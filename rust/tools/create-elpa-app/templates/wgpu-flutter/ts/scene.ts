// The 3D scene: a spinning, multi-coloured cube rendered by Elpa's wgpu pipeline
// into the Native3DView surface. Every frame builds one depth-tested render pass
// — a shader, a render pipeline, the cube geometry, and an MVP uniform — and
// submits it over the GPU pipe (app.gpu). Elpa's resource cache creates each GPU
// object once (keyed by the stable ids below) and only re-uploads the bytes that
// change, so after the first frame only the 64-byte MVP uniform is refilled.
//
// The JSON shapes here mirror Elpa's wire protocol exactly (snake_case resource
// fields, an array `usage`, `op: "renderPass"` with `color_attachments`): the VM
// deserializes them straight into the renderer's command tree. Extend `prime()`
// with your own geometry/materials, or replace the shader for custom effects.

import { app } from "./app";

// ---- the shader: transform by the MVP uniform, output the vertex colour -------
const CUBE_WGSL = `
struct U { mvp : mat4x4<f32> };
@group(0) @binding(0) var<uniform> u : U;

struct VSIn  { @location(0) pos : vec3<f32>, @location(1) col : vec3<f32> };
struct VSOut { @builtin(position) clip : vec4<f32>, @location(0) col : vec3<f32> };

@vertex
fn vs(in : VSIn) -> VSOut {
    var o : VSOut;
    o.clip = u.mvp * vec4<f32>(in.pos, 1.0);
    o.col = in.col;
    return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.col, 1.0);
}
`;

// Half-extent of the cube and the six face colours (one flat colour per face).
const S = 0.8;
const FACE_COLORS = [
    [0.91, 0.30, 0.24], // +Z front  (red)
    [0.18, 0.80, 0.44], // -Z back   (green)
    [0.20, 0.60, 0.86], // -X left   (blue)
    [0.95, 0.77, 0.06], // +X right  (yellow)
    [0.10, 0.74, 0.78], // +Y top    (cyan)
    [0.61, 0.35, 0.71], // -Y bottom (purple)
];
// The four corners of each face, CCW from outside. Position only; the colour is
// taken from FACE_COLORS by face index when the interleaved buffer is built.
const FACE_CORNERS = [
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], // +Z
    [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], // -Z
    [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], // -X
    [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], // +X
    [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], // +Y
    [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], // -Y
];

/// Build the interleaved vertex buffer (pos.xyz, col.rgb — 6 floats/vertex) and
/// the 36 triangle indices (two per face).
function buildGeometry(): { verts: number[]; indices: number[] } {
    const verts: number[] = [];
    const indices: number[] = [];
    for (let f = 0; f < 6; f++) {
        const base = f * 4;
        const color = FACE_COLORS[f];
        for (let c = 0; c < 4; c++) {
            const p = FACE_CORNERS[f][c];
            verts.push(p[0] * S, p[1] * S, p[2] * S, color[0], color[1], color[2]);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { verts, indices };
}

// ---- column-major 4x4 matrix maths (WebGPU clip space, z in [0,1]) ------------
function matMul(a: number[], b: number[]): number[] {
    const out: number[] = [];
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let s = 0.0;
            for (let k = 0; k < 4; k++) {
                s += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = s;
        }
    }
    return out;
}

function perspective(fovyRad: number, aspect: number, near: number, far: number): number[] {
    const f = 1.0 / Math.tan(fovyRad * 0.5);
    const nf = 1.0 / (near - far);
    return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, far * nf, -1,
        0, 0, near * far * nf, 0,
    ];
}

function translation(x: number, y: number, z: number): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function rotationY(a: number): number[] {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function rotationX(a: number): number[] {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

export class SceneController {
    gpu = app.gpu;
    angle = 0.0;
    spinning = true;
    geom = buildGeometry();

    /// Reserved for parity with the prior API; geometry is built eagerly above and
    /// every GPU resource is declared per-frame (the cache creates each once).
    prime(): void {}

    render(dt: number): void {
        if (this.spinning) {
            this.angle += dt * 0.0012; // dt is milliseconds
        }

        // Live surface metrics: size for the depth target + aspect, and the exact
        // colour format the pipeline's target must match (the surface may be
        // *-srgb; wgpu requires an exact match).
        const si: any = this.gpu.surfaceInfo();
        const w = Math.floor(si && si.width ? si.width : 1) || 1;
        const h = Math.floor(si && si.height ? si.height : 1) || 1;
        const aspect = h > 0 ? w / h : 1.0;
        const colorFormat = si && si.colorFormat ? si.colorFormat : "bgra8unorm";

        // MVP = proj · view · model. View pushes the cube back; model tumbles it.
        const proj = perspective(Math.PI / 3.0, aspect, 0.1, 100.0);
        const view = translation(0.0, 0.0, -3.2);
        const model = matMul(rotationY(this.angle), rotationX(this.angle * 0.6));
        const mvp = matMul(proj, matMul(view, model));

        // A depth texture sized to the surface (id carries the size so a resize
        // creates a fresh one rather than reusing a mismatched cache entry).
        const depthId = "cube.depth." + w + "x" + h;

        const resources = [
            { kind: "shader", id: "cube.shader", wgsl: CUBE_WGSL },
            {
                kind: "bindGroupLayout",
                id: "cube.bgl",
                entries: [{ binding: 0, visibility: ["VERTEX"], ty: "uniform" }],
            },
            { kind: "pipelineLayout", id: "cube.layout", bind_group_layouts: ["cube.bgl"] },
            {
                kind: "renderPipeline",
                id: "cube.pipe",
                layout: "cube.layout",
                vertex: {
                    module: "cube.shader",
                    entry_point: "vs",
                    buffers: [
                        {
                            array_stride: 24,
                            step_mode: "vertex",
                            attributes: [
                                { format: "float32x3", offset: 0, shader_location: 0 },
                                { format: "float32x3", offset: 12, shader_location: 1 },
                            ],
                        },
                    ],
                },
                fragment: {
                    module: "cube.shader",
                    entry_point: "fs",
                    targets: [{ format: colorFormat }],
                },
                primitive: { topology: "triangle-list", front_face: "ccw", cull_mode: "none" },
                depth_stencil: { format: "depth32float", depth_write_enabled: true, depth_compare: "less" },
            },
            {
                kind: "texture",
                id: depthId,
                size: { width: w, height: h, depth: 1 },
                format: "depth32float",
                usage: ["RENDER_ATTACHMENT"],
            },
            {
                kind: "buffer",
                id: "cube.vb",
                size: this.geom.verts.length * 4,
                usage: ["VERTEX"],
                data_f32: this.geom.verts,
            },
            {
                kind: "buffer",
                id: "cube.ib",
                size: this.geom.indices.length * 4,
                usage: ["INDEX"],
                data_u32: this.geom.indices,
            },
            {
                kind: "buffer",
                id: "cube.mvp",
                size: 64,
                usage: ["UNIFORM", "COPY_DST"],
                data_f32: mvp,
            },
            {
                kind: "bindGroup",
                id: "cube.bg",
                layout: "cube.bgl",
                entries: [{ binding: 0, resource: { type: "buffer", buffer: "cube.mvp" } }],
            },
        ];

        // Animate the clear colour slightly so the card is visibly alive even on a
        // host where the GPU surface has not (yet) been registered.
        const t = (Math.sin(this.angle) + 1.0) * 0.5;
        const bg = { r: 0.05 + t * 0.06, g: 0.09, b: 0.16 + t * 0.06, a: 1.0 };

        const pass = {
            op: "renderPass",
            id: "cube.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear", store: true, clear_color: bg }],
            depth_stencil: { view: depthId, depth_load: "clear", depth_clear: 1.0, depth_store: true },
            commands: [
                { cmd: "setPipeline", pipeline: "cube.pipe" },
                { cmd: "setBindGroup", index: 0, bind_group: "cube.bg" },
                { cmd: "setVertexBuffer", slot: 0, buffer: "cube.vb", offset: 0 },
                { cmd: "setIndexBuffer", buffer: "cube.ib", format: "uint32", offset: 0 },
                {
                    cmd: "drawIndexed",
                    index_count: this.geom.indices.length,
                    instance_count: 1,
                    first_index: 0,
                    base_vertex: 0,
                    first_instance: 0,
                },
            ],
        };

        this.gpu.submit({ resources: resources, commands: [pass] });
    }
}

export const sceneCtl = new SceneController();
