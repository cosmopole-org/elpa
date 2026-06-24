// Elpa Liquid Glass — the Widget base class.
//
// Every widget is a `Widget` subclass: an immutable description (its props, in
// `this.p`) plus the polymorphic `measureIntrinsic`/`paint`. The retained-tree
// protocol — mount, compose, reassemble, bucket — lives here, so adding a widget
// is just a new subclass with no central switch to edit. Each node emits a flat
// stream of 20-float instances into the runtime's buffers; the submitter later
// partitions that one stream into the backdrop / glass / ink draws by instance
// kind, so widgets never think about passes.
class Widget {
    constructor(p) { this.p = p; this._fw = -1.0; this._fh = -1.0; }

    children(app) {
        if (has(this.p, "children")) { return this.p.children; }
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { return [this.p.child]; } }
        return [];
    }
    mount(app, parent) {
        this._parent = parent;
        let kids = this.children(app);
        for (let i = 0; i < len(kids); i++) { kids[i].mount(app, this); }
    }

    measureIntrinsic(app) { return { w: 0.0, h: 0.0 }; }
    measure(app) {
        let m = this.measureIntrinsic(app);
        if (this._fw >= 0.0) { m.w = this._fw; }
        if (this._fh >= 0.0) { m.h = this._fh; }
        return m;
    }

    flexFactor() { return 0.0; }
    isPositioned() { return 0.0; }
    scrollFill() { return 0.0; }

    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); }

    paintCenter(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app); let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }
    paintInset(app, cx, cy, pad) {
        this._cx = cx; this._cy = cy; this.beginSelf(app); let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx + (pad.l - pad.r) / 2.0, cy + (pad.t - pad.b) / 2.0); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }

    beginSelf(app) {
        this._self = []; this._selfTaps = []; this._selfDrags = []; this._over = [];
        app.painter.into(this._self, this._selfTaps, this._selfDrags);
    }
    beginLeaf(app) {
        this._out = []; this._taps = []; this._drags = [];
        this._self = this._out; this._kids = [];
        app.painter.into(this._out, this._taps, this._drags);
    }
    compose() {
        if (!has(this, "_selfTaps")) { return 0; }
        let kids = this._kids;
        let o = concat([], this._self); let t = concat([], this._selfTaps); let d = concat([], this._selfDrags);
        for (let i = 0; i < len(kids); i++) { o = concat(o, kids[i]._out); t = concat(t, kids[i]._taps); d = concat(d, kids[i]._drags); }
        if (has(this, "_over")) { o = concat(o, this._over); }
        this._out = o; this._taps = t; this._drags = d;
        return 0;
    }
    reassemble() {
        let kids = this._kids;
        for (let i = 0; i < len(kids); i++) { kids[i].reassemble(); }
        this.compose();
        return 0;
    }
    bucket(dyn) {
        let kids = this._kids;
        if (len(kids) == 0) { return this._out; }
        let s = concat([], this._self);
        for (let i = 0; i < len(kids); i++) { s = concat(s, kids[i].bucket(dyn)); }
        if (has(this, "_over")) { s = concat(s, this._over); }
        return s;
    }
}
