// Elpa Game3D — bounding volumes, ray casting and collision queries.
//
// The geometry side of game logic: axis-aligned bounding boxes (`Box3`),
// bounding spheres (`Sphere`), and a `Ray` with analytic intersection against
// both. `Raycaster` walks a scene and returns the meshes a ray hits, nearest
// first — the basis for picking, line-of-sight and projectile tests. The
// volume↔volume predicates (`intersectsBox`, `intersectsSphere`) drive broad-
// phase collision between moving bodies.
//
// `Box3` is referenced by `Geometry.boundingBox`, so it is defined here but used
// across the engine; class hoisting makes the forward reference safe.

// ------------------------------------------------------------------- Box3 ------
class Box3 {
    // `lo`/`hi` (not `min`/`max`, which shadow the math builtins) are the corner
    // vectors, or absent for an empty box that grows via `expandByPoint`.
    constructor(lo, hi) {
        if (isNull(lo)) { lo = new Vec3(1e30, 1e30, 1e30); }
        if (isNull(hi)) { hi = new Vec3(-1e30, -1e30, -1e30); }
        this.min = lo; this.max = hi;
    }
    clone() { return new Box3(this.min.clone(), this.max.clone()); }
    isEmpty() {
        if (this.max.x < this.min.x) { return 1.0; }
        if (this.max.y < this.min.y) { return 1.0; }
        if (this.max.z < this.min.z) { return 1.0; }
        return 0.0;
    }
    center() { return this.min.add(this.max).scale(0.5); }
    size() { return this.max.sub(this.min); }
    expandByPoint(p) {
        this.min = this.min.min(p); this.max = this.max.max(p); return this;
    }
    containsPoint(p) {
        if (p.x < this.min.x) { return 0.0; } if (p.x > this.max.x) { return 0.0; }
        if (p.y < this.min.y) { return 0.0; } if (p.y > this.max.y) { return 0.0; }
        if (p.z < this.min.z) { return 0.0; } if (p.z > this.max.z) { return 0.0; }
        return 1.0;
    }
    intersectsBox(b) {
        if (b.max.x < this.min.x) { return 0.0; } if (b.min.x > this.max.x) { return 0.0; }
        if (b.max.y < this.min.y) { return 0.0; } if (b.min.y > this.max.y) { return 0.0; }
        if (b.max.z < this.min.z) { return 0.0; } if (b.min.z > this.max.z) { return 0.0; }
        return 1.0;
    }
    // Closest point on the box to `p` (clamped per axis).
    clampPoint(p) {
        return new Vec3(
            clamp(p.x, this.min.x, this.max.x),
            clamp(p.y, this.min.y, this.max.y),
            clamp(p.z, this.min.z, this.max.z));
    }
    intersectsSphere(s) { return s.intersectsBox(this); }
    // Return a new box: this box transformed by `m` (a Mat4), re-fitted around
    // the eight transformed corners.
    applyMatrix(m) {
        let mn = this.min; let mx = this.max;
        let corners = [
            new Vec3(mn.x, mn.y, mn.z), new Vec3(mx.x, mn.y, mn.z),
            new Vec3(mn.x, mx.y, mn.z), new Vec3(mx.x, mx.y, mn.z),
            new Vec3(mn.x, mn.y, mx.z), new Vec3(mx.x, mn.y, mx.z),
            new Vec3(mn.x, mx.y, mx.z), new Vec3(mx.x, mx.y, mx.z)];
        let out = new Box3();
        for (let i = 0; i < 8; i++) { out.expandByPoint(m.transformPoint(corners[i])); }
        return out;
    }
}
function box3FromCenterSize(center, size) {
    let h = size.scale(0.5); return new Box3(center.sub(h), center.add(h));
}

// ------------------------------------------------------------------ Sphere -----
class Sphere {
    constructor(center, radius) {
        if (isNull(center)) { center = new Vec3(0.0, 0.0, 0.0); }
        if (isNull(radius)) { radius = 1.0; }
        this.center = center; this.radius = radius;
    }
    clone() { return new Sphere(this.center.clone(), this.radius); }
    containsPoint(p) { if (p.distanceTo(this.center) <= this.radius) { return 1.0; } return 0.0; }
    intersectsSphere(s) {
        let r = this.radius + s.radius;
        if (this.center.distanceTo(s.center) <= r) { return 1.0; }
        return 0.0;
    }
    intersectsBox(b) {
        let c = b.clampPoint(this.center);
        if (c.distanceTo(this.center) <= this.radius) { return 1.0; }
        return 0.0;
    }
}

// -------------------------------------------------------------------- Ray ------
// A ray with an origin and a (normalized) direction.
class Ray {
    constructor(origin, direction) {
        if (isNull(origin)) { origin = new Vec3(0.0, 0.0, 0.0); }
        if (isNull(direction)) { direction = new Vec3(0.0, 0.0, -1.0); }
        this.origin = origin; this.direction = direction.normalize();
    }
    at(t) { return this.origin.add(this.direction.scale(t)); }
    // Distance to the nearest box intersection (slab method), or -1 if missed.
    intersectBox(b) {
        let o = this.origin; let d = this.direction;
        let tmin = -1e30; let tmax = 1e30;
        let oc = [o.x, o.y, o.z]; let dc = [d.x, d.y, d.z];
        let lo = [b.min.x, b.min.y, b.min.z]; let hi = [b.max.x, b.max.y, b.max.z];
        for (let i = 0; i < 3; i++) {
            if (abs(dc[i]) < EPSILON) {
                if (oc[i] < lo[i]) { return -1.0; } if (oc[i] > hi[i]) { return -1.0; }
            } else {
                let inv = 1.0 / dc[i];
                let t1 = (lo[i] - oc[i]) * inv; let t2 = (hi[i] - oc[i]) * inv;
                if (t1 > t2) { let tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tmin) { tmin = t1; } if (t2 < tmax) { tmax = t2; }
                if (tmin > tmax) { return -1.0; }
            }
        }
        if (tmax < 0.0) { return -1.0; }
        if (tmin >= 0.0) { return tmin; }
        return tmax; // origin inside the box
    }
    // Distance to the nearest sphere intersection, or -1 if missed.
    intersectSphere(s) {
        let oc = this.origin.sub(s.center); let d = this.direction;
        let b = oc.dot(d); let c = oc.dot(oc) - s.radius * s.radius;
        if (c > 0.0) { if (b > 0.0) { return -1.0; } }
        let disc = b * b - c;
        if (disc < 0.0) { return -1.0; }
        let t = -b - sqrt(disc);
        if (t < 0.0) { t = -b + sqrt(disc); }
        if (t < 0.0) { return -1.0; }
        return t;
    }
}

// --------------------------------------------------------------- Raycaster -----
// Casts a ray through a scene and reports the meshes it hits (world-space AABB
// test), nearest first. A point-and-direction or a screen-pick ray feeds it.
class Raycaster {
    constructor(origin, direction) { this.ray = new Ray(origin, direction); }
    set(origin, direction) { this.ray = new Ray(origin, direction); return this; }
    // Build a pick ray from normalized device coords (ndcX, ndcY in [-1,1]) and a
    // camera (its view+projection). Returns this.
    setFromCamera(ndcX, ndcY, camera, aspect) {
        camera.updateProjection(aspect);
        let invVP = camera.projectionMatrix.mul(camera.viewMatrix()).invert();
        let near = invVP.transformPoint(new Vec3(ndcX, ndcY, 0.0));
        let far = invVP.transformPoint(new Vec3(ndcX, ndcY, 1.0));
        this.ray = new Ray(near, far.sub(near).normalize());
        return this;
    }
    // All mesh hits under `root`, each { mesh, distance, point }, nearest first.
    intersect(root) {
        let hits = []; let ray = this.ray;
        root.traverse((node) => {
            if (node.nodeType == "mesh") {
                if (node.visible > 0.5) {
                    let box = node.worldBounds();
                    let t = ray.intersectBox(box);
                    if (t >= 0.0) { push(hits, { mesh: node, distance: t, point: ray.at(t) }); }
                }
            }
        });
        sortHitsByDistance(hits);
        return hits;
    }
    // The single nearest hit, or 0 if none.
    intersectFirst(root) { let h = this.intersect(root); if (len(h) == 0) { return 0; } return h[0]; }
}

// Insertion sort by `distance` (small lists; stable, no comparator builtin).
function sortHitsByDistance(hits) {
    for (let i = 1; i < len(hits); i++) {
        let h = hits[i]; let j = i - 1;
        for (let guard = 0; guard < len(hits); guard++) {
            if (j >= 0) { if (hits[j].distance > h.distance) { hits[j + 1] = hits[j]; j = j - 1; } else { guard = 999999; } }
            else { guard = 999999; }
        }
        hits[j + 1] = h;
    }
    return hits;
}

// Convenience world-volume collision tests between two meshes.
function meshesCollideAABB(a, b) { return a.worldBounds().intersectsBox(b.worldBounds()); }
