//! The **vello scene** — Elpa's abstract drawing vocabulary.
//!
//! Where [`command`](crate::command) mirrors `wgpu` one-to-one, this module
//! mirrors [Vello](https://github.com/linebender/vello): a [`Scene`] is an
//! ordered batch of high-level vector-graphics [`SceneOp`]s — fills, strokes,
//! clip/blend layers, gradients, images and glyph runs — that the VM streams to
//! the host, which encodes them into a `vello::Scene` and rasterizes them on the
//! GPU. This is the *primary* drawing path; it sits one level of abstraction
//! above the raw command tree.
//!
//! Crucially, the raw wgpu command tree is **not** discarded — it becomes a
//! single operation, [`SceneOp::RawWgpu`], so a program can splice an arbitrary
//! wgpu render/compute batch into the very same target the vector ops draw into
//! (a custom shader, a 3D scene, a compute effect). Direct wgpu usage is thus a
//! *subset* of the scene vocabulary, composited by the same renderer.
//!
//! Like resources in the command tree, scene-level [`SceneResource`]s (images and
//! fonts) are keyed by [`ResourceId`] so the host uploads each one once and the
//! per-frame `Scene` references it by id.

use serde::{Deserialize, Serialize};

use crate::command::Frame;
use crate::geometry::Color;
use crate::resource::ResourceId;

/// A 2D affine transform in column-major order `[a, b, c, d, e, f]`, mapping a
/// point `(x, y)` to `(a·x + c·y + e, b·x + d·y + f)` — exactly Vello/kurbo's
/// `Affine`. The default is the identity.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Affine(pub [f64; 6]);

impl Default for Affine {
    fn default() -> Self {
        Affine::IDENTITY
    }
}

impl Affine {
    pub const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub const fn translate(x: f64, y: f64) -> Affine {
        Affine([1.0, 0.0, 0.0, 1.0, x, y])
    }
    pub const fn scale(sx: f64, sy: f64) -> Affine {
        Affine([sx, 0.0, 0.0, sy, 0.0, 0.0])
    }
    pub fn rotate(theta: f64) -> Affine {
        let (s, c) = theta.sin_cos();
        Affine([c, s, -s, c, 0.0, 0.0])
    }

    /// The composition `self ∘ other` — apply `other` first, then `self`. Matches
    /// kurbo's `Affine * Affine`, so the host can pass it straight through.
    pub fn then(self, other: Affine) -> Affine {
        let a = self.0;
        let b = other.0;
        Affine([
            b[0] * a[0] + b[1] * a[2],
            b[0] * a[1] + b[1] * a[3],
            b[2] * a[0] + b[3] * a[2],
            b[2] * a[1] + b[3] * a[3],
            b[4] * a[0] + b[5] * a[2] + a[4],
            b[4] * a[1] + b[5] * a[3] + a[5],
        ])
    }
}

/// The fill rule used to decide a path's interior (Vello's `peniko::Fill`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FillRule {
    #[default]
    NonZero,
    EvenOdd,
}

/// One element of a freeform path (mirrors kurbo's `PathEl`). Coordinates are in
/// the op's local space; the op's `transform` maps them to the surface.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "el", rename_all = "camelCase")]
pub enum PathEl {
    MoveTo { x: f64, y: f64 },
    LineTo { x: f64, y: f64 },
    /// Quadratic Bézier with control point `(cx, cy)` to `(x, y)`.
    QuadTo { cx: f64, cy: f64, x: f64, y: f64 },
    /// Cubic Bézier with control points `(c1x, c1y)`, `(c2x, c2y)` to `(x, y)`.
    CurveTo { c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64 },
    ClosePath,
}

/// A shape to fill, stroke or clip with. Convenience primitives (rect, rounded
/// rect, circle, …) avoid forcing the VM to emit Bézier elements for the common
/// UI cases; `Elements` is the general escape hatch. Each maps to a kurbo shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum Path {
    /// A freeform path built from path elements.
    Elements { els: Vec<PathEl> },
    Rect { x: f64, y: f64, w: f64, h: f64 },
    /// A rounded rectangle. `radius` is the uniform corner radius unless the
    /// per-corner radii are given (top-left, top-right, bottom-right, bottom-left).
    RoundRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(default)]
        radius: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        radii: Option<[f64; 4]>,
    },
    Circle { cx: f64, cy: f64, r: f64 },
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
    Line { x0: f64, y0: f64, x1: f64, y1: f64 },
}

/// How a gradient/image brush extends past its defined range (Vello `Extend`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Extend {
    #[default]
    Pad,
    Repeat,
    Reflect,
}

/// One color stop of a gradient: `offset` in `[0, 1]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ColorStop {
    pub offset: f32,
    pub color: Color,
}

/// The geometry of a gradient (Vello's `Gradient` kinds).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GradientKind {
    /// A linear gradient from `(x0, y0)` to `(x1, y1)`.
    Linear { x0: f64, y0: f64, x1: f64, y1: f64 },
    /// A radial gradient. With only `(cx, cy, r)` it is a simple radial; the
    /// optional focal point `(fx, fy)` / `fr` makes it a two-circle gradient.
    Radial {
        cx: f64,
        cy: f64,
        r: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fx: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fy: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fr: Option<f64>,
    },
    /// A sweep (conic) gradient centred at `(cx, cy)`, sweeping `start`→`end`
    /// radians.
    Sweep { cx: f64, cy: f64, start_angle: f32, end_angle: f32 },
}

/// A gradient brush: its geometry, its color stops, and how it extends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gradient {
    #[serde(flatten)]
    pub kind: GradientKind,
    pub stops: Vec<ColorStop>,
    #[serde(default)]
    pub extend: Extend,
}

/// What a fill/stroke paints with (Vello's `peniko::Brush`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "brush", rename_all = "camelCase")]
pub enum Brush {
    /// A flat color.
    Solid { color: Color },
    /// A gradient.
    Gradient { gradient: Gradient },
    /// A scene-level image resource, tiled per its `extend`.
    Image {
        image: ResourceId,
        #[serde(default = "one_f32")]
        alpha: f32,
        #[serde(default)]
        extend: Extend,
    },
}

impl Brush {
    /// The image resource id this brush samples, if any (for resource liveness).
    pub fn image_ref(&self) -> Option<&ResourceId> {
        match self {
            Brush::Image { image, .. } => Some(image),
            _ => None,
        }
    }
}

/// The join applied where two stroke segments meet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Join {
    #[default]
    Miter,
    Round,
    Bevel,
}

/// The cap applied at the ends of an open stroke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Cap {
    #[default]
    Butt,
    Round,
    Square,
}

/// A stroke style (Vello/kurbo `Stroke`): width, join/cap, miter limit, dashes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrokeStyle {
    pub width: f64,
    #[serde(default)]
    pub join: Join,
    #[serde(default)]
    pub cap: Cap,
    #[serde(default = "miter_default")]
    pub miter_limit: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dashes: Vec<f64>,
    #[serde(default)]
    pub dash_offset: f64,
}

impl StrokeStyle {
    pub fn new(width: f64) -> Self {
        Self {
            width,
            join: Join::default(),
            cap: Cap::default(),
            miter_limit: miter_default(),
            dashes: Vec::new(),
            dash_offset: 0.0,
        }
    }
}

/// The blend mode for a pushed layer (Vello `peniko::BlendMode`): a separable
/// mix plus a Porter-Duff compose. The string tokens match peniko's `Mix` /
/// `Compose` variant names lower-cased, so the backend maps them directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlendMode {
    #[serde(default = "mix_default")]
    pub mix: Mix,
    #[serde(default = "compose_default")]
    pub compose: Compose,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode { mix: Mix::Normal, compose: Compose::SrcOver }
    }
}

/// Separable blend mix modes (Vello `peniko::Mix`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Mix {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    /// Vello's special "clip" mix — the layer clips but does not blend.
    Clip,
}

/// Porter-Duff compositing operators (Vello `peniko::Compose`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Compose {
    Clear,
    Copy,
    Dest,
    #[default]
    SrcOver,
    DestOver,
    SrcIn,
    DestIn,
    SrcOut,
    DestOut,
    SrcAtop,
    DestAtop,
    Xor,
    Plus,
}

/// A single positioned glyph within a [`GlyphRun`]: `id` is the font's glyph
/// index; `(x, y)` is its pen position in the run's local space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Glyph {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

/// A run of glyphs from one font at one size, painted with one brush (Vello's
/// `Scene::draw_glyphs`). Text shaping happens in the SDK; the host only
/// rasterizes the already-positioned glyph indices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlyphRun {
    /// A scene-level [`SceneResource::Font`] id.
    pub font: ResourceId,
    pub font_size: f32,
    #[serde(default = "btrue")]
    pub hint: bool,
    pub brush: Brush,
    pub glyphs: Vec<Glyph>,
}

/// One drawing operation in a [`Scene`] (a `vello::Scene` call), tagged by `op`.
///
/// The first operations mirror Vello's drawing API; [`SceneOp::RawWgpu`] is the
/// escape hatch that splices a whole raw wgpu [`Frame`] into the same target, so
/// a custom shader / 3D pass / compute effect composites with the vector content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SceneOp {
    /// Fill a shape with a brush. `transform` maps the shape to the surface;
    /// `brush_transform` optionally transforms the brush independently.
    Fill {
        #[serde(default)]
        fill: FillRule,
        #[serde(default)]
        transform: Affine,
        brush: Brush,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brush_transform: Option<Affine>,
        path: Path,
    },
    /// Stroke a shape's outline with a brush.
    Stroke {
        style: StrokeStyle,
        #[serde(default)]
        transform: Affine,
        brush: Brush,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brush_transform: Option<Affine>,
        path: Path,
    },
    /// Push a clip + blend layer. Subsequent ops draw clipped to `clip` and are
    /// composited back at `alpha` with `blend` on the matching [`SceneOp::PopLayer`].
    PushLayer {
        #[serde(default)]
        blend: BlendMode,
        #[serde(default = "one_f32")]
        alpha: f32,
        #[serde(default)]
        transform: Affine,
        clip: Path,
    },
    /// Pop the most recently pushed layer.
    PopLayer,
    /// Blit a scene-level image at `transform`.
    DrawImage {
        image: ResourceId,
        #[serde(default)]
        transform: Affine,
        #[serde(default = "one_f32")]
        alpha: f32,
    },
    /// Draw a run of positioned glyphs.
    DrawGlyphs {
        #[serde(default)]
        transform: Affine,
        run: GlyphRun,
    },
    /// Splice a raw wgpu [`Frame`] into the same target (the wgpu path as a
    /// subset op). The host renders it with the wgpu renderer, compositing it
    /// with the surrounding vector content.
    RawWgpu { frame: Frame },
}

/// A scene-level resource the ops reference by id: an image or a font. The host
/// uploads each once and caches it across frames (mirrors the command tree's
/// resource cache, at the scene level).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SceneResource {
    /// A decoded RGBA8 (premultiplied straight per `format`) image.
    Image {
        id: ResourceId,
        width: u32,
        height: u32,
        /// `rgba8` (the default/only format for now).
        #[serde(default = "rgba8")]
        format: String,
        /// Base64-encoded pixel bytes, row-major, 4 bytes/pixel.
        data_b64: String,
    },
    /// A font file (TTF/OTF) the glyph runs index into.
    Font { id: ResourceId, data_b64: String },
}

impl SceneResource {
    pub fn id(&self) -> &ResourceId {
        match self {
            SceneResource::Image { id, .. } | SceneResource::Font { id, .. } => id,
        }
    }
}

/// One frame's worth of vector drawing: the scene-level resources it references
/// plus the ordered list of operations. This is exactly what the VM streams via
/// `scene.submit`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default)]
    pub resources: Vec<SceneResource>,
    #[serde(default)]
    pub ops: Vec<SceneOp>,
}

impl Scene {
    pub fn parse(json: &str) -> Result<Scene, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// The scene-level resource ids referenced by the ops (image brushes, drawn
    /// images, glyph-run fonts) — for resource-cache liveness.
    pub fn referenced_resources(&self) -> Vec<ResourceId> {
        let mut ids = Vec::new();
        for op in &self.ops {
            match op {
                SceneOp::Fill { brush, .. } | SceneOp::Stroke { brush, .. } => {
                    if let Some(img) = brush.image_ref() {
                        ids.push(img.clone());
                    }
                }
                SceneOp::DrawImage { image, .. } => ids.push(image.clone()),
                SceneOp::DrawGlyphs { run, .. } => {
                    ids.push(run.font.clone());
                    if let Some(img) = run.brush.image_ref() {
                        ids.push(img.clone());
                    }
                }
                _ => {}
            }
        }
        ids
    }

    /// The raw wgpu frames embedded in this scene (the [`SceneOp::RawWgpu`] ops),
    /// in order — what the wgpu renderer composites into the same target.
    pub fn raw_frames(&self) -> impl Iterator<Item = &Frame> {
        self.ops.iter().filter_map(|op| match op {
            SceneOp::RawWgpu { frame } => Some(frame),
            _ => None,
        })
    }

    /// Whether the scene draws any vector (vello) content, vs. being only raw
    /// wgpu ops. Lets a host fast-path a pure-wgpu scene through the wgpu renderer.
    pub fn has_vector_ops(&self) -> bool {
        self.ops.iter().any(|op| !matches!(op, SceneOp::RawWgpu { .. }))
    }
}

fn one_f32() -> f32 {
    1.0
}
fn btrue() -> bool {
    true
}
fn miter_default() -> f64 {
    4.0
}
fn rgba8() -> String {
    "rgba8".into()
}
fn mix_default() -> Mix {
    Mix::Normal
}
fn compose_default() -> Compose {
    Compose::SrcOver
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCENE: &str = r#"{
      "resources": [
        {"kind":"font","id":"roboto","data_b64":"AA=="}
      ],
      "ops": [
        {"op":"fill","brush":{"brush":"solid","color":{"r":1,"g":0,"b":0,"a":1}},
         "path":{"shape":"roundRect","x":10,"y":10,"w":100,"h":40,"radius":8}},
        {"op":"pushLayer","clip":{"shape":"rect","x":0,"y":0,"w":50,"h":50}},
        {"op":"stroke","style":{"width":2.0},
         "brush":{"brush":"gradient","gradient":{"type":"linear","x0":0,"y0":0,"x1":50,"y1":0,
           "stops":[{"offset":0,"color":{"r":0,"g":0,"b":0,"a":1}},
                    {"offset":1,"color":{"r":1,"g":1,"b":1,"a":1}}]}},
         "path":{"shape":"line","x0":0,"y0":0,"x1":50,"y1":50}},
        {"op":"popLayer"},
        {"op":"drawGlyphs","run":{"font":"roboto","font_size":14.0,
           "brush":{"brush":"solid","color":{"r":0,"g":0,"b":0,"a":1}},
           "glyphs":[{"id":42,"x":0,"y":12}]}},
        {"op":"rawWgpu","frame":{"commands":[
           {"op":"renderPass","color_attachments":[{"view":{"kind":"surface"}}],
            "commands":[{"cmd":"draw","vertex_count":3}]}]}}
      ]
    }"#;

    #[test]
    fn parses_a_full_scene() {
        let s = Scene::parse(SCENE).unwrap();
        assert_eq!(s.resources.len(), 1);
        assert_eq!(s.ops.len(), 6);
        assert!(s.has_vector_ops());
        // The font is referenced; the raw frame is exposed for the wgpu path.
        assert!(s.referenced_resources().contains(&"roboto".to_string()));
        assert_eq!(s.raw_frames().count(), 1);
    }

    #[test]
    fn round_trips_through_serde() {
        let s = Scene::parse(SCENE).unwrap();
        let json = serde_json::to_string(&s).unwrap();
        let again = Scene::parse(&json).unwrap();
        assert_eq!(s, again);
    }

    #[test]
    fn raw_wgpu_is_a_first_class_op() {
        // A scene that is *only* a raw wgpu frame: the existing command tree as a
        // subset operation. The host can fast-path this through the wgpu renderer.
        let json = r#"{"ops":[{"op":"rawWgpu","frame":{"commands":[]}}]}"#;
        let s = Scene::parse(json).unwrap();
        assert!(!s.has_vector_ops(), "pure-wgpu scene has no vector ops");
        assert_eq!(s.raw_frames().count(), 1);
    }

    #[test]
    fn affine_compose_matches_translate_then_scale() {
        // scale(2) ∘ translate(10,0): translate first, then scale → (2*(x+10), 2y).
        let m = Affine::scale(2.0, 2.0).then(Affine::translate(10.0, 0.0));
        let [a, b, c, d, e, f] = m.0;
        assert_eq!((a, b, c, d, e, f), (2.0, 0.0, 0.0, 2.0, 20.0, 0.0));
    }
}
