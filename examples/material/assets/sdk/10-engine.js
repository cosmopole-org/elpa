// Elpa Material — engine services.
//
// The drawing/theming/layout machinery, each a single-responsibility class the
// `Material` runtime owns and threads to widgets during measure/paint. These
// replace the old free-floating `_rect`/`_acc`/`_cell`/`_paintText…` helpers and
// their module-global state with cohesive objects:
//
//   Painter         — emits the 16-float instances (rects, shadows, glyphs,
//                     image sentinels, capsules, discs, rings) and hit regions
//                     into whatever buffer the runtime points it at.
//   Theme           — the animated M3 colour scheme (surface hierarchy, outline
//                     variants, the tonal accent palette, light/dark cross-fade).
//   Metrics         — the responsive layout coordinator: viewport, layout unit,
//                     window size class, type/density/spacing scale, safe area,
//                     and the per-node sizing helpers.
//   FontEngine      — the host glyph atlas + proportional text layout (with the
//                     stroke-vector fallback) and the app-font controls.
//   IconEngine      — the built-in vector icon set and the SVG-path stroker.
//   MediaEngine     — async network/storage images + animated video as GPU
//                     textures, and the interleaved image-draw planner.
//   AnimationClock  — eased 0..1 values and press layers, with per-key subscriber
//                     tracking so the frame clock repaints only what is moving.

// A float32 vertex/uniform buffer resource descriptor (shared by submit + media).
function bufF32(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }

// --------------------------------------------------------------- Painter ------
// Holds the three "current" output buffers (instances, taps, drags). The runtime
// re-points it at a node's buffers (`into`) before that node emits; `outInto`
// re-points only the instance stream so on-top decoration (badges, scrollbars)
// lands after children.
class Painter {
    constructor() { this.out = []; this.taps = []; this.drags = []; }
    into(out, taps, drags) { this.out = out; this.taps = taps; this.drags = drags; }
    outInto(out) { this.out = out; }
    // A rounded-rect SDF instance: center, half-size, radius, border, rotation,
    // feather (1.0), fill rgba, border rgba.
    rect(cx, cy, hw, hh, r, border, rot, fill, bcol) {
        let o = this.out;
        push(o, cx); push(o, cy); push(o, hw); push(o, hh);
        push(o, r); push(o, border); push(o, rot); push(o, 1.0);
        push(o, fill[0]); push(o, fill[1]); push(o, fill[2]); push(o, fill[3]);
        push(o, bcol[0]); push(o, bcol[1]); push(o, bcol[2]); push(o, bcol[3]);
    }
    // A soft drop shadow: a grown, dropped, heavily-feathered black rect.
    shadow(cx, cy, hw, hh, r, grow, drop, blur) {
        let o = this.out;
        push(o, cx); push(o, cy + drop); push(o, hw + grow); push(o, hh + grow);
        push(o, r + grow); push(o, 0.0); push(o, 0.0); push(o, blur);
        push(o, 0.0); push(o, 0.0); push(o, 0.0); push(o, 0.28);
        push(o, 0.0); push(o, 0.0); push(o, 0.0); push(o, 0.0);
    }
    // A textured glyph quad. b = atlas UV rect (u0,v0,u1,v1); bcol.x = 2 marks the
    // instance a glyph so the shader samples the atlas instead of the SDF.
    glyph(cx, cy, hw, hh, u0, v0, u1, v1, col) {
        let o = this.out;
        push(o, cx); push(o, cy); push(o, hw); push(o, hh);
        push(o, u0); push(o, v0); push(o, u1); push(o, v1);
        push(o, col[0]); push(o, col[1]); push(o, col[2]); push(o, col[3]);
        push(o, 2.0); push(o, 0.0); push(o, 0.0); push(o, 0.0);
    }
    // An image sentinel: a self-contained instance carrying everything needed to
    // draw the textured quad for `handle`, found and interleaved by the submitter.
    //   [0]=marker [1]=handle [2..6]=cx,cy,hw,hh,r [7..10]=u0,v0,u1,v1 [11..14]=tint
    image(handle, cx, cy, hw, hh, r, tint) {
        let o = this.out;
        push(o, IMG_MARK); push(o, num(handle)); push(o, cx); push(o, cy);
        push(o, hw); push(o, hh); push(o, r); push(o, 0.0);
        push(o, 0.0); push(o, 1.0); push(o, 1.0); push(o, tint[0]);
        push(o, tint[1]); push(o, tint[2]); push(o, tint[3]); push(o, 0.0);
    }
    // A stroked line as a rounded capsule between (ax,ay) and (bx,by), `thick` wide.
    seg(ax, ay, bx, by, thick, col) {
        let dx = bx - ax; let dy = by - ay; let ln = sqrt(dx * dx + dy * dy);
        this.rect((ax + bx) / 2.0, (ay + by) / 2.0, ln / 2.0 + thick / 2.0, thick / 2.0, thick / 2.0, 0.0, atan2(dy, dx), col, CLEAR);
    }
    disc(cx, cy, r, col) { this.rect(cx, cy, r, r, r, 0.0, 0.0, col, CLEAR); }
    ring(cx, cy, r, w, col) { this.rect(cx, cy, r, r, r, w, 0.0, CLEAR, col); }
    addTap(cx, cy, hw, hh, id, onTap) { push(this.taps, { cx: cx, cy: cy, hw: hw, hh: hh, id: id, onTap: onTap }); }
    addDrag(cx, cy, hw, hh, onChanged, left, width) {
        push(this.drags, { cx: cx, cy: cy, hw: hw, hh: hh,
            onDrag: (px) => { onChanged(clamp01((px - left) / width)); } });
    }
}

// ----------------------------------------------------------------- Theme ------
// The animated Material 3 colour scheme. `darkAnim` is the live light↔dark
// cross-fade value the runtime advances; every role mixes its light and dark tone
// by it, so a theme toggle eases the entire palette.
class Theme {
    constructor() { this.darkTarget = 0.0; this.darkAnim = 0.0; this.accent = 0; }
    set(darkTarget, accent) { this.darkTarget = darkTarget; this.accent = accent; }
    mix(l, d) { return l * (1.0 - this.darkAnim) + d * this.darkAnim; }
    bg() { return [this.mix(0.984, 0.078), this.mix(0.969, 0.071), this.mix(0.996, 0.094)]; }
    surfaceContainer(a) { return [this.mix(0.957, 0.129), this.mix(0.937, 0.122), this.mix(0.969, 0.149), a]; }
    surfaceHighest(a) { return [this.mix(0.902, 0.212), this.mix(0.878, 0.204), this.mix(0.914, 0.231), a]; }
    onSurface(a) { return [this.mix(0.114, 0.902), this.mix(0.106, 0.878), this.mix(0.125, 0.914), a]; }
    outline(a) { return [this.mix(0.475, 0.576), this.mix(0.455, 0.561), this.mix(0.494, 0.600), a]; }
    outlineVar(a) { return [this.mix(0.792, 0.286), this.mix(0.769, 0.271), this.mix(0.816, 0.310), a]; }
    accCh(i) { return ACC_LIGHT[this.accent][i] * (1.0 - this.darkAnim) + ACC_DARK[this.accent][i] * this.darkAnim; }
    acc(a) { return [this.accCh(0), this.accCh(1), this.accCh(2), a]; }
    onAcc(a) { return [this.mix(1.0, 0.118), this.mix(1.0, 0.110), this.mix(1.0, 0.137), a]; }
    mixCol(c0, c1, t) {
        return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t, c0[3] + (c1[3] - c0[3]) * t];
    }
    brighten(col, amt) { return [col[0] + amt, col[1] + amt, col[2] + amt, col[3]]; }
    // Resolve a named M3 colour role to rgba at alpha `a`.
    colorRole(name, a) {
        if (name == "primary") { return this.acc(a); }
        if (name == "onPrimary") { return this.onAcc(a); }
        if (name == "surface") { return this.surfaceContainer(a); }
        if (name == "surfaceHigh") { return this.surfaceHighest(a); }
        if (name == "outline") { return this.outline(a); }
        if (name == "outlineVar") { return this.outlineVar(a); }
        if (name == "onSurface") { return this.onSurface(a); }
        if (name == "bg") { let c = this.bg(); return [c[0], c[1], c[2], a]; }
        return this.surfaceContainer(a);
    }
    // Text ink: "accent" / "onAccent" roles, else on-surface.
    inkColor(ink) {
        if (ink == "accent") { return this.acc(1.0); }
        if (ink == "onAccent") { return this.onAcc(0.98); }
        return this.onSurface(1.0);
    }
}

// --------------------------------------------------------------- Metrics ------
// The responsive layout coordinator. Breakpoints follow Material's window size
// classes keyed off the *logical* (dp) width; the layout unit, type scale, chrome
// density and spacing are then chosen per class, so the UI adapts to the form
// factor rather than being one design scaled up and down.
class Metrics {
    constructor() {
        this.vw = 1.0; this.vh = 1.0; this.u = 1.0; this.dpr = 1.0;
        this.lw = 1.0; this.lh = 1.0; this.cls = 2;
        this.type = 1.0; this.dens = 1.0; this.sp = 1.0;
        this.saT = 0.0; this.saR = 0.0; this.saB = 0.0; this.saL = 0.0;
    }
    setMetrics(si) {
        this.vw = num(si.width); this.vh = num(si.height);
        this.dpr = 1.0; if (has(si, "scaleFactor")) { this.dpr = num(si.scaleFactor); }
        if (this.dpr < 0.1) { this.dpr = 1.0; }
        this.lw = this.vw / this.dpr; this.lh = this.vh / this.dpr;
        if (has(si, "logicalWidth")) { this.lw = num(si.logicalWidth); }
        if (has(si, "logicalHeight")) { this.lh = num(si.logicalHeight); }
        if (this.lw < 600.0) { this.cls = 0; } else { if (this.lw < 840.0) { this.cls = 1; } else { this.cls = 2; } }
        // Phones get larger text, properly-sized touch targets (≥48dp, 56–80dp
        // bars, 56dp FAB) and more generous spacing; desktop keeps the dense scale.
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
    // The layout unit (physical px): the content column (≈92 units wide) divided
    // by ~96. Compact uses nearly the full width; wider classes a centred column.
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
    // Density unit: the layout unit scaled by chrome density (taller bars, bigger
    // touch targets on phones; collapses to the plain unit on desktop).
    du() { return this.u * this.dens; }
    // Named M3 type roles, scaled by the responsive type factor.
    cell(size) {
        if (size == "headline") { return this.u * 0.82 * this.type; }
        if (size == "title") { return this.u * 0.55 * this.type; }
        if (size == "body") { return this.u * 0.42 * this.type; }
        if (size == "label") { return this.u * 0.40 * this.type; }
        if (size == "caption") { return this.u * 0.32 * this.type; }
        if (size == "micro") { return this.u * 0.26 * this.type; }
        return this.u * 0.40 * this.type;
    }
    // Resolve a Text node's cell size: explicit `px` (rendered cap height), a
    // numeric `size` in layout units, or a named role.
    cellOf(p) {
        if (has(p, "px")) { return p.px / 6.0; }
        let s = "body"; if (has(p, "size")) { s = p.size; }
        if (typeOf(s) == "number") { return this.u * s * this.type; }
        return this.cell(s);
    }
    // Resolve a Text node's stroke weight (capsule thickness): CSS-like names or a
    // numeric 100–900; default 0.92 matches the kit's prior look.
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
    // EdgeInsets-style padding in physical px: `pad` (all), `padX`/`padY` (axis),
    // or per-side `padL`/`padR`/`padT`/`padB`; missing sides 0.
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
    // Safe-area insets for a SafeArea node (physical px); per-edge opt-out flags.
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
    // Pixel→screen scale for a glyph cell: the atlas is rasterised once at a fixed
    // px size; this maps it so a glyph's on-screen size tracks the kit's rhythm.
    textScale(cell) { if (this.atlas == 0) { return cell * 0.2; } return cell * 6.6 / this.atlas.pxSize; }
    glyphMap(thick) { if (thick > 1.1) { return this.atlas.bold; } return this.atlas.regular; }
    // Proportional text width from the atlas advances (monospace estimate before
    // the atlas loads). Uses the regular weight for measurement.
    textW(str, cell) {
        if (this.atlas == 0) { return len(str) * 5.0 * cell; }
        let g = this.atlas.regular; let sc = this.textScale(cell); let w = 0.0;
        for (let i = 0; i < len(str); i++) { let ch = charAt(str, i); if (has(g, ch)) { w = w + g[ch].adv * sc; } }
        return w;
    }
    // Real text: lay glyphs out from the atlas, centred on (cx,cy). Falls back to
    // the stroke font when no atlas is available.
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
                    painter.glyph(glx + gw / 2.0, gtop + gh / 2.0, gw / 2.0, gh / 2.0,
                        gg.x / aw, gg.y / ah, (gg.x + gg.w) / aw, (gg.y + gg.h) / ah, col);
                }
                penX = penX + gg.adv * sc;
            }
        }
    }
    // Fallback stroke-font rasteriser (when no atlas). `thick` is the capsule
    // weight; `font` an optional custom stroke-glyph map.
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
                    painter.rect(cx + cell * (ax + bx) / 2.0, cy + cell * (ay + by) / 2.0,
                        cell * ln / 2.0, cell * th / 2.0, cell * th / 2.0, 0.0, atan2(dy, dx), col, CLEAR);
                }
            }
        }
    }
    // Convenience layouts (all in physical px, `cell` is the glyph scale).
    text(painter, str, cx, cy, cell, col) { this.paintCentered(painter, str, cx, cy, cell, col, 0.92, 0); }
    textLeft(painter, str, x, cy, cell, col) { this.text(painter, str, x + this.textW(str, cell) / 2.0, cy, cell, col); }
    // Truncate `str` to fit `maxW` px at `cell`, appending an ellipsis.
    ellipsize(str, cell, maxW) {
        if (maxW <= 0.0) { return ""; }
        if (this.textW(str, cell) <= maxW) { return str; }
        let ell = "..."; let ew = this.textW(ell, cell); let n = len(str); let fit = "";
        for (let i = 0; i < n; i++) {
            let next = concat(fit, charAt(str, i));
            if (this.textW(next, cell) + ew > maxW) { i = n; } else { fit = next; }
        }
        return concat(fit, ell);
    }
    textLeftClip(painter, str, x, cy, cell, col, maxW) { this.textLeft(painter, this.ellipsize(str, cell, maxW), x, cy, cell, col); }
    // Word-wrapped left-aligned paragraph within `maxW`.
    wrappedLeft(painter, str, x, y, maxW, cell, col) {
        let words = split(str, " "); let line = ""; let ly = y; let lh = 6.0 * cell + cell * 1.4;
        for (let i = 0; i < len(words); i++) {
            let w = words[i]; let trial = w; if (len(line) > 0) { trial = concat(line, concat(" ", w)); }
            if (this.textW(trial, cell) > maxW) {
                if (len(line) > 0) { this.textLeft(painter, line, x, ly, cell, col); ly = ly + lh; line = w; }
                else { this.textLeft(painter, w, x, ly, cell, col); line = ""; }
            } else { line = trial; }
        }
        if (len(line) > 0) { this.textLeft(painter, line, x, ly, cell, col); }
    }
    // Load the host-rasterised atlas (regular + bold + metrics) for the current
    // font source — the downloaded default, or an app-chosen URL/storage path.
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
    // Choose / restore the app font (the runtime triggers the repaint).
    applyFont(src, hasFont) { this.fontSrc = src; this.hasFont = hasFont; this.atlas = 0; this.atlasUp = 0.0; this.fontVer = this.fontVer + 1; }
    // The atlas texture id is versioned per font swap so a size change recreates
    // the texture (and its bind group) rather than keeping a stale view.
    atlasId() { return concat("elpa.m3.atlas.", str(this.fontVer)); }
    atlasTexRes() {
        let w = 1; let h = 1; if (this.atlas != 0) { w = this.atlas.width; h = this.atlas.height; }
        return [
            { kind: "texture", id: this.atlasId(), size: { width: w, height: h }, format: "r8unorm", usage: ["TEXTURE_BINDING", "COPY_DST"] },
            { kind: "sampler", id: "elpa.m3.samp", mag_filter: "linear", min_filter: "linear", mipmap_filter: "linear" },
        ];
    }
    // Upload the atlas pixels exactly once per font.
    atlasUploadCmds() {
        if (this.atlas == 0) { return []; }
        if (this.atlasUp > 0.5) { return []; }
        this.atlasUp = 1.0;
        return [{ op: "writeTexture", texture: this.atlasId(), origin: { x: 0, y: 0, z: 0 },
            size: { width: this.atlas.width, height: this.atlas.height }, data_b64: this.atlas.data }];
    }
}

// ------------------------------------------------------------ IconEngine ------
// The built-in vector icon set (each icon drawn from capsules/discs/rings) and a
// stroke-only SVG-path renderer: a path's outline is stroked (this kit cannot
// area-fill an arbitrary polygon — every primitive is a rounded rect). The
// grammar covers M/L/H/V/C/Q/Z (absolute + relative) with Béziers flattened.
class IconEngine {
    constructor() { this.svgIcons = {}; }
    // Register a named SVG icon usable wherever an icon name is.
    registerIcon(name, d, viewBox) { let vb = 24.0; if (viewBox != 0) { vb = viewBox; } this.svgIcons[name] = { d: d, vb: vb }; }
    // Draw a named icon inside a box of half-extent `r` at (cx,cy). A registered
    // SVG icon under this name takes precedence. Unknown names fall back to a dot.
    draw(painter, name, cx, cy, r, col) {
        let t = r * 0.18;
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
        if (name == "video") { painter.rect(cx - r * 0.15, cy, r * 0.5, r * 0.42, r * 0.14, 0.0, 0.0, CLEAR, col); painter.ring(cx - r * 0.15, cy, r * 0.5, t * 0.5, col); painter.seg(cx + r * 0.42, cy - r * 0.3, cx + r * 0.7, cy - r * 0.45, t, col); painter.seg(cx + r * 0.42, cy + r * 0.3, cx + r * 0.7, cy + r * 0.45, t, col); painter.seg(cx + r * 0.7, cy - r * 0.45, cx + r * 0.7, cy + r * 0.45, t, col); return 0; }
        painter.disc(cx, cy, r * 0.5, col);
        return 0;
    }
    // Draw an icon node honouring an inline `svg` path (stroked) or a name.
    drawNode(painter, p, cx, cy, r, col) {
        if (has(p, "svg")) {
            let vb = 24.0; if (has(p, "viewBox")) { vb = p.viewBox; }
            this.iconSvg(painter, p.svg, cx, cy, r, r * 0.18, col, vb); return 0;
        }
        this.draw(painter, p.icon, cx, cy, r, col); return 0;
    }
    // Flatten a cubic / quadratic Bézier into line points appended to `out`.
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
    // Tokenise a path `d` into command letters and numeric strings.
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
    // Parse a path into a list of polylines (each a list of [x,y] points).
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
    // Stroke a parsed path into the icon box at (cx,cy), half-extent `r`.
    iconSvg(painter, d, cx, cy, r, t, col, vb) {
        let polys = this.svgPolys(d); let sc = (2.0 * r) / vb; let ox = cx - r; let oy = cy - r;
        for (let p = 0; p < len(polys); p++) {
            let poly = polys[p];
            for (let i = 0; i < len(poly) - 1; i++) {
                let a = poly[i]; let b = poly[i + 1];
                painter.seg(ox + a[0] * sc, oy + a[1] * sc, ox + b[0] * sc, oy + b[1] * sc, t, col);
            }
        }
    }
}

// --------------------------------------------------------- AnimationClock -----
// Eased 0..1 values (`anim`) toward `target`, decaying press layers (`press`),
// and the key→subscriber map (`keySubs`) recorded as widgets paint, so the frame
// clock repaints only the components whose keys are still moving. `paintingComp`
// is set by the runtime while a component paints.
class AnimationClock {
    constructor() { this.anim = {}; this.target = {}; this.press = {}; this.keySubs = {}; this.paintingComp = 0; }
    // Reading an eased value records this subscriber and sets the target.
    ease(key, target) {
        this.keySubs[key] = this.paintingComp;
        this.target[key] = target;
        if (has(this.anim, key)) { return this.anim[key]; }
        this.anim[key] = target; return target;
    }
    // Reading a press value records this subscriber.
    pressVal(id) {
        this.keySubs[id] = this.paintingComp;
        if (has(this.press, id)) { return this.press[id]; }
        return 0.0;
    }
    pressDown(id) { this.press[id] = 1.0; }
    // Mark the component that owns `key` dirty (deduped) into `dirty`.
    markDirty(dirty, key) {
        if (has(this.keySubs, key)) {
            let c = this.keySubs[key];
            let mk = 0.0; if (has(c, "_dirtyFlag")) { mk = c._dirtyFlag; }
            if (mk != 1.0) { c._dirtyFlag = 1.0; push(dirty, c); }
        }
    }
    // Advance every eased value and press layer one step; mark still-moving keys'
    // owners dirty into `dirty`.
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

// ------------------------------------------------------------ MediaEngine -----
// Async network/storage images + animated video shown as GPU textures by the
// second pipeline. Decoded RGBA frames arrive from the host's off-thread
// `media.*` engine; a widget emits a self-contained image sentinel that the
// submitter interleaves as a textured-quad draw at the right z. Each source keeps
// a stable texture handle whose *contents* the frame clock refreshes.
class MediaEngine {
    constructor() {
        this.media = {};       // key -> load/playback state
        this.mediaRef = {};    // media keys referenced by the *visible* tree this render
        this.imgTex = {};      // handle -> { w,h,ver,up,data,lastFrameN } (texture contents)
        this.imgHandle = {};   // media key -> numeric texture handle
        this.imgHandleN = 0;   // handle allocator
        this.app = 0;          // back-ref (metrics + frameN), set by Material
    }
    handle(key) {
        if (!has(this.imgHandle, key)) { this.imgHandle[key] = this.imgHandleN; this.imgHandleN = this.imgHandleN + 1; }
        return this.imgHandle[key];
    }
    // The texture id encodes its size *and frame version*: a placeholder (1×1) →
    // real-size swap yields a new id, and every decoded frame of a video gets its
    // own id too. Re-uploading new pixels into one stable texture is not honoured
    // by every backend (a cached, already-sampled GL texture keeps showing its
    // first contents), so each frame is a fresh texture the renderer creates,
    // binds and draws — the same path the (correct) still image already uses. The
    // previous frame's texture isn't referenced, so the resource cache evicts it.
    imgTexId(handle, w, h, ver) { return concat(concat(concat(concat(concat(concat("elpa.m3.img.tex.", str(handle)), "."), str(w)), concat("x", str(h))), ".v"), str(ver)); }
    // Register a media source (idempotent) and kick off its off-thread load.
    ensure(key, src, video) {
        this.mediaRef[key] = 1.0;
        let handle = this.handle(key); let hk = str(handle);
        if (!has(this.imgTex, hk)) { this.imgTex[hk] = { w: 1, h: 1, ver: 0, up: 0.0, data: IMG_PLACEHOLDER, lastFrameN: -1 }; }
        if (!has(this.media, key)) {
            this.media[key] = { ready: 0.0, failed: 0.0, w: 1, h: 1, frames: 1, total: 0, video: video,
                handle: handle, startMs: now(), curIdx: -1 };
            let req = { id: key };
            if (has(src, "url")) { req.url = src.url; } else { if (has(src, "path")) { req.path = src.path; } }
            askHost("media.open", [req]);
        }
        return this.media[key];
    }
    pollOne(key) {
        let m = this.media[key];
        if (m.ready > 0.5) { return 0; } if (m.failed > 0.5) { return 0; }
        let p = askHost("media.poll", [{ id: key }]);
        if (isNull(p)) { return 0; }
        if (has(p, "failed")) { if (p.failed) { m.failed = 1.0; return 0; } }
        if (has(p, "ready")) { if (p.ready) {
            m.ready = 1.0; m.w = num(p.width); m.h = num(p.height);
            m.frames = num(p.frames); m.total = num(p.durationMs);
            m.curIdx = -1;
        } }
        return 0;
    }
    // Pick the current frame (stills: 0; video: advance by wall-clock while
    // playing) and stage a texture upload when it changes. Returns 1 if it did.
    advance(key, playing) {
        let m = this.media[key];
        if (m.ready < 0.5) { return 0.0; }
        let idx = 0;
        if (m.video > 0.5) { if (m.frames > 1) {
            if (playing > 0.5) {
                let per = m.total / m.frames; if (per < 1.0) { per = 60.0; }
                let elapsed = now() - m.startMs; let span = m.total; if (span < 1.0) { span = m.frames * per; }
                idx = floor((elapsed - floor(elapsed / span) * span) / per);
                if (idx >= m.frames) { idx = m.frames - 1; } if (idx < 0) { idx = 0; }
            } else { idx = m.curIdx; if (idx < 0) { idx = 0; } }
        } }
        if (idx == m.curIdx) { return 0.0; }
        let f = askHost("media.frame", [{ id: key, index: idx }]);
        if (isNull(f)) { return 0.0; }
        if (!has(f, "data")) { return 0.0; }
        m.curIdx = idx;
        let t = this.imgTex[str(m.handle)];
        t.w = num(f.width); t.h = num(f.height); t.data = f.data; t.ver = t.ver + 1; t.up = 0.0;
        return 1.0;
    }
    // Drive every registered source one tick: load the not-yet-ready ones and
    // advance the playing videos. Only on-screen sources are driven.
    tick() {
        let changed = 0.0; let ks = keys(this.media);
        for (let i = 0; i < len(ks); i++) {
            let key = ks[i]; let m = this.media[key];
            if (!has(this.mediaRef, key)) { continue; }
            this.pollOne(key);
            let playing = 1.0; if (has(m, "_playing")) { playing = m._playing; }
            if (this.advance(key, playing) > 0.5) { changed = 1.0; }
        }
        return changed;
    }
    resetRefs() { this.mediaRef = {}; }
    // A media source from a widget's props: `{ url }` (network) or `{ path }`.
    srcOf(p) {
        if (has(p, "url")) { return { key: concat("u:", p.url), req: { url: p.url } }; }
        if (has(p, "path")) { return { key: concat("p:", p.path), req: { path: p.path } }; }
        return 0;
    }
    // Ensure a source is loading and emit its quad (loaded frame or placeholder).
    drawMedia(painter, key, src, video, cx, cy, hw, hh, r, tint) {
        let m = this.ensure(key, src, video);
        painter.image(m.handle, cx, cy, hw, hh, r, tint);
        return m;
    }

    // ---- draw planning (interleaved SDF + image draws) ----------------------
    // Locate image sentinels in `inst` and emit an ordered draw plan: SDF
    // sub-ranges (drawn straight from `inst` via first_instance/instance_count,
    // so sentinel slots sit unread and cost nothing) and image draws, in paint
    // order. Returns the unique image-texture handles referenced this frame.
    planDraws(inst) {
        let n = len(inst) / 16; let draws = []; let handles = []; let seen = {};
        let runStart = 0;
        for (let i = 0; i < n; i++) {
            let base = i * 16;
            if (inst[base] == IMG_MARK) {
                if (i > runStart) { push(draws, { sdf: 1.0, first: runStart, count: i - runStart }); }
                let handle = floor(inst[base + 1] + 0.5);
                push(draws, { sdf: 0.0, handle: handle,
                    cx: inst[base + 2], cy: inst[base + 3], hw: inst[base + 4], hh: inst[base + 5], r: inst[base + 6],
                    u0: inst[base + 7], v0: inst[base + 8], u1: inst[base + 9], v1: inst[base + 10],
                    tint: [inst[base + 11], inst[base + 12], inst[base + 13], inst[base + 14]] });
                if (!has(seen, str(handle))) { seen[str(handle)] = 1.0; push(handles, handle); }
                runStart = i + 1;
            }
        }
        if (n > runStart) { push(draws, { sdf: 1.0, first: runStart, count: n - runStart }); }
        return { buf: inst, draws: draws, handles: handles };
    }
    // Declare an image handle's texture (and stage its one-time upload), deduped.
    declareImageTex(handle, res, uploads, declared) {
        let frameN = this.app.frameN;
        let t = this.imgTex[str(handle)]; let id = this.imgTexId(handle, t.w, t.h, t.ver);
        if (has(declared, id)) { return id; }
        declared[id] = 1.0;
        if (t.lastFrameN < frameN - 1) { t.up = 0.0; }
        t.lastFrameN = frameN;
        push(res, { kind: "texture", id: id, size: { width: t.w, height: t.h }, format: "rgba8unorm", usage: ["TEXTURE_BINDING", "COPY_DST"] });
        if (t.up < 0.5) {
            push(uploads, { op: "writeTexture", texture: id, origin: { x: 0, y: 0, z: 0 },
                size: { width: t.w, height: t.h }, data_b64: t.data });
            t.up = 1.0;
        }
        return id;
    }
    // Interleaved SDF/image draw commands for one plan against vertex buffer `vbuf`.
    imgDrawCmds(plan, vbuf, tag, res, uploads, declared) {
        let m = this.app.metrics;
        let pcmds = [
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
            { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: vbuf, offset: 0 },
        ];
        for (let i = 0; i < len(plan.draws); i++) {
            let d = plan.draws[i];
            if (d.sdf > 0.5) {
                push(pcmds, { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" });
                push(pcmds, { cmd: "setPipeline", pipeline: "elpa.m3.pipe" });
                push(pcmds, { cmd: "draw", vertex_count: 6, instance_count: d.count, first_vertex: 0, first_instance: d.first });
            } else {
                let texId = this.declareImageTex(d.handle, res, uploads, declared);
                let uid = concat(concat("elpa.m3.img.u.", tag), str(i)); let bid = concat(concat("elpa.m3.img.bg.", tag), str(i));
                push(res, bufF32(uid, ["UNIFORM", "COPY_DST"],
                    [m.vw, m.vh, d.cx, d.cy, d.hw, d.hh, d.r, 0.0, d.u0, d.v0, d.u1, d.v1, d.tint[0], d.tint[1], d.tint[2], d.tint[3]]));
                push(res, { kind: "bindGroup", id: bid, layout: "elpa.m3.img.bgl", entries: [
                    { binding: 0, resource: { type: "buffer", buffer: uid } },
                    { binding: 1, resource: { type: "textureView", texture: texId } },
                    { binding: 2, resource: { type: "sampler", sampler: "elpa.m3.img.samp" } } ] });
                push(pcmds, { cmd: "setPipeline", pipeline: "elpa.m3.img.pipe" });
                push(pcmds, { cmd: "setBindGroup", index: 0, bind_group: bid });
                push(pcmds, { cmd: "draw", vertex_count: 6, instance_count: 1, first_vertex: 0, first_instance: 0 });
            }
        }
        return pcmds;
    }
    // The shared image-pipeline resources (shader, layout, pipeline, sampler).
    imgPipelineResources() {
        return [
            { kind: "shader", id: "elpa.m3.img.shader", wgsl: IMG_WGSL },
            { kind: "bindGroupLayout", id: "elpa.m3.img.bgl",
              entries: [
                  { binding: 0, visibility: ["VERTEX", "FRAGMENT"], ty: "uniform" },
                  { binding: 1, visibility: ["FRAGMENT"], ty: "texture" },
                  { binding: 2, visibility: ["FRAGMENT"], ty: "sampler" }] },
            { kind: "pipelineLayout", id: "elpa.m3.img.layout", bind_group_layouts: ["elpa.m3.img.bgl"] },
            { kind: "renderPipeline", id: "elpa.m3.img.pipe", layout: "elpa.m3.img.layout",
              vertex: { module: "elpa.m3.img.shader", entry_point: "vs", buffers: [] },
              fragment: { module: "elpa.m3.img.shader", entry_point: "fs", targets: [{
                  format: "bgra8unorm",
                  blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                           alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
            { kind: "sampler", id: "elpa.m3.img.samp", mag_filter: "linear", min_filter: "linear", mipmap_filter: "linear" },
        ];
    }
    addImgPipeline(res) {
        let ip = this.imgPipelineResources();
        for (let i = 0; i < len(ip); i++) { push(res, ip[i]); }
    }
}
