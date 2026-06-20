// Elpa Liquid Glass — a feature-rich calculator, in JavaScript.
//
// It uses the Liquid Glass SDK (linked ahead of this file) as a pure black box:
// it declares state, composes a glass widget tree, and never touches the GPU. The
// app is two halves:
//
//   1. A self-contained expression engine — a tokenizer, a shunting-yard parser
//      (precedence, right-assoc power, unary minus, parentheses, functions) and an
//      RPN evaluator — plus a number formatter. No `eval`, no host calls; pure VM
//      arithmetic over the standard library (sin/cos/ln/sqrt/pow/factorial/…).
//   2. A responsive glass UI — a glass display card with a live running result, a
//      BASIC/SCIENTIFIC mode switch, DEG/RAD + theme chips, a scientific function
//      block, a four-column keypad laid out with `Row`+`Expanded` so the keys fill
//      the width evenly at every size class, memory keys, and a tap-to-recall
//      history card. The whole thing scrolls if a small screen can't fit it.

// ============================================================================
//  Expression engine (pure functions — no widgets, no state)
// ============================================================================

// Digit chars → their value; letters → membership; function names → membership.
let CALC_DIGITS = { "0": 0.0, "1": 1.0, "2": 2.0, "3": 3.0, "4": 4.0, "5": 5.0, "6": 6.0, "7": 7.0, "8": 8.0, "9": 9.0 };
let CALC_LETTERS = { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1, I: 1, J: 1, K: 1, L: 1, M: 1, N: 1, O: 1, P: 1, Q: 1, R: 1, S: 1, T: 1, U: 1, V: 1, W: 1, X: 1, Y: 1, Z: 1 };
let CALC_FUNCS = { SIN: 1, COS: 1, TAN: 1, ASIN: 1, ACOS: 1, ATAN: 1, LN: 1, LOG: 1, SQRT: 1, EXP: 1, ABS: 1 };

function isOpCh(c) {
    if (c == "+") { return 1.0; } if (c == "-") { return 1.0; } if (c == "*") { return 1.0; }
    if (c == "/") { return 1.0; } if (c == "^") { return 1.0; } if (c == "%") { return 1.0; }
    return 0.0;
}

// Lex `s` (already upper-cased) into a flat token list. Returns { ok, toks }.
function calcTokenize(s) {
    let toks = []; let i = 0; let n = len(s);
    while (i < n) {
        let c = charAt(s, i); let handled = 0.0;
        if (c == " ") { i = i + 1; handled = 1.0; }
        if (handled < 0.5) { if (has(CALC_DIGITS, c)) {
            // A number with an optional single decimal point.
            let val = 0.0; let seenDot = 0.0; let frac = 0.1; let go = 1.0;
            while (go > 0.5) {
                if (i >= n) { go = 0.0; }
                else {
                    let d = charAt(s, i);
                    if (has(CALC_DIGITS, d)) {
                        if (seenDot < 0.5) { val = val * 10.0 + CALC_DIGITS[d]; }
                        else { val = val + CALC_DIGITS[d] * frac; frac = frac / 10.0; }
                        i = i + 1;
                    } else { if (d == ".") {
                        if (seenDot > 0.5) { return { ok: 0.0, toks: toks }; }
                        seenDot = 1.0; i = i + 1;
                    } else { go = 0.0; } }
                }
            }
            push(toks, { t: "num", v: val }); handled = 1.0;
        } }
        if (handled < 0.5) { if (c == ".") {
            // A leading-dot number like `.5`.
            let val = 0.0; let frac = 0.1; let any = 0.0; let go = 1.0; i = i + 1;
            while (go > 0.5) {
                if (i >= n) { go = 0.0; }
                else { let d = charAt(s, i); if (has(CALC_DIGITS, d)) { val = val + CALC_DIGITS[d] * frac; frac = frac / 10.0; any = 1.0; i = i + 1; } else { go = 0.0; } }
            }
            if (any < 0.5) { return { ok: 0.0, toks: toks }; }
            push(toks, { t: "num", v: val }); handled = 1.0;
        } }
        if (handled < 0.5) { if (has(CALC_LETTERS, c)) {
            // An identifier: a constant (PI / E) or a function name.
            let name = ""; let go = 1.0;
            while (go > 0.5) { if (i >= n) { go = 0.0; } else { let d = charAt(s, i); if (has(CALC_LETTERS, d)) { name = concat(name, d); i = i + 1; } else { go = 0.0; } } }
            if (name == "PI") { push(toks, { t: "num", v: 3.141592653589793 }); }
            else { if (name == "E") { push(toks, { t: "num", v: 2.718281828459045 }); }
            else { if (has(CALC_FUNCS, name)) { push(toks, { t: "fn", v: name }); }
            else { return { ok: 0.0, toks: toks }; } } }
            handled = 1.0;
        } }
        if (handled < 0.5) { if (c == "(") { push(toks, { t: "lp" }); i = i + 1; handled = 1.0; } }
        if (handled < 0.5) { if (c == ")") { push(toks, { t: "rp" }); i = i + 1; handled = 1.0; } }
        if (handled < 0.5) { if (c == "!") { push(toks, { t: "fact" }); i = i + 1; handled = 1.0; } }
        if (handled < 0.5) { if (isOpCh(c) > 0.5) { push(toks, { t: "op", v: c }); i = i + 1; handled = 1.0; } }
        if (handled < 0.5) { return { ok: 0.0, toks: toks }; }
    }
    return { ok: 1.0, toks: toks };
}

// Shunting-yard: token list → Reverse-Polish output. Returns { ok, rpn }.
function calcShunt(toks) {
    let out = []; let ops = []; let prev = "start";
    let precOf = (v) => {
        if (v == "+") { return 2.0; } if (v == "-") { return 2.0; }
        if (v == "*") { return 3.0; } if (v == "/") { return 3.0; } if (v == "%") { return 3.0; }
        if (v == "^") { return 4.0; } return 0.0;
    };
    let precTok = (top) => {
        if (top.t == "op") { return precOf(top.v); }
        if (top.t == "u") { return 4.0; }
        if (top.t == "fn") { return 6.0; }
        return 0.0;
    };
    let pushBin = (v) => {
        let p0 = precOf(v); let ra = 0.0; if (v == "^") { ra = 1.0; }
        let go = 1.0;
        while (go > 0.5) {
            if (len(ops) == 0) { go = 0.0; }
            else {
                let top = ops[len(ops) - 1];
                if (top.t == "lp") { go = 0.0; }
                else {
                    let pt = precTok(top); let dp = 0.0;
                    if (pt > p0) { dp = 1.0; }
                    if (pt == p0) { if (ra < 0.5) { dp = 1.0; } }
                    if (dp > 0.5) { push(out, pop(ops)); } else { go = 0.0; }
                }
            }
        }
        push(ops, { t: "op", v: v }); prev = "op";
    };
    let i = 0; let n = len(toks); let bad = 0.0;
    while (i < n) {
        let tk = toks[i]; let t = tk.t;
        if (t == "num") { push(out, tk); prev = "num"; }
        if (t == "fn") { push(ops, tk); prev = "fn"; }
        if (t == "lp") { push(ops, tk); prev = "lp"; }
        if (t == "fact") { push(out, tk); prev = "num"; }
        if (t == "rp") {
            let stop = 0.0;
            while (stop < 0.5) {
                if (len(ops) == 0) { bad = 1.0; stop = 1.0; }
                else {
                    let top = pop(ops);
                    if (top.t == "lp") { stop = 1.0; if (len(ops) > 0) { if (ops[len(ops) - 1].t == "fn") { push(out, pop(ops)); } } }
                    else { push(out, top); }
                }
            }
            prev = "num";
        }
        if (t == "op") {
            let v = tk.v; let uc = 0.0;
            if (prev == "start") { uc = 1.0; } if (prev == "op") { uc = 1.0; }
            if (prev == "lp") { uc = 1.0; } if (prev == "fn") { uc = 1.0; }
            if (v == "-") { if (uc > 0.5) { push(ops, { t: "u" }); prev = "op"; } else { pushBin("-"); } }
            else { if (v == "+") { if (uc > 0.5) { prev = "op"; } else { pushBin("+"); } } else { pushBin(v); } }
        }
        if (bad > 0.5) { i = n; } else { i = i + 1; }
    }
    if (bad > 0.5) { return { ok: 0.0, rpn: out }; }
    let stop2 = 0.0;
    while (stop2 < 0.5) {
        if (len(ops) == 0) { stop2 = 1.0; }
        else { let top = pop(ops); if (top.t == "lp") { return { ok: 0.0, rpn: out }; } push(out, top); }
    }
    return { ok: 1.0, rpn: out };
}

// Apply a unary function. Trig honours the DEG/RAD mode.
function applyFn(name, a, deg) {
    if (name == "SIN") { if (deg > 0.5) { return sin(radians(a)); } return sin(a); }
    if (name == "COS") { if (deg > 0.5) { return cos(radians(a)); } return cos(a); }
    if (name == "TAN") { if (deg > 0.5) { return tan(radians(a)); } return tan(a); }
    if (name == "ASIN") { let r = asin(a); if (deg > 0.5) { return degrees(r); } return r; }
    if (name == "ACOS") { let r = acos(a); if (deg > 0.5) { return degrees(r); } return r; }
    if (name == "ATAN") { let r = atan(a); if (deg > 0.5) { return degrees(r); } return r; }
    if (name == "LN") { return ln(a); }
    if (name == "LOG") { return log10(a); }
    if (name == "SQRT") { return sqrt(a); }
    if (name == "EXP") { return exp(a); }
    if (name == "ABS") { return abs(a); }
    return a;
}

// Apply a binary operator. Guards division / modulo by zero (→ NaN → "ERR").
function applyOp(v, a, b) {
    if (v == "+") { return a + b; }
    if (v == "-") { return a - b; }
    if (v == "*") { return a * b; }
    if (v == "/") { if (b == 0.0) { return NAN(); } return a / b; }
    if (v == "^") { return pow(a, b); }
    if (v == "%") { if (b == 0.0) { return NAN(); } return a - floor(a / b) * b; }
    return 0.0;
}

// Evaluate an RPN list. Returns { ok, val }; ok=0 on any malformed / non-finite.
function calcEvalRpn(rpn, deg) {
    let st = []; let err = 0.0; let i = 0; let n = len(rpn);
    while (i < n) {
        let tk = rpn[i]; let t = tk.t;
        if (t == "num") { push(st, tk.v); }
        if (t == "u") { if (len(st) < 1) { err = 1.0; } else { let a = pop(st); push(st, 0.0 - a); } }
        if (t == "fact") {
            if (len(st) < 1) { err = 1.0; }
            else {
                let a = pop(st); let rn = round(a);
                if (a < 0.0) { err = 1.0; }
                if (abs(rn - a) > 0.0000001) { err = 1.0; }
                if (rn > 170.0) { err = 1.0; }
                if (err < 0.5) { push(st, factorial(rn)); }
            }
        }
        if (t == "fn") { if (len(st) < 1) { err = 1.0; } else { let a = pop(st); push(st, applyFn(tk.v, a, deg)); } }
        if (t == "op") { if (len(st) < 2) { err = 1.0; } else { let b = pop(st); let a = pop(st); push(st, applyOp(tk.v, a, b)); } }
        if (err > 0.5) { i = n; } else { i = i + 1; }
    }
    if (err > 0.5) { return { ok: 0.0, val: 0.0 }; }
    if (len(st) != 1) { return { ok: 0.0, val: 0.0 }; }
    let v = st[0];
    if (isNaN(v)) { return { ok: 0.0, val: 0.0 }; }
    if (!isFinite(v)) { return { ok: 0.0, val: 0.0 }; }
    return { ok: 1.0, val: v };
}

// Parse + evaluate an expression string. Returns { ok, val }.
function evaluate(rawExpr, deg) {
    let s = upper(trim(rawExpr));
    if (len(s) == 0) { return { ok: 0.0, val: 0.0 }; }
    let tk = calcTokenize(s);
    if (tk.ok < 0.5) { return { ok: 0.0, val: 0.0 }; }
    let sh = calcShunt(tk.toks);
    if (sh.ok < 0.5) { return { ok: 0.0, val: 0.0 }; }
    return calcEvalRpn(sh.rpn, deg);
}

// ---- number formatting -------------------------------------------------------
function digCh(d) { return charAt("0123456789", d); }

function intToStr(n) {
    if (n < 1.0) { return "0"; }
    let s = ""; let nn = n; let guard = 0;
    while (nn >= 1.0) {
        if (guard > 18) { nn = 0.0; }
        else { let q = floor(nn / 10.0); let d = round(nn - q * 10.0); if (d > 9.0) { d = 9.0; } if (d < 0.0) { d = 0.0; } s = concat(digCh(d), s); nn = q; guard = guard + 1; }
    }
    return s;
}

// Format a number for the display: integer when whole, else up to 10 decimals
// with trailing zeros trimmed; non-finite → "ERR".
function fmt(x) {
    if (isNaN(x)) { return "ERR"; }
    if (!isFinite(x)) { return "ERR"; }
    let neg = 0.0; let ax = x; if (x < 0.0) { neg = 1.0; ax = 0.0 - x; }
    if (ax < 1000000.0) { if (ax > 0.0) { ax = round(ax * 10000000000.0) / 10000000000.0; } }
    let ip = floor(ax); let fp = ax - ip;
    let fs = ""; let f = fp; let guard = 0;
    while (guard < 10) {
        if (f <= 0.0000000001) { guard = 10; }
        else { f = f * 10.0; let d = floor(f + 0.000000001); if (d > 9.0) { d = 9.0; } fs = concat(fs, digCh(d)); f = f - d; guard = guard + 1; }
    }
    let strip = 0.0;
    while (strip < 0.5) { let L = len(fs); if (L == 0) { strip = 1.0; } else { if (charAt(fs, L - 1) == "0") { fs = substring(fs, 0, L - 1); } else { strip = 1.0; } } }
    let out = intToStr(ip);
    if (len(fs) > 0) { out = concat(concat(out, "."), fs); }
    if (neg > 0.5) { if (out != "0") { out = concat("-", out); } }
    return out;
}

// Keep at most the last `maxN` chars (so the most recent digits stay visible).
function clipTail(s, maxN) { let n = len(s); if (n <= maxN) { return s; } return substring(s, n - maxN, n); }

// ============================================================================
//  Application state
// ============================================================================
let dark = 0.0; let accent = 0;
let expr = "";          // the expression being typed (ASCII)
let result = "0";       // the last committed result
let justEval = 0.0;     // 1 right after "=" — the next digit starts fresh
let sci = 0.0;          // 0 BASIC, 1 SCIENTIFIC
let deg = 1.0;          // 1 DEG, 0 RAD
let memory = 0.0;       // M store
let history = [];       // [{ e, r }] most-recent-last

// The component `update` is captured here so the top-level key handlers below
// (which run outside the component closure) can request a repaint.
let gUpdate = () => {};

// Responsive layout sizes, refreshed each build from the size class.
let LW = 70.0; let LBH = 11.0; let LTS = "title"; let LFS = "label";
let DISP_W = 62.0; let SMALL_MAX = 18.0; let BIG_MAX = 15.0; let HIST_MAX = 34.0;

// ============================================================================
//  Input handlers (mutate state, then repaint)
// ============================================================================
function pressDigit(d) { if (justEval > 0.5) { expr = ""; justEval = 0.0; } expr = concat(expr, d); gUpdate(); }
function pressDot() { if (justEval > 0.5) { expr = ""; justEval = 0.0; } expr = concat(expr, "."); gUpdate(); }
function pressOp(op) { if (justEval > 0.5) { justEval = 0.0; } expr = concat(expr, op); gUpdate(); }
function pressFunc(name) { if (justEval > 0.5) { expr = ""; justEval = 0.0; } expr = concat(expr, concat(name, "(")); gUpdate(); }
function pressConst(c) { if (justEval > 0.5) { expr = ""; justEval = 0.0; } expr = concat(expr, c); gUpdate(); }
function pressParen(p) { if (justEval > 0.5) { if (p == "(") { expr = ""; } justEval = 0.0; } expr = concat(expr, p); gUpdate(); }
function backspace() { if (justEval > 0.5) { justEval = 0.0; } if (len(expr) > 0) { expr = substring(expr, 0, len(expr) - 1); } gUpdate(); }
function clearAll() { expr = ""; result = "0"; justEval = 0.0; gUpdate(); }
function equals() {
    if (len(expr) == 0) { gUpdate(); return 0; }
    let r = evaluate(expr, deg);
    if (r.ok > 0.5) { let s = fmt(r.val); push(history, { e: expr, r: s }); result = s; expr = s; justEval = 1.0; }
    else { result = "ERR"; justEval = 1.0; }
    gUpdate();
}
function negate() { let r = evaluate(expr, deg); if (r.ok > 0.5) { expr = fmt(0.0 - r.val); justEval = 0.0; } gUpdate(); }
function percent() { let r = evaluate(expr, deg); if (r.ok > 0.5) { expr = fmt(r.val / 100.0); justEval = 0.0; } gUpdate(); }
function memClear() { memory = 0.0; gUpdate(); }
function memRecall() { if (justEval > 0.5) { expr = ""; justEval = 0.0; } expr = concat(expr, fmt(memory)); gUpdate(); }
function memPlus() { let r = evaluate(expr, deg); if (r.ok > 0.5) { memory = memory + r.val; } gUpdate(); }
function memMinus() { let r = evaluate(expr, deg); if (r.ok > 0.5) { memory = memory - r.val; } gUpdate(); }

function onCalcKey(k) {
    if (has(CALC_DIGITS, k)) { pressDigit(k); }
    else { if (k == ".") { pressDot(); }
    else { if (k == "+") { pressOp("+"); }
    else { if (k == "-") { pressOp("-"); }
    else { if (k == "*") { pressOp("*"); }
    else { if (k == "/") { pressOp("/"); }
    else { if (k == "^") { pressOp("^"); }
    else { if (k == "!") { pressOp("!"); }
    else { if (k == "(") { pressParen("("); }
    else { if (k == ")") { pressParen(")"); }
    else { if (k == "%") { percent(); }
    else { if (k == "Enter") { equals(); }
    else { if (k == "=") { equals(); }
    else { if (k == "Backspace") { backspace(); }
    else { if (k == "Escape") { clearAll(); }
    else { if (k == "c") { clearAll(); }
    else { if (k == "C") { clearAll(); }
    else { if (k == "n") { negate(); }
    else { if (k == "s") { sci = 1.0 - sci; gUpdate(); }
    else { if (k == "r") { deg = 1.0 - deg; gUpdate(); }
    else { if (k == "d") { dark = 1.0 - dark; gUpdate(); }
    } } } } } } } } } } } } } } } } } } } }
}

// ============================================================================
//  Widget builders
// ============================================================================
// One keypad key: a glass (or accent-filled) rounded box with a centred label,
// wrapped in `Expanded` so a row of them shares the width evenly.
function kbtn(label, kind, onTap) {
    let inkRole = "ink"; let weight = "medium"; let tsize = LTS; let filled = 0.0;
    if (kind == "op") { inkRole = "accent"; weight = "bold"; }
    if (kind == "fn") { inkRole = "accent"; weight = "medium"; tsize = LFS; }
    if (kind == "util") { inkRole = "soft"; weight = "medium"; }
    if (kind == "mem") { inkRole = "soft"; weight = "medium"; tsize = LFS; }
    if (kind == "eq") { inkRole = "onAccent"; weight = "bold"; filled = 1.0; }
    let txt = Text(label, { size: tsize, weight: weight, ink: inkRole });
    let box = 0;
    if (filled > 0.5) { box = Container({ id: label, height: LBH, radius: 3.0, color: "primary", onTap: onTap, child: txt }); }
    else { box = Container({ id: label, height: LBH, radius: 3.0, glass: 1.0, onTap: onTap, child: txt }); }
    return Expanded({ flex: 1.0, child: box });
}

// A full-width keypad row of evenly-sized keys.
function krow(children) { return Row({ width: LW, gap: 1.6, children: children }); }

let Calc = defineComponent(function (props, update) {
    gUpdate = update;
    setTheme(dark, accent);

    // ---- responsive sizing ---------------------------------------------------
    let cmp = isCompact(); let med = isMedium();
    // A `GlassCard` pads its child by 8 units × the size-class spacing factor
    // (`m.sp`: 1.0 expanded, 1.2 medium, 1.4 compact), so subtract that from the
    // inner width to make the display card line up flush with the keypad rows.
    LW = 58.0; LBH = 9.0; SMALL_MAX = 22.0; BIG_MAX = 16.0; HIST_MAX = 40.0; DISP_W = LW - 8.0;
    if (med > 0.5) { LW = 70.0; LBH = 11.0; DISP_W = LW - 9.6; }
    if (cmp > 0.5) { LW = 86.0; LBH = 13.0; SMALL_MAX = 14.0; BIG_MAX = 11.0; HIST_MAX = 24.0; DISP_W = LW - 11.2; }

    // ---- display strings (live running result) -------------------------------
    let smallRaw = "0"; if (len(expr) > 0) { smallRaw = expr; }
    let bigRaw = result;
    if (justEval < 0.5) {
        let pv = evaluate(expr, deg);
        if (pv.ok > 0.5) { if (len(expr) > 0) { bigRaw = fmt(pv.val); } else { bigRaw = "0"; } }
        else { bigRaw = smallRaw; }
    }
    let degLabel = "RAD"; if (deg > 0.5) { degLabel = "DEG"; }
    let thmLabel = "LIGHT"; if (dark > 0.5) { thmLabel = "DARK"; }
    let statusL = degLabel; if (memory != 0.0) { statusL = concat(degLabel, "  M"); }
    let statusR = "BASIC"; if (sci > 0.5) { statusR = "SCI"; }

    let display = GlassCard({ thick: 1.0, child: Column({ width: DISP_W, cross: "end", gap: 1.4, children: [
        Row({ width: DISP_W, main: "between", children: [
            Text(statusL, { size: "caption", ink: "soft", weight: "medium" }),
            Text(statusR, { size: "caption", ink: "accent", weight: "semibold" }),
        ] }),
        Text(clipTail(smallRaw, SMALL_MAX), { size: "title", ink: "soft", weight: "medium" }),
        Text(clipTail(bigRaw, BIG_MAX), { size: "headline", weight: "bold" }),
    ] }) });

    // ---- mode + chips --------------------------------------------------------
    let controls = Row({ width: LW, main: "between", children: [
        SegmentedButton({ id: "mode", segments: ["BASIC", "SCI"], selected: sci,
            onSelect: (i) => { sci = num(i); update(); } }),
        Row({ gap: 1.6, children: [
            Chip({ id: "deg", label: degLabel, value: deg, onTap: () => { deg = 1.0 - deg; update(); } }),
            Chip({ id: "thm", label: thmLabel, value: dark, onTap: () => { dark = 1.0 - dark; update(); } }),
        ] }),
    ] });

    // ---- assemble the scrollable body ---------------------------------------
    let kids = [];
    push(kids, display);
    push(kids, controls);

    if (sci > 0.5) {
        push(kids, krow([
            kbtn("MC", "mem", memClear), kbtn("MR", "mem", memRecall),
            kbtn("M+", "mem", memPlus), kbtn("M-", "mem", memMinus),
        ]));
        push(kids, krow([
            kbtn("SIN", "fn", () => { pressFunc("SIN"); }), kbtn("COS", "fn", () => { pressFunc("COS"); }),
            kbtn("TAN", "fn", () => { pressFunc("TAN"); }), kbtn("^", "op", () => { pressOp("^"); }),
        ]));
        push(kids, krow([
            kbtn("LN", "fn", () => { pressFunc("LN"); }), kbtn("LOG", "fn", () => { pressFunc("LOG"); }),
            kbtn("SQRT", "fn", () => { pressFunc("SQRT"); }), kbtn("!", "op", () => { pressOp("!"); }),
        ]));
        push(kids, krow([
            kbtn("PI", "fn", () => { pressConst("PI"); }), kbtn("E", "fn", () => { pressConst("E"); }),
            kbtn("(", "util", () => { pressParen("("); }), kbtn(")", "util", () => { pressParen(")"); }),
        ]));
    }

    push(kids, krow([
        kbtn("AC", "util", clearAll), kbtn("DEL", "util", backspace),
        kbtn("%", "util", percent), kbtn("/", "op", () => { pressOp("/"); }),
    ]));
    push(kids, krow([
        kbtn("7", "num", () => { pressDigit("7"); }), kbtn("8", "num", () => { pressDigit("8"); }),
        kbtn("9", "num", () => { pressDigit("9"); }), kbtn("*", "op", () => { pressOp("*"); }),
    ]));
    push(kids, krow([
        kbtn("4", "num", () => { pressDigit("4"); }), kbtn("5", "num", () => { pressDigit("5"); }),
        kbtn("6", "num", () => { pressDigit("6"); }), kbtn("-", "op", () => { pressOp("-"); }),
    ]));
    push(kids, krow([
        kbtn("1", "num", () => { pressDigit("1"); }), kbtn("2", "num", () => { pressDigit("2"); }),
        kbtn("3", "num", () => { pressDigit("3"); }), kbtn("+", "op", () => { pressOp("+"); }),
    ]));
    push(kids, krow([
        kbtn("NEG", "util", negate), kbtn("0", "num", () => { pressDigit("0"); }),
        kbtn(".", "num", pressDot), kbtn("=", "eq", equals),
    ]));

    if (len(history) > 0) {
        let hk = []; let hn = len(history); let starti = hn - 4; if (starti < 0) { starti = 0; }
        for (let i = hn - 1; i >= starti; i = i - 1) {
            let it = history[i];
            let line = concat(concat(it.e, " = "), it.r);
            push(hk, Container({ id: concat("h", str(i)), width: DISP_W, height: 6.0, radius: 2.0,
                onTap: () => { expr = it.r; result = it.r; justEval = 0.0; update(); },
                child: Text(clipTail(line, HIST_MAX), { size: "caption", ink: "soft" }) }));
        }
        push(kids, GlassCard({ child: Column({ width: DISP_W, cross: "end", gap: 0.8, children: hk }) }));
    }

    push(kids, SizedBox({ height: 4.0 }));

    return Scaffold({
        onKey: onCalcKey,
        appBar: AppBar({ title: "CALCULATOR",
            onMenu: () => { dark = 1.0 - dark; update(); },
            actionIcon: "settings", onAction: () => { accent = accent + 1; if (accent > 3) { accent = 0; } update(); } }),
        body: ListView({ id: "calc", glass: 0.0, width: LW, gap: 1.6, children: kids }),
    });
});

runApp(Calc);
