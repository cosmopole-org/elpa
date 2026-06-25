//! A GPU-less scene backend. It implements [`SceneBackend`] as no-ops with
//! counters, so an [`Elpa`](crate::Elpa) instance can run the full VM + scene
//! orchestration with no graphics device — the scene-path analog of
//! [`HeadlessBackend`](crate::HeadlessBackend), for tests, CI, and validating an
//! app's vello drawing-op stream before wiring real Vello output.

use elpa_protocol::{Rect, SceneOp, SceneResource};
use elpa_renderer::SceneBackend;

/// No-op scene backend that records how much drawing work it was asked to do.
#[derive(Debug, Default, Clone)]
pub struct HeadlessSceneBackend {
    pub resources_ensured: usize,
    pub resources_dropped: usize,
    pub scenes_begun: usize,
    pub ops_encoded: usize,
    /// Raw wgpu frames composited as scene ops (the subset op).
    pub raw_frames: usize,
    pub fills: usize,
    pub strokes: usize,
    pub layers_pushed: usize,
    pub glyph_runs: usize,
    pub presents: usize,
}

impl SceneBackend for HeadlessSceneBackend {
    fn ensure_resource(&mut self, _res: &SceneResource) {
        self.resources_ensured += 1;
    }
    fn drop_resource(&mut self, _id: &str) {
        self.resources_dropped += 1;
    }
    fn begin_scene(&mut self) {
        self.scenes_begun += 1;
    }
    fn encode_op(&mut self, op: &SceneOp) {
        self.ops_encoded += 1;
        match op {
            SceneOp::Fill { .. } => self.fills += 1,
            SceneOp::Stroke { .. } => self.strokes += 1,
            SceneOp::PushLayer { .. } => self.layers_pushed += 1,
            SceneOp::DrawGlyphs { .. } => self.glyph_runs += 1,
            SceneOp::RawWgpu { .. } => self.raw_frames += 1,
            _ => {}
        }
    }
    fn present_scene(&mut self, _dirty: &[Rect]) {
        self.presents += 1;
    }
}
