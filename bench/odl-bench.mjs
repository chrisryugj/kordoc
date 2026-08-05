#!/usr/bin/env node
// opendataloader-bench 외부 벤치 예측 생성기 (측정용 — 게이트 아님)
//
// 사용법:
//   git clone https://github.com/opendataloader-project/opendataloader-bench <클론경로>
//   npm run build
//   node bench/odl-bench.mjs <클론경로>          # prediction/kordoc/markdown/*.md 생성
//   cd <클론경로> && uv sync && uv run python src/evaluator.py --engine kordoc
//
// 조건: 기본 옵션(OCR off) — pdf-inspector README 측정 조건과 동일.
// 실측 2026-08-05 (kordoc v4.7.1, 200문서, 실패 0, 순차 ~7s):
//   overall 0.669 | NID 0.822 | TEDS 0.553 | MHS 0.300
// 대조(해당 레포 README/pdf-inspector README): opendataloader-hybrid 0.907,
// docling 0.882, pdf-inspector 0.875, opendataloader 0.831, pymupdf4llm 0.732,
// markitdown 0.589. 국제(영문 위주) 코퍼스 — 한국 공문서 특화 튜닝(마커 헤딩·
// 한글 줄병합·괘선 표)이 그대로 적용된 결과이며, 약점은 헤딩 위계(MHS)와
// 수평 괘선 전용(서구 재무표 스타일) 표 감지.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"
import { parse } from "../dist/index.js"

const root = process.argv[2]
if (!root) {
  console.error("사용법: node bench/odl-bench.mjs <opendataloader-bench 클론경로>")
  process.exit(1)
}
const outDir = join(root, "prediction/kordoc/markdown")
await mkdir(outDir, { recursive: true })
const files = (await readdir(join(root, "pdfs"))).filter(f => f.endsWith(".pdf")).sort()
let ok = 0, fail = 0
const t0 = performance.now()
for (const f of files) {
  try {
    const r = await parse(await readFile(join(root, "pdfs", f)))
    await writeFile(join(outDir, basename(f, ".pdf") + ".md"), r.markdown ?? "")
    ok++
  } catch (e) {
    await writeFile(join(outDir, basename(f, ".pdf") + ".md"), "")
    fail++
    console.error("FAIL", f, String(e).slice(0, 120))
  }
}
console.log(`ok=${ok} fail=${fail} elapsed=${((performance.now() - t0) / 1000).toFixed(1)}s → ${outDir}`)
