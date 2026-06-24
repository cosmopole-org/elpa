// Realistic end-to-end benchmark for the Elpa web example. Drives Material
// Design 3 widgets through diverse interaction scenarios in real (headless)
// Chromium (SwiftShader WebGL):
//
//   * idle baseline (no input)
//   * navigation-bar switches between tabs (full repaint per switch)
//   * navigation-drawer slide (60-frame eased open / close)
//   * slider drag (continuous repaint while dragging the thumb)
//   * theme cross-fade (toggles dark mode: re-colors every component)
//   * switch toggle (single-component scoped repaint)
//   * fab tap (accent palette swap: re-colors most of the chrome)
//
// For each scenario it reports the **settle time** (wall-clock from the input
// until rendering returns to smooth — 3 consecutive sub-50 ms frames) and the
// **per-frame timing** (`animate()` mean/p50/p95/max ms) drawn from the page's
// own `[elpa-frame]` console samples (the web example logs these every 60
// frames when launched with `?perf=1`; this script enables that).
//
//   ELPA_URL=http://localhost:8088/ node scripts/web-scenarios-perf.js
//
// Settle thresholds are wall-clock + frame caps so a starved rAF can never
// hang the run. The headless SwiftShader rasteriser is far slower than real
// GPUs, so absolute numbers here mainly serve as a regression / delta gauge.

const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.ELPA_URL || 'http://localhost:8088/';
const URL = BASE.includes('perf=') ? BASE : BASE + (BASE.includes('?') ? '&' : '?') + 'perf=1';
const OUT = process.env.ELPA_OUT;
const CAP_MS = parseInt(process.env.ELPA_CAP || '20000', 10);

function parse(line) {
  const m = line.match(/n=(\d+)\s+mean=([\d.]+)ms\s+p50=([\d.]+)ms\s+p95=([\d.]+)ms\s+max=([\d.]+)ms/);
  if (!m) return null;
  return { n: +m[1], mean: +m[2], p50: +m[3], p95: +m[4], max: +m[5] };
}

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: xs.length,
    mean_ms: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1),
    p50_ms: +q(0.5).toFixed(1),
    p95_ms: +q(0.95).toFixed(1),
    max_ms: +Math.max(...xs).toFixed(1),
  };
}

function combineFrames(samples) {
  if (!samples.length) return null;
  const n = samples.reduce((a, b) => a + b.n, 0);
  return {
    batches: samples.length,
    frames: n,
    mean_ms: +(samples.reduce((a, b) => a + b.mean * b.n, 0) / n).toFixed(2),
    p50_ms: +(samples.reduce((a, b) => a + b.p50, 0) / samples.length).toFixed(2),
    p95_ms: +Math.max(...samples.map((s) => s.p95)).toFixed(2),
    max_ms: +Math.max(...samples.map((s) => s.max)).toFixed(2),
  };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: 412, height: 892 } });

  const allFrames = [];
  let currentBucket = null;
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[elpa-frame]')) {
      const s = parse(t);
      if (s && currentBucket) currentBucket.push(s);
    } else if (/panic|unreachable/i.test(t)) {
      console.error('PANIC:', t);
    }
  });
  page.on('pageerror', (e) => console.error('PAGEERR:', e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3500); // boot + first paint + font

  // settleAfter(action): wall-clock from `action` to 3 consecutive sub-50 ms
  // frames, capped at CAP_MS. Returns the settle time in ms.
  async function settleAfter(action) {
    const t0 = Date.now();
    await action();
    await page.evaluate((cap) => new Promise((res) => {
      let prev = performance.now(), smooth = 0; const start = prev; let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      function tick(now) {
        const dt = now - prev; prev = now;
        if (dt < 50) smooth++; else smooth = 0;
        if (smooth >= 3 || now - start > cap) return finish();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      setTimeout(finish, cap + 500);
    }), CAP_MS);
    return Date.now() - t0;
  }

  async function scenario(label, runs, action) {
    currentBucket = [];
    allFrames.push({ label, frames: currentBucket });
    const settles = [];
    for (let i = 0; i < runs; i++) {
      settles.push(await settleAfter(action));
      await page.waitForTimeout(250);
    }
    currentBucket = null;
    return { label, settle_ms: stats(settles), per_settle_ms: settles.map((x) => Math.round(x)),
             frame_timing_ms: combineFrames(allFrames[allFrames.length - 1].frames) };
  }

  // Idle baseline: just let the page sit and report its rest-state frame cost.
  currentBucket = [];
  await page.waitForTimeout(4000);
  const idle = combineFrames(currentBucket);
  currentBucket = null;

  const results = {};
  results.idle = idle;

  // Navigation bar: 4 cells at bottom, repeatedly tap each.
  results.nav_switch = await scenario('nav_switch', 6, async () => {
    const W = 412, H = 892;
    const cells = [52, 154, 258, 360].map((x) => ({ x, y: H - 28 }));
    const cell = cells[Math.floor(Math.random() * cells.length)];
    await page.mouse.click(cell.x, cell.y);
  });

  // Navigation drawer (eased slide): `m` toggles it.
  results.drawer_toggle = await scenario('drawer_toggle', 4, async () => {
    await page.keyboard.press('m');
  });

  // Theme cross-fade: `d` toggles dark mode (full-tree recolor + ease).
  results.theme_toggle = await scenario('theme_toggle', 4, async () => {
    await page.keyboard.press('d');
  });

  // Switch toggle: space toggles the demo switch (scoped repaint).
  results.switch_toggle = await scenario('switch_toggle', 6, async () => {
    await page.keyboard.press(' ');
  });

  // FAB tap: cycles the accent color (recolors most chrome).
  results.fab_tap = await scenario('fab_tap', 4, async () => {
    // The FAB sits near the bottom-right of the gallery.
    await page.mouse.click(360, 760);
  });

  // Slider: keyboard arrow keys nudge the slider value (continuous repaint).
  results.slider_nudge = await scenario('slider_nudge', 6, async () => {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowRight');
    }
  });

  const report = {
    url: URL,
    viewport: '412x892 (Pixel-size phone simulation)',
    note: 'Headless Chromium + SwiftShader software WebGL. The dominant per-frame cost in this environment is software rasterisation, not the engine; numbers serve mainly as a regression / relative-improvement gauge.',
    ...results,
  };
  const j = JSON.stringify(report, null, 2);
  console.log(j);
  if (OUT) fs.writeFileSync(OUT, j);
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
