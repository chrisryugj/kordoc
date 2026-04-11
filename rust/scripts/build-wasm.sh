#!/usr/bin/env bash
# Build WASM artifact for kordoc integration.
#
# Prerequisites:
#   cargo install wasm-pack
#
# Output: pkg/ (wasm-pack default) — `kordoc_rust_bg.wasm` + JS glue.
# Target is `web` because kordoc is a pure ESM package and ships to both
# Node (>=18, has WebAssembly global) and browsers.

set -euo pipefail
cd "$(dirname "$0")/.."

wasm-pack build \
  --target web \
  --release \
  --features wasm \
  --out-dir pkg \
  --out-name kordoc_rust

echo
echo "=== Output ==="
ls -lh pkg/ | grep -E '\.(wasm|js|ts)$' || true

echo
echo "Next: copy pkg/ into kordoc's dist/ at release time, or publish as"
echo "a sibling npm package (e.g. @kordoc/rust) and depend on it from kordoc."
