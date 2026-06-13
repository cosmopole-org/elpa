//! End-to-end proof that the ported Elpian VM drives Elpa: compile an AST that
//! builds a wgpu command tree and calls `gpu.submit`, pump the host-call loop,
//! and confirm the runtime surfaces a parsed `Frame` — then feed that frame
//! through the real `Renderer` and assert the partial-render behavior.

use elpa_renderer::{FrameStats, GpuBackend, Renderer};
use elpa_runtime::Runtime;
use elpa_protocol::{ComputePass, EncoderCommand, Frame, Rect, RenderPass, ResourceDesc};
use serde_json::json;

/// A trivial counting backend so we can assert on GPU work without a GPU.
#[derive(Default)]
struct CountingBackend {
    created: usize,
    rendered: usize,
}
impl GpuBackend for CountingBackend {
    fn create_resource(&mut self, _d: &ResourceDesc) {
        self.created += 1;
    }
    fn destroy_resource(&mut self, _id: &str) {}
    fn begin_frame(&mut self) {}
    fn record_render_pass(&mut self, _p: &RenderPass) {
        self.rendered += 1;
    }
    fn record_compute_pass(&mut self, _p: &ComputePass) {}
    fn record_encoder_command(&mut self, _c: &EncoderCommand) {}
    fn end_frame(&mut self, _d: &[Rect]) {}
}

/// An Elpian AST whose body is a `host_call` to `gpu.submit` carrying a one-pass
/// wgpu command tree (a shader + a triangle pipeline drawn to the surface) —
/// exactly what an app's `gpu.submit(frame)` lowers to in the front-end.
fn submit_program() -> String {
    // Helpers to build typed AST literal nodes.
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

    let frame = obj(json!({
        "resources": arr(vec![
            obj(json!({ "kind": s("shader"), "id": s("sh"), "wgsl": s("// wgsl") })),
            obj(json!({
                "kind": s("renderPipeline"), "id": s("pipe"),
                "vertex":   obj(json!({ "module": s("sh"), "entry_point": s("vs") })),
                "fragment": obj(json!({
                    "module": s("sh"), "entry_point": s("fs"),
                    "targets": arr(vec![ obj(json!({ "format": s("bgra8unorm") })) ])
                }))
            })),
        ]),
        "commands": arr(vec![
            obj(json!({
                "op": s("renderPass"), "id": s("main"),
                "color_attachments": arr(vec![
                    obj(json!({ "view": obj(json!({ "kind": s("surface") })) }))
                ]),
                "commands": arr(vec![
                    obj(json!({ "cmd": s("setPipeline"), "pipeline": s("pipe") })),
                    obj(json!({ "cmd": s("draw"), "vertex_count": i(3) })),
                ])
            }))
        ])
    }));

    json!({
        "type": "program",
        "body": [
            { "type": "host_call", "data": { "name": "gpu.submit", "args": [ frame ] } }
        ]
    })
    .to_string()
}

#[test]
fn vm_submit_surfaces_a_wgpu_frame_and_renders_it() {
    let mut rt = Runtime::from_ast("e2e", &submit_program())
        .expect("AST should compile and register a VM");

    // Drive the VM; capture the submitted frame.
    let mut captured: Option<Frame> = None;
    rt.run(|frame| captured = Some(frame.clone()));

    let frame = captured.expect("VM should have submitted exactly one frame");
    assert_eq!(frame.resources.len(), 2, "shader + pipeline");
    assert_eq!(frame.commands.len(), 1, "one render pass");
    match &frame.commands[0] {
        EncoderCommand::RenderPass(rp) => {
            assert_eq!(rp.id.as_deref(), Some("main"));
            assert!(rp.targets_surface());
        }
        _ => panic!("expected a render pass"),
    }

    // Now map that VM-produced frame through the real renderer.
    let mut renderer = Renderer::new(CountingBackend::default());
    let s1 = renderer.render(&frame);
    assert_eq!(s1.resources_created, 2);
    assert!(s1.presented);
    assert_eq!(renderer.backend().created, 2);
    assert_eq!(renderer.backend().rendered, 1);

    // Re-submitting the identical frame is fully cached: the static pipeline and
    // the unchanged surface pass are reused, so no GPU work and no present.
    let s2 = renderer.render(&frame);
    assert_eq!(s2, FrameStats::default());
    assert_eq!(renderer.backend().created, 2, "pipeline/shader not recreated");
    assert_eq!(renderer.backend().rendered, 1, "pass not re-recorded");
}
