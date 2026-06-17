// Elpa Material — the Widget base class.
//
// Every widget is a `Widget` subclass: an immutable description (its props, in
// `this.p`) plus the polymorphic `measureIntrinsic`/`paint` that the old giant
// `_measureKind`/`_paint` switches used to dispatch by a `kind` string. The
// retained-tree protocol — mount, compose, reassemble, bucket — lives here too,
// so adding a widget is just a new subclass, with no central switch to edit.
//
// Layout/paint cache fields each widget instance carries:
//   _parent           — its parent node (wired at mount)
//   _cx,_cy           — its painted centre (so a partial update repaints in place)
//   _fw,_fh           — a tight constraint a parent forces (-1.0 = none)
//   _self/_selfTaps/_selfDrags — a container's own decoration buffers
//   _kids             — the children it actually painted (z-order)
//   _over             — on-top decoration (badges, scrollbars)
//   _out/_taps/_drags — its subtree's assembled instances + hit regions
class Widget {
    constructor(p) { this.p = p; this._fw = -1.0; this._fh = -1.0; }

    // Structural children, in z-order — used by `mount` (and tree reassembly).
    // `child`/`children` props are the common cases; containers override.
    children(app) {
        if (has(this.p, "children")) { return this.p.children; }
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { return [this.p.child]; } }
        return [];
    }
    // Build the retained tree: wire parents and recurse. `Component` overrides to
    // run its function and mount the produced subtree.
    mount(app, parent) {
        this._parent = parent;
        let kids = this.children(app);
        for (let i = 0; i < len(kids); i++) { kids[i].mount(app, this); }
    }

    // Intrinsic content size by kind (overridden). `measure` wraps it to honour a
    // parent's tight constraint (`_fw`/`_fh`), the Flutter behaviour.
    measureIntrinsic(app) { return { w: 0.0, h: 0.0 }; }
    measure(app) {
        let m = this.measureIntrinsic(app);
        if (this._fw >= 0.0) { m.w = this._fw; }
        if (this._fh >= 0.0) { m.h = this._fh; }
        return m;
    }

    // Layout predicates (replace `kind ==` checks in parent layout code).
    flexFactor() { return 0.0; }   // Expanded/Flexible report their flex here
    isPositioned() { return 0.0; } // Positioned (inside a Stack)
    scrollFill() { return 0.0; }   // ListView/GridView fill the scaffold body

    // Paint into the runtime's buffers (overridden). Default: an empty leaf.
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); }

    // Shared single-child layouts reused by several widgets.
    // Centre the child on (cx,cy).
    paintCenter(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app); let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }
    // Inset the child by `pad` (padding / safe area), shifting it by the asymmetry.
    paintInset(app, cx, cy, pad) {
        this._cx = cx; this._cy = cy; this.beginSelf(app); let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx + (pad.l - pad.r) / 2.0, cy + (pad.t - pad.b) / 2.0); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }

    // Start a container's own decoration buffers and point the painter at them.
    // Decoration drawn now sits behind children painted next; `_over` lands on top.
    beginSelf(app) {
        this._self = []; this._selfTaps = []; this._selfDrags = []; this._over = [];
        app.painter.into(this._self, this._selfTaps, this._selfDrags);
    }
    // Start a leaf's buffers: it emits straight into `_out`.
    beginLeaf(app) {
        this._out = []; this._taps = []; this._drags = [];
        this._self = this._out; this._kids = [];
        app.painter.into(this._out, this._taps, this._drags);
    }
    // Compose `_out`/`_taps`/`_drags` from own decoration + children + overlay.
    // A leaf (no `_selfTaps`) already holds its output, so this is a no-op for it.
    compose() {
        if (!has(this, "_selfTaps")) { return 0; }
        let kids = this._kids;
        let o = concat([], this._self); let t = concat([], this._selfTaps); let d = concat([], this._selfDrags);
        for (let i = 0; i < len(kids); i++) { o = concat(o, kids[i]._out); t = concat(t, kids[i]._taps); d = concat(d, kids[i]._drags); }
        if (has(this, "_over")) { o = concat(o, this._over); }
        this._out = o; this._taps = t; this._drags = d;
        return 0;
    }
    // Reassemble the cached output bottom-up (no fn re-run, no re-emit).
    reassemble() {
        let kids = this._kids;
        for (let i = 0; i < len(kids); i++) { kids[i].reassemble(); }
        this.compose();
        return 0;
    }
    // Split into static (non-animating) instances returned here and dynamic ones
    // pushed into `dyn`. A leaf returns its whole output.
    bucket(dyn) {
        let kids = this._kids;
        if (len(kids) == 0) { return this._out; }
        let s = concat([], this._self);
        for (let i = 0; i < len(kids); i++) { s = concat(s, kids[i].bucket(dyn)); }
        if (has(this, "_over")) { s = concat(s, this._over); }
        return s;
    }
}
