// Elpa Material Design 3 UI kit — the importable module, authored in JavaScript.
//
// This is the SDK itself, *not* a generator: the file you are reading runs
// directly on the Elpian VM. An Elpa app `vm.import`s it (see `demo.js`); its
// top-level body registers one reusable drawing `Definition` per widget through
// `askHost("gpu.define", [def])`. The app then references each widget by id and
// feeds it a per-frame instance buffer.
//
// Two design rules keep the whole kit inside one tiny primitive:
//
//   1. All shape & anti-aliasing math lives in WGSL — every widget is drawn by a
//      single *rounded-rectangle signed-distance-field* pipeline. Material 3
//      shapes are rounded rects, pills, circles and capsules, so one SDF draws
//      cards, buttons, the FAB, switches, checkboxes, radios, sliders, chips,
//      progress bars, dividers and even the vector-stroke text.
//   2. The Elpian side ships only resource objects, instanced draws, and
//      per-instance `f32` data. The app computes that data in plain JS.
//
// Per-instance data (4 × vec4 = 64 bytes = 16 floats), matching the WGSL `In`:
//   a    = center.xy, halfSize.xy            (pixels)
//   b    = cornerRadius, borderWidth, rotation, feather
//   fill = fill rgba
//   bcol = border rgba

// One rounded-rect SDF. The vertex shader places a (optionally rotated) quad in
// pixel space; the fragment shader evaluates a rounded-rect SDF for crisp,
// anti-aliased corners and composites a border ring over the fill. `feather` is
// the edge softness in pixels: ~1 for crisp widgets, large for soft M3
// elevation shadows.
let WGSL = "
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
    let cov = clamp(0.5 - d / f, 0.0, 1.0);       // outer coverage (feathered)
    let inner = d + o.params.y;                   // pull the edge in by borderWidth
    let icov = clamp(0.5 - inner / f, 0.0, 1.0);  // interior (fill) region
    let col = mix(o.bcol, o.fill, icov);          // border ring outside the interior
    return vec4<f32>(col.rgb, col.a * cov);
}
";

// The shared resource set: one shader + one pipeline for the whole kit. Each
// widget definition carries it (the renderer dedups by id and creates each once,
// then caches), so any subset of widgets is independently drawable. The
// "bgra8unorm" color-target token is rewritten by the web host to the browser
// surface's actual format.
function shared() {
    return [
        { kind: "shader", id: "elpa.m3.shader", wgsl: WGSL },
        {
            kind: "bindGroupLayout",
            id: "elpa.m3.bgl",
            entries: [{ binding: 0, visibility: ["VERTEX"], ty: "uniform" }],
        },
        { kind: "pipelineLayout", id: "elpa.m3.layout", bind_group_layouts: ["elpa.m3.bgl"] },
        {
            kind: "renderPipeline",
            id: "elpa.m3.pipe",
            layout: "elpa.m3.layout",
            vertex: {
                module: "elpa.m3.shader",
                entry_point: "vs",
                buffers: [{
                    array_stride: 64,
                    step_mode: "instance",
                    attributes: [
                        { format: "float32x4", offset: 0, shader_location: 0 },
                        { format: "float32x4", offset: 16, shader_location: 1 },
                        { format: "float32x4", offset: 32, shader_location: 2 },
                        { format: "float32x4", offset: 48, shader_location: 3 },
                    ],
                }],
            },
            fragment: {
                module: "elpa.m3.shader",
                entry_point: "fs",
                targets: [{
                    format: "bgra8unorm",
                    blend: {
                        color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                        alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" },
                    },
                }],
            },
        },
    ];
}

// Register one widget: a render-level definition that binds the shared pipeline,
// pulls per-instance data from the widget's instance buffer (slot 0, filled by
// the app each frame), and draws `layers` instances of the 6-vertex quad.
function define(name, layers) {
    askHost("gpu.define", [{
        id: concat("elpa.m3.", name),
        resources: shared(),
        level: "render",
        commands: [
            { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: concat(concat("elpa.m3.", name), ".instances"), offset: 0 },
            { cmd: "draw", vertex_count: 6, instance_count: layers, first_vertex: 0, first_instance: 0 },
        ],
    }]);
}

// The catalog. Each `layers` count is the exact number of rounded-rect instances
// the app supplies for that widget every frame.
define("card", 2);            // elevation shadow + surface
define("appBar", 5);          // bar + 3 menu lines + avatar
define("filledButton", 2);    // elevation shadow + container
define("outlinedButton", 1);  // outline ring
define("fab", 4);             // elevation shadow + container + 2 icon bars
define("switch", 2);          // track + thumb
define("checkbox", 3);        // box + 2 check-mark capsules
define("radioGroup", 6);      // 3 × (ring + dot)
define("slider", 3);          // inactive track + active track + thumb
define("chip", 2);            // body + leading dot
define("progress", 2);        // track + indicator
define("divider", 1);         // hairline
define("labels", 256);        // vector-stroke caption capsules (max; padded)
