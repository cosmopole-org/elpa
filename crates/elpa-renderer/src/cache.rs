//! Layer caching.
//!
//! Each compositing layer is rasterized once into a GPU texture and re-used on
//! subsequent frames as long as its *content hash* is unchanged. A layer whose
//! commands are identical to last frame is a pure texture blit — no
//! re-rasterization. This is the core of "don't redraw what didn't change".

use std::collections::HashMap;

use elpa_protocol::{DrawList, LayerId, Rect};

/// A content hash identifying the exact pixels a layer should contain. If two
/// frames produce the same `CacheKey` for a layer, the cached texture is valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey(pub u64);

impl CacheKey {
    /// Hash every command assigned to `layer` (order-sensitive). A real backend
    /// would also fold in DPI scale and the layer's allocated size.
    pub fn of_layer(list: &DrawList, layer: LayerId) -> CacheKey {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for cmd in list.commands.iter().filter(|c| c.layer == layer) {
            // `DrawCommand` derives `Serialize`; hashing its debug-stable JSON
            // keeps this simple and dependency-free for the scaffold. The wgpu
            // backend replaces this with a manual `Hash` over packed fields.
            serde_json::to_string(cmd).unwrap_or_default().hash(&mut h);
        }
        CacheKey(h.finish())
    }
}

/// Metadata the cache stores per layer. The actual GPU texture handle lives in
/// the backend; this records what that texture currently contains.
#[derive(Debug, Clone)]
pub struct CachedLayer {
    pub key: CacheKey,
    pub bounds: Rect,
    /// Opaque handle the [`crate::backend::GpuBackend`] uses to address the
    /// texture allocated for this layer.
    pub texture_id: u64,
}

/// Tracks, per [`LayerId`], the content currently resident on the GPU.
#[derive(Debug, Default)]
pub struct LayerCache {
    layers: HashMap<LayerId, CachedLayer>,
}

impl LayerCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if the cached texture for `layer` already matches `key`,
    /// meaning it can be composited without re-rasterizing.
    pub fn is_valid(&self, layer: LayerId, key: CacheKey) -> bool {
        self.layers.get(&layer).is_some_and(|c| c.key == key)
    }

    pub fn get(&self, layer: LayerId) -> Option<&CachedLayer> {
        self.layers.get(&layer)
    }

    /// Record that `layer` now holds content identified by `key`.
    pub fn insert(&mut self, layer: LayerId, cached: CachedLayer) {
        self.layers.insert(layer, cached);
    }

    /// Drop layers no longer present in the current frame so their GPU textures
    /// can be reclaimed by the backend.
    pub fn retain_layers(&mut self, live: &[LayerId]) -> Vec<CachedLayer> {
        let mut evicted = Vec::new();
        self.layers.retain(|id, cached| {
            let keep = live.contains(id);
            if !keep {
                evicted.push(cached.clone());
            }
            keep
        });
        evicted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::command::{Paint, Primitive};
    use elpa_protocol::{Color, DrawCommand};

    fn sample_list(x: f32) -> DrawList {
        let mut dl = DrawList::new();
        dl.push(DrawCommand::new(
            LayerId(1),
            Rect::new(x, 0.0, 10.0, 10.0),
            Primitive::Rect {
                rect: Rect::new(x, 0.0, 10.0, 10.0),
                radius: 0.0,
                paint: Paint::Solid(Color::WHITE),
            },
        ));
        dl
    }

    #[test]
    fn identical_layers_hash_equal() {
        let a = CacheKey::of_layer(&sample_list(0.0), LayerId(1));
        let b = CacheKey::of_layer(&sample_list(0.0), LayerId(1));
        assert_eq!(a, b);
    }

    #[test]
    fn changed_layers_hash_differently() {
        let a = CacheKey::of_layer(&sample_list(0.0), LayerId(1));
        let b = CacheKey::of_layer(&sample_list(5.0), LayerId(1));
        assert_ne!(a, b);
    }

    #[test]
    fn cache_validity_and_eviction() {
        let mut cache = LayerCache::new();
        let key = CacheKey(42);
        assert!(!cache.is_valid(LayerId(1), key));
        cache.insert(LayerId(1), CachedLayer { key, bounds: Rect::default(), texture_id: 7 });
        assert!(cache.is_valid(LayerId(1), key));
        let evicted = cache.retain_layers(&[]);
        assert_eq!(evicted.len(), 1);
        assert!(!cache.is_valid(LayerId(1), key));
    }
}
