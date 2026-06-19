// Elpa Game3D — the engine / game loop.
//
// `Game` is the runtime root, the analog of the Material kit's `Material`
// instance: it owns the active `Scene`, the `Camera` and the `Renderer`, tracks
// input state (held keys, pointer position), and drives the host entry points.
// An app registers an `onUpdate(dt, game)` callback (move things, run game
// logic), optionally an input/resize callback, and calls `startGame()`; the
// engine renders the first frame and then re-renders on every animation tick and
// event. Picking is one call away via `game.pick()` (a camera-relative ray cast).

// ------------------------------------------------------------ OrbitController --
// A turntable camera rig (the classic "orbit controls"): the camera looks at a
// `target` from a spherical offset (azimuth `yaw`, elevation `pitch`, `distance`).
// Pointer drag rotates, the wheel (or pinch) zooms, and a secondary-button drag
// pans the target across the ground plane — the standard inspect-a-scene gesture
// set. The rig writes the camera's position + look-at each time it changes.
class OrbitController {
    constructor(camera, target) {
        this.camera = camera;
        if (isNull(target)) { target = new Vec3(0.0, 0.0, 0.0); }
        this.target = target;
        this.distance = 14.0; this.minDistance = 3.0; this.maxDistance = 70.0;
        this.yaw = 0.7; this.pitch = 0.55;        // radians; pitch is elevation
        this.minPitch = 0.06; this.maxPitch = 1.5; // keep just inside straight-down
        this.rotateSpeed = 3.2; this.zoomSpeed = 0.0016; this.panSpeed = 1.1;
        this.dragging = 0.0; this.panning = 0.0; this.lastX = 0.0; this.lastY = 0.0;
        this.apply();
    }
    // Place the camera on the sphere around the target and aim it inward.
    apply() {
        let cp = cos(this.pitch); let sp = sin(this.pitch);
        let ex = this.target.x + this.distance * cp * sin(this.yaw);
        let ey = this.target.y + this.distance * sp;
        let ez = this.target.z + this.distance * cp * cos(this.yaw);
        this.camera.setPosition(ex, ey, ez);
        this.camera.lookAt(this.target.x, this.target.y, this.target.z);
        return this;
    }
    pointerDown(nx, ny, button) {
        this.lastX = nx; this.lastY = ny;
        if (button == 2) { this.panning = 1.0; } else { this.dragging = 1.0; }
    }
    pointerMove(nx, ny) {
        let dx = nx - this.lastX; let dy = ny - this.lastY;
        this.lastX = nx; this.lastY = ny;
        if (this.dragging > 0.5) {
            this.yaw = this.yaw - dx * this.rotateSpeed;
            this.pitch = clamp(this.pitch + dy * this.rotateSpeed, this.minPitch, this.maxPitch);
            this.apply();
        }
        if (this.panning > 0.5) { this.pan(dx, dy); }
    }
    pointerUp() { this.dragging = 0.0; this.panning = 0.0; }
    // Wheel zoom: scale the orbit distance (clamped). `dy` is the wheel delta.
    wheel(dy) {
        this.distance = clamp(this.distance * (1.0 + dy * this.zoomSpeed), this.minDistance, this.maxDistance);
        this.apply();
    }
    zoomBy(factor) { this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance); this.apply(); }
    // Slide the target in the camera's horizontal-right / world-up plane.
    pan(dx, dy) {
        let right = new Vec3(cos(this.yaw), 0.0, -sin(this.yaw));
        let up = new Vec3(0.0, 1.0, 0.0);
        let amt = this.distance * this.panSpeed;
        this.target = this.target.add(right.scale(-dx * amt)).add(up.scale(dy * amt));
        this.apply();
    }
}

class Game {
    constructor() {
        this.scene = new Scene();
        this.camera = new PerspectiveCamera(60.0, 0.1, 1000.0);
        this.camera.setPosition(0.0, 2.5, 6.0).lookAt(0.0, 0.0, 0.0);
        this.renderer = new Renderer();
        // The 2D HUD: floating, draggable panels composited over the 3D scene.
        this.overlay = new Overlay();
        this.uiCapture = 0.0;   // 1 while the HUD owns the active pointer gesture
        this.surface = { width: 1, height: 1, aspect: 1.0 };
        this.time = 0.0;        // seconds since start
        this.frame = 0;         // frames rendered
        this.running = 0.0;
        // App callbacks.
        this.updateFn = 0; this.eventFn = 0; this.resizeFn = 0;
        // Optional camera rig (see enableOrbit); 0 = none.
        this.controls = 0;
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
    // Attach a turntable camera rig and let it drive the active camera. `opts`
    // may set target (Vec3), distance, minDistance, maxDistance, yaw, pitch.
    enableOrbit(opts) {
        let c = new OrbitController(this.camera);
        if (!isNull(opts)) {
            if (has(opts, "target")) { c.target = opts.target; }
            if (has(opts, "distance")) { c.distance = opts.distance; }
            if (has(opts, "minDistance")) { c.minDistance = opts.minDistance; }
            if (has(opts, "maxDistance")) { c.maxDistance = opts.maxDistance; }
            if (has(opts, "yaw")) { c.yaw = opts.yaw; }
            if (has(opts, "pitch")) { c.pitch = opts.pitch; }
        }
        c.apply(); this.controls = c; return c;
    }

    // ---- rendering ----------------------------------------------------------
    surfaceInfo() { let si = askHost("gpu.surfaceInfo", []); if (!isNull(si)) { this.surface = si; } return this.surface; }
    renderFrame() { this.renderer.render(this.scene, this.camera, this.surfaceInfo(), this); }

    // Add a floating HUD panel; see `Overlay.addPanel`. Returns the `UIPanel` so
    // the app can chain `.label(...) / .bar(...) / .button(...)` onto it.
    addPanel(opts) { return this.overlay.addPanel(opts); }

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

        // The HUD gets first refusal on a pointer gesture. A press that lands on a
        // panel (drag its title bar, tap a button) is *captured*, so the camera rig
        // ignores the whole gesture — dragging a window must never orbit the scene.
        // Hit-testing uses logical pixels (`e.x`/`e.y`), the HUD's layout space.
        if (this.overlay != 0) {
            if (t == "pointerdown") { this.uiCapture = this.overlay.pointerDown(e.x, e.y, this); }
            if (t == "pointermove") { if (this.uiCapture > 0.5) { this.overlay.pointerMove(e.x, e.y); } }
            if (t == "pointerup") { if (this.uiCapture > 0.5) { this.overlay.pointerUp(); this.uiCapture = 0.0; } }
        }

        // Feed the camera rig (drag-rotate, wheel-zoom, secondary-drag-pan) unless
        // the HUD owns this gesture. The wheel still zooms regardless.
        if (this.controls != 0) {
            if (this.uiCapture < 0.5) {
                let btn = 0; if (has(e, "button")) { btn = e.button; }
                if (t == "pointerdown") { this.controls.pointerDown(e.nx, e.ny, btn); }
                if (t == "pointermove") { this.controls.pointerMove(e.nx, e.ny); }
                if (t == "pointerup") { this.controls.pointerUp(); }
            }
            if (t == "wheel") { this.controls.wheel(e.deltaY); }
        }
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
