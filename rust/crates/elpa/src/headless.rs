//! A GPU-less backend. It implements [`GpuBackend`] as no-ops with counters, so
//! an [`Elpa`](crate::Elpa) instance can run the full VM + caching + partial-
//! render pipeline with no graphics device — for tests, CI, headless servers, or
//! validating an app's frame logic before wiring real GPU output.

use elpa_protocol::{ComputePass, EncoderCommand, Rect, RenderPass, ResourceDesc};
use elpa_renderer::GpuBackend;

/// No-op backend that records how much work it was asked to do.
#[derive(Debug, Default, Clone)]
pub struct HeadlessBackend {
    pub resources_created: usize,
    pub resources_updated: usize,
    pub resources_destroyed: usize,
    pub render_passes: usize,
    pub compute_passes: usize,
    pub encoder_cmds: usize,
    pub presents: usize,
}

impl GpuBackend for HeadlessBackend {
    fn create_resource(&mut self, _desc: &ResourceDesc) {
        self.resources_created += 1;
    }
    fn update_buffer(&mut self, _id: &str, _offset: u64, _bytes: &[u8]) {
        self.resources_updated += 1;
    }
    fn destroy_resource(&mut self, _id: &str) {
        self.resources_destroyed += 1;
    }
    fn begin_frame(&mut self) {}
    fn record_render_pass(&mut self, _pass: &RenderPass) {
        self.render_passes += 1;
    }
    fn record_compute_pass(&mut self, _pass: &ComputePass) {
        self.compute_passes += 1;
    }
    fn record_encoder_command(&mut self, _cmd: &EncoderCommand) {
        self.encoder_cmds += 1;
    }
    fn end_frame(&mut self, _dirty: &[Rect]) {
        self.presents += 1;
    }
}
