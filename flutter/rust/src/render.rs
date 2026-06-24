//! The **native Elpa widget** path: Elpa's wgpu renderer painting into a texture
//! that Flutter samples directly, with no CPU copy of pixel data.
//!
//! This is the *optional* half of the system (the `gpu` feature). The DSL path —
//! the app describing a Flutter widget tree over the messaging pipe — needs no
//! GPU and is the default. The native path is for the cases where Elpa's own
//! wgpu rendering (custom shaders, 3D, liquid-glass effects) should appear inline
//! inside the Flutter tree as a single widget.
//!
//! ## Zero-copy contract
//!
//! Flutter's [`Texture`] widget composites an externally-owned GPU texture by
//! *id*. The host registers a texture with the engine's platform texture
//! registry and gets back an `int64` id; the Rust side renders into the GPU
//! texture that backs that id, and Flutter composites it on the raster thread
//! without the pixels ever touching the CPU. The exact handle differs per
//! platform, and that platform glue is what the `gpu` build wires up:
//!
//! * **Android** — a `SurfaceTexture` / `HardwareBuffer`; wgpu renders into a
//!   `wgpu::Texture` created from the imported `AHardwareBuffer` (Vulkan external
//!   memory), Flutter samples the same buffer.
//! * **iOS / macOS** — a `CVPixelBuffer` registered as a Flutter
//!   `FlutterTexture`; wgpu (Metal) renders into an `IOSurface`-backed
//!   `MTLTexture` sharing that buffer.
//! * **Linux / Windows** — a DMA-BUF / DXGI shared handle imported into wgpu and
//!   handed to Flutter's GL/ANGLE/D3D compositor.
//! * **Web** — Elpa already targets `wgpu` over WebGL/WebGPU; the canvas is
//!   composited under the Flutter web view (an `HtmlElementView`), so there is no
//!   texture id — the [`NativeSurface::Web`] variant carries the canvas selector.
//!
//! Keeping this seam in one module means the DSL path stays completely
//! GPU-free, and adding a platform only touches [`register_surface`].

/// How the host surfaces Elpa's GPU output to Flutter on the current platform.
/// The variants name the handle each platform's compositor expects; the Dart
/// side turns the [`NativeSurface::Texture`] id into a `Texture(textureId: …)`
/// widget, and [`NativeSurface::Web`] into an `HtmlElementView`.
#[derive(Debug, Clone)]
pub enum NativeSurface {
    /// A Flutter external-texture id (Android/iOS/macOS/desktop). Composited by
    /// `Texture(textureId)`.
    Texture { id: i64, width: u32, height: u32 },
    /// A platform-view canvas selector (web). Composited by `HtmlElementView`.
    Web { canvas_id: String },
    /// No native surface registered yet.
    None,
}

impl Default for NativeSurface {
    fn default() -> Self {
        NativeSurface::None
    }
}

/// A request from the app to size/configure its native render surface. Sent over
/// the pipe on an application channel and serviced by the host's GPU integration.
#[derive(Debug, Clone)]
pub struct SurfaceRequest {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// Register (or update) the native surface Elpa renders into and hand back the
/// [`NativeSurface`] descriptor Dart composites.
///
/// Without the `gpu` feature this is a no-op returning [`NativeSurface::None`]:
/// the engine runs headless and the UI comes entirely from the DSL pipe. With
/// `gpu`, the platform-specific build creates the shared texture, points Elpa's
/// `WgpuBackend` at it, and returns the id/selector.
#[allow(unused_variables)]
pub fn register_surface(req: SurfaceRequest) -> NativeSurface {
    #[cfg(feature = "gpu")]
    {
        // The platform integration lives here in a `gpu` build: import the shared
        // GPU buffer, build a `wgpu::Texture` view over it, configure the
        // `WgpuBackend`'s surface to target it, and register the buffer with the
        // platform texture registry to obtain the Flutter texture id. See the
        // README's "native widget" section for the per-platform wiring.
        gpu_impl::register_surface(req)
    }
    #[cfg(not(feature = "gpu"))]
    {
        NativeSurface::None
    }
}

#[cfg(feature = "gpu")]
mod gpu_impl {
    use super::{NativeSurface, SurfaceRequest};

    /// Placeholder for the platform-specific shared-texture wiring. A real `gpu`
    /// build replaces this with the import/registry calls for the target OS.
    pub fn register_surface(_req: SurfaceRequest) -> NativeSurface {
        NativeSurface::None
    }
}
