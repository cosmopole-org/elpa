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
    assert!(inst.len() >= 24, "the app emitted instances ({} floats)", inst.len());
    assert_eq!(inst.len() % 24, 0, "instance stride is 24 floats");
}

#[test]
fn widget_tree_relayouts_on_resize() {
    // The widget tree inflates an element tree that builds a render tree; a resize
    // reconfigures the RenderView and re-runs layout/paint without trapping.
    let mut app = instance();
    app.start();
    let before = instances(&app).len();
    assert!(before > 24, "the widget demo emits a non-trivial frame");

    app.resize(700, 1200, 2.0);
    assert!(app.trap_reason().is_none(), "no VM trap on resize: {:?}", app.trap_reason());
    assert!(app.last_stats().presented, "resized frame presented");
    let after = instances(&app).len();
    assert_eq!(after % 24, 0, "instance stride preserved after resize");
    assert!(after > 24, "the widget tree re-laid-out and re-painted on resize");
}

#[test]
fn tap_drives_setstate_rebuild() {
    // The interactive loop: a tap on the FloatingActionButton hit-tests to its
    // RenderPointerListener, fires onTap → setState (the "likes" counter shown in
    // the Discover hero) → markNeedsBuild, the BuildOwner rebuilds the dirty
    // subtree, and a new frame is submitted whose counter text changed — no trap.
    let mut app = instance();
    app.start();

    // The FAB sits at the bottom-right of the 1000×800 surface, raised above the
    // bottom nav (right: 22, bottom: 86, ⌀58 → centre ≈ (949, 685)). Tapping it
    // increments the "likes" counter shown in the Discover hero.
    let (fx, fy) = (949.0, 685.0);
    let before = instances(&app);
    app.send_event(&InputEvent::PointerDown { x: fx, y: fy, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: fx, y: fy, button: 0 });
    assert!(app.trap_reason().is_none(), "no VM trap on tap: {:?}", app.trap_reason());
    assert_ne!(
        instances(&app),
        before,
        "a tap on the FAB fired onTap → setState → rebuild → new frame"
    );
    assert!(app.last_stats().presented, "the rebuilt frame was submitted");
    assert_eq!(instances(&app).len() % 24, 0, "instance stride preserved after tap");

    // Tapping the FAB again advances the counter once more (the element / render
    // objects are reused across rebuilds, only the counter glyphs change).
    let before2 = instances(&app);
    app.send_event(&InputEvent::PointerDown { x: fx, y: fy, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: fx, y: fy, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap on the second tap");
    assert_ne!(before2, instances(&app), "a second tap advances the counter again");
}

#[test]
fn bottom_nav_switches_screens_and_scrolls() {
    // Tapping the BottomNavigationBar switches the body to a different screen
    // (Discover → Browse → Library → Settings); a vertical drag on a scrollable
    // screen flings its viewport. All without a VM trap.
    let mut app = instance();
    app.start();
    let discover = instances(&app);

    // Bottom nav lives along the bottom edge; the four items split the width.
    // Tap the 3rd item (Library) at ~x = 625, y ≈ 778.
    app.send_event(&InputEvent::PointerDown { x: 625.0, y: 778.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 625.0, y: 778.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap switching tabs: {:?}", app.trap_reason());
    assert_ne!(instances(&app), discover, "the body switched to another screen");

    // Drag the Library list upward to scroll it (a fling), then settle frames.
    let scrolled = instances(&app);
    app.send_event(&InputEvent::PointerDown { x: 500.0, y: 400.0, button: 0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 320.0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 240.0 });
    app.send_event(&InputEvent::PointerUp { x: 500.0, y: 240.0, button: 0 });
    for _ in 0..8 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "no trap while scrolling: {:?}", app.trap_reason());
    assert_ne!(instances(&app), scrolled, "the list scrolled to a new offset");
    assert_eq!(instances(&app).len() % 24, 0, "instance stride preserved after scroll");
}

#[test]
fn animation_ticks_advance_frames() {
    // The Discover hero hosts a repeating CircularProgressIndicator + a breathing
    // Sparkline driven by AnimationControllers. Advancing the scheduler with real
    // frame dt produces evolving frames — proof the animation layer ticks.
    let mut app = instance();
    app.start();
    let a = instances(&app);
    for _ in 0..6 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "no trap while animating: {:?}", app.trap_reason());
    let b = instances(&app);
    assert_eq!(b.len() % 24, 0, "instance stride preserved while animating");
    assert_ne!(a, b, "the animation advanced the frame on scheduler ticks");
}
