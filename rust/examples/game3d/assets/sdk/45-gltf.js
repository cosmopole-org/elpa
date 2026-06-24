// Elpa Game3D — glTF 2.0 / GLB loader.
//
// Turns a glTF document (the JSON plus its binary buffers) into engine objects:
// a node hierarchy of `Object3D`s, with `Mesh`es carrying `Geometry` (decoded
// from accessors) and `Material`s (from the pbrMetallicRoughness model). It
// handles both forms:
//
//   * `.glb` — the binary container: a 12-byte header then a JSON chunk and an
//     optional BIN chunk (`loadGLB(bytes)` / `loadBase64(str)`).
//   * `.gltf` — the JSON document with buffers as `data:` base64 URIs, or with a
//     separately-supplied binary blob (`parse(doc, binBytes)`).
//
// Accessor decoding (de-interleaving by bufferView stride, every glTF component
// type) runs through `BinaryReader`, so it needs no host help and is fully
// deterministic — the loader is exercised end-to-end in the crate's tests.

// glTF accessor `type` → component count.
let GLTF_COMPONENTS = { "SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16 };
// glTF `componentType` → byte size.
function gltfCompSize(t) {
    if (t == 5120) { return 1; } if (t == 5121) { return 1; }
    if (t == 5122) { return 2; } if (t == 5123) { return 2; }
    if (t == 5125) { return 4; } if (t == 5126) { return 4; }
    return 4;
}

class GLTFLoader {
    constructor() {
        this.doc = 0;       // parsed glTF JSON object
        this.bin = 0;       // GLB binary chunk (byte array) or 0
        this._buffers = {}; // bufferIndex(str) -> decoded byte array (cache)
        this.warnings = [];
    }

    // ---- GLB container ------------------------------------------------------
    // Split a `.glb` byte array into its JSON document and BIN chunk.
    parseGLB(bytes) {
        let r = new BinaryReader(bytes, 0);
        let magic = r.u32(); // 'glTF' = 0x46546C67
        if (magic != 1179937895) { push(this.warnings, "not a GLB (bad magic)"); return { json: 0, bin: 0 }; }
        r.u32(); // version
        r.u32(); // total length
        let json = 0; let bin = 0;
        for (let guard = 0; guard < 64; guard++) {
            if (r.remaining() < 8) { guard = 999; }
            else {
                let chunkLen = r.u32(); let chunkType = r.u32(); let start = r.pos;
                if (chunkType == 1313821514) { json = jsonParse(r.ascii(chunkLen)); }      // 'JSON'
                else { if (chunkType == 5130562) { bin = slice(bytes, start, start + chunkLen); r.seek(start + chunkLen); } // 'BIN\0'
                else { r.seek(start + chunkLen); } }
            }
        }
        return { json: json, bin: bin };
    }

    // ---- entry points -------------------------------------------------------
    loadGLB(bytes) { let g = this.parseGLB(bytes); return this.parse(g.json, g.bin); }
    loadBase64(b64) { return this.loadGLB(B64.decode(b64)); }

    // Parse a glTF document (JSON object) with an optional binary chunk into the
    // root `Object3D` of its default scene.
    parse(doc, bin) {
        this.doc = doc; this.bin = bin; this._buffers = {};
        let root = new Object3D(); root.nodeType = "group"; root.name = "gltf";
        if (isNull(doc)) { return root; }
        if (this.fieldMissing(doc, "nodes")) { return root; }
        let sceneIdx = 0; if (has(doc, "scene")) { sceneIdx = doc.scene; }
        let nodeIdxs = 0;
        if (has(doc, "scenes")) { let sc = doc.scenes[sceneIdx]; if (has(sc, "nodes")) { nodeIdxs = sc.nodes; } }
        if (nodeIdxs == 0) { nodeIdxs = range(len(doc.nodes)); } // no scenes: take all nodes
        for (let i = 0; i < len(nodeIdxs); i++) { root.add(this.buildNode(nodeIdxs[i])); }
        return root;
    }
    fieldMissing(o, k) { if (has(o, k)) { return 0.0; } return 1.0; }

    // ---- buffer resolution --------------------------------------------------
    bufferBytes(bi) {
        let key = str(bi);
        if (has(this._buffers, key)) { return this._buffers[key]; }
        let buf = this.doc.buffers[bi]; let bytes = 0;
        if (has(buf, "uri")) {
            let uri = buf.uri;
            if (startsWith(uri, "data:")) { bytes = B64.decodeDataUri(uri); }
            else { push(this.warnings, concat("external buffer not fetched: ", uri)); bytes = []; }
        } else { bytes = this.bin; } // GLB: buffer 0 is the BIN chunk
        if (isNull(bytes)) { bytes = []; }
        this._buffers[key] = bytes; return bytes;
    }

    // Read one accessor into a flat array of numbers (de-strided).
    readAccessor(ai) {
        let acc = this.doc.accessors[ai];
        let bv = this.doc.bufferViews[acc.bufferView];
        let bytes = this.bufferBytes(bv.buffer);
        let ncomp = GLTF_COMPONENTS[acc.type];
        let compSize = gltfCompSize(acc.componentType);
        let baseOff = 0; if (has(bv, "byteOffset")) { baseOff = bv.byteOffset; }
        let accOff = 0; if (has(acc, "byteOffset")) { accOff = acc.byteOffset; }
        let start = baseOff + accOff;
        let stride = ncomp * compSize;
        if (has(bv, "byteStride")) { if (bv.byteStride > 0) { stride = bv.byteStride; } }
        let out = fill(acc.count * ncomp, 0.0);
        for (let i = 0; i < acc.count; i++) {
            let r = new BinaryReader(bytes, start + i * stride);
            for (let c = 0; c < ncomp; c++) { out[i * ncomp + c] = this.readComponent(r, acc.componentType); }
        }
        return out;
    }
    readComponent(r, t) {
        if (t == 5126) { return r.f32(); }
        if (t == 5125) { return r.u32(); }
        if (t == 5123) { return r.u16(); }
        if (t == 5121) { return r.u8(); }
        if (t == 5122) { return r.i16(); }
        if (t == 5120) { return r.i8(); }
        return r.f32();
    }

    // ---- node / mesh / material construction --------------------------------
    buildNode(ni) {
        let node = this.doc.nodes[ni]; let obj;
        if (has(node, "mesh")) { obj = this.buildMesh(node.mesh); }
        else { obj = new Object3D(); obj.nodeType = "group"; }
        if (has(node, "name")) { obj.name = node.name; }
        if (has(node, "matrix")) { this.applyMatrix(obj, node.matrix); }
        else {
            if (has(node, "translation")) { let t = node.translation; obj.position.set(t[0], t[1], t[2]); }
            if (has(node, "rotation")) { let q = node.rotation; obj.quaternion = new Quat(q[0], q[1], q[2], q[3]); }
            if (has(node, "scale")) { let s = node.scale; obj.scaling.set(s[0], s[1], s[2]); }
        }
        if (has(node, "children")) {
            let ch = node.children;
            for (let i = 0; i < len(ch); i++) { obj.add(this.buildNode(ch[i])); }
        }
        return obj;
    }
    // Decompose a column-major TRS matrix into the node's position/quat/scale.
    applyMatrix(obj, e) {
        obj.position.set(e[12], e[13], e[14]);
        let sx = sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
        let sy = sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
        let sz = sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
        if (sx < EPSILON) { sx = 1.0; } if (sy < EPSILON) { sy = 1.0; } if (sz < EPSILON) { sz = 1.0; }
        obj.scaling.set(sx, sy, sz);
        // Rotation from the scale-normalized upper-left 3x3 (column-major).
        let m00 = e[0] / sx; let m01 = e[4] / sy; let m02 = e[8] / sz;
        let m10 = e[1] / sx; let m11 = e[5] / sy; let m12 = e[9] / sz;
        let m20 = e[2] / sx; let m21 = e[6] / sy; let m22 = e[10] / sz;
        let tr = m00 + m11 + m22; let qx = 0.0; let qy = 0.0; let qz = 0.0; let qw = 1.0;
        if (tr > 0.0) {
            let s = sqrt(tr + 1.0) * 2.0;
            qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
        } else {
            if (m00 > m11) { if (m00 > m22) {
                let s = sqrt(1.0 + m00 - m11 - m22) * 2.0;
                qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
            } else {
                let s = sqrt(1.0 + m22 - m00 - m11) * 2.0;
                qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
            } } else { if (m11 > m22) {
                let s = sqrt(1.0 + m11 - m00 - m22) * 2.0;
                qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
            } else {
                let s = sqrt(1.0 + m22 - m00 - m11) * 2.0;
                qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
            } }
        }
        obj.quaternion = new Quat(qx, qy, qz, qw).normalize();
        return obj;
    }

    buildMesh(mi) {
        let m = this.doc.meshes[mi];
        let group = new Object3D(); group.nodeType = "group";
        if (has(m, "name")) { group.name = m.name; }
        let prims = m.primitives;
        for (let i = 0; i < len(prims); i++) {
            let prim = prims[i];
            let geo = this.buildGeometry(prim); let mat = this.buildMaterial(prim);
            group.add(new Mesh(geo, mat));
        }
        return group;
    }

    buildGeometry(prim) {
        let attrs = prim.attributes;
        let positions = this.readAccessor(attrs.POSITION);
        let normals = 0; if (has(attrs, "NORMAL")) { normals = this.readAccessor(attrs.NORMAL); }
        let uvs = 0; if (has(attrs, "TEXCOORD_0")) { uvs = this.readAccessor(attrs.TEXCOORD_0); }
        let indices;
        if (has(prim, "indices")) { indices = this.readAccessor(prim.indices); }
        else { let n = len(positions) / 3; indices = range(n); }
        return new Geometry(positions, normals, uvs, indices);
    }

    buildMaterial(prim) {
        let mat = new Material();
        if (!has(prim, "material")) { return mat; }
        let g = this.doc.materials[prim.material];
        if (has(g, "name")) { mat.name = g.name; }
        if (has(g, "pbrMetallicRoughness")) {
            let pbr = g.pbrMetallicRoughness;
            if (has(pbr, "baseColorFactor")) { mat.color = pbr.baseColorFactor; }
            if (has(pbr, "metallicFactor")) { mat.metallic = pbr.metallicFactor; }
            if (has(pbr, "roughnessFactor")) { mat.roughness = pbr.roughnessFactor; }
        }
        if (has(g, "emissiveFactor")) { mat.emissive = g.emissiveFactor; }
        if (has(g, "doubleSided")) { if (g.doubleSided) { mat.doubleSided = 1.0; } }
        return mat;
    }
}
