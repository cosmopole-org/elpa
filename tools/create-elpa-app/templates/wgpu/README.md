# __APP_TITLE__

A **wgpu Elpa** project: an Elpa application written in **JavaScript** that runs
directly on the Elpian VM and renders through **wgpu**. The demo combines a
**3D game scene** (the Game3D SDK) with a **2D UI overlay**, hosted in a native
window.

## Layout

| Path | What it is |
|------|------------|
| `app/` | The native host crate (a `winit` window + wgpu surface driving Elpa). |
| `app/assets/sdk/game3d/` | The **Game3D SDK** — scene graph, cameras, lights, primitive + glTF geometry, a forward renderer, physics, and a 2D HUD overlay. |
| `app/assets/sdk/material/` | The **Material Design 3 SDK** — a Flutter-style 2D widget kit (vendored for building a pure-2D Elpa app). |
| `app/assets/demo.js` | The demo program: a lit 3D scene of orbiting primitives with a 2D overlay UI. |
| `app/build.rs` | Concatenates the Game3D SDK modules + `demo.js` into the program the VM compiles at startup. |
| `engine/` | The vendored Elpa engine (VM + renderer + runtime), a self-contained Cargo workspace. |

## Run it

```bash
cd app
cargo run --release
```

A window opens with the scene. **Drag** to orbit the camera, **scroll** to zoom,
and use the overlay buttons to pause, change the spin speed, or recolor the
bodies.

## How the demo is composed

`app/assets/demo.js` is authored against the **Game3D SDK**: it builds a `Scene`
(a ground disc, a ring of orbiting cubes and spheres, a centre pillar), adds two
directional lights, attaches a turntable camera with `enableOrbit`, and registers
an `onUpdate` callback that spins the ring every frame. The **2D UI** is the
SDK's overlay — floating panels (`addPanel(...).label(...).bar(...).button(...)`)
that draw live read-outs and interactive buttons on top of the 3D scene.

### About combining Material 2D widgets with Game3D

Both SDKs are vendored under `app/assets/sdk/`. The demo drives **Game3D**, whose
own overlay provides the 2D UI layer, because each SDK owns the wgpu surface and
defines the same VM lifecycle hooks (`onFrame`/`onResize`/`onEvent`) — so they
cannot simply be concatenated into one program. To build a **pure 2D** Material
app instead, point `build.rs` at `assets/sdk/material/` and write a `demo.js`
that calls `runApp(...)` with a Material widget tree. The Game3D overlay is the
ready-made path for 2D UI over a 3D scene.

## Editing the app

The JavaScript is recompiled by the VM on every launch (`Elpa::new_from_js`), so
just edit `app/assets/demo.js` (or the SDK modules) and re-run — `build.rs`
re-concatenates the program automatically.

---

*Scaffolded with `create-elpa-app` (template: `wgpu`).*
