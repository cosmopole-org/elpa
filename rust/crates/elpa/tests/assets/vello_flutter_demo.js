// =============================================================================
// A Flutter-like UI SDK in JavaScript, drawn entirely with Vello scene ops.
//
// This is the rewrite of Elpa's from-scratch, JS-authored Flutter-like SDK onto
// the new Vello drawing path: instead of emitting a raw wgpu command tree, the
// painting layer records high-level vector operations (fills, strokes, clip
// layers, gradients, glyph runs) and streams them via `scene.submit`. Direct
// wgpu is no longer the drawing mechanism — it survives only as the `rawWgpu`
// op, which composites an arbitrary wgpu frame (here, a 3D card) into the very
// same scene the 2D widgets paint into.
//
// Layers, bottom-up:
//   * dart:ui    — Color, Brush, Paint, Path, Transform2D, Canvas, Scene.
//   * rendering  — a minimal box layout (constraints down, sizes up).
//   * widgets    — Container, Padding, Column, Row, Text, Card, Button.
//   * app        — builds a tree, lays it out to the surface, paints, submits.
// =============================================================================

// ---- dart:ui (Vello scene recorder) ----------------------------------------

class Color {
  static rgba(r, g, b, a) { return { r: r, g: g, b: b, a: isNull(a) ? 1.0 : a }; }
}

class Brush {
  static solid(c) { return { brush: "solid", color: c }; }
  static linear(x0, y0, x1, y1, stops) {
    return { brush: "gradient", gradient: { type: "linear", x0: x0, y0: y0, x1: x1, y1: y1, stops: stops } };
  }
}

class Paint {
  constructor() { this.style = "fill"; this.brush = Brush.solid(Color.rgba(0.0, 0.0, 0.0, 1.0)); this.strokeWidth = 1.0; }
  static fill(c) { let p = new Paint(); p.brush = Brush.solid(c); return p; }
  static fillBrush(b) { let p = new Paint(); p.brush = b; return p; }
  static stroke(c, w) { let p = new Paint(); p.style = "stroke"; p.brush = Brush.solid(c); p.strokeWidth = w; return p; }
}

class Path {
  static rect(x, y, w, h) { return { shape: "rect", x: x, y: y, w: w, h: h }; }
  static rrect(x, y, w, h, r) { return { shape: "roundRect", x: x, y: y, w: w, h: h, radius: r }; }
  static circle(cx, cy, r) { return { shape: "circle", cx: cx, cy: cy, r: r }; }
}

class Transform2D {
  static identity() { return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; }
  static translate(x, y) { return [1.0, 0.0, 0.0, 1.0, x, y]; }
  static mul(a, b) {
    return [
      b[0] * a[0] + b[1] * a[2], b[0] * a[1] + b[1] * a[3],
      b[2] * a[0] + b[3] * a[2], b[2] * a[1] + b[3] * a[3],
      b[4] * a[0] + b[5] * a[2] + a[4], b[4] * a[1] + b[5] * a[3] + a[5],
    ];
  }
}

class Canvas {
  constructor() { this.ops = []; this.stack = [Transform2D.identity()]; this.clipCounts = [0]; }
  _x() { return this.stack[len(this.stack) - 1]; }
  save() { push(this.stack, this._x()); push(this.clipCounts, 0); }
  restore() {
    let n = this.clipCounts[len(this.clipCounts) - 1];
    for (let i = 0; i < n; i++) push(this.ops, { op: "popLayer" });
    pop(this.clipCounts); pop(this.stack);
  }
  translate(dx, dy) { let i = len(this.stack) - 1; this.stack[i] = Transform2D.mul(this.stack[i], Transform2D.translate(dx, dy)); }
  clipRRect(x, y, w, h, r) {
    push(this.ops, { op: "pushLayer", transform: this._x(), clip: Path.rrect(x, y, w, h, r) });
    let i = len(this.clipCounts) - 1; this.clipCounts[i] = this.clipCounts[i] + 1;
  }
  drawPath(path, paint) {
    if (paint.style === "stroke") push(this.ops, { op: "stroke", style: { width: paint.strokeWidth }, transform: this._x(), brush: paint.brush, path: path });
    else push(this.ops, { op: "fill", transform: this._x(), brush: paint.brush, path: path });
  }
  drawRect(x, y, w, h, paint) { this.drawPath(Path.rect(x, y, w, h), paint); }
  drawRRect(x, y, w, h, r, paint) { this.drawPath(Path.rrect(x, y, w, h, r), paint); }
  drawCircle(cx, cy, r, paint) { this.drawPath(Path.circle(cx, cy, r), paint); }
  drawGlyphs(font, size, glyphs, color) {
    push(this.ops, { op: "drawGlyphs", transform: this._x(), run: { font: font, font_size: size, brush: Brush.solid(color), glyphs: glyphs } });
  }
  drawRaw(frame) { push(this.ops, { op: "rawWgpu", frame: frame }); }
}

class Scene {
  constructor() { this.resources = []; this.canvas = new Canvas(); }
  addFont(id, b64) { push(this.resources, { kind: "font", id: id, data_b64: b64 }); return this; }
  build() { return { resources: this.resources, ops: this.canvas.ops }; }
}

// ---- rendering (a minimal box model: constraints down, sizes up) ------------

class Size { constructor(w, h) { this.w = w; this.h = h; } }

class Widget {
  constructor() { this.size = new Size(0.0, 0.0); }
  // Lay out under a max width/height; set and return this.size.
  layout(maxW, maxH) { this.size = new Size(maxW, maxH); return this.size; }
  // Paint at (x, y) on the canvas.
  paint(canvas, x, y) {}
}

class Text extends Widget {
  constructor(s, opts) {
    super();
    this.text = s;
    this.fontSize = isNull(opts) || isNull(opts.fontSize) ? 16.0 : opts.fontSize;
    this.color = isNull(opts) || isNull(opts.color) ? Color.rgba(0.1, 0.1, 0.12, 1.0) : opts.color;
  }
  layout(maxW, maxH) { this.size = new Size(min(maxW, len(this.text) * this.fontSize * 0.6), this.fontSize * 1.3); return this.size; }
  paint(canvas, x, y) {
    // Shape one glyph per character: the glyph id is the character's index in a
    // charset (a stand-in for font cmap lookup), so the run reflects the actual
    // text. Headless does not rasterise; this exercises the glyph-run op path.
    let glyphs = [];
    let adv = this.fontSize * 0.6;
    let charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :.,!?-+/";
    for (let i = 0; i < len(this.text); i++) {
      let code = indexOf(charset, charAt(this.text, i));
      push(glyphs, { id: (code < 0 ? 0 : code) + 2, x: i * adv, y: this.fontSize });
    }
    canvas.save(); canvas.translate(x, y);
    canvas.drawGlyphs("ui.font", this.fontSize, glyphs, this.color);
    canvas.restore();
  }
}

class Container extends Widget {
  constructor(opts) {
    super();
    this.color = isNull(opts.color) ? NIL : opts.color;
    this.brush = isNull(opts.brush) ? NIL : opts.brush;
    this.radius = isNull(opts.radius) ? 0.0 : opts.radius;
    this.padding = isNull(opts.padding) ? 0.0 : opts.padding;
    this.child = isNull(opts.child) ? NIL : opts.child;
    this.width = isNull(opts.width) ? NIL : opts.width;
    this.height = isNull(opts.height) ? NIL : opts.height;
  }
  layout(maxW, maxH) {
    let w = isNull(this.width) ? maxW : this.width;
    let h = isNull(this.height) ? maxH : this.height;
    if (!isNull(this.child)) {
      let cs = this.child.layout(w - this.padding * 2.0, h - this.padding * 2.0);
      if (isNull(this.height)) h = cs.h + this.padding * 2.0;
    }
    this.size = new Size(w, h); return this.size;
  }
  paint(canvas, x, y) {
    let paint = NIL;
    if (!isNull(this.brush)) paint = Paint.fillBrush(this.brush);
    else if (!isNull(this.color)) paint = Paint.fill(this.color);
    if (!isNull(paint)) {
      if (this.radius > 0.0) canvas.drawRRect(x, y, this.size.w, this.size.h, this.radius, paint);
      else canvas.drawRect(x, y, this.size.w, this.size.h, paint);
    }
    if (!isNull(this.child)) {
      // Clip the child to the rounded background; save/clip/restore stays balanced.
      let clip = this.radius > 0.0;
      if (clip) { canvas.save(); canvas.clipRRect(x, y, this.size.w, this.size.h, this.radius); }
      this.child.paint(canvas, x + this.padding, y + this.padding);
      if (clip) canvas.restore();
    }
  }
}

class Column extends Widget {
  constructor(children, gap) { super(); this.children = children; this.gap = isNull(gap) ? 8.0 : gap; }
  layout(maxW, maxH) {
    let h = 0.0; let w = 0.0;
    for (let i = 0; i < len(this.children); i++) {
      let cs = this.children[i].layout(maxW, maxH);
      h = h + cs.h; if (i > 0) h = h + this.gap;
      if (cs.w > w) w = cs.w;
    }
    this.size = new Size(maxW, h); return this.size;
  }
  paint(canvas, x, y) {
    let cy = y;
    for (let i = 0; i < len(this.children); i++) {
      this.children[i].paint(canvas, x, cy);
      cy = cy + this.children[i].size.h + this.gap;
    }
  }
}

// A "3D card": a raw wgpu frame composited into the scene as the `rawWgpu` op.
class SceneCard extends Widget {
  constructor(h) { super(); this.h = h; }
  layout(maxW, maxH) { this.size = new Size(maxW, this.h); return this.size; }
  paint(canvas, x, y) {
    canvas.drawRaw({
      commands: [{
        op: "renderPass",
        color_attachments: [{ view: { kind: "surface" }, load: "load", store: true }],
        commands: [{ cmd: "draw", vertex_count: 3 }],
      }],
    });
  }
}

// ---- app --------------------------------------------------------------------

let _likes = 0;

function buildUI(surfaceW) {
  return new Container({ color: Color.rgba(1.0, 1.0, 1.0, 1.0), padding: 20.0,
    child: new Column([
      new Text("Vello Flutter Demo", { fontSize: 28.0 }),
      new Container({ color: Color.rgba(0.95, 0.96, 0.98, 1.0), radius: 16.0, padding: 16.0, height: 84.0,
        child: new Text("Likes: " + str(_likes), { fontSize: 20.0, color: Color.rgba(0.1, 0.3, 0.9, 1.0) }) }),
      new Container({ radius: 16.0, height: 96.0,
        brush: Brush.linear(0.0, 0.0, surfaceW, 0.0, [
          { offset: 0.0, color: Color.rgba(0.36, 0.20, 0.96, 1.0) },
          { offset: 1.0, color: Color.rgba(0.05, 0.62, 0.96, 1.0) },
        ]) }),
      new SceneCard(120.0),
    ], 18.0) });
}

function render() {
  let info = askHost("gpu.surfaceInfo", []);
  let scene = new Scene();
  scene.addFont("ui.font", "AAEB");
  let root = buildUI(info.width);
  root.layout(info.width, info.height);
  root.paint(scene.canvas, 0.0, 0.0);
  askHost("scene.submit", [scene.build()]);
}

// Top-level program: first paint.
render();

function onEvent(e) {
  // Any tap bumps the like counter and repaints.
  if (e.type === "pointerdown") { _likes = _likes + 1; render(); }
}

function onResize(info) { render(); }
function onFrame(dt) {}
