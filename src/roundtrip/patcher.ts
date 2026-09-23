/**
 * HWPX 서식 보존 무손실 라운드트립 패치 — v3.0 킬러기능.
 *
 * parse()로 얻은 마크다운을 편집한 뒤 patchHwpx()에 넘기면, 원본 HWPX의
 * ZIP/XML 구조를 그대로 두고 변경된 문단/셀의 텍스트만 in-place 치환한다.
 * 스타일·이미지·표 구조·설정은 1바이트도 건드리지 않는다 (section XML 외
 * ZIP 엔트리는 원본 바이트 그대로, 변경 문단도 run 구조·charPr 보존).
 *
 * 지원: 문단/헤딩 텍스트 수정, 표 셀 텍스트 수정 (GFM·HTML·1x1·1열 표),
 * 문단 → GFM 표 인플레이스 변환 (v3.5 — table-insert.ts),
 * GFM/HTML 표 행 추가/삭제 (v3.7 — table-rows.ts, 병합 교차·개체 포함 행은 skip).
 * 미지원(graceful skip): 블록 추가/삭제/순서 변경, 표 열/병합 변경,
 * 캡션·각주·머리말/꼬리말·이미지 변경. skipped[]에 사유와 함께 보고된다.
 */

import JSZip from "jszip"
import { parseHwpxDocument } from "../hwpx/parser.js"
import { blocksToMarkdown } from "../table/builder.js"
import { normalizedSimilarity } from "../diff/text-diff.js"
import type { IRBlock, PatchOptions, PatchResult, PatchSkip, DiffResult, BlockDiff } from "../types.js"
import {
  scanSectionXml, buildParagraphSplices, markerRunSplices, applySplices, allLinesegRemovalSplices, findElementEnd,
  type SectionScan, type ScanParagraph, type ScanCell, type ScanTable, type SpliceEdit,
} from "./source-map.js"
import { patchZipEntries } from "./zip-patch.js"
import { AUTONUM_PREFIX_RE,
  splitMarkdownUnits, normForMatch, sanitizeText, unescapeGfm, summarize, parseGfmTable,
  alignUnits,
  type MdUnit,
} from "./markdown-units.js"
import { patchGfmTable, patchHtmlTable, patchTextChunkTable } from "./table-patch.js"
import { collectMaxNumericId, injectCellBorderFill, buildTableParagraphXml } from "./table-insert.js"
import { resolveSectionEntryNames } from "./hwpx-entries.js"

export type { PatchOptions, PatchResult, PatchSkip } from "../types.js"

// ─── 메인 API ────────────────────────────────────────

/**
 * 원본 HWPX와 편집된 마크다운으로 서식 보존 패치본을 만든다.
 *
 * @param original 원본 HWPX 바이트
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
export async function patchHwpx(
  original: Uint8Array,
  editedMarkdown: string,
  options?: PatchOptions,
): Promise<PatchResult> {
  const skipped: PatchSkip[] = []
  let applied = 0

  // 1) 원본 파싱 (기존 파서 그대로 — IR 블록과 마크다운 확보)
  let origBlocks: IRBlock[]
  try {
    const parsed = await parseHwpxDocument(u8ToArrayBuffer(original))
    origBlocks = parsed.blocks
  } catch (err) {
    return { success: false, applied: 0, skipped, error: `원본 HWPX 파싱 실패: ${err instanceof Error ? err.message : String(err)}` }
  }

  // 2) 소스맵 — section XML 직접 스캔 (DOM 재직렬화 없음)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(original)
  } catch {
    return { success: false, applied: 0, skipped, error: "ZIP 로드 실패" }
  }
  const sectionPaths = await resolveSectionEntryNames(zip)
  if (sectionPaths.length === 0) {
    return { success: false, applied: 0, skipped, error: "HWPX 섹션 파일을 찾을 수 없습니다" }
  }
  const scans: SectionScan[] = []
  for (let i = 0; i < sectionPaths.length; i++) {
    const xml = await zip.file(sectionPaths[i])!.async("text")
    scans.push(scanSectionXml(xml, i))
  }

  // 2b) header.xml 로드 — 문단→표 변환 시 셀 테두리 borderFill 주입 대상
  //     (header 엔트리를 못 찾으면 tableInsert undefined → 문단→표 변환만 graceful skip)
  let tableInsert: TableInsertState | undefined
  const headerEntryName = await resolveHeaderEntryName(zip)
  if (headerEntryName) {
    const headerXml = await zip.file(headerEntryName)!.async("text")
    const maxId = collectMaxNumericId([...scans.map(s => s.xml), headerXml])
    tableInsert = { headerEntryName, headerXml, headerSplices: [], borderFillId: null, nextId: maxId + 1 }
  }

  // 3) 유닛 구성 + 정렬 (마크다운 도메인 diff)
  const origUnits = buildOrigUnits(origBlocks)
  const editedUnits = splitMarkdownUnits(editedMarkdown)
  const pairs = alignUnits(origUnits.map(u => u.raw), editedUnits.map(u => u.raw))

  // 4) 본문 문단 ↔ 소스맵 문단 매핑 (정규화 텍스트 + 등장 순서)
  const paraMap = resolveParagraphMappings(origBlocks, scans)
  const scanTables = scans.flatMap(s => s.tables.filter(t => t.rows.length > 0))
  const obTableOrdinals = buildTableOrdinals(origBlocks)

  // 5) 변경 적용
  const sectionSplices: SpliceEdit[][] = scans.map(() => [])
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      const orig = origUnits[oi]
      const edited = editedUnits[ei]
      if (orig.raw === edited.raw) continue
      applied += handleModifiedUnit(orig, edited, {
        origBlocks, paraMap, scans, scanTables, obTableOrdinals, sectionSplices, skipped, tableInsert,
      })
    } else if (oi !== null) {
      skipped.push({ reason: "블록 삭제는 미지원 (v1) — 원본 유지", before: summarize(origUnits[oi].raw) })
    } else if (ei !== null) {
      skipped.push({ reason: "블록 추가는 미지원 (v1)", after: summarize(editedUnits[ei].raw) })
    }
  }

  // 6) ZIP 재조립 — 수정된 섹션만 교체, 나머지는 원본 바이트 그대로
  const replacements = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  try {
    for (let i = 0; i < scans.length; i++) {
      if (sectionSplices[i].length === 0) continue
      // 텍스트가 바뀐 섹션은 줄 레이아웃 캐시(linesegarray)를 전부 비워 한컴 변조
      // 경고를 막는다 (텍스트 변경으로 캐시가 어긋남 — 뷰어가 열 때 재계산).
      // 삭제된 행(<hp:tr>) 범위 안의 linesegarray는 삭제 splice에 포함되므로 제외
      const claimed = sectionSplices[i].filter(s => s.end > s.start)
      sectionSplices[i].push(...allLinesegRemovalSplices(scans[i].xml)
        .filter(ls => !claimed.some(c => ls.start >= c.start && ls.end <= c.end)))
      const newXml = applySplices(scans[i].xml, sectionSplices[i])
      replacements.set(sectionPaths[i], encoder.encode(newXml))
    }
    // header.xml 변경 — 문단→표 변환으로 셀 테두리 borderFill이 주입된 경우만
    if (tableInsert && tableInsert.headerSplices.length > 0) {
      const newHeader = applySplices(tableInsert.headerXml, tableInsert.headerSplices)
      replacements.set(tableInsert.headerEntryName, encoder.encode(newHeader))
    }
  } catch (err) {
    return { success: false, applied: 0, skipped, error: `소스맵 splice 실패: ${err instanceof Error ? err.message : String(err)}` }
  }

  let data: Uint8Array
  if (replacements.size === 0) {
    data = new Uint8Array(original) // Buffer.slice는 view라 명시적 복사
  } else {
    try {
      data = patchZipEntries(original, replacements)
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `ZIP 재조립 실패: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  // 7) 자동 검증 — 패치본 재파싱 vs 편집 마크다운
  let verification: DiffResult | undefined
  if (options?.verify !== false) {
    try {
      const reparsed = await parseHwpxDocument(u8ToArrayBuffer(data))
      verification = diffUnitLists(splitMarkdownUnits(reparsed.markdown), editedUnits)
    } catch (err) {
      return { success: false, applied, skipped, error: `패치본 재파싱 실패 — 패치 중단: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { success: true, data, applied, skipped, verification }
}

// ─── 유닛 구성 ───────────────────────────────────────

export interface OrigUnit extends MdUnit {
  /** 출처 IR 블록 인덱스 */
  blockIdx: number
  role?: "caption"
  /** 한 문단 블록이 여러 유닛으로 갈라짐 (강제 줄바꿈 \n\n, 문단 내 '|' 줄, [별표] 2블록
   *  병합) — 유닛 하나의 수정이 문단 전체를 덮어쓰므로 부분 수정 미지원 처리 */
  fragment?: boolean
}

/**
 * IR 블록별 개별 렌더링으로 유닛 생성 — blocksToMarkdown의 [별표 N] 2블록
 * 병합 규칙을 재현해 전체 렌더와 동일한 분할을 보장한다.
 */
export function buildOrigUnits(blocks: IRBlock[]): OrigUnit[] {
  const units: OrigUnit[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let consume = 1
    let chunk: string
    if (block.type === "paragraph" && block.text && /^\[별표\s*\d+/.test(sanitizeText(block.text))) {
      const next = blocks[i + 1]
      if (next?.type === "paragraph" && next.text && /관련\)?$/.test(next.text)) consume = 2
      chunk = blocksToMarkdown(blocks.slice(i, i + consume))
    } else {
      chunk = blocksToMarkdown([block])
    }
    if (chunk) {
      const subUnits = splitMarkdownUnits(chunk)
      // 문단/헤딩 블록이 여러 유닛으로 갈라지거나 [별표] 2블록 병합이면 부분 수정 불가
      const isFragment = consume === 2
        || ((block.type === "paragraph" || block.type === "heading") && subUnits.length > 1)
      for (let s = 0; s < subUnits.length; s++) {
        const u: OrigUnit = { ...subUnits[s], blockIdx: i, fragment: isFragment || undefined }
        // 표 캡션 — 표 유닛 앞의 **...** 텍스트 유닛
        if (block.type === "table" && block.table?.caption && s === 0 && subUnits.length > 1 && u.kind === "text" && u.raw.startsWith("**")) {
          u.role = "caption"
        }
        units.push(u)
      }
    }
    i += consume - 1
  }
  return units
}

/** OB 표 블록 인덱스 → 최상위 표 서수 */
export function buildTableOrdinals(blocks: IRBlock[]): Map<number, number> {
  const map = new Map<number, number>()
  let ordinal = 0
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "table" && blocks[i].table) map.set(i, ordinal++)
  }
  return map
}

// ─── 유닛 정렬 — markdown-units.ts로 이동 (표 행 정렬과 공용), re-export로 하위 호환 유지

export { alignUnits, type AlignedPair } from "./markdown-units.js"

// ─── 문단 매핑 ───────────────────────────────────────

export interface ParaMapping {
  para?: ScanParagraph
  /** 자동번호 접두가 IR 텍스트에 붙어 있었음 (스캔 텍스트에는 없음) */
  prefixStripped?: boolean
}

/**
 * OB 문단/헤딩 블록 → 스캔 문단 매핑.
 * 같은 정규화 텍스트끼리 등장 순서대로 페어링 (중복 문단 대응).
 * 머리말/꼬리말로 배치된 선두/말미 블록은 매핑에서 제외.
 */
export function resolveParagraphMappings(blocks: IRBlock[], scans: SectionScan[]): Map<number, ParaMapping> {
  const buckets = new Map<string, ScanParagraph[]>()
  for (const scan of scans) {
    for (const para of scan.bodyParagraphs) {
      const key = normForMatch(para.text)
      if (!key) continue
      let list = buckets.get(key)
      if (!list) buckets.set(key, (list = []))
      list.push(para)
    }
  }
  const headerNorms = new Set(scans.flatMap(s => s.headerTexts.map(normForMatch)).filter(Boolean))
  const footerNorms = new Set(scans.flatMap(s => s.footerTexts.map(normForMatch)).filter(Boolean))

  // applyPageText가 선두/말미에 배치한 머리말/꼬리말 블록 식별
  // (detectHwpxHeadings가 pageText 블록을 heading으로 재타입할 수 있어 heading도 검사)
  const pageText = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text || !headerNorms.has(normForMatch(b.text))) break
    pageText.add(i)
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text || !footerNorms.has(normForMatch(b.text))) break
    pageText.add(i)
  }

  const counters = new Map<string, number>()
  const result = new Map<number, ParaMapping>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text) continue
    if (pageText.has(i)) { result.set(i, {}); continue }

    let key = normForMatch(b.text)
    let prefixStripped = false
    if (!buckets.has(key)) {
      // 자동번호/글머리 접두 제거 후 재시도 (resolveParaHeading가 붙인 prefix)
      const sp = b.text.indexOf(" ")
      if (sp > 0) {
        const alt = normForMatch(b.text.slice(sp + 1))
        if (alt && buckets.has(alt)) { key = alt; prefixStripped = true }
      }
    }
    const list = buckets.get(key)
    if (!list) { result.set(i, {}); continue }
    const occ = counters.get(key) ?? 0
    counters.set(key, occ + 1)
    result.set(i, occ < list.length ? { para: list[occ], prefixStripped } : {})
  }
  return result
}

// ─── 변경 처리 ───────────────────────────────────────

/**
 * 문단→표 인플레이스 변환 상태 — header.xml에 셀 테두리 borderFill을 1회 주입하고
 * 표 instId를 문서 전역 유니크하게 발급한다. header 엔트리를 못 찾으면 null
 * (그 경우 문단→표 변환은 graceful skip).
 */
interface TableInsertState {
  headerEntryName: string
  headerXml: string
  headerSplices: SpliceEdit[]
  /** 첫 표 삽입 시 header에 추가한 셀 테두리 borderFill id (없으면 아직 미주입) */
  borderFillId: number | null
  /** 다음 발급할 instId (문서 전역 max+1부터 증가) */
  nextId: number
}

interface PatchCtx {
  origBlocks: IRBlock[]
  paraMap: Map<number, ParaMapping>
  scans: SectionScan[]
  scanTables: ScanTable[]
  obTableOrdinals: Map<number, number>
  sectionSplices: SpliceEdit[][]
  skipped: PatchSkip[]
  /** 문단→표 인플레이스 변환용 (header 엔트리 해석 실패 시 undefined) */
  tableInsert?: TableInsertState
}

/** 변경된 유닛 쌍 처리 — 적용 건수 반환 */
function handleModifiedUnit(orig: OrigUnit, edited: MdUnit, ctx: PatchCtx): number {
  const block = ctx.origBlocks[orig.blockIdx]
  const skip = (reason: string) => {
    ctx.skipped.push({ reason, before: summarize(orig.raw), after: summarize(edited.raw) })
    return 0
  }

  if (orig.role === "caption") return skip("표 캡션 수정은 미지원 (v1)")
  if (orig.kind === "separator" || orig.kind === "image") return skip("이미지/구분선 변경은 미지원")
  if (!block) return skip("블록 매핑 실패")
  if (orig.fragment) return skip("문단 분절(강제 줄바꿈/병합 유닛) — 부분 수정은 미지원 (v1)")

  if (block.type === "table" && block.table) {
    if (orig.kind !== edited.kind) return skip("표 ↔ 비표 변경은 미지원 (표 구조 변경)")
    // IR 최상위 표 수 ≠ 스캔 최상위 표 수면 서수가 밀려 엉뚱한 표가 수정될 수 있음
    if (ctx.obTableOrdinals.size !== ctx.scanTables.length) return skip("표 개수 불일치 — 소스맵 신뢰 불가")
    const ordinal = ctx.obTableOrdinals.get(orig.blockIdx)
    const scanTable = ordinal !== undefined ? ctx.scanTables[ordinal] : undefined
    if (!scanTable) return skip("표 소스맵 매핑 실패")
    if (orig.kind === "gfm-table") return patchGfmTable(block.table, scanTable, orig, edited, ctx, skip)
    if (orig.kind === "html-table") return patchHtmlTable(block.table, scanTable, orig, edited, ctx, skip)
    return patchTextChunkTable(block.table, scanTable, orig, edited, ctx, skip)
  }

  if ((block.type === "paragraph" || block.type === "heading") && orig.kind === "text") {
    if (edited.kind === "text") return patchParagraphUnit(block, orig, edited, ctx, skip)
    // 문단/헤딩 → 표 인플레이스 변환 (v3.5) — 원본 문단을 그 자리에서 표로 치환
    if (edited.kind === "gfm-table") return convertParagraphToTable(block, orig, edited, ctx, skip)
    if (edited.kind === "html-table") return skip("문단→병합표(HTML) 변환은 미지원 — GFM 표(| 헤더 | … |)로 작성하세요")
  }

  return skip("지원하지 않는 블록 유형 변경")
}

// ── 문단 → 표 인플레이스 변환 ──

/** 문단 여는 태그에서 paraPrIDRef 추출 (표를 담는 바깥 문단에 승계) */
function extractParaPrIdRef(xml: string, start: number): number | null {
  const gt = xml.indexOf(">", start)
  if (gt < 0) return null
  const m = xml.slice(start, gt + 1).match(/paraPrIDRef="(\d+)"/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * 원본 문단(text)을 편집된 GFM 표로 그 자리에서 치환한다.
 * 문단 <hp:p> 전체 범위를 표 문단 XML로 splice 교체하고, 셀 테두리용 borderFill을
 * header.xml에 (문서당 1회) 주입한다. 원본의 다른 문단·표·서식은 보존된다.
 */
function convertParagraphToTable(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx,
  skip: (reason: string) => number,
): number {
  const ti = ctx.tableInsert
  if (!ti) return skip("문단→표 변환 불가 — header 엔트리(borderFills) 해석 실패")

  const mapping = ctx.paraMap.get(orig.blockIdx)
  if (!mapping?.para) return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역) — 표 변환 불가")
  const para = mapping.para
  if (para.kind !== "body") return skip("본문 외 영역(표 셀/글상자) 문단의 표 변환은 미지원")

  const scan = ctx.scans[para.sectionIndex]
  if (!scan) return skip("섹션 매핑 실패")
  const pEnd = findElementEnd(scan.xml, para.start)
  if (pEnd < 0) return skip("문단 끝 위치 탐색 실패")

  // 편집 GFM 표 → 행렬
  const rows = parseGfmTable(edited.lines)
  if (rows.length === 0 || rows.every(r => r.length === 0)) return skip("표 내용이 비어 있음")

  // 셀 테두리 borderFill 확보 (문서당 1회) — header.xml에 append splice 기록
  if (ti.borderFillId === null) {
    const inj = injectCellBorderFill(ti.headerXml, ti.nextId++)
    if (!inj) return skip("header <hh:borderFills> 구조를 찾을 수 없어 표 테두리 생성 불가")
    ti.borderFillId = inj.borderFillId
    ti.headerSplices.push(...inj.headerSplices)
  }

  const outerParaPrId = extractParaPrIdRef(scan.xml, para.start) ?? 0
  const tableXml = buildTableParagraphXml(rows, {
    borderFillId: ti.borderFillId,
    outerParaPrId,
    cellParaPrId: 0,
    cellCharPrId: 0,
    tableId: ti.nextId++,
  })

  ctx.sectionSplices[para.sectionIndex].push({ start: para.start, end: pEnd, replacement: tableXml })
  return 1
}

// ── 문단 ──

function patchParagraphUnit(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx,
  skip: (reason: string) => number,
): number {
  const mapping = ctx.paraMap.get(orig.blockIdx)
  if (!mapping?.para) return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)")

  // 문단 내 강제 줄바꿈(<hp:br/>/<hp:lineBreak/>) — 평문 치환 시 줄바꿈이 공백으로
  // 변해 무손실 약속이 깨지므로 미지원 (v1)
  if (block.text && block.text.includes("\n")) {
    return skip("문단 내 강제 줄바꿈 포함 — 수정 시 줄바꿈 보존 불가로 미지원 (v1)")
  }

  // 편집 마크다운 → 평문
  const origPlain = textUnitToPlain(orig.raw, block)
  let newPlain = textUnitToPlain(edited.raw, block)

  // 각주 표기 처리 — 본문이 아닌 각주 ctrl에 있으므로 분리
  if (block.footnoteText) {
    const noteMatch = newPlain.match(/\s*\(주: ([\s\S]*)\)$/)
    if (noteMatch) {
      newPlain = newPlain.slice(0, noteMatch.index).trimEnd()
      if (normForMatch(noteMatch[1]) !== normForMatch(block.footnoteText)) {
        ctx.skipped.push({ reason: "각주 텍스트 수정은 미지원 — 본문만 적용", before: block.footnoteText, after: noteMatch[1] })
      }
    } else {
      ctx.skipped.push({ reason: "각주 표기 삭제는 미지원 — 각주 유지, 본문만 적용", before: `(주: ${block.footnoteText})` })
    }
  }

  // 자동번호 접두 — XML에 없는 텍스트이므로 떼고 기록
  if (mapping.prefixStripped) {
    const origPrefix = block.text!.split(" ", 1)[0]
    const sp = newPlain.indexOf(" ")
    const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain
    // 번호 형식: 끝 구두점 필수("1." "가)" "(2)") 또는 단일 원문자/로마자 — 맨 단어 오인 방지
    if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
      newPlain = sp > 0 ? newPlain.slice(sp + 1) : ""
    } else {
      ctx.skipped.push({ reason: "자동번호 접두 식별 실패 — 번호 포함 텍스트로 적용 (뷰어에서 중복 표시 가능)", after: summarize(newPlain) })
    }
  }

  if (newPlain === origPlain) return skip("텍스트 외 변경(헤딩 레벨/서식)만 감지 — 스타일 변경은 미지원")

  // 단일 hp:t로 합쳐 기록하면 재파싱 sanitize에서 변형되는 텍스트(run 경계 이중 공백 등)
  // — 기록 후 동일 렌더가 보장되지 않으므로 미지원
  if (sanitizeText(newPlain) !== newPlain) {
    return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
  }

  const xml = ctx.scans[mapping.para.sectionIndex]?.xml
  const splices = (xml ? markerRunSplices(mapping.para, xml, newPlain) : null) ?? buildParagraphSplices(mapping.para, newPlain, xml)
  if (splices === null) return skip("문단에 텍스트 노드를 만들 수 없음")
  ctx.sectionSplices[mapping.para.sectionIndex].push(...splices)
  return 1
}

/** 텍스트 유닛 마크다운 → 평문 (builder 렌더링의 역변환) */
export function textUnitToPlain(raw: string, block: IRBlock): string {
  // 여러 줄(soft-wrap)은 한 문단으로
  let text = raw.split("\n").map(l => l.trim()).filter(Boolean).join(" ")
  // 헤딩 접두 — 헤딩/[별표] 블록만 (리터럴 '# '로 시작하는 일반 문단은 보존)
  if (block.type === "heading" || (block.text && /^\[별표\s*\d+/.test(sanitizeText(block.text)))) {
    text = text.replace(/^#{1,6}\s+/, "")
  }
  // 링크 — 원본이 href 블록일 때 표시 텍스트만
  if (block.href) {
    const linkMatch = text.match(/^\[([\s\S]*)\]\([^)]*\)$/)
    if (linkMatch) text = linkMatch[1]
  }
  // *(...관련)* 이탤릭 래핑
  if (/^\*[^*][\s\S]*\*$/.test(text) && block.text && /^\([^)]*조[^)]*관련\)$/.test(sanitizeText(block.text))) {
    text = text.slice(1, -1)
  }
  return unescapeGfm(text)
}

// ─── 검증 diff ───────────────────────────────────────

/** 유닛 목록 diff → DiffResult (검증 리포트용) */
export function diffUnitLists(a: MdUnit[], b: MdUnit[]): DiffResult {
  const pairs = alignUnits(a.map(u => u.raw), b.map(u => u.raw))
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 }
  const diffs: BlockDiff[] = []
  for (const [ai, bi] of pairs) {
    if (ai !== null && bi !== null) {
      if (a[ai].raw === b[bi].raw) { stats.unchanged++; continue }
      stats.modified++
      diffs.push({ type: "modified", before: unitToBlock(a[ai]), after: unitToBlock(b[bi]), similarity: normalizedSimilarity(a[ai].raw, b[bi].raw) })
    } else if (ai !== null) {
      stats.removed++
      diffs.push({ type: "removed", before: unitToBlock(a[ai]) })
    } else if (bi !== null) {
      stats.added++
      diffs.push({ type: "added", after: unitToBlock(b[bi]) })
    }
  }
  return { stats, diffs }
}

function unitToBlock(u: MdUnit): IRBlock {
  return { type: "paragraph", text: u.raw }
}

// ─── 헬퍼 ────────────────────────────────────────────

function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/** header.xml ZIP 엔트리 경로 해석 — 대부분 Contents/header.xml, manifest/스캔 fallback */
async function resolveHeaderEntryName(zip: JSZip): Promise<string | null> {
  for (const p of ["Contents/header.xml", "header.xml"]) {
    if (zip.file(p)) return p
  }
  for (const mp of ["Contents/content.hpf", "content.hpf"]) {
    const f = zip.file(mp)
    if (!f) continue
    const xml = await f.async("text")
    const m = xml.match(/<opf:item\b[^>]*\bid="header"[^>]*\bhref="([^"]+)"/i)
      || xml.match(/<opf:item\b[^>]*\bhref="([^"]*header[^"]*\.xml)"/i)
    if (m) {
      let href = m[1]
      if (!href.startsWith("/") && !href.startsWith("Contents/")) href = "Contents/" + href
      if (zip.file(href)) return href
    }
  }
  const found = Object.keys(zip.files).find(n => /header\.xml$/i.test(n))
  return found ?? null
}

// 섹션 엔트리 해석은 hwpx-entries.ts로 이동 (session/filler 공용) — re-export로 하위 호환 유지
export { resolveSectionEntryNames } from "./hwpx-entries.js"
