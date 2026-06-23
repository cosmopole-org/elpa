// Elpa Flutter — the raster backend (Flutter's Skia / CanvasKit analog).
//
// `Painter` is the rasterizer the dart:ui `Canvas` (20-ui) lowers onto: it owns
// the affine transform / opacity stack and emits the 16-float SDF instances the
// one render pipeline draws. `FontEngine` rasterises real text from a host glyph
// atlas (with a stroke-vector fallback). `Ticker` is the eased-value clock the
// scheduler advances for implicit animations. Nothing above this layer touches
// the GPU command tree directly — they go through the Canvas, which goes here.

// A float32 buffer resource descriptor.
function bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }

// --------------------------------------------------------------- Painter ------
// The low-level rasterizer. Holds the "current" instance buffer and a Canvas-style
// affine transform [a,b,c,d,e,f] (world = M·local) with an opacity multiplier and
// a save stack. Every primitive honours the active transform/opacity, so a
// Transform / Opacity render object is just a matrix concat / alpha multiply.
class Painter {
    constructor() {
        this.out = [];
        this.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        this.alpha = 1.0;
        this.stack = [];
    }
    reset(out) { this.out = out; this.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; this.alpha = 1.0; this.stack = []; }

    // ---- transform / opacity stack -----------------------------------------
    save() {
        push(this.stack, [this.m[0], this.m[1], this.m[2], this.m[3], this.m[4], this.m[5], this.alpha]);
    }
    restore() {
        if (len(this.stack) <= 0) { return 0; }
        let s = pop(this.stack);
        this.m = [s[0], s[1], s[2], s[3], s[4], s[5]]; this.alpha = s[6];
        return 0;
    }
    translate(dx, dy) { let m = this.m; m[4] = m[4] + m[0] * dx + m[2] * dy; m[5] = m[5] + m[1] * dx + m[3] * dy; }
    scale(sx, sy) { let m = this.m; m[0] = m[0] * sx; m[1] = m[1] * sx; m[2] = m[2] * sy; m[3] = m[3] * sy; }
    rotate(t) {
        let c = cos(t); let s = sin(t); let m = this.m;
        let a0 = m[0]; let b0 = m[1]; let c0 = m[2]; let d0 = m[3];
        m[0] = a0 * c + c0 * s; m[1] = b0 * c + d0 * s; m[2] = a0 * (-s) + c0 * c; m[3] = b0 * (-s) + d0 * c;
    }
    setAlpha(a) { this.alpha = this.alpha * a; }
    // Map a local point through the transform.
    xpt(x, y) { let m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    xsx() { let m = this.m; return sqrt(m[0] * m[0] + m[1] * m[1]); }
    xsy() { let m = this.m; return sqrt(m[2] * m[2] + m[3] * m[3]); }
    xrot() { let m = this.m; return atan2(m[1], m[0]); }
    xcol(c) { return [c[0], c[1], c[2], c[3] * this.alpha]; }

    // A rounded-rect SDF instance in local coords: centre, half-size, radius,
    // border, rotation, feather, fill rgba, border rgba.
    rrect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
        let p = this.xpt(cx, cy); let sx = this.xsx(); let sy = this.xsy(); let sa = (sx + sy) * 0.5;
        this.raw(p[0], p[1], hw * sx, hh * sy, r * sa, border * sa, rot + this.xrot(), this.xcol(fill), this.xcol(bcol));
    }
    raw(cx, cy, hw, hh, r, border, rot, fill, bcol) {
        let o = this.out;
        push(o, cx); push(o, cy); push(o, hw); push(o, hh);
        push(o, r); push(o, border); push(o, rot); push(o, 1.0);
        push(o, fill[0]); push(o, fill[1]); push(o, fill[2]); push(o, fill[3]);
        push(o, bcol[0]); push(o, bcol[1]); push(o, bcol[2]); push(o, bcol[3]);
    }
    // A soft drop shadow (BoxShadow): a grown, offset, heavily-feathered rect.
    shadow(cx, cy, hw, hh, r, grow, dx, dy, blur, col) {
        let p = this.xpt(cx + dx, cy + dy); let sx = this.xsx(); let sy = this.xsy(); let sa = (sx + sy) * 0.5;
        let c = this.xcol(col);
        let o = this.out;
        push(o, p[0]); push(o, p[1]); push(o, (hw + grow) * sx); push(o, (hh + grow) * sy);
        push(o, (r + grow) * sa); push(o, 0.0); push(o, 0.0); push(o, blur * sa);
        push(o, c[0]); push(o, c[1]); push(o, c[2]); push(o, c[3]);
        push(o, 0.0); push(o, 0.0); push(o, 0.0); push(o, 0.0);
    }
    // A textured glyph quad. b carries the atlas UV rect; bcol.x = 2 flags glyph.
    glyph(cx, cy, hw, hh, u0, v0, u1, v1, col) {
        let p = this.xpt(cx, cy); let sx = this.xsx(); let sy = this.xsy();
        let c = this.xcol(col);
        let o = this.out;
        push(o, p[0]); push(o, p[1]); push(o, hw * sx); push(o, hh * sy);
        push(o, u0); push(o, v0); push(o, u1); push(o, v1);
        push(o, c[0]); push(o, c[1]); push(o, c[2]); push(o, c[3]);
        push(o, 2.0); push(o, 0.0); push(o, 0.0); push(o, 0.0);
    }
    // A stroked line as a rounded capsule between (ax,ay) and (bx,by).
    line(ax, ay, bx, by, thick, col) {
        let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
        this.rrect((ax + bx) / 2.0, (ay + by) / 2.0, ln / 2.0 + thick / 2.0, thick / 2.0, thick / 2.0, 0.0, atan2(dy, dx), col, CLEAR);
    }
    circle(cx, cy, r, col) { this.rrect(cx, cy, r, r, r, 0.0, 0.0, col, CLEAR); }
    ring(cx, cy, r, w, col) { this.rrect(cx, cy, r, r, r, w, 0.0, CLEAR, col); }
}

// ------------------------------------------------------------ FontEngine ------
// Real text from a host-rasterised coverage atlas, with the stroke-vector
// fallback when no atlas is available. Mirrors Flutter's text stack at the
// dart:ui level: measure (textWidth) and lay glyphs out onto the Canvas.
class FontEngine {
    constructor() { this.atlas = 0; this.atlasUp = 0.0; this.fontVer = 0; }
    textScale(cell) { if (this.atlas == 0) { return cell * 0.2; } return cell * 6.6 / this.atlas.pxSize; }
    glyphMap() { return this.atlas.regular; }
    // Proportional text width from the atlas advances (monospace estimate before
    // the atlas loads). `cell` is the glyph scale (cap-height-ish in px / 6).
    textW(s, cell) {
        if (this.atlas == 0) { return len(s) * 5.0 * cell; }
        let g = this.atlas.regular; let sc = this.textScale(cell); let w = 0.0;
        for (let i = 0; i < len(s); i++) { let ch = charAt(s, i); if (has(g, ch)) { w = w + g[ch].adv * sc; } }
        return w;
    }
    // Approximate line height for a glyph cell.
    lineH(cell) { if (this.atlas == 0) { return cell * 8.0; } return (this.atlas.ascent + this.atlas.descent) * this.textScale(cell) * 1.3; }
    // Lay glyphs out from the atlas with the top-left of the text box at (x,y).
    paintLeftTop(painter, s, x, y, cell, col) {
        if (this.atlas == 0) { this.paintCapsules(painter, s, x, y, cell, col); return 0; }
        let g = this.glyphMap(); let sc = this.textScale(cell);
        let aw = this.atlas.width; let ah = this.atlas.height; let n = len(s);
        let penX = x;
        let baseline = y + this.atlas.ascent * sc;
        for (let i = 0; i < n; i++) {
            let ch = charAt(s, i);
            if (has(g, ch)) {
                let gg = g[ch];
                if (gg.w > 0.0) {
                    let gw = gg.w * sc; let gh = gg.h * sc;
                    let glx = penX + gg.bx * sc;
                    let gtop = baseline - (gg.by + gg.h) * sc;
                    painter.glyph(glx + gw / 2.0, gtop + gh / 2.0, gw / 2.0, gh / 2.0,
                        gg.x / aw, gg.y / ah, (gg.x + gg.w) / aw, (gg.y + gg.h) / ah, col);
                }
                penX = penX + gg.adv * sc;
            }
        }
    }
    // Fallback stroke-font rasteriser (top-left origin at (x,y)).
    paintCapsules(painter, s, x, y, cell, col) {
        s = upper(s); let nch = len(s); let adv = 5.0; let th = 0.9;
        let scale = cell;
        for (let ci = 0; ci < nch; ci++) {
            let ch = charAt(s, ci);
            if (has(GLYPHS, ch)) {
                let segs = GLYPHS[ch];
                let gx = x + ci * adv * scale;
                for (let si = 0; si < len(segs); si++) {
                    let sg = segs[si];
                    painter.line(gx + sg[0] * scale, y + sg[1] * scale, gx + sg[2] * scale, y + sg[3] * scale, th * scale, col);
                }
            }
        }
    }
    loadAtlas() {
        let r = askHost("text.atlas", [{ size: 48.0 }]);
        if (isNull(r)) { return 0; }
        if (!has(r, "ok")) { return 0; }
        if (!r.ok) { return 0; }
        this.atlas = r; this.atlasUp = 0.0; return 0;
    }
    atlasId() { return concat("elpa.fl.atlas.", str(this.fontVer)); }
    atlasTexRes() {
        let w = 1; let h = 1; if (this.atlas != 0) { w = this.atlas.width; h = this.atlas.height; }
        return [
            { kind: "texture", id: this.atlasId(), size: { width: w, height: h }, format: "r8unorm", usage: ["TEXTURE_BINDING", "COPY_DST"] },
            { kind: "sampler", id: "elpa.fl.samp", mag_filter: "linear", min_filter: "linear", mipmap_filter: "linear" },
        ];
    }
    atlasUploadCmds() {
        if (this.atlas == 0) { return []; }
        if (this.atlasUp > 0.5) { return []; }
        this.atlasUp = 1.0;
        return [{ op: "writeTexture", texture: this.atlasId(), origin: { x: 0, y: 0, z: 0 },
            size: { width: this.atlas.width, height: this.atlas.height }, data_b64: this.atlas.data }];
    }
}

// ---------------------------------------------------------------- Ticker ------
// The eased-value clock the scheduler advances each frame for implicit
// animations (AnimatedContainer-style). A value reads toward its target; the
// binding repaints while any value is still moving. Faithful to Flutter's
// SchedulerBinding/Ticker driving the implicit-animation curves.
class Ticker {
    constructor() { this.val = {}; this.target = {}; }
    ease(key, target) {
        this.target[key] = target;
        if (has(this.val, key)) { return this.val[key]; }
        this.val[key] = target; return target;
    }
    // Advance every value one step; returns 1 if anything is still moving.
    advance() {
        let moving = 0.0; let ks = keys(this.val);
        for (let i = 0; i < len(ks); i++) {
            let k = ks[i]; let nv = this.val[k] + (this.target[k] - this.val[k]) * 0.22;
            if (abs(nv - this.target[k]) < 0.002) { nv = this.target[k]; }
            if (abs(nv - this.val[k]) > 0.0004) { moving = 1.0; }
            this.val[k] = nv;
        }
        return moving;
    }
}
