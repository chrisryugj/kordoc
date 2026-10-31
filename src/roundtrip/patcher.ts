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
 * GFM/HTML 표 행 추가/삭제 (v3.7 — table-rows.ts, 병합 교차·개체 포함 행은 skip),
 * 문단 추가/삭제 (structure-edit.ts — 추가 문단은 같은 항목 부호 원본 문단의 서식 복제).
 * 미지원(graceful skip): 블록 순서 변경, 표 열/병합 변경,
 * 캡션·각주·머리말/꼬리말·이미지 변경. skipped[]에 사유와 함께 보고된다.
 */

import JSZip from "jszip"
import { parseHwpxDocument } from "../hwpx/parser.js"
import { blocksToMarkdown } from "../table/builder.js"
import { normalizedSimilarity } from "../diff/text-diff.js"
import type { IRBlock, PatchOptions, PatchResult, PatchSkip, DiffResult, BlockDiff } from "../types.js"
import {
  scanSectionXml, buildParagraphSplices, markerRunSplices, applySplices, changedLinesegRemovalSplices, findElementEnd, decodeXmlEntities,
  type SectionScan, type ScanParagraph, type ScanCell, type ScanTable, type SpliceEdit,
} from "./source-map.js"
import { noteFormatFrom, noteRefMark, type NoteNumberFormat } from "../hwpx/notes.js"
import { patchZipEntries } from "./zip-patch.js"
import { checkPatchIntegrity } from "./integrity.js"
import { stripHeadMarker, stripShownHeadMarker, noScriptTags,
  splitMarkdownUnits, normForMatch, sanitizeText, unescapeGfm, summarize, parseGfmTable, parseHtmlTable, htmlCellInnerToLines,
  alignUnits, editedFromVisual, editedFromWideCols, LAYOUT_MODE_MISMATCH,
  type MdUnit,
} from "./markdown-units.js"
import { patchGfmTable, patchHtmlTable, patchTextChunkTable } from "./table-patch.js"
import { appendBorderFills, createBorderVariants, type BorderVariants } from "./border-variants.js"
import { collectMaxNumericId, injectCellBorderFill, buildTableParagraphXml } from "./table-insert.js"
import { resolveSectionEntryNames } from "./hwpx-entries.js"
import { detectFormat } from "../detect.js"
import { patchHwp } from "./hwp5-patch.js"
import { parseEmphasis, styledInline, minimalTextSplices, flagsPerChar, commonEnds, type InsertStyle } from "./inline-edit.js"
import { charPrBook, type CharPrBook } from "./char-pr.js"
import { clickHereEditSplices } from "../form/click-here.js"
import { lineBreakTextSplices } from "./line-break-edit.js"
import { fallbackTextEdit, fallbackTableEdits } from "./text-fallback.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { createStructureEditor, pairTablesInGaps, charStyles } from "./structure-edit.js"

export type { PatchOptions, PatchResult, PatchSkip } from "../types.js"

// ─── 메인 API ────────────────────────────────────────

/**
 * 원본 HWPX와 편집된 마크다운으로 서식 보존 패치본을 만든다.
 *
 * @param original 원본 HWPX 바이트 (속이 HWP 5.x 인 문서는 patchHwp 로 넘긴다)
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
export async function patchHwpx(
  original: Uint8Array,
  editedMarkdown: string,
  options?: PatchOptions,
): Promise<PatchResult> {
  const skipped: PatchSkip[] = []
  let applied = 0

  // 0) 포맷은 parse() 처럼 확장자가 아니라 매직 바이트로 가른다. 정책브리핑 보도자료는 .hwpx 이름에 HWP 5.x
  //    바이너리를 싣기도 해서(korea-kr-pairs 5건·pairs2 7건, 반대로 .hwp 이름의 HWPX 1건, rhwp·seoul2 9건) 확장자를
  //    믿고 부르면 parse 는 되는데 패치만 "손상된 HWPX" 로 실패했다 — HWP5 는 patchHwp 로 넘기고, 패처가 없는
  //    포맷(HWP 3.x·PDF 등)은 손상 오보 대신 포맷을 밝혀 거절한다
  const format = detectFormat(new Uint8Array(original.subarray(0, 512)).buffer) // Buffer.slice 는 view — 복사해 잰다
  if (format === "hwp") return patchHwp(original, editedMarkdown, options)
  if (format !== "hwpx") {
    return { success: false, applied: 0, skipped, error: `서식 보존 패치는 HWPX·HWP 5.x 문서만 지원합니다 (감지된 포맷: ${format})` }
  }

  // 1) 원본 파싱 (기존 파서 그대로 — IR 블록과 마크다운 확보)
  //    원본 표 서수로 위치를 찾으므로 틀 표를 풀지 않은 keep 출력이 기준 — 편집본이 기본(visual) 출력이면 분명히 알린다
  //    편집본이 끝 빈 열 보존(--keep-empty-cols) 추출이면 그 IR 이 기준 — 기본 추출은 끝 빈 입력칸을 잘라 그 칸을 채울 수 없다 (#144)
  let origBlocks: IRBlock[]
  let keepTrailingEmptyCols = false
  try {
    const trimmed = await parseHwpxDocument(u8ToArrayBuffer(original), { layoutTables: "keep" })
    const wide = await parseHwpxDocument(u8ToArrayBuffer(original), { layoutTables: "keep", keepTrailingEmptyCols: true })
    keepTrailingEmptyCols = editedFromWideCols(trimmed.markdown, wide.markdown, editedMarkdown)
    const parsed = keepTrailingEmptyCols ? wide : trimmed
    origBlocks = parsed.blocks
    const visual = await parseHwpxDocument(u8ToArrayBuffer(original), { keepTrailingEmptyCols })
    // 기본 출력이 keep 과 달라도 글을 고치지 않았다면 위치 매핑 없이 원본을 그대로 돌려준다 (HWP5 patchHwp 와 같은 규칙)
    if (parsed.markdown !== visual.markdown && editedMarkdown === visual.markdown) {
      const verification = options?.verify === false ? undefined
        : diffUnitLists(splitMarkdownUnits(visual.markdown), splitMarkdownUnits(editedMarkdown))
      return { success: true, data: new Uint8Array(original), applied: 0, skipped, verification }
    }
    if (editedFromVisual(parsed.markdown, visual.markdown, editedMarkdown)) return { success: false, applied: 0, skipped, error: LAYOUT_MODE_MISMATCH }
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
    const xml = await readZipEntry(zip.file(sectionPaths[i])!, "text")
    scans.push(scanSectionXml(xml, i))
  }

  // 2b) header.xml 로드 — 문단→표 변환 시 셀 테두리 borderFill 주입 대상
  //     (header 엔트리를 못 찾으면 tableInsert undefined → 문단→표 변환만 graceful skip)
  let tableInsert: TableInsertState | undefined
  let borders: BorderVariants | undefined
  const headerEntryName = await resolveHeaderEntryName(zip)
  if (headerEntryName) {
    const headerXml = await readZipEntry(zip.file(headerEntryName)!, "text")
    const maxId = collectMaxNumericId([...scans.map(s => s.xml), headerXml])
    tableInsert = { headerEntryName, headerXml, headerSplices: [], borderFillId: null, nextId: maxId + 1 }
    const ti = tableInsert
    borders = createBorderVariants(headerXml, () => ti.nextId++)
  }

  // 3) 유닛 구성 + 정렬 (마크다운 도메인 diff)
  const origUnits = buildOrigUnits(origBlocks)
  const editedUnits = splitMarkdownUnits(editedMarkdown)
  const pairs = alignUnits(origUnits.map(u => looseRaw(u.raw)), editedUnits.map(u => looseRaw(u.raw)))

  // 4) 본문 문단 ↔ 소스맵 문단 매핑 (정규화 텍스트 + 등장 순서)
  const paraMap = resolveParagraphMappings(origBlocks, scans)
  const scanTables = scans.flatMap(s => s.tables.filter(t => t.rows.length > 0 && !t.channel))
  const obTableOrdinals = buildTableOrdinals(origBlocks)

  // 5) 변경 적용 — 문단 추가·삭제(structure)는 정확 정렬(대형 문서 폴백이 아닌 LCS)일 때만: 폴백은 가운데 구간을 통째로
  //    삭제+추가로 보고하므로 그대로 반영하면 원본 서식이 전부 복제본으로 갈린다
  const sectionSplices: SpliceEdit[][] = scans.map(() => [])
  const structural = options?.structure !== false && origUnits.length * editedUnits.length <= 4_000_000
  const charBook = tableInsert && charPrBook(tableInsert.headerXml)
  const ctx: PatchCtx = { origBlocks, paraMap, scans, scanTables, obTableOrdinals, sectionSplices, skipped, tableInsert, structure: structural, borders, charBook,
    unitKeys: origUnits.map(u => (u.kind === "text" ? fallbackPlain(u.raw, origBlocks[u.blockIdx]).replace(/\s+/g, "") : "")) }
  const struct = structural ? createStructureEditor({
    origUnits, origBlocks, paraMap, scans, scanTables, obTableOrdinals, sectionSplices, skipped,
    inlineOf: oi => textUnitInline(origUnits[oi].raw, origBlocks[origUnits[oi].blockIdx]),
    tableXml: (edited, outerParaPrId) => newTableParagraph(edited, outerParaPrId, tableInsert),
    chars: tableInsert && charStyles(tableInsert.headerXml, scans.map(s => s.xml)),
  }) : null
  let lastOi: number | null = null
  for (const [oi, ei] of struct ? pairTablesInGaps(pairs, origUnits, editedUnits) : pairs) {
    if (oi !== null && ei !== null) {
      lastOi = oi
      const orig = origUnits[oi]
      const edited = editedUnits[ei]
      if (looseRaw(orig.raw) === looseRaw(edited.raw)) continue
      const restyled = struct?.restyle(oi, edited) ?? null
      applied += restyled ?? modifyUnit(oi, orig, edited, ctx)
    } else if (oi !== null) {
      lastOi = oi
      if (struct) applied += struct.remove(oi)
      else skipped.push({ reason: "블록 삭제는 미지원 (structure: false) — 원본 유지", before: summarize(origUnits[oi].raw) })
    } else if (ei !== null) {
      if (struct) applied += struct.insert(editedUnits[ei], lastOi)
      else skipped.push({ reason: "블록 추가는 미지원 (structure: false)", after: summarize(editedUnits[ei].raw) })
    }
  }
  if (struct) scans.forEach((_, i) => sectionSplices[i].push(...struct.staleCacheSplices(i)))

  // 6) ZIP 재조립 — 수정된 섹션만 교체, 나머지는 원본 바이트 그대로
  const replacements = new Map<string, Uint8Array>()
  const edited: Array<{ name: string; xml: string; splices: SpliceEdit[] }> = []
  const encoder = new TextEncoder()
  try {
    for (let i = 0; i < scans.length; i++) {
      if (sectionSplices[i].length === 0) continue
      edited.push({ name: sectionPaths[i], xml: scans[i].xml, splices: [...sectionSplices[i]] })
      // 글이 바뀐 문단의 줄 레이아웃 캐시(linesegarray)만 비운다: 어긋난 캐시는 한컴 변조 경고를 띄우고,
      // 손대지 않은 문단의 캐시까지 지우면 자체 조판이 없는 뷰어가 쪽 전체를 다시 짜 깨진다 (changedLinesegRemovalSplices).
      // 삭제된 행(<hp:tr>) 범위 안의 linesegarray는 삭제 splice에 포함되므로 제외
      sectionSplices[i].push(...changedLinesegRemovalSplices(scans[i].xml, sectionSplices[i]))
      const newXml = applySplices(scans[i].xml, sectionSplices[i])
      replacements.set(sectionPaths[i], encoder.encode(newXml))
    }
    // header.xml 변경 — 문단→표 변환으로 셀 테두리 borderFill이 주입된 경우만
    // 행 추가가 만든 테두리 변형도 같은 header 에 덧붙인다
    if (tableInsert && (tableInsert.headerSplices.length > 0 || borders?.added().length || charBook?.added())) {
      const newHeader = charBook!.apply(appendBorderFills(applySplices(tableInsert.headerXml, tableInsert.headerSplices), borders?.added() ?? []))
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

  // 7) 자동 검증 — 바이트·구조 무결성(교체 안 한 엔트리 그대로·XML 엄격 파싱·글만 고친 섹션 태그 보존) 뒤 패치본 재파싱 vs
  //    편집 마크다운. 무결성이 깨졌으면 패처 결함이라 깨진 파일을 내보내지 않는다
  let verification: DiffResult | undefined
  if (options?.verify !== false) {
    const issues = replacements.size > 0 ? checkPatchIntegrity(original, data, replacements, edited) : []
    if (issues.length) return { success: false, applied, skipped, error: `패치본 무결성 검사 실패 — 패치 중단: ${issues.join("; ")}` }
    try {
      const reparsed = await parseHwpxDocument(u8ToArrayBuffer(data), { layoutTables: "keep", keepTrailingEmptyCols })
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
  /** 강제 줄바꿈 빈 줄로 갈라진 문단 조각의 순번 — 조각 글만 바꿔 문단 전체 글로 다시 맞춘다 */
  part?: number
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
        if (isFragment && consume === 1 && block.text?.includes("\n")) u.part = s
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
  /** 파서가 본문에 끼운 각주·미주 참조 부호(문서 순서) — hp:t 에 없으므로 편집 텍스트에서 뺀다 */
  noteMarks?: string[]
}

/**
 * OB 문단/헤딩 블록 → 스캔 문단 매핑.
 * 같은 정규화 텍스트끼리 등장 순서대로 페어링 (중복 문단 대응).
 * 머리말/꼬리말로 배치된 선두/말미 블록은 매핑에서 제외.
 */
export function resolveParagraphMappings(blocks: IRBlock[], scans: SectionScan[]): Map<number, ParaMapping> {
  const buckets = new Map<string, ScanParagraph[]>()
  for (const scan of scans) {
    // kordoc 장식표의 제목·요약 칸 문단 — 파서가 그 칸 글을 heading·인용문 블록으로 낸다 (문서 순서로 끼운다)
    const channel = scan.tables.flatMap(t => t.channelCell?.paragraphs ?? [])
    const paras = channel.length ? [...scan.bodyParagraphs, ...channel].sort((a, b) => a.start - b.start) : scan.bodyParagraphs
    for (const para of paras) {
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

  // 각주·미주 문단 — 파서가 본문에 끼운 참조 부호("1)"·"문1）")만큼 IR 텍스트가 스캔 텍스트보다 길다.
  // 부호는 그 문단 XML 의 개체 속성·구역 번호 모양에서 파서와 같은 함수(notes.ts noteRefMark)로 재구성
  const noted = scans.flatMap(scan => {
    if (!/<(?:\w+:)?(?:footNote|endNote)\b/.test(scan.xml)) return []
    const fmts = sectionNoteFormats(scan.xml)
    return scan.bodyParagraphs
      .map(p => ({ key: normForMatch(p.text), marks: paraNoteMarks(scan.xml, p, fmts) }))
      .filter(x => x.key && x.marks.length > 0)
  })

  const counters = new Map<string, number>()
  const result = new Map<number, ParaMapping>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text) continue
    if (pageText.has(i)) { result.set(i, {}); continue }

    // 첨자 태그는 파서 표기(원문 hp:t 엔 없다)라 떼고 맞댄다 — 종전엔 위첨자가 든 문단은 늘 매핑에 실패해 원문 글 찾기로 갔다
    const text = noScriptTags(b.text)
    let key = normForMatch(text)
    let prefixStripped = false
    let noteMarks: string[] | undefined
    if (!buckets.has(key)) {
      // 자동번호/글머리 접두 제거 후 재시도 (resolveParaHeading가 붙인 prefix)
      const sp = text.indexOf(" ")
      const alt = sp > 0 ? normForMatch(text.slice(sp + 1)) : ""
      if (alt && buckets.has(alt)) { key = alt; prefixStripped = true }
      else {
        // 각주·미주 참조 부호를 뺀 텍스트가 그 문단 스캔 텍스트와 같으면 그 문단 (접두 제거와도 조합)
        for (const n of noted) {
          if (textWithoutMarks(key, n.key, n.marks)) { key = n.key; noteMarks = n.marks; break }
          if (alt && textWithoutMarks(alt, n.key, n.marks)) { key = n.key; noteMarks = n.marks; prefixStripped = true; break }
        }
      }
    }
    const list = buckets.get(key)
    if (!list) { result.set(i, {}); continue }
    const occ = counters.get(key) ?? 0
    counters.set(key, occ + 1)
    result.set(i, occ < list.length ? { para: list[occ], prefixStripped, noteMarks } : {})
  }
  return result
}

/** 구역 첫 secPr 의 footNotePr/endNotePr > autoNumFormat — 파서 notes.readSectionNoteFormats 의 정규식판 */
function sectionNoteFormats(xml: string): { footnote?: NoteNumberFormat; endnote?: NoteNumberFormat } {
  const pick = (tag: string): NoteNumberFormat | undefined => {
    const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>\\s*<(?:\\w+:)?autoNumFormat\\b([^>]*?)/?>`).exec(xml)
    return m ? noteFormatFrom(n => xmlAttr(m[1], n)) : undefined
  }
  return { footnote: pick("footNotePr"), endnote: pick("endNotePr") }
}

function xmlAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)
  return m ? decodeXmlEntities(m[1]) : undefined
}

/**
 * 문단 자신의 각주·미주 본문 참조 부호(문서 순서) — 문단 안 표·글상자·캡션·주석 본문 속 주석은
 * 각자 다른 문단 소관이라 세지 않는다 (파서 extractParagraphInfo 가 부호를 끼우는 범위와 같다)
 */
export function paraNoteMarks(xml: string, para: ScanParagraph, fmts: { footnote?: NoteNumberFormat; endnote?: NoteNumberFormat }): string[] {
  const end = findElementEnd(xml, para.start)
  if (end < 0) return []
  const seg = xml.slice(para.start, end)
  if (!/<(?:\w+:)?(?:footNote|endNote)\b/.test(seg)) return []
  const marks: string[] = []
  let depth = 0
  for (const m of seg.matchAll(/<(\/?)(?:\w+:)?(tbl|drawText|caption|footNote|endNote|header|footer|memo|hiddenComment)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m
    if (selfClose) continue
    if (close) { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && (tag === "footNote" || tag === "endNote")) {
      const get = (n: string) => xmlAttr(attrs, n)
      marks.push(noteRefMark(
        { number: get("number"), prefixChar: get("prefixChar"), suffixChar: get("suffixChar"), userChar: get("userChar") },
        tag === "endNote" ? fmts.endnote : fmts.footnote,
      ))
    }
    depth++
  }
  return marks
}

/** IR 정규화 텍스트에서 부호를 (순서대로) 빼면 스캔 정규화 텍스트와 같은가 — 글자 우선 두 포인터 */
function textWithoutMarks(irKey: string, scanKey: string, marks: string[]): boolean {
  let i = 0, j = 0, k = 0
  while (i < irKey.length) {
    if (j < scanKey.length && irKey[i] === scanKey[j]) { i++; j++; continue }
    if (k < marks.length && marks[k] && irKey.startsWith(marks[k], i)) { i += marks[k].length; k++; continue }
    if (irKey[i] === " " && (j === 0 || scanKey[j - 1] === " ")) { i++; continue } // 부호 앞뒤 공백 붕괴 차이
    return false
  }
  return j === scanKey.length && k === marks.length
}

/**
 * 편집 텍스트에서 각주·미주 참조 부호를 뺀다 — 부호는 앞 낱말에 붙어 나오므로(“액체1)와”) 앞 글자가
 * 공백이 아닌 등장을 우선하고, 문단 첫머리 부호(“문1）”)는 0 위치로 인정. 못 찾은 부호는 사용자가
 * 지운 것 — 주석 개체는 XML 에 그대로 남는다(삭제 미지원)
 */
export function removeNoteMarks(text: string, marks: string[]): { text: string; missing: string[] } {
  let out = text
  let cursor = 0
  const missing: string[] = []
  for (const mark of marks) {
    if (!mark) continue
    let at = -1
    for (let p = out.indexOf(mark, cursor); p !== -1; p = out.indexOf(mark, p + 1)) {
      if (p === 0 || !/\s/.test(out[p - 1])) { at = p; break }
      if (at === -1) at = p
    }
    if (at === -1) { missing.push(mark); continue }
    out = out.slice(0, at) + out.slice(at + mark.length)
    cursor = at
  }
  return { text: out, missing }
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
  /** 문단 추가·삭제 반영 (표 칸 안 줄 수 변경 포함) */
  structure?: boolean
  /** 행 추가 복제 행 테두리 고침 (table-rows) */
  borders?: BorderVariants
  /** 원본 유닛별 글 열쇠(공백 뺀 평문, 글 유닛만) — 글로 찾아 고치기의 등장 순번 */
  unitKeys?: string[]
  /** header 글자 모양 책 — 새 글을 마크다운 서식대로 넣을 때 서식만 다른 글자 모양 (header 를 못 읽으면 없음) */
  charBook?: CharPrBook
}

/** 글로 찾아 고치기용 평문(줄은 "\n") — 강조 표지·첨자 태그·그림 줄을 걷는다 (원문 hp:t 에 없는 표기) */
export function fallbackPlain(raw: string, block: IRBlock | undefined): string {
  const inline = block ? textUnitInline(raw, block, "\n") : raw.split("\n").map(l => l.trim()).filter(Boolean).join("\n")
  return parseEmphasis(inline.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/<br\s*\/?>/gi, "\n")).plain.replace(/<\/?(?:sup|sub)>/g, "")
}

/** 표 유닛 → 행별 칸 평문 (GFM·HTML). 칸 안 그림·중첩표는 null 칸 글로 */
export function tableUnitCells(u: MdUnit): string[][] | null {
  const cell = (t: string) => parseEmphasis(t).plain.replace(/<\/?(?:sup|sub)>/g, "").trim()
  if (u.kind === "gfm-table") {
    return parseGfmTable(u.raw.split("\n")).map(r => r.map(c => cell(c.replace(/(?<!\\)<br\s*\/?>/gi, "\n").replace(/\\\|/g, "|"))))
  }
  if (u.kind === "html-table") {
    const rows = parseHtmlTable(u.raw)
    if (!rows) return null
    return rows.map(r => r.cells.map(c => {
      const { lines, hadNonText } = htmlCellInnerToLines(c.inner)
      return hadNonText ? "\u0000" + lines.join("\n") : cell(lines.join("\n"))
    }))
  }
  return null
}

/**
 * 변경 유닛 처리 — 좌표 경로(handleModifiedUnit)가 한 건도 못 고쳤으면 그 경로의 splice·건너뜀을 되돌리고
 * 원문 글을 문단에서 찾아 고친다(text-fallback). 서식은 원문 문단·칸 그대로다
 */
function modifyUnit(oi: number, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx): number {
  const snap = ctx.sectionSplices.map(s => s.length)
  const skipSnap = ctx.skipped.length
  const n = handleModifiedUnit(orig, edited, ctx)
  const fresh = ctx.skipped.slice(skipSnap)
  if (n > 0 || fresh.length === 0 || fresh.every(s => s.partial)) return n
  if (orig.kind === "separator" || orig.kind === "image" || orig.kind !== edited.kind) return n
  const removed = ctx.sectionSplices.map((s, i) => s.splice(snap[i]))
  const block = ctx.origBlocks[orig.blockIdx]
  let applied = 0
  let failed: Array<{ before: string; after: string }> = []
  if (orig.kind === "text") {
    const origPlain = fallbackPlain(orig.raw, block)
    const keys = ctx.unitKeys ?? []
    const k = keys[oi] ?? ""
    let occ = 0, total = 0
    keys.forEach((x, i) => { if (x === k) { total++; if (i < oi) occ++ } })
    if (fallbackTextEdit(ctx, origPlain, fallbackPlain(edited.raw, block), occ, Math.max(total, 1))) applied = 1
  } else {
    const o = tableUnitCells(orig), e = tableUnitCells(edited)
    if (o && e && o.length === e.length && o.every((r, i) => r.length === e[i].length)
      && o.every((r, i) => r.every((c, j) => !c.startsWith("\u0000") || c === e[i][j]))) {
      const ordinal = ctx.obTableOrdinals.size === ctx.scanTables.length ? ctx.obTableOrdinals.get(orig.blockIdx) : undefined
      const r = fallbackTableEdits(ctx, ordinal !== undefined ? ctx.scanTables[ordinal] : undefined, o, e)
      applied = r.applied
      failed = r.failed
    }
  }
  if (applied === 0) {
    removed.forEach((r, i) => ctx.sectionSplices[i].push(...r))
    return n
  }
  ctx.skipped.length = skipSnap
  for (const f of failed) ctx.skipped.push({ reason: "표 칸 위치를 찾지 못함 — 이 칸만 미적용", before: summarize(f.before), after: summarize(f.after) })
  return applied
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
  if (orig.fragment && orig.part === undefined) return skip("문단 분절(강제 줄바꿈/병합 유닛) — 부분 수정은 미지원 (v1)")

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

/** 추가된 GFM 표 → 표 문단 XML (문단→표 변환과 같은 빌더·셀 테두리) — 못 만들면 사유 */
function newTableParagraph(edited: MdUnit, outerParaPrId: number, ti: TableInsertState | undefined): string | { reason: string } {
  if (!ti) return { reason: "표 추가 불가 — header 엔트리(borderFills) 해석 실패" }
  const rows = parseGfmTable(edited.lines)
  if (rows.length === 0 || rows.every(r => r.length === 0)) return { reason: "표 내용이 비어 있음" }
  if (ti.borderFillId === null) {
    const inj = injectCellBorderFill(ti.headerXml, ti.nextId++)
    if (!inj) return { reason: "header <hh:borderFills> 구조를 찾을 수 없어 표 테두리 생성 불가" }
    ti.borderFillId = inj.borderFillId
    ti.headerSplices.push(...inj.headerSplices)
  }
  return buildTableParagraphXml(rows, { borderFillId: ti.borderFillId, outerParaPrId, cellParaPrId: 0, cellCharPrId: 0, tableId: ti.nextId++ })
}

// ── 문단 ──

function patchParagraphUnit(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx,
  skip: (reason: string) => number,
): number {
  const mapping = ctx.paraMap.get(orig.blockIdx)
  if (!mapping?.para) return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)")

  // 문단 내 강제 줄바꿈(<hp:lineBreak/>) — 줄바꿈을 "\n" 으로 맞대 바뀐 자리만 고친다
  if (block.text && block.text.includes("\n")) return patchLineBreakParagraph(block, orig, edited, mapping, ctx, skip)

  // 편집 마크다운 → 평문 + 서식 조각 (강조 표지·첨자 태그는 걷는다: 조각 경계가 run 서식 경계, 원문 hp:t 엔 태그가 없다)
  const origInline = styledInline(textUnitInline(orig.raw, block))
  const newInline = styledInline(textUnitInline(edited.raw, block))
  let origPlain = origInline.plain
  let newPlain = newInline.plain
  // 각주·참조 부호·자동번호 접두를 떼면 조각 좌표가 어긋나므로 그때는 문단 단위 diff 만
  const segsUsable = !block.footnoteText && !mapping.noteMarks?.length && !mapping.prefixStripped

  // 각주 표기 처리 — 본문이 아닌 각주 ctrl에 있으므로 분리
  if (block.footnoteText) {
    // 주석 안 표(#149)는 마크다운에 HTML 격자로 나가 footnoteText(평탄화 글)와 모양이 다르다 — 원본 마크다운 표기와 견준다
    const origNote = block.footnoteBlocks ? origPlain.match(/\s*\(주: ([\s\S]*)\)$/)?.[1] : undefined
    origPlain = origPlain.replace(/\s*\(주: [\s\S]*\)$/, "")
    const noteMatch = newPlain.match(/\s*\(주: ([\s\S]*)\)$/)
    if (noteMatch) {
      newPlain = newPlain.slice(0, noteMatch.index).trimEnd()
      if (normForMatch(noteMatch[1]) !== normForMatch(origNote ?? block.footnoteText)) {
        ctx.skipped.push({ reason: "각주 텍스트 수정은 미지원 — 본문만 적용", before: block.footnoteText, after: noteMatch[1] })
      }
    } else {
      ctx.skipped.push({ reason: "각주 표기 삭제는 미지원 — 각주 유지, 본문만 적용", before: `(주: ${block.footnoteText})` })
    }
  }

  // 각주·미주 참조 부호 — 개체가 그리는 글이라 hp:t 에 쓰지 않는다
  if (mapping.noteMarks?.length) {
    origPlain = removeNoteMarks(origPlain, mapping.noteMarks).text
    const r = removeNoteMarks(newPlain, mapping.noteMarks)
    newPlain = r.text
    if (r.missing.length) ctx.skipped.push({ reason: "각주 참조 부호 삭제는 미지원 — 각주 유지, 본문만 적용", before: r.missing.join(" ") })
  }

  // 자동번호·글머리표 접두 — XML에 없는 텍스트이므로 떼고 기록
  if (mapping.prefixStripped) {
    origPlain = stripShownHeadMarker(block.text!, origPlain)
    const head = stripHeadMarker(block.text!, newPlain)
    newPlain = head.text
    if (head.note) ctx.skipped.push({ reason: head.note, after: summarize(newPlain), partial: true })
  }

  if (newPlain === origPlain) return skip("텍스트 외 변경(헤딩 레벨/서식)만 감지 — 스타일 변경은 미지원")

  // 단일 hp:t로 합쳐 기록하면 재파싱 sanitize에서 변형되는 텍스트(run 경계 이중 공백 등)
  //: 기록 후 동일 렌더가 보장되지 않으므로 미지원. 단 원문 문단이 이미 그 꼴(균등 띄어쓰기 "기   간"이 마크다운에
  // 그대로 보이는 서식 문단)이면 같은 렌더 경로를 타므로 허용한다: 바뀐 자리만 고쳐 원문 띄어쓰기는 그대로 남는다
  if (sanitizeText(newPlain) !== newPlain && sanitizeText(origPlain) === origPlain) {
    return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
  }

  const xml = ctx.scans[mapping.para.sectionIndex]?.xml
  // 새 글은 마크다운 서식대로 — 바뀐 자리가 다른 서식 run 에 들면 서식만 다른 글자 모양 run 으로 (굵은 제목 끝에 붙인 글)
  const book = ctx.charBook
  const style: InsertStyle | undefined = segsUsable && book ? {
    flags: flagsPerChar(newInline.segs, newInline.flags), known: origInline.flags.reduce((a, b) => a | b, 0),
    flagsOf: id => book.flagsOf(id), variant: (id, f) => book.variant(id, f),
  } : undefined
  // 미기입 누름틀 자리에 쓴 값은 누름틀에 채운다 — 아니면 바뀐 자리만, 그것도 안 되면 문단 통째
  const minimal = xml ? minimalTextSplices(mapping.para, xml, origPlain, newPlain, segsUsable ? origInline.segs : undefined, segsUsable ? newInline.segs : undefined, style) : null
  const splices = (xml ? clickHereEditSplices(mapping.para, xml, origPlain, newPlain) : null)
    ?? minimal ?? (xml ? markerRunSplices(mapping.para, xml, newPlain) : null) ?? buildParagraphSplices(mapping.para, newPlain, xml)
  if (splices === null) return skip("문단에 텍스트 노드를 만들 수 없음")
  ctx.sectionSplices[mapping.para.sectionIndex].push(...splices)
  if (segsUsable && origInline.segs.length !== newInline.segs.length
    && (!minimal || !style || style.missed || restyledKept(origInline, newInline, origPlain, newPlain))) {
    ctx.skipped.push({ reason: "강조(굵게·밑줄 등) 추가·삭제는 미지원: 글만 적용, 원문 글자 모양 유지", before: summarize(orig.raw), after: summarize(edited.raw), partial: true })
  }
  return 1
}

/** 바뀐 자리 밖(공통 앞·뒤) 글의 강조가 달라졌는가 — 그 강조 추가·삭제는 글자 모양을 못 바꿔 부분 적용으로 알린다 */
function restyledKept(o: { segs: string[]; flags: number[] }, n: { segs: string[]; flags: number[] }, oPlain: string, nPlain: string): boolean {
  const of = flagsPerChar(o.segs, o.flags), nf = flagsPerChar(n.segs, n.flags)
  const { p, s } = commonEnds(oPlain, nPlain)
  for (let i = 0; i < p; i++) if (of[i] !== nf[i]) return true
  for (let i = 1; i <= s; i++) if (of[of.length - i] !== nf[nf.length - i]) return true
  return false
}

/** 강제 줄바꿈 문단: 마크다운 줄을 "\n" 으로 이은 평문끼리 diff 해 줄바꿈 요소를 지키며 고친다. 줄바꿈을 늘리고 줄여도 된다 */
function patchLineBreakParagraph(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, mapping: ParaMapping, ctx: PatchCtx,
  skip: (reason: string) => number,
): number {
  if (block.footnoteText || mapping.noteMarks?.length || mapping.prefixStripped) {
    return skip("강제 줄바꿈 문단의 각주·자동번호 — 수정 미지원")
  }
  const plain = (raw: string) => parseEmphasis(textUnitInline(raw, block, "\n")).plain
  let origNorm = plain(orig.raw)
  let newNorm = plain(edited.raw)
  if (newNorm === origNorm) return skip("텍스트 외 변경(헤딩 레벨/서식)만 감지 — 스타일 변경은 미지원")
  if (newNorm.split("\n").some(l => sanitizeText(l) !== l) && origNorm.split("\n").every(l => sanitizeText(l) === l)) {
    return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
  }
  // 빈 줄(줄바꿈 둘)로 갈라진 조각 — 문단 전체 글에서 이 조각 자리만 바꾼다
  if (orig.part !== undefined) {
    const parts = splitMarkdownUnits(blocksToMarkdown([block])).map(u => plain(u.raw))
    if (parts[orig.part] !== origNorm) return skip("문단 분절(강제 줄바꿈) 조각 매핑 실패 — 미지원")
    origNorm = parts.join("\n\n")
    parts[orig.part] = newNorm
    newNorm = parts.join("\n\n")
  }
  const xml = ctx.scans[mapping.para!.sectionIndex]?.xml
  const splices = xml ? lineBreakTextSplices(mapping.para!, xml, origNorm, newNorm) : null
  if (!splices) return skip("강제 줄바꿈 문단을 원문과 맞대지 못함 — 미지원")
  ctx.sectionSplices[mapping.para!.sectionIndex].push(...splices)
  return 1
}

/** 텍스트 유닛 마크다운 → 평문 (builder 렌더링의 역변환): 강조 표지(** · <u> 등)는 걷는다 (글자로 찍히지 않게) */
export function textUnitToPlain(raw: string, block: IRBlock): string {
  return parseEmphasis(textUnitInline(raw, block)).plain
}

/** 텍스트 유닛 마크다운 → 강조 표지·첨자 태그를 걷은 평문과 조각마다 서식 비트 (styledInline). sep 은 마크다운 줄 잇기 */
export function textUnitStyled(raw: string, block: IRBlock, sep = " "): { plain: string; segs: string[]; flags: number[] } {
  return styledInline(textUnitInline(raw, block, sep))
}

/** 텍스트 유닛 마크다운 → 강조 표지가 남은 인라인 글 (헤딩 접두·링크·관련 이탤릭만 벗김) */
function textUnitInline(raw: string, block: IRBlock, sep = " "): string {
  // 여러 줄(soft-wrap)은 한 문단으로 — 강제 줄바꿈 문단은 줄을 "\n" 으로 잇는다
  let text = raw.split("\n").map(l => l.trim()).filter(Boolean).join(sep)
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
  return text
}

// ─── 검증 diff ───────────────────────────────────────

/** 유닛 목록 diff → DiffResult (검증 리포트용) */
export function diffUnitLists(a: MdUnit[], b: MdUnit[]): DiffResult {
  const pairs = alignUnits(a.map(u => looseRaw(u.raw)), b.map(u => looseRaw(u.raw)))
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 }
  const diffs: BlockDiff[] = []
  for (const [ai, bi] of pairs) {
    if (ai !== null && bi !== null) {
      if (looseRaw(a[ai].raw) === looseRaw(b[bi].raw)) { stats.unchanged++; continue }
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

/** 비교용 마크다운 — 파서가 홑 물결을 \~ 로 내보내지만(escapeGfm) 편집자가 맨 ~ 로 써도 같은 글이다 (홑 ~ 는 취소선이 아님) */
export function looseRaw(raw: string): string {
  return raw.replace(/\\~/g, "~")
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
    const xml = await readZipEntry(f, "text")
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
