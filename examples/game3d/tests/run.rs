//! Drive the Game3D engine (JavaScript) on a real (headless) Elpa instance —
//! proof that the SDK and an app compile, link into one VM, and drive the whole
//! pipeline end to end: the engine walks a scene graph, builds a depth-tested 3D
//! render pass with per-object draws, and `gpu.submit`s it; animation moves the
//! scene; the glTF/GLB loader decodes real binary geometry; and the physics layer
//! answers ray-cast / AABB collision queries.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

// --------------------------------------------------------------- helpers -------

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

fn instance_for(program: &str) -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(1280, 720, 1.0), program)
        .expect("SDK + app program compiles")
}

fn render_pass(app: &Elpa<HeadlessBackend>) -> &elpa::protocol::RenderPass {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .expect("expected a render pass")
}

/// The bytes of the scene uniform buffer this frame (camera + lights).
fn scene_uniform(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("frame");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "g3d.scene" => b.data_f32.clone(),
            _ => None,
        })
        .expect("scene uniform present")
}

/// Every per-object uniform this frame (each mesh's model + material), in id
/// order — the bytes that change when meshes move even if the camera is still.
fn model_uniforms(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("frame");
    let mut named: Vec<(String, Vec<f32>)> = frame
        .resources
        .iter()
        .filter_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id.starts_with("g3d.model.") => {
                b.data_f32.clone().map(|d| (b.id.clone(), d))
            }
            _ => None,
        })
        .collect();
    named.sort_by(|a, b| a.0.cmp(&b.0));
    named.into_iter().flat_map(|(_, d)| d).collect()
}

// ------------------------------------------------------------------ tests ------

#[test]
fn engine_shader_is_valid_wgsl() {
    // Validate the engine's WGSL exactly as wgpu does. The SDK is JavaScript, so
    // lower it to Elpian AST first and walk that for the embedded shader string.
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_game3d::module_js())).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert_eq!(shaders.len(), 1, "the engine has one forward shader");
    let src = &shaders[0];
    let module = naga::front::wgsl::parse_str(src)
        .unwrap_or_else(|e| panic!("WGSL parse failed: {}", e.emit_to_string(src)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .expect("WGSL validation failed");
}

#[test]
fn demo_starts_and_draws_a_depth_tested_pass() {
    let mut app = instance_for(&elpa_game3d::program());
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "g3d.pipe"), "pipeline created");
    assert!(frame.resources.iter().any(|r| r.id() == "g3d.shader"), "shader created");

    let rp = render_pass(&app);
    assert!(rp.depth_stencil.is_some(), "the 3D pass is depth-tested");

    // One indexed draw per visible mesh — the island village has ~100 (houses,
    // trees, the windmill, boats, villagers, clouds, terrain).
    let draws: Vec<&RenderCommand> = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::DrawIndexed { .. }))
        .collect();
    assert!(draws.len() > 60, "a populated scene: one indexed draw per mesh (got {})", draws.len());

    // The scene binds group 0 (camera + lights) and there is a depth texture.
    assert!(frame.resources.iter().any(|r| matches!(r, ResourceDesc::Texture(t) if t.id.starts_with("g3d.depth."))));
    assert!(frame.resources.iter().any(|r| r.id() == "g3d.scene"));
}

#[test]
fn animation_moves_the_scene() {
    // The windmill sails turn, clouds drift, boats bob and villagers hop each
    // tick, so the per-object (model) uniforms must change frame to frame even
    // though the orbit camera is still.
    let mut app = instance_for(&elpa_game3d::program());
    app.start();
    let before = model_uniforms(&app);

    let mut moved = false;
    for _ in 0..6 {
        app.animate(16.0);
        moved |= model_uniforms(&app) != before;
    }
    assert!(moved, "animating moved the scene's objects");
    assert!(app.trap_reason().is_none(), "no trap while animating");
}

#[test]
fn orbit_drag_rotates_the_camera() {
    // Dragging the pointer must rotate the turntable camera, changing the view
    // matrix in the scene uniform.
    let mut app = instance_for(&elpa_game3d::program());
    app.start();
    let before = scene_uniform(&app);

    app.send_event(&InputEvent::PointerDown { x: 640.0, y: 360.0, button: 0 });
    app.send_event(&InputEvent::PointerMove { x: 900.0, y: 420.0 });
    let after = scene_uniform(&app);

    assert!(after != before, "dragging orbited the camera (view matrix changed)");
    assert!(app.trap_reason().is_none(), "no trap while orbiting");
}

#[test]
fn wheel_zoom_moves_the_camera() {
    // The wheel zooms the orbit rig in/out, moving the camera position.
    let mut app = instance_for(&elpa_game3d::program());
    app.start();
    let before = scene_uniform(&app);

    app.send_event(&InputEvent::Wheel { x: 640.0, y: 360.0, delta_y: -240.0 });
    let after = scene_uniform(&app);

    assert!(after != before, "the wheel zoomed the camera");
    assert!(app.trap_reason().is_none(), "no trap while zooming");
}

#[test]
fn resize_refits_the_projection() {
    let mut app = instance_for(&elpa_game3d::program());
    app.start();
    app.resize(800, 1200, 1.0);
    assert!(app.last_stats().presented, "resize forces a fresh present");
    assert!(app.trap_reason().is_none(), "no trap on resize");
    // The depth texture is sized to the new surface.
    let frame = app.last_frame().unwrap();
    assert!(
        frame.resources.iter().any(|r| matches!(r, ResourceDesc::Texture(t) if t.id == "g3d.depth.800x1200")),
        "depth target re-sized to the new surface"
    );
}

#[test]
fn pointer_pick_does_not_trap() {
    let mut app = instance_for(&elpa_game3d::program());
    app.start();
    // A tap routes through the engine's ray-cast pick path. (The pick itself does
    // not mutate the scene, so the re-rendered frame may be served from cache —
    // what matters is the ray cast runs cleanly without trapping the VM.)
    app.send_event(&InputEvent::PointerDown { x: 640.0, y: 360.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap on a pointer pick");
    assert!(app.take_log().is_empty(), "no host errors on a pointer pick");
}

// ---- glTF / GLB ---------------------------------------------------------------

/// A minimal but valid `.glb`: one triangle (3 float positions, 3 u16 indices).
fn build_triangle_glb() -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let indices: [u16; 3] = [0, 1, 2];
    let mut bin = Vec::new();
    for p in positions {
        bin.extend_from_slice(&p.to_le_bytes());
    }
    let idx_offset = bin.len(); // 36
    for i in indices {
        bin.extend_from_slice(&i.to_le_bytes());
    }
    let bin_len_unpadded = bin.len(); // 42
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let json = format!(
        concat!(
            r#"{{"asset":{{"version":"2.0"}},"scene":0,"scenes":[{{"nodes":[0]}}],"#,
            r#""nodes":[{{"mesh":0}}],"#,
            r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}],"#,
            r#""accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}},"#,
            r#"{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"#,
            r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},"#,
            r#"{{"buffer":0,"byteOffset":{idx},"byteLength":6}}],"#,
            r#""buffers":[{{"byteLength":{blen}}}]}}"#
        ),
        idx = idx_offset,
        blen = bin_len_unpadded
    );
    let mut json_bytes = json.into_bytes();
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut glb = Vec::new();
    glb.extend_from_slice(&0x4654_6C67u32.to_le_bytes()); // 'glTF'
    glb.extend_from_slice(&2u32.to_le_bytes()); // version
    glb.extend_from_slice(&(total as u32).to_le_bytes());
    glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x4E4F_534Au32.to_le_bytes()); // 'JSON'
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    glb.extend_from_slice(&0x004E_4942u32.to_le_bytes()); // 'BIN\0'
    glb.extend_from_slice(&bin);
    glb
}

#[test]
fn gltf_glb_loads_real_geometry() {
    let glb = build_triangle_glb();
    let arr = glb.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",");
    let app_js = format!(
        concat!(
            "let scene = createScene();\n",
            "let cam = perspectiveCamera(60.0, 0.1, 100.0);\n",
            "cam.setPosition(0.0, 0.0, 3.0); cam.lookAt(0.0, 0.0, 0.0);\n",
            "useScene(scene); useCamera(cam);\n",
            "scene.add(directionalLight([1.0, 1.0, 1.0], 1.0, v3(0.0, 0.0, -1.0)));\n",
            "let model = loadGLB([{arr}]);\n",
            "scene.add(model);\n",
            "startGame();\n"
        ),
        arr = arr
    );
    let program = format!("{}\n{}", elpa_game3d::module_js(), app_js);
    let mut app = instance_for(&program);
    app.start();
    assert!(app.trap_reason().is_none(), "no trap loading GLB: {:?}", app.trap_reason());

    // The loaded mesh's interleaved vertex buffer: 3 verts × 8 floats.
    let frame = app.last_frame().expect("frame");
    let vbo = frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id.starts_with("g3d.vbo.") => b.data_f32.clone(),
            _ => None,
        })
        .expect("loaded vertex buffer present");
    assert_eq!(vbo.len(), 24, "3 vertices interleaved as 8 floats each");

    // Positions decoded from the BIN chunk land at offsets 0, 8, 16 (pos.xyz).
    let near = |a: f32, b: f32| (a - b).abs() < 1e-5;
    assert!(near(vbo[0], 0.0) && near(vbo[1], 0.0) && near(vbo[2], 0.0), "v0 = (0,0,0)");
    assert!(near(vbo[8], 1.0) && near(vbo[9], 0.0) && near(vbo[10], 0.0), "v1 = (1,0,0)");
    assert!(near(vbo[16], 0.0) && near(vbo[17], 1.0) && near(vbo[18], 0.0), "v2 = (0,1,0)");

    // The triangle draws as one indexed draw of 3 indices.
    let rp = render_pass(&app);
    let n = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::DrawIndexed { index_count: 3, .. }))
        .count();
    assert_eq!(n, 1, "the loaded triangle is one 3-index draw");
}

// ---- physics / collision ------------------------------------------------------

#[test]
fn raycast_and_aabb_collision() {
    // A program that answers two physics queries and reports each via `log`:
    //  * a ray from +Z toward the origin must hit a box there;
    //  * two overlapping unit boxes must collide on their world AABBs.
    let app_js = concat!(
        "let scene = createScene();\n",
        "let cam = perspectiveCamera(60.0, 0.1, 100.0);\n",
        "cam.setPosition(0.0, 0.0, 5.0); cam.lookAt(0.0, 0.0, 0.0);\n",
        "useScene(scene); useCamera(cam);\n",
        "scene.add(directionalLight([1.0, 1.0, 1.0], 1.0, v3(0.0, 0.0, -1.0)));\n",
        "let target = boxMesh(2.0, 2.0, 2.0, { color: [1.0, 0.2, 0.2, 1.0] });\n",
        "scene.add(target);\n",
        "let a = boxMesh(1.0, 1.0, 1.0, {}); a.setPosition(0.0, 0.0, 0.0);\n",
        "let b = boxMesh(1.0, 1.0, 1.0, {}); b.setPosition(0.4, 0.0, 0.0);\n",
        "scene.add(a); scene.add(b);\n",
        "scene.updateWorld(0);\n",
        "let rc = raycaster(v3(0.0, 0.0, 5.0), v3(0.0, 0.0, -1.0));\n",
        "let hit = rc.intersectFirst(scene);\n",
        "if (hit != 0) { askHost(\"log\", [\"RAY_HIT\"]); }\n",
        "if (meshesCollideAABB(a, b) > 0.5) { askHost(\"log\", [\"AABB_HIT\"]); }\n",
        "startGame();\n"
    );
    let program = format!("{}\n{}", elpa_game3d::module_js(), app_js);
    let mut app = instance_for(&program);
    app.start();
    assert!(app.trap_reason().is_none(), "no trap in physics queries: {:?}", app.trap_reason());

    let log = app.take_log().join("\n");
    assert!(log.contains("RAY_HIT"), "ray cast hit the box (log: {log})");
    assert!(log.contains("AABB_HIT"), "overlapping boxes collided (log: {log})");
}
