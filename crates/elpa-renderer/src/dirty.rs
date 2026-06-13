//! Dirty-region tracking for partial rendering.
//!
//! Between two frames, only some commands change. The [`DirtyTracker`]
//! accumulates the bounds of changed/added/removed commands into a small set of
//! dirty rectangles. The renderer then re-rasterizes only those regions and
//! re-composites, instead of redrawing the whole screen.

use elpa_protocol::Rect;

/// Accumulates dirty rectangles for the current frame.
///
/// A real renderer caps the set at a small N and coalesces overlapping rects to
/// avoid pathological fragmentation; past a threshold it collapses everything to
/// a single bounding rect (still cheaper than a guaranteed full redraw only when
/// the union is smaller than the viewport).
#[derive(Debug, Default, Clone)]
pub struct DirtyTracker {
    rects: Vec<Rect>,
    /// Above this many tracked rects, collapse to a single union.
    max_rects: usize,
    full: bool,
}

impl DirtyTracker {
    pub fn new() -> Self {
        Self { rects: Vec::new(), max_rects: 16, full: false }
    }

    /// Mark the whole viewport dirty (e.g. on resize or theme change).
    pub fn mark_full(&mut self) {
        self.full = true;
        self.rects.clear();
    }

    pub fn is_full(&self) -> bool {
        self.full
    }

    /// Add a changed region. Overlapping rects are merged; once `max_rects` is
    /// exceeded the set collapses to its bounding union.
    pub fn add(&mut self, r: Rect) {
        if self.full || r.is_empty() {
            return;
        }
        // Merge into any rect it already overlaps to keep the set tight.
        for existing in &mut self.rects {
            if existing.intersects(&r) {
                *existing = existing.union(&r);
                return;
            }
        }
        self.rects.push(r);
        if self.rects.len() > self.max_rects {
            let union = self.rects.iter().fold(Rect::default(), |a, b| a.union(b));
            self.rects.clear();
            self.rects.push(union);
        }
    }

    /// The dirty rectangles to repaint this frame. Empty means "nothing
    /// changed" — the previous frame can be re-presented as-is.
    pub fn rects(&self) -> &[Rect] {
        &self.rects
    }

    pub fn is_clean(&self) -> bool {
        !self.full && self.rects.is_empty()
    }

    /// Reset for the next frame.
    pub fn clear(&mut self) {
        self.rects.clear();
        self.full = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_rects_merge() {
        let mut d = DirtyTracker::new();
        d.add(Rect::new(0.0, 0.0, 10.0, 10.0));
        d.add(Rect::new(5.0, 5.0, 10.0, 10.0));
        assert_eq!(d.rects().len(), 1);
        assert_eq!(d.rects()[0], Rect::new(0.0, 0.0, 15.0, 15.0));
    }

    #[test]
    fn disjoint_rects_stay_separate_until_cap() {
        let mut d = DirtyTracker::new();
        d.add(Rect::new(0.0, 0.0, 1.0, 1.0));
        d.add(Rect::new(100.0, 100.0, 1.0, 1.0));
        assert_eq!(d.rects().len(), 2);
    }

    #[test]
    fn full_invalidation_overrides() {
        let mut d = DirtyTracker::new();
        d.add(Rect::new(0.0, 0.0, 1.0, 1.0));
        d.mark_full();
        assert!(d.is_full());
        assert!(d.rects().is_empty());
    }
}
