//! # elpa-material
//!
//! A **Material Design 3 (expressive) UI-kit SDK** for Elpa — and, like the
//! engine [`elpa-sdk`](../../sdk), it is **not Rust**. The SDK is the Elpian
//! **AST JSON** in `assets/`, which runs directly on the Elpian VM. This crate
//! only *embeds* those assets so a Rust host (the web example) can bundle and
//! register them, and hosts a generator binary (`build_material`) that authors
//! them.
//!
//! ## What the kit is
//!
//! * [`MODULE_AST`] — the importable UI-kit module. Its body is a sequence of
//!   `gpu.define` host calls, one per **widget** (`card`, `appBar`,
//!   `filledButton`, `outlinedButton`, `fab`, `switch`, `checkbox`, `radioGroup`,
//!   `slider`, `chip`, `progress`, `divider`). Every widget is drawn by the same
//!   shared **rounded-rectangle SDF pipeline** (M3 shapes are rounded rects,
//!   pills and circles), so a widget definition is just an instanced draw of its
//!   rounded-rect "layers" from a per-widget instance buffer the app supplies.
//! * [`DEMO_AST`] — a complete, **interactive** demo app. It imports the module,
//!   lays the widgets out responsively from `gpu.surfaceInfo`, and wires real
//!   interaction in `onEvent`/`onFrame`: pointer press/drag/hover, mouse wheel,
//!   and keyboard all mutate widget state, which animates and re-renders.
//!
//! ## How it stays inside Elpian's abilities
//!
//! * **All geometry / anti-aliasing math lives in WGSL** (the rounded-rect signed
//!   distance field), exactly as the engine SDK keeps trig in WGSL. The Elpian
//!   side only ships resource objects, instanced draw definitions, and per-instance
//!   `f32` data.
//! * **All interaction is branch-free arithmetic.** Hit-testing and state updates
//!   are expressed as comparisons cast to `0.0`/`1.0` and combined with `*`/`+`
//!   (e.g. a toggle is `s + hit - 2*s*hit`), so the handler needs no control flow
//!   beyond the VM's `functionCall`/`assignment`/`arithmetic`/`cast` opcodes.
//!
//! Regenerate the assets with `cargo run -p elpa-material --bin build_material`.

/// The importable UI-kit module as Elpian AST JSON. Register it as an asset and
/// `vm.import` it; see `Elpa::register_asset`.
pub const MODULE_AST: &str = include_str!("../assets/elpa-material.ast.json");

/// The interactive demo program (Elpian AST JSON) that imports [`MODULE_AST`] and
/// drives the whole UI kit from pointer / wheel / keyboard events.
pub const DEMO_AST: &str = include_str!("../assets/demo.ast.json");

/// The asset source string the demo imports the module under.
pub const MODULE_SOURCE: &str = "assets/elpa-material.ast.json";
