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
              array_stride: 96, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 },
                  { format: "float32x4", offset: 64, shader_location: 4 },
                  { format: "float32x4", offset: 80, shader_location: 5 }] }] },
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
        this.downListeners = []; this.downTargets = [];
        this.downX = 0.0; this.downY = 0.0; this.dragDist = 0.0;
        // The SDF pipeline descriptors (shader/layout/pipeline) are constant for
        // the app's lifetime. Build the (sizeable) nested descriptor tree once and
        // reuse it every frame instead of reconstructing ~20 objects per submit —
        // the host caches GPU resources by id, so re-sending the identical tree is
        // free, and the VM no longer rebuilds it on the hot frame path.
        this._pipeRes = 0;
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
        // Phase 1: rebuild dirty elements (build → reconcile render tree).
        if (this.buildOwner != 0) { this.buildOwner.buildScope(this.rootElement); }
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
        if (this._pipeRes == 0) { this._pipeRes = sdfPipelineResources(); }
        let res = concat(concat(this._pipeRes, this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.fl.inst", ["VERTEX", "COPY_DST"], inst),
        ]));
        let pass = { op: "renderPass", id: "elpa.fl.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.fl.gb" },
                { cmd: "setPipeline", pipeline: "elpa.fl.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.fl.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(inst) / 24, first_vertex: 0, first_instance: 0 },
            ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
    }

    // ---- pointer routing (Flutter's GestureBinding.hitTest + dispatch) -------
    // Hit-test the render tree at the pointer (logical px) and return the path of
    // render objects under it (innermost first).
    hitTestAt(lx, ly) {
        let result = new HitTestResult();
        this.renderView.hitTest(result, new Offset(lx, ly));
        return result;
    }
    dispatchEvent(result, eventObj) {
        for (let i = 0; i < len(result.path); i++) {
            let entry = result.path[i]; let t = entry.target;
            if (has(t, "_wantsPointer")) { t.handleEvent(eventObj, entry.localPosition); }
        }
    }
    onEvent(e) {
        let lx = e.nx * this.lw; let ly = e.ny * this.lh;
        let result = this.hitTestAt(lx, ly);
        let ev = { type: e.type, dx: lx, dy: ly, key: e.key, deltaY: e.deltaY };
        this.dispatchEvent(result, ev);
        // A minimal tap recognizer: a press then release over the same listener
        // (with an onTap) fires the tap.
        if (e.type == "pointerdown") {
            this.downTargets = []; this.downX = lx; this.downY = ly; this.dragDist = 0.0;
            for (let i = 0; i < len(result.path); i++) { let t = result.path[i].target; if (has(t, "handlers")) { if (has(t.handlers, "onTap")) { push(this.downTargets, t); } } }
        }
        if (e.type == "pointermove") {
            let dx = lx - this.downX; let dy = ly - this.downY; let d = sqrt(dx * dx + dy * dy);
            if (d > this.dragDist) { this.dragDist = d; }
        }
        if (e.type == "pointerup") {
            // A drag past the touch slop cancels the tap (Flutter's gesture arena:
            // a scroll/drag wins over a tap once the pointer moves far enough).
            if (this.dragDist < 12.0) {
                for (let i = 0; i < len(result.path); i++) {
                    let t = result.path[i].target;
                    if (has(t, "handlers")) { if (has(t.handlers, "onTap")) { if (this.inDownTargets(t)) { t.handlers.onTap(); } } }
                }
            }
            this.downTargets = [];
        }
        // setState / pointer handlers may have dirtied the tree; produce a frame.
        if (this._needsFrame > 0.5) { this.drawFrame(); }
    }
    inDownTargets(t) { for (let i = 0; i < len(this.downTargets); i++) { if (sameRef(this.downTargets[i], t)) { return true; } } return false; }
    onFrame(dt) {
        // Drive every active AnimationController with the real elapsed dt (ms) —
        // frame-rate-independent, smooth motion (Flutter's SchedulerBinding).
        let active = SCHED.tick(dt);
        let moving = this.ticker.advance();
        if (active > 0.5) { this.scheduleFrame(); }
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

// Inflate a widget tree and run it (Flutter's runApp): wrap the app in the root
// element, mount it (build → element tree → render tree wired to the RenderView),
// then draw the first frame.
function runApp(widget) {
    let owner = new BuildOwner();
    WB.buildOwner = owner;
    let el = new RootElement(new RootWidget(widget));
    el.mountRoot(owner);
    WB.rootElement = el;
    WB.drawFrame();
}

// ---- host entry points -------------------------------------------------------
function onEvent(e) { WB.onEvent(e); }
function onFrame(dt) { WB.onFrame(dt); }
function onResize(info) { WB.onResize(info); }
