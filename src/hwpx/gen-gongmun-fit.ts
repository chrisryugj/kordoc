/**
 * 공문서 모드 선계산 (generator.ts에서 분리).
 * 자동장평(orphan 줄 축소) 계획과 리스트 항목부호/깊이 사전 산출.
 */

import { type ResolvedGongmun, GongmunNumberer, computeSuppression, levelIndent, mmToHwpunit } from "./gongmun.js"
import { fitRatioForFewerLines } from "./text-metrics.js"
import { type MdBlock, parseInlineMarkdown } from "./md-runs.js"
import { CHAR_VARIANT_BASE, GONGMUN_BODY_RATIO, GONGMUN_LIST_LEVELS } from "./gen-ids.js"
import { parseChartFence } from "./chart-gen.js"

export interface GongmunFitPlan {
  /** blockIdx → 축소 장평(%) */
  ratioByBlock: Map<number, number>
  /** 등장한 고유 장평 목록(변형 charPr 발급 순서) */
  variants: number[]
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
  gongmunList: Map<number, { marker: string; depth: number }>,
): GongmunFitPlan | null {
  const minRatio = gongmun.autoFitMinRatio
  if (minRatio === null || minRatio >= GONGMUN_BODY_RATIO) return null
  const pageW = 59528 - mmToHwpunit(gongmun.margins.left) - mmToHwpunit(gongmun.margins.right)
  const ratioByBlock = new Map<number, number>()
  const variants: number[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let text: string
    let firstW: number
    let contW: number
    if (block.type === "list_item" && gongmunList.has(i)) {
      const { marker, depth } = gongmunList.get(i)!
      // 개조식 □(16pt)·※(13pt)는 본문 charPr(15pt) 계열이 아니라 변형 제외
      if (gongmun.numbering === "gaejosik" && (depth === 0 || (block.text || "").trimStart().startsWith("※"))) continue
      const content = plainRenderText(block.text || "")
      text = marker ? `${marker} ${content}` : content
      const li = levelIndent(depth, gongmun.bodyHeight, gongmun.numbering, gongmun.sizes, gongmun.bullet2, gongmun.preset === "press")
      // 부호 생략 항목은 내어쓰기 없는 전용 paraPr(GONGMUN_LIST_PLAIN_BASE) — indent 0
      const left = li.left
      const indent = marker ? li.indent : 0
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

/**
 * 공문서 모드 리스트 사전 처리 — 연속된 list_item run마다 단계별 부호 산출 +
 * 단일 형제 부호 생략. block 인덱스 → {marker, depth} 매핑 반환.
 */
export function precomputeGongmunList(
  blocks: MdBlock[],
  gongmun: ResolvedGongmun,
): Map<number, { marker: string; depth: number }> {
  const result = new Map<number, { marker: string; depth: number }>()
  // 개조식 적응 시프트 — h3가 □ 대항목을 차지하는 문서는 리스트가 ○부터 시작.
  // 법정 8단계 + h2 말머리 'number'(공고문)는 h2가 1단계(1. 2.)를 차지하므로
  // 리스트를 한 단계 내림(가.부터 + 1자 들여쓰기) — "1. 제목 / 1. 본문" 동일 부호
  // 중복은 규정 위계 위반 (v4.0.2 실무자 QA)
  const depthOffset =
    (gongmun.numbering === "gaejosik" && blocks.some((b) => b.type === "heading" && b.level === 3)) ||
    (gongmun.numbering === "standard" && gongmun.h2Marker === "number" && blocks.some((b) => b.type === "heading" && b.level === 2))
      ? 1
      : 0
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
    // 단일 형제 부호 생략(편람 규정)은 suppressSingle 옵트인 + 법정 번호(standard)에만.
    // 기본은 하나여도 부호 부여 — 부호 없는 계단 들여쓰기가 실무 눈에 어색 (v4.0.2 QA)
    const suppress = gongmun.suppressSingle && gongmun.numbering === "standard"
      ? computeSuppression(depths)
      : depths.map(() => false)
    const numberer = new GongmunNumberer(gongmun.numbering, gongmun.bullet2, gongmun.preset === "press")
    run.forEach((bi, k) => {
      const marker = numberer.next(depths[k], suppress[k])
      result.set(bi, { marker, depth: depths[k] })
    })
  }
  return result
}
