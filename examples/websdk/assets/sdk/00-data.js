// Elpa Material Design 3 SDK — shared data (shaders, glyph font, palettes).
//
// This module holds the *static data* the engine draws with: the two WGSL
// shaders (the rounded-rect SDF pipeline that draws the whole UI, and the
// textured-quad pipeline for images/video), the fallback stroke-vector glyph
// font, the M3 tonal accent palettes, and a few shared constants. It declares
// no behaviour — the engine classes in the following modules consume it.
//
// The SDK is built from small, single-responsibility modules concatenated ahead
// of an app (see `lib.rs`), exactly like a Flutter app `import`s
// `package:flutter/material.dart`. Architecture, in dependency order:
//
//   00-data      — this file: shaders, font, palettes, constants.
//   10-engine    — Painter, Theme, Metrics, FontEngine, IconEngine, MediaEngine,
//                  AnimationClock: the drawing/þeming/layout-metrics services.
//   20-widget    — the Widget base class (measure/paint/compose protocol).
//   30-widgets-* — the widget catalog, each widget a Widget subclass.
//   40-runtime   — Component + Material: the retained-tree runtime, event loop,
//                  animation clock and `gpu.submit` frame builder.
//   50-api       — the public widget constructors, `runApp`/`defineComponent`,
//                  the platform-service wrappers and the host entry points,
//                  delegating to the single `Material` instance `M`.
//
// Per-instance data (16 floats): center.xy, halfSize.xy, cornerRadius,
// borderWidth, rotation, feather, fill rgba, border rgba.

// The live surface color-format token. Every render pipeline's color target and
// every offscreen scene texture must match the actual surface format (wgpu
// requires an exact match), and that format is only known at run time — the
// browser/desktop surface may be `bgra8unorm` or an `*-srgb` variant. The host
// reports it via `gpu.surfaceInfo`; `Metrics.setMetrics` refreshes this global
// each frame before any pipeline is built, so prebuilt bytecode adapts to
// whatever surface it is deployed onto (replacing the old build-time string
// patch of the JS source, which prebuilt bytecode cannot do). Defaults to
// `bgra8unorm` for the headless/test backend.
let SURFACE_FMT = "bgra8unorm";

// ----------------------------------------------------------------- shader -----
let SDF_WGSL = "
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
    @location(6) uv: vec2<f32>,
    @location(7) @interpolate(flat) glyph: f32,
};

// One pipeline draws everything. A 'glyph' instance (flagged by bcol.x > 1.5)
// repurposes the b vector as an atlas UV rect (u0,v0,u1,v1) and samples the font
// coverage atlas; every other instance is the rounded-rect SDF as before.
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
    o.clip = vec4<f32>(ndc, 0.0, 1.0);
    o.p = local;
    o.half = half;
    o.params = in.b.xy;
    o.fill = in.fill;
    o.bcol = in.bcol;
    o.feather = in.b.w;
    let cuv = corners[vi] * 0.5 + vec2<f32>(0.5, 0.5);
    o.uv = mix(in.b.xy, in.b.zw, cuv);
    o.glyph = select(0.0, 1.0, isGlyph);
    return o;
}

fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
    // Sampled in uniform control flow (WGSL requirement), used only for glyphs.
    let tex = textureSample(atlas, samp, o.uv).r;
    if (o.glyph > 0.5) {
        return vec4<f32>(o.fill.rgb, o.fill.a * tex);
    }
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

// A second pipeline that draws one full-colour textured quad per image/video
// frame, with rounded-corner coverage and a tint. It is intentionally separate
// from the SDF pipeline (different binding layout: a per-image uniform + an RGBA
// texture), and is invoked between SDF sub-draws so images respect paint order.
let IMG_WGSL = "
struct U { a: vec4<f32>, b: vec4<f32>, uv: vec4<f32>, tint: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) p: vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> Out {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let half = u.b.xy;
    let local = corners[vi] * half;
    let world = u.a.zw + local;
    let ndc = vec2<f32>(world.x / u.a.x * 2.0 - 1.0, 1.0 - world.y / u.a.y * 2.0);
    var o: Out;
    o.clip = vec4<f32>(ndc, 0.0, 1.0);
    let cuv = corners[vi] * 0.5 + vec2<f32>(0.5, 0.5);
    o.uv = mix(u.uv.xy, u.uv.zw, cuv);
    o.p = local;
    return o;
}
fn sd_round_box_i(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}
@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
    let c = textureSample(tex, samp, o.uv);
    let r = min(u.b.z, min(u.b.x, u.b.y));
    let d = sd_round_box_i(o.p, u.b.xy, r);
    let cov = clamp(0.5 - d / 1.0, 0.0, 1.0);
    let col = c * u.tint;
    return vec4<f32>(col.rgb, col.a * cov);
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
    "%": [[3.4,0.4,0.6,5.6],[0.8,0.5,1.6,1.3],[2.4,4.7,3.2,5.5]],
    "!": [[2.0,0.2,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "?": [[0.6,1.4,1.9,0.3],[1.9,0.3,3.2,1.4],[3.2,1.4,2.0,3.0],[2.0,3.0,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "$": [[3.3,1.1,2.2,0.4],[2.2,0.4,1.0,0.8],[1.0,0.8,0.7,1.9],[0.7,1.9,1.8,2.7],[1.8,2.7,2.6,3.2],[2.6,3.2,3.4,4.2],[3.4,4.2,2.6,5.4],[2.6,5.4,1.4,5.7],[1.4,5.7,0.5,4.8],[2.0,-0.4,2.0,6.4]],
    "#": [[1.3,0.2,0.8,5.8],[3.0,0.2,2.5,5.8],[0.4,2.1,3.6,2.1],[0.4,3.9,3.6,3.9]],
    " ": [],
};

// Path-grammar lookups for the SVG icon parser (digits, command letters).
let SVG_DIGITS = { "0": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1 };
let SVG_PATHCMD = { M: 1, m: 1, L: 1, l: 1, H: 1, h: 1, V: 1, v: 1, C: 1, c: 1, Q: 1, q: 1, S: 1, s: 1, T: 1, t: 1, A: 1, a: 1, Z: 1, z: 1 };

// M3 tonal accent palette (primary tone for light / dark schemes): purple (the
// M3 default), teal, green, pink — the hues ColorScheme.fromSeed yields.
let ACC_LIGHT = [[0.404,0.314,0.643],[0.000,0.416,0.416],[0.220,0.416,0.125],[0.596,0.251,0.380]];
let ACC_DARK  = [[0.816,0.737,1.000],[0.306,0.847,0.859],[0.616,0.839,0.490],[1.000,0.694,0.784]];

// Shared colour constants and media sentinels.
let WHITE = [1.0, 1.0, 1.0, 1.0];
let CLEAR = [0.0, 0.0, 0.0, 0.0];
let IMG_MARK = 424242.0;            // sentinel marker in instance slot 0 (off-screen, unique)
let BACKDROP_MARK = 525252.0;       // backdrop-blur sentinel marker in instance slot 0
let BD_SCALE = 2.0;                 // backdrop blur source captured at 1/BD_SCALE resolution
// A 1x1 placeholder pixel (RGBA #F4F4F6FF) shown until real pixels land,
// pre-encoded as base64 (the VM JS subset has no base64 encoder).
let IMG_PLACEHOLDER = "9PT2/w==";

// ---- small shared helpers (pure functions, no state) -------------------------
function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
// Linear-interpolate two rgba colours.
function lerpCol(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
// Build a normalised stop list `[{ t, col }]` from a gradient's `colors` (rgba
// arrays) and optional `stops` (positions in [0,1]); even spacing if absent.
function gradStops(colors, stops) {
    let n = len(colors); let out = [];
    for (let i = 0; i < n; i++) {
        let t = 0.0; if (n > 1) { t = num(i) / (n - 1.0); }
        if (stops != 0) { if (i < len(stops)) { t = stops[i]; } }
        push(out, { t: t, col: colors[i] });
    }
    return out;
}
// Sample a normalised stop list at position `t` (clamped, piecewise-linear).
function gradColorAt(stops, t) {
    let n = len(stops); if (n == 0) { return CLEAR; }
    if (t <= stops[0].t) { return stops[0].col; }
    if (t >= stops[n - 1].t) { return stops[n - 1].col; }
    for (let i = 0; i < n - 1; i++) {
        let a = stops[i]; let b = stops[i + 1];
        if (t >= a.t) { if (t <= b.t) {
            let span = b.t - a.t; let f = 0.0; if (span > 0.0001) { f = (t - a.t) / span; }
            return lerpCol(a.col, b.col, f);
        } }
    }
    return stops[n - 1].col;
}
function sel(a, b) { if (a == b) { return 1.0; } return 0.0; }
function inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}

// ============================================================================
// Elpa Web SDK additions — CSS static data.
//
// The Web SDK layers an HTML element model + a CSS box/layout/paint system on
// top of the same instanced SDF pipeline. This block holds the *static* CSS
// data: the named-colour table (CSS Color Module Level 4 keywords, stored as
// hex and resolved by the Style engine's parser) and the property tables that
// drive shorthand expansion and inheritance. No behaviour lives here.
// ============================================================================

// CSS named colours (keyword -> hex). The Style engine's `parseColor` resolves
// a keyword through this table, then through its hex/rgb()/hsl() parsers.
let CSS_COLORS = {
    transparent: "#00000000", currentcolor: "currentColor",
    black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff",
    magenta: "#ff00ff", fuchsia: "#ff00ff", lime: "#00ff00", maroon: "#800000",
    navy: "#000080", olive: "#808000", purple: "#800080", teal: "#008080",
    silver: "#c0c0c0", gray: "#808080", grey: "#808080", orange: "#ffa500",
    aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aquamarine: "#7fffd4",
    azure: "#f0ffff", beige: "#f5f5dc", bisque: "#ffe4c4", blanchedalmond: "#ffebcd",
    blueviolet: "#8a2be2", brown: "#a52a2a", burlywood: "#deb887", cadetblue: "#5f9ea0",
    chartreuse: "#7fff00", chocolate: "#d2691e", coral: "#ff7f50",
    cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
    darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b",
    darkgray: "#a9a9a9", darkgrey: "#a9a9a9", darkgreen: "#006400",
    darkkhaki: "#bdb76b", darkmagenta: "#8b008b", darkolivegreen: "#556b2f",
    darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000",
    darksalmon: "#e9967a", darkseagreen: "#8fbc8f", darkslateblue: "#483d8b",
    darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1",
    darkviolet: "#9400d3", deeppink: "#ff1493", deepskyblue: "#00bfff",
    dimgray: "#696969", dimgrey: "#696969", dodgerblue: "#1e90ff",
    firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22",
    gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700",
    goldenrod: "#daa520", greenyellow: "#adff2f", honeydew: "#f0fff0",
    hotpink: "#ff69b4", indianred: "#cd5c5c", indigo: "#4b0082", ivory: "#fffff0",
    khaki: "#f0e68c", lavender: "#e6e6fa", lavenderblush: "#fff0f5",
    lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6",
    lightcoral: "#f08080", lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2",
    lightgray: "#d3d3d3", lightgrey: "#d3d3d3", lightgreen: "#90ee90",
    lightpink: "#ffb6c1", lightsalmon: "#ffa07a", lightseagreen: "#20b2aa",
    lightskyblue: "#87cefa", lightslategray: "#778899", lightslategrey: "#778899",
    lightsteelblue: "#b0c4de", lightyellow: "#ffffe0", limegreen: "#32cd32",
    linen: "#faf0e6", mediumaquamarine: "#66cdaa", mediumblue: "#0000cd",
    mediumorchid: "#ba55d3", mediumpurple: "#9370db", mediumseagreen: "#3cb371",
    mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a",
    mediumturquoise: "#48d1cc", mediumvioletred: "#c71585", midnightblue: "#191970",
    mintcream: "#f5fffa", mistyrose: "#ffe4e1", moccasin: "#ffe4b5",
    navajowhite: "#ffdead", oldlace: "#fdf5e6", olivedrab: "#6b8e23",
    orangered: "#ff4500", orchid: "#da70d6", palegoldenrod: "#eee8aa",
    palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093",
    papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb",
    plum: "#dda0dd", powderblue: "#b0e0e6", rosybrown: "#bc8f8f",
    royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072",
    sandybrown: "#f4a460", seagreen: "#2e8b57", seashell: "#fff5ee",
    sienna: "#a0522d", skyblue: "#87ceeb", slateblue: "#6a5acd",
    slategray: "#708090", slategrey: "#708090", snow: "#fffafa",
    springgreen: "#00ff7f", steelblue: "#4682b4", tan: "#d2b48c", thistle: "#d8bfd8",
    tomato: "#ff6347", turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3",
    whitesmoke: "#f5f5f5", yellowgreen: "#9acd32", rebeccapurple: "#663399"
};

// Properties that inherit by default in CSS (used by the Style engine).
let CSS_INHERITED = {
    color: 1, font: 1, fontSize: 1, fontFamily: 1, fontWeight: 1, fontStyle: 1,
    lineHeight: 1, letterSpacing: 1, wordSpacing: 1, textAlign: 1,
    textTransform: 1, textIndent: 1, whiteSpace: 1, visibility: 1,
    listStyleType: 1, listStyle: 1, cursor: 1, direction: 1, textDecoration: 0
};

// Hex digit -> value, for the colour parser (the JS subset has no parseInt 16).
let HEX_VAL = { "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
    "8": 8, "9": 9, a: 10, b: 11, c: 12, d: 13, e: 14, f: 15,
    A: 10, B: 11, C: 12, D: 13, E: 14, F: 15 };

// Numeric type test: the VM types integers as "i64" and reals as "f64"/"f32",
// so `typeOf(x) == "number"` is never true - use this instead.
function isNum(v) { let t = typeOf(v); if (t == "f64") { return 1.0; } if (t == "i64") { return 1.0; } if (t == "f32") { return 1.0; } return 0.0; }
