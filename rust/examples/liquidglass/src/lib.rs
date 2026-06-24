//! # elpa-liquidglass
//!
//! A **Liquid Glass UI kit** for Elpa — Apple's iOS-26 "Liquid Glass" material —
//! written as **JavaScript**, not Rust. Elpa compiles the JS to its VM and runs
//! it directly. The kit renders the *entire* UI — a refractable wallpaper, glass
//! chrome, solids and text — through **one instanced pipeline** in **two GPU
//! passes** regardless of widget count, so it stays high-FPS:
//!
//! 1. **Capture** the backdrop (everything behind the first glass lens) into a
//!    reduced-resolution offscreen texture.
//! 2. **Surface**: draw the whole instance stream once; each glass lens samples
//!    that texture with an SDF-normal **refraction** displacement, edge-only
//!    **chromatic aberration**, a multi-tap **blur**, a directional **specular**
//!    rim and a translucent **tint** — the real Liquid-Glass formula.
//!
//! ## What the kit is
//!
//! * [`module_js`] — **the SDK**: the glass WGSL pipeline, a glyph font + vector
//!   icon set, a responsive layout coordinator, the animated glass theme, ~40
//!   widget constructors (layout: `Container`, `Row`/`Column`, `Stack`,
//!   `ListView`/`GridView`, `Scaffold`, …; glass: `GlassCard`, `AppBar`,
//!   `FilledButton`/`GlassButton`/`OutlinedButton`, `Fab`, `Switch`, `Slider`,
//!   `Chip`, `SegmentedButton`, `NavigationBar`, `Tabs`, `TextField`, `ListTile`,
//!   `Dialog`, `BottomSheet`, …), capability-gated platform-service wrappers, and
//!   a retained-tree component runtime (`defineComponent` / `runApp`). Apps never
//!   touch the GPU.
//! * [`DEMO_JS`] — **the showcase app**: declares state and composes a glass
//!   widget tree.
//!
//! The SDK and app run in **one** VM; [`program`] concatenates the SDK ahead of
//! the app and the result is handed to
//! [`Elpa::new_from_js`](elpa::Elpa::new_from_js).

/// The Liquid Glass SDK modules, concatenated in dependency order (data → engine
/// services → the Widget base → the widget catalog → the runtime → the API).
pub const SDK_DATA_JS: &str = include_str!("../assets/sdk/00-data.js");
pub const SDK_ENGINE_JS: &str = include_str!("../assets/sdk/10-engine.js");
pub const SDK_WIDGET_JS: &str = include_str!("../assets/sdk/20-widget.js");
pub const SDK_WIDGETS_LAYOUT_JS: &str = include_str!("../assets/sdk/30-widgets-layout.js");
pub const SDK_WIDGETS_GLASS_JS: &str = include_str!("../assets/sdk/31-widgets-glass.js");
pub const SDK_RUNTIME_JS: &str = include_str!("../assets/sdk/40-runtime.js");
pub const SDK_API_JS: &str = include_str!("../assets/sdk/50-api.js");

/// The Liquid Glass SDK as one JavaScript source — the seven `assets/sdk/*.js`
/// modules concatenated in dependency order.
pub fn module_js() -> String {
    format!(
        "{SDK_DATA_JS}\n{SDK_ENGINE_JS}\n{SDK_WIDGET_JS}\n{SDK_WIDGETS_LAYOUT_JS}\n{SDK_WIDGETS_GLASS_JS}\n{SDK_RUNTIME_JS}\n{SDK_API_JS}"
    )
}

/// The interactive demo application, as JavaScript source. Uses [`module_js`].
pub const DEMO_JS: &str = include_str!("../assets/demo.js");

/// The feature-rich calculator application, as JavaScript source. A second app
/// built on the same SDK: an in-VM expression engine (tokenizer + shunting-yard
/// parser + RPN evaluator over the standard library) wired to a responsive glass
/// keypad with a BASIC/SCIENTIFIC switch, DEG/RAD + theme chips, memory keys and
/// a tap-to-recall history. Uses [`module_js`].
pub const CALCULATOR_JS: &str = include_str!("../assets/calculator.js");

/// The full demo program a host runs: the SDK linked ahead of the showcase app,
/// in one VM. Pass the result to [`Elpa::new_from_js`](elpa::Elpa::new_from_js).
pub fn program() -> String {
    format!("{}\n{DEMO_JS}", module_js())
}

/// The full calculator program: the SDK linked ahead of the calculator app, in
/// one VM. Pass the result to [`Elpa::new_from_js`](elpa::Elpa::new_from_js).
pub fn calculator_program() -> String {
    format!("{}\n{CALCULATOR_JS}", module_js())
}
