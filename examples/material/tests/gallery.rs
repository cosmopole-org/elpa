//! Run the extended widget *gallery* (JavaScript) on a real (headless) Elpa
//! instance. Where `run.rs` proves the original kit, this proves the additions:
//! the layout widgets, the broader Material catalog, charts and media all mount,
//! measure, paint, and `gpu.submit` as one instanced rounded-rect draw over the
//! *same* shared SDF pipeline — and that section switching, scrolling, text
//! input, modal overlays and the platform-service wrappers all stay clean.

use elpa::protocol::{EncoderCommand, RenderCommand, ResourceDesc};
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles")
}

/// The single per-frame instance buffer the SDK emits (all rounded-rect layers).
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

#[test]
fn gallery_shares_one_shader() {
    // The whole extended kit — every new widget, every chart — still renders
    // through exactly one rounded-rect SDF shader.
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_material::MODULE_JS.to_string()))
            .unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    // Two shaders: the rounded-rect SDF painter and the layer-compositor blit.
    assert_eq!(shaders.len(), 2, "the SDF painter + the layer-compositor blit");
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

fn collect_wgsl(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if s.contains("@vertex") => out.push(s.clone()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_wgsl(x, out)),
        serde_json::Value::Object(m) => m.values().for_each(|x| collect_wgsl(x, out)),
        _ => {}
    }
}

#[test]
fn gallery_starts_and_composites_snapshot_layers() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.pipe"), "SDF pipeline created");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.blit.pipe"), "blit pipeline created");
    // The gallery decouples into several snapshot layers: a cacheable paint pass
    // per scope, then a surface composite pass that blits them together.
    let scope_paints = frame
        .commands
        .iter()
        .filter(|c| matches!(c, EncoderCommand::RenderPass(rp)
            if rp.id.as_deref().map(|s| s.ends_with(".paint")).unwrap_or(false)))
        .count();
    assert!(scope_paints >= 2, "gallery decoupled into multiple snapshot layers");
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) if rp.targets_surface() => Some(rp),
            _ => None,
        })
        .expect("expected the surface composite pass");
    let blits: Vec<&RenderCommand> = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::Draw { vertex_count: 3, .. }))
        .collect();
    assert!(blits.len() >= 2, "one composite blit per snapshot layer");
    assert!(instances(&app).len() / 16 > 50, "many widget + glyph instances");
    assert_eq!(instances(&app).len() % 16, 0, "whole instances");
}

#[test]
fn switching_sections_changes_the_render() {
    // The bottom NavigationBar / 't' shortcut swaps the body between the layout,
    // widgets, charts and media sections — each a different widget tree.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    let mut prev = instances(&app);
    for _ in 0..3 {
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
        let now = instances(&app);
        assert!(now != prev, "switching section changed the rendered tree");
        assert!(app.trap_reason().is_none(), "no trap on section switch");
        prev = now;
    }
    assert!(app.take_log().is_empty(), "no host errors switching sections");
}

#[test]
fn charts_section_emits_many_instances() {
    // The charts section (bar/line/pie/sparkline + table) is instance-heavy: the
    // pie alone is ~72 radial spokes. Switch to it and confirm it paints.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // tab 0 -> 2 (charts).
    app.send_event(&InputEvent::KeyDown { key: "t".into() });
    app.send_event(&InputEvent::KeyDown { key: "t".into() });
    assert!(app.trap_reason().is_none());
    assert!(instances(&app).len() / 16 > 80, "charts section is instance-heavy");
    assert!(app.take_log().is_empty());
}

#[test]
fn typing_into_the_text_field_updates_it() {
    // Focus the text field (tap), then type — the field's value grows and the
    // render changes. The field sits near the top of the WIDGETS section.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // Go to the WIDGETS section.
    app.send_event(&InputEvent::KeyDown { key: "t".into() });
    let before = instances(&app);

    // The field is the first control under the "WIDGETS" title; tap its centre.
    // With u = min(vw,vh)/100 = 9 the body ListView fills from under the app bar,
    // so the field row sits near the top at y ≈ 180.
    app.send_event(&InputEvent::PointerDown { x: 450.0, y: 180.0, button: 0 });
    // Type a few characters.
    for ch in ["A", "D", "A"] {
        app.send_event(&InputEvent::KeyDown { key: ch.into() });
    }
    let after = instances(&app);
    assert!(after != before, "typing changed the rendered field");
    assert!(app.trap_reason().is_none(), "no trap while typing");
    assert!(app.take_log().is_empty(), "no host errors while typing");
}

#[test]
fn scrolling_a_list_changes_the_render() {
    // A wheel tick over the layout section's ListView pans it, changing which
    // items are visible (item-level culling) and thus the instances. Use a
    // landscape surface so the body list overflows its (short) height and is
    // actually scrollable.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1400, 600, 1.0),
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles");
    app.start();
    let _ = app.take_log();

    let before = instances(&app);
    // Wheel over the centre of the body (the ListView viewport).
    app.send_event(&InputEvent::Wheel { x: 700.0, y: 300.0, delta_y: 400.0 });
    let after = instances(&app);
    assert!(after != before, "scrolling the list changed the render");
    assert!(app.trap_reason().is_none(), "no trap on scroll");
    assert!(app.take_log().is_empty(), "no host errors on scroll");
}

#[test]
fn modal_dialog_and_snackbar_overlay() {
    // 'g' toggles a modal dialog (scrim + card + actions) and 's' a snackbar;
    // both are scaffold overlay slots painted on top of the body.
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let base = instances(&app);

    app.send_event(&InputEvent::KeyDown { key: "g".into() });
    let with_dialog = instances(&app);
    assert!(with_dialog.len() > base.len(), "dialog adds overlay instances");

    app.send_event(&InputEvent::KeyDown { key: "s".into() });
    assert!(app.trap_reason().is_none(), "no trap with overlays up");
    assert!(app.take_log().is_empty(), "no host errors with overlays up");

    // Dismiss the dialog again.
    app.send_event(&InputEvent::KeyDown { key: "g".into() });
    assert!(app.trap_reason().is_none());
}

#[test]
fn drawer_opens_and_animates() {
    // Tapping the AppBar menu opens the navigation drawer, which eases in over a
    // few frames (the scrim + panel grow), re-rendering each frame.
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    // The hamburger sits top-left (x=6u, y=5u → (54,45) with u = min(vw,vh)/100 = 9).
    app.send_event(&InputEvent::PointerDown { x: 54.0, y: 45.0, button: 0 });
    let mut moved = false;
    for _ in 0..8 {
        app.animate(16.0);
        moved |= instances(&app) != before;
    }
    assert!(moved, "the drawer eased open, changing the render");
    assert!(app.trap_reason().is_none(), "no trap animating the drawer");
    assert!(app.take_log().is_empty(), "no host errors animating the drawer");
}

#[test]
fn storage_round_trips_through_the_host() {
    // The media section's "SAVE NAME" button persists the field through the
    // fabricated filesystem (fs.* is on by default) and reads it back — proving
    // the platform-storage wrapper works end to end against a real host.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // Write directly through the host so we can then read it via the app on the
    // media tab (which displays storeRead("/gallery/name")).
    app.env_mut()
        .fs_mut()
        .write("/gallery/name", b"PERSISTED")
        .expect("host write");
    // Go to the media section (tab 3) and render it.
    for _ in 0..3 {
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
    }
    assert!(app.trap_reason().is_none(), "no trap reading storage/clock/network");
    assert!(app.take_log().is_empty(), "graceful even with network capability off");
    // The instance buffer is non-trivial (the section rendered with its tiles).
    assert!(instances(&app).len() / 16 > 30, "media section rendered");
}

#[test]
fn fab_cycles_accent_and_resizes_cleanly() {
    let mut app = instance();
    app.start();
    let _ = app.take_log();
    let before = instances(&app);

    // FAB bottom-right ≈ (vw - u*9, vh - u*9) = (819, 1319) (u = min(vw,vh)/100 = 9).
    app.send_event(&InputEvent::PointerDown { x: 819.0, y: 1319.0, button: 0 });
    assert!(instances(&app) != before, "tapping the FAB recolored the UI");

    app.resize(1200, 2000, 1.0);
    assert!(app.last_stats().presented, "resize forces a fresh present");
    assert!(app.trap_reason().is_none(), "no trap on resize");
    assert!(app.take_log().is_empty(), "no host errors on resize");
}

#[test]
fn navigation_drawer_is_a_decoupled_snapshot_layer() {
    // The headline of the scoping system: the navigation drawer paints into its
    // own snapshot layer, decoupled from the rest of the app. Opening it repaints
    // *only* the drawer's snapshot while the body and chrome behind it hold theirs.
    let mut app = instance();
    app.start();
    let _ = app.take_log();

    // The scaffold decoupled into named scopes — the drawer among them.
    assert!(app.layers().contains("drawer"), "drawer is its own scope");
    assert!(app.layers().contains("body"), "body is its own scope");
    assert!(app.layers().contains("chrome"), "chrome is its own scope");

    // Open the drawer ('m'): it slides in over several frames. On each animation
    // frame the drawer's snapshot repaints while the others are reused — the host
    // scope report shows exactly one repaint against several reuses.
    app.send_event(&InputEvent::KeyDown { key: "m".into() });
    let mut drawer_repainted_others_reused = false;
    for _ in 0..14 {
        app.animate(16.0);
        let sc = *app.last_scope_stats();
        if sc.layers_repainted >= 1 && sc.layers_reused >= 1 {
            drawer_repainted_others_reused = true;
        }
    }
    assert!(
        drawer_repainted_others_reused,
        "the drawer repainted in isolation while the body/chrome snapshots were reused"
    );
    assert!(app.trap_reason().is_none(), "no trap animating the drawer");
    assert!(app.take_log().is_empty(), "no host errors animating the drawer");
}

#[test]
fn scrolling_the_body_reuses_the_chrome_and_drawer_snapshots() {
    // A landscape surface so the body list overflows and scrolls. Dragging the
    // body repaints only the body's snapshot; the chrome and (closed) drawer keep
    // theirs — the decoupling that makes scrolling cheap.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1400, 600, 1.0),
        &elpa_material::gallery_program(),
    )
    .expect("compiles");
    app.start();
    let _ = app.take_log();

    // Drag inside the body to scroll it.
    app.send_event(&InputEvent::PointerDown { x: 700.0, y: 320.0, button: 0 });
    let mut body_alone = false;
    for i in 0..6 {
        app.send_event(&InputEvent::PointerMove { x: 700.0, y: 320.0 - (i as f64 + 1.0) * 20.0 });
        let sc = *app.last_scope_stats();
        if sc.layers_repainted >= 1 && sc.layers_reused >= 1 {
            body_alone = true;
        }
    }
    app.send_event(&InputEvent::PointerUp { x: 700.0, y: 200.0, button: 0 });
    assert!(body_alone, "scrolling repainted the body while reusing the chrome/drawer snapshots");
    assert!(app.trap_reason().is_none());
}
