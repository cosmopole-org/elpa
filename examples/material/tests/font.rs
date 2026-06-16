//! App-controlled fonts: an Elpa program can tell the runtime to use a different
//! main font — fetched by URL through the host's `NetProvider`, or loaded from a
//! storage path — via the SDK helpers `useFont` / `useFontFromPath`. Proven here
//! end to end on a headless VM: the helper triggers a `text.atlas` rebuild from
//! the chosen source and the rendered glyphs change accordingly.
//!
//! The runtime no longer bundles a font: the *default* font is itself downloaded
//! through the network provider as the runtime loads its first frame. These tests
//! serve real TrueType fixtures from a `ClosureNet`/storage instead of hitting the
//! network, and prove that with no provider at all text still renders (the kit's
//! built-in stroke-vector fallback) rather than trapping.

use elpa::protocol::{EncoderCommand, ResourceDesc};
use elpa::{ClosureNet, Elpa, EnvToggles, HeadlessBackend, NetResponse, SurfaceInfo};

// Two real TrueType faces with distinct metrics: one stands in for the runtime's
// *downloaded default* font, the other for an app-chosen custom font — so a swap
// measurably moves the rendered text.
const DEFAULT_TTF: &[u8] = include_bytes!("../../../crates/elpa-runtime/tests/fonts/LiberationSans-Regular.ttf");
const CUSTOM_TTF: &[u8] = include_bytes!("../../../crates/elpa-runtime/tests/fonts/LiberationSans-Bold.ttf");

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame");
    let order = ["body", "chrome", "drawer", "overlay", "root"];
    let mut out = Vec::new();
    for scope in order {
        let id = format!("elpa.layer.{scope}.inst");
        if let Some(d) = frame.resources.iter().find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == id => b.data_f32.clone(),
            _ => None,
        }) {
            out.extend(d);
        }
    }
    assert!(!out.is_empty(), "at least one scope instance buffer present");
    out
}

// The base64 of the uploaded font atlas this frame (proves which atlas is live).
fn atlas_b64(app: &Elpa<HeadlessBackend>) -> Option<String> {
    let frame = app.last_frame().expect("a frame");
    frame.commands.iter().find_map(|c| match c {
        EncoderCommand::WriteTexture { data_b64, .. } => Some(data_b64.clone()),
        _ => None,
    })
}

// Grant network and wire a provider that returns `bytes` for any request — so the
// runtime can "download" a font (the default or a custom URL) offline in tests.
fn serve_font(app: &mut Elpa<HeadlessBackend>, bytes: &'static [u8]) {
    app.env_mut().set_toggles(EnvToggles::all_on());
    app.env_mut().set_net(Box::new(ClosureNet(move |_req| {
        Ok(NetResponse { status: 200, body: String::new(), bytes: Some(bytes.to_vec()) })
    })));
}

fn app_with(body_call: &str) -> String {
    format!(
        "{}\n let App = defineComponent(function(props, update) {{ return Scaffold({{ appBar: AppBar({{ title: \"FONT\" }}), body: Text(\"Hello World\", {{ size: \"title\" }}) }}); }}); {} runApp(App);",
        elpa_material::MODULE_JS, body_call
    )
}

#[test]
fn use_font_by_url_changes_the_rendered_text() {
    // Baseline with the downloaded default font.
    let mut base = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(800, 600, 1.0), &app_with(""))
        .expect("compiles");
    serve_font(&mut base, DEFAULT_TTF);
    base.start();
    let base_atlas = atlas_b64(&base).expect("default atlas uploaded");
    let base_inst = instances(&base);

    // Same app, but it asks the runtime to download a *different* font by URL.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFont(\"https://fonts.test/Custom.ttf\");"),
    )
    .expect("compiles");
    serve_font(&mut app, CUSTOM_TTF);
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
    serve_font(&mut base, DEFAULT_TTF);
    base.start();
    let base_atlas = atlas_b64(&base).expect("default atlas");

    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFontFromPath(\"/fonts/app.ttf\");"),
    )
    .expect("compiles");
    // Stage the font in the fabricated filesystem (binary-safe) before start; the
    // font comes from storage, so no network is needed for this app.
    app.env_mut().fs_mut().write("/fonts/app.ttf", CUSTOM_TTF).expect("stage font");
    app.start();

    assert!(app.trap_reason().is_none(), "no trap using a path font: {:?}", app.trap_reason());
    assert_ne!(atlas_b64(&app).expect("custom atlas"), base_atlas, "the stored font produced a different atlas");
}

#[test]
fn no_font_source_and_no_network_degrades_to_vector_text() {
    // A URL with no network provisioned must not crash. There is no bundled font
    // to fall back to, so no atlas is built — the kit renders text with its
    // built-in stroke-vector fallback instead.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(800, 600, 1.0),
        &app_with("useFont(\"https://unreachable.test/x.ttf\");"),
    )
    .expect("compiles");
    app.start(); // network is off by default → no custom font and no default font
    assert!(app.trap_reason().is_none(), "graceful fallback, no trap");
    assert!(atlas_b64(&app).is_none(), "no font atlas without a network provider");
    assert!(!instances(&app).is_empty(), "still renders text via the vector fallback");
}
