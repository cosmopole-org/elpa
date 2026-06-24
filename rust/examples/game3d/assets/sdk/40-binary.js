// Elpa Game3D — binary decoding primitives.
//
// glTF binary buffers (and `.glb` containers) are little-endian byte blobs the
// loader must read as typed values. The Elpian VM has no `ArrayBuffer` /
// `DataView` and no bitwise operators, so this module rebuilds just enough of
// that surface from plain integer arrays and arithmetic:
//
//   Base64.decode(str)   — standard + URL-safe base64 → an array of byte ints.
//   BinaryReader         — a cursor over a byte array with little-endian
//                          readers for u8/u16/u32/i8/i16/i32 and IEEE-754 f32.
//
// `decodeFloat32` reconstructs an IEEE-754 single from its 32-bit pattern using
// only `floor`/`pow`/division — no bit ops — so it runs unchanged on the VM.

// ----------------------------------------------------------------- Base64 ------
// A lazily-built code → value lookup for both the standard and URL-safe
// alphabets. Padding ('=') and any whitespace are skipped.
let __b64_lut = 0;
function b64Lut() {
    if (__b64_lut != 0) { return __b64_lut; }
    let alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let m = {};
    for (let i = 0; i < len(alpha); i++) { m[charAt(alpha, i)] = i; }
    m["-"] = 62; m["_"] = 63; // URL-safe variants
    __b64_lut = m; return m;
}

class Base64 {
    // Decode a base64 string to an array of byte values (0..255).
    decode(s) {
        let lut = b64Lut(); let out = []; let acc = 0; let bits = 0;
        for (let i = 0; i < len(s); i++) {
            let c = charAt(s, i);
            if (has(lut, c)) {
                acc = acc * 64 + lut[c]; bits = bits + 6;
                if (bits >= 8) {
                    bits = bits - 8; let shift = pow(2.0, bits);
                    let byte = floor(acc / shift);
                    push(out, byte); acc = acc - byte * shift;
                }
            }
        }
        return out;
    }
    // Strip a `data:...;base64,` URI prefix if present, then decode.
    decodeDataUri(uri) {
        let comma = indexOf(uri, ",");
        if (comma >= 0) { return this.decode(slice(uri, comma + 1)); }
        return this.decode(uri);
    }
}
let B64 = new Base64();

// Reconstruct an IEEE-754 32-bit float from its unsigned 32-bit bit pattern.
function decodeFloat32(u) {
    if (u == 0) { return 0.0; }
    let sign = 1.0;
    if (u >= 2147483648) { sign = -1.0; u = u - 2147483648; } // clear sign bit (2^31)
    let exp = floor(u / 8388608);            // bits 23..30 (2^23)
    let mant = u - exp * 8388608;            // low 23 bits
    if (exp == 0) { return sign * (mant / 8388608.0) * pow(2.0, -126.0); } // subnormal
    if (exp == 255) {
        if (mant == 0) { return sign * INF(); }
        return NAN();
    }
    return sign * (1.0 + mant / 8388608.0) * pow(2.0, exp - 127.0);
}

// -------------------------------------------------------------- BinaryReader ---
// A little-endian cursor over a byte array (`bytes`, an array of 0..255 ints).
class BinaryReader {
    constructor(bytes, offset) {
        this.bytes = bytes;
        if (isNull(offset)) { offset = 0; }
        this.pos = offset;
    }
    seek(p) { this.pos = p; return this; }
    remaining() { return len(this.bytes) - this.pos; }

    u8() { let v = this.bytes[this.pos]; this.pos = this.pos + 1; return v; }
    u16() { let b = this.bytes; let p = this.pos; this.pos = p + 2; return b[p] + b[p + 1] * 256; }
    u32() {
        let b = this.bytes; let p = this.pos; this.pos = p + 4;
        return b[p] + b[p + 1] * 256 + b[p + 2] * 65536 + b[p + 3] * 16777216;
    }
    i8() { let v = this.u8(); if (v >= 128) { v = v - 256; } return v; }
    i16() { let v = this.u16(); if (v >= 32768) { v = v - 65536; } return v; }
    i32() { let v = this.u32(); if (v >= 2147483648) { v = v - 4294967296; } return v; }
    f32() { return decodeFloat32(this.u32()); }

    // Decode a run of UTF-8-ish bytes as an ASCII string (glTF JSON chunks and
    // the GLB magic are ASCII; non-ASCII bytes pass through as code points).
    ascii(count) {
        let s = ""; let end = this.pos + count;
        for (let i = this.pos; i < end; i++) { s = concat(s, chr(this.bytes[i])); }
        this.pos = end; return s;
    }
}

// Read `count` little-endian f32s starting at byte offset `off` in `bytes`.
function readF32Array(bytes, off, count) {
    let r = new BinaryReader(bytes, off); let out = fill(count, 0.0);
    for (let i = 0; i < count; i++) { out[i] = r.f32(); }
    return out;
}
