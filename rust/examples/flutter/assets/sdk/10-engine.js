// Elpa Flutter — the raster backend (Flutter's Skia / CanvasKit analog).
//
// `Painter` is the backend the dart:ui `Canvas` (20-ui) lowers onto: it owns the
// affine transform / opacity stack and records a **Vello scene** — a batch of
// high-level vector ops (fills / strokes / clip layers) the host rasterizes with
// Vello. `FontEngine` lays text out as vector glyph strokes. `Ticker` is the
// eased-value clock the scheduler advances for implicit animations. Nothing above
// this layer touches the draw pipe directly — they go through the Canvas, here.

// A float32 buffer resource descriptor.
function bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }

// --------------------------------------------------------------- Painter ------
// The raster backend the dart:ui `Canvas` (20-ui) lowers onto. It no longer emits
// SDF instances for one wgpu pipeline — it records a **Vello scene**: a batch of
// high-level vector ops (`fill` / `stroke` / `pushLayer` / `popLayer`) the host
// rasterizes with Vello. The public method surface is unchanged (rrect / circle /
// ring / line / shadow / glyph / setClip / save / restore / translate / scale /
// rotate / setAlpha), so every layer above — rendering, widgets, Material — paints
// exactly as before; only the lowering changed.
//
// It holds a Canvas-style affine transform `m` = [a,b,c,d,e,f] (world = M·local)
// and an opacity multiplier; each op carries `m` as its Vello transform, so a
// Transform / Opacity render object is still just a matrix concat / alpha multiply.
// A clip (ClipRect/RRect/Oval, scroll viewport) becomes a Vello `pushLayer`, popped
// when the matching `save`/`restore` scope unwinds.
class Painter {
    constructor() { this.out = []; this.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; this.alpha = 1.0; this.stack = []; this.openLayers = 0; }
    reset(out) { this.out = out; this.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; this.alpha = 1.0; this.stack = []; this.openLayers = 0; }
    // Pop any clip layers still open at frame end (defensive: keeps push/pop
    // balanced even if some caller clipped outside a save/restore scope).
    finish() { while (this.openLayers > 0) { push(this.out, { op: "popLayer" }); this.openLayers = this.openLayers - 1; } }

    // ---- transform / opacity / clip stack ----------------------------------
    save() { push(this.stack, [this.m[0], this.m[1], this.m[2], this.m[3], this.m[4], this.m[5], this.alpha, this.openLayers]); }
    restore() {
        if (len(this.stack) <= 0) { return 0; }
        let s = pop(this.stack); let mark = s[7];
        // Close every clip layer opened since the matching save (nested clips pop
        // in order), then restore the transform + opacity.
        while (this.openLayers > mark) { push(this.out, { op: "popLayer" }); this.openLayers = this.openLayers - 1; }
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
    // Map a local point through the transform (kept for callers that need it).
    xpt(x, y) { let m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    // An rgba array → a Vello Color object, with the active opacity folded in.
    xcol(c) { return { r: c[0], g: c[1], b: c[2], a: c[3] * this.alpha }; }
    _solid(col) { return { brush: "solid", color: col }; }

    // The Vello transform for a primitive centred at (cx,cy) with optional rotation,
    // so its path can be authored centred at the origin (world = m · T(cx,cy) · R(rot)).
    _xform(cx, cy, rot) {
        let m = this.m;
        if (rot == 0.0) { return [m[0], m[1], m[2], m[3], m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]]; }
        let co = cos(rot); let si = sin(rot);
        return [m[0] * co + m[2] * si, m[1] * co + m[3] * si, m[0] * (-si) + m[2] * co, m[1] * (-si) + m[3] * co,
            m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]];
    }
    // A rounded-rect path centred at the origin (a plain rect when r ≤ 0).
    _rrectPath(hw, hh, r) {
        let rr = r; let mx = min(hw, hh); if (rr > mx) { rr = mx; }
        if (rr <= 0.0) { return { shape: "rect", x: 0.0 - hw, y: 0.0 - hh, w: 2.0 * hw, h: 2.0 * hh }; }
        return { shape: "roundRect", x: 0.0 - hw, y: 0.0 - hh, w: 2.0 * hw, h: 2.0 * hh, radius: rr };
    }

    // A rounded rect in local coords: centre, half-size, radius, border, rotation,
    // fill rgba, border rgba. Fills when `fill` is opaque-ish; strokes when a
    // border width + colour is given. (CLEAR fill/border are skipped.)
    rrect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
        let xf = this._xform(cx, cy, rot); let path = this._rrectPath(hw, hh, r);
        if (fill[3] > 0.0) { if (this.alpha > 0.0) {
            push(this.out, { op: "fill", transform: xf, brush: this._solid(this.xcol(fill)), path: path });
        } }
        if (border > 0.0) { if (bcol[3] > 0.0) {
            push(this.out, { op: "stroke", style: { width: border }, transform: xf, brush: this._solid(this.xcol(bcol)), path: path });
        } }
    }
    // Compatibility shim: the old screen-space variant. The transform now handles
    // the world mapping, so this is identical to `rrect`.
    raw(cx, cy, hw, hh, r, border, rot, fill, bcol) { this.rrect(cx, cy, hw, hh, r, border, rot, fill, bcol); }
    // A soft drop shadow (BoxShadow): a grown, offset, low-alpha rounded-rect fill
    // composited under the content. (`blur` softens the alpha; Vello blends it.)
    shadow(cx, cy, hw, hh, r, grow, dx, dy, blur, col) {
        let soft = 0.5; if (blur > 0.0) { soft = 0.5 / (1.0 + blur * 0.15); }
        let sc = [col[0], col[1], col[2], col[3] * soft];
        let xf = this._xform(cx + dx, cy + dy, 0.0);
        push(this.out, { op: "fill", transform: xf, brush: this._solid(this.xcol(sc)), path: this._rrectPath(hw + grow, hh + grow, r + grow) });
    }
    // Atlas-glyph quad — unused now that text renders as vector strokes (see
    // FontEngine.paintCapsules); falls back to a filled block if ever called.
    glyph(cx, cy, hw, hh, u0, v0, u1, v1, col) { this.rrect(cx, cy, hw, hh, 0.0, 0.0, 0.0, col, CLEAR); }
    // A stroked line as a rounded capsule between (ax,ay) and (bx,by).
    line(ax, ay, bx, by, thick, col) {
        let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
        this.rrect((ax + bx) / 2.0, (ay + by) / 2.0, ln / 2.0 + thick / 2.0, thick / 2.0, thick / 2.0, 0.0, atan2(dy, dx), col, CLEAR);
    }
    circle(cx, cy, r, col) { this.rrect(cx, cy, r, r, r, 0.0, 0.0, col, CLEAR); }
    ring(cx, cy, r, w, col) { this.rrect(cx, cy, r, r, r, w, 0.0, CLEAR, col); }

    // A clip becomes a Vello clip layer (`pushLayer` with a clip path); the
    // matching save/restore scope pops it. `cx,cy,hw,hh,r` are local coords.
    setClip(cx, cy, hw, hh, r) {
        push(this.out, { op: "pushLayer", transform: this._xform(cx, cy, 0.0), clip: this._rrectPath(hw, hh, r) });
        this.openLayers = this.openLayers + 1;
    }
}

// ------------------------------------------------------------ FontEngine ------
// Text laid out as vector glyph strokes (the `GLYPHS` capsule font) and emitted
// through the Painter as Vello strokes — no host atlas is loaded on the Vello
// path. Mirrors Flutter's text stack at the dart:ui level: measure (textWidth)
// and lay glyphs out onto the Canvas. (The atlas helpers below are a dormant
// fallback retained for hosts that provide a coverage atlas.)
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
