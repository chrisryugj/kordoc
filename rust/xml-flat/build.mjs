// xml-flat wasm 빌드 → src/xml/xml-flat-wasm.ts (base64). Rust 와 wasm32-unknown-unknown 타깃이 필요하다:
//   node rust/xml-flat/build.mjs   (rustup 이면 rust-toolchain.toml 의 버전·타깃을 스스로 받는다)
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
const here = dirname(fileURLToPath(import.meta.url))
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
// 빌드한 기계의 경로가 wasm(패닉 위치 문자열)에 박히지 않게 한다
const rustflags = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${here}=/xml-flat`].join("\x1f")
execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: here, stdio: "inherit", env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags } })
const wasm = readFileSync(join(here, "target/wasm32-unknown-unknown/release/xml_flat.wasm"))
const out = join(here, "../../src/xml/xml-flat-wasm.ts")
writeFileSync(out, `// 생성 파일 — rust/xml-flat/build.mjs 가 만든다. 손으로 고치지 않는다 (quick-xml ${"0.38"}, ${wasm.length} bytes)\nexport const XML_FLAT_WASM = "${wasm.toString("base64")}"\n`)
console.log("wrote", out, wasm.length, "bytes")
