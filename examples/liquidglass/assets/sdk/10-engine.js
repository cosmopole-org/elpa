// Elpa Liquid Glass — engine services.
//
// The drawing/theming/layout machinery the runtime owns and threads to widgets
// while they measure and paint:
//
//   GlassPainter    — emits the 20-float instances (solid rects, glass lenses,
//                     shadows, glyphs, capsules, discs, rings, gradients) and hit
//                     regions into whatever buffers the runtime points it at, with
//                     a Canvas-style transform / opacity stack.
//   GlassTheme      — the animated Liquid-Glass scheme: a vivid wallpaper to
//                     refract, translucent glass tints, specular rim, ink colours,
//                     the accent palette, and the light↔dark cross-fade.
//   Metrics         — the responsive layout coordinator (window size classes).
//   FontEngine      — the host glyph atlas + proportional text layout, with the
//                     stroke-vector fallback.
//   IconEngine      — the built-in vector icon set and the SVG-path stroker.
//   AnimationClock  — eased 0..1 values + press layers with per-key subscriber
//                     tracking, so the frame clock repaints only what is moving.

function bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }

// --------------------------------------------------------------- GlassPainter -
class GlassPainter {
    constructor() {
        this.out = []; this.taps = []; this.drags = [];
        this.xdepth = 0; this.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        this.alpha = 1.0; this.xstack = [];
    }
    into(out, taps, drags) { this.out = out; this.taps = taps; this.drags = drags; }
    outInto(out) { this.out = out; }

    // ---- transform / opacity stack (for Transform / Opacity widgets) ---------
    save() { push(this.xstack, [this.m[0], this.m[1], this.m[2], this.m[3], this.m[4], this.m[5], this.alpha]); this.xdepth = this.xdepth + 1; }
    restore() { if (this.xdepth <= 0) { return 0; } let s = pop(this.xstack); this.xdepth = this.xdepth - 1; this.m = [s[0], s[1], s[2], s[3], s[4], s[5]]; this.alpha = s[6]; return 0; }
    translate(dx, dy) { let m = this.m; m[4] = m[4] + m[0] * dx + m[2] * dy; m[5] = m[5] + m[1] * dx + m[3] * dy; }
    scale(sx, sy) { let m = this.m; m[0] = m[0] * sx; m[1] = m[1] * sx; m[2] = m[2] * sy; m[3] = m[3] * sy; }
    rotate(t) { let c = cos(t); let s = sin(t); let m = this.m; let a0 = m[0]; let b0 = m[1]; let c0 = m[2]; let d0 = m[3]; m[0] = a0 * c + c0 * s; m[1] = b0 * c + d0 * s; m[2] = a0 * (-s) + c0 * c; m[3] = b0 * (-s) + d0 * c; }
    setAlpha(a) { this.alpha = this.alpha * a; }
    xpt(x, y) { let m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    xsx() { let m = this.m; return sqrt(m[0] * m[0] + m[1] * m[1]); }
    xsy() { let m = this.m; return sqrt(m[2] * m[2] + m[3] * m[3]); }
    xrot() { let m = this.m; return atan2(m[1], m[0]); }
    xcol(c) { return [c[0], c[1], c[2], c[3] * this.alpha]; }

    // ---- the one 20-float instance emitter -----------------------------------
    push20(cx, cy, hw, hh, b0, b1, b2, b3, fill, bcol, kind, refr, spec, blur) {
        let o = this.out;
        push(o, cx); push(o, cy); push(o, hw); push(o, hh);
        push(o, b0); push(o, b1); push(o, b2); push(o, b3);
        push(o, fill[0]); push(o, fill[1]); push(o, fill[2]); push(o, fill[3]);
        push(o, bcol[0]); push(o, bcol[1]); push(o, bcol[2]); push(o, bcol[3]);
        push(o, kind); push(o, refr); push(o, spec); push(o, blur);
    }

    // A solid rounded-rect SDF instance (fill + border), honouring the transform.
    rect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
        if (this.xdepth > 0) {
            let p = this.xpt(cx, cy); let sx = this.xsx(); let sy = this.xsy(); let sa = (sx + sy) * 0.5;
            this.push20(p[0], p[1], hw * sx, hh * sy, r * sa, border * sa, rot + this.xrot(), 1.0, this.xcol(fill), this.xcol(bcol), KIND_SOLID, 0.0, 0.0, 0.0);
            return 0;
        }
        this.push20(cx, cy, hw, hh, r, border, rot, 1.0, fill, bcol, KIND_SOLID, 0.0, 0.0, 0.0);
    }
    // A liquid-glass lens. `tint` is the translucent glass colour; `rim` the
    // subtle border-line colour; refraction/specular/blur are px-scale strengths.
    glass(cx, cy, hw, hh, r, border, rot, tint, rim, refr, spec, blur) {
        if (this.xdepth > 0) {
            let p = this.xpt(cx, cy); let sx = this.xsx(); let sy = this.xsy(); let sa = (sx + sy) * 0.5;
            this.push20(p[0], p[1], hw * sx, hh * sy, r * sa, border * sa, rot + this.xrot(), 1.0, this.xcol(tint), this.xcol(rim), KIND_GLASS, refr * sa, spec, blur * sa);
            return 0;
        }
        this.push20(cx, cy, hw, hh, r, border, rot, 1.0, tint, rim, KIND_GLASS, refr, spec, blur);
    }
    // A soft drop shadow (grown, dropped, heavily-feathered).
    shadow(cx, cy, hw, hh, r, grow, drop, blur, col) {
        let a = col[3];
        if (this.xdepth > 0) {
            let p = this.xpt(cx, cy + drop); let sx = this.xsx(); let sy = this.xsy(); let sa = (sx + sy) * 0.5;
            cx = p[0]; cy = -drop + p[1]; hw = hw * sx; hh = hh * sy; r = r * sa; grow = grow * sa; blur = blur * sa; a = a * this.alpha;
        }
        this.push20(cx, cy + drop, hw + grow, hh + grow, r + grow, 0.0, 0.0, blur, [col[0], col[1], col[2], a], CLEAR, KIND_SHADOW, 0.0, 0.0, 0.0);
    }
    // A textured glyph quad: b carries the atlas uv rect (u0,v0,u1,v1).
    glyph(cx, cy, hw, hh, u0, v0, u1, v1, col) {
        if (this.xdepth > 0) {
            let p = this.xpt(cx, cy); let sx = this.xsx(); let sy = this.xsy();
            cx = p[0]; cy = p[1]; hw = hw * sx; hh = hh * sy; col = this.xcol(col);
        }
        this.push20(cx, cy, hw, hh, u0, v0, u1, v1, col, CLEAR, KIND_GLYPH, 0.0, 0.0, 0.0);
    }
    // Primitives composed from the solid rounded rect.
    seg(ax, ay, bx, by, thick, col) { let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy); this.rect((ax + bx) / 2.0, (ay + by) / 2.0, ln / 2.0 + thick / 2.0, thick / 2.0, thick / 2.0, 0.0, atan2(dy, dx), col, CLEAR); }
    disc(cx, cy, r, col) { this.rect(cx, cy, r, r, r, 0.0, 0.0, col, CLEAR); }
    ring(cx, cy, r, w, col) { this.rect(cx, cy, r, r, r, w, 0.0, CLEAR, col); }
    capsule(cx, cy, hw, hh, rot, col) { this.rect(cx, cy, hw, hh, min(hw, hh), 0.0, rot, col, CLEAR); }

    // ---- gradients (multi-stop, from the one solid primitive) ----------------
    gradLinear(cx, cy, hw, hh, r, stops, bx0, by0, bx1, by1) {
        let horiz = 1.0; if (abs(by1 - by0) > abs(bx1 - bx0)) { horiz = 0.0; }
        let bands = 22; let base = gradColorAt(stops, 0.0);
        this.rect(cx, cy, hw, hh, r, 0.0, 0.0, base, CLEAR);
        for (let i = 0; i < bands; i++) {
            let t0 = num(i) / bands; let t1 = (num(i) + 1.0) / bands; let tm = (t0 + t1) / 2.0;
            let col = gradColorAt(stops, tm);
            if (horiz > 0.5) { let x = cx - hw + (t0 + t1) * hw; let bw = (t1 - t0) * hw + 0.6; this.rect(x, cy, bw, hh, 0.0, 0.0, 0.0, col, CLEAR); }
            else { let y = cy - hh + (t0 + t1) * hh; let bh = (t1 - t0) * hh + 0.6; this.rect(cx, y, hw, bh, 0.0, 0.0, 0.0, col, CLEAR); }
        }
        this.rect(cx, cy, hw, hh, r, 0.0, 0.0, CLEAR, CLEAR);
    }
    gradRadial(cx, cy, radius, stops) { let rings = 22; for (let i = 0; i < rings; i++) { let t = 1.0 - num(i) / rings; let rr = radius * (1.0 - num(i) / rings); this.disc(cx, cy, rr + 0.6, gradColorAt(stops, t)); } }

    addTap(cx, cy, hw, hh, id, onTap) { push(this.taps, { cx: cx, cy: cy, hw: hw, hh: hh, id: id, onTap: onTap }); }
    addDrag(cx, cy, hw, hh, onChanged, left, width) { push(this.drags, { cx: cx, cy: cy, hw: hw, hh: hh, onDrag: (px) => { onChanged(clamp01((px - left) / width)); } }); }
}

// ----------------------------------------------------------------- GlassTheme -
// The animated Liquid-Glass scheme. A vivid wallpaper gives the glass something
// to refract; the chrome itself is translucent glass over it. Every role mixes
// its light and dark tone by `darkAnim`, so a theme toggle eases the whole UI.
class GlassTheme {
    constructor() { this.darkTarget = 0.0; this.darkAnim = 0.0; this.accent = 0; }
    set(darkTarget, accent) { this.darkTarget = darkTarget; this.accent = accent; }
    mix(l, d) { return l * (1.0 - this.darkAnim) + d * this.darkAnim; }
    // The wallpaper gradient stops (top→bottom), as { t, col } — vivid in light,
    // deep in dark. Used by the runtime to paint the refractable background.
    wallpaper() {
        let a = [this.mix(0.04, 0.03), this.mix(0.45, 0.05), this.mix(0.96, 0.18)];
        let b = [this.mix(0.45, 0.06), this.mix(0.30, 0.05), this.mix(0.95, 0.30)];
        let c = [this.mix(0.98, 0.10), this.mix(0.32, 0.04), this.mix(0.62, 0.22)];
        let d = [this.mix(1.00, 0.16), this.mix(0.62, 0.10), this.mix(0.30, 0.14)];
        return [{ t: 0.0, col: [a[0], a[1], a[2], 1.0] }, { t: 0.4, col: [b[0], b[1], b[2], 1.0] }, { t: 0.72, col: [c[0], c[1], c[2], 1.0] }, { t: 1.0, col: [d[0], d[1], d[2], 1.0] }];
    }
    bg() { let w = this.wallpaper(); return [w[0].col[0], w[0].col[1], w[0].col[2]]; }
    // Translucent glass tint over the refracted backdrop. `s` scales opacity.
    glass(s) { return [this.mix(1.0, 0.12), this.mix(1.0, 0.13), this.mix(1.0, 0.17), this.mix(0.16, 0.34) * s]; }
    glassThin() { return this.glass(0.7); }
    glassThick() { return this.glass(1.5); }
    // Specular rim-line colour (bright in both schemes).
    rim(a) { return [this.mix(1.0, 0.9), this.mix(1.0, 0.92), this.mix(1.0, 1.0), this.mix(0.55, 0.30) * a]; }
    // Text / icon ink.
    ink(a) { return [this.mix(0.10, 0.98), this.mix(0.11, 0.98), this.mix(0.14, 1.0), a]; }
    inkSoft(a) { return [this.mix(0.30, 0.78), this.mix(0.31, 0.80), this.mix(0.36, 0.86), a]; }
    accCh(i) { return ACC_LIGHT[this.accent][i] * (1.0 - this.darkAnim) + ACC_DARK[this.accent][i] * this.darkAnim; }
    acc(a) { return [this.accCh(0), this.accCh(1), this.accCh(2), a]; }
    onAcc(a) { return [1.0, 1.0, 1.0, a]; }
    brighten(col, amt) { return [col[0] + amt, col[1] + amt, col[2] + amt, col[3]]; }
    colorRole(name, a) {
        if (name == "primary") { return this.acc(a); }
        if (name == "onPrimary") { return this.onAcc(a); }
        if (name == "glass") { let c = this.glass(1.0); return [c[0], c[1], c[2], c[3] * a]; }
        if (name == "ink") { return this.ink(a); }
        if (name == "inkSoft") { return this.inkSoft(a); }
        if (name == "rim") { return this.rim(a); }
        return this.glass(1.0);
    }
    inkColor(ink) { if (ink == "accent") { return this.acc(1.0); } if (ink == "onAccent") { return this.onAcc(1.0); } if (ink == "soft") { return this.inkSoft(1.0); } return this.ink(1.0); }
}

// --------------------------------------------------------------- Metrics ------
// Responsive layout coordinator: Material-style window size classes keyed off the
// logical (dp) width pick the layout unit, type scale, chrome density and spacing.
class Metrics {
    constructor() {
        this.vw = 1.0; this.vh = 1.0; this.u = 1.0; this.dpr = 1.0;
        this.lw = 1.0; this.lh = 1.0; this.cls = 2;
        this.type = 1.0; this.dens = 1.0; this.sp = 1.0;
        this.saT = 0.0; this.saR = 0.0; this.saB = 0.0; this.saL = 0.0;
    }
    setMetrics(si) {
        this.vw = num(si.width); this.vh = num(si.height);
        if (has(si, "colorFormat")) { SURFACE_FMT = si.colorFormat; }
        this.dpr = 1.0; if (has(si, "scaleFactor")) { this.dpr = num(si.scaleFactor); }
        if (this.dpr < 0.1) { this.dpr = 1.0; }
        this.lw = this.vw / this.dpr; this.lh = this.vh / this.dpr;
        if (has(si, "logicalWidth")) { this.lw = num(si.logicalWidth); }
        if (has(si, "logicalHeight")) { this.lh = num(si.logicalHeight); }
        if (this.lw < 600.0) { this.cls = 0; } else { if (this.lw < 840.0) { this.cls = 1; } else { this.cls = 2; } }
        if (this.cls == 0) { this.type = 1.5; this.dens = 1.8; this.sp = 1.4; }
        else { if (this.cls == 1) { this.type = 1.22; this.dens = 1.4; this.sp = 1.2; } else { this.type = 1.0; this.dens = 1.0; this.sp = 1.0; } }
        this.saT = 0.0; this.saR = 0.0; this.saB = 0.0; this.saL = 0.0;
        if (has(si, "safeArea")) {
            let sa = si.safeArea;
            if (has(sa, "top")) { this.saT = num(sa.top); }
            if (has(sa, "right")) { this.saR = num(sa.right); }
            if (has(sa, "bottom")) { this.saB = num(sa.bottom); }
            if (has(sa, "left")) { this.saL = num(sa.left); }
        }
        this.u = this.unit();
    }
    unit() {
        let colDp = this.lw - 24.0;
        if (this.cls == 1) { colDp = min(this.lw - 64.0, 720.0); }
        if (this.cls == 2) { colDp = min(this.lw * 0.9, 860.0); }
        if (colDp < 240.0) { colDp = this.lw; }
        return colDp / 96.0 * this.dpr;
    }
    sizeClass() { if (this.cls == 0) { return "compact"; } if (this.cls == 1) { return "medium"; } return "expanded"; }
    isCompact() { if (this.cls == 0) { return 1.0; } return 0.0; }
    isMedium() { if (this.cls == 1) { return 1.0; } return 0.0; }
    isExpanded() { if (this.cls == 2) { return 1.0; } return 0.0; }
    du() { return this.u * this.dens; }
    cell(size) {
        if (size == "headline") { return this.u * 0.82 * this.type; }
        if (size == "title") { return this.u * 0.55 * this.type; }
        if (size == "body") { return this.u * 0.42 * this.type; }
        if (size == "label") { return this.u * 0.40 * this.type; }
        if (size == "caption") { return this.u * 0.32 * this.type; }
        if (size == "micro") { return this.u * 0.26 * this.type; }
        return this.u * 0.40 * this.type;
    }
    cellOf(p) {
        if (has(p, "px")) { return p.px / 6.0; }
        let s = "body"; if (has(p, "size")) { s = p.size; }
        if (typeOf(s) == "number") { return this.u * s * this.type; }
        return this.cell(s);
    }
    weightThick(p) {
        if (!has(p, "weight")) { return 0.92; }
        let w = p.weight;
        if (typeOf(w) == "number") { return 0.5 + w / 1000.0; }
        if (w == "thin") { return 0.6; }
        if (w == "light") { return 0.72; }
        if (w == "regular") { return 0.92; }
        if (w == "medium") { return 1.05; }
        if (w == "semibold") { return 1.18; }
        if (w == "bold") { return 1.32; }
        return 0.92;
    }
    padOf(p) {
        let l = 0.0; let r = 0.0; let t = 0.0; let b = 0.0;
        if (has(p, "pad")) { l = p.pad; r = p.pad; t = p.pad; b = p.pad; }
        if (has(p, "padX")) { l = p.padX; r = p.padX; }
        if (has(p, "padY")) { t = p.padY; b = p.padY; }
        if (has(p, "padL")) { l = p.padL; }
        if (has(p, "padR")) { r = p.padR; }
        if (has(p, "padT")) { t = p.padT; }
        if (has(p, "padB")) { b = p.padB; }
        return { l: l * this.u * this.sp, r: r * this.u * this.sp, t: t * this.u * this.sp, b: b * this.u * this.sp };
    }
    safeInsets(p) {
        let t = this.saT; let r = this.saR; let b = this.saB; let l = this.saL;
        if (has(p, "top")) { if (p.top < 0.5) { t = 0.0; } }
        if (has(p, "right")) { if (p.right < 0.5) { r = 0.0; } }
        if (has(p, "bottom")) { if (p.bottom < 0.5) { b = 0.0; } }
        if (has(p, "left")) { if (p.left < 0.5) { l = 0.0; } }
        return { l: l, r: r, t: t, b: b };
    }
    gapPx(p) { if (has(p, "gap")) { return p.gap * this.u * this.sp; } return this.u * 2.0 * this.sp; }
    iconR(p) { if (has(p, "size")) { return p.size * this.u * 0.5; } return this.u * 1.8; }
}

// ------------------------------------------------------------ FontEngine ------
// Real text from a host-rasterised coverage atlas (regular + bold), with a
// proportional layout and the stroke-vector fallback when no atlas is available.
class FontEngine {
    constructor() { this.atlas = 0; this.atlasUp = 0.0; this.fontSrc = 0; this.hasFont = 0.0; this.fontVer = 0; }
    textScale(cell) { if (this.atlas == 0) { return cell * 0.2; } return cell * 6.6 / this.atlas.pxSize; }
    glyphMap(thick) { if (thick > 1.1) { return this.atlas.bold; } return this.atlas.regular; }
    textW(str, cell) {
        if (this.atlas == 0) { return len(str) * 5.0 * cell; }
        let g = this.atlas.regular; let sc = this.textScale(cell); let w = 0.0;
        for (let i = 0; i < len(str); i++) { let ch = charAt(str, i); if (has(g, ch)) { w = w + g[ch].adv * sc; } }
        return w;
    }
    paintCentered(painter, str, cx, cy, cell, col, thick, font) {
        if (this.atlas == 0) { this.paintCapsules(painter, str, cx, cy, cell, col, thick, font); return 0; }
        let g = this.glyphMap(thick); let sc = this.textScale(cell);
        let aw = this.atlas.width; let ah = this.atlas.height; let n = len(str);
        let tw = 0.0;
        for (let i = 0; i < n; i++) { let ch = charAt(str, i); if (has(g, ch)) { tw = tw + g[ch].adv * sc; } }
        let penX = cx - tw / 2.0;
        let baseline = cy + (this.atlas.ascent + this.atlas.descent) * sc / 2.0;
        for (let i = 0; i < n; i++) {
            let ch = charAt(str, i);
            if (has(g, ch)) {
                let gg = g[ch];
                if (gg.w > 0.0) {
                    let gw = gg.w * sc; let gh = gg.h * sc;
                    let glx = penX + gg.bx * sc;
                    let gtop = baseline - (gg.by + gg.h) * sc;
                    painter.glyph(glx + gw / 2.0, gtop + gh / 2.0, gw / 2.0, gh / 2.0, gg.x / aw, gg.y / ah, (gg.x + gg.w) / aw, (gg.y + gg.h) / ah, col);
                }
                penX = penX + gg.adv * sc;
            }
        }
    }
    paintCapsules(painter, str, cx, cy, cell, col, thick, font) {
        let glyphs = GLYPHS;
        if (font != 0) { glyphs = font; } else { str = upper(str); }
        let nch = len(str); let adv = 5.0; let th = thick;
        for (let ci = 0; ci < nch; ci++) {
            let ch = charAt(str, ci);
            if (has(glyphs, ch)) {
                let segs = glyphs[ch];
                let gc = (ci - (nch - 1.0) / 2.0) * adv;
                for (let si = 0; si < len(segs); si++) {
                    let s = segs[si];
                    let ax = gc - 2.0 + s[0]; let ay = s[1] - 3.0;
                    let bx = gc - 2.0 + s[2]; let by = s[3] - 3.0;
                    let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
                    painter.rect(cx + cell * (ax + bx) / 2.0, cy + cell * (ay + by) / 2.0, cell * ln / 2.0, cell * th / 2.0, cell * th / 2.0, 0.0, atan2(dy, dx), col, CLEAR);
                }
            }
        }
    }
    text(painter, str, cx, cy, cell, col) { this.paintCentered(painter, str, cx, cy, cell, col, 0.92, 0); }
    textW2(str, cell) { return this.textW(str, cell); }
    textLeft(painter, str, x, cy, cell, col) { this.text(painter, str, x + this.textW(str, cell) / 2.0, cy, cell, col); }
    ellipsize(str, cell, maxW) {
        if (maxW <= 0.0) { return ""; }
        if (this.textW(str, cell) <= maxW) { return str; }
        let ell = "..."; let ew = this.textW(ell, cell); let n = len(str); let fit = "";
        for (let i = 0; i < n; i++) { let next = concat(fit, charAt(str, i)); if (this.textW(next, cell) + ew > maxW) { i = n; } else { fit = next; } }
        return concat(fit, ell);
    }
    textLeftClip(painter, str, x, cy, cell, col, maxW) { this.textLeft(painter, this.ellipsize(str, cell, maxW), x, cy, cell, col); }
    loadAtlas() {
        let req = { size: 48.0 };
        if (this.hasFont > 0.5) {
            if (has(this.fontSrc, "url")) { req.url = this.fontSrc.url; }
            if (has(this.fontSrc, "boldUrl")) { req.boldUrl = this.fontSrc.boldUrl; }
            if (has(this.fontSrc, "path")) { req.path = this.fontSrc.path; }
            if (has(this.fontSrc, "boldPath")) { req.boldPath = this.fontSrc.boldPath; }
        }
        let r = askHost("text.atlas", [req]);
        if (isNull(r)) { return 0; }
        if (!has(r, "ok")) { return 0; }
        if (!r.ok) { return 0; }
        this.atlas = r; this.atlasUp = 0.0; return 0;
    }
    applyFont(src, hasFont) { this.fontSrc = src; this.hasFont = hasFont; this.atlas = 0; this.atlasUp = 0.0; this.fontVer = this.fontVer + 1; }
    atlasId() { return concat("elpa.lg.atlas.", str(this.fontVer)); }
    atlasTexRes() {
        let w = 1; let h = 1; if (this.atlas != 0) { w = this.atlas.width; h = this.atlas.height; }
        return [
            { kind: "texture", id: this.atlasId(), size: { width: w, height: h }, format: "r8unorm", usage: ["TEXTURE_BINDING", "COPY_DST"] },
            { kind: "sampler", id: "elpa.lg.samp", mag_filter: "linear", min_filter: "linear", mipmap_filter: "linear" },
        ];
    }
    atlasUploadCmds() {
        if (this.atlas == 0) { return []; }
        if (this.atlasUp > 0.5) { return []; }
        this.atlasUp = 1.0;
        return [{ op: "writeTexture", texture: this.atlasId(), origin: { x: 0, y: 0, z: 0 }, size: { width: this.atlas.width, height: this.atlas.height }, data_b64: this.atlas.data }];
    }
}

// ------------------------------------------------------------ IconEngine ------
// Built-in vector icons (capsules/discs/rings) and a stroke-only SVG path
// renderer (M/L/H/V/C/Q/Z, absolute + relative, Béziers flattened).
class IconEngine {
    constructor() { this.svgIcons = {}; }
    registerIcon(name, d, viewBox) { let vb = 24.0; if (viewBox != 0) { vb = viewBox; } this.svgIcons[name] = { d: d, vb: vb }; }
    draw(painter, name, cx, cy, r, col) {
        let t = r * 0.16;
        if (has(this.svgIcons, name)) { let g = this.svgIcons[name]; this.iconSvg(painter, g.d, cx, cy, r, t, col, g.vb); return 0; }
        if (name == "add") { painter.seg(cx - r * 0.62, cy, cx + r * 0.62, cy, t, col); painter.seg(cx, cy - r * 0.62, cx, cy + r * 0.62, t, col); return 0; }
        if (name == "close") { painter.seg(cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5, t, col); painter.seg(cx - r * 0.5, cy + r * 0.5, cx + r * 0.5, cy - r * 0.5, t, col); return 0; }
        if (name == "check") { painter.seg(cx - r * 0.55, cy + r * 0.05, cx - r * 0.12, cy + r * 0.5, t, col); painter.seg(cx - r * 0.12, cy + r * 0.5, cx + r * 0.6, cy - r * 0.45, t, col); return 0; }
        if (name == "menu") { painter.seg(cx - r * 0.6, cy - r * 0.45, cx + r * 0.6, cy - r * 0.45, t, col); painter.seg(cx - r * 0.6, cy, cx + r * 0.6, cy, t, col); painter.seg(cx - r * 0.6, cy + r * 0.45, cx + r * 0.6, cy + r * 0.45, t, col); return 0; }
        if (name == "back") { painter.seg(cx + r * 0.5, cy, cx - r * 0.5, cy, t, col); painter.seg(cx - r * 0.5, cy, cx, cy - r * 0.45, t, col); painter.seg(cx - r * 0.5, cy, cx, cy + r * 0.45, t, col); return 0; }
        if (name == "search") { painter.ring(cx - r * 0.15, cy - r * 0.15, r * 0.45, t * 0.8, col); painter.seg(cx + r * 0.2, cy + r * 0.2, cx + r * 0.62, cy + r * 0.62, t, col); return 0; }
        if (name == "settings") { painter.ring(cx, cy, r * 0.4, t * 0.8, col); for (let i = 0; i < 8; i++) { let a = i * 0.785; painter.seg(cx + cos(a) * r * 0.5, cy + sin(a) * r * 0.5, cx + cos(a) * r * 0.78, cy + sin(a) * r * 0.78, t * 0.9, col); } return 0; }
        if (name == "home") { painter.seg(cx - r * 0.6, cy - r * 0.05, cx, cy - r * 0.6, t, col); painter.seg(cx, cy - r * 0.6, cx + r * 0.6, cy - r * 0.05, t, col); painter.seg(cx - r * 0.42, cy - r * 0.1, cx - r * 0.42, cy + r * 0.55, t, col); painter.seg(cx + r * 0.42, cy - r * 0.1, cx + r * 0.42, cy + r * 0.55, t, col); painter.seg(cx - r * 0.42, cy + r * 0.55, cx + r * 0.42, cy + r * 0.55, t, col); return 0; }
        if (name == "heart") { painter.disc(cx - r * 0.28, cy - r * 0.18, r * 0.32, col); painter.disc(cx + r * 0.28, cy - r * 0.18, r * 0.32, col); painter.rect(cx, cy + r * 0.12, r * 0.42, r * 0.42, r * 0.12, 0.0, 0.785, col, CLEAR); return 0; }
        if (name == "star") { for (let i = 0; i < 5; i++) { let a = i * 1.2566 - 1.5708; painter.seg(cx, cy, cx + cos(a) * r * 0.75, cy + sin(a) * r * 0.75, t * 1.4, col); } return 0; }
        if (name == "play") { painter.seg(cx - r * 0.3, cy - r * 0.5, cx + r * 0.55, cy, t, col); painter.seg(cx + r * 0.55, cy, cx - r * 0.3, cy + r * 0.5, t, col); painter.seg(cx - r * 0.3, cy - r * 0.5, cx - r * 0.3, cy + r * 0.5, t, col); return 0; }
        if (name == "pause") { painter.rect(cx - r * 0.3, cy, t * 1.1, r * 0.55, t * 0.4, 0.0, 0.0, col, CLEAR); painter.rect(cx + r * 0.3, cy, t * 1.1, r * 0.55, t * 0.4, 0.0, 0.0, col, CLEAR); return 0; }
        if (name == "person") { painter.disc(cx, cy - r * 0.35, r * 0.34, col); painter.rect(cx, cy + r * 0.45, r * 0.5, r * 0.32, r * 0.3, 0.0, 0.0, col, CLEAR); return 0; }
        if (name == "bell") { painter.disc(cx, cy + r * 0.55, t * 0.8, col); painter.seg(cx - r * 0.42, cy + r * 0.25, cx + r * 0.42, cy + r * 0.25, t, col); painter.seg(cx - r * 0.42, cy + r * 0.25, cx - r * 0.32, cy - r * 0.35, t, col); painter.seg(cx + r * 0.42, cy + r * 0.25, cx + r * 0.32, cy - r * 0.35, t, col); painter.seg(cx - r * 0.32, cy - r * 0.35, cx + r * 0.32, cy - r * 0.35, t, col); return 0; }
        if (name == "image") { painter.ring(cx, cy, r * 0.7, t * 0.7, col); painter.disc(cx + r * 0.28, cy - r * 0.28, r * 0.16, col); painter.seg(cx - r * 0.55, cy + r * 0.45, cx - r * 0.1, cy - r * 0.05, t, col); painter.seg(cx - r * 0.1, cy - r * 0.05, cx + r * 0.55, cy + r * 0.45, t, col); return 0; }
        if (name == "chart") { painter.seg(cx - r * 0.6, cy + r * 0.55, cx - r * 0.6, cy + r * 0.05, t, col); painter.seg(cx - r * 0.15, cy + r * 0.55, cx - r * 0.15, cy - r * 0.3, t, col); painter.seg(cx + r * 0.3, cy + r * 0.55, cx + r * 0.3, cy - r * 0.55, t, col); painter.seg(cx - r * 0.75, cy + r * 0.6, cx + r * 0.65, cy + r * 0.6, t * 0.7, col); return 0; }
        painter.disc(cx, cy, r * 0.5, col);
        return 0;
    }
    drawNode(painter, p, cx, cy, r, col) {
        if (has(p, "svg")) { let vb = 24.0; if (has(p, "viewBox")) { vb = p.viewBox; } this.iconSvg(painter, p.svg, cx, cy, r, r * 0.16, col, vb); return 0; }
        this.draw(painter, p.icon, cx, cy, r, col); return 0;
    }
    flatC(p0, p1, p2, p3, steps, out) {
        for (let i = 1; i <= steps; i++) {
            let t = num(i) / steps; let u = 1.0 - t;
            let x = u * u * u * p0[0] + 3.0 * u * u * t * p1[0] + 3.0 * u * t * t * p2[0] + t * t * t * p3[0];
            let y = u * u * u * p0[1] + 3.0 * u * u * t * p1[1] + 3.0 * u * t * t * p2[1] + t * t * t * p3[1];
            push(out, [x, y]);
        }
    }
    flatQ(p0, p1, p2, steps, out) {
        for (let i = 1; i <= steps; i++) {
            let t = num(i) / steps; let u = 1.0 - t;
            let x = u * u * p0[0] + 2.0 * u * t * p1[0] + t * t * p2[0];
            let y = u * u * p0[1] + 2.0 * u * t * p1[1] + t * t * p2[1];
            push(out, [x, y]);
        }
    }
    svgTok(d) {
        let toks = []; let numStr = ""; let n = len(d);
        for (let i = 0; i < n; i++) {
            let c = charAt(d, i);
            let isNum = 0.0;
            if (has(SVG_DIGITS, c)) { isNum = 1.0; }
            if (c == ".") { isNum = 1.0; }
            if (c == "e") { isNum = 1.0; }
            if (c == "E") { isNum = 1.0; }
            if (isNum > 0.5) { numStr = concat(numStr, c); }
            else {
                if (c == "-") {
                    let afterE = 0.0;
                    if (len(numStr) > 0) { let lc = charAt(numStr, len(numStr) - 1.0); if (lc == "e") { afterE = 1.0; } if (lc == "E") { afterE = 1.0; } }
                    if (afterE > 0.5) { numStr = concat(numStr, c); }
                    else { if (len(numStr) > 0) { push(toks, numStr); } numStr = "-"; }
                } else {
                    if (len(numStr) > 0) { push(toks, numStr); numStr = ""; }
                    if (c == "+") { numStr = ""; }
                    else {
                        let sep = 0.0;
                        if (c == " ") { sep = 1.0; } if (c == ",") { sep = 1.0; }
                        if (c == "\n") { sep = 1.0; } if (c == "\t") { sep = 1.0; } if (c == "\r") { sep = 1.0; }
                        if (sep < 0.5) { push(toks, c); }
                    }
                }
            }
        }
        if (len(numStr) > 0) { push(toks, numStr); }
        return toks;
    }
    svgPolys(d) {
        let toks = this.svgTok(d); let nt = len(toks);
        let polys = []; let cur = [];
        let px = 0.0; let py = 0.0; let sx = 0.0; let sy = 0.0;
        let cmd = ""; let rel = 0.0; let i = 0;
        for (let g = 0; g <= nt; g++) {
            if (i >= nt) { g = nt + 1; }
            else {
                let tk = toks[i];
                if (has(SVG_PATHCMD, tk)) { cmd = upper(tk); rel = 0.0; if (sel(tk, cmd) < 0.5) { rel = 1.0; } i = i + 1; }
                if (cmd == "M") {
                    let x = num(toks[i]); let y = num(toks[i + 1]); i = i + 2;
                    if (rel > 0.5) { x = px + x; y = py + y; }
                    if (len(cur) > 0) { push(polys, cur); }
                    cur = []; push(cur, [x, y]); px = x; py = y; sx = x; sy = y;
                    cmd = "L";
                } else { if (cmd == "L") {
                    let x = num(toks[i]); let y = num(toks[i + 1]); i = i + 2;
                    if (rel > 0.5) { x = px + x; y = py + y; }
                    push(cur, [x, y]); px = x; py = y;
                } else { if (cmd == "H") {
                    let x = num(toks[i]); i = i + 1; if (rel > 0.5) { x = px + x; }
                    push(cur, [x, py]); px = x;
                } else { if (cmd == "V") {
                    let y = num(toks[i]); i = i + 1; if (rel > 0.5) { y = py + y; }
                    push(cur, [px, y]); py = y;
                } else { if (cmd == "C") {
                    let x1 = num(toks[i]); let y1 = num(toks[i + 1]); let x2 = num(toks[i + 2]);
                    let y2 = num(toks[i + 3]); let x = num(toks[i + 4]); let y = num(toks[i + 5]); i = i + 6;
                    if (rel > 0.5) { x1 = px + x1; y1 = py + y1; x2 = px + x2; y2 = py + y2; x = px + x; y = py + y; }
                    this.flatC([px, py], [x1, y1], [x2, y2], [x, y], 12, cur); px = x; py = y;
                } else { if (cmd == "Q") {
                    let x1 = num(toks[i]); let y1 = num(toks[i + 1]); let x = num(toks[i + 2]); let y = num(toks[i + 3]); i = i + 4;
                    if (rel > 0.5) { x1 = px + x1; y1 = py + y1; x = px + x; y = py + y; }
                    this.flatQ([px, py], [x1, y1], [x, y], 12, cur); px = x; py = y;
                } else { if (cmd == "Z") {
                    push(cur, [sx, sy]); px = sx; py = sy;
                    if (len(cur) > 0) { push(polys, cur); } cur = [];
                } else {
                    i = i + 1;
                } } } } } } }
            }
        }
        if (len(cur) > 0) { push(polys, cur); }
        return polys;
    }
    iconSvg(painter, d, cx, cy, r, t, col, vb) {
        let polys = this.svgPolys(d); let sc = (2.0 * r) / vb; let ox = cx - r; let oy = cy - r;
        for (let p = 0; p < len(polys); p++) {
            let poly = polys[p];
            for (let i = 0; i < len(poly) - 1; i++) { let a = poly[i]; let b = poly[i + 1]; painter.seg(ox + a[0] * sc, oy + a[1] * sc, ox + b[0] * sc, oy + b[1] * sc, t, col); }
        }
    }
}

// --------------------------------------------------------- AnimationClock -----
// Eased 0..1 values toward `target`, decaying press layers, and the key→
// subscriber map so the frame clock repaints only the components still moving.
class AnimationClock {
    constructor() { this.anim = {}; this.target = {}; this.press = {}; this.keySubs = {}; this.paintingComp = 0; }
    ease(key, target) {
        this.keySubs[key] = this.paintingComp;
        this.target[key] = target;
        if (has(this.anim, key)) { return this.anim[key]; }
        this.anim[key] = target; return target;
    }
    pressVal(id) { this.keySubs[id] = this.paintingComp; if (has(this.press, id)) { return this.press[id]; } return 0.0; }
    pressDown(id) { this.press[id] = 1.0; }
    markDirty(dirty, key) {
        if (has(this.keySubs, key)) {
            let c = this.keySubs[key];
            let mk = 0.0; if (has(c, "_dirtyFlag")) { mk = c._dirtyFlag; }
            if (mk != 1.0) { c._dirtyFlag = 1.0; push(dirty, c); }
        }
    }
    advance(dirty) {
        let ks = keys(this.anim);
        for (let i = 0; i < len(ks); i++) {
            let k = ks[i]; let nv = this.anim[k] + (this.target[k] - this.anim[k]) * 0.25;
            if (abs(nv - this.anim[k]) > 0.0005) { this.markDirty(dirty, k); }
            this.anim[k] = nv;
        }
        let ps = keys(this.press);
        for (let i = 0; i < len(ps); i++) {
            let k = ps[i]; let np = this.press[k] * 0.85;
            if (np < 0.002) { np = 0.0; }
            if (np != this.press[k]) { this.markDirty(dirty, k); }
            this.press[k] = np;
        }
    }
}
