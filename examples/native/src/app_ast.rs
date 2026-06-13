//! Builds the example app's program as Elpian **AST JSON** at runtime — the same
//! triangle-over-animated-background program the web example draws, so the
//! desktop/Android and web builds render identically. See `examples/web` for the
//! annotated walkthrough of the structure.

use serde_json::{json, Value};

fn s(v: &str) -> Value {
    json!({ "type": "string", "data": { "value": v } })
}
fn i(v: i64) -> Value {
    json!({ "type": "i64", "data": { "value": v } })
}
fn f(v: f64) -> Value {
    json!({ "type": "f64", "data": { "value": v } })
}
fn id(name: &str) -> Value {
    json!({ "type": "identifier", "data": { "name": name } })
}
fn obj(map: Value) -> Value {
    json!({ "type": "object", "data": { "value": map } })
}
fn arr(items: Vec<Value>) -> Value {
    json!({ "type": "array", "data": { "value": items } })
}
fn arith(op: &str, a: Value, b: Value) -> Value {
    json!({ "type": "arithmetic", "data": { "operation": op, "operand1": a, "operand2": b } })
}
fn assign(name: &str, value: Value) -> Value {
    json!({ "type": "assignment", "data": { "leftSide": id(name), "rightSide": value } })
}
fn define(name: &str, value: Value) -> Value {
    json!({ "type": "definition", "data": { "leftSide": id(name), "rightSide": value } })
}
fn call_host(name: &str, args: Vec<Value>) -> Value {
    json!({ "type": "host_call", "data": { "name": name, "args": args } })
}
fn call(name: &str, args: Vec<Value>) -> Value {
    json!({ "type": "functionCall", "data": { "callee": id(name), "args": args } })
}
fn func(name: &str, params: Vec<&str>, body: Vec<Value>) -> Value {
    json!({ "type": "functionDefinition", "data": { "name": name, "params": params, "body": body } })
}

const WGSL: &str = r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(
        vec2<f32>( 0.0,  0.6),
        vec2<f32>(-0.6, -0.6),
        vec2<f32>( 0.6, -0.6),
    );
    return vec4<f32>(p[vi], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.15, 0.7, 1.0, 1.0);
}
"#;

/// Build the program. `surface_format` is the wgpu format token the host's
/// surface uses; the pipeline's color target must match it.
pub fn build(surface_format: &str) -> String {
    let red = arith("/", arith("%", id("n"), i(120)), f(120.0));
    let frame = obj(json!({
        "resources": arr(vec![
            obj(json!({ "kind": s("shader"), "id": s("sh"), "wgsl": s(WGSL) })),
            obj(json!({
                "kind": s("renderPipeline"), "id": s("pipe"),
                "vertex":   obj(json!({ "module": s("sh"), "entry_point": s("vs") })),
                "fragment": obj(json!({
                    "module": s("sh"), "entry_point": s("fs"),
                    "targets": arr(vec![ obj(json!({ "format": s(surface_format) })) ])
                }))
            })),
        ]),
        "commands": arr(vec![
            obj(json!({
                "op": s("renderPass"), "id": s("main"),
                "color_attachments": arr(vec![ obj(json!({
                    "view": obj(json!({ "kind": s("surface") })),
                    "load": s("clear"),
                    "clear_color": obj(json!({ "r": red, "g": f(0.05), "b": f(0.12), "a": f(1.0) }))
                })) ]),
                "commands": arr(vec![
                    obj(json!({ "cmd": s("setPipeline"), "pipeline": s("pipe") })),
                    obj(json!({ "cmd": s("draw"), "vertex_count": i(3) })),
                ])
            }))
        ])
    }));

    let program = json!({
        "type": "program",
        "body": [
            define("n", i(0)),
            func("render", vec![], vec![ call_host("gpu.submit", vec![ frame ]) ]),
            func("onFrame", vec!["dt"], vec![ assign("n", arith("+", id("n"), i(1))), call("render", vec![]) ]),
            func("onEvent", vec!["e"], vec![ assign("n", arith("+", id("n"), i(20))), call("render", vec![]) ]),
            func("onResize", vec!["info"], vec![ call("render", vec![]) ]),
            call("render", vec![]),
        ]
    });
    program.to_string()
}
