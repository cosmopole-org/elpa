# __APP_TITLE__

A **wgpu Elpa** project authored in **TypeScript**. The app is a multi-file
TypeScript program, bundled by the Elpa CLI into one VM-subset script and run on
the Elpian VM, rendering through **wgpu** in a native window. The demo combines a
**3D game scene** (the Game3D SDK) with a **Material-styled 2D HUD**.

## Layout

| Path | What it is |
|------|------------|
| `app/ts/` | The **TypeScript app**, one component per file: `theme.ts`, `sim.ts`, `scene.ts`, `hud.ts`, `main.ts` (+ `elpa.d.ts` ambient SDK types). |
| `app/sdk/game3d/` | The **Game3D SDK** — scene graph, cameras, lights, primitives/glTF, a forward renderer, and a 2D HUD overlay (VM-subset JS, linked ahead of your app). |
| `app/sdk/material/` | The **Material Design 3 SDK** — vendored for a pure-2D Elpa app. |
| `app/dist/` | Build output: `app.js` (the bundle the host runs) and `app.bc` (Elpian bytecode). Produced by `create-elpa-app build`. |
| `app/src/main.rs` | The native host crate (a `winit` window + wgpu surface) — it `include_str!`s `app/dist/app.js`. |
| `engine/` | The vendored Elpa engine (VM + renderer + runtime), a self-contained Cargo workspace. |
| `elpa.json` | The project manifest the CLI reads (entry, SDK dirs, output). |

## Build & run

```bash
create-elpa-app build            # bundle app/ts/ → app/dist/{app.js,app.bc}
cd app && cargo run --release    # opens the window
```

`init` already produced the initial bundle, so a fresh project runs immediately.
After editing anything under `app/ts/`, re-run `create-elpa-app build` (the host
`include_str!`s `app/dist/app.js`, so a rebuild refreshes what `cargo run` shows).

**Drag** to orbit the camera, **scroll** to zoom, and use the HUD buttons to
pause, change the spin speed, or recolor the bodies.

## Authoring in TypeScript

Write idiomatic, multi-file TypeScript with `import`/`export` between your
components. The Game3D SDK's functions (`createScene`, `boxMesh`, `addPanel`, …)
are **global** at runtime; `app/ts/elpa.d.ts` declares their types so your editor
is happy — no import needed for SDK symbols.

`create-elpa-app build` runs an embedded transpiler that:

1. **resolves** the relative-import graph from `app/ts/main.ts`,
2. **strips** the types (swc) and **shims** the idioms the VM lacks — template
   literals → `+`, `xs.map(f)` → `map(xs, f)`, `a.length` → `len(a)`,
   `Math.floor` → `floor`, `JSON.stringify` → `jsonStringify`, … — backed by a
   small runtime prelude, then
3. **flattens** every module into one scope (the VM has no ES modules) and
   prepends the Game3D SDK, producing `app/dist/app.js` + its bytecode.

## How the demo is composed (2D over 3D, one frame)

`scene.ts` builds a `Scene` (a ground disc, a ring of orbiting cubes and spheres,
a centre pillar), adds two directional lights, and attaches a turntable camera.
`main.ts` registers an `onUpdate` callback that spins the ring every frame.

**Game3D owns the wgpu surface.** Its renderer draws the 3D scene into the surface
pass (which clears), then composites the **2D UI in the *same* `gpu.submit`** — a
second, depth-less pass that `load`s the 3D image (no second clear) and
alpha-blends the HUD panels on top. So the 2D and 3D layers are one frame, in
order: 3D pass → 2D pass.

The HUD is **Material-styled**: `hud.ts` overrides `overlay().theme` with a
Material Design 3 palette (`theme.ts`), so the floating panels —
`addPanel(...).label(...).bar(...).button(...)` — read as Material chrome over
the 3D game scene.

### Going further with the Material SDK

Both SDKs are vendored under `app/sdk/`. The composited 2D layer is the Game3D
overlay restyled to Material; to author a **pure 2D** app with the full M3 widget
catalog, point `elpa.json`'s `sdk` at `app/sdk/material` and write a `main.ts`
that calls `runApp(...)` with a Material widget tree. (The two SDKs can't be
linked into one program — they collide on lifecycle hooks and class names and
each wants to own the surface — so a single VM runs one of them.)

---

*Scaffolded with `create-elpa-app` (template: `wgpu`).*
