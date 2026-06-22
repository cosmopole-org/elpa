//! # elpa-websdk
//!
//! An **HTML + CSS web SDK** for Elpa - the browser's element model and CSS
//! engine - written as **JavaScript**, not Rust. Elpa compiles the JS to its VM
//! and runs it directly. Apps compose a tree of HTML elements with CSS and never
//! touch the GPU; the kit lays the page out and paints the *entire* document
//! through **one instanced SDF pipeline** (text, boxes, borders, gradients,
//! shadows), so it stays high-FPS regardless of element count.
//!
//! ## What the kit is
//!
//! * [`module_js`] - **the SDK**, split into single-responsibility modules
//!   (concatenated in dependency order):
//!   `00-data` (the SDF + image WGSL, the glyph font, the CSS named-colour
//!   table), `10-engine` (the `Painter`, `FontEngine`, `MediaEngine`,
//!   `AnimationClock`), `15-css` (the **CSS engine**: the `Viewport`, the
//!   `<color>`/`<length>` grammars, shorthand expansion, inheritance and the
//!   `computeStyle` cascade), `20-node` (the `Box` base class - the CSS box
//!   model + decoration paint), `30-layout` (block/inline flow with line-box
//!   text wrapping, **flexbox**, **grid**, absolute/relative positioning),
//!   `40-elements` (the HTML element catalog as `Box` subclasses + the
//!   user-agent stylesheet), `50-runtime` (the retained-tree `WebRuntime`:
//!   mount, partial update, the transition/animation clock, the DOM-style event
//!   loop and the `gpu.submit` frame builder with a static/dynamic layered
//!   split), and `60-api` (the element constructors, `h()` hyperscript,
//!   `defineComponent`/`runApp`, and the host entry points).
//! * [`DEMO_JS`] - **a product landing page** built from the SDK (nav, a hero
//!   with a live continuous animation, a feature grid with `:hover` transitions,
//!   a stat band, an interactive FAQ, and a footer).
//!
//! The SDK and app run in **one** VM; [`program`] concatenates the SDK ahead of
//! the app and the result is handed to
//! [`Elpa::new_from_js`](elpa::Elpa::new_from_js).

pub const SDK_DATA_JS: &str = include_str!("../assets/sdk/00-data.js");
pub const SDK_ENGINE_JS: &str = include_str!("../assets/sdk/10-engine.js");
pub const SDK_CSS_JS: &str = include_str!("../assets/sdk/15-css.js");
pub const SDK_NODE_JS: &str = include_str!("../assets/sdk/20-node.js");
pub const SDK_LAYOUT_JS: &str = include_str!("../assets/sdk/30-layout.js");
pub const SDK_ELEMENTS_JS: &str = include_str!("../assets/sdk/40-elements.js");
pub const SDK_RUNTIME_JS: &str = include_str!("../assets/sdk/50-runtime.js");
pub const SDK_API_JS: &str = include_str!("../assets/sdk/60-api.js");

/// The Web SDK as one JavaScript source - the eight `assets/sdk/*.js` modules
/// concatenated in dependency order.
pub fn module_js() -> String {
    format!(
        "{SDK_DATA_JS}\n{SDK_ENGINE_JS}\n{SDK_CSS_JS}\n{SDK_NODE_JS}\n{SDK_LAYOUT_JS}\n{SDK_ELEMENTS_JS}\n{SDK_RUNTIME_JS}\n{SDK_API_JS}"
    )
}

/// The showcase application, as JavaScript source. Uses [`module_js`].
pub const DEMO_JS: &str = include_str!("../assets/demo.js");

/// The full program a host runs: the SDK linked ahead of the app, in one VM.
/// Pass the result to [`Elpa::new_from_js`](elpa::Elpa::new_from_js).
pub fn program() -> String {
    format!("{}\n{DEMO_JS}", module_js())
}
