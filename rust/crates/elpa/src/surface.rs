//! Surface geometry shared between the host (window/canvas), the renderer, and
//! the app. The app reads this (via the `gpu.surfaceInfo` host call and the
//! `onResize` callback) so it can size its viewport, build correct projection
//! matrices, and map coordinates regardless of screen — phone, tablet, desktop.

use serde::{Deserialize, Serialize};

/// Safe-area insets in *physical* pixels: the space along each edge reserved by
/// the platform for system UI — the status bar, the navigation / gesture bar,
/// and display cutouts (notches, punch-holes). An app should keep interactive
/// chrome (app bars, FABs, tab bars) out of these regions while still drawing
/// background underneath them, exactly like Flutter's `MediaQuery.padding` /
/// `SafeArea`. Desktop and the web canvas report all-zero insets.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Insets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Insets {
    /// No reserved space (the default for full-window desktop / web surfaces).
    pub const ZERO: Insets = Insets { top: 0.0, right: 0.0, bottom: 0.0, left: 0.0 };

    /// Build a set of insets, clamping negatives to zero (an edge can never
    /// reserve a *negative* amount of space).
    pub fn new(top: f64, right: f64, bottom: f64, left: f64) -> Self {
        Self {
            top: top.max(0.0),
            right: right.max(0.0),
            bottom: bottom.max(0.0),
            left: left.max(0.0),
        }
    }
}

/// The current drawable surface, in *physical* pixels plus the device scale.
///
/// * `width`/`height` — physical (backing) pixels: the GPU framebuffer size and
///   the size to configure the wgpu surface with.
/// * `scale_factor` — physical / logical (CSS) pixel ratio (a.k.a. devicePixelRatio).
/// * `insets` — safe-area insets (status bar / navigation bar / cutouts), the
///   space the app should keep its chrome clear of. See [`Insets`].
/// * logical sizes — `width / scale_factor`, the CSS/layout space the app should
///   reason about for hit-testing and touch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SurfaceInfo {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    #[serde(default)]
    pub insets: Insets,
}

impl SurfaceInfo {
    pub fn new(width: u32, height: u32, scale_factor: f64) -> Self {
        Self {
            width: width.max(1),
            height: height.max(1),
            scale_factor: scale_factor.max(0.1),
            insets: Insets::ZERO,
        }
    }

    /// Same surface with its safe-area insets set — the builder the host uses to
    /// report the status-bar / navigation-bar reservations alongside the size.
    pub fn with_insets(mut self, insets: Insets) -> Self {
        self.insets = insets;
        self
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
    /// physical and logical sizes plus aspect so the app needs no math to adapt,
    /// and the safe-area insets under `safeArea` (physical px plus `logical*`
    /// equivalents) so the app can lay its chrome out clear of the system bars.
    pub fn to_json(&self) -> serde_json::Value {
        let sf = self.scale_factor; // already clamped to >= 0.1 by `new`
        serde_json::json!({
            "width": self.width,
            "height": self.height,
            "scaleFactor": self.scale_factor,
            "logicalWidth": self.logical_width(),
            "logicalHeight": self.logical_height(),
            "aspect": self.aspect(),
            "safeArea": {
                "top": self.insets.top,
                "right": self.insets.right,
                "bottom": self.insets.bottom,
                "left": self.insets.left,
                "logicalTop": self.insets.top / sf,
                "logicalRight": self.insets.right / sf,
                "logicalBottom": self.insets.bottom / sf,
                "logicalLeft": self.insets.left / sf,
            },
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

    #[test]
    fn insets_default_to_zero_and_serialize() {
        let s = SurfaceInfo::new(800, 600, 2.0);
        assert_eq!(s.insets, Insets::ZERO);
        let j = s.to_json();
        assert_eq!(j["safeArea"]["top"], 0.0);
        assert_eq!(j["safeArea"]["bottom"], 0.0);
    }

    #[test]
    fn insets_report_physical_and_logical() {
        // A phone status bar of 96 physical px at devicePixelRatio 3 is 32 dp.
        let s = SurfaceInfo::new(1080, 2340, 3.0).with_insets(Insets::new(96.0, 0.0, 48.0, 0.0));
        let j = s.to_json();
        assert_eq!(j["safeArea"]["top"], 96.0);
        assert_eq!(j["safeArea"]["logicalTop"], 32.0);
        assert_eq!(j["safeArea"]["bottom"], 48.0);
        assert_eq!(j["safeArea"]["logicalBottom"], 16.0);
    }

    #[test]
    fn negative_insets_clamp_to_zero() {
        let i = Insets::new(-5.0, 10.0, -1.0, 0.0);
        assert_eq!(i.top, 0.0);
        assert_eq!(i.right, 10.0);
        assert_eq!(i.bottom, 0.0);
    }
}
