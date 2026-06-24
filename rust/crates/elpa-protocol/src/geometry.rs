//! Small geometric/value types used directly by wgpu commands: scissor &
//! viewport rectangles, clear colors, and texture extents. These are *not* a
//! drawing abstraction — they are the operands of raw wgpu calls.

use serde::{Deserialize, Serialize};

/// An axis-aligned integer rectangle in physical pixels — the operand of
/// `set_scissor_rect` / `set_viewport` and the unit of dirty-region tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub const fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }
    pub fn right(&self) -> u32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> u32 {
        self.y + self.h
    }
    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// Smallest rect containing both — accumulates a frame's dirty region.
    pub fn union(&self, other: &Rect) -> Rect {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Rect::new(x, y, right - x, bottom - y)
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }
}

/// Straight-alpha RGBA clear color, components in `[0, 1]` (a `wgpu::Color`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Color {
    pub const TRANSPARENT: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };
    pub const BLACK: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
    pub const fn rgba(r: f64, g: f64, b: f64, a: f64) -> Self {
        Self { r, g, b, a }
    }
}

/// A 3D texture extent (`wgpu::Extent3d`); 2D textures set `depth = 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extent3d {
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub depth: u32,
}
fn one() -> u32 {
    1
}

/// A 3D texel offset (`wgpu::Origin3d`) for copies/writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Origin3d {
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(default)]
    pub z: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_union_and_intersect() {
        let a = Rect::new(0, 0, 10, 10);
        let b = Rect::new(5, 5, 10, 10);
        assert_eq!(a.union(&b), Rect::new(0, 0, 15, 15));
        assert!(a.intersects(&b));
        assert!(!a.intersects(&Rect::new(100, 100, 1, 1)));
    }
}
