//! Run the Liquid Glass framework + demo (JavaScript) on a real (headless) Elpa
//! instance — proof that the SDK and app compile, link into one VM, and drive the
//! whole two-pass glass pipeline end to end: the component runtime lays out the
//! widget tree, emits the instance stream, captures the backdrop and refracts it
//! in the surface pass; pointer / wheel / keyboard events flow through the SDK's
//! closures and change what is rendered.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
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
fn kit_shader_is_valid_wgsl() {
    // Validate the SDK's WGSL exactly as wgpu does. The SDK is JavaScript, so
    // lower it to Elpian AST first and walk that for the embedded shader string.
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_liquidglass::module_js())).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    // One pipeline draws the whole UI (background, glass, solids, text).
    assert_eq!(shaders.len(), 1, "the kit has a single glass shader");
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
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_liquidglass::program(),
    )
    .expect("SDK + app program compiles")
}

/// The per-frame instance buffer (stride 20 floats per instance).
fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.lg.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

#[test]
fn app_starts_and_draws_two_passes() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.lg.pipe"), "pipeline created");
    // The offscreen scene texture (the captured backdrop) is allocated.
    assert!(
        frame.resources.iter().any(|r| r.id().starts_with("elpa.lg.scene.")),
        "backdrop capture texture created"
    );
    // Two render passes: capture + surface.
    let passes: Vec<_> = frame
        .commands
        .iter()
        .filter_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .collect();
    assert_eq!(passes.len(), 2, "capture pass + surface pass");
    // Each pass is one instanced draw over the shared pipeline.
    for rp in &passes {
        let draws: Vec<&RenderCommand> = rp
            .commands
            .iter()
            .filter(|c| matches!(c, RenderCommand::Draw { .. }))
            .collect();
        assert_eq!(draws.len(), 1, "one instanced draw per pass");
    }
    // The surface pass draws the whole UI (many instances).
    let surf = passes.last().unwrap();
    let draw = surf
        .commands
        .iter()
        .find_map(|c| match c {
            RenderCommand::Draw { instance_count, vertex_count, .. } => Some((*instance_count, *vertex_count)),
            _ => None,
        })
        .unwrap();
    assert_eq!(draw.1, 6);
    assert!(draw.0 > 50, "many widget + glyph instances");
    assert_eq!(instances(&app).len() % 20, 0, "whole 20-float instances");
}

#[test]
fn glass_instances_are_present() {
    // At least one instance is a glass lens (kind 2 in g.x, float slot 16).
    let mut app = instance();
    app.start();
    let inst = instances(&app);
    let n = inst.len() / 20;
    let glass = (0..n).filter(|i| (inst[i * 20 + 16] - 2.0).abs() < 0.01).count();
    assert!(glass > 5, "the glass chrome emits many glass lenses (got {glass})");
}

#[test]
fn toggling_the_switch_changes_the_render() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    let mut moved = false;
    for _ in 0..8 {
        app.animate(16.0);
        moved |= instances(&app) != before;
    }
    assert!(moved, "toggling the switch changed the rendered instances");
    assert!(app.take_log().is_empty());
}

#[test]
fn slider_keys_change_the_render() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    for _ in 0..5 {
        app.send_event(&InputEvent::KeyDown { key: "ArrowRight".into() });
    }
    let after = instances(&app);
    assert!(after != before, "nudging the slider changed the render");
    assert!(app.take_log().is_empty());
}

#[test]
fn theme_key_cross_fades_the_background() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let light = clear_color(&app);

    app.send_event(&InputEvent::KeyDown { key: "d".into() });
    for _ in 0..30 {
        app.animate(16.0);
    }
    let dark = clear_color(&app);
    assert!(
        (light.0 - dark.0).abs() + (light.1 - dark.1).abs() + (light.2 - dark.2).abs() > 0.2,
        "wallpaper crossfaded light->dark ({light:?} -> {dark:?})"
    );
    assert!(app.take_log().is_empty(), "no host errors toggling theme");
}

#[test]
fn animation_refills_the_instance_buffer_in_place() {
    // While the switch eases, the instance *count* is unchanged frame to frame —
    // only floats move — so the renderer refills the same GPU buffer (a queue
    // write) rather than reallocating it.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    let mut saw_in_place = false;
    for _ in 0..8 {
        app.animate(16.0);
        let s = app.last_stats();
        if s.presented && s.resources_updated >= 1 {
            saw_in_place = true;
        }
    }
    assert!(saw_in_place, "the instance buffer was refilled in place while animating");
    assert!(app.take_log().is_empty());
}

#[test]
fn animates_and_resizes_like_a_host() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    app.send_event(&InputEvent::Wheel { x: 450.0, y: 700.0, delta_y: -120.0 });
    app.send_event(&InputEvent::KeyDown { key: "d".into() });
    let mut presented_during_anim = false;
    for _ in 0..6 {
        app.animate(16.0);
        presented_during_anim |= app.last_stats().presented;
    }
    assert!(presented_during_anim, "the theme animation re-renders while easing");
    assert!(app.take_log().is_empty(), "no host errors while animating");

    app.resize(1200, 800, 1.5);
    assert!(app.last_stats().presented, "resize forces a fresh present");
    assert!(app.trap_reason().is_none(), "no trap on resize");
    assert!(app.take_log().is_empty(), "no host errors on resize");
}

fn clear_color(app: &Elpa<HeadlessBackend>) -> (f64, f64, f64) {
    let frame = app.last_frame().expect("frame");
    // The surface pass is the last render pass.
    let rp = frame
        .commands
        .iter()
        .filter_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .last()
        .expect("expected a render pass");
    let c = rp.color_attachments[0].clear_color.expect("clear color");
    (c.r, c.g, c.b)
}
