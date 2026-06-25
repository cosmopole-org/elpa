//! Run the Flutter SDK + demo on a real (headless) Elpa instance — proof that the
//! layered SDK and app compile, link into one VM, and drive the dart:ui → **Vello
//! scene** pipeline end to end. The kit now paints by streaming a batch of
//! high-level vector ops (`scene.submit`), not a raw wgpu command tree; these
//! tests assert on the emitted scene and that the constraint protocol, layout,
//! reconciliation, scrolling and animation still behave like Flutter.

use elpa::{Elpa, HeadlessBackend, InputEvent, SceneOp, SurfaceInfo};

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 1.0),
        &elpa_flutter::program(),
    )
    .expect("SDK + app program compiles")
}

/// The ops of the most recently submitted Vello scene.
fn ops(app: &Elpa<HeadlessBackend>) -> Vec<SceneOp> {
    app.last_scene().expect("a scene was submitted").ops.clone()
}

fn count<F: Fn(&SceneOp) -> bool>(o: &[SceneOp], pred: F) -> usize {
    o.iter().filter(|x| pred(x)).count()
}

#[test]
fn sdk_paints_a_vello_scene() {
    let mut app = instance();
    app.start();

    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    // The kit drives the *scene* path, not the raw wgpu path.
    assert!(app.last_scene_stats().presented, "first scene presented");
    assert!(app.last_frame().is_none(), "the kit no longer uses the raw gpu.submit path");

    let o = ops(&app);
    assert!(o.len() >= 24, "the app emitted a non-trivial UI scene ({} ops)", o.len());
    // The UI lowers to Vello fills (rects/rrects/circles), strokes (outlines,
    // capsule lines, vector glyphs) and clip layers (rounded cards / viewports).
    assert!(count(&o, |x| matches!(x, SceneOp::Fill { .. })) > 0, "filled shapes");
    assert!(count(&o, |x| matches!(x, SceneOp::Stroke { .. })) > 0, "stroked shapes / text");
    assert!(count(&o, |x| matches!(x, SceneOp::PushLayer { .. })) > 0, "clip layers");
}

#[test]
fn sdk_ships_no_raw_wgpu_and_balances_clip_layers() {
    let mut app = instance();
    app.start();
    let o = ops(&app);

    // A pure-vector Vello scene: direct wgpu survives only as the `rawWgpu` op,
    // which this kit does not use.
    assert!(app.last_scene().unwrap().has_vector_ops());
    assert_eq!(count(&o, |x| matches!(x, SceneOp::RawWgpu { .. })), 0, "no raw wgpu ops");

    // Every clip layer is closed (push/pop balanced) — Vello requires it.
    let pushes = count(&o, |x| matches!(x, SceneOp::PushLayer { .. }));
    let pops = count(&o, |x| matches!(x, SceneOp::PopLayer));
    assert_eq!(pushes, pops, "clip layers are balanced ({pushes} push / {pops} pop)");
}

#[test]
fn widget_tree_relayouts_on_resize() {
    // The widget tree inflates an element tree that builds a render tree; a resize
    // reconfigures the RenderView and re-runs layout/paint without trapping.
    let mut app = instance();
    app.start();
    let before = ops(&app).len();
    assert!(before > 24, "the widget demo emits a non-trivial frame");

    app.resize(700, 1200, 2.0);
    assert!(app.trap_reason().is_none(), "no VM trap on resize: {:?}", app.trap_reason());
    assert!(app.last_scene_stats().presented, "resized scene presented");
    let after = ops(&app).len();
    assert!(after > 24, "the widget tree re-laid-out and re-painted on resize");
}

#[test]
fn tap_drives_setstate_rebuild() {
    // The interactive loop: a tap on the FloatingActionButton hit-tests to its
    // RenderPointerListener, fires onTap → setState (the "likes" counter shown in
    // the Discover hero) → markNeedsBuild, the BuildOwner rebuilds the dirty
    // subtree, and a new scene is submitted whose counter text changed — no trap.
    let mut app = instance();
    app.start();

    // The FAB sits at the bottom-right of the 1000×800 surface, raised above the
    // bottom nav (right: 22, bottom: 86, ⌀58 → centre ≈ (949, 685)). Tapping it
    // increments the "likes" counter shown in the Discover hero.
    let (fx, fy) = (949.0, 685.0);
    let before = ops(&app);
    app.send_event(&InputEvent::PointerDown { x: fx, y: fy, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: fx, y: fy, button: 0 });
    assert!(app.trap_reason().is_none(), "no VM trap on tap: {:?}", app.trap_reason());
    assert_ne!(ops(&app), before, "a tap on the FAB fired onTap → setState → rebuild → new scene");
    assert!(app.last_scene_stats().presented, "the rebuilt scene was submitted");

    // Tapping the FAB again advances the counter once more (the element / render
    // objects are reused across rebuilds, only the counter glyphs change).
    let before2 = ops(&app);
    app.send_event(&InputEvent::PointerDown { x: fx, y: fy, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: fx, y: fy, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap on the second tap");
    assert_ne!(before2, ops(&app), "a second tap advances the counter again");
}

#[test]
fn bottom_nav_switches_screens_and_scrolls() {
    // Tapping the BottomNavigationBar switches the body to a different screen
    // (Discover → Browse → Library → Settings); a vertical drag on a scrollable
    // screen flings its viewport. All without a VM trap.
    let mut app = instance();
    app.start();
    let discover = ops(&app);

    // Bottom nav lives along the bottom edge; the four items split the width.
    // Tap the 3rd item (Library) at ~x = 625, y ≈ 778.
    app.send_event(&InputEvent::PointerDown { x: 625.0, y: 778.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 625.0, y: 778.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap switching tabs: {:?}", app.trap_reason());
    assert_ne!(ops(&app), discover, "the body switched to another screen");

    // Drag the Library list upward to scroll it (a fling), then settle frames.
    let scrolled = ops(&app);
    app.send_event(&InputEvent::PointerDown { x: 500.0, y: 400.0, button: 0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 320.0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 240.0 });
    app.send_event(&InputEvent::PointerUp { x: 500.0, y: 240.0, button: 0 });
    for _ in 0..8 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "no trap while scrolling: {:?}", app.trap_reason());
    assert_ne!(ops(&app), scrolled, "the list scrolled to a new offset");
}

#[test]
fn animation_ticks_advance_frames() {
    // The Discover hero hosts a repeating CircularProgressIndicator + a breathing
    // Sparkline driven by AnimationControllers. Advancing the scheduler with real
    // frame dt produces evolving scenes — proof the animation layer ticks.
    let mut app = instance();
    app.start();
    let a = ops(&app);
    for _ in 0..6 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "no trap while animating: {:?}", app.trap_reason());
    assert_ne!(a, ops(&app), "the animation advanced the scene on scheduler ticks");
}
