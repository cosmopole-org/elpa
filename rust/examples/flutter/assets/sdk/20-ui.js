// Elpa Flutter — the dart:ui layer.
//
// The geometry / painting primitives Flutter exposes from its engine: Offset,
// Size, Rect, Radius, RRect, Color, Paint, Gradient, Path, and the Canvas.
// Everything above (the rendering layer) paints by issuing Canvas calls; the
// Canvas lowers them onto the `Painter` raster backend (10-engine). This mirrors
// `package:flutter` calling into `dart:ui`.

// ------------------------------------------------------------- geometry -------
class Offset {
    constructor(dx, dy) { this.dx = dx; this.dy = dy; }
    add(o) { return new Offset(this.dx + o.dx, this.dy + o.dy); }
    sub(o) { return new Offset(this.dx - o.dx, this.dy - o.dy); }
    scaleBy(s) { return new Offset(this.dx * s, this.dy * s); }
}
function offset(dx, dy) { return new Offset(dx, dy); }
let OFFSET_ZERO = new Offset(0.0, 0.0);

class Size {
    constructor(w, h) { this.width = w; this.height = h; }
    // Whether the box (origin top-left) contains a local point.
    contains(p) { if (p.dx >= 0.0) { if (p.dx <= this.width) { if (p.dy >= 0.0) { if (p.dy <= this.height) { return true; } } } } return false; }
}
function size(w, h) { return new Size(w, h); }
let SIZE_ZERO = new Size(0.0, 0.0);

// A rectangle by left/top/width/height (Flutter Rect.fromLTWH).
class Rect {
    constructor(l, t, w, h) { this.left = l; this.top = t; this.width = w; this.height = h; }
    right() { return this.left + this.width; }
    bottom() { return this.top + this.height; }
    cx() { return this.left + this.width / 2.0; }
    cy() { return this.top + this.height / 2.0; }
    deflate(d) { return new Rect(this.left + d, this.top + d, this.width - 2.0 * d, this.height - 2.0 * d); }
    shift(o) { return new Rect(this.left + o.dx, this.top + o.dy, this.width, this.height); }
}
function rectLTWH(l, t, w, h) { return new Rect(l, t, w, h); }
function rectFromOffsetSize(o, s) { return new Rect(o.dx, o.dy, s.width, s.height); }

// A uniform corner radius (one radius per box).
class Radius { constructor(r) { this.r = r; } }
function radiusCircular(r) { return new Radius(r); }
let RADIUS_ZERO = new Radius(0.0);

class RRect { constructor(rect, radius) { this.rect = rect; this.radius = radius; } }
function rrectFromRectAndRadius(rect, radius) { return new RRect(rect, radius); }

// ---------------------------------------------------------------- Color -------
// rgba stored as a [r,g,b,a] float array in 0..1 (the form the Painter wants).
function colorRGBO(r, g, b, o) { return [r / 255.0, g / 255.0, b / 255.0, o]; }
function colorARGB(a, r, g, b) { return [r / 255.0, g / 255.0, b / 255.0, a / 255.0]; }
// Opacity-adjusted copy.
function withOpacity(c, o) { return [c[0], c[1], c[2], o]; }
function colorLerp(a, b, t) { return lerpCol(a, b, t); }

// A small Material-ish palette (rgba arrays).
let Colors = {
    transparent: [0.0, 0.0, 0.0, 0.0],
    black: [0.0, 0.0, 0.0, 1.0],
    white: [1.0, 1.0, 1.0, 1.0],
    red: colorRGBO(244, 67, 54, 1.0),
    pink: colorRGBO(233, 30, 99, 1.0),
    purple: colorRGBO(156, 39, 176, 1.0),
    deepPurple: colorRGBO(103, 58, 183, 1.0),
    indigo: colorRGBO(63, 81, 181, 1.0),
    blue: colorRGBO(33, 150, 243, 1.0),
    lightBlue: colorRGBO(3, 169, 244, 1.0),
    cyan: colorRGBO(0, 188, 212, 1.0),
    teal: colorRGBO(0, 150, 136, 1.0),
    green: colorRGBO(76, 175, 80, 1.0),
    lightGreen: colorRGBO(139, 195, 74, 1.0),
    amber: colorRGBO(255, 193, 7, 1.0),
    orange: colorRGBO(255, 152, 0, 1.0),
    deepOrange: colorRGBO(255, 87, 34, 1.0),
    brown: colorRGBO(121, 85, 72, 1.0),
    grey: colorRGBO(158, 158, 158, 1.0),
    blueGrey: colorRGBO(96, 125, 139, 1.0),
};

// --------------------------------------------------------------- Paint --------
let PaintingStyle = { fill: "fill", stroke: "stroke" };
class Paint {
    constructor() { this.color = [0.0, 0.0, 0.0, 1.0]; this.style = "fill"; this.strokeWidth = 1.0; this.shader = 0; }
}
function paintFill(color) { let p = new Paint(); p.color = color; p.style = "fill"; return p; }
function paintStroke(color, w) { let p = new Paint(); p.color = color; p.style = "stroke"; p.strokeWidth = w; return p; }

// ------------------------------------------------------------- Gradient -------
// Normalised stops `[{ t, col }]` from `colors` (+ optional `stops`).
function gradStops(colors, stops) {
    let n = len(colors); let out = [];
    for (let i = 0; i < n; i++) {
        let t = 0.0; if (n > 1) { t = num(i) / (n - 1.0); }
        if (stops != 0) { if (i < len(stops)) { t = stops[i]; } }
        push(out, { t: t, col: colors[i] });
    }
    return out;
}
function gradColorAt(stops, t) {
    let n = len(stops); if (n == 0) { return CLEAR; }
    if (t <= stops[0].t) { return stops[0].col; }
    if (t >= stops[n - 1].t) { return stops[n - 1].col; }
    for (let i = 0; i < n - 1; i++) {
        let a = stops[i]; let b = stops[i + 1];
        if (t >= a.t) { if (t <= b.t) {
            let span = b.t - a.t; let f = 0.0; if (span > 0.0001) { f = (t - a.t) / span; }
            return lerpCol(a.col, b.col, f);
        } }
    }
    return stops[n - 1].col;
}
// begin/end are alignment-style points in [-1,1]; colors an rgba array list.
function linearGradient(begin, end, colors, stops) {
    return { kind: "linear", begin: begin, end: end, stops: gradStops(colors, stops) };
}
function radialGradient(center, radius, colors, stops) {
    return { kind: "radial", center: center, radius: radius, stops: gradStops(colors, stops) };
}

// --------------------------------------------------------------- Path ---------
// A path as a list of subpaths, each a polyline of [x,y] points. Béziers are
// flattened (Flutter's Skia tessellates them; here we flatten to segments the
// capsule stroker draws). drawPath strokes the polylines.
class Path {
    constructor() { this.subs = []; this.cur = 0; this.px = 0.0; this.py = 0.0; this.sx = 0.0; this.sy = 0.0; }
    moveTo(x, y) { this.cur = [[x, y]]; push(this.subs, this.cur); this.px = x; this.py = y; this.sx = x; this.sy = y; }
    lineTo(x, y) { if (this.cur == 0) { this.moveTo(0.0, 0.0); } push(this.cur, [x, y]); this.px = x; this.py = y; }
    quadraticBezierTo(cx, cy, x, y) {
        let steps = 12;
        for (let i = 1; i <= steps; i++) {
            let t = num(i) / steps; let u = 1.0 - t;
            let qx = u * u * this.px + 2.0 * u * t * cx + t * t * x;
            let qy = u * u * this.py + 2.0 * u * t * cy + t * t * y;
            push(this.cur, [qx, qy]);
        }
        this.px = x; this.py = y;
    }
    cubicTo(x1, y1, x2, y2, x, y) {
        let steps = 14;
        for (let i = 1; i <= steps; i++) {
            let t = num(i) / steps; let u = 1.0 - t;
            let bx = u * u * u * this.px + 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t * x;
            let by = u * u * u * this.py + 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t * y;
            push(this.cur, [bx, by]);
        }
        this.px = x; this.py = y;
    }
    close() { if (this.cur != 0) { push(this.cur, [this.sx, this.sy]); this.px = this.sx; this.py = this.sy; } }
}
function path() { return new Path(); }

// --------------------------------------------------------------- Canvas -------
// The dart:ui Canvas. Drawing is in *local* coordinates; the save/translate/
// scale/rotate stack (delegated to the Painter) places it. Each call lowers to a
// Vello scene op carrying the active transform.
class Canvas {
    constructor(painter, font) { this.painter = painter; this.font = font; }
    save() { this.painter.save(); }
    restore() { this.painter.restore(); }
    translate(dx, dy) { this.painter.translate(dx, dy); }
    scale(sx, sy) { this.painter.scale(sx, sy); }
    rotate(t) { this.painter.rotate(t); }
    // Clipping pushes a real Vello clip layer (a rounded-rect), popped when the
    // matching save/restore scope unwinds — nested clips intersect naturally.
    clipRect(rect) { this.painter.setClip(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, 0.0); }
    clipRRect(rr) { this.painter.setClip(rr.rect.cx(), rr.rect.cy(), rr.rect.width / 2.0, rr.rect.height / 2.0, rr.radius.r); }
    clipOval(rect) { this.painter.setClip(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, min(rect.width, rect.height) / 2.0); }

    drawColor(c) {
        // Fill an enormous rect; the binding clears to the scaffold colour, so this
        // is for explicit full-canvas paints.
        this.painter.rrect(0.0, 0.0, 100000.0, 100000.0, 0.0, 0.0, 0.0, c, CLEAR);
    }
    drawRect(rect, paint) {
        if (paint.shader != 0) { this.fillGradient(rect, RADIUS_ZERO, paint.shader); return 0; }
        if (paint.style == "stroke") { this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, 0.0, paint.strokeWidth, 0.0, CLEAR, paint.color); return 0; }
        this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, 0.0, 0.0, 0.0, paint.color, CLEAR);
    }
    drawRRect(rr, paint) {
        let rect = rr.rect; let r = rr.radius.r;
        if (paint.shader != 0) { this.fillGradient(rect, rr.radius, paint.shader); return 0; }
        if (paint.style == "stroke") { this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, paint.strokeWidth, 0.0, CLEAR, paint.color); return 0; }
        this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, 0.0, 0.0, paint.color, CLEAR);
    }
    drawCircle(center, r, paint) {
        if (paint.style == "stroke") { this.painter.ring(center.dx, center.dy, r, paint.strokeWidth, paint.color); return 0; }
        this.painter.circle(center.dx, center.dy, r, paint.color);
    }
    drawOval(rect, paint) {
        // Approximated as a max-radius rounded rect (a true ellipse when
        // square → a circle; otherwise a stadium).
        let r = min(rect.width, rect.height) / 2.0;
        if (paint.style == "stroke") { this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, paint.strokeWidth, 0.0, CLEAR, paint.color); return 0; }
        this.painter.rrect(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, 0.0, 0.0, paint.color, CLEAR);
    }
    drawLine(p1, p2, paint) { this.painter.line(p1.dx, p1.dy, p2.dx, p2.dy, paint.strokeWidth, paint.color); }
    drawPath(p, paint) {
        let th = paint.strokeWidth; if (th < 0.5) { th = 0.5; }
        for (let s = 0; s < len(p.subs); s++) {
            let poly = p.subs[s];
            for (let i = 0; i < len(poly) - 1; i++) {
                this.painter.line(poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1], th, paint.color);
            }
        }
    }
    // A soft drop shadow for a rounded rect (Canvas.drawShadow analog).
    drawShadow(rect, r, color, elevation) {
        let blur = elevation * 1.6 + 1.0; let grow = elevation * 0.4;
        this.painter.shadow(rect.cx(), rect.cy(), rect.width / 2.0, rect.height / 2.0, r, grow, 0.0, elevation * 0.5, blur, color);
    }
    // Text: top-left of the text box at `o`, `cell` the glyph scale.
    drawText(s, o, cell, color) { this.font.paintLeftTop(this.painter, s, o.dx, o.dy, cell, color); }

    // ---- gradient fill (multi-stop, banded into solid Vello fills) -----------
    fillGradient(rect, radius, g) {
        if (g.kind == "radial") { this.fillRadial(rect, g); return 0; }
        this.fillLinear(rect, radius, g);
    }
    fillLinear(rect, radius, g) {
        let bx0 = g.begin.dx; let by0 = g.begin.dy; let bx1 = g.end.dx; let by1 = g.end.dy;
        let horiz = 1.0; if (abs(by1 - by0) > abs(bx1 - bx0)) { horiz = 0.0; }
        let bands = 12; let cx = rect.cx(); let cy = rect.cy(); let hw = rect.width / 2.0; let hh = rect.height / 2.0;
        this.painter.rrect(cx, cy, hw, hh, radius.r, 0.0, 0.0, gradColorAt(g.stops, 0.0), CLEAR);
        for (let i = 0; i < bands; i++) {
            let t0 = num(i) / bands; let t1 = (num(i) + 1.0) / bands; let tm = (t0 + t1) / 2.0;
            let col = gradColorAt(g.stops, tm);
            if (horiz > 0.5) {
                let x = cx - hw + (t0 + t1) * hw; let bw = (t1 - t0) * hw + 0.6;
                this.painter.rrect(x, cy, bw, hh, 0.0, 0.0, 0.0, col, CLEAR);
            } else {
                let y = cy - hh + (t0 + t1) * hh; let bh = (t1 - t0) * hh + 0.6;
                this.painter.rrect(cx, y, hw, bh, 0.0, 0.0, 0.0, col, CLEAR);
            }
        }
    }
    fillRadial(rect, g) {
        let cx = rect.cx(); let cy = rect.cy(); let radius = min(rect.width, rect.height) / 2.0;
        let rings = 14;
        for (let i = 0; i < rings; i++) {
            let t = 1.0 - num(i) / rings; let rr = radius * (1.0 - num(i) / rings);
            this.painter.circle(cx, cy, rr + 0.6, gradColorAt(g.stops, t));
        }
    }
}

// A PictureRecorder is a no-op shim here (the binding paints straight to the live
// surface). Provided so dart:ui-style code that records a picture still parses.
class PictureRecorder { constructor() {} }
