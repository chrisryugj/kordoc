#!/usr/bin/env node
// 대형 합성 입력 성능 벤치 — perf.mjs의 소형 corpus fixture로는 안 드러나는
// PDF 테이블 감지 경로의 초선형 병목을 노출한다 (dist 빌드 불필요, tsx로 src 직접 로드).
//   1) detectClusterTables: 텍스트 조각 5,000+ (프로즈 70% + 무선 표 30%)
//   2) buildTableGrids: 적층 표 50개 (수평 1,550 × 수직 550 괘선)
// 사용법: node bench/perf-synth.mjs
import { performance } from "node:perf_hooks"
import { tsImport } from "tsx/esm/api"

const { detectClusterTables } = await tsImport("../src/pdf/cluster-detector.ts", import.meta.url)
const { buildTableGrids } = await tsImport("../src/pdf/table-grid.ts", import.meta.url)

const fmt = n => (n >= 100 ? n.toFixed(0) : n.toFixed(1))
const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
const bench = (fn, reps = 5) => {
  fn() // 워밍업
  const ms = []
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now()
    fn()
    ms.push(performance.now() - t0)
  }
  return median(ms)
}

// ── 1) 클러스터 테이블 감지: 페이지 1장에 N개 텍스트 조각 ──
function synthClusterItems(n) {
  const items = []
  let y = 30000
  let count = 0
  // 70%: 프로즈 줄 (줄당 10조각)
  while (count < n * 0.7) {
    let x = 50
    for (let k = 0; k < 10 && count < n * 0.7; k++) {
      const text = "어절조각" + (k % 7)
      const w = text.length * 10
      items.push({ text, x, y, w, h: 12, fontSize: 10, fontName: "F0" })
      x += w + 5
      count++
    }
    y -= 14
  }
  // 30%: 무선(선 없는) 표 — 6열 짧은 셀, 열 x 고정
  const colXs = [60, 150, 240, 330, 420, 510]
  while (count < n) {
    for (let c = 0; c < 6 && count < n; c++) {
      items.push({ text: "값" + (count % 100), x: colXs[c], y, w: 30, h: 12, fontSize: 10, fontName: "F0" })
      count++
    }
    y -= 14
  }
  return items
}

console.log("=== detectClusterTables (합성 텍스트 조각) ===")
for (const n of [1250, 2500, 5000, 10000, 20000]) {
  const items = synthClusterItems(n)
  let out
  const ms = bench(() => { out = detectClusterTables(items, 1) })
  console.log(`  N=${n}: ${fmt(ms)}ms · 감지 표 ${out.length}개`)
}

// ── 2) 유선 표 그리드: T개 적층 표의 괘선 → 그리드 ──
function synthGridLines(tables, rows, cols) {
  const hs = []
  const vs = []
  let yTop = 100000
  for (let t = 0; t < tables; t++) {
    const x0 = 50, w = 500, rowH = 20, colW = w / cols
    const y0 = yTop - rows * rowH
    for (let r = 0; r <= rows; r++) hs.push({ x1: x0, y1: y0 + r * rowH, x2: x0 + w, y2: y0 + r * rowH, lineWidth: 1 })
    for (let c = 0; c <= cols; c++) vs.push({ x1: x0 + c * colW, y1: y0, x2: x0 + c * colW, y2: y0 + rows * rowH, lineWidth: 1 })
    yTop = y0 - 500 // 표 사이 간격 — 연결 컴포넌트 분리
  }
  return { hs, vs }
}

console.log("=== buildTableGrids (합성 괘선) ===")
for (const [tables, rows, cols] of [[5, 10, 6], [20, 20, 8], [50, 30, 10]]) {
  const { hs, vs } = synthGridLines(tables, rows, cols)
  let out
  const ms = bench(() => { out = buildTableGrids(hs, vs) }, 3)
  console.log(`  표 ${tables}개 (H=${hs.length} V=${vs.length}): ${fmt(ms)}ms · 그리드 ${out.length}개`)
}
