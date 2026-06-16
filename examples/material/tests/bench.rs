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
            elpa::protocol::ResourceDesc::Buffer(b)
                if b.id.starts_with("elpa.layer.") && b.id.ends_with(".inst") =>
            {
                b.data_f32.as_ref().map(|d| d.len() / 16)
            }
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
