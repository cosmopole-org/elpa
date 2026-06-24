//! End-to-end performance benchmark for the Liquid Glass kit, driven through the
//! showcase demo. Run with:
//!
//!   cargo test -p elpa-liquidglass --release --test bench -- --nocapture
//!
//! It is `#[ignore]`d so it never runs in the normal suite. It reports the
//! per-frame VM cost (mount + paint + the two-pass `gpu.submit` frame build) for
//! the two animation regimes — a full-tree theme cross-fade and a scoped, single-
//! widget ease — plus pointer-move repaints, so a host can size its frame budget.

use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};
use std::time::Instant;

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(900, 1400, 1.0),
        &elpa_liquidglass::program(),
    )
    .expect("SDK + app program compiles")
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn glass_instances(app: &Elpa<HeadlessBackend>) -> (usize, usize) {
    app.last_frame()
        .map(|f| {
            f.resources
                .iter()
                .find_map(|r| match r {
                    elpa::protocol::ResourceDesc::Buffer(b) if b.id == "elpa.lg.inst" => {
                        b.data_f32.as_ref()
                    }
                    _ => None,
                })
                .map(|d| {
                    let n = d.len() / 20;
                    let glass = (0..n).filter(|i| (d[i * 20 + 16] - 2.0).abs() < 0.01).count();
                    (n, glass)
                })
                .unwrap_or((0, 0))
        })
        .unwrap_or((0, 0))
}

#[test]
#[ignore]
fn bench_liquidglass_end_to_end() {
    // --- compile + construct ------------------------------------------------
    let t = Instant::now();
    let prog = elpa_liquidglass::program();
    let mut app =
        Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(900, 1400, 1.0), &prog)
            .expect("compiles");
    let construct = t.elapsed();

    // --- first paint --------------------------------------------------------
    let t = Instant::now();
    app.start();
    let first_paint = t.elapsed();
    let (inst, glass) = glass_instances(&app);

    // --- full-tree animation (theme cross-fade) -----------------------------
    app.send_event(&InputEvent::KeyDown { key: "d".into() });
    let n = 600;
    let t = Instant::now();
    for _ in 0..n {
        app.animate(16.0);
    }
    let anim = t.elapsed();

    // --- scoped animation (switch toggle) -----------------------------------
    let mut app2 = instance();
    app2.start();
    app2.send_event(&InputEvent::KeyDown { key: " ".into() });
    let t = Instant::now();
    for _ in 0..n {
        app2.animate(16.0);
    }
    let scoped = t.elapsed();

    // --- pointer move (full repaint) ----------------------------------------
    let m = 400;
    let t = Instant::now();
    for i in 0..m {
        let x = 100.0 + (i % 200) as f64;
        app.send_event(&InputEvent::PointerMove { x, y: 700.0 });
    }
    let pointer = t.elapsed();

    let fps = |d: std::time::Duration, frames: usize| 1000.0 / (ms(d) / frames as f64);
    println!("\n=== Elpa Liquid Glass end-to-end benchmark ===");
    println!("instances/frame:        {inst}  (of which glass lenses: {glass})");
    println!("compile+construct:      {:8.2} ms", ms(construct));
    println!("first paint:            {:8.2} ms", ms(first_paint));
    println!(
        "theme anim (full):      {:8.2} ms / {n} = {:6.3} ms/frame  (~{:.0} fps headroom)",
        ms(anim),
        ms(anim) / n as f64,
        fps(anim, n)
    );
    println!(
        "switch anim (scoped):   {:8.2} ms / {n} = {:6.3} ms/frame  (~{:.0} fps headroom)",
        ms(scoped),
        ms(scoped) / n as f64,
        fps(scoped, n)
    );
    println!(
        "pointer move (repaint): {:8.2} ms / {m} = {:6.3} ms/event",
        ms(pointer),
        ms(pointer) / m as f64
    );
    println!("==============================================\n");
}
