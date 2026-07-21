/**
 * HWPX 표 구성 (parser.ts에서 분리).
 * TableState → IRTable 변환(셀 메타 재부착)과 </tbl> 완료 공통 처리.
 */

import { buildTable, convertTableToText } from "../table/builder.js"
import type { IRBlock, IRCell, IRTable } from "../types.js"
import type { CellCtxEx, TableState, WalkCtx } from "./parser-shared.js"

/**
 * TableState → IRTable 변환 — 캡션·셀 blocks(중첩표/이미지)·제목셀을 함께 attach (v3.0).
 * buildTable이 CellContext의 확장 필드를 복사하지 않으므로 cellAddr 좌표
 * (없으면 텍스트+스팬 매칭)로 결과 IRCell을 찾아 재부착한다.
 */
function buildTableWithCellMeta(state: TableState, keepAnchoredEmptyCols?: boolean): IRTable {
  const table = buildTable(state.rows, { keepAnchoredEmptyCols })
  if (state.caption) table.caption = state.caption

  // 서수 폴백용 앵커 목록 (row-major, 병합 커버 칸 제외) — 소스 tc 수와 1:1일 때만 신뢰
  const anchors: IRCell[] = []
  {
    const covered = new Set<string>()
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        if (covered.has(`${r},${c}`)) continue
        const cell = table.cells[r]?.[c]
        if (!cell) continue
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            if (dr === 0 && dc === 0) continue
            if (r + dr < table.rows && c + dc < table.cols) covered.add(`${r + dr},${c + dc}`)
          }
        }
        anchors.push(cell)
        c += cell.colSpan - 1
      }
    }
  }
  const srcCount = state.rows.reduce((s, r) => s + r.length, 0)
  const ordinalReliable = anchors.length === srcCount

  const claimed = new Set<IRCell>()
  let flatIdx = -1
  for (const row of state.rows) {
    for (const src of row as CellCtxEx[]) {
      flatIdx++
      // 구조(중첩표·이미지) 또는 왕복 채널 span 문단(v4.0.4)이 있어야 blocks를 나른다 —
      // 평문 셀은 text 평탄화로 충분 (blocks 무게 억제)
      const needsBlocks = !!src.blocks && src.blocks.length > 0
        && (src.hasStructure || src.blocks.some(b => b.spans))
      if (!needsBlocks && !src.isHeader) continue

      // 1순위: cellAddr 절대좌표 (HWPX 표준은 항상 cellAddr 제공)
      let target: IRCell | undefined
      const trimmed = src.text.trim()
      if (src.rowAddr !== undefined && src.colAddr !== undefined) {
        const cand = table.cells[src.rowAddr]?.[src.colAddr]
        if (cand && cand.text === trimmed && !claimed.has(cand)) target = cand
      }
      // 2순위: 텍스트+스팬 매칭 (cellAddr 없는 비표준 파일)
      if (!target) {
        outer: for (const irRow of table.cells) {
          for (const cand of irRow) {
            if (!claimed.has(cand) && cand.text === trimmed && cand.colSpan === src.colSpan && cand.rowSpan === src.rowSpan) {
              target = cand
              break outer
            }
          }
        }
      }
      // 3순위: 서수 폴백 — 동일 텍스트 중복/스팬 불일치로 못 찾은 셀의 blocks 유실 방지
      // (소스 tc 순서 ↔ 앵커 순서가 1:1일 때만 — 그 외엔 오부착이 유실보다 나쁨)
      if (!target && ordinalReliable) {
        const cand = anchors[flatIdx]
        if (cand && !claimed.has(cand)) target = cand
      }
      if (!target) continue
      claimed.add(target)
      if (needsBlocks) target.blocks = src.blocks
      if (src.isHeader) target.isHeader = true
    }
  }
  return table
}

/**
 * </tbl> 완료 처리 공통 로직 — walkSection/walkParagraphChildren 중복 제거.
 * 중첩표는 부모 IRCell.blocks에 IRBlock(type:'table')로 보존하고(v3.0 — 호이스팅/평탄화 제거),
 * 셀 텍스트에는 하위 호환용 평탄화 텍스트를 남긴다. 최상위 표는 블록으로 추가.
 */
export function completeTable(
  newTable: TableState,
  tableStack: TableState[],
  blocks: IRBlock[],
  ctx: WalkCtx
): TableState | null {
  const parentTable = tableStack.length > 0 ? tableStack.pop()! : null
  if (newTable.rows.length === 0) {
    if (newTable.caption) blocks.push({ type: "paragraph", text: newTable.caption, pageNumber: ctx.sectionNum })
    return parentTable
  }
  const ir = buildTableWithCellMeta(newTable, ctx.shared.keepTrailingEmptyCols)
  const block: IRBlock = { type: "table", table: ir, pageNumber: ctx.sectionNum }
  if (parentTable?.cell) {
    const cell = parentTable.cell
    ;(cell.blocks ??= []).push(block)
    cell.hasStructure = true
    // 하위 호환: IRCell.text는 blocks의 평탄화 텍스트를 포함한다
    let flat = convertTableToText(newTable.rows)
    if (newTable.caption) flat = newTable.caption + (flat ? "\n" + flat : "")
    if (flat) {
      // 글자취급(treatAsChar="1") 표는 앞뒤 텍스트와 같은 줄에 놓인다 — 인라인 줄이
      // 열려 있으면 공백으로 잇는다 (#52 후속). 블록/float 표(inline=false)나 문단
      // 첫 항목(lineOpen=false)은 종전대로 `\n`으로 분리한다.
      const inlineJoin = newTable.inline === true && cell.lineOpen === true
      cell.text += (cell.text ? (inlineJoin ? " " : "\n") : "") + flat
      cell.lineOpen = newTable.inline === true
    }
  } else {
    // 부모 표의 셀 밖(비정상 경로) 또는 최상위 — 블록으로 추가
    blocks.push(block)
  }
  return parentTable
}
