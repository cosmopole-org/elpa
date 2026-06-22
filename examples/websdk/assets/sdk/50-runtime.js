// Elpa Web SDK - the retained-tree runtime (WebRuntime).
//
// `ComponentNode` is the React/Flutter-style element: a `(props, update) ->
// element` function with its own identity, so `update()` re-runs *only* it and
// repaints its subtree in place while ancestors reassemble from cached output.
// `WebRuntime` is the framework instance `W` (created in 60-api): it owns the
// engine services, mounts and paints the document tree, runs the per-frame
// transition/animation clock, drives the DOM-style event loop (click, hover,
// scroll, focus, keyboard) and builds the `gpu.submit` frame. The whole UI is
// one instanced SDF draw (text, boxes, borders, gradients, shadows), so it stays
// high-FPS regardless of element count; `setLayered(true)` additionally splits
// the static (non-animating) instances into a buffer the renderer skips
// re-uploading, leaving only the moving elements to re-stream each frame.

// A mounted component. `update` re-runs just this node and repaints its subtree.
class ComponentNode extends Box {
    constructor(fn, props) { super("#component", props); this.fn = fn; }
    kids() { return [this._sub]; }
    uaStyle() { return { display: "contents" }; }
    mount(app, parent) {
        this._parent = parent; this._d = app.metrics.dpr;
        this._inhOut = inhOf(parent); this._cs = { display: "contents" };
        if (!has(this, "_update")) { let self = this; this._update = () => { app.partial(self); }; }
        let build = this.fn; this._sub = build(this.p, this._update);
        if (isNull(this._sub)) { this._sub = new TextRun(""); }
        this.forward();
        this._sub.mount(app, parent);
        // A component is transparent (it paints/measures through its single sub):
        // adopt the sub's computed style so the parent's layout reads the real
        // box-model fields (margins, width, flex, display) off this node, not the
        // bare `{display:"contents"}` stub — whose missing `.m`/`.width`/… read as
        // null in flow/flex/grid.
        this._cs = this._sub._cs;
    }
    forward() { this._sub._fw = this._fw; this._sub._fh = this._fh; this._sub._cbW = this._cbW; this._sub._cbH = this._cbH; }
    measureIntrinsic(app) { this.forward(); return this._sub.measure(app); }
    measure(app) { this.forward(); return this._sub.measure(app); }
    resolvedW(app) { return this._sub.resolvedW(app); }
    isInline() { return this._sub.isInline(); }
    isAbs() { return this._sub.isAbs(); }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy; this.forward();
        let prev = app.clock.paintingComp; app.clock.paintingComp = this;
        this._sub.paint(app, cx, cy);
        app.clock.paintingComp = prev;
        this._kids = [this._sub]; this.compose();
    }
    compose() { this._out = this._sub._out; this._taps = this._sub._taps; this._drags = this._sub._drags; return 0; }
    reassemble() { this._sub.reassemble(); this.compose(); return 0; }
    bucket(dyn) {
        if (has(this, "_animLayer")) { if (this._animLayer > 0.5) { for (let i = 0; i < len(this._out); i++) { push(dyn, this._out[i]); } return []; } }
        return this._sub.bucket(dyn);
    }
}

let NULLNODE = { _isNull: 1.0 };

// The shared SDF pipeline (one instanced draw paints the whole document).
function webPipelineResources() {
    return [
        { kind: "shader", id: "elpa.web.shader", wgsl: SDF_WGSL },
        { kind: "bindGroupLayout", id: "elpa.web.bgl",
          entries: [
              { binding: 0, visibility: ["VERTEX"], ty: "uniform" },
              { binding: 1, visibility: ["FRAGMENT"], ty: "texture" },
              { binding: 2, visibility: ["FRAGMENT"], ty: "sampler" }] },
        { kind: "pipelineLayout", id: "elpa.web.layout", bind_group_layouts: ["elpa.web.bgl"] },
        { kind: "renderPipeline", id: "elpa.web.pipe", layout: "elpa.web.layout",
          vertex: { module: "elpa.web.shader", entry_point: "vs", buffers: [{
              array_stride: 64, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 }] }] },
          fragment: { module: "elpa.web.shader", entry_point: "fs", targets: [{
              format: SURFACE_FMT,
              blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                       alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
    ];
}

class WebRuntime {
    constructor() {
        this.painter = new Painter();
        this.metrics = new Viewport();
        this.font = new FontEngine();
        this.icons = new IconEngine();
        this.media = new MediaEngine();
        this.clock = new AnimationClock();
        this.media.app = this;
        this.root = 0; this.running = 0.0; this.layered = 0.0;
        this.inst = []; this.taps = []; this.drags = [];
        this.hx = -100000.0; this.hy = -100000.0; this.hoverSig = ""; this.hoverIds = [];
        this.hovers = []; this.focusId = ""; this.keyFn = 0; this.hasKey = 0.0;
        this.scroll = {}; this.listRegions = {};
        this.scrollDragOn = 0.0; this.scrollDragId = ""; this.scrollDragY = 0.0; this.scrollVel = 0.0;
        this.flingId = ""; this.flingV = 0.0; this.frameN = 0; this.sidN = 0;
        this.dragging = 0.0; this.activeDrag = 0; this.clearCol = [1.0, 1.0, 1.0];
    }
    isHovered(id) { for (let i = 0; i < len(this.hoverIds); i++) { if (this.hoverIds[i] == id) { return 1.0; } } return 0.0; }
    repaint() { this.renderApp(); }
    refont() { if (this.running > 0.5) { this.renderApp(); } }

    runApp(rootCtor) { this.root = rootCtor({}); this.running = 1.0; this.renderApp(); }
    renderApp() {
        if (this.font.atlas == 0) { this.font.loadAtlas(); }
        let si = askHost("gpu.surfaceInfo", []);
        this.metrics.setMetrics(si); VPGLOBAL = this.metrics;
        this.hasKey = 0.0; this.hovers = []; this.media.resetRefs();
        this.root._cbW = this.metrics.vw; this.root._cbH = this.metrics.vh;
        this.root._fw = this.metrics.vw; this.root._fh = this.metrics.vh;
        this.root.mount(this, NULLNODE);
        this.root._cbW = this.metrics.vw; this.root._cbH = this.metrics.vh;
        this.root._fw = this.metrics.vw; this.root._fh = this.metrics.vh;
        this.root.paint(this, this.metrics.vw * 0.5, this.metrics.vh * 0.5);
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }
    // Re-run one component, repaint its subtree in place, reassemble to the root.
    partial(node) {
        node.mount(this, node._parent);
        node._sub._cbW = node._cbW; node._sub._cbH = node._cbH; node._sub._fw = node._fw; node._sub._fh = node._fh;
        node.paint(this, node._cx, node._cy);
        let a = node._parent;
        for (let guard = 0; guard < 128; guard++) { if (has(a, "_isNull")) { guard = 999; } else { a.compose(); a = a._parent; } }
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }
    repaintComps(dirty) {
        for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c.paint(this, c._cx, c._cy); c._dirtyFlag = 0.0; }
        this.root.reassemble();
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        if (this.layered > 0.5) { this.submitLayered(dirty); } else { this.submit(); }
    }

    // ---- submit (single instanced SDF draw, images interleaved) -------------
    frameBindings() {
        let m = this.metrics;
        return [
            bufF32("elpa.web.globals", ["UNIFORM", "COPY_DST"], [m.vw, m.vh, 0.0, 0.0]),
            { kind: "bindGroup", id: "elpa.web.gb", layout: "elpa.web.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: "elpa.web.globals" } },
                { binding: 1, resource: { type: "textureView", texture: this.font.atlasId() } },
                { binding: 2, resource: { type: "sampler", sampler: "elpa.web.samp" } } ] },
        ];
    }
    submitPlain() {
        let bg = this.clearCol;
        let res = concat(concat(webPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.web.inst", ["VERTEX", "COPY_DST"], this.inst),
        ]));
        let pass = { op: "renderPass", id: "elpa.web.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.web.gb" },
                { cmd: "setPipeline", pipeline: "elpa.web.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(this.inst) / 16, first_vertex: 0, first_instance: 0 },
            ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
    }
    submit() {
        this.frameN = this.frameN + 1;
        if (this.media.imgHandleN == 0) { this.submitPlain(); return 0; }
        let bg = this.clearCol; let plan = this.media.planDraws(this.inst);
        if (len(plan.handles) == 0) { this.submitPlain(); return 0; }
        let res = concat(concat(webPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.web.inst", ["VERTEX", "COPY_DST"], plan.buf),
        ]));
        this.media.addImgPipeline(res);
        let uploads = this.font.atlasUploadCmds();
        let pcmds = this.media.imgDrawCmds(plan, "elpa.web.inst", "", res, uploads, {});
        let pass = { op: "renderPass", id: "elpa.web.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: pcmds };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [pass]) }]);
    }
    // Static/dynamic split: only animating components' instances re-stream.
    submitLayered(animating) {
        for (let i = 0; i < len(animating); i++) { animating[i]._animLayer = 1.0; }
        let dyn = []; let stat = this.root.bucket(dyn);
        for (let i = 0; i < len(animating); i++) { animating[i]._animLayer = 0.0; }
        if (len(dyn) < 1) { this.submit(); return 0; }
        if (this.media.imgHandleN > 0) { this.submit(); return 0; }
        let bg = this.clearCol;
        let res = concat(concat(webPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.web.inst.static", ["VERTEX", "COPY_DST"], stat),
            bufF32("elpa.web.inst.dyn", ["VERTEX", "COPY_DST"], dyn),
        ]));
        let pass = { op: "renderPass", id: "elpa.web.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.web.gb" },
                { cmd: "setPipeline", pipeline: "elpa.web.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst.static", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(stat) / 16, first_vertex: 0, first_instance: 0 },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst.dyn", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(dyn) / 16, first_vertex: 0, first_instance: 0 },
            ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
        return 0;
    }

    // ---- scrolling (overflow:scroll/auto) ------------------------------------
    scrollBy(px, py, delta) {
        let ids = keys(this.listRegions); let handled = 0.0;
        for (let i = 0; i < len(ids); i++) {
            let id = ids[i]; let rg = this.listRegions[id];
            if (rg.maxOff > 0.5) { if (inRect(px, py, rg.cx, rg.cy, rg.hw, rg.hh)) {
                let off = 0.0; if (has(this.scroll, id)) { off = this.scroll[id]; }
                off = off + delta; if (off < 0.0) { off = 0.0; } if (off > rg.maxOff) { off = rg.maxOff; }
                this.scroll[id] = off; handled = 1.0;
            } }
        }
        return handled;
    }
    scrollIdAt(px, py) {
        let ids = keys(this.listRegions);
        for (let i = 0; i < len(ids); i++) { let id = ids[i]; let rg = this.listRegions[id]; if (rg.maxOff > 0.5) { if (inRect(px, py, rg.cx, rg.cy, rg.hw, rg.hh)) { return id; } } }
        return "";
    }

    // ---- hover ----------------------------------------------------------------
    hoverIdsAt(px, py) {
        let ids = [];
        for (let i = 0; i < len(this.hovers); i++) { let h = this.hovers[i]; if (inRect(px, py, h.cx, h.cy, h.hw, h.hh)) { push(ids, h.id); } }
        return ids;
    }
    hoverRepaint(px, py) {
        let ids = this.hoverIdsAt(px, py); let sig = "";
        for (let i = 0; i < len(ids); i++) { sig = concat(concat(sig, "|"), ids[i]); }
        if (sig == this.hoverSig) { return 0; }
        this.hoverSig = sig; this.hoverIds = ids; this.repaint(); return 0;
    }

    // ---- event loop -----------------------------------------------------------
    onEvent(e) {
        let et = e.type; let px = e.nx * this.metrics.vw; let py = e.ny * this.metrics.vh;
        if (et == "pointermove") { this.hx = px; this.hy = py; }
        if (et == "pointerdown") {
            this.flingId = ""; this.flingV = 0.0; let hitTap = 0;
            for (let i = 0; i < len(this.taps); i++) { let t = this.taps[i]; if (inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { hitTap = t; } }
            let hitDrag = 0;
            for (let i = 0; i < len(this.drags); i++) { let dd = this.drags[i]; if (inRect(px, py, dd.cx, dd.cy, dd.hw, dd.hh)) { hitDrag = dd; } }
            if (hitDrag != 0) { this.dragging = 1.0; this.activeDrag = hitDrag; hitDrag.onDrag(px, py); return 0; }
            if (hitTap != 0) {
                this.clock.pressDown(hitTap.id);
                if (has(hitTap, "focus")) { this.focusId = hitTap.focus; this.keyFn = hitTap.keyFn; this.hasKey = 1.0; }
                hitTap.onTap(); return 0;
            }
            let sid = this.scrollIdAt(px, py);
            if (len(sid) > 0) { this.scrollDragOn = 1.0; this.scrollDragId = sid; this.scrollDragY = py; this.scrollVel = 0.0; }
            else { if (len(this.focusId) > 0) { this.focusId = ""; this.hasKey = 0.0; this.repaint(); } }
        }
        if (et == "pointermove") {
            if (this.scrollDragOn > 0.5) { let dy = this.scrollDragY - py; this.scrollBy(px, this.scrollDragY, dy); this.scrollVel = this.scrollVel * 0.55 + dy * 0.45; this.scrollDragY = py; this.repaint(); }
            else { if (has(this, "dragging")) { if (this.dragging > 0.5) { this.activeDrag.onDrag(px, py); return 0; } } this.hoverRepaint(px, py); }
        }
        if (et == "pointerup") {
            if (this.scrollDragOn > 0.5) { if (abs(this.scrollVel) > 0.6) { this.flingId = this.scrollDragId; this.flingV = this.scrollVel; } }
            this.dragging = 0.0; this.scrollDragOn = 0.0; this.repaint();
        }
        if (et == "wheel") { let h = this.scrollBy(px, py, e.deltaY); if (h > 0.5) { this.repaint(); } }
        if (et == "keydown") { if (this.hasKey > 0.5) { if (this.keyFn != 0) { this.keyFn(e.key); } } }
    }
    flingStep() {
        if (len(this.flingId) == 0) { return 0.0; }
        if (!has(this.listRegions, this.flingId)) { this.flingId = ""; this.flingV = 0.0; return 0.0; }
        let rg = this.listRegions[this.flingId]; let off = 0.0; if (has(this.scroll, this.flingId)) { off = this.scroll[this.flingId]; }
        off = off + this.flingV; let edge = 0.0;
        if (off <= 0.0) { off = 0.0; edge = 1.0; } if (off >= rg.maxOff) { off = rg.maxOff; edge = 1.0; }
        this.scroll[this.flingId] = off; this.flingV = this.flingV * 0.93;
        if (edge > 0.5) { this.flingV = 0.0; this.flingId = ""; return 1.0; }
        if (abs(this.flingV) < 0.4) { this.flingV = 0.0; this.flingId = ""; }
        return 1.0;
    }
    onFrame(dt) {
        let mediaChanged = this.media.tick();
        let dirty = []; this.clock.advance(dirty);
        let flinging = this.flingStep();
        if (flinging > 0.5) { for (let i = 0; i < len(dirty); i++) { dirty[i]._dirtyFlag = 0.0; } this.repaint(); return 0; }
        if (len(dirty) > 0) { this.repaintComps(dirty); return 0; }
        if (mediaChanged > 0.5) { this.submit(); }
    }
    onResize(info) { this.metrics.setMetrics(info); VPGLOBAL = this.metrics; this.renderApp(); }
}
