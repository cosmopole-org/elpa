//! Drive the SDK with a real UI font provisioned (as a device build would
//! download it), proving the kit takes the **native Vello glyph** text path:
//! text becomes `drawGlyphs` runs (real outlines) instead of the vector-stroke
//! capsule fills, which both fixes the blocky look and collapses the per-frame op
//! count that the capsule font inflated.

use elpa::{ClosureNet, Elpa, EnvToggles, HeadlessBackend, NetResponse, SceneOp, SurfaceInfo};

const FONT: &[u8] = include_bytes!("../../../crates/elpa-runtime/tests/fonts/LiberationSans-Regular.ttf");

fn instance_with_font() -> Elpa<HeadlessBackend> {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 2.0),
        &elpa_flutter::program(),
    )
    .expect("SDK + app compiles");
    // Serve the fixture font for the runtime's default-font download.
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.env_mut().set_net(Box::new(ClosureNet(|_r| {
        Ok(NetResponse { status: 200, body: String::new(), bytes: Some(FONT.to_vec()) })
    })));
    app
}

fn kinds(app: &Elpa<HeadlessBackend>) -> (usize, usize, usize) {
    let scene = app.last_scene().expect("a scene");
    let mut fills = 0;
    let mut glyphs = 0;
    for op in &scene.ops {
        match op {
            SceneOp::Fill { .. } => fills += 1,
            SceneOp::DrawGlyphs { .. } => glyphs += 1,
            _ => {}
        }
    }
    (scene.ops.len(), fills, glyphs)
}

#[test]
fn text_uses_native_glyph_runs_when_a_font_is_available() {
    let mut app = instance_with_font();
    app.start();
    assert!(app.trap_reason().is_none(), "no trap: {:?}", app.trap_reason());

    let (ops, fills, glyphs) = kinds(&app);
    println!("native: ops={ops} fills={fills} glyphs={glyphs}");
    assert!(glyphs > 0, "text now renders as Vello glyph runs ({glyphs})");

    // The font was registered exactly once as a scene resource.
    let scene = app.last_scene().unwrap();
    assert!(scene.resources.iter().any(|r| r.id() == "elpa.fl.font"), "font resource declared");
    assert_eq!(app.last_scene_stats().resources_uploaded, 1, "font uploaded once");
}

#[test]
fn native_glyphs_collapse_the_op_count_vs_capsules() {
    // Capsule baseline: same app, no font provisioned (vector stroke fallback).
    let mut capsule = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 2.0),
        &elpa_flutter::program(),
    )
    .unwrap();
    capsule.start();
    let cap_ops = capsule.last_scene().unwrap().ops.len();

    let mut app = instance_with_font();
    app.start();
    let nat_ops = app.last_scene().unwrap().ops.len();

    println!("ops: capsule={cap_ops} native={nat_ops}");
    assert!(
        nat_ops * 2 < cap_ops,
        "native glyphs cut the op count by >2x (capsule={cap_ops}, native={nat_ops})"
    );
}

#[test]
fn font_blob_is_sent_once_not_every_frame() {
    let mut app = instance_with_font();
    app.start();
    assert_eq!(app.last_scene_stats().resources_uploaded, 1, "uploaded on first frame");

    // A later repaint (a resize forces a fresh frame) re-submits a scene that must
    // NOT re-embed the heavy font blob — the resident copy stands.
    app.resize(640, 1100, 2.0);
    let scene = app.last_scene().unwrap();
    assert!(scene.resources.is_empty(), "steady-state scenes carry no font blob");
    assert_eq!(app.last_scene_stats().resources_uploaded, 0, "no re-upload; resident font reused");
}
