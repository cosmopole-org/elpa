//! Run the Material framework + demo (JavaScript) on a real (headless) Elpa
//! instance — proof that the SDK and app compile, link into one VM, and drive
//! the whole pipeline end to end: the component runtime lays the widget tree out,
//! emits one instanced rounded-rect draw, and `gpu.submit`s it; pointer / wheel /
//! keyboard events flow through the SDK's closures (tap callbacks, the component
//! `update`) and change what is rendered.

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
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_material::module_js()))
            .unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    // Two pipelines: the rounded-rect SDF shader (every widget/chart/glyph) and
    // the image shader (real network/storage textures, streaming video frames).
    assert_eq!(shaders.len(), 2, "the kit has the SDF and image shaders");
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
        &elpa_material::program(),
    )
    .expect("SDK + app program compiles")
}

/// The same app with layered rendering switched on (static/dynamic instance
/// split). Injected by enabling the SDK flag just before `runApp`.
fn layered_instance() -> Elpa<HeadlessBackend> {
    let program = format!(
        "{}\n{}",
        elpa_material::module_js(),
        elpa_material::DEMO_JS.replace("runApp(App)", "setLayered(1.0); runApp(App)"),
    );
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(900, 1400, 1.0), &program)
        .expect("layered SDK + app program compiles")
}

/// Total instances across every per-frame instance buffer the SDK emitted —
/// whether one (`elpa.m3.inst`) or the layered pair (`*.static` + `*.dyn`).
fn total_instances(app: &Elpa<HeadlessBackend>) -> usize {
    let frame = app.last_frame().expect("a frame was submitted");
    let floats: usize = frame
        .resources
        .iter()
        .filter_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id.starts_with("elpa.m3.inst") => {
                b.data_f32.as_ref().map(|d| d.len())
            }
            _ => None,
        })
        .sum();
    floats / 16
}

/// The single per-frame instance buffer the SDK emits (all rounded-rect layers).
fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

/// The render pass's clear color (the themed background). The frame may carry a
/// one-time font-atlas upload before the pass, so find the pass rather than
/// assuming it is first.
fn clear_color(app: &Elpa<HeadlessBackend>) -> (f64, f64, f64) {
    let frame = app.last_frame().expect("frame");
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .expect("expected a render pass");
    let c = rp.color_attachments[0].clear_color.expect("clear color");
    (c.r, c.g, c.b)
}

#[test]
fn app_starts_and_draws_one_instanced_pass() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    // The whole UI is one instanced rounded-rect draw over the shared pipeline.
    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.pipe"), "pipeline created");
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .expect("expected a render pass");
    let draws: Vec<&RenderCommand> = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::Draw { .. }))
        .collect();
    assert_eq!(draws.len(), 1, "one instanced draw for the whole UI");
    match draws[0] {
        RenderCommand::Draw { instance_count, vertex_count, .. } => {
            assert_eq!(*vertex_count, 6);
            assert!(*instance_count > 50, "many widget + glyph instances");
        }
        _ => unreachable!(),
    }
    // The instance buffer matches the draw (whole 16-float instances).
    assert_eq!(instances(&app).len() % 16, 0, "whole instances");
}

#[test]
fn animation_refills_the_instance_buffer_in_place() {
    // While a widget eases (here the switch thumb), the *number* of rounded-rect
    // instances is unchanged frame to frame — only their floats move. The
    // renderer must therefore refill the same GPU buffer with a queue write
    // (`resources_updated`) rather than reallocate one (`resources_created`),
    // which is what keeps a busy, fully-repainting frame cheap.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // Toggle the switch, then ease it; the eased frames repaint the whole UI.
    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    let mut saw_in_place = false;
    for _ in 0..8 {
        app.animate(16.0);
        let s = app.last_stats();
        if s.presented && s.resources_updated >= 1 {
            saw_in_place = true;
            assert_eq!(
                s.resources_created, 0,
                "a steady-count animation frame reuses every GPU allocation"
            );
        }
    }
    assert!(saw_in_place, "the instance buffer was refilled in place while animating");
    assert!(app.take_log().is_empty());
}

#[test]
fn layered_mode_caches_the_static_layer_during_animation() {
    // With layering on, an easing widget rewrites only the small dynamic layer in
    // place; the static layer (every other widget) keeps identical bytes, so the
    // resource cache skips it — no create, no re-upload — even as the frame fully
    // repaints and presents.
    let mut app = layered_instance();
    app.start();
    let _ = app.take_log();

    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    let mut saw_static_cached = false;
    for _ in 0..8 {
        app.animate(16.0);
        let s = app.last_stats();
        // created == 0 && updated >= 1 means: nothing rebuilt, only the dynamic
        // buffer refilled — the static layer was served from cache.
        if s.presented && s.resources_created == 0 && s.resources_updated >= 1 {
            let frame = app.last_frame().unwrap();
            let has_static = frame.resources.iter().any(|r| r.id() == "elpa.m3.inst.static");
            let has_dyn = frame.resources.iter().any(|r| r.id() == "elpa.m3.inst.dyn");
            if has_static && has_dyn {
                saw_static_cached = true;
            }
        }
    }
    assert!(saw_static_cached, "static layer cached while only the dynamic layer updated");
    assert!(app.trap_reason().is_none());
    assert!(app.take_log().is_empty());
}

#[test]
fn layered_split_conserves_every_instance() {
    // The layered split must be visually lossless: at every step the static +
    // dynamic instances together equal the single-buffer frame the unlayered app
    // produces for the identical state. Drive both in lockstep (the eased values
    // are deterministic) and compare totals.
    let mut plain = instance();
    let mut layered = layered_instance();
    plain.start();
    layered.start();
    let _ = plain.take_log();
    let _ = layered.take_log();
    assert_eq!(total_instances(&plain), total_instances(&layered), "same first frame");

    plain.send_event(&InputEvent::KeyDown { key: " ".into() });
    layered.send_event(&InputEvent::KeyDown { key: " ".into() });
    for _ in 0..8 {
        plain.animate(16.0);
        layered.animate(16.0);
        assert_eq!(
            total_instances(&plain),
            total_instances(&layered),
            "layered static+dynamic conserves the full instance set"
        );
    }
    assert!(layered.take_log().is_empty());
}

#[test]
fn theme_key_cross_fades_the_background() {
    // The `d` key runs the app's onKey closure → toggles dark → update() repaints.
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
        (light.0 - dark.0).abs() + (light.1 - dark.1).abs() + (light.2 - dark.2).abs() > 0.3,
        "background crossfaded light->dark ({light:?} -> {dark:?})"
    );
    assert!(app.take_log().is_empty(), "no host errors toggling theme");
}

#[test]
fn toggling_the_switch_changes_the_render() {
    // Space toggles the switch; its thumb eases over the next frames.
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
fn tapping_the_fab_cycles_the_accent() {
    // The FAB sits bottom-right; its tap closure (a function value in the widget)
    // cycles the accent, which recolors the whole UI immediately.
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    // FAB center ≈ (vw - u*9, vh - u*9) with u = min(vw,vh)/100 = 9 → (819, 1319).
    app.send_event(&InputEvent::PointerDown { x: 819.0, y: 1319.0, button: 0 });
    let after = instances(&app);
    assert!(after != before, "tapping the FAB recolored the UI (accent cycled)");
    assert!(app.take_log().is_empty(), "no host errors on tap");
}

#[test]
fn tapping_a_radio_updates_only_that_component() {
    // The radios live in their own `RadioRow` component, so a radio tap routes
    // through that component's `update` — exercising the scoped partial update and
    // the reassembly bubble up to the root. Selecting one then eases its dot in.
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    // Middle radio "B" center ≈ (450, 892) on 900×1400 (u = min(vw,vh)/100 = 9).
    app.send_event(&InputEvent::PointerDown { x: 450.0, y: 892.0, button: 0 });
    for _ in 0..8 {
        app.animate(16.0);
    }
    let after = instances(&app);
    assert!(after != before, "selecting a radio changed the render");
    assert!(app.trap_reason().is_none(), "no trap on a scoped component update");
    assert!(app.take_log().is_empty(), "no host errors on a scoped component update");
}

#[test]
fn animates_and_resizes_like_the_web_host() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // A wheel tick over the surface must stay clean.
    app.send_event(&InputEvent::Wheel { x: 450.0, y: 700.0, delta_y: -120.0 });
    // Idle frames cost nothing (partial-render cache), so force an animation: a
    // theme toggle eases over the next frames, each of which re-renders.
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
