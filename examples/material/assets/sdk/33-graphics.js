// Elpa Material — graphics layer (Flutter's painting / dart:ui surface).
//
// The "graphical" half of Flutter that the widget catalog above did not yet
// cover: a full **Canvas / CustomPainter** command set, **gradients** (linear /
// radial / sweep, multi-stop), **opacity & colour filters**, **2D transforms**,
// and a **BackdropFilter** frosted-glass blur. Everything here is still drawn
// from the one rounded-rect SDF primitive (gradients are colour bands / rings /
// spokes; transforms and opacity ride the Painter's affine + alpha stack), so a
// CustomPaint scene is *still* part of the single instanced draw — except the
// BackdropFilter, whose blur is a real offscreen-capture multi-pass the runtime
// splices in (see `Material.submitBackdrop`).
//
//   GraphicsEngine — backdrop-sentinel scanning + SDF run splitting for the
//                    multi-pass frosted-glass compositor.
//   Path / Canvas  — the dart:ui drawing API: lines, rects, rrects, circles,
//                    ovals, arcs, paths, points, shadows, gradients, text, images,
//                    plus save/restore/translate/scale/rotate and clip tracking.
//   widgets        — CustomPaint, Opacity, ColorFiltered, Transform, RotatedBox,
//                    ClipRRect, BackdropFilter.

// ----------------------------------------------------------- GraphicsEngine ---
// Pure helpers for the backdrop-blur compositor: find the backdrop sentinels in
// an instance stream and split the rest into contiguous SDF draw runs (skipping
// the image + backdrop sentinel slots, which the SDF pipeline must not read).
class GraphicsEngine {
    // Indices (in instances) of every backdrop sentinel, and the last one.
    scanBackdrops(inst) {
        let n = len(inst) / 16; let marks = []; let last = -1;
        for (let i = 0; i < n; i++) { if (inst[i * 16] == BACKDROP_MARK) { push(marks, i); last = i; } }
        return { marks: marks, last: last };
    }
    hasBackdrop(inst) { return this.scanBackdrops(inst).last >= 0; }
    // Contiguous runs of plain SDF instances in [lo, hi), splitting at any image
    // or backdrop sentinel (whose slots the SDF draw must skip). Each run is
    // { first, count } in instance units, indexing the shared vertex buffer.
    sdfRuns(inst, lo, hi) {
        let runs = []; let start = -1;
        for (let i = lo; i < hi; i++) {
            let mark = inst[i * 16];
            let sentinel = 0.0; if (mark == IMG_MARK) { sentinel = 1.0; } if (mark == BACKDROP_MARK) { sentinel = 1.0; }
            if (sentinel > 0.5) { if (start >= 0) { push(runs, { first: start, count: i - start }); start = -1; } }
            else { if (start < 0) { start = i; } }
        }
        if (start >= 0) { push(runs, { first: start, count: hi - start }); }
        return runs;
    }
    // A backdrop region descriptor read from its sentinel instance.
    regionAt(inst, i) {
        let b = i * 16;
        return { blur: inst[b + 1], cx: inst[b + 2], cy: inst[b + 3], hw: inst[b + 4], hh: inst[b + 5], r: inst[b + 6] };
    }
}

// ------------------------------------------------------------- gradient util --
// Resolve a gradient `colors` list (rgba arrays *or* M3 role-name strings) to
// rgba arrays against the live theme.
function gcolors(app, cols) {
    let out = [];
    for (let i = 0; i < len(cols); i++) {
        let c = cols[i];
        if (typeOf(c) == "string") { push(out, app.theme.colorRole(c, 1.0)); } else { push(out, c); }
    }
    return out;
}
// Paint a gradient `g` ({ type, colors, stops?, begin?, end?, start? }) as the
// fill of a rounded box centred at (cx,cy) with half-extent (hw,hh), radius r.
function paintGradient(app, g, cx, cy, hw, hh, r) {
    let pnt = app.painter; let cols = gcolors(app, g.colors);
    let stops = 0; if (has(g, "stops")) { stops = g.stops; }
    let st = gradStops(cols, stops);
    let type = "linear"; if (has(g, "type")) { type = g.type; }
    if (type == "radial") { pnt.gradRadial(cx, cy, max(hw, hh), st); return 0; }
    if (type == "sweep") { let start = -1.5708; if (has(g, "start")) { start = g.start; } pnt.gradSweep(cx, cy, max(hw, hh), st, start); return 0; }
    let bx0 = 0.0; let by0 = 0.0; let bx1 = 1.0; let by1 = 1.0;
    if (has(g, "begin")) { bx0 = g.begin[0]; by0 = g.begin[1]; }
    if (has(g, "end")) { bx1 = g.end[0]; by1 = g.end[1]; }
    pnt.gradLinear(cx, cy, hw, hh, r, st, bx0, by0, bx1, by1);
    return 0;
}

// ------------------------------------------------------------------- Path -----
// A dart:ui Path: subpaths accumulated as flattened polylines (Béziers and arcs
// flattened to line points), ready for the Canvas stroker / convex filler.
class Path {
    constructor() { this.subs = []; this.cur = []; this.sx = 0.0; this.sy = 0.0; this.px = 0.0; this.py = 0.0; }
    moveTo(x, y) { if (len(this.cur) > 0) { push(this.subs, this.cur); } this.cur = [[x, y]]; this.sx = x; this.sy = y; this.px = x; this.py = y; return this; }
    lineTo(x, y) { if (len(this.cur) == 0) { push(this.cur, [this.px, this.py]); } push(this.cur, [x, y]); this.px = x; this.py = y; return this; }
    cubicTo(x1, y1, x2, y2, x, y) {
        for (let i = 1; i <= 16; i++) {
            let t = num(i) / 16.0; let u = 1.0 - t;
            let bx = u * u * u * this.px + 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t * x;
            let by = u * u * u * this.py + 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t * y;
            push(this.cur, [bx, by]);
        }
        this.px = x; this.py = y; return this;
    }
    quadraticTo(x1, y1, x, y) {
        for (let i = 1; i <= 14; i++) {
            let t = num(i) / 14.0; let u = 1.0 - t;
            let bx = u * u * this.px + 2.0 * u * t * x1 + t * t * x;
            let by = u * u * this.py + 2.0 * u * t * y1 + t * t * y;
            push(this.cur, [bx, by]);
        }
        this.px = x; this.py = y; return this;
    }
    // A circular arc from the current point sweeping `sweep` rad about (cx,cy).
    arcTo(cx, cy, radius, start, sweep) {
        let steps = 24;
        for (let i = 0; i <= steps; i++) {
            let a = start + sweep * num(i) / steps;
            push(this.cur, [cx + cos(a) * radius, cy + sin(a) * radius]);
        }
        let endA = start + sweep; this.px = cx + cos(endA) * radius; this.py = cy + sin(endA) * radius; return this;
    }
    close() { if (len(this.cur) > 0) { push(this.cur, [this.sx, this.sy]); push(this.subs, this.cur); this.cur = []; this.px = this.sx; this.py = this.sy; } return this; }
    polys() { let all = []; for (let i = 0; i < len(this.subs); i++) { push(all, this.subs[i]); } if (len(this.cur) > 0) { push(all, this.cur); } return all; }
}

// ------------------------------------------------------------------ Canvas ----
// The dart:ui Canvas, in the CustomPaint's local units (origin top-left, y-down);
// the widget pre-scales the Painter by the layout unit so coordinates, radii and
// stroke widths are all in units. Each method lowers to the kit's SDF primitives.
class Canvas {
    constructor(app, w, h) { this.app = app; this.pnt = app.painter; this.w = w; this.h = h; }
    // --- transform stack (delegates to the Painter affine) -------------------
    save() { this.pnt.save(); return this; }
    restore() { this.pnt.restore(); return this; }
    translate(dx, dy) { this.pnt.translate(dx, dy); return this; }
    scale(sx, sy) { let yy = sx; if (!isNull(sy)) { if (sy != 0) { yy = sy; } } this.pnt.scale(sx, yy); return this; }
    rotate(t) { this.pnt.rotate(t); return this; }
    // Clip is tracked but not rasterised (the kit is one un-scissored instanced
    // draw); calls are accepted so CustomPainter code ports unchanged.
    clipRect(l, t, r, b) { return this; }
    clipRRect(l, t, r, b, radius) { return this; }
    clipPath(path) { return this; }

    pcol(paint) { if (has(paint, "color")) { return paint.color; } return [0.0, 0.0, 0.0, 1.0]; }
    pstroke(paint) { let w = 0.3; if (has(paint, "strokeWidth")) { w = paint.strokeWidth; } return w; }
    isStroke(paint) { if (has(paint, "style")) { if (paint.style == "stroke") { return 1.0; } } return 0.0; }
    pshader(paint) { if (has(paint, "shader")) { return paint.shader; } return 0; }

    // --- primitives ----------------------------------------------------------
    drawColor(col) { this.drawPaint({ color: col }); return this; }
    drawPaint(paint) {
        let sh = this.pshader(paint);
        if (sh != 0) { paintGradient(this.app, sh, this.w / 2.0, this.h / 2.0, this.w / 2.0, this.h / 2.0, 0.0); return this; }
        this.pnt.rect(this.w / 2.0, this.h / 2.0, this.w / 2.0, this.h / 2.0, 0.0, 0.0, 0.0, this.pcol(paint), CLEAR); return this;
    }
    drawRect(l, t, r, b, paint) { this.drawRRect(l, t, r, b, 0.0, paint); return this; }
    drawRRect(l, t, r, b, radius, paint) {
        let cx = (l + r) / 2.0; let cy = (t + b) / 2.0; let hw = abs(r - l) / 2.0; let hh = abs(b - t) / 2.0;
        let sh = this.pshader(paint);
        if (sh != 0) { paintGradient(this.app, sh, cx, cy, hw, hh, radius); return this; }
        if (this.isStroke(paint) > 0.5) { this.pnt.rect(cx, cy, hw, hh, radius, this.pstroke(paint), 0.0, CLEAR, this.pcol(paint)); }
        else { this.pnt.rect(cx, cy, hw, hh, radius, 0.0, 0.0, this.pcol(paint), CLEAR); }
        return this;
    }
    drawCircle(cx, cy, radius, paint) {
        let sh = this.pshader(paint);
        if (sh != 0) { paintGradient(this.app, sh, cx, cy, radius, radius, radius); return this; }
        if (this.isStroke(paint) > 0.5) { this.pnt.ring(cx, cy, radius, this.pstroke(paint), this.pcol(paint)); }
        else { this.pnt.disc(cx, cy, radius, this.pcol(paint)); }
        return this;
    }
    drawOval(l, t, r, b, paint) {
        let cx = (l + r) / 2.0; let cy = (t + b) / 2.0; let hw = abs(r - l) / 2.0; let hh = abs(b - t) / 2.0;
        this.pnt.rect(cx, cy, hw, hh, min(hw, hh), 0.0, 0.0, this.pcol(paint), CLEAR); return this;
    }
    drawLine(x1, y1, x2, y2, paint) { this.pnt.seg(x1, y1, x2, y2, this.pstroke(paint), this.pcol(paint)); return this; }
    // Mode: "points" (dots), "lines" (segment per consecutive pair) or "polygon".
    drawPoints(mode, pts, paint) {
        let col = this.pcol(paint); let w = this.pstroke(paint);
        if (mode == "points") { for (let i = 0; i < len(pts); i++) { this.pnt.disc(pts[i][0], pts[i][1], w, col); } return this; }
        if (mode == "lines") { for (let i = 0; i + 1 < len(pts); i = i + 2) { this.pnt.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, col); } return this; }
        for (let i = 0; i + 1 < len(pts); i++) { this.pnt.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, col); }
        return this;
    }
    drawPolygon(pts, paint, close) {
        this.drawPoints("polygon", pts, paint);
        if (close > 0.5) { let n = len(pts); if (n > 1) { this.pnt.seg(pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1], this.pstroke(paint), this.pcol(paint)); } }
        return this;
    }
    drawPath(path, paint) {
        let polys = path.polys(); let col = this.pcol(paint); let w = this.pstroke(paint);
        if (this.isStroke(paint) < 0.5) {
            // Convex fill approximation: fan thin spokes from each subpath centroid.
            for (let p = 0; p < len(polys); p++) {
                let poly = polys[p]; let n = len(poly); if (n < 3) { continue; }
                let gx = 0.0; let gy = 0.0; for (let i = 0; i < n; i++) { gx = gx + poly[i][0]; gy = gy + poly[i][1]; }
                gx = gx / n; gy = gy / n;
                for (let i = 0; i < n; i++) { let a = poly[i]; let b = poly[(i + 1) % n]; this.fillTri(gx, gy, a[0], a[1], b[0], b[1], col); }
            }
            return this;
        }
        for (let p = 0; p < len(polys); p++) { let poly = polys[p]; for (let i = 0; i + 1 < len(poly); i++) { this.pnt.seg(poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1], w, col); } }
        return this;
    }
    // A filled triangle, approximated as a fan of capsules from vertex A sweeping
    // across the opposite edge B->C. The spokes spread out toward B->C, so the
    // capsule must be wide enough to close the gap between adjacent endpoints
    // there (|BC|/steps) or the fill breaks up into a starburst of spikes. Both
    // the step count and the thickness scale with the edge length so the fill
    // stays solid at any size (the same gap-closing trick the pie-fill uses).
    fillTri(ax, ay, bx, by, cx, cy, col) {
        let bc = sqrt((cx - bx) * (cx - bx) + (cy - by) * (cy - by));
        let steps = ceil(bc / 0.6); if (steps < 6) { steps = 6; } if (steps > 96) { steps = 96; }
        let thick = bc / steps + 0.3;
        for (let i = 0; i <= steps; i++) {
            let t = num(i) / steps; let ex = bx + (cx - bx) * t; let ey = by + (cy - by) * t;
            this.pnt.seg(ax, ay, ex, ey, thick, col);
        }
        return this;
    }
    // Stroke (or pie-fill, with useCenter) an arc on the ellipse box (l,t,r,b).
    drawArc(l, t, r, b, start, sweep, useCenter, paint) {
        let cx = (l + r) / 2.0; let cy = (t + b) / 2.0; let rx = abs(r - l) / 2.0; let ry = abs(b - t) / 2.0;
        let steps = 40; let col = this.pcol(paint); let w = this.pstroke(paint);
        if (useCenter > 0.5) {
            // Pie fill: one centre->rim spoke per step (a capsule wide enough to
            // close the gap to the next), not a triangle fan per step — ~steps
            // instances instead of steps × fan.
            let rim = max(rx, ry); let thick = rim * abs(sweep) / steps + 0.4;
            for (let i = 0; i <= steps; i++) {
                let a = start + sweep * num(i) / steps;
                this.pnt.seg(cx, cy, cx + cos(a) * rx, cy + sin(a) * ry, thick, col);
            }
            return this;
        }
        let px = cx + cos(start) * rx; let py = cy + sin(start) * ry;
        for (let i = 1; i <= steps; i++) {
            let a = start + sweep * num(i) / steps; let nx = cx + cos(a) * rx; let ny = cy + sin(a) * ry;
            this.pnt.seg(px, py, nx, ny, w, col); px = nx; py = ny;
        }
        return this;
    }
    // A soft drop shadow under a rounded rect (Canvas.drawShadow / BoxShadow).
    drawShadow(l, t, r, b, radius, col, blur) {
        let cx = (l + r) / 2.0; let cy = (t + b) / 2.0; let hw = abs(r - l) / 2.0; let hh = abs(b - t) / 2.0;
        this.pnt.shadowCol(cx, cy, hw, hh, radius, blur * 0.4, blur * 0.3, blur, col); return this;
    }
    // Text, centred on (x,y) by default or left-anchored when align == "left".
    drawText(txt, x, y, opt) {
        let size = 0.5; if (has(opt, "size")) { size = opt.size; }
        let col = [0.0, 0.0, 0.0, 1.0]; if (has(opt, "color")) { col = opt.color; }
        if (has(opt, "align")) { if (opt.align == "left") { this.app.font.textLeft(this.pnt, txt, x, y, size, col); return this; } }
        this.app.font.text(this.pnt, txt, x, y, size, col); return this;
    }
    // A network/storage image into the box (l,t,r,b); rounded by `radius`.
    drawImage(src, l, t, r, b, radius) {
        let cx = (l + r) / 2.0; let cy = (t + b) / 2.0; let hw = abs(r - l) / 2.0; let hh = abs(b - t) / 2.0;
        let s = this.app.media.srcOf(src);
        if (s != 0) { this.app.media.drawMedia(this.pnt, s.key, s.req, 0.0, cx, cy, hw, hh, radius, WHITE); }
        return this;
    }
}

// ------------------------------------------------------------ graphics widgets -
// CustomPaint: hand a `paint(canvas, size)` callback that draws into a Canvas in
// this widget's local units; the kit lowers it to the shared SDF instanced draw.
class CustomPaintWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let w = m.u * 30.0; let h = m.u * 20.0;
        if (has(this.p, "width")) { w = this.p.width * m.u; } if (has(this.p, "height")) { h = this.p.height * m.u; }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let wU = mz.w / m.u; let hU = mz.h / m.u;
        let pnt = app.painter;
        pnt.save(); pnt.translate(cx - hw, cy - hh); pnt.scale(m.u, m.u);
        let canvas = new Canvas(app, wU, hU);
        if (has(this.p, "paint")) { let fn = this.p.paint; fn(canvas, { w: wU, h: hU }); }
        pnt.restore();
        if (has(this.p, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(this.p), this.p.onTap); }
    }
}

// Opacity: fade an entire subtree by `opacity` in [0,1].
class OpacityWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let o = 1.0; if (has(this.p, "opacity")) { o = this.p.opacity; }
        app.painter.save(); app.painter.setAlpha(o);
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        app.painter.restore();
        this._kids = outKids; this.compose();
    }
}

// ColorFiltered: modulate (multiply) and/or offset (add) a subtree's colours —
// the common Flutter ColorFilter.mode(modulate) / matrix tint cases.
class ColorFilteredWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let mul = WHITE; if (has(this.p, "mul")) { mul = this.p.mul; } if (has(this.p, "color")) { mul = this.p.color; }
        let add = CLEAR; if (has(this.p, "add")) { add = this.p.add; }
        app.painter.save(); app.painter.colorFilter(mul, add);
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        app.painter.restore();
        this._kids = outKids; this.compose();
    }
}

// Transform: rotate (`angle`), scale (`scale`/`scaleX`/`scaleY`) and translate
// (`dx`/`dy`, in units) a subtree about its centre.
class TransformWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let m = app.metrics; let p = this.p;
        let ang = 0.0; if (has(p, "angle")) { ang = p.angle; }
        let sx = 1.0; let sy = 1.0; if (has(p, "scale")) { sx = p.scale; sy = p.scale; }
        if (has(p, "scaleX")) { sx = p.scaleX; } if (has(p, "scaleY")) { sy = p.scaleY; }
        let dx = 0.0; let dy = 0.0; if (has(p, "dx")) { dx = p.dx * m.u; } if (has(p, "dy")) { dy = p.dy * m.u; }
        app.painter.save();
        app.painter.translate(cx + dx, cy + dy); app.painter.rotate(ang); app.painter.scale(sx, sy); app.painter.translate(-cx, -cy);
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) { p.child.paint(app, cx, cy); push(outKids, p.child); } }
        app.painter.restore();
        this._kids = outKids; this.compose();
    }
}

// RotatedBox: quarter-turn rotation (`turns` × 90°), swapping the measured box.
class RotatedBoxWidget extends Widget {
    measureIntrinsic(app) {
        let mm = { w: 0.0, h: 0.0 }; if (has(this.p, "child")) { mm = this.p.child.measure(app); }
        let t = 0; if (has(this.p, "turns")) { t = this.p.turns; }
        if (t % 2 != 0) { return { w: mm.h, h: mm.w }; }
        return mm;
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let t = 0; if (has(this.p, "turns")) { t = this.p.turns; }
        app.painter.save(); app.painter.translate(cx, cy); app.painter.rotate(num(t) * 1.5707963); app.painter.translate(-cx, -cy);
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        app.painter.restore();
        this._kids = outKids; this.compose();
    }
}

// ClipRRect / ClipOval: a layout pass-through (the single un-scissored draw can't
// hard-clip a subtree); kept so Flutter clip trees port and a child painted with
// a matching radius reads as clipped. Carries a `radius` hint a child may read.
class ClipRRectWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) { this.paintCenter(app, cx, cy); }
}

// BackdropFilter: a frosted-glass region. Emits a backdrop sentinel over its box
// (the runtime renders everything painted before it into an offscreen texture and
// composites a blurred copy back inside the box), then a translucent frost tint
// and the child are painted sharp on top.
class BackdropFilterWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let mm = { w: m.u * 40.0, h: m.u * 16.0 };
        if (has(this.p, "child")) { mm = this.p.child.measure(app); }
        if (has(this.p, "width")) { mm.w = this.p.width * m.u; } if (has(this.p, "height")) { mm.h = this.p.height * m.u; }
        return mm;
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let r = m.u * 1.4; if (has(p, "radius")) { r = p.radius * m.u; }
        let blur = m.u * 1.6; if (has(p, "blur")) { blur = p.blur * m.u; }
        pnt.backdrop(cx, cy, hw, hh, r, blur, CLEAR);
        let tint = th.surfaceContainer(0.32); if (has(p, "tint")) { tint = p.tint; }
        pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, tint, CLEAR);
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) { p.child.paint(app, cx, cy); push(outKids, p.child); } }
        this._kids = outKids; this.compose();
    }
}
