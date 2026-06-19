// Elpa Game3D — geometry, materials and meshes.
//
// `Geometry` owns the raw vertex attributes (positions, normals, uvs) and an
// index list, and lazily builds the *interleaved* vertex array the renderer
// uploads (8 floats / 32 bytes per vertex: position.xyz, normal.xyz, uv.xy). It
// is built once and cached on the object, so per-frame submission only re-points
// at the same array — no re-tessellation. `BoxGeometry` / `SphereGeometry` /
// `PlaneGeometry` are the built-in primitive builders.
//
// `Material` is a small physically-inspired surface description (base colour,
// metalness, roughness, emissive). `Mesh` binds a geometry to a material as an
// `Object3D`, and exposes the object-space bounding box the physics layer reads.

let __geom_seq = 0;
function nextGeomId() { __geom_seq = __geom_seq + 1; return __geom_seq; }
let __mat_seq = 0;
function nextMaterialId() { __mat_seq = __mat_seq + 1; return __mat_seq; }

// Bytes per interleaved vertex: 8 floats (pos3 + nrm3 + uv2).
let VERTEX_STRIDE = 32;
let VERTEX_FLOATS = 8;

// Append helpers — the VM's `push` builtin takes a single value, so these keep
// the primitive builders readable when emitting xyz / uv tuples.
function push3(a, x, y, z) { push(a, x); push(a, y); push(a, z); }
function push2(a, u, v) { push(a, u); push(a, v); }

// ----------------------------------------------------------------- Geometry ----
// `positions`/`normals` are flat xyz arrays (length 3·N); `uvs` a flat xy array
// (length 2·N); `indices` a flat triangle-index array. Pass `0` for normals to
// have them computed from the faces, or `0` for uvs to default them to (0,0).
class Geometry {
    constructor(positions, normals, uvs, indices) {
        this.id = nextGeomId();
        this.positions = positions;
        this.indices = indices;
        if (isNull(normals)) { normals = 0; }
        if (isNull(uvs)) { uvs = 0; }
        this.normals = normals;
        this.uvs = uvs;
        this.vertexCount = len(positions) / 3;
        // Built lazily and cached so a frame re-references, never rebuilds.
        this._vertexData = 0;
        this._boundingBox = 0;
    }
    // Vertex count derived from the index list (the drawIndexed count).
    indexCount() { return len(this.indices); }

    // Compute face normals (flat-ish, accumulated per vertex then normalized).
    computeNormals() {
        let n = this.vertexCount; let acc = fill(n * 3, 0.0);
        let p = this.positions; let idx = this.indices;
        for (let t = 0; t < len(idx); t = t + 3) {
            let ia = idx[t]; let ib = idx[t + 1]; let ic = idx[t + 2];
            let ax = p[ia * 3]; let ay = p[ia * 3 + 1]; let az = p[ia * 3 + 2];
            let bx = p[ib * 3]; let by = p[ib * 3 + 1]; let bz = p[ib * 3 + 2];
            let cx = p[ic * 3]; let cy = p[ic * 3 + 1]; let cz = p[ic * 3 + 2];
            let e1x = bx - ax; let e1y = by - ay; let e1z = bz - az;
            let e2x = cx - ax; let e2y = cy - ay; let e2z = cz - az;
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            let tri = [ia, ib, ic];
            for (let k = 0; k < 3; k++) {
                let vi = tri[k];
                acc[vi * 3] = acc[vi * 3] + nx;
                acc[vi * 3 + 1] = acc[vi * 3 + 1] + ny;
                acc[vi * 3 + 2] = acc[vi * 3 + 2] + nz;
            }
        }
        for (let i = 0; i < n; i++) {
            let x = acc[i * 3]; let y = acc[i * 3 + 1]; let z = acc[i * 3 + 2];
            let l = sqrt(x * x + y * y + z * z);
            if (l < EPSILON) { l = 1.0; }
            acc[i * 3] = x / l; acc[i * 3 + 1] = y / l; acc[i * 3 + 2] = z / l;
        }
        this.normals = acc; return this;
    }

    // The interleaved vertex array (built once, then cached).
    vertexData() {
        if (this._vertexData != 0) { return this._vertexData; }
        if (this.normals == 0) { this.computeNormals(); }
        let n = this.vertexCount; let out = fill(n * VERTEX_FLOATS, 0.0);
        let p = this.positions; let nm = this.normals; let uv = this.uvs;
        for (let i = 0; i < n; i++) {
            let o = i * VERTEX_FLOATS;
            out[o] = p[i * 3]; out[o + 1] = p[i * 3 + 1]; out[o + 2] = p[i * 3 + 2];
            out[o + 3] = nm[i * 3]; out[o + 4] = nm[i * 3 + 1]; out[o + 5] = nm[i * 3 + 2];
            if (uv == 0) { out[o + 6] = 0.0; out[o + 7] = 0.0; }
            else { out[o + 6] = uv[i * 2]; out[o + 7] = uv[i * 2 + 1]; }
        }
        this._vertexData = out; return out;
    }

    // The object-space axis-aligned bounding box (a Box3), built once and cached.
    boundingBox() {
        if (this._boundingBox != 0) { return this._boundingBox; }
        let p = this.positions;
        if (len(p) < 3) { this._boundingBox = new Box3(new Vec3(0.0, 0.0, 0.0), new Vec3(0.0, 0.0, 0.0)); return this._boundingBox; }
        let mnx = p[0]; let mny = p[1]; let mnz = p[2];
        let mxx = p[0]; let mxy = p[1]; let mxz = p[2];
        for (let i = 0; i < this.vertexCount; i++) {
            let x = p[i * 3]; let y = p[i * 3 + 1]; let z = p[i * 3 + 2];
            if (x < mnx) { mnx = x; } if (y < mny) { mny = y; } if (z < mnz) { mnz = z; }
            if (x > mxx) { mxx = x; } if (y > mxy) { mxy = y; } if (z > mxz) { mxz = z; }
        }
        this._boundingBox = new Box3(new Vec3(mnx, mny, mnz), new Vec3(mxx, mxy, mxz));
        return this._boundingBox;
    }
}

// ---------------------------------------------------- primitive geometries -----
// A unit-by-default axis-aligned box of the given full extents, 24 vertices with
// per-face normals (so faces are flat-shaded) and 36 indices.
function BoxGeometry(width, height, depth) {
    if (isNull(width)) { width = 1.0; } if (isNull(height)) { height = width; } if (isNull(depth)) { depth = width; }
    let hx = width * 0.5; let hy = height * 0.5; let hz = depth * 0.5;
    // Six faces: each as (normal, four corners ccw). Order: +Z,-Z,+X,-X,+Y,-Y.
    let faces = [
        [[0.0, 0.0, 1.0], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
        [[0.0, 0.0, -1.0], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
        [[1.0, 0.0, 0.0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
        [[-1.0, 0.0, 0.0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
        [[0.0, 1.0, 0.0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
        [[0.0, -1.0, 0.0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]]];
    let pos = []; let nrm = []; let uv = []; let idx = [];
    let uvc = [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]];
    for (let f = 0; f < 6; f++) {
        let face = faces[f]; let nv = face[0]; let cs = face[1]; let base = f * 4;
        for (let c = 0; c < 4; c++) {
            push(pos, cs[c][0]); push(pos, cs[c][1]); push(pos, cs[c][2]);
            push(nrm, nv[0]); push(nrm, nv[1]); push(nrm, nv[2]);
            push(uv, uvc[c][0]); push(uv, uvc[c][1]);
        }
        push(idx, base); push(idx, base + 1); push(idx, base + 2);
        push(idx, base); push(idx, base + 2); push(idx, base + 3);
    }
    return new Geometry(pos, nrm, uv, idx);
}

// A UV sphere of the given radius, with `stacks` latitude bands and `sectors`
// longitude segments.
function SphereGeometry(radius, stacks, sectors) {
    if (isNull(radius)) { radius = 0.5; } if (isNull(stacks)) { stacks = 16; } if (isNull(sectors)) { sectors = 24; }
    let pos = []; let nrm = []; let uv = []; let idx = [];
    for (let i = 0; i <= stacks; i++) {
        let phi = PI() * i / stacks;       // 0..PI from the +Y pole
        let sp = sin(phi); let cp = cos(phi);
        for (let j = 0; j <= sectors; j++) {
            let theta = TAU() * j / sectors;
            let st = sin(theta); let ct = cos(theta);
            let nx = sp * ct; let ny = cp; let nz = sp * st;
            push(pos, nx * radius); push(pos, ny * radius); push(pos, nz * radius);
            push(nrm, nx); push(nrm, ny); push(nrm, nz);
            push(uv, j / sectors); push(uv, i / stacks);
        }
    }
    let row = sectors + 1;
    for (let i = 0; i < stacks; i++) {
        for (let j = 0; j < sectors; j++) {
            let a = i * row + j; let b = a + row;
            push(idx, a); push(idx, b); push(idx, a + 1);
            push(idx, a + 1); push(idx, b); push(idx, b + 1);
        }
    }
    return new Geometry(pos, nrm, uv, idx);
}

// A flat plane on the XZ axes (normal +Y), `segments` × `segments` quads, useful
// as a ground / floor.
function PlaneGeometry(size, segments) {
    if (isNull(size)) { size = 10.0; } if (isNull(segments)) { segments = 1; }
    let pos = []; let nrm = []; let uv = []; let idx = []; let h = size * 0.5;
    for (let i = 0; i <= segments; i++) {
        for (let j = 0; j <= segments; j++) {
            let x = -h + size * j / segments; let z = -h + size * i / segments;
            push(pos, x); push(pos, 0.0); push(pos, z);
            push(nrm, 0.0); push(nrm, 1.0); push(nrm, 0.0);
            push(uv, j / segments); push(uv, i / segments);
        }
    }
    let row = segments + 1;
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            let a = i * row + j; let b = a + row;
            push(idx, a); push(idx, a + 1); push(idx, b);
            push(idx, a + 1); push(idx, b + 1); push(idx, b);
        }
    }
    return new Geometry(pos, nrm, uv, idx);
}

// A cylinder / truncated cone aligned to +Y: `rTop` and `rBottom` are the cap
// radii (set `rTop = 0` for a cone), `height` the full height, `seg` the radial
// segment count (use small counts — 4 makes a pyramid, 6–8 a low-poly trunk).
// Side normals are tilted by the cone slope; flat caps are added when their
// radius is non-zero. Winding is CCW-outward to match the back-face-cull pipeline.
function CylinderGeometry(rTop, rBottom, height, seg) {
    if (isNull(rTop)) { rTop = 0.5; }
    if (isNull(rBottom)) { rBottom = 0.5; }
    if (isNull(height)) { height = 1.0; }
    if (isNull(seg)) { seg = 16; }
    let pos = []; let nrm = []; let uv = []; let idx = [];
    let hh = height * 0.5; let slope = (rBottom - rTop) / height;
    // Side: a top and bottom vertex per radial step (2 verts each).
    for (let i = 0; i <= seg; i++) {
        let a = TAU() * i / seg; let ca = cos(a); let sa = sin(a);
        let nl = sqrt(ca * ca + slope * slope + sa * sa); if (nl < EPSILON) { nl = 1.0; }
        push3(pos, ca * rTop, hh, sa * rTop); push3(nrm, ca / nl, slope / nl, sa / nl); push2(uv, i / seg, 0.0);
        push3(pos, ca * rBottom, -hh, sa * rBottom); push3(nrm, ca / nl, slope / nl, sa / nl); push2(uv, i / seg, 1.0);
    }
    for (let i = 0; i < seg; i++) {
        let a = 2 * i; let b = 2 * i + 1; let d = 2 * (i + 1); let c = 2 * (i + 1) + 1;
        push3(idx, a, d, b); push3(idx, d, c, b);
    }
    // Top cap (skipped for a cone, rTop == 0).
    if (rTop > EPSILON) {
        let center = len(pos) / 3;
        push3(pos, 0.0, hh, 0.0); push3(nrm, 0.0, 1.0, 0.0); push2(uv, 0.5, 0.5);
        let ring = len(pos) / 3;
        for (let i = 0; i <= seg; i++) { let a = TAU() * i / seg; push3(pos, cos(a) * rTop, hh, sin(a) * rTop); push3(nrm, 0.0, 1.0, 0.0); push2(uv, 0.5 + cos(a) * 0.5, 0.5 + sin(a) * 0.5); }
        for (let i = 0; i < seg; i++) { push3(idx, center, ring + i + 1, ring + i); }
    }
    // Bottom cap.
    if (rBottom > EPSILON) {
        let center = len(pos) / 3;
        push3(pos, 0.0, -hh, 0.0); push3(nrm, 0.0, -1.0, 0.0); push2(uv, 0.5, 0.5);
        let ring = len(pos) / 3;
        for (let i = 0; i <= seg; i++) { let a = TAU() * i / seg; push3(pos, cos(a) * rBottom, -hh, sin(a) * rBottom); push3(nrm, 0.0, -1.0, 0.0); push2(uv, 0.5 + cos(a) * 0.5, 0.5 + sin(a) * 0.5); }
        for (let i = 0; i < seg; i++) { push3(idx, center, ring + i, ring + i + 1); }
    }
    return new Geometry(pos, nrm, uv, idx);
}

// A cone of base `radius` and `height` (a cylinder with a zero-radius top). With
// `seg = 4` it is a square pyramid — the low-poly roof primitive.
function ConeGeometry(radius, height, seg) {
    if (isNull(radius)) { radius = 0.5; } if (isNull(height)) { height = 1.0; } if (isNull(seg)) { seg = 16; }
    return CylinderGeometry(0.0, radius, height, seg);
}

// ----------------------------------------------------------------- Material ----
// A small PBR-style surface description. `opts` is an optional object overriding
// any of: color (rgba), metallic, roughness, emissive (rgb), emissiveIntensity.
class Material {
    constructor(opts) {
        this.id = nextMaterialId();
        this.color = [0.8, 0.8, 0.82, 1.0];
        this.metallic = 0.0;
        this.roughness = 0.6;
        this.emissive = [0.0, 0.0, 0.0];
        this.emissiveIntensity = 1.0;
        this.doubleSided = 0.0;
        if (!isNull(opts)) { this.apply(opts); }
    }
    apply(opts) {
        if (has(opts, "color")) { this.color = opts.color; }
        if (has(opts, "metallic")) { this.metallic = opts.metallic; }
        if (has(opts, "roughness")) { this.roughness = opts.roughness; }
        if (has(opts, "emissive")) { this.emissive = opts.emissive; }
        if (has(opts, "emissiveIntensity")) { this.emissiveIntensity = opts.emissiveIntensity; }
        if (has(opts, "doubleSided")) { this.doubleSided = opts.doubleSided; }
        return this;
    }
    setColor(c) { this.color = c; return this; }
    // Pack the 8 material floats the per-object uniform carries:
    //   baseColor rgba, then (metallic, roughness, emissiveIntensity, 0).
    pack() {
        return [this.color[0], this.color[1], this.color[2], this.color[3],
            this.metallic, this.roughness, this.emissiveIntensity, 0.0];
    }
    emissivePacked() { return [this.emissive[0], this.emissive[1], this.emissive[2], 1.0]; }
}

// ------------------------------------------------------------------- Mesh ------
class Mesh extends Object3D {
    constructor(geometry, material) {
        super();
        this.nodeType = "mesh";
        this.geometry = geometry;
        if (isNull(material)) { material = new Material(); }
        this.material = material;
        this.castShadow = 0.0;
    }
    // The world-space AABB: the geometry's object box transformed by the world
    // matrix. Used by the physics/collision layer.
    worldBounds() { return this.geometry.boundingBox().applyMatrix(this.worldMatrix); }
}
