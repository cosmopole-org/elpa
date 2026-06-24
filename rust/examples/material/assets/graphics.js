// Elpa Material — graphics showcase application.
//
// A third app (alongside `demo.js` and `gallery.js`) that exercises the painting
// layer added in `33-graphics.js`: a full CustomPaint / Canvas scene, gradient
// fills (linear / radial / sweep), the Opacity / ColorFiltered / Transform /
// RotatedBox effect wrappers, and a BackdropFilter frosted-glass panel over a
// colourful background (the only multi-pass, offscreen-capture path in the kit).
// Like the others it uses the SDK as a black box — no gpu.submit, no coordinates.

let dark = 0.0;
let opa = 1.0;     // Opacity demo value, cycled by 'o'
let ang = 0.4;     // Transform rotation, nudged by 'r'
let blur = 2.2;    // BackdropFilter blur radius (units), nudged by 'b'/'B'

// A CustomPainter: every dart:ui Canvas command, drawn in the widget's units.
function scene(canvas, size) {
    let w = size.w; let h = size.h;
    // Background: a diagonal linear-gradient fill via a Paint shader.
    canvas.drawRect(0.0, 0.0, w, h, { shader: { type: "linear",
        colors: [[0.10, 0.16, 0.42, 1.0], [0.42, 0.12, 0.34, 1.0]], begin: [0.0, 0.0], end: [1.0, 1.0] } });
    // A faint grid (drawLine).
    for (let i = 0; i <= 9; i++) {
        canvas.drawLine(num(i) * w / 9.0, 0.0, num(i) * w / 9.0, h, { color: [1.0, 1.0, 1.0, 0.10], strokeWidth: 0.08 });
        canvas.drawLine(0.0, num(i) * h / 9.0, w, num(i) * h / 9.0, { color: [1.0, 1.0, 1.0, 0.10], strokeWidth: 0.08 });
    }
    // Filled + stroked circle (drawCircle, both Paint styles).
    canvas.drawCircle(w * 0.18, h * 0.36, 5.0, { color: [1.0, 0.72, 0.22, 1.0] });
    canvas.drawCircle(w * 0.18, h * 0.36, 5.0, { style: "stroke", strokeWidth: 0.35, color: [1.0, 1.0, 1.0, 0.95] });
    // Rounded rect + oval (drawRRect / drawOval).
    canvas.drawRRect(w * 0.34, h * 0.16, w * 0.52, h * 0.5, 1.4, { color: [0.20, 0.82, 0.55, 1.0] });
    canvas.drawOval(w * 0.56, h * 0.18, w * 0.74, h * 0.42, { color: [0.92, 0.32, 0.42, 1.0] });
    // A pie arc (drawArc, useCenter fill).
    canvas.drawArc(w * 0.76, h * 0.16, w * 0.96, h * 0.46, -1.5708, 4.4, 1.0, { color: [0.32, 0.6, 0.96, 1.0] });
    // A cubic-Bézier path stroke (Path + drawPath).
    let path = makePath();
    path.moveTo(2.0, h - 3.0);
    path.cubicTo(w * 0.3, h - 12.0, w * 0.6, h + 4.0, w - 2.0, h - 8.0);
    canvas.drawPath(path, { style: "stroke", strokeWidth: 0.45, color: [1.0, 1.0, 1.0, 0.92] });
    // A filled convex polygon (drawPath fill, fan approximation).
    let tri = makePath(); tri.moveTo(w * 0.5, h * 0.55); tri.lineTo(w * 0.6, h * 0.72); tri.lineTo(w * 0.4, h * 0.72); tri.close();
    canvas.drawPath(tri, { color: [0.95, 0.85, 0.30, 0.85] });
    // A poly-line of points (drawPoints).
    let pts = [];
    for (let i = 0; i < 9; i++) { push(pts, [2.0 + num(i) * (w - 4.0) / 8.0, h * 0.62 + sin(num(i) * 0.9) * 2.4]); }
    canvas.drawPoints("polygon", pts, { strokeWidth: 0.22, color: [1.0, 0.9, 0.45, 0.95] });
    // A rotated, non-uniformly scaled square via the transform stack.
    canvas.save();
    canvas.translate(w * 0.85, h * 0.7); canvas.rotate(0.7); canvas.scale(1.3, 0.8);
    canvas.drawRect(-3.5, -3.5, 3.5, 3.5, { color: [0.85, 0.85, 0.25, 0.85] });
    canvas.restore();
    // A soft shadow under a title, then the title text (drawShadow / drawText).
    canvas.drawShadow(w * 0.5 - 9.0, 1.0, w * 0.5 + 9.0, 5.0, 1.2, [0.0, 0.0, 0.0, 0.5], 1.6);
    canvas.drawText("CANVAS", w * 0.5, 3.0, { size: 0.8, color: [1.0, 1.0, 1.0, 1.0] });
}

let App = defineComponent(function(props, update) {
    setTheme(dark, 0);
    return Scaffold({
        onKey: (k) => {
            if (k == "d") { dark = 1.0 - dark; }
            if (k == "o") { opa = opa - 0.2; if (opa < 0.05) { opa = 1.0; } }
            if (k == "r") { ang = ang + 0.3; }
            if (k == "b") { blur = blur + 0.6; if (blur > 5.0) { blur = 0.6; } }
            update();
        },
        appBar: AppBar({ title: "GRAPHICS" }),
        body: ListView({ id: "body", surface: 1.0, children: [
            // The CustomPaint scene.
            Center({ child: CustomPaint({ width: 92.0, height: 60.0, paint: scene }) }),
            Divider({}),
            // Gradient fills: linear, radial, sweep.
            Row({ gap: 3.0, main: "center", children: [
                Container({ width: 22.0, height: 16.0, radius: 2.5,
                    gradient: LinearGradient([[0.95, 0.45, 0.2, 1.0], [0.6, 0.15, 0.5, 1.0]], { begin: [0.0, 0.0], end: [1.0, 0.0] }) }),
                Container({ width: 16.0, height: 16.0, radius: 8.0,
                    gradient: RadialGradient([[1.0, 0.95, 0.7, 1.0], [0.2, 0.3, 0.75, 1.0]]) }),
                Container({ width: 16.0, height: 16.0, radius: 8.0,
                    gradient: SweepGradient([[0.95, 0.3, 0.3, 1.0], [0.3, 0.85, 0.4, 1.0], [0.3, 0.4, 0.95, 1.0], [0.95, 0.3, 0.3, 1.0]]) }),
            ] }),
            Divider({}),
            // Effect wrappers: Opacity, ColorFiltered, Transform, RotatedBox.
            Row({ gap: 3.0, main: "center", children: [
                Opacity({ opacity: opa, child: Card({ child: Text("FADE", { size: "caption" }) }) }),
                ColorFiltered({ color: [1.0, 0.55, 0.55, 1.0], child: Card({ child: Text("TINT", { size: "caption" }) }) }),
                Transform({ angle: ang, child: Card({ child: Text("ROT", { size: "caption" }) }) }),
                RotatedBox({ turns: 1, child: Card({ child: Text("90", { size: "caption" }) }) }),
            ] }),
            Divider({}),
            // BackdropFilter frosted glass over a sweep-gradient backdrop.
            Center({ child: Stack({ width: 92.0, height: 30.0, children: [
                Container({ width: 92.0, height: 30.0, radius: 3.0,
                    gradient: LinearGradient([[0.95, 0.4, 0.2, 1.0], [0.3, 0.8, 0.9, 1.0], [0.6, 0.3, 0.9, 1.0]], { begin: [0.0, 0.0], end: [1.0, 0.0] }) }),
                Center({ child: BackdropFilter({ blur: blur, width: 62.0, height: 15.0, radius: 4.0,
                    child: Center({ child: Text("FROSTED GLASS", { size: "label" }) }) }) }),
            ] }) }),
        ] }),
    });
});

runApp(App);
