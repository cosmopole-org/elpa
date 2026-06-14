// Elpa Material Design 3 SDK — a small Flutter-style widget framework in JS.
//
// This file is the SDK. It is *linked ahead of* an app (see `demo.js`) into one
// program, exactly like a Flutter app `import`s `package:flutter/material.dart`:
// the app calls the widget constructors and `runApp` defined here and never
// touches the GPU. Everything below — the rounded-rect SDF pipeline, the glyph
// font, the responsive layout coordinator, the per-widget colors/sizes, the
// component runtime, and the event plumbing that ends in `gpu.submit` — lives in
// the SDK as a black box.
//
// Architecture
// ------------
// * Widgets are immutable description objects (`{ kind, ...props }`), like
//   Flutter `Widget`s. Constructors (`FilledButton`, `Switch`, `Column`, ...)
//   just build them.
// * Components are plain functions `(update) => widget`, React-style: you call
//   them to get a subtree. `update` re-runs the app and re-submits its graphics,
//   so a tap handler calls `update()` to repaint — the only "setState" you need.
//   `runApp(root)` mounts the root component function and re-invokes it every
//   render, so nested component functions re-run too (no `createComponent`, no
//   reconciler — the tree the root returns is already concrete).
// * The runtime walks that tree each frame: `_measure` computes intrinsic sizes,
//   `_paint` lays children out and emits rounded-rect instances + hit regions.
//   `_submit` turns the instance list into one wgpu frame. The app supplies no
//   coordinates and no draw calls.
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

// The shared resource set (one shader + pipeline). The "bgra8unorm" token is
// rewritten by the web host to the live surface format.
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
    "-": [[1.0,3.0,3.0,3.0]],
};

// ----------------------------------------------------------- runtime state ----
let _vw = 1.0; let _vh = 1.0; let _u = 1.0;   // viewport + 1% unit
let _root = 0;                                 // root component
let _inst = [];                                // per-frame instance floats
let _taps = []; let _drags = [];               // per-frame hit regions
let _dragging = 0.0; let _activeDrag = 0;      // active slider drag
let _hx = -1000.0; let _hy = -1000.0;          // hover pointer
let _keyHandler = 0; let _hasKey = 0.0;        // app key handler (per frame)
let _wheelFn = 0; let _hasWheel = 0.0;         // app wheel handler (per frame)
let _darkTarget = 0.0; let _darkAnim = 0.0;    // theme
let _accent = 0;                               // accent index
let _anim = {}; let _target = {};              // eased 0..1 values by key
let _press = {};                               // press state layers by key
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

// Repaint: re-run the app's component tree and re-submit its wgpu frame. This is
// the `update` passed to every component, so a handler can request a repaint —
// the only "setState" you need.
function _repaint() { _renderApp(); }

// Mount the root component — a plain function `(update) => widget`, React-style —
// and paint the first frame. Custom widgets are just such functions; call them
// (passing `update` if they need it) and return their widget tree.
function runApp(root) { _root = root; _renderApp(); }

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
function _rect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
    push(_inst, cx); push(_inst, cy); push(_inst, hw); push(_inst, hh);
    push(_inst, r); push(_inst, border); push(_inst, rot); push(_inst, 1.0);
    push(_inst, fill[0]); push(_inst, fill[1]); push(_inst, fill[2]); push(_inst, fill[3]);
    push(_inst, bcol[0]); push(_inst, bcol[1]); push(_inst, bcol[2]); push(_inst, bcol[3]);
}
function _shadow(cx, cy, hw, hh, r, grow, drop, blur) {
    push(_inst, cx); push(_inst, cy + drop); push(_inst, hw + grow); push(_inst, hh + grow);
    push(_inst, r + grow); push(_inst, 0.0); push(_inst, 0.0); push(_inst, blur);
    push(_inst, 0.0); push(_inst, 0.0); push(_inst, 0.0); push(_inst, 0.28);
    push(_inst, 0.0); push(_inst, 0.0); push(_inst, 0.0); push(_inst, 0.0);
}
function _paintText(str, cx, cy, cell, col) {
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

// ---------------------------------------------------------- sizing / cells ----
function _cell(size) {
    if (size == "title") { return _u * 0.55; }
    if (size == "label") { return _u * 0.40; }
    if (size == "caption") { return _u * 0.32; }
    return _u * 0.40;
}
function _textW(str, cell) { return len(str) * 5.0 * cell; }
function _btnW(label) { return _textW(label, _cell("label")) + _u * 8.0; }
function _chipW(label) { return _textW(label, _cell("caption")) + _u * 7.0; }
function _gapPx(node) { if (has(node, "gap")) { return node.gap * _u; } return _u * 2.0; }

function _hover(cx, cy, hw, hh) { if (_inRect(_hx, _hy, cx, cy, hw, hh)) { return 1.0; } return 0.0; }
function _pressVal(id) { if (has(_press, id)) { return _press[id]; } return 0.0; }
function _ease(key, target) {
    _target[key] = target;
    if (has(_anim, key)) { return _anim[key]; }
    _anim[key] = target; return target;
}
function _addTap(cx, cy, hw, hh, id, onTap) { push(_taps, { cx: cx, cy: cy, hw: hw, hh: hh, id: id, onTap: onTap }); }
function _inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}

// ------------------------------------------------------------- measure --------
function _measure(node) {
    let k = node.kind;
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

// --------------------------------------------------------------- paint --------
function _paint(node, cx, cy) {
    let k = node.kind;
    if (k == "column") { _paintColumn(node, cx, cy); return 0; }
    if (k == "row") { _paintRow(node, cx, cy); return 0; }
    if (k == "card") { _paintCard(node, cx, cy); return 0; }
    if (k == "scaffold") { _paintScaffold(node); return 0; }
    if (k == "text") { _paintText(node.text, cx, cy, _cell(node.size), _textInk(node)); return 0; }
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
    return 0;
}
function _textInk(node) {
    if (has(node, "ink")) {
        if (node.ink == "accent") { return _acc(1.0); }
        if (node.ink == "onAccent") { return _onAcc(0.98); }
    }
    return _onSurface(1.0);
}
function _paintColumn(node, cx, cy) {
    let mz = _measure(node); let gap = _gapPx(node); let top = cy - mz.h / 2.0; let nc = len(node.children);
    for (let i = 0; i < nc; i++) {
        let ch = _measure(node.children[i]); _paint(node.children[i], cx, top + ch.h / 2.0); top = top + ch.h + gap;
    }
}
function _paintRow(node, cx, cy) {
    let mz = _measure(node); let gap = _gapPx(node); let left = cx - mz.w / 2.0; let nc = len(node.children);
    for (let i = 0; i < nc; i++) {
        let cw = _measure(node.children[i]); _paint(node.children[i], left + cw.w / 2.0, cy); left = left + cw.w + gap;
    }
}
function _paintCard(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = _u * 1.6;
    _shadow(cx, cy, hw, hh, r, _u * 0.4, _u * 1.0, _u * 2.8);
    _rect(cx, cy, hw, hh, r, 0.0, 0.0, _surfaceContainer(1.0), _CLEAR);
    _paint(node.child, cx, cy);
}
function _paintScaffold(node) {
    let aH = _u * 10.0;
    if (has(node, "onKey")) { _keyHandler = node.onKey; _hasKey = 1.0; }
    if (has(node, "appBar")) { _paintAppBar(node.appBar, aH); }
    if (has(node, "body")) { _paint(node.body, _vw / 2.0, aH + (_vh - aH) / 2.0); }
    if (has(node, "fab")) { _paint(node.fab, _vw - _u * 9.0, _vh - _u * 9.0); }
}
function _paintAppBar(node, aH) {
    let cy = aH / 2.0;
    _rect(_vw / 2.0, cy, _vw / 2.0, aH / 2.0, 0.0, 0.0, 0.0, _acc(1.0), _CLEAR);
    let lineCx = _u * 6.0; let lw = _u * 2.0; let lh = _u * 0.4; let sp = _u * 1.3;
    _rect(lineCx, cy - sp, lw, lh, lh, 0.0, 0.0, _onAcc(0.95), _CLEAR);
    _rect(lineCx, cy, lw, lh, lh, 0.0, 0.0, _onAcc(0.95), _CLEAR);
    _rect(lineCx, cy + sp, lw, lh, lh, 0.0, 0.0, _onAcc(0.95), _CLEAR);
    _rect(_vw - _u * 6.0, cy, _u * 2.6, _u * 2.6, _u * 2.6, 0.0, 0.0, _onAcc(0.9), _CLEAR);
    _paintText(node.title, _vw / 2.0, cy, _cell("title"), _onAcc(0.98));
}
function _paintFilled(node, cx, cy) {
    let mz = _measure(node); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
    let st = _hover(cx, cy, hw, hh) * 0.08 + _pressVal(node.id) * 0.12;
    _shadow(cx, cy, hw, hh, hh, _u * 0.2, _u * 0.6, _u * 1.8);
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
    _rect(cx, cy, _u * 31.0, _u * 0.18, 0.0, 0.0, 0.0, _outlineVar(1.0), _CLEAR);
}
function _addDrag(cx, cy, hw, hh, onChanged, left, width) {
    push(_drags, { cx: cx, cy: cy, hw: hw, hh: hh,
        onDrag: (px) => { onChanged(clamp01((px - left) / width)); } });
}
function _registerWheel(onChanged, val) {
    _wheelFn = (dy) => { onChanged(clamp01(val + dy * (-0.0015))); };
    _hasWheel = 1.0;
}

// --------------------------------------------------------------- render -------
// Custom components are plain functions invoked eagerly (React-style), so the
// tree the root returns is already concrete widget objects — no expansion pass.
function _bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }
function _renderApp() {
    let si = askHost("gpu.surfaceInfo", []);
    _vw = num(si.width); _vh = num(si.height); _u = _vh * 0.01;
    _inst = []; _taps = []; _drags = [];
    _hasKey = 0.0; _hasWheel = 0.0;
    _paint(_root(_repaint), _vw * 0.5, _vh * 0.5);
    _submit();
}
function _submit() {
    let bg = _colorBg();
    let res = concat(_pipelineResources(), [
        _bufF32("elpa.m3.globals", ["UNIFORM", "COPY_DST"], [_vw, _vh, 0.0, 0.0]),
        { kind: "bindGroup", id: "elpa.m3.gb", layout: "elpa.m3.bgl",
          entries: [{ binding: 0, resource: { type: "buffer", buffer: "elpa.m3.globals" } }] },
        _bufF32("elpa.m3.inst", ["VERTEX"], _inst),
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

// ------------------------------------------------------------- event loop -----
function onEvent(e) {
    let et = e.type; let px = e.nx * _vw; let py = e.ny * _vh;
    if (et == "pointermove") { _hx = px; _hy = py; }
    if (et == "pointerdown") {
        for (let i = 0; i < len(_taps); i++) {
            let t = _taps[i];
            if (_inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { _press[t.id] = 1.0; t.onTap(); }
        }
        for (let i = 0; i < len(_drags); i++) {
            let d = _drags[i];
            if (_inRect(px, py, d.cx, d.cy, d.hw, d.hh)) { _dragging = 1.0; _activeDrag = d; d.onDrag(px); }
        }
        _renderApp();
    }
    if (et == "pointermove") {
        if (_dragging > 0.5) { _activeDrag.onDrag(px); }
        _renderApp();
    }
    if (et == "pointerup") { _dragging = 0.0; _renderApp(); }
    if (et == "wheel") { if (_hasWheel > 0.5) { _wheelFn(e.deltaY); } _renderApp(); }
    if (et == "keydown") { if (_hasKey > 0.5) { _keyHandler(e.key); } _renderApp(); }
    if (et == "keyup") { _renderApp(); }
}
function onFrame(dt) {
    // Advance every animation toward its target; only repaint when something is
    // actually still moving, so idle frames cost nothing (no tree rebuild, no
    // submit — the partial-render cache then keeps the GPU idle too).
    let active = 0.0;
    let nd = _darkAnim + (_darkTarget - _darkAnim) * 0.18;
    if (abs(nd - _darkAnim) > 0.0005) { active = 1.0; }
    _darkAnim = nd;
    let ks = keys(_anim);
    for (let i = 0; i < len(ks); i++) {
        let k = ks[i]; let nv = _anim[k] + (_target[k] - _anim[k]) * 0.25;
        if (abs(nv - _anim[k]) > 0.0005) { active = 1.0; }
        _anim[k] = nv;
    }
    let ps = keys(_press);
    for (let i = 0; i < len(ps); i++) {
        let k = ps[i]; _press[k] = _press[k] * 0.85;
        if (_press[k] < 0.002) { _press[k] = 0.0; }
        if (_press[k] > 0.0) { active = 1.0; }
    }
    if (active > 0.5) { _renderApp(); }
}
function onResize(info) {
    _vw = num(info.width); _vh = num(info.height); _u = _vh * 0.01;
    _renderApp();
}
