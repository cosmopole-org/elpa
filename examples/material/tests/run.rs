//! Run the Material kit's **JSON AST** assets on a real (headless) Elpa instance —
//! proof that the UI kit (which is AST JSON, not Rust) loads, draws, and *reacts*
//! to input end to end: `vm.import` registers the widget definitions, frames
//! reference widgets by id (the host expands them into the wgpu command tree),
//! and pointer / wheel / keyboard events mutate state through the VM.

use elpa::protocol::{EncoderCommand, RenderCommand};
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

const WIDGETS: [&str; 12] = [
    "elpa.m3.card",
    "elpa.m3.appBar",
    "elpa.m3.filledButton",
    "elpa.m3.outlinedButton",
    "elpa.m3.fab",
    "elpa.m3.switch",
    "elpa.m3.checkbox",
    "elpa.m3.radioGroup",
    "elpa.m3.slider",
    "elpa.m3.chip",
    "elpa.m3.progress",
    "elpa.m3.divider",
];

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

#[test]
fn kit_shader_is_valid_wgsl() {
    // Validate the kit's WGSL exactly as wgpu does, so reserved-keyword / syntax
    // errors fail in `cargo test` (not in a browser).
    let ast: serde_json::Value = serde_json::from_str(elpa_material::MODULE_AST).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert_eq!(
        shaders.len(),
        1,
        "the whole kit shares one rounded-rect shader"
    );

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
    let mut app = Elpa::new(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        elpa_material::DEMO_AST,
    )
    .expect("demo AST compiles");
    app.register_asset(elpa_material::MODULE_SOURCE, elpa_material::MODULE_AST);
    app
}

#[test]
fn module_registers_every_widget() {
    let mut app = Elpa::new(
        HeadlessBackend::default(),
        SurfaceInfo::new(8, 8, 1.0),
        elpa_material::MODULE_AST,
    )
    .expect("module AST compiles");
    app.start();
    assert_eq!(
        app.definitions().len(),
        WIDGETS.len(),
        "one definition per widget"
    );
    for id in WIDGETS {
        assert!(app.definitions().contains(id), "{id} registered");
    }
}

#[test]
fn demo_imports_module_and_draws_all_widgets() {
    let mut app = instance();
    app.start();

    for id in WIDGETS {
        assert!(
            app.definitions().contains(id),
            "{id} available after import"
        );
    }
    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    // The whole UI expands into one surface pass whose every useDefinition became
    // real draws (one per widget) with no leftover references.
    let frame = app.last_frame().expect("a frame was submitted");
    match &frame.commands[0] {
        EncoderCommand::RenderPass(rp) => {
            let draws = rp
                .commands
                .iter()
                .filter(|c| matches!(c, RenderCommand::Draw { .. }))
                .count();
            assert_eq!(draws, WIDGETS.len(), "every widget expanded into a draw");
            assert!(rp
                .commands
                .iter()
                .all(|c| !matches!(c, RenderCommand::UseDefinition { .. })));
        }
        _ => panic!("expected a render pass"),
    }
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.pipe"));
}

/// Total alpha-weighted "ink" of the slider's active-track instance — a cheap
/// proxy for the slider value the VM computed, read straight from the realized
/// frame's instance buffer.
fn slider_active_halfwidth(app: &Elpa<HeadlessBackend>) -> f32 {
    use elpa::protocol::ResourceDesc;
    let frame = app.last_frame().expect("frame");
    let buf = frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.slider.instances" => Some(b),
            _ => None,
        })
        .expect("slider instance buffer present");
    let data = buf.data_f32.as_ref().expect("slider data_f32");
    // layout: [inactive(16), active(16), thumb(16)]; active half-width is field 2.
    data[16 + 2]
}

#[test]
fn pointer_drag_moves_the_slider() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    let before = slider_active_halfwidth(&app);
    // Press near the right end of the slider track and drag.
    // Track center is at vw*0.5, half-width vw*0.40 → right end ≈ nx 0.9.
    app.send_event(&InputEvent::PointerDown {
        x: 810.0,
        y: 784.0,
        button: 0,
    });
    app.send_event(&InputEvent::PointerMove { x: 860.0, y: 784.0 });
    let after = slider_active_halfwidth(&app);
    assert!(
        after > before,
        "dragging right widened the active track ({before} -> {after})"
    );
    assert!(app.take_log().is_empty(), "no host errors while dragging");

    app.send_event(&InputEvent::PointerUp {
        x: 860.0,
        y: 784.0,
        button: 0,
    });
    assert!(app.take_log().is_empty());
}

#[test]
fn keyboard_and_wheel_are_wired() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // Keyboard nudges + actions, then a wheel tick — all must run without error.
    app.send_event(&InputEvent::KeyDown {
        key: "ArrowRight".into(),
    });
    app.send_event(&InputEvent::KeyDown { key: "d".into() }); // toggle dark
    app.send_event(&InputEvent::KeyDown { key: " ".into() }); // toggle switch
    app.send_event(&InputEvent::KeyUp { key: " ".into() });
    app.send_event(&InputEvent::Wheel {
        x: 450.0,
        y: 784.0,
        delta_y: -120.0,
    });
    assert!(
        app.take_log().is_empty(),
        "no host errors across key/wheel events"
    );
    assert!(app.last_stats().presented);
}

#[test]
fn animates_and_resizes_like_the_web_host() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // Idle frames cost nothing (partial-render cache), so to observe animation we
    // first change state: toggle the switch, which then eases its thumb over the
    // next few onFrame ticks — each of those ticks re-renders and presents.
    app.send_event(&InputEvent::PointerDown {
        x: 666.0,
        y: 476.0,
        button: 0,
    }); // switch
    let mut presented_during_anim = false;
    for _ in 0..5 {
        app.animate(16.0);
        presented_during_anim |= app.last_stats().presented;
    }
    assert!(
        presented_during_anim,
        "the switch animation re-renders while easing"
    );
    assert!(app.take_log().is_empty(), "no host errors while animating");

    // A resize invalidates the cache and refits the layout from the new surface.
    app.resize(1200, 800, 1.5);
    assert!(app.take_log().is_empty(), "no host errors on resize");
    assert!(app.last_stats().presented, "resize forces a fresh present");
}
