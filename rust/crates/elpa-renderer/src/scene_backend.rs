//! The scene backend trait — the seam where the [`Scene`] meets Vello.
//!
//! [`SceneRenderer`](crate::SceneRenderer) decides *what* to do (which scene
//! resources to (re)upload, whether a scene changed at all). A [`SceneBackend`]
//! decides *how*, mapping each [`SceneOp`] onto a `vello::Scene` call:
//!
//! | `SceneBackend` method | Vello realization                                    |
//! |-----------------------|------------------------------------------------------|
//! | `ensure_resource`     | decode + upload an image into a `vello::Image`, or register a font blob. |
//! | `begin_scene`         | `Scene::reset()` — start a fresh scene for this frame. |
//! | `encode_op` (fill)    | `Scene::fill(style, transform, brush, brush_transform, &shape)`. |
//! | `encode_op` (stroke)  | `Scene::stroke(&Stroke, transform, brush, brush_transform, &shape)`. |
//! | `encode_op` (push/pop)| `Scene::push_layer(blend, alpha, transform, &clip)` / `pop_layer()`. |
//! | `encode_op` (image)   | `Scene::draw_image(&image, transform)`.              |
//! | `encode_op` (glyphs)  | `Scene::draw_glyphs(font)…draw(brush, glyphs)`.      |
//! | `encode_op` (rawWgpu) | flush the vello scene, run the wgpu command tree into the same target, continue. |
//! | `present_scene`       | `vello::Renderer::render_to_*` + present, scissored to `dirty`. |
//!
//! The crucial [`SceneOp::RawWgpu`] case is what makes direct wgpu a *subset* of
//! the scene vocabulary: the backend composites a raw command tree into the very
//! surface the vector ops paint, rather than into a separate target.

use elpa_protocol::{Rect, Scene, SceneOp, SceneResource};

pub trait SceneBackend {
    /// Create or replace the GPU object for a scene resource (image/font),
    /// keyed by its id. Called by the renderer only when the resource is new or
    /// its content hash changed, so static images/fonts cost nothing after the
    /// first frame.
    fn ensure_resource(&mut self, res: &SceneResource);

    /// Release the cached object for a scene resource id that vanished.
    fn drop_resource(&mut self, id: &str);

    /// Start encoding a fresh scene for this frame (Vello `Scene::reset`).
    fn begin_scene(&mut self);

    /// Encode one operation into the current scene. The backend dispatches on the
    /// [`SceneOp`] variant; [`SceneOp::RawWgpu`] is composited into the same
    /// target via the wgpu renderer rather than the vello encoder.
    fn encode_op(&mut self, op: &SceneOp);

    /// Rasterize the encoded scene to the surface and present, honoring the
    /// dirty region (`dirty` empty == present the whole surface).
    fn present_scene(&mut self, dirty: &[Rect]);

    /// Convenience: encode every op of a whole scene in order. The default walks
    /// `scene.ops`; a backend rarely needs to override it.
    fn encode_scene(&mut self, scene: &Scene) {
        for op in &scene.ops {
            self.encode_op(op);
        }
    }

    /// Reconfigure the live render surface to a new physical size (a swapchain
    /// resize). The default is a no-op — a headless/offscreen backend has no
    /// resizable surface; the live Vello backend reconfigures its surface so the
    /// next present matches the window.
    fn resize(&mut self, _width: u32, _height: u32) {}

    /// The surface's color-format token (e.g. `"rgba8unorm"`), reported to the
    /// app via `gpu.surfaceInfo` so it can match render targets to the surface.
    fn surface_format_token(&self) -> String {
        "rgba8unorm".to_string()
    }

    /// The live render surface size in physical pixels, when the backend draws
    /// into a real surface/texture (vs. the host window). `None` (default) means
    /// "no distinct GPU surface" — the headless backend.
    fn surface_size(&self) -> Option<(u32, u32)> {
        None
    }
}

/// Forwarding impl so a [`SceneRenderer`](crate::SceneRenderer) can be driven
/// over a boxed trait object — letting a host hold one renderer type while
/// swapping a headless backend for the live Vello one at runtime (the scene
/// analog of [`Renderer::replace_backend`](crate::Renderer::replace_backend)).
impl SceneBackend for Box<dyn SceneBackend> {
    fn ensure_resource(&mut self, res: &SceneResource) {
        (**self).ensure_resource(res)
    }
    fn drop_resource(&mut self, id: &str) {
        (**self).drop_resource(id)
    }
    fn begin_scene(&mut self) {
        (**self).begin_scene()
    }
    fn encode_op(&mut self, op: &SceneOp) {
        (**self).encode_op(op)
    }
    fn present_scene(&mut self, dirty: &[Rect]) {
        (**self).present_scene(dirty)
    }
    fn resize(&mut self, width: u32, height: u32) {
        (**self).resize(width, height)
    }
    fn surface_format_token(&self) -> String {
        (**self).surface_format_token()
    }
    fn surface_size(&self) -> Option<(u32, u32)> {
        (**self).surface_size()
    }
}
