# Elpa Game3D — a 3D game-making SDK (JavaScript)

A clean, object-oriented **3D game engine** for Elpa, written entirely as
**JavaScript** (`assets/sdk/*.js`). Like the engine [`elpa-sdk`](../sdk) and the
[`elpa-material`](../material) UI kit, it is **not Rust**: Elpa compiles the JS
to its VM and runs it directly, emitting a wgpu command tree the renderer maps
onto the GPU in real time. Apps build a **scene graph**, register an update
callback and call `startGame()` — they never touch the GPU.

```text
   your game (JS) ─▶ scene graph (Object3D tree)
                         │  Game.tick / render
                         ▼
   Renderer ── walks the graph, builds matrices & lights on the CPU
                         │  gpu.submit(depth-tested 3D pass, one draw per mesh)
                         ▼
                 Elpa VM ─▶ renderer ─▶ wgpu ─▶ GPU
```

## What's in the box

| Module | Responsibility |
|--------|----------------|
| `00-math` | `Vec3`, `Quat`, column-major `Mat4` (the wgpu layout) — perspective / ortho / look-at projections, TRS compose, 4×4 inverse, normal matrices. |
| `10-core` | The scene graph: `Object3D` (transform hierarchy), `Scene`, and `PerspectiveCamera` / `OrthographicCamera`. |
| `20-lighting` | `DirectionalLight` and `PointLight` (range-attenuated), as scene-graph nodes. |
| `30-geometry` | `Geometry` + `Box`/`Sphere`/`Plane` primitives, a PBR-ish `Material` (base colour, metalness, roughness, emissive) and `Mesh`. |
| `40-binary` · `45-gltf` | Base64 + little-endian readers (incl. an arithmetic IEEE-754 `f32` decoder) and a full **glTF 2.0 / GLB loader** (accessors, bufferViews, nodes, PBR materials). |
| `50-physics` | `Box3` / `Sphere` bounding volumes, a `Ray`, and a `Raycaster` for picking, line-of-sight and AABB collision. |
| `60-renderer` | The forward Blinn-Phong renderer: the WGSL pipeline and the per-frame `gpu.submit` command-tree builder. |
| `70-engine` · `80-api` | The `Game` runtime (loop, input, picking) and the `new`-free public constructors + host entry points. |

## Hello, scene

```javascript
let scene = createScene();
scene.setAmbient([0.6, 0.7, 1.0], 0.15);
scene.add(directionalLight([1.0, 0.95, 0.9], 1.2, v3(-0.4, -1.0, -0.3)));

let cube = boxMesh(1.5, 1.5, 1.5, { color: [0.9, 0.3, 0.35, 1.0], metallic: 0.2, roughness: 0.4 });
scene.add(cube);

let cam = perspectiveCamera(55.0, 0.1, 200.0);
cam.setPosition(0.0, 2.0, 6.0).lookAt(0.0, 0.0, 0.0);
useScene(scene);
useCamera(cam);

onUpdate((dt, g) => { cube.rotateY(dt); });
startGame();
```

Load a model instead:

```javascript
let model = loadGLB(glbByteArray);   // or loadGLBBase64(str) / loadGLTF(doc, bin)
scene.add(model);
```

Pick or test collisions:

```javascript
let hit = game().pick();                    // nearest mesh under the pointer
let touching = meshesCollideAABB(a, b);     // world-AABB overlap
let t = ray(v3(0,0,5), v3(0,0,-1)).intersectBox(box.worldBounds());
```

See [`assets/demo.js`](assets/demo.js) for a complete animated scene (a lit
ground plane, a spinning metallic cube, a bobbing sphere and an orbiting point
light viewed by an orbiting camera).

## Design notes

* **All transform / projection / lighting math runs on the CPU** (the VM exposes
  the full elementary-function set), so the renderer ships finished matrices to
  the GPU and the WGSL stays a single straightforward forward shader.
* **Stable resource identity.** Pipelines are created once; geometry buffers are
  keyed by geometry id (built once, then re-referenced — never re-tessellated);
  only the small per-frame uniforms (camera, transforms, lights) are refilled in
  place. Elpa's resource cache turns static geometry into zero per-frame GPU work.
* **No bitwise ops, no `&&`/`||`/`?:`** — the engine is written in the JS subset
  Elpa's in-VM front-end supports (nested `if` + numeric flags, like the Material
  kit). The glTF `f32` decoder reconstructs IEEE-754 singles with pure arithmetic.

## Build & test

```bash
cargo test  -p elpa-game3d                     # headless end-to-end + WGSL validation
cargo run   -p elpa-game3d --bin build_bytecode # (re)compile the JS to assets/demo.bc
```

The suite drives the engine through a real (headless) `Elpa` instance: it
validates the WGSL with `naga` exactly as wgpu does, proves the app builds a
depth-tested 3D pass with one indexed draw per mesh, that animation moves the
scene, that the GLB loader decodes real binary geometry, and that the ray-cast /
AABB collision queries are correct.
