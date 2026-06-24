// Headless end-to-end smoke test for the built Flutter web app.
//
// Serves `build/web` under the deployed base path, loads it in real Chromium,
// and fails if the Rust bridge traps during startup — specifically the
// flutter_rust_bridge multi-threaded `WorkerPool` panic
// (`#<Memory> could not be cloned` → `RuntimeError: unreachable`) that a
// shared-memory wasm hits on a page that is not cross-origin isolated, which is
// exactly the regression that left the demo a blank "Elpa failed to start"
// screen. Run from the `flutter/` dir after `flutter build web`.
//
//   node tools/web_smoke_test.mjs [baseHref]   (default "/elpa/")

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
  '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf', '.bin': 'application/octet-stream',
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

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const fatal = [];
const isFatal = (s) => /panicked at|RuntimeError: unreachable|WorkerPool|could not be cloned|failed to start/i.test(s);
page.on('console', (m) => { const t = m.text(); if (isFatal(t)) fatal.push('console: ' + t.split('\n')[0]); });
page.on('pageerror', (e) => { const t = (e.message || '') + ' ' + (e.stack || ''); if (isFatal(t)) fatal.push('pageerror: ' + (e.message || '').split('\n')[0]); });

console.log(`[smoke] loading ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 90000 });
// Give the engine time to instantiate the wasm and run the demo's start().
await page.waitForTimeout(20000);

await browser.close();
server.close();

if (fatal.length) {
  console.error('[smoke] FAIL — the web bridge trapped during startup:');
  for (const f of fatal) console.error('  - ' + f);
  process.exit(1);
}
console.log('[smoke] PASS — the Rust bridge initialized with no startup trap.');
