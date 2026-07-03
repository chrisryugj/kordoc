#!/usr/bin/env node
// markdownToHwpx 생성물의 ZIP 내부 엔트리 sha256 스냅샷 (generator 순수 이동 게이트)
// zip 바이트는 JSZip 타임스탬프로 비결정 → 엔트리 내용만 해시.
// 사용법: node bench/gen-sweep.mjs <출력.json>  (전/후 diff로 검증, dist 기준 — build 후 실행)
import { writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { markdownToHwpx } from "../dist/index.js"

const outPath = process.argv[2]
if (!outPath) { console.error("사용법: node bench/gen-sweep.mjs <출력.json>"); process.exit(1) }

const FIXTURES = {
  basic: "# 제목1\n\n본문 **굵게** *기울임* `코드`\n\n## 제목2\n\n- 리스트1\n- 리스트2\n\n> 인용문\n",
  table: "| 구분 | 금액 | 비고 |\n| --- | --- | --- |\n| 세입 | 1,000 | 증가 |\n| 세출 | 900 | |\n",
  htmlTable: '<table><tr><th rowspan="2">구분</th><th colspan="2">내역</th></tr><tr><td>a</td><td>b</td></tr><tr><td>합계</td><td>1</td><td>2</td></tr></table>\n',
  gongmun: "수신 내부결재\n\n제목 테스트 기안\n\n1. 관련: 행정안전부 공문\n\n2. 다음과 같이 보고합니다.\n\n가. 첫째 항목\n\n나. 둘째 항목\n\n붙임 1부. 끝.\n",
  mixed: "# 사업 개요\n\n○ 기간: 2026년\n\n| 항목 | 값 |\n| --- | --- |\n| a | 1 |\n\n마무리 문단\n",
  equation: "수식\n\n$$a \\pm b = \\frac{x}{y}$$\n\n끝\n",
}

const out = {}
for (const [name, md] of Object.entries(FIXTURES)) {
  const opts = name === "gongmun" ? { gongmun: { preset: "기안문" } } : undefined
  const buf = await markdownToHwpx(md, opts)
  const zip = await JSZip.loadAsync(buf)
  const entries = Object.keys(zip.files).filter(f => !zip.files[f].dir).sort()
  for (const f of entries) {
    const content = await zip.files[f].async("uint8array")
    out[`${name}:${f}`] = createHash("sha256").update(content).digest("hex")
  }
}
await writeFile(outPath, JSON.stringify(out, null, 2))
console.log(`${Object.keys(out).length}개 엔트리 해시 → ${outPath}`)
