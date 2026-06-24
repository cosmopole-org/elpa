//! Run the *parallel graphics* showcase on a real (headless) Elpa instance: the
//! proof that the painting layer can divide its per-frame geometry work across
//! the worker-thread pool. The CustomPaint scene's particle field is computed by
//! `parallelMap` over a pool of worker VMs, then painted; toggling `p` switches
//! to single-threaded compute. This checks the SDK + worker pool run end to end
//! without traps, that the pool actually spins up threads, and that the parallel
//! and inline scenes paint the same number of particles. The `#[ignore]`d bench
//! reports the per-frame time / FPS of each so the speedup is measurable.
//!
//! Bench:
//!   cargo test -p elpa-material --release --test graphics_parallel -- --ignored --nocapture

use elpa::protocol::ResourceDesc;
use elpa::{Elpa, HeadlessBackend, InputEvent, SurfaceInfo};
use std::time::Instant;

fn instance() -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(
        HeadlessBackend::default(),
        SurfaceInfo::new(1000, 1500, 1.0),
        &elpa_material::graphics_parallel_program(),
    )
    .expect("SDK + parallel graphics program compiles")
}

/// Number of 16-float instances in the most recent frame (one per painted
/// primitive — the particle count plus the scene's chrome).
fn instance_count(app: &Elpa<HeadlessBackend>) -> usize {
    app.last_frame()
        .map(|f| {
            f.resources
                .iter()
                .filter_map(|r| match r {
                    ResourceDesc::Buffer(b) if b.id == "elpa.m3.inst" => {
                        b.data_f32.as_ref().map(|d| d.len() / 16)
                    }
                    _ => None,
                })
                .sum::<usize>()
        })
        .unwrap_or(0)
}

#[test]
fn parallel_field_paints_and_pool_spins_up() {
    let mut app = instance();
    app.start();
    // Drive a few animation frames: each spins up / uses the pool, recomputes the
    // field off-thread, and repaints.
    for _ in 0..6 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "parallel graphics did not trap");

    // The pool really started worker threads and ran the field tasks off-thread.
    let (workers, _queued, completed) =
        app.env().task_stats().expect("pool initialised after first frame");
    assert!(workers >= 1, "at least one worker thread spun up");
    assert!(completed >= 6, "field-compute tasks completed off-thread: {completed}");

    let parallel_instances = instance_count(&app);
    assert!(parallel_instances > 100, "particle field painted ({parallel_instances} instances)");

    // Toggle to single-threaded compute ('p'); the same field must paint.
    app.send_event(&InputEvent::KeyDown { key: "p".into() });
    for _ in 0..3 {
        app.animate(16.0);
    }
    assert!(app.trap_reason().is_none(), "inline compute path did not trap");
    let inline_instances = instance_count(&app);
    // Both paths draw the same particle count (only where they compute differs).
    let diff = (parallel_instances as i64 - inline_instances as i64).abs();
    assert!(
        diff <= 4,
        "parallel ({parallel_instances}) and inline ({inline_instances}) paint the same field"
    );
}

#[test]
#[ignore]
fn bench_parallel_graphics_fps() {
    let frames = 120;

    // Parallel (worker pool) path.
    let mut app = instance();
    app.start();
    for _ in 0..3 {
        app.animate(16.0); // warm up + spin up the pool
    }
    let t = Instant::now();
    for _ in 0..frames {
        app.animate(16.0);
    }
    let par = t.elapsed();
    let (workers, _q, completed) = app.env().task_stats().unwrap_or((0, 0, 0));
    let par_inst = instance_count(&app);

    // Single-threaded path: a fresh instance toggled to inline compute.
    let mut app2 = instance();
    app2.start();
    app2.send_event(&InputEvent::KeyDown { key: "p".into() }); // PParallel -> 0
    for _ in 0..3 {
        app2.animate(16.0);
    }
    let t = Instant::now();
    for _ in 0..frames {
        app2.animate(16.0);
    }
    let seq = t.elapsed();

    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    let seq_ms = ms(seq) / frames as f64;
    let par_ms = ms(par) / frames as f64;
    let cores = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1);

    println!("\n=== Elpa parallel-graphics FPS benchmark ===");
    println!("CPU cores available:     {cores}");
    println!("worker threads:          {workers}");
    println!("particles/frame:         {par_inst}  (tasks completed: {completed})");
    println!(
        "single-threaded:         {:8.3} ms/frame = {:7.1} fps",
        seq_ms,
        1000.0 / seq_ms
    );
    println!(
        "worker pool:             {:8.3} ms/frame = {:7.1} fps",
        par_ms,
        1000.0 / par_ms
    );
    println!("speedup:                 {:6.2}x", seq_ms / par_ms);
    println!("============================================\n");
}
