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
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_material::MODULE_JS.to_string()))
            .unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    // Two shaders: the rounded-rect SDF that paints every widget, and the layer
    // compositor's full-screen blit that merges the snapshot layers.
    assert_eq!(shaders.len(), 2, "the SDF painter + the layer-compositor blit");
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

/// Total instances across every per-scope layer instance buffer the SDK emitted.
fn total_instances(app: &Elpa<HeadlessBackend>) -> usize {
    instances(app).len() / 16
}

/// The full per-frame instance stream: every per-scope layer buffer
/// (`elpa.layer.<scope>.inst`) concatenated in z-order. The layered SDK paints
/// each region into its own snapshot, so the stream is bucketed by scope; this
/// reassembles it for the kit's geometric assertions.
fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    layer_instances(app)
}

/// Shared aggregation of the kit's per-scope instance buffers (z-order).
pub fn layer_instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    let order = ["body", "chrome", "drawer", "overlay", "root"];
    let mut out = Vec::new();
    for scope in order {
        let id = format!("elpa.layer.{scope}.inst");
        if let Some(data) = frame.resources.iter().find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == id => b.data_f32.clone(),
            _ => None,
        }) {
            out.extend(data);
        }
    }
    assert!(!out.is_empty(), "at least one scope instance buffer present");
    out
}

/// The surface composite pass's clear color (the themed background). The frame
/// begins with the offscreen layer paint passes and a one-time atlas upload, so
/// pick the pass that targets the *surface* rather than assuming a position.
fn clear_color(app: &Elpa<HeadlessBackend>) -> (f64, f64, f64) {
    let frame = app.last_frame().expect("frame");
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) if rp.targets_surface() => Some(rp),
            _ => None,
        })
        .expect("expected the surface composite pass");
    let c = rp.color_attachments[0].clear_color.expect("clear color");
    (c.r, c.g, c.b)
}

/// The surface composite pass (the one that merges the snapshot layers).
fn composite_pass(frame: &elpa::Frame) -> &elpa::protocol::RenderPass {
    frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) if rp.targets_surface() => Some(rp),
            _ => None,
        })
        .expect("a surface composite pass")
}

#[test]
fn app_starts_and_composites_snapshot_layers() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    // Both pipelines exist: the SDF painter and the layer-compositor blit.
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.pipe"), "SDF pipeline created");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.blit.pipe"), "blit pipeline created");

    // Every major region paints into its own offscreen snapshot: there is a
    // cacheable paint pass per scope, each targeting that scope's layer texture
    // with the 6-vertex SDF draw.
    let paint_passes: Vec<&RenderCommand> = Vec::new();
    let _ = paint_passes;
    let scope_paints: usize = frame
        .commands
        .iter()
        .filter(|c| matches!(c, EncoderCommand::RenderPass(rp)
            if rp.id.as_deref().map(|s| s.ends_with(".paint")).unwrap_or(false)))
        .count();
    assert!(scope_paints >= 2, "the scaffold decoupled into multiple snapshot layers");

    // The first frame paints every snapshot (all stale) — the renderer reports it.
    assert!(app.last_stats().layers_repainted >= 2, "first frame paints each layer once");

    // The snapshots are merged by a full-screen blit per layer in the surface
    // composite pass (3-vertex triangles), not one giant instanced draw.
    let cp = composite_pass(frame);
    let blits: Vec<&RenderCommand> = cp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::Draw { vertex_count: 3, .. }))
        .collect();
    assert!(blits.len() >= 2, "one composite blit per snapshot layer");

    // The aggregated instance stream is whole 16-float instances, and there are
    // many of them (widgets + glyphs across the layers).
    assert_eq!(instances(&app).len() % 16, 0, "whole instances");
    assert!(total_instances(&app) > 50, "many widget + glyph instances");
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
fn idle_layers_reuse_their_snapshot_while_one_region_animates() {
    // With every region decoupled into its own snapshot layer, an easing widget
    // (the switch, in the body) repaints only the body's snapshot; the chrome,
    // drawer and overlay snapshots are *reused* — no GPU paint pass, no re-upload —
    // even as the frame presents. The renderer reports both counts.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    let mut saw_reuse_with_repaint = false;
    for _ in 0..8 {
        app.animate(16.0);
        // The host's scope report: the animating region repaints, the rest reuse
        // their snapshots (their paint passes are omitted entirely).
        let sc = *app.last_scope_stats();
        if app.last_stats().presented && sc.layers_repainted >= 1 && sc.layers_reused >= 1 {
            // Nothing rebuilt — only the animating layer's buffer refilled in place.
            assert_eq!(
                app.last_stats().resources_created, 0,
                "a steady-count animation frame reuses every allocation"
            );
            saw_reuse_with_repaint = true;
        }
    }
    assert!(saw_reuse_with_repaint, "idle layers reused while one region repainted");
    assert!(app.trap_reason().is_none());
    assert!(app.take_log().is_empty());
}

#[test]
fn animating_one_region_conserves_the_total_instance_count() {
    // The switch ease only moves floats; the instance count across all snapshot
    // layers is invariant frame to frame (visually lossless decoupling).
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let base = total_instances(&app);

    app.send_event(&InputEvent::KeyDown { key: " ".into() });
    for _ in 0..8 {
        app.animate(16.0);
        assert_eq!(total_instances(&app), base, "layered decoupling conserves the instance set");
    }
    assert!(app.take_log().is_empty());
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
