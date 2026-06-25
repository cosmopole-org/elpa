//! Drive the Flutter-like, JS-authored SDK that paints entirely with **Vello
//! scene ops** on a real (headless) Elpa instance — proof that the rewritten SDK
//! compiles, runs on the VM, and streams a high-level vector scene via
//! `scene.submit`, with direct wgpu surviving only as the composited `rawWgpu`
//! subset op.

use elpa::{Elpa, HeadlessBackend, InputEvent, SceneOp, SurfaceInfo};

const SDK: &str = include_str!("assets/vello_flutter_demo.js");

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(1000, 800, 1.0), SDK)
        .expect("the Vello SDK + demo compiles")
}

/// Count scene ops by kind in the most recently submitted scene.
fn op_kinds(app: &Elpa<HeadlessBackend>) -> (usize, usize, usize, usize) {
    let scene = app.last_scene().expect("a scene was submitted");
    let mut fills = 0;
    let mut clips = 0;
    let mut glyphs = 0;
    let mut raw = 0;
    for op in &scene.ops {
        match op {
            SceneOp::Fill { .. } => fills += 1,
            SceneOp::PushLayer { .. } => clips += 1,
            SceneOp::DrawGlyphs { .. } => glyphs += 1,
            SceneOp::RawWgpu { .. } => raw += 1,
            _ => {}
        }
    }
    (fills, clips, glyphs, raw)
}

#[test]
fn sdk_paints_a_vector_scene_on_start() {
    let mut app = instance();
    app.start();

    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    // The scene path was driven (not the raw gpu.submit path).
    let st = app.last_scene_stats();
    assert!(st.presented, "the first scene presented");
    assert!(st.ops_encoded >= 5, "a non-trivial UI scene ({} ops)", st.ops_encoded);

    // The UI exercises the full vello vocabulary: filled cards (incl. a gradient
    // brush), a clip layer, glyph runs for text, and a composited raw wgpu op.
    let (fills, clips, glyphs, raw) = op_kinds(&app);
    assert!(fills >= 2, "filled containers/cards ({fills})");
    assert!(clips >= 1, "a rounded-rect clip layer ({clips})");
    assert!(glyphs >= 1, "text drawn as glyph runs ({glyphs})");
    assert_eq!(raw, 1, "the 3D card is the one composited rawWgpu subset op");

    // A font was registered as a scene resource and uploaded once.
    assert_eq!(st.resources_uploaded, 1, "the UI font uploaded once");
    let scene = app.last_scene().unwrap();
    assert!(scene.resources.iter().any(|r| r.id() == "ui.font"));
}

#[test]
fn tap_bumps_state_and_re_presents_a_new_scene() {
    let mut app = instance();
    app.start();
    let before = app.last_scene().unwrap().ops.clone();

    // A tap increments the "likes" counter, changing the title text's glyph run,
    // so the scene differs and re-presents (not served from cache).
    app.send_event(&InputEvent::PointerDown { x: 200.0, y: 120.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap on tap: {:?}", app.trap_reason());
    assert!(app.last_scene_stats().presented, "the changed scene re-presented");
    assert_ne!(app.last_scene().unwrap().ops, before, "the tap produced a new scene");
    // The font is already resident — no re-upload on the steady-state repaint.
    assert_eq!(app.last_scene_stats().resources_uploaded, 0);
}

#[test]
fn resize_relays_out_and_re_presents() {
    let mut app = instance();
    app.start();
    let (fills0, _, _, _) = op_kinds(&app);

    app.resize(640, 1100, 2.0);
    assert!(app.trap_reason().is_none(), "no trap on resize: {:?}", app.trap_reason());
    assert!(app.last_scene_stats().presented, "the resized scene presented");
    let (fills1, _, _, raw1) = op_kinds(&app);
    assert_eq!(fills0, fills1, "the same widget tree re-painted at the new size");
    assert_eq!(raw1, 1, "the composited raw op survives the relayout");
}
