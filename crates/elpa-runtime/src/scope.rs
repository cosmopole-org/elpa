//! **Layer store + layer expansion** — the host side of Elpa's scoping system.
//!
//! The program registers [`Layer`]s (via the `scope.define` host call) into a
//! [`LayerStore`]. A submitted [`Frame`] then references a layer with an
//! [`EncoderCommand::UseLayer`] instead of carrying its painting passes inline.
//! [`LayerStore::expand_layers`] resolves those references:
//!
//! * The layer's backing **snapshot texture** is merged into the frame's
//!   resources on *every* frame that uses the layer, so the resident snapshot is
//!   never evicted — even on frames where the layer is not repainted.
//! * If the layer's snapshot is **stale** (freshly declared, or invalidated since
//!   it was last painted), the layer's painting resources and passes are spliced
//!   in, repainting the snapshot, and the layer is marked clean.
//! * If the layer's snapshot is **valid**, the `useLayer` reference expands to
//!   *nothing*: the painting passes are omitted entirely, the VM never re-ran the
//!   layer's drawing logic, and the resident snapshot texture stands in for the
//!   compositing pass to sample.
//! * When the `useLayer` carries a [`LayerTransform`](elpa_protocol::LayerTransform)
//!   or opacity, the layer's small **transform uniform**
//!   ([`layer_xform_id`](elpa_protocol::layer_xform_id)) is also kept resident and
//!   refilled in place. This makes a snapshot's placement *data-only*: a drawer
//!   slide or scrim fade refreshes 32 bytes and the composite pass moves the same
//!   cached texture — no repaint, no re-rasterization, no geometry re-emit.
//!
//! Invalidation is explicit ([`LayerStore::invalidate`]); a snapshot stays valid
//! until the program says otherwise. This pairs with the renderer's
//! [`LayerTable`](elpa_renderer::LayerTable): the host omits a clean layer's
//! passes here, and the renderer reuses the snapshot of any layer pass that *is*
//! emitted, so the two halves agree that a clean layer costs nothing.

use std::collections::{HashMap, HashSet};

use elpa_protocol::{EncoderCommand, Frame, Layer, ResourceDesc};

/// What [`LayerStore::expand_layers`] did this frame, for observability.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScopeStats {
    /// `useLayer` references whose snapshot was stale and so repainted.
    pub layers_repainted: usize,
    /// `useLayer` references whose snapshot was valid and so reused (no painting).
    pub layers_reused: usize,
    /// `useLayer` references to an id with no registered layer (dropped).
    pub layers_unknown: usize,
    /// `useLayer` references that carried a transform/opacity, so the layer's
    /// transform uniform was kept resident and refilled for the composite pass.
    pub layers_transformed: usize,
}

/// A registered layer and whether its snapshot currently needs repainting.
#[derive(Debug, Clone)]
struct LayerEntry {
    layer: Layer,
    /// `true` when the snapshot is stale and the next `useLayer` must repaint it.
    dirty: bool,
}

/// A registry of named [`Layer`]s. Persists across `gpu.submit` calls so a layer
/// declared once is referenceable — and its snapshot reusable — by every later
/// frame.
#[derive(Debug, Default, Clone)]
pub struct LayerStore {
    layers: HashMap<String, LayerEntry>,
}

impl LayerStore {
    pub fn new() -> Self {
        Self { layers: HashMap::new() }
    }

    /// Register (or replace) a layer. A (re)declared layer starts **dirty** so
    /// its snapshot is painted at least once. Replacing under the same id lets a
    /// program rebuild a layer's contents (its next use repaints).
    pub fn declare(&mut self, layer: Layer) {
        self.layers.insert(layer.id.clone(), LayerEntry { layer, dirty: true });
    }

    /// Mark a layer's snapshot stale so its next use repaints. Returns whether a
    /// layer with that id was registered.
    pub fn invalidate(&mut self, id: &str) -> bool {
        match self.layers.get_mut(id) {
            Some(e) => {
                e.dirty = true;
                true
            }
            None => false,
        }
    }

    /// Invalidate every registered layer (e.g. on resize — the snapshot textures
    /// are the wrong size for the new surface and must all repaint).
    pub fn invalidate_all(&mut self) {
        for e in self.layers.values_mut() {
            e.dirty = true;
        }
    }

    /// Remove a layer. Returns whether one was present.
    pub fn release(&mut self, id: &str) -> bool {
        self.layers.remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<&Layer> {
        self.layers.get(id).map(|e| &e.layer)
    }

    /// The paint-pass id of a registered layer (for renderer registration).
    pub fn paint_pass_id(&self, id: &str) -> Option<String> {
        self.layers.get(id).map(|e| e.layer.paint_pass_id())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.layers.contains_key(id)
    }

    /// Whether a registered layer's snapshot is currently stale.
    pub fn is_dirty(&self, id: &str) -> bool {
        self.layers.get(id).map(|e| e.dirty).unwrap_or(false)
    }

    pub fn len(&self) -> usize {
        self.layers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }

    pub fn clear(&mut self) {
        self.layers.clear();
    }

    /// Resolve every `useLayer` reference in `frame`, painting stale snapshots and
    /// reusing valid ones. Returns the rebuilt frame and a [`ScopeStats`] report.
    ///
    /// Like [`DefinitionStore::expand`](crate::DefinitionStore::expand), the frame
    /// is taken **by value** so a frame that references no layers passes straight
    /// through with no allocation. Only when a `useLayer` is actually present is a
    /// new frame materialized.
    ///
    /// Repainting a layer flips it clean as a side effect, so this takes `&mut
    /// self`. The ordering of the rebuilt resource set mirrors the definition
    /// expander: layer-supplied resources (snapshot textures first, then any
    /// painting resources) come **before** the frame's own, so a compositing bind
    /// group that samples a snapshot texture finds it already declared.
    pub fn expand_layers(&mut self, frame: Frame) -> (Frame, ScopeStats) {
        let mut stats = ScopeStats::default();
        if !frame_references_layers(&frame) {
            return (frame, stats);
        }

        // Snapshot textures (always) + painting resources (only for repaints),
        // accumulated in reference order ahead of the frame's own resources.
        let mut layer_resources: Vec<ResourceDesc> = Vec::new();
        let mut commands: Vec<EncoderCommand> = Vec::with_capacity(frame.commands.len());

        for cmd in &frame.commands {
            match cmd {
                EncoderCommand::UseLayer { layer, transform, opacity } => {
                    let Some(entry) = self.layers.get_mut(layer) else {
                        stats.layers_unknown += 1;
                        continue; // unknown layer: drop the reference
                    };
                    // The snapshot texture is kept resident every frame.
                    layer_resources.push(entry.layer.texture_desc());
                    // A placed/faded reference keeps the layer's transform uniform
                    // resident and refilled in place, so the program's composite
                    // pass can slide/scale/fade the *resident* snapshot with no
                    // repaint and no geometry re-emit. Identity uses emit nothing,
                    // so a plain `useLayer` is byte-for-byte as before.
                    if transform.is_some() || opacity.is_some() {
                        let t = transform.unwrap_or_default();
                        let a = opacity.unwrap_or(1.0);
                        layer_resources.push(elpa_protocol::layer_xform_buffer(layer, &t, a));
                        stats.layers_transformed += 1;
                    }
                    if entry.dirty {
                        // Repaint: splice the painting resources + passes, clean it.
                        layer_resources.extend(entry.layer.resources.iter().cloned());
                        commands.extend(entry.layer.commands.iter().cloned());
                        entry.dirty = false;
                        stats.layers_repainted += 1;
                    } else {
                        // Reuse: the resident snapshot texture stands in.
                        stats.layers_reused += 1;
                    }
                }
                other => commands.push(other.clone()),
            }
        }

        // Deduplicate by id, keeping the first occurrence (layer resources win,
        // so a layer's snapshot/painting resources are created before any frame
        // resource that references them).
        let mut resources = Vec::with_capacity(layer_resources.len() + frame.resources.len());
        let mut seen: HashSet<String> = HashSet::new();
        for r in layer_resources.iter().chain(frame.resources.iter()) {
            if seen.insert(r.id().clone()) {
                resources.push(r.clone());
            }
        }
        (Frame { resources, commands }, stats)
    }
}

/// Whether a frame contains any `useLayer` reference. When it does not,
/// [`LayerStore::expand_layers`] hands the frame straight back with no work.
fn frame_references_layers(frame: &Frame) -> bool {
    frame.commands.iter().any(|c| matches!(c, EncoderCommand::UseLayer { .. }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::command::{ColorAttachment, RenderPass, TargetView};
    use elpa_protocol::resource::BufferDesc;
    use elpa_protocol::{RenderCommand, ResourceDesc};

    fn inst_buf(id: &str) -> ResourceDesc {
        ResourceDesc::Buffer(BufferDesc::new(id, 64, vec!["VERTEX".into(), "COPY_DST".into()]))
    }

    /// A layer whose single paint pass targets its own snapshot texture.
    fn drawer_layer() -> Layer {
        Layer {
            id: "drawer".into(),
            width: 1080,
            height: 2340,
            format: elpa_protocol::scope::default_layer_format(),
            clear_color: None,
            resources: vec![inst_buf("drawerInst")],
            commands: vec![EncoderCommand::RenderPass(RenderPass {
                id: Some("elpa.layer.drawer.paint".into()),
                color_attachments: vec![ColorAttachment {
                    view: TargetView::Texture { texture: "elpa.layer.drawer.tex".into() },
                    resolve_target: None,
                    load: "clear".into(),
                    store: true,
                    clear_color: None,
                }],
                depth_stencil: None,
                commands: vec![RenderCommand::Draw {
                    vertex_count: 6,
                    instance_count: 1,
                    first_vertex: 0,
                    first_instance: 0,
                }],
            })],
        }
    }

    /// A frame that uses the drawer layer then composites (surface pass).
    fn frame_using_drawer() -> Frame {
        Frame {
            resources: vec![],
            commands: vec![
                EncoderCommand::UseLayer { layer: "drawer".into(), transform: None, opacity: None },
                EncoderCommand::RenderPass(RenderPass {
                    id: Some("composite".into()),
                    color_attachments: vec![ColorAttachment {
                        view: TargetView::Surface,
                        resolve_target: None,
                        load: "clear".into(),
                        store: true,
                        clear_color: None,
                    }],
                    depth_stencil: None,
                    commands: vec![RenderCommand::Draw {
                        vertex_count: 6,
                        instance_count: 1,
                        first_vertex: 0,
                        first_instance: 0,
                    }],
                }),
            ],
        }
    }

    fn texture_ids(f: &Frame) -> Vec<String> {
        f.resources
            .iter()
            .filter_map(|r| match r {
                ResourceDesc::Texture(t) => Some(t.id.clone()),
                _ => None,
            })
            .collect()
    }
    fn paint_pass_present(f: &Frame) -> bool {
        f.commands.iter().any(|c| matches!(c,
            EncoderCommand::RenderPass(rp) if rp.id.as_deref() == Some("elpa.layer.drawer.paint")))
    }

    #[test]
    fn passthrough_when_no_layer_references() {
        let mut store = LayerStore::new();
        let frame = Frame { resources: vec![inst_buf("x")], commands: vec![] };
        let (out, stats) = store.expand_layers(frame.clone());
        assert_eq!(out, frame);
        assert_eq!(stats, ScopeStats::default());
    }

    #[test]
    fn first_use_paints_then_subsequent_uses_reuse_snapshot() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());

        // Frame 1: snapshot stale -> painting passes spliced, snapshot texture +
        // painting resources present.
        let (out, stats) = store.expand_layers(frame_using_drawer());
        assert_eq!(stats.layers_repainted, 1);
        assert_eq!(stats.layers_reused, 0);
        assert!(paint_pass_present(&out), "paint pass spliced when dirty");
        assert!(texture_ids(&out).contains(&"elpa.layer.drawer.tex".to_string()));
        assert!(out.resources.iter().any(|r| r.id() == "drawerInst"), "painting resource present");

        // Frame 2: snapshot valid -> paint passes omitted, but the snapshot
        // texture is *still* declared (kept resident); painting resources gone.
        let (out, stats) = store.expand_layers(frame_using_drawer());
        assert_eq!(stats.layers_reused, 1);
        assert_eq!(stats.layers_repainted, 0);
        assert!(!paint_pass_present(&out), "paint pass omitted when snapshot reused");
        assert!(texture_ids(&out).contains(&"elpa.layer.drawer.tex".to_string()), "snapshot kept resident");
        assert!(!out.resources.iter().any(|r| r.id() == "drawerInst"), "no painting resource when reused");
        // Only the composite surface pass remains.
        assert_eq!(out.commands.len(), 1);
    }

    #[test]
    fn invalidate_forces_one_repaint_then_reuse_resumes() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());
        store.expand_layers(frame_using_drawer()); // paint
        store.expand_layers(frame_using_drawer()); // reuse

        assert!(store.invalidate("drawer"));
        let (out, stats) = store.expand_layers(frame_using_drawer());
        assert_eq!(stats.layers_repainted, 1, "invalidation forces a repaint");
        assert!(paint_pass_present(&out));

        // Cleaned again afterwards.
        let (_out, stats) = store.expand_layers(frame_using_drawer());
        assert_eq!(stats.layers_reused, 1);
    }

    #[test]
    fn redeclaring_marks_dirty_again() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());
        store.expand_layers(frame_using_drawer()); // paints, now clean
        assert!(!store.is_dirty("drawer"));
        store.declare(drawer_layer()); // replace -> dirty
        assert!(store.is_dirty("drawer"));
    }

    #[test]
    fn unknown_layer_reference_is_dropped_and_counted() {
        let mut store = LayerStore::new();
        let frame = Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseLayer { layer: "ghost".into(), transform: None, opacity: None }],
        };
        let (out, stats) = store.expand_layers(frame);
        assert_eq!(stats.layers_unknown, 1);
        assert!(out.commands.is_empty(), "the dangling reference is removed");
    }

    /// A frame that composites the drawer at a slide offset + scrim fade.
    fn frame_placing_drawer(tx: f32, opacity: f32) -> Frame {
        Frame {
            resources: vec![],
            commands: vec![EncoderCommand::UseLayer {
                layer: "drawer".into(),
                transform: Some(elpa_protocol::LayerTransform::translate(tx, 0.0)),
                opacity: Some(opacity),
            }],
        }
    }
    fn xform_words(f: &Frame, layer: &str) -> Option<Vec<f32>> {
        let id = elpa_protocol::layer_xform_id(layer);
        f.resources.iter().find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == id => b.data_f32.clone(),
            _ => None,
        })
    }

    #[test]
    fn placed_use_keeps_a_resident_transform_uniform_that_moves_without_repaint() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());

        // First placed use: snapshot painted once, transform uniform materialized.
        let (out, stats) = store.expand_layers(frame_placing_drawer(0.0, 0.0));
        assert_eq!(stats.layers_repainted, 1);
        assert_eq!(stats.layers_transformed, 1);
        assert_eq!(xform_words(&out, "drawer"), Some(vec![0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0]));

        // Animation frame: snapshot *reused* (no paint pass, no painting resource),
        // but the transform uniform is refreshed in place to slide + fade it.
        let (out, stats) = store.expand_layers(frame_placing_drawer(40.0, 0.5));
        assert_eq!(stats.layers_reused, 1, "snapshot reused while it slides");
        assert_eq!(stats.layers_repainted, 0);
        assert_eq!(stats.layers_transformed, 1);
        assert!(!paint_pass_present(&out), "no repaint while sliding");
        assert!(!out.resources.iter().any(|r| r.id() == "drawerInst"), "no painting cost while sliding");
        assert_eq!(xform_words(&out, "drawer"), Some(vec![40.0, 0.0, 1.0, 1.0, 0.5, 0.0, 0.0, 0.0]));
        assert!(texture_ids(&out).contains(&"elpa.layer.drawer.tex".to_string()), "snapshot resident");
    }

    #[test]
    fn identity_use_emits_no_transform_uniform() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());
        let (out, stats) = store.expand_layers(frame_using_drawer());
        assert_eq!(stats.layers_transformed, 0);
        assert!(xform_words(&out, "drawer").is_none(), "identity placement costs nothing extra");
    }

    #[test]
    fn transient_freeze_then_thaw_cycle() {
        // The drawer-slide pattern: declare (freeze) a body layer at gesture start,
        // reuse its snapshot for every animation frame, release (thaw) at the end.
        let mut store = LayerStore::new();
        store.declare(drawer_layer());
        let (_o, s) = store.expand_layers(frame_using_drawer());
        assert_eq!(s.layers_repainted, 1, "painted once on freeze");
        for _ in 0..30 {
            let (_o, s) = store.expand_layers(frame_using_drawer());
            assert_eq!(s.layers_reused, 1, "reused every frame of the gesture");
            assert_eq!(s.layers_repainted, 0);
        }
        assert!(store.release("drawer"), "thawed at gesture end");
        assert!(!store.contains("drawer"));
    }

    #[test]
    fn invalidate_all_and_release() {
        let mut store = LayerStore::new();
        store.declare(drawer_layer());
        store.expand_layers(frame_using_drawer());
        assert!(!store.is_dirty("drawer"));
        store.invalidate_all();
        assert!(store.is_dirty("drawer"));
        assert!(store.release("drawer"));
        assert!(!store.contains("drawer"));
    }
}
