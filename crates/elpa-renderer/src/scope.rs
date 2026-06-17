//! **Layer snapshot control** — the renderer-side half of Elpa's scoping system.
//!
//! A *layer* is an offscreen render pass (it targets a texture, not the surface)
//! that a program has registered as an independently-cached **snapshot**. Unlike
//! an ordinary cacheable pass — which is skipped only while its content hash is
//! unchanged — a registered layer's snapshot validity is **explicit**: it stays
//! valid (and is reused with no GPU work) until the program calls
//! [`Renderer::invalidate_layer`](crate::Renderer::invalidate_layer). This is
//! what lets a layer hold its rendered snapshot across frames even as the rest of
//! the frame changes around it, and repaint *only* on the program's command.
//!
//! [`LayerTable`] tracks, per registered layer paint-pass id, whether its
//! snapshot is currently valid. The [`Renderer`](crate::Renderer) consults it
//! when planning an offscreen pass:
//!
//! * **valid** → the pass is skipped, the cached snapshot texture stands in
//!   (`layers_reused`).
//! * **invalid / forced** → the pass is recorded, repainting the snapshot, and
//!   the snapshot is marked valid again (`layers_repainted`).

use ahash::AHashSet as HashSet;

/// Tracks which offscreen passes are program-registered **layers** and whether
/// each one's snapshot is currently valid (reusable) or must be repainted.
#[derive(Debug, Default)]
pub struct LayerTable {
    /// Paint-pass ids the program registered as layers.
    registered: HashSet<String>,
    /// Registered layers whose snapshot is currently **valid** — reuse it,
    /// record nothing. A layer absent here (but registered) must repaint.
    valid: HashSet<String>,
}

impl LayerTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an offscreen pass id as a layer. A freshly registered layer has
    /// no valid snapshot yet, so its first appearance repaints.
    pub fn register(&mut self, pass_id: &str) {
        self.registered.insert(pass_id.to_string());
        // A (re)registration starts invalid so the snapshot is built once.
        self.valid.remove(pass_id);
    }

    /// Stop treating `pass_id` as a layer (and forget its snapshot state).
    pub fn unregister(&mut self, pass_id: &str) -> bool {
        self.valid.remove(pass_id);
        self.registered.remove(pass_id)
    }

    /// Whether `pass_id` is a registered layer.
    pub fn is_registered(&self, pass_id: &str) -> bool {
        self.registered.contains(pass_id)
    }

    /// Mark a layer's snapshot stale so its next appearance repaints. No-op for
    /// an unregistered id.
    pub fn invalidate(&mut self, pass_id: &str) {
        if self.registered.contains(pass_id) {
            self.valid.remove(pass_id);
        }
    }

    /// Force *every* registered layer to repaint (used when the whole surface is
    /// invalidated, e.g. on resize — old snapshot textures no longer fit).
    pub fn invalidate_all(&mut self) {
        self.valid.clear();
    }

    /// Whether `pass_id`'s snapshot may currently be reused without recording.
    pub fn is_valid(&self, pass_id: &str) -> bool {
        self.valid.contains(pass_id)
    }

    /// Note that a layer's snapshot was just (re)painted, so it is now valid.
    pub fn mark_painted(&mut self, pass_id: &str) {
        if self.registered.contains(pass_id) {
            self.valid.insert(pass_id.to_string());
        }
    }

    pub fn registered_count(&self) -> usize {
        self.registered.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unregistered_pass_is_not_a_layer() {
        let t = LayerTable::new();
        assert!(!t.is_registered("p"));
        assert!(!t.is_valid("p"));
    }

    #[test]
    fn lifecycle_register_paint_invalidate() {
        let mut t = LayerTable::new();
        t.register("elpa.layer.drawer.paint");
        // Freshly registered: not yet painted -> invalid.
        assert!(t.is_registered("elpa.layer.drawer.paint"));
        assert!(!t.is_valid("elpa.layer.drawer.paint"));

        // After painting it is reusable.
        t.mark_painted("elpa.layer.drawer.paint");
        assert!(t.is_valid("elpa.layer.drawer.paint"));

        // Explicit invalidation makes it repaint again.
        t.invalidate("elpa.layer.drawer.paint");
        assert!(!t.is_valid("elpa.layer.drawer.paint"));
    }

    #[test]
    fn invalidate_all_and_unregister() {
        let mut t = LayerTable::new();
        t.register("a");
        t.register("b");
        t.mark_painted("a");
        t.mark_painted("b");
        t.invalidate_all();
        assert!(!t.is_valid("a") && !t.is_valid("b"));

        t.mark_painted("a");
        assert!(t.unregister("a"));
        assert!(!t.is_registered("a") && !t.is_valid("a"));
        assert!(!t.unregister("missing"));
    }

    #[test]
    fn marking_unregistered_is_a_noop() {
        let mut t = LayerTable::new();
        t.mark_painted("ghost");
        t.invalidate("ghost");
        assert!(!t.is_valid("ghost"));
    }
}
