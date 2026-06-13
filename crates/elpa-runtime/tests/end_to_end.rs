//! Proof that the ported VM drives the runtime pump: compile an AST that builds
//! a wgpu command tree and calls `gpu.submit`, pump the host-call loop, and
//! confirm a `Frame` is surfaced and answers a `gpu.surfaceInfo` query.

use elpa_protocol::{EncoderCommand, Frame};
use elpa_runtime::{frame_from_submit, reply_json, reply_null, Runtime, Start};
use serde_json::json;

fn s(v: &str) -> serde_json::Value {
    json!({ "type": "string", "data": { "value": v } })
}
fn i(v: i64) -> serde_json::Value {
    json!({ "type": "i64", "data": { "value": v } })
}
fn obj(map: serde_json::Value) -> serde_json::Value {
    json!({ "type": "object", "data": { "value": map } })
}
fn arr(items: Vec<serde_json::Value>) -> serde_json::Value {
    json!({ "type": "array", "data": { "value": items } })
}

/// AST whose body submits a one-pass triangle frame, then asks for surfaceInfo.
fn program() -> String {
    let frame = obj(json!({
        "resources": arr(vec![
            obj(json!({ "kind": s("shader"), "id": s("sh"), "wgsl": s("// wgsl") })),
        ]),
        "commands": arr(vec![
            obj(json!({
                "op": s("renderPass"), "id": s("main"),
                "color_attachments": arr(vec![ obj(json!({ "view": obj(json!({ "kind": s("surface") })) })) ]),
                "commands": arr(vec![ obj(json!({ "cmd": s("draw"), "vertex_count": i(3) })) ])
            }))
        ])
    }));
    json!({
        "type": "program",
        "body": [
            { "type": "host_call", "data": { "name": "gpu.submit", "args": [ frame ] } },
            { "type": "host_call", "data": { "name": "gpu.surfaceInfo", "args": [] } }
        ]
    })
    .to_string()
}

#[test]
fn pump_surfaces_frame_and_answers_surface_info() {
    let mut rt = Runtime::from_ast("rt-e2e", &program()).expect("AST compiles");

    let mut captured: Option<Frame> = None;
    let mut asked_surface = false;
    rt.pump(Start::Main, |hc| match hc.api_name.as_str() {
        "gpu.submit" => {
            captured = frame_from_submit(hc);
            reply_null()
        }
        "gpu.surfaceInfo" => {
            asked_surface = true;
            reply_json(&json!({ "width": 1920, "height": 1080, "scaleFactor": 2.0 }))
        }
        _ => reply_null(),
    });

    let frame = captured.expect("a frame was submitted");
    assert_eq!(frame.resources.len(), 1);
    assert!(matches!(frame.commands[0], EncoderCommand::RenderPass(_)));
    assert!(asked_surface, "the VM queried surfaceInfo");
}
