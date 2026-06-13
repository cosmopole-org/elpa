//! Authoring tool that generates the Elpa SDK as **Elpian AST JSON**.
//!
//! The SDK itself is *not* Rust — it is the `assets/*.ast.json` files this tool
//! writes, which run directly on the Elpian VM (importable via `vm.import`). This
//! generator only assembles those files: per the design, **all geometry math
//! lives in WGSL** (which has `sin`/`cos`/`tan`), so the AST carries WGSL shader
//! strings, pipeline/resource objects, and instanced draw definitions — no
//! transcendental math is ever asked of the VM. Per-instance data (position,
//! rotation angles, size, color) flows in as plain `f32` arrays the Elpian
//! language expresses natively.
//!
//! Run with `cargo run -p elpa-sdk --bin build_sdk` to regenerate the assets.

use std::fs;
use std::path::Path;

use elpa_protocol::resource::{
    BindGroupLayoutDesc, BindGroupLayoutEntry, BlendComponent, BlendState, ColorTargetState,
    DepthStencilState, FragmentState, PipelineLayoutDesc, PrimitiveState, RenderPipelineDesc,
    ShaderDesc, VertexAttribute, VertexBufferLayout, VertexState,
};
use elpa_protocol::{Definition, DefinitionBody, RenderCommand, ResourceDesc};
use serde::Serialize;
use serde_json::{json, Map, Value};

const COLOR_FORMAT: &str = "bgra8unorm";
const DEPTH_FORMAT: &str = "depth32float";

// Stable resource ids the SDK shares (created once, cached by the renderer).
const SH2: &str = "elpa.sdk.shader.2d";
const BGL2: &str = "elpa.sdk.bgl.2d";
const LAY2: &str = "elpa.sdk.layout.2d";
const PIPE2: &str = "elpa.sdk.pipe.2d";
const GLB2: &str = "elpa.sdk.globals.2d";
const GLB2_BIND: &str = "elpa.sdk.globalsBind.2d";

const SH3: &str = "elpa.sdk.shader.3d";
const BGL3: &str = "elpa.sdk.bgl.3d";
const LAY3: &str = "elpa.sdk.layout.3d";
const PIPE3: &str = "elpa.sdk.pipe.3d";
const GLB3: &str = "elpa.sdk.globals.3d";
const GLB3_BIND: &str = "elpa.sdk.globalsBind.3d";
const DEPTH: &str = "elpa.sdk.depth.3d";

// --- WGSL (all geometry / rotation / projection math is here) ----------------

const WGSL_2D: &str = r#"
struct Globals { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> g: Globals;

struct In {
    @location(0) a: vec4<f32>,   // center.xy, size.xy
    @location(1) b: vec4<f32>,   // rotation, sides, kind, _
    @location(2) col: vec4<f32>,
};
struct Out { @builtin(position) clip: vec4<f32>, @location(0) color: vec4<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32, in: In) -> Out {
    let center = in.a.xy;
    let size = in.a.zw;
    let rot = in.b.x;
    let sides = in.b.y;
    let kind = in.b.z;
    var local = vec2<f32>(0.0, 0.0);
    if (kind < 0.5) {
        // rect: two triangles, corners at +-0.5 scaled by size (w,h)
        var corners = array<vec2<f32>, 6>(
            vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
            vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
        local = corners[vi] * size;
    } else {
        // regular polygon / circle: triangle fan of `sides` triangles
        let tri = f32(vi / 3u);
        let corner = vi % 3u;
        if (corner == 0u) {
            local = vec2<f32>(0.0, 0.0);
        } else {
            let k = tri + f32(corner - 1u);
            let ang = 6.28318530718 * k / sides;
            local = vec2<f32>(cos(ang), sin(ang)) * size.x; // size.x = radius
        }
    }
    let cr = cos(rot);
    let sr = sin(rot);
    let r = vec2<f32>(local.x * cr - local.y * sr, local.x * sr + local.y * cr);
    let world = center + r;
    let ndc = vec2<f32>(world.x / g.viewport.x * 2.0 - 1.0, 1.0 - world.y / g.viewport.y * 2.0);
    var o: Out;
    o.clip = vec4<f32>(ndc, 0.0, 1.0);
    o.color = in.col;
    return o;
}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> { return o.color; }
"#;

/// Build the 3D WGSL. The cube's 36 vertices are emitted as a WGSL literal array
/// (computed here once); the sphere is generated procedurally in the shader. The
/// model matrix (rotation), view, and perspective projection are all built in
/// WGSL from per-instance angles and the camera uniform.
fn wgsl_3d() -> String {
    let (positions, normals) = cube_vertices();
    let pos_lits = positions
        .iter()
        .map(|p| format!("vec3<f32>({:.1}, {:.1}, {:.1})", p[0], p[1], p[2]))
        .collect::<Vec<_>>()
        .join(", ");
    let nrm_lits = normals
        .iter()
        .map(|n| format!("vec3<f32>({:.1}, {:.1}, {:.1})", n[0], n[1], n[2]))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        r#"
struct Cam {{ c0: vec4<f32>, c1: vec4<f32>, c2: vec4<f32> }};
// c0 = eye.xyz, fovY ; c1 = target.xyz, aspect ; c2 = (near, far, 0, 0)
@group(0) @binding(0) var<uniform> cam: Cam;

const SPHERE_STACKS: u32 = 8u;
const SPHERE_SLICES: u32 = 16u;

struct In {{
    @location(0) a: vec4<f32>,   // position.xyz, scale
    @location(1) b: vec4<f32>,   // rotation.xyz, kind
    @location(2) col: vec4<f32>,
}};
struct Out {{
    @builtin(position) clip: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
}};

fn rot_x(t: f32) -> mat3x3<f32> {{ let s = sin(t); let c = cos(t);
    return mat3x3<f32>(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }}
fn rot_y(t: f32) -> mat3x3<f32> {{ let s = sin(t); let c = cos(t);
    return mat3x3<f32>(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }}
fn rot_z(t: f32) -> mat3x3<f32> {{ let s = sin(t); let c = cos(t);
    return mat3x3<f32>(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0); }}

@vertex
fn vs(@builtin(vertex_index) vi: u32, in: In) -> Out {{
    var pos = vec3<f32>(0.0, 0.0, 0.0);
    var nrm = vec3<f32>(0.0, 1.0, 0.0);
    if (in.b.w < 0.5) {{
        var P = array<vec3<f32>, 36>({pos_lits});
        var N = array<vec3<f32>, 36>({nrm_lits});
        pos = P[vi];
        nrm = N[vi];
    }} else {{
        // UV sphere: 6 verts per quad over a STACKS x SLICES grid
        let quad = vi / 6u;
        let corner = vi % 6u;
        let st = quad / SPHERE_SLICES;
        let sl = quad % SPHERE_SLICES;
        var offs = array<vec2<u32>, 6>(
            vec2<u32>(0u,0u), vec2<u32>(1u,0u), vec2<u32>(0u,1u),
            vec2<u32>(0u,1u), vec2<u32>(1u,0u), vec2<u32>(1u,1u));
        let o = offs[corner];
        let i = st + o.x;
        let j = sl + o.y;
        let phi = 3.14159265 * f32(i) / f32(SPHERE_STACKS);
        let theta = 6.28318530718 * f32(j) / f32(SPHERE_SLICES);
        let n = vec3<f32>(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
        pos = n * 0.5;
        nrm = n;
    }}

    let model = rot_z(in.b.z) * rot_y(in.b.y) * rot_x(in.b.x);
    let world = in.a.xyz + model * (pos * in.a.w);
    let wn = model * nrm;

    let eye = cam.c0.xyz;
    let fov = cam.c0.w;
    let focus = cam.c1.xyz;
    let aspect = cam.c1.w;
    let z_near = cam.c2.x;
    let z_far = cam.c2.y;

    let f = normalize(focus - eye);
    let s = normalize(cross(f, vec3<f32>(0.0, 1.0, 0.0)));
    let u = cross(s, f);
    let view = mat4x4<f32>(
        vec4<f32>(s.x, u.x, -f.x, 0.0),
        vec4<f32>(s.y, u.y, -f.y, 0.0),
        vec4<f32>(s.z, u.z, -f.z, 0.0),
        vec4<f32>(-dot(s, eye), -dot(u, eye), dot(f, eye), 1.0));
    let gg = 1.0 / tan(fov * 0.5);
    let nf = 1.0 / (z_near - z_far);
    let proj = mat4x4<f32>(
        vec4<f32>(gg / aspect, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, gg, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, z_far * nf, -1.0),
        vec4<f32>(0.0, 0.0, z_far * z_near * nf, 0.0));

    var out: Out;
    out.clip = proj * (view * vec4<f32>(world, 1.0));
    out.color = in.col;
    out.normal = wn;
    return out;
}}

@fragment
fn fs(o: Out) -> @location(0) vec4<f32> {{
    let n = normalize(o.normal);
    let l = normalize(vec3<f32>(0.4, 0.8, 0.5));
    let sh = 0.25 + max(dot(n, l), 0.0) * 0.75;
    return vec4<f32>(o.color.rgb * sh, o.color.a);
}}
"#,
        pos_lits = pos_lits,
        nrm_lits = nrm_lits,
    )
}

/// 36 cube vertices (6 faces × 2 triangles × 3), positions + per-face normals.
fn cube_vertices() -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
        ([0.0, 0.0, 1.0], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]),
        ([0.0, 0.0, -1.0], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]),
        ([1.0, 0.0, 0.0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]),
        ([-1.0, 0.0, 0.0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]),
        ([0.0, 1.0, 0.0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]),
        ([0.0, -1.0, 0.0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]),
    ];
    let mut pos = Vec::new();
    let mut nrm = Vec::new();
    for (normal, c) in faces {
        for &idx in &[0usize, 1, 2, 0, 2, 3] {
            pos.push(c[idx]);
            nrm.push(normal);
        }
    }
    (pos, nrm)
}

// --- shared resource sets ----------------------------------------------------

fn instance_layout() -> VertexBufferLayout {
    VertexBufferLayout {
        array_stride: 48,
        step_mode: "instance".into(),
        attributes: vec![
            VertexAttribute { format: "float32x4".into(), offset: 0, shader_location: 0 },
            VertexAttribute { format: "float32x4".into(), offset: 16, shader_location: 1 },
            VertexAttribute { format: "float32x4".into(), offset: 32, shader_location: 2 },
        ],
    }
}

fn globals_bgl(id: &str) -> ResourceDesc {
    ResourceDesc::BindGroupLayout(BindGroupLayoutDesc {
        id: id.into(),
        entries: vec![BindGroupLayoutEntry {
            binding: 0,
            visibility: vec!["VERTEX".into()],
            ty: "uniform".into(),
        }],
    })
}

fn shared_2d() -> Vec<ResourceDesc> {
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
        ResourceDesc::Shader(ShaderDesc { id: SH2.into(), wgsl: WGSL_2D.into() }),
        globals_bgl(BGL2),
        ResourceDesc::PipelineLayout(PipelineLayoutDesc {
            id: LAY2.into(),
            bind_group_layouts: vec![BGL2.into()],
        }),
        ResourceDesc::RenderPipeline(RenderPipelineDesc {
            id: PIPE2.into(),
            layout: Some(LAY2.into()),
            vertex: VertexState {
                module: SH2.into(),
                entry_point: "vs".into(),
                buffers: vec![instance_layout()],
            },
            fragment: Some(FragmentState {
                module: SH2.into(),
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

fn shared_3d() -> Vec<ResourceDesc> {
    vec![
        ResourceDesc::Shader(ShaderDesc { id: SH3.into(), wgsl: wgsl_3d() }),
        globals_bgl(BGL3),
        ResourceDesc::PipelineLayout(PipelineLayoutDesc {
            id: LAY3.into(),
            bind_group_layouts: vec![BGL3.into()],
        }),
        ResourceDesc::RenderPipeline(RenderPipelineDesc {
            id: PIPE3.into(),
            layout: Some(LAY3.into()),
            vertex: VertexState {
                module: SH3.into(),
                entry_point: "vs".into(),
                buffers: vec![instance_layout()],
            },
            fragment: Some(FragmentState {
                module: SH3.into(),
                entry_point: "fs".into(),
                targets: vec![ColorTargetState {
                    format: COLOR_FORMAT.into(),
                    blend: None,
                    write_mask: vec![],
                }],
            }),
            primitive: PrimitiveState {
                topology: "triangle-list".into(),
                strip_index_format: None,
                front_face: "ccw".into(),
                cull_mode: "back".into(),
            },
            depth_stencil: Some(DepthStencilState {
                format: DEPTH_FORMAT.into(),
                depth_write_enabled: true,
                depth_compare: "less".into(),
            }),
            multisample: Default::default(),
        }),
    ]
}

// --- shape catalog -----------------------------------------------------------

/// One standard shape: name, dimension, and the draw's vertex count.
struct Shape {
    name: &'static str,
    dim: u8,
    vertex_count: u32,
}

fn catalog() -> Vec<Shape> {
    vec![
        Shape { name: "rect", dim: 2, vertex_count: 6 },
        Shape { name: "triangle", dim: 2, vertex_count: 9 }, // 3 sides * 3
        Shape { name: "circle", dim: 2, vertex_count: 144 }, // 48 sides * 3
        Shape { name: "cube", dim: 3, vertex_count: 36 },
        Shape { name: "sphere", dim: 3, vertex_count: 768 }, // 8 * 16 * 6
    ]
}

fn shape_def_id(name: &str) -> String {
    format!("elpa.sdk.{name}")
}
fn shape_instances_id(name: &str) -> String {
    format!("elpa.sdk.{name}.instances")
}

/// A reusable render definition for one shape: the shared pipeline set for its
/// dimension + a draw of `instance_count` instances from the shape's instance
/// buffer (which the app supplies). Geometry is procedural in the shader, so
/// there is no vertex/index geometry buffer.
fn shape_definition(shape: &Shape, instance_count: u32) -> Definition {
    let pipe = if shape.dim == 3 { PIPE3 } else { PIPE2 };
    let resources = if shape.dim == 3 { shared_3d() } else { shared_2d() };
    Definition {
        id: shape_def_id(shape.name),
        resources,
        body: DefinitionBody::Render {
            commands: vec![
                RenderCommand::SetPipeline { pipeline: pipe.into() },
                RenderCommand::SetVertexBuffer {
                    slot: 0,
                    buffer: shape_instances_id(shape.name),
                    offset: 0,
                },
                RenderCommand::Draw {
                    vertex_count: shape.vertex_count,
                    instance_count,
                    first_vertex: 0,
                    first_instance: 0,
                },
            ],
        },
    }
}

// --- AST emission ------------------------------------------------------------

/// Convert plain JSON to an Elpian AST literal expression, omitting null fields
/// (every nullable protocol field is an `Option` with a serde default, so an
/// omitted key round-trips back to `None`; an explicit null would fail to parse).
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

// --- AST expression helpers (for the demo's computed, animated scene) --------

fn a_s(v: &str) -> Value {
    json!({ "type": "string", "data": { "value": v } })
}
fn a_i(v: i64) -> Value {
    json!({ "type": "i64", "data": { "value": v } })
}
fn a_f(v: f64) -> Value {
    json!({ "type": "f64", "data": { "value": v } })
}
fn a_bool(v: bool) -> Value {
    json!({ "type": "bool", "data": { "value": v } })
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
fn a_mul(a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": "*", "operand1": a, "operand2": b } })
}
fn a_add(a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": "+", "operand1": a, "operand2": b } })
}
fn a_index(target: Value, key: &str) -> Value {
    json!({ "type": "indexer", "data": { "target": target, "index": a_s(key) } })
}
fn a_define(name: &str, value: Value) -> Value {
    json!({ "type": "definition", "data": { "leftSide": a_id(name), "rightSide": value } })
}
fn a_assign(name: &str, value: Value) -> Value {
    json!({ "type": "assignment", "data": { "leftSide": a_id(name), "rightSide": value } })
}
fn a_call(name: &str) -> Value {
    json!({ "type": "functionCall", "data": { "callee": a_id(name), "args": [] } })
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
        ("entries", a_arr(vec![a_obj(vec![
            ("binding", a_i(0)),
            ("resource", a_obj(vec![("type", a_s("buffer")), ("buffer", a_s(buffer))])),
        ])])),
    ])
}

fn a_rgba(r: f64, g: f64, b: f64, a: f64) -> Vec<Value> {
    vec![a_f(r), a_f(g), a_f(b), a_f(a)]
}

fn a_use(def: &str) -> Value {
    a_obj(vec![("cmd", a_s("useDefinition")), ("definition", a_s(def))])
}

fn a_set_bind(group: &str) -> Value {
    a_obj(vec![("cmd", a_s("setBindGroup")), ("index", a_i(0)), ("bind_group", a_s(group))])
}

fn a_surface_clear(r: f64, g: f64, b: f64) -> Value {
    a_obj(vec![
        ("view", a_obj(vec![("kind", a_s("surface"))])),
        ("load", a_s("clear")),
        ("clear_color", a_obj(vec![("r", a_f(r)), ("g", a_f(g)), ("b", a_f(b)), ("a", a_f(1.0))])),
    ])
}

fn a_surface_load() -> Value {
    a_obj(vec![("view", a_obj(vec![("kind", a_s("surface"))])), ("load", a_s("load"))])
}

/// The importable SDK module: a `gpu.define` per catalog shape (single-instance
/// building blocks). An app `vm.import`s this, then references shapes by id.
fn build_module() -> Value {
    let body = catalog().iter().map(|s| host_call("gpu.define", vec![literal(&shape_definition(s, 1))])).collect();
    program(body)
}

/// A complete, runnable demo **app** (Elpian AST). It imports the SDK module,
/// then on every frame builds one frame with two passes — a depth-tested 3D pass
/// (a rotating cube and sphere) and a 2D overlay pass (a rotating rect, triangle
/// and circle) — referencing the SDK shapes by id and supplying only numeric
/// per-instance data. The scene sizes itself from `gpu.surfaceInfo`, so it fills
/// any window; rotation is driven by a frame counter (the WGSL builds the
/// matrices, so no trig is needed in the VM). This is exactly what the web
/// example loads onto GitHub Pages.
fn build_demo() -> Value {
    // Live surface metrics queried each render.
    let width = a_index(a_id("si"), "width");
    let height = a_index(a_id("si"), "height");
    let aspect = a_index(a_id("si"), "aspect");
    let spin = |k: f64| a_mul(a_id("n"), a_f(k)); // angle = n * k

    // --- 3D pass resources: camera + depth + per-instance data ---------------
    let camera = a_buffer(
        GLB3,
        &["UNIFORM", "COPY_DST"],
        // eye.xyz, fovY | target.xyz, aspect | near, far, _, _
        vec![
            a_f(3.6), a_f(2.6), a_f(4.2), a_f(std::f64::consts::FRAC_PI_3),
            a_f(0.0), a_f(0.0), a_f(0.0), aspect,
            a_f(0.1), a_f(100.0), a_f(0.0), a_f(0.0),
        ],
    );
    let depth = a_obj(vec![
        ("kind", a_s("texture")),
        ("id", a_s(DEPTH)),
        ("size", a_obj(vec![("width", width.clone()), ("height", height.clone()), ("depth", a_i(1))])),
        ("format", a_s(DEPTH_FORMAT)),
        ("usage", a_arr(vec![a_s("RENDER_ATTACHMENT")])),
    ]);
    // 3D instance layout: pos.xyz, scale | rot.xyz, kind | rgba
    let mut cube_inst = vec![a_f(-1.2), a_f(0.0), a_f(0.0), a_f(1.0), a_f(0.5), spin(0.02), a_f(0.0), a_f(0.0)];
    cube_inst.extend(a_rgba(0.20, 0.52, 0.96, 1.0));
    let mut sphere_inst = vec![a_f(1.2), a_f(0.0), a_f(0.0), a_f(1.25), a_f(0.0), spin(0.015), a_f(0.0), a_f(1.0)];
    sphere_inst.extend(a_rgba(0.96, 0.42, 0.30, 1.0));

    let pass3d = a_obj(vec![
        ("op", a_s("renderPass")),
        ("id", a_s("elpa.sdk.demo.3d")),
        ("color_attachments", a_arr(vec![a_surface_clear(0.05, 0.06, 0.09)])),
        ("depth_stencil", a_obj(vec![
            ("view", a_s(DEPTH)),
            ("depth_load", a_s("clear")),
            ("depth_clear", a_f(1.0)),
            ("depth_store", a_bool(true)),
        ])),
        ("commands", a_arr(vec![
            a_set_bind(GLB3_BIND),
            a_use(&shape_def_id("cube")),
            a_use(&shape_def_id("sphere")),
        ])),
    ]);

    // --- 2D overlay pass resources: viewport + per-instance data -------------
    let viewport = a_buffer(GLB2, &["UNIFORM", "COPY_DST"], vec![width.clone(), height.clone(), a_f(0.0), a_f(0.0)]);
    // 2D instance layout: center.xy, size.xy | rot, sides, kind, _ | rgba
    let cx = |frac: f64| a_mul(width.clone(), a_f(frac));
    let cy = a_mul(height.clone(), a_f(0.82));
    let mut rect_inst = vec![cx(0.30), cy.clone(), a_f(150.0), a_f(90.0), spin(0.01), a_f(0.0), a_f(0.0), a_f(0.0)];
    rect_inst.extend(a_rgba(0.30, 0.80, 0.45, 1.0));
    let mut tri_inst = vec![cx(0.50), cy.clone(), a_f(60.0), a_f(60.0), spin(0.02), a_f(3.0), a_f(1.0), a_f(0.0)];
    tri_inst.extend(a_rgba(0.95, 0.85, 0.20, 1.0));
    let mut circ_inst = vec![cx(0.70), cy, a_f(55.0), a_f(55.0), a_f(0.0), a_f(48.0), a_f(1.0), a_f(0.0)];
    circ_inst.extend(a_rgba(0.90, 0.35, 0.40, 1.0));

    let pass2d = a_obj(vec![
        ("op", a_s("renderPass")),
        ("id", a_s("elpa.sdk.demo.2d")),
        ("color_attachments", a_arr(vec![a_surface_load()])), // draw over the 3D scene
        ("commands", a_arr(vec![
            a_set_bind(GLB2_BIND),
            a_use(&shape_def_id("rect")),
            a_use(&shape_def_id("triangle")),
            a_use(&shape_def_id("circle")),
        ])),
    ]);

    let frame = a_obj(vec![
        ("resources", a_arr(vec![
            camera,
            a_globals_bind(GLB3_BIND, BGL3, GLB3),
            depth,
            a_buffer(&shape_instances_id("cube"), &["VERTEX"], cube_inst),
            a_buffer(&shape_instances_id("sphere"), &["VERTEX"], sphere_inst),
            viewport,
            a_globals_bind(GLB2_BIND, BGL2, GLB2),
            a_buffer(&shape_instances_id("rect"), &["VERTEX"], rect_inst),
            a_buffer(&shape_instances_id("triangle"), &["VERTEX"], tri_inst),
            a_buffer(&shape_instances_id("circle"), &["VERTEX"], circ_inst),
        ])),
        ("commands", a_arr(vec![pass3d, pass2d])),
    ]);

    // render(): query the surface, then submit the frame.
    let render = a_func(
        "render",
        vec![],
        vec![a_define("si", host_call("gpu.surfaceInfo", vec![])), host_call("gpu.submit", vec![frame])],
    );

    program(vec![
        // Pull the SDK shapes into the definition store.
        host_call("vm.import", vec![a_s("assets/elpa-sdk.ast.json")]),
        a_define("n", a_i(0)),
        render,
        // Animate: advance the counter and redraw each tick.
        a_func("onFrame", vec!["dt"], vec![a_assign("n", a_add(a_id("n"), a_i(1))), a_call("render")]),
        // Redraw on resize so the scene refits to the new surface.
        a_func("onResize", vec!["info"], vec![a_call("render")]),
        // First paint.
        a_call("render"),
    ])
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    fs::create_dir_all(&dir).unwrap();

    let module = serde_json::to_string_pretty(&build_module()).unwrap();
    fs::write(dir.join("elpa-sdk.ast.json"), &module).unwrap();

    let demo = serde_json::to_string_pretty(&build_demo()).unwrap();
    fs::write(dir.join("demo.ast.json"), &demo).unwrap();

    println!(
        "wrote assets/elpa-sdk.ast.json ({} bytes) and assets/demo.ast.json ({} bytes)",
        module.len(),
        demo.len()
    );
}
