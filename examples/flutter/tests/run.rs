//! Run the Flutter SDK + demo on a real (headless) Elpa instance — proof that the
//! layered SDK and app compile, link into one VM, and drive the dart:ui → raster
//! → GPU pipeline end to end. As the rendering / widgets layers land, the deeper
//! tests below assert the constraint protocol, layout and reconciliation behave
//! like Flutter.

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
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_flutter::module_js())).unwrap();
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
        &elpa_flutter::program(),
    )
    .expect("SDK + app program compiles")
}

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.fl.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

#[test]
fn app_mounts_and_paints() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.fl.pipe"), "pipeline created");

    let inst = instances(&app);
    assert!(inst.len() >= 16, "the app emitted instances ({} floats)", inst.len());
    assert_eq!(inst.len() % 16, 0, "instance stride is 16 floats");
}

#[test]
fn widget_tree_relayouts_on_resize() {
    // The widget tree inflates an element tree that builds a render tree; a resize
    // reconfigures the RenderView and re-runs layout/paint without trapping.
    let mut app = instance();
    app.start();
    let before = instances(&app).len();
    assert!(before > 16, "the widget demo emits a non-trivial frame");

    app.resize(700, 1200, 2.0);
    assert!(app.trap_reason().is_none(), "no VM trap on resize: {:?}", app.trap_reason());
    assert!(app.last_stats().presented, "resized frame presented");
    let after = instances(&app).len();
    assert_eq!(after % 16, 0, "instance stride preserved after resize");
    assert!(after > 16, "the widget tree re-laid-out and re-painted on resize");
}

#[test]
fn tap_drives_setstate_rebuild() {
    // The interactive loop: a tap on the GestureDetector hit-tests to the
    // RenderPointerListener, fires onTap → setState → markNeedsBuild, the
    // BuildOwner rebuilds the dirty subtree, and a new frame is submitted whose
    // counter text changed (different glyph instances) — with no VM trap.
    let mut app = instance();
    app.start();
    let base = instances(&app);

    // The "TAP ME" button sits in the bottom half of the centred 360-wide column;
    // scan the column centre so the test does not depend on exact layout metrics.
    let mut changed = false;
    let mut y = 300.0;
    while y < 760.0 {
        app.send_event(&InputEvent::PointerDown { x: 500.0, y, button: 0 });
        app.send_event(&InputEvent::PointerUp { x: 500.0, y, button: 0 });
        assert!(app.trap_reason().is_none(), "no VM trap on tap: {:?}", app.trap_reason());
        if instances(&app) != base {
            changed = true;
            break;
        }
        y += 20.0;
    }
    assert!(changed, "a tap on the GestureDetector fired onTap → setState → rebuild → new frame");
    assert!(app.last_stats().presented, "the rebuilt frame was submitted");
    assert_eq!(instances(&app).len() % 16, 0, "instance stride preserved after tap");
}
