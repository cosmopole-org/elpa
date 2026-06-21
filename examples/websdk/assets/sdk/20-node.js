// Elpa Web SDK - the Box base class (the CSS box model + decoration paint).
//
// Every HTML element is a `Box` subclass. A Box implements the retained-tree
// protocol the runtime drives (mount / measure / paint / compose / reassemble /
// bucket, with `_out`/`_taps`/`_drags` buffers and `_fw`/`_fh` forced sizes), and
// owns the CSS box model: content + padding + border + margin, `box-sizing`,
// min/max clamping, and the painted decoration (background colour & gradient,
// per-side borders, border-radius, box-shadow, outline) wrapped in the optional
// `transform` / `opacity` group. Layout *of children* is delegated by `display`
// to the algorithms in 30-layout.js (block/inline flow, flexbox, grid,
// positioning). All layout maths is in physical px; CSS lengths are scaled by
// the device-pixel-ratio exactly once, here, at resolve time.

let AUTO = -123456.0;
function noop() { return 0; }

// Resolve a length token to physical px against a physical `basis`. `dflt` is
// returned for auto/none.
function dpx(t, basis, d, dflt) {
    if (t.k == "px") { return t.v * d; }
    if (t.k == "pct") { return t.v * basis; }
    return dflt;
}

// The inherited context a node hands its children (root defaults at the top).
function inhOf(parent) {
    if (isNull(parent)) { return ROOT_INH; }
    if (has(parent, "_inhOut")) { return parent._inhOut; }
    return ROOT_INH;
}
// Merge author style over UA defaults (both already normalised objects).
function mergeStyle(ua, author) {
    let out = {}; let ks = keys(ua); for (let i = 0; i < len(ks); i++) { out[ks[i]] = ua[ks[i]]; }
    let ak = keys(author); for (let i = 0; i < len(ak); i++) { out[ak[i]] = author[ak[i]]; }
    return out;
}

class Box {
    constructor(tag, props) {
        this.tag = tag; this.p = props; if (isNull(props)) { this.p = {}; }
        this._fw = -1.0; this._fh = -1.0; this._cbW = -1.0; this._cbH = -1.0;
    }
    // The structural children (Box nodes). String children are wrapped as TextRun
    // by the API layer, so everything here is a node.
    kids() {
        if (has(this.p, "children")) { return this.p.children; }
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { return [this.p.child]; } }
        return [];
    }
    // The element's user-agent default style (overridden per element).
    uaStyle() { return {}; }

    // A hook subclasses override to prepare props before style is computed (the
    // VM has no `super.method()`, so this replaces an overridden `mount`).
    premount(app) { return 0; }

    // ---- mount: compute style top-down, recurse ------------------------------
    mount(app, parent) {
        this._parent = parent; this._d = app.metrics.dpr;
        this._sidNum = app.sidN; app.sidN = app.sidN + 1;
        this.premount(app);
        let inh = inhOf(parent);
        let author = normalizeStyle(sv(this.p, "style"));
        // :hover - merge `hoverStyle` while the pointer is over this id'd element.
        if (has(this.p, "hoverStyle")) { if (has(this.p, "id")) { if (app.isHovered(this.p.id) > 0.5) { author = mergeStyle(author, normalizeStyle(this.p.hoverStyle)); } } }
        let raw = mergeStyle(this.uaStyle(), author);
        this._raw = raw;
        this._cs = computeStyle(raw, inh, app.metrics);
        this._inhOut = this._cs.childInh;
        // Normalise children: wrap raw string/number children as TextRun nodes.
        let rawk = this.kids(); let ch = [];
        for (let i = 0; i < len(rawk); i++) { let k = rawk[i];
            if (!isNull(k)) { if (typeOf(k) != "object") { k = new TextRun(str(k)); } push(ch, k); } }
        this._childNodes = ch;
        for (let i = 0; i < len(ch); i++) { ch[i].mount(app, this); }
    }
    // Stable scroll/identity key (author id if given, else a structural counter).
    nodeKey() { if (has(this.p, "id")) { return this.p.id; } return concat("#", str(this._sidNum)); }

    // ---- box-model arithmetic (physical px) ----------------------------------
    cbW() { if (this._cbW >= 0.0) { return this._cbW; } return VPGLOBAL.vw; }
    cbH() { if (this._cbH >= 0.0) { return this._cbH; } return VPGLOBAL.vh; }
    borderPhys() { let c = this._cs; let d = this._d; return { t: c.bw.t * d, r: c.bw.r * d, b: c.bw.b * d, l: c.bw.l * d }; }
    padPhys() { let c = this._cs; let d = this._d; let w = this.cbW(); return { t: dpx(c.p.t, w, d, 0.0), r: dpx(c.p.r, w, d, 0.0), b: dpx(c.p.b, w, d, 0.0), l: dpx(c.p.l, w, d, 0.0) }; }
    marginPhys() { let c = this._cs; let d = this._d; let w = this.cbW(); return { t: dpx(c.m.t, w, d, 0.0), r: dpx(c.m.r, w, d, AUTO), b: dpx(c.m.b, w, d, 0.0), l: dpx(c.m.l, w, d, AUTO) }; }
    marginAuto() { let c = this._cs; return { l: isAuto(c.m.l), r: isAuto(c.m.r), t: isAuto(c.m.t), b: isAuto(c.m.b) }; }

    // Resolve the border-box width. Returns AUTO when width is auto and no forced
    // width is set (the caller then uses available / shrink-to-fit).
    resolvedW(app) {
        let c = this._cs; let d = this._d; let cbw = this.cbW();
        let extra = (c.bw.l + c.bw.r) * d + dpx(c.p.l, cbw, d, 0.0) + dpx(c.p.r, cbw, d, 0.0);
        let w = AUTO;
        if (!isAuto(c.width)) { let wv = dpx(c.width, cbw, d, AUTO); w = wv; if (c.boxSizing != "border-box") { w = wv + extra; } }
        else { if (this._fw >= 0.0) { w = this._fw; } }
        return this.clampW(app, w, extra);
    }
    clampW(app, w, extra) {
        let c = this._cs; let d = this._d; let cbw = this.cbW();
        if (w == AUTO) { return AUTO; }
        let mn = dpx(c.minWidth, cbw, d, 0.0); if (c.minWidth.k != "none") { let mnv = mn; if (c.boxSizing != "border-box") { if (!isAuto(c.minWidth)) { mnv = mn + extra; } } if (w < mnv) { w = mnv; } }
        if (c.maxWidth.k != "none") { let mx = dpx(c.maxWidth, cbw, d, AUTO); if (mx != AUTO) { if (c.boxSizing != "border-box") { mx = mx + extra; } if (w > mx) { w = mx; } } }
        return w;
    }
    clampH(app, h, extra) {
        let c = this._cs; let d = this._d; let cbh = this.cbH();
        let mn = dpx(c.minHeight, cbh, d, 0.0); if (mn > 0.0) { let mnv = mn; if (c.boxSizing != "border-box") { mnv = mn + extra; } if (h < mnv) { h = mnv; } }
        if (c.maxHeight.k != "none") { let mx = dpx(c.maxHeight, cbh, d, AUTO); if (mx != AUTO) { if (c.boxSizing != "border-box") { mx = mx + extra; } if (h > mx) { h = mx; } } }
        return h;
    }

    // ---- measure (border-box size) -------------------------------------------
    measureIntrinsic(app) { return this.baseMeasureIntrinsic(app); }
    baseMeasureIntrinsic(app) {
        let c = this._cs; if (c.display == "none") { return { w: 0.0, h: 0.0 }; }
        let d = this._d; let cbw = this.cbW();
        let bx = (c.bw.l + c.bw.r) * d; let by = (c.bw.t + c.bw.b) * d;
        let pxx = dpx(c.p.l, cbw, d, 0.0) + dpx(c.p.r, cbw, d, 0.0);
        let pyy = dpx(c.p.t, cbw, d, 0.0) + dpx(c.p.b, cbw, d, 0.0);
        let w = this.resolvedW(app);
        if (w == AUTO) { w = this.maxContentW(app) + pxx + bx; w = this.clampW(app, w, pxx + bx); }
        let contentW = w - pxx - bx; if (contentW < 0.0) { contentW = 0.0; }
        // Height: explicit, forced, or from a layout pass over the content width.
        let h = AUTO;
        if (!isAuto(c.height)) { let hv = dpx(c.height, this.cbH(), d, AUTO); if (hv != AUTO) { h = hv; if (c.boxSizing != "border-box") { h = hv + pyy + by; } } }
        if (h == AUTO) { if (this._fh >= 0.0) { h = this._fh; } }
        if (h == AUTO) { let lay = this.layoutChildren(app, contentW, AUTO); h = lay.h + pyy + by; }
        h = this.clampH(app, h, pyy + by);
        return { w: w, h: h };
    }
    measure(app) {
        let m = this.measureIntrinsic(app);
        if (this._fw >= 0.0) { m.w = this._fw; }
        if (this._fh >= 0.0) { m.h = this._fh; }
        return m;
    }
    // Shrink-to-fit max-content width (used when width is auto and unconstrained).
    maxContentW(app) {
        let ch = this._childNodes; let mw = 0.0;
        for (let i = 0; i < len(ch); i++) { let cm = ch[i].measure(app); if (cm.w > mw) { mw = cm.w; } }
        return mw;
    }

    // Layout predicates used by parent layout (flex/positioning).
    isInline() { let dsp = this._cs.display; if (dsp == "inline") { return 1.0; } if (dsp == "inline-block") { return 1.0; } if (dsp == "inline-flex") { return 1.0; } return 0.0; }
    isAbs() { let pos = this._cs.position; if (pos == "absolute") { return 1.0; } if (pos == "fixed") { return 1.0; } return 0.0; }

    // ---- paint ----------------------------------------------------------------
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let c = this._cs;
        if (c.display == "none") { this.beginLeaf(app); return 0; }
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        this.beginSelf(app);
        let pnt = app.painter;
        let needsSave = 0.0;
        if (len(c.transform) > 0) { needsSave = 1.0; }
        if (c.opacity < 0.999) { needsSave = 1.0; }
        if (needsSave > 0.5) {
            pnt.save();
            if (len(c.transform) > 0) { this.applyTransform(pnt, cx, cy); }
            if (c.opacity < 0.999) { pnt.setAlpha(c.opacity); }
        }
        let vis = 1.0; if (c.visibility == "hidden") { vis = 0.0; }
        if (vis > 0.5) { this.drawDecoration(app, cx, cy, hw, hh); }
        this.registerInput(app, cx, cy, hw, hh);
        let outKids = this.paintChildren(app, cx, cy, hw, hh, vis);
        if (needsSave > 0.5) { pnt.restore(); }
        this._kids = outKids; this.compose();
    }
    // Register pointer/keyboard hit regions for this element (click, focus, hover).
    registerInput(app, cx, cy, hw, hh) {
        let pe = this._cs.pointerEvents; if (pe == "none") { return 0; }
        let needTap = 0.0; if (has(this.p, "onClick")) { needTap = 1.0; } if (has(this.p, "_focusKey")) { needTap = 1.0; }
        if (needTap > 0.5) {
            let onTap = noop; if (has(this.p, "onClick")) { onTap = this.p.onClick; }
            let tap = { cx: cx, cy: cy, hw: hw, hh: hh, id: this.nodeKey(), onTap: onTap };
            if (has(this.p, "_focusKey")) { tap.focus = this.p._focusKey; tap.keyFn = this.p._onKey; }
            push(app.painter.taps, tap);
        }
        if (has(this.p, "hoverStyle")) { if (has(this.p, "id")) { push(app.hovers, { cx: cx, cy: cy, hw: hw, hh: hh, id: this.p.id }); } }
        return 0;
    }
    applyTransform(pnt, cx, cy) {
        let ops = this._cs.transform; let d = this._d;
        pnt.translate(cx, cy);
        for (let i = 0; i < len(ops); i++) {
            let o = ops[i];
            if (o.t == "tr") { pnt.translate(o.x * d, o.y * d); }
            if (o.t == "sc") { pnt.scale(o.x, o.y); }
            if (o.t == "rot") { pnt.rotate(o.a); }
        }
        pnt.translate(-cx, -cy);
    }

    // The single uniform corner radius the SDF primitive supports (the average of
    // the four CSS corners; equal corners — the common case — are exact).
    radiusPhys(hw, hh) {
        let c = this._cs; let d = this._d; let basis = min(hw, hh) * 2.0;
        let tl = dpx(c.radius.tl, basis, d, 0.0); let tr = dpx(c.radius.tr, basis, d, 0.0);
        let br = dpx(c.radius.br, basis, d, 0.0); let bl = dpx(c.radius.bl, basis, d, 0.0);
        let r = (tl + tr + br + bl) / 4.0; let mx = min(hw, hh); if (r > mx) { r = mx; }
        return r;
    }
    // Paint background, border, shadows, outline for the border box at (cx,cy).
    drawDecoration(app, cx, cy, hw, hh) { this.baseDecoration(app, cx, cy, hw, hh); }
    baseDecoration(app, cx, cy, hw, hh) {
        let c = this._cs; let pnt = app.painter; let d = this._d; let r = this.radiusPhys(hw, hh);
        // Outer box-shadows (drop), painted first so they sit behind the box.
        for (let i = 0; i < len(c.boxShadow); i++) {
            let s = c.boxShadow[i];
            if (s.inset < 0.5) {
                let sp = s.spread * d; let bl = s.blur * d;
                pnt.shadowCol(cx + s.x * d, cy + s.y * d, hw + sp, hh + sp, r, bl * 0.5, 0.0, bl + 1.0, s.color);
            }
        }
        // Gradient or solid background fill (the padding box = border box here).
        if (c.bgGradient != 0) { this.paintGradient(app, c.bgGradient, cx, cy, hw, hh, r); }
        else { if (c.bgColor[3] > 0.0) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, c.bgColor, CLEAR); } }
        // Borders: uniform fast path (one SDF border) or per-side edges.
        this.drawBorders(app, cx, cy, hw, hh, r);
        // Outline (drawn just outside the border box, no radius contribution).
        if (c.outline != 0) { if (c.outline.w > 0.0) { if (c.outline.style != "none") {
            let ow = c.outline.w * d; pnt.rect(cx, cy, hw + ow, hh + ow, r + ow, ow, 0.0, CLEAR, c.outline.color);
        } } }
    }
    drawBorders(app, cx, cy, hw, hh, r) {
        let c = this._cs; let pnt = app.painter; let d = this._d;
        let bt = c.bw.t * d; let brr = c.bw.r * d; let bb = c.bw.b * d; let bl = c.bw.l * d;
        if (bt < 0.01) { if (brr < 0.01) { if (bb < 0.01) { if (bl < 0.01) { return 0; } } } }
        let uniform = 1.0;
        if (bt != brr) { uniform = 0.0; } if (brr != bb) { uniform = 0.0; } if (bb != bl) { uniform = 0.0; }
        if (colEq(c.bc.t, c.bc.r) < 0.5) { uniform = 0.0; } if (colEq(c.bc.r, c.bc.b) < 0.5) { uniform = 0.0; } if (colEq(c.bc.b, c.bc.l) < 0.5) { uniform = 0.0; }
        if (uniform > 0.5) { pnt.rect(cx, cy, hw, hh, r, bt, 0.0, CLEAR, c.bc.t); return 0; }
        // Per-side: draw each non-zero edge as a flat rect just inside the box.
        if (bt > 0.01) { pnt.rect(cx, cy - hh + bt / 2.0, hw, bt / 2.0, 0.0, 0.0, 0.0, c.bc.t, CLEAR); }
        if (bb > 0.01) { pnt.rect(cx, cy + hh - bb / 2.0, hw, bb / 2.0, 0.0, 0.0, 0.0, c.bc.b, CLEAR); }
        if (bl > 0.01) { pnt.rect(cx - hw + bl / 2.0, cy, bl / 2.0, hh, 0.0, 0.0, 0.0, c.bc.l, CLEAR); }
        if (brr > 0.01) { pnt.rect(cx + hw - brr / 2.0, cy, brr / 2.0, hh, 0.0, 0.0, 0.0, c.bc.r, CLEAR); }
        return 0;
    }
    paintGradient(app, g, cx, cy, hw, hh, r) {
        let pnt = app.painter; let stops = [];
        for (let i = 0; i < len(g.colors); i++) { push(stops, { t: g.stops[i], col: g.colors[i] }); }
        if (g.type == "radial") { pnt.gradRadial(cx, cy, max(hw, hh), stops); return 0; }
        if (g.type == "sweep") { pnt.gradSweep(cx, cy, max(hw, hh), stops, g.start); return 0; }
        pnt.gradLinear(cx, cy, hw, hh, r, stops, g.begin[0], g.begin[1], g.end[0], g.end[1]);
        return 0;
    }

    // Dispatch child layout+paint by `display`. Returns the painted child nodes.
    paintChildren(app, cx, cy, hw, hh, vis) {
        let c = this._cs; let d = this._d;
        let bl = c.bw.l * d; let bt = c.bw.t * d; let cbw = this.cbW();
        let pl = dpx(c.p.l, cbw, d, 0.0); let pt = dpx(c.p.t, cbw, d, 0.0);
        let pr = dpx(c.p.r, cbw, d, 0.0); let pb = dpx(c.p.b, cbw, d, 0.0);
        let contentW = hw * 2.0 - bl - (c.bw.r * d) - pl - pr; if (contentW < 0.0) { contentW = 0.0; }
        let contentH = hh * 2.0 - bt - (c.bw.b * d) - pt - pb; if (contentH < 0.0) { contentH = 0.0; }
        let left = cx - hw + bl + pl; let top = cy - hh + bt + pt;
        let lay = this.layoutChildren(app, contentW, contentH);
        let outKids = [];
        if (vis < 0.5) { return outKids; }
        // overflow: scroll/auto - offset content by the scroll position, register
        // a scroll region for the event loop, and cull rows outside the viewport.
        let scrollY = 0.0; let scrolls = 0.0; let maxOff = 0.0;
        let oy = c.overflowY;
        if (oy == "scroll") { scrolls = 1.0; } if (oy == "auto") { scrolls = 1.0; } if (oy == "hidden") { scrolls = 1.0; }
        if (scrolls > 0.5) {
            maxOff = lay.h - contentH; if (maxOff < 0.0) { maxOff = 0.0; }
            let key = concat("ov:", this.nodeKey());
            let off = 0.0; if (has(app.scroll, key)) { off = app.scroll[key]; }
            if (off > maxOff) { off = maxOff; } if (off < 0.0) { off = 0.0; }
            app.scroll[key] = off; scrollY = off;
            if (oy != "hidden") { app.listRegions[key] = { cx: cx, cy: cy, hw: hw, hh: hh, maxOff: maxOff }; }
        }
        // Emit this block's own text-run glyphs (painter still points at _self).
        if (has(lay, "text")) { let tf = lay.text; let pnt = app.painter;
            for (let i = 0; i < len(tf); i++) { let g = tf[i];
                let gy = top + g.y - scrollY; let vis2 = 1.0;
                if (scrolls > 0.5) { if (gy < cy - hh - g.cell * 7.0) { vis2 = 0.0; } if (gy > cy + hh + g.cell * 7.0) { vis2 = 0.0; } }
                if (vis2 > 0.5) { app.font.paintCentered(pnt, g.str, left + g.x, gy, g.cell, g.col, g.thick, 0); } } }
        let place = lay.place;
        for (let i = 0; i < len(place); i++) {
            let pl2 = place[i]; let node = pl2.node;
            let ny = top + pl2.y - scrollY; let vis3 = 1.0;
            if (scrolls > 0.5) { if (node._cs.position != "fixed") { if (ny < cy - hh - hh) { vis3 = 0.0; } if (ny > cy + hh + hh) { vis3 = 0.0; } } }
            if (vis3 > 0.5) { node.paint(app, left + pl2.x, ny); push(outKids, node); }
        }
        if (scrolls > 0.5) { if (maxOff > 0.5) { this.paintScrollbar(app, cx, cy, hw, hh, scrollY, maxOff, contentH, lay.h); } }
        return outKids;
    }
    paintScrollbar(app, cx, cy, hw, hh, off, maxOff, viewport, total) {
        let pnt = app.painter; pnt.outInto(this._over);
        let trackH = hh * 2.0; let thumbH = trackH * viewport / total; if (thumbH < 16.0) { thumbH = 16.0; }
        let frac = off / maxOff; let thumbCy = (cy - hh) + thumbH / 2.0 + frac * (trackH - thumbH);
        pnt.rect(cx + hw - 4.0, thumbCy, 3.0, thumbH / 2.0, 3.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.32], CLEAR);
    }
    // Compute child placements (centres relative to content-box top-left) and the
    // content height. Delegated by display to 30-layout.js.
    layoutChildren(app, contentW, contentH) {
        let dsp = this._cs.display;
        if (dsp == "flex") { return flexLayout(app, this, contentW, contentH); }
        if (dsp == "inline-flex") { return flexLayout(app, this, contentW, contentH); }
        if (dsp == "grid") { return gridLayout(app, this, contentW, contentH); }
        if (dsp == "inline-grid") { return gridLayout(app, this, contentW, contentH); }
        return flowLayout(app, this, contentW, contentH);
    }

    // ---- retained-tree protocol (mirrors the runtime's expectations) ----------
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
        let o = concat([], this._self); let t = concat([], this._selfTaps); let dd = concat([], this._selfDrags);
        for (let i = 0; i < len(kids); i++) { o = concat(o, kids[i]._out); t = concat(t, kids[i]._taps); dd = concat(dd, kids[i]._drags); }
        if (has(this, "_over")) { o = concat(o, this._over); }
        this._out = o; this._taps = t; this._drags = dd;
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

// rgba equality (for the uniform-border fast path).
function colEq(a, b) {
    if (a[0] != b[0]) { return 0.0; } if (a[1] != b[1]) { return 0.0; }
    if (a[2] != b[2]) { return 0.0; } if (a[3] != b[3]) { return 0.0; }
    return 1.0;
}
