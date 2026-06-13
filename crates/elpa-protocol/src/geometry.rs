//! Geometry & paint primitives shared by the UI tree and the draw list.

use serde::{Deserialize, Serialize};

/// A 2D point in logical (pre-DPI-scale) pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// An axis-aligned rectangle in logical pixels. The single most important type
/// for partial rendering: dirty regions, layer bounds, and clip rects are all
/// `Rect`s.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    pub fn is_empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    /// Smallest rect containing both `self` and `other`. Used to accumulate the
    /// per-frame dirty region from many individual changed-node bounds.
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

    /// Overlap of two rects, or an empty rect if they do not intersect. Used to
    /// clip draw commands to the dirty region during partial replay.
    pub fn intersect(&self, other: &Rect) -> Rect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= x || bottom <= y {
            Rect::default()
        } else {
            Rect::new(x, y, right - x, bottom - y)
        }
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x < self.right() && p.y >= self.y && p.y < self.bottom()
    }
}

/// Straight-alpha RGBA color, components in `[0, 1]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const TRANSPARENT: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };
    pub const WHITE: Color = Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
    pub const BLACK: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };

    pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    /// Parse a CSS-style hex color: `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`.
    pub fn from_hex(s: &str) -> Option<Color> {
        let h = s.strip_prefix('#')?;
        let parse = |chunk: &str| u8::from_str_radix(chunk, 16).ok();
        let (r, g, b, a) = match h.len() {
            3 => (
                parse(&h[0..1].repeat(2))?,
                parse(&h[1..2].repeat(2))?,
                parse(&h[2..3].repeat(2))?,
                255,
            ),
            4 => (
                parse(&h[0..1].repeat(2))?,
                parse(&h[1..2].repeat(2))?,
                parse(&h[2..3].repeat(2))?,
                parse(&h[3..4].repeat(2))?,
            ),
            6 => (parse(&h[0..2])?, parse(&h[2..4])?, parse(&h[4..6])?, 255),
            8 => (parse(&h[0..2])?, parse(&h[2..4])?, parse(&h[4..6])?, parse(&h[6..8])?),
            _ => return None,
        };
        Some(Color::rgba(
            r as f32 / 255.0,
            g as f32 / 255.0,
            b as f32 / 255.0,
            a as f32 / 255.0,
        ))
    }
}

/// A 2D affine transform stored as a 3x2 matrix (column-major), matching the
/// Canvas 2D `setTransform(a, b, c, d, e, f)` convention.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl Default for Transform {
    fn default() -> Self {
        Transform::IDENTITY
    }
}

impl Transform {
    pub const IDENTITY: Transform = Transform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    pub fn translate(x: f32, y: f32) -> Self {
        Transform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: x, f: y }
    }

    /// `self ∘ other` — apply `other` first, then `self`.
    pub fn then(&self, other: &Transform) -> Transform {
        Transform {
            a: self.a * other.a + self.c * other.b,
            b: self.b * other.a + self.d * other.b,
            c: self.a * other.c + self.c * other.d,
            d: self.b * other.c + self.d * other.d,
            e: self.a * other.e + self.c * other.f + self.e,
            f: self.b * other.e + self.d * other.f + self.f,
        }
    }

    pub fn apply(&self, p: Point) -> Point {
        Point::new(self.a * p.x + self.c * p.y + self.e, self.b * p.x + self.d * p.y + self.f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_union_and_intersect() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 5.0, 10.0, 10.0);
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 15.0, 15.0));
        assert_eq!(a.intersect(&b), Rect::new(5.0, 5.0, 5.0, 5.0));
        assert!(a.intersects(&b));
        assert!(!a.intersect(&Rect::new(100.0, 100.0, 1.0, 1.0)).intersects(&a));
    }

    #[test]
    fn color_hex_parsing() {
        assert_eq!(Color::from_hex("#ffffff"), Some(Color::WHITE));
        assert_eq!(Color::from_hex("#000"), Some(Color::BLACK));
        assert_eq!(Color::from_hex("#FF0000FF").unwrap().r, 1.0);
        assert_eq!(Color::from_hex("nope"), None);
    }

    #[test]
    fn transform_compose_is_identity_safe() {
        let t = Transform::translate(3.0, 4.0);
        assert_eq!(Transform::IDENTITY.then(&t), t);
        assert_eq!(t.apply(Point::new(1.0, 1.0)), Point::new(4.0, 5.0));
    }
}
