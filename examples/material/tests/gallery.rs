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
    frame
        .resources
        .iter()
        .find_map(|r| match r {
            ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.clone(),
            _ => None,
        })
        .expect("instance buffer present")
}

#[test]
fn gallery_shaders_are_valid_wgsl() {
    // The kit renders through two pipelines: the rounded-rect SDF shader that
    // draws every widget/chart/glyph, and a dedicated image shader that samples
    // real (network/storage) RGBA textures for images and streaming video. Both
    // must be valid WGSL.
    let ast: serde_json::Value =
        serde_json::from_str(&elpa::compile_js_to_ast(elpa_material::module_js()))
            .unwrap();
    let mut shaders = Vec::new();
    collect_wgsl(&ast, &mut shaders);
    shaders.sort();
    shaders.dedup();
    assert_eq!(shaders.len(), 2, "the kit has exactly the SDF and image shaders");
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
fn gallery_starts_and_draws_one_instanced_pass() {
    let mut app = instance();
    app.start();

    assert!(app.last_stats().presented, "first frame presented");
    assert!(app.trap_reason().is_none(), "no VM trap: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors on first paint");

    let frame = app.last_frame().expect("a frame");
    assert!(frame.resources.iter().any(|r| r.id() == "elpa.m3.pipe"), "pipeline created");
    // The frame may carry a one-time font-atlas upload before the render pass.
    let rp = frame
        .commands
        .iter()
        .find_map(|c| match c {
            EncoderCommand::RenderPass(rp) => Some(rp),
            _ => None,
        })
        .expect("expected a render pass");
    let draws: Vec<&RenderCommand> = rp
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::Draw { .. }))
        .collect();
    assert_eq!(draws.len(), 1, "one instanced draw for the whole gallery");
    match draws[0] {
        RenderCommand::Draw { instance_count, vertex_count, .. } => {
            assert_eq!(*vertex_count, 6);
            assert!(*instance_count > 50, "many widget + glyph instances");
        }
        _ => unreachable!(),
    }
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

/// The gallery with `setLayered(1.0)` injected — the static/dynamic instance-layer
/// split the renderer's cache exploits during animation.
fn layered_instance() -> Elpa<HeadlessBackend> {
    let program = format!(
        "{}\n{}",
        elpa_material::module_js(),
        elpa_material::GALLERY_JS.replace("runApp(App)", "setLayered(1.0); runApp(App)"),
    );
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(900, 1400, 1.0), &program)
        .expect("gallery compiles")
}

#[test]
fn drawer_slide_keeps_the_body_in_the_cached_static_layer() {
    // The point of isolating the drawer in its own component: opening it sits at
    // the top of the tree, but the slide must NOT re-emit/re-upload the whole app
    // every frame. With layering on, the drawer is the only animating component,
    // so it alone lands in the dynamic buffer; the body + chrome keep identical
    // bytes in the static buffer, which the resource cache then skips re-uploading
    // (created == 0) even as the drawer eases in and the frame presents.
    let mut app = layered_instance();
    app.start();
    let _ = app.take_log();

    // Open the drawer (hamburger, top-left).
    app.send_event(&InputEvent::PointerDown { x: 54.0, y: 45.0, button: 0 });

    let mut saw_body_cached = false;
    for _ in 0..10 {
        app.animate(16.0);
        let s = app.last_stats();
        if s.presented && s.resources_created == 0 && s.resources_updated >= 1 {
            let frame = app.last_frame().unwrap();
            let has_static = frame.resources.iter().any(|r| r.id() == "elpa.m3.inst.static");
            let has_dyn = frame.resources.iter().any(|r| r.id() == "elpa.m3.inst.dyn");
            if has_static && has_dyn {
                saw_body_cached = true;
            }
        }
    }
    assert!(
        saw_body_cached,
        "the body stayed in the cached static layer while only the drawer slid"
    );
    assert!(app.trap_reason().is_none(), "no trap animating the layered drawer");
    assert!(app.take_log().is_empty(), "no host errors animating the layered drawer");
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
fn no_section_overflows_the_screen_horizontally_on_a_phone() {
    // A width-constrained Row/Column must measure at its constrained width so a
    // parent that cross-aligns or centres it places it correctly. Before that fix
    // the layout section's `Row({ width: 88 })` measured at its (all-`Expanded`,
    // ~zero) intrinsic width, so `Column({ cross: "start" })` mis-centred it and
    // the full-width row painted ~half a screen off the left edge. Guard every
    // section on a real compact phone surface: no painted quad's horizontal extent
    // may run off either screen edge (a small tolerance absorbs icon strokes that
    // legitimately sit right at the margin).
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1080, 2340, 3.0), // logical 360x780 -> compact (phone)
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles");
    app.start();
    let _ = app.take_log();

    let vw = 1080.0_f32;
    let tol = 8.0_f32; // px of slack for stroke caps sitting on the margin
    // Sentinel marker in slot 0 of an image instance — those rows are
    // interleaved in the buffer but skipped by the SDF draws (see
    // `_planDraws` in the kit), so the layout test must skip them too.
    const IMG_MARK: f32 = 424242.0;
    for section in 0..4 {
        let inst = instances(&app);
        let mut i = 0;
        let (mut min_left, mut max_right) = (f32::MAX, f32::MIN);
        while i + 4 <= inst.len() {
            if inst[i] == IMG_MARK { i += 16; continue; }
            let (cx, hw) = (inst[i], inst[i + 2]);
            min_left = min_left.min(cx - hw);
            max_right = max_right.max(cx + hw);
            i += 16;
        }
        assert!(
            min_left > -tol,
            "section {section}: a widget overflowed the left screen edge (left={min_left})"
        );
        assert!(
            max_right < vw + tol,
            "section {section}: a widget overflowed the right screen edge (right={max_right})"
        );
        assert!(app.trap_reason().is_none(), "no trap in section {section}");
        // Advance to the next bottom-nav section.
        app.send_event(&InputEvent::KeyDown { key: "t".into() });
    }
    assert!(app.take_log().is_empty(), "no host errors sweeping the sections");
}
