// Elpa Flutter — a small Material catalog (package:flutter/material analog).
//
// Built entirely on the widgets layer: Theme is an InheritedWidget (Theme.of
// looks it up and registers a dependency), MaterialApp provides it, and
// Scaffold / AppBar / ElevatedButton / Icon / CustomPaint compose the catalog
// widgets. Nothing here touches the render protocol except the two leaf render
// objects (RenderIcon, RenderCustomPaint) that paint through dart:ui.

// ------------------------------------------------------------- ThemeData ------
class ThemeData {
    constructor(primary, onPrimary, surface, onSurface, bg) {
        this.primary = primary; this.onPrimary = onPrimary;
        this.surface = surface; this.onSurface = onSurface; this.background = bg;
    }
}
function lightTheme() { return new ThemeData(colorRGBO(103, 58, 183, 1.0), Colors.white, colorRGBO(245, 245, 248, 1.0), colorRGBO(20, 20, 28, 1.0), colorRGBO(250, 250, 252, 1.0)); }
function darkTheme() { return new ThemeData(colorRGBO(187, 134, 252, 1.0), colorRGBO(20, 18, 30, 1.0), colorRGBO(30, 30, 38, 1.0), colorRGBO(236, 236, 244, 1.0), colorRGBO(18, 18, 24, 1.0)); }
let DEFAULT_THEME = lightTheme();

// Theme: an InheritedWidget carrying ThemeData; Theme.of(context) depends on it.
class ThemeWidget extends InheritedWidget {
    constructor(p) { super(p); this.data = p.data; }
    typeName() { return "Theme"; }
    updateShouldNotify(oldWidget) { return true; }
}
function Theme(p) { return new ThemeWidget(p); }
function themeOf(context) {
    let w = context.dependOnInheritedWidgetOfExactType("Theme");
    if (w == 0) { return DEFAULT_THEME; }
    return w.data;
}

// ------------------------------------------------------------ MaterialApp -----
class MaterialAppWidget extends StatelessWidget {
    constructor(p) { super(p); this.theme = DEFAULT_THEME; if (has(p, "theme")) { this.theme = p.theme; } }
    typeName() { return "MaterialApp"; }
    build(context) { return new ThemeWidget({ data: this.theme, child: this.p.home }); }
}

// --------------------------------------------------------------- Scaffold -----
class ScaffoldWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Scaffold"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let kids = [];
        if (has(p, "appBar")) { push(kids, p.appBar); }
        if (has(p, "body")) { push(kids, Expanded({ child: p.body })); }
        return Container({
            color: theme.background,
            child: Column({ mainAxisSize: "max", crossAxisAlignment: "stretch", children: kids }),
        });
    }
}

// ----------------------------------------------------------------- AppBar -----
class AppBarWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "AppBar"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let title = ""; if (has(p, "title")) { title = p.title; }
        return Container({
            color: theme.primary,
            padding: edgeOnly(20.0, 18.0, 20.0, 16.0),
            child: Row({
                mainAxisAlignment: "spaceBetween", crossAxisAlignment: "center",
                children: [
                    Text(title, { fontSize: 20.0, color: theme.onPrimary }),
                    new IconWidget({ icon: "menu", size: 22.0, color: theme.onPrimary }),
                ],
            }),
        });
    }
}

// ----------------------------------------------------------- ElevatedButton ---
class ElevatedButtonWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "ElevatedButton"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let onPressed = 0; if (has(p, "onPressed")) { onPressed = p.onPressed; }
        let label = ""; if (has(p, "label")) { label = p.label; }
        let bg = theme.primary; if (has(p, "color")) { bg = p.color; }
        return GestureDetector({
            onTap: onPressed,
            child: Container({
                padding: edgeSymmetric(22.0, 13.0),
                decoration: { color: bg, borderRadius: 22.0, boxShadow: [{ color: withOpacity(Colors.black, 0.22), blur: 10.0, dy: 4.0 }] },
                child: Text(label, { fontSize: 15.0, color: theme.onPrimary, textAlign: "center" }),
            }),
        });
    }
}

// ------------------------------------------------------------------- Icon -----
// A leaf render object that paints one of a small built-in icon set through the
// dart:ui Canvas (the Material IconEngine subset).
class RenderIcon extends RenderBox {
    constructor(name, sz, color) { super(); this.iconName = name; this.sz = sz; this.color = color; }
    performLayout() { this.size = this._constraints.constrain(new Size(this.sz, this.sz)); }
    paint(context, off) {
        let r = this.sz * 0.5; let cx = off.dx + this.size.width / 2.0; let cy = off.dy + this.size.height / 2.0;
        let t = r * 0.2; let c = this.color; let p = context.canvas.painter;
        let n = this.iconName;
        if (n == "add") { p.line(cx - r * 0.6, cy, cx + r * 0.6, cy, t, c); p.line(cx, cy - r * 0.6, cx, cy + r * 0.6, t, c); return 0; }
        if (n == "close") { p.line(cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5, t, c); p.line(cx - r * 0.5, cy + r * 0.5, cx + r * 0.5, cy - r * 0.5, t, c); return 0; }
        if (n == "check") { p.line(cx - r * 0.55, cy + r * 0.05, cx - r * 0.12, cy + r * 0.5, t, c); p.line(cx - r * 0.12, cy + r * 0.5, cx + r * 0.6, cy - r * 0.45, t, c); return 0; }
        if (n == "menu") { p.line(cx - r * 0.6, cy - r * 0.4, cx + r * 0.6, cy - r * 0.4, t, c); p.line(cx - r * 0.6, cy, cx + r * 0.6, cy, t, c); p.line(cx - r * 0.6, cy + r * 0.4, cx + r * 0.6, cy + r * 0.4, t, c); return 0; }
        if (n == "favorite") { p.circle(cx - r * 0.28, cy - r * 0.16, r * 0.32, c); p.circle(cx + r * 0.28, cy - r * 0.16, r * 0.32, c); p.rrect(cx, cy + r * 0.12, r * 0.42, r * 0.42, r * 0.12, 0.0, 0.785, c, CLEAR); return 0; }
        if (n == "star") { let i = 0; while (i < 5) { let a = i * 1.2566 - 1.5708; p.line(cx, cy, cx + cos(a) * r * 0.78, cy + sin(a) * r * 0.78, t * 1.5, c); i = i + 1; } return 0; }
        if (n == "home") { p.line(cx - r * 0.6, cy - r * 0.05, cx, cy - r * 0.6, t, c); p.line(cx, cy - r * 0.6, cx + r * 0.6, cy - r * 0.05, t, c); p.line(cx - r * 0.42, cy - r * 0.1, cx - r * 0.42, cy + r * 0.55, t, c); p.line(cx + r * 0.42, cy - r * 0.1, cx + r * 0.42, cy + r * 0.55, t, c); p.line(cx - r * 0.42, cy + r * 0.55, cx + r * 0.42, cy + r * 0.55, t, c); return 0; }
        p.circle(cx, cy, r * 0.5, c);
    }
}
class IconWidget extends LeafRenderObjectWidget {
    constructor(p) { super(p); this.icon = "star"; if (has(p, "icon")) { this.icon = p.icon; } this.sz = 24.0; if (has(p, "size")) { this.sz = p.size; } this.color = Colors.black; if (has(p, "color")) { this.color = p.color; } }
    typeName() { return "Icon"; }
    createRenderObject(context) { return new RenderIcon(this.icon, this.sz, this.color); }
    updateRenderObject(context, ro) { ro.iconName = this.icon; ro.sz = this.sz; ro.color = this.color; ro.markNeedsLayout(); }
}

// ----------------------------------------------------------- CustomPaint ------
// A leaf render object that hands a dart:ui Canvas and its Size to an app
// `painter(canvas, size)` callback — Flutter's CustomPaint / CustomPainter.
class RenderCustomPaint extends RenderBox {
    constructor(painterFn, prefW, prefH) { super(); this.painterFn = painterFn; this.prefW = prefW; this.prefH = prefH; }
    performLayout() {
        let w = this.prefW; let h = this.prefH;
        if (w < 0.0) { if (this._constraints.hasBoundedWidth()) { w = this._constraints.maxW; } else { w = 0.0; } }
        if (h < 0.0) { if (this._constraints.hasBoundedHeight()) { h = this._constraints.maxH; } else { h = 0.0; } }
        this.size = this._constraints.constrain(new Size(w, h));
    }
    paint(context, off) {
        let canvas = context.canvas;
        canvas.save(); canvas.translate(off.dx, off.dy);
        this.painterFn(canvas, this.size);
        canvas.restore();
    }
}
class CustomPaintWidget extends LeafRenderObjectWidget {
    constructor(p) { super(p); this.painterFn = p.painter; this.prefW = -1.0; this.prefH = -1.0; if (has(p, "width")) { this.prefW = p.width; } if (has(p, "height")) { this.prefH = p.height; } }
    typeName() { return "CustomPaint"; }
    createRenderObject(context) { return new RenderCustomPaint(this.painterFn, this.prefW, this.prefH); }
    updateRenderObject(context, ro) { ro.painterFn = this.painterFn; ro.prefW = this.prefW; ro.prefH = this.prefH; ro.markNeedsPaint(); }
}

// ------------------------------------------------------- public constructors --
function MaterialApp(p) { return new MaterialAppWidget(p); }
function Scaffold(p) { return new ScaffoldWidget(p); }
function AppBar(p) { return new AppBarWidget(p); }
function ElevatedButton(p) { return new ElevatedButtonWidget(p); }
function Icon(p) { return new IconWidget(p); }
function CustomPaint(p) { return new CustomPaintWidget(p); }
