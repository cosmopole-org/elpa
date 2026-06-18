//! End-to-end test + benchmark for the multi-threaded task pool, driven through
//! the real `Elpa` instance over the full VM → runtime → worker-pool stack.
//!
//! A guest `onFrame` does a fixed batch of CPU-heavy compute every frame. Two
//! variants run the *same* work: one inline on the main VM, one fanned out across
//! the worker pool (`taskSpawn` + `taskJoin`). The correctness test proves the
//! parallel path yields the identical result and that the pool actually spins up
//! threads; the `#[ignore]`d bench reports the per-frame time and FPS of each so
//! the multi-core speedup is measurable.
//!
//! Run the bench with:
//!   cargo test -p elpa --release --test workers_fps -- --ignored --nocapture

use elpa::headless::HeadlessBackend;
use elpa::{Elpa, SurfaceInfo};
use std::time::Instant;

/// The compute kernel, shared by the worker module and the inline baseline so the
/// two paths are bit-for-bit comparable. Pure: one arg object in, one number out.
const HEAVY: &str = r#"
function heavy(spec) {
    let n = spec.n;
    let acc = spec.seed;
    let i = 0;
    while (i < n) {
        acc = acc + (i * 3 + 7) - (i * 2);
        acc = acc * 1.0000001;
        i = i + 1;
    }
    return acc;
}
"#;

/// Build the parallel app: it lazily spins up the pool, then every frame spawns
/// `chunks` heavy tasks and joins them, logging the summed result.
fn parallel_app(chunks: i64, iters: i64, workers: i64) -> String {
    // Embed the worker module as a JS string literal (JSON string == JS string).
    let worker_src = serde_json::to_string(HEAVY).unwrap();
    format!(
        r#"
        var WORKER = {worker_src};
        var READY = 0;
        function onFrame(dt) {{
            if (READY == 0) {{
                askHost("task.init", [{{ source: WORKER, workers: {workers} }}]);
                READY = 1;
            }}
            let ids = [];
            let k = 0;
            while (k < {chunks}) {{
                let r = askHost("task.spawn", [{{ fn: "heavy", args: {{ n: {iters}, seed: k }} }}]);
                push(ids, r.id);
                k = k + 1;
            }}
            let res = askHost("task.join", [{{ ids: ids }}]);
            let total = 0;
            let j = 0;
            while (j < len(res.results)) {{ total = total + res.results[j]; j = j + 1; }}
            askHost("log", [total]);
        }}
    "#
    )
}

/// The inline baseline: the same kernel and batch, but computed on the main VM.
fn inline_app(chunks: i64, iters: i64) -> String {
    format!(
        r#"
        {HEAVY}
        function onFrame(dt) {{
            let total = 0;
            let k = 0;
            while (k < {chunks}) {{
                total = total + heavy({{ n: {iters}, seed: k }});
                k = k + 1;
            }}
            askHost("log", [total]);
        }}
    "#
    )
}

fn instance(src: &str) -> Elpa<HeadlessBackend> {
    Elpa::new_from_js(HeadlessBackend::default(), SurfaceInfo::new(64, 64, 1.0), src)
        .expect("app compiles")
}

/// Pull the last logged total out of an app's drained log. Each `log` payload is
/// the askHost argument array `[<number>]`; parse the number back out.
fn last_total(app: &mut Elpa<HeadlessBackend>) -> Option<f64> {
    let log = app.take_log();
    let line = log.last()?;
    let trimmed = line.trim().trim_start_matches('[').trim_end_matches(']');
    trimmed.trim().parse::<f64>().ok()
}

#[test]
fn parallel_path_matches_inline_and_pool_spins_up() {
    // Small batch so the correctness check stays fast.
    let chunks = 4;
    let iters = 500;

    let mut par = instance(&parallel_app(chunks, iters, 2));
    par.start();
    par.animate(16.0);
    let par_total = last_total(&mut par).expect("parallel app logged a total");

    let mut seq = instance(&inline_app(chunks, iters));
    seq.start();
    seq.animate(16.0);
    let seq_total = last_total(&mut seq).expect("inline app logged a total");

    // Same kernel both ways; agree up to the worker results' f64→JSON→f64
    // round-trip (the inline path never serialises).
    let tol = seq_total.abs() * 1e-5 + 1e-3;
    assert!(
        (par_total - seq_total).abs() <= tol,
        "parallel result {par_total} must match inline result {seq_total} (tol {tol})"
    );

    // The pool really started worker threads and ran the tasks off-thread.
    let (workers, _queued, completed) =
        par.env().task_stats().expect("pool initialised after first frame");
    assert!(workers >= 1, "at least one worker thread");
    assert!(completed >= chunks as u64, "all spawned tasks completed");

    // Run several more frames to make sure the steady state is stable (the pool
    // is reused, results keep matching, nothing traps).
    for _ in 0..5 {
        par.animate(16.0);
        assert_eq!(last_total(&mut par), Some(par_total));
    }
    assert!(par.trap_reason().is_none(), "parallel app did not trap");
}

#[test]
#[ignore]
fn bench_worker_fps() {
    // A frame's worth of heavy compute, split into `chunks` tasks. Sized so each
    // task is substantial relative to the spawn/JSON overhead (where fanning
    // across cores pays off) but short enough to stay in the VM's near-linear
    // loop regime — long monolithic loops scale super-linearly in this tree
    // interpreter, so the workload is "many moderate tasks", not "few huge" ones.
    let chunks: i64 = 8;
    let iters: i64 = 1_000;
    let frames = 12;

    let cores = std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1);

    // --- inline baseline ----------------------------------------------------
    let mut seq = instance(&inline_app(chunks, iters));
    seq.start();
    seq.animate(16.0); // warm up
    let _ = seq.take_log();
    let t = Instant::now();
    for _ in 0..frames {
        seq.animate(16.0);
    }
    let seq_elapsed = t.elapsed();
    let seq_total = last_total(&mut seq).unwrap_or(0.0);

    // --- parallel (worker pool) ---------------------------------------------
    let mut par = instance(&parallel_app(chunks, iters, 0)); // 0 = match cores
    par.start();
    par.animate(16.0); // warm up (also spins up the pool)
    let _ = par.take_log();
    let t = Instant::now();
    for _ in 0..frames {
        par.animate(16.0);
    }
    let par_elapsed = t.elapsed();
    let par_total = last_total(&mut par).unwrap_or(0.0);

    let (workers, _q, completed) = par.env().task_stats().unwrap_or((0, 0, 0));

    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    let seq_ms = ms(seq_elapsed) / frames as f64;
    let par_ms = ms(par_elapsed) / frames as f64;

    println!("\n=== Elpa worker-pool FPS benchmark ===");
    println!("CPU cores available:     {cores}");
    println!("worker threads:          {workers}");
    println!("tasks/frame:             {chunks}  ({iters} iters each)");
    println!("tasks completed:         {completed}");
    println!("result check:            inline={seq_total:.3}  parallel={par_total:.3}");
    println!(
        "inline (1 thread):       {:8.3} ms/frame = {:7.1} fps",
        seq_ms,
        1000.0 / seq_ms
    );
    println!(
        "parallel (pool):         {:8.3} ms/frame = {:7.1} fps",
        par_ms,
        1000.0 / par_ms
    );
    println!("speedup:                 {:6.2}x", seq_ms / par_ms);
    println!("======================================\n");

    // The two paths run the same kernel, so their results agree up to the f64 →
    // JSON → f64 round-trip the worker results take (the inline path never
    // serialises): a relative tolerance, not bit-equality.
    let tol = seq_total.abs() * 1e-5 + 1e-3;
    assert!(
        (par_total - seq_total).abs() <= tol,
        "parallel result {par_total} must match inline {seq_total} (tol {tol})"
    );
}
