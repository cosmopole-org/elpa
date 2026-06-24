// Elpa Game3D — the public API surface.
//
// The single `Game` instance `G` (the runtime root every host entry point drives)
// and the thin, `new`-free constructors apps compose scenes from — scenes,
// cameras, primitive meshes, materials, lights, the glTF loader and the physics
// helpers. Apps never touch the GPU command tree: they build a scene graph,
// register an update callback and call `startGame()`. Everything here delegates
// to the engine classes defined in the modules above (all hoisted, so this runs
// first regardless of concatenation order).

// The one engine instance — the composition root.
let G = new Game();

// ---- lifecycle ---------------------------------------------------------------
function game() { return G; }
function useScene(s) { G.setScene(s); return s; }
function useCamera(c) { G.setCamera(c); return c; }
function onUpdate(fn) { G.onUpdate(fn); }
function onInput(fn) { G.onInput(fn); }
function onResized(fn) { G.onResized(fn); }
function startGame() { G.start(); }
// Attach a turntable camera rig (drag-rotate, wheel-zoom, secondary-drag-pan).
function enableOrbit(opts) { return G.enableOrbit(opts); }
function orbitControls() { return G.controls; }

// ---- HUD overlay (floating, draggable panels) --------------------------------
// `addPanel({ id, x, y, w, title, collapsed })` creates a floating window and
// returns the `UIPanel`, so an app chains content onto it:
//   addPanel({ title: "STATS", x: 16, y: 16, w: 210 })
//     .label((g) => concat("FPS ", str(floor(g.fps))))
//     .bar("HEALTH", 0.8, [0.4, 0.85, 0.4, 1.0])
//     .button("RESET", (g) => { ... });
// Rows take either constants or `fn(game)` callbacks for live read-outs. Panels
// drag by their title bar (mouse or touch) and collapse via the title-bar grip.
function overlay() { return G.overlay; }
function addPanel(opts) { return G.addPanel(opts); }
function panel(id) { return G.overlay.panelById(id); }
function showOverlay(on) { if (on > 0.5) { G.overlay.visible = 1.0; } else { G.overlay.visible = 0.0; } }

// ---- scene / cameras ---------------------------------------------------------
function createScene() { return new Scene(); }
function group() { let g = new Object3D(); g.nodeType = "group"; return g; }
function perspectiveCamera(fovDeg, near, far) { return new PerspectiveCamera(fovDeg, near, far); }
function orthographicCamera(halfHeight, near, far) { return new OrthographicCamera(halfHeight, near, far); }

// ---- geometry / meshes / materials -------------------------------------------
function boxGeometry(w, h, d) { return BoxGeometry(w, h, d); }
function sphereGeometry(r, stacks, sectors) { return SphereGeometry(r, stacks, sectors); }
function planeGeometry(size, segments) { return PlaneGeometry(size, segments); }
function cylinderGeometry(rTop, rBottom, height, seg) { return CylinderGeometry(rTop, rBottom, height, seg); }
function coneGeometry(radius, height, seg) { return ConeGeometry(radius, height, seg); }
function geometry(positions, normals, uvs, indices) { return new Geometry(positions, normals, uvs, indices); }
function material(opts) { return new Material(opts); }
function mesh(geo, mat) { return new Mesh(geo, mat); }
function boxMesh(w, h, d, opts) { return new Mesh(BoxGeometry(w, h, d), new Material(opts)); }
function sphereMesh(r, opts) { return new Mesh(SphereGeometry(r, 16, 24), new Material(opts)); }
function planeMesh(size, opts) { return new Mesh(PlaneGeometry(size, 1), new Material(opts)); }
function cylinderMesh(rTop, rBottom, height, seg, opts) { return new Mesh(CylinderGeometry(rTop, rBottom, height, seg), new Material(opts)); }
function coneMesh(radius, height, seg, opts) { return new Mesh(ConeGeometry(radius, height, seg), new Material(opts)); }

// ---- lights ------------------------------------------------------------------
function directionalLight(color, intensity, dir) { return new DirectionalLight(color, intensity, dir); }
function pointLight(color, intensity, rng) { return new PointLight(color, intensity, rng); }

// ---- math constructors -------------------------------------------------------
function v3(x, y, z) { return new Vec3(x, y, z); }
function quaternion() { return new Quat(0.0, 0.0, 0.0, 1.0); }

// ---- model loading -----------------------------------------------------------
// `bytes` is a GLB byte array; `b64` the same container base64-encoded; `doc`/`bin`
// a parsed glTF JSON document plus an optional binary blob. Each returns the root
// `Object3D` of the loaded hierarchy, ready to `add` into a scene.
function loadGLB(bytes) { return new GLTFLoader().loadGLB(bytes); }
function loadGLBBase64(b64) { return new GLTFLoader().loadBase64(b64); }
function loadGLTF(doc, bin) { return new GLTFLoader().parse(doc, bin); }
function gltfLoader() { return new GLTFLoader(); }

// ---- physics / picking -------------------------------------------------------
function raycaster(origin, direction) { return new Raycaster(origin, direction); }
function box3(lo, hi) { return new Box3(lo, hi); }
function sphereVolume(center, radius) { return new Sphere(center, radius); }
function ray(origin, direction) { return new Ray(origin, direction); }

// ---- host entry points -------------------------------------------------------
function onFrame(dt) { G.tick(dt); }
function onResize(info) { G.resized(info); }
function onEvent(e) { G.handleEvent(e); }
