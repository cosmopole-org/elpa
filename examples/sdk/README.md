# Elpa engine SDK (Elpian AST)

A high-performance drawing SDK for Elpa programs that draws the standard **2D and
3D shapes** — and, crucially, **the SDK itself is Elpian AST**, not Rust. It ships
as JSON files that run directly on the Elpian VM and that any Elpa program can pull
in at runtime with `vm.import`.

| File | What it is |
|------|------------|
| [`assets/elpa-sdk.ast.json`](assets/elpa-sdk.ast.json) | **The SDK.** An Elpian AST `program` whose body is a `gpu.define` per shape. Importable via `vm.import`. |
| [`assets/demo.ast.json`](assets/demo.ast.json) | A demo Elpian program: imports the SDK, then draws a 2D scene and a 3D scene by referencing shapes by id. |
| `src/bin/build_sdk.rs` | The **generator** that authors the two JSON files. Not the SDK — just tooling. Run `cargo run -p elpa-sdk --bin build_sdk` to regenerate. |
| `src/lib.rs` | Only embeds the JSON (`MODULE_AST`, `DEMO_AST`) so host examples can bundle and register it. |
| `tests/run.rs` | Runs the JSON assets through a headless `Elpa` instance end to end. |

## How a program uses it

```text
program:
  vm.import("assets/elpa-sdk.ast.json")   // registers elpa.sdk.rect/triangle/circle/cube/sphere
  gpu.submit(frame)                        // frame just references shapes by id:
      renderPass:
        setBindGroup(0, globals)           // viewport (2D) or camera (3D) uniform
        useDefinition("elpa.sdk.cube")     // expands to setPipeline + draw — the host
        useDefinition("elpa.sdk.sphere")   // splices the registered commands back in
```

The host's definition store expands every `useDefinition` into the real wgpu
command tree and merges the shared shader/pipeline resources (deduplicated, created
once and cached). So the VM's per-frame payload stays tiny no matter how complex
the scene, and the shared pipelines cost nothing after the first frame.

## Why it fits inside the Elpian language

The Elpian VM has no `sin`/`cos`/`tan`. So **all** geometry, rotation and camera
projection math lives in the **WGSL shaders** the AST carries (WGSL has trig):

* **2D** — one shader draws a rect or any regular polygon (triangle … circle) from
  a per-instance `(center, size, rotation, sides, kind)`. The fan vertices and the
  rotation are computed in WGSL.
* **3D** — one shader draws a cube (literal vertices) or a UV sphere (generated in
  the shader) and builds the per-instance model matrix (from rotation **angles**),
  the view matrix, and the perspective projection entirely in WGSL.

The Elpian side therefore only ever ships:

* WGSL strings, pipeline/resource **objects**, and instanced **draw definitions**, and
* per-instance data as plain **`f32` arrays** (positions, angles, sizes, colors) via
  the protocol's `data_f32` buffer initializer (added so a VM program can build GPU
  buffers without base64).

Every one of those is expressible as Elpian AST literals — no transcendental math is
ever asked of the VM.

## Performance

* **Instanced draws** — each shape kind is one draw call for all its instances
  (geometry slot is procedural; per-instance data is vertex-buffer slot 0).
* **Created-once resources** — shaders/pipelines/layouts are shared by stable id and
  cached by the renderer.
* **Reference, don't repeat** — shapes (and composites of shapes) are named once with
  `gpu.define` and referenced by id, so frames and composites stay small.

## Regenerating

```bash
cargo run -p elpa-sdk --bin build_sdk   # rewrites assets/*.ast.json
cargo test -p elpa-sdk                  # runs the JSON through a headless Elpa VM
```
