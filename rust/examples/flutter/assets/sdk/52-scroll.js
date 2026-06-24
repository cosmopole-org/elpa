// Elpa Flutter — the scrolling layer (package:flutter viewport + scrollable).
//
// A real, physics-driven scroll stack: a `ScrollPosition` holds the pixel offset
// and clamps it to the content extent; `Scrollable` turns vertical/horizontal
// drags into offset changes and hands the release velocity to a friction
// simulation (a SchedulerBinding ticker) for a smooth fling; the viewport render
// objects (`RenderScrollList` / `RenderScrollGrid`) lay their children out along
// the scroll axis, clip to the viewport (real GPU clip), and **cull** children
// outside it — so scrolling a long list is a cheap per-frame repaint of only the
// visible rows, never a relayout. ListView / ListView.builder / GridView /
// SingleChildScrollView sit on top, mirroring Flutter's widget API.

// ------------------------------------------------------------ ScrollPosition --
class ScrollPosition {
    constructor() { this._id = nextObjId(); this.pixels = 0.0; this.maxScrollExtent = 0.0; this.viewportDimension = 0.0; this._ro = 0; }
    setPixels(v) {
        let n = v; if (n < 0.0) { n = 0.0; } if (n > this.maxScrollExtent) { n = this.maxScrollExtent; }
        if (n != this.pixels) { this.pixels = n; if (this._ro != 0) { this._ro.markNeedsPaint(); } }
    }
    jumpBy(d) { this.setPixels(this.pixels + d); }
    atEdge() { if (this.pixels <= 0.0) { return -1.0; } if (this.pixels >= this.maxScrollExtent) { return 1.0; } return 0.0; }
}
class ScrollController {
    constructor(p) {
        this._id = nextObjId(); this.position = new ScrollPosition();
        if (!isNull(p)) { if (has(p, "initialScrollOffset")) { this.position.pixels = p.initialScrollOffset; } }
    }
    offset() { return this.position.pixels; }
    jumpTo(v) { this.position.setPixels(v); }
}

// A friction fling: decays velocity (px/ms) each frame and feeds it to the
// position, stopping at rest or at a content edge (Flutter's ClampingSimulation).
class FlingSimulation {
    constructor(position, velocity) { this._id = nextObjId(); this.position = position; this.velocity = velocity; }
    tickFrame(dt) {
        let v = this.velocity;
        this.position.jumpBy(v * dt);
        this.velocity = v * pow(0.9985, dt);
        let stop = 0.0;
        if (abs(this.velocity) < 0.02) { stop = 1.0; }
        if (this.position.pixels <= 0.0) { if (v < 0.0) { stop = 1.0; } }
        if (this.position.pixels >= this.position.maxScrollExtent) { if (v > 0.0) { stop = 1.0; } }
        if (stop > 0.5) { SCHED.remove(this); }
        return 0;
    }
}

// ----------------------------------------------------------- RenderScrollList -
// A viewport that stacks its children along the main axis, clips to its bounds,
// and paints/hit-tests them shifted by -scrollOffset, culling the off-screen
// ones. Scrolling only changes the offset → markNeedsPaint, never a relayout.
class RenderScrollList extends RenderBox {
    constructor(axis, position) { super(); this.axis = axis; this.position = position; this.children = []; this.spacing = 0.0; }
    isHoriz() { if (this.axis == "horizontal") { return 1.0; } return 0.0; }
    mainOf(s) { if (this.isHoriz() > 0.5) { return s.width; } return s.height; }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new BoxParentData(); } }
    syncChildren(list) { syncContainerChildren(this, list); }
    visitChildren(fn) { for (let i = 0; i < len(this.children); i++) { fn(this.children[i]); } }
    redepthChildren() { for (let i = 0; i < len(this.children); i++) { this.redepthChild(this.children[i]); } }
    performLayout() {
        let c = this._constraints; let horiz = this.isHoriz();
        this.size = c.constrain(c.biggest());
        let crossExtent = this.size.width; if (horiz > 0.5) { crossExtent = this.size.height; }
        let cc = new BoxConstraints(crossExtent, crossExtent, 0.0, INFTY);
        if (horiz > 0.5) { cc = new BoxConstraints(0.0, INFTY, crossExtent, crossExtent); }
        let pos = 0.0; let n = len(this.children);
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; ch.layout(cc, 1.0);
            if (horiz > 0.5) { ch.parentData.offset = new Offset(pos, 0.0); } else { ch.parentData.offset = new Offset(0.0, pos); }
            pos = pos + this.mainOf(ch.size) + this.spacing;
        }
        if (n > 0) { pos = pos - this.spacing; }
        let vpMain = this.size.height; if (horiz > 0.5) { vpMain = this.size.width; }
        this.position.viewportDimension = vpMain;
        this.position.maxScrollExtent = maxD(0.0, pos - vpMain);
        this.position._ro = this;
        if (this.position.pixels > this.position.maxScrollExtent) { this.position.pixels = this.position.maxScrollExtent; }
    }
    paint(context, off) {
        let canvas = context.canvas; let horiz = this.isHoriz(); let so = this.position.pixels;
        let vpMain = this.size.height; if (horiz > 0.5) { vpMain = this.size.width; }
        canvas.save();
        canvas.clipRect(rectLTWH(off.dx, off.dy, this.size.width, this.size.height));
        // Cull children fully outside the viewport — a long list repaints only its
        // visible rows. (`continue` past below-viewport rows; a break-by-index is
        // not honoured by the VM's for-loop, so we skip rather than break.)
        for (let i = 0; i < len(this.children); i++) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            let m = o.dy; if (horiz > 0.5) { m = o.dx; }
            let cm = m - so; let cs = this.mainOf(ch.size);
            if (cm + cs < 0.0) { continue; }
            if (cm > vpMain) { continue; }
            if (horiz > 0.5) { context.paintChild(ch, new Offset(off.dx + o.dx - so, off.dy + o.dy)); }
            else { context.paintChild(ch, new Offset(off.dx + o.dx, off.dy + o.dy - so)); }
        }
        canvas.restore();
    }
    hitTestChildren(result, pos) {
        let horiz = this.isHoriz(); let so = this.position.pixels;
        for (let i = len(this.children) - 1; i >= 0; i--) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            let dx = o.dx; let dy = o.dy;
            if (horiz > 0.5) { dx = dx - so; } else { dy = dy - so; }
            if (ch.hitTest(result, new Offset(pos.dx - dx, pos.dy - dy))) { return true; }
        }
        return false;
    }
}

// ----------------------------------------------------------- RenderScrollGrid -
// A scrollable grid: `crossCount` cells per row, square-ish cells sized by
// `aspect` (width/height), laid out row by row, otherwise identical to the list
// viewport (clip + cull + offset-only scrolling).
class RenderScrollGrid extends RenderBox {
    constructor(position, crossCount, spacing, aspect) { super(); this.position = position; this.crossCount = crossCount; this.spacing = spacing; this.aspect = aspect; this.children = []; this.cellH = 1.0; }
    setupParentData(child) { if (!isObj(child.parentData)) { child.parentData = new BoxParentData(); } }
    syncChildren(list) { syncContainerChildren(this, list); }
    visitChildren(fn) { for (let i = 0; i < len(this.children); i++) { fn(this.children[i]); } }
    redepthChildren() { for (let i = 0; i < len(this.children); i++) { this.redepthChild(this.children[i]); } }
    performLayout() {
        let c = this._constraints; this.size = c.constrain(c.biggest());
        let n = len(this.children); let cc = this.crossCount;
        let cellW = (this.size.width - this.spacing * (cc - 1.0)) / cc;
        let cellH = cellW / this.aspect; this.cellH = cellH;
        let cellC = new BoxConstraints(cellW, cellW, cellH, cellH);
        for (let i = 0; i < n; i++) {
            let ch = this.children[i]; ch.layout(cellC, 1.0);
            let col = i % cc; let row = floor(i / cc);
            let x = col * (cellW + this.spacing); let y = row * (cellH + this.spacing);
            ch.parentData.offset = new Offset(x, y);
        }
        let rows = ceil(n / cc); let contentH = rows * cellH + maxD(0.0, rows - 1.0) * this.spacing;
        this.position.viewportDimension = this.size.height;
        this.position.maxScrollExtent = maxD(0.0, contentH - this.size.height);
        this.position._ro = this;
        if (this.position.pixels > this.position.maxScrollExtent) { this.position.pixels = this.position.maxScrollExtent; }
    }
    paint(context, off) {
        let canvas = context.canvas; let so = this.position.pixels;
        canvas.save(); canvas.clipRect(rectLTWH(off.dx, off.dy, this.size.width, this.size.height));
        for (let i = 0; i < len(this.children); i++) {
            let ch = this.children[i]; let o = ch.parentData.offset; let cm = o.dy - so;
            if (cm + this.cellH < 0.0) { continue; }
            if (cm > this.size.height) { continue; }
            context.paintChild(ch, new Offset(off.dx + o.dx, off.dy + o.dy - so));
        }
        canvas.restore();
    }
    hitTestChildren(result, pos) {
        let so = this.position.pixels;
        for (let i = len(this.children) - 1; i >= 0; i--) {
            let ch = this.children[i]; let o = ch.parentData.offset;
            if (ch.hitTest(result, new Offset(pos.dx - o.dx, pos.dy - (o.dy - so)))) { return true; }
        }
        return false;
    }
}

// --------------------------------------------------------- viewport widgets ----
class ListViewportWidget extends MultiChildRenderObjectWidget {
    constructor(p) { super(p); this.axis = p.axis; this.position = p.position; this.spacing = 0.0; if (has(p, "spacing")) { this.spacing = p.spacing; } }
    typeName() { return concat("ListViewport.", this.axis); }
    createRenderObject(context) { let ro = new RenderScrollList(this.axis, this.position); ro.spacing = this.spacing; return ro; }
    updateRenderObject(context, ro) { ro.axis = this.axis; ro.position = this.position; ro.spacing = this.spacing; this.position._ro = ro; ro.markNeedsLayout(); }
}
class GridViewportWidget extends MultiChildRenderObjectWidget {
    constructor(p) { super(p); this.position = p.position; this.crossCount = p.crossAxisCount; this.spacing = 0.0; if (has(p, "spacing")) { this.spacing = p.spacing; } this.aspect = 1.0; if (has(p, "childAspectRatio")) { this.aspect = p.childAspectRatio; } }
    typeName() { return "GridViewport"; }
    createRenderObject(context) { return new RenderScrollGrid(this.position, this.crossCount, this.spacing, this.aspect); }
    updateRenderObject(context, ro) { ro.position = this.position; ro.crossCount = this.crossCount; ro.spacing = this.spacing; ro.aspect = this.aspect; this.position._ro = ro; ro.markNeedsLayout(); }
}

// ------------------------------------------------------------- Scrollable ------
// Owns the ScrollController/position, converts drags into offset changes, and
// flings on release. `builder(context, position)` returns the viewport.
class ScrollableWidget extends StatefulWidget {
    constructor(p) {
        super(p); this.axis = "vertical"; if (has(p, "axis")) { this.axis = p.axis; }
        this.controller = 0; if (has(p, "controller")) { this.controller = p.controller; }
        this.builder = p.builder;
        this.physics = "scroll"; if (has(p, "physics")) { this.physics = p.physics; }
    }
    typeName() { return "Scrollable"; }
    createState() { return new ScrollableState(); }
}
class ScrollableState extends State {
    initState() {
        this.controller = this.widget.controller; if (this.controller == 0) { this.controller = new ScrollController(); }
        this.position = this.controller.position;
        this._sim = 0; this._lastC = 0.0; this._vel = 0.0;
    }
    coordOf(e) { if (this.widget.axis == "horizontal") { return e.dx; } return e.dy; }
    onDown(e) {
        if (this._sim != 0) { SCHED.remove(this._sim); this._sim = 0; }
        this._lastC = this.coordOf(e); this._vel = 0.0;
    }
    onMove(e) {
        let cur = this.coordOf(e); let delta = this._lastC - cur; this._lastC = cur;
        this._vel = delta; this.position.jumpBy(delta);
    }
    onUp(e) {
        if (this.widget.physics == "never") { return 0; }
        let v = this._vel / 16.0;
        if (abs(v) > 0.05) { this._sim = new FlingSimulation(this.position, v); SCHED.add(this._sim); }
    }
    dispose() { if (this._sim != 0) { SCHED.remove(this._sim); } }
    build(context) {
        let self = this;
        return Listener({
            behavior: "opaque",
            onPointerDown: (e) => { self.onDown(e); },
            onPointerMove: (e) => { self.onMove(e); },
            onPointerUp: (e) => { self.onUp(e); },
            child: this.widget.builder(context, this.position),
        });
    }
}
function Scrollable(p) { return new ScrollableWidget(p); }

// ----------------------------------------------------- public constructors -----
function ListView(p) {
    if (isNull(p)) { p = {}; }
    let axis = "vertical"; if (has(p, "scrollDirection")) { axis = p.scrollDirection; }
    let kids = []; if (has(p, "children")) { kids = p.children; }
    let spacing = 0.0; if (has(p, "spacing")) { spacing = p.spacing; }
    let ctrl = 0; if (has(p, "controller")) { ctrl = p.controller; }
    return Scrollable({ axis: axis, controller: ctrl,
        builder: (ctx, pos) => new ListViewportWidget({ axis: axis, position: pos, children: kids, spacing: spacing }) });
}
// ListView.builder analog: eagerly materialise itemCount items (paint culling
// keeps the per-frame GPU cost to the visible rows).
function ListViewBuilder(p) {
    let kids = []; let n = p.itemCount;
    for (let i = 0; i < n; i++) { push(kids, p.itemBuilder(i)); }
    let q = { children: kids };
    if (has(p, "scrollDirection")) { q.scrollDirection = p.scrollDirection; }
    if (has(p, "spacing")) { q.spacing = p.spacing; }
    if (has(p, "controller")) { q.controller = p.controller; }
    return ListView(q);
}
function GridView(p) {
    let kids = []; if (has(p, "children")) { kids = p.children; }
    let cross = 2.0; if (has(p, "crossAxisCount")) { cross = p.crossAxisCount; }
    let spacing = 0.0; if (has(p, "spacing")) { spacing = p.spacing; }
    let aspect = 1.0; if (has(p, "childAspectRatio")) { aspect = p.childAspectRatio; }
    let ctrl = 0; if (has(p, "controller")) { ctrl = p.controller; }
    return Scrollable({ axis: "vertical", controller: ctrl,
        builder: (ctx, pos) => new GridViewportWidget({ position: pos, children: kids, crossAxisCount: cross, spacing: spacing, childAspectRatio: aspect }) });
}
function GridViewBuilder(p) {
    let kids = []; let n = p.itemCount;
    for (let i = 0; i < n; i++) { push(kids, p.itemBuilder(i)); }
    let q = { children: kids, crossAxisCount: p.crossAxisCount };
    if (has(p, "spacing")) { q.spacing = p.spacing; }
    if (has(p, "childAspectRatio")) { q.childAspectRatio = p.childAspectRatio; }
    if (has(p, "controller")) { q.controller = p.controller; }
    return GridView(q);
}
function SingleChildScrollView(p) {
    let axis = "vertical"; if (has(p, "scrollDirection")) { axis = p.scrollDirection; }
    let ctrl = 0; if (has(p, "controller")) { ctrl = p.controller; }
    let kids = []; if (has(p, "child")) { kids = [p.child]; }
    return Scrollable({ axis: axis, controller: ctrl,
        builder: (ctx, pos) => new ListViewportWidget({ axis: axis, position: pos, children: kids }) });
}
