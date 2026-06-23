//! # elpa-flutter
//!
//! A **faithful, layered port of Flutter** for Elpa, written as **JavaScript**.
//! Where the sibling [`elpa-material`](../material) kit fuses measure + paint into
//! one `Widget` pass, this SDK mirrors Flutter's *actual* architecture, built
//! bottom-to-top as separate layers — exactly the layering of the real framework:
//!
//! * **`dart:ui`** ([`20-ui.js`]) — `Offset`/`Size`/`Rect`/`RRect`/`Color`/
//!   `Paint`/`Gradient`/`Path`/`Canvas`, lowering onto the SDF raster backend
//!   ([`10-engine.js`], Flutter's Skia/CanvasKit analog).
//! * **rendering** ([`30-rendering.js`]) — `BoxConstraints`, `RenderObject` /
//!   `RenderBox` (constraints down, sizes up), `PaintingContext`, the parent-data
//!   protocol, `RenderView`, and the concrete render boxes (ConstrainedBox,
//!   Padding, Align, **Flex**, Stack, DecoratedBox, Paragraph, Transform, Opacity,
//!   ClipRRect, PointerListener).
//! * **widgets** ([`40-widget.js`]) — `Widget`/`Element`/`BuildContext`/
//!   `BuildOwner`, `Key`, the `updateChild`/`updateChildren` reconciliation,
//!   `StatelessWidget`/`StatefulWidget`+`State.setState`, `RenderObjectElement`
//!   (leaf/single/multi child), `InheritedWidget`, `ParentDataWidget`.
//! * **catalog + Material** ([`50-widgets.js`]) — the widget catalog and a small
//!   Material catalog.
//! * **binding** ([`60-binding.js`]) — `WidgetsFlutterBinding` + `runApp`: the
//!   build→layout→paint→composite→submit frame pipeline and the host entry points.
//!
//! The SDK and the app run in **one** VM; [`program`] concatenates the SDK ahead
//! of the app and hands the result to
//! [`Elpa::new_from_js`](elpa::Elpa::new_from_js).

/// The framework, as JavaScript source — each layer a single-responsibility
/// module, concatenated in dependency order.
pub const SDK_DATA_JS: &str = include_str!("../assets/sdk/00-data.js");
pub const SDK_ENGINE_JS: &str = include_str!("../assets/sdk/10-engine.js");
pub const SDK_UI_JS: &str = include_str!("../assets/sdk/20-ui.js");
pub const SDK_RENDERING_JS: &str = include_str!("../assets/sdk/30-rendering.js");
pub const SDK_WIDGET_JS: &str = include_str!("../assets/sdk/40-widget.js");
pub const SDK_WIDGETS_JS: &str = include_str!("../assets/sdk/50-widgets.js");
pub const SDK_BINDING_JS: &str = include_str!("../assets/sdk/60-binding.js");

/// The framework as one JavaScript source (the modules concatenated). The VM
/// hoists every `class`/`function`, so this is just textual concatenation.
pub fn module_js() -> String {
    format!("{SDK_DATA_JS}\n{SDK_ENGINE_JS}\n{SDK_UI_JS}\n{SDK_RENDERING_JS}\n{SDK_WIDGET_JS}\n{SDK_WIDGETS_JS}\n{SDK_BINDING_JS}")
}

/// The interactive demo application, as JavaScript source. Uses [`module_js`].
pub const DEMO_JS: &str = include_str!("../assets/demo.js");

/// The full program a host runs: the SDK linked ahead of the app, in one VM.
pub fn program() -> String {
    format!("{}\n{DEMO_JS}", module_js())
}
