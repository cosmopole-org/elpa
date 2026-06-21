// Elpa Liquid Glass — layout widgets (Flutter's box model + the Scaffold).
//
// Column/Row (flex + cross/main alignment), the box family (Container / Padding /
// SafeArea / Center / Align / SizedBox / Expanded / Positioned), Stack, Wrap, the
// scrollable ListView / GridView, the Scaffold chrome coordinator and Badge. Each
// is a `Widget` subclass implementing `measureIntrinsic` and `paint`.

function mainDist(p, extra, nc) {
    let lead = 0.0; let between = 0.0;
    if (extra > 0.0) {
        if (has(p, "main")) {
            let mm = p.main;
            if (mm == "center") { lead = extra / 2.0; }
            if (mm == "end") { lead = extra; }
            if (mm == "between") { if (nc > 1) { between = extra / (nc - 1); } else { lead = extra / 2.0; } }
            if (mm == "around") { let gp = extra / nc; lead = gp / 2.0; between = gp; }
            if (mm == "evenly") { let gp = extra / (nc + 1); lead = gp; between = gp; }
        }
    }
    return { lead: lead, between: between };
}

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
            if (fx > 0.0) { chh = 0.0; if (flexTotal > 0.0) { chh = extra * fx / flexTotal; } if (has(ch.p, "child")) { ch.p.child._fh = chh; } }
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
            if (fx > 0.0) { cw = 0.0; if (flexTotal > 0.0) { cw = extra * fx / flexTotal; } if (has(ch.p, "child")) { ch.p.child._fw = cw; } }
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

// A decorated box: optional fixed size, padding, fill (solid OR glass), border,
// radius, gradient, elevation/shadow.
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
        if (has(p, "elevation")) { let e = p.elevation; if (e > 0.0) { pnt.shadow(cx, cy, hw, hh, r, m.u * 0.3 * e, m.u * 0.4 * e, m.u * 1.6 * e, [0.0, 0.0, 0.0, 0.28]); } }
        if (has(p, "shadow")) {
            let sd = p.shadow; let scol = [0.0, 0.0, 0.0, 0.3]; if (has(sd, "color")) { scol = sd.color; }
            let sb = m.u * 2.0; if (has(sd, "blur")) { sb = sd.blur * m.u; }
            let sdx = 0.0; let sdy = m.u * 0.6; if (has(sd, "dx")) { sdx = sd.dx * m.u; } if (has(sd, "dy")) { sdy = sd.dy * m.u; }
            pnt.shadow(cx + sdx, cy, hw, hh, r, sb * 0.4, sdy, sb, scol);
        }
        if (has(p, "gradient")) { paintGradient(app, p.gradient, cx, cy, hw, hh, r); }
        if (has(p, "glass")) { if (p.glass > 0.5) { paintGlassPanel(app, cx, cy, hw, hh, r, "thin"); } }
        let deco = 0.0; if (has(p, "color")) { deco = 1.0; } if (has(p, "border")) { deco = 1.0; }
        if (deco > 0.5) {
            let bw = 0.0; if (has(p, "border")) { bw = p.border * m.u; }
            let fill = CLEAR; if (has(p, "color")) { fill = th.colorRole(p.color, 1.0); }
            let bcol = CLEAR; if (has(p, "border")) { bcol = th.rim(1.0); if (has(p, "borderColor")) { bcol = th.colorRole(p.borderColor, 1.0); } }
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
        let r = m.u * 2.2; if (has(p, "radius")) { r = p.radius * m.u; }
        if (has(p, "glass")) { if (p.glass > 0.5) { paintGlassPanel(app, cx, cy, hw, hh, r, "thin"); } }
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
            pnt.rect(cx + hw - m.u * 0.6, thumbCy, m.u * 0.35, thumbH / 2.0, m.u * 0.35, 0.0, 0.0, th.inkSoft(0.45), CLEAR);
        }
        this._kids = outKids; this.compose();
    }
}

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

class BadgeWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: app.metrics.u * 4.0, h: app.metrics.u * 4.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; this.beginSelf(app);
        let outKids = []; let cm = { w: m.u * 4.0, h: m.u * 4.0 };
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { cm = this.p.child.measure(app); this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        pnt.outInto(this._over);
        let bx = cx + cm.w / 2.0 - m.u * 0.4; let by = cy - cm.h / 2.0 + m.u * 0.4; let br = m.u * 1.5;
        let cnt = 0.0; if (has(this.p, "count")) { cnt = this.p.count; }
        pnt.rect(bx, by, br, br, br, 0.0, 0.0, [1.0, 0.23, 0.19, 1.0], CLEAR);
        app.font.text(pnt, str(cnt), bx, by, m.cell("micro"), WHITE);
        this._kids = outKids; this.compose();
    }
}

// The screen scaffold: a refractable wallpaper background + glass app bar, body,
// bottom bar and FAB. The wallpaper is the first thing emitted, so it becomes the
// backdrop every glass element refracts.
class ScaffoldWidget extends Widget {
    children(app) {
        let node = this.p; let a = [];
        if (has(node, "appBar")) { if (!isNull(node.appBar)) { push(a, node.appBar); } }
        if (has(node, "body")) { if (!isNull(node.body)) { push(a, node.body); } }
        if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { push(a, node.bottomBar); } }
        if (has(node, "fab")) { if (!isNull(node.fab)) { push(a, node.fab); } }
        if (has(node, "sheet")) { if (!isNull(node.sheet)) { push(a, node.sheet); } }
        if (has(node, "dialog")) { if (!isNull(node.dialog)) { push(a, node.dialog); } }
        return a;
    }
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let node = this.p; this.beginSelf(app);
        // The refractable wallpaper (the backdrop). A custom `background` child
        // replaces the default vivid gradient.
        if (has(node, "background")) { if (!isNull(node.background)) { node.background.paint(app, m.vw / 2.0, m.vh / 2.0); push(this._self, 0); } }
        else { pnt.gradLinear(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, 0.0, th.wallpaper(), 0.0, 0.0, 0.0, 1.0); }
        let aH = m.u * 10.0 * m.dens; let aHTotal = aH + m.saT; let barH = m.u * 11.0 * m.dens;
        let bodyCx = m.saL + (m.vw - m.saL - m.saR) / 2.0;
        let hasBar = 0.0; if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) { hasBar = 1.0; } }
        let hasFab = 0.0; if (has(node, "fab")) { if (!isNull(node.fab)) { hasFab = 1.0; } }
        let fabR = m.du() * 4.2;
        let fabX = m.vw - m.saR - m.u * 9.0; let fabY = m.vh - m.saB - m.u * 9.0;
        if (m.isExpanded() < 0.5) {
            fabX = m.vw - m.saR - m.u * 4.0 - fabR; fabY = m.vh - m.saB - m.u * 4.0 - fabR;
            if (hasBar > 0.5) { fabY = m.vh - m.saB - barH - m.u * 4.0 - fabR; }
        }
        if (has(node, "onKey")) { app.keyHandler = node.onKey; app.hasKey = 1.0; }
        let outKids = [];
        if (has(node, "body")) { if (!isNull(node.body)) {
            let bodyTop = aHTotal; let bodyH = m.vh - aHTotal - m.saB;
            if (hasBar > 0.5) { bodyH = bodyH - barH; }
            let padT = m.u * 1.5 * m.sp; let padB = m.u * 2.0 * m.sp;
            if (hasFab > 0.5) { let clear = (bodyTop + bodyH) - (fabY - fabR) + m.u * 2.0; if (clear > 0.0) { padB = padB + clear; } }
            if (node.body.scrollFill() > 0.5) { node.body._fh = bodyH; node.body._cPadT = padT; node.body._cPadB = padB; }
            node.body.paint(app, bodyCx, bodyTop + bodyH / 2.0); push(outKids, node.body);
        } }
        if (has(node, "appBar")) { if (!isNull(node.appBar)) { node.appBar._fw = m.vw; node.appBar.paint(app, m.vw / 2.0, aHTotal / 2.0); node.appBar._fw = -1.0; push(outKids, node.appBar); } }
        if (has(node, "bottomBar")) { if (!isNull(node.bottomBar)) {
            let bn = node.bottomBar; bn._fw = m.vw - m.saL - m.saR;
            bn.paint(app, bodyCx, m.vh - m.saB - m.u * 5.5 * m.dens); bn._fw = -1.0; push(outKids, bn);
        } }
        if (hasFab > 0.5) { node.fab.paint(app, fabX, fabY); push(outKids, node.fab); }
        if (has(node, "sheet")) { if (!isNull(node.sheet)) { node.sheet.paint(app, m.vw / 2.0, m.vh / 2.0); push(outKids, node.sheet); } }
        if (has(node, "dialog")) { if (!isNull(node.dialog)) { node.dialog.paint(app, m.vw / 2.0, m.vh / 2.0); push(outKids, node.dialog); } }
        this._kids = outKids; this.compose();
    }
}

// ---- shared layout helpers ---------------------------------------------------
function sizedOuter(app, p) {
    let m = app.metrics; let mm = { w: 0.0, h: 0.0 }; if (has(p, "child")) { mm = p.child.measure(app); }
    let w = mm.w; let h = mm.h;
    if (has(p, "width")) { w = p.width * m.u; }
    if (has(p, "height")) { h = p.height * m.u; }
    return { w: w, h: h };
}
function idOf(p) { if (has(p, "id")) { return p.id; } return "x"; }

// Paint a gradient fill of a rounded rect from a gradient spec.
function paintGradient(app, gspec, cx, cy, hw, hh, r) {
    let th = app.theme; let pnt = app.painter;
    let cols = [];
    for (let i = 0; i < len(gspec.colors); i++) { let c = gspec.colors[i]; if (typeOf(c) == "string") { push(cols, th.colorRole(c, 1.0)); } else { push(cols, c); } }
    let st = 0; if (has(gspec, "stops")) { st = gspec.stops; }
    let stops = gradStops(cols, st);
    if (gspec.type == "radial") { pnt.gradRadial(cx, cy, max(hw, hh), stops); return 0; }
    let bx0 = 0.0; let by0 = 0.0; let bx1 = 0.0; let by1 = 1.0;
    if (has(gspec, "begin")) { bx0 = gspec.begin[0]; by0 = gspec.begin[1]; }
    if (has(gspec, "end")) { bx1 = gspec.end[0]; by1 = gspec.end[1]; }
    pnt.gradLinear(cx, cy, hw, hh, r, stops, bx0, by0, bx1, by1);
    return 0;
}

// Paint a liquid-glass panel: a soft shadow under it, then the glass lens. `mode`
// chooses the tint thickness ("thin" / "thick" / "regular").
function paintGlassPanel(app, cx, cy, hw, hh, r, mode) {
    let m = app.metrics; let th = app.theme; let pnt = app.painter;
    let tint = th.glass(1.0);
    if (mode == "thin") { tint = th.glassThin(); }
    if (mode == "thick") { tint = th.glassThick(); }
    let refr = m.u * 5.0; let spec = 0.5; let blur = m.u * 2.2;
    pnt.shadow(cx, cy, hw, hh, r, m.u * 0.2, m.u * 0.8, m.u * 2.6, [0.0, 0.0, 0.05, 0.22]);
    pnt.glass(cx, cy, hw, hh, r, m.u * 0.18, 0.0, tint, th.rim(1.0), refr, spec, blur);
    return 0;
}

// A Liquid-Glass selection indicator — the signature iOS-26 behaviour: a
// *refractive glass drop* (not a flat fill) that **squashes and stretches along
// its travel** so a moving selection reads as a gel flowing between states, then
// settles round. `vel` is how far it still has to slide (in cells, 0 at rest);
// `tint` is the glass tint over the refracted backdrop (accent for a primary
// selection, a bright neutral for tabs); `axis` 0 = horizontal slide, 1 =
// vertical. A faint accent glow + a strong specular rim sell the liquid lens.
function paintLiquidIndicator(app, cx, cy, hw, hh, r, vel, tint, axis) {
    let m = app.metrics; let th = app.theme; let pnt = app.painter;
    let s = abs(vel); if (s > 1.0) { s = 1.0; }
    let iw = hw; let ih = hh;
    if (axis < 0.5) { iw = hw * (1.0 + s * 0.42); ih = hh * (1.0 - s * 0.16); }
    else { ih = hh * (1.0 + s * 0.42); iw = hw * (1.0 - s * 0.16); }
    let ir = r; let mn = iw; if (ih < mn) { mn = ih; } if (ir > mn) { ir = mn; }
    pnt.shadow(cx, cy, iw, ih, ir, m.u * 0.1, m.u * 0.3, m.u * 1.6, [th.accCh(0), th.accCh(1), th.accCh(2), 0.22]);
    pnt.glass(cx, cy, iw, ih, ir, m.u * 0.16, 0.0, tint, th.rim(1.0), m.u * 5.5, 0.9, m.u * 1.6);
    return 0;
}

// The accent glass tint for a primary Liquid-Glass selection drop.
function accentGlass(th, a) { return [th.accCh(0), th.accCh(1), th.accCh(2), a]; }

// A bright neutral glass tint for a Liquid-Glass thumb / drop (Switch, Slider,
// Tabs) — a clear refractive lens with a faint cool body.
function brightGlass(th, a) { return [th.mix(1.0, 0.92), th.mix(1.0, 0.94), th.mix(1.0, 1.0), a]; }
