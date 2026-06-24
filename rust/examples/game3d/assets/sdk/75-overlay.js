// Elpa Game3D — the 2D HUD overlay (floating, draggable panels).
//
// A lightweight in-engine UI layer drawn *on top of* the 3D scene: a set of
// floating "window" panels (a title bar plus a body of labels, gauges and
// buttons) that the player can drag around — by the title bar — with a mouse or
// a finger. It is the 2D analog of the 3D renderer: it walks the panel list once
// per frame, builds a flat triangle soup of coloured quads in screen space and
// hands the engine a second, depth-less, alpha-blended render pass that `load`s
// (preserves) the 3D image and composites the HUD over it.
//
// Everything is screen-space and resolution-independent: panels are positioned
// and sized in **logical** pixels (the CSS/layout space, the same units pointer
// events arrive in), so the HUD is crisp and correctly sized on a 4K desktop and
// a high-DPI phone alike, and touch targets stay finger-friendly. Text is a
// compact 3×5 bitmap font rasterised as little quads — no font atlas, no host
// glyph calls — which keeps the overlay self-contained.
//
// The pass is given no `id`, so it re-records every frame the surface repaints
// (exactly when the 3D scene or a panel changed); when nothing moves, its vertex
// buffer is byte-identical and the engine's content cache skips the whole frame.
//
// Geometry is cached *per panel*, in two levels, so an interaction only pays for
// the panel it touches. Each panel keeps its vertex soup in panel-local pixels,
// re-tessellated only when its content changes (a cheap content fingerprint), and
// the screen-space projection of that soup, rebuilt only when the panel moves or
// the surface resizes. Each panel is its own vertex buffer + draw. So a static HUD
// over a rotating scene costs only the fingerprints; dragging a window re-projects
// just that one panel (pure arithmetic, no re-tessellation); a gauge tick
// re-tessellates only its own panel. (The bitmap font also run-length-merges
// adjacent lit cells per row to keep each soup small.)

// The 2D overlay shader: a pass-through clip-space position with a per-vertex
// RGBA colour, alpha-blended over the scene. Positions arrive already in NDC
// (the CPU maps logical pixels → clip space), so the vertex stage is trivial.
let UI_WGSL = "
struct VSOut {
    @builtin(position) clip : vec4<f32>,
    @location(0) color : vec4<f32>,
};
@vertex
fn vs(@location(0) pos : vec2<f32>, @location(1) color : vec4<f32>) -> VSOut {
    var o : VSOut;
    o.clip = vec4<f32>(pos, 0.0, 1.0);
    o.color = color;
    return o;
}
@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
    return in.color;
}
";

// ----------------------------------------------------------------- the font ---
// A 3-wide × 5-tall bitmap font: each glyph is a 15-character row-major string of
// "1" (ink) / "0" (gap). Uppercase letters, digits and a little punctuation —
// enough for a HUD. Unknown characters render as blank (a space-sized advance).
function buildUIFont() {
    let f = {};
    f["A"] = "010101111101101"; f["B"] = "110101110101110"; f["C"] = "011100100100011";
    f["D"] = "110101101101110"; f["E"] = "111100110100111"; f["F"] = "111100110100100";
    f["G"] = "011100101101011"; f["H"] = "101101111101101"; f["I"] = "111010010010111";
    f["J"] = "001001001101010"; f["K"] = "101110100110101"; f["L"] = "100100100100111";
    f["M"] = "101111111101101"; f["N"] = "101111111111101"; f["O"] = "010101101101010";
    f["P"] = "110101110100100"; f["Q"] = "010101101110011"; f["R"] = "110101110110101";
    f["S"] = "011100010001110"; f["T"] = "111010010010010"; f["U"] = "101101101101111";
    f["V"] = "101101101101010"; f["W"] = "101101111111101"; f["X"] = "101101010101101";
    f["Y"] = "101101010010010"; f["Z"] = "111001010100111";
    f["0"] = "111101101101111"; f["1"] = "010110010010111"; f["2"] = "111001111100111";
    f["3"] = "111001111001111"; f["4"] = "101101111001001"; f["5"] = "111100111001111";
    f["6"] = "111100111101111"; f["7"] = "111001010100100"; f["8"] = "111101111101111";
    f["9"] = "111101111001111";
    f[" "] = "000000000000000"; f["."] = "000000000000010"; f[":"] = "000010000010000";
    f["-"] = "000000111000000"; f["+"] = "000010111010000"; f["/"] = "001001010100100";
    f["%"] = "101001010100101"; f["!"] = "010010010000010"; f["?"] = "110001010000010";
    f["("] = "001010010010001"; f[")"] = "100010010010100"; f[","] = "000000000010100";
    f[">"] = "100010001010100"; f["<"] = "001010100010001"; f["#"] = "101111101111101";
    return f;
}
let UI_GLYPHS = buildUIFont();

// ----------------------------------------------------------- the quad builder --
// Accumulates coloured quads as a flat vertex array in pixel space — 6 floats per
// vertex (x, y, r, g, b, a), two triangles per quad. Panels draw into one of these
// in panel-local pixels; `Overlay.localToNDC` later projects it to the GPU buffer.
class UIBatch {
    constructor() { this.px = []; }      // flat: x, y (px), r, g, b, a per vertex
    vert(x, y, c) { push(this.px, x); push(this.px, y); push(this.px, c[0]); push(this.px, c[1]); push(this.px, c[2]); push(this.px, c[3]); }
    // A filled axis-aligned rectangle (top-left x,y, size w×h) in colour `c`.
    rect(x, y, w, h, c) {
        let x1 = x + w; let y1 = y + h;
        this.vert(x, y, c); this.vert(x1, y, c); this.vert(x1, y1, c);
        this.vert(x, y, c); this.vert(x1, y1, c); this.vert(x, y1, c);
    }
    // A 1-quad-per-edge hollow border of thickness `t`.
    border(x, y, w, h, t, c) {
        this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c);
        this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c);
    }
    // Proportional width of `str` at pixel-cell size `s` (4 cells / glyph: 3 + gap).
    textWidth(str, s) { return len(str) * 4.0 * s; }
    // Lay `str` out from the bitmap font with its top-left at (x, y); each "on"
    // cell becomes an `s`×`s` quad, with consecutive lit cells in a row merged
    // into a single quad (run-length) to keep the vertex count down. Returns the
    // advanced x (for chaining).
    text(str, x, y, s, c) {
        let up = upper(str); let n = len(up); let cx = x;
        for (let i = 0; i < n; i++) {
            let ch = charAt(up, i); let g = UI_GLYPHS[" "];
            if (has(UI_GLYPHS, ch)) { g = UI_GLYPHS[ch]; }
            for (let r = 0; r < 5; r++) {
                let run = 0; let start = 0;
                for (let col = 0; col < 3; col++) {
                    if (charAt(g, r * 3 + col) == "1") {
                        if (run < 0.5) { run = 1.0; start = col; } else { run = run + 1.0; }
                    } else {
                        if (run > 0.5) { this.rect(cx + start * s, y + r * s, run * s, s, c); run = 0; }
                    }
                }
                if (run > 0.5) { this.rect(cx + start * s, y + r * s, run * s, s, c); }
            }
            cx = cx + 4.0 * s;
        }
        return cx;
    }
    vertexCount() { return floor(len(this.px) / 6); }
}

// ----------------------------------------------------------------- a HUD panel --
// A floating window: a draggable title bar over a body of rows. Rows are one of
//   { type:"label", text } — static or a fn(game)->string for a live read-out;
//   { type:"bar",   label, value, color } — a labelled 0..1 gauge (value a number
//                                            or a fn(game)->number);
//   { type:"button",label, onTap } — a finger-sized tappable button.
// Positions/sizes are logical px. The body height is derived from the rows, so a
// panel sizes itself; collapsing hides the body and leaves just the title bar.
class UIPanel {
    constructor(id, x, y, w, title) {
        this.id = id; this.x = x; this.y = y; this.w = w; this.title = title;
        this.rows = [];
        this.visible = 1.0; this.collapsed = 0.0;
        this.dragging = 0.0; this.grabX = 0.0; this.grabY = 0.0;
        // Layout metrics (logical px) — finger-friendly title bar / buttons.
        this.titleH = 30.0; this.pad = 10.0; this.rowGap = 8.0;
        this.labelH = 16.0; this.barH = 12.0; this.barLabelH = 14.0; this.buttonH = 38.0;
        this.fontS = 2.0; this.titleFontS = 2.4; this.buttonFontS = 2.4;
        this.bodyH = 0.0;   // computed each build
        // Per-panel geometry cache. `local` is the panel's vertex soup in
        // panel-local pixels (origin at its top-left), tessellated only when the
        // panel's *content* changes (`localSig`); `final` is that soup translated
        // to the panel's screen position and projected to NDC, rebuilt only when
        // the panel moves or the surface resizes (`finalSig`). So dragging a panel
        // re-projects one panel; a gauge tick re-tessellates only its own panel.
        this.localSig = "?"; this.local = 0; this.localCount = 0;
        this.finalSig = "?"; this.final = 0;
    }
    label(text) { push(this.rows, { type: "label", text: text }); return this; }
    bar(lbl, value, color) { push(this.rows, { type: "bar", label: lbl, value: value, color: color }); return this; }
    button(lbl, onTap) { push(this.rows, { type: "button", label: lbl, onTap: onTap }); return this; }

    // The pixel height of a single row by kind.
    rowHeight(row) {
        if (row.type == "button") { return this.buttonH; }
        if (row.type == "bar") { return this.barLabelH + this.barH; }
        return this.labelH;
    }
    // Total body height for the current rows (0 when collapsed).
    measureBody() {
        if (this.collapsed > 0.5) { return 0.0; }
        let h = this.pad; let n = len(this.rows);
        for (let i = 0; i < n; i++) { h = h + this.rowHeight(this.rows[i]); if (i < n - 1) { h = h + this.rowGap; } }
        return h + this.pad;
    }
    totalHeight() { return this.titleH + this.measureBody(); }

    // ---- evaluation: rows may carry live fn(game) values --------------------
    rowText(row, game) {
        let t = row.text;
        if (typeOf(t) == "function") { let f = t; return str(f(game)); }
        return str(t);
    }
    barValue(row, game) {
        let v = row.value;
        if (typeOf(v) == "function") { let f = v; return clamp(num(f(game)), 0.0, 1.0); }
        return clamp(num(v), 0.0, 1.0);
    }
}

// --------------------------------------------------------------- the overlay ----
// Owns the panel stack, hit-tests pointer input (drag a title bar, tap a button),
// and builds the HUD's render pass. Later panels draw on top; tapping a panel
// brings it to the front. `theme` holds the shared colours.
class Overlay {
    constructor() {
        this.panels = [];
        this.visible = 1.0;
        this.W = 1280.0; this.H = 720.0;   // last build dims (for drag clamping)
        this.active = 0;                    // panel currently captured by a drag
        // Geometry is cached *per panel* (see `UIPanel`): each frame a panel is
        // re-tessellated only when its content changes and re-projected only when
        // it moves, so a static HUD costs ~nothing while the scene rotates, and an
        // interaction only touches the one panel it affects.
        this.theme = {
            body: [0.07, 0.09, 0.15, 0.84],
            title: [0.16, 0.40, 0.70, 0.96],
            titleIdle: [0.13, 0.20, 0.34, 0.92],
            border: [0.55, 0.72, 1.0, 0.35],
            text: [0.94, 0.97, 1.0, 1.0],
            dim: [0.66, 0.74, 0.88, 1.0],
            track: [1.0, 1.0, 1.0, 0.14],
            button: [0.20, 0.46, 0.74, 0.96],
            grip: [0.85, 0.92, 1.0, 0.85] };
    }
    addPanel(opts) {
        let id = "panel"; if (has(opts, "id")) { id = opts.id; }
        let x = 16.0; if (has(opts, "x")) { x = opts.x; }
        let y = 16.0; if (has(opts, "y")) { y = opts.y; }
        let w = 200.0; if (has(opts, "w")) { w = opts.w; }
        let title = ""; if (has(opts, "title")) { title = opts.title; }
        let p = new UIPanel(id, x, y, w, title);
        if (has(opts, "collapsed")) { p.collapsed = opts.collapsed; }
        push(this.panels, p);
        return p;
    }
    panelById(id) { for (let i = 0; i < len(this.panels); i++) { if (this.panels[i].id == id) { return this.panels[i]; } } return 0; }

    // The collapse toggle is a square button at the right end of the title bar.
    collapseRect(p) { let s = p.titleH; return { x: p.x + p.w - s, y: p.y, w: s, h: s }; }
    inRect(px, py, r) { if (px < r.x) { return 0.0; } if (py < r.y) { return 0.0; } if (px > r.x + r.w) { return 0.0; } if (py > r.y + r.h) { return 0.0; } return 1.0; }

    // Bring a panel to the top of the draw/hit stack (drawn last = on top).
    raise(idx) {
        let p = this.panels[idx]; let next = [];
        for (let i = 0; i < len(this.panels); i++) { if (i != idx) { push(next, this.panels[i]); } }
        push(next, p); this.panels = next;
    }

    // ---- input: returns 1 when the HUD consumed the event (so the camera rig
    // must ignore it — dragging a panel must not also orbit the scene). --------
    pointerDown(px, py, game) {
        if (this.visible < 0.5) { return 0.0; }
        for (let k = len(this.panels) - 1; k >= 0; k = k - 1) {
            let p = this.panels[k];
            if (p.visible > 0.5) {
                let consumed = this.hitPanel(p, k, px, py, game);
                if (consumed > 0.5) { return 1.0; }
            }
        }
        return 0.0;
    }
    hitPanel(p, k, px, py, game) {
        let title = { x: p.x, y: p.y, w: p.w, h: p.titleH };
        if (this.inRect(px, py, title) > 0.5) {
            this.raise(k);
            if (this.inRect(px, py, this.collapseRect(p)) > 0.5) {
                if (p.collapsed > 0.5) { p.collapsed = 0.0; } else { p.collapsed = 1.0; }
            } else {
                p.dragging = 1.0; p.grabX = px - p.x; p.grabY = py - p.y; this.active = p;
            }
            return 1.0;
        }
        if (p.collapsed < 0.5) {
            let body = { x: p.x, y: p.y + p.titleH, w: p.w, h: p.bodyH };
            if (this.inRect(px, py, body) > 0.5) {
                this.raise(k); this.tapRows(p, px, py, game); return 1.0;
            }
        }
        return 0.0;
    }
    // Fire the first button whose laid-out rect contains the point.
    tapRows(p, px, py, game) {
        let n = len(p.rows);
        for (let i = 0; i < n; i++) {
            let row = p.rows[i];
            if (row.type == "button") {
                if (has(row, "rx")) {
                    // Button rects are stored panel-local; add the live position.
                    let r = { x: p.x + row.rx, y: p.y + row.ry, w: row.rw, h: row.rh };
                    if (this.inRect(px, py, r) > 0.5) { let f = row.onTap; if (f != 0) { f(game); } return 0; }
                }
            }
        }
        return 0;
    }
    pointerMove(px, py) {
        if (this.active == 0) { return 0.0; }
        let p = this.active;
        if (p.dragging > 0.5) {
            let nx = px - p.grabX; let ny = py - p.grabY;
            p.x = clamp(nx, 4.0, this.W - p.w - 4.0);
            p.y = clamp(ny, 4.0, this.H - p.titleH - 4.0);
            return 1.0;
        }
        return 0.0;
    }
    pointerUp() {
        let captured = 0.0;
        if (this.active != 0) { this.active.dragging = 0.0; this.active = 0; captured = 1.0; }
        return captured;
    }

    // A cheap fingerprint of one panel's *content* (everything that shapes its
    // local geometry, but not where it sits): its width, collapse/drag state, and
    // the resolved content of each row. Dynamic `fn(game)` values are evaluated
    // here, once, and stashed on the row for the paint pass. When this is unchanged
    // the panel's tessellated geometry is reused verbatim.
    panelContentSig(game, p) {
        let parts = [];
        push(parts, p.title); push(parts, str(floor(p.w)));
        push(parts, str(floor(p.collapsed))); push(parts, str(floor(p.dragging)));
        if (p.collapsed < 0.5) {
            for (let r = 0; r < len(p.rows); r++) {
                let row = p.rows[r];
                if (row.type == "label") { row.rtext = p.rowText(row, game); push(parts, row.rtext); }
                else if (row.type == "bar") { row.rval = p.barValue(row, game); push(parts, concat(row.label, str(floor(row.rval * 1000.0)))); }
                else if (row.type == "button") { push(parts, row.label); }
            }
        }
        return join(parts, "|");
    }

    // Project a panel's local-pixel vertex soup (stride 6: x,y,r,g,b,a) to a
    // clip-space buffer at screen offset (ox,oy). Pure arithmetic per vertex — no
    // re-tessellation — so re-placing a dragged panel is cheap.
    localToNDC(local, ox, oy, w, h) {
        let out = []; let n = len(local);
        for (let i = 0; i < n; i = i + 6) {
            push(out, (local[i] + ox) / w * 2.0 - 1.0);
            push(out, 1.0 - (local[i + 1] + oy) / h * 2.0);
            push(out, local[i + 2]); push(out, local[i + 3]); push(out, local[i + 4]); push(out, local[i + 5]);
        }
        return out;
    }

    // ---- build the HUD render pass ------------------------------------------
    // Returns { resources, pass } to splice into the frame the 3D renderer submits,
    // or 0 when there is nothing to draw. Each panel is its own vertex buffer +
    // draw, so an interaction only re-uploads the panel it touched.
    build(game, w, h, colorFormat) {
        this.W = w; this.H = h;
        if (this.visible < 0.5) { return 0; }

        let res = [
            { kind: "shader", id: "g3d.ui.shader", wgsl: UI_WGSL },
            this.pipelineDesc(colorFormat)];
        let cmds = [{ cmd: "setPipeline", pipeline: "g3d.ui.pipe" }];
        let drew = 0.0;
        for (let i = 0; i < len(this.panels); i++) {
            let p = this.panels[i];
            if (p.visible > 0.5) {
                // Keep the panel on-screen (a desktop layout must not strand a
                // window off a small phone), then refresh its two cache levels.
                p.x = clamp(p.x, 4.0, max(4.0, w - p.w - 4.0));
                p.y = clamp(p.y, 4.0, max(4.0, h - p.titleH - 4.0));

                let csig = this.panelContentSig(game, p);
                if (csig != p.localSig) {
                    let b = new UIBatch(); this.drawPanelLocal(b, p);
                    p.local = b.px; p.localCount = b.vertexCount(); p.localSig = csig;
                    p.finalSig = "?";   // content changed → re-project too
                }
                let fsig = concat(concat(concat(concat(concat(csig, "@"),
                    str(floor(p.x))), ","), str(floor(p.y))),
                    concat(concat(concat(":", str(floor(w))), "x"), str(floor(h))));
                if (fsig != p.finalSig) { p.final = this.localToNDC(p.local, p.x, p.y, w, h); p.finalSig = fsig; }

                if (p.localCount > 0) {
                    let bufId = concat("g3d.ui.vbo.", p.id);
                    push(res, { kind: "buffer", id: bufId, size: len(p.final) * 4, usage: ["VERTEX"], data_f32: p.final });
                    push(cmds, { cmd: "setVertexBuffer", slot: 0, buffer: bufId, offset: 0 });
                    push(cmds, { cmd: "draw", vertex_count: p.localCount, instance_count: 1, first_vertex: 0, first_instance: 0 });
                    drew = 1.0;
                }
            }
        }
        if (drew < 0.5) { return 0; }

        // No `id`: a HUD pass re-records whenever the surface repaints, and the
        // engine still skips it when every panel's bytes are unchanged.
        let pass = { op: "renderPass",
            color_attachments: [{ view: { kind: "surface" }, load: "load", store: true }],
            commands: cmds };
        return { resources: res, pass: pass };
    }
    // The created-once 2D pipeline: a vec2 position + vec4 colour stream, no depth,
    // standard straight-alpha blending over the scene. Auto pipeline layout (no
    // bind groups — the CPU bakes everything into the vertex stream).
    pipelineDesc(colorFormat) {
        let attrs = [
            { format: "float32x2", offset: 0, shader_location: 0 },
            { format: "float32x4", offset: 8, shader_location: 1 }];
        let vbl = { array_stride: 24, step_mode: "vertex", attributes: attrs };
        let blend = {
            color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
            alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } };
        return { kind: "renderPipeline", id: "g3d.ui.pipe",
            vertex: { module: "g3d.ui.shader", entry_point: "vs", buffers: [vbl] },
            fragment: { module: "g3d.ui.shader", entry_point: "fs", targets: [{ format: colorFormat, blend: blend }] },
            primitive: { topology: "triangle-list", front_face: "ccw", cull_mode: "none" } };
    }

    // ---- paint one panel into the batch, in panel-local pixels --------------
    // Everything is laid out with the panel's top-left at (0,0); `build` projects
    // the result to the panel's screen position. Button hit-rects are likewise
    // stored panel-local (`tapRows` adds the live offset), so they survive drags.
    drawPanelLocal(b, p) {
        let th = this.theme;
        p.bodyH = p.measureBody();
        let total = p.titleH + p.bodyH;
        // Body + title bar + frame.
        if (p.collapsed < 0.5) { b.rect(0.0, p.titleH, p.w, p.bodyH, th.body); }
        let titleCol = th.titleIdle; if (p.dragging > 0.5) { titleCol = th.title; }
        b.rect(0.0, 0.0, p.w, p.titleH, titleCol);
        b.border(0.0, 0.0, p.w, total, 1.2, th.border);
        // Title text (left padded, vertically centred).
        let tFs = p.titleFontS; let tY = (p.titleH - 5.0 * tFs) / 2.0;
        b.text(p.title, p.pad, tY, tFs, th.text);
        // Collapse grip: a "-" when open, "+" when collapsed (right of the bar).
        let cgx = p.w - p.titleH;
        let sign = "-"; if (p.collapsed > 0.5) { sign = "+"; }
        b.text(sign, cgx + (p.titleH - 3.0 * tFs) / 2.0, (p.titleH - 5.0 * tFs) / 2.0, tFs, th.grip);
        if (p.collapsed > 0.5) { return 0; }
        // Body rows.
        let cy = p.titleH + p.pad; let n = len(p.rows);
        for (let i = 0; i < n; i++) {
            let row = p.rows[i]; let rh = p.rowHeight(row);
            this.drawRow(b, p, row, p.pad, cy, p.w - p.pad * 2.0, rh);
            cy = cy + rh + p.rowGap;
        }
        return 0;
    }
    drawRow(b, p, row, x, y, w, h) {
        let th = this.theme;
        // Dynamic values were resolved in `panelContentSig` and stashed on the row,
        // so the paint pass never re-evaluates the `fn(game)` callbacks.
        if (row.type == "label") {
            b.text(row.rtext, x, y + (h - 5.0 * p.fontS) / 2.0, p.fontS, th.text);
            return 0;
        }
        if (row.type == "bar") {
            b.text(row.label, x, y, p.fontS, th.dim);
            let vt = concat(str(floor(row.rval * 100.0)), "%"); let vw = b.textWidth(vt, p.fontS);
            b.text(vt, x + w - vw, y, p.fontS, th.text);
            let by = y + p.barLabelH;
            b.rect(x, by, w, p.barH, th.track);
            let col = th.button; if (has(row, "color")) { col = row.color; }
            b.rect(x, by, w * row.rval, p.barH, col);
            return 0;
        }
        if (row.type == "button") {
            // Remember the laid-out rect so taps can be hit-tested next event.
            row.rx = x; row.ry = y; row.rw = w; row.rh = h;
            b.rect(x, y, w, h, th.button);
            b.border(x, y, w, h, 1.0, th.border);
            let fs = p.buttonFontS; let tw = b.textWidth(row.label, fs);
            b.text(row.label, x + (w - tw) / 2.0, y + (h - 5.0 * fs) / 2.0, fs, th.text);
            return 0;
        }
        return 0;
    }
}
