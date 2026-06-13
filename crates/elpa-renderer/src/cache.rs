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

use elpa_protocol::{ResourceDesc, ResourceId};

/// Stable content hash of any serializable value (deterministic field order).
pub fn content_hash<T: serde::Serialize>(value: &T) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(value).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// Tracks which resources are resident on the GPU and their current hash.
#[derive(Debug, Default)]
pub struct ResourceCache {
    hashes: HashMap<ResourceId, u64>,
}

impl ResourceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reconcile the GPU with the frame's declared resources. Creates new /
    /// changed resources, evicts ones no longer present. Returns the number of
    /// resources (re)created — `0` means the resource set was fully cached.
    pub fn sync<B: crate::GpuBackend>(
        &mut self,
        resources: &[ResourceDesc],
        backend: &mut B,
    ) -> usize {
        let mut created = 0;
        let mut live = Vec::with_capacity(resources.len());
        for desc in resources {
            let id = desc.id().clone();
            let h = content_hash(desc);
            live.push(id.clone());
            if self.hashes.get(&id) != Some(&h) {
                backend.create_resource(desc);
                self.hashes.insert(id, h);
                created += 1;
            }
        }
        // Evict resources absent from this frame.
        let dead: Vec<ResourceId> =
            self.hashes.keys().filter(|k| !live.contains(k)).cloned().collect();
        for id in dead {
            backend.destroy_resource(&id);
            self.hashes.remove(&id);
        }
        created
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
        destroyed: Vec<String>,
    }
    impl crate::GpuBackend for Counter {
        fn create_resource(&mut self, d: &ResourceDesc) {
            self.created.push(d.id().clone());
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
        ResourceDesc::Buffer(BufferDesc { id: id.into(), size, usage: vec!["VERTEX".into()], data_b64: None })
    }

    #[test]
    fn resource_sync_creates_changes_and_evicts() {
        let mut cache = ResourceCache::new();
        let mut be = Counter { created: vec![], destroyed: vec![] };

        // Frame 1: two new resources.
        assert_eq!(cache.sync(&[buf("a", 16), buf("b", 16)], &mut be), 2);
        // Frame 2: identical -> nothing created.
        assert_eq!(cache.sync(&[buf("a", 16), buf("b", 16)], &mut be), 0);
        // Frame 3: "a" changed size, "b" gone.
        assert_eq!(cache.sync(&[buf("a", 32)], &mut be), 1);
        assert_eq!(be.destroyed, vec!["b".to_string()]);
    }

    #[test]
    fn touch_changes_resource_hash() {
        let mut cache = ResourceCache::new();
        let mut be = Counter { created: vec![], destroyed: vec![] };
        cache.sync(&[buf("a", 16)], &mut be);
        let before = cache.resource_hash("a");
        cache.touch("a");
        assert_ne!(cache.resource_hash("a"), before);
    }
}
