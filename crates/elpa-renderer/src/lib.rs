//! # elpa-renderer
//!
//! The renderer is the real-time map from the [`elpa_protocol::Frame`] wgpu
//! command tree to the wgpu API, plus the two optimizations that make Elpa more
//! than a thin shim:
//!
//! 1. **Resource caching** ([`cache`]): every [`elpa_protocol::ResourceDesc`] is
//!    created on the GPU once and reused until its content hash changes. Static
//!    pipelines/buffers/textures cost nothing after frame 1.
//!
//! 2. **Partial rendering** ([`manager`], [`dirty`]): each render/compute pass is
//!    content-hashed (including the hashes of the resources it references).
//!    Unchanged offscreen passes are *skipped entirely* — their cached target
//!    texture is reused — and the surface present is scissored to the changed
//!    region. A frame with nothing changed submits no work.
//!
//! 3. **Layer scoping** ([`scope`]): a program can register an offscreen pass as
//!    an independently-cached **layer**. Unlike a content-hashed pass, a layer's
//!    snapshot validity is *explicit* — reused with no GPU work until the program
//!    invalidates it ([`Renderer::invalidate_layer`]) — so a decoupled region (a
//!    navigation drawer, an app bar, the scrolling body) holds its rendered
//!    snapshot across frames and repaints only on command. This is the renderer
//!    half of Elpa's `scope.*` API; the host half lives in `elpa-runtime`.
//!
//! The actual wgpu calls live behind the [`backend::GpuBackend`] trait, so the
//! cache/partial-render logic is validated with a mock backend and no GPU. The
//! wgpu implementation (the literal command→API mapping) is the `wgpu-backend`
//! feature and is the only place that links wgpu.

pub mod backend;
pub mod cache;
pub mod dirty;
pub mod manager;
pub mod scope;

#[cfg(feature = "wgpu-backend")]
pub mod wgpu_backend;

pub use backend::GpuBackend;
pub use cache::{content_hash, PassCache, ResourceCache};
pub use dirty::DirtyTracker;
pub use manager::{FrameStats, Renderer};
pub use scope::LayerTable;
