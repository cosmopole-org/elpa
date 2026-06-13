//! The drawing-management layer: the orchestrator of partial rendering.
//!
//! Each frame the manager is handed the new [`DrawList`] (already laid out and
//! lowered by the runtime). It:
//!
//! 1. Determines the live layers and content-hashes each one.
//! 2. For every layer whose hash changed, records a dirty rect and asks the
//!    backend to re-rasterize that layer's offscreen texture (cache miss).
//!    Unchanged layers are left as cached textures (cache hit).
//! 3. Sets the scissor to the accumulated dirty region and composites every
//!    live layer (cached or freshly rasterized) into the frame.
//! 4. Evicts textures for layers that disappeared.
//!
//! If nothing changed, the dirty set is empty and the frame is a no-op present.

use std::collections::BTreeSet;

use elpa_protocol::{DrawList, LayerId};

use crate::backend::GpuBackend;
use crate::cache::{CacheKey, CachedLayer, LayerCache};
use crate::dirty::DirtyTracker;

/// Owns the cross-frame rendering state: the layer cache and the per-frame dirty
/// tracker. Generic over the [`GpuBackend`] so the same logic drives wgpu in
/// production and a mock backend in tests.
pub struct DrawingManager<B: GpuBackend> {
    backend: B,
    cache: LayerCache,
    dirty: DirtyTracker,
}

impl<B: GpuBackend> DrawingManager<B> {
    pub fn new(backend: B) -> Self {
        Self { backend, cache: LayerCache::new(), dirty: DirtyTracker::new() }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Force a full repaint next frame (resize, DPI/theme change, ...).
    pub fn invalidate_all(&mut self) {
        self.dirty.mark_full();
    }

    /// Render one frame from `list`. Returns the number of layers that were
    /// re-rasterized (cache misses) — `0` means the frame was served entirely
    /// from cache, the ideal steady state.
    pub fn render(&mut self, list: &DrawList) -> usize {
        let live_layers = ordered_layers(list);
        let mut misses = 0usize;

        // 1 & 2: hash each live layer, re-rasterize on cache miss.
        for &layer in &live_layers {
            let key = CacheKey::of_layer(list, layer);
            if self.cache.is_valid(layer, key) {
                continue; // cache hit — reuse existing texture
            }
            misses += 1;
            let bounds = list.layer_bounds(layer);
            self.dirty.add(bounds);
            // If a previous version existed, its old bounds are dirty too so the
            // area it vacated gets repainted by the layers behind it.
            if let Some(prev) = self.cache.get(layer) {
                self.dirty.add(prev.bounds);
            }
            let texture_id = self.backend.ensure_layer_texture(layer, bounds);
            let cmds: Vec<_> = list.commands.iter().filter(|c| c.layer == layer).cloned().collect();
            self.backend.rasterize_layer(texture_id, bounds, &cmds);
            self.cache.insert(layer, CachedLayer { key, bounds, texture_id });
        }

        // 4 (early): evict textures for layers that vanished; their vacated
        // bounds become dirty.
        for evicted in self.cache.retain_layers(&live_layers) {
            self.dirty.add(evicted.bounds);
            self.backend.drop_texture(evicted.texture_id);
        }

        // 3: composite. Skip entirely if nothing is dirty.
        if self.dirty.is_clean() {
            return misses;
        }
        let mut frame = self.backend.begin_frame();
        self.backend.set_scissor(self.dirty.rects());
        for &layer in &live_layers {
            if let Some(cached) = self.cache.get(layer) {
                self.backend.composite_layer(&mut frame, cached.texture_id, cached.bounds, 1.0);
            }
        }
        self.backend.present(frame);
        self.dirty.clear();
        misses
    }
}

/// Distinct layer ids in first-seen (paint) order.
fn ordered_layers(list: &DrawList) -> Vec<LayerId> {
    let mut seen = BTreeSet::new();
    let mut order = Vec::new();
    for cmd in &list.commands {
        if seen.insert(cmd.layer.0) {
            order.push(cmd.layer);
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Frame, GpuBackend};
    use elpa_protocol::command::{Paint, Primitive};
    use elpa_protocol::{Color, DrawCommand, Rect};

    /// Records backend calls so tests can assert on partial-render behavior.
    #[derive(Default)]
    struct MockBackend {
        rasterized: usize,
        composited: usize,
        presents: usize,
        next_tex: u64,
    }
    impl GpuBackend for MockBackend {
        fn ensure_layer_texture(&mut self, _layer: LayerId, _bounds: Rect) -> u64 {
            self.next_tex += 1;
            self.next_tex
        }
        fn rasterize_layer(&mut self, _t: u64, _b: Rect, _c: &[DrawCommand]) {
            self.rasterized += 1;
        }
        fn set_scissor(&mut self, _dirty: &[Rect]) {}
        fn composite_layer(&mut self, _f: &mut Frame, _t: u64, _b: Rect, _o: f32) {
            self.composited += 1;
        }
        fn begin_frame(&mut self) -> Frame {
            Frame { width: 800, height: 600 }
        }
        fn present(&mut self, _f: Frame) {
            self.presents += 1;
        }
        fn drop_texture(&mut self, _t: u64) {}
    }

    fn list_with(layer: u64, x: f32) -> DrawList {
        let mut dl = DrawList::new();
        dl.push(DrawCommand::new(
            LayerId(layer),
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
    fn first_frame_rasterizes_then_steady_state_is_cached() {
        let mut mgr = DrawingManager::new(MockBackend::default());

        // Frame 1: cold cache -> one rasterization, one present.
        let misses = mgr.render(&list_with(1, 0.0));
        assert_eq!(misses, 1);
        assert_eq!(mgr.backend().rasterized, 1);
        assert_eq!(mgr.backend().presents, 1);

        // Frame 2: identical list -> cache hit, nothing dirty, no present.
        let misses = mgr.render(&list_with(1, 0.0));
        assert_eq!(misses, 0);
        assert_eq!(mgr.backend().rasterized, 1, "must not re-rasterize unchanged layer");
        assert_eq!(mgr.backend().presents, 1, "clean frame must not present");
    }

    #[test]
    fn only_changed_layer_re_rasterizes() {
        let mut mgr = DrawingManager::new(MockBackend::default());
        // Two layers.
        let mut dl = list_with(1, 0.0);
        dl.commands.extend(list_with(2, 50.0).commands);
        assert_eq!(mgr.render(&dl), 2);

        // Change only layer 2.
        let mut dl2 = list_with(1, 0.0);
        dl2.commands.extend(list_with(2, 60.0).commands);
        let misses = mgr.render(&dl2);
        assert_eq!(misses, 1, "only the changed layer should be re-rasterized");
    }
}
