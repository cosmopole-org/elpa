//! # elpa-sdk
//!
//! The Elpa engine SDK is **not Rust** — it is the Elpian **AST JSON** in
//! `assets/`, which runs directly on the Elpian VM. This crate only *embeds*
//! those assets so a Rust host (the native / web examples) can bundle and
//! register them, and hosts a generator binary (`build_sdk`) that authors them.
//!
//! ## What the SDK is
//!
//! * [`MODULE_AST`] — the importable SDK module. It is a program whose body is a
//!   sequence of `gpu.define` host calls, one per standard shape (`rect`,
//!   `triangle`, `circle`, `cube`, `sphere`). An Elpa app pulls it in with
//!   `vm.import` and then references shapes abstractly by id (e.g.
//!   `elpa.sdk.cube`) in `gpu.submit` frames — never re-emitting their commands.
//! * [`DEMO_AST`] — a demo program that imports the module and draws a 2D scene
//!   and a 3D scene by reference, supplying only numeric per-instance data.
//!
//! ## How it stays inside Elpian's abilities
//!
//! Elpian has no `sin`/`cos`/`tan`, so **all** geometry, rotation and projection
//! math lives in the WGSL shaders the AST carries (WGSL has trig). The Elpian
//! side only ships resource objects, instanced draw definitions, and per-instance
//! data as plain `f32` arrays (via the protocol's `data_f32` buffer init) — every
//! one of which the Elpian language expresses natively.
//!
//! Regenerate the assets with `cargo run -p elpa-sdk --bin build_sdk`.

/// The importable SDK module as Elpian AST JSON. Register it as an asset and
/// `vm.import` it; see `Elpa::register_asset`.
pub const MODULE_AST: &str = include_str!("../assets/elpa-sdk.ast.json");

/// A demo program (Elpian AST JSON) that imports [`MODULE_AST`] and draws 2D and
/// 3D shapes by reference.
pub const DEMO_AST: &str = include_str!("../assets/demo.ast.json");

/// The asset source string the demo imports the module under.
pub const MODULE_SOURCE: &str = "assets/elpa-sdk.ast.json";
