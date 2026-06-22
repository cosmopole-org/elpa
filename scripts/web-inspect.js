// Visual inspection harness for the Elpa Material gallery.
// Walks every bottom-nav section + the drawer/dialog/snackbar overlays via the
// app's keyboard shortcuts, screenshots each, and records console output + failed
// network requests so we can see grey-box / request-failure issues.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.ELPA_URL || 'http://localhost:8088/';
const OUT = process.env.ELPA_OUT || '/tmp/shots';
const SETTLE = parseInt(process.env.ELPA_SETTLE_MS || '7000', 10);
fs.mkdirSync(OUT, { recursive: true });

const logs = [];
const failed = [];

async function shot(page, name, waitMs = 1200) {
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`shot: ${name}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} -> ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.url()} -> HTTP ${r.status()}`); });

  try { await page.goto(URL, { waitUntil: 'load', timeout: 30000 }); }
  catch (e) { logs.push(`[nav-error] ${e.message}`); }
  await page.waitForTimeout(SETTLE);

  // Sections are keyed by 't' (cycle tab 0->1->2->3->4->0). Start = Layout.
  const sections = ['layout', 'widgets', 'charts', 'media', 'graphics'];
  const canvas = await page.$('#elpa-canvas');
  await shot(page, '0-' + sections[0]);
  for (let i = 1; i < sections.length; i++) {
    await page.keyboard.press('t');
    await shot(page, i + '-' + sections[i]);
  }
  // Back to layout, then open overlays.
  await page.keyboard.press('t'); // -> layout (tab 0)
  await page.waitForTimeout(600);
  await page.keyboard.press('m'); await shot(page, '5-drawer');
  await page.keyboard.press('m'); await page.waitForTimeout(400); // close
  await page.keyboard.press('g'); await shot(page, '6-dialog');
  await page.keyboard.press('g'); await page.waitForTimeout(400); // close
  await page.keyboard.press('s'); await shot(page, '7-snackbar');
  await page.keyboard.press('s'); await page.waitForTimeout(400);
  await page.keyboard.press('d'); await shot(page, '8-dark');

  // Let media settle longer on the media tab for image/video load.
  await page.keyboard.press('d'); // back to light
  for (let k = 0; k < 3; k++) await page.keyboard.press('t'); // to media (tab3)
  await shot(page, '9-media-settled', 6000);

  fs.writeFileSync(`${OUT}/logs.txt`, logs.join('\n'));
  fs.writeFileSync(`${OUT}/failed.txt`, failed.join('\n'));
  console.log('=== CONSOLE (' + logs.length + ') ===');
  console.log(logs.slice(0, 80).join('\n'));
  console.log('=== FAILED REQUESTS (' + failed.length + ') ===');
  console.log([...new Set(failed)].join('\n'));
  await browser.close();
})();
