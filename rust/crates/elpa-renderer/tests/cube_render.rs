//! End-to-end GPU proof for the wgpu-flutter demo's 3D scene: feed the *exact*
//! frame tree the template's `scene.ts` submits into the real wgpu backend
//! (offscreen), then read the pixels back and assert the spinning cube actually
//! painted — vivid, saturated face colors over the dark clear, not a blank card.
//!
//! Runs on a software adapter (lavapipe / SwiftShader) in CI; skips cleanly if no
//! Vulkan/GL adapter is available so it never fails on a GPU-less box.
//!
//!   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json \
//!   cargo test -p elpa-renderer --features wgpu-backend --test cube_render
#![cfg(feature = "wgpu-backend")]

use elpa_protocol::Frame;
use elpa_renderer::wgpu_backend::WgpuBackend;
use elpa_renderer::Renderer;

// ---- column-major 4x4 maths, ported 1:1 from the template's scene.ts ----------

fn mat_mul(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for c in 0..4 {
        for r in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = s;
        }
    }
    out
}
fn perspective(fovy: f32, aspect: f32, near: f32, far: f32) -> [f32; 16] {
    let f = 1.0 / (fovy * 0.5).tan();
    let nf = 1.0 / (near - far);
    [f / aspect, 0., 0., 0., 0., f, 0., 0., 0., 0., far * nf, -1., 0., 0., near * far * nf, 0.]
}
fn translation(x: f32, y: f32, z: f32) -> [f32; 16] {
    [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., x, y, z, 1.]
}
fn rot_y(a: f32) -> [f32; 16] {
    let (s, c) = a.sin_cos();
    [c, 0., -s, 0., 0., 1., 0., 0., s, 0., c, 0., 0., 0., 0., 1.]
}
fn rot_x(a: f32) -> [f32; 16] {
    let (s, c) = a.sin_cos();
    [1., 0., 0., 0., 0., c, s, 0., 0., -s, c, 0., 0., 0., 0., 1.]
}

const S: f32 = 0.8;
const FACE_COLORS: [[f32; 3]; 6] = [
    [0.91, 0.30, 0.24],
    [0.18, 0.80, 0.44],
    [0.20, 0.60, 0.86],
    [0.95, 0.77, 0.06],
    [0.10, 0.74, 0.78],
    [0.61, 0.35, 0.71],
];
const FACE_CORNERS: [[[f32; 3]; 4]; 6] = [
    [[-1., -1., 1.], [1., -1., 1.], [1., 1., 1.], [-1., 1., 1.]],
    [[1., -1., -1.], [-1., -1., -1.], [-1., 1., -1.], [1., 1., -1.]],
    [[-1., -1., -1.], [-1., -1., 1.], [-1., 1., 1.], [-1., 1., -1.]],
    [[1., -1., 1.], [1., -1., -1.], [1., 1., -1.], [1., 1., 1.]],
    [[-1., 1., 1.], [1., 1., 1.], [1., 1., -1.], [-1., 1., -1.]],
    [[-1., -1., -1.], [1., -1., -1.], [1., -1., 1.], [-1., -1., 1.]],
];

fn build_geometry() -> (Vec<f32>, Vec<u32>) {
    let mut verts = Vec::new();
    let mut indices = Vec::new();
    for f in 0..6 {
        let base = (f * 4) as u32;
        let col = FACE_COLORS[f];
        for c in 0..4 {
            let p = FACE_CORNERS[f][c];
            verts.extend_from_slice(&[p[0] * S, p[1] * S, p[2] * S, col[0], col[1], col[2]]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (verts, indices)
}

const CUBE_WGSL: &str = r#"
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
fn fs(in : VSOut) -> @location(0) vec4<f32> { return vec4<f32>(in.col, 1.0); }
"#;

/// The exact `{resources, commands}` tree scene.ts emits for one frame, at the
/// given surface size and color format, with the cube tumbled to `angle`.
fn cube_frame(w: u32, h: u32, color_format: &str, angle: f32) -> Frame {
    let (verts, indices) = build_geometry();
    let aspect = w as f32 / h as f32;
    let proj = perspective(std::f32::consts::PI / 3.0, aspect, 0.1, 100.0);
    let view = translation(0.0, 0.0, -3.2);
    let model = mat_mul(&rot_y(angle), &rot_x(angle * 0.6));
    let mvp = mat_mul(&proj, &mat_mul(&view, &model));
    let depth_id = format!("cube.depth.{w}x{h}");

    let json = serde_json::json!({
        "resources": [
            { "kind": "shader", "id": "cube.shader", "wgsl": CUBE_WGSL },
            { "kind": "bindGroupLayout", "id": "cube.bgl",
              "entries": [{ "binding": 0, "visibility": ["VERTEX"], "ty": "uniform" }] },
            { "kind": "pipelineLayout", "id": "cube.layout", "bind_group_layouts": ["cube.bgl"] },
            { "kind": "renderPipeline", "id": "cube.pipe", "layout": "cube.layout",
              "vertex": { "module": "cube.shader", "entry_point": "vs",
                "buffers": [{ "array_stride": 24, "step_mode": "vertex",
                  "attributes": [
                    { "format": "float32x3", "offset": 0, "shader_location": 0 },
                    { "format": "float32x3", "offset": 12, "shader_location": 1 }] }] },
              "fragment": { "module": "cube.shader", "entry_point": "fs",
                "targets": [{ "format": color_format }] },
              "primitive": { "topology": "triangle-list", "front_face": "ccw", "cull_mode": "none" },
              "depth_stencil": { "format": "depth32float", "depth_write_enabled": true, "depth_compare": "less" } },
            { "kind": "texture", "id": depth_id,
              "size": { "width": w, "height": h, "depth": 1 },
              "format": "depth32float", "usage": ["RENDER_ATTACHMENT"] },
            { "kind": "buffer", "id": "cube.vb", "size": verts.len() * 4, "usage": ["VERTEX"], "data_f32": verts },
            { "kind": "buffer", "id": "cube.ib", "size": indices.len() * 4, "usage": ["INDEX"], "data_u32": indices },
            { "kind": "buffer", "id": "cube.mvp", "size": 64, "usage": ["UNIFORM", "COPY_DST"], "data_f32": mvp.to_vec() },
            { "kind": "bindGroup", "id": "cube.bg", "layout": "cube.bgl",
              "entries": [{ "binding": 0, "resource": { "type": "buffer", "buffer": "cube.mvp" } }] }
        ],
        "commands": [{
            "op": "renderPass", "id": "cube.pass",
            "color_attachments": [{ "view": { "kind": "surface" }, "load": "clear", "store": true,
                "clear_color": { "r": 0.05, "g": 0.09, "b": 0.16, "a": 1.0 } }],
            "depth_stencil": { "view": depth_id, "depth_load": "clear", "depth_clear": 1.0, "depth_store": true },
            "commands": [
                { "cmd": "setPipeline", "pipeline": "cube.pipe" },
                { "cmd": "setBindGroup", "index": 0, "bind_group": "cube.bg" },
                { "cmd": "setVertexBuffer", "slot": 0, "buffer": "cube.vb", "offset": 0 },
                { "cmd": "setIndexBuffer", "buffer": "cube.ib", "format": "uint32", "offset": 0 },
                { "cmd": "drawIndexed", "index_count": indices.len(), "instance_count": 1,
                  "first_index": 0, "base_vertex": 0, "first_instance": 0 }
            ]
        }]
    })
    .to_string();
    Frame::parse(&json).expect("scene frame parses")
}

/// Count pixels that are "vivid" — bright and saturated, i.e. the cube's face
/// colors as opposed to the dark navy clear.
fn vivid_fraction(rgba: &[u8]) -> f64 {
    let mut vivid = 0usize;
    let n = rgba.len() / 4;
    for px in rgba.chunks_exact(4) {
        let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
        let mx = r.max(g).max(b);
        let mn = r.min(g).min(b);
        if mx > 120 && (mx - mn) > 70 {
            vivid += 1;
        }
    }
    vivid as f64 / n as f64
}

#[test]
fn cube_scene_actually_paints_pixels() {
    // Card-sized offscreen surface, like the Native3DView (≈358x240 @2x).
    let (w, h) = (716u32, 480u32);
    let instance = wgpu::Instance::default();
    // Skip (don't fail) when the box has no usable adapter at all.
    if pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::None,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .is_err()
    {
        eprintln!("no GPU adapter available; skipping cube_scene_actually_paints_pixels");
        return;
    }

    let format = wgpu::TextureFormat::Rgba8Unorm;
    let backend = pollster::block_on(WgpuBackend::new_offscreen(&instance, format, w, h));
    let mut renderer = Renderer::new(backend);

    // Render a tumbled frame (non-trivial rotation so all logic runs).
    let frame = cube_frame(w, h, "rgba8unorm", 0.7);
    let stats = renderer.render(&frame);
    assert!(stats.presented, "the surface pass must record + present");

    let rgba = renderer.backend().read_target_rgba().expect("offscreen target read back");
    let vivid = vivid_fraction(&rgba);
    eprintln!("vivid pixel fraction = {:.4} ({}x{})", vivid, w, h);

    // The cube fills a large central chunk of the card; require a clearly
    // non-trivial amount of saturated color. A blank/clear-only frame scores ~0.
    assert!(
        vivid > 0.05,
        "the spinning cube did not paint — only {:.2}% vivid pixels (expected the \
         multi-colored cube to fill a big part of the card)",
        vivid * 100.0
    );
}
