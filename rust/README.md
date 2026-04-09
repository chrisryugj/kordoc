# kordoc Rust/WASM parser backend (proposal)

Opt-in Rust HWP/HWPX parser backend for kordoc, compiled to WASM.

**Status:** RFC — see [#17](https://github.com/chrisryugj/kordoc/issues/17).
This sub-crate is a proposal; no kordoc JS code is wired to it yet so the
draft PR is reviewable in isolation.

## Scope

Only HWP 5.0 (CFB/OLE) and HWPX (OOXML zip). Matches kordoc's existing
`src/hwp5/` and `src/hwpx/` surface. Not touching PDF/XLSX/DOCX.

## Why WASM (and not napi-rs)

kordoc is a pure-JS ESM package with zero native deps today. A native
addon would force a per-platform prebuild matrix (darwin×2, linux×3,
win ×1+) and node-gyp/prebuildify infrastructure. WASM is a single
artifact, runs in Node ≥18 and browsers, and slots into `dist/` with
no new CI requirements beyond a single `wasm-pack build` step.

## Build

```bash
# One-time
cargo install wasm-pack
rustup target add wasm32-unknown-unknown

# Native build + tests
cargo build
cargo test

# WASM build for kordoc integration
./scripts/build-wasm.sh
# → pkg/kordoc_rust_bg.wasm + JS glue
```

## Current status

- [x] HWP 5.0 parser (CFB/OLE, compressed streams, body text, tables,
      character shapes, BinData)
- [x] HWPX parser (zip, section XML, tables → GFM, character styles,
      images)
- [x] Byte-slice public API (`HwpParser::from_bytes`,
      `HwpxParser::from_bytes`) — WASM-compatible
- [x] `cargo test` green on native (23/23)
- [x] `cargo build --target wasm32-unknown-unknown --features wasm`
      clean (0 errors)
- [x] Dependencies pared down to 6: `cfb`, `flate2`, `miniz_oxide`,
      `zip`, `encoding_rs`, `serde`
- [ ] JS wiring in kordoc (`src/hwp5/parser.ts`, `src/hwpx/parser.ts`)
      — **intentionally deferred until integration shape is agreed**
- [ ] Parity tests against kordoc's JS parsers — need a real HWP
      fixture (kordoc currently ships only `tests/fixtures/dummy.hwpx`)
- [ ] Benchmark numbers
- [ ] Final `.wasm` size measurement

## JSON contract (proposed — see issue #17 §중간 데이터 계약)

Rust returns a typed struct; Markdown serialization stays in JS so there
is one rendering code path. Final shape to be agreed in the issue.

```ts
type KordocRustResult = {
  text: string;
  paragraphs: Array<{
    text: string;
    style?: { bold?: boolean; italic?: boolean; underline?: boolean };
  }>;
  tables: Array<{ rows: string[][] }>;
  images: Array<{ name: string; mime: string; bytes: Uint8Array }>;
  meta: { format: 'hwp' | 'hwpx'; version?: string };
};
```

Currently the `wasm-bindgen` entrypoints in `src/lib.rs` return plain
strings for simplicity — they will be swapped to `serde-wasm-bindgen`
once the shape is frozen.

## Source origin & license

Parsers are extracted from
[`mdm-core`](https://github.com/seunghan91/markdown-media) (MIT), trimmed
to HWP/HWPX only and adapted to a WASM-friendly byte-slice API. License
matches kordoc's MIT. Credit/origin noted in the PR body.

## Follow-ups before merge

See issue #17 for open questions. This sub-crate will evolve based on
the maintainer's answers to:

1. Agreement on opt-in WASM backend direction
2. Integration shape: `rust/` sub-crate (this PR) vs sibling npm package
3. `images.bytes` as `Uint8Array` vs base64
4. JSON contract finalization
5. Whether there are conflicting internal plans on the parser side
