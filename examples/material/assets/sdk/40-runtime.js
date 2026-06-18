// Elpa Material — the retained-tree runtime.
//
// `ComponentNode` is the React/Flutter-style element: a plain `(props, update) =>
// widget` function with its own identity, so `update()` re-runs *only* it.
// `Material` is the framework instance — it owns the engine services, mounts and
// paints the retained tree, runs the partial-update / per-frame-animation clock,
// drives the event loop, and builds the `gpu.submit` frame. A single instance
// `M` (created in 50-api) is the composition root; the public API and the host
// entry points delegate to it.

// A mounted component. Its `update` re-runs just this node's function and
// repaints its subtree in place; ancestors reassemble from cached output.
class ComponentNode extends Widget {
    constructor(fn, props) { super(props); this.fn = fn; }
    children(app) { return [this._sub]; }
    mount(app, parent) {
        this._parent = parent;
        if (!has(this, "_update")) { let self = this; this._update = () => { app.partial(self); }; }
        let build = this.fn; this._sub = build(this.p, this._update);
        this._sub.mount(app, this);
    }
    measureIntrinsic(app) { return this._sub.measure(app); }
    paint(app, cx, cy) {
        this._cx = cx; this._cy = cy;
        let prev = app.clock.paintingComp; app.clock.paintingComp = this;
        this._sub.paint(app, cx, cy);
        app.clock.paintingComp = prev;
        this._kids = [this._sub]; this.compose();
    }
    compose() { this._out = this._sub._out; this._taps = this._sub._taps; this._drags = this._sub._drags; return 0; }
    reassemble() { this._sub.reassemble(); this.compose(); return 0; }
    bucket(dyn) {
        if (has(this, "_animLayer")) { if (this._animLayer > 0.5) {
            for (let i = 0; i < len(this._out); i++) { push(dyn, this._out[i]); }
            return [];
        } }
        return this._sub.bucket(dyn);
    }
}

// The isolating wrapper for the navigation drawer (see ScaffoldWidget.drawerHost):
// it simply renders the widget it is handed, so the drawer's open/close slide
// marks only this component dirty.
function overlayBuilder(props, update) { return props.child; }

// Tree-root sentinel parent (the partial-reassembly walk stops here).
let NULLNODE = { _isNull: 1.0 };

// The shared SDF pipeline resources (one pipeline draws the whole UI).
function sdfPipelineResources() {
    return [
        { kind: "shader", id: "elpa.m3.shader", wgsl: SDF_WGSL },
        { kind: "bindGroupLayout", id: "elpa.m3.bgl",
          entries: [
              { binding: 0, visibility: ["VERTEX"], ty: "uniform" },
              { binding: 1, visibility: ["FRAGMENT"], ty: "texture" },
              { binding: 2, visibility: ["FRAGMENT"], ty: "sampler" }] },
        { kind: "pipelineLayout", id: "elpa.m3.layout", bind_group_layouts: ["elpa.m3.bgl"] },
        { kind: "renderPipeline", id: "elpa.m3.pipe", layout: "elpa.m3.layout",
          vertex: { module: "elpa.m3.shader", entry_point: "vs", buffers: [{
              array_stride: 64, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 }] }] },
          fragment: { module: "elpa.m3.shader", entry_point: "fs", targets: [{
              format: "bgra8unorm",
              blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                       alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
    ];
}

class Material {
    constructor() {
        this.painter = new Painter();
        this.theme = new Theme();
        this.metrics = new Metrics();
        this.font = new FontEngine();
        this.icons = new IconEngine();
        this.media = new MediaEngine();
        this.clock = new AnimationClock();
        this.graphics = new GraphicsEngine();
        this.media.app = this;
        this.root = 0; this.running = 0.0; this.layered = 0.0;
        this.inst = []; this.taps = []; this.drags = [];
        this.hx = -1000.0; this.hy = -1000.0; this.hoverSig = ""; this.hoverIds = [];
        this.focused = 0; this.focusInput = 0; this.hasFocusInput = 0.0;
        this.keyHandler = 0; this.hasKey = 0.0; this.wheelFn = 0; this.hasWheel = 0.0;
        this.dragging = 0.0; this.activeDrag = 0;
        this.scroll = {}; this.listRegions = {};
        this.scrollDragOn = 0.0; this.scrollDragId = ""; this.scrollDragY = 0.0; this.scrollVel = 0.0;
        this.flingId = ""; this.flingV = 0.0;
        this.frameN = 0;
    }
    // ---- services the widgets reach through ---------------------------------
    hover(cx, cy, hw, hh) { if (inRect(this.hx, this.hy, cx, cy, hw, hh)) { return 1.0; } return 0.0; }
    registerWheel(onChanged, val) { this.wheelFn = (dy) => { onChanged(clamp01(val + dy * (-0.0015))); }; this.hasWheel = 1.0; }
    repaint() { this.renderApp(); }
    refont() { if (this.running > 0.5) { this.renderApp(); } }

    // ---- mount / render -----------------------------------------------------
    runApp(root) { this.root = root({}); this.running = 1.0; this.renderApp(); }
    renderApp() {
        if (this.font.atlas == 0) { this.font.loadAtlas(); }
        let si = askHost("gpu.surfaceInfo", []);
        this.metrics.setMetrics(si);
        this.hasKey = 0.0; this.hasWheel = 0.0; this.hasFocusInput = 0.0;
        this.media.resetRefs();
        this.root.mount(this, NULLNODE);
        this.root.paint(this, this.metrics.vw * 0.5, this.metrics.vh * 0.5);
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.hoverSig = ""; this.hoverIds = [];
        this.submit();
    }
    // Re-run just one component, repaint its subtree in place, reassemble to root.
    partial(node) {
        node.mount(this, node._parent);
        node.paint(this, node._cx, node._cy);
        let a = node._parent;
        for (let guard = 0; guard < 64; guard++) {
            if (has(a, "_isNull")) { guard = 99; } else { a.compose(); a = a._parent; }
        }
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }
    // Repaint just the dirty components in place (eased values only, no fn re-run),
    // then reassemble bottom-up.
    repaintComps(dirty) {
        for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c.paint(this, c._cx, c._cy); c._dirtyFlag = 0.0; }
        this.root.reassemble();
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        if (this.layered > 0.5) { this.submitLayered(dirty); } else { this.submit(); }
    }
    // Re-emit the whole tree with the current theme (theme cross-fade path).
    repaintAll() {
        this.media.resetRefs();
        this.root.paint(this, this.metrics.vw * 0.5, this.metrics.vh * 0.5);
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }

    // ---- submit -------------------------------------------------------------
    frameBindings() {
        let m = this.metrics;
        return [
            bufF32("elpa.m3.globals", ["UNIFORM", "COPY_DST"], [m.vw, m.vh, 0.0, 0.0]),
            { kind: "bindGroup", id: "elpa.m3.gb", layout: "elpa.m3.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: "elpa.m3.globals" } },
                { binding: 1, resource: { type: "textureView", texture: this.font.atlasId() } },
                { binding: 2, resource: { type: "sampler", sampler: "elpa.m3.samp" } } ] },
        ];
    }
    // Single instanced draw for the whole frame (no images).
    submitPlain() {
        let bg = this.theme.bg();
        let res = concat(concat(sdfPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.m3.inst", ["VERTEX", "COPY_DST"], this.inst),
        ]));
        let pass = { op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
                { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: len(this.inst) / 16, first_vertex: 0, first_instance: 0 },
            ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
    }
    submit() {
        this.frameN = this.frameN + 1;
        if (this.graphics.hasBackdrop(this.inst)) { this.submitBackdrop(); return 0; }
        if (this.media.imgHandleN == 0) { this.submitPlain(); return 0; }
        let bg = this.theme.bg();
        let plan = this.media.planDraws(this.inst);
        if (len(plan.handles) == 0) { this.submitPlain(); return 0; }
        let res = concat(concat(sdfPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.m3.inst", ["VERTEX", "COPY_DST"], plan.buf),
        ]));
        this.media.addImgPipeline(res);
        let uploads = this.font.atlasUploadCmds();
        let pcmds = this.media.imgDrawCmds(plan, "elpa.m3.inst", "", res, uploads, {});
        let pass = { op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: pcmds };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [pass]) }]);
    }
    // A layered frame: a cached static buffer (non-animating widgets, bytes
    // unchanged → the renderer skips re-uploading it) plus a small dynamic buffer.
    submitLayered(animating) {
        // The frosted-glass compositor is a whole-frame multi-pass; it can't ride
        // the static/dynamic split, so a frame with a backdrop falls back to it.
        if (this.graphics.hasBackdrop(this.inst)) { this.submitBackdrop(); return 0; }
        for (let i = 0; i < len(animating); i++) { let c = animating[i]; c._animLayer = 1.0; }
        let dyn = [];
        let stat = this.root.bucket(dyn);
        for (let i = 0; i < len(animating); i++) { let c = animating[i]; c._animLayer = 0.0; }
        if (len(dyn) < 1) { this.submit(); return 0; }
        let bg = this.theme.bg();
        let ps = this.media.planDraws(stat); let pd = this.media.planDraws(dyn);
        let res = concat(concat(sdfPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.m3.inst.static", ["VERTEX", "COPY_DST"], ps.buf),
            bufF32("elpa.m3.inst.dyn", ["VERTEX", "COPY_DST"], pd.buf),
        ]));
        let uploads = this.font.atlasUploadCmds();
        let declared = {};
        if (len(ps.handles) + len(pd.handles) > 0) { this.media.addImgPipeline(res); }
        let cmds = this.media.imgDrawCmds(ps, "elpa.m3.inst.static", "st", res, uploads, declared);
        cmds = concat(cmds, this.media.imgDrawCmds(pd, "elpa.m3.inst.dyn", "dy", res, uploads, declared));
        let pass = { op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: cmds };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [pass]) }]);
        return 0;
    }

    // ---- backdrop blur (frosted glass) --------------------------------------
    // A real two-stage frame: everything painted *before* a backdrop sentinel is
    // rendered into an offscreen texture (pass A); the surface pass (B) redraws
    // that content sharp, composites a blurred copy of it inside each backdrop
    // region (multi-tap samples of the offscreen texture through the image
    // pipeline — a box blur), then draws everything painted *after* on top.
    sdfDrawCmds(runs) {
        let cmds = [];
        for (let i = 0; i < len(runs); i++) {
            push(cmds, { cmd: "draw", vertex_count: 6, instance_count: runs[i].count, first_vertex: 0, first_instance: runs[i].first });
        }
        return cmds;
    }
    // Multi-tap blur composite of region `rg` sampling the offscreen scene texture.
    backdropTapCmds(rg, sceneTex, res, tag) {
        let m = this.metrics; let cmds = [];
        let b = rg.blur; if (b < 0.5) { b = 0.5; }
        // 5 taps (an opaque centre + four diagonals) are enough: the offscreen
        // scene is already captured at reduced resolution, so its linear upsample
        // pre-blurs it and a handful of offset samples finish the job.
        let taps = [[0.0, 0.0, 1.0], [b, b, 0.5], [-b, b, 0.5], [b, -b, 0.5], [-b, -b, 0.5]];
        let u0b = (rg.cx - rg.hw) / m.vw; let v0b = (rg.cy - rg.hh) / m.vh;
        let u1b = (rg.cx + rg.hw) / m.vw; let v1b = (rg.cy + rg.hh) / m.vh;
        for (let i = 0; i < len(taps); i++) {
            let dx = taps[i][0] / m.vw; let dy = taps[i][1] / m.vh; let a = taps[i][2];
            let uid = concat(concat("elpa.m3.bd.u.", tag), str(i)); let bid = concat(concat("elpa.m3.bd.bg.", tag), str(i));
            push(res, bufF32(uid, ["UNIFORM", "COPY_DST"],
                [m.vw, m.vh, rg.cx, rg.cy, rg.hw, rg.hh, rg.r, 0.0, u0b + dx, v0b + dy, u1b + dx, v1b + dy, 1.0, 1.0, 1.0, a]));
            push(res, { kind: "bindGroup", id: bid, layout: "elpa.m3.img.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: uid } },
                { binding: 1, resource: { type: "textureView", texture: sceneTex } },
                { binding: 2, resource: { type: "sampler", sampler: "elpa.m3.img.samp" } } ] });
            push(cmds, { cmd: "setPipeline", pipeline: "elpa.m3.img.pipe" });
            push(cmds, { cmd: "setBindGroup", index: 0, bind_group: bid });
            push(cmds, { cmd: "draw", vertex_count: 6, instance_count: 1, first_vertex: 0, first_instance: 0 });
        }
        return cmds;
    }
    submitBackdrop() {
        let m = this.metrics; let bg = this.theme.bg();
        let scan = this.graphics.scanBackdrops(this.inst);
        let n = len(this.inst) / 16;
        let below = this.graphics.sdfRuns(this.inst, 0, scan.last);
        let above = this.graphics.sdfRuns(this.inst, scan.last + 1, n);
        // The blur source is captured at reduced resolution (BD_SCALE): blur is a
        // low-frequency effect, so a half-size offscreen target cuts the capture's
        // fill-rate ~4x and its sampling bandwidth, while the linear upsample only
        // helps the blur. Geometry maps by NDC (globals stay vw,vh), so the smaller
        // attachment just rasterises the same scene at fewer pixels.
        let sw = ceil(m.vw / BD_SCALE); let sh = ceil(m.vh / BD_SCALE); if (sw < 1) { sw = 1; } if (sh < 1) { sh = 1; }
        // Size-versioned id: stable across steady frames (so the resource cache
        // reuses the offscreen target), fresh on resize.
        let sceneTex = concat(concat(concat("elpa.m3.bd.scene.", str(sw)), "x"), str(sh));
        let res = concat(concat(sdfPipelineResources(), this.font.atlasTexRes()), concat(this.frameBindings(), [
            bufF32("elpa.m3.inst", ["VERTEX", "COPY_DST"], this.inst),
            // The scene is a render target for the SDF + image pipelines, so its
            // format must match their colour target (bgra8unorm, the surface
            // format); an rgba8unorm target here is a wgpu format mismatch that
            // errors the device on a real backend (the headless backend ignores it).
            { kind: "texture", id: sceneTex, size: { width: sw, height: sh }, format: "bgra8unorm",
              usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"] },
        ]));
        this.media.addImgPipeline(res);
        let uploads = this.font.atlasUploadCmds();
        // Pass A: render the below-backdrop content into the offscreen scene.
        let sceneCmds = concat([
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
            { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst", offset: 0 },
        ], this.sdfDrawCmds(below));
        let scenePass = { op: "renderPass", id: "elpa.m3.bd.scenePass",
            color_attachments: [{ view: { kind: "texture", texture: sceneTex }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: sceneCmds };
        // Pass B (surface): sharp below content, then a blurred composite inside
        // each region, then the above content (the frost tint + child + the rest).
        let surfCmds = concat([
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
            { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst", offset: 0 },
        ], this.sdfDrawCmds(below));
        for (let k = 0; k < len(scan.marks); k++) {
            let rg = this.graphics.regionAt(this.inst, scan.marks[k]);
            surfCmds = concat(surfCmds, this.backdropTapCmds(rg, sceneTex, res, str(k)));
        }
        surfCmds = concat(surfCmds, [
            { cmd: "setBindGroup", index: 0, bind_group: "elpa.m3.gb" },
            { cmd: "setPipeline", pipeline: "elpa.m3.pipe" },
            { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.m3.inst", offset: 0 },
        ]);
        surfCmds = concat(surfCmds, this.sdfDrawCmds(above));
        let surfPass = { op: "renderPass", id: "elpa.m3.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: surfCmds };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [scenePass, surfPass]) }]);
        return 0;
    }

    // ---- event loop ---------------------------------------------------------
    // Pan any scrollable viewport under (px,py) by `delta` px; returns 1 if one
    // consumed the gesture.
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
        for (let i = 0; i < len(ids); i++) {
            let id = ids[i]; let rg = this.listRegions[id];
            if (rg.maxOff > 0.5) { if (inRect(px, py, rg.cx, rg.cy, rg.hw, rg.hh)) { return id; } }
        }
        return "";
    }
    // The tap ids whose hit-rect contains the pointer (the hover set).
    hoverIdsAt(px, py) {
        let ids = [];
        for (let i = 0; i < len(this.taps); i++) {
            let t = this.taps[i];
            if (inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { push(ids, t.id); }
        }
        return ids;
    }
    // A no-drag move only changes hover highlighting: repaint just the components
    // owning widgets entering/leaving hover (or a full repaint if one isn't scoped).
    hoverRepaint(px, py) {
        let ids = this.hoverIdsAt(px, py);
        let sig = "";
        for (let i = 0; i < len(ids); i++) { sig = concat(concat(sig, "|"), ids[i]); }
        if (sig == this.hoverSig) { return 0; }
        let dirty = []; let full = 0.0;
        let prev = this.hoverIds;
        for (let i = 0; i < len(prev); i++) { if (!has(this.clock.keySubs, prev[i])) { full = 1.0; } this.clock.markDirty(dirty, prev[i]); }
        for (let i = 0; i < len(ids); i++) { if (!has(this.clock.keySubs, ids[i])) { full = 1.0; } this.clock.markDirty(dirty, ids[i]); }
        this.hoverSig = sig; this.hoverIds = ids;
        if (full > 0.5) { this.repaint(); return 0; }
        if (len(dirty) > 0) { this.repaintComps(dirty); }
        return 0;
    }
    onEvent(e) {
        let et = e.type; let px = e.nx * this.metrics.vw; let py = e.ny * this.metrics.vh;
        if (et == "pointermove") { this.hx = px; this.hy = py; }
        if (et == "pointerdown") {
            this.flingId = ""; this.flingV = 0.0;
            let hit = 0.0;
            for (let i = 0; i < len(this.taps); i++) {
                let t = this.taps[i];
                if (inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { this.clock.pressDown(t.id); t.onTap(); hit = 1.0; }
            }
            for (let i = 0; i < len(this.drags); i++) {
                let d = this.drags[i];
                if (inRect(px, py, d.cx, d.cy, d.hw, d.hh)) { this.dragging = 1.0; this.activeDrag = d; d.onDrag(px); hit = 1.0; }
            }
            if (hit < 0.5) {
                let sid = this.scrollIdAt(px, py);
                if (len(sid) > 0) { this.scrollDragOn = 1.0; this.scrollDragId = sid; this.scrollDragY = py; this.scrollVel = 0.0; }
                else { if (this.focused != 0) { this.focused = 0; } this.repaint(); }
            }
        }
        if (et == "pointermove") {
            if (this.scrollDragOn > 0.5) {
                let dy = this.scrollDragY - py;
                this.scrollBy(px, this.scrollDragY, dy);
                this.scrollVel = this.scrollVel * 0.55 + dy * 0.45;
                this.scrollDragY = py; this.repaint();
            }
            else { if (this.dragging > 0.5) { this.activeDrag.onDrag(px); } else { this.hoverRepaint(px, py); } }
        }
        if (et == "pointerup") {
            if (this.scrollDragOn > 0.5) {
                if (abs(this.scrollVel) > 0.6) { this.flingId = this.scrollDragId; this.flingV = this.scrollVel; }
            }
            this.dragging = 0.0; this.scrollDragOn = 0.0; this.repaint();
        }
        if (et == "wheel") {
            let h = this.scrollBy(px, py, e.deltaY);
            if (h > 0.5) { this.repaint(); } else { if (this.hasWheel > 0.5) { this.wheelFn(e.deltaY); } }
        }
        if (et == "keydown") {
            if (this.hasFocusInput > 0.5) { this.focusInput(e.key); }
            else { if (this.hasKey > 0.5) { this.keyHandler(e.key); } }
        }
        if (et == "keyup") { this.repaint(); }
    }
    // Advance one momentum-scroll step; returns whether a fling is still active.
    flingStep() {
        if (len(this.flingId) == 0) { return 0.0; }
        if (!has(this.listRegions, this.flingId)) { this.flingId = ""; this.flingV = 0.0; return 0.0; }
        let rg = this.listRegions[this.flingId];
        let off = 0.0; if (has(this.scroll, this.flingId)) { off = this.scroll[this.flingId]; }
        off = off + this.flingV;
        let edge = 0.0;
        if (off <= 0.0) { off = 0.0; edge = 1.0; }
        if (off >= rg.maxOff) { off = rg.maxOff; edge = 1.0; }
        this.scroll[this.flingId] = off;
        this.flingV = this.flingV * 0.93;
        if (edge > 0.5) { this.flingV = 0.0; this.flingId = ""; return 1.0; }
        if (abs(this.flingV) < 0.4) { this.flingV = 0.0; this.flingId = ""; }
        return 1.0;
    }
    onFrame(dt) {
        let mediaChanged = this.media.tick();
        let themeMoving = 0.0;
        let nd = this.theme.darkAnim + (this.theme.darkTarget - this.theme.darkAnim) * 0.18;
        if (abs(nd - this.theme.darkAnim) > 0.0005) { themeMoving = 1.0; }
        this.theme.darkAnim = nd;
        let dirty = [];
        this.clock.advance(dirty);
        let flinging = this.flingStep();
        if (themeMoving > 0.5) {
            for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; }
            this.repaintAll();
            return 0;
        }
        if (flinging > 0.5) {
            for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; }
            this.repaint();
            return 0;
        }
        if (len(dirty) > 0) { this.repaintComps(dirty); return 0; }
        if (mediaChanged > 0.5) { this.submit(); }
    }
    onResize(info) { this.metrics.setMetrics(info); this.renderApp(); }
}
