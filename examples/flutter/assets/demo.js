// Elpa Flutter — demo app (step 1: a dart:ui Canvas showcase).
//
// Proves the bottom layers end to end: the dart:ui `Canvas` lowering onto the
// SDF raster backend and submitting one instanced GPU frame. Later steps replace
// this with a real widget tree mounted through `runApp`.

runPaint((canvas, sz) => {
    let w = sz.width; let h = sz.height;

    // A header bar (filled rounded rect).
    canvas.drawRRect(
        rrectFromRectAndRadius(rectLTWH(16.0, 16.0, w - 32.0, 64.0), radiusCircular(16.0)),
        paintFill(Colors.deepPurple));
    canvas.drawText("FLUTTER ON ELPA", offset(40.0, 38.0), 4.0, Colors.white);

    // A gradient card.
    let card = rectLTWH(16.0, 96.0, w - 32.0, 120.0);
    let p = new Paint();
    p.shader = linearGradient(offset(-1.0, -1.0), offset(1.0, 1.0),
        [Colors.blue, Colors.teal], 0);
    canvas.drawRRect(rrectFromRectAndRadius(card, radiusCircular(20.0)), p);

    // A stroked circle + a filled disc.
    canvas.drawCircle(offset(w * 0.3, 280.0), 36.0, paintStroke(Colors.orange, 4.0));
    canvas.drawCircle(offset(w * 0.7, 280.0), 36.0, paintFill(Colors.pink));

    // A path (a little chart line).
    let line = path();
    line.moveTo(20.0, 380.0);
    line.lineTo(80.0, 340.0);
    line.cubicTo(120.0, 300.0, 160.0, 420.0, 220.0, 360.0);
    line.lineTo(280.0, 330.0);
    canvas.drawPath(line, paintStroke(Colors.green, 3.0));

    canvas.drawText("DART:UI CANVAS OK", offset(20.0, 440.0), 3.0, Colors.black);
});
