#!/usr/bin/env python3
"""Generate the two glTF assets the Game3D demo loads at runtime.

The Game3D engine ships a full glTF 2.0 / GLB loader (`assets/sdk/45-gltf.js`),
but until now the island-village demo only ever used the SDK's procedural
primitives, so the loader path never ran on a live GPU. This tool bakes two tiny,
hand-built models so the demo can exercise *both* loader entry points end to end:

  * a faceted octahedron "crystal" as a binary **.glb** container -> base64 string,
    loaded with `loadGLBBase64(...)`.
  * a hexagonal-bipyramid "diamond" as a **.gltf** JSON document whose buffer is a
    `data:` base64 URI, loaded with `loadGLTF(doc, 0)`.

Both are flat-shaded (vertices duplicated per face) with outward-wound triangles
to match the renderer's CCW / back-face-cull pipeline, and carry explicit NORMAL
accessors so the loader's accessor decoder is exercised too. Output is written
straight into `examples/game3d/assets/models.js`, the SDK module the demo links.
"""

import base64
import json
import math
import struct
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "examples" / "game3d" / "assets" / "models.js"


def faceted(faces):
    """Flat-shaded mesh from a list of triangle corner-position triples.

    Each face becomes three fresh vertices with a shared, outward-pointing face
    normal (flipped if the wound order faces inward relative to the origin), so
    gems read as crisp facets rather than a smooth blob.
    """
    positions, normals, indices = [], [], []
    for a, b, c in faces:
        ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        nx, ny, nz = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        # Centroid points roughly outward for a star-shaped solid about origin.
        cx, cy, cz = ((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)
        if nx * cx + ny * cy + nz * cz < 0.0:
            a, b, c = a, c, b
            nx, ny, nz = -nx, -ny, -nz
        ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        n = (nx / ln, ny / ln, nz / ln)
        base = len(positions) // 3
        for p in (a, b, c):
            positions += [p[0], p[1], p[2]]
            normals += [n[0], n[1], n[2]]
        indices += [base, base + 1, base + 2]
    return positions, normals, indices


def octahedron(r=1.0):
    px, nx = (r, 0, 0), (-r, 0, 0)
    py, ny = (0, r, 0), (0, -r, 0)
    pz, nz = (0, 0, r), (0, 0, -r)
    faces = [
        (py, px, pz), (py, pz, nx), (py, nx, nz), (py, nz, px),
        (ny, pz, px), (ny, nx, pz), (ny, nz, nx), (ny, px, nz),
    ]
    return faceted(faces)


def hex_bipyramid(r=0.85, top=1.25, bot=1.0, sides=6):
    ring = []
    for i in range(sides):
        a = 2 * math.pi * i / sides
        ring.append((math.cos(a) * r, 0.0, math.sin(a) * r))
    apex_t, apex_b = (0.0, top, 0.0), (0.0, -bot, 0.0)
    faces = []
    for i in range(sides):
        a, b = ring[i], ring[(i + 1) % sides]
        faces.append((apex_t, a, b))
        faces.append((apex_b, a, b))
    return faceted(faces)


def buffers(positions, normals, indices, material):
    """Pack pos(f32) + nrm(f32) + idx(u16) into one little-endian blob plus the
    accessor / bufferView metadata that indexes it (shared by GLB and glTF)."""
    nverts = len(positions) // 3
    pos_b = struct.pack("<%df" % len(positions), *positions)
    nrm_b = struct.pack("<%df" % len(normals), *normals)
    idx_b = struct.pack("<%dH" % len(indices), *indices)
    blob = pos_b + nrm_b + idx_b
    pad = (-len(blob)) % 4
    blob += b"\x00" * pad

    pos_off, nrm_off, idx_off = 0, len(pos_b), len(pos_b) + len(nrm_b)
    # min/max are required on POSITION accessors by the spec.
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    doc = {
        "asset": {"version": "2.0", "generator": "elpa gen_demo_models"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [material],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": nverts, "type": "VEC3",
             "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]},
            {"bufferView": 1, "componentType": 5126, "count": nverts, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_off, "byteLength": len(pos_b)},
            {"buffer": 0, "byteOffset": nrm_off, "byteLength": len(nrm_b)},
            {"buffer": 0, "byteOffset": idx_off, "byteLength": len(idx_b)},
        ],
        "buffers": [{"byteLength": len(pos_b) + len(nrm_b) + len(idx_b)}],
    }
    return doc, blob


def make_glb(positions, normals, indices, material):
    doc, blob = buffers(positions, normals, indices, material)
    json_bytes = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(blob))
    out += struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes  # JSON chunk
    out += struct.pack("<II", len(blob), 0x004E4942) + blob              # BIN chunk
    return base64.b64encode(bytes(out)).decode("ascii")


def make_gltf(positions, normals, indices, material):
    doc, blob = buffers(positions, normals, indices, material)
    doc["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(blob).decode("ascii")
    return json.dumps(doc, separators=(",", ":"))


# A glowing cyan crystal and a warm metallic-gold gem, via the pbrMetallicRoughness
# model the loader reads (baseColorFactor / metallic / roughness / emissiveFactor).
GEM_MATERIAL = {
    "name": "crystal",
    "pbrMetallicRoughness": {"baseColorFactor": [0.45, 0.85, 0.95, 1.0], "metallicFactor": 0.1, "roughnessFactor": 0.15},
    "emissiveFactor": [0.10, 0.45, 0.55],
}
DIAMOND_MATERIAL = {
    "name": "gold-gem",
    "pbrMetallicRoughness": {"baseColorFactor": [0.95, 0.78, 0.30, 1.0], "metallicFactor": 0.9, "roughnessFactor": 0.2},
    "emissiveFactor": [0.18, 0.10, 0.0],
}


def main():
    gem_glb_b64 = make_glb(*octahedron(1.0), GEM_MATERIAL)
    diamond_gltf = make_gltf(*hex_bipyramid(), DIAMOND_MATERIAL)

    js = f"""// Elpa Game3D — demo model assets (generated; do not edit by hand).
//
// Two tiny hand-built glTF models the island-village demo loads at runtime so the
// SDK's glTF/GLB loader (`45-gltf.js`) runs on a live GPU, not just in tests:
//
//   * GEM_GLB_B64  — a faceted octahedron "crystal" as a base64 **.glb** binary
//                    container, loaded with `loadGLBBase64(GEM_GLB_B64)`.
//   * DIAMOND_GLTF — a hexagonal-bipyramid "diamond" as a **.gltf** JSON document
//                    with a `data:` base64 buffer, loaded with
//                    `loadGLTF(diamondGLTF(), 0)`.
//
// Regenerate with:  python3 scripts/gen_demo_models.py
// (octahedron + hex-bipyramid, flat-shaded, outward-wound, with NORMAL accessors).

let GEM_GLB_B64 = "{gem_glb_b64}";
let DIAMOND_GLTF_JSON = {json.dumps(diamond_gltf)};

// Parse the embedded glTF document once, on demand.
function diamondGLTF() {{ return jsonParse(DIAMOND_GLTF_JSON); }}
"""
    OUT.write_text(js)
    print(f"wrote {OUT.relative_to(REPO)}")
    print(f"  GEM_GLB_B64:  {len(gem_glb_b64)} base64 chars (octahedron, 8 facets)")
    print(f"  DIAMOND_GLTF: {len(diamond_gltf)} JSON chars (hex bipyramid, 12 facets)")


if __name__ == "__main__":
    main()
