// Loads the page, captures all `[elpa-frame]` console samples (printed every
// ~60 frames by the web example's instrumented RAF), and reports them.
//
// Phase A: idle baseline. Captures `IDLE_MS` of console samples without input.
// Phase B: drawer animation. Toggles `m` on a fixed cadence to drive the eased
// open/close while sampling continues. Outputs combined per-phase stats.
const { chromium } = require('playwright');
const fs = require('fs');

// Note: append `?perf=1` to enable the per-frame timing log the web example
// emits via `console.log` (see `examples/web/src/lib.rs::start_raf`).
const BASE = process.env.ELPA_URL || 'http://localhost:8088/';
const URL = BASE.includes('perf=') ? BASE : BASE + (BASE.includes('?') ? '&' : '?') + 'perf=1';
const OUT = process.env.ELPA_OUT;
const IDLE_MS = parseInt(process.env.ELPA_IDLE || '4000', 10);
const ANIM_MS = parseInt(process.env.ELPA_ANIM || '12000', 10);
const TOGGLE_MS = parseInt(process.env.ELPA_TOGGLE || '2000', 10);

function parse(line) {
  // [elpa-frame] n=60 mean=12.3ms p50=10.2ms p95=21.0ms max=44.1ms
  const m = line.match(/n=(\d+)\s+mean=([\d.]+)ms\s+p50=([\d.]+)ms\s+p95=([\d.]+)ms\s+max=([\d.]+)ms/);
  if (!m) return null;
  return { n: +m[1], mean: +m[2], p50: +m[3], p95: +m[4], max: +m[5] };
}

function combine(samples) {
  if (!samples.length) return null;
  const n = samples.reduce((a, b) => a + b.n, 0);
  const mean = samples.reduce((a, b) => a + b.mean * b.n, 0) / n;
  const p50 = samples.reduce((a, b) => a + b.p50, 0) / samples.length;
  const p95 = Math.max(...samples.map((s) => s.p95));
  const max = Math.max(...samples.map((s) => s.max));
  const cnt = samples.length;
  return { batches: cnt, total_frames: n, mean_ms: +mean.toFixed(2),
           p50_ms: +p50.toFixed(2), p95_ms: +p95.toFixed(2), max_ms: +max.toFixed(2) };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: 412, height: 892 } });
  const all = [];
  const phaseA = [];
  const phaseB = [];
  let phase = 'A';
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[elpa-frame]')) {
      const s = parse(t);
      if (s) {
        all.push({ phase, ...s });
        (phase === 'A' ? phaseA : phaseB).push(s);
      }
    } else if (/panic|unreachable/i.test(t)) {
      console.error('PANIC:', t);
    }
  });
  page.on('pageerror', (e) => console.error('PAGEERR:', e.message));

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3500);

  // Phase A: idle (just clears samples after settle, then collects new ones).
  all.length = 0; phaseA.length = 0;
  await page.waitForTimeout(IDLE_MS);
  phase = 'B';

  // Phase B: drawer toggles on TOGGLE_MS cadence.
  const t0 = Date.now();
  while (Date.now() - t0 < ANIM_MS) {
    await page.keyboard.press('m');
    await page.waitForTimeout(TOGGLE_MS);
  }
  await page.waitForTimeout(1000);

  const report = {
    idle: combine(phaseA),
    drawer: combine(phaseB),
    raw: all.map(({ phase, ...rest }) => ({ phase, ...rest })),
  };
  const j = JSON.stringify(report, null, 2);
  console.log(j);
  if (OUT) fs.writeFileSync(OUT, j);
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
