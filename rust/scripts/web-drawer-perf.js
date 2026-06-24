// Measures how long the navigation-drawer open/close *animation* keeps the main
// thread janky in the real browser (headless Chromium, SwiftShader WebGL). The
// gallery binds the `m` key to toggle the drawer; the eased slide runs a fixed
// number of animation frames. We measure, per toggle, the **settle time**: the
// wall-clock from the keypress until rendering returns to smooth (3 consecutive
// frames < 50 ms apart). That window is exactly the span the UI is dropping
// frames, so a cheaper per-frame animation settles sooner = smoother.
//
// Resolved by a hard-timeout fallback so a starved rAF can never hang the run.
// Writes the JSON report to $ELPA_OUT (and stdout).
//
//   ELPA_URL=http://localhost:8088/ ELPA_OUT=/tmp/base.json node scripts/web-drawer-perf.js
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.ELPA_URL || 'http://localhost:8088/';
const OUT = process.env.ELPA_OUT;
const CYCLES = parseInt(process.env.ELPA_CYCLES || '6', 10);
const LABEL = process.env.ELPA_LABEL || 'drawer';
const CAP_MS = parseInt(process.env.ELPA_CAP || '15000', 10);

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean_ms: +mean.toFixed(1), median_ms: +q(0.5).toFixed(1),
           min_ms: +Math.min(...xs).toFixed(1), max_ms: +Math.max(...xs).toFixed(1) };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: 412, height: 892 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (/panic|unreachable/i.test(m.text())) errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3500); // boot + first paint + font

  // Settle time after one toggle: keypress -> 3 consecutive sub-50ms frames.
  // The in-page loop is also bounded by a setTimeout so it always resolves.
  async function settleAfterToggle() {
    const t0 = Date.now();
    await page.keyboard.press('m');
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
      setTimeout(finish, cap + 500); // hard fallback if rAF is starved/paused
    }), CAP_MS);
    return Date.now() - t0;
  }

  const settles = [];
  for (let i = 0; i < CYCLES; i++) {
    settles.push(await settleAfterToggle()); // alternates open / close
    await page.waitForTimeout(250);
  }

  const report = { label: LABEL, cycles: CYCLES, settle_ms: stats(settles),
                   per_toggle_ms: settles.map((x) => Math.round(x)), errors: errs };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (OUT) fs.writeFileSync(OUT, json);
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
