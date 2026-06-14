//! # elpa-material
//!
//! A **Material Design 3 (Material You) UI-kit SDK** for Elpa — and, like the
//! engine [`elpa-sdk`](../../sdk), it is **not Rust**. The SDK is the
//! **JavaScript** in `assets/`, which Elpa compiles to its VM and runs directly:
//! an Elpa instance is built straight from this source with
//! [`Elpa::new_from_js`](elpa::Elpa::new_from_js). This crate only *embeds* the
//! JS so a Rust host (the web example) can bundle and register it.
//!
//! ## What the kit is
//!
//! * [`MODULE_JS`] — the importable UI-kit module. Its top-level body registers
//!   one reusable drawing definition per **widget** (`card`, `appBar`,
//!   `filledButton`, `outlinedButton`, `fab`, `switch`, `checkbox`, `radioGroup`,
//!   `slider`, `chip`, `progress`, `divider`, plus `labels`) via
//!   `askHost("gpu.define", [def])`. Every widget is drawn by the same shared
//!   **rounded-rectangle SDF pipeline** (M3 shapes are rounded rects, pills and
//!   circles), so a widget is just an instanced draw of its rounded-rect
//!   "layers" from a per-widget instance buffer the app supplies.
//! * [`DEMO_JS`] — a complete, **interactive** demo app. It `vm.import`s the
//!   module, lays widgets out responsively from `gpu.surfaceInfo`, and wires real
//!   interaction in `onEvent`/`onFrame`: pointer press/drag/hover, mouse wheel,
//!   and keyboard all mutate widget state, which animates and re-renders. Its
//!   visuals follow the Material 3 specification the way Flutter renders it — a
//!   tonal color system, surface-container hierarchy, state layers, elevation,
//!   and an animated light/dark theme.
//!
//! ## How it stays inside the JS the VM understands
//!
//! * **All geometry / anti-aliasing math lives in WGSL** (the rounded-rect signed
//!   distance field), exactly as the engine SDK keeps trig in WGSL. The JS side
//!   only ships resource objects, instanced draws, and per-instance `f32` data.
//! * **Everything else is plain JavaScript** — `function`s, `if`/`for`, objects,
//!   arrays, arithmetic, member access, and `askHost(api, [args])` host calls —
//!   the subset Elpa's in-VM front-end lowers to the same Elpian AST a
//!   hand-written program would.

/// The importable UI-kit module, as JavaScript source. Register it as an asset
/// and `vm.import` it; see [`Elpa::register_asset`](elpa::Elpa::register_asset).
pub const MODULE_JS: &str = include_str!("../assets/elpa-material.js");

/// The interactive demo program (JavaScript) that imports [`MODULE_JS`] and
/// drives the whole UI kit from pointer / wheel / keyboard events.
pub const DEMO_JS: &str = include_str!("../assets/demo.js");

/// The asset source string the demo imports the module under.
pub const MODULE_SOURCE: &str = "assets/elpa-material.js";
