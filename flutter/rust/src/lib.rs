//! # elpa_bridge
//!
//! The native half of the Flutter app: a [flutter_rust_bridge] boundary that
//! embeds [`elpa`] and exposes it to Dart. It is the **proxy UI controller and
//! renderer for the Rust/Elpa stack** — the Elpian VM runs the app's program
//! logic, this crate pipes the VM's custom messages to and from Flutter, and the
//! Dart side turns those messages into a real Flutter widget tree (and, on the
//! `gpu` path, samples Elpa's wgpu output as a zero-copy texture).
//!
//! ## Layout
//!
//! * [`engine`] — the plain-Rust [`engine::ElpaEngine`] wrapper around an
//!   [`elpa::Elpa`] instance. No FRB types; unit-tested with `cargo test`.
//! * [`api`] — the FRB surface. A handle registry (mirroring the VM's own
//!   `machine_id` registry) so only `u64` handles, strings, and small structs
//!   ever cross the FFI boundary; the engine itself never leaves Rust. This keeps
//!   the boundary `Send`-clean and copy-free for message payloads.
//! * [`render`] — the optional wgpu zero-copy texture path for native Elpa
//!   widgets embedded in the Flutter tree (`gpu` feature).
//!
//! The generated glue (`frb_generated.rs` / `frb_generated.dart`) is produced by
//! `flutter_rust_bridge_codegen generate`; see the project README.

pub mod engine;

#[cfg(feature = "frb")]
pub mod api;

pub mod render;

// The flutter_rust_bridge codegen writes `src/frb_generated.rs` and references it
// here. It is intentionally not committed (it is a build artifact regenerated
// from `api/`); uncomment after running codegen, or let `flutter_rust_bridge_codegen
// integrate` add it for you.
// #[cfg(feature = "frb")]
// mod frb_generated;
