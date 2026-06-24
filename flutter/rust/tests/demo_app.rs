//! End-to-end check that the shipped demo Elpa app (`assets/app/main.js`) runs on
//! the engine and drives the Flutter UI through the pipe as the Dart side expects:
//! it emits a `flutter.render` tree on start and a fresh one on each tap event.
//!
//! This exercises the exact source Flutter loads, so a break in the app or in the
//! messaging contract is caught by `cargo test` without a Flutter toolchain.

use elpa_bridge::engine::{channel, ElpaEngine};

const DEMO: &str = include_str!("../../assets/app/main.js");

#[test]
fn demo_app_renders_and_responds_to_taps() {
    let mut engine = ElpaEngine::from_js(DEMO, 1080, 1920, 2.0).expect("demo compiles");

    // Start → one render on the reserved channel, showing Count: 0.
    let out = engine.start();
    assert_eq!(out.len(), 1, "exactly one render on start");
    assert_eq!(out[0].channel, channel::RENDER);
    assert!(out[0].payload.contains("\"Scaffold\""), "root is a Scaffold");
    assert!(out[0].payload.contains("Count: 0"), "initial count is 0");

    // Tapping the "+" button: Flutter posts a flutter.event carrying the handler
    // id; the app increments and re-renders.
    let out = engine.post_event(r#"{"handler":"inc","event":"onTap","key":"inc"}"#);
    assert_eq!(out.len(), 1);
    assert!(out[0].payload.contains("Count: 1"), "tap increments the count");

    // The count Text bumps its rev so the Dart cache rebuilds it; the buttons keep
    // rev:0 so they are reused. Assert the rev moved with the count.
    assert!(out[0].payload.contains("\"rev\":1"), "count node rev tracks the value");

    // Tapping "-" twice goes negative, proving inbound events keep driving state.
    engine.post_event(r#"{"handler":"dec"}"#);
    let out = engine.post_event(r#"{"handler":"dec"}"#);
    assert!(out[0].payload.contains("Count: -1"), "decrement works");
}
