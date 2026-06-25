# Native texture plugins (zero-copy 3D on desktop/mobile)

On the web, Elpa's `Native3DView` hosts a `<canvas>` and wgpu renders straight
into it — no native code needed (see `lib/src/elpa/native/elpa_surface_web.dart`).

On **desktop and mobile** the zero-copy path needs a small per-OS plugin, because
only platform code can allocate a GPU buffer that Flutter's compositor and wgpu
can *both* see, and register it with Flutter's texture registry. This directory
holds reference implementations and documents the contract that the Dart side
(`elpa_surface_io.dart`) and the Rust importer (`rust/src/import.rs`) agree on.

## The contract

A `MethodChannel("com.elpa/native_texture")` with two methods:

| Method    | Args                         | Returns                                            |
|-----------|------------------------------|----------------------------------------------------|
| `create`  | `{ width:int, height:int }`  | `{ textureId:int, handle:int, rowStride:int }`     |
| `release` | `{ textureId:int }`          | —                                                  |

* **`textureId`** — the id Flutter's texture registry returned; the `Texture`
  widget composites it.
* **`handle`** — the raw OS handle to the *same* shared buffer, passed to Rust
  so wgpu imports it (an `AHardwareBuffer*` / `IOSurfaceRef` / DMA-BUF fd / DXGI
  `HANDLE`, reinterpreted as an `int`). See `SharedTextureHandle` in
  `rust/src/render.rs`.
* **`rowStride`** — the buffer's byte stride if the platform pads rows; `0` when
  tightly packed (`width * 4`).

The flow (driven by `ElpaNativeView` → `elpa_surface_io.dart`):

1. Dart calls `create` → plugin allocates the shared buffer, registers it with
   Flutter's texture registry, returns `{ textureId, handle, rowStride }`.
2. Dart builds `Texture(textureId: …)` and, once mounted, calls the bridge's
   `registerSurface(rawHandle: handle, …)`.
3. Rust (`import::import_shared_texture`) imports `handle` into a `wgpu::Texture`
   via `wgpu-hal` external memory and installs a live wgpu backend that renders
   into it. Flutter samples the same memory — one allocation, zero copies.

## Per-OS allocation + import

| OS          | Shared buffer        | Texture registry              | wgpu import (`rust/src/import.rs`)          |
|-------------|----------------------|-------------------------------|---------------------------------------------|
| Android     | `AHardwareBuffer`    | `SurfaceTextureEntry`         | `VK_ANDROID_external_memory_…hardware_buffer` |
| iOS / macOS | `IOSurface`          | `FlutterTexture`              | `MTLDevice newTextureWithDescriptor:iosurface:` |
| Linux       | DMA-BUF              | `TextureRegistrar` (pixel/GL) | `VK_EXT_external_memory_dma_buf`            |
| Windows     | DXGI shared `HANDLE` | `TextureRegistrar` (D3D)      | `ID3D12Device::OpenSharedHandle`            |

`android/ElpaNativeTexturePlugin.kt` is a structured reference for the Android
half. The Rust importer in `rust/src/import.rs` is the matching seam — each OS
function there documents the exact external-memory entry points; it returns an
error until wired, in which case `registerSurface` reports `false` and the app
runs 2D-only (the `Native3DView` stays a sized placeholder) rather than crash.

> These plugins require the platform toolchains (NDK / Xcode / MSVC) and a real
> device/GPU to build and validate; they cannot be exercised from a Linux CI
> sandbox. Drop the file for your OS into the generated runner (e.g.
> `android/app/src/main/kotlin/…`) and register it with the engine.
