// Elpa Game3D — linear-algebra foundation.
//
// A small, allocation-light math library the rest of the engine is built on:
// `Vec3` and `Quat` value types and a column-major `Mat4` (the wgpu/WGSL layout,
// so a matrix uploads to a uniform buffer as its 16 floats with no transpose).
// The heavy 16-element kernels are kept as free functions on plain arrays
// (`mul16`, `inv16`) and wrapped by the `Mat4` class, the same split three.js
// makes between `Matrix4` and its element math.
//
// The Elpian VM exposes the full elementary-function set (`sin`, `cos`, `sqrt`,
// `tan`, `atan2`, `abs`, `min`, `max`, …) as native builtins, so every matrix,
// projection and quaternion operation runs on the CPU here — the renderer ships
// finished matrices to the GPU rather than re-deriving them per vertex in WGSL.

let EPSILON = 0.000001;
let DEG2RAD = 0.017453292519943295;
let RAD2DEG = 57.29577951308232;

// ------------------------------------------------------------------- Vec3 -----
// A 3-component vector. Operations return fresh vectors (so chaining never
// aliases an operand); the few in-place setters return `this` for fluent use.
class Vec3 {
    constructor(x, y, z) {
        if (isNull(x)) { x = 0.0; } if (isNull(y)) { y = 0.0; } if (isNull(z)) { z = 0.0; }
        this.x = x; this.y = y; this.z = z;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vec3(this.x, this.y, this.z); }
    add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
    mul(v) { return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    cross(v) {
        return new Vec3(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x);
    }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return sqrt(this.lengthSq()); }
    distanceTo(v) { return this.sub(v).length(); }
    normalize() {
        let l = this.length();
        if (l < EPSILON) { return new Vec3(0.0, 0.0, 0.0); }
        return this.scale(1.0 / l);
    }
    negate() { return new Vec3(-this.x, -this.y, -this.z); }
    lerp(v, t) {
        return new Vec3(
            this.x + (v.x - this.x) * t,
            this.y + (v.y - this.y) * t,
            this.z + (v.z - this.z) * t);
    }
    min(v) { return new Vec3(min(this.x, v.x), min(this.y, v.y), min(this.z, v.z)); }
    max(v) { return new Vec3(max(this.x, v.x), max(this.y, v.y), max(this.z, v.z)); }
    toArray() { return [this.x, this.y, this.z]; }
}
function vec3(x, y, z) { return new Vec3(x, y, z); }

// ------------------------------------------------------------------- Quat -----
// A unit quaternion (x, y, z, w). The engine stores node orientation as a quat
// (no gimbal lock, clean interpolation) and composes it into the local matrix.
class Quat {
    constructor(x, y, z, w) {
        if (isNull(x)) { x = 0.0; } if (isNull(y)) { y = 0.0; }
        if (isNull(z)) { z = 0.0; } if (isNull(w)) { w = 1.0; }
        this.x = x; this.y = y; this.z = z; this.w = w;
    }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    // Set from an axis (need not be unit) and an angle in radians.
    setFromAxisAngle(axis, angle) {
        let n = axis.normalize(); let h = angle * 0.5; let s = sin(h);
        this.x = n.x * s; this.y = n.y * s; this.z = n.z * s; this.w = cos(h);
        return this;
    }
    // Set from intrinsic Euler angles (radians) in XYZ order.
    setFromEuler(x, y, z) {
        let c1 = cos(x * 0.5); let c2 = cos(y * 0.5); let c3 = cos(z * 0.5);
        let s1 = sin(x * 0.5); let s2 = sin(y * 0.5); let s3 = sin(z * 0.5);
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        return this;
    }
    // Hamilton product (this * b), the composition of two rotations.
    multiply(b) {
        let ax = this.x; let ay = this.y; let az = this.z; let aw = this.w;
        let bx = b.x; let by = b.y; let bz = b.z; let bw = b.w;
        return new Quat(
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz);
    }
    normalize() {
        let l = sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
        if (l < EPSILON) { return new Quat(0.0, 0.0, 0.0, 1.0); }
        let s = 1.0 / l;
        return new Quat(this.x * s, this.y * s, this.z * s, this.w * s);
    }
}
function quat() { return new Quat(0.0, 0.0, 0.0, 1.0); }
function quatAxisAngle(axis, angle) { return new Quat(0.0, 0.0, 0.0, 1.0).setFromAxisAngle(axis, angle); }
function quatEuler(x, y, z) { return new Quat(0.0, 0.0, 0.0, 1.0).setFromEuler(x, y, z); }

// ----------------------------------------------------- column-major 16-array --
// All matrix kernels operate on a length-16 array `e`, column-major, so element
// (row r, col c) is `e[c * 4 + r]` — exactly wgpu's `mat4x4<f32>` memory layout.

function identity16() { return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]; }

// Matrix product a * b (both column-major), returned as a new array.
function mul16(a, b) {
    let o = fill(16, 0.0);
    for (let c = 0; c < 4; c++) {
        let bc = c * 4;
        let b0 = b[bc]; let b1 = b[bc + 1]; let b2 = b[bc + 2]; let b3 = b[bc + 3];
        o[bc] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        o[bc + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        o[bc + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        o[bc + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
}

function transpose16(m) {
    return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13],
        m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
}

// Full 4x4 inverse via cofactor expansion. Returns the identity if singular.
function inv16(m) {
    let m00 = m[0]; let m01 = m[1]; let m02 = m[2]; let m03 = m[3];
    let m10 = m[4]; let m11 = m[5]; let m12 = m[6]; let m13 = m[7];
    let m20 = m[8]; let m21 = m[9]; let m22 = m[10]; let m23 = m[11];
    let m30 = m[12]; let m31 = m[13]; let m32 = m[14]; let m33 = m[15];
    let b00 = m00 * m11 - m01 * m10; let b01 = m00 * m12 - m02 * m10;
    let b02 = m00 * m13 - m03 * m10; let b03 = m01 * m12 - m02 * m11;
    let b04 = m01 * m13 - m03 * m11; let b05 = m02 * m13 - m03 * m12;
    let b06 = m20 * m31 - m21 * m30; let b07 = m20 * m32 - m22 * m30;
    let b08 = m20 * m33 - m23 * m30; let b09 = m21 * m32 - m22 * m31;
    let b10 = m21 * m33 - m23 * m31; let b11 = m22 * m33 - m23 * m32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (abs(det) < EPSILON) { return identity16(); }
    let id = 1.0 / det;
    return [
        (m11 * b11 - m12 * b10 + m13 * b09) * id,
        (m02 * b10 - m01 * b11 - m03 * b09) * id,
        (m31 * b05 - m32 * b04 + m33 * b03) * id,
        (m22 * b04 - m21 * b05 - m23 * b03) * id,
        (m12 * b08 - m10 * b11 - m13 * b07) * id,
        (m00 * b11 - m02 * b08 + m03 * b07) * id,
        (m32 * b02 - m30 * b05 - m33 * b01) * id,
        (m20 * b05 - m22 * b02 + m23 * b01) * id,
        (m10 * b10 - m11 * b08 + m13 * b06) * id,
        (m01 * b08 - m00 * b10 - m03 * b06) * id,
        (m30 * b04 - m31 * b02 + m33 * b00) * id,
        (m21 * b02 - m20 * b04 - m23 * b00) * id,
        (m11 * b07 - m10 * b09 - m12 * b06) * id,
        (m00 * b09 - m01 * b07 + m02 * b06) * id,
        (m31 * b01 - m30 * b03 - m32 * b00) * id,
        (m20 * b03 - m21 * b01 + m22 * b00) * id];
}

// Compose a TRS matrix from position (Vec3), orientation (Quat) and scale (Vec3).
function compose16(p, q, s) {
    let x = q.x; let y = q.y; let z = q.z; let w = q.w;
    let x2 = x + x; let y2 = y + y; let z2 = z + z;
    let xx = x * x2; let xy = x * y2; let xz = x * z2;
    let yy = y * y2; let yz = y * z2; let zz = z * z2;
    let wx = w * x2; let wy = w * y2; let wz = w * z2;
    let sx = s.x; let sy = s.y; let sz = s.z;
    return [
        (1.0 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0,
        (xy - wz) * sy, (1.0 - (xx + zz)) * sy, (yz + wx) * sy, 0.0,
        (xz + wy) * sz, (yz - wx) * sz, (1.0 - (xx + yy)) * sz, 0.0,
        p.x, p.y, p.z, 1.0];
}

// ------------------------------------------------------------------- Mat4 -----
// A 4x4 transform wrapping a column-major 16-array (`this.e`). Methods return
// fresh matrices; `mat4*` free functions are the named constructors.
class Mat4 {
    // `e` is a length-16 column-major array, or absent (any non-array) for identity.
    constructor(e) { if (typeOf(e) != "array") { this.e = identity16(); } else { this.e = e; } }
    clone() { return new Mat4(slice(this.e, 0)); }
    mul(b) { return new Mat4(mul16(this.e, b.e)); }
    invert() { return new Mat4(inv16(this.e)); }
    transpose() { return new Mat4(transpose16(this.e)); }
    // The matrix that transforms normals: inverse-transpose of the model matrix
    // (the upper-left 3x3 part is what the shader uses, with normal w = 0).
    normalMatrix() { return new Mat4(transpose16(inv16(this.e))); }
    // Apply to a point (w = 1), returning a Vec3 (perspective divide applied).
    transformPoint(v) {
        let e = this.e;
        let x = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
        let y = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
        let z = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
        let w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
        if (abs(w) < EPSILON) { w = 1.0; }
        return new Vec3(x / w, y / w, z / w);
    }
    // Apply to a direction (w = 0), ignoring translation.
    transformDir(v) {
        let e = this.e;
        return new Vec3(
            e[0] * v.x + e[4] * v.y + e[8] * v.z,
            e[1] * v.x + e[5] * v.y + e[9] * v.z,
            e[2] * v.x + e[6] * v.y + e[10] * v.z);
    }
    // The world-space translation (column 3) — a node's position from its matrix.
    getTranslation() { return new Vec3(this.e[12], this.e[13], this.e[14]); }
}

function mat4() { return new Mat4(); }
function mat4FromArray(e) { return new Mat4(e); }
function mat4Compose(p, q, s) { return new Mat4(compose16(p, q, s)); }

// Right-handed perspective with a 0..1 depth range (the wgpu/WebGPU clip
// convention), looking down -Z. `fovY` is the vertical field of view in radians.
function mat4Perspective(fovY, aspect, near, far) {
    let f = 1.0 / tan(fovY * 0.5);
    let nf = 1.0 / (near - far);
    return new Mat4([
        f / aspect, 0.0, 0.0, 0.0,
        0.0, f, 0.0, 0.0,
        0.0, 0.0, far * nf, -1.0,
        0.0, 0.0, far * near * nf, 0.0]);
}

// Right-handed orthographic projection with a 0..1 depth range.
function mat4Ortho(left, right, bottom, top, near, far) {
    let lr = 1.0 / (left - right); let bt = 1.0 / (bottom - top); let nf = 1.0 / (near - far);
    return new Mat4([
        -2.0 * lr, 0.0, 0.0, 0.0,
        0.0, -2.0 * bt, 0.0, 0.0,
        0.0, 0.0, nf, 0.0,
        (left + right) * lr, (top + bottom) * bt, near * nf, 1.0]);
}

// A right-handed view matrix looking from `eye` toward `target`.
function mat4LookAt(eye, target, up) {
    let f = target.sub(eye).normalize();
    let s = f.cross(up).normalize();
    let u = s.cross(f);
    return new Mat4([
        s.x, u.x, -f.x, 0.0,
        s.y, u.y, -f.y, 0.0,
        s.z, u.z, -f.z, 0.0,
        -s.dot(eye), -u.dot(eye), f.dot(eye), 1.0]);
}

// ---------------------------------------------------------------- helpers ------
// Build an array of `n` copies of `v` (the VM `fill(n, v)` builtin, named so the
// math code reads clearly).
function fill16zero() { return fill(16, 0.0); }
function clampf(x, lo, hi) { return clamp(x, lo, hi); }
function lerpf(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------- colors -------
// Colours are plain rgba float arrays in [0,1], the form the renderer uploads.
let COLOR_WHITE = [1.0, 1.0, 1.0, 1.0];
let COLOR_BLACK = [0.0, 0.0, 0.0, 1.0];
function rgb(r, g, b) { return [r, g, b, 1.0]; }
function rgba(r, g, b, a) { return [r, g, b, a]; }
