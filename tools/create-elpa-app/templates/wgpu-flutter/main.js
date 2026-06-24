// =============================================================================
// __APP_TITLE__ — Elpa + Flutter demo with a 3D Native3DView (wgpu)
// -----------------------------------------------------------------------------
// A Flutter app whose 2D UI is streamed from the Elpian VM to real Flutter
// widgets, and whose hero card embeds a 3D Game3D-style scene rendered by Elpa's
// own wgpu pipeline into a `Native3DView` — the zero-copy surface that links
// wgpu to Flutter (a `Texture` on mobile/desktop, an `HtmlElementView` on web).
//
// The native surface is live when the bridge is built with the `gpu` Cargo
// feature and the platform shared-texture wiring is in place (see README); in the
// default headless build the Native3DView reserves its space and the 2D UI runs
// in full.
// =============================================================================

var app = new App();

function colors() { return app.theme.colors; }

// ---- reusable 2D helpers -----------------------------------------------------
function card(title, body) {
  let c = colors();
  return new Container({
    color: c.surface,
    radius: 14.0,
    padding: 16.0,
    margin: { left: 16.0, right: 16.0, top: 8.0, bottom: 8.0 },
    child: new Column({
      crossAxisAlignment: "stretch",
      children: [
        new Text(title, { size: 13.0, bold: true, color: c.textSecondary }),
        new SizedBox({ height: 12.0 }),
        body,
      ],
    }),
  });
}

function pill(label, bg, fg, onTap) {
  return new Tappable({
    onTap: onTap,
    child: new Container({
      color: bg, radius: 10.0,
      padding: { left: 16.0, right: 16.0, top: 10.0, bottom: 10.0 },
      alignment: "center",
      child: new Text(label, { bold: true, color: fg }),
    }),
  });
}

// ---- the 3D scene ------------------------------------------------------------
// A cube rendered by Elpa's wgpu pipeline into the Native3DView surface. The
// geometry is registered once as a render-level GPU definition; each frame we
// submit a surface pass that clears to an (animated) background and draws the
// cube. The Native3DView composites that texture inline in Flutter.
//
// This drives the GPU pipe directly (Gpu / FrameBuilder) so the scene runs on the
// VM without any host-specific helpers — extend `prime()`/`render()` with your
// own meshes, uniforms and pipelines.

// The 8 corners of a cube (position only), and the 36 triangle indices.
var CUBE_VERTS = [
  -0.8, -0.8, -0.8,   0.8, -0.8, -0.8,   0.8,  0.8, -0.8,  -0.8,  0.8, -0.8,
  -0.8, -0.8,  0.8,   0.8, -0.8,  0.8,   0.8,  0.8,  0.8,  -0.8,  0.8,  0.8,
];
var CUBE_INDICES = [
  0, 1, 2, 0, 2, 3,   4, 6, 5, 4, 7, 6,   4, 5, 1, 4, 1, 0,
  3, 2, 6, 3, 6, 7,   1, 5, 6, 1, 6, 2,   4, 0, 3, 4, 3, 7,
];

class SceneController {
  constructor() {
    this.gpu = app.gpu;
    this.angle = 0.0;
    this.spinning = true;
    this.primed = false;
  }
  prime() {
    // Register the cube geometry once (referenced by id every frame thereafter).
    this.gpu.define({
      id: "cube",
      level: "render",
      resources: [
        { kind: "buffer", id: "cube.vb", usage: "vertex", dataF32: CUBE_VERTS },
        { kind: "buffer", id: "cube.ib", usage: "index", dataU16: CUBE_INDICES },
      ],
      commands: [
        { cmd: "setPipeline", pipeline: "elpa.pbr" },
        { cmd: "setVertexBuffer", slot: 0, buffer: "cube.vb" },
        { cmd: "setIndexBuffer", buffer: "cube.ib", format: "uint16" },
        { cmd: "drawIndexed", indexCount: len(CUBE_INDICES) },
      ],
    });
    this.primed = true;
  }
  render(dt) {
    if (!this.primed) this.prime();
    if (this.spinning) this.angle = this.angle + dt * 0.9;
    // Animate the clear colour so the native surface is visibly alive even before
    // a 3D pipeline is wired up.
    let t = (sin(this.angle) + 1.0) * 0.5;
    let bg = Color.rgba(0.05 + t * 0.10, 0.09, 0.16 + t * 0.10, 1.0);
    this.gpu.frame().surfacePass(bg, [{ cmd: "useDefinition", definition: "cube" }]).submit();
  }
}

var sceneCtl = new SceneController();

// ---- the home page -----------------------------------------------------------
class ControlsCard extends Component {
  constructor() { super("scope.controls"); }
  build() {
    let c = colors();
    return card("3D CONTROLS", new Row({
      mainAxisAlignment: "spaceBetween",
      children: [
        pill(sceneCtl.spinning ? "PAUSE" : "RESUME", c.primary, "#FFFFFF", () => {
          sceneCtl.spinning = !sceneCtl.spinning;
          this.setState(NIL);
        }),
        pill("RESET VIEW", c.surfaceVariant, c.textPrimary, () => { sceneCtl.angle = 0.0; this.setState(NIL); }),
      ],
    }));
  }
}

class HomePage extends Page {
  constructor() {
    super("__APP_TITLE__");
    this.controls = new ControlsCard();
  }
  header() {
    let c = colors();
    return new Container({
      color: c.primary,
      padding: { left: 16.0, right: 16.0, top: 48.0, bottom: 16.0 },
      child: new Text("__APP_TITLE__", { size: 20.0, bold: true, color: "#FFFFFF" }),
    });
  }
  sceneCard() {
    // A fixed-height region hosting the native wgpu surface (live with the `gpu`
    // feature build; a reserved placeholder otherwise).
    return new Container({
      height: 240.0,
      radius: 14.0,
      color: "#0E1621",
      margin: { left: 16.0, right: 16.0, top: 8.0, bottom: 8.0 },
      child: new ClipRRect({
        radius: 14.0,
        child: new Native3DView({ key: "scene.native", height: 240.0 }),
      }),
    });
  }
  build() {
    let c = colors();
    return new Scaffold({
      backgroundColor: c.background,
      body: new Column({
        crossAxisAlignment: "stretch",
        children: [
          this.header(),
          new Expanded({ child: new ListView({
            padding: { top: 8.0, bottom: 24.0 },
            children: [
              this.sceneCard(),
              this.controls,
              card("ABOUT", new Text(
                "The card above hosts a 3D scene rendered by Elpa's wgpu pipeline " +
                "and composited inline by Flutter. The rest of the UI is a Flutter " +
                "widget tree streamed from the Elpian VM.",
                { color: c.textSecondary })),
            ],
          }) }),
        ],
      }),
    });
  }
}

// ---- bootstrap + VM lifecycle ------------------------------------------------
app.navigator.mount(new HomePage());
app.start(() => app.navigator.build());

function onHostMessage(msg) { app.handleHostMessage(msg); }
function onFrame(dt) {
  app.handleFrame(dt);   // drive 2D timers/animations
  sceneCtl.render(dt);   // render the 3D scene into the native surface
}
function onResize(info) { app.handleResize(info); }
