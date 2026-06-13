# Elpa — A Rust + wgpu Universal High-Performance App Framework

> **Status:** Foundation laid. The Elpian AST VM is ported and running; the
> protocol, drawing-management layer (caching + dirty-rect partial rendering),
> and runtime host-call loop are scaffolded, compiling, and tested. The wgpu
> backend is the next milestone. This document is the master plan: concept,
> design, and implementation detail for every layer.

---

## 0. Table of Contents

1. [Concept & Vision](#1-concept--vision)
2. [System Architecture (the big picture)](#2-system-architecture-the-big-picture)
3. [The End-to-End Pipeline](#3-the-end-to-end-pipeline)
4. [Crate Layout & Responsibilities](#4-crate-layout--responsibilities)
5. [Layer 1 — JavaScript → Elpian AST JSON](#5-layer-1--javascript--elpian-ast-json)
6. [Layer 2 — The Elpian VM (ported)](#6-layer-2--the-elpian-vm-ported)
7. [Layer 3 — The Protocol (shared vocabulary)](#7-layer-3--the-protocol-shared-vocabulary)
8. [Layer 4 — Layout & Lowering (UI tree → draw list)](#8-layer-4--layout--lowering-ui-tree--draw-list)
9. [Layer 5 — The Drawing-Management Layer](#9-layer-5--the-drawing-management-layer-the-heart)
10. [Layer 6 — The wgpu Backend (command mapping)](#10-layer-6--the-wgpu-backend-command-mapping)
11. [Text, Images, Gradients & Resources](#11-text-images-gradients--resources)
12. [The Event System](#12-the-event-system)
13. [Cross-Platform Strategy (web / mobile / desktop)](#13-cross-platform-strategy-web--mobile--desktop)
14. [Threading, Async & Frame Scheduling](#14-threading-async--frame-scheduling)
15. [Performance Budget & Benchmarks](#15-performance-budget--benchmarks)
16. [Testing Strategy](#16-testing-strategy)
17. [Roadmap & Milestones](#17-roadmap--milestones)
18. [Risks & Open Questions](#18-risks--open-questions)
19. [Appendix A — Elpian AST node reference](#appendix-a--elpian-ast-node-reference)
20. [Appendix B — Draw-command reference](#appendix-b--draw-command-reference)

---

## 1. Concept & Vision

**Elpa** is a Rust-native, wgpu-powered application framework that lets developers
write their app logic in **JavaScript** and have it run identically across **web,
mobile, and desktop**, with a single high-performance GPU renderer underneath.

The thesis is a clean separation between **what to show** (decided by user JS,
running in a tiny embedded VM) and **how to show it fast** (decided by a Rust
renderer that treats the UI as cacheable, partially-updatable GPU work):

- **One language for app authors.** Developers write JavaScript (with JSX-style
  UI). They never touch Rust, wgpu, or platform SDKs.
- **One renderer everywhere.** wgpu targets Vulkan, Metal, D3D12, and WebGPU/WebGL
  from one codebase, so a frame looks and performs the same on every platform.
- **Pay only for what changes.** The renderer is built around *partial
  rendering*: it detects the exact rectangles of the screen that changed and
  redraws only those, compositing everything else from cached GPU textures. A
  blinking cursor costs a cursor-sized repaint, not a full-screen frame.
- **Instant frames.** Logic (VM) and rendering (GPU) are decoupled. The VM emits
  a *description* of the UI; the renderer turns descriptions into frames on its
  own clock, with caching that makes the steady state nearly free.

### Non-goals (v1)

- Not a 3D game engine (the ported VM *can* carry a 3D path later; v1 focuses on
  2D UI). 3D is explicitly deferred — see §18.
- Not a JS engine with full ECMAScript semantics. Elpian is a deliberately small,
  fast, embeddable AST-VM (see §6) — a curated subset, not V8.

---

## 2. System Architecture (the big picture)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                            AUTHOR SPACE (JavaScript)                       │
│   app.js  ──  components, state, event handlers, JSX UI                    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                 │  build-time / load-time
                       ┌─────────▼──────────┐
                       │  JS → AST compiler  │  (acorn + transform; off-VM)
                       │  emits Elpian AST   │
                       └─────────┬──────────┘
                                 │  AST JSON
╔════════════════════════════════▼══════════════════════════════════════════╗
║                              RUST CORE (Elpa)                              ║
║                                                                            ║
║  ┌────────────────┐   bytecode   ┌──────────────────────────────────────┐ ║
║  │  elpian-vm     │─────────────▶│  Executor (pausing interpreter)       │ ║
║  │  compiler      │              │  runs user logic, holds app state     │ ║
║  └────────────────┘              └───────────────┬──────────────────────┘ ║
║                                                  │ askHost("render", tree) ║
║                                                  │ (pause / resume)        ║
║  ┌───────────────────────────────────────────────▼───────────────────────┐║
║  │  elpa-runtime  —  host-call dispatch loop                              │║
║  │   • routes "render" → UiTree         • routes events back into VM      │║
║  └───────────────────────────────┬──────────────────────────────────────┘ ║
║                                  │ UiTree                                  ║
║  ┌───────────────────────────────▼──────────────────────────────────────┐ ║
║  │  Layout + Lowering   (UiTree → DrawList of primitives, per layer)     │ ║
║  └───────────────────────────────┬──────────────────────────────────────┘ ║
║                                  │ DrawList (elpa-protocol)                ║
║  ┌───────────────────────────────▼──────────────────────────────────────┐ ║
║  │  elpa-renderer — Drawing-Management Layer                             │ ║
║  │   • per-layer content hashing + GPU texture cache                     │ ║
║  │   • dirty-rect accumulation (what changed since last frame)           │ ║
║  │   • decides: re-rasterize miss layers, composite the rest             │ ║
║  └───────────────────────────────┬──────────────────────────────────────┘ ║
║                                  │ GpuBackend trait calls                  ║
║  ┌───────────────────────────────▼──────────────────────────────────────┐ ║
║  │  wgpu backend — maps cache/composite ops → render passes & pipelines  │ ║
║  └───────────────────────────────┬──────────────────────────────────────┘ ║
╚═══════════════════════════════════▼════════════════════════════════════════╝
                          GPU (Vulkan / Metal / D3D12 / WebGPU)
```

The two firewalls that make this maintainable:

- **The VM never knows about wgpu.** It only emits JSON host calls. (`elpian-vm`
  depends on nothing graphical.)
- **The renderer never knows about the VM.** It only consumes a `DrawList`. (The
  drawing-management logic is GPU-API-agnostic and unit-tested with a mock
  backend.)

`elpa-protocol` is the shared vocabulary both sides agree on; `elpa-runtime` is
the only crate that knows about both.

---

## 3. The End-to-End Pipeline

A single user interaction, traced end to end:

1. **User taps a button.** The windowing host (winit) gets a pointer event.
2. **Hit-test.** The runtime hit-tests the event against the retained `UiTree`,
   finds the node, and reads its `events.click` → handler name (e.g.
   `"onPress"`).
3. **Invoke VM.** `Runtime::dispatch_event("onPress", eventJson)` calls
   `execute_vm_func_with_input`. The Executor resumes, runs the JS handler, which
   mutates app state and calls `render(NewUI())`.
4. **Host call.** `render` becomes `askHost("render", {html: tree})`; the VM
   **pauses** and hands the runtime a `HostCall` envelope.
5. **Parse + layout.** The runtime parses the payload into a `UiTree`. The layout
   engine computes geometry; lowering flattens it into a `DrawList` of
   primitives, each tagged with a `LayerId` and world-space `bounds`.
6. **Diff & dirty.** The drawing manager content-hashes each layer. Only the
   button's layer changed → it records that layer's bounds as a **dirty rect**.
7. **Minimal GPU work.** The manager asks the backend to re-rasterize *only* the
   button layer into its cached texture, sets the scissor to the dirty rect, and
   composites all layers (the rest are untouched cached textures). One small
   present.
8. **Resume VM.** The runtime resumes the VM with a typed return value; the VM
   finishes the turn.

Steady-state (nothing changed) costs: hash the layers, find them all clean,
present nothing. The expensive path is only ever proportional to *what changed*.

---

## 4. Crate Layout & Responsibilities

```text
elpa/
├── Cargo.toml                      # workspace
├── PLAN.md                         # this document
├── README.md
└── crates/
    ├── elpian-vm/                  # ✅ PORTED & RUNNING
    │   └── src/
    │       ├── lib.rs
    │       ├── api.rs              # embedding API + host-call protocol
    │       └── sdk/                # the VM itself (copied from Elpian)
    │           ├── compiler.rs     #   AST JSON → bytecode
    │           ├── executor.rs     #   bytecode interpreter (pausing)
    │           ├── vm.rs           #   VM facade + host-call marshalling
    │           ├── context.rs      #   scopes / memory
    │           └── data.rs         #   Val type system
    │
    ├── elpa-protocol/              # ✅ SHARED TYPES (tested)
    │   └── src/
    │       ├── hostcall.rs         # HostCall envelope
    │       ├── node.rs             # UiNode / UiTree
    │       ├── command.rs          # DrawCommand / DrawList / LayerId
    │       └── geometry.rs         # Rect / Color / Transform / Point
    │
    ├── elpa-renderer/              # ✅ DRAWING MANAGER (tested) / 🔜 wgpu backend
    │   └── src/
    │       ├── manager.rs          # partial-render orchestration
    │       ├── cache.rs            # per-layer content-hash texture cache
    │       ├── dirty.rs            # dirty-rect accumulation
    │       └── backend.rs          # GpuBackend trait (+ future wgpu impl)
    │
    └── elpa-runtime/               # ✅ HOST-CALL LOOP (tested)
        └── src/
            └── lib.rs              # drives VM, routes render/events
```

**Future crates** (roadmap): `elpa-layout` (extracted once layout grows),
`elpa-text` (shaping/atlas), `elpa-shell` (winit window + platform entry points),
`elpa-wasm` / `elpa-mobile` (platform glue).

Build-time guarantees today: `cargo build --workspace` and
`cargo test --workspace` both pass; the VM port is validated by an end-to-end
test that compiles an AST, runs it, and asserts the `render` UI tree arrives.

---

## 5. Layer 1 — JavaScript → Elpian AST JSON

User code is **JavaScript with JSX**. It is parsed and transformed into the
**Elpian AST JSON** the VM compiler expects. This stage runs *outside* the VM —
at build time for shipped apps, or at load time in a dev server / on-device.

### 5.1 Front-end

- **Parser:** [acorn](https://github.com/acornjs/acorn) + `acorn-jsx` (proven in
  the Elpian `pending-work/acorn-sample` + `jsx-compiler` prototypes).
- **Transform:** a `resolve()`/`transform()` pass (already prototyped) maps the
  ESTree AST to Elpian nodes:
  - `FunctionDeclaration` → `functionDefinition`
  - `IfStatement` → `ifStmt` (+ `elseStmt`/`elseifStmt`)
  - `WhileStatement` → loop
  - `VariableDeclaration` → `definition`
  - `AssignmentExpression` → `assignment`
  - `BinaryExpression` → `arithmetic`
  - `CallExpression` → `functionCall` (or `cast`)
  - `MemberExpression` → `indexer`
  - `ObjectExpression`/`ArrayExpression`/`Literal` → `object`/`array`/typed scalar
  - **JSX** (`JSXElement`) → `object` nodes `{ type, props, children }` — i.e. JSX
    *is* the UI-tree literal syntax.
- **Typed literals.** Numbers become `i16/i32/i64/f32/f64` per range/precision;
  `cast(x, "i64")` is a first-class node.

### 5.2 Why pre-parsed AST (not a JS parser in Rust)

The VM compiler consumes **JSON AST**, not source text. Keeping the JS parser in
the JS toolchain means: (a) we reuse the mature acorn ecosystem; (b) the Rust
core stays small and fast to compile to wasm; (c) the AST is a stable,
inspectable, cacheable artifact. The Rust side also has a fallback
`compile_code`/`parse_code` path for simple programs, but AST-in is the contract.

### 5.3 Distribution format

Ship `app.ast.json` (optionally pre-compiled to bytecode via
`compiler::compile_ast` and shipped as `app.elpb`). The VM can load either AST or
bytecode (`compile_and_create_of_ast` / `compile_and_create_of_bytecode`).

---

## 6. Layer 2 — The Elpian VM (ported)

The VM is copied verbatim from `elpian/rust/src/sdk` into `crates/elpian-vm`,
re-homed under a clean, renderer-agnostic embedding API (`api.rs`). The original
Bevy/Flutter coupling was dropped; the `sdk` module depends only on
`serde`/`serde_json`/`std`, so it is portable and wasm-friendly.

### 6.1 Execution model

- **Compile:** `compiler::compile_ast(astJson, 0) -> Vec<u8>` emits a compact
  **big-endian bytecode** stream. Opcodes cover literals (`0x01`–`0x09`),
  identifiers/indexers (`0x0b`/`0x0c`), calls/defs/assignments (`0x0d`–`0x0f`),
  control flow (`0x10`–`0x16`: if/loop/switch/funcdef/return/jump/branch), and
  operators (`0xf0`–`0xfd`). Full table in [Appendix A](#appendix-a--elpian-ast-node-reference).
- **Interpret:** `Executor` is a **pausing** tree/stack interpreter driven by
  `single_thread_operation(op_code, cb_id, payload)`:
  - `0x01` run / resume from start, `0x03` continue after a host call.
  - It returns `(response_op, cb_id, Val)`; `0x02` means "I need the host".
- **Values:** `Val { typ: i64, data: Rc<RefCell<Box<dyn Any>>> }`. Type codes:
  `0` null, `1..5` i16/i32/i64/f32/f64, `6` bool, `7` string, `8` object,
  `9` array, `10` function; `253` is the internal "paused on host call" sentinel.

### 6.2 The host-call boundary (the integration seam)

When user code calls `askHost(apiName, payload)` (or a `host_call` AST node), the
Executor suspends and `vm.rs` marshals an envelope:

```json
{ "machineId": "...", "apiName": "render", "payload": "<stringified args>" }
```

The embedder (`elpa-runtime`) services it and resumes via
`continue_execution(machineId, typedValueJson)`. **All side effects flow through
this one channel** — rendering, logging, timers, DOM/canvas ops. The advertised
host API set (`api.rs::all_host_apis`) includes `render`, `println`, `stringify`,
`updateApp`, the `dom.*` retained-tree API, and the `canvas.*` immediate-mode 2D
API. The renderer is what ultimately gives those calls meaning.

> **Key insight for this project:** the renderer integrates at exactly one point —
> the `render` host call carries the whole UI tree. Everything downstream (layout,
> caching, partial rendering, wgpu) is the host's business, invisible to the VM.

### 6.3 What was validated

`crates/elpa-runtime/tests/end_to_end.rs` compiles a `program` AST whose body is a
`host_call` to `render` with a `{html: Column[Text]}` tree, pumps the host-call
loop, and asserts a parsed `UiTree` (`Column → Text("Hello Elpa")`) surfaces. The
port is functional, not just compiling.

---

## 7. Layer 3 — The Protocol (shared vocabulary)

`elpa-protocol` defines the three contracts that decouple the layers.

### 7.1 `UiNode` / `UiTree` — the retained UI hierarchy

```rust
struct UiNode {
    kind: String,                 // "Column" | "Text" | "Button" | "div" | ...
    id: Option<String>,           // stable identity for diffing
    class: Option<String>,        // stylesheet matching
    props: Map<String, Value>,    // text, value, src, ...
    style: Map<String, Value>,    // inline CSS-like style
    events: Map<String, Value>,   // "click" -> "onPress"
    children: Vec<UiNode>,
}
```

This is the nested arrays/objects tree the prompt describes. `UiTree::parse`
robustly unwraps the host-call array wrapper and the `{html: ...}` front-end
wrapper. `id` (when present) drives **precise diffing**; otherwise positional
keys are used.

### 7.2 `DrawCommand` / `DrawList` — the lowered primitive list

After layout, the tree is *reduced* to a flat list of a **small closed set** of
primitives: `Rect` (rounded), `RectStroke`, `Text`, `Image`, `Path`,
`PushClip`/`PopClip`. Every command carries:

```rust
struct DrawCommand {
    layer: LayerId,      // which compositing layer (the cache unit)
    bounds: Rect,        // world-space AABB (dirty-rect culling)
    transform: Transform,
    opacity: f32,
    prim: Primitive,
}
```

Reducing the huge widget/canvas vocabulary to ~6 primitives means the GPU backend
implements only a handful of pipelines. `DrawList` provides `layer_bounds(layer)`
and `commands_in(dirtyRect)` — the exact queries the manager needs.

### 7.3 `geometry` — `Rect`, `Color`, `Transform`, `Point`

`Rect` carries `union`/`intersect`/`intersects`/`contains` — the algebra of
dirty-rect tracking. `Color::from_hex` handles `#RGB[A]`/`#RRGGBB[AA]`.
`Transform` is a 3×2 affine matching Canvas 2D's `setTransform`. All unit-tested.

---

## 8. Layer 4 — Layout & Lowering (UI tree → draw list)

This stage turns a styled `UiTree` into a positioned `DrawList`. (Scaffolded as
part of `elpa-runtime`/future `elpa-layout`; algorithm specified here.)

### 8.1 Style resolution

1. Merge inline `style` over matched stylesheet rules (selectors by `kind`,
   `.class`, `#id`), resolving CSS variables and the active theme.
2. Produce a **computed style** per node (box model, flex/stack params,
   typography, paint, border-radius, opacity, transform).

### 8.2 Layout

- **Flexbox-first** layout (Row/Column/Stack/Wrap/Expanded/Flexible/Padding/
  Center/Align/SizedBox map directly to flex concepts). HTML block/inline maps to
  the same engine.
- Two-pass: measure (intrinsic sizes, text measurement via the text engine) then
  arrange (assign each node a final `Rect` in world space).
- Output: every node annotated with a world-space rect + clip + transform.

### 8.3 Lowering to primitives

Walk the laid-out tree in paint order and emit `DrawCommand`s:

- background fill → `Rect { radius, paint }`; border → `RectStroke`; `box-shadow`
  → a blurred `Rect` behind; text → `Text`; `<img>`/`Image` → `Image`; clipping
  containers → `PushClip`/`PopClip`; arbitrary `canvas.*` paths → `Path`.

### 8.4 Layer assignment (the bridge to caching)

Lowering is also where **layers** are chosen — the single most important decision
for partial-render performance:

- A subtree becomes its **own layer** when it is a good cache boundary: it has
  `will-change`/animation, it is a scroll container, it has opacity/transform
  that changes independently, or it is large and static (e.g. a background or a
  list item).
- Static chrome (app bar, sidebar) lands on long-lived layers; volatile content
  (a counter, a cursor, an animating element) lands on small dedicated layers so
  its churn never dirties its neighbors.
- This mirrors the Elpian "frame splicing" idea (static vs. dynamic world) but
  generalized to arbitrary UI subtrees and made automatic.

Heuristics start simple (animation/scroll/opacity/size thresholds) and can later
take hints from the app (`style.layer = "isolate"`).

---

## 9. Layer 5 — The Drawing-Management Layer (the heart)

This is where "don't redraw what didn't change" lives. Implemented in
`elpa-renderer` and **fully unit-tested against a mock backend today**. Three
cooperating pieces:

### 9.1 Layer cache (`cache.rs`)

Each `LayerId` is rasterized once into an **offscreen GPU texture** and reused
while its content is unchanged. "Unchanged" is decided by a **content hash**
(`CacheKey::of_layer`) over every command assigned to the layer (order-sensitive;
the wgpu impl also folds in DPI scale + allocated size). `LayerCache` answers:

- `is_valid(layer, key)` → can we skip rasterization and just composite?
- `retain_layers(live)` → evict + return textures for layers that disappeared.

### 9.2 Dirty-rect tracker (`dirty.rs`)

Accumulates the screen rectangles that changed this frame:

- `add(rect)` merges overlapping rects (keeps the set tight) and **coalesces to a
  bounding union past a cap** to avoid pathological fragmentation.
- `mark_full()` for resize/DPI/theme changes.
- `is_clean()` → if nothing changed, the frame is a no-op present.

### 9.3 The orchestrator (`manager.rs`)

`DrawingManager::render(&DrawList) -> usize` (returns cache-miss count; `0` ==
served entirely from cache) does, each frame:

1. Enumerate live layers in paint order; content-hash each.
2. **Cache hit** → leave its texture alone. **Cache miss** → record the layer's
   new bounds *and its previous bounds* as dirty (so the area it vacated is
   repainted), allocate/resize its texture, and re-rasterize *only that layer's*
   commands.
3. Evict vanished layers; their old bounds become dirty.
4. If clean, **present nothing**. Else set the GPU scissor to the dirty rects and
   composite every live layer (cached or fresh) into the frame, then present.

Tested behaviors (`manager.rs::tests`):

- First frame: 1 rasterize + 1 present (cold cache).
- Identical second frame: **0 rasterizes, 0 presents** (pure cache hit).
- Two layers, change one: **exactly one** layer re-rasterizes.

This is the concrete realization of the prompt's requirement: *detect the
rectangle to be updated and only redraw that part, using a layer-based system
integrated with an advanced caching mechanism.*

### 9.4 Why layers + dirty rects (and not just one or the other)

- **Dirty rects alone** still force you to re-rasterize everything *inside* the
  dirty region from scratch each frame.
- **Layers alone** let you skip unchanged content but, without dirty rects, you
  re-composite and re-present the whole screen.
- **Together:** unchanged layers are free (cached textures), changed layers
  re-rasterize in isolation, and the final present is scissored to just the union
  of what moved. Cost ∝ change, both in rasterization *and* bandwidth.

---

## 10. Layer 6 — The wgpu Backend (command mapping)

The backend is the **mechanical** translation of manager decisions into wgpu.
It sits behind the `GpuBackend` trait (`backend.rs`), so the hard logic above is
already validated without a GPU. The trait's surface *is* the mapping spec:

| `GpuBackend` method      | wgpu realization                                                            |
|--------------------------|-----------------------------------------------------------------------------|
| `ensure_layer_texture`   | Create/resize a `wgpu::Texture` (RGBA8/BGRA8, `RENDER_ATTACHMENT|TEXTURE_BINDING`) sized to the layer bounds × DPI. |
| `rasterize_layer`        | A render pass targeting that texture. Translate each `Primitive` to instanced geometry on a small set of pipelines (see below). Cache-miss only. |
| `set_scissor`            | `render_pass.set_scissor_rect` for each dirty rect (or one combined pass with per-draw scissor). |
| `composite_layer`        | Draw a textured quad of the cached layer texture into the swapchain view, scissored to dirty rects, blended by `opacity`. |
| `begin_frame`/`present`  | Acquire `surface.get_current_texture`, build the composite pass, `queue.submit`, `frame.present`. |
| `drop_texture`           | Drop the `wgpu::Texture`/bind group for an evicted layer. |

### 10.1 Pipelines (deliberately few)

1. **Rounded-rect / quad pipeline** — handles `Rect`, `RectStroke`, image quads,
   and layer-composite quads. SDF-based rounded corners + borders in the
   fragment shader. Instanced: one instance per rect, attributes = `{rect, radius,
   color | uv, border}`.
2. **Glyph pipeline** — `Text` becomes instanced quads sampling an R8 glyph atlas
   (see §11). Subpixel positioning via per-instance offset.
3. **Path/triangle pipeline** — `Path` (and tessellated strokes from `canvas.*`)
   via a triangle list produced by a CPU tessellator (`lyon`), with optional MSAA.

Gradients are a fragment-shader branch on the quad pipeline driven by a gradient
table (UBO/storage buffer), keyed by the `Paint::LinearGradient(idx)` index.

### 10.2 Batching

Within a layer's rasterize pass, commands are sorted/grouped by pipeline and
texture (glyph atlas, image atlas) to minimize state changes; each group is a
single instanced draw. Because rasterization is per-*changed*-layer, batches stay
small and cache-coherent.

### 10.3 Why wgpu

One API → Vulkan, Metal, D3D12 natively, and WebGPU (with WebGL2 fallback) on the
web. The backend code is written once; only the surface/window creation differs
per platform (§13).

---

## 11. Text, Images, Gradients & Resources

- **Text:** shape with `rustybuzz` (HarfBuzz port) + `fontdb` for font matching;
  rasterize glyphs with `swash`/`ab_glyph` into a dynamic **glyph atlas**
  (R8 texture, shelf/skyline packer). Cache shaped runs by `(text, font, size)`
  so repeated labels don't re-shape. Text measurement feeds layout (§8).
- **Images:** decode (`image` crate) off the render thread; upload into an
  **image atlas** or standalone textures; reference by `image_id` in
  `Primitive::Image`. Decode is async and cached by URL/hash.
- **Gradients:** a small gradient table (linear/radial + color stops) uploaded
  once and indexed by draw commands; matches the `canvas.createLinearGradient`/
  `addColorStop` host APIs.
- **Resource lifetime:** atlases and textures are reference-counted against live
  layers; the cache's `retain_layers` eviction drives texture reclamation.

All resource caches are keyed by content hash so identical content across frames
and across layers shares one GPU upload.

---

## 12. The Event System

Input flows **opposite** to rendering — from platform to VM:

1. **Platform → host:** winit (native) / DOM listeners (web) produce raw pointer,
   keyboard, scroll, resize, and gesture events.
2. **Hit-test:** the runtime hit-tests pointer position against the retained
   `UiTree` (using each node's laid-out `Rect`), honoring clip/z-order, to find
   the target node.
3. **Propagation:** capture → target → bubble phases (mirroring the Elpian event
   model: `stopPropagation`, `preventDefault`). A node's `events` map names the
   VM handler for each phase/type.
4. **Into the VM:** `Runtime::dispatch_event(handler, eventJson)` invokes the
   handler with a structured event object (`type`, `position`, `localPosition`,
   `delta`, `key`, modifier flags, `value`, ...). The handler mutates state and
   typically calls `render()` again → a new `DrawList` → a partial repaint (§3).
5. **Async/host events:** timers (`timer.delayed`/`timer.periodic`), network, and
   animation ticks enter through the same `dispatch_event` channel keyed by
   callback id, so the loop is uniform.

Supported event vocabulary (from the Elpian event system): pointer/touch
(`click`, `pointerDown/Move/Up`, `hover`), drag, focus/blur, input/change/submit,
keyboard, gestures (swipe/pinch/scale/rotate), and `scroll`/`resize`.

---

## 13. Cross-Platform Strategy (web / mobile / desktop)

One renderer, thin per-platform shells. Only **windowing/surface creation** and
**event source** differ.

| Platform | Window/surface | VM | Renderer | Notes |
|----------|----------------|----|----------|-------|
| **Desktop** (Win/macOS/Linux) | `winit` + wgpu surface | native rlib | wgpu → D3D12/Metal/Vulkan | `elpa-shell` binary; AST or bytecode loaded from disk. |
| **Web** | `<canvas>` + WebGPU (WebGL2 fallback) | `elpian-vm` compiled to **wasm32** (already cfg-gated, `wasm-bindgen`) | wgpu → WebGPU | JS→AST can run in-browser (acorn) or be prebuilt; `elpa-wasm` glue. |
| **iOS / Android** | `winit` (or a thin native view) + wgpu | native staticlib/cdylib (`crate-type` already set) | wgpu → Metal/Vulkan | `elpa-mobile` FFI; events from the platform view. |

Shared guarantees:

- The VM already builds for wasm (deps cfg-gated; no threads assumed on wasm).
- wgpu abstracts the GPU API; shaders are written in WGSL once.
- The protocol and drawing-management layers are pure Rust with **no platform or
  GPU dependency**, so they are identical everywhere and testable on CI without a
  GPU.

Distribution: desktop ships a binary + `app.elpb`; web ships a wasm bundle + AST;
mobile ships a native lib embedded in a thin host app.

---

## 14. Threading, Async & Frame Scheduling

- **VM is single-threaded** (`Rc`/`RefCell` interior). Each app VM lives on one
  thread; multiple apps can run on multiple threads (the VM registry is behind a
  `Mutex`). On wasm it runs on the main thread.
- **Render thread separation (native):** the VM/runtime produce `DrawList`s; the
  drawing manager + wgpu run their own frame loop. A `DrawList` is plain data
  (serde), so it can be handed across the thread boundary via a channel /
  triple-buffer. The renderer presents on the display's cadence regardless of VM
  activity.
- **Off-thread work:** image decode, font shaping for large text, and path
  tessellation can run on a worker pool (native) or be chunked (wasm).
- **Frame scheduling:** vsync-driven. If `DrawingManager::render` reports a clean
  frame, the loop can idle (no present) until the next input/animation tick —
  critical for battery on mobile and for not pinning a core on desktop.
- **Backpressure:** if the VM emits renders faster than the display refreshes,
  the runtime coalesces to the latest `UiTree` before layout (only the freshest
  UI matters).

---

## 15. Performance Budget & Benchmarks

Targets (1080p, mid-range hardware):

- **Steady state (no change):** < 0.1 ms host work, **zero** rasterization, zero
  present. Idle CPU ≈ 0.
- **Localized change** (button press, cursor blink, typing): repaint cost ∝ dirty
  area; target < 1 ms total, single small present.
- **Full repaint** (resize/theme): < 8 ms at 1080p (fits 120 Hz).
- **VM turn** for a typical handler + `render`: target < 0.5 ms (bytecode interp
  is cheap; the prototype VM already passes micro-tests instantly).

Benchmark plan (Criterion, mirroring Elpian's `benches/`):

1. `dirty_tracker` merge/coalesce throughput.
2. `cache` hash + hit/miss rate on representative UI churn.
3. `manager` end-to-end frames/sec with a mock backend across change patterns
   (nothing / one node / one layer / everything).
4. Lowering throughput (UiTree → DrawList) for large trees (10k nodes).
5. (Post-wgpu) GPU frame time per change pattern with a headless adapter.

---

## 16. Testing Strategy

Layered, GPU-free where possible (so CI needs no GPU):

- **Unit (today, green):** geometry algebra, color parsing, transforms; dirty-rect
  merging/coalescing; cache hashing + validity + eviction; UI-tree parsing/
  unwrapping; host-call envelope parsing.
- **Drawing-manager behavior (today, green):** mock `GpuBackend` asserts the exact
  rasterize/composite/present counts for cold cache, steady state, and
  single-layer change — i.e. partial rendering is *proven*, not assumed.
- **VM integration (today, green):** AST → bytecode → execute → `render` → parsed
  `UiTree` end-to-end.
- **Golden-image (post-wgpu):** render a `DrawList` headless, compare against PNG
  references (mirrors Elpian's `renderer_golden.rs`).
- **Property tests:** dirty-rect union/intersect invariants; "composited output
  with caching == full redraw" equivalence under random change sequences.
- **Cross-platform smoke:** build `--target wasm32-unknown-unknown` and the mobile
  targets in CI.

---

## 17. Roadmap & Milestones

- **M0 — Foundation (✅ done in this change):** workspace; Elpian VM ported &
  running; protocol types; drawing-management layer (cache + dirty + manager)
  with mock backend; runtime host-call loop; end-to-end VM→UiTree test. All green.
- **M1 — Layout & lowering:** style resolution, flexbox layout, UiTree→DrawList
  with layer assignment heuristics. Headless `DrawList` snapshot tests.
- **M2 — Text & resources:** font matching/shaping, glyph atlas, text measurement
  feeding layout; image decode + atlas; gradient table.
- **M3 — wgpu backend:** implement `GpuBackend` with the quad/glyph/path
  pipelines; winit desktop shell; first pixels on screen; golden-image tests.
- **M4 — Events & interactivity:** hit-testing, propagation, event→VM dispatch,
  animation/timer ticks; the full interaction loop (§3) live.
- **M5 — Web target:** wasm build, WebGPU surface, in-browser/prebuilt JS→AST,
  `elpa-wasm` glue.
- **M6 — Mobile targets:** iOS/Android shells, FFI, native event sources.
- **M7 — Polish & perf:** batching, atlas eviction, off-thread pipeline,
  benchmarks vs. budget; optional 3D path revival from the ported VM.

### Immediate next steps (start of M1)

1. Extract `elpa-layout`; implement style resolution + flexbox measure/arrange.
2. Implement lowering with a first layer-assignment heuristic
   (animation/scroll/opacity/size).
3. Add `DrawList` snapshot tests for representative UIs.
4. Stand up a headless software `GpuBackend` for golden tests ahead of wgpu.

---

## 18. Risks & Open Questions

- **Layer explosion.** Too many layers ⇒ composite/texture overhead outweighs
  rasterization savings. *Mitigation:* conservative auto-layering + a per-frame
  layer budget; coalesce small static siblings into shared layers.
- **Cache-hash cost.** Hashing every command per frame could rival rasterization
  for huge static layers. *Mitigation:* incremental/structural hashing keyed off
  the UiTree diff (only re-hash layers whose source subtree changed); the scaffold
  uses a simple full hash to be replaced in M3.
- **Text correctness.** Shaping/bidi/emoji are hard. *Mitigation:* lean on
  rustybuzz/swash; treat complex-script support as an explicit sub-milestone.
- **wasm threading.** No threads on `wasm32-unknown-unknown`. *Mitigation:* the VM
  and manager already assume single-thread fallbacks; chunk heavy work.
- **JS subset semantics.** Elpian is not full JS. *Open question:* document the
  supported subset precisely and lint user code against it at the AST stage.
- **3D scope.** The ported VM historically fed a Bevy 3D path. v1 ships 2D; 3D is
  a post-M7 option reusing the same host-call boundary with a 3D `DrawList`
  variant.

---

## Appendix A — Elpian AST node reference

Statement nodes (compiled in `compiler::compile_ast`): `program` (wrapper with
`body[]`), `definition`, `assignment`, `ifStmt` (+`elseifStmt`/`elseStmt`),
`loopStmt`, `switchStmt`, `functionDefinition`, `returnOperation`,
`jumpOperation`, `conditionalBranch`, `host_call`.

Expression nodes (compiled in `serialize_expr`): scalars `i16/i32/i64/f32/f64/
bool/string`, `identifier`, `indexer`, `cast`, `object`, `array`, `callback`,
`not`, `arithmetic` (`== > >= < <= != + - * / % ^`), `functionCall`, `host_call`.

Bytecode opcode families: `0x01`–`0x09` literals/object/array, `0x0b` identifier,
`0x0c` indexer, `0x0d` call, `0x0e` definition, `0x0f` assignment, `0x10`–`0x16`
if/loop/switch/funcdef/return/jump/branch, `0xf0`–`0xfb` comparison+arithmetic,
`0xfc` not, `0xfd` cast.

Value type codes: `0` null · `1` i16 · `2` i32 · `3` i64 · `4` f32 · `5` f64 ·
`6` bool · `7` string · `8` object · `9` array · `10` function · `253` paused.

## Appendix B — Draw-command reference

Primitives (`elpa_protocol::command::Primitive`): `Rect{rect,radius,paint}`,
`RectStroke{rect,radius,width,paint}`, `Text{origin,text,size,paint}`,
`Image{rect,image_id,src}`, `Path{points,paint}`, `PushClip{rect}`, `PopClip`.

Paint: `Solid(Color)` · `LinearGradient(idx)` · `RadialGradient(idx)`.

Each `DrawCommand` adds `{ layer: LayerId, bounds: Rect, transform, opacity }`.
The widget/HTML and `canvas.*` vocabularies (Appendix-listed in the Elpian docs)
all lower to this set; `DrawList::layer_bounds` and `DrawList::commands_in(dirty)`
drive caching and partial replay.
