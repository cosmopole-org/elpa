//! Dirty-region tracking for partial presentation.
//!
//! When passes re-record, the regions they touch are accumulated here. The final
//! surface present is scissored to these rects, so unchanged screen areas keep
//! their previous pixels and bandwidth scales with change, not screen size.

use elpa_protocol::Rect;

/// Accumulates dirty rectangles for the current frame, coalescing overlaps and
/// collapsing to a bounding union past a cap to avoid fragmentation.
#[derive(Debug, Default, Clone)]
pub struct DirtyTracker {
    rects: Vec<Rect>,
    max_rects: usize,
    full: bool,
}

impl DirtyTracker {
    pub fn new() -> Self {
        Self { rects: Vec::new(), max_rects: 16, full: false }
    }

    /// Mark the whole surface dirty (resize, format change, or a pass with no
    /// scissor that targets the surface).
    pub fn mark_full(&mut self) {
        self.full = true;
        self.rects.clear();
    }

    pub fn is_full(&self) -> bool {
        self.full
    }

    pub fn add(&mut self, r: Rect) {
        if self.full || r.is_empty() {
            return;
        }
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

    /// The dirty rects to scissor the present to. Empty == nothing changed.
    pub fn rects(&self) -> &[Rect] {
        &self.rects
    }

    pub fn is_clean(&self) -> bool {
        !self.full && self.rects.is_empty()
    }

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
        d.add(Rect::new(0, 0, 10, 10));
        d.add(Rect::new(5, 5, 10, 10));
        assert_eq!(d.rects().len(), 1);
        assert_eq!(d.rects()[0], Rect::new(0, 0, 15, 15));
    }

    #[test]
    fn full_overrides_rects() {
        let mut d = DirtyTracker::new();
        d.add(Rect::new(0, 0, 1, 1));
        d.mark_full();
        assert!(d.is_full());
        assert!(d.rects().is_empty());
    }
}
