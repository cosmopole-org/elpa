//! # elpa-protocol
//!
//! The data contract between the VM and the renderer. Elpa is a *programmable VM
//! around the wgpu API*: the VM emits a **nested JSON tree of wgpu commands** and
//! the renderer maps it to wgpu in real time. This crate is that tree's schema.
//!
//! There is **no** widget / DOM / canvas abstraction here — the types mirror
//! `wgpu` itself:
//!
//! * [`Frame`] — one `gpu.submit`: the resources to ensure + the encoder
//!   commands to run.
//! * [`ResourceDesc`] — declarative GPU resources (buffers, textures, samplers,
//!   shaders, bind groups, pipelines) keyed by [`ResourceId`] for caching.
//! * [`EncoderCommand`] / [`RenderPass`] / [`ComputePass`] — the imperative
//!   command tree (render/compute passes, draws, dispatches, copies, writes).
//! * [`HostCall`] — the envelope the VM pauses with on `askHost`.
//! * geometry: [`Rect`] (scissor/viewport/dirty), [`Color`] (clear),
//!   [`Extent3d`]/[`Origin3d`] (textures/copies).
//!
//! 2D and 3D are not distinct here: they are the same commands with different
//! pipelines and shaders. See `PLAN.md` for the full mapping and coverage.

pub mod command;
pub mod definition;
pub mod geometry;
pub mod hostcall;
pub mod resource;

pub use command::{
    ColorAttachment, ComputeCommand, ComputePass, EncoderCommand, Frame, RenderCommand, RenderPass,
    TargetView,
};
pub use definition::{Definition, DefinitionBody};
pub use geometry::{Color, Extent3d, Origin3d, Rect};
pub use hostcall::HostCall;
pub use resource::{ResourceDesc, ResourceId};
