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
use crate::resource::{ResourceDesc, TextureDesc};

/// The default snapshot texture format for a layer (matches the swapchain format
/// the Material kit and the examples present with).
pub fn default_layer_format() -> String {
    "bgra8unorm".into()
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
    fn zero_size_is_clamped_to_one() {
        let l = Layer { id: "x".into(), width: 0, height: 0, format: default_layer_format(),
            clear_color: None, resources: vec![], commands: vec![] };
        match l.texture_desc() {
            ResourceDesc::Texture(t) => assert_eq!((t.size.width, t.size.height), (1, 1)),
            _ => unreachable!(),
        }
    }
}
