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
// 사용법: node bench/pdf-table-gt.mjs [--gate] [--doc=부분문자열] [--verbose] [--sets=pairs,korea-kr,korea-kr-pairs,korea-kr-pairs2,rhwp] [--no-ocr]
//
// 텍스트층 없음 모수 정책 (2026-09-24): PDF 텍스트층 한글이 HWPX 한글의 1% 미만인 쌍은 텍스트층 표 복원 채점이 성립하지
// 않는다 — rhwp 자체 렌더(cairo) PDF 13쌍은 한글을 채운 곡선 경로로 그려 텍스트층에 ASCII·기호만 있다(칸 글이 빈칸이라
// 맞는 표는 숫자·가림표(*) 칸 표의 우연). 이런 쌍은 텍스트층 트랙 모수(최상위·중첩표·세트별)에서 빼 목록·사유를 남기고,
// [텍스트층 없음·OCR] 보고 트랙에서 ocr:true 로 파싱해 같은 채점을 한다(OCR 모델이 없거나 --no-ocr 면 SKIP, 게이트 아님).
// HWPX 에도 한글이 없는 쌍(영문만 쓴 rhwp 조판 시험 3쌍)은 텍스트층이 온전하므로 그대로 둔다

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { irAnchors, scoreTables } from "./lib/table-score.mjs"
import { hwpxGeoGrids, toGeoAnchors } from "./lib/geo-grid.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null
const flagValue = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? "").split("=")[1] || d

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

// 무후퇴 플로어 (기준선 2026-07-11 11차: 매칭 0.985507 / exact 0.652174 / cellF1 0.727382
// / cellExact 0.727941 / NED 0.530784 — 적층 표 분리 후 상향 잠금)
// reorderedMax: 순서구제 무증가 플로어 (2026-07-05 실측 3 = pair06 2단 조판 정당 케이스).
//   순서구제가 공용 matchTables에 있어 표 방출순서 회귀가 재짝지음으로 green 위장 가능 (리뷰 #15)
// minPairs/minRefTables: 모수 하한 — 코퍼스 소실 시 rate(0/0)=1 조용한 만점 방지 (리뷰 #14)
// 상향 잠금 (2026-09-05 v4.12.2 실측: 매칭 1.0 / exact 0.855072 / cellF1 0.945306 / cellExact 0.979575 /
// NED 0.948432 — 클립 셀 그리드(v4.12.1) + 틀 셀 중첩표·1칸 틀 복원(v4.12.2). 직전 v4.12.1 실측
// cellF1 0.873·cellExact 0.945·NED 0.842 는 코드에 반영되지 않은 채 11차 플로어가 남아 있었다)
// 무후퇴 플로어 — 2026-09-23 모수 확대(6쌍 69표 → 430쌍 1,784표: korea-kr-pairs 202·rhwp 185 편입)와 기하 정답지·쪽 넘김 잇기
// 개편 뒤 실측값(매칭 0.9725·exact 0.9008·F1 0.9442·cellExact 0.9274·NED 0.7488·중첩 exact 0.6306) 바로 아래로 잠금
// 모수 하한 2026-09-24: 텍스트층 없음 13쌍(표 46·중첩표 27)을 모수에서 빼 417쌍 1,738표 — 하한을 같은 여유 비율로 내림
// (종전 425/1750 = 430/1784 의 98.8%/98.1%)
// 상향 잠금 (2026-09-24 읽기 품질 2차: 쪽 넘김 잇기·쪽을 넘는 칸·걸친 덮개·괘선 틈·비한컴 선 표 + 텍스트층 없는 13쌍 모수 제외 뒤,
// 417쌍 1,738표 실측 매칭 0.9885·exact 0.9453·F1 0.9722·cellExact 0.9698·NED 0.9031·중첩(130표) 매칭 0.9077·exact 0.8692 바로 아래로)
const GATES = { matchedRate: 0.985, exactRate: 0.94, cellF1: 0.97, cellExactRate: 0.965, contentNED: 0.9, parseErrors: 0, reorderedMax: 15, minPairs: 412, minRefTables: 1705, nestedMatchedRate: 0.9, nestedExactRate: 0.86 }
/** 텍스트층 없음: PDF 텍스트층 한글 / HWPX 한글 이 이 값 미만 (머리 주석 모수 정책) */
const NO_TEXT_LAYER_RATIO = 0.01
const hangulCount = s => (s?.match(/[가-힣]/g) ?? []).length
// OCR 트랙 — 모델이 있을 때만 (ocr-accuracy.mjs 와 같은 확인)
const modelDir = join(process.env.KORDOC_MODEL_CACHE?.trim() || join(homedir(), ".cache", "kordoc", "models"), "ppocr")
const ocrSkip = args.includes("--no-ocr") ? "--no-ocr"
  : ["det.onnx", "rec_korean.onnx", "rec_korean.yml"].every(f => existsSync(join(modelDir, f))) ? null : `OCR 모델 없음(${modelDir})`

const t0 = performance.now()
// 코퍼스 세트 — 같은 폴더의 동명 X.hwpx + X.pdf 짝을 하위 폴더까지 모은다. PDF 는 전부 한컴 산출물
// (pairs: 기관 게시 원본, korea-kr·korea-kr-pairs: 정책브리핑 첨부 "Hancom PDF 1.3", rhwp: 한글 2022
// OCX 변환) — hwpx IR 표를 GT 로 PDF 표 복원을 채점한다. --sets=pairs,rhwp 로 좁힐 수 있다
const SETS = flagValue("sets", "pairs,korea-kr,korea-kr-pairs,korea-kr-pairs2,rhwp").split(",").filter(Boolean)
async function* walkFiles(d) {
  let entries
  try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(d, e.name)
    if (e.isDirectory()) yield* walkFiles(p)
    else yield p
  }
}
const corpusRoot = join(root, "corpus")
const pairs = []
for (const set of SETS) {
  const files = new Set()
  for await (const f of walkFiles(join(corpusRoot, set))) files.add(f)
  for (const f of files) {
    if (!f.endsWith(".pdf")) continue
    const base = f.slice(0, -4)
    if (!files.has(base + ".hwpx")) continue
    const rel = relative(corpusRoot, base)
    if (docFilter && !rel.includes(docFilter)) continue
    pairs.push({ set, base, rel })
  }
}
pairs.sort((a, b) => a.rel.localeCompare(b.rel))

const rows = []
let parseErrors = 0
const newAgg = () => ({ pairs: 0, refTables: 0, matched: 0, exact: 0, cellTotal: 0, cellExact: 0, contentNum: 0, contentDen: 0, f1Sum: 0, reordered: 0 })
const agg = newAgg()
const setAgg = new Map(SETS.map(s => [s, newAgg()]))
const nestedAgg = newAgg()
// [텍스트층 없음·OCR] 트랙 — 같은 쌍의 텍스트층 채점(noText*)도 모아 나란히 보인다
const ocrRows = []
let ocrErrors = 0, ocrMs = 0
const ocrAgg = newAgg()
const ocrNestedAgg = newAgg()
const noTextAgg = newAgg()
const noTextNestedAgg = newAgg()

/** scoreTables 결과(최상위 s·중첩 ns) → 쌍 행 */
function fillRow(row, s, ns) {
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
  if (ns) {
    row.nested = { ref: ns.tableCount, matched: ns.tableCount - ns.unmatchedRef, exact: ns.exactCount, cellF1: round(ns.cellF1), cellExactRate: round(ns.cellExactRate), contentNED: round(ns.contentNED) }
    if (verbose) row.nestedDetails = ns.details
  }
}
function addScore(a, s) {
  a.pairs++
  a.refTables += s.tableCount
  a.matched += s.tableCount - s.unmatchedRef
  a.exact += s.exactCount
  a.cellTotal += s.cellTotal
  a.cellExact += s.cellExact
  a.contentNum += s.contentNum
  a.contentDen += s.contentDen
  a.f1Sum += s.cellF1 * s.tableCount
  a.reordered += s.reordered ?? 0
}

for (const { set, base, rel } of pairs) {
  const row = { pair: rel, set }
  try {
    const hwpxBytes = await readFile(base + ".hwpx")
    // 정답지는 기하 격자 — PDF 는 화면만 담아 HWPX 논리 열(행마다 폭이 다른 같은 열)을 되살릴 수 없다 (lib/geo-grid.mjs)
    const geo = await hwpxGeoGrids(hwpxBytes)
    const hwpx = await parse(Buffer.from(hwpxBytes), { filename: basename(base) + ".hwpx" })
    const pdf = await parse(await readFile(base + ".pdf"), { filename: basename(base) + ".pdf" })
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
    // 중첩표 트랙 — 여러 칸 표의 칸 안에 든 표(깊이 무관)를 최상위 트랙과 따로 모아 따로 매칭·채점한다.
    // 모수 규칙은 최상위와 같다(1×1 틀은 안쪽 표로 승격, 2×2 이상, 흐름띠·거의 빈 표 제외)
    const topGrids = (blocks, geoOf = null, nestedOut = null) => {
      const out = []
      const push = (table, depth = 0, into = out) => {
        if (depth > 12) return
        const { rows, cols, cells } = table
        if (rows === 1 && cols === 1) {
          for (const b of cells[0]?.[0]?.blocks ?? []) {
            if (b.type === "table" && b.table) push(b.table, depth + 1, into)
          }
          return
        }
        // 모수에서 빠지는 표(띠·흐름띠·거의 빈 표)도 칸 안 표는 중첩표 트랙에 든다
        const walkNested = () => {
          if (!nestedOut) return
          for (const row of cells) for (const c of row ?? []) for (const b of c?.blocks ?? []) {
            if (b.type === "table" && b.table) push(b.table, depth + 1, nestedOut)
          }
        }
        if (rows < 2 || cols < 2) return walkNested()
        // 모수 예외 (10차, 사용자 승인): hwpx가 표를 레이아웃 도구로 쓴 표현 차 —
        // ⓐ흐름띠(화살표 단독 셀 ≥2: 채용공고⇒원서접수⇒…)는 도해라 pdf에 연결
        //   괘선이 없음 ⓑ거의 빈 표(비공백 셀 ≤1)는 겹쳐 얹은 글틀의 스캐폴딩.
        //   양측 대칭 적용 (ref·IR 같은 모수 정의)
        // 셀 글은 채점(irAnchors cellOwnText)과 같은 기준 — 그림 참조(![image]·<img>)는 글이 아니다.
        // 종전엔 text(그림 참조 포함)로 세어 사진만 든 격자(보도자료 현장 사진 3×2)가 모수에 들어왔는데,
        // 채점 앵커는 전부 빈 칸이라 짝이 될 PDF 표(글 없는 클립 격자는 빈 표로 버려짐)가 없는 비대칭이었다
        const flat = []
        for (const row of cells) for (const c of row ?? []) flat.push((c.text ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img\b[^>]*>/gi, "").trim())
        if (flat.filter(t => /^[⇒⇨⟹➡→⟶⇾]+$/.test(t)).length >= 2) return walkNested()
        if (flat.filter(Boolean).length <= 1) return walkNested()
        const logical = irAnchors(table)
        const g = geoOf && table.sourceId ? toGeoAnchors(logical, geoOf.get(table.sourceId), table) : null
        into.push({ ...(g ?? logical), bagExtra: nestedBagTexts(table) })
        walkNested()
      }
      for (const b of blocks ?? []) if (b.type === "table" && b.table) push(b.table)
      return out
    }
    // ref = hwpx IR 그리드 (irAnchors의 anchors를 scoreTables ref 형태 cells로)
    const refNested = [], irNested = []
    const refGrids = topGrids(hwpx.blocks, geo, refNested).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors, bagExtra: g.bagExtra }))
    const irGrids = topGrids(pdf.blocks, null, irNested)
    const s = scoreTables(refGrids, irGrids)
    // 중첩표 — PDF 도 칸 안에 든 표만 짝 후보다 (최상위로 빠져나온 표는 자리를 잃은 것이라 맞힌 것으로 치지 않는다)
    const refNestedGrids = refNested.map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors, bagExtra: g.bagExtra }))
    const ns = refNested.length ? scoreTables(refNestedGrids, irNested) : null
    fillRow(row, s, ns)

    // 텍스트층 없음 — 텍스트층 트랙 모수에서 빼고 OCR 트랙으로 (머리 주석 모수 정책)
    const hwpxHangul = hangulCount(hwpx.markdown), pdfHangul = hangulCount(pdf.markdown)
    if (hwpxHangul > 0 && pdfHangul < hwpxHangul * NO_TEXT_LAYER_RATIO) {
      row.noTextLayer = { pdfHangul, hwpxHangul }
      addScore(noTextAgg, s)
      if (ns) addScore(noTextNestedAgg, ns)
      if (!ocrSkip) {
        const orow = { pair: rel, set }
        try {
          const t = performance.now()
          const ocr = await parse(await readFile(base + ".pdf"), { filename: basename(base) + ".pdf", ocr: true })
          ocrMs += performance.now() - t
          orow.sec = round((performance.now() - t) / 1000, 1)
          if (!ocr.success) throw new Error(`pdf OCR 파싱 실패: ${ocr.error}`)
          const oNested = []
          const os = scoreTables(refGrids, topGrids(ocr.blocks, null, oNested))
          const ons = refNested.length ? scoreTables(refNestedGrids, oNested) : null
          fillRow(orow, os, ons)
          orow.ocrPages = (ocr.pageQuality ?? []).filter(q => q.ocrApplied).length
          orow.pages = ocr.pageQuality?.length ?? 0
          addScore(ocrAgg, os)
          if (ons) addScore(ocrNestedAgg, ons)
        } catch (err) {
          ocrErrors++
          orow.ok = false
          orow.error = String(err?.message ?? err).slice(0, 160)
        }
        ocrRows.push(orow)
      }
    } else {
      if (ns) addScore(nestedAgg, ns)
      for (const a of [agg, setAgg.get(set)]) addScore(a, s)
    }
  } catch (err) {
    parseErrors++
    row.ok = false
    row.error = String(err?.message ?? err).slice(0, 160)
  }
  rows.push(row)
}

const summarize = a => ({
  pairs: a.pairs,
  refTables: a.refTables,
  reordered: a.reordered,
  matchedRate: round(a.refTables ? a.matched / a.refTables : 1),
  exactRate: round(a.refTables ? a.exact / a.refTables : 1),
  cellF1: round(a.refTables ? a.f1Sum / a.refTables : 1),
  cellExactRate: round(a.cellTotal ? a.cellExact / a.cellTotal : 1),
  contentNED: round(a.contentDen ? a.contentNum / a.contentDen : 1),
})
const noTextRows = rows.filter(r => r.noTextLayer)
const trackRows = rows.filter(r => !r.noTextLayer)
const summary = { ...summarize(agg), pairs: trackRows.length, parseErrors, nested: summarize(nestedAgg) }
const bySet = Object.fromEntries([...setAgg].filter(([, a]) => a.pairs > 0).map(([s, a]) => [s, summarize(a)]))
const noTextLayer = {
  textLayer: { ...summarize(noTextAgg), nested: summarize(noTextNestedAgg) },
  pairs: noTextRows.map(r => ({ pair: r.pair, pdfHangul: r.noTextLayer.pdfHangul, hwpxHangul: r.noTextLayer.hwpxHangul, refTables: r.refTables, nestedRef: r.nested?.ref ?? 0 })),
}
const ocrTrack = ocrSkip || !noTextRows.length
  ? { skipped: ocrSkip ?? "대상 없음" }
  : { ...summarize(ocrAgg), errors: ocrErrors, sec: round(ocrMs / 1000, 1), nested: summarize(ocrNestedAgg), rows: ocrRows }

const elapsed = ((performance.now() - t0) / 1000).toFixed(0)
console.log(`\n══ PDF 표 구조 GT — hwpx↔pdf ${trackRows.length}쌍 (${elapsed}s) ══`)
console.log(`  ref 표 ${summary.refTables} | 매칭 ${round(summary.matchedRate * 100, 2)}% | exact ${round(summary.exactRate * 100, 2)}%`)
console.log(`  cellF1 ${summary.cellF1} | cellExact ${summary.cellExactRate} | contentNED ${summary.contentNED}`)
for (const [s, v] of Object.entries(bySet)) {
  console.log(`  [${s}] ${v.pairs}쌍 표 ${v.refTables} | 매칭 ${round(v.matchedRate * 100, 2)}% exact ${round(v.exactRate * 100, 2)}% | F1 ${v.cellF1} cellExact ${v.cellExactRate} NED ${v.contentNED}`)
}
{
  const v = summary.nested
  console.log(`  [중첩표] ${v.pairs}쌍 표 ${v.refTables} | 매칭 ${round(v.matchedRate * 100, 2)}% exact ${round(v.exactRate * 100, 2)}% | F1 ${v.cellF1} cellExact ${v.cellExactRate} NED ${v.contentNED}`)
}
if (noTextRows.length) {
  const line = (label, v) => console.log(`  [${label}] ${v.pairs}쌍 표 ${v.refTables} | 매칭 ${round(v.matchedRate * 100, 2)}% exact ${round(v.exactRate * 100, 2)}% | F1 ${v.cellF1} cellExact ${v.cellExactRate} NED ${v.contentNED}`)
  console.log(`  [텍스트층 없음] ${noTextRows.length}쌍 표 ${noTextLayer.textLayer.refTables}·중첩표 ${noTextLayer.textLayer.nested.refTables} — 텍스트층 트랙 모수 제외 (PDF 텍스트층 한글 < HWPX 한글의 ${NO_TEXT_LAYER_RATIO * 100}%)`)
  line("텍스트층 없음·텍스트층 채점(참고)", noTextLayer.textLayer)
  if (ocrTrack.skipped) console.log(`  [텍스트층 없음·OCR] SKIP — ${ocrTrack.skipped}`)
  else {
    line("텍스트층 없음·OCR", ocrTrack)
    line("텍스트층 없음·OCR 중첩표", ocrTrack.nested)
    console.log(`    OCR ${ocrRows.reduce((s, r) => s + (r.ocrPages ?? 0), 0)}/${ocrRows.reduce((s, r) => s + (r.pages ?? 0), 0)}쪽 ${ocrTrack.sec}s${ocrErrors ? ` · 실패 ${ocrErrors}` : ""}`)
  }
}
// 쌍별 — 완전 일치(표 전부 exact·NED 1)는 줄여서, 나머지는 나쁜 순으로
const perfect = trackRows.filter(r => r.ok && r.exact === r.refTables && r.matched === r.refTables && r.contentNED === 1)
const others = trackRows.filter(r => !perfect.includes(r)).sort((a, b) => (a.ok ? a.cellF1 : -1) - (b.ok ? b.cellF1 : -1))
for (const r of others) {
  if (!r.ok) { console.log(`  ❌ ${r.pair}: ${r.error}`); continue }
  console.log(`  ${r.pair}: ref ${r.refTables} → 매칭 ${r.matched} (분할병합 ${r.splitMerged}·순서구제 ${r.reordered}·텍스트 ${r.textMatched}) exact ${r.exact} | F1 ${r.cellF1} NED ${r.contentNED} | pdf잉여 ${r.unmatchedIr}`)
}
console.log(`  (완전 일치 ${perfect.length}쌍 생략 — 표 ${perfect.reduce((s, r) => s + r.refTables, 0)})`)
// 텍스트층 없음 쌍 — 텍스트층 채점(참고) → OCR 채점
for (const r of noTextRows) {
  const o = ocrRows.find(x => x.pair === r.pair)
  const ocrPart = !o ? "" : o.ok ? ` → OCR(${o.ocrPages}/${o.pages}쪽) 매칭 ${o.matched} exact ${o.exact} F1 ${o.cellF1} NED ${o.contentNED}${o.nested ? ` 중첩 ${o.nested.exact}/${o.nested.ref}` : ""}` : ` → OCR ❌ ${o.error}`
  console.log(`  ◌ ${r.pair} (PDF 한글 ${r.noTextLayer.pdfHangul}/HWPX ${r.noTextLayer.hwpxHangul}): ref ${r.refTables} 텍스트층 exact ${r.exact} F1 ${r.cellF1} NED ${r.contentNED}${r.nested ? ` 중첩 ${r.nested.exact}/${r.nested.ref}` : ""}${ocrPart}`)
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
  nestedMatchedRate: { value: summary.nested.matchedRate, threshold: GATES.nestedMatchedRate, pass: docFilter != null || summary.nested.matchedRate >= GATES.nestedMatchedRate },
  nestedExactRate: { value: summary.nested.exactRate, threshold: GATES.nestedExactRate, pass: docFilter != null || summary.nested.exactRate >= GATES.nestedExactRate },
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
await writeFile(join(root, "out", "pdf-table.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sets: SETS, summary, bySet, noTextLayer, ocrTrack, pass, gates, rows }, null, 1))
console.log(`report → bench/out/pdf-table.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
