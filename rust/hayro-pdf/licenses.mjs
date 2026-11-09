// hayro-pdf wasm 에 컴파일되는 Rust 크레이트의 라이선스 고지 → THIRD_PARTY/hayro-pdf.txt
//   node rust/hayro-pdf/licenses.mjs   (build.mjs 가 wasm 을 만든 뒤 부른다 — Cargo.lock 이 바뀌면 같이 바뀐다)
// 실행 코드에 들어가는 크레이트만 센다(빌드 때만 도는 proc-macro·build 의존성은 뺀다). 고를 수 있으면 Apache-2.0 —
// 전문은 THIRD_PARTY/apache-2.0.LICENSE 에 있다. 그 밖의 라이선스는 크레이트의 라이선스 파일을 그대로 싣는다
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
const here = dirname(fileURLToPath(import.meta.url))
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", "wasm32-unknown-unknown"], { cwd: here, maxBuffer: 1 << 28 }).toString())
const pkgs = new Map(meta.packages.map(p => [p.id, p]))
const nodes = new Map(meta.resolve.nodes.map(n => [n.id, n]))
const isMacro = p => p.targets.some(t => t.kind.includes("proc-macro"))
const seen = new Set(), stack = [meta.resolve.root]
while (stack.length) {
  const id = stack.pop()
  if (seen.has(id)) continue
  seen.add(id)
  for (const d of nodes.get(id).deps) if (d.dep_kinds.some(k => k.kind === null) && !isMacro(pkgs.get(d.pkg))) stack.push(d.pkg)
}
const crates = [...seen].map(id => pkgs.get(id)).filter(p => p.name !== "hayro-pdf").sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
/** SPDX 식에서 고를 라이선스 — Apache-2.0 이 있으면 그것, 아니면 식 그대로(AND 는 모두) */
const pick = lic => /(^|[\s(/])Apache-2\.0($|[\s)/])/.test(lic) && !/\bAND\b/.test(lic) ? "Apache-2.0" : lic
let out = `hayro-pdf (src/pdf/hayro-pdf.wasm) 에 컴파일된 Rust 크레이트 — rust/hayro-pdf/licenses.mjs 가 만든다. 손으로 고치지 않는다.
Apache-2.0 전문: THIRD_PARTY/apache-2.0.LICENSE. 그 밖의 라이선스 전문은 아래 각 크레이트 항목에 싣는다.

hayro 의 고지(NOTICE.md): 일부 코드는 PDFBox·pdf.js·png crate(Apache-2.0)에서 옮겨 왔다 — 표준 글꼴 인코딩 표, 사전 키 목록,
CalRGB·CalGray 변환, Flate 디코더, AES·MD5·SHA·RC4, PNG 예측기 디코딩.

크레이트 | 버전 | 라이선스(SPDX) | 고른 라이선스 | 저장소
`
const texts = []
/** 라이선스 → 전문을 처음 실은 크레이트 */
const textOf = new Map()
for (const p of crates) {
  const chosen = pick(p.license ?? "")
  out += `${p.name} | ${p.version} | ${p.license} | ${chosen} | ${p.repository ?? ""}\n`
  if (chosen === "Apache-2.0") continue
  const dir = dirname(p.manifest_path)
  const files = readdirSync(dir).filter(f => /^(LICEN[CS]E|COPYING)/i.test(f)).sort()
  if (!files.length) {
    // 라이선스 파일을 싣지 않은 크레이트 — 앞서 실은 같은 라이선스 전문을 가리킨다
    const same = textOf.get(chosen)
    if (!same) throw new Error(`${p.name} ${p.version}: 라이선스 파일이 없다 (${p.license})`)
    texts.push(`\n${"=".repeat(80)}\n${p.name} ${p.version} — ${chosen}: 크레이트에 전문이 없어 ${same} 항목의 전문을 따른다\n${"=".repeat(80)}\n`)
    continue
  }
  textOf.set(chosen, `${p.name} ${p.version}`)
  for (const f of files) texts.push(`\n${"=".repeat(80)}\n${p.name} ${p.version} — ${f}\n${"=".repeat(80)}\n\n${readFileSync(join(dir, f), "utf8").trim()}\n`)
}
const target = join(here, "../../THIRD_PARTY/hayro-pdf.txt")
writeFileSync(target, out + texts.join(""))
console.log("wrote", target, crates.length, "crates")
