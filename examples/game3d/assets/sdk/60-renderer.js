// Elpa Game3D — the forward renderer.
//
// Walks the scene graph once per frame, collects the visible meshes and the
// active lights, builds the wgpu command tree (a single depth-tested 3D render
// pass) and `gpu.submit`s it. All transform / projection / normal math is done
// on the CPU by the math layer and uploaded as finished matrices, so the WGSL
// here is a straightforward forward shader: a Blinn-Phong accumulation over the
// scene's lights with ambient + emissive terms and point-light attenuation.
//
// Resource identity is stable across frames (pipelines by fixed id, geometry
// buffers by geometry id, per-object uniforms by node id), so Elpa's resource
// cache builds each GPU object once and only re-uploads the bytes that changed —
// static geometry costs nothing after the first frame; only the small per-frame
// uniforms (camera, transforms, lights) are refilled in place.

// The forward shader. `MAX_LIGHTS` here must equal the JS `MAX_LIGHTS` (8).
let G3D_WGSL = "
struct Light {
    posdir : vec4<f32>,
    color  : vec4<f32>,
    params : vec4<f32>,
};
struct Scene {
    view    : mat4x4<f32>,
    proj    : mat4x4<f32>,
    camPos  : vec4<f32>,
    ambient : vec4<f32>,
    params  : vec4<f32>,
    lights  : array<Light, 8>,
};
@group(0) @binding(0) var<uniform> scene : Scene;

struct Model {
    model     : mat4x4<f32>,
    normalMat : mat4x4<f32>,
    baseColor : vec4<f32>,
    pbr       : vec4<f32>,
    emissive  : vec4<f32>,
};
@group(1) @binding(0) var<uniform> obj : Model;

struct VSIn {
    @location(0) pos : vec3<f32>,
    @location(1) nrm : vec3<f32>,
    @location(2) uv  : vec2<f32>,
};
struct VSOut {
    @builtin(position) clip : vec4<f32>,
    @location(0) wpos : vec3<f32>,
    @location(1) wnrm : vec3<f32>,
    @location(2) uv   : vec2<f32>,
};

@vertex
fn vs(in : VSIn) -> VSOut {
    let world = obj.model * vec4<f32>(in.pos, 1.0);
    var o : VSOut;
    o.wpos = world.xyz;
    o.wnrm = (obj.normalMat * vec4<f32>(in.nrm, 0.0)).xyz;
    o.uv = in.uv;
    o.clip = scene.proj * (scene.view * world);
    return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
    let N = normalize(in.wnrm);
    let V = normalize(scene.camPos.xyz - in.wpos);
    let base = obj.baseColor.rgb;
    let rough = clamp(obj.pbr.y, 0.05, 1.0);
    let shininess = mix(4.0, 128.0, 1.0 - rough);
    let metallic = obj.pbr.x;
    var color = scene.ambient.rgb * scene.ambient.a * base;
    let count = i32(scene.params.x);
    for (var i = 0; i < count; i = i + 1) {
        let L = scene.lights[i];
        var Ldir : vec3<f32>;
        var atten = 1.0;
        if (L.posdir.w < 0.5) {
            Ldir = normalize(-L.posdir.xyz);
        } else {
            let toL = L.posdir.xyz - in.wpos;
            let dist = length(toL);
            Ldir = toL / max(dist, 0.0001);
            let range = max(L.params.x, 0.0001);
            let f = clamp(1.0 - dist / range, 0.0, 1.0);
            atten = f * f;
        }
        let ndl = max(dot(N, Ldir), 0.0);
        let H = normalize(Ldir + V);
        let ndh = max(dot(N, H), 0.0);
        let spec = pow(ndh, shininess) * (1.0 - rough);
        let radiance = L.color.rgb * L.color.a * atten;
        let specCol = mix(vec3<f32>(1.0), base, metallic) * spec;
        color = color + radiance * (base * ndl + specCol);
    }
    color = color + obj.emissive.rgb * obj.pbr.z;
    return vec4<f32>(color, obj.baseColor.a);
}
";

// Buffer-descriptor helpers (float / uint32 numeric channels — no base64).
function bufF32g(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_f32: data }; }
function bufU32g(id, usage, data) { return { kind: "buffer", id: id, size: len(data) * 4, usage: usage, data_u32: data }; }

class Renderer {
    constructor() {
        this.colorFormat = "bgra8unorm"; // refreshed from the live surface
        this.depthFormat = "depth32float";
        this.stats = { meshes: 0, lights: 0, drawCalls: 0 };
    }

    // The shared, created-once pipeline resources (two pipelines: back-face cull
    // for solids and no cull for double-sided materials).
    pipelineResources() {
        let attrs = [
            { format: "float32x3", offset: 0, shader_location: 0 },
            { format: "float32x3", offset: 12, shader_location: 1 },
            { format: "float32x2", offset: 24, shader_location: 2 }];
        let vbl = { array_stride: VERTEX_STRIDE, step_mode: "vertex", attributes: attrs };
        let depth = { format: this.depthFormat, depth_write_enabled: true, depth_compare: "less" };
        return [
            { kind: "shader", id: "g3d.shader", wgsl: G3D_WGSL },
            { kind: "bindGroupLayout", id: "g3d.bgl.scene",
                entries: [{ binding: 0, visibility: ["VERTEX", "FRAGMENT"], ty: "uniform" }] },
            { kind: "bindGroupLayout", id: "g3d.bgl.model",
                entries: [{ binding: 0, visibility: ["VERTEX", "FRAGMENT"], ty: "uniform" }] },
            { kind: "pipelineLayout", id: "g3d.layout", bind_group_layouts: ["g3d.bgl.scene", "g3d.bgl.model"] },
            this.pipelineDesc("g3d.pipe", "back", vbl, depth),
            this.pipelineDesc("g3d.pipe.double", "none", vbl, depth)];
    }
    pipelineDesc(id, cull, vbl, depth) {
        return { kind: "renderPipeline", id: id, layout: "g3d.layout",
            vertex: { module: "g3d.shader", entry_point: "vs", buffers: [vbl] },
            fragment: { module: "g3d.shader", entry_point: "fs", targets: [{ format: this.colorFormat }] },
            primitive: { topology: "triangle-list", front_face: "ccw", cull_mode: cull },
            depth_stencil: depth };
    }

    // ---- per-frame uniforms -------------------------------------------------
    // The scene uniform: view, proj, camera position, ambient, light count, then
    // the fixed array of MAX_LIGHTS packed lights (zero-filled past the count).
    sceneUniform(scene, camera, lights) {
        let out = [];
        appendAll(out, camera.viewMatrix().e);
        appendAll(out, camera.projectionMatrix.e);
        let cp = camera.worldPosition();
        push(out, cp.x); push(out, cp.y); push(out, cp.z); push(out, 1.0);
        push(out, scene.ambient[0]); push(out, scene.ambient[1]); push(out, scene.ambient[2]); push(out, scene.ambientIntensity);
        let count = min(len(lights), MAX_LIGHTS);
        push(out, count); push(out, 0.0); push(out, 0.0); push(out, 0.0);
        for (let i = 0; i < MAX_LIGHTS; i++) {
            if (i < count) { appendAll(out, lights[i].pack()); }
            else { appendAll(out, fill(LIGHT_STRIDE, 0.0)); }
        }
        return out;
    }
    // The per-object uniform: model matrix, normal matrix, base colour, pbr, emissive.
    modelUniform(mesh) {
        let out = []; let mat = mesh.material; let packed = mat.pack();
        appendAll(out, mesh.worldMatrix.e);
        appendAll(out, mesh.worldMatrix.normalMatrix().e);
        for (let i = 0; i < 4; i++) { push(out, packed[i]); }      // baseColor rgba
        for (let i = 4; i < 8; i++) { push(out, packed[i]); }      // metallic, roughness, emissiveIntensity, 0
        appendAll(out, mat.emissivePacked());
        return out;
    }

    // ---- collection ---------------------------------------------------------
    collect(scene) {
        let meshes = []; let lights = [];
        scene.traverse((node) => {
            if (node.visible > 0.5) {
                if (node.nodeType == "mesh") { push(meshes, node); }
                if (node.nodeType == "light") { push(lights, node); }
            }
        });
        return { meshes: meshes, lights: lights };
    }

    // ---- frame --------------------------------------------------------------
    render(scene, camera, si, game) {
        if (has(si, "colorFormat")) { this.colorFormat = si.colorFormat; }
        let w = num(si.width); let h = num(si.height);
        let aspect = w / h; if (has(si, "aspect")) { aspect = num(si.aspect); }
        if (aspect < 0.0001) { aspect = 1.0; }

        scene.updateWorld(0);
        if (camera.parent == 0) { camera.updateWorld(0); }
        camera.updateProjection(aspect);

        let got = this.collect(scene);
        let meshes = got.meshes; let lights = got.lights;
        this.stats = { meshes: len(meshes), lights: len(lights), drawCalls: len(meshes) };

        let depthId = concat(concat(concat("g3d.depth.", str(floor(w))), "x"), str(floor(h)));
        let res = this.pipelineResources();
        push(res, { kind: "texture", id: depthId, size: { width: floor(w), height: floor(h), depth: 1 },
            format: this.depthFormat, usage: ["RENDER_ATTACHMENT"] });
        push(res, bufF32g("g3d.scene", ["UNIFORM", "COPY_DST"], this.sceneUniform(scene, camera, lights)));
        push(res, { kind: "bindGroup", id: "g3d.scene.bg", layout: "g3d.bgl.scene",
            entries: [{ binding: 0, resource: { type: "buffer", buffer: "g3d.scene" } }] });

        let cmds = [{ cmd: "setBindGroup", index: 0, bind_group: "g3d.scene.bg" }];
        let seenGeom = {};
        for (let i = 0; i < len(meshes); i++) {
            let mesh = meshes[i]; let geo = mesh.geometry;
            let vboId = concat("g3d.vbo.", str(geo.id));
            let iboId = concat("g3d.ibo.", str(geo.id));
            if (!has(seenGeom, str(geo.id))) {
                seenGeom[str(geo.id)] = 1.0;
                push(res, bufF32g(vboId, ["VERTEX"], geo.vertexData()));
                push(res, bufU32g(iboId, ["INDEX"], geo.indices));
            }
            let modelId = concat("g3d.model.", str(mesh.id));
            let modelBg = concat("g3d.model.bg.", str(mesh.id));
            push(res, bufF32g(modelId, ["UNIFORM", "COPY_DST"], this.modelUniform(mesh)));
            push(res, { kind: "bindGroup", id: modelBg, layout: "g3d.bgl.model",
                entries: [{ binding: 0, resource: { type: "buffer", buffer: modelId } }] });
            let pipe = "g3d.pipe"; if (mesh.material.doubleSided > 0.5) { pipe = "g3d.pipe.double"; }
            push(cmds, { cmd: "setPipeline", pipeline: pipe });
            push(cmds, { cmd: "setBindGroup", index: 1, bind_group: modelBg });
            push(cmds, { cmd: "setVertexBuffer", slot: 0, buffer: vboId, offset: 0 });
            push(cmds, { cmd: "setIndexBuffer", buffer: iboId, format: "uint32", offset: 0 });
            push(cmds, { cmd: "drawIndexed", index_count: geo.indexCount(), instance_count: 1, first_index: 0, base_vertex: 0, first_instance: 0 });
        }

        let bg = scene.background;
        let pass = { op: "renderPass", id: "g3d.pass",
            color_attachments: [{ view: { kind: "surface" }, load: "clear",
                clear_color: { r: bg[0], g: bg[1], b: bg[2], a: bg[3] } }],
            depth_stencil: { view: depthId, depth_load: "clear", depth_clear: 1.0, depth_store: true },
            commands: cmds };
        let passes = [pass];

        // Composite the 2D HUD over the 3D image: a second, depth-less pass that
        // `load`s the scene and alpha-blends the floating panels on top. Built in
        // logical pixels (the pointer-event space) so the HUD is DPI-correct.
        if (!isNull(game)) {
            if (game.overlay != 0) {
                if (game.overlay.visible > 0.5) {
                    let lw = w; let lh = h;
                    if (has(si, "logicalWidth")) { lw = num(si.logicalWidth); }
                    if (has(si, "logicalHeight")) { lh = num(si.logicalHeight); }
                    let ov = game.overlay.build(game, lw, lh, this.colorFormat);
                    if (ov != 0) { appendAll(res, ov.resources); push(passes, ov.pass); }
                }
            }
        }

        askHost("gpu.submit", [{ resources: res, commands: passes }]);
        return 0;
    }
}

// Append every element of `src` onto `dst` (in place). Used to splice matrices /
// packed light & material data into a flat uniform float array.
function appendAll(dst, src) { for (let i = 0; i < len(src); i++) { push(dst, src[i]); } return dst; }
