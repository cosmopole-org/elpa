# Elpa

A **programmable VM around the [Vello](https://github.com/linebender/vello)
rendering system**. You write your app in **JavaScript**; Elpa compiles it to an
AST and runs it on an embedded Rust VM. The VM drives drawing by streaming a
**batch of high-level vector operations** — a Vello *scene* — to the Rust host,
which encodes them into a `vello::Scene` and rasterizes them on the GPU through
wgpu, with **resource caching** and **free unchanged frames** on top. Targets
**web, mobile, and desktop** from one codebase.

> Elpa's drawing model is Vello's: fills, strokes, clip/blend layers, gradients,
> images and glyph runs. **Direct wgpu is a subset** — it survives as a single
> `rawWgpu` operation that composites an arbitrary wgpu command tree (a custom
> shader, a 3D scene, a compute effect) into the very same target the vector ops
> paint. The raw wgpu command tree (resources + render/compute passes) is still a
> first-class contract beneath the scene. Full design in **[`PLAN.md`](./PLAN.md)**.

## Two layers, one target

```text
JavaScript ─▶ Elpian AST ─▶ bytecode ─▶ VM (your app logic)
                                          │ askHost("scene.submit", <vello scene>)
                                          ▼
              Scene { resources[], ops[] } ─▶ SceneRenderer ─▶ vello::Scene ─▶ GPU
                                          │        ▲
                                          │        └─ op: rawWgpu(Frame) ──┐
                                          ▼                                ▼
              (or askHost("gpu.submit", <wgpu command tree>)) ─▶ Renderer (wgpu)
```

The high-level **scene path** (`scene.submit`) is the primary drawing API; the
**raw wgpu path** (`gpu.submit`, resource cache + partial rendering) is both a
standalone contract and the engine behind the `rawWgpu` scene op. Both composite
into the same surface.

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

**The JS → bytecode compile runs at build time.** The bundled examples ship the
app **precompiled to VM bytecode** (`examples/material/assets/*.bc`, produced by
`cargo run -p elpa-material --bin build_bytecode` and refreshed in CI before each
deploy). The deployed web/native app loads that bytecode directly
(`Elpa::new_from_bytecode`) — no JS/AST front-end runs at startup. The executor
decodes the bytecode **once** into an in-memory list of operation objects and
traverses that each frame, rather than re-parsing the bytes on every step.

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
draws Elpa frames in the browser, and **[`examples/native`](examples/native)**
for the same triangle running in a winit window on **desktop
(Windows/macOS/Linux) and Android** from one codebase.

## Workspace

| Crate | Role | Status |
|-------|------|--------|
| `elpian-vm` | Ported Elpian AST VM + GPU-focused host-call API; JS front-end with ES6 `class` support | ✅ running |
| `elpa-protocol` | The schema: the **Vello scene** (`Scene`/`SceneOp`: fills, strokes, clip/blend layers, gradients, images, glyphs, + `rawWgpu`) **and** the wgpu command-tree it embeds (resources + commands + geometry) | ✅ tested |
| `elpa-renderer` | Scene orchestration (`SceneBackend`/`SceneRenderer`, scene-resource cache + free unchanged frames) + the wgpu resource cache & partial rendering; **live Vello backend** (`vello-backend`) and **live wgpu backend** (`wgpu-backend`) | ✅ tested · ✅ vello 0.5 + wgpu 29 compile |
| `elpa-runtime` | Host-call pump: drives the VM, parses `gpu.submit` → `Frame` | ✅ tested |
| `elpa` | **Unified instance**: VM + renderer + backend in one object; definition store + `vm.import` | ✅ tested |
| `examples/web` | Full-window DPI canvas drawing Elpa frames (wasm) | ✅ compiles (wasm32) |
| `examples/native` | Same triangle in a winit window — desktop + Android | ✅ builds (Linux/Windows/Android) |
| `examples/sdk` | **Engine SDK as Elpian AST** (`assets/*.ast.json`): importable 2D/3D shape definitions, math in WGSL | ✅ tested |
| `examples/material` | **Flutter-style Material Design 3 framework in JavaScript** — an object-oriented SDK (`assets/sdk/*.js`: engine services + a `Widget` class hierarchy + the retained-tree `Material` runtime, `defineComponent`/`runApp`, per-component `update`) **plus a full painting layer** (a `dart:ui` `Canvas`/`CustomPaint`, gradients, opacity/colour filters, 2D transforms and a multi-pass `BackdropFilter` blur); the app composes a widget tree and never touches the GPU. Compiled to VM bytecode at build time (`build_bytecode`); the web/native examples load it with `Elpa::new_from_bytecode` | ✅ tested |
| `examples/flutter` | **A faithful, *layered* port of Flutter in JavaScript** (`assets/sdk/*.js`): unlike `material`'s fused measure/paint, it mirrors Flutter's real architecture bottom-to-top — a **`dart:ui` `Canvas`** (Offset/Size/Rect/RRect/Color/Paint/Gradient/Path) over the SDF raster backend; a **rendering layer** (`BoxConstraints`, `RenderObject`/`RenderBox` with the constraints-down/sizes-up protocol + relayout-boundary caching, `PipelineOwner`, `RenderView`, the real `RenderFlex` algorithm, Stack/Padding/Align/DecoratedBox/Paragraph/Transform/Opacity); a **widgets layer** (`Widget`/`Element`/`BuildOwner` with `updateChild`/`updateChildren` reconciliation, `StatelessWidget`/`StatefulWidget`+`setState`, `RenderObjectElement`, `InheritedWidget`, `ParentDataWidget`); a widget catalog + a small **Material** catalog (`MaterialApp`/`Scaffold`/`AppBar`/`ElevatedButton`/`Icon`/`CustomPaint`); and `WidgetsFlutterBinding`+`runApp` with pointer hit-test routing. Compiled to bytecode (`build_bytecode`); the web/native hosts load it behind `--features flutter` | ✅ tested |
| `examples/game3d` | **Object-oriented 3D game-making SDK in JavaScript** (`assets/sdk/*.js`): a scene graph (`Object3D`/`Scene`), perspective/orthographic cameras, directional/point lights, primitive + **glTF/GLB** geometry, PBR-ish materials, a forward Blinn-Phong renderer, and a physics layer (AABB/sphere volumes, ray casting, collision). Apps compose a scene graph and register an update callback. Compiled to bytecode (`build_bytecode`); the web/native hosts load it behind `--features game3d` | ✅ tested |
| `examples/websdk` | **HTML element model + CSS engine in JavaScript** (`assets/sdk/*.js`): the CSS box model, block/inline flow, **flexbox (with multi-line `flex-wrap`)**, grid, positioning, the full `<color>`/`<length>` grammar, borders/radius/shadows/gradients, transforms (incl. `skew`), `text-decoration`, `letter-spacing`, `text-shadow`, **`backdrop-filter: blur()`** (a two-pass frosted-glass composite), and **clock-driven `transition`s** (eased `opacity`/`transform`/`background`+gradients/`border` on state change) over the HTML element catalog as object-oriented class components, painting the whole page through one instanced SDF pipeline. Apps compose a tree of HTML elements styled with CSS, drive their own motion with `animTime`/`tweenValue`, and never touch the GPU. The bundled demo is a full marketing **landing page** (nav with gradient-hover CTA, hero with a live animation, feature grid, a glassmorphism band, FAQ, footer). Compiled to bytecode (`build_bytecode`); the web/native hosts load it behind `--features websdk` | ✅ tested |

## The Vello scene vocabulary

A frame submitted via `scene.submit` is a `Scene { resources[], ops[] }`. The ops
mirror `vello::Scene` one-to-one:

| Op | Vello call | Notes |
|----|------------|-------|
| `fill` | `Scene::fill` | a `path` (rect/rrect/circle/ellipse/line or freeform Bézier `elements`) + a `brush` |
| `stroke` | `Scene::stroke` | `style` (width/join/cap/miter/dashes) + `brush` |
| `pushLayer` / `popLayer` | `Scene::push_layer` / `pop_layer` | a clip `path` + `blend` (mix + compose) + `alpha` |
| `drawImage` | `Scene::draw_image` | a scene-level image resource by id |
| `drawGlyphs` | `Scene::draw_glyphs` | a `run` (font id, size, positioned glyph indices) + `brush` |
| `rawWgpu` | — | composite a raw wgpu `Frame` into the same target (the subset op) |

A **brush** is a solid color, a linear/radial/sweep **gradient** (color stops +
extend), or a scene **image**. Scene-level `resources` (`image` / `font`) are
keyed by id and uploaded once. The `SceneRenderer` content-hashes the whole
scene, so an identical re-submit does **zero** GPU work.

The Rust host (`vello-backend` feature) maps each op onto Vello via `kurbo`
shapes and `peniko` brushes; the `rawWgpu` op runs the wgpu command tree on
Vello's own device into the shared surface, so a 3D scene or custom shader sits
in the same frame as the 2D UI. The GPU-free `SceneRenderer` + a mock backend is
what the default test suite exercises (no GPU needed).

A Flutter-like UI SDK built entirely on these ops — a `dart:ui`-style
`Canvas`/`Paint`/`Path` painting layer driving a small box-layout widget tree — is
in `crates/elpa/tests/assets/vello_flutter_demo.js`, driven end-to-end through a
headless instance in `crates/elpa/tests/vello_sdk.rs`.

## Reusable drawing definitions + module import

Beyond the raw command tree, the VM can name and reuse drawing work:

* **`gpu.define` / `gpu.undefine`** register/unregister a [`Definition`] — a batch
  of commands (render-level draws *or* encoder-level passes, 2D and/or 3D) — in a
  host-side store. Frames then reference it by id with a `useDefinition` command
  instead of re-emitting it; definitions may reference other definitions, so
  complex drawings compose from simpler ones. The host **expands** each submitted
  frame against the store before rendering, so the VM's wire payload stays tiny.
* **`vm.import`** loads an external Elpian AST module (a bundled project asset or,
  via a host `fetcher`, the network) and runs it so its `gpu.define`s populate the
  *same* store — expanding the engine's drawing vocabulary at runtime.

`examples/sdk` is exactly such a module, shipped as Elpian AST JSON: import it and
draw `elpa.sdk.{rect,triangle,circle,cube,sphere}` by reference.

## Scopes: decoupled, independently-cached layers

Beyond caching *what* a frame draws, Elpa programs can decouple *where* it draws
into independently-snapshotted **layers** (scopes) — a first-class optimization
the program drives directly through the renderer's layer system:

* **`scope.define(layer)`** registers a named layer: a region that paints into
  its own offscreen **snapshot texture** instead of straight to the surface.
* A frame references a layer with a **`useLayer`** command. The host expands it:
  if the layer's snapshot is stale it splices the painting passes in (repainting
  the snapshot); if the snapshot is still valid it splices **nothing** — the
  resident snapshot texture stands in and the VM never re-ran the layer's drawing.
* **`scope.invalidate(id)`** marks a snapshot stale so it repaints on next use.
  Invalidation is *explicit*: the program — not a content heuristic — decides when
  a layer repaints. The program composites the layers into the final image by
  sampling each snapshot (`elpa.layer.<id>.tex`) in a surface pass.
* **Placement is data-only.** A `useLayer` may carry a `transform`
  (`{tx,ty,sx,sy}`) and `opacity`; the host keeps the layer's 32-byte transform
  uniform (`elpa.layer.<id>.xform`) resident and refilled in place so the
  composite pass can **slide, scale or fade a *reused* snapshot for free** — no
  repaint, no re-rasterization, no geometry re-emit. A navigation-drawer slide or
  a page transition becomes a few-byte upload per frame.
* **`freeze_layer` / `thaw_layer`** wrap the transient-snapshot lifecycle: snapshot
  a region for the duration of a gesture (the drawer slide), reuse it every frame,
  then release it so the region renders directly — and stays interactive — again.

This lets a region repaint in isolation while everything around it holds its
snapshot — a heavy 3D scene behind a moving HUD, a large static map under an
overlay, a chart that updates once a second — with the layers merged into the
final frame by a cheap per-layer composite.

> **Use it where it pays.** Layering wins when a region is **expensive to render
> and changes rarely**: the snapshot then saves real per-frame GPU work. It is the
> wrong tool for a region that is already cheap to draw — compositing a snapshot
> (an offscreen target + a full-screen blit) costs more than just re-issuing a few
> draws. The Material kit (`examples/material`) deliberately stays **single-pass**
> (it draws the whole UI as one instanced rounded-rect pass); an experiment that
> layered it measured ~3× *slower*, so the kit does not use GPU scopes. The scope
> API is proven end-to-end by the `crates/elpa` tests instead.
>
> For a *cheap* single-pass UI the right tool is the **CPU-side** analog, and the
> kit uses it for the drawer: the navigation drawer is wrapped in its own
> component so an open/close slide marks **only** the drawer dirty (not the root),
> repainting just the drawer subtree while the body is reassembled from cache —
> and, under `setLayered`, the body stays in the static instance buffer the
> renderer skips re-uploading. Same principle (decouple the moving region), at the
> layer where it pays for this workload.

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
