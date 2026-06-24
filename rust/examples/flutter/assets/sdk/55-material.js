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
// A stateful Scaffold: appBar over body over an optional bottom nav, with a
// floating action button and a slide-in Drawer (scrim + AnimatedPositioned). A
// ScaffoldScope exposes the state so an AppBar's menu button can openDrawer().
class ScaffoldScope extends InheritedWidget {
    constructor(p) { super(p); this.stateObj = p.stateObj; }
    typeName() { return "ScaffoldScope"; }
    updateShouldNotify(o) { return true; }
}
function scaffoldOf(context) { let w = context.dependOnInheritedWidgetOfExactType("ScaffoldScope"); if (w == 0) { return 0; } return w.stateObj; }

class ScaffoldWidget extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "Scaffold"; }
    createState() { return new ScaffoldState(); }
}
class ScaffoldState extends State {
    initState() { this.drawerOpen = 0.0; }
    openDrawer() { let self = this; this.setState(() => { self.drawerOpen = 1.0; }); }
    closeDrawer() { let self = this; this.setState(() => { self.drawerOpen = 0.0; }); }
    hasDrawer() { return has(this.widget.p, "drawer"); }
    build(context) {
        let theme = themeOf(context); let p = this.widget.p; let self = this;
        let col = [];
        if (has(p, "appBar")) { push(col, p.appBar); }
        if (has(p, "body")) { push(col, Expanded({ child: p.body })); }
        if (has(p, "bottomNavigationBar")) { push(col, p.bottomNavigationBar); }
        let base = Container({ color: theme.background, child: Column({ mainAxisSize: "max", crossAxisAlignment: "stretch", children: col }) });
        let stackKids = [base];
        if (has(p, "floatingActionButton")) {
            let fb = 24.0; if (has(p, "bottomNavigationBar")) { fb = 86.0; }
            push(stackKids, Positioned({ right: 22.0, bottom: fb, child: p.floatingActionButton }));
        }
        if (has(p, "drawer")) {
            let open = this.drawerOpen > 0.5;
            push(stackKids, Positioned({ left: 0.0, top: 0.0, right: 0.0, bottom: 0.0,
                child: IgnorePointer({ ignoring: !open, child: GestureDetector({ onTap: () => { self.closeDrawer(); },
                    child: AnimatedOpacity({ opacity: open ? 1.0 : 0.0, duration: 220.0,
                        child: Container({ color: withOpacity(Colors.black, 0.45) }) }) }) }) }));
            push(stackKids, AnimatedPositioned({ duration: 260.0, curve: Curves.fastOutSlowIn,
                left: open ? 0.0 : -300.0, top: 0.0, bottom: 0.0, width: 288.0, child: p.drawer }));
        }
        return new ScaffoldScope({ stateObj: self, child: new StackWidget({ fit: "expand", children: stackKids }) });
    }
}

// ----------------------------------------------------------------- AppBar -----
class AppBarWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "AppBar"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let title = ""; if (has(p, "title")) { title = p.title; }
        let bg = theme.primary; if (has(p, "backgroundColor")) { bg = p.backgroundColor; }
        let fg = theme.onPrimary; if (has(p, "foregroundColor")) { fg = p.foregroundColor; }
        let elev = 3.0; if (has(p, "elevation")) { elev = p.elevation; }
        let scaffold = scaffoldOf(context);
        let leading = 0;
        if (has(p, "leading")) { leading = p.leading; }
        else { if (scaffold != 0) { if (scaffold.hasDrawer()) { leading = IconButton({ icon: "menu", color: fg, onPressed: () => { scaffold.openDrawer(); } }); } } }
        let left = [];
        if (leading != 0) { push(left, leading); push(left, SizedBox({ width: 6.0 })); }
        push(left, Text(title, { fontSize: 20.0, color: fg }));
        let rowKids = [Row({ crossAxisAlignment: "center", children: left })];
        if (has(p, "actions")) { push(rowKids, Row({ crossAxisAlignment: "center", children: p.actions })); }
        let deco = { color: bg };
        if (elev > 0.0) { deco.boxShadow = [{ color: withOpacity(Colors.black, 0.18), blur: elev * 3.0, dy: elev }]; }
        return DecoratedBox({ decoration: deco, child: Padding({ padding: edgeOnly(8.0, 16.0, 12.0, 14.0),
            child: Row({ mainAxisAlignment: "spaceBetween", crossAxisAlignment: "center", children: rowKids }) }) });
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
        if (n == "search") { p.ring(cx - r * 0.15, cy - r * 0.15, r * 0.38, t, c); p.line(cx + r * 0.14, cy + r * 0.14, cx + r * 0.55, cy + r * 0.55, t, c); return 0; }
        if (n == "settings") { p.ring(cx, cy, r * 0.36, t, c); p.circle(cx, cy, r * 0.13, c); let i = 0; while (i < 8) { let a = i * 0.7853; p.line(cx + cos(a) * r * 0.46, cy + sin(a) * r * 0.46, cx + cos(a) * r * 0.62, cy + sin(a) * r * 0.62, t, c); i = i + 1; } return 0; }
        if (n == "person") { p.circle(cx, cy - r * 0.32, r * 0.26, c); p.rrect(cx, cy + r * 0.42, r * 0.42, r * 0.28, r * 0.28, 0.0, 0.0, c, CLEAR); return 0; }
        if (n == "shopping_cart") { p.line(cx - r * 0.6, cy - r * 0.4, cx - r * 0.4, cy - r * 0.4, t, c); p.line(cx - r * 0.4, cy - r * 0.4, cx - r * 0.18, cy + r * 0.25, t, c); p.line(cx - r * 0.18, cy + r * 0.25, cx + r * 0.5, cy + r * 0.25, t, c); p.line(cx - r * 0.3, cy - r * 0.12, cx + r * 0.58, cy - r * 0.12, t, c); p.line(cx + r * 0.58, cy - r * 0.12, cx + r * 0.5, cy + r * 0.25, t, c); p.circle(cx - r * 0.1, cy + r * 0.5, r * 0.1, c); p.circle(cx + r * 0.4, cy + r * 0.5, r * 0.1, c); return 0; }
        if (n == "arrow_back") { p.line(cx - r * 0.55, cy, cx + r * 0.55, cy, t, c); p.line(cx - r * 0.55, cy, cx - r * 0.1, cy - r * 0.42, t, c); p.line(cx - r * 0.55, cy, cx - r * 0.1, cy + r * 0.42, t, c); return 0; }
        if (n == "arrow_forward") { p.line(cx - r * 0.55, cy, cx + r * 0.55, cy, t, c); p.line(cx + r * 0.55, cy, cx + r * 0.1, cy - r * 0.42, t, c); p.line(cx + r * 0.55, cy, cx + r * 0.1, cy + r * 0.42, t, c); return 0; }
        if (n == "chevron_right") { p.line(cx - r * 0.18, cy - r * 0.4, cx + r * 0.28, cy, t, c); p.line(cx + r * 0.28, cy, cx - r * 0.18, cy + r * 0.4, t, c); return 0; }
        if (n == "chevron_left") { p.line(cx + r * 0.18, cy - r * 0.4, cx - r * 0.28, cy, t, c); p.line(cx - r * 0.28, cy, cx + r * 0.18, cy + r * 0.4, t, c); return 0; }
        if (n == "more_vert") { p.circle(cx, cy - r * 0.42, t * 0.9, c); p.circle(cx, cy, t * 0.9, c); p.circle(cx, cy + r * 0.42, t * 0.9, c); return 0; }
        if (n == "more_horiz") { p.circle(cx - r * 0.42, cy, t * 0.9, c); p.circle(cx, cy, t * 0.9, c); p.circle(cx + r * 0.42, cy, t * 0.9, c); return 0; }
        if (n == "notifications") { p.rrect(cx, cy - r * 0.05, r * 0.34, r * 0.36, r * 0.3, 0.0, 0.0, c, CLEAR); p.line(cx - r * 0.42, cy + r * 0.32, cx + r * 0.42, cy + r * 0.32, t, c); p.circle(cx, cy + r * 0.52, r * 0.1, c); return 0; }
        if (n == "play_arrow") { p.line(cx - r * 0.32, cy - r * 0.45, cx - r * 0.32, cy + r * 0.45, t, c); p.line(cx - r * 0.32, cy - r * 0.45, cx + r * 0.45, cy, t, c); p.line(cx - r * 0.32, cy + r * 0.45, cx + r * 0.45, cy, t, c); return 0; }
        if (n == "pause") { p.rrect(cx - r * 0.24, cy, r * 0.1, r * 0.42, r * 0.04, 0.0, 0.0, c, CLEAR); p.rrect(cx + r * 0.24, cy, r * 0.1, r * 0.42, r * 0.04, 0.0, 0.0, c, CLEAR); return 0; }
        if (n == "delete") { p.line(cx - r * 0.4, cy - r * 0.3, cx + r * 0.4, cy - r * 0.3, t, c); p.line(cx - r * 0.32, cy - r * 0.3, cx - r * 0.26, cy + r * 0.5, t, c); p.line(cx + r * 0.32, cy - r * 0.3, cx + r * 0.26, cy + r * 0.5, t, c); p.line(cx - r * 0.26, cy + r * 0.5, cx + r * 0.26, cy + r * 0.5, t, c); p.line(cx - r * 0.16, cy - r * 0.45, cx + r * 0.16, cy - r * 0.45, t, c); return 0; }
        if (n == "edit") { p.line(cx - r * 0.45, cy + r * 0.45, cx + r * 0.35, cy - r * 0.35, t, c); p.line(cx + r * 0.35, cy - r * 0.35, cx + r * 0.5, cy - r * 0.2, t, c); p.line(cx + r * 0.5, cy - r * 0.2, cx - r * 0.3, cy + r * 0.55, t, c); p.line(cx - r * 0.45, cy + r * 0.45, cx - r * 0.5, cy + r * 0.55, t, c); return 0; }
        if (n == "share") { p.circle(cx - r * 0.4, cy, r * 0.14, c); p.circle(cx + r * 0.4, cy - r * 0.4, r * 0.14, c); p.circle(cx + r * 0.4, cy + r * 0.4, r * 0.14, c); p.line(cx - r * 0.28, cy - r * 0.08, cx + r * 0.28, cy - r * 0.34, t, c); p.line(cx - r * 0.28, cy + r * 0.08, cx + r * 0.28, cy + r * 0.34, t, c); return 0; }
        if (n == "info") { p.ring(cx, cy, r * 0.5, t, c); p.circle(cx, cy - r * 0.24, t * 0.8, c); p.line(cx, cy - r * 0.05, cx, cy + r * 0.3, t, c); return 0; }
        if (n == "location") { p.ring(cx, cy - r * 0.12, r * 0.3, t, c); p.line(cx - r * 0.26, cy + r * 0.05, cx, cy + r * 0.55, t, c); p.line(cx + r * 0.26, cy + r * 0.05, cx, cy + r * 0.55, t, c); return 0; }
        if (n == "remove") { p.line(cx - r * 0.55, cy, cx + r * 0.55, cy, t, c); return 0; }
        if (n == "music_note") { p.circle(cx - r * 0.2, cy + r * 0.38, r * 0.16, c); p.line(cx - r * 0.05, cy + r * 0.38, cx - r * 0.05, cy - r * 0.45, t, c); p.line(cx - r * 0.05, cy - r * 0.45, cx + r * 0.4, cy - r * 0.32, t, c); return 0; }
        if (n == "bookmark") { p.line(cx - r * 0.32, cy - r * 0.45, cx - r * 0.32, cy + r * 0.5, t, c); p.line(cx + r * 0.32, cy - r * 0.45, cx + r * 0.32, cy + r * 0.5, t, c); p.line(cx - r * 0.32, cy - r * 0.45, cx + r * 0.32, cy - r * 0.45, t, c); p.line(cx - r * 0.32, cy + r * 0.5, cx, cy + r * 0.2, t, c); p.line(cx + r * 0.32, cy + r * 0.5, cx, cy + r * 0.2, t, c); return 0; }
        p.circle(cx, cy, r * 0.5, c);
    }
}
class IconWidget extends LeafRenderObjectWidget {
    constructor(p) { super(p); this.icon = "star"; if (has(p, "icon")) { this.icon = p.icon; } this.sz = 24.0; if (has(p, "size")) { this.sz = p.size; } this.color = Colors.black; if (has(p, "color")) { this.color = p.color; } }
    typeName() { return "Icon"; }
    createRenderObject(context) { return new RenderIcon(this.icon, this.sz, this.color); }
    updateRenderObject(context, ro) { ro.iconName = this.icon; ro.sz = this.sz; ro.color = this.color; ro.markNeedsLayout(); }
}

// ================================================ extended Material catalog ===

// ---- Material surface + Card ----
class MaterialWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Material"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let color = has(p, "color") ? p.color : theme.surface;
        let elev = has(p, "elevation") ? p.elevation : 0.0;
        let r = has(p, "borderRadius") ? p.borderRadius : 0.0;
        let deco = { color: color, borderRadius: r };
        if (elev > 0.0) { deco.boxShadow = [{ color: withOpacity(Colors.black, 0.20), blur: elev * 2.6, dy: elev * 0.7 }]; }
        return Container({ decoration: deco, child: has(p, "child") ? p.child : 0 });
    }
}
function Material(p) { return new MaterialWidget(p); }
function Card(p) {
    if (isNull(p)) { p = {}; }
    let r = has(p, "borderRadius") ? p.borderRadius : 12.0;
    let elev = has(p, "elevation") ? p.elevation : 2.0;
    let margin = has(p, "margin") ? p.margin : edgeAll(6.0);
    let q = { elevation: elev, borderRadius: r };
    if (has(p, "color")) { q.color = p.color; }
    if (has(p, "child")) { q.child = ClipRRect({ borderRadius: r, child: p.child }); }
    return Padding({ padding: margin, child: Material(q) });
}

// ---- ListTile ----
class ListTileWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "ListTile"; }
    build(context) {
        let theme = themeOf(context); let p = this.p; let row = [];
        if (has(p, "leading")) { push(row, p.leading); push(row, SizedBox({ width: 16.0 })); }
        let titleCol = [];
        if (has(p, "title")) { push(titleCol, Text(p.title, { fontSize: 16.0, color: theme.onSurface })); }
        if (has(p, "subtitle")) { push(titleCol, SizedBox({ height: 3.0 })); push(titleCol, Text(p.subtitle, { fontSize: 13.0, color: withOpacity(theme.onSurface, 0.6) })); }
        push(row, Expanded({ child: Column({ crossAxisAlignment: "start", mainAxisSize: "min", children: titleCol }) }));
        if (has(p, "trailing")) { push(row, SizedBox({ width: 12.0 })); push(row, p.trailing); }
        let tile = Padding({ padding: edgeSymmetric(16.0, 12.0), child: Row({ crossAxisAlignment: "center", children: row }) });
        if (has(p, "onTap")) { return GestureDetector({ onTap: p.onTap, child: tile }); }
        return tile;
    }
}
function ListTile(p) { return new ListTileWidget(p); }

// ---- Buttons ----
class IconButtonWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "IconButton"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let color = has(p, "color") ? p.color : theme.onSurface;
        let sz = has(p, "size") ? p.size : 24.0;
        return GestureDetector({ onTap: has(p, "onPressed") ? p.onPressed : 0,
            child: Container({ padding: edgeAll(8.0), child: new IconWidget({ icon: p.icon, size: sz, color: color }) }) });
    }
}
function IconButton(p) { return new IconButtonWidget(p); }
class TextButtonWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "TextButton"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let color = has(p, "color") ? p.color : theme.primary;
        return GestureDetector({ onTap: has(p, "onPressed") ? p.onPressed : 0,
            child: Container({ padding: edgeSymmetric(16.0, 10.0), child: Text(p.label, { fontSize: 14.0, color: color }) }) });
    }
}
function TextButton(p) { return new TextButtonWidget(p); }
class OutlinedButtonWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "OutlinedButton"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let color = has(p, "color") ? p.color : theme.primary;
        return GestureDetector({ onTap: has(p, "onPressed") ? p.onPressed : 0,
            child: Container({ padding: edgeSymmetric(20.0, 11.0),
                decoration: { borderRadius: 22.0, border: { width: 1.4, color: withOpacity(color, 0.7) } },
                child: Text(p.label, { fontSize: 14.0, color: color, textAlign: "center" }) }) });
    }
}
function OutlinedButton(p) { return new OutlinedButtonWidget(p); }
class FloatingActionButtonWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "FloatingActionButton"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let bg = has(p, "backgroundColor") ? p.backgroundColor : theme.primary;
        let fg = has(p, "foregroundColor") ? p.foregroundColor : theme.onPrimary;
        let icon = has(p, "icon") ? p.icon : "add";
        let child = has(p, "child") ? p.child : new IconWidget({ icon: icon, size: 26.0, color: fg });
        let d = 58.0; if (has(p, "mini")) { if (p.mini) { d = 42.0; } }
        return GestureDetector({ onTap: has(p, "onPressed") ? p.onPressed : 0,
            child: Container({ width: d, height: d, alignment: Alignments.center,
                decoration: { color: bg, borderRadius: d / 2.0, boxShadow: [{ color: withOpacity(Colors.black, 0.3), blur: 12.0, dy: 5.0 }] },
                child: child }) });
    }
}
function FloatingActionButton(p) { return new FloatingActionButtonWidget(p); }
function InkWell(p) { return GestureDetector({ onTap: has(p, "onTap") ? p.onTap : 0, child: has(p, "child") ? p.child : 0 }); }

// ---- Switch / Checkbox / Radio (themed, animated via TweenAnimationBuilder) ---
class SwitchWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Switch"; }
    build(context) {
        let theme = themeOf(context); let p = this.p; let on = p.value;
        let active = has(p, "activeColor") ? p.activeColor : theme.primary;
        let onChanged = has(p, "onChanged") ? p.onChanged : 0;
        let target = on ? 1.0 : 0.0;
        return GestureDetector({ onTap: () => { if (onChanged != 0) { onChanged(!on); } },
            child: TweenAnimationBuilder({ tween: new Tween(target, target), duration: 170.0, curve: Curves.easeInOut,
                builder: (ctx, t, ch) => {
                    let track = lerpCol(colorRGBO(140, 140, 150, 0.5), withOpacity(active, 0.95), t);
                    let tx = 3.0 + t * 20.0;
                    return Container({ width: 50.0, height: 30.0, decoration: { color: track, borderRadius: 15.0 },
                        child: Stack({ children: [ Positioned({ left: tx, top: 3.0,
                            child: Container({ width: 24.0, height: 24.0, decoration: { color: Colors.white, borderRadius: 12.0, boxShadow: [{ color: withOpacity(Colors.black, 0.25), blur: 4.0, dy: 1.0 }] } }) }) ] }) });
                } }) });
    }
}
function Switch(p) { return new SwitchWidget(p); }
class CheckboxWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Checkbox"; }
    build(context) {
        let theme = themeOf(context); let p = this.p; let on = p.value;
        let active = has(p, "activeColor") ? p.activeColor : theme.primary;
        let onChanged = has(p, "onChanged") ? p.onChanged : 0;
        let target = on ? 1.0 : 0.0;
        return GestureDetector({ onTap: () => { if (onChanged != 0) { onChanged(!on); } },
            child: TweenAnimationBuilder({ tween: new Tween(target, target), duration: 150.0, curve: Curves.easeOut,
                builder: (ctx, t, ch) => {
                    let fill = lerpCol(CLEAR, active, t);
                    let border = lerpCol(colorRGBO(120, 120, 130, 1.0), active, t);
                    let mark = SizedBox({ width: 16.0, height: 16.0 });
                    if (t > 0.25) { mark = Opacity({ opacity: clamp01((t - 0.25) / 0.75), child: new IconWidget({ icon: "check", size: 16.0, color: theme.onPrimary }) }); }
                    return Container({ width: 22.0, height: 22.0, alignment: Alignments.center,
                        decoration: { color: fill, borderRadius: 5.0, border: { width: 2.0, color: border } }, child: mark });
                } }) });
    }
}
function Checkbox(p) { return new CheckboxWidget(p); }
class RadioWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Radio"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let selected = p.value == p.groupValue;
        let active = has(p, "activeColor") ? p.activeColor : theme.primary;
        let onChanged = has(p, "onChanged") ? p.onChanged : 0;
        let target = selected ? 1.0 : 0.0;
        return GestureDetector({ onTap: () => { if (onChanged != 0) { onChanged(p.value); } },
            child: TweenAnimationBuilder({ tween: new Tween(target, target), duration: 150.0, curve: Curves.easeOut,
                builder: (ctx, t, ch) => {
                    let ringC = lerpCol(colorRGBO(120, 120, 130, 1.0), active, t);
                    return Container({ width: 22.0, height: 22.0, alignment: Alignments.center, decoration: { borderRadius: 11.0, border: { width: 2.0, color: ringC } },
                        child: Transform({ scale: t, child: Container({ width: 11.0, height: 11.0, decoration: { color: active, borderRadius: 6.0 } }) }) });
                } }) });
    }
}
function Radio(p) { return new RadioWidget(p); }

// ---- Slider (a leaf render object that owns its drag) ----
class RenderSlider extends RenderBox {
    constructor(value, onChanged, active, inactive) { super(); this.value = value; this.onChanged = onChanged; this.active = active; this.inactive = inactive; this._wantsPointer = 1.0; }
    performLayout() { let c = this._constraints; let w = c.hasBoundedWidth() ? c.maxW : 240.0; this.size = c.constrain(new Size(w, 36.0)); }
    hitTestSelf(pos) { return true; }
    handleEvent(event, local) {
        if (event.type == "pointerdown" || event.type == "pointermove") {
            let pad = 14.0; let usable = maxD(1.0, this.size.width - pad * 2.0);
            let f = clamp01((local.dx - pad) / usable);
            if (this.onChanged != 0) { this.onChanged(f); }
        }
    }
    paint(context, off) {
        let p = context.canvas.painter; let cy = off.dy + this.size.height / 2.0; let pad = 14.0;
        let usable = maxD(1.0, this.size.width - pad * 2.0); let x0 = off.dx + pad; let tx = x0 + usable * clamp01(this.value);
        p.rrect(x0 + usable / 2.0, cy, usable / 2.0, 2.5, 2.5, 0.0, 0.0, this.inactive, CLEAR);
        p.rrect((x0 + tx) / 2.0, cy, maxD(0.0, (tx - x0) / 2.0), 2.5, 2.5, 0.0, 0.0, this.active, CLEAR);
        p.circle(tx, cy, 10.0, this.active);
        p.circle(tx, cy, 6.0, Colors.white);
    }
}
class SliderLeaf extends LeafRenderObjectWidget {
    constructor(p) { super(p); this.value = p.value; this.onChanged = p.onChanged; this.active = p.active; this.inactive = p.inactive; }
    typeName() { return "Slider"; }
    createRenderObject(context) { return new RenderSlider(this.value, this.onChanged, this.active, this.inactive); }
    updateRenderObject(context, ro) { ro.value = this.value; ro.onChanged = this.onChanged; ro.active = this.active; ro.inactive = this.inactive; ro.markNeedsPaint(); }
}
class SliderWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "SliderBox"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let active = has(p, "activeColor") ? p.activeColor : theme.primary;
        let inactive = has(p, "inactiveColor") ? p.inactiveColor : withOpacity(active, 0.24);
        return new SliderLeaf({ value: p.value, onChanged: has(p, "onChanged") ? p.onChanged : 0, active: active, inactive: inactive });
    }
}
function Slider(p) { return new SliderWidget(p); }

// ---- Progress indicators ----
class LinearProgressIndicatorWidget extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "LinearProgressIndicator"; }
    createState() { return new LinearProgressIndicatorState(); }
}
class LinearProgressIndicatorState extends State {
    initState() { this.controller = new AnimationController({ duration: 1300.0 }); if (!has(this.widget.p, "value")) { this.controller.repeat(); } }
    dispose() { this.controller.dispose(); }
    build(context) {
        let theme = themeOf(context); let p = this.widget.p; let self = this;
        let color = has(p, "color") ? p.color : theme.primary; let bg = withOpacity(color, 0.2);
        if (has(p, "value")) {
            let v = clamp01(p.value);
            return ClipRRect({ borderRadius: 3.0, child: Container({ height: 6.0, color: bg,
                child: Align({ alignment: Alignments.centerLeft, child: FractionallySizedBox({ widthFactor: v, heightFactor: 1.0, child: Container({ color: color }) }) }) }) });
        }
        return ClipRRect({ borderRadius: 3.0, child: Container({ height: 6.0, color: bg,
            child: AnimatedBuilder({ animation: this.controller, builder: (ctx, ch) => {
                let t = self.controller.value();
                return Align({ alignment: new Alignment(lerpD(-1.0, 1.0, t), 0.0),
                    child: FractionallySizedBox({ widthFactor: 0.32, heightFactor: 1.0, child: Container({ decoration: { color: color, borderRadius: 3.0 } }) }) });
            } }) }) });
    }
}
function LinearProgressIndicator(p) { return new LinearProgressIndicatorWidget(p); }
class CircularProgressIndicatorWidget extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "CircularProgressIndicator"; }
    createState() { return new CircularProgressIndicatorState(); }
}
class CircularProgressIndicatorState extends State {
    initState() { this.controller = new AnimationController({ duration: 1100.0 }); this.controller.repeat(); }
    dispose() { this.controller.dispose(); }
    build(context) {
        let theme = themeOf(context); let p = this.widget.p; let self = this;
        let color = has(p, "color") ? p.color : theme.primary; let sz = has(p, "size") ? p.size : 38.0;
        return AnimatedBuilder({ animation: this.controller, builder: (ctx, ch) => {
            let t = self.controller.value();
            return CustomPaint({ width: sz, height: sz, painter: (canvas, s) => {
                let pr = canvas.painter; let cx = s.width / 2.0; let cy = s.height / 2.0; let rad = s.width / 2.0 - 3.0;
                pr.ring(cx, cy, rad, 3.0, withOpacity(color, 0.16));
                let start = t * _TAU; let sweep = 4.3; let segs = 22;
                for (let i = 0; i <= segs; i++) {
                    let a = start + sweep * (num(i) / segs);
                    pr.circle(cx + cos(a) * rad, cy + sin(a) * rad, 1.8, color);
                }
            } });
        } });
    }
}
function CircularProgressIndicator(p) { return new CircularProgressIndicatorWidget(p); }

// ---- Chip / CircleAvatar ----
class ChipWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Chip"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let bg = has(p, "color") ? p.color : withOpacity(theme.primary, 0.12);
        let fg = has(p, "labelColor") ? p.labelColor : theme.primary; let row = [];
        if (has(p, "avatar")) { push(row, p.avatar); push(row, SizedBox({ width: 6.0 })); }
        push(row, Text(p.label, { fontSize: 13.0, color: fg }));
        if (has(p, "onDeleted")) { push(row, SizedBox({ width: 4.0 })); push(row, GestureDetector({ onTap: p.onDeleted, child: new IconWidget({ icon: "close", size: 14.0, color: fg }) })); }
        let chip = Container({ padding: edgeSymmetric(12.0, 7.0), decoration: { color: bg, borderRadius: 16.0 }, child: Row({ mainAxisSize: "min", crossAxisAlignment: "center", children: row }) });
        if (has(p, "onTap")) { return GestureDetector({ onTap: p.onTap, child: chip }); }
        return chip;
    }
}
function Chip(p) { return new ChipWidget(p); }
class CircleAvatarWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "CircleAvatar"; }
    build(context) {
        let theme = themeOf(context); let p = this.p;
        let bg = has(p, "backgroundColor") ? p.backgroundColor : theme.primary;
        let r = has(p, "radius") ? p.radius : 20.0;
        return Container({ width: r * 2.0, height: r * 2.0, alignment: Alignments.center, decoration: { color: bg, borderRadius: r }, child: has(p, "child") ? p.child : 0 });
    }
}
function CircleAvatar(p) { return new CircleAvatarWidget(p); }

// ---- Drawer ----
class DrawerWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "Drawer"; }
    build(context) {
        let theme = themeOf(context);
        return Container({ decoration: { color: theme.surface, boxShadow: [{ color: withOpacity(Colors.black, 0.28), blur: 20.0, dx: 4.0 }] }, child: has(this.p, "child") ? this.p.child : 0 });
    }
}
function Drawer(p) { return new DrawerWidget(p); }
function DrawerHeader(p) {
    let theme = DEFAULT_THEME; let bg = has(p, "color") ? p.color : 0;
    let deco = 0; if (has(p, "gradient")) { deco = { gradient: p.gradient }; } else { if (bg != 0) { deco = { color: bg }; } }
    let q = { padding: edgeAll(18.0), height: 160.0, alignment: Alignments.bottomLeft, child: p.child };
    if (deco != 0) { q.decoration = deco; }
    return Container(q);
}

// ---- BottomNavigationBar ----
class BottomNavigationBarWidget extends StatelessWidget {
    constructor(p) { super(p); }
    typeName() { return "BottomNavigationBar"; }
    build(context) {
        let theme = themeOf(context); let p = this.p; let items = p.items;
        let current = has(p, "currentIndex") ? p.currentIndex : 0;
        let onTap = has(p, "onTap") ? p.onTap : 0;
        let active = has(p, "selectedItemColor") ? p.selectedItemColor : theme.primary;
        let inactive = has(p, "unselectedItemColor") ? p.unselectedItemColor : withOpacity(theme.onSurface, 0.5);
        let row = [];
        for (let i = 0; i < len(items); i++) {
            let sel = i == current; let col = inactive; if (sel) { col = active; }
            let it = items[i]; let idx = i;
            push(row, Expanded({ child: GestureDetector({ onTap: () => { if (onTap != 0) { onTap(idx); } },
                child: Container({ padding: edgeSymmetric(4.0, 8.0), color: withOpacity(Colors.white, 0.0), alignment: Alignments.center,
                    child: Column({ mainAxisSize: "min", crossAxisAlignment: "center", children: [
                        new IconWidget({ icon: it.icon, size: sel ? 26.0 : 23.0, color: col }),
                        SizedBox({ height: 4.0 }),
                        Text(it.label, { fontSize: 11.0, color: col, textAlign: "center" }),
                    ] }) }) }) }));
        }
        return Container({ decoration: { color: theme.surface, boxShadow: [{ color: withOpacity(Colors.black, 0.12), blur: 10.0, dy: -2.0 }] },
            padding: edgeOnly(4.0, 8.0, 4.0, 10.0), child: Row({ mainAxisAlignment: "spaceBetween", crossAxisAlignment: "center", children: row }) });
    }
}
function BottomNavigationBar(p) { return new BottomNavigationBarWidget(p); }
function BottomNavigationBarItem(icon, label) { return { icon: icon, label: label }; }

// ---- Tabs (TabBar + body with a sliding underline) ----
class TabsViewWidget extends StatefulWidget {
    constructor(p) { super(p); }
    typeName() { return "TabsView"; }
    createState() { return new TabsViewState(); }
}
class TabsViewState extends State {
    initState() { this.index = has(this.widget.p, "initialIndex") ? this.widget.p.initialIndex : 0; }
    build(context) {
        let theme = themeOf(context); let p = this.widget.p; let self = this;
        let tabs = p.tabs; let views = p.views; let count = num(len(tabs)); let tabRow = [];
        for (let i = 0; i < len(tabs); i++) {
            let sel = i == this.index; let col = withOpacity(theme.onSurface, 0.55); if (sel) { col = theme.primary; }
            let idx = i;
            push(tabRow, Expanded({ child: GestureDetector({ onTap: () => { self.setState(() => { self.index = idx; }); },
                child: Container({ padding: edgeSymmetric(8.0, 14.0), color: withOpacity(Colors.white, 0.0), alignment: Alignments.center,
                    child: Text(tabs[i], { fontSize: 14.0, color: col, textAlign: "center" }) }) }) }));
        }
        let frac = 0.0; if (count > 1.0) { frac = this.index / (count - 1.0); }
        let underline = SizedBox({ height: 3.0, child: AnimatedAlign({ duration: 240.0, curve: Curves.fastOutSlowIn,
            alignment: new Alignment(lerpD(-1.0, 1.0, frac), 0.0),
            child: FractionallySizedBox({ widthFactor: 1.0 / count, heightFactor: 1.0, child: Container({ decoration: { color: theme.primary, borderRadius: 2.0 } }) }) }) });
        let bar = Column({ mainAxisSize: "min", crossAxisAlignment: "stretch", children: [ Row({ children: tabRow }), SizedBox({ height: 2.0 }), underline ] });
        return Column({ mainAxisSize: "max", crossAxisAlignment: "stretch", children: [ bar, Expanded({ child: views[this.index] }) ] });
    }
}
function TabsView(p) { return new TabsViewWidget(p); }

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
