//! The flat, renderer-ready draw-command list.
//!
//! After layout, the UI tree (or a `canvas.*` op stream) is *lowered* into a
//! [`DrawList`]: a linear sequence of [`DrawCommand`]s, each tagged with the
//! [`LayerId`] it belongs to and a bounding [`Rect`]. This flat form is what the
//! drawing-management layer caches, content-hashes, diffs, and replays — and
//! what the wgpu backend batches into draw calls.

use serde::{Deserialize, Serialize};

use crate::geometry::{Color, Point, Rect, Transform};

/// Identifies a compositing layer. Layers are the unit of caching: a layer
/// whose content hash is unchanged is re-used as a cached GPU texture instead of
/// being re-rasterized. See `PLAN.md` §"Layer & Caching Model".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LayerId(pub u64);

/// How a shape is painted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Paint {
    Solid(Color),
    /// Indices into the draw list's gradient table (kept out-of-band so the
    /// command stays small and `Copy`-friendly where possible).
    LinearGradient(u32),
    RadialGradient(u32),
}

/// A single drawing primitive. This is intentionally a small, closed set: the
/// large `canvas.*` / widget vocabulary is *reduced* to these primitives during
/// lowering so the GPU backend only implements a handful of pipelines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Primitive {
    /// Filled (optionally rounded) rectangle.
    Rect { rect: Rect, radius: f32, paint: Paint },
    /// Stroked rectangle outline.
    RectStroke { rect: Rect, radius: f32, width: f32, paint: Paint },
    /// A run of shaped text. `glyphs` is resolved against the glyph atlas by the
    /// renderer; `text` is retained for hashing & accessibility.
    Text { origin: Point, text: String, size: f32, paint: Paint },
    /// A textured quad (decoded image / sub-rect of an atlas).
    Image { rect: Rect, image_id: u64, src: Rect },
    /// A filled polygon / tessellated path (vertices already flattened).
    Path { points: Vec<Point>, paint: Paint },
    /// Push a clip rectangle (intersected with the current clip).
    PushClip { rect: Rect },
    /// Pop the most recent clip.
    PopClip,
}

/// One entry in the draw list: a primitive plus the state needed to place,
/// cache, and partially-replay it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrawCommand {
    /// Compositing layer this command belongs to.
    pub layer: LayerId,
    /// World-space bounds (post-transform) used for dirty-rect culling.
    pub bounds: Rect,
    /// Affine transform applied to the primitive's local coordinates.
    pub transform: Transform,
    /// Global alpha multiplier in `[0, 1]`.
    pub opacity: f32,
    /// The primitive to draw.
    pub prim: Primitive,
}

impl DrawCommand {
    pub fn new(layer: LayerId, bounds: Rect, prim: Primitive) -> Self {
        Self { layer, bounds, transform: Transform::IDENTITY, opacity: 1.0, prim }
    }
}

/// An ordered list of draw commands for one frame, partitioned implicitly by
/// each command's [`LayerId`]. The renderer walks it in order, honoring clips.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DrawList {
    pub commands: Vec<DrawCommand>,
}

impl DrawList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, cmd: DrawCommand) {
        self.commands.push(cmd);
    }

    /// Union of the bounds of every command touching `layer` — i.e. that
    /// layer's content extent, used when allocating its cache texture.
    pub fn layer_bounds(&self, layer: LayerId) -> Rect {
        self.commands
            .iter()
            .filter(|c| c.layer == layer)
            .fold(Rect::default(), |acc, c| acc.union(&c.bounds))
    }

    /// All commands whose bounds intersect `dirty` — the subset that must be
    /// re-recorded during a partial-rendering pass.
    pub fn commands_in(&self, dirty: Rect) -> impl Iterator<Item = &DrawCommand> {
        self.commands.iter().filter(move |c| c.bounds.intersects(&dirty))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_bounds_and_dirty_filter() {
        let mut dl = DrawList::new();
        dl.push(DrawCommand::new(
            LayerId(0),
            Rect::new(0.0, 0.0, 10.0, 10.0),
            Primitive::Rect { rect: Rect::new(0.0, 0.0, 10.0, 10.0), radius: 0.0, paint: Paint::Solid(Color::WHITE) },
        ));
        dl.push(DrawCommand::new(
            LayerId(0),
            Rect::new(100.0, 100.0, 10.0, 10.0),
            Primitive::PopClip,
        ));
        assert_eq!(dl.layer_bounds(LayerId(0)), Rect::new(0.0, 0.0, 110.0, 110.0));
        let hits: Vec<_> = dl.commands_in(Rect::new(0.0, 0.0, 20.0, 20.0)).collect();
        assert_eq!(hits.len(), 1);
    }
}
