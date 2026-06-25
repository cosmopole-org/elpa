// End-to-end *interaction* test for the built wgpu+Flutter template web app.
//
// The CLI-generated `wgpu-flutter` project (see
// rust/tools/create-elpa-app/templates/wgpu-flutter) renders a different UI than
// the bundled `flutter/` Telegram demo, so it gets its own interaction test: the
// home page shows a 3D scene card (a `Native3DView`), a "3D CONTROLS" card with a
// PAUSE/RESUME + RESET VIEW pill row, and an "ABOUT" card.
//
// The sibling `web_smoke_test.mjs` (copied verbatim from the flutter shell, and
// template-agnostic) only proves the bridge doesn't trap at startup. This drives
// the real demo and asserts the UI is *live*: the controls render, and tapping
// the PAUSE pill flips it to RESUME — a full SDK-driven re-render of an isolated
// scope (`ControlsCard.setState`). It catches a UI that renders but is frozen,
// the same class of regression the flutter-shell interaction test guards.
//
// Flutter web paints to a canvas, so we enable Flutter's semantics tree and read
// the rendered text from the accessibility DOM (no GPU screenshot needed). The
// CI step copies this file into the generated project's `tools/` and runs it
// from that project dir (where `playwright` and `build/web` live):
//
//   node tools/wgpu_flutter_web_interaction_test.mjs [baseHref]   (default "/elpa/")

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const ROOT = 'build/web';
const BASE = (process.argv[2] || '/elpa/').replace(/\/?$/, '/');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
  '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.bin': 'application/octet-stream', '.symbols': 'text/plain',
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith(BASE)) p = p.slice(BASE.length - 1);
  if (p === '/' || p === '') p = '/index.html';
  const file = join(ROOT, p);
  if (!existsSync(file)) { res.statusCode = 404; res.end(); return; }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 500; res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}${BASE}`;

// SwiftShader lets headless Chromium run CanvasKit without a real GPU.
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage',
         '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' });

const fatal = [];
const isFatal = (s) => /panicked at|RuntimeError: unreachable|WorkerPool|could not be cloned|global function not found|recursively acquire|failed to start/i.test(s);
page.on('console', (m) => { const t = m.text(); if (isFatal(t)) fatal.push('console: ' + t.split('\n')[0]); });
page.on('pageerror', (e) => { const t = (e.message || '') + ' ' + (e.stack || ''); if (isFatal(t)) fatal.push('pageerror: ' + (e.message || '').split('\n')[0]); });

console.log(`[interaction] loading ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(15000); // wasm instantiate + CanvasKit + the demo's start()

// Enable Flutter's semantics so rendered text is exposed in the DOM.
await page.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click());
await page.waitForTimeout(2000);

const readText = () => page.evaluate(() => {
  const nodes = [...document.querySelectorAll('flt-semantics, [aria-label]')];
  const out = [];
  for (const n of nodes) {
    const a = n.getAttribute && n.getAttribute('aria-label');
    if (a) out.push(a);
    const t = (n.textContent || '').trim();
    if (t) out.push(t);
  }
  return out.join(' | ');
});

const fail = (msg) => { console.error(`[interaction] FAIL — ${msg}`); process.exitCode = 1; };

const before = await readText();
console.log('[interaction] initial:', before.slice(0, 240));
if (fatal.length) { fail('startup trap:\n  - ' + fatal.join('\n  - ')); }
else if (!/3D CONTROLS/i.test(before)) fail('demo did not render the controls card ("3D CONTROLS" not found)');
else if (!/PAUSE/i.test(before)) fail('scene starts spinning, so the PAUSE pill should render ("PAUSE" not found)');
else if (!/ABOUT/i.test(before)) fail('the about card did not render ("ABOUT" not found)');

// Tap the PAUSE pill: locate its semantics node, else fall back to a coordinate
// in the controls row (left pill, below the 240px scene card).
const target = await page.evaluate(() => {
  const n = [...document.querySelectorAll('flt-semantics, [aria-label]')]
    .find((e) => /^PAUSE$/i.test((e.getAttribute('aria-label') || '').trim()) || /^PAUSE$/i.test((e.textContent || '').trim()));
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (target) await page.mouse.click(target.x, target.y);
else await page.mouse.click(90, 470);
await page.waitForTimeout(1800);

const afterTap = await readText();
console.log('[interaction] after tap:', afterTap.slice(0, 240));
// Pausing flips the pill label PAUSE -> RESUME via ControlsCard.setState, proving
// the isolated scope re-rendered live.
if (!/RESUME/i.test(afterTap)) {
  fail('tapping PAUSE did not flip the pill to RESUME (controls scope did not re-render)');
}

if (fatal.length && process.exitCode !== 1) fail('bridge trapped:\n  - ' + fatal.join('\n  - '));

await browser.close();
server.close();

if (process.exitCode === 1) {
  console.error('[interaction] one or more interaction checks failed.');
} else {
  console.log('[interaction] PASS — the controls render and PAUSE→RESUME re-renders live in a real browser.');
}
