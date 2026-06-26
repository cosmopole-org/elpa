//! The scene orchestrator: walks a [`Scene`] and drives a [`SceneBackend`],
//! applying scene-resource caching and a whole-scene "nothing changed" skip.
//!
//! Unlike the wgpu [`Renderer`](crate::Renderer), which caches *per pass* (Vello
//! re-encodes the whole scene every frame by design), the scene renderer's
//! optimization is coarser but keeps the same philosophy:
//!
//! 1. **Resource caching** — every [`SceneResource`] (image/font) is uploaded
//!    once and reused until its content hash changes.
//! 2. **Free unchanged frames** — the whole scene is content-hashed; if it is
//!    byte-for-byte identical to the last presented scene, the renderer encodes
//!    and presents *nothing* (the surface still holds the last result). A frame
//!    that only re-submits the same UI does no GPU work.
//!
//! Raw wgpu frames embedded as [`SceneOp::RawWgpu`] are encoded through the
//! backend like any other op (the backend composites them into the same target),
//! and counted in [`SceneStats::raw_frames`].

use xxhash_rust::xxh3::Xxh3;

use elpa_protocol::{Rect, Scene, SceneOp, SceneResource};

use crate::cache::content_hash;
use crate::scene_backend::SceneBackend;

/// A resident scene resource: its content hash (for the upload-once cache) plus
/// the descriptor itself, kept so it can be re-uploaded onto a fresh backend when
/// the host swaps one in (headless → live Vello).
struct Resident {
    hash: u64,
    desc: SceneResource,
}

/// Per-frame work report for the scene path. The steady-state goal for a static
/// UI is `resources_uploaded == 0 && !presented` with `cached == true`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SceneStats {
    pub resources_uploaded: usize,
    pub resources_dropped: usize,
    pub ops_encoded: usize,
    /// Embedded raw wgpu frames composited this scene (a subset of `ops_encoded`).
    pub raw_frames: usize,
    /// The whole scene was unchanged from the last present — no work was done.
    pub cached: bool,
    pub presented: bool,
}

/// Maps a [`Scene`] onto a [`SceneBackend`] with resource caching and a
/// whole-scene skip. Generic over the backend so the encode/skip logic is tested
/// with a mock and no GPU; the `vello-backend` feature supplies the real one.
pub struct SceneRenderer<B: SceneBackend> {
    backend: B,
    /// Resident scene resources (image/font) keyed by id: content hash for
    /// upload caching plus the descriptor for re-upload after a backend swap.
    ///
    /// Resources are **sticky**: a resource is uploaded once and kept resident
    /// until its content changes — it is *not* evicted just because a later scene
    /// omits it. This is what lets the app transmit a large blob (a UI font is
    /// ~200 KB of base64) a single time instead of re-embedding it in every
    /// `scene.submit`, which the VM would otherwise re-serialize each frame.
    resources: ahash::AHashMap<String, Resident>,
    /// Hash of the last *presented* scene, for the "nothing changed" skip.
    last_scene: Option<u64>,
}

impl<B: SceneBackend> SceneRenderer<B> {
    pub fn new(backend: B) -> Self {
        Self { backend, resources: ahash::AHashMap::new(), last_scene: None }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }
    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    /// Swap in a different scene backend, **re-uploading** every resident
    /// resource onto it and forcing a re-present. The previous backend's device
    /// owned the old GPU handles, so the new backend starts empty; because scene
    /// resources are sticky (the app sends a font once, not every frame), the
    /// renderer must restore them itself rather than wait for the app to re-embed
    /// them. This is how a host upgrades a live instance from the headless backend
    /// to a real Vello surface without the app losing its font/images.
    pub fn replace_backend(&mut self, backend: B) -> B {
        let old = std::mem::replace(&mut self.backend, backend);
        for res in self.resources.values() {
            self.backend.ensure_resource(&res.desc);
        }
        self.invalidate();
        old
    }

    /// Force the next scene to re-present even if its content is unchanged (after
    /// a surface resize / format change, where the surface contents are stale).
    pub fn invalidate(&mut self) {
        self.last_scene = None;
    }

    /// Map one submitted [`Scene`] onto the backend.
    pub fn render(&mut self, scene: &Scene) -> SceneStats {
        let mut stats = SceneStats::default();

        // 1. Whole-scene skip: an identical re-submit does nothing. The hash
        //    covers resources + ops, so any visible change forces a re-present.
        let hash = content_hash(scene);
        if self.last_scene == Some(hash) {
            stats.cached = true;
            return stats;
        }

        // 2. Resource reconciliation: upload new/changed resources. Resources are
        //    sticky (kept resident across frames), so a scene that omits one it
        //    uploaded earlier keeps using it — no per-frame re-transmit of large
        //    font/image blobs.
        stats.resources_uploaded = self.sync_resources(&scene.resources);

        // 3. Encode + present the scene.
        self.backend.begin_scene();
        for op in &scene.ops {
            self.backend.encode_op(op);
            stats.ops_encoded += 1;
            if matches!(op, SceneOp::RawWgpu { .. }) {
                stats.raw_frames += 1;
            }
        }
        // The scene path presents the whole surface; partial-region scissoring is
        // a backend concern (Vello rasterizes the full scene), so the dirty list
        // is empty here. A future backend may narrow it.
        self.backend.present_scene(&[] as &[Rect]);
        stats.presented = true;
        self.last_scene = Some(hash);
        stats
    }

    /// Upload resources whose content hash is new or changed; returns the count
    /// that hit the backend. Unchanged resources are already resident (sticky), so
    /// re-declaring one costs nothing.
    fn sync_resources(&mut self, resources: &[SceneResource]) -> usize {
        let mut uploaded = 0;
        for res in resources {
            let h = content_hash(res);
            let id = res.id();
            if self.resources.get(id).map(|r| r.hash) != Some(h) {
                self.backend.ensure_resource(res);
                self.resources.insert(id.clone(), Resident { hash: h, desc: res.clone() });
                uploaded += 1;
            }
        }
        uploaded
    }

    /// Explicitly drop a resident resource (the app no longer needs it). Sticky
    /// residency means resources are never evicted automatically, so a host/app
    /// that churns through many one-shot images can release them by id.
    pub fn drop_resource(&mut self, id: &str) -> bool {
        if self.resources.remove(id).is_some() {
            self.backend.drop_resource(id);
            true
        } else {
            false
        }
    }
}

/// Fold a scene's identity into a hasher (the same content hash the skip uses),
/// exposed for hosts that key external state on the rendered scene.
pub fn scene_hash(scene: &Scene) -> u64 {
    let mut h = Xxh3::new();
    h.update(&content_hash(scene).to_le_bytes());
    h.digest()
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpa_protocol::{
        Affine, Brush, Color, FillRule, Frame, Path, Scene, SceneOp, SceneResource,
    };

    /// A no-op scene backend that records the work it was asked to do.
    #[derive(Default)]
    struct MockScene {
        resources_ensured: usize,
        resources_dropped: usize,
        scenes_begun: usize,
        ops: usize,
        raw_frames: usize,
        presents: usize,
        last_ops: Vec<String>,
    }
    impl SceneBackend for MockScene {
        fn ensure_resource(&mut self, _res: &SceneResource) {
            self.resources_ensured += 1;
        }
        fn drop_resource(&mut self, _id: &str) {
            self.resources_dropped += 1;
        }
        fn begin_scene(&mut self) {
            self.scenes_begun += 1;
            self.last_ops.clear();
        }
        fn encode_op(&mut self, op: &SceneOp) {
            self.ops += 1;
            let tag = match op {
                SceneOp::Fill { .. } => "fill",
                SceneOp::Stroke { .. } => "stroke",
                SceneOp::PushLayer { .. } => "pushLayer",
                SceneOp::PopLayer => "popLayer",
                SceneOp::DrawImage { .. } => "drawImage",
                SceneOp::DrawGlyphs { .. } => "drawGlyphs",
                SceneOp::RawWgpu { .. } => {
                    self.raw_frames += 1;
                    "rawWgpu"
                }
            };
            self.last_ops.push(tag.to_string());
        }
        fn present_scene(&mut self, _dirty: &[Rect]) {
            self.presents += 1;
        }
    }

    fn red_rect() -> SceneOp {
        SceneOp::Fill {
            fill: FillRule::NonZero,
            transform: Affine::IDENTITY,
            brush: Brush::Solid { color: Color::rgba(1.0, 0.0, 0.0, 1.0) },
            brush_transform: None,
            path: Path::Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 },
        }
    }

    fn font(data: &str) -> SceneResource {
        SceneResource::Font { id: "f".into(), data_b64: data.into() }
    }

    #[test]
    fn cold_scene_then_unchanged_is_free() {
        let mut r = SceneRenderer::new(MockScene::default());
        let scene = Scene { resources: vec![font("AA==")], ops: vec![red_rect()] };

        // Frame 1: upload the font, encode the op, present.
        let s = r.render(&scene);
        assert_eq!(s.resources_uploaded, 1);
        assert_eq!(s.ops_encoded, 1);
        assert!(s.presented && !s.cached);

        // Frame 2: identical scene -> no resource work, no encode, no present.
        let s = r.render(&scene);
        assert_eq!(s.resources_uploaded, 0);
        assert_eq!(s.ops_encoded, 0);
        assert!(s.cached, "an identical scene is served for free");
        assert!(!s.presented, "a cached scene must not present");
        assert_eq!(r.backend().scenes_begun, 1, "no second encode");
    }

    #[test]
    fn a_changed_op_re_encodes_and_presents() {
        let mut r = SceneRenderer::new(MockScene::default());
        r.render(&Scene { ops: vec![red_rect()], ..Default::default() });

        // Add a second op: the scene hash changes, so it re-encodes both ops.
        let s = r.render(&Scene { ops: vec![red_rect(), red_rect()], ..Default::default() });
        assert_eq!(s.ops_encoded, 2);
        assert!(s.presented && !s.cached);
    }

    #[test]
    fn raw_wgpu_op_is_encoded_and_counted() {
        let mut r = SceneRenderer::new(MockScene::default());
        let scene = Scene {
            ops: vec![red_rect(), SceneOp::RawWgpu { frame: Frame::default() }],
            ..Default::default()
        };
        let s = r.render(&scene);
        assert_eq!(s.ops_encoded, 2);
        assert_eq!(s.raw_frames, 1, "the raw wgpu op composited into the same scene");
        assert_eq!(r.backend().last_ops, vec!["fill", "rawWgpu"]);
    }

    #[test]
    fn changed_resource_re_uploads_only_itself() {
        let mut r = SceneRenderer::new(MockScene::default());
        r.render(&Scene { resources: vec![font("AA==")], ops: vec![red_rect()] });

        // Same id, new bytes -> re-upload the one resource.
        let s = r.render(&Scene { resources: vec![font("BB==")], ops: vec![red_rect()] });
        assert_eq!(s.resources_uploaded, 1);
        assert!(s.presented);
    }

    #[test]
    fn resources_are_sticky_across_frames() {
        let mut r = SceneRenderer::new(MockScene::default());
        // Frame 1 uploads the font once.
        let s = r.render(&Scene { resources: vec![font("AA==")], ops: vec![red_rect()] });
        assert_eq!(s.resources_uploaded, 1);
        // A later scene that omits the font keeps using the resident copy — it is
        // *not* dropped, and a different op still presents without re-uploading.
        let s = r.render(&Scene { ops: vec![red_rect(), red_rect()], ..Default::default() });
        assert_eq!(s.resources_uploaded, 0, "no re-upload");
        assert_eq!(s.resources_dropped, 0, "sticky: the font stays resident");
        assert_eq!(r.backend().resources_dropped, 0, "the backend was never asked to drop it");
        // It can still be released explicitly.
        assert!(r.drop_resource("f"));
        assert_eq!(r.backend().resources_dropped, 1);
    }

    #[test]
    fn invalidate_forces_a_re_present() {
        let mut r = SceneRenderer::new(MockScene::default());
        let scene = Scene { ops: vec![red_rect()], ..Default::default() };
        r.render(&scene);
        assert!(r.render(&scene).cached, "steady state is cached");
        // A resize-style invalidate forces the identical scene to re-present.
        r.invalidate();
        let s = r.render(&scene);
        assert!(s.presented && !s.cached);
    }
}
