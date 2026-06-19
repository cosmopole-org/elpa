// Elpa Game3D — the scene graph and cameras.
//
// `Object3D` is the retained node every visible thing derives from: a local
// transform (position / quaternion / scale), a parent pointer and a child list,
// exactly the three.js / Unity transform-hierarchy model. `updateWorld` folds a
// parent's world matrix into each child once per frame, so the renderer reads a
// finished `worldMatrix` off every node instead of recomputing ancestry.
//
// `Scene` is the hierarchy root. `PerspectiveCamera` / `OrthographicCamera` are
// `Object3D`s that additionally produce a view + projection matrix.

// A process-wide id allocator so every node (and the GPU resources derived from
// it) has a stable identity across frames — the renderer keys its resource cache
// off these ids, so a node's buffers are created once and reused.
let __node_seq = 0;
function nextNodeId() { __node_seq = __node_seq + 1; return __node_seq; }

// ---------------------------------------------------------------- Object3D -----
class Object3D {
    constructor() {
        this.id = nextNodeId();
        this.name = "";
        this.position = new Vec3(0.0, 0.0, 0.0);
        this.quaternion = new Quat(0.0, 0.0, 0.0, 1.0);
        this.scaling = new Vec3(1.0, 1.0, 1.0);
        this.children = [];
        this.parent = 0;
        this.visible = 1.0;
        // Cached matrices, refreshed by `updateWorld` each frame.
        this.localMatrix = mat4();
        this.worldMatrix = mat4();
        // Type tag the renderer/collector dispatch on without instanceof chains.
        this.nodeType = "object";
    }

    // ---- hierarchy ----------------------------------------------------------
    add(child) { child.parent = this; push(this.children, child); return this; }
    remove(child) {
        let kept = [];
        for (let i = 0; i < len(this.children); i++) {
            if (this.children[i].id != child.id) { push(kept, this.children[i]); }
        }
        this.children = kept; child.parent = 0; return this;
    }

    // ---- transform setters (fluent) ----------------------------------------
    setPosition(x, y, z) { this.position.set(x, y, z); return this; }
    setScale(x, y, z) { this.scaling.set(x, y, z); return this; }
    setUniformScale(s) { this.scaling.set(s, s, s); return this; }
    setRotationEuler(x, y, z) { this.quaternion = quatEuler(x, y, z); return this; }
    setRotationAxis(axis, angle) { this.quaternion = quatAxisAngle(axis, angle); return this; }
    // Post-multiply the current orientation by a rotation about a world axis.
    rotateOnAxis(axis, angle) { this.quaternion = this.quaternion.multiply(quatAxisAngle(axis, angle)).normalize(); return this; }
    rotateX(a) { return this.rotateOnAxis(new Vec3(1.0, 0.0, 0.0), a); }
    rotateY(a) { return this.rotateOnAxis(new Vec3(0.0, 1.0, 0.0), a); }
    rotateZ(a) { return this.rotateOnAxis(new Vec3(0.0, 0.0, 1.0), a); }
    translate(x, y, z) { this.position.set(this.position.x + x, this.position.y + y, this.position.z + z); return this; }

    // ---- world transform ----------------------------------------------------
    // Recompute this node's local + world matrices and recurse to children.
    // `parentMatrix` is a Mat4 (or null at the root).
    updateWorld(parentMatrix) {
        this.localMatrix = mat4Compose(this.position, this.quaternion, this.scaling);
        // The root passes no parent (null) or the `0` sentinel; anything that is
        // not a Mat4 object means "world == local".
        if (typeOf(parentMatrix) != "object") { this.worldMatrix = this.localMatrix; }
        else { this.worldMatrix = parentMatrix.mul(this.localMatrix); }
        for (let i = 0; i < len(this.children); i++) { this.children[i].updateWorld(this.worldMatrix); }
        return this;
    }
    // World-space position (the translation of the world matrix).
    worldPosition() { return this.worldMatrix.getTranslation(); }

    // Depth-first traversal applying `fn(node)` to this node and all descendants.
    traverse(fn) {
        fn(this);
        for (let i = 0; i < len(this.children); i++) { this.children[i].traverse(fn); }
    }
}

// ------------------------------------------------------------------ Scene ------
// The hierarchy root. Carries the global ambient light and background colour the
// renderer clears to; otherwise it is a plain `Object3D`.
class Scene extends Object3D {
    constructor() {
        super();
        this.nodeType = "scene";
        this.name = "scene";
        this.background = [0.05, 0.06, 0.09, 1.0];
        this.ambient = [1.0, 1.0, 1.0];     // ambient light colour
        this.ambientIntensity = 0.08;        // ambient term scale
    }
    setBackground(col) { this.background = col; return this; }
    setAmbient(col, intensity) { this.ambient = col; this.ambientIntensity = intensity; return this; }
}

// ------------------------------------------------------------ camera base ------
class Camera extends Object3D {
    constructor() {
        super();
        this.nodeType = "camera";
        this.projectionMatrix = mat4();
        // When set (a Vec3), the camera builds its view via lookAt instead of the
        // inverse of its world matrix — the common "orbit/track a point" case.
        this.target = 0;
        this.up = new Vec3(0.0, 1.0, 0.0);
    }
    lookAt(x, y, z) { this.target = new Vec3(x, y, z); return this; }
    clearTarget() { this.target = 0; return this; }
    // The view matrix: lookAt(target) when targeting, else the world inverse.
    viewMatrix() {
        if (this.target != 0) { return mat4LookAt(this.worldPosition(), this.target, this.up); }
        return this.worldMatrix.invert();
    }
    // Overridden by concrete cameras to refresh `projectionMatrix` for `aspect`.
    updateProjection(aspect) { return this; }
}

// A standard pinhole perspective camera (vertical FOV in radians).
class PerspectiveCamera extends Camera {
    constructor(fovDeg, near, far) {
        super();
        if (isNull(fovDeg)) { fovDeg = 60.0; }
        if (isNull(near)) { near = 0.1; }
        if (isNull(far)) { far = 1000.0; }
        this.fov = fovDeg * DEG2RAD;
        this.near = near; this.far = far; this.aspect = 1.0;
    }
    setFov(fovDeg) { this.fov = fovDeg * DEG2RAD; return this; }
    updateProjection(aspect) {
        this.aspect = aspect;
        this.projectionMatrix = mat4Perspective(this.fov, aspect, this.near, this.far);
        return this;
    }
}

// An orthographic camera; `halfHeight` is half the visible vertical extent in
// world units (the horizontal extent follows the surface aspect).
class OrthographicCamera extends Camera {
    constructor(halfHeight, near, far) {
        super();
        if (isNull(halfHeight)) { halfHeight = 5.0; }
        if (isNull(near)) { near = 0.1; }
        if (isNull(far)) { far = 1000.0; }
        this.halfHeight = halfHeight; this.near = near; this.far = far;
    }
    updateProjection(aspect) {
        let h = this.halfHeight; let w = h * aspect;
        this.projectionMatrix = mat4Ortho(-w, w, -h, h, this.near, this.far);
        return this;
    }
}
