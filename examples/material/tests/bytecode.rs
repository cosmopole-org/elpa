//! Prove the **build-time bytecode** path: the Material programs compiled to VM
//! bytecode (as the `build_bytecode` tool does, and as the committed
//! `assets/*.bc` the web/native examples embed) load and run on a headless Elpa
//! instance exactly like the run-time JS path — and that the surface color
//! format is resolved dynamically from `gpu.surfaceInfo` instead of being patched
//! into the source.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
use elpa::{Elpa, HeadlessBackend, SurfaceInfo};

/// The committed gallery bytecode the web and native examples embed.
const GALLERY_BC: &[u8] = include_bytes!("../assets/gallery.bc");

fn surface() -> SurfaceInfo {
    SurfaceInfo::new(900, 1400, 1.0)
}

/// The whole-UI instance buffer (`elpa.m3.inst`) from the most recent frame.
fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

/// The color-target format of the SDF render pipeline in the latest frame.
fn pipeline_format(app: &Elpa<HeadlessBackend>) -> String {
    let frame = app.last_frame().expect("a frame");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::RenderPipeline(p) if p.id == "elpa.m3.pipe" => {
                p.fragment.as_ref().map(|f| f.targets[0].format.clone())
            }
            _ => None,
        })
        .expect("SDF pipeline present")
}

#[test]
fn committed_gallery_bytecode_loads_and_draws() {
    // The exact asset the examples ship must load through `new_from_bytecode` and
    // paint a first frame with no front-end compile and no VM trap.
    let mut app = Elpa::new_from_bytecode(HeadlessBackend::default(), surface(), GALLERY_BC.to_vec())
        .expect("committed gallery bytecode loads");
    app.start();

    assert!(app.last_stats().presented, "first frame presented from bytecode");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .expect("a render pass");
    let draws = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::Draw { .. }))
        .count();
    assert_eq!(draws, 1, "one instanced draw for the whole UI");
}

#[test]
fn bytecode_path_matches_js_path() {
    // Compiling a program to bytecode and loading it must be behaviourally
    // identical to compiling the same JS at run time: same first frame down to
    // the per-instance floats.
    let js = elpa_material::program();
    let mut from_js =
        Elpa::new_from_js(HeadlessBackend::default(), surface(), &js).expect("JS compiles");
    let bytecode = elpian_vm::api::compile_js_to_bytecode(&js).expect("JS lowers to bytecode");
    let mut from_bc = Elpa::new_from_bytecode(HeadlessBackend::default(), surface(), bytecode)
        .expect("bytecode loads");

    from_js.start();
    from_bc.start();

    assert!(from_bc.trap_reason().is_none());
    assert_eq!(
        instances(&from_js),
        instances(&from_bc),
        "bytecode and JS front-ends produce the identical first frame"
    );
}

#[test]
fn surface_format_is_resolved_dynamically() {
    // The SDK no longer hard-codes (nor has the host patch) the pipeline color
    // format: it reads it from `gpu.surfaceInfo`. The headless backend reports
    // the default `bgra8unorm`, so the pipeline target must come out as that —
    // proving the surfaceInfo -> SDK -> pipeline plumbing carries the live format.
    let mut app = Elpa::new_from_bytecode(HeadlessBackend::default(), surface(), GALLERY_BC.to_vec())
        .expect("gallery bytecode loads");
    app.start();
    assert_eq!(pipeline_format(&app), "bgra8unorm");
}
