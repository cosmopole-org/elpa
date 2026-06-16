//! Momentum scrolling: after a fast drag is released, a scrollable list keeps
//! moving and decelerates over several frames instead of stopping dead under the
//! finger. Driven entirely by the SDK's JavaScript (`onEvent` records a smoothed
//! drag velocity; `onFrame` advances the fling), proven here on a real headless
//! VM the same way the web/native hosts drive it (events + `animate`).

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

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
fn momentum_keeps_a_list_scrolling_after_release() {
    // A landscape surface: the body list fills the (short) height, so its content
    // overflows and is scrollable — the case momentum applies to.
    let mut app = Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1400, 600, 1.0),
        &elpa_material::gallery_program(),
    )
    .expect("SDK + gallery program compiles");
    app.start();
    // Go to the CHARTS section: a non-interactive list, so a drag anywhere in it
    // pans the viewport (no widget swallows the gesture as a tap).
    app.send_event(&InputEvent::KeyDown { key: "t".into() });
    app.send_event(&InputEvent::KeyDown { key: "t".into() });
    let _ = app.take_log();

    // Fast upward flick over the body's scrollable list (centred at x≈700).
    let cx = 700.0;
    app.send_event(&InputEvent::PointerDown { x: cx, y: 450.0, button: 0 });
    let mut y = 450.0;
    for _ in 0..6 {
        y -= 40.0;
        app.send_event(&InputEvent::PointerMove { x: cx, y });
    }
    app.send_event(&InputEvent::PointerUp { x: cx, y, button: 0 });

    // After release, the fling animates: several `animate` ticks each change the
    // rendered offset before it settles.
    let after_release = instances(&app);
    let mut prev = after_release.clone();
    let mut moving_frames = 0;
    for _ in 0..30 {
        app.animate(16.0);
        let now = instances(&app);
        if now != prev {
            moving_frames += 1;
        }
        prev = now;
    }
    assert!(
        moving_frames >= 3,
        "fling should keep scrolling for several frames after release (got {moving_frames})"
    );
    assert!(app.trap_reason().is_none(), "no trap during the fling: {:?}", app.trap_reason());
    assert!(app.take_log().is_empty(), "no host errors during the fling");

    // A second touch halts the momentum immediately (catch-to-stop): tapping then
    // animating leaves the render unchanged.
    app.send_event(&InputEvent::PointerDown { x: cx, y: 300.0, button: 0 });
    app.send_event(&InputEvent::PointerUp { x: cx, y: 300.0, button: 0 });
    let settled = instances(&app);
    for _ in 0..5 {
        app.animate(16.0);
    }
    assert_eq!(settled, instances(&app), "a new touch stops the fling");
}
