// Elpa Material — the Material 3 widget catalog (controls + chrome).
//
// Text, the app bar, buttons, the M3 switch/checkbox/radio/slider/chip, progress
// indicators, icons, list tiles, the focusable text field, tabs, the navigation
// bar, segmented button, expansion chrome, banner, snackbar, modal dialog and the
// sliding navigation drawer. Each is a leaf `Widget` that emits its rounded-rect
// SDF instances (and hit regions) straight into its own buffer.

// Pill widths from the proportional font (label/caption cell), plus padding.
function btnW(app, label) { return app.font.textW(label, app.metrics.cell("label")) + app.metrics.u * 8.0; }
function chipW(app, label) { return app.font.textW(label, app.metrics.cell("caption")) + app.metrics.u * 7.0; }

// Real text: proportional glyphs from the font atlas (stroke-font fallback).
class TextWidget extends Widget {
    constructor(t, opt) { super(opt); this.p.text = t; }
    measureIntrinsic(app) { let c = app.metrics.cellOf(this.p); return { w: app.font.textW(this.p.text, c), h: 6.0 * c }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let ink = ""; if (has(this.p, "ink")) { ink = this.p.ink; }
        let fnt = 0; if (has(this.p, "font")) { fnt = this.p.font; }
        app.font.paintCentered(app.painter, this.p.text, cx, cy, m.cellOf(this.p), app.theme.inkColor(ink), m.weightThick(this.p), fnt);
    }
}

// M3 small top app bar: a surface bar with on-surface nav icon + left title.
class AppBarWidget extends Widget {
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let bot = cy * 2.0;
        pnt.rect(m.vw / 2.0, cy, m.vw / 2.0, cy, 0.0, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        pnt.rect(m.vw / 2.0, bot - m.u * 0.05, m.vw / 2.0, m.u * 0.05, 0.0, 0.0, 0.0, th.outlineVar(0.8), CLEAR);
        let onS = th.onSurface(1.0);
        let ccy = m.saT + (bot - m.saT) / 2.0;
        let lineCx = m.saL + m.u * 6.0;
        app.icons.draw(pnt, "menu", lineCx, ccy, m.du() * 2.6, onS);
        let actCx = m.vw - m.saR - m.u * 6.0;
        pnt.disc(actCx, ccy, m.du() * 2.4, th.acc(1.0));
        app.font.textLeft(pnt, p.title, m.saL + m.u * 11.0, ccy, m.cell("title"), onS);
        if (has(p, "onMenu")) { pnt.addTap(lineCx, ccy, m.u * 3.0, m.u * 3.0, "appMenu", p.onMenu); }
        if (has(p, "onAction")) { pnt.addTap(actCx, ccy, m.u * 3.0, m.u * 3.0, "appAction", p.onAction); }
    }
}

// M3 filled button (accent pill, elevation 0; hover/press add a tonal layer).
class FilledButtonWidget extends Widget {
    measureIntrinsic(app) { return { w: btnW(app, this.p.label), h: app.metrics.du() * 5.5 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let st = app.hover(cx, cy, hw, hh) * 0.08 + app.clock.pressVal(this.p.id) * 0.12;
        pnt.rect(cx, cy, hw, hh, hh, 0.0, 0.0, th.brighten(th.acc(1.0), st), CLEAR);
        app.font.text(pnt, this.p.label, cx, cy, m.cell("label"), th.onAcc(1.0));
        pnt.addTap(cx, cy, hw, hh, this.p.id, this.p.onTap);
    }
}
class OutlinedButtonWidget extends Widget {
    measureIntrinsic(app) { return { w: btnW(app, this.p.label), h: app.metrics.du() * 5.5 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let st = app.hover(cx, cy, hw, hh) * 0.08 + app.clock.pressVal(this.p.id) * 0.12;
        pnt.rect(cx, cy, hw, hh, hh, m.u * 0.18, 0.0, th.acc(st), th.acc(1.0));
        app.font.text(pnt, this.p.label, cx, cy, m.cell("label"), th.acc(1.0));
        pnt.addTap(cx, cy, hw, hh, this.p.id, this.p.onTap);
    }
}

class FabWidget extends Widget {
    measureIntrinsic(app) { let d = app.metrics.du() * 8.4; return { w: d, h: d }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let r = m.du() * 4.2; let rad = r * 0.45;
        let st = app.hover(cx, cy, r, r) * 0.08 + app.clock.pressVal("fab") * 0.12;
        pnt.shadow(cx, cy, r, r, rad, m.u * 0.4, m.u * 1.2, m.u * 3.0);
        pnt.rect(cx, cy, r, r, rad, 0.0, 0.0, th.brighten(th.acc(1.0), st), CLEAR);
        app.icons.draw(pnt, "add", cx, cy, r * 0.43, th.onAcc(1.0));
        pnt.addTap(cx, cy, r, r, "fab", this.p.onTap);
    }
}

class SwitchWidget extends Widget {
    measureIntrinsic(app) { let u = app.metrics.du(); return { w: u * 8.4, h: u * 4.8 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let u = m.du();
        let hw = u * 4.2; let hh = u * 2.4;
        let a = app.clock.ease(concat("sw:", this.p.id), this.p.value);
        let bw = (1.0 - a) * u * 0.22;
        pnt.rect(cx, cy, hw, hh, hh, bw, 0.0, th.mixCol(th.surfaceHighest(1.0), th.acc(1.0), a), th.mixCol(th.outline(1.0), th.acc(1.0), a));
        let rOff = hh * 0.55; let rOn = hh * 0.82; let tr = rOff + (rOn - rOff) * a;
        let left = cx - hw; let right = cx + hw;
        let tx = (left + hh) + ((right - hh) - (left + hh)) * a;
        pnt.rect(tx, cy, tr, tr, tr, 0.0, 0.0, th.mixCol(th.outline(1.0), WHITE, a), CLEAR);
        pnt.addTap(cx, cy, hw + u * 2.0, hh + u * 2.0, this.p.id, this.p.onTap);
    }
}
class CheckboxWidget extends Widget {
    measureIntrinsic(app) { let d = app.metrics.du() * 4.4; return { w: d, h: d }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let u = m.du(); let h = u * 2.2;
        let a = app.clock.ease(concat("ck:", this.p.id), this.p.value);
        pnt.rect(cx, cy, h, h, h * 0.28, u * 0.22, 0.0, th.acc(a), th.mixCol(th.outline(1.0), th.acc(1.0), a));
        let white = [1.0, 1.0, 1.0, a];
        pnt.rect(cx - h * 0.22, cy + h * 0.12, h * 0.25, h * 0.08, h * 0.08, 0.0, -2.356, white, CLEAR);
        pnt.rect(cx + h * 0.22, cy - h * 0.12, h * 0.50, h * 0.08, h * 0.08, 0.0, -0.997, white, CLEAR);
        pnt.addTap(cx, cy, h + u * 2.0, h + u * 2.0, this.p.id, this.p.onTap);
    }
}
class RadioWidget extends Widget {
    measureIntrinsic(app) { let d = app.metrics.du() * 4.4; return { w: d, h: d }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let u = m.du(); let h = u * 2.2;
        let a = app.clock.ease(concat("rb:", this.p.id), this.p.selected);
        pnt.rect(cx, cy, h, h, h, u * 0.22, 0.0, CLEAR, th.mixCol(th.outline(1.0), th.acc(1.0), a));
        let dr = h * 0.55 * a;
        pnt.rect(cx, cy, dr, dr, dr, 0.0, 0.0, th.acc(1.0), CLEAR);
        pnt.addTap(cx, cy, h + u * 2.0, h + u * 2.0, this.p.id, this.p.onTap);
    }
}
class SliderWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.u * 62.0, h: app.metrics.du() * 5.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let hw = m.u * 31.0; let hh = m.u * 0.8; let val = this.p.value;
        let left = cx - hw; let width = hw * 2.0;
        pnt.rect(cx, cy, hw, hh, hh, 0.0, 0.0, th.surfaceHighest(1.0), CLEAR);
        pnt.rect(left + val * width / 2.0, cy, val * width / 2.0, hh, hh, 0.0, 0.0, th.acc(1.0), CLEAR);
        let baseR = m.du() * 1.4; let tw = baseR * 0.42 * (1.0 + app.dragging * 0.2); let tht = baseR * (1.4 + app.dragging * 0.25);
        pnt.rect(left + val * width, cy, tw, tht, tw, 0.0, 0.0, th.acc(1.0), CLEAR);
        pnt.addDrag(cx, cy, hw, m.du() * 5.0, this.p.onChanged, left, width);
        app.registerWheel(this.p.onChanged, val);
    }
}
class ChipWidget extends Widget {
    measureIntrinsic(app) { return { w: chipW(app, this.p.label), h: app.metrics.du() * 4.2 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let a = app.clock.ease(concat("chip:", this.p.id), this.p.value);
        pnt.rect(cx, cy, hw, hh, hh * 0.5, m.u * 0.18, 0.0, th.acc(a), th.mixCol(th.outline(1.0), th.acc(1.0), a));
        let dr = hh * 0.42;
        pnt.rect(cx - hw + hh * 1.1, cy, dr, dr, dr, 0.0, 0.0, [1.0, 1.0, 1.0, a], CLEAR);
        app.font.text(pnt, this.p.label, cx + hh * 0.4, cy, m.cell("caption"), th.mixCol(th.onSurface(1.0), th.onAcc(1.0), a));
        pnt.addTap(cx, cy, hw, hh, this.p.id, this.p.onTap);
    }
}
class ProgressWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.u * 62.0, h: app.metrics.u * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter;
        let hw = m.u * 31.0; let hh = m.u * 0.8;
        let a = app.clock.ease(concat("pr:", this.p.id), this.p.value);
        pnt.rect(cx, cy, hw, hh, hh, 0.0, 0.0, th.surfaceHighest(1.0), CLEAR);
        let left = cx - hw; let width = hw * 2.0 * a;
        pnt.rect(left + width / 2.0, cy, width / 2.0, hh, hh, 0.0, 0.0, th.acc(1.0), CLEAR);
    }
}
class DividerWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.u * 62.0, h: app.metrics.u * 0.4 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let w = m.u * 31.0; if (has(this.p, "width")) { w = this.p.width * m.u * 0.5; }
        app.painter.rect(cx, cy, w, m.u * 0.18, 0.0, 0.0, 0.0, app.theme.outlineVar(1.0), CLEAR);
    }
}

class IconWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.iconR(this.p); return { w: r * 2.0, h: r * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let r = app.metrics.iconR(this.p); let col = app.theme.onSurface(1.0); if (has(this.p, "color")) { col = app.theme.colorRole(this.p.color, 1.0); }
        app.icons.drawNode(app.painter, this.p, cx, cy, r, col);
    }
}
class IconButtonWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.iconR(this.p); let s = r * 2.0 + app.metrics.du() * 2.4; return { w: s, h: s }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let r = m.iconR(p); let hw = r + m.du() * 1.2;
        let st = app.hover(cx, cy, hw, hw) * 0.10 + app.clock.pressVal(p.id) * 0.14;
        let sel2 = 0.0; if (has(p, "selected")) { sel2 = p.selected; }
        if (sel2 > 0.5) { pnt.rect(cx, cy, hw, hw, hw, 0.0, 0.0, th.acc(0.16), CLEAR); }
        if (st > 0.001) { pnt.rect(cx, cy, hw, hw, hw, 0.0, 0.0, th.onSurface(st), CLEAR); }
        let col = th.onSurface(0.85); if (sel2 > 0.5) { col = th.acc(1.0); } if (has(p, "color")) { col = th.colorRole(p.color, 1.0); }
        app.icons.drawNode(pnt, p, cx, cy, r, col);
        pnt.addTap(cx, cy, hw, hw, p.id, p.onTap);
    }
}
class AvatarWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.u * 3.2; if (has(this.p, "radius")) { r = this.p.radius * app.metrics.u; } return { w: r * 2.0, h: r * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let r = m.u * 3.2; if (has(p, "radius")) { r = p.radius * m.u; }
        let col = th.acc(1.0); if (has(p, "color")) { col = th.colorRole(p.color, 1.0); }
        pnt.disc(cx, cy, r, col);
        if (has(p, "icon")) { app.icons.draw(pnt, p.icon, cx, cy, r * 0.6, th.onAcc(1.0)); }
        else { if (has(p, "label")) { app.font.text(pnt, p.label, cx, cy, r * 0.5, th.onAcc(1.0)); } }
    }
}
class ListTileWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 56.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 9.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let st = app.hover(cx, cy, hw, hh) * 0.05; if (has(p, "id")) { st = st + app.clock.pressVal(p.id) * 0.08; }
        if (st > 0.001) { pnt.rect(cx, cy, hw, hh, m.u * 1.0, 0.0, 0.0, th.onSurface(st), CLEAR); }
        let hasLead = has(p, "leading");
        if (hasLead) { app.icons.draw(pnt, p.leading, cx - hw + m.u * 4.5, cy, m.du() * 1.9, th.onSurface(0.8)); }
        let tx = cx - hw + m.u * 4.0; if (hasLead) { tx = cx - hw + m.u * 9.0; }
        let hasSub = has(p, "subtitle");
        let ty = cy; if (hasSub) { ty = cy - m.du() * 1.3; }
        let txRight = cx + hw - m.u * 3.0; if (has(p, "trailing")) { txRight = cx + hw - m.u * 7.0; }
        let textW = txRight - tx;
        ft.textLeftClip(pnt, p.title, tx, ty, m.cell("body"), th.onSurface(1.0), textW);
        if (hasSub) { ft.textLeftClip(pnt, p.subtitle, tx, cy + m.du() * 1.6, m.cell("caption"), th.onSurface(0.65), textW); }
        if (has(p, "trailing")) { app.icons.draw(pnt, p.trailing, cx + hw - m.u * 4.0, cy, m.du() * 1.7, th.onSurface(0.7)); }
        if (has(p, "onTap")) { pnt.addTap(cx, cy, hw, hh, idOf(p), p.onTap); }
    }
}
class TextFieldWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = m.u * 50.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 7.5 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let f = 0.0; if (app.focused == p.id) { f = 1.0; }
        let bw = m.u * 0.18; let bcol = th.outline(1.0); if (f > 0.5) { bw = m.u * 0.3; bcol = th.acc(1.0); }
        pnt.rect(cx, cy, hw, hh, m.u * 1.2, bw, 0.0, th.surfaceContainer(0.5), bcol);
        let tx = cx - hw + m.u * 2.6; let val = p.value;
        if (len(val) == 0) { if (has(p, "placeholder")) { ft.textLeft(pnt, p.placeholder, tx, cy, m.cell("body"), th.onSurface(0.4)); } }
        else { ft.textLeft(pnt, val, tx, cy, m.cell("body"), th.onSurface(1.0)); }
        if (has(p, "label")) { ft.textLeft(pnt, p.label, tx, cy - hh - m.u * 1.3, m.cell("caption"), bcol); }
        if (f > 0.5) {
            let cw = ft.textW(val, m.cell("body"));
            pnt.rect(tx + cw + m.u * 0.4, cy, m.u * 0.14, hh * 0.5, m.u * 0.07, 0.0, 0.0, th.acc(1.0), CLEAR);
            app.focusInput = (key) => {
                let v = p.value;
                if (key == "Backspace") { v = substring(v, 0, max(0.0, len(v) - 1.0)); }
                else { if (len(key) == 1) { v = concat(v, key); } }
                if (has(p, "onChange")) { p.onChange(v); }
            };
            app.hasFocusInput = 1.0;
        }
        pnt.addTap(cx, cy, hw, hh, p.id, () => { app.focused = p.id; app.repaint(); });
    }
}
class TabsWidget extends Widget {
    measureIntrinsic(app) { return { w: len(this.p.tabs) * app.metrics.u * 14.0, h: app.metrics.du() * 6.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let n = len(p.tabs); let tw = mz.w / n; let left = cx - hw;
        let idx = 0.0; if (has(p, "index")) { idx = p.index; }
        for (let i = 0; i < n; i++) {
            let tcx = left + i * tw + tw / 2.0; let on = sel(i, idx);
            let col = th.onSurface(0.65); if (on > 0.5) { col = th.acc(1.0); }
            app.font.text(pnt, p.tabs[i], tcx, cy - m.u * 0.3, m.cell("label"), col);
            let ii = i; pnt.addTap(tcx, cy, tw / 2.0, hh, concat("tab", str(ii)), () => { p.onChange(ii); });
        }
        let a = app.clock.ease(concat("tabs:", idOf(p)), idx);
        let icx = left + (a + 0.5) * tw;
        pnt.rect(cx, cy + hh - m.u * 0.1, hw, m.u * 0.08, 0.0, 0.0, 0.0, th.outlineVar(1.0), CLEAR);
        pnt.rect(icx, cy + hh - m.u * 0.3, tw * 0.34, m.u * 0.32, m.u * 0.18, 0.0, 0.0, th.acc(1.0), CLEAR);
    }
}
class NavigationBarWidget extends Widget {
    measureIntrinsic(app) { return { w: len(this.p.items) * app.metrics.u * 14.0, h: app.metrics.du() * 11.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        pnt.rect(cx, cy, hw, hh, 0.0, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        pnt.rect(cx, cy - hh, hw, m.u * 0.06, 0.0, 0.0, 0.0, th.outlineVar(1.0), CLEAR);
        let n = len(p.items); let tw = mz.w / n; let left = cx - hw;
        let idx = 0.0; if (has(p, "index")) { idx = p.index; }
        for (let i = 0; i < n; i++) {
            let it = p.items[i]; let tcx = left + i * tw + tw / 2.0; let on = sel(i, idx);
            let col = th.onSurface(0.6); if (on > 0.5) { col = th.acc(1.0); }
            if (on > 0.5) { pnt.rect(tcx, cy - m.du() * 1.3, m.du() * 5.0, m.du() * 1.6, m.du() * 1.6, 0.0, 0.0, th.acc(0.18), CLEAR); }
            app.icons.draw(pnt, it.icon, tcx, cy - m.du() * 1.3, m.du() * 1.6, col);
            if (has(it, "label")) { app.font.text(pnt, it.label, tcx, cy + m.du() * 2.2, m.cell("micro"), col); }
            let ii = i; pnt.addTap(tcx, cy, tw / 2.0, hh, concat("nav", str(ii)), () => { p.onChange(ii); });
        }
    }
}
class SegmentedButtonWidget extends Widget {
    measureIntrinsic(app) { let m = app.metrics; let w = len(this.p.segments) * m.u * 13.0; if (has(this.p, "width")) { w = this.p.width * m.u; } return { w: w, h: m.du() * 5.5 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let n = len(p.segments); let tw = mz.w / n; let left = cx - hw;
        let idx = 0.0; if (has(p, "index")) { idx = p.index; }
        pnt.rect(cx, cy, hw, hh, hh, m.u * 0.18, 0.0, CLEAR, th.outline(1.0));
        for (let i = 0; i < n; i++) {
            let scx = left + i * tw + tw / 2.0; let on = sel(i, idx);
            if (on > 0.5) { pnt.rect(scx, cy, tw / 2.0 - m.u * 0.25, hh - m.u * 0.25, hh, 0.0, 0.0, th.acc(0.9), CLEAR); }
            let col = th.onSurface(0.9); if (on > 0.5) { col = th.onAcc(1.0); }
            app.font.text(pnt, p.segments[i], scx, cy, m.cell("label"), col);
            if (i > 0) { pnt.rect(left + i * tw, cy, m.u * 0.08, hh, 0.0, 0.0, 0.0, th.outline(0.6), CLEAR); }
            let ii = i; pnt.addTap(scx, cy, tw / 2.0, hh, concat("seg", str(ii)), () => { p.onChange(ii); });
        }
    }
}
class CircularProgressWidget extends Widget {
    measureIntrinsic(app) { let r = app.metrics.u * 4.0; if (has(this.p, "radius")) { r = this.p.radius * app.metrics.u; } return { w: r * 2.0, h: r * 2.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let r = m.u * 4.0; if (has(p, "radius")) { r = p.radius * m.u; }
        let val = 0.75; if (has(p, "value")) { val = p.value; }
        let a = app.clock.ease(concat("cp:", idOf(p)), val);
        pnt.ring(cx, cy, r, m.u * 0.5, th.surfaceHighest(1.0));
        let segn = floor(48.0 * a) + 1; let a0 = 0.0 - 1.5708;
        for (let i = 0; i < segn; i++) { let aa = a0 + (num(i) / 48.0) * 6.2832; pnt.disc(cx + cos(aa) * r, cy + sin(aa) * r, m.u * 0.42, th.acc(1.0)); }
        app.font.text(pnt, concat(str(floor(a * 100.0)), "%"), cx, cy, m.cell("caption"), th.onSurface(0.9));
    }
}
class BannerWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.u * 60.0, h: app.metrics.du() * 8.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        pnt.rect(cx, cy, hw, hh, m.u * 1.2, 0.0, 0.0, th.acc(0.16), CLEAR);
        let tx = cx - hw + m.u * 3.0;
        if (has(p, "icon")) { app.icons.draw(pnt, p.icon, cx - hw + m.u * 4.0, cy, m.du() * 1.8, th.acc(1.0)); tx = cx - hw + m.u * 8.0; }
        app.font.textLeft(pnt, p.message, tx, cy, m.cell("body"), th.onSurface(0.95));
    }
}
class SnackbarWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.u * 60.0, h: app.metrics.du() * 7.0 }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let p = this.p;
        let w = m.u * 60.0; if (m.isCompact() > 0.5) { w = m.vw - m.saL - m.saR - m.u * 8.0; }
        let cx2 = m.vw / 2.0; let cy2 = m.vh - m.saB - m.du() * 9.0; let hw = w / 2.0; let hh = m.du() * 3.5;
        pnt.shadow(cx2, cy2, hw, hh, m.u * 1.2, m.u * 0.3, m.u * 0.8, m.u * 2.0);
        pnt.rect(cx2, cy2, hw, hh, m.u * 1.2, 0.0, 0.0, [th.mix(0.18, 0.92), th.mix(0.18, 0.90), th.mix(0.2, 0.94), 1.0], CLEAR);
        app.font.textLeft(pnt, p.message, cx2 - hw + m.u * 3.0, cy2, m.cell("body"), [th.mix(0.95, 0.1), th.mix(0.95, 0.1), th.mix(0.97, 0.12), 1.0]);
        if (has(p, "actionLabel")) {
            let aw = btnW(app, p.actionLabel) / 2.0; let acx = cx2 + hw - aw - m.u * 2.0;
            app.font.text(pnt, p.actionLabel, acx, cy2, m.cell("label"), th.acc(1.0));
            if (has(p, "onAction")) { pnt.addTap(acx, cy2, aw, hh, "snackAction", p.onAction); }
        }
    }
}
class DialogWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        pnt.rect(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.45], CLEAR);
        let w = m.u * 72.0; let h = m.u * 46.0; if (has(p, "width")) { w = p.width * m.u; } if (has(p, "height")) { h = p.height * m.u; }
        let cx2 = m.vw / 2.0; let cy2 = m.vh / 2.0; let hw = w / 2.0; let hh = h / 2.0;
        pnt.shadow(cx2, cy2, hw, hh, m.u * 2.0, m.u * 0.5, m.u * 1.5, m.u * 3.0);
        pnt.rect(cx2, cy2, hw, hh, m.u * 2.4, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        if (has(p, "title")) { ft.textLeft(pnt, p.title, cx2 - hw + m.u * 4.0, cy2 - hh + m.u * 5.5, m.cell("title"), th.onSurface(1.0)); }
        if (has(p, "message")) { ft.wrappedLeft(pnt, p.message, cx2 - hw + m.u * 4.0, cy2 - hh + m.u * 12.0, hw * 2.0 - m.u * 8.0, m.cell("body"), th.onSurface(0.8)); }
        if (has(p, "actions")) {
            let acts = p.actions; let ax = cx2 + hw - m.u * 3.0;
            for (let i = len(acts) - 1; i >= 0; i = i - 1) {
                let act = acts[i]; let bw = btnW(app, act.label) / 2.0; let bcx = ax - bw;
                ft.text(pnt, act.label, bcx, cy2 + hh - m.u * 4.0, m.cell("label"), th.acc(1.0));
                pnt.addTap(bcx, cy2 + hh - m.u * 4.0, bw, m.du() * 2.6, concat("dlg", str(i)), act.onTap);
                ax = ax - bw * 2.0 - m.u * 4.0;
            }
        }
    }
}
// M3 navigation drawer: a slide-in panel with an account header and destinations
// (groupable with `{ section }` captions and `{ divider: 1 }` rules).
class DrawerWidget extends Widget {
    measureIntrinsic(app) { return { w: app.metrics.vw, h: app.metrics.vh }; }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        let open = 0.0; if (has(p, "open")) { open = p.open; }
        let a = app.clock.ease(concat("drawer:", idOf(p)), open);
        if (a < 0.01) { return 0; }
        let w = m.u * 72.0; let cap = (m.vw - m.saL) * 0.86; if (w > cap) { w = cap; }
        pnt.rect(m.vw / 2.0, m.vh / 2.0, m.vw / 2.0, m.vh / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.45 * a], CLEAR);
        let pcx = 0.0 - w / 2.0 + a * w; let cy2 = m.vh / 2.0; let hw = w / 2.0; let hh = m.vh / 2.0;
        pnt.rect(pcx, cy2, hw, hh, 0.0, 0.0, 0.0, th.surfaceContainer(1.0), CLEAR);
        let left = pcx - hw;
        let headerH = m.saT + m.du() * 26.0;
        let headInk = th.onSurface(1.0); let headSub = th.onSurface(0.6);
        if (has(p, "image")) {
            // Accent-tinted header underneath, always. Only composite the photo
            // (and its darkening scrim + white text) once it has actually loaded;
            // while it loads or if it failed, the accent header stands in instead
            // of a grey placeholder box.
            pnt.rect(pcx, headerH / 2.0, hw, headerH / 2.0, 0.0, 0.0, 0.0, th.acc(0.16), CLEAR);
            let hst = app.media.ensure(concat("drw:", p.image), { url: p.image }, 0.0);
            if (hst.ready > 0.5) {
                pnt.image(hst.handle, pcx, headerH / 2.0, hw, headerH / 2.0, 0.0, WHITE);
                pnt.rect(pcx, headerH / 2.0, hw, headerH / 2.0, 0.0, 0.0, 0.0, [0.0, 0.0, 0.0, 0.42], CLEAR);
                headInk = [1.0, 1.0, 1.0, 1.0]; headSub = [1.0, 1.0, 1.0, 0.82];
            }
        } else {
            pnt.rect(pcx, headerH / 2.0, hw, headerH / 2.0, 0.0, 0.0, 0.0, th.acc(0.16), CLEAR);
        }
        let avR = m.du() * 4.2; let avX = left + m.u * 6.0 + avR; let avY = m.saT + m.du() * 8.0;
        pnt.disc(avX, avY, avR + m.u * 0.4, th.surfaceContainer(1.0));
        pnt.disc(avX, avY, avR, th.acc(1.0));
        let avIcon = "person"; if (has(p, "avatarIcon")) { avIcon = p.avatarIcon; }
        app.icons.draw(pnt, avIcon, avX, avY, avR * 0.62, th.onAcc(1.0));
        if (has(p, "header")) { ft.textLeftClip(pnt, p.header, left + m.u * 6.0, avY + avR + m.du() * 3.4, m.cell("title"), headInk, hw * 2.0 - m.u * 10.0); }
        if (has(p, "subtitle")) { ft.textLeftClip(pnt, p.subtitle, left + m.u * 6.0, avY + avR + m.du() * 6.6, m.cell("caption"), headSub, hw * 2.0 - m.u * 10.0); }
        let items = p.items; let iy = headerH + m.du() * 2.5; let rowH = m.du() * 6.2; let navIdx = 0;
        for (let i = 0; i < len(items); i++) {
            let it = items[i];
            if (has(it, "divider")) {
                pnt.rect(pcx, iy + m.du() * 1.0, hw - m.u * 4.0, m.u * 0.05, 0.0, 0.0, 0.0, th.outlineVar(1.0), CLEAR);
                iy = iy + m.du() * 2.5;
            } else { if (has(it, "section")) {
                ft.textLeft(pnt, it.section, left + m.u * 6.0, iy + rowH * 0.45, m.cell("caption"), th.onSurface(0.5));
                iy = iy + rowH * 0.85;
            } else {
                let myIdx = navIdx; navIdx = navIdx + 1;
                let sel2 = 0.0; if (has(p, "index")) { sel2 = sel(myIdx, p.index); }
                let icy = iy + rowH / 2.0;
                if (sel2 > 0.5) { pnt.rect(pcx, icy, hw - m.u * 3.0, rowH / 2.0 - m.u * 0.5, rowH / 2.0, 0.0, 0.0, th.acc(0.18), CLEAR); }
                let col = th.onSurface(0.78); if (sel2 > 0.5) { col = th.acc(1.0); }
                if (has(it, "icon")) { app.icons.draw(pnt, it.icon, left + m.u * 6.5, icy, m.du() * 1.7, col); }
                ft.textLeftClip(pnt, it.label, left + m.u * 11.0, icy, m.cell("body"), col, hw * 2.0 - m.u * 16.0);
                let captured = myIdx;
                pnt.addTap(pcx, icy, hw - m.u * 3.0, rowH / 2.0, concat("drw", str(i)), () => { p.onSelect(captured); });
                iy = iy + rowH;
            } }
        }
        let pr = pcx + hw; let scx = (pr + m.vw) / 2.0; let sw = (m.vw - pr) / 2.0;
        if (has(p, "onClose")) { pnt.addTap(scx, m.vh / 2.0, sw, m.vh / 2.0, "drwScrim", p.onClose); }
    }
}
class DataTableWidget extends Widget {
    measureIntrinsic(app) {
        let m = app.metrics; let cw = m.u * 14.0; if (has(this.p, "colWidth")) { cw = this.p.colWidth * m.u; }
        return { w: len(this.p.columns) * cw, h: m.u * 5.0 * (len(this.p.rows) + 1) };
    }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.beginLeaf(app);
        let m = app.metrics; let th = app.theme; let pnt = app.painter; let ft = app.font; let p = this.p;
        let mz = this.measure(app); let hw = mz.w / 2.0; let hh = mz.h / 2.0;
        let cols = p.columns; let nc = len(cols); let rows = p.rows; let nr = len(rows);
        let cw = mz.w / nc; let rh = m.u * 5.0; let left = cx - hw; let top = cy - hh;
        for (let c = 0; c < nc; c++) { ft.textLeft(pnt, cols[c], left + c * cw + m.u * 1.0, top + rh / 2.0, m.cell("label"), th.onSurface(1.0)); }
        pnt.rect(cx, top + rh, hw, m.u * 0.08, 0.0, 0.0, 0.0, th.outline(1.0), CLEAR);
        for (let r2 = 0; r2 < nr; r2++) {
            let ry = top + rh * (r2 + 1) + rh / 2.0;
            if (r2 % 2 == 1) { pnt.rect(cx, ry, hw, rh / 2.0, 0.0, 0.0, 0.0, th.onSurface(0.03), CLEAR); }
            let row = rows[r2];
            for (let c = 0; c < nc; c++) { ft.textLeft(pnt, str(row[c]), left + c * cw + m.u * 1.0, ry, m.cell("body"), th.onSurface(0.85)); }
            pnt.rect(cx, ry + rh / 2.0, hw, m.u * 0.04, 0.0, 0.0, 0.0, th.outlineVar(0.5), CLEAR);
        }
    }
}
