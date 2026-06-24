// Elpa Flutter — shared data (shaders, glyph font, constants).
//
// This is a *faithful, layered* port of Flutter onto Elpa. Where the sibling
// `material` kit fuses measure + paint into one Widget pass, this SDK mirrors
// Flutter's actual architecture, bottom-to-top, each layer a separate module:
//
//   00-data       — this file: the WGSL shaders, the fallback stroke font, and
//                   the constants the raster backend draws with.
//   10-engine     — the raster backend (Flutter's Skia/CanvasKit analog): a
//                   `Painter` that emits the 16-float SDF instances, a host
//                   glyph-atlas `FontEngine`, and the eased-value `Ticker` clock.
//   20-ui         — `dart:ui`: Offset, Size, Rect, Radius, RRect, Color, Paint,
//                   Gradient, Path, Canvas, PictureRecorder. Canvas calls lower
//                   onto the Painter.
//   30-rendering  — the rendering layer: BoxConstraints, RenderObject / RenderBox
//                   (constraints down, sizes up), PaintingContext, the parent-data
//                   protocol, RenderView, and the concrete render boxes
//                   (ConstrainedBox, Padding, Align, Flex, Stack, DecoratedBox,
//                   Paragraph, Transform, Opacity, ClipRRect, PointerListener).
//   40-widget     — the widgets layer: Widget / Element / BuildContext /
//                   BuildOwner, Key, the updateChild + updateChildren
//                   reconciliation, StatelessWidget / StatefulWidget + State,
//                   RenderObjectElement (leaf / single / multi child),
//                   InheritedWidget, ParentDataWidget.
//   50-widgets    — the widget catalog (SizedBox, Padding, Center, Row, Column,
//                   Expanded, Stack, Container, Text, GestureDetector, …) plus a
//                   small Material catalog (Scaffold, AppBar, ElevatedButton, …).
//   60-binding    — WidgetsFlutterBinding + runApp: the build→layout→paint→
//                   composite→submit pipeline, the hit-test gesture dispatch, the
//                   frame scheduler, and the host entry points.
//
// Per-instance data (16 floats): center.xy, halfSize.xy, cornerRadius,
// borderWidth, rotation, feather, fill rgba, border rgba.

// The live surface color-format token. Every render pipeline's color target must
// match the actual surface format (wgpu requires an exact match); the host
// reports it via gpu.surfaceInfo and the binding refreshes this global each frame
// before any pipeline is built, so prebuilt bytecode adapts to whatever surface
// it is deployed onto. Defaults to bgra8unorm for the headless/test backend.
let SURFACE_FMT = "bgra8unorm";

// ----------------------------------------------------------------- shader -----
// One pipeline draws the whole frame: a rounded-rect signed-distance field, or —
// when bcol.x > 1.5 — a glyph quad that samples the font coverage atlas. This is
// the same primitive Flutter's Skia backend reduces most UI to (rects, rrects,
// lines-as-capsules, glyph quads), expressed as one instanced SDF draw.
let SDF_WGSL = "
struct Globals { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> g: Globals;

struct In {
    @location(0) a: vec4<f32>,
    @location(1) b: vec4<f32>,
    @location(2) fill: vec4<f32>,
    @location(3) bcol: vec4<f32>,
    @location(4) clip: vec4<f32>,
    @location(5) clip2: vec4<f32>,
};
struct Out {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) p: vec2<f32>,
    @location(1) @interpolate(flat) half: vec2<f32>,
    @location(2) @interpolate(flat) params: vec2<f32>,
    @location(3) @interpolate(flat) fill: vec4<f32>,
    @location(4) @interpolate(flat) bcol: vec4<f32>,
    @location(5) @interpolate(flat) feather: f32,
    @location(6) uv: vec2<f32>,
    @location(7) @interpolate(flat) glyph: f32,
    @location(8) world: vec2<f32>,
    @location(9) @interpolate(flat) clipc: vec4<f32>,
    @location(10) @interpolate(flat) clipp: vec2<f32>,
};

@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@vertex
fn vs(@builtin(vertex_index) vi: u32, in: In) -> Out {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let isGlyph = in.bcol.x > 1.5;
    let half = in.a.zw;
    let local = corners[vi] * half;
    var rot = 0.0;
    if (!isGlyph) { rot = in.b.z; }
    let cr = cos(rot);
    let sr = sin(rot);
    let rotated = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
    let world = in.a.xy + rotated;
    let ndc = vec2<f32>(world.x / g.viewport.x * 2.0 - 1.0, 1.0 - world.y / g.viewport.y * 2.0);
    var o: Out;
    o.clip_pos = vec4<f32>(ndc, 0.0, 1.0);
    o.p = local;
    o.half = half;
    o.params = in.b.xy;
    o.fill = in.fill;
    o.bcol = in.bcol;
    o.feather = in.b.w;
    let cuv = corners[vi] * 0.5 + vec2<f32>(0.5, 0.5);
    o.uv = mix(in.b.xy, in.b.zw, cuv);
    o.glyph = select(0.0, 1.0, isGlyph);
    o.world = world;
    o.clipc = in.clip;
    o.clipp = vec2<f32>(in.clip2.x, in.clip2.y);
    return o;
}

fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
    let tex = textureSample(atlas, samp, o.uv).r;
    var outc: vec4<f32>;
    if (o.glyph > 0.5) {
        outc = vec4<f32>(o.fill.rgb, o.fill.a * tex);
    } else {
        let r = min(o.params.x, min(o.half.x, o.half.y));
        let d = sd_round_box(o.p, o.half, r);
        let f = max(o.feather, 0.75);
        let cov = clamp(0.5 - d / f, 0.0, 1.0);
        let inner = d + o.params.y;
        let icov = clamp(0.5 - inner / f, 0.0, 1.0);
        let col = mix(o.bcol, o.fill, icov);
        outc = vec4<f32>(col.rgb, col.a * cov);
    }
    // Screen-space rounded-rect clip (ClipRect / ClipRRect / scroll viewports).
    if (o.clipp.y > 0.5) {
        let cc = vec2<f32>(o.clipc.x, o.clipc.y);
        let ch = vec2<f32>(o.clipc.z, o.clipc.w);
        let crad = min(o.clipp.x, min(ch.x, ch.y));
        let cd = sd_round_box(o.world - cc, ch, crad);
        let ccov = clamp(0.5 - cd, 0.0, 1.0);
        outc = vec4<f32>(outc.rgb, outc.a * ccov);
    }
    return outc;
}
";

// A vector stroke font: each glyph is line segments [x0,y0,x1,y1] in a 4-wide ×
// 6-tall box (origin top-left, y down), drawn as overlapping rounded capsules.
// Used only as the fallback when no host font atlas is available.
let GLYPHS = {
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
    "-": [[0.6,3.0,3.4,3.0]],
    "%": [[3.4,0.4,0.6,5.6],[0.8,0.5,1.6,1.3],[2.4,4.7,3.2,5.5]],
    "!": [[2.0,0.2,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "?": [[0.6,1.4,1.9,0.3],[1.9,0.3,3.2,1.4],[3.2,1.4,2.0,3.0],[2.0,3.0,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "#": [[1.3,0.2,0.8,5.8],[3.0,0.2,2.5,5.8],[0.4,2.1,3.6,2.1],[0.4,3.9,3.6,3.9]],
    " ": [],
};

// Shared colour constants.
// The VM compares objects with `==` *structurally* (deep), which would recurse
// forever on the render/element graph (parent↔child cycles). So heap nodes carry
// a unique id and we compare *identity* via `sameRef` — Flutter's `identical()`.
let NEXT_OBJ_ID = 0;
function nextObjId() { NEXT_OBJ_ID = NEXT_OBJ_ID + 1; return NEXT_OBJ_ID; }
// `has` only accepts objects, so guard against functions / arrays / primitives
// (e.g. comparing two animation-listener closures by identity in `sameRef`).
function hasId(x) { if (isNull(x)) { return false; } if (x == 0) { return false; } if (typeOf(x) != "object") { return false; } if (has(x, "_id")) { return true; } return false; }
// Reference identity: both have ids → compare ids; otherwise fall back to a
// primitive `==` (safe: never deep-compares two cyclic objects).
function sameRef(a, b) {
    let ai = hasId(a); let bi = hasId(b);
    if (ai) { if (bi) { if (a._id == b._id) { return true; } return false; } return false; }
    if (bi) { return false; }
    if (a == b) { return true; }
    return false;
}

let WHITE = [1.0, 1.0, 1.0, 1.0];
let BLACK = [0.0, 0.0, 0.0, 1.0];
let CLEAR = [0.0, 0.0, 0.0, 0.0];
let TRANSPARENT = [0.0, 0.0, 0.0, 0.0];

// ---- small shared helpers (pure functions, no state) -------------------------
function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
// Linear-interpolate two scalars / rgba colours.
function lerpD(a, b, t) { return a + (b - a) * t; }
function lerpCol(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
function inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}
