//! Safe-area handling: the Material kit keeps its chrome clear of the platform's
//! reserved regions (the status bar at the top, the navigation / gesture bar at
//! the bottom, display cutouts on the sides) instead of drawing under them. The
//! host reports those regions through `SurfaceInfo`'s insets; this proves that
//! information reaches the JavaScript layout and actually moves pixels — the same
//! mechanism the Android build uses to dodge the status bar.

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, Insets, SurfaceInfo};

/// The per-quad instance buffer the kit submits each frame (16 floats per quad,
/// the first four being cx, cy, half-w, half-h).
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

/// Render the gallery on a phone-sized surface with the given safe-area insets
/// (physical px). Insets are reported the same way the native host does.
fn render_with_insets(insets: Insets) -> Vec<f32> {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1080, 2340, 3.0).with_insets(insets),
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles");
    app.start();
    assert!(app.trap_reason().is_none(), "no trap: {:?}", app.trap_reason());
    instances(&app)
}

#[test]
fn status_bar_inset_shifts_the_layout() {
    // A typical phone status bar (~108 physical px at dpr 3 ≈ 36 dp) plus a
    // gesture bar at the bottom. The chrome must lay out differently than with no
    // insets — if the value were ignored the two frames would be identical.
    let none = render_with_insets(Insets::ZERO);
    let inset = render_with_insets(Insets::new(108.0, 0.0, 72.0, 0.0));

    assert!(!none.is_empty() && !inset.is_empty(), "both frames paint widgets");
    assert_ne!(none, inset, "safe-area insets must move the chrome, not be ignored");
}

#[test]
fn zero_insets_match_the_unset_default() {
    // Explicit all-zero insets are indistinguishable from never setting any, so
    // desktop / web (which report no insets) render byte-for-byte as before.
    let unset = render_with_insets(Insets::ZERO);
    let explicit_zero = render_with_insets(Insets::new(0.0, 0.0, 0.0, 0.0));
    assert_eq!(unset, explicit_zero);
}

#[test]
fn updating_insets_at_runtime_relayouts() {
    // Rotation / system-bar changes arrive after start via set_safe_area_insets;
    // the app must re-fit (the kit's onResize repaints) rather than stay stale.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1080, 2340, 3.0),
        &elpa_material::gallery_program(),
    )
    .expect("compiles");
    app.start();
    let before = instances(&app);

    app.set_safe_area_insets(108.0, 0.0, 72.0, 0.0);
    assert!(app.trap_reason().is_none(), "no trap after inset update");
    let after = instances(&app);

    assert_ne!(before, after, "reporting insets at runtime re-fits the chrome");
}
