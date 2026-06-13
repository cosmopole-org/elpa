//! Input events the host forwards into the app. The host (web canvas, native
//! window) normalizes platform events into these; [`Elpa::send_event`] delivers
//! them to the app's `onEvent` function as a JSON object.
//!
//! Pointer coordinates are in **logical** (CSS) pixels with the origin at the
//! surface's top-left, so the same handler logic works across DPI and screen
//! sizes; the app scales to physical pixels using `surfaceInfo.scaleFactor` when
//! it needs framebuffer coordinates.

use crate::surface::SurfaceInfo;

/// A normalized input event.
#[derive(Debug, Clone)]
pub enum InputEvent {
    PointerDown { x: f64, y: f64, button: u8 },
    PointerMove { x: f64, y: f64 },
    PointerUp { x: f64, y: f64, button: u8 },
    Wheel { x: f64, y: f64, delta_y: f64 },
    KeyDown { key: String },
    KeyUp { key: String },
}

impl InputEvent {
    /// The `type` string the app matches on in `onEvent`.
    pub fn kind(&self) -> &'static str {
        match self {
            InputEvent::PointerDown { .. } => "pointerdown",
            InputEvent::PointerMove { .. } => "pointermove",
            InputEvent::PointerUp { .. } => "pointerup",
            InputEvent::Wheel { .. } => "wheel",
            InputEvent::KeyDown { .. } => "keydown",
            InputEvent::KeyUp { .. } => "keyup",
        }
    }

    /// Serialize to the JSON event object passed to `onEvent`. `surface` lets the
    /// app receive normalized coordinates (`nx`/`ny` in `[0,1]`) for resolution-
    /// independent hit-testing.
    pub fn to_json(&self, surface: &SurfaceInfo) -> serde_json::Value {
        let (lw, lh) = (surface.logical_width().max(1.0), surface.logical_height().max(1.0));
        let mut v = serde_json::json!({ "type": self.kind() });
        let map = v.as_object_mut().unwrap();
        match self {
            InputEvent::PointerDown { x, y, button } | InputEvent::PointerUp { x, y, button } => {
                map.insert("x".into(), (*x).into());
                map.insert("y".into(), (*y).into());
                map.insert("nx".into(), (x / lw).into());
                map.insert("ny".into(), (y / lh).into());
                map.insert("button".into(), (*button).into());
            }
            InputEvent::PointerMove { x, y } => {
                map.insert("x".into(), (*x).into());
                map.insert("y".into(), (*y).into());
                map.insert("nx".into(), (x / lw).into());
                map.insert("ny".into(), (y / lh).into());
            }
            InputEvent::Wheel { x, y, delta_y } => {
                map.insert("x".into(), (*x).into());
                map.insert("y".into(), (*y).into());
                map.insert("deltaY".into(), (*delta_y).into());
            }
            InputEvent::KeyDown { key } | InputEvent::KeyUp { key } => {
                map.insert("key".into(), key.clone().into());
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_event_carries_normalized_coords() {
        let s = SurfaceInfo::new(800, 600, 2.0); // logical 400x300
        let e = InputEvent::PointerDown { x: 200.0, y: 150.0, button: 0 };
        let j = e.to_json(&s);
        assert_eq!(j["type"], "pointerdown");
        assert_eq!(j["nx"], 0.5);
        assert_eq!(j["ny"], 0.5);
    }
}
