/**
 * 실제 페이지 경계 게이트 (#66) — 조판 캐시로 복원한 쪽수가 한컴과 같은지 잠근다.
 *
 * 같은 문서를 hwp/hwpx(±pdf)로 병행 게시한 pairs 코퍼스가 재료다. 한컴이 직접 뽑은
 * PDF의 장수가 그 문서의 참값이고, 우리 쪽수는 그것과 일치해야 한다. PDF가 없는 쌍은
 * 매니페스트의 expectedPages(실측 기준선)를 참값 자리에 놓는다 — 참값 주장이 아니라
 * "어제와 같은가"를 묻는 회귀 잠금이다.
 *
 * 검사 3종 (쌍마다):
 *   ① pageMode == "layout" — 조판 캐시 경로가 살아있는지. section 근사로 떨어지면
 *      쪽수가 우연히 맞아도 기능은 죽은 것이라 별도로 본다.
 *   ② pageCount == expectedPages — hwp·hwpx 각각. 두 포맷이 같은 값을 내야 하므로
 *      한쪽 경로만 회귀해도 여기서 걸린다.
 *   ③ pdf 장수 × pdfUp == expectedPages — 기준선 자체의 검증. PDF 장수는 kordoc이
 *      아니라 pdfjs로 직접 읽는다(우리 버그가 정답지까지 오염시키면 게이트가 무의미).
 *
 * 사용: node bench/verify-pages.mjs [--gate] [--verbose]
 *   --gate: 위반이 하나라도 있으면 exit 1 (bench:gate 체인 편입용, 기존 --gate 관례)
 * 전제: npm run build (dist/ 최신)
 *
 * bench:gate 체인의 맨 앞에 둔다 — 뒤에 두면 score.mjs 모수 하한(hwp쌍 ≥12)에 막혀
 * pairs가 10쌍인 기기에서 &&가 첫 링크에서 끊기고 이 게이트가 영영 실행되지 않는다.
 * 필요한 재료(pairs 10쌍)는 이미 갖춰져 있으므로 앞에서 먼저 판정한다.
 */
import { parse } from "../dist/index.js"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const CORPUS = "bench/corpus/pairs"
const MANIFEST = "bench/pairs-manifest.json"
const args = process.argv.slice(2)
const GATE_MODE = args.includes("--gate")
const VERBOSE = args.includes("--verbose")

/** PDF 장수는 독립 경로로 읽는다 — kordoc PDF 파서를 정답지로 쓰면 자기채점이 된다 */
async function pdfPageCount(path) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    useSystemFonts: false,
    verbosity: 0,
  }).promise
  return doc.numPages
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))
const results = []
const skipped = []

for (const pair of manifest.pairs) {
  const { base, expectedPages, pdfUp = 1 } = pair
  const path = ext => join(CORPUS, `${base}.${ext}`)
  const present = ["hwpx", "hwp", "pdf"].filter(ext => existsSync(path(ext)))

  if (present.length === 0) {
    skipped.push(base)
    continue
  }
  if (expectedPages === undefined) {
    results.push({ base, fail: ["매니페스트에 expectedPages 없음"], detail: "" })
    continue
  }

  const fail = []
  const detail = []

  for (const ext of ["hwpx", "hwp"]) {
    if (!present.includes(ext)) continue
    try {
      const r = await parse(path(ext))
      const mode = r.metadata?.pageMode
      detail.push(`${ext} ${r.pageCount}${mode === "layout" ? "" : `(${mode})`}`)
      if (r.pageCount !== expectedPages) fail.push(`${ext} ${r.pageCount} ≠ 기준 ${expectedPages}`)
      if (mode !== "layout") fail.push(`${ext} pageMode=${mode} — 조판 캐시 경로 이탈`)
    } catch (e) {
      fail.push(`${ext} 파싱 실패: ${e.message}`)
    }
  }

  if (present.includes("pdf")) {
    try {
      const n = await pdfPageCount(path("pdf"))
      const truth = n * pdfUp
      detail.push(`pdf ${n}${pdfUp > 1 ? `×${pdfUp}=${truth}` : ""}`)
      if (truth !== expectedPages) {
        fail.push(`pdf 참값 ${truth} ≠ 기준 ${expectedPages} — 기준선이 틀렸거나 pdfUp 미반영`)
      }
    } catch (e) {
      fail.push(`pdf 읽기 실패: ${e.message}`)
    }
  }

  results.push({ base, fail, detail: detail.join(" · ") })
}

for (const r of results) {
  console.log(`${r.fail.length === 0 ? "✅" : "❌"} ${r.base}  ${r.detail}`)
  for (const f of r.fail) console.log(`   ↳ ${f}`)
}

const passed = results.filter(r => r.fail.length === 0).length
console.log(`\n페이지 경계: ${passed}/${results.length} 쌍 통과`)
// 검사 못 한 쌍은 목록으로 남긴다 — 부분 동기화 기기의 결과가 "전수 통과"로 읽히지 않도록
if (skipped.length > 0) {
  console.log(`⚠️  코퍼스 부재로 건너뜀 ${skipped.length}쌍: ${skipped.join(", ")}`)
}
if (VERBOSE) console.log(`(참값: PDF 있는 쌍은 한컴 산출 장수, 없는 쌍은 매니페스트 실측 기준선)`)

// --gate: 무후퇴 플로어 — 한 쌍이라도 어긋나면 실패. 기준선 자체를 바꿔야 한다면
// 매니페스트 expectedPages를 고치고 무엇을 왜 고쳤는지 커밋에 남긴다.
if (GATE_MODE) {
  if (results.length === 0) {
    console.error(`❌ 페이지 게이트: 코퍼스(${CORPUS})가 비어 검증 불가`)
    process.exit(1)
  }
  if (passed < results.length) {
    console.error(`❌ 페이지 게이트 실패: ${results.length - passed}쌍 불일치`)
    process.exit(1)
  }
  console.log(`✅ 페이지 게이트 통과 (${passed}/${results.length} 쌍 전수 일치)`)
}
