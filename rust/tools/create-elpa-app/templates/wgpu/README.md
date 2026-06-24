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

## How the demo is composed (2D over 3D, one frame)

`app/assets/demo.js` is authored against the **Game3D SDK**: it builds a `Scene`
(a ground disc, a ring of orbiting cubes and spheres, a centre pillar), adds two
directional lights, attaches a turntable camera with `enableOrbit`, and registers
an `onUpdate` callback that spins the ring every frame.

**Game3D owns the wgpu surface.** Its renderer draws the 3D scene into the surface
pass (which clears), then composites the **2D UI in the *same* `gpu.submit`** — a
second, depth-less pass that `load`s the 3D image (no second clear) and
alpha-blends the HUD panels on top. So the 2D and 3D layers are one frame, in
order: 3D pass → 2D pass.

The HUD is **Material-styled**: the demo overrides `overlay().theme` with a
Material Design 3 palette (surface, primary, outline, on-surface, surface-variant
roles), so the floating panels —
`addPanel(...).label(...).bar(...).button(...)` — read as Material chrome over
the 3D game scene.

### Going further with the Material SDK

Both SDKs are vendored under `app/assets/sdk/`. The composited 2D layer is the
Game3D overlay restyled to Material; to author a **pure 2D** app with the full M3
widget catalog (`Scaffold`, `AppBar`, `TextField`, charts, …), point `build.rs`
at `assets/sdk/material/` and write a `demo.js` that calls `runApp(...)` with a
Material widget tree. (The two SDKs can't be concatenated into one program —
they collide on lifecycle hooks and class names and each wants to own the
surface — so a single VM runs one of them; here Game3D owns the surface and
provides the composited 2D layer.)

## Editing the app

The JavaScript is recompiled by the VM on every launch (`Elpa::new_from_js`), so
just edit `app/assets/demo.js` (or the SDK modules) and re-run — `build.rs`
re-concatenates the program automatically.

---

*Scaffolded with `create-elpa-app` (template: `wgpu`).*
