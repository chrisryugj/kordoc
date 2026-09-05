#!/usr/bin/env node
// A-1: PDF 표 구조 채점 — 같은 문서 hwpx↔pdf 쌍(corpus/pairs/)에서 hwpx IR 표
// (hwpx 트랙 표 611/611·cellExact 1.0으로 신뢰 검증됨)를 GT로 pdf IR 표를 대조.
// coverage(텍스트 trigram)가 못 보는 구조 붕괴(2단 조판 사건 류)를 메우는 트랙.
//
// 주의: pdf는 페이지 단위로 표가 쪼개지고(분할표 병합 보정이 일부 흡수) 병합·머리글
// 표현이 hwpx와 다를 수 있어 만점이 목표가 아니다 — 무후퇴 플로어 감시.
//
// 기준선 (2026-07-11 11차: 적층 표 분리 — 경계선 공유 스트립+본표 절단 + 밴드별
// vertex 재계산): ref 표 69 | 매칭 0.985507 | exact 0.652174 | cellF1 0.727382 |
// cellExact 0.727941 | contentNED 0.530784
// (11차 개선: 채용공고 머리 스트립(업무명·직종 1행 표)이 응시원서 본표와 경계
//  수평선을 공유해 Union-Find가 22x10류 프랑켄 그리드로 묶던 것을, 컷 라인
//  판정(전폭 수평선 + 관통 논리 수직선 0 + 양쪽 독립 수직선 2+ + 내부 x-집합
//  비겹침)으로 절단 — pair05·07·08 응시원서 행 정렬 복구(cellExact +3.0pp).
//  관통 판정은 체인 뷰(맞닿은 세그먼트를 논리 수직선으로) — nrich 지원서처럼
//  외곽선을 섹션별 세그먼트로 그린 단일 표(gap 0 맞닿음)는 절단하지 않고, 별개
//  표 사이 실간격(실측 2.9pt+)만 가른다. 분리 밴드는 vertex를 자기 선으로 재계산
//  (공유 경계선 위 교차점이 반대편 표의 수직선 x를 나르던 열 오염 제거).
//  exact 불변 근거: 응시원서 잔여 열 편차는 GT(hwpx 통합그리드)의 유령 좁은 열
//  (섹션별 구분선 217.9/226.0을 별도 열로 모델링)과 본문 영역에 괘선 자체가 없는
//  열(460.7)로, ①병합 열 표현 차의 재확인 — 선 증거로 재현 불가.)
//
// 직전 기준선 (2026-07-03 10차: 강등 라벨헤더 가드 + 체인 뷰 합성 + 매칭 3픽스 +
// 모수 예외, 2회 동일): 매칭 0.985507 | exact 0.652174 | cellF1 0.724023 |
// cellExact 0.697712 | contentNED 0.523722
// (직전 기준선 매칭 0.9028/exact 0.5833/F1 0.6518/cellExact 0.6732/NED 0.4939 —
//  10차 개선: ①파서 강등 가드: 첫 행 전체가 마커 없는 짧은 라벨 + 본문 내용 ≥1셀
//    이면 텍스트 박스 강등 면제 — 본문 ○/ㅇ 항목부호(pair07 3x3)와 양식 빈
//    기입란(pair10 2x3)의 오강등 완치, pdf 코퍼스 14파일 문단→표 복구.
//  ②파서 체인 뷰: 개방 변 합성의 끝점 정렬 판정을 콜리니어 세그먼트를 이은 논리
//    괘선 기준으로 — 셀 단위로 쪼개 그은 괘선(pair06 문의처 2x4)도 그룹 합류.
//    물리 병합 아님 (9차 폐기 실험과 구분).
//  ③채점기: bag 교집합 0(양쪽 비어있지 않음) 매칭 차단 — dims-only 누수가 진짜
//    짝 선점+순서구제 봉쇄하던 것 해소 (pair06 제출서류 EXACT 복구, pair11 잡매칭
//    제거로 매칭 정직 −1). ④채점기: 전체 텍스트 접두 유사도 폴백 — 세밀 분할
//    프로즈 박스(pair06 결격사유 3x2→18x3, pdf측 후반부는 1열 표로 모수 밖) 구제.
//  ⑤모수 예외(사용자 승인): 흐름띠(화살표 단독 셀 ≥2)·거의 빈 표(비공백 ≤1셀)는
//    hwpx가 표를 레이아웃 도구로 쓴 표현 차 — 양측 대칭 제외 (72→69).
//  잔여 미매칭 1 = pair11 자가진단표 12x6: pdf에 수직선 4개뿐(체크박스 열 괘선
//  미출력)이라 파서 구제 불가급 — 수용. NED 상승은 문의처·결격사유 매칭의 정직한
//  셀 대조 편입에도 라벨 열 복구 이득이 큰 것.)
//
// 잔여 미달 성격 (2026-07-03 정밀 분석 — 개선 시도와 결론):
// ①병합 열 표현 차 = 1.5~3pt 미세 오프셋 경계를 GT(hwpx 그리드)가 문서마다 다르게
//   모델링 (pair06 응시원서는 12열로 분리 / pair08 신청서는 9열로 통합). 파서
//   tolerance를 내리면(coordMergeTol 8→1.5 실험) pair06 22x9→22x12로 GT 일치하지만
//   pair08 22x10→22x13 유령 열로 F1 0.373→0 붕괴 — pdf 쪽에서 두 경우를 구분할
//   증거가 없어 철회. 고정 임계값으론 원리적으로 불가한 표현 차로 분류.
// ②동의서류 평탄화 표현 차 — hwpx 외곽표+중첩표 vs pdf 단일 그리드 (매칭은 bagExtra로
//   회복, 셀 좌표 채점은 구조 차이를 그대로 반영). 가족채용확인서 19x14→5x2도 같은
//   계열 (10차 해부: 오매칭 아님 — 같은 서식의 부분 포착, pdf p16 선 15H/10V뿐)
// ③분할병합 보정 = 이 코퍼스에서 발동 대상 없음 (9차 실측: 페이지 분할 표가 없고,
//   파서 mergeCrossPageTables가 상류에서 흡수. rowsSum 머리글 가설은 기각 —
//   pair10 ref#15 +1행은 분할이 아니라 중첩표 평탄화였음)
// ④물리 세그먼트 병합·컴포넌트 단위 합성은 실측 부작용(pair07 지원서 셀 이동,
//   pair10 반환청구서 demote 연쇄)으로 보류 — 체인 뷰(판정 전용)가 대체 (10차)
//
// 사용법: node bench/pdf-table-gt.mjs [--gate] [--doc=부분문자열] [--verbose]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { irAnchors, scoreTables } from "./lib/table-score.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

// 무후퇴 플로어 (기준선 2026-07-11 11차: 매칭 0.985507 / exact 0.652174 / cellF1 0.727382
// / cellExact 0.727941 / NED 0.530784 — 적층 표 분리 후 상향 잠금)
// reorderedMax: 순서구제 무증가 플로어 (2026-07-05 실측 3 = pair06 2단 조판 정당 케이스).
//   순서구제가 공용 matchTables에 있어 표 방출순서 회귀가 재짝지음으로 green 위장 가능 (리뷰 #15)
// minPairs/minRefTables: 모수 하한 — 코퍼스 소실 시 rate(0/0)=1 조용한 만점 방지 (리뷰 #14)
// 상향 잠금 (2026-09-05 v4.12.2 실측: 매칭 1.0 / exact 0.855072 / cellF1 0.945306 / cellExact 0.979575 /
// NED 0.948432 — 클립 셀 그리드(v4.12.1) + 틀 셀 중첩표·1칸 틀 복원(v4.12.2). 직전 v4.12.1 실측
// cellF1 0.873·cellExact 0.945·NED 0.842 는 코드에 반영되지 않은 채 11차 플로어가 남아 있었다)
const GATES = { matchedRate: 0.98, exactRate: 0.85, cellF1: 0.94, cellExactRate: 0.97, contentNED: 0.94, parseErrors: 0, reorderedMax: 3, minPairs: 3, minRefTables: 35 }

const t0 = performance.now()
const dir = join(root, "corpus", "pairs")
const names = await readdir(dir)
const pairs = names
  .filter(n => n.endsWith(".pdf"))
  .map(n => n.replace(/\.pdf$/, ""))
  .filter(base => names.includes(base + ".hwpx"))
  .filter(base => !docFilter || base.includes(docFilter))
  .sort()

const rows = []
let parseErrors = 0
const agg = { refTables: 0, matched: 0, exact: 0, cellTotal: 0, cellExact: 0, contentNum: 0, contentDen: 0, f1Sum: 0, reordered: 0 }

for (const base of pairs) {
  const row = { pair: base }
  try {
    const hwpx = await parse(await readFile(join(dir, base + ".hwpx")), { filename: base + ".hwpx" })
    const pdf = await parse(await readFile(join(dir, base + ".pdf")), { filename: base + ".pdf" })
    if (!hwpx.success) throw new Error(`hwpx 파싱 실패: ${hwpx.error}`)
    if (!pdf.success) throw new Error(`pdf 파싱 실패: ${pdf.error}`)

    // 비교 모수 = 최상위 표 중 2행×2열 이상 (양쪽 동일 규칙).
    // 1×1은 래퍼/안내박스 관행이라 제외하되, 셀 안에 중첩표를 담은 래퍼(공문
    // "표 안에 표")는 중첩표를 비교 단위로 승격 (pdf는 래퍼 없이 안쪽 표를 감지).
    // N×1/1×N 스트립은 글상자·머리띠 관행으로 hwpx/pdf 표 의미가 갈리는 지점이라
    // 제외 — 구조 붕괴 신호는 2×2+ 그리드에서 나타나고, 텍스트 자체는 coverage
    // 트랙이 감시한다. 다중 셀 표의 중첩은 pdf가 부모 그리드로 평탄화하므로
    // 승격하지 않는다.
    // 다중 셀 표의 중첩표 텍스트 수집 (재귀) — 매칭 bag 보강용. pdf는 중첩을 부모
    // 그리드로 평탄화하므로 ref(hwpx) 쪽 bag에 중첩 텍스트를 합쳐야 같은 표로 본다.
    const nestedBagTexts = table => {
      const texts = []
      const seen = new Set()
      const walk = (t, depth = 0) => {
        if (depth > 12) return
        for (const row of t.cells ?? []) {
          for (const cell of row ?? []) {
            if (!cell || seen.has(cell)) continue
            seen.add(cell)
            for (const b of cell.blocks ?? []) {
              if (b.type === "table" && b.table) {
                for (const a of irAnchors(b.table).anchors) if (a.text) texts.push(a.text)
                walk(b.table, depth + 1)
              }
            }
          }
        }
      }
      walk(table)
      return texts
    }
    const topGrids = blocks => {
      const out = []
      const push = (table, depth = 0) => {
        if (depth > 12) return
        const { rows, cols, cells } = table
        if (rows === 1 && cols === 1) {
          for (const b of cells[0]?.[0]?.blocks ?? []) {
            if (b.type === "table" && b.table) push(b.table, depth + 1)
          }
          return
        }
        if (rows < 2 || cols < 2) return
        // 모수 예외 (10차, 사용자 승인): hwpx가 표를 레이아웃 도구로 쓴 표현 차 —
        // ⓐ흐름띠(화살표 단독 셀 ≥2: 채용공고⇒원서접수⇒…)는 도해라 pdf에 연결
        //   괘선이 없음 ⓑ거의 빈 표(비공백 셀 ≤1)는 겹쳐 얹은 글틀의 스캐폴딩.
        //   양측 대칭 적용 (ref·IR 같은 모수 정의)
        const flat = []
        for (const row of cells) for (const c of row ?? []) flat.push((c.text ?? "").trim())
        if (flat.filter(t => /^[⇒⇨⟹➡→⟶⇾]+$/.test(t)).length >= 2) return
        if (flat.filter(Boolean).length <= 1) return
        out.push({ ...irAnchors(table), bagExtra: nestedBagTexts(table) })
      }
      for (const b of blocks ?? []) if (b.type === "table" && b.table) push(b.table)
      return out
    }
    // ref = hwpx IR 그리드 (irAnchors의 anchors를 scoreTables ref 형태 cells로)
    const refGrids = topGrids(hwpx.blocks).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors, bagExtra: g.bagExtra }))
    const irGrids = topGrids(pdf.blocks)
    const s = scoreTables(refGrids, irGrids)

    row.ok = true
    row.refTables = s.tableCount
    row.pdfTables = s.irTableCount
    row.matched = s.tableCount - s.unmatchedRef
    row.exact = s.exactCount
    row.splitMerged = s.splitTables
    row.reordered = s.reordered
    row.textMatched = s.textMatched
    row.cellF1 = round(s.cellF1)
    row.cellExactRate = round(s.cellExactRate)
    row.contentNED = round(s.contentNED)
    row.unmatchedRef = s.unmatchedRef
    row.unmatchedIr = s.unmatchedIr
    if (verbose) row.details = s.details

    agg.refTables += s.tableCount
    agg.matched += row.matched
    agg.exact += s.exactCount
    agg.cellTotal += s.cellTotal
    agg.cellExact += s.cellExact
    agg.contentNum += s.contentNum
    agg.contentDen += s.contentDen
    agg.f1Sum += s.cellF1 * s.tableCount
    agg.reordered += s.reordered ?? 0
  } catch (err) {
    parseErrors++
    row.ok = false
    row.error = String(err?.message ?? err).slice(0, 160)
  }
  rows.push(row)
}

const summary = {
  pairs: rows.length,
  parseErrors,
  refTables: agg.refTables,
  reordered: agg.reordered,
  matchedRate: round(agg.refTables ? agg.matched / agg.refTables : 1),
  exactRate: round(agg.refTables ? agg.exact / agg.refTables : 1),
  cellF1: round(agg.refTables ? agg.f1Sum / agg.refTables : 1),
  cellExactRate: round(agg.cellTotal ? agg.cellExact / agg.cellTotal : 1),
  contentNED: round(agg.contentDen ? agg.contentNum / agg.contentDen : 1),
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(0)
console.log(`\n══ PDF 표 구조 GT — hwpx↔pdf ${rows.length}쌍 (${elapsed}s) ══`)
console.log(`  ref 표 ${summary.refTables} | 매칭 ${round(summary.matchedRate * 100, 2)}% | exact ${round(summary.exactRate * 100, 2)}%`)
console.log(`  cellF1 ${summary.cellF1} | cellExact ${summary.cellExactRate} | contentNED ${summary.contentNED}`)
for (const r of rows) {
  if (!r.ok) { console.log(`  ❌ ${r.pair}: ${r.error}`); continue }
  console.log(`  ${r.pair}: ref ${r.refTables} → 매칭 ${r.matched} (분할병합 ${r.splitMerged}·순서구제 ${r.reordered}·텍스트 ${r.textMatched}) exact ${r.exact} | F1 ${r.cellF1} NED ${r.contentNED} | pdf잉여 ${r.unmatchedIr}`)
}

// 게이트 판정 — 무후퇴 플로어 (2026-07-03 bench:gate 편입)
const gates = {
  matchedRate: { value: summary.matchedRate, threshold: GATES.matchedRate, pass: summary.matchedRate >= GATES.matchedRate },
  exactRate: { value: summary.exactRate, threshold: GATES.exactRate, pass: summary.exactRate >= GATES.exactRate },
  cellF1: { value: summary.cellF1, threshold: GATES.cellF1, pass: summary.cellF1 >= GATES.cellF1 },
  cellExactRate: { value: summary.cellExactRate, threshold: GATES.cellExactRate, pass: summary.cellExactRate >= GATES.cellExactRate },
  contentNED: { value: summary.contentNED, threshold: GATES.contentNED, pass: summary.contentNED >= GATES.contentNED },
  parseErrors: { value: parseErrors, threshold: GATES.parseErrors, pass: parseErrors <= GATES.parseErrors },
  reordered: { value: summary.reordered, threshold: GATES.reorderedMax, pass: summary.reordered <= GATES.reorderedMax },
  // 모수 하한 — 부분 실행(--doc)은 제외
  population: {
    value: `pairs ${summary.pairs}/refTables ${summary.refTables}`,
    threshold: `≥ ${GATES.minPairs}/${GATES.minRefTables}`,
    pass: docFilter != null || (summary.pairs >= GATES.minPairs && summary.refTables >= GATES.minRefTables),
  },
}
const pass = Object.values(gates).every(g => g.pass)
for (const [k, g] of Object.entries(gates)) {
  if (!g.pass) console.log(`  ❌ ${k} ${g.value} (기준 ${g.threshold})`)
}

await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "pdf-table.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, pass, gates, rows }, null, 1))
console.log(`report → bench/out/pdf-table.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
