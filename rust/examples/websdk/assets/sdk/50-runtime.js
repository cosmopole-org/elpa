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
        // The build fn runs here (not in paint), so set `paintingComp` around it:
        // any animTime()/tween() the component reads must subscribe *this* node so
        // the frame clock repaints the right component.
        let build = this.fn;
        let prevc = app.clock.paintingComp; app.clock.paintingComp = this;
        this._sub = build(this.p, this._update);
        app.clock.paintingComp = prevc;
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
    // Re-paint the page *without* re-mounting. Scrolling and flinging change
    // neither the element tree nor any computed style - only the scroll offset,
    // which is applied as a paint-time shift in `paintChildren`. So the expensive
    // half of `renderApp` (re-running every component function and the whole CSS
    // cascade) is pure waste here; skipping it - and reusing the memoized measures,
    // which stay valid because layout is unchanged - is what keeps scrolling at a
    // high frame rate.
    renderScroll() {
        this.hovers = []; this.media.resetRefs();
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
        let painted = [];
        for (let i = 0; i < len(dirty); i++) {
            let c = dirty[i]; c._dirtyFlag = 0.0;
            // Skip a component that has not been laid out yet (e.g. scrolled out of
            // view, so never painted): it has no centre, and there is nothing on
            // screen to refresh. It re-subscribes when it next paints.
            if (isNull(c._cx)) { } else {
                // Re-run the component (a partial re-mount) so any animTime()/tween()
                // it reads is re-evaluated against the new clock and re-subscribed —
                // a bare re-paint would reuse last frame's values and drop the
                // continuous subscription, freezing the animation after one frame.
                c.mount(this, c._parent);
                c._sub._cbW = c._cbW; c._sub._cbH = c._cbH; c._sub._fw = c._fw; c._sub._fh = c._fh;
                c.paint(this, c._cx, c._cy); push(painted, c);
            }
        }
        this.root.reassemble();
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        if (this.layered > 0.5) { this.submitLayered(painted); } else { this.submit(); }
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
        // A backdrop-filter region needs the two-pass frosted-glass compositor.
        if (this.hasBackdrop(this.inst) > 0.5) { this.submitBackdrop(); return 0; }
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
        // A frame with a backdrop falls out of the static/dynamic fast path (it
        // needs the offscreen capture + composite); route it through `submit`.
        if (this.hasBackdrop(this.inst) > 0.5) { this.submit(); return 0; }
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

    // ---- backdrop blur (frosted glass) --------------------------------------
    // A `backdrop-filter: blur()` region needs a two-stage frame: everything
    // painted *before* a backdrop sentinel is rendered into an offscreen texture
    // (pass A); the surface pass (B) redraws that content sharp, composites a
    // blurred copy of it inside each backdrop region (multi-tap samples of the
    // offscreen texture through the image pipeline — a cheap box blur), then draws
    // everything painted *after* on top. (Images in the same frame are not
    // interleaved on this path; a frosted region and an <img> do not co-occur in
    // the kit's pages.)
    hasBackdrop(inst) { let n = len(inst) / 16; for (let i = 0; i < n; i++) { if (inst[i * 16] == BACKDROP_MARK) { return 1.0; } } return 0.0; }
    scanBackdrops(inst) {
        let n = len(inst) / 16; let marks = []; let last = -1;
        for (let i = 0; i < n; i++) { if (inst[i * 16] == BACKDROP_MARK) { push(marks, i); last = i; } }
        return { marks: marks, last: last };
    }
    // Contiguous runs of plain SDF instances in [lo, hi), splitting at any image
    // or backdrop sentinel (whose slots the SDF draw must not read).
    sdfRuns(inst, lo, hi) {
        let runs = []; let start = -1;
        for (let i = lo; i < hi; i++) {
            let mark = inst[i * 16]; let sentinel = 0.0;
            if (mark == IMG_MARK) { sentinel = 1.0; } if (mark == BACKDROP_MARK) { sentinel = 1.0; }
            if (sentinel > 0.5) { if (start >= 0) { push(runs, { first: start, count: i - start }); start = -1; } }
            else { if (start < 0) { start = i; } }
        }
        if (start >= 0) { push(runs, { first: start, count: hi - start }); }
        return runs;
    }
    regionAt(inst, i) {
        let b = i * 16;
        return { blur: inst[b + 1], cx: inst[b + 2], cy: inst[b + 3], hw: inst[b + 4], hh: inst[b + 5], r: inst[b + 6] };
    }
    sdfDrawCmds(runs) {
        let cmds = [];
        for (let i = 0; i < len(runs); i++) { push(cmds, { cmd: "draw", vertex_count: 6, instance_count: runs[i].count, first_vertex: 0, first_instance: runs[i].first }); }
        return cmds;
    }
    // Multi-tap blur composite of region `rg`, sampling the offscreen scene texture
    // through the image pipeline (an opaque centre tap + four half-weight diagonal
    // taps; the reduced-resolution scene's linear upsample pre-blurs it).
    backdropTapCmds(rg, sceneTex, res, tag) {
        let m = this.metrics; let cmds = [];
        let b = rg.blur; if (b < 0.5) { b = 0.5; }
        let taps = [[0.0, 0.0, 1.0], [b, b, 0.5], [-b, b, 0.5], [b, -b, 0.5], [-b, -b, 0.5]];
        let u0b = (rg.cx - rg.hw) / m.vw; let v0b = (rg.cy - rg.hh) / m.vh;
        let u1b = (rg.cx + rg.hw) / m.vw; let v1b = (rg.cy + rg.hh) / m.vh;
        for (let i = 0; i < len(taps); i++) {
            let dx = taps[i][0] / m.vw; let dy = taps[i][1] / m.vh; let a = taps[i][2];
            let uid = concat(concat("elpa.web.bd.u.", tag), str(i)); let bid = concat(concat("elpa.web.bd.bg.", tag), str(i));
            push(res, bufF32(uid, ["UNIFORM", "COPY_DST"],
                [m.vw, m.vh, rg.cx, rg.cy, rg.hw, rg.hh, rg.r, 0.0, u0b + dx, v0b + dy, u1b + dx, v1b + dy, 1.0, 1.0, 1.0, a]));
            push(res, { kind: "bindGroup", id: bid, layout: "elpa.web.img.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: uid } },
                { binding: 1, resource: { type: "textureView", texture: sceneTex } },
                { binding: 2, resource: { type: "sampler", sampler: "elpa.web.img.samp" } } ] });
            push(cmds, { cmd: "setPipeline", pipeline: "elpa.web.img.pipe" });
            push(cmds, { cmd: "setBindGroup", index: 0, bind_group: bid });
            push(cmds, { cmd: "draw", vertex_count: 6, instance_count: 1, first_vertex: 0, first_instance: 0 });
        }
        return cmds;
    }
    submitBackdrop() {
        let m = this.metrics; let bg = this.clearCol;
        let scan = this.scanBackdrops(this.inst);
        let n = len(this.inst) / 16;
        let below = this.sdfRuns(this.inst, 0, scan.last);
        let above = this.sdfRuns(this.inst, scan.last + 1, n);
        // The blur source is captured at reduced resolution (BD_SCALE): blur is a
        // low-frequency effect, so a smaller offscreen target cuts fill-rate while
        // its linear upsample only helps. Geometry maps by NDC (globals stay vw,vh).
        let sw = floor(m.vw / BD_SCALE) + 1; let sh = floor(m.vh / BD_SCALE) + 1;
        if (sw < 1) { sw = 1; } if (sh < 1) { sh = 1; }
        let sceneTex = concat(concat(concat("elpa.web.bd.scene.", str(sw)), "x"), str(sh));
        let res = concat(concat(webPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.web.inst", ["VERTEX", "COPY_DST"], this.inst),
            { kind: "texture", id: sceneTex, size: { width: sw, height: sh }, format: SURFACE_FMT,
              usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"] },
        ]));
        this.media.addImgPipeline(res);
        let uploads = this.font.atlasUploadCmds();
        // Pass A: render the below-backdrop content into the offscreen scene.
        let sceneCmds = concat([
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.web.gb" },
            { cmd: "setPipeline", pipeline: "elpa.web.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst", offset: 0 },
        ], this.sdfDrawCmds(below));
        let scenePass = { op: "renderPass", id: "elpa.web.bd.scenePass",
            color_attachments: [{ view: { kind: "texture", texture: sceneTex }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: sceneCmds };
        // Pass B (surface): sharp below content, then the blurred composite inside
        // each region, then the above content on top.
        let surfCmds = concat([
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.web.gb" },
            { cmd: "setPipeline", pipeline: "elpa.web.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst", offset: 0 },
        ], this.sdfDrawCmds(below));
        for (let k = 0; k < len(scan.marks); k++) {
            let rg = this.regionAt(this.inst, scan.marks[k]);
            surfCmds = concat(surfCmds, this.backdropTapCmds(rg, sceneTex, res, str(k)));
        }
        surfCmds = concat(surfCmds, [
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.web.gb" },
            { cmd: "setPipeline", pipeline: "elpa.web.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.web.inst", offset: 0 },
        ]);
        surfCmds = concat(surfCmds, this.sdfDrawCmds(above));
        let surfPass = { op: "renderPass", id: "elpa.web.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: surfCmds };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [scenePass, surfPass]) }]);
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
            if (this.scrollDragOn > 0.5) { let dy = this.scrollDragY - py; this.scrollBy(px, this.scrollDragY, dy); this.scrollVel = this.scrollVel * 0.55 + dy * 0.45; this.scrollDragY = py; this.renderScroll(); }
            else { if (has(this, "dragging")) { if (this.dragging > 0.5) { this.activeDrag.onDrag(px, py); return 0; } } this.hoverRepaint(px, py); }
        }
        if (et == "pointerup") {
            if (this.scrollDragOn > 0.5) { if (abs(this.scrollVel) > 0.6) { this.flingId = this.scrollDragId; this.flingV = this.scrollVel; } }
            this.dragging = 0.0; this.scrollDragOn = 0.0; this.repaint();
        }
        if (et == "wheel") { let h = this.scrollBy(px, py, e.deltaY); if (h > 0.5) { this.renderScroll(); } }
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
        let dirty = []; this.clock.advance(dirty, dt);
        let flinging = this.flingStep();
        if (flinging > 0.5) { for (let i = 0; i < len(dirty); i++) { dirty[i]._dirtyFlag = 0.0; } this.renderScroll(); return 0; }
        if (len(dirty) > 0) { this.repaintComps(dirty); return 0; }
        if (mediaChanged > 0.5) { this.submit(); }
    }
    onResize(info) { this.metrics.setMetrics(info); VPGLOBAL = this.metrics; this.renderApp(); }
}
