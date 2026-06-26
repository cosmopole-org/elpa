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
//!
//! ## The vello scene path
//!
//! Layered above the command tree is the **scene renderer**
//! ([`scene_renderer`], [`scene_backend`]): it maps an
//! [`elpa_protocol::Scene`] — a batch of high-level vector ops — onto a
//! [`SceneBackend`], with scene-resource caching and a whole-scene "nothing
//! changed" skip. The same seam pattern applies: the orchestration is tested
//! with a mock backend, and the real [Vello](https://github.com/linebender/vello)
//! implementation (the only place that links vello + wgpu) is the `vello-backend`
//! feature. An embedded raw wgpu frame ([`elpa_protocol::SceneOp::RawWgpu`]) is
//! composited into the same target through the wgpu [`Renderer`], so direct wgpu
//! is a subset of the scene vocabulary.

pub mod backend;
pub mod cache;
pub mod dirty;
pub mod manager;
pub mod scene_backend;
pub mod scene_renderer;
pub mod scope;

#[cfg(feature = "wgpu-backend")]
pub mod wgpu_backend;

#[cfg(feature = "vello-backend")]
pub mod vello_backend;

/// Vello's own re-exported `wgpu`. Vello pins a specific wgpu release that is
/// *not* the version a host links directly, so the two are distinct crates in the
/// dependency graph. A host that needs to name a wgpu type for the Vello path —
/// e.g. building a [`vello_backend::VelloSceneBackend`] from a canvas /
/// window `SurfaceTarget` — must use *this* wgpu, not its own, or the types will
/// not match.
#[cfg(feature = "vello-backend")]
pub use vello::wgpu as vello_wgpu;

pub use backend::GpuBackend;
pub use cache::{content_hash, PassCache, ResourceCache};
pub use dirty::DirtyTracker;
pub use manager::{FrameStats, Renderer};
pub use scene_backend::SceneBackend;
pub use scene_renderer::{scene_hash, SceneRenderer, SceneStats};
pub use scope::LayerTable;
