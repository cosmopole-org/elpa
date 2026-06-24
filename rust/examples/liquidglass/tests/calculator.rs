//! Drive the Liquid Glass **calculator** app on a real (headless) Elpa instance.
//!
//! Proves the second app built on the kit compiles, links into one VM and runs
//! the whole two-pass glass pipeline end to end: the keypad lays out through
//! `Row`/`Expanded`, key events flow through the in-VM expression engine and
//! change what is rendered, and switching BASIC→SCIENTIFIC reflows the keypad —
//! all with no VM trap and no host errors.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_liquidglass::calculator_program(),
    )
    .expect("SDK + calculator program compiles")
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

fn key(app: &mut Elpa<HeadlessBackend>, k: &str) {
    app.send_event(&InputEvent::KeyDown { key: k.into() });
}

#[test]
fn calculator_starts_and_draws_two_passes() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.lg.pipe"), "pipeline created");
    assert!(
        frame.resources.iter().any(|r| r.id().starts_with("elpa.lg.scene.")),
        "backdrop capture texture created"
    );
    let passes: Vec<_> = frame
        .commands
        .iter()
        .filter_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .collect();
    assert_eq!(passes.len(), 2, "capture pass + surface pass");

    // The surface pass draws the whole calculator in one instanced draw.
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
    assert!(draw.0 > 50, "many keypad + glyph instances");
    assert_eq!(instances(&app).len() % 20, 0, "whole 20-float instances");
}

#[test]
fn glass_keys_emit_glass_lenses() {
    // The glass keypad emits many glass lenses (kind 2 in g.x, float slot 16).
    let mut app = instance();
    app.start();
    let inst = instances(&app);
    let n = inst.len() / 20;
    let glass = (0..n).filter(|i| (inst[i * 20 + 16] - 2.0).abs() < 0.01).count();
    assert!(glass > 5, "the glass keypad emits many glass lenses (got {glass})");
}

#[test]
fn typing_a_calculation_changes_the_render_without_errors() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    // Enter "12*3" — the live preview should update the display.
    for k in ["1", "2", "*", "3"] {
        key(&mut app, k);
    }
    let after_typing = instances(&app);
    assert!(after_typing != before, "typing a calculation changed the render");

    // Evaluate it. No trap, no host errors, still presenting.
    key(&mut app, "=");
    assert!(app.last_stats().presented, "the result frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap evaluating: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors evaluating an expression");
    assert!(instances(&app) != after_typing, "the committed result changed the render");
}

#[test]
fn scientific_mode_reflows_the_keypad() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let basic = instances(&app).len();

    // Toggle BASIC -> SCIENTIFIC ('s'); the extra function + memory rows add keys.
    key(&mut app, "s");
    let sci = instances(&app).len();
    assert!(sci > basic, "scientific mode adds keypad rows (basic {basic} -> sci {sci})");
    assert!(app.trap_reason().is_none(), "no trap switching modes: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors switching modes");
}

#[test]
fn handles_errors_and_clears_without_trapping() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // A malformed expression ("3/0(") must evaluate to an error state, not trap.
    for k in ["3", "/", "0", "(", "="] {
        key(&mut app, k);
    }
    assert!(app.trap_reason().is_none(), "no trap on a bad expression: {:?}", app.trap_reason());

    // Clear, switch to scientific mode, and run another expression. (Functions
    // come from on-screen buttons, not typed keys, so type a numeric one.)
    key(&mut app, "Escape");
    key(&mut app, "s");
    for k in ["9", "0", "^", "2", "Enter"] {
        key(&mut app, k);
    }
    assert!(app.trap_reason().is_none(), "no trap after clear + recompute: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors across the sequence");
}
