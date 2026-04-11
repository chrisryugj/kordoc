# kordoc/rust — Development notes

Notes for working on the Rust/WASM parser backend. See `README.md` for
the high-level overview and [issue #17](https://github.com/chrisryugj/kordoc/issues/17)
for the RFC.

## Layout

```
rust/
├── Cargo.toml             # minimal deps, wasm feature
├── rust-toolchain.toml    # stable + wasm32-unknown-unknown
├── src/
│   ├── lib.rs             # wasm-bindgen glue
│   ├── hwp/               # HWP 5.0 (CFB/OLE)
│   │   ├── ole.rs         # CompoundFile reader
│   │   ├── record.rs      # tag-based record parser
│   │   └── parser.rs      # body text, tables, styles
│   └── hwpx/
│       └── parser.rs      # OOXML-style zip + section XML
├── tests/smoke.rs         # type-level smoke tests
└── scripts/build-wasm.sh  # wasm-pack wrapper
```

## Byte-slice API (WASM contract)

The canonical entrypoints are:

```rust
HwpParser::from_bytes(bytes)   // HWP 5.0
HwpxParser::from_bytes(bytes)  // HWPX
```

Both accept anything that implements `Into<Vec<u8>>`. Native `open()`
funnels through `from_bytes`, so there is one code path for native and
wasm32.

`std::fs` access is gated on `#[cfg(not(target_arch = "wasm32"))]` to
keep filesystem code out of the WASM binary.

## Running tests

```bash
cargo test                            # native (23 tests)
cargo build --target wasm32-unknown-unknown            # wasm32 sanity
cargo build --target wasm32-unknown-unknown --features wasm  # + glue
```

## Building the WASM artifact

```bash
./scripts/build-wasm.sh
# Output: pkg/kordoc_rust_bg.wasm + pkg/kordoc_rust.js
```

The build script uses `wasm-pack build --target web` because kordoc is
an ESM package that runs in both Node (≥18 has the WebAssembly global)
and browsers.

## Open follow-ups before the JS side is wired

1. **Parity tests.** Need real HWP fixtures. `tests/fixtures/` currently
   only has `dummy.hwpx`. Either add a few public-domain samples under
   `tests/fixtures/hwp-rust/` or point the Rust tests at existing JS
   fixtures once they land.
2. **JSON contract.** `src/lib.rs` currently returns `String` from
   `parseHwp`/`parseHwpx` for simplicity. Swap to
   `serde-wasm-bindgen::to_value` once the `KordocRustResult` shape in
   README.md is agreed.
3. **Pre-existing dead code warnings.** A few unused helpers (e.g.
   `parse_section_records`, `extract_text_simple`) are inherited from
   the source repo. Leaving them in place for now to minimize diff noise
   against the origin — clean up in a follow-up commit once the PR
   direction is confirmed.
4. **CI.** A `rust/` CI job running `cargo test` + `wasm-pack build`
   will be added in a follow-up commit once the maintainer signals
   which CI platform they prefer (GitHub Actions presumably).

## Source origin

Parsers adapted from [`mdm-core`](https://github.com/seunghan91/markdown-media).
Upstream is MIT-licensed, same as kordoc. Modifications in this sub-crate:

- Trimmed to HWP + HWPX modules only
- Introduced byte-slice `from_bytes` constructors for WASM compatibility
- Gated `std::fs` usage behind `#[cfg(not(target_arch = "wasm32"))]`
- Fixed two stale test assertions (GFM separator spacing, 0x1F control
  char branch)
