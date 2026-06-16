# Web visual e2e test

A headless-browser smoke test for the deployed web example
([`examples/web`](../examples/web)) — the GitHub Pages build. It loads the real
wasm bundle in headless Chromium (SwiftShader WebGL), captures the console, and
**fails on a blank screen or a wasm panic**.

This exists because a renderer bug once turned the deployed page fully black: an
empty rendering scope emitted a zero-length vertex buffer, and the real wgpu
backend panicked (`buffer slices can not be empty`) on the first frame — invisible
to the GPU-less headless unit tests. This test reproduces the live browser path.

## Run it

```bash
npm install                       # playwright + pngjs (once)
npx playwright install chromium   # browser binary (once)
scripts/web-e2e.sh                # build (Trunk) + serve + visual check
```

Or against an already-served bundle:

```bash
ELPA_URL=http://localhost:8088/ npm run e2e
```

## What it checks

- The page loads and the wasm app boots without a panic / page error
  (any `panic` / `unreachable` / failed `expect`/`unwrap` in the console fails it).
- The rendered frame is **not** blank: the screenshot has a high fraction of
  non-black pixels and several distinct colours (a real UI, not a solid clear).

The blank check reads the **screenshot** rather than `canvas.getImageData`: a
WebGPU/WebGL canvas without `preserveDrawingBuffer` reads back empty even while
visibly rendering, so the browser's screenshot compositor is the reliable source.

Exit codes: `0` rendered, `2` blank, `3` panic/page error.
