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
