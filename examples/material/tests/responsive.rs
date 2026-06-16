//! True responsiveness: the Material kit adapts its layout to the device form
//! factor (Material window size classes) rather than rendering one proportional
//! design scaled up and down. Proven on a real headless VM by laying the same
//! gallery out across surfaces that differ *only* in size class and confirming the
//! result is not a uniform rescale — phones get larger type, taller chrome and a
//! reflowed grid; a wide window gets a centred reading column.

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, SurfaceInfo};

fn instances(app: &Elpa<HeadlessBackend>) -> Vec<f32> {
    let frame = app.last_frame().expect("a frame was submitted");
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

fn render(w: u32, h: u32, dpr: f64) -> Vec<f32> {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(w, h, dpr),
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles");
    app.start();
    assert!(app.trap_reason().is_none(), "no trap rendering {}x{}@{}: {:?}", w, h, dpr, app.trap_reason());
    instances(&app)
}

// Normalise an instance buffer's per-quad geometry (cx, cy, half-w, half-h — the
// first four of each 16-float instance) into viewport fractions, so two frames
// that are pure proportional rescales of each other compare *equal*. Any
// difference therefore reflects a real layout adaptation, not just a size change.
fn normalized_geometry(inst: &[f32], vw: f32, vh: f32) -> Vec<i32> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= inst.len() {
        // Round to 1e-3 of the viewport so float noise doesn't masquerade as change.
        out.push((inst[i] / vw * 1000.0).round() as i32);
        out.push((inst[i + 1] / vh * 1000.0).round() as i32);
        out.push((inst[i + 2] / vw * 1000.0).round() as i32);
        out.push((inst[i + 3] / vh * 1000.0).round() as i32);
        i += 16;
    }
    out
}

#[test]
fn gallery_layout_is_not_a_uniform_rescale_across_size_classes() {
    // Two surfaces with the *same* logical aspect ratio, one an exact 2× scale of
    // the other, but landing in different size classes: 500dp wide is compact (a
    // phone), 1000dp wide is expanded (a desktop). A purely proportional layout
    // would yield identical viewport-normalised geometry; the responsive kit does
    // not — different type scale, chrome density and a reflowed grid.
    let compact = render(500, 1083, 1.0); // logical 500 wide  -> compact
    let expanded = render(1000, 2166, 1.0); // logical 1000 wide -> expanded

    let cn = normalized_geometry(&compact, 500.0, 1083.0);
    let en = normalized_geometry(&expanded, 1000.0, 2166.0);
    assert_ne!(
        cn, en,
        "compact and expanded must differ beyond a uniform rescale (responsive layout)"
    );
}

#[test]
fn high_dpi_phone_renders_cleanly() {
    // A real high-DPI phone: logical 390×844 at devicePixelRatio 3 (physical
    // 1170×2532) — exercises the compact code paths (type scale, chrome density,
    // grid reflow) and the logical-pixel breakpoint, and must render without
    // trapping. (A previous proportional design would shrink to a zoomed-out
    // desktop here; now it adapts.)
    let phone = render(1170, 2532, 3.0);
    assert!(!phone.is_empty(), "the phone surface still paints widgets");
    assert_eq!(phone.len() % 16, 0, "whole instances");
}
