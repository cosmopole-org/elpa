// Elpa Web SDK — the CSS engine (Viewport + Style resolver).
//
// This is the heart of the kit: it turns a raw CSS declaration object (property
// name -> string/number value) into a *computed style* of numbers, colours and
// enums the box-model / layout / paint code consumes. It implements the CSS
// value machinery a browser does at this layer:
//
//   * the <color> grammar — named keywords (CSS Color L4), #rgb/#rgba/#rrggbb/
//     #rrggbbaa, rgb()/rgba(), hsl()/hsla(), `transparent`, `currentColor`;
//   * the <length>/<percentage> grammar — px, em, rem, vw, vh, vmin, vmax, %,
//     unit-less numbers, `auto`/`none` (kept as tokens so percentages resolve
//     against the right containing block at layout time);
//   * shorthand expansion — margin/padding/border/border-radius/inset/gap/flex/
//     background/box-shadow/transition/transform/font;
//   * inheritance — the inherited subset (colour, font, text, visibility, …)
//     flows top-down so children compute against their parent's used values.
//
// `Viewport` is the device surface: physical pixel size, device-pixel-ratio and
// the root font size (the `rem` basis). CSS px are device-independent; the kit
// renders in physical px, so every used length is multiplied by `dpr` at the
// paint boundary (the `u()` helper) — exactly once, never in layout maths.

// The root inherited context (the initial values of inherited properties), used
// as the parent context of the document root.
let ROOT_INH = {
    color: [0.0, 0.0, 0.0, 1.0], fontPx: 16.0, fontWeight: 400.0, fontStyle: "normal",
    lineHeight: 1.2, textAlign: "left", whiteSpace: "normal", textTransform: "none",
    letterSpacing: 0.0, visibility: "visible", listStyleType: "disc", cursor: "auto",
    textDecoration: "none", textShadow: []
};

// ---------------------------------------------------------------- Viewport ----
class Viewport {
    constructor() { this.vw = 1.0; this.vh = 1.0; this.dpr = 1.0; this.rootPx = 16.0; }
    setMetrics(si) {
        this.vw = num(si.width); this.vh = num(si.height);
        if (has(si, "colorFormat")) { SURFACE_FMT = si.colorFormat; }
        this.dpr = 1.0; if (has(si, "scaleFactor")) { this.dpr = num(si.scaleFactor); }
        if (this.dpr < 0.1) { this.dpr = 1.0; }
    }
    // CSS px -> physical px (the one place the device scale is applied).
    u(cssPx) { return cssPx * this.dpr; }
    // Viewport size in CSS px (the vw/vh/% basis units).
    cssW() { return this.vw / this.dpr; }
    cssH() { return this.vh / this.dpr; }
    bg() { return [1.0, 1.0, 1.0]; }
    setRootFontSize(px) { this.rootPx = px; }
}

// ------------------------------------------------------------------ helpers ---
// Split `s` on `sep` at top level only (commas inside parens stay together) —
// for multi-value lists (multiple backgrounds, shadows, transition props).
function cssSplitTop(s, sep) {
    let out = []; let depth = 0; let cur = ""; let n = len(s);
    for (let i = 0; i < n; i++) {
        let c = charAt(s, i);
        if (c == "(") { depth = depth + 1; }
        if (c == ")") { if (depth > 0) { depth = depth - 1; } }
        let isSep = 0.0; if (c == sep) { if (depth == 0) { isSep = 1.0; } }
        if (isSep > 0.5) { push(out, trim(cur)); cur = ""; } else { cur = concat(cur, c); }
    }
    if (len(trim(cur)) > 0) { push(out, trim(cur)); }
    return out;
}
// Split a value into whitespace-separated tokens at top level (parens grouped).
function cssTokens(s) {
    let out = []; let depth = 0; let cur = ""; let n = len(s);
    for (let i = 0; i < n; i++) {
        let c = charAt(s, i);
        if (c == "(") { depth = depth + 1; cur = concat(cur, c); }
        else { if (c == ")") { if (depth > 0) { depth = depth - 1; } cur = concat(cur, c); }
        else {
            let ws = 0.0;
            if (c == " ") { ws = 1.0; } if (c == "\t") { ws = 1.0; } if (c == "\n") { ws = 1.0; } if (c == "\r") { ws = 1.0; }
            if (ws > 0.5) { if (depth == 0) { if (len(cur) > 0) { push(out, cur); cur = ""; } } else { cur = concat(cur, c); } }
            else { cur = concat(cur, c); }
        } }
    }
    if (len(cur) > 0) { push(out, cur); }
    return out;
}
// The inner argument list of a `fn(a, b, c)` value, split into tokens.
function cssArgs(s) {
    let o = indexOf(s, "("); if (o < 0) { return []; }
    let inner = substring(s, o + 1, len(s)); let c = indexOf(inner, ")");
    if (c >= 0) { inner = substring(inner, 0, c); }
    let parts = cssSplitTop(inner, ","); let out = [];
    for (let i = 0; i < len(parts); i++) {
        let p = trim(parts[i]);
        // Allow "h s l / a" slash syntax → flatten to comma list.
        if (contains(p, "/")) { let sp = split(p, "/"); for (let j = 0; j < len(sp); j++) { let t = trim(sp[j]); if (len(t) > 0) { push(out, t); } } }
        else { push(out, p); }
    }
    return out;
}

// ----------------------------------------------------------------- colours ----
// Two hex chars -> 0..255.
function hex2(s, i) {
    let a = charAt(s, i); let b = charAt(s, i + 1); let hv = 0.0;
    if (has(HEX_VAL, a)) { hv = HEX_VAL[a]; }
    let lv = 0.0; if (has(HEX_VAL, b)) { lv = HEX_VAL[b]; }
    return hv * 16.0 + lv;
}
function hex1(s, i) { let a = charAt(s, i); let hv = 0.0; if (has(HEX_VAL, a)) { hv = HEX_VAL[a]; } return hv * 16.0 + hv; }
function parseHex(s) {
    let h = substring(s, 1, len(s)); let n = len(h);
    if (n == 3) { return [hex1(h, 0) / 255.0, hex1(h, 1) / 255.0, hex1(h, 2) / 255.0, 1.0]; }
    if (n == 4) { return [hex1(h, 0) / 255.0, hex1(h, 1) / 255.0, hex1(h, 2) / 255.0, hex1(h, 3) / 255.0]; }
    if (n == 6) { return [hex2(h, 0) / 255.0, hex2(h, 2) / 255.0, hex2(h, 4) / 255.0, 1.0]; }
    if (n == 8) { return [hex2(h, 0) / 255.0, hex2(h, 2) / 255.0, hex2(h, 4) / 255.0, hex2(h, 6) / 255.0]; }
    return [0.0, 0.0, 0.0, 1.0];
}
// A channel that may be "50%" or "0..255".
function colCh(t) { if (endsWith(t, "%")) { return num(substring(t, 0, len(t) - 1)) / 100.0; } return num(t) / 255.0; }
function hue2rgb(p, q, t) {
    if (t < 0.0) { t = t + 1.0; } if (t > 1.0) { t = t - 1.0; }
    if (t < 0.16667) { return p + (q - p) * 6.0 * t; }
    if (t < 0.5) { return q; }
    if (t < 0.66667) { return p + (q - p) * (0.66667 - t) * 6.0; }
    return p;
}
function hslToRgb(h, s, l) {
    h = h / 360.0; if (s == 0.0) { return [l, l, l]; }
    let q = l + s - l * s; if (l < 0.5) { q = l * (1.0 + s); }
    let p = 2.0 * l - q;
    return [hue2rgb(p, q, h + 0.33333), hue2rgb(p, q, h), hue2rgb(p, q, h - 0.33333)];
}
// Resolve any CSS <color> to rgba [0..1]. `cur` is the currentColor value.
function parseColor(v, cur) {
    if (isNull(v)) { return CLEAR; }
    if (typeOf(v) != "string") { if (typeOf(v) == "array") { return v; } return CLEAR; }
    let s = trim(v); if (len(s) == 0) { return CLEAR; }
    let low = lower(s);
    if (low == "transparent") { return [0.0, 0.0, 0.0, 0.0]; }
    if (low == "currentcolor") { if (isNull(cur)) { return ROOT_INH.color; } return cur; }
    if (startsWith(s, "#")) { return parseHex(s); }
    if (startsWith(low, "rgb")) {
        let a = cssArgs(s);
        let al = 1.0; if (len(a) > 3) { al = num(a[3]); if (endsWith(a[3], "%")) { al = num(substring(a[3], 0, len(a[3]) - 1)) / 100.0; } }
        return [colCh(a[0]), colCh(a[1]), colCh(a[2]), al];
    }
    if (startsWith(low, "hsl")) {
        let a = cssArgs(s); let h = num(a[0]);
        let sn = num(a[1]); if (endsWith(a[1], "%")) { sn = num(substring(a[1], 0, len(a[1]) - 1)) / 100.0; }
        let ln = num(a[2]); if (endsWith(a[2], "%")) { ln = num(substring(a[2], 0, len(a[2]) - 1)) / 100.0; }
        let rgb = hslToRgb(h, sn, ln);
        let al = 1.0; if (len(a) > 3) { al = num(a[3]); if (endsWith(a[3], "%")) { al = num(substring(a[3], 0, len(a[3]) - 1)) / 100.0; } }
        return [rgb[0], rgb[1], rgb[2], al];
    }
    if (has(CSS_COLORS, low)) { let hx = CSS_COLORS[low]; if (hx == "currentColor") { if (isNull(cur)) { return ROOT_INH.color; } return cur; } return parseHex(hx); }
    return CLEAR;
}

// ----------------------------------------------------------------- lengths ----
// Parse a <length>/<percentage>/keyword into a token resolved at layout time:
//   { k:"px", v } | { k:"pct", v(0..1) } | { k:"auto" } | { k:"none" }
// em/rem/vw/vh/vmin/vmax fold to px immediately (basis-independent).
function parseLen(v, fontPx, vp) {
    if (isNull(v)) { return { k: "auto" }; }
    if (isNum(v) > 0.5) { return { k: "px", v: v }; }
    let s = trim(lower(v));
    if (s == "auto") { return { k: "auto" }; }
    if (s == "none") { return { k: "none" }; }
    if (s == "0") { return { k: "px", v: 0.0 }; }
    if (s == "normal") { return { k: "auto" }; }
    if (endsWith(s, "%")) { return { k: "pct", v: num(substring(s, 0, len(s) - 1)) / 100.0 }; }
    if (endsWith(s, "px")) { return { k: "px", v: num(substring(s, 0, len(s) - 2)) }; }
    if (endsWith(s, "rem")) { return { k: "px", v: num(substring(s, 0, len(s) - 3)) * vp.rootPx }; }
    if (endsWith(s, "em")) { return { k: "px", v: num(substring(s, 0, len(s) - 2)) * fontPx }; }
    if (endsWith(s, "vw")) { return { k: "px", v: num(substring(s, 0, len(s) - 2)) * vp.cssW() / 100.0 }; }
    if (endsWith(s, "vh")) { return { k: "px", v: num(substring(s, 0, len(s) - 2)) * vp.cssH() / 100.0 }; }
    if (endsWith(s, "vmin")) { let m = min(vp.cssW(), vp.cssH()); return { k: "px", v: num(substring(s, 0, len(s) - 4)) * m / 100.0 }; }
    if (endsWith(s, "vmax")) { let m = max(vp.cssW(), vp.cssH()); return { k: "px", v: num(substring(s, 0, len(s) - 4)) * m / 100.0 }; }
    if (endsWith(s, "pt")) { return { k: "px", v: num(substring(s, 0, len(s) - 2)) * 1.3333 }; }
    // A bare number, else a non-length token (e.g. a colour in a shadow list).
    if (startsNumeric(s) > 0.5) { return { k: "px", v: num(s) }; }
    return { k: "auto" };
}
// True if `s` begins like a number (digit, sign or decimal point).
function startsNumeric(s) {
    if (len(s) == 0) { return 0.0; }
    let c = charAt(s, 0);
    if (c == "-") { return 1.0; } if (c == "+") { return 1.0; } if (c == ".") { return 1.0; }
    if (has(HEX_VAL, c)) { if (c != "a") { if (c != "b") { if (c != "c") { if (c != "d") { if (c != "e") { if (c != "f") { return 1.0; } } } } } } }
    return 0.0;
}
// Resolve a length token to CSS px against a containing-block `basis`.
// `dflt` is returned for auto/none.
function usedLen(t, basis, dflt) {
    if (t.k == "px") { return t.v; }
    if (t.k == "pct") { return t.v * basis; }
    return dflt;
}
function isAuto(t) { if (t.k == "auto") { return 1.0; } return 0.0; }

// A numeric font-weight from a keyword or number.
function parseWeight(v, inh) {
    if (isNull(v)) { return inh; }
    if (isNum(v) > 0.5) { return v; }
    let s = trim(lower(v));
    if (s == "normal") { return 400.0; }
    if (s == "bold") { return 700.0; }
    if (s == "lighter") { return 300.0; }
    if (s == "bolder") { return 700.0; }
    return num(s);
}

// Camel-case a kebab-case property name ("background-color" -> "backgroundColor").
function camel(k) {
    if (!contains(k, "-")) { return k; }
    let parts = split(k, "-"); let out = parts[0];
    for (let i = 1; i < len(parts); i++) { let p = parts[i]; if (len(p) > 0) { out = concat(out, concat(upper(substring(p, 0, 1)), substring(p, 1, len(p)))); } }
    return out;
}
// Normalise a raw style object: kebab keys -> camelCase (author may use either).
function normalizeStyle(raw) {
    if (isNull(raw)) { return {}; }
    if (typeOf(raw) != "object") { return {}; }
    let out = {}; let ks = keys(raw);
    for (let i = 0; i < len(ks); i++) { let k = ks[i]; out[camel(k)] = raw[k]; }
    return out;
}
function sv(st, k) { if (has(st, k)) { return st[k]; } return 0; }
function svdef(st, k, d) { if (has(st, k)) { let v = st[k]; if (!isNull(v)) { return v; } } return d; }
// Expand a 1..4-value box shorthand into {t,r,b,l} (CSS clockwise rules).
function box4(toks) {
    let n = len(toks);
    if (n == 1) { return { t: toks[0], r: toks[0], b: toks[0], l: toks[0] }; }
    if (n == 2) { return { t: toks[0], r: toks[1], b: toks[0], l: toks[1] }; }
    if (n == 3) { return { t: toks[0], r: toks[1], b: toks[2], l: toks[1] }; }
    return { t: toks[0], r: toks[1], b: toks[2], l: toks[3] };
}
function angleRad(s) {
    s = trim(lower(s));
    if (endsWith(s, "deg")) { return num(substring(s, 0, len(s) - 3)) * 0.0174533; }
    if (endsWith(s, "turn")) { return num(substring(s, 0, len(s) - 4)) * 6.2831853; }
    if (endsWith(s, "rad")) { return num(substring(s, 0, len(s) - 3)); }
    if (endsWith(s, "grad")) { return num(substring(s, 0, len(s) - 4)) * 0.015708; }
    return num(s) * 0.0174533;
}
function durMs(s) {
    s = trim(lower(s));
    if (endsWith(s, "ms")) { return num(substring(s, 0, len(s) - 2)); }
    if (endsWith(s, "s")) { return num(substring(s, 0, len(s) - 1)) * 1000.0; }
    return num(s);
}

// ------------------------------------------------------------------- Style ----
// The cascade: build a computed style from a (normalised) declaration object,
// the parent's inherited context and the viewport. Absolute lengths fold to CSS
// px now; percentage/auto lengths stay tokens (resolved at layout against the
// right containing block). Inherited properties fall back to `inh`.
// CSS value parsers (gradients, shadows, transforms, transitions).
// Parse `linear-gradient(...)` / `radial-gradient(...)` to a kit gradient spec.
function cssGradient(s, cur) {
        let low = lower(s);
        let kind = "linear"; if (startsWith(low, "radial")) { kind = "radial"; } if (startsWith(low, "conic")) { kind = "sweep"; }
        let a = cssSplitTop(substring(s, indexOf(s, "(") + 1, len(s) - 1), ",");
        let angle = 3.14159; let start = 0; let colors = []; let stops = [];
        let i0 = 0;
        if (len(a) > 0) {
            let first = trim(lower(a[0]));
            if (endsWith(first, "deg")) { angle = angleRad(first); i0 = 1; }
            else { if (startsWith(first, "to ")) { angle = gradDir(first); i0 = 1; }
            else { if (startsWith(first, "from ")) { start = angleRad(trim(substring(a[0], 5, len(a[0])))); i0 = 1; }
            else { if (startsWith(first, "at ")) { i0 = 1; } } } }
        }
        for (let i = i0; i < len(a); i++) {
            let toks = cssTokens(trim(a[i]));
            if (len(toks) > 0) {
                push(colors, parseColor(toks[0], cur));
                if (len(toks) > 1) { let st = toks[1]; if (endsWith(st, "%")) { push(stops, num(substring(st, 0, len(st) - 1)) / 100.0); } else { push(stops, -1.0); } }
                else { push(stops, -1.0); }
            }
        }
        // Even-space any unspecified stops.
        for (let i = 0; i < len(stops); i++) { if (stops[i] < 0.0) { if (len(colors) > 1) { stops[i] = num(i) / (len(colors) - 1.0); } else { stops[i] = 0.0; } } }
        let dx = cos(angle - 1.5708); let dy = sin(angle - 1.5708);
        return { type: kind, colors: colors, stops: stops, angle: angle, start: start,
            begin: [0.5 - dx * 0.5, 0.5 - dy * 0.5], end: [0.5 + dx * 0.5, 0.5 + dy * 0.5] };
    }
function gradDir(s) {
        if (contains(s, "right")) { if (contains(s, "top")) { return 0.785; } if (contains(s, "bottom")) { return 2.356; } return 1.5708; }
        if (contains(s, "left")) { if (contains(s, "top")) { return -0.785; } if (contains(s, "bottom")) { return -2.356; } return -1.5708; }
        if (contains(s, "top")) { return 0.0; }
        return 3.14159;
    }
    // Parse a `box-shadow` list into [{x,y,blur,spread,color,inset}].
function cssShadows(v, cur) {
        if (isNull(v)) { return []; } if (typeOf(v) != "string") { return []; }
        if (trim(lower(v)) == "none") { return []; }
        let parts = cssSplitTop(v, ","); let out = [];
        for (let i = 0; i < len(parts); i++) {
            let toks = cssTokens(parts[i]); let inset = 0.0; let nums = []; let col = cur;
            for (let j = 0; j < len(toks); j++) {
                let t = toks[j];
                if (lower(t) == "inset") { inset = 1.0; }
                else { let pl = parseLen(t, 16.0, VPGLOBAL); if (pl.k == "px") { push(nums, pl.v); } else { col = parseColor(t, cur); } }
            }
            let x = 0.0; let y = 0.0; let bl = 0.0; let sp = 0.0;
            if (len(nums) > 0) { x = nums[0]; } if (len(nums) > 1) { y = nums[1]; }
            if (len(nums) > 2) { bl = nums[2]; } if (len(nums) > 3) { sp = nums[3]; }
            push(out, { x: x, y: y, blur: bl, spread: sp, color: col, inset: inset });
        }
        return out;
    }
    // Parse a `transform` value into an ordered op list.
function cssTransform(v, fontPx, vp) {
        if (isNull(v)) { return []; } if (typeOf(v) != "string") { return []; }
        if (trim(lower(v)) == "none") { return []; }
        let fns = cssTokens(v); let ops = [];
        for (let i = 0; i < len(fns); i++) {
            let f = fns[i]; let name = lower(substring(f, 0, indexOf(f, "("))); let a = cssArgs(f);
            if (name == "translate") { let tx = usedLen(parseLen(a[0], fontPx, vp), 0.0, 0.0); let ty = 0.0; if (len(a) > 1) { ty = usedLen(parseLen(a[1], fontPx, vp), 0.0, 0.0); } push(ops, { t: "tr", x: tx, y: ty }); }
            if (name == "translatex") { push(ops, { t: "tr", x: usedLen(parseLen(a[0], fontPx, vp), 0.0, 0.0), y: 0.0 }); }
            if (name == "translatey") { push(ops, { t: "tr", x: 0.0, y: usedLen(parseLen(a[0], fontPx, vp), 0.0, 0.0) }); }
            if (name == "scale") { let sx = num(a[0]); let sy = sx; if (len(a) > 1) { sy = num(a[1]); } push(ops, { t: "sc", x: sx, y: sy }); }
            if (name == "scalex") { push(ops, { t: "sc", x: num(a[0]), y: 1.0 }); }
            if (name == "scaley") { push(ops, { t: "sc", x: 1.0, y: num(a[0]) }); }
            if (name == "rotate") { push(ops, { t: "rot", a: angleRad(a[0]) }); }
            if (name == "skew") { let kx = angleRad(a[0]); let ky = 0.0; if (len(a) > 1) { ky = angleRad(a[1]); } push(ops, { t: "sk", x: kx, y: ky }); }
            if (name == "skewx") { push(ops, { t: "sk", x: angleRad(a[0]), y: 0.0 }); }
            if (name == "skewy") { push(ops, { t: "sk", x: 0.0, y: angleRad(a[0]) }); }
        }
        return ops;
    }
    // Parse a `text-shadow` list into [{x,y,blur,color}] (physical-px-agnostic;
    // offsets/blur are CSS px, scaled at paint time).
function cssTextShadows(v, cur) {
        if (isNull(v)) { return []; } if (typeOf(v) != "string") { return []; }
        if (trim(lower(v)) == "none") { return []; }
        let parts = cssSplitTop(v, ","); let out = [];
        for (let i = 0; i < len(parts); i++) {
            let toks = cssTokens(parts[i]); let nums = []; let col = cur;
            for (let j = 0; j < len(toks); j++) {
                let t = toks[j]; let pl = parseLen(t, 16.0, VPGLOBAL);
                if (pl.k == "px") { push(nums, pl.v); } else { col = parseColor(t, cur); }
            }
            let x = 0.0; let y = 0.0; let bl = 0.0;
            if (len(nums) > 0) { x = nums[0]; } if (len(nums) > 1) { y = nums[1]; } if (len(nums) > 2) { bl = nums[2]; }
            push(out, { x: x, y: y, blur: bl, color: col });
        }
        return out;
    }
function cssTransitions(v) {
        if (isNull(v)) { return []; } if (typeOf(v) != "string") { return []; }
        let parts = cssSplitTop(v, ","); let out = [];
        for (let i = 0; i < len(parts); i++) {
            let toks = cssTokens(parts[i]); let prop = "all"; let dur = 0.0; let delay = 0.0; let nd = 0;
            for (let j = 0; j < len(toks); j++) {
                let t = toks[j];
                if (endsWith(lower(t), "s")) { if (nd == 0) { dur = durMs(t); nd = 1; } else { delay = durMs(t); } }
                else { if (j == 0) { prop = lower(t); } }
            }
            push(out, { prop: prop, dur: dur, delay: delay });
        }
        return out;
}

// A global viewport handle so the shadow/length parsers can resolve viewport
// units without threading `vp` everywhere; set by the runtime each frame.
let VPGLOBAL = new Viewport();

// Build the computed style for one element from its normalised declaration `st`,
// the parent inherited context `inh`, and the viewport `vp`. Absolute lengths
// fold to CSS px; %/auto stay tokens. Returns the computed style, including the
// `childInh` context the element's children inherit.
function computeStyle(st, inh, vp) {
    let cs = {};
    // --- inherited text/font context -----------------------------------------
    let col = inh.color;
    if (has(st, "color")) { col = parseColor(st.color, inh.color); }
    cs.color = col;
    let fontPx = inh.fontPx;
    if (has(st, "fontSize")) { let t = parseLen(st.fontSize, inh.fontPx, vp); fontPx = usedLen(t, inh.fontPx, inh.fontPx); }
    cs.fontPx = fontPx;
    cs.fontWeight = parseWeight(sv(st, "fontWeight"), inh.fontWeight);
    cs.fontStyle = svdef(st, "fontStyle", inh.fontStyle);
    cs.fontFamily = svdef(st, "fontFamily", "");
    let lh = inh.lineHeight; let lhPx = inh.lineHeight * fontPx;
    if (has(st, "lineHeight")) {
        let v = st.lineHeight;
        if (isNum(v) > 0.5) { lh = v; lhPx = v * fontPx; }
        else { let lv = lower(trim(v)); if (lv == "normal") { lh = 1.2; lhPx = 1.2 * fontPx; }
            else { let t = parseLen(v, fontPx, vp); if (t.k == "px") { lhPx = t.v; lh = t.v / fontPx; } else { if (t.k == "pct") { lhPx = t.v * fontPx; lh = t.v; } else { lh = num(v); lhPx = lh * fontPx; } } } }
    }
    cs.lineHeight = lh; cs.lineHeightPx = lhPx;
    cs.textAlign = svdef(st, "textAlign", inh.textAlign);
    cs.textTransform = svdef(st, "textTransform", inh.textTransform);
    cs.whiteSpace = svdef(st, "whiteSpace", inh.whiteSpace);
    cs.visibility = svdef(st, "visibility", inh.visibility);
    cs.listStyleType = svdef(st, "listStyleType", inh.listStyleType);
    cs.cursor = svdef(st, "cursor", inh.cursor);
    cs.letterSpacing = 0.0;
    if (has(st, "letterSpacing")) { let t = parseLen(st.letterSpacing, fontPx, vp); cs.letterSpacing = usedLen(t, 0.0, 0.0); } else { cs.letterSpacing = inh.letterSpacing; }
    let inhDeco = "none"; if (has(inh, "textDecoration")) { inhDeco = inh.textDecoration; }
    cs.textDecoration = svdef(st, "textDecoration", inhDeco);

    // --- box / display --------------------------------------------------------
    cs.display = lower(svdef(st, "display", "block"));
    cs.position = lower(svdef(st, "position", "static"));
    cs.boxSizing = lower(svdef(st, "boxSizing", "content-box"));
    cs.float = lower(svdef(st, "float", "none"));
    cs.clear = lower(svdef(st, "clear", "none"));
    cs.overflowX = lower(svdef(st, "overflowX", svdef(st, "overflow", "visible")));
    cs.overflowY = lower(svdef(st, "overflowY", svdef(st, "overflow", "visible")));
    cs.opacity = 1.0; if (has(st, "opacity")) { cs.opacity = num(st.opacity); }
    cs.zIndex = 0.0; cs.hasZ = 0.0; if (has(st, "zIndex")) { let z = st.zIndex; if (lower(concat("", z)) != "auto") { cs.zIndex = num(z); cs.hasZ = 1.0; } }
    cs.pointerEvents = lower(svdef(st, "pointerEvents", "auto"));

    // --- sizing tokens --------------------------------------------------------
    cs.width = parseLen(svdef(st, "width", "auto"), fontPx, vp);
    cs.height = parseLen(svdef(st, "height", "auto"), fontPx, vp);
    cs.minWidth = parseLen(svdef(st, "minWidth", "0"), fontPx, vp);
    cs.maxWidth = parseLen(svdef(st, "maxWidth", "none"), fontPx, vp);
    cs.minHeight = parseLen(svdef(st, "minHeight", "0"), fontPx, vp);
    cs.maxHeight = parseLen(svdef(st, "maxHeight", "none"), fontPx, vp);

    // --- margin / padding (shorthand + longhand, tokens) ----------------------
    let mt = parseLen("0", fontPx, vp);
    let m = { t: mt, r: mt, b: mt, l: mt };
    if (has(st, "margin")) { let bx = box4(cssTokens(concat("", st.margin))); m = { t: parseLen(bx.t, fontPx, vp), r: parseLen(bx.r, fontPx, vp), b: parseLen(bx.b, fontPx, vp), l: parseLen(bx.l, fontPx, vp) }; }
    if (has(st, "marginTop")) { m.t = parseLen(st.marginTop, fontPx, vp); }
    if (has(st, "marginRight")) { m.r = parseLen(st.marginRight, fontPx, vp); }
    if (has(st, "marginBottom")) { m.b = parseLen(st.marginBottom, fontPx, vp); }
    if (has(st, "marginLeft")) { m.l = parseLen(st.marginLeft, fontPx, vp); }
    cs.m = m;
    let p = { t: mt, r: mt, b: mt, l: mt };
    if (has(st, "padding")) { let bx = box4(cssTokens(concat("", st.padding))); p = { t: parseLen(bx.t, fontPx, vp), r: parseLen(bx.r, fontPx, vp), b: parseLen(bx.b, fontPx, vp), l: parseLen(bx.l, fontPx, vp) }; }
    if (has(st, "paddingTop")) { p.t = parseLen(st.paddingTop, fontPx, vp); }
    if (has(st, "paddingRight")) { p.r = parseLen(st.paddingRight, fontPx, vp); }
    if (has(st, "paddingBottom")) { p.b = parseLen(st.paddingBottom, fontPx, vp); }
    if (has(st, "paddingLeft")) { p.l = parseLen(st.paddingLeft, fontPx, vp); }
    cs.p = p;

    // --- borders --------------------------------------------------------------
    cs.bw = { t: 0.0, r: 0.0, b: 0.0, l: 0.0 };
    cs.bs = { t: "none", r: "none", b: "none", l: "none" };
    cs.bc = { t: col, r: col, b: col, l: col };
    if (has(st, "border")) { applyBorderShorthand(cs, "all", st.border, col, fontPx, vp); }
    if (has(st, "borderTop")) { applyBorderShorthand(cs, "t", st.borderTop, col, fontPx, vp); }
    if (has(st, "borderRight")) { applyBorderShorthand(cs, "r", st.borderRight, col, fontPx, vp); }
    if (has(st, "borderBottom")) { applyBorderShorthand(cs, "b", st.borderBottom, col, fontPx, vp); }
    if (has(st, "borderLeft")) { applyBorderShorthand(cs, "l", st.borderLeft, col, fontPx, vp); }
    if (has(st, "borderWidth")) { let bx = box4(cssTokens(concat("", st.borderWidth))); cs.bw = { t: bwPx(bx.t, fontPx, vp), r: bwPx(bx.r, fontPx, vp), b: bwPx(bx.b, fontPx, vp), l: bwPx(bx.l, fontPx, vp) }; }
    if (has(st, "borderColor")) { let bc = parseColor(st.borderColor, col); cs.bc = { t: bc, r: bc, b: bc, l: bc }; }
    if (has(st, "borderStyle")) { let s = lower(concat("", st.borderStyle)); cs.bs = { t: s, r: s, b: s, l: s }; }
    if (has(st, "borderTopWidth")) { cs.bw.t = bwPx(st.borderTopWidth, fontPx, vp); }
    if (has(st, "borderRightWidth")) { cs.bw.r = bwPx(st.borderRightWidth, fontPx, vp); }
    if (has(st, "borderBottomWidth")) { cs.bw.b = bwPx(st.borderBottomWidth, fontPx, vp); }
    if (has(st, "borderLeftWidth")) { cs.bw.l = bwPx(st.borderLeftWidth, fontPx, vp); }
    if (has(st, "borderTopColor")) { cs.bc.t = parseColor(st.borderTopColor, col); }
    if (has(st, "borderBottomColor")) { cs.bc.b = parseColor(st.borderBottomColor, col); }
    if (has(st, "borderLeftColor")) { cs.bc.l = parseColor(st.borderLeftColor, col); }
    if (has(st, "borderRightColor")) { cs.bc.r = parseColor(st.borderRightColor, col); }

    // border-radius (1..4 corners; px/%/em tokens). Slash (elliptical) -> x radius.
    let zr = parseLen("0", fontPx, vp);
    cs.radius = { tl: zr, tr: zr, br: zr, bl: zr };
    if (has(st, "borderRadius")) { let rs = concat("", st.borderRadius); if (contains(rs, "/")) { rs = trim(split(rs, "/")[0]); } let bx = box4Corners(cssTokens(rs)); cs.radius = { tl: parseLen(bx.tl, fontPx, vp), tr: parseLen(bx.tr, fontPx, vp), br: parseLen(bx.br, fontPx, vp), bl: parseLen(bx.bl, fontPx, vp) }; }
    if (has(st, "borderTopLeftRadius")) { cs.radius.tl = parseLen(st.borderTopLeftRadius, fontPx, vp); }
    if (has(st, "borderTopRightRadius")) { cs.radius.tr = parseLen(st.borderTopRightRadius, fontPx, vp); }
    if (has(st, "borderBottomRightRadius")) { cs.radius.br = parseLen(st.borderBottomRightRadius, fontPx, vp); }
    if (has(st, "borderBottomLeftRadius")) { cs.radius.bl = parseLen(st.borderBottomLeftRadius, fontPx, vp); }

    // --- background -----------------------------------------------------------
    cs.bgColor = CLEAR; cs.bgGradient = 0;
    if (has(st, "background")) { let b = concat("", st.background); if (contains(lower(b), "gradient(")) { cs.bgGradient = cssGradient(b, col); } else { cs.bgColor = parseColor(b, col); } }
    if (has(st, "backgroundColor")) { cs.bgColor = parseColor(st.backgroundColor, col); }
    if (has(st, "backgroundImage")) { let b = concat("", st.backgroundImage); if (contains(lower(b), "gradient(")) { cs.bgGradient = cssGradient(b, col); } }

    // --- effects --------------------------------------------------------------
    cs.boxShadow = cssShadows(sv(st, "boxShadow"), col);
    let inhTsh = []; if (has(inh, "textShadow")) { inhTsh = inh.textShadow; }
    if (has(st, "textShadow")) { cs.textShadow = cssTextShadows(st.textShadow, col); } else { cs.textShadow = inhTsh; }
    cs.transform = cssTransform(sv(st, "transform"), fontPx, vp);
    cs.transformOrigin = svdef(st, "transformOrigin", "center");
    cs.transition = cssTransitions(sv(st, "transition"));
    cs.outline = 0;
    if (has(st, "outline")) { let o = computeOutline(st.outline, col, fontPx, vp); cs.outline = o; }

    // --- flexbox --------------------------------------------------------------
    cs.flexDirection = lower(svdef(st, "flexDirection", "row"));
    cs.flexWrap = lower(svdef(st, "flexWrap", "nowrap"));
    cs.justifyContent = lower(svdef(st, "justifyContent", "flex-start"));
    cs.alignItems = lower(svdef(st, "alignItems", "stretch"));
    cs.alignContent = lower(svdef(st, "alignContent", "stretch"));
    cs.alignSelf = lower(svdef(st, "alignSelf", "auto"));
    cs.flexGrow = 0.0; cs.flexShrink = 1.0; cs.flexBasis = parseLen("auto", fontPx, vp);
    if (has(st, "flex")) { applyFlexShorthand(cs, st.flex, fontPx, vp); }
    if (has(st, "flexGrow")) { cs.flexGrow = num(st.flexGrow); }
    if (has(st, "flexShrink")) { cs.flexShrink = num(st.flexShrink); }
    if (has(st, "flexBasis")) { cs.flexBasis = parseLen(st.flexBasis, fontPx, vp); }
    cs.order = 0.0; if (has(st, "order")) { cs.order = num(st.order); }

    // --- gap (flex + grid) ----------------------------------------------------
    cs.rowGap = 0.0; cs.colGap = 0.0;
    if (has(st, "gap")) { let g = cssTokens(concat("", st.gap)); cs.rowGap = usedLen(parseLen(g[0], fontPx, vp), 0.0, 0.0); cs.colGap = cs.rowGap; if (len(g) > 1) { cs.colGap = usedLen(parseLen(g[1], fontPx, vp), 0.0, 0.0); } }
    if (has(st, "rowGap")) { cs.rowGap = usedLen(parseLen(st.rowGap, fontPx, vp), 0.0, 0.0); }
    if (has(st, "columnGap")) { cs.colGap = usedLen(parseLen(st.columnGap, fontPx, vp), 0.0, 0.0); }

    // --- grid -----------------------------------------------------------------
    cs.gridCols = 0; cs.gridRows = 0;
    if (has(st, "gridTemplateColumns")) { cs.gridCols = parseTracks(concat("", st.gridTemplateColumns), fontPx, vp); }
    if (has(st, "gridTemplateRows")) { cs.gridRows = parseTracks(concat("", st.gridTemplateRows), fontPx, vp); }
    cs.gridAutoFlow = lower(svdef(st, "gridAutoFlow", "row"));

    // --- positioned insets ----------------------------------------------------
    cs.top = parseLen(svdef(st, "top", "auto"), fontPx, vp);
    cs.right = parseLen(svdef(st, "right", "auto"), fontPx, vp);
    cs.bottom = parseLen(svdef(st, "bottom", "auto"), fontPx, vp);
    cs.left = parseLen(svdef(st, "left", "auto"), fontPx, vp);

    // --- the context children inherit ----------------------------------------
    cs.childInh = { color: col, fontPx: fontPx, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
        lineHeight: lh, textAlign: cs.textAlign, whiteSpace: cs.whiteSpace, textTransform: cs.textTransform,
        letterSpacing: cs.letterSpacing, visibility: cs.visibility, listStyleType: cs.listStyleType, cursor: cs.cursor,
        textDecoration: cs.textDecoration, textShadow: cs.textShadow };
    return cs;
}

function bwPx(v, fontPx, vp) {
    let s = lower(trim(concat("", v)));
    if (s == "thin") { return 1.0; } if (s == "medium") { return 3.0; } if (s == "thick") { return 5.0; }
    let t = parseLen(v, fontPx, vp); return usedLen(t, 0.0, 0.0);
}
function box4Corners(toks) {
    let n = len(toks);
    if (n == 1) { return { tl: toks[0], tr: toks[0], br: toks[0], bl: toks[0] }; }
    if (n == 2) { return { tl: toks[0], tr: toks[1], br: toks[0], bl: toks[1] }; }
    if (n == 3) { return { tl: toks[0], tr: toks[1], br: toks[2], bl: toks[1] }; }
    return { tl: toks[0], tr: toks[1], br: toks[2], bl: toks[3] };
}
// border shorthand: <width> <style> <color> in any order.
function applyBorderShorthand(cs, side, v, cur, fontPx, vp) {
    let toks = cssTokens(concat("", v)); let w = 3.0; let style = "solid"; let color = cur; let gotW = 0.0;
    let styles = { none: 1, hidden: 1, solid: 1, dashed: 1, dotted: 1, double: 1, groove: 1, ridge: 1, inset: 1, outset: 1 };
    for (let i = 0; i < len(toks); i++) {
        let t = toks[i]; let lt = lower(t);
        if (has(styles, lt)) { style = lt; }
        else { let pl = parseLen(t, fontPx, vp); if (pl.k == "px") { w = bwPx(t, fontPx, vp); gotW = 1.0; } else { if (lt == "thin") { w = 1.0; gotW = 1.0; } else { if (lt == "medium") { w = 3.0; gotW = 1.0; } else { if (lt == "thick") { w = 5.0; gotW = 1.0; } else { color = parseColor(t, cur); } } } } }
    }
    if (style == "none") { w = 0.0; } if (style == "hidden") { w = 0.0; }
    let sides = [side]; if (side == "all") { sides = ["t", "r", "b", "l"]; }
    for (let i = 0; i < len(sides); i++) { let s = sides[i]; cs.bw[s] = w; cs.bs[s] = style; cs.bc[s] = color; }
}
function computeOutline(v, cur, fontPx, vp) {
    let toks = cssTokens(concat("", v)); let w = 3.0; let color = cur; let style = "solid";
    let styles = { none: 1, solid: 1, dashed: 1, dotted: 1, double: 1 };
    for (let i = 0; i < len(toks); i++) { let t = toks[i]; let lt = lower(t); if (has(styles, lt)) { style = lt; } else { let pl = parseLen(t, fontPx, vp); if (pl.k == "px") { w = pl.v; } else { color = parseColor(t, cur); } } }
    return { w: w, style: style, color: color };
}
function applyFlexShorthand(cs, v, fontPx, vp) {
    let s = lower(trim(concat("", v)));
    if (s == "none") { cs.flexGrow = 0.0; cs.flexShrink = 0.0; cs.flexBasis = parseLen("auto", fontPx, vp); return 0; }
    if (s == "auto") { cs.flexGrow = 1.0; cs.flexShrink = 1.0; cs.flexBasis = parseLen("auto", fontPx, vp); return 0; }
    let toks = cssTokens(s); let ni = 0;
    cs.flexGrow = 1.0; cs.flexShrink = 1.0; cs.flexBasis = parseLen("0", fontPx, vp);
    for (let i = 0; i < len(toks); i++) {
        let t = toks[i]; let pl = parseLen(t, fontPx, vp);
        if (pl.k == "px") { if (ni == 0) { cs.flexGrow = pl.v; ni = 1; } else { if (ni == 1) { cs.flexShrink = pl.v; ni = 2; } } }
        else { cs.flexBasis = pl; }
    }
    return 0;
}
// Parse grid track list (px, fr, %, repeat(n, track)) -> [{fr} | {px} | {pct}].
function parseTracks(v, fontPx, vp) {
    let toks = cssTokens(v); let out = [];
    for (let i = 0; i < len(toks); i++) {
        let t = toks[i]; let lt = lower(t);
        if (startsWith(lt, "repeat(")) {
            let a = cssArgs(t); let cnt = floor(num(a[0]));
            for (let r = 0; r < cnt; r++) { for (let j = 1; j < len(a); j++) { push(out, oneTrack(a[j], fontPx, vp)); } }
        } else { push(out, oneTrack(t, fontPx, vp)); }
    }
    return out;
}
function oneTrack(t, fontPx, vp) {
    let lt = lower(trim(t));
    if (endsWith(lt, "fr")) { return { fr: num(substring(lt, 0, len(lt) - 2)) }; }
    if (lt == "auto") { return { fr: 1.0 }; }
    let pl = parseLen(t, fontPx, vp); if (pl.k == "pct") { return { pct: pl.v }; } return { px: usedLen(pl, 0.0, 0.0) };
}
