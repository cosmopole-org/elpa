#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building Elpa native example..."

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup not found — please install Rust from https://rustup.rs/"
  exit 1
fi

echo "Running cargo build for examples/native..."
cargo build --manifest-path "$DIR/Cargo.toml" --release

echo "Build complete. Run with: $DIR/target/release/elpa-native-example"
