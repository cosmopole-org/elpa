// Elpa Web SDK - the HTML element catalog (user-agent stylesheet + behaviour).
//
// Most elements differ only by their default ("user-agent") style, so they all
// share one `HtmlElement` class that reads its defaults from the `UA` registry
// by tag name - which makes the catalog *complete*: every HTML tag resolves to a
// box with the right default `display`, margins, font size/weight, etc. Elements
// that carry behaviour beyond styling (images, text inputs, anchors, list items,
// line breaks, rules) are dedicated subclasses below.

// The user-agent stylesheet: tag -> default declarations (camelCase). Mirrors a
// browser's html.css. Anything not listed falls back to an inline box.
let UA = {
    // Sectioning / flow containers (block, no special font).
    html: { display: "block" },
    body: { display: "block" }, div: { display: "block" }, section: { display: "block" },
    article: { display: "block" }, aside: { display: "block" }, nav: { display: "block" },
    header: { display: "block" }, footer: { display: "block" }, main: { display: "block" },
    figure: { display: "block", marginTop: "16px", marginBottom: "16px", marginLeft: "40px", marginRight: "40px" },
    figcaption: { display: "block" }, address: { display: "block", fontStyle: "italic" },
    hgroup: { display: "block" }, details: { display: "block" }, summary: { display: "block" },
    dialog: { display: "block", padding: "16px", background: "white", border: "1px solid #999" },
    // Paragraphs / headings (block with vertical margins, heading weights/sizes).
    p: { display: "block", marginTop: "16px", marginBottom: "16px" },
    h1: { display: "block", fontSize: "32px", fontWeight: "bold", marginTop: "21px", marginBottom: "21px" },
    h2: { display: "block", fontSize: "24px", fontWeight: "bold", marginTop: "20px", marginBottom: "20px" },
    h3: { display: "block", fontSize: "19px", fontWeight: "bold", marginTop: "18px", marginBottom: "18px" },
    h4: { display: "block", fontSize: "16px", fontWeight: "bold", marginTop: "21px", marginBottom: "21px" },
    h5: { display: "block", fontSize: "13px", fontWeight: "bold", marginTop: "22px", marginBottom: "22px" },
    h6: { display: "block", fontSize: "11px", fontWeight: "bold", marginTop: "24px", marginBottom: "24px" },
    blockquote: { display: "block", marginTop: "16px", marginBottom: "16px", marginLeft: "40px", marginRight: "40px" },
    pre: { display: "block", whiteSpace: "pre", fontFamily: "monospace", marginTop: "13px", marginBottom: "13px" },
    // Lists.
    ul: { display: "block", marginTop: "16px", marginBottom: "16px", paddingLeft: "40px", listStyleType: "disc" },
    ol: { display: "block", marginTop: "16px", marginBottom: "16px", paddingLeft: "40px", listStyleType: "decimal" },
    li: { display: "block" }, dl: { display: "block", marginTop: "16px", marginBottom: "16px" },
    dt: { display: "block" }, dd: { display: "block", marginLeft: "40px" }, menu: { display: "block" },
    // Tables (mapped to block/flow; cells laid out as rows).
    table: { display: "block", borderCollapse: "separate" }, caption: { display: "block", textAlign: "center" },
    thead: { display: "block" }, tbody: { display: "block" }, tfoot: { display: "block" },
    tr: { display: "flex", flexDirection: "row" }, td: { display: "block", flex: "1", padding: "2px" },
    th: { display: "block", flex: "1", fontWeight: "bold", textAlign: "center", padding: "2px" },
    colgroup: { display: "none" }, col: { display: "none" },
    // Forms.
    form: { display: "block" }, fieldset: { display: "block", border: "2px groove #c0c0c0", padding: "10px", marginLeft: "2px", marginRight: "2px" },
    legend: { display: "block", paddingLeft: "2px", paddingRight: "2px" },
    label: { display: "inline" }, select: { display: "inline-block", border: "1px solid #767676", padding: "2px", background: "white" },
    option: { display: "block" }, optgroup: { display: "block", fontWeight: "bold" },
    progress: { display: "inline-block", width: "160px", height: "16px" }, meter: { display: "inline-block", width: "80px", height: "16px" },
    button: { display: "inline-block", paddingTop: "2px", paddingBottom: "2px", paddingLeft: "8px", paddingRight: "8px", border: "1px solid #767676", borderRadius: "3px", background: "#e9e9ed", color: "black", textAlign: "center", cursor: "pointer", fontSize: "14px" },
    // Inline text-level semantics.
    span: { display: "inline" }, a: { display: "inline", color: "#0000ee", textDecoration: "underline" },
    strong: { display: "inline", fontWeight: "bold" }, b: { display: "inline", fontWeight: "bold" },
    em: { display: "inline", fontStyle: "italic" }, i: { display: "inline", fontStyle: "italic" },
    u: { display: "inline", textDecoration: "underline" }, s: { display: "inline", textDecoration: "line-through" },
    strike: { display: "inline", textDecoration: "line-through" }, del: { display: "inline", textDecoration: "line-through" },
    ins: { display: "inline", textDecoration: "underline" }, small: { display: "inline", fontSize: "13px" },
    big: { display: "inline", fontSize: "19px" }, mark: { display: "inline", background: "#ffff00", color: "black" },
    sub: { display: "inline", fontSize: "11px" }, sup: { display: "inline", fontSize: "11px" },
    code: { display: "inline", fontFamily: "monospace" }, kbd: { display: "inline", fontFamily: "monospace" },
    samp: { display: "inline", fontFamily: "monospace" }, var: { display: "inline", fontStyle: "italic" },
    cite: { display: "inline", fontStyle: "italic" }, q: { display: "inline" }, abbr: { display: "inline" },
    time: { display: "inline" }, dfn: { display: "inline", fontStyle: "italic" }, data: { display: "inline" },
    bdi: { display: "inline" }, bdo: { display: "inline" }, ruby: { display: "inline" }, wbr: { display: "inline" },
    // Embedded / media.
    canvas: { display: "inline-block" }, svg: { display: "inline-block" }, video: { display: "inline-block" },
    audio: { display: "inline" }, iframe: { display: "inline-block", border: "2px inset" }, object: { display: "inline-block" },
    embed: { display: "inline-block" }, picture: { display: "inline" }, source: { display: "none" }, track: { display: "none" },
    // Metadata (not rendered).
    head: { display: "none" }, title: { display: "none" }, meta: { display: "none" }, link: { display: "none" },
    style: { display: "none" }, script: { display: "none" }, base: { display: "none" }, template: { display: "none" }
};

// The shared element: its UA defaults come from the registry by tag.
class HtmlElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { if (has(UA, this.tag)) { return UA[this.tag]; } return { display: "inline" }; }
}

// <br> - a forced line break (block-level, zero height; it ends the inline run).
class BrElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { return { display: "block", height: "0px" }; }
    kids() { return []; }
    measureIntrinsic(app) { return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); }
}
// <hr> - a horizontal rule.
class HrElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { return { display: "block", marginTop: "8px", marginBottom: "8px", borderTop: "1px solid #c0c0c0", height: "0px" }; }
    kids() { return []; }
}

// <a> - an inline anchor; an `href`+`onNavigate` or `onClick` makes it tappable.
class AnchorElement extends HtmlElement {
    constructor(tag, props) { super(tag, props); }
    premount(app) {
        if (has(this.p, "href")) { if (!has(this.p, "onClick")) { let self = this; this.p.onClick = () => { if (has(app, "onNavigate")) { app.onNavigate(self.p.href); } }; } }
        return 0;
    }
}

// <li> - a list item that paints its marker (disc / decimal / none) in the
// padding area to the left of its content.
class LiElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { return { display: "block" }; }
    drawDecoration(app, cx, cy, hw, hh) {
        this.baseDecoration(app, cx, cy, hw, hh);
        let lst = this._cs.listStyleType; if (lst == "none") { return 0; }
        let pnt = app.painter; let c = this._cs; let d = this._d;
        let fs = c.fontPx * d; let my = cy - hh + c.lineHeightPx * d / 2.0;
        let mx = cx - hw + 4.0 * d;
        if (lst == "decimal") { let n = 1.0; if (has(this, "_liIndex")) { n = this._liIndex + 1.0; }
            app.font.paintCentered(pnt, concat(str(floor(n)), "."), mx + fs * 0.4, my, pxCell(fs), c.color, 0.92, 0); }
        else { pnt.disc(mx + fs * 0.18, my, fs * 0.16, c.color); }
        return 0;
    }
}

// <img> - an image drawn through the MediaEngine textured-quad pipeline.
class ImgElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { return { display: "inline-block" }; }
    kids() { return []; }
    naturalSize(app) {
        let d = this._d; let w = 0.0; let h = 0.0;
        if (has(this.p, "width")) { w = num(this.p.width) * d; } if (has(this.p, "height")) { h = num(this.p.height) * d; }
        if (has(this.p, "src")) { let s = this.media(app); if (!isNull(s)) { let m = app.media.media[s.key]; if (!isNull(m)) { if (m.ready > 0.5) { if (w == 0.0) { w = m.w; } if (h == 0.0) { h = m.h; } } } } }
        if (w == 0.0) { w = 80.0 * d; } if (h == 0.0) { h = 60.0 * d; }
        return { w: w, h: h };
    }
    media(app) { if (!has(this.p, "src")) { return 0; } return { key: concat("u:", this.p.src), req: { url: this.p.src } }; }
    measureIntrinsic(app) {
        let c = this._cs; let d = this._d; let n = this.naturalSize(app);
        let w = n.w; let h = n.h;
        if (!isAuto(c.width)) { w = dpx(c.width, this.cbW(), d, n.w); } else { if (this._fw >= 0.0) { w = this._fw; } }
        if (!isAuto(c.height)) { h = dpx(c.height, this.cbH(), d, n.h); }
        return { w: w, h: h };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let r = this.radiusPhys(hw, hh); let s = this.media(app);
        if (isNull(s)) { app.painter.rect(cx, cy, hw, hh, r, 0.0, 0.0, [0.9, 0.9, 0.92, 1.0], CLEAR); }
        else { app.media.drawMedia(app.painter, s.key, s.req, 0.0, cx, cy, hw, hh, r, WHITE); }
        this.registerInput(app, cx, cy, hw, hh);
    }
}

// <input> / <textarea> - an editable text field with focus + caret.
class InputElement extends Box {
    constructor(tag, props) { super(tag, props); }
    uaStyle() { return { display: "inline-block", border: "1px solid #767676", padding: "2px 4px", background: "white", color: "black", width: "180px", fontSize: "14px" }; }
    kids() { return []; }
    value() { if (has(this.p, "value")) { return concat("", this.p.value); } return ""; }
    premount(app) {
        let self = this;
        this.p._focusKey = "input"; if (has(this.p, "id")) { this.p._focusKey = this.p.id; }
        this.p._onKey = (key) => {
            let v = self.value();
            if (key == "Backspace") { if (len(v) > 0) { v = substring(v, 0, len(v) - 1); } }
            else { if (key == "Enter") { if (has(self.p, "onSubmit")) { self.p.onSubmit(v); } }
            else { if (len(key) == 1) { v = concat(v, key); } } }
            if (has(self.p, "onInput")) { self.p.onInput(v); }
        };
        if (!has(this.p, "onClick")) { this.p.onClick = noop; }
        return 0;
    }
    measureIntrinsic(app) {
        let c = this._cs; let d = this._d; let n = this.baseMeasureIntrinsic(app);
        let h = (c.fontPx * c.lineHeight) * d + (dpx(c.p.t, this.cbW(), d, 0.0) + dpx(c.p.b, this.cbW(), d, 0.0)) + (c.bw.t + c.bw.b) * d;
        if (isAuto(c.height)) { n.h = h; }
        return n;
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        this.beginSelf(app); this.drawDecoration(app, cx, cy, hw, hh);
        let c = this._cs; let d = this._d; let pnt = app.painter;
        let pl = dpx(c.p.l, this.cbW(), d, 0.0); let cell = pxCell(c.fontPx * d);
        let v = this.value(); let col = c.color; let placeholder = 0.0;
        if (len(v) == 0) { if (has(this.p, "placeholder")) { v = concat("", this.p.placeholder); col = [0.5, 0.5, 0.5, 1.0]; placeholder = 1.0; } }
        let masked = v; if (has(this.p, "type")) { if (this.p.type == "password") { if (placeholder < 0.5) { masked = repeat("*", len(v)); } } }
        let tx = cx - hw + pl + (c.bw.l * d);
        app.font.textLeft(pnt, masked, tx, cy, cell, col);
        let focused = 0.0; if (app.focusId == this.p._focusKey) { focused = 1.0; }
        if (focused > 0.5) {
            let cw = app.font.textW(masked, cell); if (placeholder > 0.5) { cw = 0.0; }
            pnt.rect(tx + cw + 1.0, cy, 1.0, cell * 3.0, 0.0, 0.0, 0.0, c.color, CLEAR);
            pnt.rect(cx, cy, hw, hh, this.radiusPhys(hw, hh), 1.5 * d, 0.0, CLEAR, [0.1, 0.45, 0.9, 1.0]);
        }
        this.registerInput(app, cx, cy, hw, hh);
        this._kids = []; this.compose();
    }
}
