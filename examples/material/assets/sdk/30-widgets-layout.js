// Elpa Material — layout widgets (Flutter's box model + the Scaffold).
//
// Column/Row (with flex + cross/main alignment), the decorated box family
// (Container/Padding/SafeArea/Center/Align/SizedBox/Expanded/Positioned), Stack,
// Wrap, the scrollable ListView/GridView, the Scaffold chrome coordinator, Badge
// and ExpansionTile. Each is a `Widget` subclass implementing `measureIntrinsic`
// and `paint`; child measures are computed once per layout (no repeated
// recursive re-measures), which is both clearer and cheaper than the old code.

// Main-axis distribution of slack beyond the packed children (Flutter's
// MainAxisAlignment): start | center | end | between | around | evenly.
function mainDist(p, extra, nc) {
    let lead = 0.0; let between = 0.0;
    if (extra > 0.0) {
        if (has(p, "main")) {
            let mm = p.main;
            if (mm == "center") { lead = extra / 2.0; }
            if (mm == "end") { lead = extra; }
            if (mm == "between") { if (nc > 1) { between = extra / (nc - 1); } else { lead = extra / 2.0; } }
            if (mm == "around") { let g = extra / nc; lead = g / 2.0; between = g; }
            if (mm == "evenly") { let g = extra / (nc + 1); lead = g; between = g; }
        }
    }
    return { lead: lead, between: between };
}

// Vertical stack. Content-sized and centred by default; honours an explicit
// height, a `cross` alignment, and `Expanded` children sharing the leftover.
class ColumnWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let kids = this.p.children; let nc = len(kids); let gap = m.gapPx(this.p);
        let mw = 0.0; let h = 0.0;
        for (let i = 0; i < nc; i++) { let c = kids[i].measure(app); if (c.w > mw) { mw = c.w; } h = h + c.h; }
        if (nc > 1) { h = h + gap * (nc - 1); }
        if (has(this.p, "width")) { mw = this.p.width * m.u; }
        if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: mw, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let gap = m.gapPx(p); let kids = p.children; let nc = len(kids);
        let main = mz.h; if (has(p, "height")) { main = p.height * m.u; }
        let fixed = 0.0; let flexTotal = 0.0; let cms = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = ch.measure(app); push(cms, cm);
            let fx = ch.flexFactor(); if (fx > 0.0) { flexTotal = flexTotal + fx; } else { fixed = fixed + cm.h; }
        }
        if (nc > 1) { fixed = fixed + gap * (nc - 1); }
        let extra = main - fixed; if (extra < 0.0) { extra = 0.0; }
        let dist = { lead: 0.0, between: 0.0 }; if (flexTotal < 0.5) { dist = mainDist(p, extra, nc); }
        let top = cy - main / 2.0 + dist.lead; let outKids = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = cms[i]; let chh = cm.h; let fx = ch.flexFactor();
            if (fx > 0.0) {
                chh = 0.0; if (flexTotal > 0.0) { chh = extra * fx / flexTotal; }
                if (has(ch.p, "child")) { ch.p.child._fh = chh; }
            }
            let ccx = cx; let cw = cm.w;
            if (has(p, "cross")) {
                if (p.cross == "start") { ccx = cx - mz.w / 2.0 + cw / 2.0; }
                if (p.cross == "end") { ccx = cx + mz.w / 2.0 - cw / 2.0; }
            }
            ch.paint(app, ccx, top + chh / 2.0); top = top + chh + gap + dist.between; push(outKids, ch);
            if (fx > 0.0) { if (has(ch.p, "child")) { ch.p.child._fh = -1.0; } }
        }
        this._kids = outKids; this.compose();
    }
}

// Horizontal stack — the row analog of ColumnWidget.
class RowWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let kids = this.p.children; let nc = len(kids); let gap = m.gapPx(this.p);
        let w = 0.0; let mh = 0.0;
        for (let i = 0; i < nc; i++) { let c = kids[i].measure(app); w = w + c.w; if (c.h > mh) { mh = c.h; } }
        if (nc > 1) { w = w + gap * (nc - 1); }
        if (has(this.p, "width")) { w = this.p.width * m.u; }
        if (has(this.p, "height")) { mh = this.p.height * m.u; }
        return { w: w, h: mh };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let gap = m.gapPx(p); let kids = p.children; let nc = len(kids);
        let main = mz.w; if (has(p, "width")) { main = p.width * m.u; }
        let fixed = 0.0; let flexTotal = 0.0; let cms = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = ch.measure(app); push(cms, cm);
            let fx = ch.flexFactor(); if (fx > 0.0) { flexTotal = flexTotal + fx; } else { fixed = fixed + cm.w; }
        }
        if (nc > 1) { fixed = fixed + gap * (nc - 1); }
        let extra = main - fixed; if (extra < 0.0) { extra = 0.0; }
        let dist = { lead: 0.0, between: 0.0 }; if (flexTotal < 0.5) { dist = mainDist(p, extra, nc); }
        let left = cx - main / 2.0 + dist.lead; let outKids = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = cms[i]; let cw = cm.w; let fx = ch.flexFactor();
            if (fx > 0.0) {
                cw = 0.0; if (flexTotal > 0.0) { cw = extra * fx / flexTotal; }
                if (has(ch.p, "child")) { ch.p.child._fw = cw; }
            }
            let ccy = cy; let chh2 = cm.h;
            if (has(p, "cross")) {
                if (p.cross == "start") { ccy = cy - mz.h / 2.0 + chh2 / 2.0; }
                if (p.cross == "end") { ccy = cy + mz.h / 2.0 - chh2 / 2.0; }
            }
            ch.paint(app, left + cw / 2.0, ccy); left = left + cw + gap + dist.between; push(outKids, ch);
            if (fx > 0.0) { if (has(ch.p, "child")) { ch.p.child._fw = -1.0; } }
        }
        this._kids = outKids; this.compose();
    }
}

// An elevated rounded surface (M3 card).
class CardWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let c = this.p.child.measure(app);
        return { w: c.w + m.u * 8.0 * m.sp, h: c.h + m.u * 8.0 * m.sp };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let p = app.painter; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = m.u * 1.6;
        if (has(this.p, "radius")) { r = this.p.radius * m.u; }
        p.shadow(cx, cy, hw, hh, r, m.u * 0.4, m.u * 1.0, m.u * 2.8);
        let fill = th.surfaceContainer(1.0); if (has(this.p, "color")) { fill = th.colorRole(this.p.color, 1.0); }
        p.rect(cx, cy, hw, hh, r, 0.0, 0.0, fill, CLEAR);
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }
}

// A decorated box: optional fixed size, padding, fill, border, radius.
class ContainerWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let p = this.p;
        let cw = 0.0; let ch = 0.0;
        if (has(p, "child")) { let mm = p.child.measure(app); cw = mm.w; ch = mm.h; }
        let pad = m.padOf(p); let w = cw + pad.l + pad.r; let h = ch + pad.t + pad.b;
        if (has(p, "width")) { w = p.width * m.u; }
        if (has(p, "height")) { h = p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        this.beginSelf(app);
        let r = 0.0; if (has(p, "radius")) { r = p.radius * m.u; }
        // Optional drop shadow / elevation (Flutter's BoxShadow / Material elevation).
        if (has(p, "elevation")) { let e = p.elevation; if (e > 0.0) { pnt.shadow(cx, cy, hw, hh, r, m.u * 0.3 * e, m.u * 0.4 * e, m.u * 1.6 * e); } }
        if (has(p, "shadow")) { let sd = p.shadow; let sc = [0.0, 0.0, 0.0, 0.3]; if (has(sd, "color")) { sc = sd.color; }
            let sb = m.u * 2.0; if (has(sd, "blur")) { sb = sd.blur * m.u; }
            let sdx = 0.0; let sdy = m.u * 0.6; if (has(sd, "dx")) { sdx = sd.dx * m.u; } if (has(sd, "dy")) { sdy = sd.dy * m.u; }
            pnt.shadowCol(cx + sdx, cy, hw, hh, r, sb * 0.4, sdy, sb, sc); }
        // Gradient fill (linear / radial / sweep) takes precedence over a flat colour.
        if (has(p, "gradient")) { paintGradient(app, p.gradient, cx, cy, hw, hh, r); }
        let deco = 0.0; if (has(p, "color")) { deco = 1.0; } if (has(p, "border")) { deco = 1.0; }
        if (deco > 0.5) {
            let bw = 0.0; if (has(p, "border")) { bw = p.border * m.u; }
            let fill = CLEAR; if (has(p, "color")) { fill = th.colorRole(p.color, 1.0); }
            let bcol = CLEAR; if (has(p, "border")) { bcol = th.outline(1.0); if (has(p, "borderColor")) { bcol = th.colorRole(p.borderColor, 1.0); } }
            pnt.rect(cx, cy, hw, hh, r, bw, 0.0, fill, bcol);
        }
        if (has(p, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(p), p.onTap); }
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) {
            let pad = m.padOf(p); p.child.paint(app, cx + (pad.l - pad.r) / 2.0, cy + (pad.t - pad.b) / 2.0); push(outKids, p.child);
        } }
        this._kids = outKids; this.compose();
    }
}

// Padding / SafeArea share `paintInset`; they differ only in the inset source.
class PaddingWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let mm = { w: 0.0, h: 0.0 }; if (has(this.p, "child")) { mm = this.p.child.measure(app); }
        let pad = m.padOf(this.p); return { w: mm.w + pad.l + pad.r, h: mm.h + pad.t + pad.b };
    }
    paint(app, cx, cy) { this.paintInset(app, cx, cy, app.metrics.padOf(this.p)); }
}
class SafeAreaWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let mm = { w: 0.0, h: 0.0 }; if (has(this.p, "child")) { mm = this.p.child.measure(app); }
        let pad = m.safeInsets(this.p); return { w: mm.w + pad.l + pad.r, h: mm.h + pad.t + pad.b };
    }
    paint(app, cx, cy) { this.paintInset(app, cx, cy, app.metrics.safeInsets(this.p)); }
}

// Center / SizedBox / Expanded / Positioned all centre their child; Align offsets.
class CenterWidget extends Widget {
    measureIntrinsic(app) { return sizedOuter(app, this.p); }
    paint(app, cx, cy) { this.paintCenter(app, cx, cy); }
}
class SizedBoxWidget extends Widget {
    measureIntrinsic(app) { return sizedOuter(app, this.p); }
    paint(app, cx, cy) { this.paintCenter(app, cx, cy); }
}
class AlignWidget extends Widget {
    measureIntrinsic(app) { return sizedOuter(app, this.p); }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app); let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) {
            let mz = this.measure(app); let cm = this.p.child.measure(app);
            let ax = 0.0; let ay = 0.0; if (has(this.p, "ax")) { ax = this.p.ax; } if (has(this.p, "ay")) { ay = this.p.ay; }
            this.p.child.paint(app, cx + ax * (mz.w - cm.w) / 2.0, cy + ay * (mz.h - cm.h) / 2.0); push(outKids, this.p.child);
        } }
        this._kids = outKids; this.compose();
    }
}
class ExpandedWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    flexFactor() { if (has(this.p, "flex")) { return this.p.flex; } return 1.0; }
    paint(app, cx, cy) { this.paintCenter(app, cx, cy); }
}
class PositionedWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    isPositioned() { return 1.0; }
    paint(app, cx, cy) { this.paintCenter(app, cx, cy); }
}

// Layered children; `Positioned` children pin to edges.
class StackWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let kids = this.p.children; let w = 0.0; let h = 0.0;
        for (let i = 0; i < len(kids); i++) { let mm = kids[i].measure(app); if (mm.w > w) { w = mm.w; } if (mm.h > h) { h = mm.h; } }
        if (has(this.p, "width")) { w = this.p.width * m.u; }
        if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; this.beginSelf(app);
        let mz = this.measure(app); let kids = this.p.children; let nc = len(kids); let outKids = [];
        let left = cx - mz.w / 2.0; let top = cy - mz.h / 2.0;
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = ch.measure(app); let px = cx; let py = cy;
            if (ch.isPositioned() > 0.5) {
                if (has(ch.p, "left")) { px = left + ch.p.left * m.u + cm.w / 2.0; }
                if (has(ch.p, "right")) { px = left + mz.w - ch.p.right * m.u - cm.w / 2.0; }
                if (has(ch.p, "top")) { py = top + ch.p.top * m.u + cm.h / 2.0; }
                if (has(ch.p, "bottom")) { py = top + mz.h - ch.p.bottom * m.u - cm.h / 2.0; }
            }
            ch.paint(app, px, py); push(outKids, ch);
        }
        this._kids = outKids; this.compose();
    }
}

// Flowing run-wrapped children.
class WrapWidget extends Widget {
    wrapMaxW(app) { if (has(this.p, "maxWidth")) { return this.p.maxWidth * app.metrics.u; } return app.metrics.u * 60.0; }
    measureIntrinsic(app) {
        let m = app.metrics; let maxW = this.wrapMaxW(app); let gap = m.gapPx(this.p);
        let rg = gap; if (has(this.p, "runGap")) { rg = this.p.runGap * m.u; }
        let kids = this.p.children; let nc = len(kids); let x = 0.0; let rowH = 0.0; let totalH = 0.0;
        for (let i = 0; i < nc; i++) {
            let cm = kids[i].measure(app);
            if (x > 0.0) { if (x + gap + cm.w > maxW) { totalH = totalH + rowH + rg; x = 0.0; rowH = 0.0; } }
            if (x > 0.0) { x = x + gap; }
            x = x + cm.w; if (cm.h > rowH) { rowH = cm.h; }
        }
        return { w: maxW, h: totalH + rowH };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; this.beginSelf(app);
        let mz = this.measure(app); let maxW = this.wrapMaxW(app); let gap = m.gapPx(this.p);
        let rg = gap; if (has(this.p, "runGap")) { rg = this.p.runGap * m.u; }
        let kids = this.p.children; let nc = len(kids); let left = cx - mz.w / 2.0; let top = cy - mz.h / 2.0;
        let x = 0.0; let rowTop = top; let rowH = 0.0; let outKids = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = ch.measure(app);
            if (x > 0.0) { if (x + gap + cm.w > maxW) { rowTop = rowTop + rowH + rg; x = 0.0; rowH = 0.0; } }
            if (x > 0.0) { x = x + gap; }
            ch.paint(app, left + x + cm.w / 2.0, rowTop + cm.h / 2.0); push(outKids, ch);
            x = x + cm.w; if (cm.h > rowH) { rowH = cm.h; }
        }
        this._kids = outKids; this.compose();
    }
}

// Scrollable list (item-culled) with a momentum-friendly scrollbar.
class ListViewWidget extends Widget {
    scrollFill() { return 1.0; }
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 62.0; let h = m.u * 40.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; }
        if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let gap = m.gapPx(p);
        let padT = 0.0; if (has(this, "_cPadT")) { padT = this._cPadT; }
        let padB = 0.0; if (has(this, "_cPadB")) { padB = this._cPadB; }
        let kids = p.children; let nc = len(kids); let total = 0.0; let cms = [];
        for (let i = 0; i < nc; i++) { let cm = kids[i].measure(app); push(cms, cm); total = total + cm.h; }
        if (nc > 1) { total = total + gap * (nc - 1); }
        total = total + padT + padB;
        let viewport = mz.h; let maxOff = total - viewport; if (maxOff < 0.0) { maxOff = 0.0; }
        let off = 0.0; if (has(app.scroll, p.id)) { off = app.scroll[p.id]; }
        if (off > maxOff) { off = maxOff; } if (off < 0.0) { off = 0.0; }
        app.scroll[p.id] = off;
        app.listRegions[p.id] = { cx: cx, cy: cy, hw: hw, hh: hh, maxOff: maxOff };
        let r = m.u * 1.2; if (has(p, "radius")) { r = p.radius * m.u; }
        if (has(p, "surface")) { if (p.surface > 0.5) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR); } }
        let top = cy - hh - off + padT; let outKids = [];
        for (let i = 0; i < nc; i++) {
            let ch = kids[i]; let cm = cms[i]; let itemCy = top + cm.h / 2.0;
            if (itemCy + cm.h / 2.0 >= cy - hh) { if (itemCy - cm.h / 2.0 <= cy + hh) { ch.paint(app, cx, itemCy); push(outKids, ch); } }
            top = top + cm.h + gap;
        }
        if (maxOff > 0.5) {
            pnt.outInto(this._over);
            let trackH = hh * 2.0; let thumbH = trackH * viewport / total; if (thumbH < m.u * 4.0) { thumbH = m.u * 4.0; }
            let frac = off / maxOff; let thumbCy = (cy - hh) + thumbH / 2.0 + frac * (trackH - thumbH);
            pnt.rect(cx + hw - m.u * 0.6, thumbCy, m.u * 0.35, thumbH / 2.0, m.u * 0.35, 0.0, 0.0, th.outline(0.7), CLEAR);
        }
        this._kids = outKids; this.compose();
    }
}

// Scrollable grid (item-culled), `cols` columns of tight cells.
class GridViewWidget extends Widget {
    scrollFill() { return 1.0; }
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 62.0; let h = m.u * 40.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; }
        if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let cols = p.cols; let gap = m.gapPx(p); let cellW = (mz.w - gap * (cols - 1)) / cols;
        let cellH = cellW; if (has(p, "cellHeight")) { cellH = p.cellHeight * m.u; }
        let padT = 0.0; if (has(this, "_cPadT")) { padT = this._cPadT; }
        let padB = 0.0; if (has(this, "_cPadB")) { padB = this._cPadB; }
        let kids = p.children; let nc = len(kids); let rows = ceil(num(nc) / cols);
        let total = rows * cellH + (rows - 1) * gap + padT + padB; let viewport = mz.h;
        let maxOff = total - viewport; if (maxOff < 0.0) { maxOff = 0.0; }
        let off = 0.0; if (has(app.scroll, p.id)) { off = app.scroll[p.id]; }
        if (off > maxOff) { off = maxOff; } if (off < 0.0) { off = 0.0; } app.scroll[p.id] = off;
        app.listRegions[p.id] = { cx: cx, cy: cy, hw: hw, hh: hh, maxOff: maxOff };
        let left = cx - hw; let top = cy - hh - off + padT; let outKids = [];
        for (let i = 0; i < nc; i++) {
            let col = i % cols; let row = floor(num(i) / cols);
            let cxi = left + col * (cellW + gap) + cellW / 2.0; let cyi = top + row * (cellH + gap) + cellH / 2.0;
            if (cyi + cellH / 2.0 >= cy - hh) { if (cyi - cellH / 2.0 <= cy + hh) {
                let cell = kids[i]; cell._fw = cellW; cell._fh = cellH;
                cell.paint(app, cxi, cyi); push(outKids, cell);
                cell._fw = -1.0; cell._fh = -1.0;
            } }
        }
        this._kids = outKids; this.compose();
    }
}

// A small count chip overlaid on a child.
class BadgeWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: app.metrics.u * 4.0, h: app.metrics.u * 4.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let pnt = app.painter; this.beginSelf(app);
        let outKids = []; let cm = { w: m.u * 4.0, h: m.u * 4.0 };
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { cm = this.p.child.measure(app); this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        pnt.outInto(this._over);
        let bx = cx + cm.w / 2.0 - m.u * 0.4; let by = cy - cm.h / 2.0 + m.u * 0.4; let br = m.u * 1.5;
        let cnt = 0.0; if (has(this.p, "count")) { cnt = this.p.count; }
        pnt.rect(bx, by, br, br, br, 0.0, 0.0, [0.85, 0.25, 0.3, 1.0], CLEAR);
        app.font.text(pnt, str(cnt), bx, by, m.cell("micro"), WHITE);
        this._kids = outKids; this.compose();
    }
}

// A header row that expands to reveal a child.
class ExpansionTileWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let hh = m.du() * 7.0; let w = m.u * 50.0; if (has(this.p, "width")) { w = this.p.width * m.u; }
        let h = hh;
        if (has(this.p, "expanded")) { if (this.p.expanded > 0.5) { if (has(this.p, "child")) {
            let mm = this.p.child.measure(app); h = hh + mm.h + m.u * 2.0; if (mm.w + m.u * 4.0 > w) { w = mm.w + m.u * 4.0; }
        } } }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let hdrH = m.du() * 7.0;
        this.beginSelf(app);
        pnt.rect(cx, cy, hw, hh, m.u * 1.4, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        let hcy = cy - hh + hdrH / 2.0;
        ft.textLeft(pnt, p.title, cx - hw + m.u * 3.0, hcy, m.cell("body"), th.onSurface(1.0));
        let exp = 0.0; if (has(p, "expanded")) { exp = p.expanded; }
        let a = app.clock.ease(concat("exp:", idOf(p)), exp);
        let chx = cx + hw - m.u * 4.0; let arm = m.u * 1.0; let dir = a * 1.5708;
        pnt.seg(chx, hcy, chx + cos(dir - 2.356) * arm, hcy + sin(dir - 2.356) * arm, m.u * 0.3, th.onSurface(0.7));
        pnt.seg(chx, hcy, chx + cos(dir + 2.356) * arm, hcy + sin(dir + 2.356) * arm, m.u * 0.3, th.onSurface(0.7));
        if (has(p, "onToggle")) { pnt.addTap(cx, hcy, hw, hdrH / 2.0, idOf(p), p.onToggle); }
        let outKids = [];
        if (exp > 0.5) { if (has(p, "child")) { if (!isNull(p.child)) {
            let cm = p.child.measure(app); p.child.paint(app, cx, cy - hh + hdrH + m.u * 1.0 + cm.h / 2.0); push(outKids, p.child);
        } } }
        this._kids = outKids; this.compose();
    }
}

// The screen scaffold: app bar, body, bottom bar, FAB, drawer, snackbar, dialog.
class ScaffoldWidget extends Widget {
    // The drawer is isolated in its own repaint unit (a Component) so its slide
    // marks only that subtree dirty — not the whole app. Memoised so mount and
    // paint share one identity across an open/close gesture.
    drawerHost() {
        if (!has(this, "_dHost")) { this._dHost = new ComponentNode(overlayBuilder, { child: this.p.drawer }); }
        return this._dHost;
    }
    children(app) {
        let node = this.p; let a = [];
        if (has(node, "appBar")) { if (!isNull(node.appBar)) { push(a, node.appBar); } }
        if (has(node, "body")) { if (!isNull(node.body)) { push(a, node.body); } }
        if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { push(a, node.bottomBar); } }
        if (has(node, "fab")) { if (!isNull(node.fab)) { push(a, node.fab); } }
        if (has(node, "drawer")) { if (!isNull(node.drawer)) { push(a, this.drawerHost()); } }
        if (has(node, "snackbar")) { if (!isNull(node.snackbar)) { push(a, node.snackbar); } }
        if (has(node, "dialog")) { if (!isNull(node.dialog)) { push(a, node.dialog); } }
        return a;
    }
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let node = this.p; this.beginSelf(app);
        let aH = m.u * 10.0 * m.dens; let aHTotal = aH + m.saT; let barH = m.u * 11.0 * m.dens;
        let bodyCx = m.saL + (m.vw - m.saL - m.saR) / 2.0;
        let hasBar = 0.0; if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { hasBar = 1.0; } }
        let hasFab = 0.0; if (has(node, "fab")) { if (!isNull(node.fab)) { hasFab = 1.0; } }
        let fabR = m.du() * 4.2;
        let fabX = m.vw - m.saR - m.u * 9.0; let fabY = m.vh - m.saB - m.u * 9.0;
        if (m.isExpanded() < 0.5) {
            fabX = m.vw - m.saR - m.u * 4.0 - fabR;
            fabY = m.vh - m.saB - m.u * 4.0 - fabR;
            if (hasBar > 0.5) { fabY = m.vh - m.saB - barH - m.u * 4.0 - fabR; }
        }
        if (m.saB > 0.0) { if (hasBar > 0.5) {
            pnt.rect(m.vw / 2.0, m.vh - m.saB / 2.0, m.vw / 2.0, m.saB / 2.0, 0.0, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        } }
        if (has(node, "onKey")) { app.keyHandler = node.onKey; app.hasKey = 1.0; }
        let outKids = [];
        // Body first so the bars draw over scrolling content.
        if (has(node, "body")) { if (!isNull(node.body)) {
            let bodyTop = aHTotal; let bodyH = m.vh - aHTotal - m.saB;
            if (hasBar > 0.5) { bodyH = bodyH - barH; }
            let padT = m.u * 1.5 * m.sp; let padB = m.u * 2.0 * m.sp;
            if (hasFab > 0.5) {
                let clear = (bodyTop + bodyH) - (fabY - fabR) + m.u * 2.0;
                if (clear > 0.0) { padB = padB + clear; }
            }
            if (node.body.scrollFill() > 0.5) { node.body._fh = bodyH; node.body._cPadT = padT; node.body._cPadB = padB; }
            node.body.paint(app, bodyCx, bodyTop + bodyH / 2.0); push(outKids, node.body);
        } }
        if (has(node, "appBar")) { if (!isNull(node.appBar)) { node.appBar.paint(app, m.vw / 2.0, aHTotal / 2.0); push(outKids, node.appBar); } }
        if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) {
            let bn = node.bottomBar; bn._fw = m.vw - m.saL - m.saR;
            bn.paint(app, bodyCx, m.vh - m.saB - m.u * 5.5 * m.dens); bn._fw = -1.0; push(outKids, bn);
        } }
        if (hasFab > 0.5) { node.fab.paint(app, fabX, fabY); push(outKids, node.fab); }
        if (has(node, "drawer")) { if (!isNull(node.drawer)) { let dh = this.drawerHost(); dh.paint(app, m.vw / 2.0, m.vh / 2.0); push(outKids, dh); } }
        if (has(node, "snackbar")) { if (!isNull(node.snackbar)) { node.snackbar.paint(app, m.vw / 2.0, m.vh / 2.0); push(outKids, node.snackbar); } }
        if (has(node, "dialog")) { if (!isNull(node.dialog)) { node.dialog.paint(app, m.vw / 2.0, m.vh / 2.0); push(outKids, node.dialog); } }
        this._kids = outKids; this.compose();
    }
}

// ---- shared layout helpers (on Widget so all subclasses reuse them) ----------
// Intrinsic size of a child-wrapping box honouring explicit width/height.
function sizedOuter(app, p) {
    let m = app.metrics; let mm = { w: 0.0, h: 0.0 }; if (has(p, "child")) { mm = p.child.measure(app); }
    let w = mm.w; let h = mm.h;
    if (has(p, "width")) { w = p.width * m.u; }
    if (has(p, "height")) { h = p.height * m.u; }
    return { w: w, h: h };
}
function idOf(p) { if (has(p, "id")) { return p.id; } return "x"; }
