//! # elpa-renderer
//!
//! The rendering half of Elpa. It is split into two concerns:
//!
//! 1. **Drawing-management layer** ([`manager`], [`cache`], [`dirty`]): a
//!    GPU-agnostic engine that turns a [`elpa_protocol::DrawList`] into a set of
//!    cached compositing layers, tracks which screen rectangles changed between
//!    frames, and decides the minimal work to present the next frame.
//!
//! 2. **GPU backend** ([`backend`]): the [`backend::GpuBackend`] trait that the
//!    drawing manager drives. The concrete wgpu implementation (under the
//!    `wgpu-backend` feature) maps cache/composite operations to wgpu render
//!    passes — the "Elpian-commands → wgpu-commands" mapping.
//!
//! The split keeps the hard, well-tested logic (caching, dirty rects, layer
//! composition) independent of the GPU API, and keeps the GPU code a thin,
//! mechanical translation layer. See `PLAN.md` for the full design.

pub mod backend;
pub mod cache;
pub mod dirty;
pub mod manager;

pub use backend::{Frame, GpuBackend};
pub use cache::{CacheKey, LayerCache};
pub use dirty::DirtyTracker;
pub use manager::DrawingManager;
