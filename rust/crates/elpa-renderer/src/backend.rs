//! The GPU backend trait — the seam where the command tree meets wgpu.
//!
//! [`Renderer`](crate::Renderer) decides *what* to do (which resources to
//! (re)create, which passes to record or skip, what to scissor). A [`GpuBackend`]
//! decides *how*, mapping each call to wgpu, one-to-one:
//!
//! | `GpuBackend` method     | wgpu realization                                   |
//! |-------------------------|----------------------------------------------------|
//! | `create_resource`       | `device.create_buffer/texture/sampler/shader_module/bind_group_layout/bind_group/pipeline_layout/render_pipeline/compute_pipeline` (dispatch on `ResourceDesc`). |
//! | `update_buffer`         | `queue.write_buffer` into the existing allocation (data-only change). |
//! | `destroy_resource`      | drop the cached wgpu handle.                       |
//! | `begin_frame`           | `surface.get_current_texture` + `device.create_command_encoder`. |
//! | `record_render_pass`    | `encoder.begin_render_pass` + replay each `RenderCommand` (`set_pipeline`, `set_bind_group`, `set_vertex_buffer`, `draw_indexed`, `set_scissor_rect`, …). |
//! | `record_compute_pass`   | `encoder.begin_compute_pass` + `set_pipeline`/`set_bind_group`/`dispatch_workgroups`. |
//! | `record_encoder_command`| `encoder.copy_*` / `queue.write_buffer`/`write_texture`/`clear_buffer`. |
//! | `end_frame`             | `queue.submit` + `frame.present`, honoring the dirty scissor. |
//!
//! Crucially, when [`Renderer`] decides a pass is a cache hit it simply does not
//! call `record_render_pass` — the backend's previously-rendered target texture
//! stands in. That omission *is* the partial-rendering speedup.

use elpa_protocol::{ComputePass, EncoderCommand, Rect, RenderPass, ResourceDesc};

pub trait GpuBackend {
    /// Create or replace the GPU object for `desc` (dispatch on its variant).
    fn create_resource(&mut self, desc: &ResourceDesc);

    /// Refill an existing buffer's contents in place via a queue write, reusing
    /// its GPU allocation. Called by the cache when a buffer is re-declared with
    /// new data but an unchanged size/usage (and `COPY_DST`), so an app that
    /// rebuilds a dynamic buffer every frame does not churn GPU allocations.
    fn update_buffer(&mut self, id: &str, offset: u64, bytes: &[u8]);

    /// Release the GPU object previously created for `id`.
    fn destroy_resource(&mut self, id: &str);

    /// Acquire the swapchain image and start a command encoder for this frame.
    fn begin_frame(&mut self);

    /// Encode one render pass (cache miss / uncacheable only).
    fn record_render_pass(&mut self, pass: &RenderPass);

    /// Encode one compute pass (cache miss / uncacheable only).
    fn record_compute_pass(&mut self, pass: &ComputePass);

    /// Encode a copy or queue-write command.
    fn record_encoder_command(&mut self, cmd: &EncoderCommand);

    /// Submit the encoder and present, scissored to `dirty` (empty == full).
    fn end_frame(&mut self, dirty: &[Rect]);

    /// The protocol token for the surface's color format (e.g. `"bgra8unorm"`,
    /// `"bgra8unorm-srgb"`). Apps read this via `gpu.surfaceInfo` so a render
    /// pipeline's color target matches the live surface on every backend — wgpu
    /// requires the pipeline target format to equal the surface format exactly.
    /// Defaults to `"bgra8unorm"`, which suits the headless/test backend and is
    /// the historical default; a live backend overrides it with its real format.
    fn surface_format_token(&self) -> String {
        "bgra8unorm".to_string()
    }

    /// The live render surface's size in physical pixels, when the backend draws
    /// into a real surface/texture (vs. the host window). Apps read this via
    /// `gpu.surfaceInfo` so they size per-frame render targets — a depth texture,
    /// an offscreen pass — to the *actual* surface, which wgpu requires to match
    /// the color attachment exactly. This matters when the GPU surface is a
    /// sub-region of the window (e.g. an inline native widget / `Native3DView`
    /// composited into a larger Flutter tree): the window the 2D UI lays out
    /// against is *not* the swapchain the 3D scene renders into.
    ///
    /// `None` (the default) means "no distinct GPU surface" — the headless/test
    /// backend — so `gpu.surfaceInfo` keeps reporting the host window size.
    fn surface_size(&self) -> Option<(u32, u32)> {
        None
    }
}
