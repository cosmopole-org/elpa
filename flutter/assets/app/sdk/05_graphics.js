// =============================================================================
// Elpa SDK — Graphics & 3D
// -----------------------------------------------------------------------------
// The high-level surface over Elpa's wgpu command pipe (`gpu.submit` /
// `gpu.define`) and the native, GPU-rendered widget. There are two ways to put
// rendered pixels on screen, and the SDK covers both:
//
//   1. Flutter Impeller path — ordinary widgets (this file's 2D helpers compose
//      with the DSL); Flutter rasterises them on its own Impeller backend.
//   2. Elpa native surface — `Native3DView` embeds Elpa's own wgpu surface inline
//      as a zero-copy texture. A `Scene3D` (camera + meshes + materials) renders
//      into it through the GPU pipe — the route for real 3D games and effects.
//
// `Gpu` is the typed facade over the command pipe; `FrameBuilder` assembles one
// frame's `{ resources, commands }` tree; `Scene3D` is a tiny scene graph that
// compiles to that tree. Meshes register once as reusable GPU *definitions* and
// each frame references them by id, so per-frame payloads stay tiny.
// =============================================================================

/// Colour helpers for the GPU path (floats in [0,1], matching `geometry::Color`).
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
      a = Color._byte(h, 0);
      r = Color._byte(h, 2);
      g = Color._byte(h, 4);
      b = Color._byte(h, 6);
    } else {
      r = Color._byte(h, 0);
      g = Color._byte(h, 2);
      b = Color._byte(h, 4);
    }
    return { r: r / 255.0, g: g / 255.0, b: b / 255.0, a: a / 255.0 };
  }
  static _byte(h, i) {
    let hi = Color._nib(charAt(h, i));
    let lo = Color._nib(charAt(h, i + 1));
    return hi * 16 + lo;
  }
  static _nib(c) {
    let d = "0123456789abcdef";
    let lc = lower(c);
    let idx = indexOf(d, lc);
    return idx < 0 ? 0 : idx;
  }
}

/// Typed facade over the GPU command pipe. One per app (use `app.gpu`).
class Gpu {
  constructor(host) {
    this.host = host;
  }
  /// Begin assembling a frame.
  frame() {
    return new FrameBuilder(this);
  }
  /// Register a reusable drawing definition (referenced later by id).
  define(definition) {
    this.host.gpuDefine(definition);
  }
  undefine(id) {
    this.host.gpuUndefine(id);
  }
  submit(frameTree) {
    this.host.gpuSubmit(frameTree);
  }
  surfaceInfo() {
    return this.host.surfaceInfo();
  }
}

/// Assembles one frame: a list of resources and encoder commands. The common
/// case — clear the surface and draw some registered meshes — is one method call.
class FrameBuilder {
  constructor(gpu) {
    this.gpu = gpu;
    this.resources = [];
    this.commands = [];
  }

  resource(desc) {
    push(this.resources, desc);
    return this;
  }

  /// A render pass targeting the swapchain surface, clearing to `color`, whose
  /// body is the given list of `RenderCommand`s (e.g. `useDefinition` draws).
  surfacePass(color, drawCommands) {
    push(this.commands, {
      op: "renderPass",
      colorAttachments: [
        {
          view: { kind: "surface" },
          load: "clear",
          store: true,
          clearColor: color,
        },
      ],
      commands: isNull(drawCommands) ? [] : drawCommands,
    });
    return this;
  }

  /// Reference a registered encoder-level definition (a whole reusable scene).
  useDefinition(id) {
    push(this.commands, { op: "useDefinition", definition: id });
    return this;
  }

  build() {
    return { resources: this.resources, commands: this.commands };
  }

  submit() {
    this.gpu.submit(this.build());
  }
}

// ---- 3D scene graph ---------------------------------------------------------

/// A perspective camera. `position`/`target` are `[x,y,z]`; `fov` in degrees.
class Camera {
  constructor() {
    this.position = [0.0, 0.0, 5.0];
    this.target = [0.0, 0.0, 0.0];
    this.up = [0.0, 1.0, 0.0];
    this.fov = 60.0;
    this.near = 0.1;
    this.far = 100.0;
  }
  moveTo(x, y, z) { this.position = [x, y, z]; return this; }
  lookAt(x, y, z) { this.target = [x, y, z]; return this; }
  perspective(fovDeg, near, far) { this.fov = fovDeg; this.near = near; this.far = far; return this; }
}

/// A material: a base colour and an optional named shader/pipeline id the host
/// resolves to a registered GPU pipeline resource.
class Material {
  constructor(color) {
    this.color = isNull(color) ? Color.rgba(1.0, 1.0, 1.0, 1.0) : color;
    this.pipeline = "elpa.pbr";
    this.metallic = 0.0;
    this.roughness = 0.6;
  }
  shader(pipelineId) { this.pipeline = pipelineId; return this; }
  pbr(metallic, roughness) { this.metallic = metallic; this.roughness = roughness; return this; }
}

/// A mesh: geometry plus a material. Geometry is given as flat vertex/index
/// arrays; the mesh registers once as a render-level GPU definition and is then
/// referenced by id every frame (`Scene3D.renderTo`).
class Mesh {
  constructor(id) {
    this.id = id;
    this.vertices = [];
    this.indices = [];
    this.material = new Material(NIL);
    this.transform = Mesh.identity();
    this._registered = false;
  }

  static identity() {
    return [
      1.0, 0.0, 0.0, 0.0,
      0.0, 1.0, 0.0, 0.0,
      0.0, 0.0, 1.0, 0.0,
      0.0, 0.0, 0.0, 1.0,
    ];
  }

  geometry(vertices, indices) {
    this.vertices = vertices;
    this.indices = indices;
    return this;
  }
  withMaterial(material) { this.material = material; return this; }
  translate(x, y, z) {
    this.transform[12] = x; this.transform[13] = y; this.transform[14] = z;
    return this;
  }

  /// Register this mesh's geometry+pipeline with the host as a render-level
  /// definition. Call once after construction; thereafter the scene draws it by
  /// id with a tiny `useDefinition`.
  register(gpu) {
    gpu.define({
      id: this.id,
      level: "render",
      resources: [
        { kind: "buffer", id: this.id + ".vb", usage: "vertex", dataF32: this.vertices },
        { kind: "buffer", id: this.id + ".ib", usage: "index", dataU16: this.indices },
      ],
      commands: [
        { cmd: "setPipeline", pipeline: this.material.pipeline },
        { cmd: "setVertexBuffer", slot: 0, buffer: this.id + ".vb" },
        { cmd: "setIndexBuffer", buffer: this.id + ".ib", format: "uint16" },
        { cmd: "drawIndexed", indexCount: len(this.indices) },
      ],
    });
    this._registered = true;
    return this;
  }
}

/// A minimal scene graph: a camera, a clear colour, and a set of meshes. Renders
/// into whatever surface the host's GPU pipe is bound to (e.g. a `Native3DView`'s
/// texture) by compiling to a single clear pass plus per-mesh draw references.
class Scene3D {
  constructor() {
    this.camera = new Camera();
    this.background = Color.hex("#0E1621");
    this.meshes = [];
    this._registered = false;
  }
  setBackground(color) { this.background = color; return this; }
  add(mesh) { push(this.meshes, mesh); return this; }

  /// Register every mesh with the host once (before the first render).
  prime(gpu) {
    for (let i = 0; i < len(this.meshes); i++) {
      this.meshes[i].register(gpu);
    }
    this._registered = true;
    return this;
  }

  /// Compile the scene to a frame and submit it.
  renderTo(gpu) {
    if (!this._registered) this.prime(gpu);
    let draws = [];
    for (let i = 0; i < len(this.meshes); i++) {
      push(draws, { cmd: "useDefinition", definition: this.meshes[i].id });
    }
    gpu.frame().surfacePass(this.background, draws).submit();
  }
}

/// The native, wgpu-rendered Elpa widget: a zero-copy texture (native) or canvas
/// (web) painted by Elpa's own renderer and composited inline by Flutter. A
/// `Scene3D` renders into the surface this view is bound to.
/// `new Native3DView({ textureId, canvasId, width, height })`
class Native3DView extends Widget {
  constructor(config) {
    super("ElpaNative", config);
    this._take(config, ["textureId", "canvasId", "width", "height"]);
  }
}
