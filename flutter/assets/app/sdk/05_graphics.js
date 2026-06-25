// =============================================================================
// Elpa SDK — Graphics (Vello scene path)
// -----------------------------------------------------------------------------
// The high-level surface over Elpa's **Vello scene pipe** (`scene.submit`). A
// frame is a batch of high-level vector drawing operations — fills, strokes,
// clip/blend layers, gradients, glyph runs — that the VM streams to the Rust
// host, which encodes them into a `vello::Scene` and rasterises them on the GPU.
//
// This replaces the old raw-wgpu command-tree facade: direct wgpu usage is no
// longer the drawing mechanism, it is a *single operation type* (`rawWgpu`) that
// composites an arbitrary wgpu render batch — a custom shader, a 3D scene, a
// compute effect — into the very same target the vector ops paint. So a 3D
// `Scene3D` is now just one op inside an otherwise-vector scene.
//
//   * `Color`      — float RGBA helper (matches `geometry::Color`).
//   * `Paint`      — fill/stroke style + brush (solid / gradient / image).
//   * `Path`       — a shape to fill/stroke/clip (rect, rrect, circle, …).
//   * `Canvas`     — a dart:ui-style recorder: save/restore transform stack,
//                    clip layers, drawRect/RRect/Circle/Line/Path, drawText.
//   * `Scene`      — collects the op batch + scene resources and submits it.
//   * `Gpu`        — typed facade over the pipe (`scene.submit`, `gpu.*`).
//   * `Scene3D`    — a tiny 3D scene graph compiled to a single `rawWgpu` op.
// =============================================================================

/// Colour helpers (floats in [0,1], matching `geometry::Color`).
class Color {
  static rgba(r, g, b, a) {
    return { r: r, g: g, b: b, a: isNull(a) ? 1.0 : a };
  }
  /// Parse `#RRGGBB` / `#AARRGGBB` into a float colour.
  static hex(s) {
    let h = s;
    if (charAt(h, 0) === "#") h = substring(h, 1, len(h));
    let a = 255;
    let r; let g; let b;
    if (len(h) === 8) {
      a = Color._byte(h, 0); r = Color._byte(h, 2); g = Color._byte(h, 4); b = Color._byte(h, 6);
    } else {
      r = Color._byte(h, 0); g = Color._byte(h, 2); b = Color._byte(h, 4);
    }
    return { r: r / 255.0, g: g / 255.0, b: b / 255.0, a: a / 255.0 };
  }
  static _byte(h, i) { return Color._nib(charAt(h, i)) * 16 + Color._nib(charAt(h, i + 1)); }
  static _nib(c) {
    let idx = indexOf("0123456789abcdef", lower(c));
    return idx < 0 ? 0 : idx;
  }
}

/// A 2D affine transform `[a,b,c,d,e,f]` (column-major), matching the host's
/// `scene::Affine`. The identity is the default.
class Transform2D {
  static identity() { return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]; }
  static translate(x, y) { return [1.0, 0.0, 0.0, 1.0, x, y]; }
  static scale(sx, sy) { return [sx, 0.0, 0.0, sy, 0.0, 0.0]; }
  /// `a ∘ b` — apply `b` first, then `a`.
  static mul(a, b) {
    return [
      b[0] * a[0] + b[1] * a[2],
      b[0] * a[1] + b[1] * a[3],
      b[2] * a[0] + b[3] * a[2],
      b[2] * a[1] + b[3] * a[3],
      b[4] * a[0] + b[5] * a[2] + a[4],
      b[4] * a[1] + b[5] * a[3] + a[5],
    ];
  }
}

/// A brush: what a fill/stroke paints with.
class Brush {
  static solid(color) { return { brush: "solid", color: color }; }
  /// `stops` is `[{ offset, color }]`.
  static linear(x0, y0, x1, y1, stops) {
    return { brush: "gradient", gradient: { type: "linear", x0: x0, y0: y0, x1: x1, y1: y1, stops: stops } };
  }
  static radial(cx, cy, r, stops) {
    return { brush: "gradient", gradient: { type: "radial", cx: cx, cy: cy, r: r, stops: stops } };
  }
  static image(id, alpha) { return { brush: "image", image: id, alpha: isNull(alpha) ? 1.0 : alpha }; }
}

/// A dart:ui-style Paint: fill vs stroke, the brush, and stroke parameters.
class Paint {
  constructor() {
    this.style = "fill";
    this.brush = Brush.solid(Color.rgba(0.0, 0.0, 0.0, 1.0));
    this.strokeWidth = 1.0;
  }
  static fill(color) { let p = new Paint(); p.brush = Brush.solid(color); return p; }
  static stroke(color, width) {
    let p = new Paint(); p.style = "stroke"; p.brush = Brush.solid(color); p.strokeWidth = width; return p;
  }
  withBrush(brush) { this.brush = brush; return this; }
}

/// A shape to fill/stroke/clip. Mirrors the host's `scene::Path`.
class Path {
  static rect(x, y, w, h) { return { shape: "rect", x: x, y: y, w: w, h: h }; }
  static rrect(x, y, w, h, radius) { return { shape: "roundRect", x: x, y: y, w: w, h: h, radius: radius }; }
  static circle(cx, cy, r) { return { shape: "circle", cx: cx, cy: cy, r: r }; }
  static ellipse(cx, cy, rx, ry) { return { shape: "ellipse", cx: cx, cy: cy, rx: rx, ry: ry }; }
  static line(x0, y0, x1, y1) { return { shape: "line", x0: x0, y0: y0, x1: x1, y1: y1 }; }
  /// A freeform path from element dicts (use the `el*` helpers).
  static elements(els) { return { shape: "elements", els: els }; }
}
function moveTo(x, y) { return { el: "moveTo", x: x, y: y }; }
function lineTo(x, y) { return { el: "lineTo", x: x, y: y }; }
function quadTo(cx, cy, x, y) { return { el: "quadTo", cx: cx, cy: cy, x: x, y: y }; }
function curveTo(c1x, c1y, c2x, c2y, x, y) { return { el: "curveTo", c1x: c1x, c1y: c1y, c2x: c2x, c2y: c2y, x: x, y: y }; }
function closePath() { return { el: "closePath" }; }

/// A dart:ui-style Canvas that records Vello scene ops. A transform stack
/// (`save`/`translate`/`scale`/`restore`) is folded into each op's transform;
/// `clipRRect`/`clipRect` push a clip layer that `restore` pops.
class Canvas {
  constructor() {
    this.ops = [];
    this.stack = [Transform2D.identity()];
    // Tracks how many clip layers each save pushed, so restore pops them.
    this.clipCounts = [0];
  }

  _xform() { return this.stack[len(this.stack) - 1]; }

  save() {
    push(this.stack, this._xform());
    push(this.clipCounts, 0);
  }
  restore() {
    let clips = this.clipCounts[len(this.clipCounts) - 1];
    for (let i = 0; i < clips; i++) push(this.ops, { op: "popLayer" });
    pop(this.clipCounts);
    pop(this.stack);
  }
  translate(dx, dy) {
    let i = len(this.stack) - 1;
    this.stack[i] = Transform2D.mul(this.stack[i], Transform2D.translate(dx, dy));
  }
  scale(sx, sy) {
    let i = len(this.stack) - 1;
    this.stack[i] = Transform2D.mul(this.stack[i], Transform2D.scale(sx, sy));
  }

  clipRect(rect) { this._pushClip(Path.rect(rect.x, rect.y, rect.w, rect.h)); }
  clipRRect(rect, radius) { this._pushClip(Path.rrect(rect.x, rect.y, rect.w, rect.h, radius)); }
  _pushClip(path) {
    push(this.ops, { op: "pushLayer", transform: this._xform(), clip: path });
    let i = len(this.clipCounts) - 1;
    this.clipCounts[i] = this.clipCounts[i] + 1;
  }
  /// A blend/opacity layer (composited at `alpha`) — popped by `restore`.
  saveLayer(alpha, clip) {
    push(this.stack, this._xform());
    push(this.clipCounts, 1);
    push(this.ops, { op: "pushLayer", alpha: alpha, transform: this._xform(),
      clip: isNull(clip) ? Path.rect(0.0, 0.0, 100000.0, 100000.0) : clip });
  }

  drawPath(path, paint) {
    if (paint.style === "stroke") {
      push(this.ops, { op: "stroke", style: { width: paint.strokeWidth }, transform: this._xform(), brush: paint.brush, path: path });
    } else {
      push(this.ops, { op: "fill", transform: this._xform(), brush: paint.brush, path: path });
    }
  }
  drawRect(rect, paint) { this.drawPath(Path.rect(rect.x, rect.y, rect.w, rect.h), paint); }
  drawRRect(rect, radius, paint) { this.drawPath(Path.rrect(rect.x, rect.y, rect.w, rect.h, radius), paint); }
  drawCircle(cx, cy, r, paint) { this.drawPath(Path.circle(cx, cy, r), paint); }
  drawLine(x0, y0, x1, y1, paint) {
    let p = paint; if (p.style !== "stroke") { p = Paint.stroke(Color.rgba(0.0, 0.0, 0.0, 1.0), 1.0); p.brush = paint.brush; }
    this.drawPath(Path.line(x0, y0, x1, y1), p);
  }

  /// Draw a run of pre-shaped glyphs (`[{ id, x, y }]`) from a registered font.
  drawGlyphs(fontId, fontSize, glyphs, color) {
    push(this.ops, { op: "drawGlyphs", transform: this._xform(),
      run: { font: fontId, font_size: fontSize, brush: Brush.solid(color), glyphs: glyphs } });
  }

  /// Composite a raw wgpu frame (the subset op) into the same scene.
  drawRaw(frame) { push(this.ops, { op: "rawWgpu", frame: frame }); }
}

/// Collects a Canvas's ops + scene-level resources and submits the scene.
class Scene {
  constructor() {
    this.resources = [];
    this.canvas = new Canvas();
  }
  /// Register a font resource (TTF/OTF, base64) referenced by glyph runs.
  addFont(id, dataB64) { push(this.resources, { kind: "font", id: id, data_b64: dataB64 }); return this; }
  /// Register an RGBA8 image resource (base64 row-major pixels).
  addImage(id, width, height, dataB64) {
    push(this.resources, { kind: "image", id: id, width: width, height: height, data_b64: dataB64 });
    return this;
  }
  build() { return { resources: this.resources, ops: this.canvas.ops }; }
}

/// Typed facade over the GPU/scene pipe. One per app (use `app.gpu`).
class Gpu {
  constructor(host) { this.host = host; }
  /// Begin a Vello scene.
  scene() { return new Scene(); }
  /// Submit a Vello scene (the primary drawing path).
  submitScene(scene) { this.host.sceneSubmit(scene.build()); }
  /// Register a reusable wgpu drawing definition (referenced by a rawWgpu frame).
  define(definition) { this.host.gpuDefine(definition); }
  undefine(id) { this.host.gpuUndefine(id); }
  /// Submit a raw wgpu frame directly (back-compat; equivalent to a one-op scene).
  submit(frameTree) { this.host.gpuSubmit(frameTree); }
  surfaceInfo() { return this.host.surfaceInfo(); }
}

// ---- 3D scene graph (now a single rawWgpu op inside a Vello scene) ----------

class Camera {
  constructor() {
    this.position = [0.0, 0.0, 5.0]; this.target = [0.0, 0.0, 0.0]; this.up = [0.0, 1.0, 0.0];
    this.fov = 60.0; this.near = 0.1; this.far = 100.0;
  }
  moveTo(x, y, z) { this.position = [x, y, z]; return this; }
  lookAt(x, y, z) { this.target = [x, y, z]; return this; }
  perspective(fovDeg, near, far) { this.fov = fovDeg; this.near = near; this.far = far; return this; }
}

class Material {
  constructor(color) {
    this.color = isNull(color) ? Color.rgba(1.0, 1.0, 1.0, 1.0) : color;
    this.pipeline = "elpa.pbr"; this.metallic = 0.0; this.roughness = 0.6;
  }
  shader(pipelineId) { this.pipeline = pipelineId; return this; }
  pbr(metallic, roughness) { this.metallic = metallic; this.roughness = roughness; return this; }
}

class Mesh {
  constructor(id) {
    this.id = id; this.vertices = []; this.indices = [];
    this.material = new Material(NIL); this.transform = Mesh.identity(); this._registered = false;
  }
  static identity() {
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
  }
  geometry(vertices, indices) { this.vertices = vertices; this.indices = indices; return this; }
  withMaterial(material) { this.material = material; return this; }
  translate(x, y, z) { this.transform[12] = x; this.transform[13] = y; this.transform[14] = z; return this; }
  register(gpu) {
    gpu.define({
      id: this.id, level: "render",
      resources: [
        { kind: "buffer", id: this.id + ".vb", size: len(this.vertices) * 4, usage: ["VERTEX"], data_f32: this.vertices },
        { kind: "buffer", id: this.id + ".ib", size: len(this.indices) * 2, usage: ["INDEX"], data_u16: this.indices },
      ],
      commands: [
        { cmd: "setPipeline", pipeline: this.material.pipeline },
        { cmd: "setVertexBuffer", slot: 0, buffer: this.id + ".vb" },
        { cmd: "setIndexBuffer", buffer: this.id + ".ib", format: "uint16" },
        { cmd: "drawIndexed", index_count: len(this.indices) },
      ],
    });
    this._registered = true; return this;
  }
}

/// A minimal 3D scene graph. It compiles to a raw wgpu frame, which is then
/// composited into a Vello scene as a single `rawWgpu` op — so 3D content lives
/// in the same scene as the 2D UI drawn around it.
class Scene3D {
  constructor() {
    this.camera = new Camera(); this.background = Color.hex("#0E1621");
    this.meshes = []; this._registered = false;
  }
  setBackground(color) { this.background = color; return this; }
  add(mesh) { push(this.meshes, mesh); return this; }
  prime(gpu) {
    for (let i = 0; i < len(this.meshes); i++) this.meshes[i].register(gpu);
    this._registered = true; return this;
  }
  /// Build the raw wgpu frame this scene draws.
  toFrame() {
    let draws = [];
    for (let i = 0; i < len(this.meshes); i++) push(draws, { cmd: "useDefinition", definition: this.meshes[i].id });
    return {
      commands: [{
        op: "renderPass",
        color_attachments: [{ view: { kind: "surface" }, load: "clear", store: true, clear_color: this.background }],
        commands: draws,
      }],
    };
  }
  /// Compile to a frame and submit it as a one-op Vello scene (3D as a subset op).
  renderTo(gpu) {
    if (!this._registered) this.prime(gpu);
    let scene = gpu.scene();
    scene.canvas.drawRaw(this.toFrame());
    gpu.submitScene(scene);
  }
}

/// The native, GPU-rendered Elpa widget (zero-copy texture / canvas) composited
/// inline by Flutter. A `Scene3D` renders into the surface this view is bound to.
class Native3DView extends Widget {
  constructor(config) {
    super("ElpaNative", config);
    this._take(config, ["textureId", "canvasId", "width", "height"]);
  }
}
