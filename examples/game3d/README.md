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
| `30-geometry` | `Geometry` + `Box`/`Sphere`/`Plane`/`Cylinder`/`Cone` primitives, a PBR-ish `Material` (base colour, metalness, roughness, emissive) and `Mesh`. |
| `40-binary` · `45-gltf` | Base64 + little-endian readers (incl. an arithmetic IEEE-754 `f32` decoder) and a full **glTF 2.0 / GLB loader** (accessors, bufferViews, nodes, PBR materials). |
| `50-physics` | `Box3` / `Sphere` bounding volumes, a `Ray`, and a `Raycaster` for picking, line-of-sight and AABB collision. |
| `60-renderer` | The forward Blinn-Phong renderer: the WGSL pipeline and the per-frame `gpu.submit` command-tree builder. |
| `70-engine` | The `Game` runtime (loop, input, picking) and an `OrbitController` turntable camera (drag-orbit / wheel-zoom / pan). |
| `75-overlay` | The 2D **HUD**: floating, **draggable** (mouse + touch) `UIPanel` windows of labels, gauges and buttons, composited over the 3D scene in a second alpha-blended pass. A compact 3×5 bitmap font keeps it self-contained (no font atlas). |
| `80-api` | The `new`-free public constructors + host entry points. |

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

Add a turntable camera (drag to orbit, scroll/pinch to zoom, right-drag to pan):

```javascript
enableOrbit({ target: v3(0, 1, 0), distance: 30, minDistance: 8, maxDistance: 65 });
```

Float a draggable HUD panel over the scene (mouse **or** touch — drag the title
bar to move it, tap the title-bar grip to collapse it):

```javascript
addPanel({ title: "STATS", x: 16, y: 16, w: 216 })
    .label((g) => concat("FPS    ", str(floor(g.fps))))
    .label((g) => concat("MESHES  ", str(g.renderer.stats.meshes)))
    .bar("ZOOM", (g) => 0.6, [0.45, 0.78, 1.0, 1.0])      // a 0..1 gauge
    .button("RESET VIEW", (g) => { resetView(); });        // a finger-sized button
```

Rows take constants or `fn(game)` callbacks for live read-outs; the HUD captures
any gesture that lands on a panel, so dragging a window never orbits the scene
behind it. Panels are positioned and sized in *logical* pixels, so they stay
crisp and finger-friendly across desktop and high-DPI mobile.

See [`assets/demo.js`](assets/demo.js) for a complete **low-poly island village**:
a round grass island ringed by a sandy beach in an open sea, a cluster of
cottages (walls, pyramid roofs, glowing windows, chimneys), scattered trees,
gentle hills, a working windmill whose sails turn, sailboats bobbing offshore,
hopping villagers and drifting clouds — ~100 meshes built from a handful of
shared geometries, lit by a warm sun and a cool sky fill, explored with the
orbit camera. The scene is assembled through small builder functions
(`makeTree`, `makeHouse`, `makeWindmill`, …).

Floating over the village are four **draggable HUD panels** — live village stats
(frame rate, mesh / draw counts, clock), camera controls (a zoom gauge with
zoom-in/out and reset buttons), simulation toggles (pause, show/hide clouds) and
a collapsible help card — each a window the player drags anywhere by its title
bar with a mouse or a finger.

Two pedestals in the square display gems **loaded at runtime through the glTF/GLB
loader** rather than built from primitives: a faceted crystal from a base64
`.glb` binary container (`loadGLBBase64`) and a gold gem from a `.gltf` JSON
document with a `data:` buffer (`loadGLTF`). The model bytes live in
[`assets/models.js`](assets/models.js) (generated by
[`scripts/gen_demo_models.py`](../../scripts/gen_demo_models.py)), so the loader
path runs on the live GPU in the web/native hosts, not only in the headless tests.

## Design notes

* **All transform / projection / lighting math runs on the CPU** (the VM exposes
  the full elementary-function set), so the renderer ships finished matrices to
  the GPU and the WGSL stays a single straightforward forward shader.
* **Stable resource identity.** Pipelines are created once; geometry buffers are
  keyed by geometry id (built once, then re-referenced — never re-tessellated);
  only the small per-frame uniforms (camera, transforms, lights) are refilled in
  place. Elpa's resource cache turns static geometry into zero per-frame GPU work.
* **The HUD is cached, not re-tessellated.** The overlay fingerprints its visible
  content each frame (dims, panel positions/state, resolved text/gauge values) and
  only rebuilds its vertex soup when that signature changes — so a static HUD adds
  ~no per-frame CPU while the scene rotates beneath it (`tests/bench.rs` measures
  interpreter steps/frame: the HUD's steady-state overhead is ~1%, down from ~4×
  when it rebuilt every frame). The bitmap font run-length-merges lit cells to keep
  the soup small.
* **No bitwise ops, no `&&`/`||`/`?:`** — the engine is written in the JS subset
  Elpa's in-VM front-end supports (nested `if` + numeric flags, like the Material
  kit). The glTF `f32` decoder reconstructs IEEE-754 singles with pure arithmetic.

## Build & test

```bash
cargo test  -p elpa-game3d                     # headless end-to-end + WGSL validation + HUD frame-cost bench
cargo run   -p elpa-game3d --bin build_bytecode # (re)compile the JS to assets/demo.bc
```

The suite drives the engine through a real (headless) `Elpa` instance: it
validates the WGSL with `naga` exactly as wgpu does, proves the app builds a
depth-tested 3D pass with one indexed draw per mesh, that animation moves the
scene, that the GLB loader decodes real binary geometry, and that the ray-cast /
AABB collision queries are correct.

## Run it on a real GPU (web / native)

The [`web`](../web) and [`native`](../native) example hosts can embed this demo's
bytecode and run it on a live wgpu surface, behind a `game3d` Cargo feature:

```bash
# Browser (full-window canvas)
cd examples/web && trunk build --release --features game3d

# Desktop (Windows / macOS / Linux) and Android
cd examples/native && cargo run --release --features game3d
cd examples/native && cargo apk run --release --features game3d
```

Without the feature both hosts run the Material gallery as before; the feature
just swaps the embedded `assets/demo.bc` produced by `build_bytecode`.

The repo's CI wires this up for you:

* **GitHub Pages** ([`deploy-pages.yml`](../../.github/workflows/deploy-pages.yml))
  builds both apps on every push and serves this demo live at
  `https://<owner>.github.io/<repo>/game3d/` (the Material gallery stays at the
  root).
* **APK** ([`android-apk.yml`](../../.github/workflows/android-apk.yml)) — run the
  "Build APK" workflow with `app=game3d` to produce and commit `elpa-game3d.apk`
  (the Material build remains `elpa.apk`).
* **Bytecode** ([`build-bytecode.yml`](../../.github/workflows/build-bytecode.yml))
  recompiles and commits `assets/demo.bc` whenever this SDK's JavaScript changes.
