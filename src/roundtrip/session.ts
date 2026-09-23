/**
 * HWPX 문서 세션 — 에디터 통합용 블록 단위 증분 패치 API (v3.1).
 *
 * patchHwpx가 "편집된 마크다운 전체"를 받아 내부에서 LCS 정렬하는 것과 달리,
 * 세션은 블록 인덱스로 직접 편집을 지정한다 (에디터의 블록 클릭-편집에 대응).
 *
 * 설계 원칙:
 * - 매핑은 patcher와 동일한 알고리즘 재사용 (정규화 텍스트 버킷 + 표 서수) —
 *   "n회 연속 patchBlocks ≡ 일괄 patchHwpx" 동등성이 성립하는 근거.
 * - 패치 후 상태는 새 바이트에서 전체 재구축 (오프셋 리베이스 대신 재스캔 —
 *   성능보다 정합성). patchBlocks 호출 후 이전 블록 인덱스는 무효이며
 *   session.blocks를 다시 읽어야 한다.
 * - capability()는 patcher의 graceful-skip 게이트를 사전 판정으로 노출 —
 *   에디터가 편집 전에 잠금 UI를 띄울 수 있는 단일 진실 소스.
 */

import JSZip from "jszip"
import { parseHwpxDocument } from "../hwpx/parser.js"
import type { IRBlock, IRTable, PatchOptions, PatchResult, PatchSkip, DiffResult } from "../types.js"
import {
  scanSectionXml, buildParagraphSplices, applySplices, allLinesegRemovalSplices,
  type SectionScan, type ScanTable, type SpliceEdit,
} from "./source-map.js"
import { patchZipEntries } from "./zip-patch.js"
import { resolveSectionEntryNames } from "./hwpx-entries.js"
import {
  resolveParagraphMappings, removeNoteMarks, buildTableOrdinals, buildOrigUnits, diffUnitLists,
  type ParaMapping,
} from "./patcher.js"
import { applyCellEdit, stripCellTokens, extractCellTokens } from "./table-patch.js"
import { splitMarkdownUnits, normForMatch, sanitizeText, summarize, AUTONUM_PREFIX_RE } from "./markdown-units.js"

// ─── 공개 타입 ───────────────────────────────────────

/** 블록 편집 가능성 — 에디터 잠금 UI의 근거 */
export type BlockCapability = "text" | "cell-text" | "locked"

export interface CellCapability {
  editable: boolean
  /** 편집 불가 사유 (한국어) */
  reason?: string
}

export interface BlockCapabilityInfo {
  capability: BlockCapability
  /** locked 사유 (한국어) */
  reason?: string
  /** 표 블록: IRTable 격자 좌표(row×col)별 셀 편집 가능 여부 */
  cells?: CellCapability[][]
}

/** 블록 → 원본 위치 참조 (에디터 하이라이트/점프용) */
export interface BlockSourceRef {
  kind: "paragraph" | "table"
  /** 0-based 섹션 인덱스 */
  sectionIndex: number
  /** 섹션 XML 내 시작 문자 오프셋 (<hp:p>/<hp:tbl> 여는 태그) */
  xmlStart: number
}

/** 블록 단위 편집 — patchBlocks 입력 */
export interface BlockEdit {
  /** session.blocks 기준 0-based 블록 인덱스 */
  blockIndex: number
  /**
   * 문단/헤딩 블록의 새 텍스트 (평문).
   * 빈 문자열(비우기)은 미지원 — patchHwpx의 "블록 삭제 미지원"과 정합
   * (비우면 재파싱 시 블록 핸들이 사라져 세션으로 복구 불가).
   */
  newText?: string
  /** 표 블록의 셀 편집 (IRTable 격자 좌표 기준). 이미지가 든 셀은 이미지
   *  토큰(`![image](...)`/`[이미지: ...]`)을 유지한 채 텍스트만 수정해야 한다. */
  cells?: Array<{ row: number; col: number; text: string }>
}

// ─── 내부 상태 ───────────────────────────────────────

interface SessionState {
  bytes: Uint8Array
  blocks: IRBlock[]
  markdown: string
  sectionPaths: string[]
  scans: SectionScan[]
  paraMap: Map<number, ParaMapping>
  scanTables: ScanTable[]
  tableOrdinals: Map<number, number>
  /** 여러 마크다운 유닛으로 갈라지는 블록 (부분 수정 불가) */
  fragmentBlocks: Set<number>
}

async function buildState(bytes: Uint8Array): Promise<SessionState> {
  const parsed = await parseHwpxDocument(u8ToArrayBuffer(bytes))
  const zip = await JSZip.loadAsync(bytes)
  const sectionPaths = await resolveSectionEntryNames(zip)
  if (sectionPaths.length === 0) {
    throw new Error("HWPX 섹션 파일을 찾을 수 없습니다")
  }
  const scans: SectionScan[] = []
  for (let i = 0; i < sectionPaths.length; i++) {
    const xml = await zip.file(sectionPaths[i])!.async("text")
    scans.push(scanSectionXml(xml, i))
  }
  const paraMap = resolveParagraphMappings(parsed.blocks, scans)
  const scanTables = scans.flatMap(s => s.tables.filter(t => t.rows.length > 0))
  const tableOrdinals = buildTableOrdinals(parsed.blocks)
  const fragmentBlocks = new Set<number>()
  const unitBlocks = new Set<number>()
  for (const u of buildOrigUnits(parsed.blocks)) {
    unitBlocks.add(u.blockIdx)
    if (u.fragment) fragmentBlocks.add(u.blockIdx)
  }
  // 유닛이 없는 문단/헤딩 블록 = [별표] 병합 등으로 다른 블록 유닛에 흡수됨 —
  // patchHwpx가 fragment로 skip하는 영역이므로 세션도 잠가 동등성 유지
  for (let i = 0; i < parsed.blocks.length; i++) {
    const b = parsed.blocks[i]
    if ((b.type === "paragraph" || b.type === "heading") && b.text && !unitBlocks.has(i)) {
      fragmentBlocks.add(i)
    }
  }
  return {
    bytes, blocks: parsed.blocks, markdown: parsed.markdown,
    sectionPaths, scans, paraMap, scanTables, tableOrdinals, fragmentBlocks,
  }
}

function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/** IR 셀 텍스트 → 마크다운 렌더와 동일 규칙의 비어있지 않은 라인들 */
function irCellLines(text: string): string[] {
  return stripCellTokens(sanitizeText(text)).split("\n").map(s => s.trim()).filter(Boolean)
}

// ─── 세션 ────────────────────────────────────────────

export class HwpxSession {
  private state: SessionState

  private constructor(state: SessionState) {
    this.state = state
  }

  /** HWPX 바이트로 세션을 연다 (입력은 복사되어 외부 변이와 격리) */
  static async open(input: Uint8Array | ArrayBuffer): Promise<HwpxSession> {
    // 주의: new Uint8Array(ArrayBuffer)는 복사가 아닌 뷰 — slice로 명시 복사
    const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0))
    return new HwpxSession(await buildState(bytes))
  }

  /** 현재 문서의 IR 블록 — patchBlocks 후 갱신되므로 호출마다 다시 읽을 것 */
  get blocks(): IRBlock[] {
    return this.state.blocks
  }

  /** 현재 문서의 마크다운 */
  get markdown(): string {
    return this.state.markdown
  }

  /** 현재 문서 바이트 (복사본) */
  get bytes(): Uint8Array {
    return new Uint8Array(this.state.bytes)
  }

  /** 블록 → 원본 위치 참조. 매핑 실패 시 undefined */
  sourceRef(blockIndex: number): BlockSourceRef | undefined {
    const st = this.state
    const block = st.blocks[blockIndex]
    if (!block) return undefined
    if (block.type === "paragraph" || block.type === "heading") {
      const para = st.paraMap.get(blockIndex)?.para
      if (!para) return undefined
      return { kind: "paragraph", sectionIndex: para.sectionIndex, xmlStart: para.start }
    }
    if (block.type === "table" && block.table) {
      if (st.tableOrdinals.size !== st.scanTables.length) return undefined
      const ordinal = st.tableOrdinals.get(blockIndex)
      const t = ordinal !== undefined ? st.scanTables[ordinal] : undefined
      if (!t) return undefined
      return { kind: "table", sectionIndex: t.sectionIndex, xmlStart: t.start }
    }
    return undefined
  }

  /** 블록 편집 가능성 사전 판정 — patcher graceful-skip 게이트의 사전 버전 */
  capability(blockIndex: number): BlockCapabilityInfo {
    const st = this.state
    const block = st.blocks[blockIndex]
    if (!block) return { capability: "locked", reason: "블록 인덱스 범위 밖" }

    if (block.type === "paragraph" || block.type === "heading") {
      if (st.fragmentBlocks.has(blockIndex)) {
        return { capability: "locked", reason: "문단 분절(강제 줄바꿈/병합 유닛) — 부분 수정은 미지원 (v1)" }
      }
      if (block.text && block.text.includes("\n")) {
        return { capability: "locked", reason: "문단 내 강제 줄바꿈 포함 — 수정 시 줄바꿈 보존 불가로 미지원 (v1)" }
      }
      if (!st.paraMap.get(blockIndex)?.para) {
        return { capability: "locked", reason: "문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)" }
      }
      return { capability: "text" }
    }

    if (block.type === "table" && block.table) {
      if (st.tableOrdinals.size !== st.scanTables.length) {
        return { capability: "locked", reason: "표 개수 불일치 — 소스맵 신뢰 불가" }
      }
      const ordinal = st.tableOrdinals.get(blockIndex)
      const scanTable = ordinal !== undefined ? st.scanTables[ordinal] : undefined
      if (!scanTable) {
        return { capability: "locked", reason: "표 소스맵 매핑 실패" }
      }
      const table = block.table
      const cells: CellCapability[][] = []
      let anyEditable = false
      for (let r = 0; r < table.rows; r++) {
        const row: CellCapability[] = []
        for (let c = 0; c < table.cols; c++) {
          const info = cellStaticCheck(table, scanTable, r, c)
          if (info.editable) anyEditable = true
          row.push(info)
        }
        cells.push(row)
      }
      if (!anyEditable) return { capability: "locked", reason: "편집 가능한 셀 없음", cells }
      return { capability: "cell-text", cells }
    }

    return { capability: "locked", reason: `${block.type} 블록 편집은 미지원 (v1)` }
  }

  /** 전 블록의 편집 가능성 */
  capabilities(): BlockCapabilityInfo[] {
    return this.state.blocks.map((_, i) => this.capability(i))
  }

  /**
   * 블록 단위 증분 패치 — 적용 후 세션 상태가 새 바이트로 갱신된다.
   *
   * - 호출은 내부적으로 직렬화된다 (동시 호출 시 도착 순서대로 누적 적용)
   * - 무변경 편집(현재 텍스트와 동일)은 조용히 건너뜀 (applied/skipped 모두 제외)
   * - 변경이 하나도 적용되지 않으면 반환 data는 현재 문서와 바이트 동일
   * - changes는 "패치 전 → 후" 문서 diff — modified 수가 기대 편집 수와
   *   일치하는지 확인 용도. patchHwpx의 verification(잔차 검증)과 의미가 다르다.
   */
  async patchBlocks(edits: BlockEdit[], options?: PatchOptions): Promise<PatchResult> {
    // 재진입 직렬화 — 겹치는 호출이 서로의 상태 갱신을 덮어쓰는 lost-update 방지
    const run = this.opQueue.then(() => this.patchBlocksInner(edits, options))
    this.opQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private opQueue: Promise<void> = Promise.resolve()

  private async patchBlocksInner(edits: BlockEdit[], options?: PatchOptions): Promise<PatchResult> {
    const st = this.state
    const skipped: PatchSkip[] = []
    let applied = 0
    const sectionSplices: SpliceEdit[][] = st.scans.map(() => [])
    const cellCtx = { scans: st.scans, sectionSplices, skipped }
    const seenParas = new Set<number>()
    const seenCells = new Set<string>()

    for (const edit of edits) {
      const i = edit.blockIndex
      const block = st.blocks[i]
      if (!block) {
        skipped.push({ reason: `블록 인덱스 범위 밖: ${i}` })
        continue
      }

      // ── 표 셀 편집 ──
      if (block.type === "table" && block.table) {
        if (!edit.cells?.length) {
          skipped.push({ reason: "표 블록에는 cells 편집만 지원", before: summarize(block.table.caption ?? "(표)") })
          continue
        }
        if (st.tableOrdinals.size !== st.scanTables.length) {
          skipped.push({ reason: "표 개수 불일치 — 소스맵 신뢰 불가" })
          continue
        }
        const ordinal = st.tableOrdinals.get(i)
        const scanTable = ordinal !== undefined ? st.scanTables[ordinal] : undefined
        if (!scanTable) {
          skipped.push({ reason: "표 소스맵 매핑 실패" })
          continue
        }
        for (const cellEdit of edit.cells) {
          const key = `${i}:${cellEdit.row},${cellEdit.col}`
          if (seenCells.has(key)) {
            skipped.push({ reason: "같은 셀에 중복 편집 — 먼저 적용된 편집 유지", after: summarize(cellEdit.text) })
            continue
          }
          const irCell = block.table.cells[cellEdit.row]?.[cellEdit.col]
          if (!irCell) {
            skipped.push({ reason: `셀 좌표 범위 밖: ${cellEdit.row},${cellEdit.col}`, after: summarize(cellEdit.text) })
            continue
          }
          // 이미지 토큰은 본문 텍스트가 아님 — 변경 불가, 기록 전 제거
          if (extractCellTokens(irCell.text) !== extractCellTokens(cellEdit.text)) {
            skipped.push({ reason: "셀 내 이미지 변경은 미지원", before: summarize(irCell.text), after: summarize(cellEdit.text) })
            continue
          }
          const newLines = stripCellTokens(cellEdit.text).split("\n").map(s => s.trim()).filter(Boolean)
          const origLines = irCellLines(irCell.text)
          if (newLines.join("\n") === origLines.join("\n")) continue // 무변경
          const n = applyCellEdit(
            block.table, scanTable, cellEdit.row, cellEdit.col, newLines, cellCtx,
            irCell.text, cellEdit.text, origLines.length,
          )
          // splice가 실제 생성된 편집만 슬롯 점유 (no-op/skip은 후속 편집 허용)
          if (n > 0) seenCells.add(key)
          applied += n
        }
        continue
      }

      // ── 문단/헤딩 텍스트 편집 ──
      if ((block.type === "paragraph" || block.type === "heading") && edit.newText !== undefined) {
        if (seenParas.has(i)) {
          skipped.push({ reason: "같은 블록에 중복 편집 — 먼저 적용된 편집 유지", after: summarize(edit.newText) })
          continue
        }
        const n = this.patchParagraphPlain(i, block, edit.newText, sectionSplices, skipped)
        // splice가 실제 생성된 편집만 슬롯 점유 (no-op/skip은 후속 편집 허용)
        if (n > 0) seenParas.add(i)
        applied += n
        continue
      }

      skipped.push({
        reason: `지원하지 않는 블록 유형(${block.type}) 또는 편집 형식`,
        before: summarize(block.text ?? ""),
      })
    }

    // ── splice 적용 + ZIP 재조립 (patcher와 동일 경로) ──
    const replacements = new Map<string, Uint8Array>()
    const encoder = new TextEncoder()
    try {
      for (let s = 0; s < st.scans.length; s++) {
        if (sectionSplices[s].length === 0) continue
        // 텍스트가 바뀐 섹션은 줄 레이아웃 캐시(linesegarray)를 전부 비워 한컴 변조
        // 경고·구버전 줄배치 렌더를 막는다 (patchHwpx와 동일 — 뷰어가 열 때 재계산)
        sectionSplices[s].push(...allLinesegRemovalSplices(st.scans[s].xml))
        replacements.set(st.sectionPaths[s], encoder.encode(applySplices(st.scans[s].xml, sectionSplices[s])))
      }
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `소스맵 splice 실패: ${err instanceof Error ? err.message : String(err)}` }
    }

    if (replacements.size === 0) {
      // 무변경 — patchHwpx와 결과 형태를 맞추기 위해 changes(전부 unchanged)도 채운다
      let changes: DiffResult | undefined
      if (options?.verify !== false) {
        const units = splitMarkdownUnits(st.markdown)
        changes = diffUnitLists(units, units)
      }
      return { success: true, data: new Uint8Array(st.bytes), applied, skipped, changes }
    }

    let data: Uint8Array
    try {
      data = patchZipEntries(st.bytes, replacements)
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `ZIP 재조립 실패: ${err instanceof Error ? err.message : String(err)}` }
    }

    // ── 상태 재구축 + 검증 ──
    const beforeMarkdown = st.markdown
    let newState: SessionState
    try {
      newState = await buildState(data)
    } catch (err) {
      // 세션은 이전 상태 유지 — 깨진 바이트를 노출하지 않는다
      return { success: false, applied, skipped, error: `패치본 재파싱 실패 — 패치 중단: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.state = newState

    let changes: DiffResult | undefined
    if (options?.verify !== false) {
      changes = diffUnitLists(splitMarkdownUnits(beforeMarkdown), splitMarkdownUnits(newState.markdown))
    }

    // 반환 버퍼는 내부 상태와 분리 (호출자 변조가 후속 패치를 오염시키지 않도록)
    return { success: true, data: new Uint8Array(data), applied, skipped, changes }
  }

  /** 문단/헤딩 평문 편집 — patcher.patchParagraphUnit의 평문 입력 버전 */
  private patchParagraphPlain(
    blockIndex: number, block: IRBlock, newTextRaw: string,
    sectionSplices: SpliceEdit[][], skipped: PatchSkip[],
  ): number {
    const skip = (reason: string) => {
      skipped.push({ reason, before: summarize(block.text ?? ""), after: summarize(newTextRaw) })
      return 0
    }
    const st = this.state

    // 무변경 — 조용히 통과
    if (newTextRaw === (block.text ?? "")) return 0

    if (st.fragmentBlocks.has(blockIndex)) {
      return skip("문단 분절(강제 줄바꿈/병합 유닛) — 부분 수정은 미지원 (v1)")
    }
    if (block.text && block.text.includes("\n")) {
      return skip("문단 내 강제 줄바꿈 포함 — 수정 시 줄바꿈 보존 불가로 미지원 (v1)")
    }
    const mapping = st.paraMap.get(blockIndex)
    if (!mapping?.para) {
      return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)")
    }

    // 여러 줄 입력은 한 문단으로 (마크다운 soft-wrap과 동일 규칙)
    let newPlain = newTextRaw.split("\n").map(l => l.trim()).filter(Boolean).join(" ")

    // 각주·미주 참조 부호 — 개체가 그리는 글이라 hp:t 에 쓰지 않는다 (patcher 와 동일 규칙)
    if (mapping.noteMarks?.length) {
      const r = removeNoteMarks(newPlain, mapping.noteMarks)
      newPlain = r.text
      if (r.missing.length) skipped.push({ reason: "각주 참조 부호 삭제는 미지원 — 각주 유지, 본문만 적용", before: r.missing.join(" ") })
    }

    // 자동번호 접두 — XML에 없는 텍스트이므로 떼고 기록 (patcher와 동일 규칙)
    if (mapping.prefixStripped) {
      const origPrefix = block.text!.split(" ", 1)[0]
      const sp = newPlain.indexOf(" ")
      const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain
      if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
        newPlain = sp > 0 ? newPlain.slice(sp + 1) : ""
      } else {
        skipped.push({ reason: "자동번호 접두 식별 실패 — 번호 포함 텍스트로 적용 (뷰어에서 중복 표시 가능)", after: summarize(newPlain) })
      }
    }

    // 빈 문자열 비우기 — 재파싱 시 블록이 사라져 핸들이 영구 소실되고,
    // patchHwpx는 같은 의도(유닛 삭제)를 "블록 삭제 미지원"으로 skip하므로
    // 동등성을 위해 세션도 동일하게 거부한다
    if (newPlain === "") {
      return skip("블록 비우기/삭제는 미지원 (v1) — 원본 유지")
    }

    // 기록 후 재파싱 sanitize에서 변형되는 텍스트는 무손실 약속이 깨짐
    if (sanitizeText(newPlain) !== newPlain) {
      return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
    }

    const splices = buildParagraphSplices(mapping.para, newPlain, st.scans[mapping.para.sectionIndex]?.xml)
    if (splices === null) return skip("문단에 텍스트 노드를 만들 수 없음")
    sectionSplices[mapping.para.sectionIndex].push(...splices)
    return 1
  }
}

/** 셀 정적 편집 가능성 — table-patch applyCellEdit의 정적 게이트 사전 판정 */
function cellStaticCheck(table: IRTable, scanTable: ScanTable, r: number, c: number): CellCapability {
  const irCell = table.cells[r]?.[c]
  if (!irCell) return { editable: false, reason: "셀 좌표 범위 밖" }

  const cell = scanTable.cellByAnchor.get(`${r},${c}`)
  if (!cell) return { editable: false, reason: "병합 영역의 빈 칸이거나 좌표 불일치" }

  // 스캔 문단 합산 ↔ IR 셀 텍스트 정규화 일치 (applyCellEdit와 동일 게이트)
  const scanJoined = cell.paragraphs.map(p => p.text).filter(t => normForMatch(t)).join("\n")
  if (normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (irCell.blocks ?? []).filter(b => b.type === "paragraph" || b.type === "heading")
      const flatJoined = flatBlocks.map(b => b.text ?? "").join("\n")
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return { editable: false, reason: "셀 콘텐츠 구조 복잡 (중첩표/글상자) — 매핑 신뢰 불가" }
      }
    }
  }

  const nonEmpty = cell.paragraphs.filter(p => normForMatch(p.text) !== "")
  if (nonEmpty.length === 0) {
    // 빈 셀 — 삽입 가능한 문단이 있어야 채울 수 있음
    if (cell.paragraphs.length === 0) {
      return { editable: false, reason: "빈 셀에 문단이 없어 텍스트 삽입 불가" }
    }
    return { editable: true }
  }
  const lines = irCellLines(irCell.text)
  if (lines.length !== nonEmpty.length) {
    return { editable: false, reason: "셀 줄 경계 매핑 모호 (리터럴 <br>/문단 내 줄바꿈) — 미지원" }
  }
  return { editable: true }
}

// ─── 편의 API ────────────────────────────────────────

/** HWPX 문서 세션 열기 */
export async function openHwpxDocument(input: Uint8Array | ArrayBuffer): Promise<HwpxSession> {
  return HwpxSession.open(input)
}

/** 원샷 블록 패치 — 세션 없이 한 번에 (stateless RPC용) */
export async function patchHwpxBlocks(
  original: Uint8Array | ArrayBuffer,
  edits: BlockEdit[],
  options?: PatchOptions,
): Promise<PatchResult> {
  const session = await HwpxSession.open(original)
  return session.patchBlocks(edits, options)
}
