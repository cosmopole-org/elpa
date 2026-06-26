// Elpa Flutter — WidgetsFlutterBinding + runApp (the glue to the host).
//
// The binding owns the engine services (Painter, FontEngine, Ticker), reads the
// surface metrics, and runs the per-frame pipeline that ends in `scene.submit`
// (a Vello scene of vector ops). This is Flutter's RendererBinding +
// WidgetsBinding: it holds the RenderView, drives drawFrame (build → layout →
// paint → composite → submit), routes pointer events through a hit test, and
// schedules frames for implicit animations.
//
// `drawFrame` resets the Painter, paints the RenderView (or a direct callback),
// then submits the recorded Vello scene; `submit` is the final implementation.

// The kit draws through the Vello scene pipe (`scene.submit`): there is no wgpu
// pipeline to declare — the host rasterizes the high-level vector ops the Painter
// records. (Raw wgpu survives as the `rawWgpu` scene op, which this kit does not
// need.)

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
        this.readSurface();
        // Load the real UI font once (no-op after the first attempt); text then
        // renders as crisp Vello glyph runs instead of vector stroke capsules.
        this.font.ensureLoaded();
        this._needsFrame = 0.0;
        // Phase 1: rebuild dirty elements (build → reconcile render tree).
        if (this.buildOwner != 0) { this.buildOwner.buildScope(this.rootElement); }
        let ops = [];
        this.painter.reset(ops);
        this.painter.scale(this.dpr, this.dpr);
        this.paintBackground();
        if (this.renderView.child != 0) {
            this.renderView.setConfiguration(this.lw, this.lh);
            this.pipelineOwner.flushLayout();
            let ctx = new PaintingContext(new Canvas(this.painter, this.font));
            this.pipelineOwner.flushPaint(ctx);
        } else {
            if (this.paintFn != 0) { this.paintFn(new Canvas(this.painter, this.font), new Size(this.lw, this.lh)); }
        }
        this.painter.finish();
        this.submit(ops);
    }

    // Clear the surface by filling the whole logical canvas with the scaffold
    // colour as the first scene op (Vello composites the rest on top). Replaces
    // the old render pass `load: "clear"`.
    paintBackground() {
        let bg = this.clearColor; let c = [bg[0], bg[1], bg[2], 1.0];
        this.painter.rrect(this.lw / 2.0, this.lh / 2.0, this.lw / 2.0, this.lh / 2.0, 0.0, 0.0, 0.0, c, CLEAR);
    }
    // Stream the recorded Vello scene to the host. The whole batch of vector ops
    // is one `scene.submit`; the host rasterizes it with Vello (and the scene
    // renderer skips re-presenting an unchanged frame).
    submit(ops) {
        this.frameN = this.frameN + 1;
        // The font resource is declared once (the renderer keeps it resident); on
        // every other frame `sceneResources()` returns [], so the heavy font blob
        // is not re-embedded in — and re-serialized for — each submit.
        askHost("scene.submit", [{ resources: this.font.sceneResources(), ops: ops }]);
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
