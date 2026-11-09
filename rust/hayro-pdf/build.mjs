// hayro-pdf wasm 빌드 → src/pdf/hayro-pdf.wasm. Rust 와 wasm32-unknown-unknown 타깃이 필요하다:
//   node rust/hayro-pdf/build.mjs   (rustup 이면 rust-toolchain.toml 의 버전·타깃을 스스로 받는다)
// hayro 는 Cargo.toml 의 git 커밋으로 고정한다 — 같은 커밋·도구 사슬이면 어느 기계에서 빌드해도 같은 바이트
import { execFileSync } from "node:child_process"
import { copyFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
const here = dirname(fileURLToPath(import.meta.url))
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
// 빌드한 기계의 경로가 wasm(패닉 위치 문자열)에 박히지 않게 한다
const rustflags = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${here}=/hayro-pdf`].join("\x1f")
execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"], { cwd: here, stdio: "inherit", env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags } })
const out = join(here, "../../src/pdf/hayro-pdf.wasm")
copyFileSync(join(here, "target/wasm32-unknown-unknown/release/hayro_pdf.wasm"), out)
console.log("wrote", out, statSync(out).size, "bytes")
// 컴파일된 크레이트의 라이선스 고지도 같은 Cargo.lock 으로 다시 만든다
execFileSync(process.execPath, [join(here, "licenses.mjs")], { stdio: "inherit" })
