//! Run the *graphics showcase* (JavaScript) on a real (headless) Elpa instance —
//! the proof for the painting layer added in `33-graphics.js`. It checks that the
//! whole dart:ui surface mounts and paints without traps: a full CustomPaint /
//! Canvas scene (lines, rects, rrects, circles, ovals, arcs, paths, points,
//! shadows, gradients, transforms, text), gradient-filled containers, the
//! Opacity / ColorFiltered / Transform / RotatedBox effect wrappers, and the
//! BackdropFilter frosted glass — whose blur is a genuine multi-pass,
//! offscreen-capture compositor (a render pass into an offscreen texture, then a
//! surface pass that samples it). The kit's two shaders stay valid WGSL.

use elpa::protocol::{EncoderCommand, ResourceDesc};
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 1500, 1.0),
        &elpa_material::graphics_program(),
    )
    .expect("SDK + graphics program compiles")
}

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

/// Every per-frame instance buffer's floats summed (one `elpa.m3.inst`, or — when
/// a backdrop frame uses a different layout — whatever `elpa.m3.inst*` it emits).
fn instance_floats(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .filter_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.clone(),
            _ => None,
        })
        .next()
        .expect("instance buffer present")
}

/// Count the render passes in the last frame, and how many target an offscreen
/// texture (vs. the surface).
fn pass_counts(app: &Elpa<HeadlessBackend>) -> (usize, usize) {
    let frame = app.last_frame().expect("a frame");
    let mut total = 0;
    let mut offscreen = 0;
    for c in &frame.commands {
        if let EncoderCommand::RenderPass(rp) = c {
            total += 1;
            // Offscreen iff the (single) colour attachment targets a texture view.
            let targets_texture = serde_json::to_value(&rp.color_attachments[0].view)
                .ok()
                .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(|s| s == "texture"))
                .unwrap_or(false);
            if targets_texture {
                offscreen += 1;
            }
        }
    }
    (total, offscreen)
}

#[test]
fn graphics_scene_stays_lightweight_and_downsamples_the_blur() {
    // Performance guards. The CustomPaint scene must stay instance-light — a pie
    // arc once emitted a triangle fan *per step* (~432 instances for one arc); now
    // it is one spoke per step. And the BackdropFilter must capture its blur source
    // at reduced resolution (a low-frequency effect doesn't need full res), which
    // cuts the offscreen fill-rate ~4x. Both are what make the tab cheap to scroll.
    let (sw, sh) = (1000u32, 1500u32);
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(sw, sh, 1.0),
        &elpa_material::graphics_program(),
    )
    .unwrap();
    app.start();

    let instances = instance_floats(&app).len() / 16;
    assert!(
        instances < 700,
        "the graphics scene must stay lightweight (got {instances} instances)"
    );

    // The offscreen blur-capture texture is downsampled (smaller than the surface).
    let scene = app
        .last_frame()
        .unwrap()
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Texture(t) if t.id.starts_with("elpa.m3.bd.scene") => Some(t.clone()),
            _ => None,
        })
        .expect("the offscreen scene texture is declared");
    assert!(
        scene.size.width < sw && scene.size.height < sh,
        "the blur source is captured at reduced resolution ({}x{} vs surface {sw}x{sh})",
        scene.size.width,
        scene.size.height
    );
    assert!(app.trap_reason().is_none());
    assert!(app.take_log().is_empty());
}

#[test]
fn graphics_shaders_are_valid_wgsl() {
    // The painting layer adds no new pipelines — gradients, transforms and the
    // canvas are all the rounded-rect SDF primitive; the backdrop reuses the image
    // pipeline. So the kit still ships exactly the SDF + image shaders, both valid.
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_material::module_js())).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert_eq!(shaders.len(), 2, "graphics layer adds no shader: still SDF + image");
    for src in &shaders {
        let module = naga::front::wgsl::parse_str(src)
            .unwrap_or_else(|e| panic!("WGSL parse failed: {}", e.emit_to_string(src)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .expect("WGSL validation failed");
    }
}

#[test]
fn graphics_app_starts_clean() {
    let mut app = instance();
    app.start();
    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors painting the graphics scene");
    // The scene is instance-heavy (the canvas + gradients alone are hundreds).
    assert!(
        instance_floats(&app).len() / 16 > 200,
        "the canvas + gradients emit many instances"
    );
}

#[test]
fn backdrop_filter_is_a_multipass_offscreen_capture() {
    // The frosted-glass BackdropFilter must turn the frame into a real multi-pass:
    // one render pass that targets an offscreen texture (capturing the content
    // behind the panel) and one that targets the surface (compositing the blurred
    // copy back). The offscreen scene texture is a sampleable render target.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    let (total, offscreen) = pass_counts(&app);
    assert!(total >= 2, "backdrop frame has at least two render passes (got {total})");
    assert_eq!(offscreen, 1, "exactly one pass renders into the offscreen scene texture");

    let frame = app.last_frame().unwrap();
    let scene = frame.resources.iter().find(|r| r.id().starts_with("elpa.m3.bd.scene"));
    assert!(scene.is_some(), "the offscreen scene texture resource is declared");
    let scene_fmt = match scene.unwrap() {
        ResourceDesc::Texture(t) => {
            assert!(
                t.usage.iter().any(|u| u == "RENDER_ATTACHMENT"),
                "scene texture is a render target"
            );
            assert!(
                t.usage.iter().any(|u| u == "TEXTURE_BINDING"),
                "scene texture is sampleable (so the blur pass can read it)"
            );
            t.format.clone()
        }
        _ => panic!("elpa.m3.bd.scene* should be a texture"),
    };
    // The offscreen scene is a render target for the SDF + image pipelines, so its
    // texture format MUST equal their colour-target format — a mismatch is a wgpu
    // device error that hangs a real backend (the headless backend can't catch it,
    // so assert the invariant here).
    let pipe_fmt = frame
        .resources
        .iter()
        .find_map(|r| {
            let v = serde_json::to_value(r).ok()?;
            if v.get("kind")?.as_str()? != "renderPipeline" {
                return None;
            }
            if v.get("id")?.as_str()? != "elpa.m3.pipe" {
                return None;
            }
            v.get("fragment")?
                .get("targets")?
                .get(0)?
                .get("format")?
                .as_str()
                .map(|s| s.to_string())
        })
        .expect("the SDF pipeline declares a colour-target format");
    assert_eq!(
        scene_fmt, pipe_fmt,
        "offscreen render-target format must match the pipeline colour target"
    );
    assert!(app.trap_reason().is_none(), "no trap building the backdrop frame");
    assert!(app.take_log().is_empty(), "no host errors building the backdrop frame");
}

#[test]
fn effect_keys_change_the_render() {
    // 'o' steps Opacity, 'r' rotates the Transform, 'b' grows the backdrop blur,
    // 'd' cross-fades the theme — each must change the emitted instances/commands.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    for key in ["o", "r", "b"] {
        let before = instance_floats(&app);
        app.send_event(&InputEvent::KeyDown { key: key.into() });
        let after = instance_floats(&app);
        assert!(after != before, "key '{key}' changed the rendered scene");
        assert!(app.trap_reason().is_none(), "no trap handling '{key}'");
    }
    assert!(app.take_log().is_empty(), "no host errors driving the effects");
}

#[test]
fn animates_and_resizes_cleanly() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // The theme cross-fade animates over several frames; each re-renders (and the
    // backdrop multi-pass re-records) without traps or host errors.
    app.send_event(&InputEvent::KeyDown { key: "d".into() });
    let mut presented = false;
    for _ in 0..10 {
        app.animate(16.0);
        presented |= app.last_stats().presented;
    }
    assert!(presented, "the theme animation re-renders the graphics scene");
    assert!(app.trap_reason().is_none(), "no trap animating");

    app.resize(1400, 900, 1.0);
    assert!(app.last_stats().presented, "resize forces a fresh present");
    assert!(app.trap_reason().is_none(), "no trap on resize");
    assert!(app.take_log().is_empty(), "no host errors animating/resizing");
}
