//! Content-hash caches for resources and passes.
//!
//! Both caches answer one question: *is this identical to what the GPU already
//! holds?* If yes, do nothing. Resources are keyed by their app-chosen
//! [`ResourceId`]; passes by their `id`. The hash of a pass folds in the hashes
//! of the resources it references, so changing a buffer automatically
//! invalidates every pass that reads it.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io;

use elpa_protocol::{ResourceDesc, ResourceId};

/// An [`io::Write`] sink that folds every byte into a [`Hasher`] instead of
/// buffering them. Lets us serialize a value *through* a hasher with no
/// intermediate `String`/`Vec` allocation — the serialized form is consumed as
/// it is produced. (Hashing the raw UTF-8 of the JSON is just as stable a
/// fingerprint as hashing the `String` was, and is never persisted across
/// processes, so the exact algorithm is free to change.)
struct HashWriter<'a>(&'a mut DefaultHasher);

impl io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Stable content hash of any serializable value (deterministic field order).
///
/// Streams the value's JSON encoding straight into the hasher rather than
/// allocating the whole string first, so hashing a large descriptor (e.g. a
/// multi-megabyte instance buffer declared every frame) costs no transient
/// allocation. For buffers specifically, prefer [`buffer_hash`], which skips
/// formatting each element as text entirely.
pub fn content_hash<T: serde::Serialize>(value: &T) -> u64 {
    let mut h = DefaultHasher::new();
    // Serialization into a hasher cannot fail on our own types; ignore the Result.
    let _ = serde_json::to_writer(HashWriter(&mut h), value);
    h.finish()
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
            let mut h = DefaultHasher::new();
            // Domain tag so a buffer can never collide with a JSON-hashed desc.
            b"buffer".hash(&mut h);
            b.id.hash(&mut h);
            b.size.hash(&mut h);
            b.usage.hash(&mut h);
            match b.init_bytes() {
                Some(bytes) => {
                    1u8.hash(&mut h);
                    bytes.hash(&mut h);
                }
                None => 0u8.hash(&mut h),
            }
            h.finish()
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
        let mut report = SyncReport::default();
        let mut live: std::collections::HashSet<ResourceId> =
            std::collections::HashSet::with_capacity(resources.len());
        for desc in resources {
            let id = desc.id();
            let h = descriptor_hash(desc);
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
            report.created += 1;
        }
        // Evict resources absent from this frame.
        let dead: Vec<ResourceId> =
            self.hashes.keys().filter(|k| !live.contains(*k)).cloned().collect();
        for id in dead {
            backend.destroy_resource(&id);
            self.hashes.remove(&id);
            self.buffers.remove(&id);
        }
        report
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
