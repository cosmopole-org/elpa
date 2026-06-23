// Elpa Flutter — WidgetsFlutterBinding + runApp (the glue to the host).
//
// The binding owns the engine services (Painter, FontEngine, Ticker), reads the
// surface metrics, builds the one render pipeline, and runs the per-frame
// pipeline that ends in `gpu.submit`. This is Flutter's RendererBinding +
// WidgetsBinding: it holds the RenderView, drives drawFrame (build → layout →
// paint → composite → submit), routes pointer events through a hit test, and
// schedules frames for implicit animations.
//
// NOTE (step 1): the rendering + widgets layers are introduced in later modules.
// This module is structured so those layers slot in: `drawFrame` resets the
// painter, paints (today: a callback; later: the RenderView), and submits. The
// pipeline / submit code below is the final, reused implementation.

// The shared SDF pipeline resources (one pipeline draws the whole UI).
function sdfPipelineResources() {
    return [
        { kind: "shader", id: "elpa.fl.shader", wgsl: SDF_WGSL },
        { kind: "bindGroupLayout", id: "elpa.fl.bgl",
          entries: [
              { binding: 0, visibility: ["VERTEX"], ty: "uniform" },
              { binding: 1, visibility: ["FRAGMENT"], ty: "texture" },
              { binding: 2, visibility: ["FRAGMENT"], ty: "sampler" }] },
        { kind: "pipelineLayout", id: "elpa.fl.layout", bind_group_layouts: ["elpa.fl.bgl"] },
        { kind: "renderPipeline", id: "elpa.fl.pipe", layout: "elpa.fl.layout",
          vertex: { module: "elpa.fl.shader", entry_point: "vs", buffers: [{
              array_stride: 64, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 }] }] },
          fragment: { module: "elpa.fl.shader", entry_point: "fs", targets: [{
              format: SURFACE_FMT,
              blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                       alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
    ];
}

class WidgetsBinding {
    constructor() {
        this.painter = new Painter();
        this.font = new FontEngine();
        this.ticker = new Ticker();
        // Surface metrics (physical px + device pixel ratio).
        this.pw = 1.0; this.ph = 1.0; this.dpr = 1.0; this.lw = 1.0; this.lh = 1.0;
        this.clearColor = [0.96, 0.96, 0.97, 1.0];
        this.frameN = 0; this._needsFrame = 0.0;
        // The pipeline owner + root render object (Flutter's RendererBinding).
        this.pipelineOwner = new PipelineOwner(this);
        this.renderView = new RenderView();
        this.renderView.owner = this.pipelineOwner;
        this.renderView._attached = 1.0;
        this.pipelineOwner.rootNode = this.renderView;
        // The retained element tree (populated by the widgets layer).
        this.rootElement = 0; this.buildOwner = 0;
        // Step-1 fallback: a direct paint callback.
        this.paintFn = 0;
        // Hit-test bookkeeping for gesture dispatch.
        this.downListeners = [];
    }

    // Schedule a frame (Flutter's SchedulerBinding.scheduleFrame). The host pumps
    // onFrame; we draw when a visual update was requested.
    scheduleFrame() { this._needsFrame = 1.0; }

    // Attach the root render object under the RenderView and schedule initial
    // layout (Flutter's renderViewElement / scheduleInitialLayout).
    setRoot(ro) {
        this.renderView.setChild(ro);
        this.renderView._relayoutBoundary = this.renderView;
        this.renderView._needsLayout = 1.0;
        push(this.pipelineOwner.layoutDirty, this.renderView);
        this.scheduleFrame();
    }

    // Refresh surface metrics from the host (called before every frame build).
    readSurface() {
        let si = askHost("gpu.surfaceInfo", []);
        if (isNull(si)) { return 0; }
        this.pw = num(si.width); this.ph = num(si.height);
        if (has(si, "colorFormat")) { SURFACE_FMT = si.colorFormat; }
        this.dpr = 1.0;
        if (has(si, "scaleFactor")) { this.dpr = num(si.scaleFactor); }
        if (this.dpr < 0.1) { this.dpr = 1.0; }
        this.lw = this.pw / this.dpr; this.lh = this.ph / this.dpr;
        if (has(si, "logicalWidth")) { this.lw = num(si.logicalWidth); }
        if (has(si, "logicalHeight")) { this.lh = num(si.logicalHeight); }
        return 0;
    }

    // Build / layout / paint the frame, then submit. The painter is reset with a
    // root scale(dpr) so the tree lays out and paints in *logical* pixels (dp),
    // exactly as Flutter's RenderView scales by devicePixelRatio.
    drawFrame() {
        if (this.font.atlas == 0) { this.font.loadAtlas(); }
        this.readSurface();
        this._needsFrame = 0.0;
        let inst = [];
        if (this.renderView.child != 0) {
            this.renderView.setConfiguration(this.lw, this.lh);
            this.pipelineOwner.flushLayout();
            this.painter.reset(inst);
            this.painter.scale(this.dpr, this.dpr);
            let ctx = new PaintingContext(new Canvas(this.painter, this.font));
            this.pipelineOwner.flushPaint(ctx);
        } else {
            this.painter.reset(inst);
            this.painter.scale(this.dpr, this.dpr);
            if (this.paintFn != 0) { this.paintFn(new Canvas(this.painter, this.font), new Size(this.lw, this.lh)); }
        }
        this.submit(inst);
    }

    frameBindings() {
        return [
            bufF32("elpa.fl.globals", ["UNIFORM", "COPY_DST"], [this.pw, this.ph, 0.0, 0.0]),
            { kind: "bindGroup", id: "elpa.fl.gb", layout: "elpa.fl.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: "elpa.fl.globals" } },
                { binding: 1, resource: { type: "textureView", texture: this.font.atlasId() } },
                { binding: 2, resource: { type: "sampler", sampler: "elpa.fl.samp" } } ] },
        ];
    }
    submit(inst) {
        this.frameN = this.frameN + 1;
        let bg = this.clearColor;
        let res = concat(concat(sdfPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.fl.inst", ["VERTEX", "COPY_DST"], inst),
        ]));
        let pass = { op: "renderPass", id: "elpa.fl.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.fl.gb" },
                { cmd: "setPipeline", pipeline: "elpa.fl.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.fl.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(inst) / 16, first_vertex: 0, first_instance: 0 },
            ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
    }

    // ---- host event loop (expanded by the gestures layer) -------------------
    onEvent(e) { return 0; }
    onFrame(dt) {
        let moving = this.ticker.advance();
        if (moving > 0.5) { this.scheduleFrame(); }
        if (this._needsFrame > 0.5) { this.drawFrame(); }
    }
    onResize(info) { this.drawFrame(); }
}

// The one binding instance — Flutter's WidgetsFlutterBinding.ensureInitialized().
let WB = new WidgetsBinding();

// Step-1 entry: paint directly through a dart:ui Canvas callback. Superseded by
// the widget-tree `runApp(widget)` once the widgets layer lands.
function runPaint(fn) { WB.paintFn = fn; WB.drawFrame(); }

// Step-2 entry: mount a render object as the root and draw a frame (proves the
// rendering layer before the widgets layer inflates the tree for you).
function runRenderObject(ro) { WB.setRoot(ro); WB.drawFrame(); }

// ---- host entry points -------------------------------------------------------
function onEvent(e) { WB.onEvent(e); }
function onFrame(dt) { WB.onFrame(dt); }
function onResize(info) { WB.onResize(info); }
