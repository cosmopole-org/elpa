//! End-to-end check that the shipped demo Elpa app (`assets/app/main.js`) runs on
//! the engine and drives the Flutter UI through the pipe as the Dart side expects:
//! a full `flutter.render` on start, then **scoped** `flutter.patch` messages —
//! one per render scope — for taps and animation ticks.
//!
//! This exercises the exact source Flutter loads, so a break in the app or in the
//! messaging/scoping contract is caught by `cargo test` without a Flutter toolchain.

use elpa_bridge::engine::{channel, ElpaEngine};

const DEMO: &str = include_str!("../../assets/app/main.js");

#[test]
fn demo_app_drives_independent_render_scopes() {
    let mut engine = ElpaEngine::from_js(DEMO, 1080, 1920, 2.0).expect("demo compiles");

    // Start → a full render (the multi-scope tree) plus a request to run the
    // clock's animation ticker.
    let out = engine.start();
    assert_eq!(out.len(), 2, "render + tick on start");
    assert_eq!(out[0].channel, channel::RENDER);
    assert!(out[0].payload.contains("\"Scaffold\""), "root is a Scaffold");
    assert!(out[0].payload.contains("counterA"), "scope A present");
    assert!(out[0].payload.contains("counterB"), "scope B present");
    assert!(out[0].payload.contains("\"clock\""), "clock scope present");
    assert!(out[0].payload.contains("A: 0") && out[0].payload.contains("B: 0"));
    // `flutter.tick` is a shell-side (Dart) channel that toggles the animation
    // ticker; the engine just forwards it like any other app message.
    assert_eq!(out[1].channel, "flutter.tick");

    // Tapping "Increment A" patches ONLY scope A (a scoped flutter.patch), not a
    // full re-render: exactly one message, on the patch channel, carrying A's
    // subtree at its new value. B is not touched.
    let out = engine.post_event(r#"{"handler":"incA"}"#);
    assert_eq!(out.len(), 1, "one scoped patch, not a full render");
    assert_eq!(out[0].channel, channel::PATCH);
    assert!(out[0].payload.contains("\"key\":\"counterA\""), "patch targets scope A");
    assert!(out[0].payload.contains("A: 1"), "A incremented");
    assert!(!out[0].payload.contains("counterB"), "B's scope is not in A's patch");

    // Tapping "Increment B" likewise patches only scope B.
    let out = engine.post_event(r#"{"handler":"incB"}"#);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].channel, channel::PATCH);
    assert!(out[0].payload.contains("\"key\":\"counterB\""));
    assert!(out[0].payload.contains("B: 1"));
    assert!(!out[0].payload.contains("counterA"), "A's scope is not in B's patch");

    // An animation tick patches only the clock scope — the counters never rebuild.
    let out = engine.frame(16.0);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].channel, channel::PATCH);
    assert!(out[0].payload.contains("\"key\":\"clock\""), "tick patches the clock scope");
    assert!(out[0].payload.contains(": 1"), "clock frame counter advanced");
}

/// The Flutter shell drives lifecycle handlers the demo deliberately does NOT
/// define — `onResize`/`onEvent` (the shell reports the surface size and forwards
/// raw pointer events on every build), while the demo only implements
/// `onHostMessage`/`onFrame`. Invoking an undefined handler must be a harmless
/// no-op, not a VM panic: a panic mid-turn poisons the VM and silently freezes
/// the app, which is exactly what froze the counters and clock in the live demo.
#[test]
fn undefined_lifecycle_handlers_are_harmless_no_ops() {
    let mut engine = ElpaEngine::from_js(DEMO, 1080, 1920, 2.0).expect("demo compiles");
    engine.start();

    // The shell's `_syncSurface` reports size + safe-area on first build, driving
    // `onResize` (undefined in the demo). It must not crash or emit anything.
    assert!(engine.resize(720, 1280, 2.0).is_empty(), "undefined onResize is a no-op");
    assert!(engine.safe_area(96.0, 0.0, 48.0, 0.0).is_empty(), "undefined onResize is a no-op");

    // The shell forwards raw pointer events to `onEvent` (also undefined). No-op.
    use elpa_bridge::engine::Pointer;
    assert!(engine.pointer(Pointer::Down, 10.0, 10.0, 0).is_empty(), "undefined onEvent is a no-op");
    assert!(engine.pointer(Pointer::Up, 10.0, 10.0, 0).is_empty(), "undefined onEvent is a no-op");

    // Crucially, the VM is NOT poisoned by those calls: the handlers it *does*
    // define still run and drive their scoped patches afterwards.
    let out = engine.post_event(r#"{"handler":"incA"}"#);
    assert_eq!(out.len(), 1, "tap still works after undefined-handler calls");
    assert!(out[0].payload.contains("A: 1"), "A still increments");

    let out = engine.frame(16.0);
    assert_eq!(out.len(), 1, "tick still works after undefined-handler calls");
    assert!(out[0].payload.contains("\"key\":\"clock\""), "clock still advances");
}
