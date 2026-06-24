//! End-to-end performance benchmark for the Elpa engine, driven through the
//! Material Design demo. Run with:
//!
//!   cargo test -p elpa-material --release --test bench -- --nocapture
//!
//! It is `#[ignore]`d so it never runs in the normal suite.

use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};
use std::time::Instant;

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_material::program(),
    )
    .expect("SDK + app program compiles")
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Minimal driver for callgrind: a handful of full repaints (mount+paint+submit).
#[test]
#[ignore]
fn bench_profile_repaint() {
    let mut app = instance();
    app.start();
    for i in 0..15 {
        let x = 100.0 + (i % 200) as f64;
        app.send_event(&InputEvent::PointerMove { x, y: 700.0 });
    }
    std::hint::black_box(app.last_frame());
}

#[test]
#[ignore]
fn bench_material_end_to_end() {
    // --- compile + construct ------------------------------------------------
    let t = Instant::now();
    let prog = elpa_material::program();
    let mut app = Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(900, 1400, 1.0), &prog)
        .expect("compiles");
    let construct = t.elapsed();

    // --- first paint --------------------------------------------------------
    let t = Instant::now();
    app.start();
    let first_paint = t.elapsed();
    let inst = app.last_frame().map(|f| {
        f.resources.iter().filter_map(|r| match r {
            elpa::protocol::ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.as_ref().map(|d| d.len() / 16),
            _ => None,
        }).sum::<usize>()
    }).unwrap_or(0);

    // --- steady-state animation (theme cross-fade: full-tree repaint) -------
    app.send_event(&InputEvent::KeyDown { key: "d".into() });
    let n = 600;
    let t = Instant::now();
    for _ in 0..n {
        app.animate(16.0);
    }
    let anim = t.elapsed();

    // --- widget-eased animation (switch toggle: scoped repaint) -------------
    let mut app2 = instance();
    app2.start();
    app2.send_event(&InputEvent::KeyDown { key: " ".into() });
    let t = Instant::now();
    for _ in 0..n {
        app2.animate(16.0);
    }
    let scoped = t.elapsed();

    // --- pointer event (full repaint via _repaint) --------------------------
    let m = 400;
    let t = Instant::now();
    for i in 0..m {
        let x = 100.0 + (i % 200) as f64;
        app.send_event(&InputEvent::PointerMove { x, y: 700.0 });
    }
    let pointer = t.elapsed();

    println!("\n=== Elpa material end-to-end benchmark ===");
    println!("instances/frame:        {inst}");
    println!("compile+construct:      {:8.2} ms", ms(construct));
    println!("first paint:            {:8.2} ms", ms(first_paint));
    println!("theme anim (full):      {:8.2} ms / {n} frames = {:6.3} ms/frame", ms(anim), ms(anim) / n as f64);
    println!("switch anim (scoped):   {:8.2} ms / {n} frames = {:6.3} ms/frame", ms(scoped), ms(scoped) / n as f64);
    println!("pointer move (repaint): {:8.2} ms / {m} events = {:6.3} ms/event", ms(pointer), ms(pointer) / m as f64);
    println!("==========================================\n");
}

/// Drawer slide on the full **gallery** with its banner image registered.
///
/// The gallery's navigation drawer has a network header image, which used to
/// register an image handle and force every subsequent `_submit` through a
/// `_planDraws` path that *copied every non-image instance's 16 floats* into a
/// fresh `clean[]` array each frame. That copy was the dominant per-frame
/// cost during the drawer slide. This bench drives the kit's eased open /
/// close in the same code path the web example uses (the `m` key toggles the
/// drawer) and reports the per-frame VM cost.
#[test]
#[ignore]
fn bench_gallery_drawer_with_image() {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(412, 892, 1.0), // phone-sized to match the web bench
        &elpa_material::gallery_program(),
    )
    .expect("gallery compiles");
    app.start();

    // Open the drawer. The image handle is now registered, so every subsequent
    // submit will exercise the planning path.
    app.send_event(&InputEvent::KeyDown { key: "m".into() });

    // Settle the open animation, then close + settle, repeated, timing the
    // animate() calls themselves (which is what the browser's rAF measures).
    let mut total_frames = 0usize;
    let t = Instant::now();
    for _ in 0..4 {
        // Open + close the drawer once each iteration; the eased slide takes
        // ~30 frames per direction at 0.18 step, so 80 covers both with slack.
        for _ in 0..80 {
            app.animate(16.0);
            total_frames += 1;
        }
        app.send_event(&InputEvent::KeyDown { key: "m".into() });
    }
    let elapsed = t.elapsed();

    let inst = app.last_frame().map(|f| {
        f.resources.iter().filter_map(|r| match r {
            elpa::protocol::ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => b.data_f32.as_ref().map(|d| d.len() / 16),
            _ => None,
        }).sum::<usize>()
    }).unwrap_or(0);

    println!("\n=== Elpa gallery drawer-with-image bench ===");
    println!("instances/frame:        {inst}");
    println!("drawer slide:           {:8.2} ms / {total_frames} frames = {:6.3} ms/frame",
        ms(elapsed), ms(elapsed) / total_frames as f64);
    println!("============================================\n");
}
