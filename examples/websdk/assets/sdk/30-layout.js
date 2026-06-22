// Elpa Web SDK - the layout algorithms (block/inline flow, flexbox, grid).
//
// Each function takes the container Box and its content-box size (physical px,
// `contentH` may be AUTO) and returns { h, place, text }:
//   * h     - the content height the container resolves to,
//   * place - atomic child placements { node, x, y } (centres relative to the
//             content-box top-left), painted by the container,
//   * text  - text-run glyph fragments { str, x, y, cell, col, thick } the
//             container emits into its own buffer (text belongs to its block).
// All maths is physical px. These are pure (no painter emit), so the same pass
// serves both `measure` (height) and `paint` (placement).

// A run of text: an inline leaf with no box of its own; its glyphs are flowed by
// the containing block's inline formatter and painted into that block's buffer.
class TextRun extends Box {
    // `_isText` is an own data field (not a method): this VM's `has` sees only
    // instance fields, so the `isText` predicate tests this flag, not a method.
    constructor(text) { super("#text", {}); this._text = concat("", text); this._isText = 1.0; }
    isText() { return 1.0; }
    isInline() { return 1.0; }
    kids() { return []; }
    uaStyle() { return { display: "inline" }; }
    measureIntrinsic(app) {
        let cell = pxCell(this._cs.fontPx * this._d);
        return { w: app.font.textW(this.transformed(), cell), h: this._cs.lineHeightPx * this._d };
    }
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); }
    transformed() {
        let t = this._text; let tt = this._cs.textTransform;
        if (tt == "uppercase") { return upper(t); } if (tt == "lowercase") { return lower(t); }
        return t;
    }
}
function isText(n) { if (has(n, "_isText")) { return 1.0; } return 0.0; }
// Physical font cell for the SDF/atlas text engine from a physical font size.
function pxCell(fontPxPhys) { return fontPxPhys / 6.6; }
function weightThick(w) { let t = 0.5 + w / 1000.0; if (t < 0.6) { t = 0.6; } if (t > 1.4) { t = 1.4; } return t; }

// Resolve a child's four margins to physical px (auto -> 0 here; centring is
// handled by the block formatter). `cbw` is the containing-block width (physical).
function childMargins(child, cbw, d) {
    let c = child._cs;
    let l = dpx(c.m.l, cbw, d, 0.0); let r = dpx(c.m.r, cbw, d, 0.0);
    return { t: dpx(c.m.t, cbw, d, 0.0), r: r, b: dpx(c.m.b, cbw, d, 0.0), l: l };
}

// ============================================================ block + inline ==
function flowLayout(app, box, contentW, contentH) {
    let kids = box._childNodes; let place = []; let text = [];
    let y = 0.0; let absKids = []; let flow = [];
    // Split children into in-flow vs out-of-flow (skipping display:none).
    for (let i = 0; i < len(kids); i++) {
        let k = kids[i];
        if (k._cs.display != "none") { if (k.isAbs() > 0.5) { push(absKids, k); } else { push(flow, k); } }
    }
    let i = 0;
    while (i < len(flow)) {
        let k = flow[i];
        let inlineLevel = 0.0; if (isText(k) > 0.5) { inlineLevel = 1.0; } if (k.isInline() > 0.5) { inlineLevel = 1.0; }
        if (inlineLevel > 0.5) {
            // Gather the maximal run of consecutive inline-level children.
            let run = []; let j = i; let stop = 0.0;
            while (j < len(flow)) {
                if (stop < 0.5) {
                    let kk = flow[j]; let il = 0.0; if (isText(kk) > 0.5) { il = 1.0; } if (kk.isInline() > 0.5) { il = 1.0; }
                    if (il > 0.5) { push(run, kk); j = j + 1; } else { stop = 1.0; }
                } else { j = len(flow); }
            }
            let res = inlineFlow(app, box, run, contentW, y);
            y = res.y; place = concat(place, res.place); text = concat(text, res.text);
            i = i + len(run);
        } else {
            let r = layoutBlockChild(app, box, k, contentW, contentH, y);
            y = r.y; push(place, { node: k, x: r.cx, y: r.cy });
            i = i + 1;
        }
    }
    // Absolutely-positioned descendants resolve against this padding box.
    let ab = layoutAbs(app, box, absKids, contentW, contentH);
    place = concat(place, ab);
    return { h: y, place: place, text: text };
}

// One block-level child in normal flow at vertical pen `y`. Returns the new pen
// and the child centre (relative to content top-left).
function layoutBlockChild(app, box, child, contentW, contentH, y) {
    let d = box._d;
    child._cbW = contentW; if (contentH == AUTO) { child._cbH = box.cbH(); } else { child._cbH = contentH; }
    let m = childMargins(child, contentW, d);
    let autoL = isAuto(child._cs.m.l); let autoR = isAuto(child._cs.m.r);
    let ml = m.l; let mr = m.r; if (autoL > 0.5) { ml = 0.0; } if (autoR > 0.5) { mr = 0.0; }
    child._fw = -1.0;
    let cw = child.resolvedW(app);
    let avail = contentW - ml - mr; if (avail < 0.0) { avail = 0.0; }
    if (cw == AUTO) { cw = avail; }
    child._fw = cw;
    let cm = child.measure(app);
    // Auto horizontal margins: centre the block in its free space.
    let freeX = contentW - cw - ml - mr;
    if (autoL > 0.5) { if (autoR > 0.5) { ml = ml + freeX / 2.0; } else { ml = ml + freeX; } }
    else { if (autoR > 0.5) { } }
    let cx = ml + cw / 2.0; let cy = y + m.t + cm.h / 2.0;
    // Relative positioning shifts the painted box without affecting flow.
    if (child._cs.position == "relative") {
        let off = relOffset(child, contentW, contentH, d); cx = cx + off.x; cy = cy + off.y;
    }
    return { y: y + m.t + cm.h + m.b, cx: cx, cy: cy };
}

// Inline formatting: flow text words + atomic inline boxes into line boxes that
// wrap at `contentW`, then justify each line per the block's text-align.
function inlineFlow(app, box, run, contentW, y0) {
    let d = box._d; let align = box._cs.textAlign; let nowrap = 0.0;
    if (box._cs.whiteSpace == "nowrap") { nowrap = 1.0; } if (box._cs.whiteSpace == "pre") { nowrap = 1.0; }
    let items = [];
    for (let i = 0; i < len(run); i++) {
        let node = run[i];
        if (isText(node) > 0.5) {
            let cell = pxCell(node._cs.fontPx * d); let col = node._cs.color; let thick = weightThick(node._cs.fontWeight);
            let lh = node._cs.lineHeightPx * d; let words = split(node.transformed(), " ");
            let sp = app.font.textW(" ", cell);
            for (let w = 0; w < len(words); w++) {
                let word = words[w];
                if (len(word) > 0) { push(items, { kind: "text", w: app.font.textW(word, cell), h: lh, str: word, cell: cell, col: col, thick: thick, sp: sp }); }
            }
        } else {
            node._cbW = contentW; node._fw = -1.0; let cm = node.measure(app);
            let m = childMargins(node, contentW, d);
            push(items, { kind: "box", w: cm.w + m.l + m.r, h: cm.h, node: node, ml: m.l });
        }
    }
    let place = []; let text = []; let y = y0;
    let line = []; let lineW = 0.0; let lineH = 0.0;
    let i = 0;
    while (i < len(items)) {
        let it = items[i]; let adv = it.w; if (it.kind == "text") { if (len(line) > 0) { adv = adv + it.sp; } }
        let over = 0.0; if (nowrap < 0.5) { if (len(line) > 0) { if (lineW + adv > contentW) { over = 1.0; } } }
        if (over > 0.5) { let f = flushLine(box, line, lineW, lineH, contentW, y, align); place = concat(place, f.place); text = concat(text, f.text); y = y + lineH; line = []; lineW = 0.0; lineH = 0.0; }
        else { i = i + 1; }
        if (over < 0.5) {
            let lead = 0.0; if (it.kind == "text") { if (len(line) > 0) { lead = it.sp; } }
            push(line, { it: it, x: lineW + lead }); lineW = lineW + adv; if (it.h > lineH) { lineH = it.h; }
        }
    }
    if (len(line) > 0) { let f = flushLine(box, line, lineW, lineH, contentW, y, align); place = concat(place, f.place); text = concat(text, f.text); y = y + lineH; }
    return { y: y, place: place, text: text };
}
// Position one line's items (apply text-align, vertical centre) and emit them.
function flushLine(box, line, lineW, lineH, contentW, y, align) {
    let place = []; let text = []; let off = 0.0; let free = contentW - lineW;
    if (free > 0.0) { if (align == "center") { off = free / 2.0; } if (align == "right") { off = free; } if (align == "end") { off = free; } }
    let cyLine = y + lineH / 2.0;
    for (let i = 0; i < len(line); i++) {
        let e = line[i]; let it = e.it; let cx = off + e.x + it.w / 2.0;
        if (it.kind == "text") { push(text, { str: it.str, x: cx, y: cyLine, cell: it.cell, col: it.col, thick: it.thick }); }
        else { push(place, { node: it.node, x: off + e.x + it.ml + (it.w - it.ml) / 2.0, y: cyLine }); }
    }
    return { place: place, text: text };
}

// ===================================================================== flex ===
function flexLayout(app, box, contentW, contentH) {
    let c = box._cs; let d = box._d; let kids = box._childNodes;
    let row = 1.0; if (startsWith(c.flexDirection, "column")) { row = 0.0; }
    let rev = 0.0; if (endsWith(c.flexDirection, "reverse")) { rev = 1.0; }
    let gapMain = c.colGap * d; let gapCross = c.rowGap * d;
    if (row < 0.5) { gapMain = c.rowGap * d; gapCross = c.colGap * d; }
    let items = [];
    for (let i = 0; i < len(kids); i++) {
        let k = kids[i];
        if (k._cs.display != "none") { if (k.isAbs() < 0.5) { push(items, k); } }
    }
    items = sortByOrder(items);
    let n = len(items); if (n == 0) { return { h: 0.0, place: [], text: [] }; }
    let mainAvail = contentW; if (row < 0.5) { mainAvail = contentH; if (contentH == AUTO) { mainAvail = AUTO; } }

    // Base (hypothetical) main sizes.
    let bases = []; let crosses = []; let grows = []; let shrinks = [];
    for (let i = 0; i < n; i++) {
        let k = items[i]; let kc = k._cs; k._cbW = contentW; k._fw = -1.0; k._fh = -1.0;
        let cm = k.measure(app); let base = 0.0;
        if (row > 0.5) {
            if (kc.flexBasis.k != "auto") { base = dpx(kc.flexBasis, contentW, d, cm.w); if (kc.boxSizing != "border-box") { } } else { if (!isAuto(kc.width)) { base = cm.w; } else { base = cm.w; } }
            push(crosses, cm.h);
        } else {
            if (kc.flexBasis.k != "auto") { base = dpx(kc.flexBasis, box.cbH(), d, cm.h); } else { base = cm.h; }
            push(crosses, cm.w);
        }
        push(bases, base); push(grows, kc.flexGrow); push(shrinks, kc.flexShrink);
    }
    let sumBase = 0.0; for (let i = 0; i < n; i++) { sumBase = sumBase + bases[i]; }
    let totalGap = gapMain * (n - 1);
    let mainSize = mainAvail; if (mainAvail == AUTO) { mainSize = sumBase + totalGap; }
    let free = mainSize - sumBase - totalGap;
    // Grow / shrink distribution.
    let sizes = [];
    let sumGrow = 0.0; for (let i = 0; i < n; i++) { sumGrow = sumGrow + grows[i]; }
    let sumShrink = 0.0; for (let i = 0; i < n; i++) { sumShrink = sumShrink + shrinks[i] * bases[i]; }
    for (let i = 0; i < n; i++) {
        let s = bases[i];
        if (free > 0.0) { if (sumGrow > 0.0) { s = bases[i] + free * grows[i] / sumGrow; } }
        else { if (free < 0.0) { if (sumShrink > 0.0) { s = bases[i] + free * (shrinks[i] * bases[i]) / sumShrink; } } }
        if (s < 0.0) { s = 0.0; }
        push(sizes, s);
    }
    // Cross size of the line.
    let crossSize = contentH; if (row < 0.5) { crossSize = contentW; }
    let lineCross = 0.0; for (let i = 0; i < n; i++) { if (crosses[i] > lineCross) { lineCross = crosses[i]; } }
    if (crossSize == AUTO) { crossSize = lineCross; }
    if (row > 0.5) { if (contentH != AUTO) { crossSize = contentH; } } else { crossSize = contentW; }

    // Main-axis justification.
    let used = totalGap; for (let i = 0; i < n; i++) { used = used + sizes[i]; }
    let slack = mainSize - used; if (slack < 0.0) { slack = 0.0; }
    let lead = 0.0; let between = gapMain;
    let jc = c.justifyContent;
    if (jc == "center") { lead = slack / 2.0; }
    if (jc == "flex-end") { lead = slack; } if (jc == "end") { lead = slack; }
    if (jc == "space-between") { if (n > 1) { between = gapMain + slack / (n - 1); } else { lead = 0.0; } }
    if (jc == "space-around") { let g = slack / n; lead = g / 2.0; between = gapMain + g; }
    if (jc == "space-evenly") { let g = slack / (n + 1); lead = g; between = gapMain + g; }

    let place = []; let pos = lead;
    for (let i = 0; i < n; i++) {
        let idx = i; if (rev > 0.5) { idx = n - 1 - i; }
        let k = items[idx]; let kc = k._cs; let s = sizes[idx]; let cs2 = crosses[idx];
        // align-items / align-self along the cross axis (stretch grows the item).
        let al = c.alignItems; if (kc.alignSelf != "auto") { al = kc.alignSelf; }
        let crossPos = 0.0; let crossLen = cs2;
        if (al == "stretch") { let autoCross = 0.0; if (row > 0.5) { if (isAuto(kc.height)) { autoCross = 1.0; } } else { if (isAuto(kc.width)) { autoCross = 1.0; } } if (autoCross > 0.5) { crossLen = crossSize; } }
        if (al == "center") { crossPos = (crossSize - cs2) / 2.0; }
        if (al == "flex-end") { crossPos = crossSize - cs2; } if (al == "end") { crossPos = crossSize - cs2; }
        // Force the computed main (and stretched cross) size, then measure.
        if (row > 0.5) { k._fw = s; if (crossLen != cs2) { k._fh = crossLen; } } else { k._fh = s; if (crossLen != cs2) { k._fw = crossLen; } }
        let cm = k.measure(app);
        let mainC = pos + s / 2.0; let crossC = crossPos + cm.h / 2.0; if (row < 0.5) { crossC = crossPos + cm.w / 2.0; }
        let cx = mainC; let cy = crossC; if (row < 0.5) { cx = crossC; cy = mainC; }
        push(place, { node: k, x: cx, y: cy });
        pos = pos + s + between;
    }
    let h = crossSize; if (row > 0.5) { if (contentH == AUTO) { h = lineCross; } else { h = contentH; } } else { h = mainSize; }
    let ab = layoutAbs(app, box, absOf(kids), contentW, contentH); place = concat(place, ab);
    return { h: h, place: place, text: [] };
}
function sortByOrder(items) {
    let arr = concat([], items); let n = len(arr);
    for (let i = 1; i < n; i++) { let j = i; while (j > 0) { if (arr[j - 1]._cs.order > arr[j]._cs.order) { let t = arr[j - 1]; arr[j - 1] = arr[j]; arr[j] = t; j = j - 1; } else { j = 0; } } }
    return arr;
}
function absOf(kids) { let o = []; for (let i = 0; i < len(kids); i++) { if (kids[i]._cs.display != "none") { if (kids[i].isAbs() > 0.5) { push(o, kids[i]); } } } return o; }

// ===================================================================== grid ===
function gridLayout(app, box, contentW, contentH) {
    let c = box._cs; let d = box._d; let kids = box._childNodes;
    let tracks = c.gridCols; if (tracks == 0) { tracks = [{ fr: 1.0 }]; }
    let ncol = len(tracks); let gapC = c.colGap * d; let gapR = c.rowGap * d;
    // Resolve column widths (px/pct fixed; fr shares the remainder).
    let fixed = 0.0; let frTotal = 0.0;
    for (let i = 0; i < ncol; i++) { let t = tracks[i]; if (has(t, "px")) { fixed = fixed + t.px; } else { if (has(t, "pct")) { fixed = fixed + t.pct * contentW; } else { frTotal = frTotal + t.fr; } } }
    let frRem = contentW - fixed - gapC * (ncol - 1); if (frRem < 0.0) { frRem = 0.0; }
    let colW = [];
    for (let i = 0; i < ncol; i++) { let t = tracks[i]; let w = 0.0; if (has(t, "px")) { w = t.px; } else { if (has(t, "pct")) { w = t.pct * contentW; } else { if (frTotal > 0.0) { w = frRem * t.fr / frTotal; } } } push(colW, w); }
    let items = []; for (let i = 0; i < len(kids); i++) { let k = kids[i]; if (k._cs.display != "none") { if (k.isAbs() < 0.5) { push(items, k); } } }
    let place = []; let y = 0.0; let i = 0; let n = len(items);
    while (i < n) {
        let rowH = 0.0; let cells = [];
        for (let col = 0; col < ncol; col++) {
            if (i + col >= n) { col = ncol; }
            else { let k = items[i + col]; k._cbW = colW[col]; k._fw = colW[col]; k._fh = -1.0; let cm = k.measure(app); push(cells, { node: k, w: colW[col], h: cm.h, col: col }); if (cm.h > rowH) { rowH = cm.h; } }
        }
        let x = 0.0;
        for (let col = 0; col < len(cells); col++) {
            let cell = cells[col]; let k = cell.node;
            let al = c.alignItems; if (al == "stretch") { if (isAuto(k._cs.height)) { k._fh = rowH; } }
            let cm = k.measure(app);
            push(place, { node: k, x: x + cell.w / 2.0, y: y + cm.h / 2.0 });
            x = x + cell.w + gapC;
        }
        y = y + rowH + gapR; i = i + ncol;
    }
    if (n > 0) { y = y - gapR; }
    let ab = layoutAbs(app, box, absOf(kids), contentW, contentH); place = concat(place, ab);
    return { h: y, place: place, text: [] };
}

// =============================================================== positioning ==
// Lay out absolutely / fixed positioned children against this padding box.
function layoutAbs(app, box, absKids, contentW, contentH) {
    let d = box._d; let place = []; let cbH = contentH; if (contentH == AUTO) { cbH = box.cbH(); }
    for (let i = 0; i < len(absKids); i++) {
        let k = absKids[i]; let kc = k._cs; k._cbW = contentW; k._cbH = cbH; k._fw = -1.0; k._fh = -1.0;
        let lT = kc.left; let rT = kc.right; let tT = kc.top; let bT = kc.bottom;
        // Width from left+right if both set, else from width/shrink-to-fit.
        let cm0 = k.measure(app); let w = cm0.w;
        if (!isAuto(lT)) { if (!isAuto(rT)) { w = contentW - dpx(lT, contentW, d, 0.0) - dpx(rT, contentW, d, 0.0); k._fw = w; } }
        let cm = k.measure(app);
        let cx = cm.w / 2.0; let cy = cm.h / 2.0;
        if (!isAuto(lT)) { cx = dpx(lT, contentW, d, 0.0) + cm.w / 2.0; }
        else { if (!isAuto(rT)) { cx = contentW - dpx(rT, contentW, d, 0.0) - cm.w / 2.0; } }
        if (!isAuto(tT)) { cy = dpx(tT, cbH, d, 0.0) + cm.h / 2.0; }
        else { if (!isAuto(bT)) { cy = cbH - dpx(bT, cbH, d, 0.0) - cm.h / 2.0; } }
        push(place, { node: k, x: cx, y: cy });
    }
    return place;
}
// Relative-position offset (top/left win over bottom/right) in physical px.
function relOffset(node, contentW, contentH, d) {
    let c = node._cs; let cbH = contentH; if (contentH == AUTO) { cbH = node.cbH(); }
    let x = 0.0; let y = 0.0;
    if (!isAuto(c.left)) { x = dpx(c.left, contentW, d, 0.0); } else { if (!isAuto(c.right)) { x = -dpx(c.right, contentW, d, 0.0); } }
    if (!isAuto(c.top)) { y = dpx(c.top, cbH, d, 0.0); } else { if (!isAuto(c.bottom)) { y = -dpx(c.bottom, cbH, d, 0.0); } }
    return { x: x, y: y };
}
