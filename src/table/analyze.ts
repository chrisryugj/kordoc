/**
 * 표 분류 배선 (#76 Task 3·5) — 파싱이 끝난 IRBlock 트리를 재귀하며 `IRTable.classification` 을 붙인다.
 * 원문 순서·셀 텍스트·캡션은 건드리지 않는다(메타만 추가). 기본 parse 는 이 함수를 부르지 않는다(opt-in).
 */

import type { IRBlock, IRTable } from "../types.js"
import { classifyTable } from "./classifier.js"
import { hasStructuredCellContent } from "./builder.js"

function hasMerged(table: IRTable): boolean {
  return table.cells.some(row => row.some(c => c.colSpan > 1 || c.rowSpan > 1))
}

/** 앞뒤 문단 텍스트(도표 문맥) 를 모아 분류 — 형제 블록 기준 */
function classifyInList(blocks: IRBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === "table" && b.table) {
      const near: string[] = []
      for (const j of [i - 2, i - 1, i + 1]) { const n = blocks[j]; if (n && n.type !== "table" && n.text) near.push(n.text) }
      b.table.classification = classifyTable(b.table, { nearbyText: near })
      // 재귀 — 셀 blocks·캡션 blocks. 부모 분류가 자식을 덮어쓰지 않는다
      for (const row of b.table.cells) for (const cell of row) if (cell.blocks) classifyInList(cell.blocks)
      if (b.table.captionBlocks) classifyInList(b.table.captionBlocks)
    }
    if (b.children) classifyInList(b.children)
  }
}

/** 트리 전체 분류(변경은 classification 필드 추가뿐). 같은 배열을 돌려준다 */
export function classifyTableTree(blocks: IRBlock[]): IRBlock[] {
  classifyInList(blocks)
  return blocks
}

export type TableRepresentation = "gfm" | "html" | "visual"

/**
 * 분류 인식 표현 정책 — `visual` 은 명시 요청(스마트 시각 출력)에서만 나온다. 기본 마크다운 경로는 이 함수를 쓰지 않는다.
 *   단순 의미표 → gfm(손실 없을 때) · 구조 셀/병합 → html · non-tabular(+smart) → visual · uncertain(+smart) → html(구조)+시각은 호출자
 */
export function chooseTableRepresentation(table: IRTable, opts: { smartVisual?: boolean } = {}): TableRepresentation {
  const structured = hasMerged(table) || hasStructuredCellContent(table)
  if (opts.smartVisual && table.classification?.kind === "non-tabular-layout") return "visual"
  return structured ? "html" : "gfm"
}
