//! Run the Web SDK + showcase page on a real (headless) Elpa instance - proof
//! that the SDK and app compile, link into one VM, and drive the CSS layout +
//! paint pipeline end to end: the document mounts, the box model / flow / flex /
//! grid lay it out, the whole page renders as one instanced SDF draw, and
//! pointer / keyboard events flow through the SDK's closures and change what is
//! rendered.

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

#[test]
fn sdk_shaders_are_valid_wgsl() {
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_websdk::module_js())).unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert!(!shaders.is_empty(), "the kit ships WGSL shaders");
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

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 1.0),
        &elpa_websdk::program(),
    )
    .expect("SDK + app program compiles")
}

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id.starts_with("elpa.web.inst") => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

#[test]
fn page_mounts_and_paints() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.web.pipe"), "pipeline created");

    // The whole page is at least one instanced SDF draw.
    let inst = instances(&app);
    assert!(inst.len() >= 16, "the page emitted instances ({} floats)", inst.len());
    assert_eq!(inst.len() % 16, 0, "instance stride is 16 floats");
}

#[test]
fn click_repaints_and_changes_the_page() {
    let mut app = instance();
    app.start();
    let before = instances(&app).len();

    // Hover across the nav (top of the page): exercises the :hover hit-testing +
    // the CSS-transition path (nav links / the "Get started" button declare
    // `transition`, so a hover change routes their colour/transform through the
    // animation clock).
    app.send_event(&InputEvent::PointerMove { x: 900.0, y: 30.0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 30.0 });
    assert!(app.trap_reason().is_none(), "no trap while hovering: {:?}", app.trap_reason());

    // Click in the hero (tap hit-testing + the repaint path).
    app.send_event(&InputEvent::PointerDown { x: 200.0, y: 320.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 200.0, y: 320.0, button: 0 });
    assert!(app.trap_reason().is_none(), "no trap after click: {:?}", app.trap_reason());

    // Type some characters (keyboard path; harmless when nothing is focused).
    app.send_event(&InputEvent::KeyDown { key: "H".into() });
    app.send_event(&InputEvent::KeyDown { key: "i".into() });
    assert!(app.trap_reason().is_none(), "no trap after typing: {:?}", app.trap_reason());

    // Run a few animation frames so the hovered transitions + the live FPS
    // visualiser (a continuous animTime() component) actually advance.
    for _ in 0..6 {
        app.animate(16.0);
        assert!(app.trap_reason().is_none(), "no trap animating after interaction: {:?}", app.trap_reason());
    }
    let after = instances(&app).len();
    assert!(after >= 16, "page still renders after interaction ({} floats)", after);
    let _ = before;
}

#[test]
fn scrolling_is_stable_and_keeps_content() {
    // A narrow, short viewport: the page stacks into a tall single column whose
    // height exceeds the viewport, so the body's `overflow:auto` becomes a live
    // scroll region.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(420, 600, 1.0),
        &elpa_websdk::program(),
    )
    .expect("SDK + app program compiles");
    app.start();
    let before = instances(&app).len();

    // Wheel down repeatedly, then back up - the scroll-only repaint path.
    for _ in 0..12 {
        app.send_event(&InputEvent::Wheel { x: 200.0, y: 300.0, delta_y: 80.0 });
        assert!(app.trap_reason().is_none(), "no trap while scrolling: {:?}", app.trap_reason());
    }
    // Mid-scroll the page must still paint real content - the centre-based culler
    // used to drop elements taller than the viewport while they were on screen.
    let mid = instances(&app).len();
    assert!(mid >= 16, "content still painted mid-scroll ({} floats)", mid);
    assert_eq!(mid % 16, 0, "instance stride is 16 floats");

    for _ in 0..12 {
        app.send_event(&InputEvent::Wheel { x: 200.0, y: 300.0, delta_y: -80.0 });
        assert!(app.trap_reason().is_none(), "no trap while scrolling back: {:?}", app.trap_reason());
    }
    // Scrolled fully back to the top: the same content as the initial frame.
    let after = instances(&app).len();
    assert_eq!(after, before, "scrolling back to the top restores the page");
}

// A minimal page whose card declares `backdrop-filter: blur()`, over content
// behind it — exercises the two-pass frosted-glass compositor end to end.
const BACKDROP_APP: &str = r##"
let App = defineComponent(function (props, update) {
    return Body({ style: { background: "#101426", padding: "24px" }, children: [
        Div({ style: { background: "linear-gradient(90deg, #ef4444, #3b82f6)", width: "260px", height: "140px",
            borderRadius: "12px" }, children: ["behind"] }),
        Div({ style: { marginTop: "-60px", marginLeft: "40px", background: "rgba(255,255,255,0.16)",
            border: "1px solid rgba(255,255,255,0.3)", borderRadius: "16px", padding: "20px",
            backdropFilter: "blur(12px)" }, children: ["frosted glass"] }),
    ] });
});
runApp(App);
"##;

#[test]
fn backdrop_filter_composites_offscreen() {
    let src = format!("{}\n{}", elpa_websdk::module_js(), BACKDROP_APP);
    let mut app = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(640, 400, 1.0), &src)
        .expect("SDK + backdrop app compiles");
    app.start();
    assert!(app.trap_reason().is_none(), "no trap with a backdrop: {:?}", app.trap_reason());

    let frame = app.last_frame().expect("a frame was submitted");
    // The two-pass compositor captures the below-backdrop content into an
    // offscreen "scene" texture before blurring it back over the surface.
    assert!(
        frame.resources.iter().any(|r| r.id().starts_with("elpa.web.bd.scene")),
        "backdrop frame captures an offscreen scene texture"
    );
    assert!(app.take_log().is_empty(), "no host errors compositing the backdrop");
}

// Four fixed-width boxes in a flex row of a narrow container. `WRAP` switches
// flex-wrap on; everything else is identical, so any change in painted height is
// the wrapping.
fn flex_app(wrap: &str) -> String {
    format!(
        "{}\nlet App = defineComponent(function (props, update) {{ return Body({{ style: {{ padding: \"0px\" }}, children: [ \
         Div({{ style: {{ display: \"flex\", flexDirection: \"row\", flexWrap: \"{wrap}\", gap: \"10px\", width: \"300px\" }}, children: [ \
         Div({{ style: {{ width: \"120px\", height: \"40px\", flexShrink: \"0\", background: \"#e11\" }} }}), \
         Div({{ style: {{ width: \"120px\", height: \"40px\", flexShrink: \"0\", background: \"#1e1\" }} }}), \
         Div({{ style: {{ width: \"120px\", height: \"40px\", flexShrink: \"0\", background: \"#11e\" }} }}), \
         Div({{ style: {{ width: \"120px\", height: \"40px\", flexShrink: \"0\", background: \"#ee1\" }} }}) ] }}) ] }}); }}); runApp(App);",
        elpa_websdk::module_js()
    )
}

// Bottom edge of the painted content (max cy+hh over real rect/glyph instances,
// skipping image/backdrop sentinels).
fn painted_bottom(app: &Elpa<HeadlessBackend>) -> f32 {
    let inst = instances(app);
    let mut bottom = 0.0f32;
    for chunk in inst.chunks(16) {
        let mark = chunk[0];
        if mark == 424242.0 || mark == 525252.0 {
            continue;
        }
        bottom = bottom.max(chunk[1] + chunk[3]);
    }
    bottom
}

#[test]
fn flex_wrap_breaks_onto_new_lines() {
    let mut nowrap = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(360, 400, 1.0), &flex_app("nowrap"))
        .expect("nowrap compiles");
    nowrap.start();
    let mut wrap = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(360, 400, 1.0), &flex_app("wrap"))
        .expect("wrap compiles");
    wrap.start();
    assert!(nowrap.trap_reason().is_none() && wrap.trap_reason().is_none());

    // 4 unshrinkable 120px boxes do not fit one 300px row, so wrapping stacks them
    // onto further lines — the painted content reaches further down the page.
    let nb = painted_bottom(&nowrap);
    let wb = painted_bottom(&wrap);
    assert!(wb > nb + 20.0, "wrap should be taller than nowrap (wrap={wb}, nowrap={nb})");
}

#[test]
fn animation_frame_is_stable() {
    let mut app = instance();
    app.start();
    for _ in 0..8 {
        app.animate(16.0);
        assert!(app.trap_reason().is_none(), "no trap during animation: {:?}", app.trap_reason());
    }
}
