// Elpa Game3D — the engine / game loop.
//
// `Game` is the runtime root, the analog of the Material kit's `Material`
// instance: it owns the active `Scene`, the `Camera` and the `Renderer`, tracks
// input state (held keys, pointer position), and drives the host entry points.
// An app registers an `onUpdate(dt, game)` callback (move things, run game
// logic), optionally an input/resize callback, and calls `startGame()`; the
// engine renders the first frame and then re-renders on every animation tick and
// event. Picking is one call away via `game.pick()` (a camera-relative ray cast).

class Game {
    constructor() {
        this.scene = new Scene();
        this.camera = new PerspectiveCamera(60.0, 0.1, 1000.0);
        this.camera.setPosition(0.0, 2.5, 6.0).lookAt(0.0, 0.0, 0.0);
        this.renderer = new Renderer();
        this.surface = { width: 1, height: 1, aspect: 1.0 };
        this.time = 0.0;        // seconds since start
        this.frame = 0;         // frames rendered
        this.running = 0.0;
        // App callbacks.
        this.updateFn = 0; this.eventFn = 0; this.resizeFn = 0;
        // Input state.
        this.keys = {};
        this.pointerX = 0.5; this.pointerY = 0.5; this.pointerDown = 0.0;
    }

    // ---- configuration ------------------------------------------------------
    setScene(s) { this.scene = s; return this; }
    setCamera(c) { this.camera = c; return this; }
    onUpdate(fn) { this.updateFn = fn; return this; }
    onInput(fn) { this.eventFn = fn; return this; }
    onResized(fn) { this.resizeFn = fn; return this; }

    // ---- rendering ----------------------------------------------------------
    surfaceInfo() { let si = askHost("gpu.surfaceInfo", []); if (!isNull(si)) { this.surface = si; } return this.surface; }
    renderFrame() { this.renderer.render(this.scene, this.camera, this.surfaceInfo()); }

    // ---- lifecycle ----------------------------------------------------------
    start() { this.running = 1.0; this.renderFrame(); }
    // Advance one animation tick (`dt` in ms): run app logic, then re-render.
    tick(dt) {
        let dts = dt * 0.001;
        this.frame = this.frame + 1; this.time = this.time + dts;
        if (this.updateFn != 0) { let fn = this.updateFn; fn(dts, this); }
        if (this.running > 0.5) { this.renderFrame(); }
    }
    resized(info) {
        if (!isNull(info)) { this.surface = info; }
        if (this.resizeFn != 0) { let fn = this.resizeFn; fn(info, this); }
        this.renderFrame();
    }

    // ---- input --------------------------------------------------------------
    handleEvent(e) {
        let t = e.type;
        if (t == "pointermove") { this.pointerX = e.nx; this.pointerY = e.ny; }
        if (t == "pointerdown") { this.pointerX = e.nx; this.pointerY = e.ny; this.pointerDown = 1.0; }
        if (t == "pointerup") { this.pointerDown = 0.0; }
        if (t == "keydown") { this.keys[e.key] = 1.0; }
        if (t == "keyup") { this.keys[e.key] = 0.0; }
        if (this.eventFn != 0) { let fn = this.eventFn; fn(e, this); }
        if (this.running > 0.5) { this.renderFrame(); }
    }
    isKeyDown(k) { if (has(this.keys, k)) { if (this.keys[k] > 0.5) { return 1.0; } } return 0.0; }

    // ---- picking ------------------------------------------------------------
    aspect() { if (has(this.surface, "aspect")) { return num(this.surface.aspect); } return 1.0; }
    // A `Raycaster` from the camera through the current pointer position.
    pickRay() {
        let ndcX = this.pointerX * 2.0 - 1.0;
        let ndcY = 1.0 - this.pointerY * 2.0;
        return new Raycaster().setFromCamera(ndcX, ndcY, this.camera, this.aspect());
    }
    // The nearest mesh under the pointer (or 0), as { mesh, distance, point }.
    pick() { return this.pickRay().intersectFirst(this.scene); }
}
