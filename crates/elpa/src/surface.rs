//! Surface geometry shared between the host (window/canvas), the renderer, and
//! the app. The app reads this (via the `gpu.surfaceInfo` host call and the
//! `onResize` callback) so it can size its viewport, build correct projection
//! matrices, and map coordinates regardless of screen — phone, tablet, desktop.

use serde::{Deserialize, Serialize};

/// The current drawable surface, in *physical* pixels plus the device scale.
///
/// * `width`/`height` — physical (backing) pixels: the GPU framebuffer size and
///   the size to configure the wgpu surface with.
/// * `scale_factor` — physical / logical (CSS) pixel ratio (a.k.a. devicePixelRatio).
/// * logical sizes — `width / scale_factor`, the CSS/layout space the app should
///   reason about for hit-testing and touch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SurfaceInfo {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

impl SurfaceInfo {
    pub fn new(width: u32, height: u32, scale_factor: f64) -> Self {
        Self { width: width.max(1), height: height.max(1), scale_factor: scale_factor.max(0.1) }
    }

    /// Aspect ratio (width / height) — feed straight into a projection matrix.
    pub fn aspect(&self) -> f32 {
        self.width as f32 / self.height as f32
    }

    pub fn logical_width(&self) -> f64 {
        self.width as f64 / self.scale_factor
    }
    pub fn logical_height(&self) -> f64 {
        self.height as f64 / self.scale_factor
    }

    /// The object handed back to the VM for `gpu.surfaceInfo`. Includes both
    /// physical and logical sizes plus aspect so the app needs no math to adapt.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "width": self.width,
            "height": self.height,
            "scaleFactor": self.scale_factor,
            "logicalWidth": self.logical_width(),
            "logicalHeight": self.logical_height(),
            "aspect": self.aspect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_and_aspect_are_consistent() {
        let s = SurfaceInfo::new(800, 400, 2.0);
        assert_eq!(s.aspect(), 2.0);
        assert_eq!(s.logical_width(), 400.0);
        assert_eq!(s.logical_height(), 200.0);
        assert_eq!(s.to_json()["aspect"], 2.0);
    }

    #[test]
    fn clamps_degenerate_inputs() {
        let s = SurfaceInfo::new(0, 0, 0.0);
        assert_eq!(s.width, 1);
        assert!(s.scale_factor > 0.0);
    }
}
