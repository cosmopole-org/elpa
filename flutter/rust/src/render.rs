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

/// The opaque, platform-specific handle to a shared GPU buffer that a native
/// Flutter texture-registry plugin allocated and registered. The plugin hands
/// this to Rust so the bridge can import the *same* memory into a
/// [`wgpu::Texture`] — wgpu renders into it, Flutter samples it, one allocation,
/// zero copies. The numeric value's meaning is per-platform (see [`import`]):
///
/// * **Android** — pointer to an `AHardwareBuffer` (`*mut AHardwareBuffer as i64`).
/// * **iOS / macOS** — an `IOSurfaceRef` (`*mut __IOSurface as i64`).
/// * **Linux** — a DMA-BUF file descriptor (`RawFd as i64`).
/// * **Windows** — a shared NT `HANDLE` to a D3D12 resource (`isize as i64`).
#[derive(Debug, Clone, Copy)]
pub struct SharedTextureHandle {
    pub raw: i64,
    /// Bytes per row of the shared allocation, when the platform pads rows (e.g.
    /// an `AHardwareBuffer` stride); `0` means tightly packed (`width * 4`).
    pub row_stride: u32,
}

/// The GPU backend an Elpa engine drives, selected at runtime. An engine always
/// **boots** on [`LiveBackend::Headless`] so the 2D/DSL path runs with no GPU and
/// the app is interactive immediately. When the host registers a platform render
/// surface (a web canvas or a native shared texture) the engine swaps in
/// [`LiveBackend::Wgpu`] *in place* — the same VM and the same app state, now
/// painting real pixels into the surface Flutter composites. Keeping the choice
/// behind one enum (rather than monomorphizing the whole [`elpa::Elpa`] over the
/// backend) is what lets the upgrade happen after boot, asynchronously, once the
/// surface size is known from Flutter layout.
pub enum LiveBackend {
    /// GPU-free: drives the full VM + caching + partial-render pipeline as no-ops.
    Headless(elpa::HeadlessBackend),
    /// A live wgpu backend rendering into the registered surface/texture.
    #[cfg(feature = "gpu")]
    Wgpu(Box<elpa::WgpuBackend<'static>>),
}

impl Default for LiveBackend {
    fn default() -> Self {
        LiveBackend::Headless(elpa::HeadlessBackend::default())
    }
}

/// Delegate a [`GpuBackend`] method to whichever variant is live. (`Wgpu` is only
/// a possible arm under the `gpu` feature.)
macro_rules! dispatch {
    ($self:ident, $b:ident => $call:expr) => {
        match $self {
            LiveBackend::Headless($b) => $call,
            #[cfg(feature = "gpu")]
            LiveBackend::Wgpu($b) => $call,
        }
    };
}

impl elpa::GpuBackend for LiveBackend {
    fn create_resource(&mut self, desc: &elpa::protocol::ResourceDesc) {
        dispatch!(self, b => b.create_resource(desc))
    }
    fn update_buffer(&mut self, id: &str, offset: u64, bytes: &[u8]) {
        dispatch!(self, b => b.update_buffer(id, offset, bytes))
    }
    fn destroy_resource(&mut self, id: &str) {
        dispatch!(self, b => b.destroy_resource(id))
    }
    fn begin_frame(&mut self) {
        dispatch!(self, b => b.begin_frame())
    }
    fn record_render_pass(&mut self, pass: &elpa::protocol::RenderPass) {
        dispatch!(self, b => b.record_render_pass(pass))
    }
    fn record_compute_pass(&mut self, pass: &elpa::protocol::ComputePass) {
        dispatch!(self, b => b.record_compute_pass(pass))
    }
    fn record_encoder_command(&mut self, cmd: &elpa::protocol::EncoderCommand) {
        dispatch!(self, b => b.record_encoder_command(cmd))
    }
    fn end_frame(&mut self, dirty: &[elpa::protocol::Rect]) {
        dispatch!(self, b => b.end_frame(dirty))
    }
    fn surface_format_token(&self) -> String {
        dispatch!(self, b => b.surface_format_token())
    }
    fn surface_size(&self) -> Option<(u32, u32)> {
        dispatch!(self, b => b.surface_size())
    }
}

/// Build a live wgpu backend over a **native shared texture** (the zero-copy
/// Flutter `Texture` path). The platform plugin already allocated the shared
/// buffer and registered it with Flutter's texture registry; `handle` names that
/// buffer. We import it into a [`wgpu::Texture`] on a wgpu device and wrap it in a
/// backend that renders into it every frame. Blocks on device acquisition (native
/// has real threads, so a synchronous FRB call is fine here).
///
/// Returns `None` if the platform import is unavailable (e.g. an unsupported
/// adapter), in which case the engine stays on its current backend and the 2D UI
/// keeps running.
#[cfg(all(feature = "gpu", not(target_arch = "wasm32")))]
pub fn build_native_backend(
    handle: SharedTextureHandle,
    width: u32,
    height: u32,
) -> Option<elpa::WgpuBackend<'static>> {
    let format = wgpu::TextureFormat::Rgba8Unorm;
    match crate::import::import_shared_texture(handle, format, width, height) {
        Ok((device, queue, texture)) => Some(elpa::WgpuBackend::from_imported_texture(
            device, queue, texture, format, width, height,
        )),
        Err(e) => {
            eprintln!("elpa: shared-texture import failed ({e}); keeping 2D-only backend");
            None
        }
    }
}

/// Build a live wgpu backend over an **HTML canvas** (the web path). Flutter hosts
/// the canvas as a platform view (`HtmlElementView`); we make a wgpu surface
/// straight from it and render into it inline with the rest of the page. Async:
/// the browser exposes adapter/device acquisition only as promises, and on the
/// app's single-threaded wasm there is no thread to block on, so the caller awaits
/// this from an async FRB entry point.
#[cfg(all(feature = "gpu", target_arch = "wasm32"))]
pub async fn build_web_backend(
    canvas: web_sys::HtmlCanvasElement,
    width: u32,
    height: u32,
) -> Option<elpa::WgpuBackend<'static>> {
    let instance = wgpu::util::new_instance_with_webgpu_detection(
        wgpu::InstanceDescriptor::new_without_display_handle_from_env(),
    )
    .await;
    // Build the canvas surface with an explicit (empty) web display handle so both
    // the WebGPU and the WebGL fallback backends accept it (WebGL rejects a
    // missing display handle). This mirrors the standalone web example.
    let surface = {
        let value: &wasm_bindgen::JsValue = canvas.as_ref();
        let obj = core::ptr::NonNull::from(value).cast();
        let raw_window_handle = wgpu::rwh::WebCanvasWindowHandle::new(obj).into();
        let raw_display_handle = wgpu::rwh::RawDisplayHandle::Web(wgpu::rwh::WebDisplayHandle::new());
        match unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(raw_display_handle),
                raw_window_handle,
            })
        } {
            Ok(s) => s,
            Err(e) => {
                web_sys::console::error_1(&format!("elpa: canvas surface failed: {e}").into());
                return None;
            }
        }
    };
    // Tolerate "no GPU adapter" (e.g. a headless browser without WebGL/WebGPU):
    // fall back to the 2D backend instead of trapping the whole app.
    elpa::WgpuBackend::try_new_seeded(&instance, surface, width.max(1), height.max(1), None).await
}

