//! Per-OS import of a platform shared buffer into a [`wgpu::Texture`] — the one
//! place the zero-copy contract is platform-specific.
//!
//! ## The handshake
//!
//! 1. A native Flutter **texture-registry plugin** (one per platform, under the
//!    project's runner) allocates a shared GPU buffer and registers it with
//!    Flutter's texture registry, getting back an `int64` texture id *and* the
//!    raw OS handle to that buffer.
//! 2. Dart calls `registerSurface(handle, rawHandle, width, height)` over the
//!    bridge; the FRB layer hands the raw handle to [`import_shared_texture`].
//! 3. We import the *same* memory into a [`wgpu::Texture`] via `wgpu-hal` external
//!    memory, so Elpa's renderer writes the texture Flutter samples — one
//!    allocation, no per-frame copy.
//!
//! ## Why this is a seam, not a single implementation
//!
//! External-memory import is entirely backend/OS specific:
//!
//! | OS            | Shared buffer        | wgpu backend | Import path                              |
//! |---------------|----------------------|--------------|------------------------------------------|
//! | Android       | `AHardwareBuffer`    | Vulkan       | `VK_ANDROID_external_memory_android_hardware_buffer` |
//! | Linux         | DMA-BUF fd           | Vulkan       | `VK_EXT_external_memory_dma_buf`         |
//! | iOS / macOS   | `IOSurface`          | Metal        | `MTLDevice::newTextureWithDescriptor:iosurface:plane:` |
//! | Windows       | DXGI shared `HANDLE` | DX12         | `ID3D12Device::OpenSharedHandle`         |
//!
//! Each requires the matching native toolchain (NDK / Xcode / MSVC) to build and
//! a real device to validate; none can be exercised from a Linux CI sandbox. So
//! the function below is the **single integration point**: it interprets the
//! handle per-OS and constructs the wgpu objects. Until a platform's external
//! image is wired, it returns `Err`, and the caller keeps the engine on its 2D
//! backend (the app still runs; the 3D card just stays blank) rather than crash.
//!
//! The exact `wgpu-hal` entry points are the same on every backend:
//! `Adapter::as_hal` / `Device::as_hal` to reach the raw device, the backend's
//! `Device::texture_from_raw` (hal) to wrap the imported image, then
//! `wgpu::Device::create_texture_from_hal` to surface it as a `wgpu::Texture`.

use crate::render::SharedTextureHandle;

/// Import `handle` into a wgpu device/queue + a render-target texture aliasing the
/// shared memory. `format` and `width`/`height` must match how the native plugin
/// allocated the buffer (the plugin and this side agree on `Rgba8Unorm`).
///
/// Returns the device and queue that own the import alongside the texture, so the
/// caller can build a [`elpa::WgpuBackend`] that renders into it.
pub fn import_shared_texture(
    handle: SharedTextureHandle,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
) -> Result<(wgpu::Device, wgpu::Queue, wgpu::Texture), String> {
    #[cfg(target_os = "android")]
    {
        android::import(handle, format, width, height)
    }
    #[cfg(target_os = "linux")]
    {
        linux::import(handle, format, width, height)
    }
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        apple::import(handle, format, width, height)
    }
    #[cfg(target_os = "windows")]
    {
        windows::import(handle, format, width, height)
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "linux",
        target_os = "ios",
        target_os = "macos",
        target_os = "windows"
    )))]
    {
        let _ = (handle, format, width, height);
        Err("no shared-texture import for this target".into())
    }
}

// The per-OS modules below name the precise external-memory entry points and own
// the unsafe interop. Each builds: a wgpu instance on the OS's backend, an
// adapter/device with the external-memory features enabled, and a `wgpu::Texture`
// wrapping the imported image. They are compiled only for their target so a wrong
// guess on one OS can never break another platform's (or CI's) build.

#[cfg(target_os = "android")]
mod android {
    use crate::render::SharedTextureHandle;

    /// Import an `AHardwareBuffer` (`handle.raw as *mut AHardwareBuffer`) as a
    /// Vulkan external image and wrap it as a `wgpu::Texture`.
    ///
    /// Steps (Vulkan backend): create the instance/device with
    /// `VK_ANDROID_external_memory_android_hardware_buffer` (+ its deps:
    /// `VK_KHR_external_memory`, `VK_KHR_sampler_ycbcr_conversion`,
    /// `VK_EXT_queue_family_foreign`); query the buffer's
    /// `VkAndroidHardwareBufferPropertiesANDROID`; create a `VkImage` with an
    /// `VkExternalMemoryImageCreateInfo` + `VkExternalFormatANDROID`; allocate
    /// memory with `VkImportAndroidHardwareBufferInfoANDROID` and bind it; then
    /// surface it via `wgpu_hal::vulkan::Device::texture_from_raw` +
    /// `wgpu::Device::create_texture_from_hal`.
    pub fn import(
        handle: SharedTextureHandle,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<(wgpu::Device, wgpu::Queue, wgpu::Texture), String> {
        let _ = (handle, format, width, height);
        Err("android AHardwareBuffer import not yet wired (see module docs)".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::render::SharedTextureHandle;

    /// Import a DMA-BUF (`handle.raw as RawFd`) as a Vulkan external image.
    ///
    /// Steps (Vulkan backend): enable `VK_EXT_external_memory_dma_buf` +
    /// `VK_KHR_external_memory_fd`; create a `VkImage` with
    /// `VkExternalMemoryImageCreateInfo { DMA_BUF }` and an explicit
    /// `VkImageDrmFormatModifierExplicitCreateInfoEXT`; import the fd with
    /// `VkImportMemoryFdInfoKHR` and bind; wrap via
    /// `wgpu_hal::vulkan::Device::texture_from_raw` +
    /// `wgpu::Device::create_texture_from_hal`.
    pub fn import(
        handle: SharedTextureHandle,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<(wgpu::Device, wgpu::Queue, wgpu::Texture), String> {
        let _ = (handle, format, width, height);
        Err("linux DMA-BUF import not yet wired (see module docs)".into())
    }
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod apple {
    use crate::render::SharedTextureHandle;

    /// Import an `IOSurface` (`handle.raw as IOSurfaceRef`) as a Metal texture.
    ///
    /// Steps (Metal backend): reach the `MTLDevice` via
    /// `wgpu_hal::metal::Device::as_raw`; build an `MTLTextureDescriptor`
    /// (`bgra8Unorm`/`rgba8Unorm`, `usage = .renderTarget | .shaderRead`); call
    /// `newTextureWithDescriptor:iosurface:plane:` with the registered surface;
    /// wrap via `wgpu_hal::metal::Device::texture_from_raw` +
    /// `wgpu::Device::create_texture_from_hal`. (`IOSurface` is inherently shared,
    /// so no explicit external-memory extension is needed.)
    pub fn import(
        handle: SharedTextureHandle,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<(wgpu::Device, wgpu::Queue, wgpu::Texture), String> {
        let _ = (handle, format, width, height);
        Err("apple IOSurface import not yet wired (see module docs)".into())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use crate::render::SharedTextureHandle;

    /// Import a DXGI shared `HANDLE` (`handle.raw as isize`) as a DX12 resource.
    ///
    /// Steps (DX12 backend): reach the `ID3D12Device` via
    /// `wgpu_hal::dx12::Device::raw_device`; `OpenSharedHandle` to get the shared
    /// `ID3D12Resource`; wrap via `wgpu_hal::dx12::Device::texture_from_raw` +
    /// `wgpu::Device::create_texture_from_hal`. The plugin must create the source
    /// resource with `D3D12_HEAP_FLAG_SHARED` and a Flutter-compatible format.
    pub fn import(
        handle: SharedTextureHandle,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<(wgpu::Device, wgpu::Queue, wgpu::Texture), String> {
        let _ = (handle, format, width, height);
        Err("windows DXGI shared-handle import not yet wired (see module docs)".into())
    }
}
