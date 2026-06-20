// Elpa Liquid Glass — the glass material widget catalog.
//
// The interactive chrome, every piece rendered as the Liquid-Glass lens (or
// accent solid + ink text on top of it): Text, Icon, IconButton, GlassCard,
// GlassBar / AppBar, FilledButton / GlassButton / OutlinedButton, GlassFab,
// Switch, Slider, Chip, SegmentedButton, NavigationBar, Tabs, TextField,
// Divider, ListTile, Avatar, Progress, Dialog, BottomSheet, plus the Transform /
// Opacity effect wrappers. Each is a `Widget` subclass.

// ---------------------------------------------------------------- Text --------
class TextWidget extends Widget {
    constructor(t, opt) { super(opt); this.p.text = t; }
    measureIntrinsic(app) { let m = app.metrics; let cell = m.cellOf(this.p); let w = app.font.textW(this.p.text, cell); let h = 6.0 * cell + cell * 0.6; return { w: w, h: h }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let cell = m.cellOf(this.p);
        let col = app.theme.ink(1.0);
        if (has(this.p, "ink")) { col = app.theme.inkColor(this.p.ink); }
        if (has(this.p, "color")) { if (typeOf(this.p.color) == "string") { col = app.theme.colorRole(this.p.color, 1.0); } else { col = this.p.color; } }
        let thick = m.weightThick(this.p);
        app.font.paintCentered(app.painter, this.p.text, cx, cy, cell, col, thick, 0);
    }
}

// ---------------------------------------------------------------- Icon --------
class IconWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.iconR(this.p); return { w: r * 2.0, h: r * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let r = app.metrics.iconR(this.p);
        let col = app.theme.ink(1.0);
        if (has(this.p, "ink")) { col = app.theme.inkColor(this.p.ink); }
        if (has(this.p, "color")) { if (typeOf(this.p.color) == "string") { col = app.theme.colorRole(this.p.color, 1.0); } else { col = this.p.color; } }
        app.icons.drawNode(app.painter, this.p, cx, cy, r * 0.82, col);
    }
}

// A round glass icon button.
class IconButtonWidget extends Widget {
    measureIntrinsic(app) { let s = app.metrics.du() * 5.2; return { w: s, h: s }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let s = m.du() * 5.2; let r = s / 2.0;
        let pr = app.clock.pressVal(idOf(p));
        let rr = r * (1.0 - pr * 0.08);
        if (has(p, "glass")) { if (p.glass > 0.5) { pnt.glass(cx, cy, rr, rr, rr, m.u * 0.16, 0.0, th.glassThin(), th.rim(1.0), m.u * 4.0, 0.5, m.u * 1.6); } }
        let col = th.ink(0.95); if (has(p, "ink")) { col = th.inkColor(p.ink); }
        app.icons.drawNode(pnt, p, cx, cy, r * 0.5, col);
        if (has(p, "onTap")) { pnt.addTap(cx, cy, r, r, idOf(p), p.onTap); }
        this._kids = []; this.compose();
    }
}

// ---------------------------------------------------------------- GlassCard ---
class GlassCardWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let pad = m.u * 8.0 * m.sp; let c = { w: 0.0, h: 0.0 };
        if (has(this.p, "child")) { c = this.p.child.measure(app); }
        return { w: c.w + pad, h: c.h + pad };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let pnt = app.painter; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = m.u * 3.2;
        if (has(this.p, "radius")) { r = this.p.radius * m.u; }
        let mode = "regular"; if (has(this.p, "thick")) { if (this.p.thick > 0.5) { mode = "thick"; } }
        paintGlassPanel(app, cx, cy, hw, hh, r, mode);
        if (has(this.p, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(this.p), this.p.onTap); }
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        this._kids = outKids; this.compose();
    }
}

// ---------------------------------------------------------------- GlassBar ----
// A glass bar (top app bar). Title left-aligned, optional leading + action icons.
class AppBarWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.vw; if (this._fw >= 0.0) { w = this._fw; } return { w: w, h: m.u * 10.0 * m.dens + m.saT }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let r = m.u * 0.0;
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.1, 0.0, th.glass(1.1), th.rim(0.8), m.u * 3.0, 0.35, m.u * 2.6);
        let baseY = m.saT + (mz.h - m.saT) / 2.0;
        let leftX = cx - hw + m.u * 4.0;
        if (has(p, "onMenu")) { app.icons.draw(pnt, "menu", leftX, baseY, m.u * 2.0, th.ink(0.95)); pnt.addTap(leftX, baseY, m.u * 3.0, m.u * 3.0, "appbar.menu", p.onMenu); leftX = leftX + m.u * 6.0; }
        if (has(p, "title")) { app.font.textLeft(pnt, p.title, leftX, baseY, m.cell("title"), th.ink(1.0)); }
        if (has(p, "onAction")) { let ax = cx + hw - m.u * 4.0; let ic = "search"; if (has(p, "actionIcon")) { ic = p.actionIcon; } app.icons.draw(pnt, ic, ax, baseY, m.u * 2.0, th.ink(0.95)); pnt.addTap(ax, baseY, m.u * 3.0, m.u * 3.0, "appbar.action", p.onAction); }
        this._kids = []; this.compose();
    }
}

// ---------------------------------------------------------------- Buttons -----
// Shared pill-button layout: an optional glass/accent fill, ink label, press ease.
function paintPillButton(app, node, cx, cy, kind) {
    let m = app.metrics; let th = app.theme; let pnt = app.painter;
    let cell = m.cell("label"); let label = ""; if (has(node, "label")) { label = node.label; }
    let tw = app.font.textW(label, cell);
    let padX = m.du() * 3.2; let h = m.du() * 4.6;
    let w = tw + padX * 2.0; if (has(node, "width")) { w = node.width * m.u; }
    let hw = w / 2.0; let hh = h / 2.0; let r = hh;
    let pr = app.clock.pressVal(idOf(node));
    let sc = 1.0 - pr * 0.05; hw = hw * sc; hh = hh * sc; r = hh;
    if (kind == "filled") {
        pnt.shadow(cx, cy, hw, hh, r, m.u * 0.2, m.u * 0.6, m.u * 2.0, [th.accCh(0) * 0.5, th.accCh(1) * 0.5, th.accCh(2) * 0.5, 0.4]);
        pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, th.acc(1.0), CLEAR);
        if (pr > 0.01) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, [1.0, 1.0, 1.0, pr * 0.18], CLEAR); }
        app.font.text(pnt, label, cx, cy, cell, th.onAcc(1.0));
    } else { if (kind == "outlined") {
        pnt.rect(cx, cy, hw, hh, r, m.u * 0.22, 0.0, CLEAR, th.acc(0.9));
        app.font.text(pnt, label, cx, cy, cell, th.acc(1.0));
    } else {
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.16, 0.0, th.glassThin(), th.rim(1.0), m.u * 4.0, 0.6, m.u * 1.8);
        if (pr > 0.01) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, [1.0, 1.0, 1.0, pr * 0.12], CLEAR); }
        app.font.text(pnt, label, cx, cy, cell, th.ink(1.0));
    } }
    if (has(node, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(node), node.onTap); }
    return { w: w, h: h };
}
class FilledButtonWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let cell = m.cell("label"); let tw = app.font.textW(this.p.label, cell); let w = tw + m.du() * 6.4; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 4.6 }; }
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); paintPillButton(app, this.p, cx, cy, "filled"); }
}
class OutlinedButtonWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let cell = m.cell("label"); let tw = app.font.textW(this.p.label, cell); let w = tw + m.du() * 6.4; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 4.6 }; }
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); paintPillButton(app, this.p, cx, cy, "outlined"); }
}
class GlassButtonWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let cell = m.cell("label"); let tw = app.font.textW(this.p.label, cell); let w = tw + m.du() * 6.4; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 4.6 }; }
    paint(app, cx, cy) { this._cx = cx; this._cy = cy; this.beginLeaf(app); paintPillButton(app, this.p, cx, cy, "glass"); }
}

// A round glass floating action button.
class GlassFabWidget extends Widget {
    measureIntrinsic(app) { let s = app.metrics.du() * 8.4; return { w: s, h: s }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let r = m.du() * 4.2;
        let pr = app.clock.pressVal("fab"); let rr = r * (1.0 - pr * 0.06);
        pnt.shadow(cx, cy, rr, rr, rr, m.u * 0.2, m.u * 1.0, m.u * 3.0, [0.0, 0.0, 0.05, 0.3]);
        if (has(p, "accent")) { if (p.accent > 0.5) { pnt.rect(cx, cy, rr, rr, rr, 0.0, 0.0, th.acc(1.0), CLEAR); } else { pnt.glass(cx, cy, rr, rr, rr, m.u * 0.2, 0.0, th.glassThick(), th.rim(1.0), m.u * 5.0, 0.7, m.u * 2.0); } }
        else { pnt.glass(cx, cy, rr, rr, rr, m.u * 0.2, 0.0, th.glassThick(), th.rim(1.0), m.u * 5.0, 0.7, m.u * 2.0); }
        let ic = "add"; if (has(p, "icon")) { ic = p.icon; }
        let icol = th.ink(0.95); if (has(p, "accent")) { if (p.accent > 0.5) { icol = th.onAcc(1.0); } }
        app.icons.draw(pnt, ic, cx, cy, r * 0.42, icol);
        if (has(p, "onTap")) { pnt.addTap(cx, cy, rr, rr, "fab", p.onTap); }
    }
}

// ---------------------------------------------------------------- Switch ------
class SwitchWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; return { w: m.du() * 9.0, h: m.du() * 5.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let w = m.du() * 9.0; let h = m.du() * 5.0; let hw = w / 2.0; let hh = h / 2.0; let r = hh;
        let v = 0.0; if (has(p, "value")) { v = p.value; }
        let a = app.clock.ease(concat("sw:", idOf(p)), v);
        // Track: glass off, accent on.
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.14, 0.0, th.glassThin(), th.rim(0.8), m.u * 3.0, 0.4, m.u * 1.4);
        if (a > 0.01) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, th.acc(a), CLEAR); }
        // Thumb slides.
        let tr = hh - m.u * 0.7; let tx = cx - hw + r + a * (w - r * 2.0);
        pnt.shadow(tx, cy, tr, tr, tr, m.u * 0.1, m.u * 0.3, m.u * 1.2, [0.0, 0.0, 0.0, 0.25]);
        pnt.rect(tx, cy, tr, tr, tr, 0.0, 0.0, WHITE, CLEAR);
        if (has(p, "onTap")) { pnt.addTap(cx, cy, hw, hh, concat("sw:", idOf(p)), p.onTap); }
    }
}

// ---------------------------------------------------------------- Slider ------
class SliderWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 40.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 4.6 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let mz = this.measure(app); let w = mz.w; let hw = w / 2.0;
        let v = 0.5; if (has(p, "value")) { v = p.value; }
        let trackH = m.u * 1.1; let left = cx - hw + m.u * 1.6; let right = cx + hw - m.u * 1.6; let span = right - left;
        // Glass track + accent active portion.
        pnt.glass((left + right) / 2.0, cy, span / 2.0 + trackH, trackH, trackH, m.u * 0.1, 0.0, th.glassThin(), th.rim(0.7), m.u * 2.0, 0.3, m.u * 1.0);
        let tx = left + v * span;
        pnt.rect((left + tx) / 2.0, cy, (tx - left) / 2.0, trackH, trackH, 0.0, 0.0, th.acc(1.0), CLEAR);
        // Glass thumb.
        let thr = m.du() * 1.9;
        pnt.shadow(tx, cy, thr, thr, thr, m.u * 0.1, m.u * 0.3, m.u * 1.2, [0.0, 0.0, 0.0, 0.25]);
        pnt.rect(tx, cy, thr, thr, thr, 0.0, 0.0, WHITE, CLEAR);
        if (has(p, "onChanged")) {
            pnt.addDrag(cx, cy, hw, mz.h / 2.0, p.onChanged, left, span);
            app.registerWheel(p.onChanged, v);
        }
    }
}

// ---------------------------------------------------------------- Chip --------
class ChipWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let cell = m.cell("label"); let tw = app.font.textW(this.p.label, cell); return { w: tw + m.du() * 4.0, h: m.du() * 4.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = hh;
        let v = 0.0; if (has(p, "value")) { v = p.value; }
        let a = app.clock.ease(concat("chip:", idOf(p)), v);
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.14, 0.0, th.glassThin(), th.rim(0.9), m.u * 3.0, 0.5, m.u * 1.4);
        if (a > 0.01) { pnt.rect(cx, cy, hw, hh, r, 0.0, 0.0, th.acc(a * 0.9), CLEAR); }
        let col = th.ink(1.0); if (a > 0.5) { col = th.onAcc(1.0); }
        app.font.text(pnt, p.label, cx, cy, m.cell("label"), col);
        if (has(p, "onTap")) { pnt.addTap(cx, cy, hw, hh, concat("chip:", idOf(p)), p.onTap); }
    }
}

// ----------------------------------------------------- SegmentedButton --------
class SegmentedButtonWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let segs = this.p.segments; let w = m.du() * 7.0 * len(segs); if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 4.8 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = hh;
        let segs = p.segments; let n = len(segs); let segW = mz.w / n;
        let sel0 = 0; if (has(p, "selected")) { sel0 = p.selected; }
        let a = app.clock.ease(concat("seg:", idOf(p)), num(sel0));
        // Glass container.
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.14, 0.0, th.glassThin(), th.rim(0.8), m.u * 3.0, 0.4, m.u * 1.6);
        // Sliding accent highlight.
        let left = cx - hw; let hx = left + segW / 2.0 + a * segW;
        pnt.rect(hx, cy, segW / 2.0 - m.u * 0.4, hh - m.u * 0.4, r - m.u * 0.4, 0.0, 0.0, th.acc(0.92), CLEAR);
        for (let i = 0; i < n; i++) {
            let sx = left + segW * i + segW / 2.0;
            let col = th.ink(0.95); if (i == sel0) { col = th.onAcc(1.0); }
            app.font.text(pnt, segs[i], sx, cy, m.cell("label"), col);
            if (has(p, "onSelect")) { let idx = i; pnt.addTap(sx, cy, segW / 2.0, hh, concat(concat("seg:", idOf(p)), str(idx)), () => { p.onSelect(idx); }); }
        }
    }
}

// ---------------------------------------------------------- NavigationBar -----
class NavigationBarWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.vw; if (this._fw >= 0.0) { w = this._fw; } return { w: w, h: m.u * 11.0 * m.dens }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let items = p.items; let n = len(items); let segW = mz.w / n;
        let sel0 = 0; if (has(p, "selected")) { sel0 = p.selected; }
        let a = app.clock.ease(concat("nav:", idOf(p)), num(sel0));
        // Floating glass pill bar.
        let r = hh - m.u * 1.2;
        pnt.glass(cx, cy, hw - m.u * 1.2, hh - m.u * 1.2, r, m.u * 0.16, 0.0, th.glass(1.2), th.rim(0.9), m.u * 4.0, 0.45, m.u * 2.6);
        let left = cx - hw; let hx = left + segW / 2.0 + a * segW;
        // Selected indicator (glass highlight).
        let indR = m.du() * 2.6;
        pnt.rect(hx, cy - m.u * 0.6, indR, indR * 0.7, indR * 0.7, 0.0, 0.0, th.acc(0.22), CLEAR);
        for (let i = 0; i < n; i++) {
            let sx = left + segW * i + segW / 2.0;
            let col = th.inkSoft(0.85); if (i == sel0) { col = th.acc(1.0); }
            app.icons.draw(pnt, items[i].icon, sx, cy - m.u * 0.8, m.du() * 1.5, col);
            if (has(items[i], "label")) { app.font.text(pnt, items[i].label, sx, cy + m.du() * 2.2, m.cell("micro"), col); }
            if (has(p, "onSelect")) { let idx = i; pnt.addTap(sx, cy, segW / 2.0, hh, concat(concat("nav:", idOf(p)), str(idx)), () => { p.onSelect(idx); }); }
        }
        this._kids = []; this.compose();
    }
}

// ---------------------------------------------------------------- Tabs --------
class TabsWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 50.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 5.2 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = hh;
        let tabs = p.tabs; let n = len(tabs); let segW = mz.w / n;
        let sel0 = 0; if (has(p, "selected")) { sel0 = p.selected; }
        let a = app.clock.ease(concat("tab:", idOf(p)), num(sel0));
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.12, 0.0, th.glassThin(), th.rim(0.7), m.u * 2.5, 0.35, m.u * 1.4);
        let left = cx - hw; let hx = left + segW / 2.0 + a * segW;
        pnt.rect(hx, cy, segW / 2.0 - m.u * 0.4, hh - m.u * 0.4, r - m.u * 0.4, 0.0, 0.0, WHITE, CLEAR);
        for (let i = 0; i < n; i++) {
            let sx = left + segW * i + segW / 2.0;
            let col = th.ink(0.9); if (i == sel0) { col = [0.1, 0.11, 0.14, 1.0]; }
            app.font.text(pnt, tabs[i], sx, cy, m.cell("label"), col);
            if (has(p, "onSelect")) { let idx = i; pnt.addTap(sx, cy, segW / 2.0, hh, concat(concat("tab:", idOf(p)), str(idx)), () => { p.onSelect(idx); }); }
        }
    }
}

// ---------------------------------------------------------------- TextField ---
class TextFieldWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 50.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 5.4 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginLeaf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0; let r = m.u * 2.4;
        let focused = 0.0; if (app.focused == this) { focused = 1.0; }
        pnt.glass(cx, cy, hw, hh, r, m.u * 0.18, 0.0, th.glassThin(), th.rim(0.9), m.u * 3.0, 0.4, m.u * 1.6);
        if (focused > 0.5) { pnt.rect(cx, cy, hw, hh, r, m.u * 0.3, 0.0, CLEAR, th.acc(0.9)); }
        let cell = m.cell("body"); let tx = cx - hw + m.u * 2.4;
        let val = ""; if (has(p, "value")) { val = p.value; }
        if (len(val) > 0) { app.font.textLeftClip(pnt, val, tx, cy, cell, th.ink(1.0), mz.w - m.u * 4.0); }
        else { if (has(p, "hint")) { app.font.textLeft(pnt, p.hint, tx, cy, cell, th.inkSoft(0.6)); } }
        if (focused > 0.5) { let cw = app.font.textW(val, cell); pnt.rect(tx + cw + m.u * 0.3, cy, m.u * 0.16, hh - m.u * 1.4, m.u * 0.08, 0.0, 0.0, th.acc(1.0), CLEAR); }
        pnt.addTap(cx, cy, hw, hh, idOf(p), () => { app.focusField(this); });
        if (has(p, "onChanged")) { this._onChanged = p.onChanged; }
        if (focused > 0.5) { app.focusInput = (k) => { this.input(app, k); }; app.hasFocusInput = 1.0; }
    }
    input(app, k) {
        let p = this.p; let val = ""; if (has(p, "value")) { val = p.value; }
        if (k == "Backspace") { if (len(val) > 0) { val = substr0(val, len(val) - 1.0); } }
        else { if (len(k) == 1) { val = concat(val, k); } }
        if (has(p, "onChanged")) { p.onChanged(val); }
    }
}
// VM string subset has no slice; build a prefix of `s` up to `n` chars.
function substr0(s, n) { let out = ""; for (let i = 0; i < n; i++) { out = concat(out, charAt(s, i)); } return out; }

// ---------------------------------------------------------------- Divider -----
class DividerWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 40.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.u * 1.2 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let mz = this.measure(app);
        app.painter.rect(cx, cy, mz.w / 2.0, m.u * 0.08, m.u * 0.08, 0.0, 0.0, app.theme.inkSoft(0.2), CLEAR);
    }
}

// ---------------------------------------------------------------- Avatar ------
class AvatarWidget extends Widget {
    measureIntrinsic(app) { let s = app.metrics.du() * 6.0; if (has(this.p, "size")) { s = this.p.size * app.metrics.u; } return { w: s, h: s }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let mz = this.measure(app); let r = mz.w / 2.0;
        pnt.rect(cx, cy, r, r, r, 0.0, 0.0, th.acc(0.85), CLEAR);
        if (has(this.p, "label")) { app.font.text(pnt, this.p.label, cx, cy, m.cell("title"), th.onAcc(1.0)); }
        else { app.icons.draw(pnt, "person", cx, cy, r * 0.6, th.onAcc(1.0)); }
    }
}

// ---------------------------------------------------------------- Progress ----
class ProgressWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 40.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.u * 1.6 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = m.u * 0.6;
        let v = 0.0; if (has(p, "value")) { v = p.value; }
        let a = app.clock.ease(concat("pg:", idOf(p)), v);
        pnt.glass(cx, cy, hw, hh, hh, 0.0, 0.0, th.glassThin(), th.rim(0.5), m.u * 1.5, 0.2, m.u * 0.8);
        let left = cx - hw;
        pnt.rect(left + a * mz.w / 2.0, cy, a * hw, hh, hh, 0.0, 0.0, th.acc(1.0), CLEAR);
    }
}

class CircularProgressWidget extends Widget {
    measureIntrinsic(app) { let s = app.metrics.du() * 5.0; return { w: s, h: s }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let r = m.du() * 2.2; let v = 0.7; if (has(p, "value")) { v = p.value; }
        let segs = floor(20.0 * v); if (segs < 1) { segs = 1; }
        pnt.ring(cx, cy, r, m.u * 0.3, th.inkSoft(0.18));
        for (let i = 0; i < segs; i++) { let a = -1.5708 + num(i) / 20.0 * 6.2831853; pnt.disc(cx + cos(a) * r, cy + sin(a) * r, m.u * 0.32, th.acc(1.0)); }
    }
}

// ---------------------------------------------------------------- ListTile ----
class ListTileWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 56.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 7.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let pr = app.clock.pressVal(idOf(p));
        if (pr > 0.01) { pnt.rect(cx, cy, hw, hh, m.u * 2.0, 0.0, 0.0, th.ink(pr * 0.08), CLEAR); }
        let tx = cx - hw + m.u * 3.0;
        if (has(p, "icon")) { app.icons.draw(pnt, p.icon, cx - hw + m.u * 3.5, cy, m.du() * 1.6, th.acc(1.0)); tx = cx - hw + m.u * 8.0; }
        let titleY = cy; if (has(p, "subtitle")) { titleY = cy - m.du() * 1.1; }
        app.font.textLeftClip(pnt, p.title, tx, titleY, m.cell("body"), th.ink(1.0), hw * 2.0 - m.u * 12.0);
        if (has(p, "subtitle")) { app.font.textLeftClip(pnt, p.subtitle, tx, cy + m.du() * 1.4, m.cell("caption"), th.inkSoft(0.8), hw * 2.0 - m.u * 12.0); }
        if (has(p, "trailing")) { app.icons.draw(pnt, p.trailing, cx + hw - m.u * 3.5, cy, m.du() * 1.4, th.inkSoft(0.7)); }
        if (has(p, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(p), p.onTap); }
        let outKids = []; this._kids = outKids; this.compose();
    }
}

// ---------------------------------------------------------------- Dialog ------
class DialogWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let open = 0.0; if (has(p, "open")) { open = p.open; }
        let a = app.clock.ease("dialog", open);
        if (a < 0.01) { this._kids = []; this.compose(); return 0; }
        pnt.rect(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, a * 0.4], CLEAR);
        if (has(p, "onScrim")) { pnt.addTap(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, "dialog.scrim", p.onScrim); }
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) {
            let cm = p.child.measure(app); let dcy = m.vh / 2.0 + (1.0 - a) * m.u * 6.0;
            let hw = cm.w / 2.0 + m.u * 4.0; let hh = cm.h / 2.0 + m.u * 4.0;
            paintGlassPanel(app, m.vw / 2.0, dcy, hw, hh, m.u * 4.0, "thick");
            p.child.paint(app, m.vw / 2.0, dcy); push(outKids, p.child);
        } }
        this._kids = outKids; this.compose();
    }
}

// ----------------------------------------------------------- BottomSheet ------
class BottomSheetWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p; this.beginSelf(app);
        let open = 0.0; if (has(p, "open")) { open = p.open; }
        let a = app.clock.ease("sheet", open);
        if (a < 0.01) { this._kids = []; this.compose(); return 0; }
        pnt.rect(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, a * 0.35], CLEAR);
        if (has(p, "onScrim")) { pnt.addTap(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, "sheet.scrim", p.onScrim); }
        let h = m.vh * 0.42; let sy = m.vh - h / 2.0 + (1.0 - a) * h;
        let hw = m.vw / 2.0 - m.u * 1.5;
        paintGlassPanel(app, m.vw / 2.0, sy, hw, h / 2.0, m.u * 4.0, "thick");
        // Grab handle.
        pnt.rect(m.vw / 2.0, sy - h / 2.0 + m.u * 2.0, m.u * 4.0, m.u * 0.5, m.u * 0.5, 0.0, 0.0, th.inkSoft(0.4), CLEAR);
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) { p.child.paint(app, m.vw / 2.0, sy + m.u * 1.0); push(outKids, p.child); } }
        this._kids = outKids; this.compose();
    }
}

// ----------------------------------------------------- effect wrappers --------
class OpacityWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let o = 1.0; if (has(this.p, "opacity")) { o = this.p.opacity; }
        app.painter.save(); app.painter.setAlpha(o);
        let outKids = [];
        if (has(this.p, "child")) { if (!isNull(this.p.child)) { this.p.child.paint(app, cx, cy); push(outKids, this.p.child); } }
        app.painter.restore();
        this._kids = outKids; this.compose();
    }
}
class TransformWidget extends Widget {
    measureIntrinsic(app) { if (has(this.p, "child")) { return this.p.child.measure(app); } return { w: 0.0, h: 0.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginSelf(app);
        let p = this.p; let pnt = app.painter; pnt.save();
        let ang = 0.0; if (has(p, "angle")) { ang = p.angle; }
        let scl = 1.0; if (has(p, "scale")) { scl = p.scale; }
        let dx = 0.0; let dy = 0.0; if (has(p, "dx")) { dx = p.dx * app.metrics.u; } if (has(p, "dy")) { dy = p.dy * app.metrics.u; }
        pnt.translate(cx + dx, cy + dy); pnt.rotate(ang); pnt.scale(scl, scl); pnt.translate(-cx, -cy);
        let outKids = [];
        if (has(p, "child")) { if (!isNull(p.child)) { p.child.paint(app, cx, cy); push(outKids, p.child); } }
        pnt.restore();
        this._kids = outKids; this.compose();
    }
}
