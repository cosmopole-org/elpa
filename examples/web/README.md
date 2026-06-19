# Elpa web example

Runs an Elpa app and draws its wgpu frames to a **full-window, DPI-aware HTML
canvas**. The app is the **Material Design 3 example**
([`examples/material`](../material)), a Flutter-style widget framework written in
**JavaScript**: a widget SDK linked ahead of an app that composes a widget tree
and calls `runApp`. Elpa compiles the whole thing to its VM
(`Elpa::new_from_js`); the SDK's component runtime lays out an **interactive** M3
surface — buttons, a FAB, a switch, checkbox, radio group, slider, chip, linear
progress and cards — and packs every frame into one instanced rounded-rect draw.
The shared shader and pipeline are created **once** and cached; only the instance
data changes — demonstrating Elpa's resource caching and partial rendering on
real wgpu. This is what the repo's GitHub Pages site shows.

`src/lib.rs` builds the linked program with `elpa_material::program()` —
retargeting the pipeline's color format to the live surface — runs it with
`Elpa::new_from_js`, and forwards **pointer, wheel and keyboard** events into the
app. All layout and interaction logic lives entirely in the framework's
JavaScript, not in this crate.

### Try it

- **Tap / click** buttons, the FAB, switch, checkbox, radios and chip.
- **Drag** the slider thumb (or hover for the buttons' state layers).
- **Scroll** the mouse wheel to nudge the slider.
- **Keys:** ◀ / ▶ nudge the slider, `d` toggles dark mode, space toggles the
  switch, `r` resets everything. The FAB cycles the accent color.

This crate is intentionally **excluded from the workspace** (it pulls the full
wgpu + web-sys stack and only targets wasm). Build it on its own.

### Run the 3D game demo instead

The same host can run the **Game3D engine demo** ([`examples/game3d`](../game3d)) —
a lit, animated 3D scene (a ground plane, a spinning metallic cube, a bobbing
sphere and an orbiting point light) from the object-oriented `elpa-game3d` SDK.
Build with the `game3d` feature, which embeds `game3d/assets/demo.bc` instead of
the Material gallery:

```bash
trunk build --release --features game3d
# or, with wasm-pack:
wasm-pack build --release -- --features game3d
```

Pointer/resize events flow into the engine unchanged (the demo casts a pick ray
on tap). Regenerate the bytecode after editing the SDK with
`cargo run -p elpa-game3d --bin build_bytecode`.

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
