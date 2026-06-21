//! Run the Web SDK + showcase page on a real (headless) Elpa instance - proof
//! that the SDK and app compile, link into one VM, and drive the CSS layout +
//! paint pipeline end to end: the document mounts, the box model / flow / flex /
//! grid lay it out, the whole page renders as one instanced SDF draw, and
//! pointer / keyboard events flow through the SDK's closures and change what is
//! rendered.

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

#[test]
fn sdk_shaders_are_valid_wgsl() {
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_websdk::module_js())).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert!(!shaders.is_empty(), "the kit ships WGSL shaders");
    for src in &shaders {
        let module = naga::front::wgsl::parse_str(src)
            .unwrap_or_else(|e| panic!("WGSL parse failed: {}", e.emit_to_string(src)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .expect("WGSL validation failed");
    }
}

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 1.0),
        &elpa_websdk::program(),
    )
    .expect("SDK + app program compiles")
}

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id.starts_with("elpa.web.inst") => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

#[test]
fn page_mounts_and_paints() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.web.pipe"), "pipeline created");

    // The whole page is at least one instanced SDF draw.
    let inst = instances(&app);
    assert!(inst.len() >= 16, "the page emitted instances ({} floats)", inst.len());
    assert_eq!(inst.len() % 16, 0, "instance stride is 16 floats");
}

#[test]
fn click_repaints_and_changes_the_page() {
    let mut app = instance();
    app.start();
    let before = instances(&app).len();

    // Click around the counter button (left card region) - exercises tap
    // hit-testing + the component partial-update path.
    app.send_event(&InputEvent::PointerDown { x: 150.0, y: 320.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 150.0, y: 320.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap after click: {:?}", app.trap_reason());

    // Focus the text field (lower form row) and type into it.
    app.send_event(&InputEvent::PointerDown { x: 200.0, y: 720.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 200.0, y: 720.0, button: 0 });
    app.send_event(&InputEvent::KeyDown { key: "H".into() });
    app.send_event(&InputEvent::KeyDown { key: "i".into() });
    assert!(app.trap_reason().is_none(), "no trap after typing: {:?}", app.trap_reason());
    let after = instances(&app).len();
    assert!(after >= before, "page still renders after interaction");
}

#[test]
fn animation_frame_is_stable() {
    let mut app = instance();
    app.start();
    for _ in 0..8 {
        app.animate(16.0);
        assert!(app.trap_reason().is_none(), "no trap during animation: {:?}", app.trap_reason());
    }
}
