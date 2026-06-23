// Elpa Flutter — the rendering layer (package:flutter/rendering analog).
//
// The box layout protocol, exactly as Flutter runs it: a parent passes
// `BoxConstraints` *down*, each child chooses its `Size` within them and reports
// it *up*, and the parent positions the child by writing an offset into the
// child's parent data. Layout is cached per relayout boundary (a child whose
// constraints did not change and that its parent does not size-depend on is not
// re-laid-out), and painting walks the tree issuing dart:ui Canvas calls through
// a `PaintingContext`. `PipelineOwner` flushes the dirty-layout and dirty-paint
// lists each frame; `RenderView` is the root that ties the tree to the surface.

let INFTY = 1000000000.0;
function clampR(v, lo, hi) { if (v < lo) { return lo; } if (v > hi) { return hi; } return v; }
function maxD(a, b) { if (a > b) { return a; } return b; }
function minD(a, b) { if (a < b) { return a; } return b; }

// ------------------------------------------------------- painting helpers -----
// Alignment in [-1,1]^2 (Flutter Alignment): (-1,-1) top-left, (0,0) center.
class Alignment {
    constructor(x, y) { this.x = x; this.y = y; }
    // The offset of a child of `diff = parent - child` size under this alignment.
    alongOffset(diffW, diffH) { return new Offset((1.0 + this.x) / 2.0 * diffW, (1.0 + this.y) / 2.0 * diffH); }
}
let Alignments = {
    topLeft: new Alignment(-1.0, -1.0), topCenter: new Alignment(0.0, -1.0), topRight: new Alignment(1.0, -1.0),
    centerLeft: new Alignment(-1.0, 0.0), center: new Alignment(0.0, 0.0), centerRight: new Alignment(1.0, 0.0),
    bottomLeft: new Alignment(-1.0, 1.0), bottomCenter: new Alignment(0.0, 1.0), bottomRight: new Alignment(1.0, 1.0),
};

// EdgeInsets (Flutter EdgeInsets) in logical px.
class EdgeInsets {
    constructor(l, t, r, b) { this.left = l; this.top = t; this.right = r; this.bottom = b; }
    horizontal() { return this.left + this.right; }
    vertical() { return this.top + this.bottom; }
}
function edgeAll(v) { return new EdgeInsets(v, v, v, v); }
function edgeSymmetric(h, v) { return new EdgeInsets(h, v, h, v); }
function edgeOnly(l, t, r, b) { return new EdgeInsets(l, t, r, b); }
let EDGE_ZERO = new EdgeInsets(0.0, 0.0, 0.0, 0.0);

// ------------------------------------------------------------ constraints -----
class BoxConstraints {
    constructor(minW, maxW, minH, maxH) { this.minW = minW; this.maxW = maxW; this.minH = minH; this.maxH = maxH; }
    constrainWidth(w) { return clampR(w, this.minW, this.maxW); }
    constrainHeight(h) { return clampR(h, this.minH, this.maxH); }
    constrain(sz) { return new Size(this.constrainWidth(sz.width), this.constrainHeight(sz.height)); }
    biggest() { return new Size(this.constrainWidth(INFTY), this.constrainHeight(INFTY)); }
    smallest() { return new Size(this.minW, this.minH); }
    hasBoundedWidth() { return this.maxW < INFTY; }
    hasBoundedHeight() { return this.maxH < INFTY; }
    isTight() { if (this.minW >= this.maxW) { if (this.minH >= this.maxH) { return true; } } return false; }
    loosen() { return new BoxConstraints(0.0, this.maxW, 0.0, this.maxH); }
    // Returns constraints respecting `this` but as close to `c` as possible.
    enforce(c) {
        return new BoxConstraints(
            clampR(this.minW, c.minW, c.maxW), clampR(this.maxW, c.minW, c.maxW),
            clampR(this.minH, c.minH, c.maxH), clampR(this.maxH, c.minH, c.maxH));
    }
    deflate(e) {
        let h = e.horizontal(); let v = e.vertical();
        let dmaxW = maxD(0.0, this.maxW - h); let dmaxH = maxD(0.0, this.maxH - v);
        return new BoxConstraints(
            clampR(this.minW - h, 0.0, dmaxW), dmaxW,
            clampR(this.minH - v, 0.0, dmaxH), dmaxH);
    }
    copyWith(minW, maxW, minH, maxH) { return new BoxConstraints(minW, maxW, minH, maxH); }
    equals(o) {
        if (this.minW != o.minW) { return false; }
        if (this.maxW != o.maxW) { return false; }
        if (this.minH != o.minH) { return false; }
        if (this.maxH != o.maxH) { return false; }
        return true;
    }
}
function constraintsTight(sz) { return new BoxConstraints(sz.width, sz.width, sz.height, sz.height); }
function constraintsTightFor(w, h) {
    let minW = 0.0; let maxW = INFTY; let minH = 0.0; let maxH = INFTY;
    if (w >= 0.0) { minW = w; maxW = w; }
    if (h >= 0.0) { minH = h; maxH = h; }
    return new BoxConstraints(minW, maxW, minH, maxH);
}
function constraintsLoose(sz) { return new BoxConstraints(0.0, sz.width, 0.0, sz.height); }
function constraintsExpand() { return new BoxConstraints(0.0, INFTY, 0.0, INFTY); }

// ----------------------------------------------------------- parent data ------
class ParentData { constructor() {} detach() {} }
class BoxParentData extends ParentData { constructor() { super(); this.offset = new Offset(0.0, 0.0); } }
class FlexParentData extends BoxParentData { constructor() { super(); this.flex = 0.0; this.fit = "tight"; } }
class StackParentData extends BoxParentData {
    constructor() { super(); this.top = -1.0; this.right = -1.0; this.bottom = -1.0; this.left = -1.0; this.width = -1.0; this.height = -1.0; }
    isPositioned() {
        if (this.top >= 0.0) { return true; } if (this.right >= 0.0) { return true; }
        if (this.bottom >= 0.0) { return true; } if (this.left >= 0.0) { return true; }
        if (this.width >= 0.0) { return true; } if (this.height >= 0.0) { return true; }
        return false;
    }
}

// --------------------------------------------------------- hit testing --------
class HitTestEntry { constructor(target, pos) { this.target = target; this.localPosition = pos; } }
class HitTestResult {
    constructor() { this.path = []; }
    add(entry) { push(this.path, entry); }
}

// ------------------------------------------------------- PipelineOwner ---------
// Holds the dirty-layout and dirty-paint node lists and flushes them each frame,
// in depth order, exactly like Flutter's PipelineOwner.
class PipelineOwner {
    constructor(binding) { this.binding = binding; this.layoutDirty = []; this.paintDirty = []; this.rootNode = 0; }
    requestVisualUpdate() { this.binding.scheduleFrame(); }
    // Insertion-sort the dirty list by ascending depth, then relayout each.
    flushLayout() {
        for (let pass = 0; pass < 16; pass++) {
            if (len(this.layoutDirty) == 0) { return 0; }
            let dirty = this.layoutDirty; this.layoutDirty = [];
            sortByDepth(dirty);
            for (let i = 0; i < len(dirty); i++) {
                let node = dirty[i];
                if (node._needsLayout > 0.5) { if (node._attached > 0.5) { node.layoutWithoutResize(); } }
            }
        }
        return 0;
    }
    flushPaint(context) {
        // Single-canvas model: paint the whole tree from the root in one walk.
        if (this.rootNode != 0) { this.rootNode.paintFromRoot(context); }
        this.paintDirty = [];
    }
}
// Insertion sort an array of render objects by `.depth` ascending (stable, small).
function sortByDepth(a) {
    for (let i = 1; i < len(a); i++) {
        let x = a[i]; let j = i - 1;
        for (let g = 0; g < len(a); g++) {
            if (j >= 0) { if (a[j].depth > x.depth) { a[j + 1] = a[j]; j = j - 1; } else { g = len(a); } }
            else { g = len(a); }
        }
        a[j + 1] = x;
    }
}

// ------------------------------------------------------- PaintingContext ------
// A thin holder of the active dart:ui Canvas (Flutter's PaintingContext wraps a
// canvas + layer tree; with one surface layer we just carry the canvas).
class PaintingContext {
    constructor(canvas) { this.canvas = canvas; }
    paintChild(child, off) { child.paintWithContext(this, off); }
}

// ----------------------------------------------------------- RenderObject -----
class RenderObject {
    constructor() {
        this._id = nextObjId();
        this.parent = 0; this.owner = 0; this.depth = 0; this._attached = 0.0;
        this._needsLayout = 1.0; this._needsPaint = 1.0;
        this._constraints = 0; this._relayoutBoundary = 0; this.parentData = 0;
    }
    // Lifecycle / tree wiring.
    attach(owner) { this.owner = owner; this._attached = 1.0; if (this._needsLayout > 0.5) { if (this._relayoutBoundary != 0) { this._needsLayout = 0.0; this.markNeedsLayout(); } } if (this._needsPaint > 0.5) { this.markNeedsPaint(); } }
    detach() { this._attached = 0.0; this.owner = 0; }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new BoxParentData(); } }
    redepthChild(child) { if (child.depth <= this.depth) { child.depth = this.depth + 1; child.redepthChildren(); } }
    redepthChildren() { return 0; }
    adoptChild(child) {
        child.parent = this; this.setupParentData(child);
        if (this.owner != 0) { child.attach(this.owner); }
        this.redepthChild(child);
        this.markNeedsLayout();
    }
    dropChild(child) {
        child.cleanRelayoutBoundary();
        child.parent = 0; if (this.owner != 0) { child.detach(); }
        this.markNeedsLayout();
    }
    cleanRelayoutBoundary() { this._relayoutBoundary = 0; this._needsLayout = 1.0; }
    visitChildren(fn) { return 0; }

    // Layout entry point. Decides the relayout boundary and skips work when the
    // constraints and boundary are unchanged — Flutter's core layout caching.
    layout(constraints, parentUsesSize) {
        let isBoundary = 0.0;
        if (parentUsesSize < 0.5) { isBoundary = 1.0; }
        if (this.sizedByParent() > 0.5) { isBoundary = 1.0; }
        if (constraints.isTight()) { isBoundary = 1.0; }
        if (!isRenderObj(this.parent)) { isBoundary = 1.0; }
        let boundary = this;
        if (isBoundary < 0.5) { boundary = this.parent._relayoutBoundary; }
        // Cache hit (clean + same constraints + same boundary) → skip. Identity
        // compare via sameRef: `==` on render objects would deep-recurse the graph.
        if (this._needsLayout < 0.5) {
            if (this._constraints != 0) { if (this._constraints.equals(constraints)) { if (sameRef(this._relayoutBoundary, boundary)) { return 0; } } }
        }
        this._constraints = constraints; this._relayoutBoundary = boundary;
        if (this.sizedByParent() > 0.5) { this.performResize(); }
        this.performLayout();
        this._needsLayout = 0.0;
        this.markNeedsPaint();
        return 0;
    }
    layoutWithoutResize() {
        this.performLayout(); this._needsLayout = 0.0; this.markNeedsPaint();
    }
    sizedByParent() { return 0.0; }
    performResize() { return 0; }
    performLayout() { return 0; }

    markNeedsLayout() {
        if (this._needsLayout > 0.5) { return 0; }
        if (!sameRef(this._relayoutBoundary, this)) {
            if (isRenderObj(this.parent)) { this._needsLayout = 1.0; this.parent.markNeedsLayout(); return 0; }
        }
        this._needsLayout = 1.0;
        if (this.owner != 0) { push(this.owner.layoutDirty, this); this.owner.requestVisualUpdate(); }
    }
    markNeedsPaint() {
        if (this._needsPaint > 0.5) { return 0; }
        this._needsPaint = 1.0;
        if (this.owner != 0) { push(this.owner.paintDirty, this); this.owner.requestVisualUpdate(); }
    }
    paintWithContext(context, off) { this._needsPaint = 0.0; this.paint(context, off); }
    paint(context, off) { return 0; }
    // Whole-tree paint walk from the root (single-canvas compositing model).
    paintFromRoot(context) { this.paintWithContext(context, OFFSET_ZERO); }
}
function isObj(x) { if (isNull(x)) { return false; } if (x == 0) { return false; } return true; }
function isRenderObj(x) { if (!isObj(x)) { return false; } if (has(x, "_isRenderObject")) { return true; } return false; }
function roListContains(list, c) { for (let i = 0; i < len(list); i++) { if (sameRef(list[i], c)) { return true; } } return false; }
// Sync a container render object's children to `list`, preserving identity:
// drop the removed, adopt the new, and mark layout on any change. Used by the
// MultiChildRenderObjectElement to wire reconciled children in.
function syncContainerChildren(self, list) {
    for (let i = 0; i < len(self.children); i++) { let c = self.children[i]; if (!roListContains(list, c)) { self.dropChild(c); } }
    for (let i = 0; i < len(list); i++) { let c = list[i]; if (!sameRef(c.parent, self)) { self.adoptChild(c); } }
    let changed = 0.0;
    if (len(list) != len(self.children)) { changed = 1.0; }
    else { for (let i = 0; i < len(list); i++) { if (!sameRef(list[i], self.children[i])) { changed = 1.0; } } }
    self.children = list;
    if (changed > 0.5) { self.markNeedsLayout(); }
}

// ------------------------------------------------------------- RenderBox ------
class RenderBox extends RenderObject {
    constructor() { super(); this._isRenderObject = 1.0; this.size = new Size(0.0, 0.0); }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new BoxParentData(); } }
    // Hit test: local `pos` is in this box's coordinate space.
    hitTest(result, pos) {
        if (this.size.contains(pos)) {
            let hit = false;
            if (this.hitTestChildren(result, pos)) { hit = true; }
            if (this.hitTestSelf(pos)) { hit = true; }
            if (hit) { result.add(new HitTestEntry(this, pos)); return true; }
        }
        return false;
    }
    hitTestSelf(pos) { return false; }
    hitTestChildren(result, pos) { return false; }
}

// A box with one child that, by default, takes its child's size and paints it at
// the same offset (Flutter's RenderProxyBox). The single-child base for most
// effect / decoration render objects.
class RenderProxyBox extends RenderBox {
    constructor() { super(); this.child = 0; }
    setChild(c) {
        if (sameRef(this.child, c)) { return 0; }
        if (this.child != 0) { this.dropChild(this.child); }
        this.child = c;
        if (c != 0) { this.adoptChild(c); }
    }
    visitChildren(fn) { if (this.child != 0) { fn(this.child); } }
    redepthChildren() { if (this.child != 0) { this.redepthChild(this.child); } }
    computeSizeForNoChild(constraints) { return constraints.smallest(); }
    performLayout() {
        if (this.child != 0) { this.child.layout(this._constraints, 1.0); this.size = this.child.size; }
        else { this.size = this.computeSizeForNoChild(this._constraints); }
    }
    paint(context, off) { if (this.child != 0) { context.paintChild(this.child, off); } }
    hitTestChildren(result, pos) {
        if (this.child != 0) {
            let o = this.child.parentData.offset;
            return this.child.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy));
        }
        return false;
    }
}

// ---- RenderConstrainedBox (SizedBox / ConstrainedBox) ----
class RenderConstrainedBox extends RenderProxyBox {
    constructor(additional) { super(); this.additional = additional; }
    performLayout() {
        if (this.child != 0) { this.child.layout(this.additional.enforce(this._constraints), 1.0); this.size = this.child.size; }
        else { this.size = this.additional.enforce(this._constraints).constrain(SIZE_ZERO); }
    }
}

// ---- RenderPadding ----
class RenderPadding extends RenderBox {
    constructor(padding) { super(); this.padding = padding; this.child = 0; }
    setChild(c) { if (sameRef(this.child, c)) { return 0; } if (this.child != 0) { this.dropChild(this.child); } this.child = c; if (c != 0) { this.adoptChild(c); } }
    visitChildren(fn) { if (this.child != 0) { fn(this.child); } }
    redepthChildren() { if (this.child != 0) { this.redepthChild(this.child); } }
    performLayout() {
        let p = this.padding;
        if (this.child == 0) { this.size = this._constraints.constrain(new Size(p.horizontal(), p.vertical())); return 0; }
        let inner = this._constraints.deflate(p);
        this.child.layout(inner, 1.0);
        this.child.parentData.offset = new Offset(p.left, p.top);
        this.size = this._constraints.constrain(new Size(p.horizontal() + this.child.size.width, p.vertical() + this.child.size.height));
    }
    paint(context, off) { if (this.child != 0) { let o = this.child.parentData.offset; context.paintChild(this.child, new Offset(off.dx + o.dx, off.dy + o.dy)); } }
    hitTestChildren(result, pos) {
        if (this.child != 0) { let o = this.child.parentData.offset; return this.child.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy)); }
        return false;
    }
}

// ---- RenderPositionedBox (Align / Center) ----
class RenderPositionedBox extends RenderBox {
    constructor(alignment, widthFactor, heightFactor) { super(); this.alignment = alignment; this.widthFactor = widthFactor; this.heightFactor = heightFactor; this.child = 0; }
    setChild(c) { if (sameRef(this.child, c)) { return 0; } if (this.child != 0) { this.dropChild(this.child); } this.child = c; if (c != 0) { this.adoptChild(c); } }
    visitChildren(fn) { if (this.child != 0) { fn(this.child); } }
    redepthChildren() { if (this.child != 0) { this.redepthChild(this.child); } }
    performLayout() {
        let c = this._constraints;
        let shrinkW = 0.0; if (this.widthFactor >= 0.0) { shrinkW = 1.0; } if (!c.hasBoundedWidth()) { shrinkW = 1.0; }
        let shrinkH = 0.0; if (this.heightFactor >= 0.0) { shrinkH = 1.0; } if (!c.hasBoundedHeight()) { shrinkH = 1.0; }
        if (this.child == 0) {
            this.size = c.constrain(new Size(maxD(0.0, shrinkW * 0.0), maxD(0.0, shrinkH * 0.0)));
            return 0;
        }
        this.child.layout(c.loosen(), 1.0);
        let wf = 1.0; if (this.widthFactor >= 0.0) { wf = this.widthFactor; }
        let hf = 1.0; if (this.heightFactor >= 0.0) { hf = this.heightFactor; }
        let w = INFTY; let h = INFTY;
        if (shrinkW > 0.5) { w = this.child.size.width * wf; }
        if (shrinkH > 0.5) { h = this.child.size.height * hf; }
        this.size = c.constrain(new Size(w, h));
        let off = this.alignment.alongOffset(this.size.width - this.child.size.width, this.size.height - this.child.size.height);
        this.child.parentData.offset = off;
    }
    paint(context, off) { if (this.child != 0) { let o = this.child.parentData.offset; context.paintChild(this.child, new Offset(off.dx + o.dx, off.dy + o.dy)); } }
    hitTestChildren(result, pos) {
        if (this.child != 0) { let o = this.child.parentData.offset; return this.child.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy)); }
        return false;
    }
}

// ----------------------------------------------------------- RenderFlex ------
// The real Flutter flex algorithm: lay out inflexible children with an unbounded
// main axis, distribute the remaining main-axis space to flex children by flex
// factor (tight/loose fit), compute the cross size, then position children per
// mainAxisAlignment / crossAxisAlignment.
class RenderFlex extends RenderBox {
    constructor(direction, mainAxisAlignment, crossAxisAlignment, mainAxisSize) {
        super(); this.direction = direction; this.mainAxisAlignment = mainAxisAlignment;
        this.crossAxisAlignment = crossAxisAlignment; this.mainAxisSize = mainAxisSize; this.children = [];
    }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new FlexParentData(); } if (!has(child.parentData, "flex")) { child.parentData.flex = 0.0; } }
    setChildren(list) {
        for (let i = 0; i < len(this.children); i++) { this.dropChild(this.children[i]); }
        this.children = list;
        for (let i = 0; i < len(list); i++) { this.adoptChild(list[i]); }
    }
    syncChildren(list) { syncContainerChildren(this, list); }
    visitChildren(fn) { for (let i = 0; i < len(this.children); i++) { fn(this.children[i]); } }
    redepthChildren() { for (let i = 0; i < len(this.children); i++) { this.redepthChild(this.children[i]); } }
    isHoriz() { if (this.direction == "horizontal") { return 1.0; } return 0.0; }
    mainOf(sz) { if (this.isHoriz() > 0.5) { return sz.width; } return sz.height; }
    crossOf(sz) { if (this.isHoriz() > 0.5) { return sz.height; } return sz.width; }

    performLayout() {
        let c = this._constraints; let horiz = this.isHoriz();
        let maxMain = this.maxMainOf(c); let canFlex = maxMain < INFTY;
        let totalFlex = 0.0; let allocated = 0.0; let crossSize = 0.0; let n = len(this.children);
        // Pass 1: inflexible children.
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; let flex = ch.parentData.flex;
            if (flex > 0.0) { totalFlex = totalFlex + flex; }
            else {
                let inner = this.childConstraints(c, horiz, -1.0);
                ch.layout(inner, 1.0);
                allocated = allocated + this.mainOf(ch.size);
                crossSize = maxD(crossSize, this.crossOf(ch.size));
            }
        }
        // Pass 2: flex children share the free space by flex factor.
        let freeSpace = maxD(0.0, maxMain - allocated);
        let spacePerFlex = 0.0; if (totalFlex > 0.0) { if (canFlex) { spacePerFlex = freeSpace / totalFlex; } }
        let allocatedFlex = 0.0;
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; let flex = ch.parentData.flex;
            if (flex > 0.0) {
                let extent = spacePerFlex * flex;
                let inner = this.childConstraints(c, horiz, extent);
                ch.layout(inner, 1.0);
                allocatedFlex = allocatedFlex + this.mainOf(ch.size);
                crossSize = maxD(crossSize, this.crossOf(ch.size));
            }
        }
        allocated = allocated + allocatedFlex;
        // Resolve the box size.
        let actualMain = allocated;
        if (this.mainAxisSize == "max") { if (canFlex) { actualMain = maxMain; } }
        let crossExtent = crossSize;
        if (horiz > 0.5) { this.size = c.constrain(new Size(actualMain, crossExtent)); crossExtent = this.size.height; actualMain = this.size.width; }
        else { this.size = c.constrain(new Size(crossExtent, actualMain)); crossExtent = this.size.width; actualMain = this.size.height; }
        // Distribute leftover main-axis space per mainAxisAlignment.
        let leftover = maxD(0.0, actualMain - allocated);
        let leading = 0.0; let between = 0.0;
        let mode = this.mainAxisAlignment;
        if (mode == "end") { leading = leftover; }
        else { if (mode == "center") { leading = leftover / 2.0; }
        else { if (mode == "spaceBetween") { if (n > 1) { between = leftover / (n - 1.0); } }
        else { if (mode == "spaceAround") { if (n > 0) { between = leftover / n; leading = between / 2.0; } }
        else { if (mode == "spaceEvenly") { if (n > 0) { between = leftover / (n + 1.0); leading = between; } } } } } }
        // Position each child.
        let pos = leading;
        for (let i = 0; i < n; i++) {
            let ch = this.children[i];
            let crossPos = this.crossPosition(crossExtent, this.crossOf(ch.size));
            if (horiz > 0.5) { ch.parentData.offset = new Offset(pos, crossPos); }
            else { ch.parentData.offset = new Offset(crossPos, pos); }
            pos = pos + this.mainOf(ch.size) + between;
        }
    }
    maxMainOf(c) { if (this.isHoriz() > 0.5) { return c.maxW; } return c.maxH; }
    // Constraints for a child: main axis loose (or tight `extent` for flex tight
    // fit), cross axis stretch → tight, else loose.
    childConstraints(c, horiz, extent) {
        let stretch = 0.0; if (this.crossAxisAlignment == "stretch") { stretch = 1.0; }
        let crossMin = 0.0; let crossMax = INFTY;
        if (horiz > 0.5) { crossMax = c.maxH; if (stretch > 0.5) { crossMin = c.maxH; } }
        else { crossMax = c.maxW; if (stretch > 0.5) { crossMin = c.maxW; } }
        let mainMin = 0.0; let mainMax = INFTY;
        if (extent >= 0.0) { mainMax = extent; mainMin = extent; }
        if (horiz > 0.5) { return new BoxConstraints(mainMin, mainMax, crossMin, crossMax); }
        return new BoxConstraints(crossMin, crossMax, mainMin, mainMax);
    }
    crossPosition(crossExtent, childCross) {
        let a = this.crossAxisAlignment;
        if (a == "start") { return 0.0; }
        if (a == "end") { return crossExtent - childCross; }
        if (a == "stretch") { return 0.0; }
        return (crossExtent - childCross) / 2.0;
    }
    paint(context, off) {
        for (let i = 0; i < len(this.children); i++) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            context.paintChild(ch, new Offset(off.dx + o.dx, off.dy + o.dy));
        }
    }
    hitTestChildren(result, pos) {
        for (let i = len(this.children) - 1; i >= 0; i--) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            if (ch.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy))) { return true; }
        }
        return false;
    }
}

// ----------------------------------------------------------- RenderStack ------
class RenderStack extends RenderBox {
    constructor(alignment, fit) { super(); this.alignment = alignment; this.fit = fit; this.children = []; }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new StackParentData(); } }
    setChildren(list) {
        for (let i = 0; i < len(this.children); i++) { this.dropChild(this.children[i]); }
        this.children = list;
        for (let i = 0; i < len(list); i++) { this.adoptChild(list[i]); }
    }
    syncChildren(list) { syncContainerChildren(this, list); }
    visitChildren(fn) { for (let i = 0; i < len(this.children); i++) { fn(this.children[i]); } }
    redepthChildren() { for (let i = 0; i < len(this.children); i++) { this.redepthChild(this.children[i]); } }
    performLayout() {
        let c = this._constraints; let n = len(this.children);
        let width = c.minW; let height = c.minH; let hasNonPositioned = 0.0;
        let nonPosConstraints = c.loosen();
        if (this.fit == "expand") { nonPosConstraints = constraintsTight(c.biggest()); }
        for (let i = 0; i < n; i++) {
            let ch = this.children[i];
            if (ch.parentData.isPositioned()) { continue; }
            hasNonPositioned = 1.0;
            ch.layout(nonPosConstraints, 1.0);
            width = maxD(width, ch.size.width); height = maxD(height, ch.size.height);
        }
        if (hasNonPositioned > 0.5) { this.size = c.constrain(new Size(width, height)); }
        else { this.size = c.biggest(); }
        // Place non-positioned children by alignment; resolve positioned children.
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; let pd = ch.parentData;
            if (pd.isPositioned()) { this.layoutPositioned(ch, pd); }
            else {
                let o = this.alignment.alongOffset(this.size.width - ch.size.width, this.size.height - ch.size.height);
                pd.offset = o;
            }
        }
    }
    layoutPositioned(ch, pd) {
        let minW = 0.0; let maxW = INFTY; let minH = 0.0; let maxH = INFTY;
        if (pd.width >= 0.0) { minW = pd.width; maxW = pd.width; }
        else { if (pd.left >= 0.0) { if (pd.right >= 0.0) { minW = maxD(0.0, this.size.width - pd.left - pd.right); maxW = minW; } } }
        if (pd.height >= 0.0) { minH = pd.height; maxH = pd.height; }
        else { if (pd.top >= 0.0) { if (pd.bottom >= 0.0) { minH = maxD(0.0, this.size.height - pd.top - pd.bottom); maxH = minH; } } }
        ch.layout(new BoxConstraints(minW, maxW, minH, maxH), 1.0);
        let x = 0.0; let y = 0.0;
        if (pd.left >= 0.0) { x = pd.left; } else { if (pd.right >= 0.0) { x = this.size.width - pd.right - ch.size.width; } }
        if (pd.top >= 0.0) { y = pd.top; } else { if (pd.bottom >= 0.0) { y = this.size.height - pd.bottom - ch.size.height; } }
        pd.offset = new Offset(x, y);
    }
    paint(context, off) {
        for (let i = 0; i < len(this.children); i++) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            context.paintChild(ch, new Offset(off.dx + o.dx, off.dy + o.dy));
        }
    }
    hitTestChildren(result, pos) {
        for (let i = len(this.children) - 1; i >= 0; i--) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            if (ch.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - o.dy))) { return true; }
        }
        return false;
    }
}

// ---- RenderDecoratedBox (BoxDecoration) ----
class RenderDecoratedBox extends RenderProxyBox {
    constructor(decoration, position) { super(); this.decoration = decoration; this.position = position; }
    computeSizeForNoChild(constraints) { return constraints.constrain(constraints.biggest()); }
    paint(context, off) {
        if (this.position != "foreground") { this.paintDeco(context, off); }
        if (this.child != 0) { context.paintChild(this.child, off); }
        if (this.position == "foreground") { this.paintDeco(context, off); }
    }
    paintDeco(context, off) {
        let d = this.decoration; let canvas = context.canvas;
        let r = 0.0; if (has(d, "borderRadius")) { r = d.borderRadius; }
        let rect = rectLTWH(off.dx, off.dy, this.size.width, this.size.height);
        if (has(d, "boxShadow")) {
            let sh = d.boxShadow;
            for (let i = 0; i < len(sh); i++) {
                let s = sh[i]; let blur = 6.0; if (has(s, "blur")) { blur = s.blur; }
                let dx = 0.0; let dy = 0.0; if (has(s, "dx")) { dx = s.dx; } if (has(s, "dy")) { dy = s.dy; }
                let spread = 0.0; if (has(s, "spread")) { spread = s.spread; }
                canvas.painter.shadow(rect.cx() + dx, rect.cy() + dy, rect.width / 2.0 + spread, rect.height / 2.0 + spread, r, 0.0, 0.0, 0.0, blur, s.color);
            }
        }
        if (has(d, "gradient")) {
            let p = new Paint(); p.shader = d.gradient;
            canvas.drawRRect(rrectFromRectAndRadius(rect, radiusCircular(r)), p);
        } else { if (has(d, "color")) {
            canvas.drawRRect(rrectFromRectAndRadius(rect, radiusCircular(r)), paintFill(d.color));
        } }
        if (has(d, "border")) {
            let b = d.border;
            canvas.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, b.width, 0.0, CLEAR, b.color);
        }
    }
}

// ---- RenderParagraph (Text) ----
class RenderParagraph extends RenderBox {
    constructor(text, style) { super(); this.text = text; this.style = style; this.lines = []; this.cell = 2.0; }
    fontSize() { if (has(this.style, "fontSize")) { return this.style.fontSize; } return 14.0; }
    color() { if (has(this.style, "color")) { return this.style.color; } return BLACK; }
    performLayout() {
        let font = WB.font; let cell = this.fontSize() / 6.6; this.cell = cell;
        let maxW = this._constraints.maxW;
        // Word-wrap into lines that fit maxW.
        let words = split(this.text, " "); this.lines = []; let line = ""; let widest = 0.0;
        for (let i = 0; i < len(words); i++) {
            let w = words[i]; let trial = w; if (len(line) > 0) { trial = concat(concat(line, " "), w); }
            if (font.textW(trial, cell) > maxW) {
                if (len(line) > 0) { push(this.lines, line); widest = maxD(widest, font.textW(line, cell)); line = w; }
                else { push(this.lines, w); widest = maxD(widest, font.textW(w, cell)); line = ""; }
            } else { line = trial; }
        }
        if (len(line) > 0) { push(this.lines, line); widest = maxD(widest, font.textW(line, cell)); }
        let lh = font.lineH(cell);
        this.size = this._constraints.constrain(new Size(widest, lh * maxD(1.0, num(len(this.lines)))));
    }
    paint(context, off) {
        let font = WB.font; let lh = font.lineH(this.cell); let col = this.color();
        let align = "left"; if (has(this.style, "textAlign")) { align = this.style.textAlign; }
        for (let i = 0; i < len(this.lines); i++) {
            let s = this.lines[i]; let x = off.dx;
            if (align == "center") { x = off.dx + (this.size.width - font.textW(s, this.cell)) / 2.0; }
            if (align == "right") { x = off.dx + this.size.width - font.textW(s, this.cell); }
            context.canvas.drawText(s, new Offset(x, off.dy + num(i) * lh), this.cell, col);
        }
    }
}

// ---- RenderOpacity ----
class RenderOpacity extends RenderProxyBox {
    constructor(opacity) { super(); this.opacity = opacity; }
    paint(context, off) {
        if (this.child == 0) { return 0; }
        if (this.opacity >= 0.999) { context.paintChild(this.child, off); return 0; }
        if (this.opacity <= 0.001) { return 0; }
        context.canvas.save(); context.canvas.painter.setAlpha(this.opacity);
        context.paintChild(this.child, off);
        context.canvas.restore();
    }
}

// ---- RenderTransform (rotate / scale around a center) ----
class RenderTransform extends RenderProxyBox {
    constructor(kind, a, b) { super(); this.kind = kind; this.a = a; this.b = b; }
    paint(context, off) {
        if (this.child == 0) { return 0; }
        let canvas = context.canvas; let cx = off.dx + this.size.width / 2.0; let cy = off.dy + this.size.height / 2.0;
        canvas.save(); canvas.translate(cx, cy);
        if (this.kind == "rotate") { canvas.rotate(this.a); }
        if (this.kind == "scale") { canvas.scale(this.a, this.b); }
        canvas.translate(-cx, -cy);
        context.paintChild(this.child, off);
        canvas.restore();
    }
}

// ---- RenderClipRRect (a proxy; the SDF backend has no stencil clip) ----
class RenderClipRRect extends RenderProxyBox {
    constructor(radius) { super(); this.radius = radius; }
}

// ---- RenderPointerListener (Listener / GestureDetector backing) ----
class RenderPointerListener extends RenderProxyBox {
    constructor(handlers, behavior) { super(); this.handlers = handlers; this.behavior = behavior; }
    hitTestSelf(pos) { if (this.behavior == "opaque") { return true; } if (this.behavior == "translucent") { return true; } return false; }
    // Called by the binding when a pointer event lands on this listener.
    handleEvent(event) {
        let h = this.handlers;
        if (event.type == "pointerdown") { if (has(h, "onPointerDown")) { h.onPointerDown(event); } }
        if (event.type == "pointerup") { if (has(h, "onPointerUp")) { h.onPointerUp(event); } }
        if (event.type == "pointermove") { if (has(h, "onPointerMove")) { h.onPointerMove(event); } }
    }
}

// ------------------------------------------------------------- RenderView -----
// The root of the render tree. Sized to the surface (in logical px), it lays out
// its child with tight constraints and ties the tree to the frame pipeline.
class RenderView extends RenderObject {
    constructor() { super(); this._isRenderObject = 1.0; this.child = 0; this.size = new Size(0.0, 0.0); this.configSize = new Size(1.0, 1.0); }
    setChild(c) { if (sameRef(this.child, c)) { return 0; } if (this.child != 0) { this.dropChild(this.child); } this.child = c; if (c != 0) { this.adoptChild(c); } }
    visitChildren(fn) { if (this.child != 0) { fn(this.child); } }
    redepthChildren() { if (this.child != 0) { this.redepthChild(this.child); } }
    setConfiguration(w, h) {
        let changed = 0.0;
        if (this.configSize.width != w) { changed = 1.0; } if (this.configSize.height != h) { changed = 1.0; }
        this.configSize = new Size(w, h);
        if (changed > 0.5) {
            this._needsLayout = 1.0; this._relayoutBoundary = this;
            if (this.owner != 0) { push(this.owner.layoutDirty, this); }
        }
    }
    sizedByParent() { return 1.0; }
    performResize() { this.size = this.configSize; }
    performLayout() {
        this.size = this.configSize;
        if (this.child != 0) { this.child.layout(constraintsTight(this.size), 0.0); }
    }
    layout(constraints, parentUsesSize) { this._constraints = 0; this._relayoutBoundary = this; if (this.sizedByParent() > 0.5) { this.performResize(); } this.performLayout(); this._needsLayout = 0.0; }
    paint(context, off) { if (this.child != 0) { context.paintChild(this.child, off); } }
    hitTest(result, pos) {
        if (this.child != 0) { this.child.hitTest(result, pos); }
        result.add(new HitTestEntry(this, pos));
        return true;
    }
    paintFromRoot(context) { this.paintWithContext(context, OFFSET_ZERO); }
}
