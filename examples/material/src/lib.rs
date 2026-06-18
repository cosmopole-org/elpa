//! # elpa-material
//!
//! A **Material Design 3 (Material You) UI framework** for Elpa, written as
//! **JavaScript** — a small, Flutter-style widget toolkit plus an interactive
//! demo that uses it. Like the engine [`elpa-sdk`](../../sdk), it is **not Rust**:
//! Elpa compiles the JS to its VM and runs it directly.
//!
//! ## What the kit is
//!
//! * [`module_js`] — **the SDK**. A widget framework: the rounded-rect SDF
//!   pipeline, a glyph font (digits + symbols) and vector icon set, a responsive
//!   layout coordinator, the per-widget M3 colors/sizes, ~50 widget constructors
//!   spanning layout (`Container`, `Padding`, `SafeArea`, `Center`,
//!   `Stack`/`Positioned`, `Wrap`, `ListView`, `GridView`, `Expanded`, …),
//!   the Material catalog
//!   (`Scaffold`, `AppBar`, `TextField`, `IconButton`, `ListTile`, `Tabs`,
//!   `NavigationBar`, `SegmentedButton`, `ExpansionTile`, `Drawer`, `Dialog`,
//!   `Snackbar`, …), content/charts (`DataTable`, `BarChart`, `LineChart`,
//!   `PieChart`, `Sparkline`) and media (`Image`, `VideoPlayer`), plus
//!   capability-gated platform-service wrappers (`storeRead`/`storeWrite`,
//!   `httpGet`/`httpPost`, `now`, `randomUnit`), and a retained-tree component
//!   runtime — `defineComponent(fn)` / `runApp(root)` — whose internals end in
//!   `gpu.submit`. Apps never touch the GPU.
//! * [`DEMO_JS`] — **the original app**, and [`GALLERY_JS`] — **a wider showcase**
//!   of the extended catalog. Both use the SDK as a black box: declare state and
//!   compose a widget tree. Components are plain functions `(props, update) =>
//!   widget`, wrapped with `defineComponent` and then instantiated like Flutter
//!   widgets (`Tile({ ... })`, no wrapper); a tap handler mutates state and calls
//!   `update()`, which repaints **only that component** (parents and siblings
//!   reuse cached output) — the Flutter `setState` pattern done right.
//!
//! ## Linking
//!
//! The SDK and app run in **one** VM (Elpa's `vm.import` would run a module in a
//! separate, disposed VM, so its functions would not be callable). [`program`]
//! concatenates the SDK ahead of the app — exactly like a Flutter app
//! `import`ing `package:flutter/material.dart` — and the result is handed to
//! [`Elpa::new_from_js`](elpa::Elpa::new_from_js).
//!
//! Arrow functions / closures (tap callbacks, the component `update`) are part of
//! the JavaScript subset Elpa's in-VM front-end supports.

/// The Material SDK, as JavaScript source.
///
/// The framework is organised into single-responsibility modules under
/// `assets/sdk/`, concatenated here in dependency order (data → engine services
/// → the Widget base → the widget catalog → the runtime → the public API). The
/// VM hoists every `class`/`function` declaration, so this is just textual
/// concatenation; [`module_js`] joins them into the one source the VM compiles.
pub const SDK_DATA_JS: &str = include_str!("../assets/sdk/00-data.js");
pub const SDK_ENGINE_JS: &str = include_str!("../assets/sdk/10-engine.js");
pub const SDK_WIDGET_JS: &str = include_str!("../assets/sdk/20-widget.js");
pub const SDK_WIDGETS_LAYOUT_JS: &str = include_str!("../assets/sdk/30-widgets-layout.js");
pub const SDK_WIDGETS_MATERIAL_JS: &str = include_str!("../assets/sdk/31-widgets-material.js");
pub const SDK_WIDGETS_MEDIA_JS: &str = include_str!("../assets/sdk/32-widgets-media.js");
pub const SDK_GRAPHICS_JS: &str = include_str!("../assets/sdk/33-graphics.js");
pub const SDK_RUNTIME_JS: &str = include_str!("../assets/sdk/40-runtime.js");
pub const SDK_API_JS: &str = include_str!("../assets/sdk/50-api.js");

/// The Material SDK (the widget framework), as one JavaScript source — the eight
/// `assets/sdk/*.js` modules concatenated in dependency order.
pub fn module_js() -> String {
    format!(
        "{SDK_DATA_JS}\n{SDK_ENGINE_JS}\n{SDK_WIDGET_JS}\n{SDK_WIDGETS_LAYOUT_JS}\n{SDK_WIDGETS_MATERIAL_JS}\n{SDK_WIDGETS_MEDIA_JS}\n{SDK_GRAPHICS_JS}\n{SDK_RUNTIME_JS}\n{SDK_API_JS}"
    )
}

/// The interactive demo application, as JavaScript source. Uses [`module_js`].
pub const DEMO_JS: &str = include_str!("../assets/demo.js");

/// The widget *gallery* application, as JavaScript source. Exercises the extended
/// widget set (layout widgets, the broader Material catalog, charts, media) and
/// the platform-service wrappers. Also uses [`module_js`].
pub const GALLERY_JS: &str = include_str!("../assets/gallery.js");

/// The *graphics* showcase application, as JavaScript source. Exercises the
/// painting layer: CustomPaint / Canvas, gradients, the Opacity / ColorFiltered /
/// Transform / RotatedBox effect wrappers and the BackdropFilter frosted-glass
/// blur (the multi-pass offscreen-capture path). Also uses [`module_js`].
pub const GRAPHICS_JS: &str = include_str!("../assets/graphics.js");

/// The full program a host runs: the SDK linked ahead of the app, in one VM.
/// Pass the result to [`Elpa::new_from_js`](elpa::Elpa::new_from_js).
pub fn program() -> String {
    format!("{}\n{DEMO_JS}", module_js())
}

/// The SDK linked ahead of the widget gallery — the analog of [`program`] for
/// [`GALLERY_JS`].
pub fn gallery_program() -> String {
    format!("{}\n{GALLERY_JS}", module_js())
}

/// The SDK linked ahead of the graphics showcase — the analog of [`program`] for
/// [`GRAPHICS_JS`].
pub fn graphics_program() -> String {
    format!("{}\n{GRAPHICS_JS}", module_js())
}

/// The particle-field compute kernel (`field(spec)`), shared by the parallel
/// showcase's inline and worker paths.
pub const GRAPHICS_FIELD_WORKER_JS: &str = include_str!("../assets/graphics_field_worker.js");

/// The *parallel graphics* showcase, as JavaScript source. Computes a per-frame
/// particle field on the worker-thread pool (`taskInit` + `parallelMap`) and
/// paints it through a CustomPaint — the demonstration that the painting layer
/// can divide its per-frame geometry work across CPU cores.
pub const GRAPHICS_PARALLEL_JS: &str = include_str!("../assets/graphics_parallel.js");

/// The SDK linked ahead of the parallel-graphics showcase. The compute kernel is
/// linked in twice over: once as runnable code (so the single-threaded path can
/// call `field` directly) and once as the `FIELD_WORKER` source string the app
/// hands to `taskInit` so every worker thread compiles it into its own executor.
pub fn graphics_parallel_program() -> String {
    // A minimal JSON string-literal encoder so the kernel source can be embedded
    // as a JS string without a serde dependency in the library crate.
    let mut lit = String::with_capacity(GRAPHICS_FIELD_WORKER_JS.len() + 16);
    lit.push('"');
    for c in GRAPHICS_FIELD_WORKER_JS.chars() {
        match c {
            '"' => lit.push_str("\\\""),
            '\\' => lit.push_str("\\\\"),
            '\n' => lit.push_str("\\n"),
            '\r' => lit.push_str("\\r"),
            '\t' => lit.push_str("\\t"),
            c if (c as u32) < 0x20 => lit.push_str(&format!("\\u{:04x}", c as u32)),
            c => lit.push(c),
        }
    }
    lit.push('"');
    format!(
        "{}\n{GRAPHICS_FIELD_WORKER_JS}\nvar FIELD_WORKER = {lit};\n{GRAPHICS_PARALLEL_JS}",
        module_js()
    )
}
