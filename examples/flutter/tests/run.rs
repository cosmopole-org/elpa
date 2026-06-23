//! Run the Flutter SDK + demo on a real (headless) Elpa instance — proof that the
//! layered SDK and app compile, link into one VM, and drive the dart:ui → raster
//! → GPU pipeline end to end. As the rendering / widgets layers land, the deeper
//! tests below assert the constraint protocol, layout and reconciliation behave
//! like Flutter.

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, SurfaceInfo};

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
