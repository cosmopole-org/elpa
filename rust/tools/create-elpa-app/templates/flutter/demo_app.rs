//! End-to-end smoke test for __APP_TITLE__.
//!
//! Compiles the exact bundle the app ships — the Elpa SDK modules
//! (`assets/app/sdk/*.js`) followed by the demo (`assets/app/main.js`), joined
//! like `kAppSources` in `lib/main.dart` — drives it through the real engine, and
//! checks that it boots and emits a render. A break in the SDK or the app is
//! caught here by `cargo test` with no Flutter toolchain needed.

use elpa_bridge::engine::{channel, ElpaEngine, OutMessage};

const SDK_CORE: &str = include_str!("../../assets/app/sdk/00_core.js");
const SDK_THEME: &str = include_str!("../../assets/app/sdk/01_theme.js");
const SDK_WIDGETS: &str = include_str!("../../assets/app/sdk/02_widgets.js");
const SDK_REACTIVE: &str = include_str!("../../assets/app/sdk/03_reactive.js");
const SDK_TIMING: &str = include_str!("../../assets/app/sdk/04_timing.js");
const SDK_GRAPHICS: &str = include_str!("../../assets/app/sdk/05_graphics.js");
const SDK_NAV: &str = include_str!("../../assets/app/sdk/06_navigation.js");
const SDK_APP: &str = include_str!("../../assets/app/sdk/07_app.js");
const APP_MAIN: &str = include_str!("../../assets/app/main.js");

/// The full program the VM compiles: SDK modules + the app, joined like the loader.
fn bundle() -> String {
    [
        SDK_CORE, SDK_THEME, SDK_WIDGETS, SDK_REACTIVE, SDK_TIMING, SDK_GRAPHICS, SDK_NAV, SDK_APP,
        APP_MAIN,
    ]
    .join("\n")
}

/// Drain all messages on a channel into one big string (for substring asserts).
fn joined(out: &[OutMessage], ch: &str) -> String {
    out.iter().filter(|m| m.channel == ch).map(|m| m.payload.clone()).collect::<Vec<_>>().join("|")
}

#[test]
fn app_bundle_compiles() {
    assert!(
        ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).is_some(),
        "the SDK + app bundle compiles on the VM",
    );
}

#[test]
fn app_boots_and_renders() {
    let mut engine =
        ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).expect("SDK + app bundle compiles");

    let out = engine.start();
    let render = joined(&out, channel::RENDER);
    assert!(!render.is_empty(), "a full render is emitted on start");
    assert!(render.contains("\"Scaffold\""), "the root is a Scaffold");
    assert!(render.contains("__APP_TITLE__"), "the app title is in the first render");
}

#[test]
fn frame_and_resize_do_not_crash() {
    let mut engine = ElpaEngine::from_js(&bundle(), 1080, 1920, 2.0).unwrap();
    engine.start();
    // Pump a few frames (drives timers/animations and any per-frame GPU submit)
    // and rotate the surface — all without panicking.
    for _ in 0..3 {
        let _ = engine.frame(16.0);
    }
    let _ = engine.resize(1920, 1080, 2.0);
}
