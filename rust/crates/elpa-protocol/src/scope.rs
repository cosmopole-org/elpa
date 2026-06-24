//! **Scopes / rendering layers** — the decoupled, independently-cached half of a
//! frame.
//!
//! Where a [`Definition`](crate::Definition) names a *reusable* batch of drawing
//! work, a [`Layer`] names a *decoupled, snapshotted* one. A layer is a region of
//! the UI (a navigation drawer, an app bar, the scrolling body, an overlay) that
//! paints into its **own offscreen target texture** — its *snapshot* — instead of
//! drawing straight to the surface. The snapshot is reused frame after frame and
//! only repainted when the program explicitly invalidates the layer, so a static
//! region costs *nothing* to keep on screen no matter how complex it is, and an
//! animating region repaints in isolation without touching its neighbours.
//!
//! The pieces fit together exactly like definitions do, so the wire payload from
//! the VM stays tiny:
//!
//! * A program declares a layer once (the `scope.define` host call), giving its
//!   id, snapshot size/format, the resources it paints with and the encoder
//!   commands (render passes) that paint it. The host keeps it in a *layer store*.
//! * A submitted [`Frame`](crate::Frame) references a layer with an
//!   [`EncoderCommand::UseLayer`](crate::EncoderCommand::UseLayer). The host's
//!   layer store **expands** that reference: if the layer's snapshot is stale it
//!   splices the painting passes in (repainting the snapshot); if the snapshot is
//!   still valid it splices *nothing* — the resident snapshot texture stands in,
//!   and the VM never re-ran the layer's drawing logic at all.
//! * The program then composites the layers into the final image by sampling
//!   their snapshot textures (each layer's [`Layer::texture_id`]) in a surface
//!   pass, blending them in z-order.
//!
//! Invalidation is **explicit**: a snapshot stays valid until the program calls
//! `scope.invalidate`, so the program — not a content heuristic — decides when a
//! layer repaints. This is what makes a drawer slide open while the body behind
//! it is never re-rendered, or the body scroll while the chrome around it holds
//! its snapshot.

use serde::{Deserialize, Serialize};

use crate::command::EncoderCommand;
use crate::geometry::{Color, Extent3d};
use crate::resource::{BufferDesc, ResourceDesc, TextureDesc};

/// The default snapshot texture format for a layer (matches the swapchain format
/// the Material kit and the examples present with).
pub fn default_layer_format() -> String {
    "bgra8unorm".into()
}

/// Serde default for the scale components of a [`LayerTransform`] (no scaling).
fn one() -> f32 {
    1.0
}

/// A cheap **affine placement + opacity** for compositing a layer's resident
/// snapshot: a translation (physical px) and a per-axis scale, applied where the
/// program samples the snapshot to draw it.
///
/// This is the primitive that makes *motion free*. Sliding a navigation drawer,
/// fading a scrim, or running a page transition does not change a single pixel of
/// what a layer *contains* — only *where* and *how opaquely* its snapshot is
/// drawn. Carrying the placement on the [`UseLayer`](crate::EncoderCommand::UseLayer)
/// reference lets the host write it into the layer's small **transform uniform**
/// ([`layer_xform_id`]) each frame, so the snapshot moves with **no repaint, no
/// re-rasterization, and no geometry re-emit** — the program's composite pass
/// reads the uniform and places the same cached texture at the new spot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LayerTransform {
    /// Horizontal translation in physical pixels.
    #[serde(default)]
    pub tx: f32,
    /// Vertical translation in physical pixels.
    #[serde(default)]
    pub ty: f32,
    /// Horizontal scale (1.0 = unscaled).
    #[serde(default = "one")]
    pub sx: f32,
    /// Vertical scale (1.0 = unscaled).
    #[serde(default = "one")]
    pub sy: f32,
}

impl Default for LayerTransform {
    fn default() -> Self {
        Self { tx: 0.0, ty: 0.0, sx: 1.0, sy: 1.0 }
    }
}

impl LayerTransform {
    /// The neutral placement: no translation, unit scale.
    pub fn identity() -> Self {
        Self::default()
    }

    /// A pure translation (physical px), unit scale.
    pub fn translate(tx: f32, ty: f32) -> Self {
        Self { tx, ty, sx: 1.0, sy: 1.0 }
    }

    /// The std140-friendly uniform payload the composite pass binds: the
    /// translation, the scale, and `opacity`, padded to a 32-byte (`vec4`-aligned)
    /// block: `[tx, ty, sx, sy, opacity, 0, 0, 0]`.
    pub fn uniform_words(&self, opacity: f32) -> [f32; 8] {
        [self.tx, self.ty, self.sx, self.sy, opacity, 0.0, 0.0, 0.0]
    }
}

/// The conventional id of a layer's **composite transform uniform** — the small
/// (32-byte) buffer the host refills each frame with the layer's
/// [`LayerTransform`] + opacity so the program's compositing pass can place and
/// fade the resident snapshot without re-emitting any geometry. Declared (kept
/// resident, refilled in place) only on frames whose `useLayer` carries a
/// transform or opacity, so a layer used at its identity placement costs nothing
/// extra.
pub fn layer_xform_id(layer_id: &str) -> String {
    format!("elpa.layer.{layer_id}.xform")
}

/// Build the resident transform-uniform [`ResourceDesc`] for a layer from its
/// per-frame [`LayerTransform`] + opacity. `UNIFORM | COPY_DST` so the renderer's
/// resource cache refills the same GPU allocation in place each frame (a queue
/// write) — moving/fading the snapshot is a 32-byte upload, not a re-record.
pub fn layer_xform_buffer(layer_id: &str, transform: &LayerTransform, opacity: f32) -> ResourceDesc {
    ResourceDesc::Buffer(BufferDesc {
        id: layer_xform_id(layer_id),
        size: 32,
        usage: vec!["UNIFORM".into(), "COPY_DST".into()],
        data_f32: Some(transform.uniform_words(opacity).to_vec()),
        ..Default::default()
    })
}

/// The conventional id of a layer's backing **snapshot texture** — the offscreen
/// target a layer paints into and the program samples to composite. Derived from
/// the layer id so both the painting passes and the compositing pass can name it
/// without threading an extra field around.
pub fn layer_texture_id(layer_id: &str) -> String {
    format!("elpa.layer.{layer_id}.tex")
}

/// The conventional id of a layer's **paint pass** — the cacheable offscreen
/// render pass that draws the layer into its snapshot texture. Registered with
/// the renderer so the snapshot can be reused or force-repainted by id.
pub fn layer_paint_pass_id(layer_id: &str) -> String {
    format!("elpa.layer.{layer_id}.paint")
}

/// A declared **scope / rendering layer**: a named, independently-cached
/// offscreen target whose painted result is snapshotted and reused until the
/// program invalidates it.
///
/// JSON mirrors [`Definition`](crate::Definition): `id` + snapshot geometry +
/// the `resources`/`commands` that paint it.
/// ```json
/// {"id":"drawer","width":1080,"height":2340,"format":"bgra8unorm",
///  "resources":[ … instance buffer … ],
///  "commands":[ {"op":"renderPass","id":"elpa.layer.drawer.paint", … } ]}
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    /// Stable name the program references in `useLayer` and the store keys on.
    pub id: String,
    /// Snapshot texture width in physical pixels.
    pub width: u32,
    /// Snapshot texture height in physical pixels.
    pub height: u32,
    /// Snapshot texture format (defaults to [`default_layer_format`]).
    #[serde(default = "default_layer_format")]
    pub format: String,
    /// Optional clear colour recorded into the snapshot when nothing else is
    /// declared by the painting passes (informational; the painting passes own
    /// their own attachment loads). Defaults to fully transparent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_color: Option<Color>,
    /// Resources the painting passes need (instance buffers, etc.). Merged into
    /// the frame's resource set **only while the layer is repainting**, so a
    /// reused snapshot carries no per-frame resource cost.
    #[serde(default)]
    pub resources: Vec<ResourceDesc>,
    /// The painting commands — encoder-level passes that render *into* this
    /// layer's snapshot texture. Run only when the layer is (re)painted.
    #[serde(default)]
    pub commands: Vec<EncoderCommand>,
}

impl Layer {
    /// The id of this layer's backing snapshot texture.
    pub fn texture_id(&self) -> String {
        layer_texture_id(&self.id)
    }

    /// The id of this layer's paint pass (the cacheable offscreen render pass).
    pub fn paint_pass_id(&self) -> String {
        layer_paint_pass_id(&self.id)
    }

    /// The backing snapshot [`TextureDesc`]: a render target the layer paints
    /// into (`RENDER_ATTACHMENT`) and the program samples to composite
    /// (`TEXTURE_BINDING`), also copyable (`COPY_SRC`) for read-back. Declared in
    /// every frame that uses the layer so the resident snapshot is never evicted,
    /// even on frames where the layer is not repainted.
    pub fn texture_desc(&self) -> ResourceDesc {
        ResourceDesc::Texture(TextureDesc {
            id: self.texture_id(),
            size: Extent3d { width: self.width.max(1), height: self.height.max(1), depth: 1 },
            format: self.format.clone(),
            usage: vec![
                "RENDER_ATTACHMENT".into(),
                "TEXTURE_BINDING".into(),
                "COPY_SRC".into(),
            ],
            mip_level_count: 1,
            sample_count: 1,
            dimension: "2d".into(),
        })
    }

    pub fn parse(json: &str) -> Result<Layer, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_roundtrips_and_derives_ids() {
        let json = r#"{
          "id":"drawer","width":1080,"height":2340,
          "resources":[{"kind":"buffer","id":"drawerInst","size":64,"usage":["VERTEX","COPY_DST"]}],
          "commands":[{"op":"renderPass","id":"elpa.layer.drawer.paint",
            "color_attachments":[{"view":{"kind":"texture","texture":"elpa.layer.drawer.tex"}}],
            "commands":[{"cmd":"draw","vertex_count":6}]}]
        }"#;
        let l = Layer::parse(json).unwrap();
        assert_eq!(l.id, "drawer");
        assert_eq!(l.format, default_layer_format(), "format defaulted");
        assert_eq!(l.texture_id(), "elpa.layer.drawer.tex");
        assert_eq!(l.paint_pass_id(), "elpa.layer.drawer.paint");
        assert_eq!(l.resources.len(), 1);
        let back = serde_json::to_string(&l).unwrap();
        assert_eq!(Layer::parse(&back).unwrap(), l);
    }

    #[test]
    fn texture_desc_is_a_sampleable_render_target() {
        let l = Layer { id: "body".into(), width: 800, height: 600, format: default_layer_format(),
            clear_color: None, resources: vec![], commands: vec![] };
        match l.texture_desc() {
            ResourceDesc::Texture(t) => {
                assert_eq!(t.id, "elpa.layer.body.tex");
                assert_eq!((t.size.width, t.size.height), (800, 600));
                assert!(t.usage.contains(&"RENDER_ATTACHMENT".to_string()));
                assert!(t.usage.contains(&"TEXTURE_BINDING".to_string()));
            }
            _ => panic!("expected texture"),
        }
    }

    #[test]
    fn transform_defaults_to_identity_and_packs_a_vec4_aligned_uniform() {
        // Missing scale fields default to 1.0; the packed uniform is 8 words
        // (32 bytes) with opacity in slot 4 and the tail padded.
        let t: LayerTransform = serde_json::from_str(r#"{"tx":12.0,"ty":-4.0}"#).unwrap();
        assert_eq!((t.sx, t.sy), (1.0, 1.0), "scale defaults to unit");
        assert_eq!(t.uniform_words(0.5), [12.0, -4.0, 1.0, 1.0, 0.5, 0.0, 0.0, 0.0]);
        assert_eq!(LayerTransform::identity(), LayerTransform::default());
        assert_eq!(LayerTransform::translate(3.0, 7.0), LayerTransform { tx: 3.0, ty: 7.0, sx: 1.0, sy: 1.0 });
    }

    #[test]
    fn xform_buffer_is_an_in_place_refillable_uniform() {
        match layer_xform_buffer("drawer", &LayerTransform::translate(20.0, 0.0), 1.0) {
            ResourceDesc::Buffer(b) => {
                assert_eq!(b.id, "elpa.layer.drawer.xform");
                assert_eq!(b.size, 32);
                assert!(b.usage.contains(&"UNIFORM".to_string()));
                assert!(b.usage.contains(&"COPY_DST".to_string()), "refilled in place");
                assert_eq!(b.data_f32.unwrap(), vec![20.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
            }
            _ => panic!("expected a buffer"),
        }
    }

    #[test]
    fn use_layer_transform_roundtrips_and_stays_absent_by_default() {
        use crate::command::EncoderCommand;
        // No transform/opacity: the fields are omitted from the wire form, so
        // existing frames serialize byte-for-byte as before.
        let plain = EncoderCommand::UseLayer { layer: "body".into(), transform: None, opacity: None };
        let js = serde_json::to_string(&plain).unwrap();
        assert!(!js.contains("transform") && !js.contains("opacity"), "absent by default: {js}");
        assert_eq!(serde_json::from_str::<EncoderCommand>(&js).unwrap(), plain);

        let placed = EncoderCommand::UseLayer {
            layer: "drawer".into(),
            transform: Some(LayerTransform::translate(64.0, 0.0)),
            opacity: Some(0.8),
        };
        let back: EncoderCommand = serde_json::from_str(&serde_json::to_string(&placed).unwrap()).unwrap();
        assert_eq!(back, placed);
    }

    #[test]
    fn zero_size_is_clamped_to_one() {
        let l = Layer { id: "x".into(), width: 0, height: 0, format: default_layer_format(),
            clear_color: None, resources: vec![], commands: vec![] };
        match l.texture_desc() {
            ResourceDesc::Texture(t) => assert_eq!((t.size.width, t.size.height), (1, 1)),
            _ => unreachable!(),
        }
    }
}
