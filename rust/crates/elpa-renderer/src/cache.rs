//! Content-hash caches for resources and passes.
//!
//! Both caches answer one question: *is this identical to what the GPU already
//! holds?* If yes, do nothing. Resources are keyed by their app-chosen
//! [`ResourceId`]; passes by their `id`. The hash of a pass folds in the hashes
//! of the resources it references, so changing a buffer automatically
//! invalidates every pass that reads it.

use std::io;

use ahash::{AHashMap as HashMap, AHashSet as HashSet};
use bumpalo::Bump;
use xxhash_rust::xxh3::Xxh3;

use elpa_protocol::{ResourceDesc, ResourceId};

/// An [`io::Write`] sink that feeds every byte into an xxHash-3 streaming
/// state instead of buffering them. Lets us serialize a value *through* a
/// hasher with no intermediate `String`/`Vec` allocation. xxHash-3 uses SIMD
/// internally and is significantly faster than the default SipHash for the
/// content-hashing hot path.
struct HashWriter(Xxh3);

impl HashWriter {
    fn new() -> Self {
        HashWriter(Xxh3::new())
    }
    fn finish(self) -> u64 {
        self.0.digest()
    }
}

impl io::Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Stable content hash of any serializable value (deterministic field order).
///
/// Streams the value's JSON encoding straight into an xxHash-3 hasher rather
/// than allocating the whole string first, so hashing a large descriptor costs
/// no transient allocation. For buffers specifically, prefer [`descriptor_hash`],
/// which skips formatting each element as text entirely.
pub fn content_hash<T: serde::Serialize>(value: &T) -> u64 {
    let mut w = HashWriter::new();
    let _ = serde_json::to_writer(&mut w, value);
    w.finish()
}

/// Content hash of a resource descriptor, specialized so a buffer's bulk data is
/// hashed as **raw little-endian bytes** rather than serialized to a JSON number
/// array first. A dynamic vertex/instance buffer that is rebuilt every frame is
/// the common hot path; formatting tens of thousands of floats to text just to
/// hash them dominated the frame otherwise. Non-buffer descriptors (pipelines,
/// bind groups, …) are small and static, so they keep the generic JSON hash.
pub fn descriptor_hash(desc: &ResourceDesc) -> u64 {
    match desc {
        ResourceDesc::Buffer(b) => {
            let mut h = Xxh3::new();
            // Domain tag so a buffer can never collide with a JSON-hashed desc.
            h.update(b"buffer");
            h.update(b.id.as_bytes());
            h.update(&b.size.to_le_bytes());
            // Hash usage strings sequentially.
            for u in &b.usage {
                h.update(u.as_bytes());
                h.update(b"\x00");
            }
            match b.init_bytes() {
                Some(bytes) => {
                    h.update(b"\x01");
                    h.update(&bytes);
                }
                None => h.update(b"\x00"),
            }
            h.digest()
        }
        other => content_hash(other),
    }
}

/// Whether a buffer descriptor's contents can be updated in place with a queue
/// write (it must declare `COPY_DST`) and actually carries new data to write.
fn buffer_is_writable(b: &elpa_protocol::resource::BufferDesc) -> bool {
    b.usage.iter().any(|u| u == "COPY_DST")
}

/// The structural signature (everything but the data payload) of a buffer, used
/// to decide whether a change can be served by an in-place write (same size and
/// usage) or requires a full recreate.
fn buffer_shape(b: &elpa_protocol::resource::BufferDesc) -> (u64, u64) {
    (b.size, content_hash(&b.usage))
}

/// What [`ResourceCache::sync`] did this frame: resources freshly (re)created on
/// the GPU vs. existing buffers updated in place with a queue write.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SyncReport {
    pub created: usize,
    pub updated: usize,
}

/// The remembered shape of a resident buffer (size + usage signature, plus
/// whether it can take queue writes), so a later frame can tell a pure data
/// change from a structural one.
#[derive(Debug, Clone, Copy)]
struct BufferShape {
    shape: (u64, u64),
    writable: bool,
}

/// Tracks which resources are resident on the GPU and their current hash.
#[derive(Debug, Default)]
pub struct ResourceCache {
    hashes: HashMap<ResourceId, u64>,
    /// Shapes of resident buffers, to route data-only changes to an in-place
    /// write instead of a destroy+recreate.
    buffers: HashMap<ResourceId, BufferShape>,
    /// For each resident bind group, the resources it binds. A bind group's
    /// descriptor is stable across frames, but the buffers it binds may be
    /// refilled in place, so a pass that reads the bind group must fold in these
    /// resources' content hashes to notice an animated uniform changed.
    bind_group_refs: HashMap<ResourceId, Vec<ResourceId>>,
}

impl ResourceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reconcile the GPU with the frame's declared resources. Creates new /
    /// changed resources, **updates** changed-but-same-shape buffers in place,
    /// and evicts ones no longer present. Returns counts of each (a fully cached
    /// resource set reports `created == 0 && updated == 0`).
    ///
    /// In-place update is the key animation optimization: a vertex/instance/
    /// uniform buffer that an app re-declares every frame with fresh `data_*`
    /// keeps the *same* GPU allocation and is refilled with `queue.write_buffer`,
    /// instead of allocating and tearing down a buffer per frame. It engages only
    /// when the new descriptor keeps the same size and usage and declares
    /// `COPY_DST`; anything else falls back to a recreate, so behavior is
    /// unchanged for buffers that don't opt in.
    pub fn sync<B: crate::GpuBackend>(
        &mut self,
        resources: &[ResourceDesc],
        backend: &mut B,
    ) -> SyncReport {
        // Per-call bump arena: all temporary allocations within sync() are freed
        // in O(1) when `arena` drops, without touching the global allocator.
        let arena = Bump::new();
        let mut report = SyncReport::default();
        let mut live: HashSet<ResourceId> = HashSet::with_capacity_and_hasher(
            resources.len(),
            ahash::RandomState::new(),
        );

        // Phase 1 — compute all content hashes in parallel (pure, read-only).
        // GPU mutations in phase 2 must stay sequential, but hashing is the
        // expensive part for frames with many or large resources.
        #[cfg(not(target_arch = "wasm32"))]
        let new_hashes: Vec<(&ResourceDesc, u64)> = {
            use rayon::prelude::*;
            resources.par_iter().map(|d| (d, descriptor_hash(d))).collect()
        };
        // On wasm32 use an arena-backed vec to avoid global-allocator pressure.
        #[cfg(target_arch = "wasm32")]
        let new_hashes: bumpalo::collections::Vec<(&ResourceDesc, u64)> = {
            let mut v = bumpalo::collections::Vec::new_in(&arena);
            v.extend(resources.iter().map(|d| (d, descriptor_hash(d))));
            v
        };

        // Phase 2 — sequential GPU mutations using the precomputed hashes.
        for (desc, h) in new_hashes {
            let id = desc.id();
            live.insert(id.clone());
            if self.hashes.get(id) == Some(&h) {
                continue; // identical to the resident copy — nothing to do
            }

            // A buffer whose bytes changed but whose size/usage match the
            // resident one (and which allows COPY_DST) is refilled in place.
            if let ResourceDesc::Buffer(b) = desc {
                let resident = self.buffers.get(id).copied();
                let writable_now = buffer_is_writable(b);
                let same_shape = resident.map(|r| r.shape) == Some(buffer_shape(b));
                if let (Some(prev), true, true) = (resident, same_shape, writable_now) {
                    if prev.writable {
                        if let Some(bytes) = b.init_bytes() {
                            backend.update_buffer(id, 0, &bytes);
                            self.hashes.insert(id.clone(), h);
                            report.updated += 1;
                            continue;
                        }
                    }
                }
            }

            backend.create_resource(desc);
            self.hashes.insert(id.clone(), h);
            if let ResourceDesc::Buffer(b) = desc {
                self.buffers
                    .insert(id.clone(), BufferShape { shape: buffer_shape(b), writable: buffer_is_writable(b) });
            }
            // Remember what a bind group binds, so a pass that reads it can fold
            // in those resources' content hashes (a uniform refilled in place
            // leaves the bind group descriptor — and its hash — unchanged).
            if let ResourceDesc::BindGroup(bg) = desc {
                self.bind_group_refs.insert(id.clone(), bg.bound_resources());
            }
            report.created += 1;
        }
        // Evict resources absent from this frame. Collect into an arena vec to
        // avoid a global-allocator round-trip for this short-lived list.
        let dead: bumpalo::collections::Vec<ResourceId> = {
            let mut v = bumpalo::collections::Vec::new_in(&arena);
            v.extend(self.hashes.keys().filter(|k| !live.contains(*k)).cloned());
            v
        };
        for id in dead {
            backend.destroy_resource(&id);
            self.hashes.remove(&id);
            self.buffers.remove(&id);
            self.bind_group_refs.remove(&id);
        }
        report
    }

    /// The resources a resident bind group binds (empty for anything that is not
    /// a known bind group). A pass that reads a bind group folds these in so an
    /// in-place buffer update behind it still invalidates the pass.
    pub fn bound_resources(&self, id: &str) -> &[ResourceId] {
        self.bind_group_refs.get(id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Current hash of a resource (0 if unknown) — folded into pass hashes.
    pub fn resource_hash(&self, id: &str) -> u64 {
        self.hashes.get(id).copied().unwrap_or(0)
    }

    /// Mark a resource's contents changed (e.g. after a `writeBuffer`/copy)
    /// without a descriptor change, so dependent passes invalidate.
    pub fn touch(&mut self, id: &str) {
        let e = self.hashes.entry(id.to_string()).or_insert(0);
        *e = e.wrapping_add(0x9E37_79B9_7F4A_7C15);
    }
}

/// Tracks the last-recorded content hash of each identified pass.
#[derive(Debug, Default)]
pub struct PassCache {
    hashes: HashMap<String, u64>,
}

impl PassCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` if the cached recording of `pass_id` already matches `hash`.
    pub fn is_valid(&self, pass_id: &str, hash: u64) -> bool {
        self.hashes.get(pass_id) == Some(&hash)
    }

    pub fn insert(&mut self, pass_id: &str, hash: u64) {
        self.hashes.insert(pass_id.to_string(), hash);
    }

    /// Forget passes not present in `live` this frame.
    pub fn retain(&mut self, live: &[String]) {
        self.hashes.retain(|k, _| live.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::resource::BufferDesc;

    struct Counter {
        created: Vec<String>,
        updated: Vec<String>,
        destroyed: Vec<String>,
    }
    impl crate::GpuBackend for Counter {
        fn create_resource(&mut self, d: &ResourceDesc) {
            self.created.push(d.id().clone());
        }
        fn update_buffer(&mut self, id: &str, _offset: u64, _bytes: &[u8]) {
            self.updated.push(id.to_string());
        }
        fn destroy_resource(&mut self, id: &str) {
            self.destroyed.push(id.to_string());
        }
        fn begin_frame(&mut self) {}
        fn record_render_pass(&mut self, _p: &elpa_protocol::RenderPass) {}
        fn record_compute_pass(&mut self, _p: &elpa_protocol::ComputePass) {}
        fn record_encoder_command(&mut self, _c: &elpa_protocol::EncoderCommand) {}
        fn end_frame(&mut self, _d: &[elpa_protocol::Rect]) {}
    }

    fn buf(id: &str, size: u64) -> ResourceDesc {
        ResourceDesc::Buffer(BufferDesc::new(id, size, vec!["VERTEX".into()]))
    }

    /// A `COPY_DST` buffer carrying `data` — the in-place-updatable shape.
    fn dyn_buf(id: &str, data: Vec<f32>) -> ResourceDesc {
        let mut d = BufferDesc::new(id, (data.len() * 4) as u64, vec!["VERTEX".into(), "COPY_DST".into()]);
        d.data_f32 = Some(data);
        ResourceDesc::Buffer(d)
    }

    fn counter() -> Counter {
        Counter { created: vec![], updated: vec![], destroyed: vec![] }
    }

    #[test]
    fn resource_sync_creates_changes_and_evicts() {
        let mut cache = ResourceCache::new();
        let mut be = counter();

        // Frame 1: two new resources.
        assert_eq!(cache.sync(&[buf("a", 16), buf("b", 16)], &mut be).created, 2);
        // Frame 2: identical -> nothing created.
        assert_eq!(cache.sync(&[buf("a", 16), buf("b", 16)], &mut be).created, 0);
        // Frame 3: "a" changed size, "b" gone.
        assert_eq!(cache.sync(&[buf("a", 32)], &mut be).created, 1);
        assert_eq!(be.destroyed, vec!["b".to_string()]);
    }

    #[test]
    fn copy_dst_buffer_data_change_updates_in_place() {
        let mut cache = ResourceCache::new();
        let mut be = counter();

        // Frame 1: created (first sight).
        let r = cache.sync(&[dyn_buf("inst", vec![1.0, 2.0, 3.0])], &mut be);
        assert_eq!((r.created, r.updated), (1, 0));
        assert_eq!(be.created, vec!["inst".to_string()]);

        // Frame 2: only the data changed, same size + usage + COPY_DST -> the GPU
        // allocation is reused via a queue write, not recreated.
        let r = cache.sync(&[dyn_buf("inst", vec![4.0, 5.0, 6.0])], &mut be);
        assert_eq!((r.created, r.updated), (0, 1), "data-only change is an in-place write");
        assert_eq!(be.updated, vec!["inst".to_string()]);
        assert!(be.created.len() == 1 && be.destroyed.is_empty(), "no recreate, no destroy");

        // Frame 3: identical data -> fully cached, no work at all.
        let r = cache.sync(&[dyn_buf("inst", vec![4.0, 5.0, 6.0])], &mut be);
        assert_eq!((r.created, r.updated), (0, 0));
    }

    #[test]
    fn buffer_without_copy_dst_recreates_on_data_change() {
        let mut cache = ResourceCache::new();
        let mut be = counter();
        let mk = |data: Vec<f32>| {
            let mut d = BufferDesc::new("vb", (data.len() * 4) as u64, vec!["VERTEX".into()]);
            d.data_f32 = Some(data);
            ResourceDesc::Buffer(d)
        };
        cache.sync(&[mk(vec![1.0, 2.0])], &mut be);
        // No COPY_DST -> a data change must recreate, never an in-place write.
        let r = cache.sync(&[mk(vec![3.0, 4.0])], &mut be);
        assert_eq!((r.created, r.updated), (1, 0));
        assert!(be.updated.is_empty());
    }

    #[test]
    fn buffer_size_change_recreates_not_updates() {
        let mut cache = ResourceCache::new();
        let mut be = counter();
        cache.sync(&[dyn_buf("inst", vec![1.0, 2.0])], &mut be);
        // Growing the buffer changes its shape -> recreate (the old allocation is
        // the wrong size for a queue write).
        let r = cache.sync(&[dyn_buf("inst", vec![1.0, 2.0, 3.0])], &mut be);
        assert_eq!((r.created, r.updated), (1, 0));
        assert!(be.updated.is_empty());
    }

    #[test]
    fn touch_changes_resource_hash() {
        let mut cache = ResourceCache::new();
        let mut be = counter();
        cache.sync(&[buf("a", 16)], &mut be);
        let before = cache.resource_hash("a");
        cache.touch("a");
        assert_ne!(cache.resource_hash("a"), before);
    }
}
