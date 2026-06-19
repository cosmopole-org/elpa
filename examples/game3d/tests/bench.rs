//! Frame-cost benchmark for the Game3D engine — measures VM interpreter steps
//! per animated frame, the deterministic proxy for per-frame CPU cost. Used to
//! quantify (and regression-guard) the HUD overlay's contribution to the
//! steady-state render loop while the scene rotates.

use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};

fn instance(program: &str) -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(1280, 720, 1.0), program)
        .expect("compiles")
}

/// Median interpreter steps per animated frame over `n` ticks (after a warmup).
/// Uses the lifetime instruction tally delta, since a frame spans several VM
/// turns (each host call — `surfaceInfo`, `gpu.submit` — ends a turn).
fn steps_per_frame(app: &mut Elpa<HeadlessBackend>, n: usize) -> u64 {
    for _ in 0..8 {
        app.animate(16.0);
    }
    let mut samples = Vec::with_capacity(n);
    for _ in 0..n {
        let before = app.usage().expect("usage").instructions;
        app.animate(16.0);
        let after = app.usage().expect("usage").instructions;
        samples.push(after - before);
    }
    samples.sort_unstable();
    samples[samples.len() / 2]
}

#[test]
fn hud_steady_state_frame_cost() {
    // Full demo (four HUD panels) vs the same scene with the overlay hidden. With
    // the overlay's geometry cached, an animated frame whose HUD did not change
    // must not pay to rebuild it — so the per-frame cost with the HUD on should be
    // close to the cost with it off (the scene rotation dominates either way).
    let with_hud = elpa_game3d::program();
    let no_hud = format!("{}\nshowOverlay(0.0);\n", elpa_game3d::program());

    let mut a = instance(&with_hud);
    a.start();
    let mut b = instance(&no_hud);
    b.start();

    let on = steps_per_frame(&mut a, 60);
    let off = steps_per_frame(&mut b, 60);
    let overhead = on as f64 / off.max(1) as f64;
    println!("steps/frame: HUD on = {on}, HUD off = {off}, ratio = {overhead:.2}x");

    assert!(a.trap_reason().is_none(), "no trap with HUD");
    assert!(b.trap_reason().is_none(), "no trap without HUD");
    // The HUD must not rebuild its geometry on a frame where nothing in it
    // changed; a cached steady state keeps the per-frame overhead modest.
    assert!(
        overhead < 1.5,
        "HUD adds too much per-frame VM work while rotating (ratio {overhead:.2}x)"
    );
}

/// Median interpreter steps per pointer-move over a drag of `n` moves, after the
/// given press has started the gesture. `start` opens the gesture (a press on a
/// panel title bar, or on empty scene), then we sweep the pointer and sample the
/// per-move VM cost.
fn steps_per_move(app: &mut Elpa<HeadlessBackend>, start: (f64, f64), n: usize) -> u64 {
    app.send_event(&InputEvent::PointerDown { x: start.0, y: start.1, button: 0 });
    let mut samples = Vec::with_capacity(n);
    let mut x = start.0;
    let mut y = start.1;
    for i in 0..n {
        // A small zig-zag so the position genuinely changes each move.
        x += if i % 2 == 0 { 3.0 } else { 2.0 };
        y += 1.0;
        let before = app.usage().expect("usage").instructions;
        app.send_event(&InputEvent::PointerMove { x, y });
        let after = app.usage().expect("usage").instructions;
        samples.push(after - before);
    }
    app.send_event(&InputEvent::PointerUp { x, y, button: 0 });
    samples.sort_unstable();
    samples[samples.len() / 2]
}

#[test]
fn interaction_costs() {
    // Quantify the per-event VM cost of the live interactions: dragging a HUD
    // panel (2D), orbiting the camera (3D), and wheel-zoom (3D + a HUD gauge).
    // The "RESET VIEW" pose makes the orbit deterministic. Prints the numbers and
    // guards the two HUD-driven paths against rebuilding more than one panel.
    let mut a = instance(&elpa_game3d::program());
    a.start();
    // Warm the caches.
    for _ in 0..4 {
        a.animate(16.0);
    }

    // Dragging the "VILLAGE" panel by its title bar (logical ~ (40,28)).
    let panel_drag = steps_per_move(&mut a, (40.0, 28.0), 40);
    // Orbiting the scene from clear space at the surface centre.
    let orbit_drag = steps_per_move(&mut a, (640.0, 360.0), 40);
    println!("steps/move: panel-drag = {panel_drag}, orbit-drag = {orbit_drag}");

    // A single wheel-zoom tick (moves the camera and the ZOOM gauge).
    let before = a.usage().expect("usage").instructions;
    a.send_event(&InputEvent::Wheel { x: 640.0, y: 360.0, delta_y: -240.0 });
    let wheel = a.usage().expect("usage").instructions - before;
    println!("steps/event: wheel-zoom = {wheel}");

    assert!(a.trap_reason().is_none(), "no trap during interactions");
    // Regression guards (headroom over the measured costs). Orbiting moves only
    // the camera, so the scene's cached per-mesh uniforms must hold — no full
    // re-pack. Dragging a panel must re-project just that panel, and a wheel tick
    // re-tessellate only the gauge's panel — none may regress to a whole-HUD or
    // whole-scene rebuild.
    assert!(orbit_drag < 400_000, "orbit drag re-packed the static scene (cost {orbit_drag})");
    assert!(panel_drag < 800_000, "panel drag rebuilt more than the dragged panel (cost {panel_drag})");
    assert!(wheel < 1_200_000, "wheel-zoom rebuilt more than the camera panel (cost {wheel})");
}
