// Elpa idiomatic-TS runtime prelude.
//
// The Elpian VM runs a practical JavaScript *subset*: it has the stdlib globals
// (`len`, `push`, `concat`, `str`, …) but not the JS Array/String *methods*
// (`.map`, `.filter`, …) that idiomatic TypeScript leans on. The create-elpa-app
// transpiler rewrites those method calls into plain calls — `xs.map(f)` becomes
// `map(xs, f)` — and this prelude, prepended to every bundle, supplies the
// implementations in pure VM-subset JS. Everything here is defined with the
// primitives the VM does have (`len`, `push`, `range`, closures, `while`).

// ---- array higher-order helpers --------------------------------------------
function map(xs, f) {
    let out = []; let n = len(xs); let i = 0;
    while (i < n) { push(out, f(xs[i], i)); i = i + 1; }
    return out;
}
function filter(xs, f) {
    let out = []; let n = len(xs); let i = 0;
    while (i < n) { if (f(xs[i], i)) { push(out, xs[i]); } i = i + 1; }
    return out;
}
function forEach(xs, f) {
    let n = len(xs); let i = 0;
    while (i < n) { f(xs[i], i); i = i + 1; }
    return 0;
}
function reduce(xs, f, init) {
    let n = len(xs); let i = 0; let acc = init;
    // Support the no-initial-value form `xs.reduce(f)` (seed with the first item).
    if (isNull(init)) { if (n > 0) { acc = xs[0]; i = 1; } }
    while (i < n) { acc = f(acc, xs[i], i); i = i + 1; }
    return acc;
}
function find(xs, f) {
    let n = len(xs); let i = 0;
    while (i < n) { if (f(xs[i], i)) { return xs[i]; } i = i + 1; }
    return 0;
}
function findIndex(xs, f) {
    let n = len(xs); let i = 0;
    while (i < n) { if (f(xs[i], i)) { return i; } i = i + 1; }
    return 0 - 1;
}
function some(xs, f) {
    let n = len(xs); let i = 0;
    while (i < n) { if (f(xs[i], i)) { return true; } i = i + 1; }
    return false;
}
function every(xs, f) {
    let n = len(xs); let i = 0;
    while (i < n) { if (!f(xs[i], i)) { return false; } i = i + 1; }
    return true;
}
function flat(xs) {
    let out = []; let n = len(xs); let i = 0;
    while (i < n) {
        let v = xs[i];
        if (typeOf(v) == "array") { let m = len(v); let j = 0; while (j < m) { push(out, v[j]); j = j + 1; } }
        else { push(out, v); }
        i = i + 1;
    }
    return out;
}

function __at(xs, i) {
    let n = len(xs);
    if (i < 0) { i = n + i; }
    if (i < 0) { return 0; }
    if (i >= n) { return 0; }
    return xs[i];
}
function __flatMap(xs, f) {
    let out = []; let n = len(xs); let i = 0;
    while (i < n) {
        let v = f(xs[i], i);
        if (typeOf(v) == "array") { let m = len(v); let j = 0; while (j < m) { push(out, v[j]); j = j + 1; } }
        else { push(out, v); }
        i = i + 1;
    }
    return out;
}
function __lastIndexOf(xs, v) {
    let i = len(xs) - 1;
    while (i >= 0) { if (xs[i] == v) { return i; } i = i - 1; }
    return 0 - 1;
}
function __findLast(xs, f) {
    let i = len(xs) - 1;
    while (i >= 0) { if (f(xs[i], i)) { return xs[i]; } i = i - 1; }
    return 0;
}
// Array.from(x): a shallow copy for arrays; the characters for a string.
function __from(x) {
    let out = [];
    if (typeOf(x) == "string") {
        let n = len(x); let i = 0; while (i < n) { push(out, charAt(x, i)); i = i + 1; }
        return out;
    }
    let n = len(x); let i = 0; while (i < n) { push(out, x[i]); i = i + 1; }
    return out;
}
// In-place splice(start, deleteCount, ...items) → returns the removed slice.
function __splice(xs, start, count) {
    let n = len(xs);
    if (isNull(start)) { start = 0; }
    if (start < 0) { start = n + start; if (start < 0) { start = 0; } }
    if (isNull(count)) { count = n - start; }
    if (count < 0) { count = 0; }
    if (start + count > n) { count = n - start; }
    let removed = []; let k = 0;
    while (k < count) { push(removed, xs[start + k]); k = k + 1; }
    // Shift the tail left over the removed window, then pop the surplus.
    let i = start + count;
    while (i < n) { xs[i - count] = xs[i]; i = i + 1; }
    let drop = 0; while (drop < count) { pop(xs); drop = drop + 1; }
    return removed;
}
// Comparator sort (insertion sort; stable, no recursion needed by the VM).
function __sortCmp(xs, cmp) {
    let n = len(xs); let i = 1;
    while (i < n) {
        let v = xs[i]; let j = i - 1;
        while (j >= 0 && cmp(xs[j], v) > 0) { xs[j + 1] = xs[j]; j = j - 1; }
        xs[j + 1] = v; i = i + 1;
    }
    return xs;
}

// ---- Math.random (deterministic LCG; the sandbox has no entropy source) -----
let __elpa_seed = 2463534242.0;
function __random() {
    // Numerical Recipes LCG, normalised to [0, 1).
    __elpa_seed = (__elpa_seed * 1664525.0 + 1013904223.0) % 4294967296.0;
    return __elpa_seed / 4294967296.0;
}

// ---- console.* (no stdout from the VM sandbox; kept as a safe no-op) ---------
let console = { log: (a) => { return 0; }, warn: (a) => { return 0; }, error: (a) => { return 0; } };
