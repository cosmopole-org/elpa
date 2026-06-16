// Times bottom-nav page switches in the real browser (headless Chromium) to
// measure the live rendering cost. Clicks the nav bar and waits for the next
// few animation frames, reporting wall-clock per switch.
const { chromium } = require('playwright');

const URL = process.env.ELPA_URL || 'http://localhost:8088/';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (/panic/i.test(m.text())) errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000); // boot + first paint

  // The bottom nav bar sits at the bottom; tap its 4 cells across the width.
  const W = 1024, H = 768;
  const cells = [128, 384, 640, 896].map((x) => ({ x, y: H - 28 }));

  // Dispatch a pointerdown the way the app listens (canvas pointer events), then
  // measure how long until rendering has stabilised (rAF deltas back to ~frame).
  async function timedTap(pt) {
    const t0 = Date.now();
    await page.mouse.click(pt.x, pt.y);
    // Wait until two consecutive rAFs are < 50ms apart (render settled), capped.
    await page.evaluate(() => new Promise((res) => {
      let prev = performance.now(), stable = 0, start = prev;
      function tick(now) {
        const dt = now - prev; prev = now;
        if (dt < 50) stable++; else stable = 0;
        if (stable >= 3 || now - start > 20000) res();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }));
    return Date.now() - t0;
  }

  const times = [];
  for (let i = 0; i < 6; i++) {
    const t = await timedTap(cells[i % cells.length]);
    times.push(t);
    console.log(`nav tap #${i} -> cell ${i % cells.length}: ${t} ms`);
  }
  console.log('errors:', errs.length ? errs.join(' | ') : 'none');
  await browser.close();
})();
