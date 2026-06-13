# Elpa web example

Runs an Elpa app and draws its wgpu frames to a **full-window, DPI-aware HTML
canvas**. The app (built as Elpian AST in [`src/app_ast.rs`](src/app_ast.rs))
draws a triangle over an animated background; the background color advances every
animation frame while the shader and pipeline are created **once** and reused —
demonstrating Elpa's resource caching and partial rendering on real wgpu.

This crate is intentionally **excluded from the workspace** (it pulls the full
wgpu + web-sys stack and only targets wasm). Build it on its own.

## What it shows

- A single `Elpa` instance owning the VM + renderer + live `WgpuBackend`.
- The canvas fills the viewport and tracks `devicePixelRatio`, so it renders
  crisply and with correct aspect on phone, tablet, and desktop. On `resize` the
  swapchain is reconfigured and the app's `onResize` re-fits.
- Pointer events flow into the app's `onEvent`; `requestAnimationFrame` drives
  `onFrame`.

## Build & serve

### Option A — Trunk (recommended)

```bash
# one-time tooling
rustup target add wasm32-unknown-unknown
cargo install trunk

# from this directory
cd examples/web
trunk serve --release --open
```

`index.html` has `<link data-trunk rel="rust" />`, so Trunk compiles this crate
to wasm, runs `wasm-bindgen`, and serves it. Open the shown localhost URL.

### Option B — wasm-pack + any static server

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

cd examples/web
wasm-pack build --release --target web --out-dir pkg
# Then serve a small index that imports ./pkg/elpa_web_example.js and calls
# its default init(); or use Trunk above which does this for you.
python3 -m http.server 8080
```

## Notes

- **WebGPU** is used where available; the `webgl` feature is enabled as a
  fallback for browsers without WebGPU. Serve over `http://localhost` or HTTPS
  (WebGPU is unavailable on `file://`).
- The format the app's pipeline targets is read from the live surface
  (`backend.surface_format()`) and injected into the AST, so it always matches.
- To see the partial-render/caching effect, note that resizing or animating only
  re-records the surface pass — the shader and render pipeline are never
  recreated after the first frame.
