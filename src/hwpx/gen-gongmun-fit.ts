/**
 * 공문서 모드 선계산 (generator.ts에서 분리).
 * 자동장평(orphan 줄 축소) 계획과 리스트 항목부호/깊이 사전 산출.
 */

import { type ResolvedGongmun, GongmunNumberer, computeSuppression, levelMarkerHeight, hangulOrdinal, levelIndent, markerWidth, mmToHwpunit, usesAsteriskThird, usesReportFonts } from "./gongmun.js"
import { fitRatioForFewerLines } from "./text-metrics.js"
import { type MdBlock, parseInlineMarkdown } from "./md-runs.js"
import { CHAR_VARIANT_BASE, GONGMUN_BODY_RATIO, GONGMUN_LIST_LEVELS } from "./gen-ids.js"
import { A4_W_HU } from "./geometry.js"
import { parseChartFence } from "./chart-gen.js"

export interface GongmunFitPlan {
  /** blockIdx → 축소 장평(%) */
  ratioByBlock: Map<number, number>
  /** 등장한 고유 장평 목록(변형 charPr 발급 순서) */
  variants: number[]
}

/** 리스트 항목 하나의 선계산 결과 */
export interface GongmunListItem {
  marker: string
  depth: number
  /**
   * (depth, 부호폭) 전용 내어쓰기 paraPr 변형 인덱스 (GONGMUN_LIST_VARIANT_BASE + n).
   * depth 대표 부호('1.')보다 넓은 부호('10.'·'(10)')를 단 항목에만 부여 —
   * 공용 paraPr의 고정 내어쓰기로는 둘째 줄이 내용 첫 글자보다 왼쪽으로 어긋난다 (v4.0.5 P1-1)
   */
  indentVariant?: number
}

/** precomputeGongmunList 결과 — 항목 매핑 + 내어쓰기 변형 paraPr 스펙 */
export interface GongmunListPlan {
  items: Map<number, GongmunListItem>
  /** 변형 paraPr 발급 목록 (등장 순) — gen-header가 GONGMUN_LIST_VARIANT_BASE부터 방출 */
  indentVariants: Array<{ depth: number; widthHu: number }>
}

/** 렌더될 문자열(마크다운 강조 문법 제거) — 폭 계산용 */
function plainRenderText(text: string): string {
  return parseInlineMarkdown(text).map(s => s.text).join("")
}

/**
 * 문단별 자동 장평 계획 — 어절 줄바꿈 시뮬레이션으로 "장평을 줄이면 한 줄을
 * 아낄 수 있는" 문단을 찾아 95→minRatio 범위의 가장 큰 장평을 배정한다.
 * 대상: 일반 문단·항목(list_item). 제목/가운데정렬/코드/인용/표는 제외.
 */
export function computeGongmunFitPlan(
  blocks: MdBlock[],
  gongmun: ResolvedGongmun,
  gongmunList: GongmunListPlan,
): GongmunFitPlan | null {
  const minRatio = gongmun.autoFitMinRatio
  if (minRatio === null || minRatio >= GONGMUN_BODY_RATIO) return null
  const pageW = A4_W_HU - mmToHwpunit(gongmun.margins.left) - mmToHwpunit(gongmun.margins.right)
  const ratioByBlock = new Map<number, number>()
  const variants: number[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let text: string
    let firstW: number
    let contW: number
    if (block.type === "list_item" && gongmunList.items.has(i)) {
      const { marker, depth, indentVariant } = gongmunList.items.get(i)!
      // 개조식 □(16pt)·※(13pt)는 본문 charPr(15pt) 계열이 아니라 변형 제외
      if (gongmun.numbering === "gaejosik" && (depth === 0 || (block.text || "").trimStart().startsWith("※"))) continue
      // levels 오버라이드 단계는 전용 charPr(다른 크기·글꼴) — 본문 장평 변형 대상 아님 (v4.12.3)
      if (gongmun.levels?.[depth]) continue
      const content = plainRenderText(block.text || "")
      text = marker ? `${marker} ${content}` : content
      const li = levelIndent(depth, gongmun.bodyHeight, gongmun.numbering, gongmun.sizes, gongmun.bullet2, usesAsteriskThird(gongmun.preset))
      // 부호 생략 항목은 내어쓰기 없는 전용 paraPr(GONGMUN_LIST_PLAIN_BASE) — indent 0.
      // 내어쓰기 변형('10.'류)은 자기 부호폭 기준 (P1-1)
      const left = li.left
      const indent = marker
        ? (indentVariant !== undefined ? -gongmunList.indentVariants[indentVariant].widthHu : li.indent)
        : 0
      // 음수 intent(내어쓰기): 첫 줄은 left에서, 둘째 줄부터 left+|intent|에서 시작
      firstW = pageW - left - Math.max(indent, 0)
      contW = pageW - left - Math.max(-indent, 0)
    } else if (block.type === "paragraph") {
      const raw = (block.text || "").trim()
      if (/^<center>[\s\S]*<\/center>$/i.test(raw)) continue // 가운데정렬 — 대상 아님
      if (gongmun.numbering === "gaejosik" && raw.startsWith("※")) continue // ※ 참고(13pt) 제외
      text = plainRenderText(raw)
      firstW = contW = pageW
    } else {
      continue
    }
    if (!text) continue
    const r = fitRatioForFewerLines(text, firstW, contW, gongmun.bodyHeight, GONGMUN_BODY_RATIO, minRatio)
    if (r === null) continue
    ratioByBlock.set(i, r)
    if (!variants.includes(r)) variants.push(r)
  }
  return ratioByBlock.size > 0 ? { ratioByBlock, variants } : null
}

/** fit 계획에 따른 charPr id 매퍼 — 본문 계열(0~3)만 변형으로 치환.
 *  base: 변형 charPr 시작 id (개조식은 전용 charPr 뒤 — gen-ids charVariantBase) */
export function variantMapper(fit: GongmunFitPlan, blockIdx: number, base: number = CHAR_VARIANT_BASE): ((id: number) => number) | undefined {
  const r = fit.ratioByBlock.get(blockIdx)
  if (r === undefined) return undefined
  const vi = fit.variants.indexOf(r)
  return (id) => (id >= 0 && id <= 3 ? base + vi * 4 + id : id)
}

// 법정 8단계·보고서 불릿의 리터럴 부호 → depth 역산 테이블 (P2 재분류용).
// 한글 서수는 hangulOrdinal 정규 시퀀스(초성14×단모음6 조합 84자)만 인정 —
// '는.'·'를.' 같은 일반 음절 문두 오검출 방지.
const ORDINAL_SYLLABLES = new Set(Array.from({ length: 84 }, (_, i) => hangulOrdinal(i)))

/** 문단 선두 리터럴 부호 판독 — {depth, 부호 제거한 내용} 또는 null */
function literalMarkerDepth(text: string): { depth: number; content: string } | null {
  const t = text.trimStart()
  let m: RegExpExecArray | null
  if ((m = /^([가-힣])\.\s+(.*)$/s.exec(t)) && ORDINAL_SYLLABLES.has(m[1])) return { depth: 1, content: m[2] }
  if ((m = /^(\d{1,3})\)\s+(.*)$/s.exec(t))) return { depth: 2, content: m[2] }
  if ((m = /^([가-힣])\)\s+(.*)$/s.exec(t)) && ORDINAL_SYLLABLES.has(m[1])) return { depth: 3, content: m[2] }
  if ((m = /^\((\d{1,3})\)\s+(.*)$/s.exec(t))) return { depth: 4, content: m[2] }
  if ((m = /^\(([가-힣])\)\s+(.*)$/s.exec(t)) && ORDINAL_SYLLABLES.has(m[1])) return { depth: 5, content: m[2] }
  if ((m = /^([①-⑳㉑-㉟㊱-㊿])\s+(.*)$/s.exec(t))) return { depth: 6, content: m[2] }
  if ((m = /^([㉮-㉻])\s+(.*)$/s.exec(t))) return { depth: 7, content: m[2] }
  if ((m = /^□\s+(.*)$/s.exec(t))) return { depth: 0, content: m[1] }
  if ((m = /^[○ㅇ]\s+(.*)$/s.exec(t))) return { depth: 1, content: m[1] }
  if ((m = /^ㆍ\s+(.*)$/s.exec(t))) return { depth: 3, content: m[1] }
  return null
}

/**
 * 리터럴 부호 문단 → list_item 재분류 (blocks in-place, gongmun 모드 전용).
 * ※ 참고·<center>/<right> 지시 문단은 제외. depthOffset(공고문 h2 번호 등)을
 * 되돌려 최종 depth == 부호 종류의 법정 depth가 되게 한다.
 */
function reclassifyLiteralItems(blocks: MdBlock[], depthOffset: number): void {
  for (const b of blocks) {
    if (b.type !== "paragraph") continue
    const raw = (b.text || "").trimStart()
    if (!raw || raw.startsWith("※") || /^\*\s/.test(raw) || /^<(center|right)>/i.test(raw)) continue
    const lit = literalMarkerDepth(raw)
    if (!lit || !lit.content.trim()) continue
    b.type = "list_item"
    b.text = lit.content
    b.indent = Math.max(lit.depth - depthOffset, 0)
    b.ordered = lit.depth !== 0 // □만 불릿 취급 (renumber는 depth 기반이라 영향 없음)
  }
}

/**
 * 공문서 모드 리스트 사전 처리 — 연속된 list_item run마다 단계별 부호 산출 +
 * 단일 형제 부호 생략. block 인덱스 → {marker, depth} 매핑 반환.
 */
export function precomputeGongmunList(
  blocks: MdBlock[],
  gongmun: ResolvedGongmun,
): GongmunListPlan {
  const result = new Map<number, GongmunListItem>()
  // (depth, 부호폭) 내어쓰기 변형 — depth 대표 부호폭과 다른 항목('10.' 등 두 자리)에만.
  // key `${depth}:${width}` → indentVariants 인덱스
  const indentVariants: Array<{ depth: number; widthHu: number }> = []
  const variantIdx = new Map<string, number>()
  const variantOf = (marker: string, depth: number): number | undefined => {
    // 순번에 따라 부호폭이 변하는 체계는 법정 번호(standard)뿐 — 불릿(report·gaejosik)은
    // depth당 부호가 고정이고, 개조식 indent는 실측 체계(gaejosikLevelIndent)가 정본이다
    if (!marker || gongmun.numbering !== "standard") return undefined
    // 부호폭은 그 단계의 글자 크기(levels 오버라이드 반영)로 — 대표 부호와 같은 기준
    const h = levelMarkerHeight(gongmun, depth)
    const w = markerWidth(marker, h)
    const rep = -levelIndent(depth, gongmun.bodyHeight, gongmun.numbering, gongmun.sizes, gongmun.bullet2, usesAsteriskThird(gongmun.preset), h).indent
    if (w === rep) return undefined
    const key = `${depth}:${w}`
    let vi = variantIdx.get(key)
    if (vi === undefined) {
      vi = indentVariants.length
      indentVariants.push({ depth, widthHu: w })
      variantIdx.set(key, vi)
    }
    return vi
  }
  // 개조식 적응 시프트 — h3가 □ 대항목을 차지하는 문서는 리스트가 ○부터 시작.
  // 법정 8단계 + h2 말머리 'number'(공고문)는 h2가 1단계(1. 2.)를 차지하므로
  // 리스트를 한 단계 내림(가.부터 + 1자 들여쓰기) — "1. 제목 / 1. 본문" 동일 부호
  // 중복은 규정 위계 위반 (v4.0.2 실무자 QA)
  const depthOffset =
    (gongmun.numbering === "gaejosik" && blocks.some((b) => b.type === "heading" && b.level === 3)) ||
    (gongmun.numbering === "standard" && gongmun.h2Marker === "number" && blocks.some((b) => b.type === "heading" && b.level === 2))
      ? 1
      : 0
  // 리터럴 부호 문단 재분류 (v4.0.5 P2) — parse가 방출한 기존 공문서의 항목이
  // '가. 내용'·'1) 내용'·'□ 내용' 리터럴 문단으로 고착되면 2차 생성에서 8단계
  // 자동 재번호가 안 걸린다. 부호 종류로 depth를 역산해 list_item으로 복원한다.
  reclassifyLiteralItems(blocks, depthOffset)
  let i = 0
  while (i < blocks.length) {
    if (blocks[i].type !== "list_item") { i++; continue }
    // 연속 run 수집 — 항목 사이에 낀 표/수식은 run을 끊지 않는다 (공문 관행: 항목
    // 아래 근거 표·수식을 붙이고 다음 항목 번호가 이어짐 — 리뷰 #39 ·5).
    // 표/수식 뒤에 항목이 없으면 거기서 종료.
    // 항목 사이에 낀 표·수식·차트(실변환되는 chart 펜스)는 run 을 끊지 않는다. 변환 실패
    // (계열 0)한 chart 펜스는 일반 코드블록이므로 run 절단이 맞다 (gen-section 판정과 일치).
    const passThrough = (b: MdBlock): boolean =>
      b.type === "table" || b.type === "html_table" || b.type === "equation" ||
      (b.type === "code_block" && (b.lang || "").toLowerCase() === "chart" && parseChartFence(b.text || "") !== null)
    const run: number[] = []
    while (i < blocks.length) {
      const b = blocks[i]
      if (b.type === "list_item") { run.push(i); i++; continue }
      if (passThrough(b)) {
        let j = i + 1
        while (j < blocks.length && passThrough(blocks[j])) j++
        if (j < blocks.length && blocks[j].type === "list_item") { i = j; continue }
      }
      break
    }
    const depths = run.map((bi) => Math.min(Math.max((blocks[bi].indent || 0) + depthOffset, 0), GONGMUN_LIST_LEVELS - 1))
    // 실측 프리셋(measured)에서 ※ 시작 항목·'*' 마커 항목은 렌더가 참고(※) 문단으로
    // 빼내며 번호를 버린다(gen-section). 그 항목이 법정번호(standard) 카운터를 소비하면
    // 뒤 항목 번호가 건너뛰므로(1. → ※ → 3.), 번호매김·형제집계에서 함께 제외한다.
    const measured = usesReportFonts(gongmun.preset)
    const isRef = (bi: number): boolean =>
      measured && ((blocks[bi].text || "").trimStart().startsWith("※") || blocks[bi].marker === "*")
    const activeK = run.map((_, k) => k).filter((k) => !isRef(run[k]))
    const activeDepths = activeK.map((k) => depths[k])
    // 단일 형제 부호 생략(편람 규정)은 suppressSingle 옵트인 + 법정 번호(standard)에만.
    // 기본은 하나여도 부호 부여 — 부호 없는 계단 들여쓰기가 실무 눈에 어색 (v4.0.2 QA)
    const suppress = gongmun.suppressSingle && gongmun.numbering === "standard"
      ? computeSuppression(activeDepths)
      : activeDepths.map(() => false)
    const numberer = new GongmunNumberer(gongmun.numbering, gongmun.bullet2, usesAsteriskThird(gongmun.preset))
    // 참고 항목은 번호 없이 depth만 기록(fit 계획용), 비참고 항목만 순번 부여
    run.forEach((bi, k) => { if (isRef(run[k])) result.set(bi, { marker: "", depth: depths[k] }) })
    activeK.forEach((k, j) => {
      const marker = numberer.next(activeDepths[j], suppress[j])
      result.set(run[k], { marker, depth: depths[k], indentVariant: variantOf(marker, depths[k]) })
    })
  }
  return { items: result, indentVariants }
}
