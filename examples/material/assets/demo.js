// Elpa Material Design 3 demo — the interactive app, authored in JavaScript.
//
// This is the program the GitHub Pages deployment runs. It is plain JavaScript
// compiled to the Elpian VM by Elpa's built-in front-end (no off-VM toolchain):
// `Elpa::new_from_js(backend, surface, DEMO_JS)`. It `vm.import`s the UI-kit
// module (`elpa-material.js`), lays widgets out responsively from
// `gpu.surfaceInfo`, and wires pointer / wheel / keyboard events to widget
// state — which animates and re-renders every frame.
//
// The visual language follows the Material 3 (Material You) specification, drawn
// the way Flutter's Material library renders it: a tonal color system with a
// surface-container hierarchy, full-height "pill" buttons, a rounded-square FAB,
// state layers on press/hover, elevation shadows, and an animated dark theme.
//
// Every widget is a set of rounded-rect "layers": 16 floats per instance
// (center.xy, halfSize.xy, cornerRadius, borderWidth, rotation, feather, then
// fill rgba + border rgba) fed to the kit's shared SDF pipeline.

// Pull in the UI kit; this registers elpa.m3.{card,appBar,filledButton,...}.
askHost("vm.import", ["assets/elpa-material.js"]);

// ---------------------------------------------------------------- state -------
let n = 0;                 // frame counter
let dark = 0.0;            // target theme (0 light, 1 dark)
let darkAnim = 0.0;        // eased theme
let swOn = 0.0;   let swAnim = 0.0;     // switch
let ck = 0.0;     let ckAnim = 0.0;     // checkbox
let chip = 0.0;   let chipAnim = 0.0;   // filter chip
let radio = 0.0;                        // selected radio index (0..2)
let r0Anim = 1.0; let r1Anim = 0.0; let r2Anim = 0.0;
let sliderVal = 0.5; let dragging = 0.0;
let accent = 0;                         // index into the tonal palette
let hx = -1000.0; let hy = -1000.0;     // last hover position
let pressFilled = 0.0; let pressOutlined = 0.0; let pressFab = 0.0;
let keyGlow = 0.0;
let vw = 1.0; let vh = 1.0;             // viewport in physical px
let L = 0;                              // layout object (filled by layout())
let txt = [];                           // cached caption capsule instances
let txtDark = -1.0; let txtAccent = -1; // cache-invalidation keys
let LABEL_CAP = 256;                    // labels instance-buffer capacity
let TRANSPARENT = [0.0, 0.0, 0.0, 0.0];

// M3 tonal accent palette the FAB cycles through. Each entry is the primary
// tone for light and (a lighter) dark scheme: purple (the M3 default), teal,
// green, pink — the same hues Flutter's ColorScheme.fromSeed produces.
let accLight = [
    [0.404, 0.314, 0.643],
    [0.000, 0.416, 0.416],
    [0.220, 0.416, 0.125],
    [0.596, 0.251, 0.380],
];
let accDark = [
    [0.816, 0.737, 1.000],
    [0.306, 0.847, 0.859],
    [0.616, 0.839, 0.490],
    [1.000, 0.694, 0.784],
];

// A vector stroke font: each glyph is line segments [x0,y0,x1,y1] in a 4-wide ×
// 6-tall box (origin top-left, y down). Rendered as rounded capsules whose ends
// overlap at joints, the strokes connect into smooth, continuous letterforms.
let GLYPHS = {
    A: [[0.2,6.0,2.0,0.2],[2.0,0.2,3.8,6.0],[0.95,3.8,3.05,3.8]],
    B: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.6,0.0],[2.6,0.0,3.5,1.5],[3.5,1.5,2.6,3.0],[0.3,3.0,2.6,3.0],[2.6,3.0,3.7,4.5],[3.7,4.5,2.6,6.0],[0.3,6.0,2.6,6.0]],
    C: [[3.6,1.3,2.5,0.2],[2.5,0.2,1.2,0.5],[1.2,0.5,0.3,2.0],[0.3,2.0,0.3,4.0],[0.3,4.0,1.2,5.5],[1.2,5.5,2.5,5.8],[2.5,5.8,3.6,4.7]],
    E: [[0.3,0.0,0.3,6.0],[0.3,0.0,3.6,0.0],[0.3,3.0,2.9,3.0],[0.3,6.0,3.6,6.0]],
    F: [[0.3,0.0,0.3,6.0],[0.3,0.0,3.6,0.0],[0.3,3.0,2.9,3.0]],
    G: [[3.6,1.3,2.5,0.2],[2.5,0.2,1.2,0.5],[1.2,0.5,0.3,2.0],[0.3,2.0,0.3,4.0],[0.3,4.0,1.2,5.5],[1.2,5.5,2.5,5.8],[2.5,5.8,3.6,4.8],[3.6,4.8,3.6,3.4],[2.4,3.4,3.6,3.4]],
    H: [[0.3,0.0,0.3,6.0],[3.7,0.0,3.7,6.0],[0.3,3.0,3.7,3.0]],
    I: [[1.0,0.0,3.0,0.0],[2.0,0.0,2.0,6.0],[1.0,6.0,3.0,6.0]],
    K: [[0.3,0.0,0.3,6.0],[0.3,3.4,3.6,0.0],[1.3,2.4,3.8,6.0]],
    L: [[0.3,0.0,0.3,6.0],[0.3,6.0,3.6,6.0]],
    M: [[0.2,6.0,0.2,0.0],[0.2,0.0,2.0,3.2],[2.0,3.2,3.8,0.0],[3.8,0.0,3.8,6.0]],
    O: [[1.3,0.3,2.7,0.3],[2.7,0.3,3.7,1.6],[3.7,1.6,3.7,4.4],[3.7,4.4,2.7,5.7],[2.7,5.7,1.3,5.7],[1.3,5.7,0.3,4.4],[0.3,4.4,0.3,1.6],[0.3,1.6,1.3,0.3]],
    P: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.7,0.0],[2.7,0.0,3.6,1.5],[3.6,1.5,2.7,3.0],[0.3,3.0,2.7,3.0]],
    R: [[0.3,0.0,0.3,6.0],[0.3,0.0,2.7,0.0],[2.7,0.0,3.6,1.5],[3.6,1.5,2.7,3.0],[0.3,3.0,2.7,3.0],[1.6,3.0,3.8,6.0]],
    S: [[3.5,1.2,2.4,0.3],[2.4,0.3,1.1,0.6],[1.1,0.6,0.5,1.8],[0.5,1.8,1.7,2.8],[1.7,2.8,2.6,3.3],[2.6,3.3,3.5,4.4],[3.5,4.4,2.8,5.5],[2.8,5.5,1.5,5.8],[1.5,5.8,0.4,4.9]],
    T: [[0.2,0.0,3.8,0.0],[2.0,0.0,2.0,6.0]],
    U: [[0.3,0.0,0.3,4.4],[0.3,4.4,1.4,5.7],[1.4,5.7,2.6,5.7],[2.6,5.7,3.7,4.4],[3.7,4.4,3.7,0.0]],
    V: [[0.2,0.0,2.0,6.0],[2.0,6.0,3.8,0.0]],
    W: [[0.1,0.0,1.0,6.0],[1.0,6.0,2.0,2.2],[2.0,2.2,3.0,6.0],[3.0,6.0,3.9,0.0]],
    "-": [[1.0,3.0,3.0,3.0]],
};

// ---------------------------------------------------------- color system -----
// Each channel eases between its light and dark value by darkAnim, so toggling
// the theme cross-fades the whole UI. Values are the M3 baseline neutral roles.
function mixCh(l, d) { return l * (1.0 - darkAnim) + d * darkAnim; }

function colorBg() { return [mixCh(0.984, 0.078), mixCh(0.969, 0.071), mixCh(0.996, 0.094)]; }
function surfaceContainer(a) { return [mixCh(0.957, 0.129), mixCh(0.937, 0.122), mixCh(0.969, 0.149), a]; }
function surfaceHighest(a) { return [mixCh(0.902, 0.212), mixCh(0.878, 0.204), mixCh(0.914, 0.231), a]; }
function onSurface(a) { return [mixCh(0.114, 0.902), mixCh(0.106, 0.878), mixCh(0.125, 0.914), a]; }
function outline(a) { return [mixCh(0.475, 0.576), mixCh(0.455, 0.561), mixCh(0.494, 0.600), a]; }
function outlineVar(a) { return [mixCh(0.792, 0.286), mixCh(0.769, 0.271), mixCh(0.816, 0.310), a]; }

// The active accent (primary), eased between its light and dark tone.
function accCh(i) { return accLight[accent][i] * (1.0 - darkAnim) + accDark[accent][i] * darkAnim; }
function acc(a) { return [accCh(0), accCh(1), accCh(2), a]; }
// "On accent" content (text / icons on a primary-colored surface): near-white in
// light, near-black in dark, so it stays legible whichever scheme is active.
function onAcc(a) { return [mixCh(1.0, 0.118), mixCh(1.0, 0.110), mixCh(1.0, 0.137), a]; }

function mixCol(c0, c1, t) {
    return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t, c0[3] + (c1[3] - c0[3]) * t];
}
// A flat additive lighten — a cheap proxy for an M3 white state-layer overlay.
function brighten(col, amt) { return [col[0] + amt, col[1] + amt, col[2] + amt, col[3]]; }

// --------------------------------------------------------------- helpers ------
// One rounded-rect instance (16 floats); crisp edge (feather ~1px).
function inst(cx, cy, hw, hh, radius, border, rot, fill, bcol) {
    return [cx, cy, hw, hh, radius, border, rot, 1.0,
            fill[0], fill[1], fill[2], fill[3],
            bcol[0], bcol[1], bcol[2], bcol[3]];
}
// A soft, downward-offset dark rounded rect behind an elevated surface — an M3
// elevation shadow (large feather → blurred edge).
function shadow(cx, cy, hw, hh, radius, grow, drop, blur) {
    return [cx, cy + drop, hw + grow, hh + grow, radius + grow, 0.0, 0.0, blur,
            0.0, 0.0, 0.0, 0.28, 0.0, 0.0, 0.0, 0.0];
}
// Append every float of instance `a` onto array `out` (O(1) amortized push).
function emit(out, a) { for (let j = 0; j < len(a); j++) { push(out, a[j]); } }
// Concatenate a list of instance arrays into one flat float array.
function joinAll(arrs) {
    let o = [];
    for (let i = 0; i < len(arrs); i++) { o = concat(o, arrs[i]); }
    return o;
}

// 1.0/0.0-free hit test: true when (px,py) is inside the axis-aligned rect.
function inRect(px, py, cx, cy, hw, hh) {
    if (px >= cx - hw) { if (px <= cx + hw) { if (py >= cy - hh) { if (py <= cy + hh) { return true; } } } }
    return false;
}
function clamp01(v) { if (v < 0.0) { return 0.0; } if (v > 1.0) { return 1.0; } return v; }
function ease(cur, target, k) { return cur + (target - cur) * k; }
function sel(r, v) { if (r == v) { return 1.0; } return 0.0; }

// ---------------------------------------------------------------- layout ------
// Recompute every widget's geometry from the live viewport into `L`. Called by
// both render() (to build instances) and onEvent() (to hit-test), so layout has
// exactly one source of truth.
function layout() {
    L = {
        appBar:         { cx: vw * 0.5,  cy: vh * 0.055, hw: vw * 0.5,  hh: vh * 0.045 },
        card:           { cx: vw * 0.5,  cy: vh * 0.56,  hw: vw * 0.44, hh: vh * 0.40 },
        filledButton:   { cx: vw * 0.32, cy: vh * 0.22,  hw: vw * 0.20, hh: vh * 0.032 },
        outlinedButton: { cx: vw * 0.70, cy: vh * 0.22,  hw: vw * 0.18, hh: vh * 0.032 },
        switch:         { cx: vw * 0.74, cy: vh * 0.34,  hw: vh * 0.045, hh: vh * 0.020 },
        checkbox:       { cx: vw * 0.26, cy: vh * 0.34,  hw: vh * 0.022, hh: vh * 0.022 },
        radioGroup:     { cx: vw * 0.5,  cy: vh * 0.45,  hw: vh * 0.020, hh: vh * 0.020, sp: vw * 0.13 },
        slider:         { cx: vw * 0.5,  cy: vh * 0.56,  hw: vw * 0.40, hh: vh * 0.0075 },
        chip:           { cx: vw * 0.34, cy: vh * 0.67,  hw: vw * 0.13, hh: vh * 0.024 },
        divider:        { cx: vw * 0.5,  cy: vh * 0.62,  hw: vw * 0.40, hh: 1.0 },
        progress:       { cx: vw * 0.5,  cy: vh * 0.74,  hw: vw * 0.40, hh: vh * 0.0075 },
        fab:            { cx: vw * 0.84, cy: vh * 0.85,  hw: vh * 0.05, hh: vh * 0.05 },
    };
}

// ----------------------------------------------------- per-widget builders ----
function buildCard() {
    let c = L.card;
    let r = vh * 0.016;   // M3 medium container corner
    return joinAll([
        shadow(c.cx, c.cy, c.hw, c.hh, r, vh * 0.004, vh * 0.010, vh * 0.028),
        inst(c.cx, c.cy, c.hw, c.hh, r, 0.0, 0.0, surfaceContainer(1.0), TRANSPARENT),
    ]);
}

function buildAppBar() {
    let b = L.appBar;
    let lineCx = b.cx - b.hw + vh * 0.06;
    let lw = vh * 0.020; let lh = vh * 0.004; let sp = vh * 0.013;
    let avCx = b.cx + b.hw - vh * 0.06; let avR = vh * 0.026;
    return joinAll([
        inst(b.cx, b.cy, b.hw, b.hh, 0.0, 0.0, 0.0, acc(1.0), TRANSPARENT),
        inst(lineCx, b.cy - sp, lw, lh, lh, 0.0, 0.0, onAcc(0.95), TRANSPARENT),
        inst(lineCx, b.cy,      lw, lh, lh, 0.0, 0.0, onAcc(0.95), TRANSPARENT),
        inst(lineCx, b.cy + sp, lw, lh, lh, 0.0, 0.0, onAcc(0.95), TRANSPARENT),
        inst(avCx, b.cy, avR, avR, avR, 0.0, 0.0, onAcc(0.90), TRANSPARENT),
    ]);
}

function buildFilled() {
    let b = L.filledButton;
    let st = hoverState(b) * 0.08 + pressFilled * 0.12;
    return joinAll([
        shadow(b.cx, b.cy, b.hw, b.hh, b.hh, vh * 0.002, vh * 0.006, vh * 0.018),
        inst(b.cx, b.cy, b.hw, b.hh, b.hh, 0.0, 0.0, brighten(acc(1.0), st), TRANSPARENT),
    ]);
}

function buildOutlined() {
    let b = L.outlinedButton;
    let st = hoverState(b) * 0.08 + pressOutlined * 0.12;
    return inst(b.cx, b.cy, b.hw, b.hh, b.hh, vh * 0.0018, 0.0, acc(st), acc(1.0));
}

function buildFab() {
    let f = L.fab;
    let st = 0.0;
    if (inRect(hx, hy, f.cx, f.cy, f.hw, f.hw)) { st = 0.08; }
    st = st + pressFab * 0.12;
    let rad = f.hw * 0.57;   // M3 FAB: rounded square, not a circle
    return joinAll([
        shadow(f.cx, f.cy, f.hw, f.hw, rad, vh * 0.004, vh * 0.012, vh * 0.030),
        inst(f.cx, f.cy, f.hw, f.hw, rad, 0.0, 0.0, brighten(acc(1.0), st), TRANSPARENT),
        inst(f.cx, f.cy, f.hw * 0.42, f.hw * 0.10, f.hw * 0.10, 0.0, 0.0, onAcc(1.0), TRANSPARENT),
        inst(f.cx, f.cy, f.hw * 0.10, f.hw * 0.42, f.hw * 0.10, 0.0, 0.0, onAcc(1.0), TRANSPARENT),
    ]);
}

function buildSwitch() {
    let s = L.switch;
    let trackFill = mixCol(surfaceHighest(1.0), acc(1.0), swAnim);
    let trackBorder = mixCol(outline(1.0), acc(1.0), swAnim);
    let bw = (1.0 - swAnim) * vh * 0.0022;   // outline only while off
    let track = inst(s.cx, s.cy, s.hw, s.hh, s.hh, bw, 0.0, trackFill, trackBorder);
    let rOff = s.hh * 0.55; let rOn = s.hh * 0.82;
    let tr = rOff + (rOn - rOff) * swAnim;
    let left = s.cx - s.hw; let right = s.cx + s.hw;
    let tx = (left + s.hh) + ((right - s.hh) - (left + s.hh)) * swAnim;
    let thumbFill = mixCol(outline(1.0), [1.0, 1.0, 1.0, 1.0], swAnim);
    let thumb = inst(tx, s.cy, tr, tr, tr, 0.0, 0.0, thumbFill, TRANSPARENT);
    return concat(track, thumb);
}

function buildCheckbox() {
    let c = L.checkbox; let h = c.hw;
    let box = inst(c.cx, c.cy, h, h, h * 0.28, vh * 0.0022, 0.0,
        acc(ckAnim), mixCol(outline(1.0), acc(1.0), ckAnim));
    let white = [1.0, 1.0, 1.0, ckAnim];
    let leftBar = inst(c.cx - h * 0.22, c.cy + h * 0.12, h * 0.25, h * 0.08, h * 0.08, 0.0, -2.356, white, TRANSPARENT);
    let rightBar = inst(c.cx + h * 0.22, c.cy - h * 0.12, h * 0.50, h * 0.08, h * 0.08, 0.0, -0.997, white, TRANSPARENT);
    return joinAll([box, leftBar, rightBar]);
}

function buildRadio() {
    let g = L.radioGroup;
    let out = [];
    for (let i = 0; i < 3; i++) {
        let ci = g.cx + (i - 1) * g.sp;
        let anim = r0Anim;
        if (i == 1) { anim = r1Anim; }
        if (i == 2) { anim = r2Anim; }
        let ring = inst(ci, g.cy, g.hw, g.hw, g.hw, vh * 0.0022, 0.0,
            TRANSPARENT, mixCol(outline(1.0), acc(1.0), anim));
        let dr = g.hw * 0.55 * anim;
        let dot = inst(ci, g.cy, dr, dr, dr, 0.0, 0.0, acc(1.0), TRANSPARENT);
        out = concat(out, concat(ring, dot));
    }
    return out;
}

function buildSlider() {
    let s = L.slider;
    let left = s.cx - s.hw; let width = s.hw * 2.0;
    let inactive = inst(s.cx, s.cy, s.hw, s.hh, s.hh, 0.0, 0.0, surfaceHighest(1.0), TRANSPARENT);
    let actHw = sliderVal * width / 2.0;
    let actCx = left + sliderVal * width / 2.0;
    let active = inst(actCx, s.cy, actHw, s.hh, s.hh, 0.0, 0.0, acc(1.0), TRANSPARENT);
    let baseR = vh * 0.014;
    let tw = baseR * 0.42 * (1.0 + dragging * 0.2);
    let th = baseR * (1.4 + dragging * 0.25);
    let tx = left + sliderVal * width;
    let thumb = inst(tx, s.cy, tw, th, tw, 0.0, 0.0, acc(1.0), TRANSPARENT);
    return joinAll([inactive, active, thumb]);
}

function buildChip() {
    let c = L.chip;
    let body = inst(c.cx, c.cy, c.hw, c.hh, c.hh * 0.5, vh * 0.0018, 0.0,
        acc(chipAnim), mixCol(outline(1.0), acc(1.0), chipAnim));
    let dotCx = c.cx - c.hw + c.hh * 1.1; let dr = c.hh * 0.42;
    let dot = inst(dotCx, c.cy, dr, dr, dr, 0.0, 0.0, [1.0, 1.0, 1.0, chipAnim], TRANSPARENT);
    return concat(body, dot);
}

function buildProgress() {
    let p = L.progress;
    let track = inst(p.cx, p.cy, p.hw, p.hh, p.hh, 0.0, 0.0, surfaceHighest(1.0), TRANSPARENT);
    let prog = (swAnim + ckAnim + chipAnim) / 3.0;
    let left = p.cx - p.hw; let width = p.hw * 2.0 * prog;
    let indicator = inst(left + width / 2.0, p.cy, width / 2.0, p.hh, p.hh, 0.0, 0.0, acc(1.0), TRANSPARENT);
    return concat(track, indicator);
}

function buildDivider() {
    let d = L.divider;
    return inst(d.cx, d.cy, d.hw, d.hh, 0.0, 0.0, 0.0, outlineVar(1.0), TRANSPARENT);
}

// Hover state-layer amount (0/1) for a rectangular widget at the hover point.
function hoverState(w) { if (inRect(hx, hy, w.cx, w.cy, w.hw, w.hh)) { return 1.0; } return 0.0; }

// ----------------------------------------------------------------- text -------
// Caption descriptors for the current layout. `ink`: 0 on-surface, 1 accent,
// 2 on-accent (white).
function buildLabels() {
    let g = L.radioGroup;
    let labels = [];
    push(labels, { t: "ELPA UI", cx: L.appBar.cx, cy: L.appBar.cy, cell: vh * 0.0058, ink: 2 });
    push(labels, { t: "THEME", cx: L.filledButton.cx, cy: L.filledButton.cy, cell: vh * 0.0042, ink: 2 });
    push(labels, { t: "RESET", cx: L.outlinedButton.cx, cy: L.outlinedButton.cy, cell: vh * 0.0042, ink: 1 });
    push(labels, { t: "WI-FI", cx: L.switch.cx, cy: L.switch.cy - vh * 0.035, cell: vh * 0.0036, ink: 0 });
    push(labels, { t: "AGREE", cx: L.checkbox.cx, cy: L.checkbox.cy - vh * 0.035, cell: vh * 0.0036, ink: 0 });
    push(labels, { t: "VOLUME", cx: L.slider.cx, cy: L.slider.cy - vh * 0.030, cell: vh * 0.0036, ink: 0 });
    push(labels, { t: "TASKS", cx: L.progress.cx, cy: L.progress.cy - vh * 0.028, cell: vh * 0.0036, ink: 0 });
    push(labels, { t: "FILTER", cx: L.chip.cx + L.chip.hh * 0.5, cy: L.chip.cy, cell: vh * 0.0034, ink: 0 });
    push(labels, { t: "A", cx: g.cx - g.sp, cy: g.cy + vh * 0.032, cell: vh * 0.0040, ink: 0 });
    push(labels, { t: "B", cx: g.cx,        cy: g.cy + vh * 0.032, cell: vh * 0.0040, ink: 0 });
    push(labels, { t: "C", cx: g.cx + g.sp, cy: g.cy + vh * 0.032, cell: vh * 0.0040, ink: 0 });
    return labels;
}

function inkColor(code) {
    if (code == 1) { return acc(1.0); }
    if (code == 2) { return onAcc(0.98); }
    return onSurface(1.0);
}

// Build the cached caption capsule buffer for the current layout + theme, padded
// to LABEL_CAP instances with invisible zero rects so the draw count is fixed.
function buildText() {
    let labels = buildLabels();
    let out = [];
    let adv = 5.0; let th = 0.92;
    for (let li = 0; li < len(labels); li++) {
        let lab = labels[li];
        let col = inkColor(lab.ink);
        let text = lab.t;
        let nch = len(text);
        for (let ci = 0; ci < nch; ci++) {
            let ch = charAt(text, ci);
            if (has(GLYPHS, ch)) {
                let segs = GLYPHS[ch];
                let gc = (ci - (nch - 1.0) / 2.0) * adv;
                for (let si = 0; si < len(segs); si++) {
                    let s = segs[si];
                    let ax = gc - 2.0 + s[0]; let ay = s[1] - 3.0;
                    let bx = gc - 2.0 + s[2]; let by = s[3] - 3.0;
                    let dx = bx - ax; let dy = by - ay;
                    let ln = sqrt(dx * dx + dy * dy);
                    emit(out, inst(
                        lab.cx + lab.cell * (ax + bx) / 2.0,
                        lab.cy + lab.cell * (ay + by) / 2.0,
                        lab.cell * ln / 2.0, lab.cell * th / 2.0, lab.cell * th / 2.0,
                        0.0, atan2(dy, dx), col, TRANSPARENT));
                }
            }
        }
    }
    let have = len(out) / 16;
    for (let k = have; k < LABEL_CAP; k++) {
        for (let z = 0; z < 16; z++) { push(out, 0.0); }
    }
    txt = out;
    txtDark = darkAnim; txtAccent = accent;
}

// Rebuild captions only when the theme or accent has moved since the last build
// (their geometry is layout-only and cached; their color tracks the scheme).
function maybeRebuildText() {
    let dd = darkAnim - txtDark;
    if (dd < 0.0) { dd = -dd; }
    if (dd > 0.003) { buildText(); return 0; }
    if (accent != txtAccent) { buildText(); }
    return 0;
}

// --------------------------------------------------------------- render -------
function buf(id, usage, data) {
    return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data };
}
function instBuf(name, data) {
    return buf(concat(concat("elpa.m3.", name), ".instances"), ["VERTEX"], data);
}

function render() {
    let si = askHost("gpu.surfaceInfo", []);
    vw = num(si.width); vh = num(si.height);
    layout();
    maybeRebuildText();
    let bg = colorBg();

    let res = [
        buf("elpa.m3.globals", ["UNIFORM", "COPY_DST"], [vw, vh, 0.0, 0.0]),
        { kind: "bindGroup", id: "elpa.m3.globalsBind", layout: "elpa.m3.bgl",
          entries: [{ binding: 0, resource: { type: "buffer", buffer: "elpa.m3.globals" } }] },
    ];
    push(res, instBuf("card", buildCard()));
    push(res, instBuf("appBar", buildAppBar()));
    push(res, instBuf("filledButton", buildFilled()));
    push(res, instBuf("outlinedButton", buildOutlined()));
    push(res, instBuf("fab", buildFab()));
    push(res, instBuf("switch", buildSwitch()));
    push(res, instBuf("checkbox", buildCheckbox()));
    push(res, instBuf("radioGroup", buildRadio()));
    push(res, instBuf("slider", buildSlider()));
    push(res, instBuf("chip", buildChip()));
    push(res, instBuf("progress", buildProgress()));
    push(res, instBuf("divider", buildDivider()));
    push(res, buf("elpa.m3.labels.instances", ["VERTEX"], txt));

    // Draw order: panel behind, controls, app bar, captions, FAB on top.
    let order = ["card", "divider", "progress", "slider", "switch", "checkbox",
                 "radioGroup", "chip", "filledButton", "outlinedButton", "appBar", "labels", "fab"];
    let cmds = [{ cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.globalsBind" }];
    for (let i = 0; i < len(order); i++) {
        push(cmds, { cmd: "useDefinition", definition: concat("elpa.m3.", order[i]) });
    }

    askHost("gpu.submit", [{
        resources: res,
        commands: [{
            op: "renderPass", id: "elpa.m3.ui",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: cmds,
        }],
    }]);
}

// ------------------------------------------------------------ interaction -----
function pad() { return vh * 0.02; }   // finger-friendly touch padding
function hit(px, py, name) { let w = L[name]; return inRect(px, py, w.cx, w.cy, w.hw, w.hh); }
function hitPad(px, py, name) { let w = L[name]; return inRect(px, py, w.cx, w.cy, w.hw + pad(), w.hh + pad()); }
function radioHit(px, py, idx) {
    let g = L.radioGroup; let cx = g.cx + (idx - 1) * g.sp;
    return inRect(px, py, cx, g.cy, g.hw + pad(), g.hw + pad());
}
function sliderHit(px, py) { let s = L.slider; return inRect(px, py, s.cx, s.cy, s.hw, vh * 0.05); }
function sliderSet(px) { let s = L.slider; sliderVal = clamp01((px - (s.cx - s.hw)) / (s.hw * 2.0)); }
function resetAll() { swOn = 0.0; ck = 0.0; chip = 0.0; radio = 0.0; sliderVal = 0.5; }

function onEvent(e) {
    layout();
    let et = e.type;
    let px = e.nx * vw; let py = e.ny * vh;

    if (et == "pointermove") { hx = px; hy = py; }

    if (et == "pointerdown") {
        if (hit(px, py, "filledButton")) { pressFilled = 1.0; dark = 1.0 - dark; }
        if (hit(px, py, "outlinedButton")) { pressOutlined = 1.0; resetAll(); }
        if (inRect(px, py, L.fab.cx, L.fab.cy, L.fab.hw, L.fab.hw)) { pressFab = 1.0; accent = (accent + 1) % 4; }
        if (hitPad(px, py, "switch")) { swOn = 1.0 - swOn; }
        if (hitPad(px, py, "checkbox")) { ck = 1.0 - ck; }
        if (hit(px, py, "chip")) { chip = 1.0 - chip; }
        if (radioHit(px, py, 0)) { radio = 0.0; }
        if (radioHit(px, py, 1)) { radio = 1.0; }
        if (radioHit(px, py, 2)) { radio = 2.0; }
        if (sliderHit(px, py)) { dragging = 1.0; sliderSet(px); }
    }

    if (et == "pointerup") {
        pressFilled = 0.0; pressOutlined = 0.0; pressFab = 0.0; dragging = 0.0;
    }

    if (et == "pointermove") {
        if (dragging > 0.5) { sliderSet(px); }
    }

    if (et == "wheel") { sliderVal = clamp01(sliderVal + e.deltaY * (-0.0015)); }

    if (et == "keydown") {
        let k = e.key;
        if (k == "ArrowRight") { sliderVal = clamp01(sliderVal + 0.05); }
        if (k == "ArrowLeft") { sliderVal = clamp01(sliderVal - 0.05); }
        if (k == "d") { dark = 1.0 - dark; }
        if (k == " ") { swOn = 1.0 - swOn; }
        if (k == "r") { resetAll(); }
        keyGlow = 1.0;
    }
    if (et == "keyup") { keyGlow = 0.0; }

    render();
}

function onFrame(dt) {
    n = n + 1;
    swAnim = ease(swAnim, swOn, 0.25);
    ckAnim = ease(ckAnim, ck, 0.25);
    chipAnim = ease(chipAnim, chip, 0.25);
    darkAnim = ease(darkAnim, dark, 0.18);
    r0Anim = ease(r0Anim, sel(radio, 0.0), 0.30);
    r1Anim = ease(r1Anim, sel(radio, 1.0), 0.30);
    r2Anim = ease(r2Anim, sel(radio, 2.0), 0.30);
    pressFilled = pressFilled * 0.85;
    pressOutlined = pressOutlined * 0.85;
    pressFab = pressFab * 0.85;
    keyGlow = keyGlow * 0.90;
    render();
}

function onResize(info) {
    vw = num(info.width); vh = num(info.height);
    layout(); buildText(); render();
}

// First paint: query the surface, lay out, build captions, render.
let si0 = askHost("gpu.surfaceInfo", []);
vw = num(si0.width); vh = num(si0.height);
layout();
buildText();
render();
