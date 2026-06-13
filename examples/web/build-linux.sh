#!/usr/bin/env bash
set -euo pipefail

# Build script for the Elpa web example on Linux.
# Usage: run from this directory or execute the script from the crate directory:
#   cd examples/web
#   ./build-linux.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building Elpa web example (Linux)..."

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup not found — please install Rust from https://rustup.rs/"
  exit 1
fi

# Ensure the wasm target is installed
if ! rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
  echo "Adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

# Ensure Trunk is available
if ! command -v trunk >/dev/null 2>&1; then
  echo "Trunk not found. Install with: cargo install trunk"
  exit 1
fi

echo "Building web example with Trunk..."
pushd "$DIR" >/dev/null
# Trunk will build this crate and required workspace dependencies for the
# `wasm32-unknown-unknown` target. Avoid `cargo build --workspace` here since
# running that from inside `examples/web` attempts to build the wasm crate for
# the host target and can fail.
trunk build --release
popd >/dev/null

echo "Build complete. Trunk output is in $DIR/dist (or trunk's configured output)."
