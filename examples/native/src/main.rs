use std::rc::Rc;

use elpa::{Elpa, SurfaceInfo, WgpuBackend};
use winit::{event::*, event_loop::{ControlFlow, EventLoop}, window::Window};

mod app_ast {
    use serde_json::{json, Value};

    fn s(v: &str) -> Value { json!({ "type": "string", "data": { "value": v } }) }
    fn i(v: i64) -> Value { json!({ "type": "i64", "data": { "value": v } }) }
    fn f(v: f64) -> Value { json!({ "type": "f64", "data": { "value": v } }) }
    fn id(name: &str) -> Value { json!({ "type": "identifier", "data": { "name": name } }) }
    fn obj(map: Value) -> Value { json!({ "type": "object", "data": { "value": map } }) }
    fn arr(items: Vec<Value>) -> Value { json!({ "type": "array", "data": { "value": items } }) }
    fn arith(op: &str, a: Value, b: Value) -> Value { json!({ "type": "arithmetic", "data": { "operation": op, "operand1": a, "operand2": b } }) }
    fn assign(name: &str, value: Value) -> Value { json!({ "type": "assignment", "data": { "leftSide": id(name), "rightSide": value } }) }
    fn define(name: &str, value: Value) -> Value { json!({ "type": "definition", "data": { "leftSide": id(name), "rightSide": value } }) }
    fn call_host(name: &str, args: Vec<Value>) -> Value { json!({ "type": "host_call", "data": { "name": name, "args": args } }) }
    fn call(name: &str, args: Vec<Value>) -> Value { json!({ "type": "functionCall", "data": { "callee": id(name), "args": args } }) }
    fn func(name: &str, params: Vec<&str>, body: Vec<Value>) -> Value { json!({ "type": "functionDefinition", "data": { "name": name, "params": params, "body": body } }) }

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

    pub fn build(surface_format: &str) -> String {
        let red = arith("/", arith("%", id("n"), i(120)), f(120.0));
        let frame = obj(json!({
            "resources": arr(vec![
                obj(json!({ "kind": s("shader"), "id": s("sh"), "wgsl": s(WGSL) })),
                obj(json!({
                    "kind": s("renderPipeline"), "id": s("pipe"),
                    "vertex": obj(json!({ "module": s("sh"), "entry_point": s("vs") })),
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
}

fn format_token(fmt: wgpu::TextureFormat) -> String {
    use wgpu::TextureFormat as F;
    match fmt {
        F::Bgra8Unorm => "bgra8unorm",
        F::Bgra8UnormSrgb => "bgra8unorm-srgb",
        F::Rgba8Unorm => "rgba8unorm",
        F::Rgba8UnormSrgb => "rgba8unorm-srgb",
        _ => "bgra8unorm",
    }
    .to_string()
}

fn main() {
    env_logger::init();

    let event_loop = EventLoop::new().unwrap();
    let window = event_loop
        .create_window(Window::default_attributes())
        .expect("failed to create window");

    // Create wgpu instance and surface
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::from_window_without_display(&window))
        .expect("create surface from window");

    // Initialize wgpu backend and Elpa (async -> block_on)
    let backend = pollster::block_on(async { WgpuBackend::new(&instance, surface, 800, 600).await });
    let format_token = format_token(backend.surface_format());

    let ast = app_ast::build(&format_token);
    let surface_info = SurfaceInfo::new(800, 600, 1.0);

    let mut app = Elpa::new(backend, surface_info, &ast).expect("app AST compiles");
    app.start();

    let app = Rc::new(std::cell::RefCell::new(app));

    event_loop
        .run(move |event, active_loop| {
            active_loop.set_control_flow(ControlFlow::Poll);
            match event {
                Event::WindowEvent { event, .. } => match event {
                    WindowEvent::CloseRequested => active_loop.exit(),
                    WindowEvent::Resized(physical_size) => {
                        let mut app = app.borrow_mut();
                        app.renderer_mut()
                            .backend_mut()
                            .resize(physical_size.width, physical_size.height);
                        app.resize(physical_size.width, physical_size.height, 1.0);
                    }
                    _ => {}
                },
                    Event::NewEvents(cause) => match cause {
                        StartCause::Init | StartCause::Poll => {
                            // Drive animation and present a frame
                            app.borrow_mut().animate(16.0);
                        }
                        _ => {}
                    },
                _ => {}
            }
        })
        .expect("event loop failed");
}
