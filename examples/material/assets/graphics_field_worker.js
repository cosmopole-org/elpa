// Elpa Material — the particle-field compute kernel.
//
// A pure, host-free function: given a chunk descriptor it returns that chunk's
// animated particle positions. It is used two ways by `graphics_parallel.js`:
//   * linked into the main program, so the single-threaded path can call it
//     directly (`field(spec)`), and
//   * shipped as the *worker module source* (`taskInit`), so each worker thread
//     compiles it into its own Elpian executor and runs it off the render thread.
// Either way the maths is identical, so the parallel and inline scenes match.
//
// `spec` = { n, off, t, w, h }: produce `n` particles starting at global index
// `off`, animated by time `t`, laid out inside a `w` x `h` box. Each particle is
// a few transcendental ops — light alone, heavy in aggregate across hundreds per
// frame, which is exactly the per-frame geometry work worth spreading over cores.
function field(s) {
    let out = [];
    let i = 0;
    while (i < s.n) {
        let k = num(s.off + i);
        let a = k * 0.13 + s.t;
        let swirl = 0.5 + 0.5 * sin(k * 0.021 + s.t * 0.7);
        // A little inner loop so each particle is real work, not a single op —
        // this is the cost the worker pool divides across threads.
        let wob = 0.0;
        let j = 0;
        while (j < 24) { wob = wob + sin(k * 0.001 * num(j) + s.t) * cos(num(j) * 0.5); j = j + 1; }
        let rad = 0.46 * swirl + wob * 0.004;
        let x = s.w * (0.5 + rad * cos(a));
        let y = s.h * (0.5 + rad * sin(a * 1.3));
        push(out, [x, y]);
        i = i + 1;
    }
    return out;
}
