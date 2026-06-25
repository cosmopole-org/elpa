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
//!
//! Layered *above* the raw command tree is the **vello scene** ([`scene`]): a
//! [`Scene`] is a batch of high-level vector-drawing [`SceneOp`]s (fills,
//! strokes, clips, gradients, images, glyphs) the VM streams via `scene.submit`.
//! The raw command tree survives as a single [`SceneOp::RawWgpu`] op, so direct
//! wgpu usage is a *subset* of the scene vocabulary, composited into the same
//! target. This is Elpa's primary drawing path.

pub mod command;
pub mod definition;
pub mod geometry;
pub mod hostcall;
pub mod resource;
pub mod scene;
pub mod scope;

pub use command::{
    ColorAttachment, ComputeCommand, ComputePass, EncoderCommand, Frame, RenderCommand, RenderPass,
    TargetView,
};
pub use definition::{Definition, DefinitionBody};
pub use geometry::{Color, Extent3d, Origin3d, Rect};
pub use hostcall::HostCall;
pub use resource::{ResourceDesc, ResourceId};
pub use scene::{
    Affine, Brush, Cap, ColorStop, Compose, Extend, FillRule, Glyph, GlyphRun, Gradient,
    GradientKind, Join, Mix, Path, PathEl, Scene, SceneOp, SceneResource, StrokeStyle,
};
pub use scope::{
    layer_paint_pass_id, layer_texture_id, layer_xform_buffer, layer_xform_id, Layer,
    LayerTransform,
};
