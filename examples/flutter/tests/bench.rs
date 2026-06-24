//! Frame-time benchmark (ignored by default). Run with:
//!   cargo test -p elpa-flutter --release --test bench -- --ignored --nocapture
use std::time::Instant;

use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

#[test]
#[ignore]
fn frame_timing() {
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 800, 2.0),
        &elpa_flutter::program(),
    )
    .expect("SDK + app program compiles");

    let t0 = Instant::now();
    app.start();
    println!("start: {:.2} ms", t0.elapsed().as_secs_f64() * 1000.0);

    let frames = 240;
    let t1 = Instant::now();
    for _ in 0..frames {
        app.animate(16.0);
    }
    let anim_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let per = anim_ms / frames as f64;
    println!(
        "animate: {frames} frames {anim_ms:.1} ms = {per:.3} ms/frame ({:.0} fps)",
        1000.0 / per
    );

    app.send_event(&InputEvent::PointerDown { x: 625.0, y: 778.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: 625.0, y: 778.0, button: 0 });
    let sframes = 120;
    let t2 = Instant::now();
    app.send_event(&InputEvent::PointerDown { x: 500.0, y: 400.0, button: 0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 320.0 });
    app.send_event(&InputEvent::PointerMove { x: 500.0, y: 240.0 });
    app.send_event(&InputEvent::PointerUp { x: 500.0, y: 240.0, button: 0 });
    for _ in 0..sframes {
        app.animate(16.0);
    }
    let scroll_ms = t2.elapsed().as_secs_f64() * 1000.0;
    let sper = scroll_ms / sframes as f64;
    println!(
        "scroll : {sframes} frames {scroll_ms:.1} ms = {sper:.3} ms/frame ({:.0} fps)",
        1000.0 / sper
    );

    assert!(app.trap_reason().is_none(), "trap: {:?}", app.trap_reason());
}
