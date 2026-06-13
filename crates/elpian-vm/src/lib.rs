//! # elpian-vm
//!
//! The Elpian AST-based bytecode virtual machine, ported from the Elpian
//! project for use as the application logic core of the Elpa framework.
//!
//! ## Pipeline
//!
//! ```text
//! JS source ──(acorn/babel front-end, off-VM)──▶ Elpian AST JSON
//!           ──(compiler::compile_ast)──────────▶ bytecode (Vec<u8>)
//!           ──(executor)───────────────────────▶ execution + host calls
//! ```
//!
//! The VM is a *pausing* interpreter: when user code calls
//! `askHost(apiName, payload)` it suspends and hands a host-call request back
//! to the embedder. The embedder (the Elpa runtime) services the call —
//! crucially `askHost("render", uiTree)` — and resumes the VM with
//! [`api::continue_execution`].
//!
//! This crate is renderer-agnostic. It knows nothing about wgpu; it only emits
//! host-call requests as JSON. The `elpa-runtime` crate wires those requests to
//! the `elpa-renderer`.
//!
//! See `PLAN.md` at the repository root for the full architecture.

pub mod api;
pub mod sdk;

pub use sdk::data::Val;
pub use sdk::vm::VM;
