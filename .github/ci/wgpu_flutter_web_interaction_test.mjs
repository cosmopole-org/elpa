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
// the rendered text from the accessibility DOM (no GPU screenshot needed). Under
// headless SwiftShader, wasm instantiation + CanvasKit warm-up + the demo's
// start() can take a while and the semantics placeholder may not exist on the
// first try, so we *poll* (re-enabling semantics each round) instead of waiting a
// single fixed interval, and dump the page state if the UI never shows up.
//
// The CI step copies this file into the generated project's `tools/` and runs it
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

// Keep a full transcript of console + page errors. `fatal` flags the known
// startup traps; `transcript` keeps everything so a silent failure (a Dart/VM
// exception that doesn't match a fatal pattern, leaving the UI on its spinner)
// is still visible in the CI log.
const fatal = [];
const transcript = [];
const isFatal = (s) => /panicked at|RuntimeError: unreachable|WorkerPool|could not be cloned|global function not found|recursively acquire|failed to start/i.test(s);
const note = (line) => { transcript.push(line); if (isFatal(line)) fatal.push(line.split('\n')[0]); };
page.on('console', (m) => note('console[' + m.type() + ']: ' + m.text().split('\n')[0]));
page.on('pageerror', (e) => note('pageerror: ' + ((e.message || '') + ' ' + (e.stack || '')).split('\n')[0]));

console.log(`[interaction] loading ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 90000 });

// Enabling Flutter's semantics exposes the rendered text in the DOM. The
// placeholder only exists once the engine has mounted, so (re)click it each poll.
const enableSemantics = () => page.evaluate(() => {
  const el = document.querySelector('flt-semantics-placeholder')
    || document.querySelector('[aria-label="Enable accessibility"]');
  if (el) { el.click(); return true; }
  return false;
});

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

// Poll up to ~75s for the controls card to render (wasm + CanvasKit + start()),
// re-enabling semantics each round and bailing early on a fatal startup trap.
let before = '';
let placeholderSeen = false;
const deadline = Date.now() + 75000;
while (Date.now() < deadline) {
  placeholderSeen = (await enableSemantics()) || placeholderSeen;
  await page.waitForTimeout(1500);
  before = await readText();
  if (/3D CONTROLS/i.test(before) || fatal.length) break;
}

const dumpDiagnostics = async (label) => {
  const diag = await page.evaluate(() => ({
    placeholder: !!(document.querySelector('flt-semantics-placeholder')
      || document.querySelector('[aria-label="Enable accessibility"]')),
    semanticsNodes: document.querySelectorAll('flt-semantics').length,
    ariaNodes: document.querySelectorAll('[aria-label]').length,
    flutterView: !!(document.querySelector('flutter-view') || document.querySelector('flt-glass-pane')),
    bodyTextLen: (document.body.innerText || '').length,
    bodyHtml: document.body.innerHTML.slice(0, 1000),
  }));
  console.error(`[interaction] ${label} diagnostics:`);
  console.error('  placeholderEverSeen=' + placeholderSeen + ' placeholderNow=' + diag.placeholder +
    ' flutterView=' + diag.flutterView + ' semanticsNodes=' + diag.semanticsNodes +
    ' ariaNodes=' + diag.ariaNodes + ' bodyTextLen=' + diag.bodyTextLen);
  console.error('  bodyHtml: ' + diag.bodyHtml.replace(/\s+/g, ' '));
  console.error('  console transcript (tail):');
  for (const l of transcript.slice(-25)) console.error('    ' + l);
};

const fail = async (msg) => {
  console.error(`[interaction] FAIL — ${msg}`);
  await dumpDiagnostics('failure');
  process.exitCode = 1;
};

console.log('[interaction] initial:', before.slice(0, 240));
if (fatal.length) { await fail('startup trap:\n  - ' + fatal.join('\n  - ')); }
else if (!/3D CONTROLS/i.test(before)) await fail('demo did not render the controls card ("3D CONTROLS" not found)');
else if (!/PAUSE/i.test(before)) await fail('scene starts spinning, so the PAUSE pill should render ("PAUSE" not found)');
else if (!/ABOUT/i.test(before)) await fail('the about card did not render ("ABOUT" not found)');

// Only drive the tap if the controls actually rendered.
if (process.exitCode !== 1) {
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

  // Poll for the PAUSE -> RESUME flip (ControlsCard.setState re-render).
  let afterTap = '';
  const tapDeadline = Date.now() + 10000;
  while (Date.now() < tapDeadline) {
    await page.waitForTimeout(1000);
    afterTap = await readText();
    if (/RESUME/i.test(afterTap) || fatal.length) break;
  }
  console.log('[interaction] after tap:', afterTap.slice(0, 240));
  // Pausing flips the pill label PAUSE -> RESUME via ControlsCard.setState, proving
  // the isolated scope re-rendered live.
  if (!/RESUME/i.test(afterTap)) {
    await fail('tapping PAUSE did not flip the pill to RESUME (controls scope did not re-render)');
  }
}

if (fatal.length && process.exitCode !== 1) await fail('bridge trapped:\n  - ' + fatal.join('\n  - '));

await browser.close();
server.close();

if (process.exitCode === 1) {
  console.error('[interaction] one or more interaction checks failed.');
} else {
  console.log('[interaction] PASS — the controls render and PAUSE→RESUME re-renders live in a real browser.');
}
