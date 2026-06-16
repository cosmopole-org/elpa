//! App-controlled fonts: an Elpa program can tell the runtime to use a different
//! main font — fetched by URL through the host's `NetProvider`, or loaded from a
//! storage path — via the SDK helpers `useFont` / `useFontFromPath`. Proven here
//! end to end on a headless VM: the helper triggers a `text.atlas` rebuild from
//! the chosen source and the rendered glyphs change accordingly.

use elpa::protocol::{EncoderCommand, ResourceDesc};
use elpa::{ClosureNet, Elpa, EnvToggles, HeadlessBackend, NetResponse, SurfaceInfo};

// A real TrueType font to stand in for the "downloaded"/"stored" one (distinct
// metrics from the bundled regular face, so the rendered text measurably moves).
const CUSTOM_TTF: &[u8] = include_bytes!("../../../crates/elpa-runtime/assets/fonts/LiberationSans-Bold.ttf");

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

// The base64 of the uploaded font atlas this frame (proves which atlas is live).
fn atlas_b64(app: &Elpa<HeadlessBackend>) -> Option<String> {
    let frame = app.last_frame().expect("a frame");
    frame.commands.iter().find_map(|c| match c {
        EncoderCommand::WriteTexture { data_b64, .. } => Some(data_b64.clone()),
        _ => None,
    })
}

fn app_with(body_call: &str) -> String {
    format!(
        "{}\n let App = defineComponent(function(props, update) {{ return Scaffold({{ appBar: AppBar({{ title: \"FONT\" }}), body: Text(\"Hello World\", {{ size: \"title\" }}) }}); }}); {} runApp(App);",
        elpa_material::MODULE_JS, body_call
    )
}

#[test]
fn use_font_by_url_changes_the_rendered_text() {
    // Baseline with the bundled font.
    let mut base = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(800, 600, 1.0), &app_with(""))
        .expect("compiles");
    base.start();
    let base_atlas = atlas_b64(&base).expect("bundled atlas uploaded");
    let base_inst = instances(&base);

    // Same app, but it asks the runtime to download a font by URL.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFont(\"https://fonts.test/Custom.ttf\");"),
    )
    .expect("compiles");
    // Grant network and wire a provider that returns the font bytes (binary).
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.env_mut().set_net(Box::new(ClosureNet(|_req| {
        Ok(NetResponse { status: 200, body: String::new(), bytes: Some(CUSTOM_TTF.to_vec()) })
    })));
    app.start();

    assert!(app.trap_reason().is_none(), "no trap using a URL font: {:?}", app.trap_reason());
    let url_atlas = atlas_b64(&app).expect("custom atlas uploaded");
    assert_ne!(url_atlas, base_atlas, "the downloaded font produced a different atlas");
    assert_ne!(instances(&app), base_inst, "the downloaded font changed the rendered text");
}

#[test]
fn use_font_from_storage_path_changes_the_rendered_text() {
    let mut base = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(800, 600, 1.0), &app_with(""))
        .expect("compiles");
    base.start();
    let base_atlas = atlas_b64(&base).expect("bundled atlas");

    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFontFromPath(\"/fonts/app.ttf\");"),
    )
    .expect("compiles");
    // Stage the font in the fabricated filesystem (binary-safe) before start.
    app.env_mut().fs_mut().write("/fonts/app.ttf", CUSTOM_TTF).expect("stage font");
    app.start();

    assert!(app.trap_reason().is_none(), "no trap using a path font: {:?}", app.trap_reason());
    assert_ne!(atlas_b64(&app).expect("custom atlas"), base_atlas, "the stored font produced a different atlas");
}

#[test]
fn missing_font_source_falls_back_to_bundled() {
    // A URL with no network provisioned must not crash — it falls back to bundled.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFont(\"https://unreachable.test/x.ttf\");"),
    )
    .expect("compiles");
    app.start(); // network is off by default → host falls back to the bundled font
    assert!(app.trap_reason().is_none(), "graceful fallback, no trap");
    assert!(atlas_b64(&app).is_some(), "still renders text with the bundled font");
}
