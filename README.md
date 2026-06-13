# Elpa

A **programmable VM around the wgpu API**. You write your app in **JavaScript**;
Elpa compiles it to an AST and runs it on an embedded Rust VM. The VM drives the
GPU directly by emitting a **nested JSON tree of wgpu commands**, which Elpa maps
onto the real wgpu API in **real time** — adding **resource caching** and
**partial rendering** on top. Targets **web, mobile, and desktop** from one
codebase.

> Elpa is **not** a widget toolkit. No DOM, no Flutter widgets, no Canvas-2D
> abstraction. It sits at wgpu's level: 2D, 3D, and compute are the same commands
> with different pipelines/shaders. Full design in **[`PLAN.md`](./PLAN.md)**.

## How it works (one breath)

```text
JavaScript ─▶ Elpian AST ─▶ bytecode ─▶ VM (your app logic)
                                          │ askHost("gpu.submit", <wgpu command tree>)
                                          ▼
              Frame {resources[], commands[]} ─▶ Renderer
                                          │  • create-once resource cache
                                          │  • skip unchanged passes (partial render)
                                          │  • scissor present to dirty region
                                          ▼
                                   wgpu backend ─▶ GPU
```

The VM never links wgpu; the renderer never links the VM. They agree only on the
`elpa-protocol` command tree.

## The unified instance

Add `elpa` as a dependency, construct one object with a GPU backend + your app
AST, and drive it — it owns and manages the VM, the renderer, and the backend:

```rust
let surface = SurfaceInfo::new(width_px, height_px, device_pixel_ratio);
let mut app = Elpa::new(backend, surface, app_ast_json)?;
app.start();                 // run the program (init + first frame)
app.send_event(&event);      // -> app onEvent -> re-render (cheap, partial)
app.resize(w, h, scale);     // reconfigure + app onResize
app.animate(dt_ms);          // -> app onFrame for animation
```

The app (JS → AST) defines `onEvent`, `onResize`, `onFrame`, reads live screen
metrics via `gpu.surfaceInfo`, and re-renders by re-submitting frames; the cache
makes unchanged frames free and changed passes re-record in isolation.

See **[`examples/web`](examples/web)** for a full-window, DPI-aware canvas that
draws Elpa frames in the browser.

## Workspace

| Crate | Role | Status |
|-------|------|--------|
| `elpian-vm` | Ported Elpian AST VM + GPU-focused host-call API | ✅ running |
| `elpa-protocol` | The wgpu command-tree schema (resources + commands + geometry) | ✅ tested |
| `elpa-renderer` | Resource cache, partial rendering, `GpuBackend` trait, **live wgpu backend** | ✅ tested · ✅ wgpu 29 compiles |
| `elpa-runtime` | Host-call pump: drives the VM, parses `gpu.submit` → `Frame` | ✅ tested |
| `elpa` | **Unified instance**: VM + renderer + backend in one object | ✅ tested |
| `examples/web` | Full-window DPI canvas drawing Elpa frames (wasm) | ✅ compiles (wasm32) |

## Build & test

```bash
cargo build --workspace
cargo test  --workspace
```

The suite proves the model end to end: the VM compiles an AST, builds a
shader+pipeline+draw command tree, and `gpu.submit`s it; the renderer creates the
resources once, and an identical re-submit does **zero** GPU work and presents
nothing; changing a referenced buffer re-records only the dependent pass.

## wgpu coverage

The JSON schema covers the **core wgpu surface for 2D, 3D, and compute** —
all resource types, render & compute passes, every common draw/dispatch/copy/
write command, and full blend/depth/multisample/vertex state. Advanced features
(render bundles, query sets, multi-draw-indirect, full stencil state, …) and the
**live wgpu backend** are roadmapped. See the
[coverage matrix in `PLAN.md` §11](./PLAN.md#11-wgpu-command-coverage-matrix).

## Provenance

`crates/elpian-vm/src/sdk` is ported from the
[Elpian](https://github.com/cosmopole-org/elpian) Rust VM (only the VM —
re-homed behind a renderer-agnostic API). Elpa adopts none of Elpian's
widget/DOM/canvas concepts.
