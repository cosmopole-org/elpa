// Elpa Flutter — shared data (shaders, glyph font, constants).
//
// This is a *faithful, layered* port of Flutter onto Elpa. Where the sibling
// `material` kit fuses measure + paint into one Widget pass, this SDK mirrors
// Flutter's actual architecture, bottom-to-top, each layer a separate module:
//
//   00-data       — this file: the vector stroke font and the constants the
//                   paint backend draws with.
//   10-engine     — the paint backend (Flutter's Skia/CanvasKit analog): a
//                   `Painter` that records a Vello scene (vector ops), a
//                   vector-glyph `FontEngine`, and the eased-value `Ticker` clock.
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
// match the actual surface format. Retained as a harmless default for any host
// that still queries it; the Vello backend owns the surface format itself.
let SURFACE_FMT = "bgra8unorm";

// NOTE: this kit now draws through the **Vello scene** path (`scene.submit`) — a
// batch of high-level vector ops (fills, strokes, clip/blend layers) the host
// rasterizes with Vello. The old single-pass SDF wgpu shader is gone: rounded
// rects, capsules and glyph strokes are now real Vello paths, not one instanced
// SDF draw. (Raw wgpu survives elsewhere as the `rawWgpu` scene op.)

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
