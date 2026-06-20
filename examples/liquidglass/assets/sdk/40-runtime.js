// Elpa Liquid Glass — the retained-tree runtime.
//
// `ComponentNode` is the React/Flutter-style element: a `(props, update) =>
// widget` function with its own identity, so `update()` re-runs *only* it.
// `Glass` is the framework instance — it owns the engine services, mounts and
// paints the retained tree, runs the partial-update / per-frame animation clock,
// drives the event loop, and builds the **two-pass liquid-glass frame**:
//
//   Pass A (capture): render the backdrop — every instance painted *before* the
//     first glass lens (the wallpaper + any content behind the chrome) — into a
//     reduced-resolution offscreen "scene" texture.
//   Pass B (surface): render the **whole** instance stream in one instanced draw;
//     the glass lenses sample the scene texture with the refraction / chromatic /
//     specular formula, so they bend the real content behind them.
//
// Both passes are one instanced draw over the one pipeline, so the entire UI —
// background, glass, solids and text — costs two draws regardless of widget count.

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
    bucket(dyn) { return this._sub.bucket(dyn); }
}

let NULLNODE = { _isNull: 1.0 };

// The one pipeline that draws everything (stride 80 = 5×vec4).
function glassPipelineResources() {
    return [
        { kind: "shader", id: "elpa.lg.shader", wgsl: GLASS_WGSL },
        { kind: "bindGroupLayout", id: "elpa.lg.bgl",
          entries: [
              { binding: 0, visibility: ["VERTEX", "FRAGMENT"], ty: "uniform" },
              { binding: 1, visibility: ["FRAGMENT"], ty: "texture" },
              { binding: 2, visibility: ["FRAGMENT"], ty: "texture" },
              { binding: 3, visibility: ["FRAGMENT"], ty: "sampler" }] },
        { kind: "pipelineLayout", id: "elpa.lg.layout", bind_group_layouts: ["elpa.lg.bgl"] },
        { kind: "renderPipeline", id: "elpa.lg.pipe", layout: "elpa.lg.layout",
          vertex: { module: "elpa.lg.shader", entry_point: "vs", buffers: [{
              array_stride: 80, step_mode: "instance", attributes: [
                  { format: "float32x4", offset: 0, shader_location: 0 },
                  { format: "float32x4", offset: 16, shader_location: 1 },
                  { format: "float32x4", offset: 32, shader_location: 2 },
                  { format: "float32x4", offset: 48, shader_location: 3 },
                  { format: "float32x4", offset: 64, shader_location: 4 }] }] },
          fragment: { module: "elpa.lg.shader", entry_point: "fs", targets: [{
              format: SURFACE_FMT,
              blend: { color: { src_factor: "src-alpha", dst_factor: "one-minus-src-alpha", operation: "add" },
                       alpha: { src_factor: "one", dst_factor: "one-minus-src-alpha", operation: "add" } } }] } },
    ];
}

class Glass {
    constructor() {
        this.painter = new GlassPainter();
        this.theme = new GlassTheme();
        this.metrics = new Metrics();
        this.font = new FontEngine();
        this.icons = new IconEngine();
        this.clock = new AnimationClock();
        this.root = 0; this.running = 0.0;
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
    // ---- services widgets reach through --------------------------------------
    hover(cx, cy, hw, hh) { if (inRect(this.hx, this.hy, cx, cy, hw, hh)) { return 1.0; } return 0.0; }
    registerWheel(onChanged, val) { this.wheelFn = (dy) => { onChanged(clamp01(val + dy * (-0.0015))); }; this.hasWheel = 1.0; }
    repaint() { this.renderApp(); }
    refont() { if (this.running > 0.5) { this.renderApp(); } }
    focusField(node) { this.focused = node; this.renderApp(); }

    // ---- mount / render ------------------------------------------------------
    runApp(root) { this.root = root({}); this.running = 1.0; this.renderApp(); }
    renderApp() {
        if (this.font.atlas == 0) { this.font.loadAtlas(); }
        let si = askHost("gpu.surfaceInfo", []);
        this.metrics.setMetrics(si);
        this.hasKey = 0.0; this.hasWheel = 0.0; this.hasFocusInput = 0.0;
        this.root.mount(this, NULLNODE);
        this.root.paint(this, this.metrics.vw * 0.5, this.metrics.vh * 0.5);
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.hoverSig = ""; this.hoverIds = [];
        this.submit();
    }
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
    repaintComps(dirty) {
        for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c.paint(this, c._cx, c._cy); c._dirtyFlag = 0.0; }
        this.root.reassemble();
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }
    repaintAll() {
        this.root.paint(this, this.metrics.vw * 0.5, this.metrics.vh * 0.5);
        this.inst = this.root._out; this.taps = this.root._taps; this.drags = this.root._drags;
        this.submit();
    }

    // ---- submit (two-pass liquid glass) --------------------------------------
    firstGlassInstance() {
        let n = len(this.inst) / 20;
        for (let i = 0; i < n; i++) { if (this.inst[i * 20 + 16] == KIND_GLASS) { return i; } }
        return -1;
    }
    baseResources(sceneTex) {
        let m = this.metrics;
        let res = concat(glassPipelineResources(), this.font.atlasTexRes());
        push(res, bufF32("elpa.lg.globals", ["UNIFORM", "COPY_DST"], [m.vw, m.vh, 0.0, 0.0]));
        push(res, bufF32("elpa.lg.inst", ["VERTEX", "COPY_DST"], this.inst));
        // Bind group A: no live backdrop (atlas stands in; the glass branch that
        // would sample it never runs in the capture pass).
        push(res, { kind: "bindGroup", id: "elpa.lg.bgA", layout: "elpa.lg.bgl", entries: [
            { binding: 0, resource: { type: "buffer", buffer: "elpa.lg.globals" } },
            { binding: 1, resource: { type: "textureView", texture: this.font.atlasId() } },
            { binding: 2, resource: { type: "textureView", texture: this.font.atlasId() } },
            { binding: 3, resource: { type: "sampler", sampler: "elpa.lg.samp" } } ] });
        if (sceneTex != 0) {
            // Bind group B: the captured scene as the refraction backdrop.
            push(res, { kind: "bindGroup", id: "elpa.lg.bgB", layout: "elpa.lg.bgl", entries: [
                { binding: 0, resource: { type: "buffer", buffer: "elpa.lg.globals" } },
                { binding: 1, resource: { type: "textureView", texture: sceneTex } },
                { binding: 2, resource: { type: "textureView", texture: this.font.atlasId() } },
                { binding: 3, resource: { type: "sampler", sampler: "elpa.lg.samp" } } ] });
        }
        return res;
    }
    submit() {
        this.frameN = this.frameN + 1;
        let m = this.metrics; let bg = this.theme.bg(); let n = len(this.inst) / 20;
        let firstGlass = this.firstGlassInstance();
        if (firstGlass < 0) {
            // No glass this frame: one straight surface pass.
            let res = this.baseResources(0);
            let pass = { op: "renderPass", id: "elpa.lg.pass",
                color_attachments: [{ view: { kind: "surface" }, load: "clear", clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
                commands: [
                    { cmd: "setBindGroup", index: 0, bind_group: "elpa.lg.bgA" },
                    { cmd: "setPipeline", pipeline: "elpa.lg.pipe" },
                    { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.lg.inst", offset: 0 },
                    { cmd: "draw", vertex_count: 6, instance_count: n, first_vertex: 0, first_instance: 0 } ] };
            askHost("gpu.submit", [{ resources: res, commands: concat(this.font.atlasUploadCmds(), [pass]) }]);
            return 0;
        }
        let sw = ceil(m.vw / BD_SCALE); let sh = ceil(m.vh / BD_SCALE); if (sw < 1) { sw = 1; } if (sh < 1) { sh = 1; }
        let sceneTex = concat(concat(concat("elpa.lg.scene.", str(sw)), "x"), str(sh));
        let res = this.baseResources(sceneTex);
        push(res, { kind: "texture", id: sceneTex, size: { width: sw, height: sh }, format: SURFACE_FMT, usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"] });
        let uploads = this.font.atlasUploadCmds();
        // Pass A: capture the backdrop (instances before the first glass lens).
        let scenePass = { op: "renderPass", id: "elpa.lg.scenePass",
            color_attachments: [{ view: { kind: "texture", texture: sceneTex }, load: "clear", clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.lg.bgA" },
                { cmd: "setPipeline", pipeline: "elpa.lg.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.lg.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: firstGlass, first_vertex: 0, first_instance: 0 } ] };
        // Pass B: the whole UI to the surface; glass refracts the scene texture.
        let surfPass = { op: "renderPass", id: "elpa.lg.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear", clear_color: { r: bg[0], g: bg[1], b: bg[2], a: 1.0 } }],
            commands: [
                { cmd: "setBindGroup", index: 0, bind_group: "elpa.lg.bgB" },
                { cmd: "setPipeline", pipeline: "elpa.lg.pipe" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "elpa.lg.inst", offset: 0 },
                { cmd: "draw", vertex_count: 6, instance_count: n, first_vertex: 0, first_instance: 0 } ] };
        askHost("gpu.submit", [{ resources: res, commands: concat(uploads, [scenePass, surfPass]) }]);
        return 0;
    }

    // ---- event loop ----------------------------------------------------------
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
    hoverIdsAt(px, py) {
        let ids = [];
        for (let i = 0; i < len(this.taps); i++) { let t = this.taps[i]; if (inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { push(ids, t.id); } }
        return ids;
    }
    hoverRepaint(px, py) {
        let ids = this.hoverIdsAt(px, py); let sig = "";
        for (let i = 0; i < len(ids); i++) { sig = concat(concat(sig, "|"), ids[i]); }
        if (sig == this.hoverSig) { return 0; }
        let dirty = []; let full = 0.0; let prev = this.hoverIds;
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
            this.flingId = ""; this.flingV = 0.0; let hit = 0.0;
            for (let i = 0; i < len(this.taps); i++) { let t = this.taps[i]; if (inRect(px, py, t.cx, t.cy, t.hw, t.hh)) { this.clock.pressDown(t.id); t.onTap(); hit = 1.0; } }
            for (let i = 0; i < len(this.drags); i++) { let d = this.drags[i]; if (inRect(px, py, d.cx, d.cy, d.hw, d.hh)) { this.dragging = 1.0; this.activeDrag = d; d.onDrag(px); hit = 1.0; } }
            if (hit < 0.5) {
                let sid = this.scrollIdAt(px, py);
                if (len(sid) > 0) { this.scrollDragOn = 1.0; this.scrollDragId = sid; this.scrollDragY = py; this.scrollVel = 0.0; }
                else { if (this.focused != 0) { this.focused = 0; } this.repaint(); }
            }
        }
        if (et == "pointermove") {
            if (this.scrollDragOn > 0.5) { let dy = this.scrollDragY - py; this.scrollBy(px, this.scrollDragY, dy); this.scrollVel = this.scrollVel * 0.55 + dy * 0.45; this.scrollDragY = py; this.repaint(); }
            else { if (this.dragging > 0.5) { this.activeDrag.onDrag(px); } else { this.hoverRepaint(px, py); } }
        }
        if (et == "pointerup") {
            if (this.scrollDragOn > 0.5) { if (abs(this.scrollVel) > 0.6) { this.flingId = this.scrollDragId; this.flingV = this.scrollVel; } }
            this.dragging = 0.0; this.scrollDragOn = 0.0; this.repaint();
        }
        if (et == "wheel") { let h = this.scrollBy(px, py, e.deltaY); if (h > 0.5) { this.repaint(); } else { if (this.hasWheel > 0.5) { this.wheelFn(e.deltaY); } } }
        if (et == "keydown") { if (this.hasFocusInput > 0.5) { this.focusInput(e.key); } else { if (this.hasKey > 0.5) { this.keyHandler(e.key); } } }
        if (et == "keyup") { this.repaint(); }
    }
    flingStep() {
        if (len(this.flingId) == 0) { return 0.0; }
        if (!has(this.listRegions, this.flingId)) { this.flingId = ""; this.flingV = 0.0; return 0.0; }
        let rg = this.listRegions[this.flingId];
        let off = 0.0; if (has(this.scroll, this.flingId)) { off = this.scroll[this.flingId]; }
        off = off + this.flingV; let edge = 0.0;
        if (off <= 0.0) { off = 0.0; edge = 1.0; }
        if (off >= rg.maxOff) { off = rg.maxOff; edge = 1.0; }
        this.scroll[this.flingId] = off; this.flingV = this.flingV * 0.93;
        if (edge > 0.5) { this.flingV = 0.0; this.flingId = ""; return 1.0; }
        if (abs(this.flingV) < 0.4) { this.flingV = 0.0; this.flingId = ""; }
        return 1.0;
    }
    onFrame(dt) {
        let themeMoving = 0.0;
        let nd = this.theme.darkAnim + (this.theme.darkTarget - this.theme.darkAnim) * 0.18;
        if (abs(nd - this.theme.darkAnim) > 0.0005) { themeMoving = 1.0; }
        this.theme.darkAnim = nd;
        let dirty = []; this.clock.advance(dirty);
        let flinging = this.flingStep();
        if (themeMoving > 0.5) { for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; } this.repaintAll(); return 0; }
        if (flinging > 0.5) { for (let i = 0; i < len(dirty); i++) { let c = dirty[i]; c._dirtyFlag = 0.0; } this.repaint(); return 0; }
        if (len(dirty) > 0) { this.repaintComps(dirty); return 0; }
    }
    onResize(info) { this.metrics.setMetrics(info); this.renderApp(); }
}
