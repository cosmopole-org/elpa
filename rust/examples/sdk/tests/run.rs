//! Run the SDK's **JSON AST** assets on a real (headless) Elpa instance — proof
//! that the SDK (which is the AST JSON, not Rust) loads and draws end to end:
//! `vm.import` registers the shape definitions, and frames reference shapes by id
//! while the host expands them into the full wgpu command tree.

use elpa::{Elpa, HeadlessBackend, SurfaceInfo};
use elpa::protocol::{EncoderCommand, RenderCommand};

/// Recursively collect every WGSL string literal from an AST JSON value (a
/// shader's `wgsl` field is a `{"type":"string",...}` node whose value contains
/// `@vertex`).
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
    // Parse + validate every shader the SDK module carries exactly as wgpu does,
    // so reserved-keyword / syntax errors fail in `cargo test` (not in a browser).
    let ast: serde_json::Value = serde_json::from_str(elpa_sdk::MODULE_AST).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert!(shaders.len() >= 2, "expected 2D and 3D shaders, got {}", shaders.len());

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

const SHAPES: [&str; 5] =
    ["elpa.sdk.rect", "elpa.sdk.triangle", "elpa.sdk.circle", "elpa.sdk.cube", "elpa.sdk.sphere"];

fn instance() -> Elpa<HeadlessBackend> {
    // The demo imports the module under this asset source.
    let mut app =
        Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(800, 600, 1.0), elpa_sdk::DEMO_AST)
            .expect("demo AST compiles");
    app.register_asset(elpa_sdk::MODULE_SOURCE, elpa_sdk::MODULE_AST);
    app
}

#[test]
fn module_ast_is_a_program_of_defines() {
    // The module alone registers exactly the catalog of shapes.
    let mut app =
        Elpa::new(HeadlessBackend::default(), SurfaceInfo::new(8, 8, 1.0), elpa_sdk::MODULE_AST)
            .expect("module AST compiles");
    app.start();
    assert_eq!(app.definitions().len(), SHAPES.len(), "one definition per shape");
    for id in SHAPES {
        assert!(app.definitions().contains(id), "{id} registered");
    }
}

#[test]
fn demo_imports_module_and_draws_2d_and_3d() {
    let mut app = instance();
    app.start();

    // Import populated the shape catalog...
    assert_eq!(app.definitions().len(), SHAPES.len());
    for id in SHAPES {
        assert!(app.definitions().contains(id), "{id} available after import");
    }

    // ...and both the 2D and 3D scenes rendered (two surface passes).
    assert_eq!(app.renderer().backend().render_passes, 2);
    assert!(app.last_stats().presented);
    // No host-side errors were logged (expansion succeeded).
    assert!(app.take_log().is_empty());
}

#[test]
fn referenced_shapes_expand_to_draws_with_no_leftover_references() {
    let mut app = instance();
    app.start();

    // last_frame is the realized (expanded) 3D scene: cube + sphere as real
    // draws, depth-tested, with no `useDefinition` left in the tree.
    let frame = app.last_frame().expect("a frame was submitted");
    match &frame.commands[0] {
        EncoderCommand::RenderPass(rp) => {
            assert!(rp.depth_stencil.is_some(), "3D scene is depth-tested");
            let draws = rp
                .commands
                .iter()
                .filter(|c| matches!(c, RenderCommand::Draw { .. }))
                .count();
            assert_eq!(draws, 2, "cube + sphere expanded into two draws");
            assert!(rp
                .commands
                .iter()
                .all(|c| !matches!(c, RenderCommand::UseDefinition { .. })));
        }
        _ => panic!("expected render pass"),
    }
    // The shared 3D pipeline + depth texture were created as cacheable resources.
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.sdk.pipe.3d"));
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.sdk.depth.3d"));
}

#[test]
fn demo_animates_and_resizes_like_the_web_host() {
    // Mirrors what the web example does: start, drive animation frames, and
    // resize. The scene sizes itself from surfaceInfo and rotates via a counter,
    // so each tick re-renders without error and the resize refits.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    for _ in 0..3 {
        app.animate(16.0);
    }
    assert!(app.last_stats().presented, "animation keeps presenting");
    assert!(app.take_log().is_empty(), "no host errors while animating");

    app.resize(1920, 1080, 2.0);
    assert!(app.take_log().is_empty(), "no host errors on resize");
    // After resizing, the depth texture refits the new surface (1920x1080).
    let frame = app.last_frame().unwrap();
    let depth = frame
        .resources
        .iter()
        .find_map(|r| match r {
            elpa::protocol::ResourceDesc::Texture(t) if t.id == "elpa.sdk.depth.3d" => Some(t),
            _ => None,
        })
        .expect("depth texture present");
    assert_eq!((depth.size.width, depth.size.height), (1920, 1080));
}
