/**
 * RAG용 구조 보존 청킹 — IRBlock[] → DocChunk[].
 *
 * 문서의 위계(마크다운 헤딩 스택 + 개조식 리스트 깊이)를 breadcrumb으로 보존한
 * 청크 목록을 만든다. 토큰 상한·오버랩 등 자르기 정책은 의도적으로 없다 —
 * "구조 트리 제공"까지가 이 모듈의 몫이고 실제 분할은 소비자(RAG 파이프라인)가 한다.
 *
 * breadcrumb 규칙:
 * - 헤딩(level 1~6)은 스택 구조 — 같거나 깊은 level을 팝하고 push, 리스트 위계 리셋
 * - 리스트 항목은 깊이 d 등장 시 depth>=d를 팝하고 push — 하위 항목이 뒤따르면
 *   그 breadcrumb으로 승격되고, 자식이 없으면 다음 형제/헤딩이 팝해 자연 소멸
 * - 깊이는 IR의 listDepth 그대로. listDepth가 없는 개조식 선두 부호 문단
 *   (□·○·- / 1.·가.·1) 등)은 depth 0 항목으로 취급 — IR에 없는 깊이는 지어내지 않는다
 * - 청크의 breadcrumb은 자기 자신을 제외한 상위 경로다
 */

import type { IRBlock } from "./types.js"
import { blocksToMarkdown } from "./table/builder.js"

export interface DocChunk {
  /** "c0001" 순번 id — 같은 입력이면 같은 출력 (결정적) */
  id: string
  type: "text" | "table" | "heading"
  /** 상위 헤딩 + 리스트 위계 경로 (예: ["1. 개요", "가. 목적"]) */
  breadcrumb: string[]
  /** 청크 본문 마크다운 — 표는 GFM/HTML 그대로 (blocksToMarkdown 재사용) */
  text: string
  /** 원본 페이지/섹션 번호 (1-based) — IR에 없으면 생략 */
  page?: number
  /** 원본 IRBlock 인덱스 범위 [start, end] (양끝 포함) — 출처 앵커 */
  blockRange: [number, number]
  /** 표 청크 전용 구조 요약 — cells는 includeTableCells 옵션 시에만 */
  table?: { rows: number; cols: number; cells?: string[][] }
}

export interface ChunkOptions {
  /** 표 청크에 셀 텍스트 행렬 포함 여부 (기본 false) */
  includeTableCells?: boolean
  /**
   * "section"(기본): 같은 breadcrumb 아래 연속 텍스트 블록을 하나로 병합,
   * "block": IRBlock 1개 = 청크 1개
   */
  granularity?: "block" | "section"
}

/**
 * 개조식/항목부호 선두 마커 — listDepth 미기재 리스트 항목의 depth 0 식별용.
 * gongmun 8단계 부호(1. 가. 1) 가) (1) (가) ① ㉮)와 개조식 글머리(□ ○ - ※ 등).
 * 파서는 md 문법과 충돌하는 부호('- '·'1) ')에만 listDepth(1~)를 채우므로,
 * depth 0 항목은 부호 텍스트로만 식별 가능하다 (승격이 동작하기 위한 최소 휴리스틱)
 */
const LIST_MARKER_RE =
  /^(?:[□■◇◆○◎●◦ㅇ•▪▸▶※-]|\d{1,3}[.)]|[가나다라마바사아자차카타파하][.)]|\([가나다라마바사아자차카타파하0-9]{1,3}\)|[①-⑳㉮-㉻㈎-㈛])\s/

/** 블록의 리스트 깊이 — 리스트 항목이 아니면 undefined */
function listDepthOf(block: IRBlock): number | undefined {
  if (block.listDepth !== undefined) return block.listDepth
  if (block.type === "list") return 0
  if (block.type === "paragraph" && block.text && LIST_MARKER_RE.test(block.text.trim())) return 0
  return undefined
}

function sameBreadcrumb(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function blocksToChunks(blocks: IRBlock[], options?: ChunkOptions): DocChunk[] {
  const granularity = options?.granularity ?? "section"
  const includeCells = options?.includeTableCells ?? false

  const chunks: DocChunk[] = []
  const headingStack: { level: number; text: string }[] = []
  const listStack: { depth: number; text: string }[] = []
  const crumb = () => [...headingStack.map(h => h.text), ...listStack.map(l => l.text)]

  const push = (
    type: DocChunk["type"],
    breadcrumb: string[],
    text: string,
    blockRange: [number, number],
    page?: number,
    table?: DocChunk["table"]
  ) => {
    const chunk: DocChunk = { id: "c" + String(chunks.length + 1).padStart(4, "0"), type, breadcrumb, text, blockRange }
    if (page !== undefined) chunk.page = page
    if (table) chunk.table = table
    chunks.push(chunk)
  }

  // section 병합 누적 상태 — 같은 breadcrumb의 연속 텍스트 블록
  let run: { breadcrumb: string[]; blocks: IRBlock[]; start: number; end: number; page?: number } | null = null
  const flushRun = () => {
    if (!run) return
    push("text", run.breadcrumb, blocksToMarkdown(run.blocks), [run.start, run.end], run.page)
    run = null
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const md = blocksToMarkdown([block])
    if (!md) continue // 빈 블록 스킵 — 스택에도 불참

    if (block.type === "heading") {
      flushRun()
      const level = Math.min(block.level || 2, 6) // blocksToMarkdown과 동일한 기본값
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop()
      listStack.length = 0 // 새 헤딩 = 리스트 위계 리셋
      push("heading", crumb(), md, [i, i], block.pageNumber)
      headingStack.push({ level, text: (block.text ?? "").trim() })
      continue
    }

    if (block.type === "table" && block.table) {
      // 표는 항상 독립 청크 — 병합 금지
      flushRun()
      const summary: NonNullable<DocChunk["table"]> = { rows: block.table.rows, cols: block.table.cols }
      if (includeCells) summary.cells = block.table.cells.map(row => row.map(c => c.text))
      push("table", crumb(), md, [i, i], block.pageNumber, summary)
      continue
    }

    // 텍스트 계열 (paragraph·list·image·separator)
    const depth = listDepthOf(block)
    if (depth !== undefined) {
      while (listStack.length && listStack[listStack.length - 1].depth >= depth) listStack.pop()
    }
    const breadcrumb = crumb()
    if (depth !== undefined) listStack.push({ depth, text: (block.text ?? "").trim() })

    if (granularity === "block") {
      push("text", breadcrumb, md, [i, i], block.pageNumber)
      continue
    }
    if (run && sameBreadcrumb(run.breadcrumb, breadcrumb)) {
      run.blocks.push(block)
      run.end = i
      if (run.page === undefined) run.page = block.pageNumber
    } else {
      flushRun()
      run = { breadcrumb, blocks: [block], start: i, end: i, page: block.pageNumber }
    }
  }
  flushRun()

  return chunks
}
