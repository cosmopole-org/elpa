//! Authoring tool that generates the **Material Design 3 (expressive) UI kit** as
//! **Elpian AST JSON**.
//!
//! The kit itself is *not* Rust — it is the `assets/*.ast.json` files this tool
//! writes, which run directly on the Elpian VM (importable via `vm.import`). This
//! generator only assembles those files. Two design rules keep everything inside
//! the Elpian language's abilities:
//!
//! 1. **All shape / anti-aliasing math lives in WGSL.** Every widget is drawn by
//!    a single *rounded-rectangle signed-distance-field* pipeline (M3 shapes are
//!    rounded rects, pills and circles). The Elpian side only ships resource
//!    objects, instanced draw definitions, and per-instance `f32` data.
//! 2. **All interaction is branch-free arithmetic.** The Elpian VM's `bool*bool`
//!    is unreliable and its `ifStmt` is untested, so the demo never branches:
//!    hit-tests are comparisons `cast` to `0.0`/`1.0`, combined with `*` (AND)
//!    and `+`; a toggle is `s + t - 2*s*t`, a select is `s*(1-h) + v*h`. Only the
//!    VM's well-exercised opcodes (`arithmetic`, `cast`, `functionCall`,
//!    `definition`, `assignment`, `indexer`, `host_call`) are used.
//!
//! Run with `cargo run -p elpa-material --bin build_material` to regenerate.

use std::fs;
use std::path::Path;

use elpa_protocol::resource::{
    BindGroupLayoutDesc, BindGroupLayoutEntry, BlendComponent, BlendState, ColorTargetState,
    FragmentState, PipelineLayoutDesc, PrimitiveState, RenderPipelineDesc, ShaderDesc,
    VertexAttribute, VertexBufferLayout, VertexState,
};
use elpa_protocol::{Definition, DefinitionBody, RenderCommand, ResourceDesc};
use serde::Serialize;
use serde_json::{json, Map, Value};

const COLOR_FORMAT: &str = "bgra8unorm";

// Stable resource ids the kit shares (created once, cached by the renderer).
const SH: &str = "elpa.m3.shader";
const BGL: &str = "elpa.m3.bgl";
const LAY: &str = "elpa.m3.layout";
const PIPE: &str = "elpa.m3.pipe";
const GLB: &str = "elpa.m3.globals";
const GLB_BIND: &str = "elpa.m3.globalsBind";

// --- WGSL: one rounded-rect SDF primitive (all shape math lives here) --------
//
// Per-instance data (4 × vec4 = 64 bytes):
//   loc0 a    = center.xy, halfSize.xy        (pixels)
//   loc1 b    = cornerRadius, borderWidth, rotation, _
//   loc2 fill = fill rgba
//   loc3 bcol = border rgba
//
// The vertex shader places a quad (optionally rotated) in pixel space; the
// fragment shader evaluates a rounded-rect SDF for crisp, anti-aliased corners
// and composites a border ring over the fill. Pills (radius = halfHeight),
// circles (square + radius = half), cards, bars and icons are all this one shape.
const WGSL: &str = r#"
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
    // `feather` is the edge-softness in pixels: ~1 for crisp widgets, large for
    // soft elevation shadows.
    let f = max(o.feather, 0.75);
    let cov = clamp(0.5 - d / f, 0.0, 1.0);       // outer coverage (feathered)
    let inner = d + o.params.y;                   // pull the edge in by borderWidth
    let icov = clamp(0.5 - inner / f, 0.0, 1.0);  // interior (fill) region
    let col = mix(o.bcol, o.fill, icov);          // border ring outside the interior
    return vec4<f32>(col.rgb, col.a * cov);
}
"#;

// --- shared resource set (one shader + pipeline for the whole kit) -----------

fn instance_layout() -> VertexBufferLayout {
    VertexBufferLayout {
        array_stride: 64,
        step_mode: "instance".into(),
        attributes: vec![
            VertexAttribute {
                format: "float32x4".into(),
                offset: 0,
                shader_location: 0,
            },
            VertexAttribute {
                format: "float32x4".into(),
                offset: 16,
                shader_location: 1,
            },
            VertexAttribute {
                format: "float32x4".into(),
                offset: 32,
                shader_location: 2,
            },
            VertexAttribute {
                format: "float32x4".into(),
                offset: 48,
                shader_location: 3,
            },
        ],
    }
}

fn shared_resources() -> Vec<ResourceDesc> {
    let blend = BlendState {
        color: BlendComponent {
            src_factor: "src-alpha".into(),
            dst_factor: "one-minus-src-alpha".into(),
            operation: "add".into(),
        },
        alpha: BlendComponent {
            src_factor: "one".into(),
            dst_factor: "one-minus-src-alpha".into(),
            operation: "add".into(),
        },
    };
    vec![
        ResourceDesc::Shader(ShaderDesc {
            id: SH.into(),
            wgsl: WGSL.into(),
        }),
        ResourceDesc::BindGroupLayout(BindGroupLayoutDesc {
            id: BGL.into(),
            entries: vec![BindGroupLayoutEntry {
                binding: 0,
                visibility: vec!["VERTEX".into()],
                ty: "uniform".into(),
            }],
        }),
        ResourceDesc::PipelineLayout(PipelineLayoutDesc {
            id: LAY.into(),
            bind_group_layouts: vec![BGL.into()],
        }),
        ResourceDesc::RenderPipeline(RenderPipelineDesc {
            id: PIPE.into(),
            layout: Some(LAY.into()),
            vertex: VertexState {
                module: SH.into(),
                entry_point: "vs".into(),
                buffers: vec![instance_layout()],
            },
            fragment: Some(FragmentState {
                module: SH.into(),
                entry_point: "fs".into(),
                targets: vec![ColorTargetState {
                    format: COLOR_FORMAT.into(),
                    blend: Some(blend),
                    write_mask: vec![],
                }],
            }),
            primitive: PrimitiveState::default(),
            depth_stencil: None,
            multisample: Default::default(),
        }),
    ]
}

// --- widget catalog ----------------------------------------------------------

/// One widget: its name and how many rounded-rect "layers" (instances) compose
/// it. Each becomes a reusable draw `Definition` the app references by id and
/// feeds a matching instance buffer.
struct Widget {
    name: &'static str,
    layers: u32,
}

fn catalog() -> Vec<Widget> {
    vec![
        Widget {
            name: "card",
            layers: 2, // drop shadow + surface
        },
        Widget {
            name: "appBar",
            layers: 5,
        },
        Widget {
            name: "filledButton",
            layers: 2, // drop shadow + container
        },
        Widget {
            name: "outlinedButton",
            layers: 1,
        },
        Widget {
            name: "fab",
            layers: 4, // drop shadow + container + 2 icon bars
        },
        Widget {
            name: "switch",
            layers: 2,
        },
        Widget {
            name: "checkbox",
            layers: 3,
        },
        Widget {
            name: "radioGroup",
            layers: 6,
        },
        Widget {
            name: "slider",
            layers: 3,
        },
        Widget {
            name: "chip",
            layers: 2,
        },
        Widget {
            name: "progress",
            layers: 2,
        },
        Widget {
            name: "divider",
            layers: 1,
        },
        // One instance per lit pixel of every caption (5×7 dot-matrix text).
        Widget {
            name: "labels",
            layers: labels_layer_count(),
        },
    ]
}

fn widget_def_id(name: &str) -> String {
    format!("elpa.m3.{name}")
}
fn widget_instances_id(name: &str) -> String {
    format!("elpa.m3.{name}.instances")
}

/// A reusable render definition for one widget: the shared pipeline + a draw of
/// `layers` instances from the widget's instance buffer (which the app supplies
/// each frame). Geometry is procedural (6 verts), so there is no vertex geometry
/// buffer — only the per-instance buffer in slot 0.
fn widget_definition(w: &Widget) -> Definition {
    Definition {
        id: widget_def_id(w.name),
        resources: shared_resources(),
        body: DefinitionBody::Render {
            commands: vec![
                RenderCommand::SetPipeline {
                    pipeline: PIPE.into(),
                },
                RenderCommand::SetVertexBuffer {
                    slot: 0,
                    buffer: widget_instances_id(w.name),
                    offset: 0,
                },
                RenderCommand::Draw {
                    vertex_count: 6,
                    instance_count: w.layers,
                    first_vertex: 0,
                    first_instance: 0,
                },
            ],
        },
    }
}

// --- generic AST literal emission (omit null fields, like the engine SDK) -----

fn to_ast(v: &Value) -> Value {
    match v {
        Value::String(s) => json!({ "type": "string", "data": { "value": s } }),
        Value::Bool(b) => json!({ "type": "bool", "data": { "value": b } }),
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                json!({ "type": "i64", "data": { "value": n.as_i64().unwrap_or(0) } })
            } else {
                json!({ "type": "f64", "data": { "value": n.as_f64().unwrap_or(0.0) } })
            }
        }
        Value::Array(items) => {
            json!({ "type": "array", "data": { "value": items.iter().map(to_ast).collect::<Vec<_>>() } })
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, val) in map {
                if val.is_null() {
                    continue;
                }
                out.insert(k.clone(), to_ast(val));
            }
            json!({ "type": "object", "data": { "value": out } })
        }
        Value::Null => json!({ "type": "i64", "data": { "value": 0 } }),
    }
}

fn literal<T: Serialize>(v: &T) -> Value {
    to_ast(&serde_json::to_value(v).expect("serializes"))
}

fn host_call(name: &str, args: Vec<Value>) -> Value {
    json!({ "type": "host_call", "data": { "name": name, "args": args } })
}

fn program(body: Vec<Value>) -> Value {
    json!({ "type": "program", "body": body })
}

// --- AST expression helpers --------------------------------------------------

fn a_s(v: &str) -> Value {
    json!({ "type": "string", "data": { "value": v } })
}
fn a_i(v: i64) -> Value {
    json!({ "type": "i64", "data": { "value": v } })
}
fn a_f(v: f64) -> Value {
    json!({ "type": "f64", "data": { "value": v } })
}
fn a_id(name: &str) -> Value {
    json!({ "type": "identifier", "data": { "name": name } })
}
fn a_obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    json!({ "type": "object", "data": { "value": m } })
}
fn a_arr(items: Vec<Value>) -> Value {
    json!({ "type": "array", "data": { "value": items } })
}
fn a_op(op: &str, a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": op, "operand1": a, "operand2": b } })
}
fn add(a: Value, b: Value) -> Value {
    a_op("+", a, b)
}
fn sub(a: Value, b: Value) -> Value {
    a_op("-", a, b)
}
fn mul(a: Value, b: Value) -> Value {
    a_op("*", a, b)
}
fn div(a: Value, b: Value) -> Value {
    a_op("/", a, b)
}
fn a_cast(v: Value, ty: &str) -> Value {
    json!({ "type": "cast", "data": { "value": v, "targetType": ty } })
}
/// A boolean comparison cast to `0.0` / `1.0` — the building block of all
/// branch-free interaction logic.
fn b2f(cond: Value) -> Value {
    a_cast(cond, "f64")
}
fn a_idx(target: Value, index: Value) -> Value {
    json!({ "type": "indexer", "data": { "target": target, "index": index } })
}
fn a_idxs(target: Value, key: &str) -> Value {
    a_idx(target, a_s(key))
}
fn a_idxi(target: Value, i: i64) -> Value {
    a_idx(target, a_i(i))
}
fn a_def(name: &str, value: Value) -> Value {
    json!({ "type": "definition", "data": { "leftSide": a_id(name), "rightSide": value } })
}
fn a_set(name: &str, value: Value) -> Value {
    json!({ "type": "assignment", "data": { "leftSide": a_id(name), "rightSide": value } })
}
fn a_call(name: &str) -> Value {
    json!({ "type": "functionCall", "data": { "callee": a_id(name), "args": [] } })
}
fn a_call1(name: &str, arg: Value) -> Value {
    json!({ "type": "functionCall", "data": { "callee": a_id(name), "args": [arg] } })
}
fn a_return(v: Value) -> Value {
    json!({ "type": "returnOperation", "data": { "value": v } })
}
fn a_func(name: &str, params: Vec<&str>, body: Vec<Value>) -> Value {
    json!({ "type": "functionDefinition", "data": { "name": name, "params": params, "body": body } })
}

/// An f32-array GPU buffer whose elements may be computed expressions.
fn a_buffer(id: &str, usage: &[&str], floats: Vec<Value>) -> Value {
    a_obj(vec![
        ("kind", a_s("buffer")),
        ("id", a_s(id)),
        ("size", a_i((floats.len() * 4) as i64)),
        ("usage", a_arr(usage.iter().map(|u| a_s(u)).collect())),
        ("data_f32", a_arr(floats)),
    ])
}

fn a_globals_bind(id: &str, layout: &str, buffer: &str) -> Value {
    a_obj(vec![
        ("kind", a_s("bindGroup")),
        ("id", a_s(id)),
        ("layout", a_s(layout)),
        (
            "entries",
            a_arr(vec![a_obj(vec![
                ("binding", a_i(0)),
                (
                    "resource",
                    a_obj(vec![("type", a_s("buffer")), ("buffer", a_s(buffer))]),
                ),
            ])]),
        ),
    ])
}

fn a_use(def: &str) -> Value {
    a_obj(vec![
        ("cmd", a_s("useDefinition")),
        ("definition", a_s(def)),
    ])
}

fn a_set_bind(group: &str) -> Value {
    a_obj(vec![
        ("cmd", a_s("setBindGroup")),
        ("index", a_i(0)),
        ("bind_group", a_s(group)),
    ])
}

// --- expression sugar used throughout the demo -------------------------------

fn lf(w: &str, f: &str) -> Value {
    a_idxs(a_idxs(a_id("L"), w), f)
}
fn eq(a: Value, b: Value) -> Value {
    a_op("==", a, b)
}
fn ge(a: Value, b: Value) -> Value {
    a_op(">=", a, b)
}
fn le(a: Value, b: Value) -> Value {
    a_op("<=", a, b)
}
fn gt(a: Value, b: Value) -> Value {
    a_op(">", a, b)
}
fn lt(a: Value, b: Value) -> Value {
    a_op("<", a, b)
}

/// `1.0` if `(px,py)` lies in the axis-aligned rect, else `0.0` — the AND of four
/// comparisons via multiplication of their `0/1` casts.
fn inrect(px: Value, py: Value, cx: Value, cy: Value, hw: Value, hh: Value) -> Value {
    let in_x = mul(
        b2f(ge(px.clone(), sub(cx.clone(), hw.clone()))),
        b2f(le(px, add(cx, hw))),
    );
    let in_y = mul(
        b2f(ge(py.clone(), sub(cy.clone(), hh.clone()))),
        b2f(le(py, add(cy, hh))),
    );
    mul(in_x, in_y)
}

// --- palette (Material色: surfaces/outline mix with darkAnim; accent from list) -

/// Channel mix between a light value and a dark value driven by `darkAnim`.
fn mixch(l: f64, d: f64) -> Value {
    add(
        mul(a_f(l), sub(a_f(1.0), a_id("darkAnim"))),
        mul(a_f(d), a_id("darkAnim")),
    )
}
fn mixs(a: Value, b: Value, t: Value) -> Value {
    add(mul(a, sub(a_f(1.0), t.clone())), mul(b, t))
}
fn mix_col(c0: Vec<Value>, c1: Vec<Value>, t: Value) -> Vec<Value> {
    (0..4)
        .map(|i| mixs(c0[i].clone(), c1[i].clone(), t.clone()))
        .collect()
}
fn c4(r: f64, g: f64, b: f64, a: f64) -> Vec<Value> {
    vec![a_f(r), a_f(g), a_f(b), a_f(a)]
}
fn transparent() -> Vec<Value> {
    c4(0.0, 0.0, 0.0, 0.0)
}
fn pal_bg() -> Vec<Value> {
    vec![
        mixch(0.93, 0.06),
        mixch(0.94, 0.06),
        mixch(0.97, 0.08),
        a_f(1.0),
    ]
}
fn pal_surface(a: Value) -> Vec<Value> {
    vec![mixch(1.0, 0.13), mixch(1.0, 0.14), mixch(1.0, 0.17), a]
}
fn pal_variant() -> Vec<Value> {
    vec![
        mixch(0.86, 0.27),
        mixch(0.87, 0.28),
        mixch(0.90, 0.32),
        a_f(1.0),
    ]
}
fn pal_outline() -> Vec<Value> {
    vec![
        mixch(0.66, 0.40),
        mixch(0.66, 0.40),
        mixch(0.70, 0.46),
        a_f(1.0),
    ]
}
fn accch(i: i64) -> Value {
    a_idxi(a_idx(a_id("accents"), a_id("accent")), i)
}
/// The current accent color (indexed from the `accents` list by `accent`) at a
/// given alpha.
fn acc(a: Value) -> Vec<Value> {
    vec![accch(0), accch(1), accch(2), a]
}
fn acc1() -> Vec<Value> {
    acc(a_f(1.0))
}
/// Add a flat amount to each rgb channel (a Material "state layer" lighten).
fn brighten(col: Vec<Value>, amt: Value) -> Vec<Value> {
    vec![
        add(col[0].clone(), amt.clone()),
        add(col[1].clone(), amt.clone()),
        add(col[2].clone(), amt),
        col[3].clone(),
    ]
}

// --- one rounded-rect instance (16 f32) --------------------------------------

#[allow(clippy::too_many_arguments)]
fn inst(
    cx: Value,
    cy: Value,
    hw: Value,
    hh: Value,
    radius: Value,
    border: Value,
    rot: Value,
    fill: Vec<Value>,
    bcol: Vec<Value>,
) -> Vec<Value> {
    // Crisp edge (feather ≈ 1px) for normal widgets.
    let mut v = vec![cx, cy, hw, hh, radius, border, rot, a_f(1.0)];
    v.extend(fill);
    v.extend(bcol);
    debug_assert_eq!(v.len(), 16);
    v
}

/// A soft, downward-offset dark rounded rect *behind* an elevated surface — a
/// Material elevation shadow. `grow`/`drop`/`blur` are pixel expressions.
fn shadow(
    cx: Value,
    cy: Value,
    hw: Value,
    hh: Value,
    radius: Value,
    grow: Value,
    drop: Value,
    blur: Value,
) -> Vec<Value> {
    let mut v = vec![
        cx,
        add(cy, drop),
        add(hw, grow.clone()),
        add(hh, grow.clone()),
        add(radius, grow),
        a_f(0.0),
        a_f(0.0),
        blur, // large feather → blurred shadow edge
    ];
    v.extend(c4(0.0, 0.0, 0.0, 0.30)); // soft black
    v.extend(transparent());
    debug_assert_eq!(v.len(), 16);
    v
}

/// The standard elevation shadow for a surface of the given geometry (drop &
/// blur scale with the viewport so it reads on any screen).
fn shadow_for(cx: Value, cy: Value, hw: Value, hh: Value, radius: Value) -> Vec<Value> {
    shadow(
        cx,
        cy,
        hw,
        hh,
        radius,
        mul(a_id("vh"), a_f(0.006)),
        mul(a_id("vh"), a_f(0.012)),
        mul(a_id("vh"), a_f(0.030)),
    )
}

// --- text: a 5×7 dot-matrix font drawn with the same rounded-rect primitive ---
//
// There is no glyph engine, so captions are rendered as small rounded squares —
// one per lit pixel of a 5×7 font. The label geometry depends only on the layout
// (not per-frame state), so it is computed once into the cached `txt` buffer and
// reused every frame (see `buildText` / `onResize`).

/// A vector **stroke font**: each glyph is a set of line segments in a 4-wide ×
/// 6-tall box (origin top-left, y down). Drawn as rounded capsules (rotated
/// rounded rects with fully-rounded ends) they connect at joints into smooth,
/// continuous letterforms — a clean rounded typeface, not a dot grid. Unknown
/// chars (incl. space) → no strokes.
type Seg = ((f64, f64), (f64, f64));
fn glyph_strokes(c: char) -> Vec<Seg> {
    let s = |a: (f64, f64), b: (f64, f64)| (a, b);
    match c.to_ascii_uppercase() {
        'A' => vec![
            s((0.2, 6.0), (2.0, 0.2)),
            s((2.0, 0.2), (3.8, 6.0)),
            s((0.95, 3.8), (3.05, 3.8)),
        ],
        'B' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (2.6, 0.0)),
            s((2.6, 0.0), (3.5, 1.5)),
            s((3.5, 1.5), (2.6, 3.0)),
            s((0.3, 3.0), (2.6, 3.0)),
            s((2.6, 3.0), (3.7, 4.5)),
            s((3.7, 4.5), (2.6, 6.0)),
            s((0.3, 6.0), (2.6, 6.0)),
        ],
        'C' => vec![
            s((3.6, 1.3), (2.5, 0.2)),
            s((2.5, 0.2), (1.2, 0.5)),
            s((1.2, 0.5), (0.3, 2.0)),
            s((0.3, 2.0), (0.3, 4.0)),
            s((0.3, 4.0), (1.2, 5.5)),
            s((1.2, 5.5), (2.5, 5.8)),
            s((2.5, 5.8), (3.6, 4.7)),
        ],
        'D' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (2.3, 0.0)),
            s((2.3, 0.0), (3.7, 2.0)),
            s((3.7, 2.0), (3.7, 4.0)),
            s((3.7, 4.0), (2.3, 6.0)),
            s((0.3, 6.0), (2.3, 6.0)),
        ],
        'E' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (3.6, 0.0)),
            s((0.3, 3.0), (2.9, 3.0)),
            s((0.3, 6.0), (3.6, 6.0)),
        ],
        'F' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (3.6, 0.0)),
            s((0.3, 3.0), (2.9, 3.0)),
        ],
        'G' => vec![
            s((3.6, 1.3), (2.5, 0.2)),
            s((2.5, 0.2), (1.2, 0.5)),
            s((1.2, 0.5), (0.3, 2.0)),
            s((0.3, 2.0), (0.3, 4.0)),
            s((0.3, 4.0), (1.2, 5.5)),
            s((1.2, 5.5), (2.5, 5.8)),
            s((2.5, 5.8), (3.6, 4.8)),
            s((3.6, 4.8), (3.6, 3.4)),
            s((2.4, 3.4), (3.6, 3.4)),
        ],
        'H' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((3.7, 0.0), (3.7, 6.0)),
            s((0.3, 3.0), (3.7, 3.0)),
        ],
        'I' => vec![
            s((1.0, 0.0), (3.0, 0.0)),
            s((2.0, 0.0), (2.0, 6.0)),
            s((1.0, 6.0), (3.0, 6.0)),
        ],
        'K' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 3.4), (3.6, 0.0)),
            s((1.3, 2.4), (3.8, 6.0)),
        ],
        'L' => vec![s((0.3, 0.0), (0.3, 6.0)), s((0.3, 6.0), (3.6, 6.0))],
        'M' => vec![
            s((0.2, 6.0), (0.2, 0.0)),
            s((0.2, 0.0), (2.0, 3.2)),
            s((2.0, 3.2), (3.8, 0.0)),
            s((3.8, 0.0), (3.8, 6.0)),
        ],
        'N' => vec![
            s((0.3, 6.0), (0.3, 0.0)),
            s((0.3, 0.0), (3.7, 6.0)),
            s((3.7, 6.0), (3.7, 0.0)),
        ],
        'O' => vec![
            s((1.3, 0.3), (2.7, 0.3)),
            s((2.7, 0.3), (3.7, 1.6)),
            s((3.7, 1.6), (3.7, 4.4)),
            s((3.7, 4.4), (2.7, 5.7)),
            s((2.7, 5.7), (1.3, 5.7)),
            s((1.3, 5.7), (0.3, 4.4)),
            s((0.3, 4.4), (0.3, 1.6)),
            s((0.3, 1.6), (1.3, 0.3)),
        ],
        'P' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (2.7, 0.0)),
            s((2.7, 0.0), (3.6, 1.5)),
            s((3.6, 1.5), (2.7, 3.0)),
            s((0.3, 3.0), (2.7, 3.0)),
        ],
        'R' => vec![
            s((0.3, 0.0), (0.3, 6.0)),
            s((0.3, 0.0), (2.7, 0.0)),
            s((2.7, 0.0), (3.6, 1.5)),
            s((3.6, 1.5), (2.7, 3.0)),
            s((0.3, 3.0), (2.7, 3.0)),
            s((1.6, 3.0), (3.8, 6.0)),
        ],
        'S' => vec![
            s((3.5, 1.2), (2.4, 0.3)),
            s((2.4, 0.3), (1.1, 0.6)),
            s((1.1, 0.6), (0.5, 1.8)),
            s((0.5, 1.8), (1.7, 2.8)),
            s((1.7, 2.8), (2.6, 3.3)),
            s((2.6, 3.3), (3.5, 4.4)),
            s((3.5, 4.4), (2.8, 5.5)),
            s((2.8, 5.5), (1.5, 5.8)),
            s((1.5, 5.8), (0.4, 4.9)),
        ],
        'T' => vec![s((0.2, 0.0), (3.8, 0.0)), s((2.0, 0.0), (2.0, 6.0))],
        'U' => vec![
            s((0.3, 0.0), (0.3, 4.4)),
            s((0.3, 4.4), (1.4, 5.7)),
            s((1.4, 5.7), (2.6, 5.7)),
            s((2.6, 5.7), (3.7, 4.4)),
            s((3.7, 4.4), (3.7, 0.0)),
        ],
        'V' => vec![s((0.2, 0.0), (2.0, 6.0)), s((2.0, 6.0), (3.8, 0.0))],
        'W' => vec![
            s((0.1, 0.0), (1.0, 6.0)),
            s((1.0, 6.0), (2.0, 2.2)),
            s((2.0, 2.2), (3.0, 6.0)),
            s((3.0, 6.0), (3.9, 0.0)),
        ],
        'X' => vec![s((0.3, 0.0), (3.7, 6.0)), s((3.7, 0.0), (0.3, 6.0))],
        'Y' => vec![
            s((0.3, 0.0), (2.0, 3.0)),
            s((3.7, 0.0), (2.0, 3.0)),
            s((2.0, 3.0), (2.0, 6.0)),
        ],
        'Z' => vec![
            s((0.3, 0.0), (3.7, 0.0)),
            s((3.7, 0.0), (0.3, 6.0)),
            s((0.3, 6.0), (3.7, 6.0)),
        ],
        '-' => vec![s((1.0, 3.0), (3.0, 3.0))],
        _ => vec![],
    }
}

/// Number of stroke segments in a string (its instance count).
fn stroke_count(text: &str) -> u32 {
    text.chars().map(|c| glyph_strokes(c).len() as u32).sum()
}

/// Text color source.
#[derive(Clone, Copy)]
enum Ink {
    White,
    Accent,
    OnSurface,
}

/// The 4 rgba expressions for an [`Ink`]. Theme/accent-dependent inks reference a
/// per-frame global (`g_on` / `g_acc`) so each glyph pixel costs one tiny
/// `indexer` node, not an inlined color tree — and still tracks theme changes.
fn ink(k: Ink) -> Vec<Value> {
    match k {
        Ink::White => c4(1.0, 1.0, 1.0, 1.0),
        Ink::Accent => vec![
            a_idxi(a_id("g_acc"), 0),
            a_idxi(a_id("g_acc"), 1),
            a_idxi(a_id("g_acc"), 2),
            a_f(1.0),
        ],
        Ink::OnSurface => vec![
            a_idxi(a_id("g_on"), 0),
            a_idxi(a_id("g_on"), 1),
            a_idxi(a_id("g_on"), 2),
            a_f(1.0),
        ],
    }
}

/// Per-frame text colors (cheap): `g_on` reads on the surface in either theme;
/// `g_acc` is the live accent. Referenced by every caption pixel.
fn text_color_updates() -> Vec<Value> {
    vec![
        a_set(
            "g_on",
            a_arr(vec![
                mixch(0.16, 0.92),
                mixch(0.16, 0.92),
                mixch(0.20, 0.94),
            ]),
        ),
        a_set("g_acc", a_arr(vec![accch(0), accch(1), accch(2)])),
    ]
}

/// Emit one rounded **capsule** per glyph stroke of `text` (a rotated rounded
/// rect with fully-rounded ends). Position/size come from the label's cached
/// globals `lx/ly/lc{idx}` (`lc` = per-unit screen size; the glyph box is 4×6
/// units). Capsule ends overlap at joints, so strokes connect into smooth,
/// continuous letterforms.
fn text_strokes(idx: usize, text: &str, color: Vec<Value>) -> Vec<Value> {
    let lx = || a_id(&format!("lx{idx}"));
    let ly = || a_id(&format!("ly{idx}"));
    let lc = || a_id(&format!("lc{idx}"));
    let n = text.chars().count() as f64;
    let adv = 5.0; // advance per glyph: 4-wide box + 1 unit gap
    let th = 0.92; // stroke thickness (units)
    let mut out = Vec::new();
    for (i, ch) in text.chars().enumerate() {
        let gc = ((i as f64) - (n - 1.0) / 2.0) * adv; // glyph center-x in units
        for ((x0, y0), (x1, y1)) in glyph_strokes(ch) {
            // box [0,4]×[0,6] centered on the glyph slot and on the baseline.
            let ax = gc - 2.0 + x0;
            let ay = y0 - 3.0;
            let bx = gc - 2.0 + x1;
            let by = y1 - 3.0;
            let cxu = (ax + bx) / 2.0;
            let cyu = (ay + by) / 2.0;
            let (dx, dy) = (bx - ax, by - ay);
            let len = (dx * dx + dy * dy).sqrt();
            let ang = dy.atan2(dx);
            out.extend(inst(
                add(lx(), mul(lc(), a_f(cxu))),
                add(ly(), mul(lc(), a_f(cyu))),
                mul(lc(), a_f(len / 2.0)),
                mul(lc(), a_f(th / 2.0)),
                mul(lc(), a_f(th / 2.0)), // radius = half thickness → capsule
                a_f(0.0),
                a_f(ang),
                color.clone(),
                transparent(),
            ));
        }
    }
    out
}

/// One caption: text, its center / cell-size expressions, and ink.
struct Label {
    text: &'static str,
    cx: Value,
    cy: Value,
    cell: Value,
    color: Ink,
}

/// Every caption in the demo, positioned relative to the layout `L`.
fn labels() -> Vec<Label> {
    // Glyph cell sizes (a glyph is 5×7 cells). Kept small relative to the
    // viewport so captions sit inside their widgets instead of dominating.
    let title = || mul(a_id("vh"), a_f(0.0056));
    let btn = || mul(a_id("vh"), a_f(0.0043));
    let cap = || mul(a_id("vh"), a_f(0.0037));
    let above = |w: &str, f: f64| sub(lf(w, "cy"), mul(a_id("vh"), a_f(f)));
    let mut v = vec![
        // App-bar title (on the accent bar).
        Label {
            text: "ELPA UI",
            cx: lf("appBar", "cx"),
            cy: lf("appBar", "cy"),
            cell: title(),
            color: Ink::White,
        },
        // Button labels (centered on each button).
        Label {
            text: "THEME",
            cx: lf("filledButton", "cx"),
            cy: lf("filledButton", "cy"),
            cell: btn(),
            color: Ink::White,
        },
        Label {
            text: "RESET",
            cx: lf("outlinedButton", "cx"),
            cy: lf("outlinedButton", "cy"),
            cell: btn(),
            color: Ink::Accent,
        },
        // Control captions (above each control).
        Label {
            text: "WI-FI",
            cx: lf("switch", "cx"),
            cy: above("switch", 0.035),
            cell: cap(),
            color: Ink::OnSurface,
        },
        Label {
            text: "AGREE",
            cx: lf("checkbox", "cx"),
            cy: above("checkbox", 0.035),
            cell: cap(),
            color: Ink::OnSurface,
        },
        Label {
            text: "VOLUME",
            cx: lf("slider", "cx"),
            cy: above("slider", 0.03),
            cell: cap(),
            color: Ink::OnSurface,
        },
        Label {
            text: "TASKS",
            cx: lf("progress", "cx"),
            cy: above("progress", 0.028),
            cell: cap(),
            color: Ink::OnSurface,
        },
        // Chip label.
        Label {
            text: "FILTER",
            cx: add(lf("chip", "cx"), mul(lf("chip", "hh"), a_f(0.5))),
            cy: lf("chip", "cy"),
            cell: cap(),
            color: Ink::OnSurface,
        },
    ];
    // A / B / C under the radio buttons.
    for (i, t) in ["A", "B", "C"].iter().enumerate() {
        let ci = add(
            lf("radioGroup", "cx"),
            mul(a_f((i as f64) - 1.0), lf("radioGroup", "sp")),
        );
        v.push(Label {
            text: t,
            cx: ci,
            cy: add(lf("radioGroup", "cy"), mul(a_id("vh"), a_f(0.032))),
            cell: mul(a_id("vh"), a_f(0.0040)),
            color: Ink::OnSurface,
        });
    }
    v
}

/// Total caption instance count (the `labels` widget's layer count).
fn labels_layer_count() -> u32 {
    labels().iter().map(|l| stroke_count(l.text)).sum()
}

/// All caption instances, concatenated (built only on layout changes).
fn rb_labels() -> Vec<Value> {
    let mut v = Vec::new();
    for (idx, l) in labels().iter().enumerate() {
        v.extend(text_strokes(idx, l.text, ink(l.color)));
    }
    v
}

// --- per-widget instance builders (read layout `L` + animated state) ---------

fn rb_card() -> Vec<Value> {
    let radius = || mul(a_id("vh"), a_f(0.03));
    let mut v = shadow_for(
        lf("card", "cx"),
        lf("card", "cy"),
        lf("card", "hw"),
        lf("card", "hh"),
        radius(),
    );
    v.extend(inst(
        lf("card", "cx"),
        lf("card", "cy"),
        lf("card", "hw"),
        lf("card", "hh"),
        radius(),
        a_f(0.0),
        a_f(0.0),
        pal_surface(a_f(1.0)),
        transparent(),
    ));
    v
}

fn rb_appbar() -> Vec<Value> {
    let cx = || lf("appBar", "cx");
    let cy = || lf("appBar", "cy");
    let hw = || lf("appBar", "hw");
    let hh = || lf("appBar", "hh");
    let white = || c4(1.0, 1.0, 1.0, 0.95);
    // The bar itself (accent-colored — an "expressive" colored top app bar).
    let bar = inst(
        cx(),
        cy(),
        hw(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        a_f(0.0),
        acc1(),
        transparent(),
    );
    // A three-line "menu" affordance near the left.
    let line_cx = add(sub(cx(), hw()), mul(a_id("vh"), a_f(0.06)));
    let lw = mul(a_id("vh"), a_f(0.022));
    let lh = mul(a_id("vh"), a_f(0.004));
    let sp = mul(a_id("vh"), a_f(0.013));
    let line = |dy: Value| {
        inst(
            line_cx.clone(),
            add(cy(), dy),
            lw.clone(),
            lh.clone(),
            lh.clone(),
            a_f(0.0),
            a_f(0.0),
            white(),
            transparent(),
        )
    };
    // A circular "avatar" near the right.
    let av_cx = sub(add(cx(), hw()), mul(a_id("vh"), a_f(0.06)));
    let av_r = mul(a_id("vh"), a_f(0.028));
    let avatar = inst(
        av_cx,
        cy(),
        av_r.clone(),
        av_r.clone(),
        av_r,
        a_f(0.0),
        a_f(0.0),
        c4(1.0, 1.0, 1.0, 0.9),
        transparent(),
    );
    let mut v = bar;
    v.extend(line(sub(a_f(0.0), sp.clone())));
    v.extend(line(a_f(0.0)));
    v.extend(line(sp));
    v.extend(avatar);
    v
}

fn rb_filled() -> Vec<Value> {
    let hover = inrect(
        a_id("hx"),
        a_id("hy"),
        lf("filledButton", "cx"),
        lf("filledButton", "cy"),
        lf("filledButton", "hw"),
        lf("filledButton", "hh"),
    );
    let state = add(mul(hover, a_f(0.10)), mul(a_id("pressFilled"), a_f(0.16)));
    let mut v = shadow_for(
        lf("filledButton", "cx"),
        lf("filledButton", "cy"),
        lf("filledButton", "hw"),
        lf("filledButton", "hh"),
        lf("filledButton", "hh"),
    );
    v.extend(inst(
        lf("filledButton", "cx"),
        lf("filledButton", "cy"),
        lf("filledButton", "hw"),
        lf("filledButton", "hh"),
        lf("filledButton", "hh"),
        a_f(0.0),
        a_f(0.0),
        brighten(acc1(), state),
        transparent(),
    ));
    v
}

fn rb_outlined() -> Vec<Value> {
    let hover = inrect(
        a_id("hx"),
        a_id("hy"),
        lf("outlinedButton", "cx"),
        lf("outlinedButton", "cy"),
        lf("outlinedButton", "hw"),
        lf("outlinedButton", "hh"),
    );
    let state = add(mul(hover, a_f(0.10)), mul(a_id("pressOutlined"), a_f(0.16)));
    inst(
        lf("outlinedButton", "cx"),
        lf("outlinedButton", "cy"),
        lf("outlinedButton", "hw"),
        lf("outlinedButton", "hh"),
        lf("outlinedButton", "hh"),
        a_f(1.5),
        a_f(0.0),
        acc(state),
        acc1(),
    )
}

fn rb_fab() -> Vec<Value> {
    let r = || lf("fab", "hw");
    let cx = || lf("fab", "cx");
    let cy = || lf("fab", "cy");
    let hover = inrect(a_id("hx"), a_id("hy"), cx(), cy(), r(), r());
    let state = add(mul(hover, a_f(0.10)), mul(a_id("pressFab"), a_f(0.16)));
    let container = inst(
        cx(),
        cy(),
        r(),
        r(),
        r(),
        a_f(0.0),
        a_f(0.0),
        brighten(acc1(), state),
        transparent(),
    );
    let white = || c4(1.0, 1.0, 1.0, 1.0);
    let bar_h = inst(
        cx(),
        cy(),
        mul(r(), a_f(0.42)),
        mul(r(), a_f(0.12)),
        mul(r(), a_f(0.12)),
        a_f(0.0),
        a_f(0.0),
        white(),
        transparent(),
    );
    let bar_v = inst(
        cx(),
        cy(),
        mul(r(), a_f(0.12)),
        mul(r(), a_f(0.42)),
        mul(r(), a_f(0.12)),
        a_f(0.0),
        a_f(0.0),
        white(),
        transparent(),
    );
    let mut v = shadow_for(cx(), cy(), r(), r(), r());
    v.extend(container);
    v.extend(bar_h);
    v.extend(bar_v);
    v
}

fn rb_switch() -> Vec<Value> {
    let cx = || lf("switch", "cx");
    let cy = || lf("switch", "cy");
    let hw = || lf("switch", "hw");
    let hh = || lf("switch", "hh");
    let track_fill = mix_col(pal_variant(), acc1(), a_id("swAnim"));
    let track = inst(
        cx(),
        cy(),
        hw(),
        hh(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        track_fill,
        transparent(),
    );
    let thumb_r = mul(hh(), a_f(0.72));
    let left = sub(cx(), hw());
    let travel = sub(mul(hw(), a_f(2.0)), mul(thumb_r.clone(), a_f(2.0)));
    let thumb_x = add(add(left, thumb_r.clone()), mul(a_id("swAnim"), travel));
    let thumb_fill = mix_col(pal_outline(), c4(1.0, 1.0, 1.0, 1.0), a_id("swAnim"));
    let thumb = inst(
        thumb_x,
        cy(),
        thumb_r.clone(),
        thumb_r.clone(),
        thumb_r,
        a_f(0.0),
        a_f(0.0),
        thumb_fill,
        transparent(),
    );
    let mut v = track;
    v.extend(thumb);
    v
}

fn rb_checkbox() -> Vec<Value> {
    let h = || lf("checkbox", "hw");
    let cx = || lf("checkbox", "cx");
    let cy = || lf("checkbox", "cy");
    let box_fill = acc(a_id("ckAnim"));
    let box_border = mix_col(pal_outline(), acc1(), a_id("ckAnim"));
    let boxl = inst(
        cx(),
        cy(),
        h(),
        h(),
        mul(h(), a_f(0.28)),
        a_f(2.0),
        a_f(0.0),
        box_fill,
        box_border,
    );
    let white = || vec![a_f(1.0), a_f(1.0), a_f(1.0), a_id("ckAnim")];
    // Two rotated bars forming a check mark (no glyph engine — just geometry).
    let off = |k: f64| mul(h(), a_f(k));
    let left_bar = inst(
        sub(cx(), off(0.225)),
        add(cy(), off(0.125)),
        off(0.247),
        off(0.08),
        off(0.08),
        a_f(0.0),
        a_f(-2.356),
        white(),
        transparent(),
    );
    let right_bar = inst(
        add(cx(), off(0.225)),
        sub(cy(), off(0.125)),
        off(0.505),
        off(0.08),
        off(0.08),
        a_f(0.0),
        a_f(-0.997),
        white(),
        transparent(),
    );
    let mut v = boxl;
    v.extend(left_bar);
    v.extend(right_bar);
    v
}

fn rb_radio() -> Vec<Value> {
    let cy = || lf("radioGroup", "cy");
    let hw = || lf("radioGroup", "hw");
    let mut v = Vec::new();
    for i in 0..3 {
        let ci = add(
            lf("radioGroup", "cx"),
            mul(a_f((i as f64) - 1.0), lf("radioGroup", "sp")),
        );
        let anim = a_id(match i {
            0 => "r0Anim",
            1 => "r1Anim",
            _ => "r2Anim",
        });
        let ring_border = mix_col(pal_outline(), acc1(), anim.clone());
        let ring = inst(
            ci.clone(),
            cy(),
            hw(),
            hw(),
            hw(),
            a_f(2.0),
            a_f(0.0),
            transparent(),
            ring_border,
        );
        let dot_r = mul(hw(), mul(a_f(0.55), anim));
        let dot = inst(
            ci,
            cy(),
            dot_r.clone(),
            dot_r.clone(),
            dot_r,
            a_f(0.0),
            a_f(0.0),
            acc1(),
            transparent(),
        );
        v.extend(ring);
        v.extend(dot);
    }
    v
}

fn rb_slider() -> Vec<Value> {
    let cx = || lf("slider", "cx");
    let cy = || lf("slider", "cy");
    let hw = || lf("slider", "hw");
    let hh = || lf("slider", "hh");
    let left = sub(cx(), hw());
    let width = mul(hw(), a_f(2.0));
    let thumb_x = add(left.clone(), mul(a_id("sliderVal"), width.clone()));
    let inactive = inst(
        cx(),
        cy(),
        hw(),
        hh(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        pal_variant(),
        transparent(),
    );
    let act_hw = div(mul(a_id("sliderVal"), width.clone()), a_f(2.0));
    let act_cx = add(left, div(mul(a_id("sliderVal"), width), a_f(2.0)));
    let active = inst(
        act_cx,
        cy(),
        act_hw,
        hh(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        acc1(),
        transparent(),
    );
    // Thumb grows slightly while dragging (a touch-target "pressed" cue).
    let base_r = mul(a_id("vh"), a_f(0.016));
    let thumb_r = mul(base_r, add(a_f(1.0), mul(a_id("dragging"), a_f(0.3))));
    let thumb = inst(
        thumb_x,
        cy(),
        thumb_r.clone(),
        thumb_r.clone(),
        thumb_r,
        a_f(0.0),
        a_f(0.0),
        acc1(),
        transparent(),
    );
    let mut v = inactive;
    v.extend(active);
    v.extend(thumb);
    v
}

fn rb_chip() -> Vec<Value> {
    let cx = || lf("chip", "cx");
    let cy = || lf("chip", "cy");
    let hw = || lf("chip", "hw");
    let hh = || lf("chip", "hh");
    let body_fill = acc(a_id("chipAnim"));
    let body_border = mix_col(pal_outline(), acc1(), a_id("chipAnim"));
    let body = inst(
        cx(),
        cy(),
        hw(),
        hh(),
        hh(),
        a_f(1.5),
        a_f(0.0),
        body_fill,
        body_border,
    );
    // A leading selected-indicator dot that fades in with chipAnim.
    let dot_cx = add(sub(cx(), hw()), mul(hh(), a_f(1.1)));
    let dot_r = mul(hh(), a_f(0.45));
    let dot = inst(
        dot_cx,
        cy(),
        dot_r.clone(),
        dot_r.clone(),
        dot_r,
        a_f(0.0),
        a_f(0.0),
        vec![a_f(1.0), a_f(1.0), a_f(1.0), a_id("chipAnim")],
        transparent(),
    );
    let mut v = body;
    v.extend(dot);
    v
}

fn rb_progress() -> Vec<Value> {
    let cx = || lf("progress", "cx");
    let cy = || lf("progress", "cy");
    let hw = || lf("progress", "hw");
    let hh = || lf("progress", "hh");
    let track = inst(
        cx(),
        cy(),
        hw(),
        hh(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        pal_variant(),
        transparent(),
    );
    // Determinate progress = how many toggles are on (animated) — moving the
    // switch / checkbox / chip fills this bar.
    let prog = div(
        add(add(a_id("swAnim"), a_id("ckAnim")), a_id("chipAnim")),
        a_f(3.0),
    );
    let left = sub(cx(), hw());
    let width = mul(mul(hw(), a_f(2.0)), prog);
    let ind_cx = add(left, div(width.clone(), a_f(2.0)));
    let ind_hw = div(width, a_f(2.0));
    let indicator = inst(
        ind_cx,
        cy(),
        ind_hw,
        hh(),
        hh(),
        a_f(0.0),
        a_f(0.0),
        acc1(),
        transparent(),
    );
    let mut v = track;
    v.extend(indicator);
    v
}

fn rb_divider() -> Vec<Value> {
    inst(
        lf("divider", "cx"),
        lf("divider", "cy"),
        lf("divider", "hw"),
        lf("divider", "hh"),
        a_f(0.0),
        a_f(0.0),
        a_f(0.0),
        pal_variant(),
        transparent(),
    )
}

/// Map a widget name to its instance-data builder.
fn rb(name: &str) -> Vec<Value> {
    match name {
        "card" => rb_card(),
        "appBar" => rb_appbar(),
        "filledButton" => rb_filled(),
        "outlinedButton" => rb_outlined(),
        "fab" => rb_fab(),
        "switch" => rb_switch(),
        "checkbox" => rb_checkbox(),
        "radioGroup" => rb_radio(),
        "slider" => rb_slider(),
        "chip" => rb_chip(),
        "progress" => rb_progress(),
        "divider" => rb_divider(),
        "labels" => rb_labels(),
        _ => unreachable!("unknown widget {name}"),
    }
}

// Draw order: panel behind, controls, app bar, captions, then the floating
// action button on top.
const DRAW_ORDER: [&str; 13] = [
    "card",
    "divider",
    "progress",
    "slider",
    "switch",
    "checkbox",
    "radioGroup",
    "chip",
    "filledButton",
    "outlinedButton",
    "appBar",
    "labels",
    "fab",
];

// --- the importable module ---------------------------------------------------

/// The importable UI-kit module: a `gpu.define` per widget. An app `vm.import`s
/// this, then references widgets by id and feeds each a per-frame instance buffer.
fn build_module() -> Value {
    let body = catalog()
        .iter()
        .map(|w| host_call("gpu.define", vec![literal(&widget_definition(w))]))
        .collect();
    program(body)
}

// --- the interactive demo app ------------------------------------------------

/// `clamp01(v)` — branch-free clamp to `[0,1]`.
fn fn_clamp01() -> Value {
    a_func(
        "clamp01",
        vec!["v"],
        vec![
            a_def("t", a_id("v")),
            // if t > 1 → subtract (t-1) to land on 1
            a_set(
                "t",
                sub(
                    a_id("t"),
                    mul(b2f(gt(a_id("t"), a_f(1.0))), sub(a_id("t"), a_f(1.0))),
                ),
            ),
            // if t < 0 → subtract t to land on 0
            a_set(
                "t",
                sub(a_id("t"), mul(b2f(lt(a_id("t"), a_f(0.0))), a_id("t"))),
            ),
            a_return(a_id("t")),
        ],
    )
}

/// `layout()` — recompute every widget's geometry from the live viewport into the
/// single object `L`. Called by both `render()` (to build instances) and
/// `onEvent()` (to hit-test), so layout has exactly one source of truth.
fn fn_layout() -> Value {
    let vwf = |frac: f64| mul(a_id("vw"), a_f(frac));
    let vhf = |frac: f64| mul(a_id("vh"), a_f(frac));
    let rect = |cx: Value, cy: Value, hw: Value, hh: Value| {
        a_obj(vec![("cx", cx), ("cy", cy), ("hw", hw), ("hh", hh)])
    };
    let radios = a_obj(vec![
        ("cx", vwf(0.5)),
        ("cy", vhf(0.45)),
        ("hw", vhf(0.020)),
        ("hh", vhf(0.020)),
        ("sp", vwf(0.13)),
    ]);
    let l = a_obj(vec![
        ("appBar", rect(vwf(0.5), vhf(0.055), vwf(0.5), vhf(0.045))),
        ("card", rect(vwf(0.5), vhf(0.56), vwf(0.44), vhf(0.40))),
        (
            "filledButton",
            rect(vwf(0.32), vhf(0.22), vwf(0.20), vhf(0.032)),
        ),
        (
            "outlinedButton",
            rect(vwf(0.70), vhf(0.22), vwf(0.18), vhf(0.032)),
        ),
        ("switch", rect(vwf(0.74), vhf(0.34), vhf(0.045), vhf(0.020))),
        (
            "checkbox",
            rect(vwf(0.26), vhf(0.34), vhf(0.022), vhf(0.022)),
        ),
        ("radioGroup", radios),
        ("slider", rect(vwf(0.5), vhf(0.56), vwf(0.40), vhf(0.005))),
        ("chip", rect(vwf(0.34), vhf(0.67), vwf(0.13), vhf(0.024))),
        ("divider", rect(vwf(0.5), vhf(0.62), vwf(0.40), a_f(1.0))),
        ("progress", rect(vwf(0.5), vhf(0.74), vwf(0.40), vhf(0.006))),
        ("fab", rect(vwf(0.84), vhf(0.85), vhf(0.05), vhf(0.05))),
    ]);
    a_func("layout", vec![], vec![a_set("L", l)])
}

/// The `labels` instance buffer, backed by the cached `txt` array (rebuilt only
/// on layout changes, not per frame).
fn labels_buffer() -> Value {
    a_obj(vec![
        ("kind", a_s("buffer")),
        ("id", a_s(&widget_instances_id("labels"))),
        ("size", a_i((labels_layer_count() as i64) * 64)),
        ("usage", a_arr(vec![a_s("VERTEX")])),
        ("data_f32", a_id("txt")),
    ])
}

/// `buildText()` — cache each label's base position / cell size into its
/// `lx/ly/lc` globals from the current layout, then (re)build the `txt` glyph
/// buffer. Cheap to skip per frame; called once at start and on every resize.
fn fn_build_text() -> Value {
    let mut body = Vec::new();
    for (idx, l) in labels().into_iter().enumerate() {
        body.push(a_set(&format!("lx{idx}"), l.cx));
        body.push(a_set(&format!("ly{idx}"), l.cy));
        body.push(a_set(&format!("lc{idx}"), l.cell));
    }
    body.push(a_set("txt", a_arr(rb_labels())));
    a_func("buildText", vec![], body)
}

/// `render()` — query the surface, refresh layout, then build and submit one
/// frame referencing every widget by id with freshly-computed instance data.
fn fn_render() -> Value {
    let mut resources = vec![
        a_buffer(
            GLB,
            &["UNIFORM", "COPY_DST"],
            vec![a_id("vw"), a_id("vh"), a_f(0.0), a_f(0.0)],
        ),
        a_globals_bind(GLB_BIND, BGL, GLB),
    ];
    for w in catalog() {
        // Captions are expensive (one instance per lit pixel) and depend only on
        // layout, so they live in the cached `txt` buffer, rebuilt on resize — not
        // re-evaluated every frame here.
        if w.name == "labels" {
            resources.push(labels_buffer());
            continue;
        }
        let floats = rb(w.name);
        debug_assert_eq!(
            floats.len() as u32,
            w.layers * 16,
            "{} layer/data mismatch",
            w.name
        );
        resources.push(a_buffer(&widget_instances_id(w.name), &["VERTEX"], floats));
    }

    let mut commands = vec![a_set_bind(GLB_BIND)];
    for name in DRAW_ORDER {
        commands.push(a_use(&widget_def_id(name)));
    }
    let bg = pal_bg();
    let clear = a_obj(vec![
        ("view", a_obj(vec![("kind", a_s("surface"))])),
        ("load", a_s("clear")),
        (
            "clear_color",
            a_obj(vec![
                ("r", bg[0].clone()),
                ("g", bg[1].clone()),
                ("b", bg[2].clone()),
                ("a", a_f(1.0)),
            ]),
        ),
    ]);
    let pass = a_obj(vec![
        ("op", a_s("renderPass")),
        ("id", a_s("elpa.m3.ui")),
        ("color_attachments", a_arr(vec![clear])),
        ("commands", a_arr(commands)),
    ]);
    let frame = a_obj(vec![
        ("resources", a_arr(resources)),
        ("commands", a_arr(vec![pass])),
    ]);

    let mut render_body = vec![
        a_def("si", host_call("gpu.surfaceInfo", vec![])),
        a_set("vw", a_cast(a_idxs(a_id("si"), "width"), "f64")),
        a_set("vh", a_cast(a_idxs(a_id("si"), "height"), "f64")),
        a_call("layout"),
    ];
    // Refresh the live text colors (theme + accent) every frame; the cached glyph
    // positions reference these globals.
    render_body.extend(text_color_updates());
    render_body.push(host_call("gpu.submit", vec![frame]));
    a_func("render", vec![], render_body)
}

/// A branch-free toggle assignment: `name = name + t - 2*name*t` (t ∈ {0,1}).
fn toggle(name: &str, t: Value) -> Value {
    a_set(
        name,
        sub(
            add(a_id(name), t.clone()),
            mul(a_f(2.0), mul(a_id(name), t)),
        ),
    )
}
/// Zero `name` when `trig` is 1 (used by reset).
fn clear_on(name: &str, trig: Value) -> Value {
    a_set(name, mul(a_id(name), sub(a_f(1.0), trig)))
}
/// Set `name` toward `v` when `h` is 1, else keep it.
fn set_on(name: &str, v: Value, h: Value) -> Value {
    a_set(
        name,
        add(mul(a_id(name), sub(a_f(1.0), h.clone())), mul(v, h)),
    )
}

/// `onEvent(e)` — the whole interaction model, expressed without any branches.
/// `e` always carries `{type,x,y,nx,ny,button,deltaY,key}` (the host fills every
/// field), so each line evaluates safely for every event kind and only the
/// matching `is*` gate is non-zero.
fn fn_on_event() -> Value {
    let hit = |w: &str| {
        inrect(
            a_id("px"),
            a_id("py"),
            lf(w, "cx"),
            lf(w, "cy"),
            lf(w, "hw"),
            lf(w, "hh"),
        )
    };
    // A finger-friendly hit area: the widget's bounds grown by a comfortable
    // touch padding so small controls are still easy to tap on a phone.
    let hitp = |w: &str| {
        let pad = || mul(a_id("vh"), a_f(0.02));
        inrect(
            a_id("px"),
            a_id("py"),
            lf(w, "cx"),
            lf(w, "cy"),
            add(lf(w, "hw"), pad()),
            add(lf(w, "hh"), pad()),
        )
    };
    let mut body = vec![
        a_call("layout"),
        a_def("et", a_idxs(a_id("e"), "type")),
        a_def("ky", a_idxs(a_id("e"), "key")),
        a_def("px", mul(a_idxs(a_id("e"), "nx"), a_id("vw"))),
        a_def("py", mul(a_idxs(a_id("e"), "ny"), a_id("vh"))),
        a_def("isDown", b2f(eq(a_id("et"), a_s("pointerdown")))),
        a_def("isUp", b2f(eq(a_id("et"), a_s("pointerup")))),
        a_def("isMove", b2f(eq(a_id("et"), a_s("pointermove")))),
        a_def("isWheel", b2f(eq(a_id("et"), a_s("wheel")))),
        a_def("isKey", b2f(eq(a_id("et"), a_s("keydown")))),
        a_def("isKeyUp", b2f(eq(a_id("et"), a_s("keyup")))),
        // Hover position tracks pointer moves only (offscreen otherwise).
        set_on("hx", a_id("px"), a_id("isMove")),
        set_on("hy", a_id("py"), a_id("isMove")),
        // --- pointer-down hits on each control --------------------------------
        a_def("downFb", mul(a_id("isDown"), hit("filledButton"))),
        a_def("downOb", mul(a_id("isDown"), hit("outlinedButton"))),
        a_def("downFab", mul(a_id("isDown"), hit("fab"))),
        a_def("downSw", mul(a_id("isDown"), hitp("switch"))),
        a_def("downCk", mul(a_id("isDown"), hitp("checkbox"))),
        a_def("downChip", mul(a_id("isDown"), hit("chip"))),
        // Press state layers (decay each frame in onFrame).
        set_on("pressFilled", a_f(1.0), a_id("downFb")),
        set_on("pressOutlined", a_f(1.0), a_id("downOb")),
        set_on("pressFab", a_f(1.0), a_id("downFab")),
    ];

    // Radio selection: each radio's hit is disjoint, so summed sets are safe.
    for i in 0..3 {
        let ci = add(
            lf("radioGroup", "cx"),
            mul(a_f((i as f64) - 1.0), lf("radioGroup", "sp")),
        );
        let pad = mul(a_id("vh"), a_f(0.02));
        let hit_i = inrect(
            a_id("px"),
            a_id("py"),
            ci,
            lf("radioGroup", "cy"),
            add(lf("radioGroup", "hw"), pad.clone()),
            add(lf("radioGroup", "hw"), pad),
        );
        let down_i = mul(a_id("isDown"), hit_i);
        body.push(set_on("radio", a_f(i as f64), down_i));
    }

    // Slider drag: down-on-track starts a drag, up ends it, move while dragging
    // (or the initial down) sets the value from the pointer x.
    let sl_hit = inrect(
        a_id("px"),
        a_id("py"),
        lf("slider", "cx"),
        lf("slider", "cy"),
        lf("slider", "hw"),
        mul(a_id("vh"), a_f(0.05)),
    );
    let sl_left = sub(lf("slider", "cx"), lf("slider", "hw"));
    let sl_width = mul(lf("slider", "hw"), a_f(2.0));
    body.extend(vec![
        a_def("slHit", sl_hit),
        a_def("startDrag", mul(a_id("isDown"), a_id("slHit"))),
        // up clears the drag, down-on-track sets it
        a_set(
            "dragging",
            mul(a_id("dragging"), sub(a_f(1.0), a_id("isUp"))),
        ),
        a_set(
            "dragging",
            add(
                a_id("dragging"),
                mul(a_id("startDrag"), sub(a_f(1.0), a_id("dragging"))),
            ),
        ),
        a_def(
            "applySet",
            add(
                mul(a_id("isDown"), a_id("slHit")),
                mul(a_id("isMove"), a_id("dragging")),
            ),
        ),
        a_def(
            "newVal",
            a_call1("clamp01", div(sub(a_id("px"), sl_left), sl_width)),
        ),
        set_on("sliderVal", a_id("newVal"), a_id("applySet")),
        // Mouse wheel over the surface nudges the slider.
        a_set(
            "sliderVal",
            a_call1(
                "clamp01",
                add(
                    a_id("sliderVal"),
                    mul(
                        a_id("isWheel"),
                        mul(a_idxs(a_id("e"), "deltaY"), a_f(-0.0015)),
                    ),
                ),
            ),
        ),
    ]);

    // Keyboard: arrows nudge the slider; d/space/r are discrete actions.
    body.extend(vec![
        a_def(
            "kRight",
            mul(a_id("isKey"), b2f(eq(a_id("ky"), a_s("ArrowRight")))),
        ),
        a_def(
            "kLeft",
            mul(a_id("isKey"), b2f(eq(a_id("ky"), a_s("ArrowLeft")))),
        ),
        a_set(
            "sliderVal",
            a_call1(
                "clamp01",
                add(
                    a_id("sliderVal"),
                    sub(
                        mul(a_id("kRight"), a_f(0.05)),
                        mul(a_id("kLeft"), a_f(0.05)),
                    ),
                ),
            ),
        ),
        a_def("kD", mul(a_id("isKey"), b2f(eq(a_id("ky"), a_s("d"))))),
        a_def("kSpace", mul(a_id("isKey"), b2f(eq(a_id("ky"), a_s(" "))))),
        a_def("kR", mul(a_id("isKey"), b2f(eq(a_id("ky"), a_s("r"))))),
        // FAB cycles the accent color (pointer down on the FAB, integer modulo).
        a_set(
            "accent",
            a_op(
                "%",
                add(a_id("accent"), a_cast(a_id("downFab"), "i64")),
                a_i(4),
            ),
        ),
        // Toggles (pointer + keyboard share each control; events are disjoint).
        toggle("dark", add(a_id("downFb"), a_id("kD"))),
        toggle("swOn", add(a_id("downSw"), a_id("kSpace"))),
        toggle("ck", a_id("downCk")),
        toggle("chip", a_id("downChip")),
        // Reset: the outlined button or the 'r' key restores defaults.
        a_def("reset", add(a_id("downOb"), a_id("kR"))),
        clear_on("swOn", a_id("reset")),
        clear_on("ck", a_id("reset")),
        clear_on("chip", a_id("reset")),
        clear_on("radio", a_id("reset")),
        set_on("sliderVal", a_f(0.5), a_id("reset")),
        // Key glow: lit while a key is held (set on keydown, cleared on keyup).
        a_set(
            "keyGlow",
            mul(a_id("keyGlow"), sub(a_f(1.0), a_id("isKeyUp"))),
        ),
        set_on("keyGlow", a_f(1.0), a_id("isKey")),
        // Repaint immediately so interaction feels instant (raf also animates).
        a_call("render"),
    ]);

    a_func("onEvent", vec!["e"], body)
}

/// `onFrame(dt)` — advance every animation toward its target, then repaint.
fn fn_on_frame() -> Value {
    let lerp = |name: &str, target: Value, k: f64| {
        a_set(name, add(a_id(name), mul(sub(target, a_id(name)), a_f(k))))
    };
    let decay = |name: &str, k: f64| a_set(name, mul(a_id(name), a_f(k)));
    a_func(
        "onFrame",
        vec!["dt"],
        vec![
            a_set("n", add(a_id("n"), a_i(1))),
            lerp("swAnim", a_id("swOn"), 0.25),
            lerp("ckAnim", a_id("ck"), 0.25),
            lerp("chipAnim", a_id("chip"), 0.25),
            lerp("darkAnim", a_id("dark"), 0.18),
            lerp("r0Anim", b2f(eq(a_id("radio"), a_f(0.0))), 0.30),
            lerp("r1Anim", b2f(eq(a_id("radio"), a_f(1.0))), 0.30),
            lerp("r2Anim", b2f(eq(a_id("radio"), a_f(2.0))), 0.30),
            decay("pressFilled", 0.85),
            decay("pressOutlined", 0.85),
            decay("pressFab", 0.85),
            decay("keyGlow", 0.90),
            a_call("render"),
        ],
    )
}

fn build_demo() -> Value {
    // Accent palette the FAB cycles through (indigo, teal, orange, pink).
    let accents = a_arr(vec![
        a_arr(vec![a_f(0.40), a_f(0.31), a_f(0.85)]),
        a_arr(vec![a_f(0.00), a_f(0.59), a_f(0.53)]),
        a_arr(vec![a_f(0.90), a_f(0.49), a_f(0.13)]),
        a_arr(vec![a_f(0.85), a_f(0.24), a_f(0.52)]),
    ]);

    let state: Vec<Value> = vec![
        a_def("n", a_i(0)),
        a_def("dark", a_f(0.0)),
        a_def("darkAnim", a_f(0.0)),
        a_def("swOn", a_f(0.0)),
        a_def("swAnim", a_f(0.0)),
        a_def("ck", a_f(0.0)),
        a_def("ckAnim", a_f(0.0)),
        a_def("chip", a_f(0.0)),
        a_def("chipAnim", a_f(0.0)),
        a_def("radio", a_f(0.0)),
        a_def("r0Anim", a_f(1.0)),
        a_def("r1Anim", a_f(0.0)),
        a_def("r2Anim", a_f(0.0)),
        a_def("sliderVal", a_f(0.5)),
        a_def("dragging", a_f(0.0)),
        a_def("accent", a_i(0)),
        a_def("hx", a_f(-1000.0)),
        a_def("hy", a_f(-1000.0)),
        a_def("pressFilled", a_f(0.0)),
        a_def("pressOutlined", a_f(0.0)),
        a_def("pressFab", a_f(0.0)),
        a_def("keyGlow", a_f(0.0)),
        a_def("vw", a_f(1.0)),
        a_def("vh", a_f(1.0)),
        a_def("L", a_i(0)),
        a_def("txt", a_arr(vec![])), // cached caption glyph instances
        a_def("g_on", a_arr(vec![a_f(0.0), a_f(0.0), a_f(0.0)])), // text-on-surface color
        a_def("g_acc", a_arr(vec![a_f(0.0), a_f(0.0), a_f(0.0)])), // text accent color
        a_def("accents", accents),
    ];

    // Per-label cached base position (lx/ly) and cell size (lc), set in buildText.
    let mut state = state;
    for idx in 0..labels().len() {
        state.push(a_def(&format!("lx{idx}"), a_f(0.0)));
        state.push(a_def(&format!("ly{idx}"), a_f(0.0)));
        state.push(a_def(&format!("lc{idx}"), a_f(1.0)));
    }

    // Set vw/vh from a surface-info object, refresh layout, rebuild the cached
    // caption geometry, and paint — used at startup and on resize.
    let relayout = |src: Value| {
        vec![
            a_set("vw", a_cast(a_idxs(src.clone(), "width"), "f64")),
            a_set("vh", a_cast(a_idxs(src, "height"), "f64")),
            a_call("layout"),
            a_call("buildText"),
            a_call("render"),
        ]
    };

    let mut body = vec![host_call(
        "vm.import",
        vec![a_s("assets/elpa-material.ast.json")],
    )];
    body.extend(state);
    body.push(fn_clamp01());
    body.push(fn_layout());
    body.push(fn_build_text());
    body.push(fn_render());
    body.push(fn_on_event());
    body.push(fn_on_frame());
    // Resize: the `info` arg already carries the new surface size.
    body.push(a_func("onResize", vec!["info"], relayout(a_id("info"))));
    // First paint: query the surface, lay out, build captions, then render.
    body.push(a_def("si0", host_call("gpu.surfaceInfo", vec![])));
    body.extend(relayout(a_id("si0")));
    program(body)
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    fs::create_dir_all(&dir).unwrap();

    let module = serde_json::to_string_pretty(&build_module()).unwrap();
    fs::write(dir.join("elpa-material.ast.json"), &module).unwrap();

    // The demo carries thousands of caption-glyph instances; serialize it
    // compactly (it is machine-generated and too large to review by hand) to keep
    // the embedded wasm payload small.
    let demo = serde_json::to_string(&build_demo()).unwrap();
    fs::write(dir.join("demo.ast.json"), &demo).unwrap();

    println!(
        "wrote assets/elpa-material.ast.json ({} bytes) and assets/demo.ast.json ({} bytes)",
        module.len(),
        demo.len()
    );
}
