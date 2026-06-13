//! The GPU backend trait — the seam where the drawing-management layer meets
//! the actual graphics API.
//!
//! The [`DrawingManager`](crate::DrawingManager) decides *what* to do (which
//! layers to rasterize, which cached textures to composite, which dirty rects to
//! scissor). A [`GpuBackend`] decides *how*, by mapping those decisions onto a
//! concrete API. The shipping implementation is wgpu (feature `wgpu-backend`);
//! a headless software backend is used for tests.

use elpa_protocol::{DrawCommand, LayerId, Rect};

/// A handle to one presented frame's worth of GPU work. Acquired at the start of
/// a frame and submitted at the end.
pub struct Frame {
    pub width: u32,
    pub height: u32,
}

/// Operations the drawing manager needs from a graphics API. A wgpu
/// implementation maps these to: render-pass-per-layer for `rasterize_layer`,
/// a textured-quad pass for `composite_layer`, and `set_scissor`/`present` to
/// the swapchain.
pub trait GpuBackend {
    /// Allocate (or resize) the offscreen texture backing a layer; returns the
    /// opaque texture id stored in [`crate::cache::CachedLayer`].
    fn ensure_layer_texture(&mut self, layer: LayerId, bounds: Rect) -> u64;

    /// Rasterize `commands` into the layer's offscreen texture. Only called when
    /// the layer's content hash changed (cache miss).
    fn rasterize_layer(&mut self, texture_id: u64, bounds: Rect, commands: &[DrawCommand]);

    /// Constrain subsequent compositing to the union of `dirty` (the scissor /
    /// clip used for partial presentation). Empty slice means full-frame.
    fn set_scissor(&mut self, dirty: &[Rect]);

    /// Blit a cached layer texture into the frame at its bounds.
    fn composite_layer(&mut self, frame: &mut Frame, texture_id: u64, bounds: Rect, opacity: f32);

    /// Acquire the next swapchain image.
    fn begin_frame(&mut self) -> Frame;

    /// Submit and present.
    fn present(&mut self, frame: Frame);

    /// Free a texture that the cache evicted.
    fn drop_texture(&mut self, texture_id: u64);
}
