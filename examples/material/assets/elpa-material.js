// Elpa Material Design 3 SDK — a small Flutter-style widget framework in JS.
//
// This file is the SDK. It is *linked ahead of* an app (see `demo.js`) into one
// program, exactly like a Flutter app `import`s `package:flutter/material.dart`:
// the app calls the widget constructors, `defineComponent`, and `runApp` defined
// here and never touches the GPU. Everything below — the rounded-rect SDF pipeline,
// the glyph font, the responsive layout coordinator, the per-widget M3
// colors/sizes, the retained component runtime, and the event plumbing that ends
// in `gpu.submit` — lives in the SDK as a black box.
//
// Architecture
// ------------
// * Widgets are immutable description objects (`{ kind, ...props }`), like
//   Flutter `Widget`s. Constructors (`FilledButton`, `Switch`, `Column`, ...)
//   just build them.
// * A *component* is a plain function `(props, update) => widget`, React-style.
//   You turn one into a widget constructor with `defineComponent(fn)` and then
//   instantiate it in the tree like a Flutter widget — `Tile({ ... })`, no
//   wrapper — so the runtime owns its identity. Each mounted component gets its
//   own `update`; calling it re-runs **only that component** and re-submits.
// * The runtime keeps a retained tree. A full render mounts it (running every
//   component fn), measures, paints, and caches each node's painted output
//   (`_out`, plus hit regions). `update()` re-runs just its component's fn,
//   repaints that subtree at its cached box, and reassembles the frame from the
//   *cached* output of every other component (no parents, no siblings re-run) —
//   then `gpu.submit`s. The app supplies no coordinates and no draw calls.
//
// Per-instance data (16 floats): center.xy, halfSize.xy, cornerRadius,
// borderWidth, rotation, feather, fill rgba, border rgba.

// ----------------------------------------------------------------- shader -----
let _WGSL = "
struct Globals { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> g: Globals;

struct In {
    @location(0) a: vec4<f32>,
    @location(1) b: vec4<f32>,
    @location(2) fill: vec4<f32>,
    @location(3) bcol: vec4<f32>,
};
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) p: vec2<f32>,
    @location(1) @interpolate(flat) half: vec2<f32>,
    @location(2) @interpolate(flat) params: vec2<f32>,
    @location(3) @interpolate(flat) fill: vec4<f32>,
    @location(4) @interpolate(flat) bcol: vec4<f32>,
    @location(5) @interpolate(flat) feather: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, in: In) -> Out {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let half = in.a.zw;
    let local = corners[vi] * half;
    let rot = in.b.z;
    let cr = cos(rot);
    let sr = sin(rot);
    let rotated = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
    let world = in.a.xy + rotated;
    let ndc = vec2<f32>(world.x / g.viewport.x * 2.0 - 1.0, 1.0 - world.y / g.viewport.y * 2.0);
    var o: Out;
    o.clip = vec4<f32>(ndc, 0.0, 1.0);
    o.p = local;
    o.half = half;
    o.params = in.b.xy;
    o.fill = in.fill;
    o.bcol = in.bcol;
    o.feather = in.b.w;
    return o;
}

fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
    let r = min(o.params.x, min(o.half.x, o.half.y));
    let d = sd_round_box(o.p, o.half, r);
    let f = max(o.feather, 0.75);
    let cov = clamp(0.5 - d / f, 0.0, 1.0);
    let inner = d + o.params.y;
    let icov = clamp(0.5 - inner / f, 0.0, 1.0);
    let col = mix(o.bcol, o.fill, icov);
    return vec4<f32>(col.rgb, col.a * cov);
}
";

function _pipelineResources() {
    return [
        { kind: "shader", id: "elpa.m3.shader", wgsl: _WGSL },
        { kind: "bindGroupLayout", id: "elpa.m3.bgl",
          entries: [{ binding: 0, visibility: ["VERTEX"], ty: "uniform" }] },
        { kind: "pipelineLayout", id: "elpa.m3.layout", bind_group_layouts: ["elpa.m3.bgl"] },
        { kind: "renderPipeline", id: "elpa.m3.pipe", layout: "elpa.m3.layout",
          vertex: { module: "elpa.m3.shader", entry_point: "vs", buffers: [{
              array_stride: 64, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 }] }] },
          fragment: { module: "elpa.m3.shader", entry_point: "fs", targets: [{
              format: "bgra8unorm",
              blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                       alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
    ];
}

// ------------------------------------------------------------ glyph font ------
// A vector stroke font: each glyph is line segments [x0,y0,x1,y1] in a 4-wide ×
// 6-tall box (origin top-left, y down), drawn as overlapping rounded capsules.
let _GLYPHS = {
    A: [[0.2,6.0,2.0,0.2],[2.0,0.2,3.8,6.0],[0.95,3.8,3.05,3.8]],
    B: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.6,0.0],[2.6,0.0,3.5,1.5],[3.5,1.5,2.6,3.0],[0.3,3.0,2.6,3.0],[2.6,3.0,3.7,4.5],[3.7,4.5,2.6,6.0],[0.3,6.0,2.6,6.0]],
    C: [[3.6,1.3,2.5,0.2],[2.5,0.2,1.2,0.5],[1.2,0.5,0.3,2.0],[0.3,2.0,0.3,4.0],[0.3,4.0,1.2,5.5],[1.2,5.5,2.5,5.8],[2.5,5.8,3.6,4.7]],
    E: [[0.3,0.0,0.3,6.0],[0.3,0.0,3.6,0.0],[0.3,3.0,2.9,3.0],[0.3,6.0,3.6,6.0]],
    F: [[0.3,0.0,0.3,6.0],[0.3,0.0,3.6,0.0],[0.3,3.0,2.9,3.0]],
    G: [[3.6,1.3,2.5,0.2],[2.5,0.2,1.2,0.5],[1.2,0.5,0.3,2.0],[0.3,2.0,0.3,4.0],[0.3,4.0,1.2,5.5],[1.2,5.5,2.5,5.8],[2.5,5.8,3.6,4.8],[3.6,4.8,3.6,3.4],[2.4,3.4,3.6,3.4]],
    H: [[0.3,0.0,0.3,6.0],[3.7,0.0,3.7,6.0],[0.3,3.0,3.7,3.0]],
    I: [[1.0,0.0,3.0,0.0],[2.0,0.0,2.0,6.0],[1.0,6.0,3.0,6.0]],
    K: [[0.3,0.0,0.3,6.0],[0.3,3.4,3.6,0.0],[1.3,2.4,3.8,6.0]],
    L: [[0.3,0.0,0.3,6.0],[0.3,6.0,3.6,6.0]],
    M: [[0.2,6.0,0.2,0.0],[0.2,0.0,2.0,3.2],[2.0,3.2,3.8,0.0],[3.8,0.0,3.8,6.0]],
    N: [[0.3,6.0,0.3,0.0],[0.3,0.0,3.7,6.0],[3.7,6.0,3.7,0.0]],
    O: [[1.3,0.3,2.7,0.3],[2.7,0.3,3.7,1.6],[3.7,1.6,3.7,4.4],[3.7,4.4,2.7,5.7],[2.7,5.7,1.3,5.7],[1.3,5.7,0.3,4.4],[0.3,4.4,0.3,1.6],[0.3,1.6,1.3,0.3]],
    P: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.7,0.0],[2.7,0.0,3.6,1.5],[3.6,1.5,2.7,3.0],[0.3,3.0,2.7,3.0]],
    R: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.7,0.0],[2.7,0.0,3.6,1.5],[3.6,1.5,2.7,3.0],[0.3,3.0,2.7,3.0],[1.6,3.0,3.8,6.0]],
    S: [[3.5,1.2,2.4,0.3],[2.4,0.3,1.1,0.6],[1.1,0.6,0.5,1.8],[0.5,1.8,1.7,2.8],[1.7,2.8,2.6,3.3],[2.6,3.3,3.5,4.4],[3.5,4.4,2.8,5.5],[2.8,5.5,1.5,5.8],[1.5,5.8,0.4,4.9]],
    T: [[0.2,0.0,3.8,0.0],[2.0,0.0,2.0,6.0]],
    U: [[0.3,0.0,0.3,4.4],[0.3,4.4,1.4,5.7],[1.4,5.7,2.6,5.7],[2.6,5.7,3.7,4.4],[3.7,4.4,3.7,0.0]],
    V: [[0.2,0.0,2.0,6.0],[2.0,6.0,3.8,0.0]],
    W: [[0.1,0.0,1.0,6.0],[1.0,6.0,2.0,2.2],[2.0,2.2,3.0,6.0],[3.0,6.0,3.9,0.0]],
    D: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.3,0.3],[2.3,0.3,3.6,2.0],[3.6,2.0,3.6,4.0],[3.6,4.0,2.3,5.7],[2.3,5.7,0.3,6.0]],
    J: [[3.2,0.0,3.2,4.4],[3.2,4.4,2.2,5.8],[2.2,5.8,1.0,5.3],[1.0,5.3,0.6,4.2]],
    Q: [[1.3,0.3,2.7,0.3],[2.7,0.3,3.7,1.6],[3.7,1.6,3.7,4.4],[3.7,4.4,2.7,5.7],[2.7,5.7,1.3,5.7],[1.3,5.7,0.3,4.4],[0.3,4.4,0.3,1.6],[0.3,1.6,1.3,0.3],[2.4,4.4,3.8,6.2]],
    X: [[0.3,0.0,3.7,6.0],[3.7,0.0,0.3,6.0]],
    Y: [[0.3,0.0,2.0,3.0],[3.7,0.0,2.0,3.0],[2.0,3.0,2.0,6.0]],
    Z: [[0.3,0.0,3.7,0.0],[3.7,0.0,0.3,6.0],[0.3,6.0,3.7,6.0]],
    "0": [[1.3,0.3,2.7,0.3],[2.7,0.3,3.6,1.8],[3.6,1.8,3.6,4.2],[3.6,4.2,2.7,5.7],[2.7,5.7,1.3,5.7],[1.3,5.7,0.4,4.2],[0.4,4.2,0.4,1.8],[0.4,1.8,1.3,0.3],[0.9,4.8,3.1,1.2]],
    "1": [[1.2,1.2,2.0,0.2],[2.0,0.2,2.0,6.0],[1.0,6.0,3.0,6.0]],
    "2": [[0.4,1.4,1.5,0.3],[1.5,0.3,2.8,0.6],[2.8,0.6,3.2,2.0],[3.2,2.0,0.5,6.0],[0.5,6.0,3.7,6.0]],
    "3": [[0.4,0.8,2.2,0.2],[2.2,0.2,3.4,1.4],[3.4,1.4,2.0,3.0],[2.0,3.0,3.5,4.4],[3.5,4.4,2.3,5.8],[2.3,5.8,0.5,5.2]],
    "4": [[2.9,0.0,0.4,4.0],[0.4,4.0,3.7,4.0],[2.9,1.5,2.9,6.0]],
    "5": [[3.4,0.2,0.7,0.2],[0.7,0.2,0.5,2.8],[0.5,2.8,2.3,2.4],[2.3,2.4,3.5,3.6],[3.5,3.6,2.6,5.7],[2.6,5.7,0.5,5.2]],
    "6": [[3.3,0.6,2.0,0.2],[2.0,0.2,0.6,2.2],[0.6,2.2,0.5,4.6],[0.5,4.6,1.7,5.8],[1.7,5.8,3.2,4.9],[3.2,4.9,2.2,3.3],[2.2,3.3,0.7,3.8]],
    "7": [[0.3,0.2,3.7,0.2],[3.7,0.2,1.6,6.0]],
    "8": [[1.9,0.2,3.2,1.3],[3.2,1.3,1.9,2.9],[1.9,2.9,0.7,1.3],[0.7,1.3,1.9,0.2],[1.9,2.9,3.4,4.3],[3.4,4.3,1.9,5.8],[1.9,5.8,0.5,4.3],[0.5,4.3,1.9,2.9]],
    "9": [[3.3,2.7,1.8,3.0],[1.8,3.0,0.6,1.6],[0.6,1.6,1.9,0.2],[1.9,0.2,3.3,1.4],[3.3,1.4,3.3,3.8],[3.3,3.8,2.1,5.8]],
    ".": [[1.85,5.55,2.15,5.85]],
    ",": [[2.1,5.3,1.6,6.4]],
    ":": [[1.85,2.0,2.15,2.3],[1.85,4.4,2.15,4.7]],
    "/": [[3.4,0.2,0.6,6.0]],
    "+": [[2.0,1.6,2.0,4.4],[0.6,3.0,3.4,3.0]],
    "%": [[3.4,0.4,0.6,5.6],[0.8,0.5,1.6,1.3],[2.4,4.7,3.2,5.5]],
    "!": [[2.0,0.2,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "?": [[0.6,1.4,1.9,0.3],[1.9,0.3,3.2,1.4],[3.2,1.4,2.0,3.0],[2.0,3.0,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "$": [[3.3,1.1,2.2,0.4],[2.2,0.4,1.0,0.8],[1.0,0.8,0.7,1.9],[0.7,1.9,1.8,2.7],[1.8,2.7,2.6,3.2],[2.6,3.2,3.4,4.2],[3.4,4.2,2.6,5.4],[2.6,5.4,1.4,5.7],[1.4,5.7,0.5,4.8],[2.0,-0.4,2.0,6.4]],
    "#": [[1.3,0.2,0.8,5.8],[3.0,0.2,2.5,5.8],[0.4,2.1,3.6,2.1],[0.4,3.9,3.6,3.9]],
    " ": [],
};

// ----------------------------------------------------------- runtime state ----
let _vw = 1.0; let _vh = 1.0; let _u = 1.0;   // viewport + 1% unit
let _root = 0;                                 // root component node
let _NULL = { kind: "null" };                  // tree-root sentinel parent
let _curOut = []; let _curTaps = []; let _curDrags = [];  // paint targets
let _inst = []; let _taps = []; let _drags = [];          // current frame (root)
let _dragging = 0.0; let _activeDrag = 0;      // active slider drag
let _hx = -1000.0; let _hy = -1000.0;          // hover pointer
let _keyHandler = 0; let _hasKey = 0.0;        // app key handler (per render)
let _wheelFn = 0; let _hasWheel = 0.0;         // app wheel handler (per render)
let _focused = 0;                              // id of the focused TextField (0 = none)
let _focusInput = 0; let _hasFocusInput = 0.0; // focused field's key handler (per render)
let _scroll = {};                              // scroll offset (px) per scrollable id
let _listRegions = {};                         // last painted scroll viewport per id
let _scrollDragOn = 0.0; let _scrollDragId = ""; let _scrollDragY = 0.0;  // touch scroll
let _scrollVel = 0.0;                          // smoothed drag velocity (px/frame)
let _flingId = ""; let _flingV = 0.0;          // active momentum fling (id + velocity)
let _darkTarget = 0.0; let _darkAnim = 0.0;    // theme
let _accent = 0;                               // accent index
let _anim = {}; let _target = {};              // eased 0..1 values by key
let _press = {};                               // press state layers by key
let _paintingComp = 0;                         // component currently being painted
let _keySubs = {};                             // animation key -> subscriber component
let _layered = 0.0;                            // split static/dynamic instance layers
let _animatingComps = [];                      // components animating this frame (layered mode)
let _WHITE = [1.0, 1.0, 1.0, 1.0];
let _CLEAR = [0.0, 0.0, 0.0, 0.0];

// M3 tonal accent palette (primary tone for light / dark schemes): purple (the
// M3 default), teal, green, pink — the hues ColorScheme.fromSeed yields.
let _accLight = [[0.404,0.314,0.643],[0.000,0.416,0.416],[0.220,0.416,0.125],[0.596,0.251,0.380]];
let _accDark  = [[0.816,0.737,1.000],[0.306,0.847,0.859],[0.616,0.839,0.490],[1.000,0.694,0.784]];

// -------------------------------------------------------------- public API ----
// Push the app's theme into the framework (call from the root builder each
// build, like reading ThemeData from MaterialApp).
function setTheme(darkTarget, accent) { _darkTarget = darkTarget; _accent = accent; }

// Opt into layered rendering: while widgets animate, the instances of the
// *non-animating* widgets are uploaded as a separate "static" buffer whose
// contents don't change frame to frame, so the renderer's resource cache skips
// re-uploading it (and only the small "dynamic" buffer of the animating widgets
// is rewritten in place). The visible result is identical for this app's
// non-overlapping layout; it is opt-in because pulling animating widgets to the
// end of the draw order could reorder alpha-blending where widgets overlap.
function setLayered(on) { _layered = on; }

// Place a component function in the tree (the runtime's element node). `fn` is a
// plain function `(props, update) => widget`; the runtime owns its identity, so
// its `update` repaints only it. This is an internal detail: app code never
// calls it — it wraps its component functions with `defineComponent` and then
// instantiates them like Flutter widgets (see below).
function Component(fn, props) { return { kind: "comp", fn: fn, props: props }; }

// Turn a component function `(props, update) => widget` into a widget
// constructor — the Flutter analog of declaring a `StatelessWidget` /
// `StatefulWidget` class. The result is called like any built-in widget,
// `Tile({ label: "WI-FI", child: ... })`, and yields a tree node the runtime
// mounts with its own identity and `update`. No `Component(...)` wrapper is
// needed at the call site: a defined component nests in another component's tree
// exactly like `Switch`, `Row`, or `Card` do, so custom widgets compose just
// like the built-ins. Each call captures its own `fn`, so distinct components
// stay distinct.
function defineComponent(fn) { return (props) => Component(fn, props); }

// Mount the root component (a `defineComponent` constructor) and paint the first
// frame — the analog of Flutter's `runApp(MyApp())`.
function runApp(root) { _root = root({}); _renderApp(); }

// ---- Platform services (capability-gated host interfaces) --------------------
// Thin app-facing wrappers over Elpa's `askHost` seam: the clock, the fabricated
// filesystem (native disk or browser storage), synchronous HTTP, and randomness.
// Each is gated by a host capability/toggle; when one is unplugged the call
// short-circuits to a typed null, so these wrappers degrade gracefully (return
// "", 0, or report status 0) instead of trapping — letting an app probe what the
// platform actually grants without crashing.
function _ok(r) { if (isNull(r)) { return 0.0; } if (has(r, "ok")) { if (r.ok) { return 1.0; } } return 0.0; }
// Wall-clock / monotonic milliseconds (0 when the clock is unplugged).
function now() { let r = askHost("time.now", []); if (isNull(r)) { return 0; } if (has(r, "ms")) { return r.ms; } return 0; }
// Persistent storage over the fabricated filesystem (same virtual FS on web and
// native). Paths are POSIX-like ("/state/count"). Reads return "" when absent.
function storeWrite(path, data) { return _ok(askHost("fs.write", [{ path: path, data: data }])); }
function storeRead(path) { let r = askHost("fs.read", [{ path: path }]); if (isNull(r)) { return ""; } if (has(r, "data")) { return r.data; } return ""; }
function storeExists(path) { let r = askHost("fs.exists", [{ path: path }]); if (isNull(r)) { return 0.0; } if (has(r, "exists")) { if (r.exists) { return 1.0; } } return 0.0; }
function storeList(path) { let r = askHost("fs.list", [{ path: path }]); if (isNull(r)) { return []; } if (has(r, "entries")) { return r.entries; } return []; }
function storeDelete(path) { return _ok(askHost("fs.delete", [{ path: path }])); }
// Synchronous HTTP. `onDone(status, body)`; status 0 means the request could not
// be made (network capability not provisioned, or the host denied it).
function httpGet(url, onDone) { _httpReq("GET", url, 0, onDone); }
function httpPost(url, body, onDone) { _httpReq("POST", url, body, onDone); }
function _httpReq(method, url, body, onDone) {
    let req = { method: method, url: url };
    if (typeOf(body) == "string") { req.body = body; }
    let r = askHost("net.fetch", [req]);
    if (isNull(r)) { onDone(0, ""); return 0; }
    if (has(r, "ok")) { if (!r.ok) { onDone(0, ""); return 0; } }
    let st = 0; if (has(r, "status")) { st = r.status; }
    let bd = ""; if (has(r, "body")) { bd = r.body; }
    onDone(st, bd);
    return 0;
}
// Random unit float in [0,1) (0 when randomness is unplugged).
function randomUnit() { let r = askHost("random.next", []); if (isNull(r)) { return 0.0; } if (has(r, "value")) { return r.value; } return 0.0; }

function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
function sel(a, b) { if (a == b) { return 1.0; } return 0.0; }

// Widget constructors — immutable description objects.
function Scaffold(p) { p.kind = "scaffold"; return p; }
function AppBar(p) { p.kind = "appBar"; return p; }
function Card(p) { p.kind = "card"; return p; }
function Column(p) { p.kind = "column"; return p; }
function Row(p) { p.kind = "row"; return p; }
function Text(t, opt) { opt.kind = "text"; opt.text = t; return opt; }
function FilledButton(p) { p.kind = "filledButton"; if (!has(p, "id")) { p.id = p.label; } return p; }
function OutlinedButton(p) { p.kind = "outlinedButton"; if (!has(p, "id")) { p.id = p.label; } return p; }
function Fab(p) { p.kind = "fab"; return p; }
function Switch(p) { p.kind = "switch"; return p; }
function Checkbox(p) { p.kind = "checkbox"; return p; }
function Radio(p) { p.kind = "radio"; return p; }
function Slider(p) { p.kind = "slider"; return p; }
function Chip(p) { p.kind = "chip"; return p; }
function Progress(p) { p.kind = "progress"; if (!has(p, "id")) { p.id = "progress"; } return p; }
function Divider(p) { p.kind = "divider"; return p; }

// ---- Layout widgets (Flutter's box model) ------------------------------------
// A decorated box: optional fixed width/height, padding, fill, border, radius.
function Container(p) { p.kind = "container"; return p; }
function Padding(p) { p.kind = "padding"; return p; }
function Center(p) { p.kind = "center"; return p; }
function Align(p) { p.kind = "align"; return p; }
function SizedBox(p) { p.kind = "sizedBox"; return p; }
function Spacer(p) { p.kind = "sizedBox"; if (!has(p, "width")) { p.width = 0.0; } if (!has(p, "height")) { p.height = 0.0; } return p; }
function Expanded(p) { p.kind = "expanded"; if (!has(p, "flex")) { p.flex = 1.0; } return p; }
function Flexible(p) { p.kind = "expanded"; if (!has(p, "flex")) { p.flex = 1.0; } return p; }
function Stack(p) { p.kind = "stack"; return p; }
function Positioned(p) { p.kind = "positioned"; return p; }
function Wrap(p) { p.kind = "wrap"; return p; }
function ListView(p) { p.kind = "listView"; if (!has(p, "id")) { p.id = "list"; } return p; }
function GridView(p) { p.kind = "gridView"; if (!has(p, "id")) { p.id = "grid"; } if (!has(p, "cols")) { p.cols = 2; } return p; }

// ---- Material / content widgets ----------------------------------------------
function Icon(p) { p.kind = "icon"; return p; }
function IconButton(p) { p.kind = "iconButton"; if (!has(p, "id")) { p.id = p.icon; } return p; }
function Avatar(p) { p.kind = "avatar"; return p; }
function Badge(p) { p.kind = "badge"; return p; }
function ListTile(p) { p.kind = "listTile"; if (!has(p, "id")) { p.id = p.title; } return p; }
function TextField(p) { p.kind = "textField"; if (!has(p, "value")) { p.value = ""; } if (!has(p, "id")) { p.id = "field"; } return p; }
function Tabs(p) { p.kind = "tabs"; if (!has(p, "id")) { p.id = "tabs"; } return p; }
function NavigationBar(p) { p.kind = "navBar"; return p; }
function SegmentedButton(p) { p.kind = "segmented"; return p; }
function CircularProgress(p) { p.kind = "circularProgress"; if (!has(p, "id")) { p.id = "circular"; } return p; }
function ExpansionTile(p) { p.kind = "expansionTile"; if (!has(p, "id")) { p.id = p.title; } return p; }
function Snackbar(p) { p.kind = "snackbar"; return p; }
function Dialog(p) { p.kind = "dialog"; return p; }
function Drawer(p) { p.kind = "drawer"; if (!has(p, "id")) { p.id = "drawer"; } return p; }
function Banner(p) { p.kind = "banner"; return p; }
function DataTable(p) { p.kind = "dataTable"; return p; }

// ---- Media / charts ----------------------------------------------------------
function Image(p) { p.kind = "image"; return p; }
function VideoPlayer(p) { p.kind = "video"; if (!has(p, "id")) { p.id = "video"; } return p; }
function BarChart(p) { p.kind = "barChart"; return p; }
function LineChart(p) { p.kind = "lineChart"; return p; }
function PieChart(p) { p.kind = "pieChart"; return p; }
function Sparkline(p) { p.kind = "sparkline"; return p; }

// EdgeInsets-style padding in `_u` units. Reads `pad` (all sides), `padX`/`padY`
// (axis), or the per-side `padL`/`padR`/`padT`/`padB`; missing sides are 0.
function _padOf(node) {
    let l = 0.0; let r = 0.0; let t = 0.0; let b = 0.0;
    if (has(node, "pad")) { l = node.pad; r = node.pad; t = node.pad; b = node.pad; }
    if (has(node, "padX")) { l = node.padX; r = node.padX; }
    if (has(node, "padY")) { t = node.padY; b = node.padY; }
    if (has(node, "padL")) { l = node.padL; }
    if (has(node, "padR")) { r = node.padR; }
    if (has(node, "padT")) { t = node.padT; }
    if (has(node, "padB")) { b = node.padB; }
    return { l: l * _u, r: r * _u, t: t * _u, b: b * _u };
}

// --------------------------------------------------------- color system -------
function _mix(l, d) { return l * (1.0 - _darkAnim) + d * _darkAnim; }
function _colorBg() { return [_mix(0.984,0.078), _mix(0.969,0.071), _mix(0.996,0.094)]; }
function _surfaceContainer(a) { return [_mix(0.957,0.129), _mix(0.937,0.122), _mix(0.969,0.149), a]; }
function _surfaceHighest(a) { return [_mix(0.902,0.212), _mix(0.878,0.204), _mix(0.914,0.231), a]; }
function _onSurface(a) { return [_mix(0.114,0.902), _mix(0.106,0.878), _mix(0.125,0.914), a]; }
function _outline(a) { return [_mix(0.475,0.576), _mix(0.455,0.561), _mix(0.494,0.600), a]; }
function _outlineVar(a) { return [_mix(0.792,0.286), _mix(0.769,0.271), _mix(0.816,0.310), a]; }
function _accCh(i) { return _accLight[_accent][i] * (1.0 - _darkAnim) + _accDark[_accent][i] * _darkAnim; }
function _acc(a) { return [_accCh(0), _accCh(1), _accCh(2), a]; }
function _onAcc(a) { return [_mix(1.0,0.118), _mix(1.0,0.110), _mix(1.0,0.137), a]; }
function _mixCol(c0, c1, t) {
    return [c0[0]+(c1[0]-c0[0])*t, c0[1]+(c1[1]-c0[1])*t, c0[2]+(c1[2]-c0[2])*t, c0[3]+(c1[3]-c0[3])*t];
}
function _brighten(col, amt) { return [col[0]+amt, col[1]+amt, col[2]+amt, col[3]]; }

// --------------------------------------------------------- primitive emit -----
// Emit into the current node's buffers (_curOut/_curTaps/_curDrags).
function _rect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
    push(_curOut, cx); push(_curOut, cy); push(_curOut, hw); push(_curOut, hh);
    push(_curOut, r); push(_curOut, border); push(_curOut, rot); push(_curOut, 1.0);
    push(_curOut, fill[0]); push(_curOut, fill[1]); push(_curOut, fill[2]); push(_curOut, fill[3]);
    push(_curOut, bcol[0]); push(_curOut, bcol[1]); push(_curOut, bcol[2]); push(_curOut, bcol[3]);
}
function _shadow(cx, cy, hw, hh, r, grow, drop, blur) {
    push(_curOut, cx); push(_curOut, cy + drop); push(_curOut, hw + grow); push(_curOut, hh + grow);
    push(_curOut, r + grow); push(_curOut, 0.0); push(_curOut, 0.0); push(_curOut, blur);
    push(_curOut, 0.0); push(_curOut, 0.0); push(_curOut, 0.0); push(_curOut, 0.28);
    push(_curOut, 0.0); push(_curOut, 0.0); push(_curOut, 0.0); push(_curOut, 0.0);
}
function _paintText(str, cx, cy, cell, col) {
    str = upper(str);
    let nch = len(str); let adv = 5.0; let th = 0.92;
    for (let ci = 0; ci < nch; ci++) {
        let ch = charAt(str, ci);
        if (has(_GLYPHS, ch)) {
            let segs = _GLYPHS[ch];
            let gc = (ci - (nch - 1.0) / 2.0) * adv;
            for (let si = 0; si < len(segs); si++) {
                let s = segs[si];
                let ax = gc - 2.0 + s[0]; let ay = s[1] - 3.0;
                let bx = gc - 2.0 + s[2]; let by = s[3] - 3.0;
                let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
                _rect(cx + cell * (ax + bx) / 2.0, cy + cell * (ay + by) / 2.0,
                      cell * ln / 2.0, cell * th / 2.0, cell * th / 2.0, 0.0, atan2(dy, dx), col, _CLEAR);
            }
        }
    }
}
function _addTap(cx, cy, hw, hh, id, onTap) { push(_curTaps, { cx: cx, cy: cy, hw: hw, hh: hh, id: id, onTap: onTap }); }
function _addDrag(cx, cy, hw, hh, onChanged, left, width) {
    push(_curDrags, { cx: cx, cy: cy, hw: hw, hh: hh,
        onDrag: (px) => { onChanged(clamp01((px - left) / width)); } });
}
function _registerWheel(onChanged, val) { _wheelFn = (dy) => { onChanged(clamp01(val + dy * (-0.0015))); }; _hasWheel = 1.0; }

// A stroked line as a rounded capsule between (ax,ay) and (bx,by), `thick` wide.
function _seg(ax, ay, bx, by, thick, col) {
    let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
    _rect((ax + bx) / 2.0, (ay + by) / 2.0, ln / 2.0 + thick / 2.0, thick / 2.0, thick / 2.0, 0.0, atan2(dy, dx), col, _CLEAR);
}
function _disc(cx, cy, r, col) { _rect(cx, cy, r, r, r, 0.0, 0.0, col, _CLEAR); }
function _ring(cx, cy, r, w, col) { _rect(cx, cy, r, r, r, w, 0.0, _CLEAR, col); }

// A tiny vector icon set: each icon is drawn from capsules/discs/rings inside a
// box of half-extent `r` centered at (cx,cy). Unknown names fall back to a dot.
function _icon(name, cx, cy, r, col) {
    let t = r * 0.26;
    if (name == "add") { _seg(cx - r * 0.62, cy, cx + r * 0.62, cy, t, col); _seg(cx, cy - r * 0.62, cx, cy + r * 0.62, t, col); return 0; }
    if (name == "close") { _seg(cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5, t, col); _seg(cx - r * 0.5, cy + r * 0.5, cx + r * 0.5, cy - r * 0.5, t, col); return 0; }
    if (name == "check") { _seg(cx - r * 0.55, cy + r * 0.05, cx - r * 0.12, cy + r * 0.5, t, col); _seg(cx - r * 0.12, cy + r * 0.5, cx + r * 0.6, cy - r * 0.45, t, col); return 0; }
    if (name == "menu") { _seg(cx - r * 0.6, cy - r * 0.45, cx + r * 0.6, cy - r * 0.45, t, col); _seg(cx - r * 0.6, cy, cx + r * 0.6, cy, t, col); _seg(cx - r * 0.6, cy + r * 0.45, cx + r * 0.6, cy + r * 0.45, t, col); return 0; }
    if (name == "back") { _seg(cx + r * 0.5, cy, cx - r * 0.5, cy, t, col); _seg(cx - r * 0.5, cy, cx, cy - r * 0.45, t, col); _seg(cx - r * 0.5, cy, cx, cy + r * 0.45, t, col); return 0; }
    if (name == "search") { _ring(cx - r * 0.15, cy - r * 0.15, r * 0.45, t * 0.8, col); _seg(cx + r * 0.2, cy + r * 0.2, cx + r * 0.62, cy + r * 0.62, t, col); return 0; }
    if (name == "settings") { _ring(cx, cy, r * 0.4, t * 0.8, col); for (let i = 0; i < 8; i++) { let a = i * 0.785; _seg(cx + cos(a) * r * 0.5, cy + sin(a) * r * 0.5, cx + cos(a) * r * 0.78, cy + sin(a) * r * 0.78, t * 0.9, col); } return 0; }
    if (name == "home") { _seg(cx - r * 0.6, cy - r * 0.05, cx, cy - r * 0.6, t, col); _seg(cx, cy - r * 0.6, cx + r * 0.6, cy - r * 0.05, t, col); _seg(cx - r * 0.42, cy - r * 0.1, cx - r * 0.42, cy + r * 0.55, t, col); _seg(cx + r * 0.42, cy - r * 0.1, cx + r * 0.42, cy + r * 0.55, t, col); _seg(cx - r * 0.42, cy + r * 0.55, cx + r * 0.42, cy + r * 0.55, t, col); return 0; }
    if (name == "heart") { _disc(cx - r * 0.28, cy - r * 0.18, r * 0.32, col); _disc(cx + r * 0.28, cy - r * 0.18, r * 0.32, col); _rect(cx, cy + r * 0.12, r * 0.42, r * 0.42, r * 0.12, 0.0, 0.785, col, _CLEAR); return 0; }
    if (name == "star") { for (let i = 0; i < 5; i++) { let a = i * 1.2566 - 1.5708; _seg(cx, cy, cx + cos(a) * r * 0.75, cy + sin(a) * r * 0.75, t * 1.4, col); } return 0; }
    if (name == "play") { _seg(cx - r * 0.3, cy - r * 0.5, cx + r * 0.55, cy, t, col); _seg(cx + r * 0.55, cy, cx - r * 0.3, cy + r * 0.5, t, col); _seg(cx - r * 0.3, cy - r * 0.5, cx - r * 0.3, cy + r * 0.5, t, col); return 0; }
    if (name == "pause") { _rect(cx - r * 0.3, cy, t * 1.1, r * 0.55, t * 0.4, 0.0, 0.0, col, _CLEAR); _rect(cx + r * 0.3, cy, t * 1.1, r * 0.55, t * 0.4, 0.0, 0.0, col, _CLEAR); return 0; }
    if (name == "person") { _disc(cx, cy - r * 0.35, r * 0.34, col); _rect(cx, cy + r * 0.45, r * 0.5, r * 0.32, r * 0.3, 0.0, 0.0, col, _CLEAR); return 0; }
    if (name == "bell") { _disc(cx, cy + r * 0.55, t * 0.8, col); _seg(cx - r * 0.42, cy + r * 0.25, cx + r * 0.42, cy + r * 0.25, t, col); _seg(cx - r * 0.42, cy + r * 0.25, cx - r * 0.32, cy - r * 0.35, t, col); _seg(cx + r * 0.42, cy + r * 0.25, cx + r * 0.32, cy - r * 0.35, t, col); _seg(cx - r * 0.32, cy - r * 0.35, cx + r * 0.32, cy - r * 0.35, t, col); return 0; }
    if (name == "image") { _ring(cx, cy, r * 0.7, t * 0.7, col); _disc(cx + r * 0.28, cy - r * 0.28, r * 0.16, col); _seg(cx - r * 0.55, cy + r * 0.45, cx - r * 0.1, cy - r * 0.05, t, col); _seg(cx - r * 0.1, cy - r * 0.05, cx + r * 0.55, cy + r * 0.45, t, col); return 0; }
    if (name == "chart") { _seg(cx - r * 0.6, cy + r * 0.55, cx - r * 0.6, cy + r * 0.05, t, col); _seg(cx - r * 0.15, cy + r * 0.55, cx - r * 0.15, cy - r * 0.3, t, col); _seg(cx + r * 0.3, cy + r * 0.55, cx + r * 0.3, cy - r * 0.55, t, col); _seg(cx - r * 0.75, cy + r * 0.6, cx + r * 0.65, cy + r * 0.6, t * 0.7, col); return 0; }
    if (name == "video") { _rect(cx - r * 0.15, cy, r * 0.5, r * 0.42, r * 0.14, 0.0, 0.0, _CLEAR, col); _ring(cx - r * 0.15, cy, r * 0.5, t * 0.5, col); _seg(cx + r * 0.42, cy - r * 0.3, cx + r * 0.7, cy - r * 0.45, t, col); _seg(cx + r * 0.42, cy + r * 0.3, cx + r * 0.7, cy + r * 0.45, t, col); _seg(cx + r * 0.7, cy - r * 0.45, cx + r * 0.7, cy + r * 0.45, t, col); return 0; }
    _disc(cx, cy, r * 0.5, col);
    return 0;
}

// ---------------------------------------------------------- sizing / cells ----
function _cell(size) {
    if (size == "headline") { return _u * 0.82; }
    if (size == "title") { return _u * 0.55; }
    if (size == "body") { return _u * 0.42; }
    if (size == "label") { return _u * 0.40; }
    if (size == "caption") { return _u * 0.32; }
    if (size == "micro") { return _u * 0.26; }
    return _u * 0.40;
}
function _textW(str, cell) { return len(str) * 5.0 * cell; }
function _btnW(label) { return _textW(label, _cell("label")) + _u * 8.0; }
function _chipW(label) { return _textW(label, _cell("caption")) + _u * 7.0; }
function _gapPx(node) { if (has(node, "gap")) { return node.gap * _u; } return _u * 2.0; }

function _hover(cx, cy, hw, hh) { if (_inRect(_hx, _hy, cx, cy, hw, hh)) { return 1.0; } return 0.0; }
// Reading a press/ease value records that the component currently being painted
// depends on that animation key, so the frame clock can later repaint *only* the
// components whose keys are still moving.
function _pressVal(id) { _keySubs[id] = _paintingComp; if (has(_press, id)) { return _press[id]; } return 0.0; }
function _ease(key, target) {
    _keySubs[key] = _paintingComp;
    _target[key] = target;
    if (has(_anim, key)) { return _anim[key]; }
    _anim[key] = target; return target;
}
function _inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}

// ------------------------------------------------------------- measure --------
function _iconR(node) { if (has(node, "size")) { return node.size * _u * 0.5; } return _u * 1.8; }
function _sizedOuter(node) {
    let m = { w: 0.0, h: 0.0 }; if (has(node, "child")) { m = _measure(node.child); }
    let w = m.w; let h = m.h;
    if (has(node, "width")) { w = node.width * _u; }
    if (has(node, "height")) { h = node.height * _u; }
    return { w: w, h: h };
}
function _measureStack(node) {
    let w = 0.0; let h = 0.0; let nc = len(node.children);
    for (let i = 0; i < nc; i++) { let m = _measure(node.children[i]); if (m.w > w) { w = m.w; } if (m.h > h) { h = m.h; } }
    if (has(node, "width")) { w = node.width * _u; }
    if (has(node, "height")) { h = node.height * _u; }
    return { w: w, h: h };
}
function _wrapMaxW(node) { if (has(node, "maxWidth")) { return node.maxWidth * _u; } return _u * 60.0; }
function _measureWrap(node) {
    let maxW = _wrapMaxW(node); let gap = _gapPx(node); let rg = gap; if (has(node, "runGap")) { rg = node.runGap * _u; }
    let nc = len(node.children); let x = 0.0; let rowH = 0.0; let totalH = 0.0;
    for (let i = 0; i < nc; i++) {
        let m = _measure(node.children[i]);
        if (x > 0.0) { if (x + gap + m.w > maxW) { totalH = totalH + rowH + rg; x = 0.0; rowH = 0.0; } }
        if (x > 0.0) { x = x + gap; }
        x = x + m.w;
        if (m.h > rowH) { rowH = m.h; }
    }
    return { w: maxW, h: totalH + rowH };
}
// Intrinsic size of a node by kind. `_measure` wraps this to honour a parent's
// forced allocation (`_fw`/`_fh`), so a `Container` placed in an `Expanded` slot
// or a `GridView` cell fills the box the parent gave it instead of collapsing to
// its (often zero) content size — the Flutter "tight constraints" behaviour.
function _measure(node) {
    let m = _measureKind(node);
    if (has(node, "_fw")) { if (node._fw >= 0.0) { m.w = node._fw; } }
    if (has(node, "_fh")) { if (node._fh >= 0.0) { m.h = node._fh; } }
    return m;
}
function _measureKind(node) {
    let k = node.kind;
    if (k == "comp") { return _measure(node._sub); }
    if (k == "text") { let c = _cell(node.size); return { w: _textW(node.text, c), h: 6.0 * c }; }
    if (k == "filledButton") { return { w: _btnW(node.label), h: _u * 5.5 }; }
    if (k == "outlinedButton") { return { w: _btnW(node.label), h: _u * 5.5 }; }
    if (k == "fab") { return { w: _u * 8.4, h: _u * 8.4 }; }
    if (k == "switch") { return { w: _u * 8.4, h: _u * 4.8 }; }
    if (k == "checkbox") { return { w: _u * 4.4, h: _u * 4.4 }; }
    if (k == "radio") { return { w: _u * 4.4, h: _u * 4.4 }; }
    if (k == "slider") { return { w: _u * 62.0, h: _u * 5.0 }; }
    if (k == "chip") { return { w: _chipW(node.label), h: _u * 4.2 }; }
    if (k == "progress") { return { w: _u * 62.0, h: _u * 2.0 }; }
    if (k == "divider") { return { w: _u * 62.0, h: _u * 0.4 }; }
    if (k == "column") { return _measureColumn(node); }
    if (k == "row") { return _measureRow(node); }
    if (k == "card") { let c = _measure(node.child); return { w: c.w + _u * 8.0, h: c.h + _u * 8.0 }; }
    if (k == "scaffold") { return { w: _vw, h: _vh }; }
    if (k == "container") {
        let cw = 0.0; let ch = 0.0;
        if (has(node, "child")) { let m = _measure(node.child); cw = m.w; ch = m.h; }
        let pad = _padOf(node); let w = cw + pad.l + pad.r; let h = ch + pad.t + pad.b;
        if (has(node, "width")) { w = node.width * _u; }
        if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "padding") {
        let m = { w: 0.0, h: 0.0 }; if (has(node, "child")) { m = _measure(node.child); }
        let pad = _padOf(node); return { w: m.w + pad.l + pad.r, h: m.h + pad.t + pad.b };
    }
    if (k == "center") { return _sizedOuter(node); }
    if (k == "align") { return _sizedOuter(node); }
    if (k == "sizedBox") { return _sizedOuter(node); }
    if (k == "expanded") { if (has(node, "child")) { return _measure(node.child); } return { w: 0.0, h: 0.0 }; }
    if (k == "positioned") { if (has(node, "child")) { return _measure(node.child); } return { w: 0.0, h: 0.0 }; }
    if (k == "stack") { return _measureStack(node); }
    if (k == "wrap") { return _measureWrap(node); }
    if (k == "listView") {
        let w = _u * 62.0; let h = _u * 40.0;
        if (has(node, "width")) { w = node.width * _u; }
        if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "gridView") {
        let w = _u * 62.0; let h = _u * 40.0;
        if (has(node, "width")) { w = node.width * _u; }
        if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "badge") { if (has(node, "child")) { return _measure(node.child); } return { w: _u * 4.0, h: _u * 4.0 }; }
    if (k == "expansionTile") {
        let hh = _u * 7.0; let w = _u * 50.0; if (has(node, "width")) { w = node.width * _u; }
        let h = hh;
        if (has(node, "expanded")) { if (node.expanded > 0.5) { if (has(node, "child")) {
            let m = _measure(node.child); h = hh + m.h + _u * 2.0; if (m.w + _u * 4.0 > w) { w = m.w + _u * 4.0; }
        } } }
        return { w: w, h: h };
    }
    if (k == "icon") { let r = _iconR(node); return { w: r * 2.0, h: r * 2.0 }; }
    if (k == "iconButton") { let r = _iconR(node); return { w: r * 2.0 + _u * 2.4, h: r * 2.0 + _u * 2.4 }; }
    if (k == "avatar") { let r = _u * 3.2; if (has(node, "radius")) { r = node.radius * _u; } return { w: r * 2.0, h: r * 2.0 }; }
    if (k == "listTile") { let w = _u * 56.0; if (has(node, "width")) { w = node.width * _u; } return { w: w, h: _u * 9.0 }; }
    if (k == "textField") { let w = _u * 50.0; if (has(node, "width")) { w = node.width * _u; } return { w: w, h: _u * 7.5 }; }
    if (k == "tabs") { return { w: len(node.tabs) * _u * 14.0, h: _u * 6.0 }; }
    if (k == "navBar") { return { w: len(node.items) * _u * 14.0, h: _u * 11.0 }; }
    if (k == "segmented") { return { w: len(node.segments) * _u * 13.0, h: _u * 5.5 }; }
    if (k == "circularProgress") { let r = _u * 4.0; if (has(node, "radius")) { r = node.radius * _u; } return { w: r * 2.0, h: r * 2.0 }; }
    if (k == "snackbar") { return { w: _u * 60.0, h: _u * 7.0 }; }
    if (k == "dialog") { return { w: _vw, h: _vh }; }
    if (k == "drawer") { return { w: _vw, h: _vh }; }
    if (k == "banner") { return { w: _u * 60.0, h: _u * 8.0 }; }
    if (k == "dataTable") {
        let cw = _u * 14.0; if (has(node, "colWidth")) { cw = node.colWidth * _u; }
        return { w: len(node.columns) * cw, h: _u * 5.0 * (len(node.rows) + 1) };
    }
    if (k == "image") {
        let w = _u * 30.0; let h = _u * 20.0;
        if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "video") {
        let w = _u * 60.0; let h = _u * 34.0;
        if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "barChart") {
        let w = _u * 60.0; let h = _u * 28.0;
        if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "lineChart") {
        let w = _u * 60.0; let h = _u * 28.0;
        if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    if (k == "pieChart") { let r = _u * 14.0; if (has(node, "radius")) { r = node.radius * _u; } return { w: r * 2.0, h: r * 2.0 }; }
    if (k == "sparkline") {
        let w = _u * 24.0; let h = _u * 6.0;
        if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
        return { w: w, h: h };
    }
    return { w: 0.0, h: 0.0 };
}
function _measureColumn(node) {
    let mw = 0.0; let h = 0.0; let nc = len(node.children); let gap = _gapPx(node);
    for (let i = 0; i < nc; i++) { let c = _measure(node.children[i]); if (c.w > mw) { mw = c.w; } h = h + c.h; }
    if (nc > 1) { h = h + gap * (nc - 1); }
    return { w: mw, h: h };
}
function _measureRow(node) {
    let w = 0.0; let mh = 0.0; let nc = len(node.children); let gap = _gapPx(node);
    for (let i = 0; i < nc; i++) { let c = _measure(node.children[i]); w = w + c.w; if (c.h > mh) { mh = c.h; } }
    if (nc > 1) { w = w + gap * (nc - 1); }
    return { w: w, h: mh };
}

// --------------------------------------------------------------- mount --------
// Build the retained tree: run every component fn, wire parents. Re-runnable on
// any subtree (partial update re-mounts just one component).
function _mkUpdate(node) { return () => { _partial(node); }; }
// Structural children of any node, in z-order — the single place that knows a
// widget's child layout, used by both `_mount` and tree reassembly. `comp` is
// handled separately (it runs its function to produce `_sub`).
function _structKids(node) {
    if (node.kind == "scaffold") {
        let a = [];
        if (has(node, "appBar")) { if (!isNull(node.appBar)) { push(a, node.appBar); } }
        if (has(node, "body")) { if (!isNull(node.body)) { push(a, node.body); } }
        if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { push(a, node.bottomBar); } }
        if (has(node, "fab")) { if (!isNull(node.fab)) { push(a, node.fab); } }
        if (has(node, "drawer")) { if (!isNull(node.drawer)) { push(a, node.drawer); } }
        if (has(node, "snackbar")) { if (!isNull(node.snackbar)) { push(a, node.snackbar); } }
        if (has(node, "dialog")) { if (!isNull(node.dialog)) { push(a, node.dialog); } }
        return a;
    }
    if (has(node, "children")) { return node.children; }
    if (has(node, "child")) { if (!isNull(node.child)) { return [node.child]; } }
    return [];
}
function _mount(node, parent) {
    node._parent = parent;
    if (node.kind == "comp") {
        if (!has(node, "_update")) { node._update = _mkUpdate(node); }
        node._sub = node.fn(node.props, node._update);
        _mount(node._sub, node);
        return 0;
    }
    let kids = _structKids(node);
    for (let i = 0; i < len(kids); i++) { _mount(kids[i], node); }
    return 0;
}

// --------------------------------------------------------------- paint --------
// Each node ends up with `_out` (its subtree's instances), `_taps`, `_drags`,
// and `_cx`/`_cy` (its center), so a later partial update can repaint it in place.
// Compose a node's final `_out`/`_taps`/`_drags` from its own decoration
// (`_self`), its laid-out children (`_kids`), and any on-top overlay (`_over`).
// Leaves (no kids) already hold their output in `_out`, so composing is a no-op.
// This single rule replaces per-kind reassembly, so a new container widget needs
// no edits here, in `_reassembleTree`, or in `_bucketLayers`.
function _compose(node) {
    if (node.kind == "comp") { node._out = node._sub._out; node._taps = node._sub._taps; node._drags = node._sub._drags; return 0; }
    // A leaf already holds its output in `_out` (and never got `_selfTaps` from
    // `_beginSelf`); a container composes `_self` + children + `_over`, even when
    // it has *no* (visible) children — otherwise its `_out` would stay unset and a
    // parent's `concat` over it would fault.
    if (!has(node, "_selfTaps")) { return 0; }
    let kids = node._kids;
    let o = concat([], node._self); let t = concat([], node._selfTaps); let d = concat([], node._selfDrags);
    for (let i = 0; i < len(kids); i++) { o = concat(o, kids[i]._out); t = concat(t, kids[i]._taps); d = concat(d, kids[i]._drags); }
    if (has(node, "_over")) { o = concat(o, node._over); }
    node._out = o; node._taps = t; node._drags = d;
    return 0;
}
// Start a container's own decoration buffers and point the emit cursor at them.
// Decoration drawn now lands *behind* the children painted next; anything pushed
// into `_over` lands on top of them (badges, scrollbars).
function _beginSelf(node) {
    node._self = []; node._selfTaps = []; node._selfDrags = []; node._over = [];
    _curOut = node._self; _curTaps = node._selfTaps; _curDrags = node._selfDrags;
}
function _paint(node, cx, cy) {
    node._cx = cx; node._cy = cy;
    let k = node.kind;
    if (k == "comp") {
        let prev = _paintingComp; _paintingComp = node;
        _paint(node._sub, cx, cy);
        _paintingComp = prev;
        node._kids = [node._sub]; _compose(node);
        return 0;
    }
    if (k == "column") { _paintColumn(node, cx, cy); return 0; }
    if (k == "row") { _paintRow(node, cx, cy); return 0; }
    if (k == "card") { _paintCard(node, cx, cy); return 0; }
    if (k == "scaffold") { _paintScaffold(node); return 0; }
    if (k == "container") { _paintContainer(node, cx, cy); return 0; }
    if (k == "padding") { _paintBox(node, cx, cy, _padOf(node)); return 0; }
    if (k == "center") { _paintCenter(node, cx, cy); return 0; }
    if (k == "align") { _paintAlign(node, cx, cy); return 0; }
    if (k == "sizedBox") { _paintCenter(node, cx, cy); return 0; }
    if (k == "expanded") { _paintCenter(node, cx, cy); return 0; }
    if (k == "positioned") { _paintCenter(node, cx, cy); return 0; }
    if (k == "stack") { _paintStack(node, cx, cy); return 0; }
    if (k == "wrap") { _paintWrap(node, cx, cy); return 0; }
    if (k == "listView") { _paintListView(node, cx, cy); return 0; }
    if (k == "gridView") { _paintGridView(node, cx, cy); return 0; }
    if (k == "badge") { _paintBadge(node, cx, cy); return 0; }
    if (k == "expansionTile") { _paintExpansion(node, cx, cy); return 0; }
    // Leaf: emit straight into this node's fresh buffers.
    node._out = []; node._taps = []; node._drags = [];
    node._self = node._out; node._kids = [];
    _curOut = node._out; _curTaps = node._taps; _curDrags = node._drags;
    if (k == "text") { _paintText(node.text, cx, cy, _cell(node.size), _textInk(node)); return 0; }
    if (k == "appBar") { _paintAppBar(node, cx, cy); return 0; }
    if (k == "filledButton") { _paintFilled(node, cx, cy); return 0; }
    if (k == "outlinedButton") { _paintOutlined(node, cx, cy); return 0; }
    if (k == "fab") { _paintFab(node, cx, cy); return 0; }
    if (k == "switch") { _paintSwitch(node, cx, cy); return 0; }
    if (k == "checkbox") { _paintCheckbox(node, cx, cy); return 0; }
    if (k == "radio") { _paintRadio(node, cx, cy); return 0; }
    if (k == "slider") { _paintSlider(node, cx, cy); return 0; }
    if (k == "chip") { _paintChip(node, cx, cy); return 0; }
    if (k == "progress") { _paintProgress(node, cx, cy); return 0; }
    if (k == "divider") { _paintDivider(node, cx, cy); return 0; }
    if (k == "icon") { _paintIcon(node, cx, cy); return 0; }
    if (k == "iconButton") { _paintIconButton(node, cx, cy); return 0; }
    if (k == "avatar") { _paintAvatar(node, cx, cy); return 0; }
    if (k == "listTile") { _paintListTile(node, cx, cy); return 0; }
    if (k == "textField") { _paintTextField(node, cx, cy); return 0; }
    if (k == "tabs") { _paintTabs(node, cx, cy); return 0; }
    if (k == "navBar") { _paintNavBar(node, cx, cy); return 0; }
    if (k == "segmented") { _paintSegmented(node, cx, cy); return 0; }
    if (k == "circularProgress") { _paintCircular(node, cx, cy); return 0; }
    if (k == "banner") { _paintBanner(node, cx, cy); return 0; }
    if (k == "snackbar") { _paintSnackbar(node, cx, cy); return 0; }
    if (k == "dialog") { _paintDialog(node, cx, cy); return 0; }
    if (k == "drawer") { _paintDrawer(node, cx, cy); return 0; }
    if (k == "dataTable") { _paintDataTable(node, cx, cy); return 0; }
    if (k == "image") { _paintImage(node, cx, cy); return 0; }
    if (k == "video") { _paintVideo(node, cx, cy); return 0; }
    if (k == "barChart") { _paintBarChart(node, cx, cy); return 0; }
    if (k == "lineChart") { _paintLineChart(node, cx, cy); return 0; }
    if (k == "pieChart") { _paintPieChart(node, cx, cy); return 0; }
    if (k == "sparkline") { _paintSparkline(node, cx, cy); return 0; }
    return 0;
}
function _textInk(node) {
    if (has(node, "ink")) {
        if (node.ink == "accent") { return _acc(1.0); }
        if (node.ink == "onAccent") { return _onAcc(0.98); }
    }
    return _onSurface(1.0);
}
// Vertical stack. Content-sized and centered by default (the original
// behaviour); honours an explicit main-axis `height`, a `cross` alignment, and
// `Expanded` children that share the leftover main extent by `flex`.
function _paintColumn(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let gap = _gapPx(node); let nc = len(node.children);
    let main = mz.h; if (has(node, "height")) { main = node.height * _u; }
    let fixed = 0.0; let flexTotal = 0.0;
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i];
        if (ch.kind == "expanded") { flexTotal = flexTotal + ch.flex; } else { fixed = fixed + _measure(ch).h; }
    }
    if (nc > 1) { fixed = fixed + gap * (nc - 1); }
    let extra = main - fixed; if (extra < 0.0) { extra = 0.0; }
    let top = cy - main / 2.0; let kids = [];
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i]; let chh = _measure(ch).h;
        if (ch.kind == "expanded") {
            chh = 0.0; if (flexTotal > 0.0) { chh = extra * ch.flex / flexTotal; }
            // Give the flex child tight vertical constraints so it fills its slot.
            if (has(ch, "child")) { let cc = ch.child; cc._fh = chh; }
        }
        let ccx = cx; let cw = _measure(ch).w;
        if (has(node, "cross")) {
            if (node.cross == "start") { ccx = cx - mz.w / 2.0 + cw / 2.0; }
            if (node.cross == "end") { ccx = cx + mz.w / 2.0 - cw / 2.0; }
        }
        _paint(ch, ccx, top + chh / 2.0); top = top + chh + gap; push(kids, ch);
        if (ch.kind == "expanded") { if (has(ch, "child")) { let cc = ch.child; cc._fh = -1.0; } }
    }
    node._kids = kids; _compose(node);
}
// Horizontal stack — the row analog of `_paintColumn`.
function _paintRow(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let gap = _gapPx(node); let nc = len(node.children);
    let main = mz.w; if (has(node, "width")) { main = node.width * _u; }
    let fixed = 0.0; let flexTotal = 0.0;
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i];
        if (ch.kind == "expanded") { flexTotal = flexTotal + ch.flex; } else { fixed = fixed + _measure(ch).w; }
    }
    if (nc > 1) { fixed = fixed + gap * (nc - 1); }
    let extra = main - fixed; if (extra < 0.0) { extra = 0.0; }
    let left = cx - main / 2.0; let kids = [];
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i]; let cw = _measure(ch).w;
        if (ch.kind == "expanded") {
            cw = 0.0; if (flexTotal > 0.0) { cw = extra * ch.flex / flexTotal; }
            // Give the flex child tight horizontal constraints so it fills its slot.
            if (has(ch, "child")) { let cc = ch.child; cc._fw = cw; }
        }
        let ccy = cy; let chh2 = _measure(ch).h;
        if (has(node, "cross")) {
            if (node.cross == "start") { ccy = cy - mz.h / 2.0 + chh2 / 2.0; }
            if (node.cross == "end") { ccy = cy + mz.h / 2.0 - chh2 / 2.0; }
        }
        _paint(ch, left + cw / 2.0, ccy); left = left + cw + gap; push(kids, ch);
        if (ch.kind == "expanded") { if (has(ch, "child")) { let cc = ch.child; cc._fw = -1.0; } }
    }
    node._kids = kids; _compose(node);
}
function _paintCard(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = _u * 1.6;
    if (has(node, "radius")) { r = node.radius * _u; }
    _shadow(cx, cy, hw, hh, r, _u * 0.4, _u * 1.0, _u * 2.8);
    let fill = _surfaceContainer(1.0); if (has(node, "color")) { fill = _colorRole(node.color, 1.0); }
    _rect(cx, cy, hw, hh, r, 0.0, 0.0, fill, _CLEAR);
    let kids = [];
    if (has(node, "child")) { if (!isNull(node.child)) { _paint(node.child, cx, cy); push(kids, node.child); } }
    node._kids = kids; _compose(node);
}
function _paintScaffold(node) {
    _beginSelf(node);
    let aH = _u * 10.0;
    if (has(node, "onKey")) { _keyHandler = node.onKey; _hasKey = 1.0; }
    let kids = [];
    // Paint the body first so the top app bar and bottom navigation draw *over*
    // it: this single-pass kit has no per-widget scissor, so scrolling list items
    // that extend past the viewport edges are covered by the bars (M3 also layers
    // the app bar above scrolling content) instead of bleeding across them.
    if (has(node, "body")) { if (!isNull(node.body)) {
        let bodyTop = aH; let bodyH = _vh - aH;
        if (has(node, "bottomBar")) { bodyH = bodyH - _u * 11.0; }
        // A scrollable body fills the whole body region (tight vertical constraint)
        // so its viewport adapts to the screen — no fixed-height list stranded in a
        // sea of whitespace on tall phones, no overflow on short ones. Other body
        // widgets (e.g. a Card) keep their intrinsic size and are centred.
        let bk = node.body.kind;
        if (bk == "listView") { let bn = node.body; bn._fh = bodyH; }
        if (bk == "gridView") { let bn = node.body; bn._fh = bodyH; }
        _paint(node.body, _vw / 2.0, bodyTop + bodyH / 2.0); push(kids, node.body);
    } }
    if (has(node, "appBar")) { if (!isNull(node.appBar)) { _paint(node.appBar, _vw / 2.0, aH / 2.0); push(kids, node.appBar); } }
    if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { _paint(node.bottomBar, _vw / 2.0, _vh - _u * 5.5); push(kids, node.bottomBar); } }
    if (has(node, "fab")) { if (!isNull(node.fab)) { _paint(node.fab, _vw - _u * 9.0, _vh - _u * 9.0); push(kids, node.fab); } }
    if (has(node, "drawer")) { if (!isNull(node.drawer)) { _paint(node.drawer, _vw / 2.0, _vh / 2.0); push(kids, node.drawer); } }
    if (has(node, "snackbar")) { if (!isNull(node.snackbar)) { _paint(node.snackbar, _vw / 2.0, _vh / 2.0); push(kids, node.snackbar); } }
    if (has(node, "dialog")) { if (!isNull(node.dialog)) { _paint(node.dialog, _vw / 2.0, _vh / 2.0); push(kids, node.dialog); } }
    node._kids = kids; _compose(node);
}
// M3 small top app bar: a *surface* bar (not a saturated primary block — that is
// the Material 2 look) with on-surface nav icon + left-aligned title, an
// on-surface-variant trailing action, and a hairline divider separating it from
// the scrolling body.
function _paintAppBar(node, cx, cy) {
    let bot = cy * 2.0;
    _rect(_vw / 2.0, cy, _vw / 2.0, cy, 0.0, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    _rect(_vw / 2.0, bot - _u * 0.05, _vw / 2.0, _u * 0.05, 0.0, 0.0, 0.0, _outlineVar(0.8), _CLEAR);
    let onS = _onSurface(1.0); let onSV = _onSurface(0.7);
    let lineCx = _u * 6.0; let lw = _u * 2.0; let lh = _u * 0.4; let sp = _u * 1.3;
    _rect(lineCx, cy - sp, lw, lh, lh, 0.0, 0.0, onS, _CLEAR);
    _rect(lineCx, cy, lw, lh, lh, 0.0, 0.0, onS, _CLEAR);
    _rect(lineCx, cy + sp, lw, lh, lh, 0.0, 0.0, onS, _CLEAR);
    // Trailing action rendered as a small accent avatar (theme/profile affordance).
    _disc(_vw - _u * 6.0, cy, _u * 2.4, _acc(1.0));
    _paintTextLeft(node.title, _u * 11.0, cy, _cell("title"), onS);
    if (has(node, "onMenu")) { _addTap(lineCx, cy, _u * 3.0, _u * 3.0, "appMenu", node.onMenu); }
    if (has(node, "onAction")) { _addTap(_vw - _u * 6.0, cy, _u * 3.0, _u * 3.0, "appAction", node.onAction); }
}
// M3 filled button: a fully-rounded accent pill at *elevation 0* (no drop shadow
// — that was a Material 2 trait); hover/press add a tonal state layer.
function _paintFilled(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let st = _hover(cx, cy, hw, hh) * 0.08 + _pressVal(node.id) * 0.12;
    _rect(cx, cy, hw, hh, hh, 0.0, 0.0, _brighten(_acc(1.0), st), _CLEAR);
    _paintText(node.label, cx, cy, _cell("label"), _onAcc(1.0));
    _addTap(cx, cy, hw, hh, node.id, node.onTap);
}
function _paintOutlined(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let st = _hover(cx, cy, hw, hh) * 0.08 + _pressVal(node.id) * 0.12;
    _rect(cx, cy, hw, hh, hh, _u * 0.18, 0.0, _acc(st), _acc(1.0));
    _paintText(node.label, cx, cy, _cell("label"), _acc(1.0));
    _addTap(cx, cy, hw, hh, node.id, node.onTap);
}
function _paintFab(node, cx, cy) {
    let r = _u * 4.2; let rad = r * 0.45;
    let st = _hover(cx, cy, r, r) * 0.08 + _pressVal("fab") * 0.12;
    _shadow(cx, cy, r, r, rad, _u * 0.4, _u * 1.2, _u * 3.0);
    _rect(cx, cy, r, r, rad, 0.0, 0.0, _brighten(_acc(1.0), st), _CLEAR);
    _rect(cx, cy, r * 0.42, r * 0.10, r * 0.10, 0.0, 0.0, _onAcc(1.0), _CLEAR);
    _rect(cx, cy, r * 0.10, r * 0.42, r * 0.10, 0.0, 0.0, _onAcc(1.0), _CLEAR);
    _addTap(cx, cy, r, r, "fab", node.onTap);
}
function _paintSwitch(node, cx, cy) {
    let hw = _u * 4.2; let hh = _u * 2.4;
    let a = _ease(concat("sw:", node.id), node.value);
    let bw = (1.0 - a) * _u * 0.22;
    _rect(cx, cy, hw, hh, hh, bw, 0.0, _mixCol(_surfaceHighest(1.0), _acc(1.0), a), _mixCol(_outline(1.0), _acc(1.0), a));
    let rOff = hh * 0.55; let rOn = hh * 0.82; let tr = rOff + (rOn - rOff) * a;
    let left = cx - hw; let right = cx + hw;
    let tx = (left + hh) + ((right - hh) - (left + hh)) * a;
    _rect(tx, cy, tr, tr, tr, 0.0, 0.0, _mixCol(_outline(1.0), _WHITE, a), _CLEAR);
    _addTap(cx, cy, hw + _u * 2.0, hh + _u * 2.0, node.id, node.onTap);
}
function _paintCheckbox(node, cx, cy) {
    let h = _u * 2.2;
    let a = _ease(concat("ck:", node.id), node.value);
    _rect(cx, cy, h, h, h * 0.28, _u * 0.22, 0.0, _acc(a), _mixCol(_outline(1.0), _acc(1.0), a));
    let white = [1.0, 1.0, 1.0, a];
    _rect(cx - h * 0.22, cy + h * 0.12, h * 0.25, h * 0.08, h * 0.08, 0.0, -2.356, white, _CLEAR);
    _rect(cx + h * 0.22, cy - h * 0.12, h * 0.50, h * 0.08, h * 0.08, 0.0, -0.997, white, _CLEAR);
    _addTap(cx, cy, h + _u * 2.0, h + _u * 2.0, node.id, node.onTap);
}
function _paintRadio(node, cx, cy) {
    let h = _u * 2.2;
    let a = _ease(concat("rb:", node.id), node.selected);
    _rect(cx, cy, h, h, h, _u * 0.22, 0.0, _CLEAR, _mixCol(_outline(1.0), _acc(1.0), a));
    let dr = h * 0.55 * a;
    _rect(cx, cy, dr, dr, dr, 0.0, 0.0, _acc(1.0), _CLEAR);
    _addTap(cx, cy, h + _u * 2.0, h + _u * 2.0, node.id, node.onTap);
}
function _paintSlider(node, cx, cy) {
    let hw = _u * 31.0; let hh = _u * 0.8; let val = node.value;
    let left = cx - hw; let width = hw * 2.0;
    _rect(cx, cy, hw, hh, hh, 0.0, 0.0, _surfaceHighest(1.0), _CLEAR);
    _rect(left + val * width / 2.0, cy, val * width / 2.0, hh, hh, 0.0, 0.0, _acc(1.0), _CLEAR);
    let baseR = _u * 1.4; let tw = baseR * 0.42 * (1.0 + _dragging * 0.2); let th = baseR * (1.4 + _dragging * 0.25);
    _rect(left + val * width, cy, tw, th, tw, 0.0, 0.0, _acc(1.0), _CLEAR);
    _addDrag(cx, cy, hw, _u * 5.0, node.onChanged, left, width);
    _registerWheel(node.onChanged, val);
}
function _paintChip(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let a = _ease(concat("chip:", node.id), node.value);
    _rect(cx, cy, hw, hh, hh * 0.5, _u * 0.18, 0.0, _acc(a), _mixCol(_outline(1.0), _acc(1.0), a));
    let dr = hh * 0.42;
    _rect(cx - hw + hh * 1.1, cy, dr, dr, dr, 0.0, 0.0, [1.0, 1.0, 1.0, a], _CLEAR);
    _paintText(node.label, cx + hh * 0.4, cy, _cell("caption"), _mixCol(_onSurface(1.0), _onAcc(1.0), a));
    _addTap(cx, cy, hw, hh, node.id, node.onTap);
}
function _paintProgress(node, cx, cy) {
    let hw = _u * 31.0; let hh = _u * 0.8;
    let a = _ease(concat("pr:", node.id), node.value);
    _rect(cx, cy, hw, hh, hh, 0.0, 0.0, _surfaceHighest(1.0), _CLEAR);
    let left = cx - hw; let width = hw * 2.0 * a;
    _rect(left + width / 2.0, cy, width / 2.0, hh, hh, 0.0, 0.0, _acc(1.0), _CLEAR);
}
function _paintDivider(node, cx, cy) {
    let w = _u * 31.0; if (has(node, "width")) { w = node.width * _u * 0.5; }
    _rect(cx, cy, w, _u * 0.18, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
}

// ------------------------------------------------ shared helpers (new kit) ----
function _idOf(node) { if (has(node, "id")) { return node.id; } return "x"; }
function _colorRole(name, a) {
    if (name == "primary") { return _acc(a); }
    if (name == "onPrimary") { return _onAcc(a); }
    if (name == "surface") { return _surfaceContainer(a); }
    if (name == "surfaceHigh") { return _surfaceHighest(a); }
    if (name == "outline") { return _outline(a); }
    if (name == "outlineVar") { return _outlineVar(a); }
    if (name == "onSurface") { return _onSurface(a); }
    if (name == "bg") { let c = _colorBg(); return [c[0], c[1], c[2], a]; }
    return _surfaceContainer(a);
}
// Left-aligned text: `_paintText` centers on x, so shift by half its width.
function _paintTextLeft(str, x, cy, cell, col) { _paintText(str, x + _textW(str, cell) / 2.0, cy, cell, col); }
// Word-wrapped left-aligned paragraph within `maxW`.
function _paintWrappedLeft(str, x, y, maxW, cell, col) {
    let words = split(str, " "); let line = ""; let ly = y; let lh = 6.0 * cell + cell * 1.4;
    for (let i = 0; i < len(words); i++) {
        let w = words[i]; let trial = w; if (len(line) > 0) { trial = concat(line, concat(" ", w)); }
        if (_textW(trial, cell) > maxW) {
            if (len(line) > 0) { _paintTextLeft(line, x, ly, cell, col); ly = ly + lh; line = w; }
            else { _paintTextLeft(w, x, ly, cell, col); line = ""; }
        } else { line = trial; }
    }
    if (len(line) > 0) { _paintTextLeft(line, x, ly, cell, col); }
}
function _pieColor(i) {
    let pal = [_acc(1.0), [0.0, 0.55, 0.55, 1.0], [0.85, 0.45, 0.1, 1.0], [0.45, 0.3, 0.7, 1.0], [0.2, 0.62, 0.28, 1.0], [0.82, 0.25, 0.35, 1.0]];
    return pal[i % len(pal)];
}
function _fmtTime(frac) { return concat(str(floor(frac * 100.0)), "%"); }

// ------------------------------------------------------ layout widget paints --
function _paintBox(node, cx, cy, pad) {
    _beginSelf(node);
    let kids = [];
    if (has(node, "child")) { if (!isNull(node.child)) { _paint(node.child, cx + (pad.l - pad.r) / 2.0, cy + (pad.t - pad.b) / 2.0); push(kids, node.child); } }
    node._kids = kids; _compose(node);
}
function _paintContainer(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    _beginSelf(node);
    let deco = 0.0; if (has(node, "color")) { deco = 1.0; } if (has(node, "border")) { deco = 1.0; }
    if (deco > 0.5) {
        let r = 0.0; if (has(node, "radius")) { r = node.radius * _u; }
        let bw = 0.0; if (has(node, "border")) { bw = node.border * _u; }
        let fill = _CLEAR; if (has(node, "color")) { fill = _colorRole(node.color, 1.0); }
        let bcol = _CLEAR; if (has(node, "border")) { bcol = _outline(1.0); if (has(node, "borderColor")) { bcol = _colorRole(node.borderColor, 1.0); } }
        _rect(cx, cy, hw, hh, r, bw, 0.0, fill, bcol);
    }
    if (has(node, "onTap")) { _addTap(cx, cy, hw, hh, _idOf(node), node.onTap); }
    let kids = [];
    if (has(node, "child")) { if (!isNull(node.child)) {
        let pad = _padOf(node); _paint(node.child, cx + (pad.l - pad.r) / 2.0, cy + (pad.t - pad.b) / 2.0); push(kids, node.child);
    } }
    node._kids = kids; _compose(node);
}
function _paintCenter(node, cx, cy) {
    _beginSelf(node);
    let kids = [];
    if (has(node, "child")) { if (!isNull(node.child)) { _paint(node.child, cx, cy); push(kids, node.child); } }
    node._kids = kids; _compose(node);
}
function _paintAlign(node, cx, cy) {
    _beginSelf(node);
    let kids = [];
    if (has(node, "child")) { if (!isNull(node.child)) {
        let mz = _measure(node); let cm = _measure(node.child);
        let ax = 0.0; let ay = 0.0; if (has(node, "ax")) { ax = node.ax; } if (has(node, "ay")) { ay = node.ay; }
        _paint(node.child, cx + ax * (mz.w - cm.w) / 2.0, cy + ay * (mz.h - cm.h) / 2.0); push(kids, node.child);
    } }
    node._kids = kids; _compose(node);
}
function _paintStack(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let nc = len(node.children); let kids = [];
    let left = cx - mz.w / 2.0; let top = cy - mz.h / 2.0;
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i]; let cm = _measure(ch); let px = cx; let py = cy;
        if (ch.kind == "positioned") {
            if (has(ch, "left")) { px = left + ch.left * _u + cm.w / 2.0; }
            if (has(ch, "right")) { px = left + mz.w - ch.right * _u - cm.w / 2.0; }
            if (has(ch, "top")) { py = top + ch.top * _u + cm.h / 2.0; }
            if (has(ch, "bottom")) { py = top + mz.h - ch.bottom * _u - cm.h / 2.0; }
        }
        _paint(ch, px, py); push(kids, ch);
    }
    node._kids = kids; _compose(node);
}
function _paintWrap(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let maxW = _wrapMaxW(node);
    let gap = _gapPx(node); let rg = gap; if (has(node, "runGap")) { rg = node.runGap * _u; }
    let nc = len(node.children); let left = cx - mz.w / 2.0; let top = cy - mz.h / 2.0;
    let x = 0.0; let rowTop = top; let rowH = 0.0; let kids = [];
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i]; let cm = _measure(ch);
        if (x > 0.0) { if (x + gap + cm.w > maxW) { rowTop = rowTop + rowH + rg; x = 0.0; rowH = 0.0; } }
        if (x > 0.0) { x = x + gap; }
        _paint(ch, left + x + cm.w / 2.0, rowTop + cm.h / 2.0); push(kids, ch);
        x = x + cm.w; if (cm.h > rowH) { rowH = cm.h; }
    }
    node._kids = kids; _compose(node);
}
function _paintListView(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let gap = _gapPx(node);
    let nc = len(node.children); let total = 0.0;
    for (let i = 0; i < nc; i++) { total = total + _measure(node.children[i]).h; }
    if (nc > 1) { total = total + gap * (nc - 1); }
    let viewport = mz.h; let maxOff = total - viewport; if (maxOff < 0.0) { maxOff = 0.0; }
    let off = 0.0; if (has(_scroll, node.id)) { off = _scroll[node.id]; }
    if (off > maxOff) { off = maxOff; } if (off < 0.0) { off = 0.0; }
    _scroll[node.id] = off;
    _listRegions[node.id] = { cx: cx, cy: cy, hw: hw, hh: hh, maxOff: maxOff };
    let r = _u * 1.2; if (has(node, "radius")) { r = node.radius * _u; }
    if (has(node, "surface")) { if (node.surface > 0.5) { _rect(cx, cy, hw, hh, r, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR); } }
    let top = cy - hh - off; let kids = [];
    for (let i = 0; i < nc; i++) {
        let ch = node.children[i]; let cm = _measure(ch); let itemCy = top + cm.h / 2.0;
        if (itemCy + cm.h / 2.0 >= cy - hh) { if (itemCy - cm.h / 2.0 <= cy + hh) { _paint(ch, cx, itemCy); push(kids, ch); } }
        top = top + cm.h + gap;
    }
    if (maxOff > 0.5) {
        _curOut = node._over;
        let trackH = hh * 2.0; let thumbH = trackH * viewport / total; if (thumbH < _u * 4.0) { thumbH = _u * 4.0; }
        let frac = off / maxOff; let thumbCy = (cy - hh) + thumbH / 2.0 + frac * (trackH - thumbH);
        _rect(cx + hw - _u * 0.6, thumbCy, _u * 0.35, thumbH / 2.0, _u * 0.35, 0.0, 0.0, _outline(0.7), _CLEAR);
    }
    node._kids = kids; _compose(node);
}
function _paintGridView(node, cx, cy) {
    _beginSelf(node);
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let cols = node.cols; let gap = _gapPx(node); let cellW = (mz.w - gap * (cols - 1)) / cols;
    let cellH = cellW; if (has(node, "cellHeight")) { cellH = node.cellHeight * _u; }
    let nc = len(node.children); let rows = ceil(num(nc) / cols);
    let total = rows * cellH + (rows - 1) * gap; let viewport = mz.h;
    let maxOff = total - viewport; if (maxOff < 0.0) { maxOff = 0.0; }
    let off = 0.0; if (has(_scroll, node.id)) { off = _scroll[node.id]; }
    if (off > maxOff) { off = maxOff; } if (off < 0.0) { off = 0.0; } _scroll[node.id] = off;
    _listRegions[node.id] = { cx: cx, cy: cy, hw: hw, hh: hh, maxOff: maxOff };
    let left = cx - hw; let top = cy - hh - off; let kids = [];
    for (let i = 0; i < nc; i++) {
        let col = i % cols; let row = floor(num(i) / cols);
        let cxi = left + col * (cellW + gap) + cellW / 2.0; let cyi = top + row * (cellH + gap) + cellH / 2.0;
        if (cyi + cellH / 2.0 >= cy - hh) { if (cyi - cellH / 2.0 <= cy + hh) {
            // Tight constraints: each cell fills its grid box.
            let cell = node.children[i]; cell._fw = cellW; cell._fh = cellH;
            _paint(cell, cxi, cyi); push(kids, cell);
            cell._fw = -1.0; cell._fh = -1.0;
        } }
    }
    node._kids = kids; _compose(node);
}
function _paintBadge(node, cx, cy) {
    _beginSelf(node);
    let kids = [];
    let cm = { w: _u * 4.0, h: _u * 4.0 };
    if (has(node, "child")) { if (!isNull(node.child)) { cm = _measure(node.child); _paint(node.child, cx, cy); push(kids, node.child); } }
    _curOut = node._over;
    let bx = cx + cm.w / 2.0 - _u * 0.4; let by = cy - cm.h / 2.0 + _u * 0.4; let br = _u * 1.5;
    let cnt = 0.0; if (has(node, "count")) { cnt = node.count; }
    _rect(bx, by, br, br, br, 0.0, 0.0, [0.85, 0.25, 0.3, 1.0], _CLEAR);
    _paintText(str(cnt), bx, by, _cell("micro"), _WHITE);
    node._kids = kids; _compose(node);
}
function _paintExpansion(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let hdrH = _u * 7.0;
    _beginSelf(node);
    _rect(cx, cy, hw, hh, _u * 1.4, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    let hcy = cy - hh + hdrH / 2.0;
    _paintTextLeft(node.title, cx - hw + _u * 3.0, hcy, _cell("body"), _onSurface(1.0));
    let exp = 0.0; if (has(node, "expanded")) { exp = node.expanded; }
    let a = _ease(concat("exp:", _idOf(node)), exp);
    let chx = cx + hw - _u * 4.0; let arm = _u * 1.0; let dir = a * 1.5708;
    _seg(chx, hcy, chx + cos(dir - 2.356) * arm, hcy + sin(dir - 2.356) * arm, _u * 0.3, _onSurface(0.7));
    _seg(chx, hcy, chx + cos(dir + 2.356) * arm, hcy + sin(dir + 2.356) * arm, _u * 0.3, _onSurface(0.7));
    if (has(node, "onToggle")) { _addTap(cx, hcy, hw, hdrH / 2.0, _idOf(node), node.onToggle); }
    let kids = [];
    if (exp > 0.5) { if (has(node, "child")) { if (!isNull(node.child)) {
        let cm = _measure(node.child); _paint(node.child, cx, cy - hh + hdrH + _u * 1.0 + cm.h / 2.0); push(kids, node.child);
    } } }
    node._kids = kids; _compose(node);
}

// --------------------------------------------------- material / content paints
function _paintIcon(node, cx, cy) {
    let r = _iconR(node); let col = _onSurface(1.0); if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    _icon(node.icon, cx, cy, r, col);
}
function _paintIconButton(node, cx, cy) {
    let r = _iconR(node); let hw = r + _u * 1.2;
    let st = _hover(cx, cy, hw, hw) * 0.10 + _pressVal(node.id) * 0.14;
    let sel2 = 0.0; if (has(node, "selected")) { sel2 = node.selected; }
    if (sel2 > 0.5) { _rect(cx, cy, hw, hw, hw, 0.0, 0.0, _acc(0.16), _CLEAR); }
    if (st > 0.001) { _rect(cx, cy, hw, hw, hw, 0.0, 0.0, _onSurface(st), _CLEAR); }
    let col = _onSurface(0.85); if (sel2 > 0.5) { col = _acc(1.0); } if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    _icon(node.icon, cx, cy, r, col);
    _addTap(cx, cy, hw, hw, node.id, node.onTap);
}
function _paintAvatar(node, cx, cy) {
    let r = _u * 3.2; if (has(node, "radius")) { r = node.radius * _u; }
    let col = _acc(1.0); if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    _disc(cx, cy, r, col);
    if (has(node, "icon")) { _icon(node.icon, cx, cy, r * 0.6, _onAcc(1.0)); }
    else { if (has(node, "label")) { _paintText(node.label, cx, cy, r * 0.5, _onAcc(1.0)); } }
}
function _paintListTile(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let st = _hover(cx, cy, hw, hh) * 0.05; if (has(node, "id")) { st = st + _pressVal(node.id) * 0.08; }
    if (st > 0.001) { _rect(cx, cy, hw, hh, _u * 1.0, 0.0, 0.0, _onSurface(st), _CLEAR); }
    let hasLead = has(node, "leading");
    if (hasLead) { _icon(node.leading, cx - hw + _u * 4.5, cy, _u * 1.9, _onSurface(0.8)); }
    let tx = cx - hw + _u * 4.0; if (hasLead) { tx = cx - hw + _u * 9.0; }
    let hasSub = has(node, "subtitle");
    let ty = cy; if (hasSub) { ty = cy - _u * 1.3; }
    _paintTextLeft(node.title, tx, ty, _cell("body"), _onSurface(1.0));
    if (hasSub) { _paintTextLeft(node.subtitle, tx, cy + _u * 1.6, _cell("caption"), _onSurface(0.65)); }
    if (has(node, "trailing")) { _icon(node.trailing, cx + hw - _u * 4.0, cy, _u * 1.7, _onSurface(0.7)); }
    if (has(node, "onTap")) { _addTap(cx, cy, hw, hh, _idOf(node), node.onTap); }
}
function _paintTextField(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let f = 0.0; if (_focused == node.id) { f = 1.0; }
    let bw = _u * 0.18; let bcol = _outline(1.0); if (f > 0.5) { bw = _u * 0.3; bcol = _acc(1.0); }
    _rect(cx, cy, hw, hh, _u * 1.2, bw, 0.0, _surfaceContainer(0.5), bcol);
    let tx = cx - hw + _u * 2.6; let val = node.value;
    if (len(val) == 0) { if (has(node, "placeholder")) { _paintTextLeft(node.placeholder, tx, cy, _cell("body"), _onSurface(0.4)); } }
    else { _paintTextLeft(val, tx, cy, _cell("body"), _onSurface(1.0)); }
    if (has(node, "label")) { _paintTextLeft(node.label, tx, cy - hh - _u * 1.3, _cell("caption"), bcol); }
    if (f > 0.5) {
        let cw = _textW(val, _cell("body"));
        _rect(tx + cw + _u * 0.4, cy, _u * 0.14, hh * 0.5, _u * 0.07, 0.0, 0.0, _acc(1.0), _CLEAR);
        _focusInput = (key) => {
            let v = node.value;
            if (key == "Backspace") { v = substring(v, 0, max(0.0, len(v) - 1.0)); }
            else { if (len(key) == 1) { v = concat(v, key); } }
            if (has(node, "onChange")) { node.onChange(v); }
        };
        _hasFocusInput = 1.0;
    }
    _addTap(cx, cy, hw, hh, node.id, () => { _focused = node.id; _repaint(); });
}
function _paintTabs(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let n = len(node.tabs); let tw = mz.w / n; let left = cx - hw;
    let idx = 0.0; if (has(node, "index")) { idx = node.index; }
    for (let i = 0; i < n; i++) {
        let tcx = left + i * tw + tw / 2.0; let on = sel(i, idx);
        let col = _onSurface(0.65); if (on > 0.5) { col = _acc(1.0); }
        _paintText(node.tabs[i], tcx, cy - _u * 0.3, _cell("label"), col);
        let ii = i; _addTap(tcx, cy, tw / 2.0, hh, concat("tab", str(ii)), () => { node.onChange(ii); });
    }
    let a = _ease(concat("tabs:", _idOf(node)), idx);
    let icx = left + (a + 0.5) * tw;
    _rect(cx, cy + hh - _u * 0.1, hw, _u * 0.08, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
    _rect(icx, cy + hh - _u * 0.3, tw * 0.34, _u * 0.32, _u * 0.18, 0.0, 0.0, _acc(1.0), _CLEAR);
}
function _paintNavBar(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    _rect(cx, cy, hw, hh, 0.0, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    _rect(cx, cy - hh, hw, _u * 0.06, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
    let n = len(node.items); let tw = mz.w / n; let left = cx - hw;
    let idx = 0.0; if (has(node, "index")) { idx = node.index; }
    for (let i = 0; i < n; i++) {
        let it = node.items[i]; let tcx = left + i * tw + tw / 2.0; let on = sel(i, idx);
        let col = _onSurface(0.6); if (on > 0.5) { col = _acc(1.0); }
        if (on > 0.5) { _rect(tcx, cy - _u * 1.3, _u * 5.0, _u * 1.6, _u * 1.6, 0.0, 0.0, _acc(0.18), _CLEAR); }
        _icon(it.icon, tcx, cy - _u * 1.3, _u * 1.6, col);
        if (has(it, "label")) { _paintText(it.label, tcx, cy + _u * 2.2, _cell("micro"), col); }
        let ii = i; _addTap(tcx, cy, tw / 2.0, hh, concat("nav", str(ii)), () => { node.onChange(ii); });
    }
}
function _paintSegmented(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let n = len(node.segments); let tw = mz.w / n; let left = cx - hw;
    let idx = 0.0; if (has(node, "index")) { idx = node.index; }
    _rect(cx, cy, hw, hh, hh, _u * 0.18, 0.0, _CLEAR, _outline(1.0));
    for (let i = 0; i < n; i++) {
        let scx = left + i * tw + tw / 2.0; let on = sel(i, idx);
        if (on > 0.5) { _rect(scx, cy, tw / 2.0 - _u * 0.25, hh - _u * 0.25, hh, 0.0, 0.0, _acc(0.9), _CLEAR); }
        let col = _onSurface(0.9); if (on > 0.5) { col = _onAcc(1.0); }
        _paintText(node.segments[i], scx, cy, _cell("label"), col);
        if (i > 0) { _rect(left + i * tw, cy, _u * 0.08, hh, 0.0, 0.0, 0.0, _outline(0.6), _CLEAR); }
        let ii = i; _addTap(scx, cy, tw / 2.0, hh, concat("seg", str(ii)), () => { node.onChange(ii); });
    }
}
function _paintCircular(node, cx, cy) {
    let r = _u * 4.0; if (has(node, "radius")) { r = node.radius * _u; }
    let val = 0.75; if (has(node, "value")) { val = node.value; }
    let a = _ease(concat("cp:", _idOf(node)), val);
    _ring(cx, cy, r, _u * 0.5, _surfaceHighest(1.0));
    let segn = floor(48.0 * a) + 1; let a0 = 0.0 - 1.5708;
    for (let i = 0; i < segn; i++) { let aa = a0 + (num(i) / 48.0) * 6.2832; _disc(cx + cos(aa) * r, cy + sin(aa) * r, _u * 0.42, _acc(1.0)); }
    _paintText(concat(str(floor(a * 100.0)), "%"), cx, cy, _cell("caption"), _onSurface(0.9));
}
function _paintBanner(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    _rect(cx, cy, hw, hh, _u * 1.2, 0.0, 0.0, _acc(0.16), _CLEAR);
    let tx = cx - hw + _u * 3.0;
    if (has(node, "icon")) { _icon(node.icon, cx - hw + _u * 4.0, cy, _u * 1.8, _acc(1.0)); tx = cx - hw + _u * 8.0; }
    _paintTextLeft(node.message, tx, cy, _cell("body"), _onSurface(0.95));
}
function _paintSnackbar(node, cx, cy) {
    let w = _u * 60.0; let cx2 = _vw / 2.0; let cy2 = _vh - _u * 9.0; let hw = w / 2.0; let hh = _u * 3.5;
    _shadow(cx2, cy2, hw, hh, _u * 1.2, _u * 0.3, _u * 0.8, _u * 2.0);
    _rect(cx2, cy2, hw, hh, _u * 1.2, 0.0, 0.0, [_mix(0.18, 0.92), _mix(0.18, 0.90), _mix(0.2, 0.94), 1.0], _CLEAR);
    _paintTextLeft(node.message, cx2 - hw + _u * 3.0, cy2, _cell("body"), [_mix(0.95, 0.1), _mix(0.95, 0.1), _mix(0.97, 0.12), 1.0]);
    if (has(node, "actionLabel")) {
        let aw = _btnW(node.actionLabel) / 2.0; let acx = cx2 + hw - aw - _u * 2.0;
        _paintText(node.actionLabel, acx, cy2, _cell("label"), _acc(1.0));
        if (has(node, "onAction")) { _addTap(acx, cy2, aw, hh, "snackAction", node.onAction); }
    }
}
function _paintDialog(node, cx, cy) {
    _rect(_vw / 2.0, _vh / 2.0, _vw / 2.0, _vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.45], _CLEAR);
    let w = _u * 72.0; let h = _u * 46.0; if (has(node, "width")) { w = node.width * _u; } if (has(node, "height")) { h = node.height * _u; }
    let cx2 = _vw / 2.0; let cy2 = _vh / 2.0; let hw = w / 2.0; let hh = h / 2.0;
    _shadow(cx2, cy2, hw, hh, _u * 2.0, _u * 0.5, _u * 1.5, _u * 3.0);
    _rect(cx2, cy2, hw, hh, _u * 2.4, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    if (has(node, "title")) { _paintTextLeft(node.title, cx2 - hw + _u * 4.0, cy2 - hh + _u * 5.5, _cell("title"), _onSurface(1.0)); }
    if (has(node, "message")) { _paintWrappedLeft(node.message, cx2 - hw + _u * 4.0, cy2 - hh + _u * 12.0, hw * 2.0 - _u * 8.0, _cell("body"), _onSurface(0.8)); }
    if (has(node, "actions")) {
        let acts = node.actions; let ax = cx2 + hw - _u * 3.0;
        for (let i = len(acts) - 1; i >= 0; i = i - 1) {
            let act = acts[i]; let bw = _btnW(act.label) / 2.0; let bcx = ax - bw;
            _paintText(act.label, bcx, cy2 + hh - _u * 4.0, _cell("label"), _acc(1.0));
            _addTap(bcx, cy2 + hh - _u * 4.0, bw, _u * 2.6, concat("dlg", str(i)), act.onTap);
            ax = ax - bw * 2.0 - _u * 4.0;
        }
    }
}
function _paintDrawer(node, cx, cy) {
    let open = 0.0; if (has(node, "open")) { open = node.open; }
    let a = _ease(concat("drawer:", _idOf(node)), open);
    if (a < 0.01) { return 0; }
    let w = _u * 64.0;
    _rect(_vw / 2.0, _vh / 2.0, _vw / 2.0, _vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.45 * a], _CLEAR);
    let pcx = 0.0 - w / 2.0 + a * w; let cy2 = _vh / 2.0; let hw = w / 2.0; let hh = _vh / 2.0;
    _rect(pcx, cy2, hw, hh, 0.0, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    if (has(node, "header")) { _paintTextLeft(node.header, pcx - hw + _u * 4.0, _u * 8.0, _cell("title"), _onSurface(1.0)); }
    let items = node.items; let iy = _u * 16.0;
    for (let i = 0; i < len(items); i++) {
        let it = items[i]; let sel2 = 0.0; if (has(node, "index")) { sel2 = sel(i, node.index); }
        if (sel2 > 0.5) { _rect(pcx, iy, hw - _u * 2.0, _u * 2.2, _u * 2.0, 0.0, 0.0, _acc(0.18), _CLEAR); }
        let col = _onSurface(0.8); if (sel2 > 0.5) { col = _acc(1.0); }
        if (has(it, "icon")) { _icon(it.icon, pcx - hw + _u * 5.0, iy, _u * 1.7, col); }
        _paintTextLeft(it.label, pcx - hw + _u * 9.0, iy, _cell("body"), col);
        let ii = i; _addTap(pcx, iy, hw, _u * 2.5, concat("drw", str(ii)), () => { node.onSelect(ii); });
        iy = iy + _u * 6.0;
    }
    let pr = pcx + hw; let scx = (pr + _vw) / 2.0; let sw = (_vw - pr) / 2.0;
    if (has(node, "onClose")) { _addTap(scx, _vh / 2.0, sw, _vh / 2.0, "drwScrim", node.onClose); }
}
function _paintDataTable(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let cols = node.columns; let nc = len(cols); let rows = node.rows; let nr = len(rows);
    let cw = mz.w / nc; let rh = _u * 5.0; let left = cx - hw; let top = cy - hh;
    for (let c = 0; c < nc; c++) { _paintTextLeft(cols[c], left + c * cw + _u * 1.0, top + rh / 2.0, _cell("label"), _onSurface(1.0)); }
    _rect(cx, top + rh, hw, _u * 0.08, 0.0, 0.0, 0.0, _outline(1.0), _CLEAR);
    for (let r2 = 0; r2 < nr; r2++) {
        let ry = top + rh * (r2 + 1) + rh / 2.0;
        if (r2 % 2 == 1) { _rect(cx, ry, hw, rh / 2.0, 0.0, 0.0, 0.0, _onSurface(0.03), _CLEAR); }
        let row = rows[r2];
        for (let c = 0; c < nc; c++) { _paintTextLeft(str(row[c]), left + c * cw + _u * 1.0, ry, _cell("body"), _onSurface(0.85)); }
        _rect(cx, ry + rh / 2.0, hw, _u * 0.04, 0.0, 0.0, 0.0, _outlineVar(0.5), _CLEAR);
    }
}

// ------------------------------------------------------------ media / charts --
function _paintImage(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = _u * 1.2; if (has(node, "radius")) { r = node.radius * _u; }
    let tone = _surfaceHighest(1.0); if (has(node, "color")) { tone = _colorRole(node.color, 1.0); }
    _rect(cx, cy, hw, hh, r, 0.0, 0.0, tone, _CLEAR);
    _rect(cx, cy - hh * 0.5, hw, hh * 0.5, r, 0.0, 0.0, _brighten(tone, 0.04), _CLEAR);
    _icon("image", cx, cy, min(hw, hh) * 0.5, _onSurface(0.35));
    if (has(node, "label")) { _paintText(node.label, cx, cy + hh - _u * 2.0, _cell("caption"), _onSurface(0.6)); }
}
function _paintVideo(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let playing = 0.0; if (has(node, "playing")) { playing = node.playing; }
    let val = 0.0; if (has(node, "value")) { val = node.value; }
    _rect(cx, cy, hw, hh, _u * 1.2, 0.0, 0.0, [0.05, 0.05, 0.07, 1.0], _CLEAR);
    _rect(cx, cy - hh * 0.4, hw, hh * 0.6, _u * 1.2, 0.0, 0.0, [0.1, 0.11, 0.14, 1.0], _CLEAR);
    let cr = min(hw, hh) * 0.34;
    _disc(cx, cy, cr, [1.0, 1.0, 1.0, 0.16]);
    let ic = "play"; if (playing > 0.5) { ic = "pause"; }
    _icon(ic, cx, cy, cr * 0.7, [1.0, 1.0, 1.0, 0.95]);
    if (has(node, "onToggle")) { _addTap(cx, cy, cr, cr, concat(node.id, "toggle"), node.onToggle); }
    let sy = cy + hh - _u * 2.0; let sxl = cx - hw + _u * 2.0; let sw = mz.w - _u * 4.0;
    _rect(cx, sy, sw / 2.0, _u * 0.4, _u * 0.4, 0.0, 0.0, [1.0, 1.0, 1.0, 0.3], _CLEAR);
    _rect(sxl + val * sw / 2.0, sy, val * sw / 2.0, _u * 0.4, _u * 0.4, 0.0, 0.0, _acc(1.0), _CLEAR);
    _disc(sxl + val * sw, sy, _u * 0.9, _acc(1.0));
    if (has(node, "onSeek")) { _addDrag(cx, sy, sw / 2.0, _u * 2.5, node.onSeek, sxl, sw); }
    _paintTextLeft(_fmtTime(val), sxl, sy - _u * 2.3, _cell("micro"), [1.0, 1.0, 1.0, 0.8]);
}
function _paintBarChart(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let data = node.data; let n = len(data); let maxv = 0.0;
    for (let i = 0; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } }
    if (has(node, "max")) { maxv = node.max; } if (maxv <= 0.0) { maxv = 1.0; }
    let pad = _u * 1.0; let left = cx - hw + pad; let base = cy + hh - _u * 3.0; let avail = mz.w - pad * 2.0;
    let step = avail / n; let bw = step * 0.6;
    let col = _acc(1.0); if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    _rect(cx, base + _u * 0.2, hw - pad, _u * 0.06, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
    for (let i = 0; i < n; i++) {
        let h2 = (data[i] / maxv) * (mz.h - _u * 7.0); if (h2 < _u * 0.2) { h2 = _u * 0.2; }
        let bcx = left + i * step + step / 2.0;
        _rect(bcx, base - h2 / 2.0, bw / 2.0, h2 / 2.0, _u * 0.4, 0.0, 0.0, col, _CLEAR);
        if (has(node, "labels")) { _paintText(node.labels[i], bcx, base + _u * 1.6, _cell("micro"), _onSurface(0.7)); }
    }
}
function _paintLineChart(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let data = node.data; let n = len(data); if (n < 2) { return 0; }
    let maxv = data[0]; let minv = data[0];
    for (let i = 1; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } if (data[i] < minv) { minv = data[i]; } }
    if (has(node, "max")) { maxv = node.max; } if (has(node, "min")) { minv = node.min; }
    let rng = maxv - minv; if (rng <= 0.0) { rng = 1.0; }
    let pad = _u * 2.0; let left = cx - hw + pad; let availW = mz.w - pad * 2.0; let top = cy - hh + pad; let availH = mz.h - pad * 2.0;
    let col = _acc(1.0); if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    _rect(cx, cy + hh - pad, hw - pad, _u * 0.05, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
    let pxs = []; let pys = [];
    for (let i = 0; i < n; i++) {
        let x = left + (num(i) / (n - 1)) * availW; let norm = (data[i] - minv) / rng; let y = top + (1.0 - norm) * availH;
        push(pxs, x); push(pys, y);
    }
    for (let i = 0; i < n - 1; i++) { _seg(pxs[i], pys[i], pxs[i + 1], pys[i + 1], _u * 0.4, col); }
    for (let i = 0; i < n; i++) { _disc(pxs[i], pys[i], _u * 0.55, col); }
}
function _paintSparkline(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let data = node.data; let n = len(data); if (n < 2) { return 0; }
    let maxv = data[0]; let minv = data[0];
    for (let i = 1; i < n; i++) { if (data[i] > maxv) { maxv = data[i]; } if (data[i] < minv) { minv = data[i]; } }
    let rng = maxv - minv; if (rng <= 0.0) { rng = 1.0; }
    let left = cx - hw; let top = cy - hh; let col = _acc(1.0); if (has(node, "color")) { col = _colorRole(node.color, 1.0); }
    let pxs = []; let pys = [];
    for (let i = 0; i < n; i++) { push(pxs, left + (num(i) / (n - 1)) * mz.w); push(pys, top + (1.0 - (data[i] - minv) / rng) * mz.h); }
    for (let i = 0; i < n - 1; i++) { _seg(pxs[i], pys[i], pxs[i + 1], pys[i + 1], _u * 0.3, col); }
}
function _paintPieChart(node, cx, cy) {
    let r = _u * 14.0; if (has(node, "radius")) { r = node.radius * _u; }
    let data = node.data; let n = len(data); let total = 0.0;
    for (let i = 0; i < n; i++) { total = total + data[i].value; }
    if (total <= 0.0) { total = 1.0; }
    let bounds = []; let acc = 0.0;
    for (let i = 0; i < n; i++) { acc = acc + data[i].value / total; push(bounds, acc); }
    let spokes = 72; let thick = (6.2832 * r / spokes) + _u * 0.12;
    for (let s = 0; s < spokes; s++) {
        let frac = (num(s) + 0.5) / spokes; let si = 0;
        for (let j = 0; j < n; j++) { if (frac <= bounds[j]) { si = j; j = n; } }
        let aa = frac * 6.2832 - 1.5708; let col = _pieColor(si);
        if (has(data[si], "colorIndex")) { col = _pieColor(data[si].colorIndex); }
        _seg(cx, cy, cx + cos(aa) * r, cy + sin(aa) * r, thick, col);
    }
    if (has(node, "hole")) { _disc(cx, cy, r * node.hole, _surfaceContainer(1.0)); }
}

// ---------------------------------------------------- partial reassembly ------
// Recompute a node's cached output from its children's *cached* output (no fn
// re-run, no re-paint) — used to bubble a single component's update to the root.
// Re-run just this component, repaint it in its cached box, then reassemble the
// frame from every other component's cached output (`_compose` bubbles its
// children's cached output up). Only this subtree's fn runs.
function _partial(node) {
    _mount(node, node._parent);
    _paint(node, node._cx, node._cy);
    let a = node._parent;
    for (let guard = 0; guard < 64; guard++) {
        if (a.kind == "null") { guard = 99; } else { _compose(a); a = a._parent; }
    }
    _inst = _root._out; _taps = _root._taps; _drags = _root._drags;
    _submit();
}

// --------------------------------------------- per-frame partial animation ----
// Reassemble the whole tree's cached output bottom-up (cheap native concat; no
// component fn re-runs, no instance re-emits) after some components were
// repainted in place by the frame clock.
function _reassembleTree(node) {
    if (node.kind == "comp") { _reassembleTree(node._sub); _compose(node); return 0; }
    let kids = node._kids;
    for (let i = 0; i < len(kids); i++) { _reassembleTree(kids[i]); }
    _compose(node);
    return 0;
}
// Mark the component that owns `key` dirty (deduped) for this frame.
function _markDirty(dirty, key) {
    if (has(_keySubs, key)) {
        let c = _keySubs[key];
        let mk = 0.0; if (has(c, "_dirtyFlag")) { mk = c._dirtyFlag; }
        if (mk != 1.0) { c._dirtyFlag = 1.0; push(dirty, c); }
    }
}
// Repaint just the dirty components in place (their state is unchanged, so no
// fn re-run / re-mount — only re-emit with the eased values), then reassemble.
function _repaintComps(dirty) {
    for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; _paint(c, c._cx, c._cy); c._dirtyFlag = 0.0; }
    _reassembleTree(_root);
    _inst = _root._out; _taps = _root._taps; _drags = _root._drags;
    if (_layered > 0.5) { _submitLayered(dirty); } else { _submit(); }
}

// Split the reassembled tree into a static layer (everything that is NOT in the
// animating set) and a dynamic layer (the animating components' whole subtrees).
// Returns the static instance array and pushes dynamic instances into `dyn`. Each
// instance lands in exactly one layer, so static ∪ dynamic == the full frame.
function _bucketLayers(node, dyn) {
    if (node.kind == "comp") {
        if (has(node, "_animLayer")) { if (node._animLayer > 0.5) {
            for (let i = 0; i < len(node._out); i++) { push(dyn, node._out[i]); }
            return [];
        } }
        return _bucketLayers(node._sub, dyn);
    }
    let kids = node._kids;
    if (len(kids) == 0) { return node._out; }
    let s = concat([], node._self);
    for (let i = 0; i < len(kids); i++) { s = concat(s, _bucketLayers(kids[i], dyn)); }
    if (has(node, "_over")) { s = concat(s, node._over); }
    return s;
}
// Re-emit the whole tree with the current theme (no fn re-run), used while the
// light/dark cross-fade is in flight since it recolors every component.
function _repaintAll() {
    _paint(_root, _vw * 0.5, _vh * 0.5);
    _inst = _root._out; _taps = _root._taps; _drags = _root._drags;
    _submit();
}

// --------------------------------------------------------------- render -------
function _bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }
// The responsive layout unit (1% of the *shorter* viewport side). Widgets are
// sized in these units, and the apps lay content out to roughly 90 of them wide;
// deriving the unit from the shorter side keeps that content inside the screen in
// *both* orientations — on a tall phone the width governs (so nothing overflows
// horizontally), on a wide desktop the height governs (the prior behaviour).
function _unit() { return min(_vw, _vh) * 0.01; }
function _renderApp() {
    let si = askHost("gpu.surfaceInfo", []);
    _vw = num(si.width); _vh = num(si.height); _u = _unit();
    _hasKey = 0.0; _hasWheel = 0.0; _hasFocusInput = 0.0;
    _mount(_root, _NULL);
    _paint(_root, _vw * 0.5, _vh * 0.5);
    _inst = _root._out; _taps = _root._taps; _drags = _root._drags;
    _submit();
}
function _repaint() { _renderApp(); }
function _submit() {
    let bg = _colorBg();
    let res = concat(_pipelineResources(), [
        _bufF32("elpa.m3.globals", ["UNIFORM", "COPY_DST"], [_vw, _vh, 0.0, 0.0]),
        { kind: "bindGroup", id: "elpa.m3.gb", layout: "elpa.m3.bgl",
          entries: [{ binding: 0, resource: { type: "buffer", buffer: "elpa.m3.globals" } }] },
        // The instance buffer is re-declared every frame with fresh geometry.
        // Marking it COPY_DST lets the renderer's resource cache refill the same
        // GPU allocation in place (a queue write) whenever the instance *count*
        // is unchanged — the steady state while animating — instead of freeing
        // and reallocating a buffer each frame.
        _bufF32("elpa.m3.inst", ["VERTEX", "COPY_DST"], _inst),
    ]);
    askHost("gpu.submit", [{
        resources: res,
        commands: [{ op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
                { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(_inst) / 16, first_vertex: 0, first_instance: 0 },
            ] }],
    }]);
}

// Submit a layered frame: a cached "static" buffer (non-animating widgets, whose
// bytes are unchanged frame to frame → the renderer skips re-uploading it) plus a
// small "dynamic" buffer (the animating components), drawn back-to-back with the
// shared pipeline. Falls back to a single buffer when nothing is animating.
function _submitLayered(animating) {
    for (let i = 0; i < len(animating); i++) { let c = animating[i]; c._animLayer = 1.0; }
    let dyn = [];
    let stat = _bucketLayers(_root, dyn);
    for (let i = 0; i < len(animating); i++) { let c = animating[i]; c._animLayer = 0.0; }
    if (len(dyn) < 1) { _submit(); return 0; }

    let bg = _colorBg();
    let res = concat(_pipelineResources(), [
        _bufF32("elpa.m3.globals", ["UNIFORM", "COPY_DST"], [_vw, _vh, 0.0, 0.0]),
        { kind: "bindGroup", id: "elpa.m3.gb", layout: "elpa.m3.bgl",
          entries: [{ binding: 0, resource: { type: "buffer", buffer: "elpa.m3.globals" } }] },
        _bufF32("elpa.m3.inst.static", ["VERTEX", "COPY_DST"], stat),
        _bufF32("elpa.m3.inst.dyn", ["VERTEX", "COPY_DST"], dyn),
    ]);
    askHost("gpu.submit", [{
        resources: res,
        commands: [{ op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
                { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst.static", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(stat) / 16, first_vertex: 0, first_instance: 0 },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst.dyn", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(dyn) / 16, first_vertex: 0, first_instance: 0 },
            ] }],
    }]);
    return 0;
}

// ------------------------------------------------------------- event loop -----
// Pan any scrollable viewport under (px,py) by `delta` px; returns whether one
// consumed the gesture. Scrollables register their viewport each paint in
// `_listRegions`, keyed by id, so a stale entry simply never matches.
function _scrollBy(px, py, delta) {
    let ids = keys(_listRegions); let handled = 0.0;
    for (let i = 0; i < len(ids); i++) {
        let id = ids[i]; let rg = _listRegions[id];
        if (rg.maxOff > 0.5) { if (_inRect(px, py, rg.cx, rg.cy, rg.hw, rg.hh)) {
            let off = 0.0; if (has(_scroll, id)) { off = _scroll[id]; }
            off = off + delta; if (off < 0.0) { off = 0.0; } if (off > rg.maxOff) { off = rg.maxOff; }
            _scroll[id] = off; handled = 1.0;
        } }
    }
    return handled;
}
function _scrollIdAt(px, py) {
    let ids = keys(_listRegions);
    for (let i = 0; i < len(ids); i++) {
        let id = ids[i]; let rg = _listRegions[id];
        if (rg.maxOff > 0.5) { if (_inRect(px, py, rg.cx, rg.cy, rg.hw, rg.hh)) { return id; } }
    }
    return "";
}
function onEvent(e) {
    let et = e.type; let px = e.nx * _vw; let py = e.ny * _vh;
    if (et == "pointermove") { _hx = px; _hy = py; }
    if (et == "pointerdown") {
        // A new touch always halts any in-flight momentum (catch-to-stop).
        _flingId = ""; _flingV = 0.0;
        let hit = 0.0;
        for (let i = 0; i < len(_taps); i++) {
            let t = _taps[i];
            if (_inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { _press[t.id] = 1.0; t.onTap(); hit = 1.0; }
        }
        for (let i = 0; i < len(_drags); i++) {
            let d = _drags[i];
            if (_inRect(px, py, d.cx, d.cy, d.hw, d.hh)) { _dragging = 1.0; _activeDrag = d; d.onDrag(px); hit = 1.0; }
        }
        if (hit < 0.5) {
            let sid = _scrollIdAt(px, py);
            if (len(sid) > 0) { _scrollDragOn = 1.0; _scrollDragId = sid; _scrollDragY = py; _scrollVel = 0.0; }
            else { if (_focused != 0) { _focused = 0; } _repaint(); }
        }
    }
    if (et == "pointermove") {
        if (_scrollDragOn > 0.5) {
            let dy = _scrollDragY - py;
            _scrollBy(px, _scrollDragY, dy);
            // Track a smoothed finger velocity so release can keep the list moving.
            _scrollVel = _scrollVel * 0.55 + dy * 0.45;
            _scrollDragY = py; _repaint();
        }
        else { if (_dragging > 0.5) { _activeDrag.onDrag(px); } else { _repaint(); } }
    }
    if (et == "pointerup") {
        // On release, hand the gesture to a momentum fling if it was moving fast
        // enough — the list keeps scrolling and decelerates smoothly instead of
        // stopping dead under the finger.
        if (_scrollDragOn > 0.5) {
            if (abs(_scrollVel) > 0.6) { _flingId = _scrollDragId; _flingV = _scrollVel; }
        }
        _dragging = 0.0; _scrollDragOn = 0.0; _repaint();
    }
    if (et == "wheel") {
        let h = _scrollBy(px, py, e.deltaY);
        if (h > 0.5) { _repaint(); } else { if (_hasWheel > 0.5) { _wheelFn(e.deltaY); } }
    }
    if (et == "keydown") {
        if (_hasFocusInput > 0.5) { _focusInput(e.key); }
        else { if (_hasKey > 0.5) { _keyHandler(e.key); } }
    }
    if (et == "keyup") { _repaint(); }
}
// Advance one momentum-scroll step: move the flung list by the current velocity,
// decelerate it, and stop when it slows below a threshold or reaches an edge.
// Returns whether a fling is still active (so the frame knows to repaint).
function _flingStep() {
    if (len(_flingId) == 0) { return 0.0; }
    if (!has(_listRegions, _flingId)) { _flingId = ""; _flingV = 0.0; return 0.0; }
    let rg = _listRegions[_flingId];
    let off = 0.0; if (has(_scroll, _flingId)) { off = _scroll[_flingId]; }
    off = off + _flingV;
    let edge = 0.0;
    if (off <= 0.0) { off = 0.0; edge = 1.0; }
    if (off >= rg.maxOff) { off = rg.maxOff; edge = 1.0; }
    _scroll[_flingId] = off;
    _flingV = _flingV * 0.93;            // friction
    if (edge > 0.5) { _flingV = 0.0; _flingId = ""; return 1.0; }
    if (abs(_flingV) < 0.4) { _flingV = 0.0; _flingId = ""; }
    return 1.0;
}
function onFrame(dt) {
    // Advance animations; collect the components whose keys are still moving, then
    // repaint *only those* (idle frames cost nothing). The theme cross-fade is the
    // one exception: it recolors everything, so it repaints the whole tree.
    let themeMoving = 0.0;
    let nd = _darkAnim + (_darkTarget - _darkAnim) * 0.18;
    if (abs(nd - _darkAnim) > 0.0005) { themeMoving = 1.0; }
    _darkAnim = nd;
    let dirty = [];
    let ks = keys(_anim);
    for (let i = 0; i < len(ks); i++) {
        let k = ks[i]; let nv = _anim[k] + (_target[k] - _anim[k]) * 0.25;
        if (abs(nv - _anim[k]) > 0.0005) { _markDirty(dirty, k); }
        _anim[k] = nv;
    }
    let ps = keys(_press);
    for (let i = 0; i < len(ps); i++) {
        let k = ps[i]; let np = _press[k] * 0.85;
        if (np < 0.002) { np = 0.0; }
        if (np != _press[k]) { _markDirty(dirty, k); }
        _press[k] = np;
    }
    let flinging = _flingStep();
    if (themeMoving > 0.5) {
        for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; }
        _repaintAll();
        return 0;
    }
    // A live fling pans a scroll viewport, so the whole frame is re-laid out (the
    // same path a drag takes); do this before the cheaper per-component repaint.
    if (flinging > 0.5) {
        for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; }
        _repaint();
        return 0;
    }
    if (len(dirty) > 0) { _repaintComps(dirty); }
}
function onResize(info) {
    _vw = num(info.width); _vh = num(info.height); _u = _unit();
    _renderApp();
}
