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
// A 1x1 placeholder pixel (RGBA #F4F4F6FF) shown until real pixels land,
// pre-encoded as base64 (the VM JS subset has no base64 encoder).
let IMG_PLACEHOLDER = "9PT2/w==";

// ---- small shared helpers (pure functions, no state) -------------------------
function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
function sel(a, b) { if (a == b) { return 1.0; } return 0.0; }
function inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}
