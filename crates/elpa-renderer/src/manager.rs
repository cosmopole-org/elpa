//! The renderer orchestrator: walks a [`Frame`] command tree and drives the
//! [`GpuBackend`], applying resource caching and partial rendering.
//!
//! Per frame:
//! 1. **Sync resources** — create/replace changed ones, evict vanished ones.
//! 2. **Plan passes** — content-hash each pass (folding in referenced-resource
//!    hashes). A cacheable *offscreen* pass whose hash is unchanged is **skipped**
//!    (its target texture is reused). Anything changed marks the frame dirty.
//! 3. **Execute** — only if the frame is dirty: begin an encoder, record the
//!    non-skipped passes / copies / writes in order, and present scissored to the
//!    accumulated dirty region. A fully-cached frame does *no* GPU work.

use xxhash_rust::xxh3::Xxh3;

use elpa_protocol::{EncoderCommand, Frame, RenderCommand, RenderPass};

use crate::backend::GpuBackend;
use crate::cache::{content_hash, PassCache, ResourceCache};
use crate::dirty::DirtyTracker;
use crate::scope::LayerTable;

/// Per-frame work report. The steady-state goal is
/// `resources_created == 0 && passes_recorded == 0 && !presented`. A frame that
/// only animates a dynamic buffer reports `resources_updated > 0` with
/// `resources_created == 0` — the buffer's GPU allocation was reused.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FrameStats {
    pub resources_created: usize,
    /// Buffers refilled in place (queue write) rather than recreated.
    pub resources_updated: usize,
    pub passes_recorded: usize,
    pub passes_cached: usize,
    /// Registered **layer** snapshots repainted this frame (a subset of
    /// `passes_recorded`): an offscreen layer pass whose snapshot was stale.
    pub layers_repainted: usize,
    /// Registered **layer** snapshots reused this frame (a subset of
    /// `passes_cached`): an offscreen layer pass skipped because its snapshot was
    /// still valid — no GPU work, the resident snapshot texture stands in.
    pub layers_reused: usize,
    pub presented: bool,
}

/// What to do with each top-level command, decided in the planning phase.
enum Plan {
    Skip,
    RecordRender(usize),
    RecordCompute(usize),
    RecordEncoder(usize),
    /// Surface/idless render pass: record only if the frame ends up dirty.
    SurfaceMaybe(usize),
}

pub struct Renderer<B: GpuBackend> {
    backend: B,
    resources: ResourceCache,
    passes: PassCache,
    dirty: DirtyTracker,
    layers: LayerTable,
}

impl<B: GpuBackend> Renderer<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            resources: ResourceCache::new(),
            passes: PassCache::new(),
            dirty: DirtyTracker::new(),
            layers: LayerTable::new(),
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Mutable access to the backend (e.g. to reconfigure the surface on resize).
    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    /// Drop all cached pass recordings so every pass re-records next frame. Used
    /// after a surface resize / format change, where cached offscreen textures
    /// and the prior present are no longer valid. Every registered layer snapshot
    /// is invalidated too — its texture is the wrong size for the new surface.
    pub fn invalidate(&mut self) {
        self.passes = PassCache::new();
        self.layers.invalidate_all();
        self.dirty.mark_full();
    }

    // ---- Layer scoping (snapshot control) -----------------------------------

    /// Register an offscreen pass id as an independently-cached **layer**. Its
    /// snapshot is then reused frame-to-frame (no GPU work) until the program
    /// calls [`Renderer::invalidate_layer`] — repaints are *explicit*, not driven
    /// by content hashing. Registering is idempotent; the first appearance after
    /// registration paints the snapshot once.
    pub fn register_layer(&mut self, paint_pass_id: &str) {
        self.layers.register(paint_pass_id);
    }

    /// Stop treating `paint_pass_id` as a layer (and forget its snapshot state).
    /// Returns whether it was registered.
    pub fn unregister_layer(&mut self, paint_pass_id: &str) -> bool {
        self.layers.unregister(paint_pass_id)
    }

    /// Mark a registered layer's snapshot stale so its next appearance repaints.
    pub fn invalidate_layer(&mut self, paint_pass_id: &str) {
        self.layers.invalidate(paint_pass_id);
    }

    /// Whether `paint_pass_id` is a registered layer.
    pub fn is_layer(&self, paint_pass_id: &str) -> bool {
        self.layers.is_registered(paint_pass_id)
    }

    /// The layer snapshot table (validity per registered layer).
    pub fn layers(&self) -> &LayerTable {
        &self.layers
    }

    /// Map one submitted [`Frame`] onto the GPU.
    pub fn render(&mut self, frame: &Frame) -> FrameStats {
        let mut stats = FrameStats::default();
        self.dirty.clear();

        // 1. Resource reconciliation.
        let sync = self.resources.sync(&frame.resources, &mut self.backend);
        stats.resources_created = sync.created;
        stats.resources_updated = sync.updated;

        // 2. Plan each command; decide dirtiness and pass cache hits.
        let mut plan: Vec<Plan> = Vec::with_capacity(frame.commands.len());
        let mut live_passes: Vec<String> = Vec::new();
        let mut frame_dirty = false;

        for (i, cmd) in frame.commands.iter().enumerate() {
            match cmd {
                EncoderCommand::RenderPass(rp) => {
                    let hash = self.hash_render_pass(rp);
                    if let (Some(id), false) = (rp.id.as_deref(), rp.targets_surface()) {
                        // Cacheable offscreen pass.
                        live_passes.push(id.to_string());
                        if self.layers.is_registered(id) {
                            // Registered layer: snapshot validity is *explicit* —
                            // reuse the snapshot until the program invalidates it,
                            // regardless of content hash. This is what lets a layer
                            // hold its rendered snapshot across frames while the
                            // rest of the frame changes around it.
                            if self.layers.is_valid(id) {
                                stats.passes_cached += 1;
                                stats.layers_reused += 1;
                                plan.push(Plan::Skip);
                            } else {
                                self.passes.insert(id, hash);
                                self.layers.mark_painted(id);
                                frame_dirty = true;
                                stats.layers_repainted += 1;
                                plan.push(Plan::RecordRender(i));
                            }
                        } else if self.passes.is_valid(id, hash) {
                            stats.passes_cached += 1;
                            plan.push(Plan::Skip);
                        } else {
                            self.passes.insert(id, hash);
                            frame_dirty = true;
                            plan.push(Plan::RecordRender(i));
                        }
                    } else {
                        // Surface or idless pass: record iff the frame is dirty.
                        if let Some(id) = rp.id.as_deref() {
                            live_passes.push(id.to_string());
                            if !self.passes.is_valid(id, hash) {
                                self.passes.insert(id, hash);
                                frame_dirty = true;
                            }
                        } else {
                            frame_dirty = true;
                        }
                        self.collect_surface_dirty(rp);
                        plan.push(Plan::SurfaceMaybe(i));
                    }
                }
                EncoderCommand::ComputePass(cp) => {
                    let hash = self.hash_compute_pass(cp);
                    if let Some(id) = cp.id.as_deref() {
                        live_passes.push(id.to_string());
                        if self.passes.is_valid(id, hash) {
                            stats.passes_cached += 1;
                            plan.push(Plan::Skip);
                        } else {
                            self.passes.insert(id, hash);
                            frame_dirty = true;
                            plan.push(Plan::RecordCompute(i));
                        }
                    } else {
                        frame_dirty = true;
                        plan.push(Plan::RecordCompute(i));
                    }
                }
                // Copies/writes mutate resources: always run, always dirty, and
                // bump the touched resource so dependent passes invalidate.
                other => {
                    self.touch_targets(other);
                    frame_dirty = true;
                    plan.push(Plan::RecordEncoder(i));
                }
            }
        }
        self.passes.retain(&live_passes);

        // 3. Execute only if something changed.
        if !frame_dirty {
            return stats; // fully served from cache — no GPU work, no present
        }

        self.backend.begin_frame();
        for p in &plan {
            match *p {
                Plan::Skip => {}
                Plan::RecordRender(i) | Plan::SurfaceMaybe(i) => {
                    if let EncoderCommand::RenderPass(rp) = &frame.commands[i] {
                        self.backend.record_render_pass(rp);
                        stats.passes_recorded += 1;
                    }
                }
                Plan::RecordCompute(i) => {
                    if let EncoderCommand::ComputePass(cp) = &frame.commands[i] {
                        self.backend.record_compute_pass(cp);
                        stats.passes_recorded += 1;
                    }
                }
                Plan::RecordEncoder(i) => {
                    self.backend.record_encoder_command(&frame.commands[i]);
                }
            }
        }
        self.backend.end_frame(self.dirty.rects());
        stats.presented = true;
        stats
    }

    /// Hash a render pass including the hashes of resources it references, so a
    /// changed buffer/pipeline invalidates the pass automatically.
    fn hash_render_pass(&self, rp: &RenderPass) -> u64 {
        let mut h = Xxh3::new();
        h.update(&content_hash(rp).to_le_bytes());
        for id in rp.referenced_resources() {
            h.update(&self.resources.resource_hash(&id).to_le_bytes());
        }
        h.digest()
    }

    fn hash_compute_pass(&self, cp: &elpa_protocol::ComputePass) -> u64 {
        let mut h = Xxh3::new();
        h.update(&content_hash(cp).to_le_bytes());
        for id in cp.referenced_resources() {
            h.update(&self.resources.resource_hash(&id).to_le_bytes());
        }
        h.digest()
    }

    /// Add a surface pass's scissor rects to the dirty region; if it has none,
    /// the whole surface is dirty.
    fn collect_surface_dirty(&mut self, rp: &RenderPass) {
        let mut any = false;
        for c in &rp.commands {
            if let RenderCommand::SetScissorRect { rect } = c {
                self.dirty.add(*rect);
                any = true;
            }
        }
        if !any {
            self.dirty.mark_full();
        }
    }

    /// Bump the destination resource of a copy/write so dependents invalidate.
    fn touch_targets(&mut self, cmd: &EncoderCommand) {
        match cmd {
            EncoderCommand::CopyBufferToBuffer { dst, .. }
            | EncoderCommand::CopyBufferToTexture { dst, .. }
            | EncoderCommand::CopyTextureToBuffer { dst, .. }
            | EncoderCommand::CopyTextureToTexture { dst, .. } => self.resources.touch(dst),
            EncoderCommand::WriteBuffer { buffer, .. } | EncoderCommand::ClearBuffer { buffer, .. } => {
                self.resources.touch(buffer)
            }
            EncoderCommand::WriteTexture { texture, .. } => self.resources.touch(texture),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::command::{ColorAttachment, TargetView};
    use elpa_protocol::resource::BufferDesc;
    use elpa_protocol::{ComputePass, Rect, RenderPass, ResourceDesc};

    #[derive(Default)]
    struct Mock {
        created: usize,
        updated: usize,
        destroyed: usize,
        render_recorded: usize,
        compute_recorded: usize,
        encoder_recorded: usize,
        frames_begun: usize,
        presents: usize,
        last_dirty: Vec<Rect>,
    }
    impl GpuBackend for Mock {
        fn create_resource(&mut self, _d: &ResourceDesc) {
            self.created += 1;
        }
        fn update_buffer(&mut self, _id: &str, _offset: u64, _bytes: &[u8]) {
            self.updated += 1;
        }
        fn destroy_resource(&mut self, _id: &str) {
            self.destroyed += 1;
        }
        fn begin_frame(&mut self) {
            self.frames_begun += 1;
        }
        fn record_render_pass(&mut self, _p: &RenderPass) {
            self.render_recorded += 1;
        }
        fn record_compute_pass(&mut self, _p: &ComputePass) {
            self.compute_recorded += 1;
        }
        fn record_encoder_command(&mut self, _c: &EncoderCommand) {
            self.encoder_recorded += 1;
        }
        fn end_frame(&mut self, dirty: &[Rect]) {
            self.presents += 1;
            self.last_dirty = dirty.to_vec();
        }
    }

    fn buf(id: &str, size: u64) -> ResourceDesc {
        ResourceDesc::Buffer(BufferDesc::new(id, size, vec!["VERTEX".into()]))
    }

    fn offscreen_pass(id: &str, vb: &str) -> EncoderCommand {
        EncoderCommand::RenderPass(RenderPass {
            id: Some(id.into()),
            color_attachments: vec![ColorAttachment {
                view: TargetView::Texture { texture: "sceneTex".into() },
                resolve_target: None,
                load: "clear".into(),
                store: true,
                clear_color: None,
            }],
            depth_stencil: None,
            commands: vec![RenderCommand::SetVertexBuffer { slot: 0, buffer: vb.into(), offset: 0 }],
        })
    }

    fn surface_pass(scissor: Option<Rect>) -> EncoderCommand {
        let mut commands = vec![RenderCommand::Draw {
            vertex_count: 3,
            instance_count: 1,
            first_vertex: 0,
            first_instance: 0,
        }];
        if let Some(r) = scissor {
            commands.insert(0, RenderCommand::SetScissorRect { rect: r });
        }
        EncoderCommand::RenderPass(RenderPass {
            id: Some("present".into()),
            color_attachments: vec![ColorAttachment {
                view: TargetView::Surface,
                resolve_target: None,
                load: "clear".into(),
                store: true,
                clear_color: None,
            }],
            depth_stencil: None,
            commands,
        })
    }

    fn scene_frame(vb_size: u64, scissor: Option<Rect>) -> Frame {
        Frame {
            resources: vec![buf("vb", vb_size)],
            commands: vec![offscreen_pass("scene", "vb"), surface_pass(scissor)],
        }
    }

    #[test]
    fn cold_frame_then_fully_cached_steady_state() {
        let mut r = Renderer::new(Mock::default());

        // Frame 1: create vb, record both passes, present.
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.resources_created, 1);
        assert_eq!(s.passes_recorded, 2);
        assert!(s.presented);

        // Frame 2: identical -> nothing created, offscreen pass cached, no work.
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.resources_created, 0);
        assert_eq!(s.passes_recorded, 0, "nothing should be recorded");
        assert_eq!(s.passes_cached, 1, "offscreen scene pass is a cache hit");
        assert!(!s.presented, "a fully cached frame must not present");
        assert_eq!(r.backend().frames_begun, 1, "no second encoder");
    }

    #[test]
    fn changing_a_buffer_invalidates_only_dependent_passes() {
        let mut r = Renderer::new(Mock::default());
        r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));

        // vb size changes -> resource recreated -> scene pass (reads vb) misses
        // -> frame dirty -> scene re-records and surface present runs again.
        let s = r.render(&scene_frame(128, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.resources_created, 1);
        assert_eq!(s.passes_recorded, 2, "scene + surface re-recorded");
        assert!(s.presented);
        assert_eq!(r.backend().last_dirty, vec![Rect::new(0, 0, 800, 600)]);
    }

    #[test]
    fn registered_layer_reuses_snapshot_until_explicitly_invalidated() {
        let mut r = Renderer::new(Mock::default());
        r.register_layer("scene");

        // Frame 1: layer painted once (snapshot built), surface composited.
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_repainted, 1);
        assert_eq!(s.layers_reused, 0);
        assert!(s.presented);

        // Frame 2: even though we re-emit an *identical* layer pass, an unchanged
        // hash is irrelevant — the snapshot is explicitly valid, so it is reused.
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_reused, 1, "snapshot reused with no record");
        assert_eq!(s.passes_recorded, 0);

        // Frame 3: changing the buffer would normally invalidate a content-hashed
        // pass — but a *layer* ignores content, so the snapshot is still reused.
        let s = r.render(&scene_frame(128, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_reused, 1, "explicit-only: content change does not repaint a layer");
        assert_eq!(s.layers_repainted, 0);

        // Now invalidate explicitly: the next frame repaints the snapshot.
        r.invalidate_layer("scene");
        let s = r.render(&scene_frame(128, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_repainted, 1, "explicit invalidation repaints");
        assert!(s.presented);
    }

    #[test]
    fn invalidate_forces_all_layers_to_repaint() {
        let mut r = Renderer::new(Mock::default());
        r.register_layer("scene");
        r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        // Reused in steady state.
        assert_eq!(r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600)))).layers_reused, 1);
        // A full invalidate (e.g. resize) forces a repaint.
        r.invalidate();
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_repainted, 1);
    }

    #[test]
    fn unregistering_a_layer_restores_content_hash_caching() {
        let mut r = Renderer::new(Mock::default());
        r.register_layer("scene");
        r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert!(r.unregister_layer("scene"));
        // No longer a layer: an identical re-submit is a normal content-hash hit.
        let s = r.render(&scene_frame(64, Some(Rect::new(0, 0, 800, 600))));
        assert_eq!(s.layers_reused, 0);
        assert_eq!(s.passes_cached, 1, "back to ordinary pass caching");
    }

    #[test]
    fn writebuffer_marks_frame_dirty_and_runs() {
        let mut r = Renderer::new(Mock::default());
        r.render(&scene_frame(64, Some(Rect::new(0, 0, 10, 10))));

        let mut f = scene_frame(64, Some(Rect::new(0, 0, 10, 10)));
        f.commands.insert(
            0,
            EncoderCommand::WriteBuffer {
                buffer: "vb".into(),
                offset: 0,
                data_b64: Some("AAAA".into()),
                data_f32: None,
                data_u32: None,
                data_u16: None,
            },
        );
        let s = r.render(&f);
        assert!(s.presented, "a queue write forces the frame to run");
        assert_eq!(r.backend().encoder_recorded, 1);
        // The write touched vb, so the scene pass that reads vb also re-records.
        assert!(s.passes_recorded >= 2);
    }
}
