# Elpa — A Programmable VM Around the wgpu API

> **What Elpa is:** a Rust framework that runs the user's app logic (written in
> JavaScript, compiled to an AST) on a small embedded **VM**, and lets that VM
> drive the GPU directly by emitting a **nested JSON tree of wgpu commands**.
> Elpa maps that tree onto the real wgpu API in **real time**, adding exactly two
> things on top: **resource caching** and **partial rendering**.
>
> **What Elpa is *not*:** it is *not* a widget toolkit. There is no DOM, no
> Flutter-style widget tree, no Canvas-2D abstraction. Elpa is a thin, fast,
> programmable layer at the level of wgpu itself. 2D and 3D are not separate
> systems — they are the same wgpu commands with different pipelines and shaders.
>
> **Status:** the VM is ported and running; the wgpu command-tree protocol and
> the caching + partial-rendering engine are implemented and tested against a
> mock backend; the live wgpu backend is the next milestone. `cargo test
> --workspace` is green.

---

## 0. Table of Contents

1. [Concept & Vision](#1-concept--vision)
2. [System Architecture](#2-system-architecture)
3. [End-to-End Pipeline](#3-end-to-end-pipeline)
4. [Crate Layout](#4-crate-layout)
5. [JavaScript → AST (VM front-end)](#5-javascript--ast-vm-front-end)
6. [The VM (ported from Elpian)](#6-the-vm-ported-from-elpian)
7. [The wgpu Command-Tree Protocol](#7-the-wgpu-command-tree-protocol)
8. [Real-Time JSON → wgpu Mapping (the backend)](#8-real-time-json--wgpu-mapping-the-backend)
9. [Resource Caching](#9-resource-caching)
10. [Partial Rendering](#10-partial-rendering)
11. [**wgpu Command Coverage Matrix**](#11-wgpu-command-coverage-matrix)
12. [Cross-Platform Strategy](#12-cross-platform-strategy)
13. [Threading & Frame Scheduling](#13-threading--frame-scheduling)
14. [Performance Budget](#14-performance-budget)
15. [Testing Strategy](#15-testing-strategy)
16. [Roadmap & Milestones](#16-roadmap--milestones)
17. [Risks & Open Questions](#17-risks--open-questions)

---

## 1. Concept & Vision

Elpa gives app authors a **programmable GPU**: they write ordinary JavaScript,
and from it they build and submit GPU work — buffers, textures, shaders,
pipelines, render passes, compute passes, draw and dispatch calls — expressed as
a JSON tree. Elpa executes that tree on wgpu every frame, but is smart about it:

- **The VM is the program.** App logic (state, events, what-to-draw decisions)
  runs in the embedded Elpian VM. The VM's *output* is GPU commands, not widgets.
- **The JSON is wgpu.** The command tree is a faithful mirror of wgpu's own API.
  Nothing is interpreted into higher-level shapes; a `draw` is a `draw`, a
  `dispatch` is a `dispatch`. This is what makes Elpa *universal* — anything wgpu
  can render (2D UI, 3D scenes, GPGPU/compute, post-processing) is expressible.
- **Caching is automatic.** Every declared resource is created on the GPU once
  and reused until its description changes. Static pipelines and geometry cost
  nothing after the first frame.
- **Rendering is partial.** Each pass is content-hashed (including the resources
  it reads). Unchanged offscreen passes are *skipped* and their cached output
  texture reused; the surface present is scissored to just the changed region. A
  frame in which nothing changed submits no GPU work at all.

The result is a high-performance, cross-platform (web/mobile/desktop) engine
where the app author has wgpu's full power but pays only for what changes.

### Design tenets

1. **Stay at wgpu's level.** No abstraction that hides a wgpu concept. If wgpu
   has it, the JSON has it; if it doesn't, Elpa doesn't invent it.
2. **The VM never links wgpu; the renderer never links the VM.** They meet only
   at the JSON command tree (`elpa-protocol`).
3. **Optimization is transparent.** Caching and partial rendering change *when*
   wgpu calls happen, never *what* the app asked for. Output is identical to a
   naive full-redraw — just cheaper.

---

## 2. System Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│                       AUTHOR SPACE (JavaScript)                         │
│   app.js — state, event handlers, code that BUILDS wgpu command trees   │
└──────────────────────────────────┬────────────────────────────────────┘
                                    │ acorn parse + transform (off-VM)
                          ┌─────────▼──────────┐
                          │  Elpian AST JSON    │
                          └─────────┬──────────┘
╔══════════════════════════════════▼═════════════════════════════════════╗
║                              RUST CORE (Elpa)                           ║
║  ┌──────────────┐  bytecode  ┌────────────────────────────────────────┐║
║  │  elpian-vm   │───────────▶│ Executor (pausing interpreter)          │║
║  │  compiler    │            │ runs app logic, holds app state         │║
║  └──────────────┘            └──────────────────┬─────────────────────┘║
║                                                 │ askHost("gpu.submit", ║
║                                                 │          <frame tree>) ║
║  ┌───────────────────────────────────────────────▼──────────────────┐  ║
║  │  elpa-runtime — host-call loop                                    │  ║
║  │    parses payload → elpa_protocol::Frame                          │  ║
║  └───────────────────────────────┬──────────────────────────────────┘  ║
║                                  │ Frame { resources[], commands[] }     ║
║  ┌───────────────────────────────▼──────────────────────────────────┐  ║
║  │  elpa-renderer::Renderer                                          │  ║
║  │    • ResourceCache  — create-once, reuse-by-hash                  │  ║
║  │    • PassCache      — skip unchanged passes (partial render)      │  ║
║  │    • DirtyTracker   — scissor the present to what changed         │  ║
║  └───────────────────────────────┬──────────────────────────────────┘  ║
║                                  │ GpuBackend trait calls                ║
║  ┌───────────────────────────────▼──────────────────────────────────┐  ║
║  │  wgpu backend — JSON command ⇒ wgpu API, one-to-one               │  ║
║  └───────────────────────────────┬──────────────────────────────────┘  ║
╚═══════════════════════════════════▼═════════════════════════════════════╝
                       GPU (Vulkan / Metal / D3D12 / WebGPU)
```

---

## 3. End-to-End Pipeline

1. **App builds GPU work.** In JS, the app constructs a frame object: the
   resources it needs (`shader`, `buffer`, `renderPipeline`, …) and the commands
   to run (`renderPass` → `setPipeline`/`setVertexBuffer`/`drawIndexed`, etc.).
2. **Submit.** `gpu.submit(frame)` → `askHost("gpu.submit", frame)`. The VM
   **pauses** and hands the runtime a `HostCall`.
3. **Parse.** The runtime parses the payload into `elpa_protocol::Frame` (a typed
   wgpu command tree) and gives it to the `Renderer`.
4. **Cache resources.** The `ResourceCache` creates only the resources whose
   descriptor hash changed; everything static is reused.
5. **Plan passes.** Each render/compute pass is hashed (folding in the hashes of
   the resources it references). Unchanged cacheable passes are flagged **Skip**.
6. **Execute minimally.** If anything changed: begin an encoder, record only the
   non-skipped passes/copies/writes, and present scissored to the dirty region.
   If nothing changed: submit nothing.
7. **Resume.** The runtime resumes the VM; the app continues (e.g. waits for the
   next event/animation tick, then submits the next frame).

Input events run the same loop in reverse: the host calls a VM function with the
event payload; the handler updates state and submits a new frame → a minimal
re-render.

---

## 4. Crate Layout

```text
elpa/
├── PLAN.md · README.md · Cargo.toml (workspace)
└── crates/
    ├── elpian-vm/        ✅ ported VM (sdk) + renderer-agnostic host-call API
    │   └── src/{lib.rs, api.rs, sdk/{compiler,executor,vm,context,data}.rs}
    ├── elpa-protocol/    ✅ the wgpu command tree schema (tested)
    │   └── src/{resource.rs, command.rs, geometry.rs, hostcall.rs}
    ├── elpa-renderer/    ✅ caching + partial render (tested) · 🔜 wgpu backend
    │   └── src/{manager.rs, cache.rs, dirty.rs, backend.rs}
    └── elpa-runtime/     ✅ host-call loop: VM ⇄ Frame (tested)
        └── src/lib.rs
```

`cargo build --workspace` and `cargo test --workspace` pass today (15 tests). An
end-to-end test compiles an AST that calls `gpu.submit` with a shader+pipeline+
draw, runs the VM, parses the emitted `Frame`, and renders it through the real
`Renderer`, asserting the caching/partial-render behavior.

---

## 5. JavaScript → AST (VM front-end)

The app is JavaScript; it is parsed and transformed into **Elpian AST JSON**
before reaching the VM. This is the only "compile" step and runs off the VM (at
build time, or load time in a dev server / on device).

- **Parser:** acorn (+`acorn-jsx` if convenient) — proven in the Elpian
  prototypes. JSX is *optional sugar* the app could use to build command trees;
  the canonical form is plain JS object/array construction of the wgpu frame.
- **Transform:** ESTree → Elpian nodes (`functionDefinition`, `ifStmt`,
  `definition`, `assignment`, `arithmetic`, `functionCall`, `object`/`array`/
  scalar literals, `host_call`). The app's frame-building code is ordinary data
  construction; `gpu.submit(frame)` becomes a `host_call`.
- **Output:** `app.ast.json` (or pre-compiled bytecode `app.elpb`).

> Note: only the *VM* is taken from Elpian. The front-end here is just "parse JS
> to the AST the VM eats"; Elpa adopts none of Elpian's widget/DOM/canvas ideas.

---

## 6. The VM (ported from Elpian)

Copied verbatim from `elpian/rust/src/sdk` into `crates/elpian-vm`, re-homed
behind a clean host-call API (`api.rs`) with the Elpian Bevy/Flutter coupling
removed. The `sdk` depends only on `serde`/`serde_json`/`std`, so it is portable
and wasm-friendly.

- **Compile:** `compiler::compile_ast(astJson, 0) -> Vec<u8>` → compact
  big-endian bytecode.
- **Interpret:** `Executor` is a *pausing* interpreter. `single_thread_operation`
  drives it: `0x01` run/resume, `0x03` continue after a host call.
- **Values:** `Val { typ, data }`; type codes `0` null · `1..5` ints/floats · `6`
  bool · `7` string · `8` object · `9` array · `10` function · `253` paused.
- **Host-call boundary (the only seam):** `askHost(apiName, payload)` suspends the
  VM and emits `{ machineId, apiName, payload }`. The runtime services it and
  resumes via `continue_execution`. Elpa's host API is tiny and GPU-focused:
  `gpu.submit`, `gpu.writeBuffer`, `gpu.writeTexture`, `gpu.readBuffer`,
  `gpu.surfaceInfo`, `log`. **No canvas/dom APIs.**

The port is validated end-to-end (AST → bytecode → execute → `gpu.submit` →
parsed `Frame`).

---

## 7. The wgpu Command-Tree Protocol

`elpa-protocol` is the schema of the JSON the VM submits. It mirrors wgpu.

### 7.1 `Frame`

```jsonc
{
  "resources": [ /* ResourceDesc… declarative GPU objects, keyed by id */ ],
  "commands":  [ /* EncoderCommand… imperative work, in order */ ]
}
```

### 7.2 Resources (`ResourceDesc`, tagged by `kind`)

`buffer`, `texture`, `sampler`, `shader` (WGSL), `bindGroupLayout`, `bindGroup`,
`pipelineLayout`, `renderPipeline`, `computePipeline`. Each has an app-chosen
`id` used as its **cache key** and for cross-references. Render pipelines carry
full `vertex`/`fragment`/`primitive`/`depthStencil`/`multisample` state, so both
2D (no depth) and 3D (depth-tested, culled) pipelines are expressible. Large wgpu
enums (formats, usages, blend factors, …) are carried as strings/`Vec<String>`
flags and parsed at the backend, which keeps the JSON⇆wgpu mapping **total**:
any valid wgpu token passes through.

### 7.3 Commands (`EncoderCommand`, tagged by `op`)

`renderPass`, `computePass`, `copyBufferToBuffer`, `copyBufferToTexture`,
`copyTextureToBuffer`, `copyTextureToTexture`, `writeBuffer`, `writeTexture`,
`clearBuffer`. A `renderPass` nests `RenderCommand`s; a `computePass` nests
`ComputeCommand`s — see the matrix in §11 for the full list.

A render pass targets either the **surface** (the swapchain) or a declared
**texture** (an offscreen, *cacheable* layer). That distinction is the hook for
partial rendering (§10).

---

## 8. Real-Time JSON → wgpu Mapping (the backend)

The backend is the literal translation of the command tree into wgpu calls,
behind the `GpuBackend` trait so the caching/partial-render logic is testable
without a GPU. The trait *is* the mapping spec:

| `GpuBackend` method      | wgpu call(s) |
|--------------------------|--------------|
| `create_resource(desc)`  | dispatch on `kind` → `device.create_buffer` / `create_texture` / `create_sampler` / `create_shader_module` / `create_bind_group_layout` / `create_bind_group` / `create_pipeline_layout` / `create_render_pipeline` / `create_compute_pipeline`. Enum tokens parsed here. |
| `destroy_resource(id)`   | drop the cached handle. |
| `begin_frame()`          | `surface.get_current_texture` + `device.create_command_encoder`. |
| `record_render_pass(rp)` | `encoder.begin_render_pass` (attachments from `color_attachments`/`depth_stencil`) then replay each `RenderCommand`. |
| `record_compute_pass(cp)`| `encoder.begin_compute_pass` then replay each `ComputeCommand`. |
| `record_encoder_command` | `encoder.copy_*` / `queue.write_buffer` / `write_texture` / `clear_buffer`. |
| `end_frame(dirty)`       | `queue.submit` + `surface_texture.present`, scissored to `dirty`. |

The wgpu impl lives under the `wgpu-backend` feature (M3) and is the *only* place
that links wgpu. Everything above it is GPU-API-agnostic.

---

## 9. Resource Caching

`ResourceCache` (`cache.rs`) maps each `ResourceId` to the content hash of the
descriptor currently realized on the GPU. On each `Frame`:

- new id or changed hash → `create_resource` (one GPU allocation), update hash;
- unchanged → **nothing**;
- id absent from the frame → `destroy_resource`, evict.

Static resources (pipelines, immutable vertex buffers, LUT textures) are built on
frame 1 and reused for the app's life. `queue.write_buffer`/copies `touch()` the
destination's hash so dependent passes invalidate (§10) without recreating the
resource. Validated by `cache.rs` tests (create/skip/evict, touch).

---

## 10. Partial Rendering

Two cooperating mechanisms in `manager.rs` (the `Renderer`):

**(a) Pass-level cache.** Every render/compute pass with an `id` is content-hashed
*including the hashes of the resources it references*. A cacheable **offscreen**
pass (targets a texture, not the surface) whose hash is unchanged is **skipped
entirely** — `record_render_pass` is never called, and its previously rendered
target texture stands in. Changing a buffer the pass reads changes the fold-in
hash → cache miss → just that pass re-records.

**(b) Dirty-rect present.** Surface passes carry `setScissorRect` commands marking
what moved; `DirtyTracker` coalesces them, and `end_frame` scissors the present to
their union (full-surface only if a surface pass declares no scissor). Unchanged
screen regions keep last frame's pixels.

**Steady state:** a frame identical to the last does no resource work, skips its
offscreen passes, finds the surface pass unchanged, and **presents nothing**.
Proven by tests:

- cold frame: resources created + both passes recorded + present;
- identical frame: `FrameStats::default()` (zero work, no present);
- change one buffer: only the dependent pass + the surface present re-run;
- `writeBuffer`: forces the frame to run and invalidates readers of that buffer.

This is exactly the prompt's requirement — *detect what changed and redraw only
that, via a layer (offscreen-pass) cache + dirty rectangles* — but expressed at
the wgpu level instead of over widgets.

---

## 11. wgpu Command Coverage Matrix

> **This section answers: "does the JSON→wgpu mapping cover all wgpu commands
> (2D, 3D, etc.) completely?"**
>
> **Short answer:** the **schema** (`elpa-protocol`) already covers the entire
> *core* wgpu surface used by 2D, 3D, and compute workloads — all resource types,
> render & compute passes, every common draw/dispatch/copy/write command, and full
> blend/depth/multisample/vertex state. It does **not yet** cover a set of
> *advanced/optional* wgpu features (listed below). Separately, the schema is
> defined and tested now, but the code that issues the *live* wgpu calls is **M3**;
> today a mock backend validates the logic. So: **core 2D+3D = covered in schema;
> advanced features + live backend = roadmapped.** "Complete coverage of *every*
> wgpu command" is explicitly *not yet* true, and the table tracks the gap.

Legend: ✅ schema implemented · 🔶 partial · ⛔ not yet · (backend = the live wgpu
call, lands in M3 unless noted).

### Resources (`device.create_*`)

| wgpu resource          | Schema | Notes |
|------------------------|:------:|-------|
| Buffer                 | ✅ | usages as flag strings; optional base64 init data |
| Texture                | ✅ | size/format/usage/mips/samples/dimension (1D/2D/3D) |
| TextureView            | 🔶 | derived from a texture by the backend; standalone view desc (format/aspect/mip & layer ranges) ⛔ |
| Sampler                | ✅ | filters, address modes, compare (shadow) |
| ShaderModule (WGSL)    | ✅ | SPIR-V/GLSL ingestion ⛔ (WGSL only) |
| BindGroupLayout        | ✅ | per-entry visibility + binding type |
| BindGroup              | ✅ | buffer / textureView / sampler bindings |
| PipelineLayout         | ✅ | push-constant ranges ⛔ (native feature) |
| RenderPipeline         | ✅ | vertex+fragment+primitive+depthStencil+multisample |
| ComputePipeline        | ✅ | module + entry point |
| RenderBundle           | ⛔ | + `executeBundles` — planned post-M3 |
| QuerySet (timestamp/occlusion) | ⛔ | + `writeTimestamp`/`resolveQuerySet` |

### Encoder-level commands

| wgpu command                 | Schema | Notes |
|------------------------------|:------:|-------|
| begin_render_pass            | ✅ | `renderPass` with color + depth/stencil attachments |
| begin_compute_pass           | ✅ | `computePass` |
| copy_buffer_to_buffer        | ✅ | |
| copy_buffer_to_texture       | ✅ | |
| copy_texture_to_buffer       | ✅ | (basis for `gpu.readBuffer`) |
| copy_texture_to_texture      | ✅ | |
| clear_buffer                 | ✅ | |
| clear_texture                | 🔶 | via render-pass clear today; direct op ⛔ |
| push/pop_debug_group, insert_debug_marker | ⛔ | cosmetic/tooling |
| write_timestamp / resolve_query_set | ⛔ | needs QuerySet |

### Render-pass commands

| wgpu command                  | Schema | Notes |
|-------------------------------|:------:|-------|
| set_pipeline                  | ✅ | |
| set_bind_group (+ dynamic offsets) | ✅ | |
| set_vertex_buffer             | ✅ | |
| set_index_buffer (uint16/32)  | ✅ | |
| draw                          | ✅ | + instancing |
| draw_indexed                  | ✅ | + instancing, base vertex |
| draw_indirect                 | ✅ | |
| draw_indexed_indirect         | ✅ | |
| multi_draw_indirect(_count)   | ⛔ | native feature |
| set_scissor_rect              | ✅ | also drives partial-present dirty rects |
| set_viewport                  | ✅ | incl. min/max depth (3D) |
| set_blend_constant            | ✅ | |
| set_stencil_reference         | ✅ | |
| execute_bundles               | ⛔ | needs RenderBundle |
| begin/end_occlusion_query     | ⛔ | needs QuerySet |

### Compute-pass commands

| wgpu command                  | Schema | Notes |
|-------------------------------|:------:|-------|
| set_pipeline / set_bind_group | ✅ | |
| dispatch_workgroups           | ✅ | `dispatch` |
| dispatch_workgroups_indirect  | ✅ | `dispatchIndirect` |

### Pipeline state coverage (inside descriptors)

| State                         | Schema | Notes |
|-------------------------------|:------:|-------|
| Vertex buffer layouts/attrs   | ✅ | stride, step mode, per-attr format/offset/location |
| Primitive (topology/cull/front-face/strip index) | ✅ | polygon line/point fill ⛔ (native) |
| Blend (color & alpha factors/ops) | ✅ | covers alpha/additive/multiply/etc. |
| Color write mask              | ✅ | |
| Depth test/write/compare      | ✅ | 3D depth |
| Stencil (faces/ops/masks)     | 🔶 | `setStencilReference` ✅; full per-face `StencilState` ⛔ |
| Multisample (count/mask/a2c)  | ✅ | MSAA |

### What "2D vs 3D" means here

There is no 2D/3D switch. **2D** = pipelines with no depth-stencil and an
orthographic transform in the shader; **3D** = pipelines with a depth attachment,
back-face culling, and a perspective transform. **Compute** (particles, GPGPU,
skinning, post-processing) is first-class via compute passes. All three are
already expressible with the ✅ rows above.

### There are no "shape", "texture", or "text" commands — by design

This is the most common misconception, so it is stated explicitly: **wgpu has no
command to "draw a cube", "draw a rect", "draw an image", or "draw text".** Those
do not exist in the wgpu API, and therefore not in Elpa's command tree either —
adding them would re-introduce exactly the widget/canvas abstraction Elpa
excludes. Every shape, texture, and glyph is **data fed to a generic draw call**:

| Goal | wgpu/Elpa expression (all ✅ commands) |
|------|----------------------------------------|
| Triangle | vertex buffer (3 verts) + pipeline → `draw{vertexCount:3}` |
| Rect / quad | 4 verts + index buffer → `drawIndexed{indexCount:6}` |
| Cube / arbitrary 3D mesh | vertex+index buffer + depth-tested pipeline → `drawIndexed{indexCount:36}` |
| Any 2D/3D shape | its vertices in a buffer + a matching pipeline → a `draw`/`drawIndexed` |
| Textured surface | `texture` + `sampler` + `bindGroup`; fragment shader samples it on a quad |
| Text | a glyph-atlas `texture` + per-glyph quads in a vertex buffer → `draw`. **wgpu performs no font shaping** — the app or an optional helper produces the glyph geometry/atlas. |

So: the **commands** needed to draw any 2D/3D shape, textures, and text are all
covered (`setPipeline`, `setVertexBuffer`, `setIndexBuffer`, `setBindGroup`,
`draw`, `drawIndexed`, `draw*Indirect`, `dispatch`). What Elpa intentionally does
*not* provide is a built-in shape/text/image vocabulary — that lives in app code
(JS) or a separate, optional helper crate layered *above* the command tree, never
inside it. The deferred ⛔ features are not required for any of the above.

### Conclusion

- **Complete for core 2D + 3D + compute (schema):** yes.
- **Complete for *every* wgpu feature:** no — the ⛔ rows (render bundles, query
  sets/timestamps, multi-draw-indirect, full stencil-face state, standalone
  texture-view descriptors, push constants, SPIR-V/GLSL, debug markers,
  clear_texture) are deliberately deferred and tracked here.
- **Live wgpu backend:** the mapping table in §8 is the spec; its implementation
  is M3. Until then the schema is exercised through the mock backend.

Closing the ⛔ list is a mechanical extension of `elpa-protocol` + the backend and
is scheduled across M3–M5.

---

## 12. Cross-Platform Strategy

One renderer; thin per-platform shells differing only in surface creation and
event source.

| Platform | Surface | VM | Backend |
|----------|---------|----|---------|
| **Desktop** (Win/macOS/Linux) | `winit` + wgpu | native rlib | wgpu → D3D12/Metal/Vulkan |
| **Web** | `<canvas>` + WebGPU (WebGL2 fallback) | `elpian-vm` on **wasm32** (deps already cfg-gated, `wasm-bindgen`) | wgpu → WebGPU |
| **iOS / Android** | native view + wgpu | native static/cdylib (`crate-type` set) | wgpu → Metal/Vulkan |

The protocol, caching, and partial-render logic are pure Rust with **no GPU or
platform dependency**, so they are identical everywhere and CI-testable without a
GPU. Shaders are WGSL, written once.

---

## 13. Threading & Frame Scheduling

- **VM is single-threaded** (`Rc`/`RefCell`); one app VM per thread (registry
  behind a `Mutex`); main thread on wasm.
- **Render/VM decoupled (native):** a `Frame` is plain serde data, so it can be
  produced by the VM thread and consumed by a render thread via a channel /
  triple-buffer. The renderer runs on the display's cadence.
- **Idle when clean:** if `Renderer::render` reports an all-cached frame, the loop
  can park until the next event/animation tick — no busy GPU, good for battery.
- **Coalescing:** if the VM submits faster than vsync, keep only the latest frame.

---

## 14. Performance Budget

Targets (1080p, mid hardware):

- **Steady state (nothing changed):** zero resource work, all offscreen passes
  skipped, **no present**. ~0 GPU, near-0 CPU.
- **Localized change:** cost ∝ the re-recorded pass(es) + a scissored present;
  target < 1 ms.
- **Full redraw (resize/format change):** < 8 ms (fits 120 Hz).
- **VM turn** (handler + build + submit a frame): target < 0.5 ms.

Benchmarks (Criterion): resource-sync throughput; pass hashing + hit/miss rate;
end-to-end frames/sec across change patterns (none/one-pass/all) with the mock
backend; post-M3 GPU frame time on a headless adapter.

---

## 15. Testing Strategy

- **Unit (green today):** geometry (rect union/intersect), resource & command
  parse/roundtrip (incl. a depth-tested 3D pipeline and a compute+copy frame),
  host-call envelope, dirty-rect coalescing, resource cache create/skip/evict.
- **Renderer behavior (green):** mock `GpuBackend` asserts exact
  create/record/present counts for cold / steady-state / single-change / write
  frames — partial rendering is *proven*.
- **VM integration (green):** AST → bytecode → execute → `gpu.submit` → parsed
  `Frame` → rendered, with caching asserted.
- **Post-M3:** golden-image tests rendering a `Frame` on a headless wgpu adapter;
  property test "cached output ≡ naive full redraw" under random change sequences.
- **Cross-target:** CI builds `wasm32-unknown-unknown` and mobile targets.

---

## 16. Roadmap & Milestones

- **M0 — Foundation (✅ done):** workspace; VM ported & running; wgpu command-tree
  protocol; resource caching + partial rendering with mock backend; runtime
  host-call loop; end-to-end VM→Frame→render test. All green.
- **M1 — Protocol completeness:** close the high-value ⛔ rows (standalone
  TextureView desc, full stencil state, clear_texture); fuzz the JSON schema;
  formalize `gpu.writeBuffer`/`writeTexture`/`readBuffer`/`surfaceInfo`.
- **M2 — Front-end:** JS→AST toolchain (acorn) producing frame-building programs;
  example apps (a 2D quad, a 3D cube, a compute particle sim).
- **M3 — Live wgpu backend:** implement `GpuBackend` over wgpu + a `winit` desktop
  shell; first pixels; golden-image tests. This realizes §8 and §11's backend.
- **M4 — Partial-render on GPU:** offscreen-pass texture cache + scissored present
  on real wgpu; verify steady-state does no GPU work; perf vs §14.
- **M5 — Advanced wgpu features:** render bundles + `executeBundles`, query
  sets/timestamps, multi-draw-indirect, push constants; readback path.
- **M6 — Web + mobile shells:** wasm/WebGPU; iOS/Android surfaces & event sources.
- **M7 — Polish & perf:** render-thread decoupling, frame coalescing, benchmarks,
  resource eviction policies.

### Immediate next steps

1. Implement the wgpu `GpuBackend` (enum-token parsing → wgpu descriptors).
2. Stand up the `winit` desktop shell + surface configuration.
3. Add the JS→AST example that submits a 3D depth-tested frame.

---

## 17. Risks & Open Questions

- **Schema vs. wgpu drift.** wgpu's API evolves; string-token enums absorb most
  changes, but structural additions need schema work. *Mitigation:* version the
  protocol; validate tokens at the backend with clear errors.
- **Pass-hash cost.** Hashing large passes each frame could rival recording.
  *Mitigation:* structural/incremental hashing keyed off which resources the VM
  actually touched; the current full hash is a correct, replaceable baseline.
- **Dirty-rect responsibility.** True partial *present* relies on the app
  scissoring its surface pass to what changed (Elpa always skips unchanged
  offscreen passes regardless). *Open question:* offer an optional helper that
  derives surface dirty rects from which offscreen passes changed.
- **Resource lifetime/eviction.** Frequent id churn could thrash GPU allocations.
  *Mitigation:* keep a small LRU of recently-evicted resources before destroying.
- **Validation/safety.** Malformed command trees must fail gracefully, not panic
  the GPU. *Mitigation:* validate references (ids exist, types match) before
  recording; surface errors to the VM via the host-call return value.
