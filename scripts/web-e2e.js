// Playwright e2e visual test for the Elpa web example.
//
// Loads the served page in headless Chromium (SwiftShader WebGL), captures all
// console output + page errors, screenshots the page, and analyses the captured
// PNG to detect a blank/black screen. The screenshot is used for the blank check
// rather than a `getImageData` readback of the live canvas: a WebGL/WebGPU
// canvas without `preserveDrawingBuffer` reads back empty even when it is
// visibly rendering, whereas the browser's screenshot compositor captures the
// real pixels.
//
// Exit codes: 0 = rendered something, 2 = blank/black, 3 = a panic/page error.
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const fs = require('fs');

const URL = process.env.ELPA_URL || 'http://localhost:8088/';
const SHOT = process.env.ELPA_SHOT || '/tmp/elpa-web.png';
const SETTLE_MS = parseInt(process.env.ELPA_SETTLE_MS || '6000', 10);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });

  const logs = [];
  let sawPanic = false;
  const record = (line) => {
    logs.push(line);
    if (/panic|RuntimeError: unreachable|expect|unwrap/i.test(line)) sawPanic = true;
  };
  page.on('console', (m) => record(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => record(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    logs.push(`[requestfailed] ${r.url()} -> ${r.failure() && r.failure().errorText}`));

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  } catch (e) {
    record(`[nav-error] ${e.message}`);
  }
  await page.waitForTimeout(SETTLE_MS);

  // Screenshot and analyse: count pixels that are not near-black, and how many
  // distinct-ish colours appear (a solid clear colour is still "blank UI").
  const buf = await page.screenshot({ path: SHOT });
  const png = PNG.sync.read(buf);
  let nonBlack = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 12 || g > 12 || b > 12) nonBlack++;
    colors.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
  }
  const total = png.width * png.height;
  const stats = {
    w: png.width, h: png.height, total,
    nonBlackPct: ((100 * nonBlack) / total).toFixed(2),
    distinctColors: colors.size,
  };

  console.log('=== CANVAS STATS (from screenshot) ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log('=== CONSOLE / ERRORS (' + logs.length + ') ===');
  console.log(logs.join('\n'));
  fs.writeFileSync('/tmp/elpa-web-logs.txt', logs.join('\n'));

  await browser.close();

  if (sawPanic) {
    console.log('RESULT: FAIL (panic/page error detected)');
    process.exit(3);
  }
  // A real UI has many non-black pixels AND several distinct colours (text,
  // surfaces, accent). A solid clear colour would pass nonBlack but fail colours.
  const blank = nonBlack / total < 0.05 || colors.size < 5;
  console.log('RESULT:', blank ? 'FAIL (blank screen)' : 'PASS (UI rendered)');
  process.exit(blank ? 2 : 0);
})();
