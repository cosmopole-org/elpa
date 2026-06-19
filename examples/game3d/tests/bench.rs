//! Frame-cost benchmark for the Game3D engine — measures VM interpreter steps
//! per animated frame, the deterministic proxy for per-frame CPU cost. Used to
//! quantify (and regression-guard) the HUD overlay's contribution to the
//! steady-state render loop while the scene rotates.

use elpa::{Elpa, HeadlessBackend, SurfaceInfo};

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
