# Elpa web example

Runs an Elpa app and draws its wgpu frames to a **full-window, DPI-aware HTML
canvas**. The app is the **engine SDK example** ([`examples/sdk`](../sdk)), which
is itself Elpian AST JSON: it `vm.import`s the SDK module and draws a rotating 3D
cube and sphere with a 2D rect / triangle / circle overlay, all referenced by id.
The shared shaders and pipelines are created **once** and cached; only the
per-frame instance data changes — demonstrating Elpa's reusable definitions,
resource caching, and partial rendering on real wgpu. This is what the repo's
GitHub Pages site shows.

`src/lib.rs` registers the SDK module (`elpa_sdk::MODULE_AST`) as the asset the
demo imports — retargeting the pipelines' color format to the live surface — and
runs `elpa_sdk::DEMO_AST`. The drawing logic lives entirely in the SDK's JSON, not
in this crate.

This crate is intentionally **excluded from the workspace** (it pulls the full
wgpu + web-sys stack and only targets wasm). Build it on its own.

## What it shows

- A single `Elpa` instance owning the VM + renderer + live `WgpuBackend`, running
  an imported Elpian-AST SDK module.
- The canvas fills the viewport and tracks `devicePixelRatio`; the scene sizes
  itself from `gpu.surfaceInfo`, so it renders crisply and with correct aspect on
  phone, tablet, and desktop. On `resize` the swapchain is reconfigured and the
  app's `onResize` re-fits.
- `requestAnimationFrame` drives `onFrame`, advancing the rotation each tick.

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
- The format the pipelines target is read from the live surface
  (`backend.surface_format()`) and substituted into the imported SDK module, so it
  always matches the swapchain.
- To see the caching effect, note that animating only re-records the passes with
  changed instance data — the SDK's shaders and render pipelines are created once
  and never recreated.

## Build on Linux

This repository includes a small helper script to build the web example on
Linux using Trunk. From this directory run:

```bash
cd examples/web
./build-linux.sh
```

The script ensures the `wasm32-unknown-unknown` target is installed, builds
the workspace artifacts in release mode, and runs `trunk build --release`.
