// Elpa Liquid Glass SDK — shared data (the glass shader, glyph fallback font,
// palettes, constants).
//
// This module holds the *static data* the engine draws with. The headline is the
// one WGSL pipeline that renders the **entire** Liquid Glass UI — Apple's iOS-26
// "Liquid Glass" material — in a single instanced draw. Every instance is one of
// four kinds, branched on per-fragment:
//
//   kind 0  SOLID   a rounded-rect signed-distance field (fill + border).
//   kind 1  GLYPH   a textured quad sampling the host font coverage atlas.
//   kind 2  GLASS   a liquid-glass lens: it samples the captured backdrop with an
//                   SDF-normal *refraction* displacement (edge lensing), edge-only
//                   *chromatic aberration*, a multi-tap *blur*, a directional
//                   *specular* rim highlight, an inner bevel shade and a tint.
//   kind 3  SHADOW  a soft, feathered drop shadow (grown, dropped, blurred rect).
//
// The glass formula follows real Liquid-Glass implementations: a rounded-box SDF
// decides coverage; the SDF gradient is the surface normal; the backdrop is bent
// along that normal proportionally to edge proximity (a convex-lens magnification
// at the rim); R/B channels are sampled at a slightly larger/smaller offset for
// chromatic fringing; a Fresnel-ish `pow(edge, k)` term lit from the top-left
// adds the bright rim; the opposite rim is darkened for depth.
//
// Per-instance data is 20 floats (5×vec4, stride 80): a=center.xy+halfSize.xy,
// b=cornerRadius,border,rotation,feather (GLYPH: atlas uv rect), fill rgba,
// border rgba, g=kind,refraction,specular,blur.

// The live surface colour-format token, refreshed each frame from
// `gpu.surfaceInfo` before any pipeline/offscreen target is built so prebuilt
// bytecode adapts to whatever surface (bgra8unorm / *-srgb) it is deployed onto.
let SURFACE_FMT = "bgra8unorm";

// Instance kinds (the `g.x` discriminator).
let KIND_SOLID = 0.0;
let KIND_GLYPH = 1.0;
let KIND_GLASS = 2.0;
let KIND_SHADOW = 3.0;

// The backdrop captured for refraction is rendered at 1/BD_SCALE resolution: the
// glass blur is a low-frequency effect, so a smaller offscreen target cuts the
// capture fill-rate ~BD_SCALE^2 AND shrinks the texture the glass lenses sample
// on the surface pass (better cache locality per tap) — the linear upsample only
// softens the blur, which the lens wants anyway.
let BD_SCALE = 2.5;

// --------------------------------------------------------------- shader -------
// One pipeline draws everything. Bindings: globals uniform, the captured backdrop
// texture (sampled by glass lenses), the font atlas (sampled by glyphs), and a
// linear sampler. Glass and glyph reads use `textureSampleLevel` (explicit LOD)
// so they are valid inside non-uniform control flow — no derivative uniformity
// requirement, so the four kinds can branch freely.
let GLASS_WGSL = "
struct Globals { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct In {
    @location(0) a: vec4<f32>,
    @location(1) b: vec4<f32>,
    @location(2) fill: vec4<f32>,
    @location(3) bcol: vec4<f32>,
    @location(4) gp: vec4<f32>,
};
struct Out {
    @builtin(position) clip: vec4<f32>,
    @location(0) p: vec2<f32>,
    @location(1) @interpolate(flat) half: vec2<f32>,
    @location(2) @interpolate(flat) bp: vec4<f32>,
    @location(3) @interpolate(flat) fill: vec4<f32>,
    @location(4) @interpolate(flat) bcol: vec4<f32>,
    @location(5) @interpolate(flat) gp: vec4<f32>,
    @location(6) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, in: In) -> Out {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    let isGlyph = in.gp.x > 0.5 && in.gp.x < 1.5;
    let half = in.a.zw;
    let local = corners[vi] * half;
    var rot = in.b.z;
    if (isGlyph) { rot = 0.0; }
    let cr = cos(rot);
    let sr = sin(rot);
    let rotated = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
    let world = in.a.xy + rotated;
    let ndc = vec2<f32>(world.x / g.viewport.x * 2.0 - 1.0, 1.0 - world.y / g.viewport.y * 2.0);
    var o: Out;
    o.clip = vec4<f32>(ndc, 0.0, 1.0);
    o.p = local;
    o.half = half;
    o.bp = in.b;
    o.fill = in.fill;
    o.bcol = in.bcol;
    o.gp = in.gp;
    let cuv = corners[vi] * 0.5 + vec2<f32>(0.5, 0.5);
    o.uv = mix(in.b.xy, in.b.zw, cuv);
    return o;
}

fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}
// SDF gradient = outward surface normal, by central differences (robust on both
// the flat edges and the rounded corners).
fn sd_normal(p: vec2<f32>, b: vec2<f32>, r: f32) -> vec2<f32> {
    let e = 0.75;
    let dx = sd_round_box(p + vec2<f32>(e, 0.0), b, r) - sd_round_box(p - vec2<f32>(e, 0.0), b, r);
    let dy = sd_round_box(p + vec2<f32>(0.0, e), b, r) - sd_round_box(p - vec2<f32>(0.0, e), b, r);
    let n = vec2<f32>(dx, dy);
    let l = length(n);
    if (l < 0.0001) { return vec2<f32>(0.0, 0.0); }
    return n / l;
}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {
    let kind = o.gp.x;
    // GLYPH: sample the coverage atlas, tint by fill.
    if (kind > 0.5 && kind < 1.5) {
        let a = textureSampleLevel(atlas, samp, o.uv, 0.0).r;
        return vec4<f32>(o.fill.rgb, o.fill.a * a);
    }
    let r = min(o.bp.x, min(o.half.x, o.half.y));
    let d = sd_round_box(o.p, o.half, r);
    let f = max(o.bp.w, 0.75);
    let cov = clamp(0.5 - d / f, 0.0, 1.0);
    // SHADOW: a feathered fill (the feather rides in b.w).
    if (kind > 2.5) {
        return vec4<f32>(o.fill.rgb, o.fill.a * cov);
    }
    // SOLID: rounded SDF with a border ring.
    if (kind < 0.5) {
        let inner = d + o.bp.y;
        let icov = clamp(0.5 - inner / f, 0.0, 1.0);
        let col = mix(o.bcol, o.fill, icov);
        return vec4<f32>(col.rgb, col.a * cov);
    }
    // GLASS: the liquid-glass lens.
    let uv = o.clip.xy / g.viewport;
    let n = sd_normal(o.p, o.half, r);
    // Edge proximity: 1 at the rim, falling to 0 by `edgeW` px inside.
    let edgeW = max(r * 0.9, 7.0);
    let edge = clamp(1.0 + d / edgeW, 0.0, 1.0);
    let refr = o.gp.y;
    // Convex-lens displacement: bend the backdrop outward along the normal,
    // strongest at the rim (edge^2), magnifying what is just outside the glass.
    let disp = n * edge * edge * refr / g.viewport;
    let blur = o.gp.w;
    let px = blur / g.viewport.x;
    let py = blur / g.viewport.y;
    let buv = uv + disp;
    // Backdrop blur. The captured scene texture is already half-res (pre-softened),
    // so a cheap 3-tap diagonal blur reads the same as a 5-tap cross but costs two
    // fewer samples per fragment — a big fill-rate win when many lenses overlap.
    let d1 = vec2<f32>(px, py);
    var bg = textureSampleLevel(backdrop, samp, buv, 0.0).rgb * 0.5;
    bg = bg + textureSampleLevel(backdrop, samp, buv + d1, 0.0).rgb * 0.25;
    bg = bg + textureSampleLevel(backdrop, samp, buv - d1, 0.0).rgb * 0.25;
    // Edge-only chromatic aberration: split R/B along the normal at the rim. Gated
    // to the rim so the panel interior (the bulk of the fragments) skips these two
    // samples entirely — the prism fringe is only ever visible near the edge.
    if (edge > 0.03) {
        let ca = edge * edge * refr * 0.5 / g.viewport.x;
        let cr = textureSampleLevel(backdrop, samp, buv + n * ca, 0.0).r;
        let cb = textureSampleLevel(backdrop, samp, buv - n * ca, 0.0).b;
        bg = vec3<f32>(mix(bg.r, cr, 0.7), bg.g, mix(bg.b, cb, 0.7));
    }
    // Tint (translucent glass colour over the refracted backdrop).
    let tint = o.fill;
    var col = mix(bg, tint.rgb, tint.a);
    // Directional specular rim (light from the top-left) + opposite-rim shade.
    let ldir = normalize(vec2<f32>(-0.55, -0.84));
    let rim = pow(edge, 2.5);
    let spec = clamp(dot(n, ldir), 0.0, 1.0) * rim * o.gp.z;
    let shade = clamp(dot(n, -ldir), 0.0, 1.0) * rim * o.gp.z * 0.4;
    col = col + vec3<f32>(spec, spec, spec) - vec3<f32>(shade, shade, shade);
    // A faint inner border line on the glass rim.
    let inner = d + o.bp.y;
    let icov = clamp(0.5 - inner / f, 0.0, 1.0);
    let bl = (1.0 - icov) * o.bcol.a;
    col = mix(col, o.bcol.rgb, bl);
    return vec4<f32>(col, cov);
}
";

// A vector stroke font (fallback when no host atlas is available): each glyph is
// line segments [x0,y0,x1,y1] in a 4-wide × 6-tall box (origin top-left, y down),
// drawn as overlapping rounded capsules.
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
    "*": [[2.0,1.0,2.0,5.0],[0.6,2.0,3.4,4.0],[3.4,2.0,0.6,4.0]],
    "^": [[0.8,2.4,2.0,1.0],[2.0,1.0,3.2,2.4]],
    "=": [[0.6,2.3,3.4,2.3],[0.6,3.7,3.4,3.7]],
    "(": [[2.8,0.4,1.4,1.8],[1.4,1.8,1.4,4.2],[1.4,4.2,2.8,5.6]],
    ")": [[1.2,0.4,2.6,1.8],[2.6,1.8,2.6,4.2],[2.6,4.2,1.2,5.6]],
    "!": [[2.0,0.2,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "?": [[0.6,1.4,1.9,0.3],[1.9,0.3,3.2,1.4],[3.2,1.4,2.0,3.0],[2.0,3.0,2.0,4.0],[1.85,5.35,2.15,5.65]],
    "#": [[1.3,0.2,0.8,5.8],[3.0,0.2,2.5,5.8],[0.4,2.1,3.6,2.1],[0.4,3.9,3.6,3.9]],
    " ": [],
};

// Path-grammar lookups for the SVG icon parser.
let SVG_DIGITS = { "0": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1 };
let SVG_PATHCMD = { M: 1, m: 1, L: 1, l: 1, H: 1, h: 1, V: 1, v: 1, C: 1, c: 1, Q: 1, q: 1, S: 1, s: 1, T: 1, t: 1, A: 1, a: 1, Z: 1, z: 1 };

// Liquid-glass accent tints (vivid system hues, light/dark): blue, indigo, pink,
// green. Used for accent glass, the selected-segment fill and the slider track.
let ACC_LIGHT = [[0.04,0.52,1.00],[0.35,0.34,0.84],[1.00,0.18,0.55],[0.20,0.78,0.35]];
let ACC_DARK  = [[0.39,0.69,1.00],[0.58,0.56,0.98],[1.00,0.45,0.70],[0.40,0.86,0.52]];

let WHITE = [1.0, 1.0, 1.0, 1.0];
let CLEAR = [0.0, 0.0, 0.0, 0.0];

// ---- small shared helpers (pure, no state) ----------------------------------
function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
function lerpCol(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
function gradStops(colors, stops) {
    let n = len(colors); let out = [];
    for (let i = 0; i < n; i++) {
        let t = 0.0; if (n > 1) { t = num(i) / (n - 1.0); }
        if (stops != 0) { if (i < len(stops)) { t = stops[i]; } }
        push(out, { t: t, col: colors[i] });
    }
    return out;
}
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
