#!/usr/bin/env bash
# Build the Elpa web example, serve it, and run the Playwright visual e2e test.
#
#   npm install            # once: installs playwright + pngjs
#   npx playwright install chromium
#   scripts/web-e2e.sh     # build (trunk) + serve + headless visual check
#
# Exits non-zero if the page renders a blank/black screen or a wasm panic is
# logged — the regression that turned the deployed page black.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/examples/web"
PORT="${ELPA_PORT:-8088}"

echo "==> Building web example with Trunk"
( cd "$WEB" && PATH="$HOME/.cargo/bin:$PATH" trunk build )

echo "==> Serving examples/web/dist on :$PORT"
( cd "$WEB/dist" && python3 -m http.server "$PORT" >/tmp/elpa-httpd.log 2>&1 ) &
HTTPD=$!
trap 'kill "$HTTPD" 2>/dev/null || true' EXIT
sleep 2

echo "==> Running headless visual test"
ELPA_URL="http://localhost:$PORT/" node "$ROOT/scripts/web-e2e.js"
