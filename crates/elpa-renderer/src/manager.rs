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

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use elpa_protocol::{EncoderCommand, Frame, RenderCommand, RenderPass};

use crate::backend::GpuBackend;
use crate::cache::{content_hash, PassCache, ResourceCache};
use crate::dirty::DirtyTracker;

/// Per-frame work report. The steady-state goal is
/// `resources_created == 0 && passes_recorded == 0 && !presented`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FrameStats {
    pub resources_created: usize,
    pub passes_recorded: usize,
    pub passes_cached: usize,
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
}

impl<B: GpuBackend> Renderer<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            resources: ResourceCache::new(),
            passes: PassCache::new(),
            dirty: DirtyTracker::new(),
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Map one submitted [`Frame`] onto the GPU.
    pub fn render(&mut self, frame: &Frame) -> FrameStats {
        let mut stats = FrameStats::default();
        self.dirty.clear();

        // 1. Resource reconciliation.
        stats.resources_created = self.resources.sync(&frame.resources, &mut self.backend);

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
                        if self.passes.is_valid(id, hash) {
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
        let mut h = DefaultHasher::new();
        content_hash(rp).hash(&mut h);
        for id in rp.referenced_resources() {
            self.resources.resource_hash(&id).hash(&mut h);
        }
        h.finish()
    }

    fn hash_compute_pass(&self, cp: &elpa_protocol::ComputePass) -> u64 {
        let mut h = DefaultHasher::new();
        content_hash(cp).hash(&mut h);
        for id in cp.referenced_resources() {
            self.resources.resource_hash(&id).hash(&mut h);
        }
        h.finish()
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
        ResourceDesc::Buffer(BufferDesc {
            id: id.into(),
            size,
            usage: vec!["VERTEX".into()],
            data_b64: None,
        })
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
    fn writebuffer_marks_frame_dirty_and_runs() {
        let mut r = Renderer::new(Mock::default());
        r.render(&scene_frame(64, Some(Rect::new(0, 0, 10, 10))));

        let mut f = scene_frame(64, Some(Rect::new(0, 0, 10, 10)));
        f.commands.insert(
            0,
            EncoderCommand::WriteBuffer { buffer: "vb".into(), offset: 0, data_b64: "AAAA".into() },
        );
        let s = r.render(&f);
        assert!(s.presented, "a queue write forces the frame to run");
        assert_eq!(r.backend().encoder_recorded, 1);
        // The write touched vb, so the scene pass that reads vb also re-records.
        assert!(s.passes_recorded >= 2);
    }
}
