//! # elpa-protocol
//!
//! The data contracts shared across the Elpa stack. These types are the
//! "language" spoken between the VM, the runtime, and the renderer:
//!
//! * [`HostCall`] — the envelope the VM emits when it pauses on `askHost`.
//! * [`UiNode`] — one node of the UI hierarchy tree carried by the `render`
//!   host call. Nested arrays/objects of these describe the whole UI.
//! * [`DrawCommand`] — the flat, renderer-ready primitive list the UI tree is
//!   *lowered* into after layout. This is what the drawing-management layer
//!   caches, diffs, and replays.
//! * [`Rect`] / [`Color`] / [`Transform`] — geometry & paint primitives.
//!
//! Keeping these in a dedicated crate means the VM never depends on wgpu and the
//! renderer never depends on the VM — they only agree on this vocabulary.
//!
//! See `PLAN.md` for how these types flow through the pipeline.

pub mod command;
pub mod geometry;
pub mod hostcall;
pub mod node;

pub use command::{DrawCommand, DrawList, LayerId};
pub use geometry::{Color, Point, Rect, Transform};
pub use hostcall::HostCall;
pub use node::{UiNode, UiTree};
