# __APP_TITLE__

A **wgpu + Flutter Elpa** project: the Flutter + flutter_rust_bridge + Elpa stack,
where the app's **2D UI** is streamed from the Elpian VM to real Flutter widgets,
and a **3D scene** is rendered by Elpa's own **wgpu** pipeline into an
`Native3DView` — the zero-copy surface that links wgpu to Flutter.

The complete Elpa engine, the Flutter bridge (including the wgpu native-widget
path), and the SDK are vendored into this project.

## Layout

| Path | What it is |
|------|------------|
| `engine/` | The vendored Elpa engine (VM + renderer + runtime) — a self-contained Cargo workspace. |
| `rust/` | The `flutter_rust_bridge` native crate. `rust/src/render.rs` holds the `gpu`-gated zero-copy texture path. |
| `lib/src/elpa/native/elpa_texture.dart` | The `ElpaNativeView` widget: a `Texture` (mobile/desktop) or `HtmlElementView` (web). |
| `assets/app/ts/` | **The app, in TypeScript**: `scene.ts` (the `SceneController` 3D scene), `cards.ts`/`page.ts` (the 2D UI + `Native3DView`), `main.ts` (bootstrap + host hooks). |
| `assets/app/sdk/05_graphics.js` | The graphics SDK: `Gpu`/`FrameBuilder`, `Color`, and the `Native3DView` widget. |
| `assets/app/main.js` | **Build output** — the prelude + transpiled app the Dart loader concatenates after the SDK. Produced by `create-elpa-app build`. |
| `elpa.json` | The project manifest the CLI reads (entry, SDK dir, outputs). |

## How the 3D ↔ Flutter link works

- `scene.ts` registers a cube geometry once as a render-level GPU definition and,
  every frame (`main.ts`'s `onFrame` hook), submits a surface pass over the GPU
  pipe via `app.gpu.frame().surfacePass(color, draws).submit()`.
- The frame targets the surface bound to the **`Native3DView`** placed in the 2D
  widget tree. On mobile/desktop Flutter samples it through a `Texture` backed by
  a shared GPU buffer (Android `HardwareBuffer`, iOS/macOS `IOSurface`, Linux
  DMA-BUF, Windows DXGI); on web it is an `HtmlElementView` over Elpa's canvas.
- This compositing is **zero-copy**: Elpa's renderer writes the texture, Flutter
  samples it inline with the rest of the 2D UI.

The native surface is **live only when the bridge is built with the `gpu` Cargo
feature** and the platform shared-texture wiring is in place (see
`rust/src/render.rs::register_surface`). In the default headless build the
`Native3DView` reserves its space and the 2D UI runs in full — so the app always
builds and runs; the 3D surface lights up once you opt into `gpu`.

## Setup

```bash
cargo install flutter_rust_bridge_codegen
dart pub global activate ffigen

# 0. Bundle the TypeScript app → assets/app/main.js (init already did this once).
create-elpa-app build

# 1. Materialize the platform runners.
flutter create . --platforms=android,ios,linux,macos,windows,web --project-name __APP_SNAKE__

# 2. Generate the bridge bindings, then uncomment `mod frb_generated;` in rust/src/lib.rs.
flutter_rust_bridge_codegen generate

# 3. Run (headless native surface — 2D UI + reserved 3D region).
flutter pub get
flutter run

# 4. To light up the live 3D surface, build the native crate with the gpu feature
#    (and the platform shared-texture wiring from rust/src/render.rs):
#    add `--features gpu` wherever the crate is compiled for your target.
```

## The demo

`assets/app/ts/` shows:

- a **3D scene card** — a GPU-rendered scene (a registered cube + an animated
  clear) submitted into the `Native3DView` every frame (`scene.ts`),
- a **controls** component to pause/resume and reset the view (`cards.ts`),
- an **about** card (`page.ts`).

Edit the `SceneController` (`scene.ts`'s `prime()`/`render()`) to register your
own geometry, pipelines and uniforms, or replace the 2D cards with your own UI.
The 2D and 3D layers update independently — the 2D cards patch their own scopes;
the 3D scene re-submits every frame. After editing `assets/app/ts/`, run
`create-elpa-app build` and hot-restart.

For a browser preview, `create-elpa-app install` sets up the Flutter SDK + wasm
toolchain and builds the Elpa + Flutter wasm host (one shot), then
`create-elpa-app dev` serves your bytecode against it.

---

*Scaffolded with `create-elpa-app` (template: `wgpu-flutter`).*
