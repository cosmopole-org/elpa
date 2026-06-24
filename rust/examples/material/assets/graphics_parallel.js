// Elpa Material — parallel graphics showcase.
//
// The same painting layer as `graphics.js`, but the heavy per-frame geometry — a
// field of hundreds of animated particles — is computed on the **worker-thread
// pool** (each worker running its own Elpian executor) instead of on the render
// thread. Every frame the field is split into chunks, each chunk handed to a
// worker via `parallelMap`, and the gathered points are painted by a CustomPaint.
// Press 'p' to toggle parallel vs. single-threaded compute and compare.
//
// The compute kernel `field(spec)` is linked in from `graphics_field_worker.js`
// (so the inline path can call it directly), and its source is also injected as
// the global `FIELD_WORKER` string so `taskInit` can compile it onto the workers.

let PT = 0.0;        // animation clock (seconds)
let PARTS = [];      // last computed field: a flat array of [x, y] points
let PRepaint = 0;    // the App component's update(), captured on first build
let PInit = 0;       // worker pool initialised?
let PChunks = 6;     // tasks fanned out per frame
let PPer = 80;       // particles per task (PChunks * PPer total per frame)
let PParallel = 1.0; // 1 = worker pool, 0 = single-threaded (toggled by 'p')
let PW = 92.0;       // CustomPaint width  (units)
let PH = 60.0;       // CustomPaint height (units)

// Gather one frame's particle field, either across the pool or inline. Both
// paths run the *same* kernel, so the painted result is identical — only where
// the work runs differs.
function pComputeField() {
    let out = [];
    if (PParallel > 0.5) {
        // Build the per-chunk arg objects, fan them across the workers, join.
        let chunks = [];
        let c = 0;
        while (c < PChunks) { push(chunks, { n: PPer, off: c * PPer, t: PT, w: PW, h: PH }); c = c + 1; }
        let results = parallelMap("field", chunks);
        let i = 0;
        while (i < len(results)) {
            let part = results[i];
            let j = 0;
            while (j < len(part)) { push(out, part[j]); j = j + 1; }
            i = i + 1;
        }
    } else {
        let c = 0;
        while (c < PChunks) {
            let part = field({ n: PPer, off: c * PPer, t: PT, w: PW, h: PH });
            let j = 0;
            while (j < len(part)) { push(out, part[j]); j = j + 1; }
            c = c + 1;
        }
    }
    PARTS = out;
}

// The CustomPainter: just paint the precomputed points — no heavy maths here, so
// the canvas emission stays cheap and the cost lives in the (parallel) compute.
function pscene(canvas, size) {
    let w = size.w; let h = size.h;
    canvas.drawRect(0.0, 0.0, w, h, { shader: { type: "linear",
        colors: [[0.05, 0.07, 0.16, 1.0], [0.12, 0.06, 0.20, 1.0]], begin: [0.0, 0.0], end: [1.0, 1.0] } });
    let i = 0;
    while (i < len(PARTS)) {
        let p = PARTS[i];
        canvas.drawCircle(p[0], p[1], 0.5, { color: [0.45, 0.8, 1.0, 0.8] });
        i = i + 1;
    }
    canvas.drawText("PARALLEL FIELD", w * 0.5, 2.5, { size: 0.7, color: [1.0, 1.0, 1.0, 0.95] });
}

let PApp = defineComponent(function(props, update) {
    PRepaint = update;
    setTheme(0.0, 0);
    return Scaffold({
        onKey: (k) => {
            if (k == "p") { PParallel = 1.0 - PParallel; }
            update();
        },
        appBar: AppBar({ title: "PARALLEL" }),
        body: Center({ child: CustomPaint({ width: PW, height: PH, paint: pscene }) }),
    });
});

// The app drives its own animation: spin up the pool once, advance the clock,
// recompute the field (off-thread when parallel), repaint, then let the SDK run
// its own per-frame work. Overrides the SDK's default `onFrame` (declared earlier,
// so this later declaration wins) and chains back into it.
function onFrame(dt) {
    if (PInit == 0) { taskInit(FIELD_WORKER, 0); PInit = 1; }
    PT = PT + dt * 0.001;
    pComputeField();
    if (PRepaint != 0) { PRepaint(); }
    M.onFrame(dt);
}

runApp(PApp);
