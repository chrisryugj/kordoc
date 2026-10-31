/**
 * HWP 5.x 바이너리 서식 보존 무손실 라운드트립 패치 — patchHwpx의 HWP5 대응.
 *
 * parse()로 얻은 마크다운을 편집한 뒤 patchHwp()에 넘기면, 원본 HWP의
 * CFB/레코드 구조를 그대로 두고 변경된 문단/표 셀의 PARA_TEXT만 치환한다.
 * 연쇄 갱신: PARA_HEADER nChars, CHAR_SHAPE 위치, LINE_SEG 삭제(한컴이 줄 나눔을 다시 짬), 레코드
 * 크기 재계산 → 섹션 스트림 재직렬화 → deflate 재압축 → CFB 재조립.
 *
 * 안전 게이트 (하나라도 깨지면 해당 수정은 graceful skip — 파일 무결성 우선):
 *  - 섹션 레코드 재직렬화가 원본과 바이트 동일해야 패치 허용
 *  - PARA_TEXT 1개 + 레코드 텍스트 재구성 일치 문단만 수정 — 글 가운데 탭·필드가 있으면 바뀐 글자만 고치고 제어 문자는 바이트째 둔다
 *  - 배포용/암호화/DRM 문서는 전체 거부
 *
 * 지원: 본문 문단/헤딩 텍스트 수정, GFM 표 셀 텍스트 수정 (좌표 기반). 미기입 누름틀의 안내문은 파서처럼 글에서 빼고 맞대며,
 * 그 자리에 쓴 값은 누름틀에 채운다(수정 표시 bit 15).
 * 미지원(graceful skip): 블록 추가/삭제, 표 구조 변경, HTML 표 셀, 캡션·각주·
 * 머리말/꼬리말, 편집이 제어 문자에 걸치는 문단. skipped[]에 사유 보고.
 */

import { deflateRawSync } from "zlib"
import { createRequire } from "module"
import { parseHwp5Document } from "../hwp5/parser.js"
import { unfilledClickHereGuide, isClickHereGuideText } from "../hwp5/body.js"
import {
  decompressStream, parseFileHeader, createParaTextState, appendParaText, readRecords,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE, TAG_ID_MAPPINGS, TAG_DOC_CHAR_SHAPE,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DISTRIBUTION, FLAG_DRM, FLAG_TRACK_CHANGES,
} from "../hwp5/record.js"
import type { IRBlock, IRTable, PatchOptions, PatchResult, PatchSkip, DiffResult } from "../types.js"
import {
  buildOrigUnits, alignUnits, diffUnitLists, textUnitStyled, restyledKept, patchHwpx, fallbackPlain, tableUnitCells, type OrigUnit,
} from "./patcher.js"
import { findRuns, planRunEdits, prepareFallback } from "./text-fallback.js"
import { detectFormat } from "../detect.js"
import {
  splitMarkdownUnits, normForMatch, sanitizeText, parseGfmTable, unescapeGfmCell, unescapeGfm, escapeGfm, summarize, isInlineColumnTable, replicateColumnTable,
  replicateTableToHtml, replicateHtmlTable, parseHtmlTable, htmlCellInnerToLines, extractTopLevelTables,
  stripHeadMarker, stripShownHeadMarker, noScriptTags, editedFromVisual, editedFromWideCols, LAYOUT_MODE_MISMATCH,
  type MdUnit,
} from "./markdown-units.js"
import { stripCellTokens, extractCellTokens, extractImgTags } from "./table-patch.js"
import { hwpCharBook, cellLineStyles, type HwpCharBook, type HwpInsertStyle } from "./hwp5-char-shape.js"
import { replaceOleStream } from "./ole-surgeon.js"
import { parseEmphasis, styledInline, flagsPerChar } from "./inline-edit.js"
import { stageParaPatch } from "./hwp5-para-stage.js"

export { splitParaText } from "./hwp5-para-stage.js"

const require = createRequire(import.meta.url)
const CFB: CfbModule = require("cfb")

interface CfbEntry { name?: string; content?: Buffer | Uint8Array; size?: number }
interface CfbContainer { FileIndex: CfbEntry[]; FullPaths: string[] }
interface CfbModule {
  parse(data: Buffer): CfbContainer
  find(cfb: CfbContainer, path: string): CfbEntry | null
  write(cfb: CfbContainer, opts: { type: "buffer" }): Buffer
}

// 본문 레코드 태그 — record.ts의 TAG_PARA_SHAPE(0x45)는 본문 맥락에선 LINE_SEG
const TAG_PARA_LINE_SEG = 0x0045

/** 4바이트 ASCII → u32 컨트롤 ID ("tbl " → 0x74626c20) — parser.ts cid와 동일 */
function cid(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0
}
const CTRL_TBL = cid("tbl ")
const CTRL_GSO = cid("gso ")

function swap32(id: number): number {
  return (((id & 0xff) << 24) | (((id >>> 8) & 0xff) << 16) | (((id >>> 16) & 0xff) << 8) | ((id >>> 24) & 0xff)) >>> 0
}
function isCtrl(rec: RawRecord, id: number): boolean {
  if (rec.tagId !== TAG_CTRL_HEADER || rec.data.length < 4) return false
  const raw = rec.data.readUInt32LE(0)
  return raw === id || swap32(raw) === id
}

// ─── 레코드 입출력 (엄격 모드 + 재직렬화 동일성 게이트) ──

interface RawRecord { tagId: number; level: number; data: Buffer }

/** 스트림 끝까지 정확히 소비될 때만 성공 — 잔여/비정형 바이트가 있으면 null */
function readRecordsStrict(stream: Buffer): RawRecord[] | null {
  const recs: RawRecord[] = []
  let off = 0
  while (off < stream.length) {
    if (off + 4 > stream.length) return null
    const h = stream.readUInt32LE(off); off += 4
    const tagId = h & 0x3ff
    const level = (h >>> 10) & 0x3ff
    let size = (h >>> 20) & 0xfff
    if (size === 0xfff) {
      if (off + 4 > stream.length) return null
      size = stream.readUInt32LE(off); off += 4
    }
    if (off + size > stream.length) return null
    recs.push({ tagId, level, data: stream.subarray(off, off + size) })
    off += size
  }
  return recs
}

function serializeRecords(recs: RawRecord[], repl?: Map<number, Buffer | null>, inserts?: Map<number, RawRecord[]>): Buffer {
  const parts: Buffer[] = []
  const push = (tagId: number, level: number, data: Buffer) => {
    const ext = data.length >= 0xfff
    const header = Buffer.alloc(ext ? 8 : 4)
    header.writeUInt32LE(((tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((ext ? 0xfff : data.length) << 20)) >>> 0, 0)
    if (ext) header.writeUInt32LE(data.length, 4)
    parts.push(header, data)
  }
  for (let i = 0; i < recs.length; i++) {
    for (const ins of inserts?.get(i) ?? []) push(ins.tagId, ins.level, ins.data)
    const data = repl?.get(i)
    if (data !== null) push(recs[i].tagId, recs[i].level, data ?? recs[i].data)
  }
  return Buffer.concat(parts)
}

// ─── 섹션 스캔 ───────────────────────────────────────

export interface ScanPara5 {
  sectionIndex: number
  headerIdx: number
  kind: "body" | "cell" | "other"
  /** PARA_TEXT 레코드 인덱스: -1=없음(빈 문단), -2=복수(미지원) */
  textIdx: number
  charShapeIdx: number
  lineSegIdx: number
  rangeTagCount: number
  ctrlMask: number
  nCharsRaw: number
  /** extractText 결과 (트림 전 원문) — 미기입 누름틀 안내문은 파서처럼 뺀다 */
  rawText: string
  /** 미기입 누름틀 안내문 구간 (뺄 전 글 위치, 오름차순)과 그 누름틀 CTRL_HEADER 레코드 — rawText 에 없다 */
  guides: Array<{ start: number; end: number; ctrl: number }>
}

interface ScanCell5 { paras: ScanPara5[] }

interface ScanTable5 {
  sectionIndex: number
  rows: number
  cols: number
  /** "row,col" → 셀 (앵커 좌표 기준) */
  cells: Map<string, ScanCell5>
}

export interface SectionScan5 {
  records: RawRecord[]
  /** 재직렬화 바이트 동일성 통과 여부 — 실패 시 이 섹션 패치 금지 */
  safe: boolean
  paras: ScanPara5[]
  tables: ScanTable5[]
  compressed: boolean
  /** 수정 스테이징: 레코드 인덱스 → 새 데이터 (null 이면 그 레코드를 뺀다) */
  repl: Map<number, Buffer | null>
  /** 삽입 스테이징: 레코드 인덱스 → 그 레코드 앞에 삽입할 신규 레코드들 */
  inserts: Map<number, RawRecord[]>
}

function scanSection(stream: Buffer, sectionIndex: number, compressed: boolean): SectionScan5 {
  const records = readRecordsStrict(stream)
  if (!records) return { records: [], safe: false, paras: [], tables: [], compressed, repl: new Map(), inserts: new Map() }
  const safe = serializeRecords(records).equals(stream)

  // 부모 인덱스 계산 (level 기반 스택)
  const parent = new Int32Array(records.length).fill(-1)
  const stack: number[] = []
  for (let i = 0; i < records.length; i++) {
    while (stack.length > 0 && records[stack[stack.length - 1]].level >= records[i].level) stack.pop()
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1
    stack.push(i)
  }
  const ancestorCtrl = (i: number, id: number): boolean => {
    for (let p = parent[i]; p >= 0; p = parent[p]) if (isCtrl(records[p], id)) return true
    return false
  }

  // 문단 수집
  const paras: ScanPara5[] = []
  const parasByHeader = new Map<number, ScanPara5>()
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.tagId !== TAG_PARA_HEADER || rec.data.length < 18) continue
    let textIdx = -1
    let charShapeIdx = -1
    let lineSegIdx = -1
    const state = createParaTextState()
    const ctrlRecs: number[] = []
    for (let j = i + 1; j < records.length && records[j].level > rec.level; j++) {
      if (records[j].level !== rec.level + 1) continue
      const t = records[j].tagId
      if (t === TAG_PARA_TEXT) {
        textIdx = textIdx === -1 ? j : -2
        appendParaText(state, records[j].data)
      } else if (t === TAG_CHAR_SHAPE && charShapeIdx === -1) charShapeIdx = j
      else if (t === TAG_PARA_LINE_SEG && lineSegIdx === -1) lineSegIdx = j
      else if (t === TAG_CTRL_HEADER) ctrlRecs.push(j)
    }
    // 미기입 누름틀 안내문은 파서가 글에서 뺀다(인쇄되지 않는 글) — 소스맵 글도 빼야 IR 문단과 맞는다
    const guides: ScanPara5["guides"] = []
    for (const r of [...state.fieldRanges].sort((a, b) => a.start - b.start)) {
      const ctrl = ctrlRecs[r.ctrlIdx] ?? -1
      const guide = ctrl >= 0 ? unfilledClickHereGuide(records[ctrl].data) : undefined
      if (guide === undefined || !isClickHereGuideText(state.text.slice(r.start, r.end), guide)) continue
      if (guides.length && r.start < guides[guides.length - 1].end) continue
      guides.push({ start: r.start, end: r.end, ctrl })
    }
    let rawText = state.text
    for (const g of [...guides].reverse()) rawText = rawText.slice(0, g.start) + rawText.slice(g.end)

    // 분류: 컨트롤 무관(또는 글상자 내부) → body, 그 외 → other.
    // 표 셀 문단은 아래 표 수집 패스에서 "cell"로 재분류된다 (셀 문단은
    // LIST_HEADER의 자식이 아니라 같은 레벨 형제 — 부모 체인으론 식별 불가).
    let ctrlSeen = false, nonGso = false
    for (let a = parent[i]; a >= 0; a = parent[a]) {
      if (records[a].tagId === TAG_CTRL_HEADER) {
        ctrlSeen = true
        if (!isCtrl(records[a], CTRL_GSO)) nonGso = true
      }
    }
    const kind: ScanPara5["kind"] = !ctrlSeen || !nonGso ? "body" : "other"

    const para: ScanPara5 = {
      sectionIndex, headerIdx: i, kind, textIdx, charShapeIdx, lineSegIdx,
      rangeTagCount: rec.data.readUInt16LE(14),
      ctrlMask: rec.data.readUInt32LE(4),
      nCharsRaw: rec.data.readUInt32LE(0),
      rawText,
      guides,
    }
    paras.push(para)
    parasByHeader.set(i, para)
  }

  // 최상위 표 수집 (다른 tbl 내부에 중첩된 표 제외 — IR 최상위 표 서수와 정렬)
  const tables: ScanTable5[] = []
  for (let i = 0; i < records.length; i++) {
    if (!isCtrl(records[i], CTRL_TBL) || ancestorCtrl(i, CTRL_TBL)) continue
    const ctrlLevel = records[i].level
    let rows = 0, cols = 0, tableIdx = -1
    for (let j = i + 1; j < records.length && records[j].level > ctrlLevel; j++) {
      if (records[j].level === ctrlLevel + 1 && records[j].tagId === TAG_TABLE && records[j].data.length >= 8) {
        rows = records[j].data.readUInt16LE(4)
        cols = records[j].data.readUInt16LE(6)
        tableIdx = j
        break
      }
    }
    if (tableIdx < 0 || rows === 0 || cols === 0) continue
    // 셀 문단은 LIST_HEADER와 같은 레벨의 후속 형제 — parser.ts parseCell과 동일 경계
    const cells = new Map<string, ScanCell5>()
    let j = tableIdx + 1
    while (j < records.length && records[j].level > ctrlLevel) {
      if (records[j].tagId !== TAG_LIST_HEADER) { j++; continue }
      const lh = records[j]
      const cellLevel = lh.level
      const cellParas: ScanPara5[] = []
      let k = j + 1
      while (k < records.length) {
        const r = records[k]
        if (r.level < cellLevel) break
        if (r.level === cellLevel && (r.tagId === TAG_LIST_HEADER || r.tagId === TAG_TABLE)) break
        if (r.level === cellLevel && r.tagId === TAG_PARA_HEADER) {
          const cp = parasByHeader.get(k)
          if (cp) { cp.kind = "cell"; cellParas.push(cp) }
        }
        k++
      }
      if (lh.data.length >= 16) {
        cells.set(`${lh.data.readUInt16LE(10)},${lh.data.readUInt16LE(8)}`, { paras: cellParas })
      }
      j = k
    }
    tables.push({ sectionIndex, rows, cols, cells })
  }

  return { records, safe, paras, tables, compressed, repl: new Map(), inserts: new Map() }
}

// ─── 메인 API ────────────────────────────────────────

/**
 * 원본 HWP 5.x와 편집된 마크다운으로 서식 보존 패치본을 만든다.
 *
 * @param original 원본 HWP 바이트 (OLE2/CFB — 속이 HWPX(ZIP)인 문서는 patchHwpx 로 넘긴다)
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
export async function patchHwp(
  original: Uint8Array,
  editedMarkdown: string,
  options?: PatchOptions,
): Promise<PatchResult> {
  // .hwp 이름의 HWPX 등 속이 HWP 5.x 가 아닌 입력 — 매직 바이트 판정·거절은 patchHwpx 한 곳에서 (설명도 거기)
  if (detectFormat(new Uint8Array(original.subarray(0, 512)).buffer) !== "hwp") return patchHwpx(original, editedMarkdown, options)
  const skipped: PatchSkip[] = []
  let applied = 0
  const originalBuf = Buffer.from(original.buffer, original.byteOffset, original.byteLength)

  // 1) CFB + FileHeader — 배포용/암호화 거부
  let cfb: CfbContainer
  try {
    cfb = CFB.parse(originalBuf)
  } catch (err) {
    return fail(`CFB 컨테이너 파싱 실패: ${msg(err)}`)
  }
  const fhEntry = CFB.find(cfb, "/FileHeader")
  if (!fhEntry?.content) return fail("FileHeader 스트림이 없습니다 — HWP 5.x 파일이 아닙니다")
  let flags: number
  try {
    flags = parseFileHeader(Buffer.from(fhEntry.content)).flags
  } catch (err) {
    return fail(`FileHeader 파싱 실패: ${msg(err)}`)
  }
  if (flags & (FLAG_ENCRYPTED | FLAG_DISTRIBUTION | FLAG_DRM)) {
    return fail("암호화/배포용/DRM 문서는 패치를 지원하지 않습니다")
  }
  const compressed = (flags & FLAG_COMPRESSED) !== 0
  // 글자 모양 책 — 새 글을 마크다운 서식대로 넣을 짝 글자 모양 (DocInfo 를 못 읽으면 없음: 서식은 들어갈 run 그대로). 짝이 없을 때
  // 새로 만드는 건 DocInfo 를 바이트 그대로 다시 쓸 수 있고 ID_MAPPINGS 글자 모양 개수가 레코드 수와 맞을 때만
  let charBook: HwpCharBook | undefined
  let docInfoRecs: RawRecord[] | undefined
  try {
    const di = CFB.find(cfb, "/DocInfo")?.content
    if (di) {
      const stream = compressed ? decompressStream(Buffer.from(di)) : Buffer.from(di)
      const recs = readRecordsStrict(stream)
      const idm = recs?.find(r => r.tagId === TAG_ID_MAPPINGS)
      const writable = !!recs && !!idm && idm.data.length >= 40 && serializeRecords(recs).equals(stream)
        && idm.data.readInt32LE(36) === recs.filter(r => r.tagId === TAG_DOC_CHAR_SHAPE).length
        && recs.map(r => r.tagId).lastIndexOf(TAG_DOC_CHAR_SHAPE) < recs.length - 1
      charBook = hwpCharBook(recs ?? readRecords(stream), writable)
      if (writable) docInfoRecs = recs!
    }
  } catch { /* 책 없이 — 서식은 run 그대로 */ }

  // 2) 원본 파싱 (기존 파서 그대로 — IR 블록 확보)
  //    원본 표 서수로 위치를 찾으므로 틀 표를 풀지 않은 keep 출력이 기준 — 편집본이 기본(visual) 출력이면 분명히 알린다
  //    편집본이 끝 빈 열 보존(--keep-empty-cols) 추출이면 그 IR 이 기준 — 기본 추출은 끝 빈 입력칸을 잘라 그 칸을 채울 수 없다 (#144)
  let origBlocks: IRBlock[]
  let keepTrailingEmptyCols = false
  try {
    const trimmed = parseHwp5Document(originalBuf, { layoutTables: "keep" })
    const wide = parseHwp5Document(originalBuf, { layoutTables: "keep", keepTrailingEmptyCols: true })
    keepTrailingEmptyCols = editedFromWideCols(trimmed.markdown, wide.markdown, editedMarkdown)
    const kept = keepTrailingEmptyCols ? wide : trimmed
    origBlocks = kept.blocks
    const visual = parseHwp5Document(originalBuf, { keepTrailingEmptyCols }).markdown
    // 기본 출력이 keep과 달라도 글을 고치지 않았다면 위치 매핑 없이 원본을 그대로 돌려준다.
    if (kept.markdown !== visual && editedMarkdown === visual) {
      const verification = options?.verify === false ? undefined
        : diffUnitLists(splitMarkdownUnits(visual), splitMarkdownUnits(editedMarkdown))
      return { success: true, data: new Uint8Array(original), applied: 0, skipped, verification }
    }
    if (editedFromVisual(kept.markdown, visual, editedMarkdown)) return fail(LAYOUT_MODE_MISMATCH)
  } catch (err) {
    return fail(`원본 HWP 파싱 실패: ${msg(err)}`)
  }

  // 3) 섹션 스트림 스캔
  const sectionPaths = cfb.FullPaths
    .map(p => p.replace(/^Root Entry/, ""))
    .filter(p => /^\/BodyText\/Section\d+$/.test(p))
    .sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]))
  if (sectionPaths.length === 0) return fail("BodyText 섹션 스트림을 찾을 수 없습니다")

  const scans: SectionScan5[] = []
  for (let i = 0; i < sectionPaths.length; i++) {
    const entry = CFB.find(cfb, sectionPaths[i])
    if (!entry?.content) return fail(`섹션 스트림 읽기 실패: ${sectionPaths[i]}`)
    let stream: Buffer
    try {
      stream = compressed ? decompressStream(Buffer.from(entry.content)) : Buffer.from(entry.content)
    } catch (err) {
      return fail(`섹션 압축 해제 실패: ${msg(err)}`)
    }
    scans.push(scanSection(stream, i, compressed))
  }

  // 4) 유닛 구성 + 정렬 (HWPX 패처와 동일한 마크다운 도메인 diff)
  const origUnits = buildOrigUnits(origBlocks)
  const editedUnits = splitMarkdownUnits(editedMarkdown)
  const pairs = alignUnits(origUnits.map(u => u.raw), editedUnits.map(u => u.raw))

  const paraMap = resolveParaMappings(origBlocks, scans)
  const tableMap = resolveTableMappings(origBlocks, scans.flatMap(s => s.tables))

  // 5) 변경 적용 (스테이징)
  const ctx: PatchCtx5 = { origBlocks, paraMap, scans, tableMap, skipped, keepLineseg: options?.keepLineseg === true, charBook }
  const unitKeys = origUnits.map(u => (u.kind === "text" ? fallbackPlain(u.raw, origBlocks[u.blockIdx]).replace(/\s+/g, "") : ""))
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      const orig = origUnits[oi]
      const edited = editedUnits[ei]
      if (orig.raw === edited.raw) continue
      applied += modifyUnit5(oi, orig, edited, ctx, unitKeys)
    } else if (oi !== null) {
      skipped.push({ reason: "블록 삭제는 미지원 (v1) — 원본 유지", before: summarize(origUnits[oi].raw) })
    } else if (ei !== null) {
      skipped.push({ reason: "블록 추가는 미지원 (v1)", after: summarize(editedUnits[ei].raw) })
    }
  }

  // 6) 섹션 재직렬화 + 재압축 + 섹터 레벨 in-place 교체 — 컨테이너 전체 재조립 없음
  //    (수정된 섹션의 데이터 섹터/FAT 체인/디렉토리 start·size 외에는 원본 바이트 유지)
  let data: Uint8Array
  const warnings: string[] = []
  const dirty = scans.some(s => s.repl.size > 0 || s.inserts.size > 0)
  if (!dirty) {
    data = new Uint8Array(original)
  } else {
    try {
      let out = originalBuf
      for (let i = 0; i < scans.length; i++) {
        if (scans[i].repl.size === 0 && scans[i].inserts.size === 0) continue
        const newStream = serializeRecords(scans[i].records, scans[i].repl, scans[i].inserts)
        const content = compressed ? compressWithTail(newStream) : newStream
        out = replaceOleStream(out, sectionPaths[i], content)
      }
      // 새로 만든 글자 모양(붙인 글을 마크다운 서식대로) — CHAR_SHAPE 끝에 덧붙이고 ID_MAPPINGS 개수를 올린다
      const added = charBook?.added() ?? []
      if (added.length && docInfoRecs) {
        const last = docInfoRecs.map(r => r.tagId).lastIndexOf(TAG_DOC_CHAR_SHAPE)
        const idm = docInfoRecs.findIndex(r => r.tagId === TAG_ID_MAPPINGS)
        const counts = Buffer.from(docInfoRecs[idm].data)
        counts.writeInt32LE(counts.readInt32LE(36) + added.length, 36)
        const stream = serializeRecords(docInfoRecs, new Map([[idm, counts]]),
          new Map([[last + 1, added.map(data => ({ tagId: TAG_DOC_CHAR_SHAPE, level: docInfoRecs![last].level, data }))]]))
        out = replaceOleStream(out, "/DocInfo", compressed ? compressWithTail(stream) : stream)
      }
      // 변경 추적 문서는 한컴이 ViewText(고치기 전 사본)를 그려 고친 글이 화면에 안 나온다 — 추적 표시를 끄면 BodyText 를 그린다
      // (한컴 맥 실측: 표시를 끈 패치본은 고친 글이 보이고 글자 수가 추적 기록을 뺀 지금 내용만큼으로 준다)
      if (flags & FLAG_TRACK_CHANGES) {
        const header = Buffer.from(fhEntry.content)
        header.writeUInt32LE((flags & ~FLAG_TRACK_CHANGES) >>> 0, 36)
        out = replaceOleStream(out, "/FileHeader", header)
        warnings.push("변경 내용 추적 문서라 한글이 고친 본문을 그리도록 추적 표시를 껐습니다. 한글에서는 지금 내용만 보이고 누가 무엇을 바꿨는지의 기록은 보이지 않습니다(원본 파일에는 남아 있음).")
      }
      data = new Uint8Array(out)
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `HWP 섹터 수술 실패: ${msg(err)}` }
    }
  }

  // 7) 자동 검증 — 패치본 재파싱 vs 편집 마크다운
  let verification: DiffResult | undefined
  if (options?.verify !== false) {
    try {
      const reparsed = parseHwp5Document(Buffer.from(data), { layoutTables: "keep", keepTrailingEmptyCols })
      // 본문 문단은 \n(재파싱 방출)과 <br>(편집)로 강제 줄바꿈 표기 규약이 달라 raw 비교가
      // 항상 잔차를 낸다 — 표기를 통일해 완전 적용된 패치를 '잔차'로 오보고하지 않게 한다 (hwp5-2)
      const normBr = (u: MdUnit): MdUnit => ({ ...u, raw: u.raw.replace(/<br\s*\/?\s*>/gi, "\n") })
      verification = diffUnitLists(splitMarkdownUnits(reparsed.markdown).map(normBr), editedUnits.map(normBr))
    } catch (err) {
      return { success: false, applied, skipped, error: `패치본 재파싱 실패 — 패치 중단: ${msg(err)}` }
    }
  }

  return { success: true, data, applied, skipped, verification, ...(warnings.length ? { warnings } : {}) }

  function fail(error: string): PatchResult {
    return { success: false, applied: 0, skipped, error }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── 문단 매핑 (IR 블록 ↔ 스캔 문단) ─────────────────

interface ParaMapping5 {
  para?: ScanPara5
  /** 자동번호/글머리 접두가 IR 텍스트에 붙어 있었음 (레코드 텍스트에는 없음) */
  prefixStripped?: boolean
}

/**
 * 같은 정규화 텍스트끼리 등장 순서대로 페어링 (중복 문단 대응) — HWPX 패처와 동일 방식.
 * 셀 문단도 버킷에 포함 (flattenLayoutTables로 해체된 레이아웃 표 문단이 IR에선 문단 블록).
 * 단, 같은 텍스트가 여러 위치에 있고 본문 문단만으로 구성되지 않으면 모호 — 매핑 포기. 다만 칸 문단 수가 IR 표 칸 등장 수와 같고
 * 본문 문단 수가 IR 문단 등장 수와 같으면 칸은 표 경로 몫이므로 본문 문단끼리 순서대로 짝짓는다("○○소장 귀하"가 본문과 서식 표에)
 */
function resolveParaMappings(blocks: IRBlock[], scans: SectionScan5[]): Map<number, ParaMapping5> {
  const buckets = new Map<string, ScanPara5[]>()
  for (const scan of scans) {
    for (const para of scan.paras) {
      if (para.kind === "other") continue
      const key = normForMatch(para.rawText)
      if (!key) continue
      let list = buckets.get(key)
      if (!list) buckets.set(key, (list = []))
      list.push(para)
    }
  }
  // IR 문단 블록·표 칸(칸은 한 번씩, 줄마다)에 나오는 횟수
  const irParas = new Map<string, number>(), inTables = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string): void => { if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  for (const b of blocks) {
    if ((b.type === "paragraph" || b.type === "heading") && b.text) bump(irParas, normForMatch(b.text))
    if (b.type !== "table" || !b.table) continue
    for (const cell of new Set(b.table.cells.flat())) if (cell) for (const line of cell.text.split("\n")) bump(inTables, normForMatch(line))
  }
  /** 등장 순서로 짝지을 문단 목록 — 하나뿐이거나 전부 본문이면 그대로, 칸이 섞였으면 위 조건일 때 본문만, 아니면 null(모호) */
  const pairable = (key: string, list: ScanPara5[]): ScanPara5[] | null => {
    if (list.length === 1 || list.every(p => p.kind === "body")) return list
    const body = list.filter(p => p.kind === "body")
    return body.length && body.length === (irParas.get(key) ?? 0) && list.length - body.length === (inTables.get(key) ?? 0) ? body : null
  }

  const counters = new Map<string, number>()
  const result = new Map<number, ParaMapping5>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text) continue
    // 첨자 태그는 파서 표기(원문 PARA_TEXT 엔 없다)라 떼고 맞댄다 (HWPX resolveParagraphMappings 와 같다)
    const text = noScriptTags(b.text)
    let key = normForMatch(text)
    let prefixStripped = false
    if (!buckets.has(key)) {
      // 자동번호/글머리 접두 제거 후 재시도 (파서가 붙인 headMarker)
      const sp = text.indexOf(" ")
      if (sp > 0) {
        const alt = normForMatch(text.slice(sp + 1))
        if (alt && buckets.has(alt)) { key = alt; prefixStripped = true }
      }
    }
    const found = buckets.get(key)
    const list = found ? pairable(key, found) : null
    if (!list) { result.set(i, {}); continue }
    const occ = counters.get(key) ?? 0
    counters.set(key, occ + 1)
    result.set(i, occ < list.length ? { para: list[occ], prefixStripped } : {})
  }
  return result
}

/**
 * IR 표 블록 ↔ 스캔 표 매핑. flattenLayoutTables가 일부 표를 문단으로 해체하면
 * IR 표 수 < 바이너리 표 수가 되어 단순 서수 인덱싱이 밀린다(엉뚱한 표 수정 위험).
 * 문서 순서를 보존한 채 rows×cols 시그니처로 매칭하고, 같은 시그니처 표가 여러 개면
 * 셀 텍스트 정합 점수로 택일한다. 매핑 못 한 표는 누락(조회 시 skip → 안전).
 */
function resolveTableMappings(blocks: IRBlock[], scanTables: ScanTable5[]): Map<number, ScanTable5> {
  const result = new Map<number, ScanTable5>()
  let si = 0
  for (let i = 0; i < blocks.length; i++) {
    const table = blocks[i].table
    if (blocks[i].type !== "table" || !table) continue
    const cands: number[] = []
    for (let k = si; k < scanTables.length; k++) {
      if (scanTables[k].rows === table.rows && scanTables[k].cols === table.cols) cands.push(k)
    }
    // IR 은 후행 빈 열을 자른다(#47 기본 계약) — 열이 더 많은 스캔 표도 후보. 잘린 열은 항상 뒤쪽이라 (행, 열) 좌표가 그대로다
    if (cands.length === 0) {
      for (let k = si; k < scanTables.length; k++) {
        if (scanTables[k].rows === table.rows && scanTables[k].cols > table.cols) cands.push(k)
      }
    }
    if (cands.length === 0) continue
    let pick = cands[0]
    if (cands.length > 1) {
      let best = tableContentScore(table, scanTables[cands[0]])
      for (let ci = 1; ci < cands.length; ci++) {
        const sc = tableContentScore(table, scanTables[cands[ci]])
        if (sc > best) { best = sc; pick = cands[ci] }
      }
    }
    result.set(i, scanTables[pick])
    si = pick + 1
  }
  return result
}

/** 앵커 셀 좌표가 겹치는 셀들의 정규화 텍스트 일치 개수 (표 디스앰비규에이션용) */
function tableContentScore(irTable: IRTable, scanTable: ScanTable5): number {
  let matched = 0
  for (const [key, scanCell] of scanTable.cells) {
    const comma = key.indexOf(",")
    const r = Number(key.slice(0, comma)), c = Number(key.slice(comma + 1))
    const irCell = irTable.cells[r]?.[c]
    if (!irCell) continue
    const a = normForMatch(scanCell.paras.map(p => p.rawText).join(" "))
    const b = normForMatch(stripCellTokens(irCell.text))
    if (a && a === b) matched++
  }
  return matched
}

// ─── 변경 처리 ───────────────────────────────────────

interface PatchCtx5 {
  origBlocks: IRBlock[]
  paraMap: Map<number, ParaMapping5>
  scans: SectionScan5[]
  tableMap: Map<number, ScanTable5>
  skipped: PatchSkip[]
  keepLineseg: boolean
  /** DocInfo 글자 모양 책 — 새 글을 마크다운 서식대로 (hwp5-char-shape) */
  charBook?: HwpCharBook
}

function handleModified(orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5): number {
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
    const scanTable = ctx.tableMap.get(orig.blockIdx)
    if (!scanTable) return skip("표 소스맵 매핑 실패 — 표 개수/구조 불일치로 신뢰 불가")
    if (orig.kind === "gfm-table") return patchGfmCells(scanTable, orig, edited, ctx, skip)
    if (orig.kind === "html-table") return patchHtmlCells5(block.table, scanTable, orig, edited, ctx, skip)
    return patchTextChunk5(block.table, scanTable, orig, edited, ctx, skip)
  }

  if ((block.type === "paragraph" || block.type === "heading") && orig.kind === "text") {
    if (edited.kind === "text") return patchParagraph(block, orig, edited, ctx, skip)
    // 문단→표 인플레이스 변환은 HWPX만 지원. HWP5 바이너리는 표 레코드 트리(+DocInfo
    // borderFill) 삽입이 무손실 게이트와 충돌하므로 미지원 — 대안을 안내하고 skip.
    if (edited.kind === "gfm-table" || edited.kind === "html-table") {
      return skip("HWP5(.hwp) 바이너리는 문단→표 인플레이스 변환 미지원 — generate로 새 문서를 만들거나, HWPX(.hwpx)로 저장 후 patch하세요")
    }
  }

  return skip("지원하지 않는 블록 유형 변경")
}

/**
 * 변경 유닛 — 좌표 경로(handleModified)가 한 건도 못 고쳤으면 그 경로의 스테이징·건너뜀을 되돌리고 원문 글을 문단에서 찾아
 * 바뀐 자리만 고친다(text-fallback). 문단·글자 모양은 원문 그대로다. 빈 칸 채우기는 좌표 경로만 한다
 */
function modifyUnit5(oi: number, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5, unitKeys: string[]): number {
  const snapshot = () => ctx.scans.map(s => ({ repl: new Map(s.repl), inserts: new Map([...s.inserts].map(([k, v]): [number, RawRecord[]] => [k, [...v]])) }))
  const restore = (snap: ReturnType<typeof snapshot>) => ctx.scans.forEach((s, i) => { s.repl = snap[i].repl; s.inserts = snap[i].inserts })
  const before = snapshot()
  const skipSnap = ctx.skipped.length
  const n = handleModified(orig, edited, ctx)
  const fresh = ctx.skipped.slice(skipSnap)
  if (n > 0 || fresh.length === 0 || fresh.every(s => s.partial)) return n
  if (orig.kind !== edited.kind || orig.kind === "separator" || orig.kind === "image") return n
  const after = snapshot()
  restore(before)

  const edit = (origLines: string, newLines: string, occ: number, total: number, scope?: ScanPara5[]): boolean => {
    const { origPlain, newPlain, opt } = prepareFallback(origLines, newLines)
    if (!origPlain.trim() || origPlain === newPlain) return false
    const groups = scope ? [scope] : ctx.scans.map(s => s.paras)
    const runs = groups.flatMap(ps => findRuns(ps.map(p => p.rawText), origPlain, opt).map(([i, j]) => ps.slice(i, j + 1)))
    const run = runs.length === 1 ? runs[0] : runs.length === total && origPlain.replace(/\s+/g, "").length >= 4 ? runs[occ] : undefined
    const plan = run && planRunEdits(run.map(p => p.rawText), origPlain, newPlain, opt)
    if (!run || !plan) return false
    const mark = snapshot()
    for (let k = 0; k < run.length; k++) {
      if (!plan[k].length) continue
      const raw = run[k].rawText
      let next = raw
      for (const e of [...plan[k]].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end)
      // 줄바꿈 든 새 글은 통째 쓰기 경로라 앞뒤 공백을 그쪽이 붙인다
      if (!stageParaPatch(ctx.scans[run[k].sectionIndex], run[k], next.includes("\n") ? next.trim() : next, () => 0, ctx.keepLineseg, raw)) {
        restore(mark)
        return false
      }
    }
    return true
  }

  let applied = 0
  const failed: Array<{ before: string; after: string }> = []
  const block = ctx.origBlocks[orig.blockIdx]
  if (orig.kind === "text") {
    const k = unitKeys[oi] ?? ""
    let occ = 0, total = 0
    unitKeys.forEach((x, i) => { if (x === k) { total++; if (i < oi) occ++ } })
    if (edit(fallbackPlain(orig.raw, block), fallbackPlain(edited.raw, block), occ, Math.max(total, 1))) applied = 1
  } else {
    const o = tableUnitCells(orig), e = tableUnitCells(edited)
    if (o && e && o.length === e.length && o.every((r, i) => r.length === e[i].length)) {
      const table = ctx.tableMap.get(orig.blockIdx)
      const scope = table ? [...table.cells.values()].flatMap(c => c.paras).sort((a, b) => a.headerIdx - b.headerIdx) : undefined
      const keys = o.flat().map(c => c.replace(/\s+/g, ""))
      o.flat().forEach((oc, f) => {
        const ec = e.flat()[f]
        if (oc === ec || keys[f] === ec.replace(/\s+/g, "")) return
        const occ = keys.slice(0, f).filter(x => x === keys[f]).length
        if (!oc.startsWith("\u0000") && keys[f] && edit(oc, ec, occ, keys.filter(x => x === keys[f]).length, scope)) applied++
        else failed.push({ before: oc.replace("\u0000", ""), after: ec.replace("\u0000", "") })
      })
    }
  }
  if (applied === 0) {
    restore(after)
    return n
  }
  ctx.skipped.length = skipSnap
  for (const f of failed) ctx.skipped.push({ reason: "표 칸 위치를 찾지 못함 — 이 칸만 미적용", before: summarize(f.before), after: summarize(f.after) })
  return applied
}

// ── 문단 ──

function patchParagraph(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5,
  skip: (reason: string) => number,
): number {
  const mapping = ctx.paraMap.get(orig.blockIdx)
  if (!mapping?.para) return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)")

  // <br> 명시 줄바꿈 → \n 복원 (셀 규약과 동일). md의 bare 개행은 soft-wrap이라
  // textUnitToPlain이 공백으로 접으므로, 본문 문단의 강제 줄바꿈은 <br>로만 표현·수정한다.
  // 연속 <br> 는 단일 \n 으로 접는다 — <br><br>(빈 줄)이 \n\n 으로 기록되면 재파싱 시
  // 한 문단이 둘로 분열돼 이후 영구 수정불가(fragment)가 되는 것을 방지 (hwp5-4)
  const restoreBr = (s: string): string => s.replace(/(?:\s*<br\s*\/?\s*>\s*)+/gi, "\n")
  // 강조 표지·첨자 태그는 걷는다(원문 PARA_TEXT 엔 없다) — 서식 비트는 새 글을 마크다운 서식대로 넣는 데 쓴다.
  // 강제 줄바꿈 문단은 마크다운이 줄바꿈을 맨 줄바꿈으로 내므로 줄을 "\n" 으로 잇는다 (HWPX patchLineBreakParagraph 와 같다)
  const sep = block.text?.includes("\n") ? "\n" : " "
  const editedStyled = textUnitStyled(edited.raw, block, sep)
  const origStyled = textUnitStyled(orig.raw, block, sep)
  let newPlain = restoreBr(editedStyled.plain)
  // 원본이 다중줄인데 새 값에 줄바꿈 표기가 없으면 — soft-wrap 접힘과 줄바꿈 제거 의도를
  // 구분할 수 없어 줄바꿈 위치 보존 불가 (기존 v1 전면 가드의 정밀화)
  if (block.text && block.text.includes("\n") && !newPlain.includes("\n")) {
    return skip("다중줄 문단 수정에 <br> 없음 — 줄바꿈 위치 보존 불가로 미지원 (줄바꿈은 <br>로 표기)")
  }

  // 각주 표기 — 본문이 아닌 각주 컨트롤에 있으므로 분리
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

  // 자동번호·글머리표 접두 — 레코드에 없는 텍스트이므로 떼고 기록
  if (mapping.prefixStripped) {
    const head = stripHeadMarker(block.text!, newPlain)
    newPlain = head.text
    if (head.note) ctx.skipped.push({ reason: head.note, after: summarize(newPlain), partial: true })
  }

  // 원본 비교는 block.text(강제 줄바꿈 \n 보존) 기준 — textUnitToPlain 은 \n 을 공백으로
  // 접어 <br>→\n 복원본과 절대 같아질 수 없어, 표기만 바꾼(\n↔<br>) no-op 편집을 수정으로
  // 오판하고 문단을 재기록해 중간 서식(CHAR_SHAPE 다중 런)을 파괴했다 (hwp5-1)
  const origPlain = block.text != null ? noScriptTags(block.text) : restoreBr(origStyled.plain)
  if (newPlain === origPlain) return skip("텍스트 외 변경(헤딩 레벨/서식)만 감지 — 스타일 변경은 미지원")
  // 재파싱 정리에서 바뀌는 글(이중 공백 등)은 미지원 — 단 원문 문단이 이미 그 꼴(마크다운에 이중 공백이 그대로 보이는 문단)이면
  // 같은 렌더 경로라 허용한다: 바뀐 자리만 고쳐 원문 띄어쓰기는 그대로 남는다 (HWPX patcher 와 같다)
  if (sanitizeText(newPlain) !== newPlain && sanitizeText(origPlain) === origPlain) {
    return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
  }

  // 바뀐 자리 계산용 원문 평문: 편집본과 같은 마크다운 경로(공백 접힘·표지 걷기)를 거쳐야 diff 가 고친 자리만 잡는다
  let origMd = restoreBr(origStyled.plain)
  if (block.footnoteText) origMd = origMd.replace(/\s*\(주: [\s\S]*\)$/, "")
  if (mapping.prefixStripped) origMd = stripShownHeadMarker(block.text!, origMd)
  // 서식 비트는 평문 좌표를 맞댈 수 있을 때만 — 앞의 머리 기호만 뗀 글은 그만큼 민다(줄바꿈·각주를 걷은 문단은 끈다)
  const off = editedStyled.plain.length - newPlain.length
  const style: HwpInsertStyle | undefined = ctx.charBook && off >= 0 && editedStyled.plain.endsWith(newPlain) && origStyled.plain.endsWith(origMd)
    ? { flags: flagsPerChar(editedStyled.segs, editedStyled.flags).slice(off), known: origStyled.flags.reduce((a, b) => a | b, 0), book: ctx.charBook }
    : undefined
  const n = stageParaPatch(ctx.scans[mapping.para.sectionIndex], mapping.para, newPlain, skip, ctx.keepLineseg, origMd, style)
  // 맞는 글자 모양을 못 구했거나, 바뀐 자리 밖 글의 강조를 바꾼 편집(그 글자 모양은 안 고친다) — HWPX 와 같다
  if (n && (style?.missed || (style && restyledKept(origStyled, editedStyled, origStyled.plain, editedStyled.plain)))) {
    ctx.skipped.push({ reason: "강조(굵게·밑줄 등) 추가·삭제는 미지원: 글만 적용, 원문 글자 모양 유지", before: summarize(orig.raw), after: summarize(edited.raw), partial: true })
  }
  return n
}

// ── GFM 표 셀 ──

function patchGfmCells(
  scanTable: ScanTable5, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5,
  skip: (reason: string) => number,
): number {
  const origRows = parseGfmTable(orig.lines)
  const editedRows = parseGfmTable(edited.lines)
  if (origRows.length !== editedRows.length || origRows.some((r, i) => r.length !== editedRows[i].length)) {
    return skip("표 구조 변경(행/열 수)은 미지원 (v1)")
  }

  let applied = 0
  for (let r = 0; r < origRows.length; r++) {
    for (let c = 0; c < origRows[r].length; c++) {
      if (origRows[r][c] === editedRows[r][c]) continue
      const cellSkip = (reason: string) => {
        ctx.skipped.push({ reason, before: summarize(origRows[r][c]), after: summarize(editedRows[r][c]) })
        return 0
      }
      const cell = scanTable.cells.get(`${r},${c}`)
      if (!cell) { cellSkip("병합 영역 셀 — 앵커 셀이 아니므로 미지원"); continue }

      // 셀 내 여러 문단은 GFM에서 <br>로 이어진다 — 분할해 각 문단과 1:1 매핑한다.
      // (단일 문단 셀도 분할 1개로 동일 경로. 문단 수가 다르면 추가/삭제이므로 미지원.)
      const beforeParts = origRows[r][c].split(/<br\s*\/?>/i)
      const afterParts = editedRows[r][c].split(/<br\s*\/?>/i)
      // 단일 문단 셀: <br>로 나뉜 여러 줄을 문단 추가 없이 한 문단 안 강제 줄바꿈(\n)으로 채운다.
      // (다중 문단 셀은 아래 1:1 매핑 유지 — 문단 구조를 보존해야 하므로.)
      if (cell.paras.length === 1) {
        const beforeEach = beforeParts.map(gfmCellToPlain)
        const afterEach = afterParts.map(gfmCellToPlain)
        if (beforeEach.some(p => p === null) || afterEach.some(p => p === null)) { cellSkip("서식/링크/이미지 포함 셀 수정은 미지원 (v1)"); continue }
        const before = beforeEach.join("\n")
        const after = afterEach.join("\n")
        if (before === after) continue
        const para = cell.paras[0]
        if (normForMatch(para.rawText) !== normForMatch(before)) { cellSkip("셀 텍스트 불일치 — 소스맵 신뢰 불가"); continue }
        if (afterEach.some(l => sanitizeText(l!) !== l)) { cellSkip("공백 정규화 불안정 텍스트 — 미지원"); continue }
        applied += stageParaPatch(ctx.scans[para.sectionIndex], para, after, cellSkip, ctx.keepLineseg, before, // 바뀐 자리만 — 굵은 조각 등 run 유지
          cellLineStyles(origRows[r][c], editedRows[r][c], ctx.charBook)(0, after))
        continue
      }
      if (beforeParts.length !== cell.paras.length || afterParts.length !== cell.paras.length) {
        cellSkip("셀 문단 수 변경 — 미지원 (문단 추가/삭제)"); continue
      }
      for (let k = 0; k < cell.paras.length; k++) {
        const before = gfmCellToPlain(beforeParts[k])
        const after = gfmCellToPlain(afterParts[k])
        if (before === null || after === null) { cellSkip("서식/링크/이미지 포함 셀 수정은 미지원 (v1)"); break }
        if (before === after) continue
        if (after.includes("\n")) { cellSkip("셀 내 줄바꿈 추가는 미지원 (v1)"); break }
        const para = cell.paras[k]
        if (normForMatch(para.rawText) !== normForMatch(before)) { cellSkip("셀 텍스트 불일치 — 소스맵 신뢰 불가"); break }
        if (sanitizeText(after) !== after) { cellSkip("공백 정규화 불안정 텍스트 — 미지원"); break }
        applied += stageParaPatch(ctx.scans[para.sectionIndex], para, after, cellSkip, ctx.keepLineseg, before, // 바뀐 자리만 — 굵은 조각 등 run 유지
          cellLineStyles(origRows[r][c], editedRows[r][c], ctx.charBook)(k, after))
      }
    }
  }
  return applied
}

// ── HTML 표 (병합셀/줄바꿈 셀) — HWPX patchHtmlTableRaw 미러 ──

/**
 * 병합셀/줄바꿈 셀 표 패치. builder의 tableToHtml 렌더를 좌표 추적 버전으로 재현해
 * 편집된 셀의 격자 좌표(=앵커 좌표)를 역산, scanTable.cells 앵커로 셀 문단을 치환한다.
 * 자기검증(replicateTableToHtml===원문) + 셀 경계 되읽기 대칭 검증으로 오매핑을 차단.
 * 중첩표 셀은 HWP5 스캔이 중첩표를 수집하지 않으므로 미지원(skip).
 */
function patchHtmlCells5(
  table: IRTable, scanTable: ScanTable5, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5,
  skip: (reason: string) => number,
): number {
  // 자기검증 — builder 렌더와 동일해야 좌표 신뢰 가능
  if (replicateTableToHtml(table) !== orig.raw) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
  const replica = replicateHtmlTable(table)
  // 되읽기 대칭 검증 — 셀 텍스트에 리터럴 '</td>' 등이 있으면 셀 경계가 어긋나 미편집 셀이
  // 잘려 저장될 수 있음. 원문을 되읽어 replica와 대조한다.
  const origRows = parseHtmlTable(orig.raw)
  if (!origRows || origRows.length !== replica.length
    || origRows.some((r, i) => r.cells.length !== replica[i].cells.length
      || r.cells.some((c, j) => c.inner !== replica[i].cells[j].inner))) {
    return skip("셀 경계 모호 (리터럴 태그 의심) — 매핑 신뢰 불가")
  }
  const editedRows = parseHtmlTable(edited.raw)
  if (!editedRows) return skip("편집된 HTML 표 파싱 실패")
  if (editedRows.length !== replica.length) return skip("표 행 추가/삭제는 미지원 (표 구조 변경)")

  let applied = 0
  for (let r = 0; r < replica.length; r++) {
    if (editedRows[r].cells.length !== replica[r].cells.length) {
      skip(`표 ${r + 1}행 셀 수 변경은 미지원`)
      continue
    }
    for (let c = 0; c < replica[r].cells.length; c++) {
      const oc = replica[r].cells[c]
      const ec = editedRows[r].cells[c]
      if (oc.colSpan !== ec.colSpan || oc.rowSpan !== ec.rowSpan) {
        skip("셀 병합(colspan/rowspan) 변경은 미지원")
        continue
      }
      if (oc.inner === ec.inner) continue

      const origContent = htmlCellInnerToLines(oc.inner)
      const editedContent = htmlCellInnerToLines(ec.inner)
      if (origContent.hadNonText || editedContent.hadNonText) {
        if (extractImgTags(oc.inner) !== extractImgTags(ec.inner)) {
          skip("셀 내 이미지 변경은 미지원")
          continue
        }
        if (extractTopLevelTables(oc.inner).join("\n") !== extractTopLevelTables(ec.inner).join("\n")) {
          skip("셀 내 중첩표 수정은 HWP5 미지원 (v1)")
          continue
        }
      }
      // 텍스트 라인 변경 (중첩표/이미지 제외분)
      if (origContent.lines.join("\n") !== editedContent.lines.join("\n")) {
        const newLines = editedContent.lines.map(l => unescapeGfm(l))
        applied += applyCellEdit5(table, scanTable, oc.gridR!, oc.gridC!, newLines, ctx, oc.inner, ec.inner, origContent.lines.length)
      }
    }
  }
  return applied
}

// ── 1x1 / 1열 표 (텍스트 청크 렌더) — HWPX patchTextChunkTable 미러 ──

function patchTextChunk5(
  table: IRTable, scanTable: ScanTable5, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5,
  skip: (reason: string) => number,
): number {
  if (table.rows === 1 && table.cols === 1 && !isInlineColumnTable(table)) {
    // builder 1x1 경로 재현 (라인별 장식 포함, 유닛 분할 시 트림됨)
    const content = sanitizeText(table.cells[0][0].text)
    const replicaLines = content.split(/\n/).map(line => {
      const t = line.trim()
      if (!t) return ""
      if (/^\d+\.\s/.test(t)) return `**${escapeGfm(t)}**`
      return escapeGfm(t)
    }).filter(Boolean)
    if (replicaLines.join("\n") !== orig.lines.join("\n")) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
    if (extractCellTokens(orig.raw) !== extractCellTokens(edited.raw)) return skip("셀 내 이미지 변경은 미지원")
    const newLines = edited.lines.map(l => {
      // builder는 /^\d+\.\s/ 라인에만 '**' 볼드를 부여 — 그 경우만 벗기고 리터럴 '**...**'는 보존
      const m = l.match(/^\*\*([\s\S]*)\*\*$/)
      const unwrap = m && /^\d+\.\s/.test(unescapeGfm(m[1]))
      return stripCellTokens(unescapeGfm(unwrap ? m![1] : l)).trim()
    }).filter(Boolean)
    return applyCellEdit5(table, scanTable, 0, 0, newLines, ctx, orig.raw, edited.raw, orig.lines.length)
  }

  if (table.cols === 1) {
    // builder 1열 경로 재현 — HWPX patchTextChunkTable 과 같다 (칸 줄마다 격자 행, 강조 span 칸은 칸 블록 마크다운)
    const replica = replicateColumnTable(table)
    if (replica.map(x => x.line).join("\n") !== orig.lines.join("\n")) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
    if (edited.lines.length !== replica.length) return skip("표 행 추가/삭제는 미지원 (표 구조 변경)")
    let applied = 0
    for (let r = 0; r < table.rows; r++) {
      const idx = replica.flatMap((x, i) => (x.gridR === r ? [i] : []))
      if (idx.every(i => replica[i].line === edited.lines[i])) continue
      const before = idx.map(i => replica[i].line), after = idx.map(i => edited.lines[i])
      if (extractCellTokens(before.join(" ")) !== extractCellTokens(after.join(" "))) {
        skip("셀 내 이미지 변경은 미지원")
        continue
      }
      const newLines = after.map(l => styledInline(stripCellTokens(l)).plain.trim()).filter(Boolean)
      applied += applyCellEdit5(table, scanTable, r, 0, newLines, ctx, before.join("<br>"), after.join("<br>"), before.length)
    }
    return applied
  }

  return skip("표 렌더 경로 식별 실패")
}

/**
 * 격자 좌표 (gridR, gridC) 셀에 새 텍스트 라인 적용 — 라인 ↔ 셀 내 비어있지 않은
 * 문단 순서 매핑 (HWPX applyCellEdit과 동일 정책, 바이너리 스테이징판).
 */
function applyCellEdit5(
  table: IRTable, scanTable: ScanTable5, gridR: number, gridC: number,
  newLines: string[], ctx: PatchCtx5, before: string, after: string,
  origLineCount?: number,
): number {
  const skip = (reason: string) => {
    ctx.skipped.push({ reason, before: summarize(before), after: summarize(after) })
    return 0
  }
  const cell = scanTable.cells.get(`${gridR},${gridC}`)
  if (!cell) return skip("셀 좌표 매핑 실패 (병합 영역의 빈 칸이거나 좌표 불일치)")

  // 셀 콘텐츠 검증 — 스캔 문단 합산과 IR 셀 텍스트의 정규화 일치
  const irCell = table.cells[gridR]?.[gridC]
  const scanJoined = cell.paras.map(p => p.rawText).filter(t => normForMatch(t)).join("\n")
  if (irCell && normForMatch(scanJoined) !== normForMatch(noScriptTags(stripCellTokens(irCell.text)))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (irCell.blocks ?? []).filter(b => b.type === "paragraph" || b.type === "heading")
      const flatJoined = noScriptTags(flatBlocks.map(b => b.text ?? "").join("\n"))
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return skip("셀 콘텐츠 구조 복잡 (중첩표/글상자) — 매핑 신뢰 불가")
      }
    }
  }

  const nonEmpty = cell.paras.filter(p => normForMatch(p.rawText) !== "")
  if (origLineCount !== undefined && nonEmpty.length > 0 && origLineCount !== nonEmpty.length) {
    return skip("셀 줄 경계 매핑 모호 (문단 내 줄바꿈) — 미지원")
  }
  const unstable = newLines.find(l => sanitizeText(l) !== l)
  if (unstable !== undefined) return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")

  // 빈 셀(모든 문단이 빈)은 빈 문단들 자체가 채움 대상 — stageParaPatch가 빈 문단 채우기를 지원
  const targets = nonEmpty.length > 0 ? nonEmpty : cell.paras
  if (targets.length === 0) return skip("셀에 문단이 없음 — 미지원")

  // 라인 → 문단 순서 매핑 (넘치는 줄은 마지막 문단에 강제 줄바꿈으로 병합, 줄어든 줄은 비움)
  const assigned: string[] = []
  for (let i = 0; i < targets.length; i++) {
    if (i < newLines.length) {
      assigned.push(i === targets.length - 1 && newLines.length > targets.length
        ? newLines.slice(i).join("\n")
        : newLines[i])
    } else {
      assigned.push("")
    }
  }
  if (newLines.length > targets.length) {
    ctx.skipped.push({ reason: "셀 내 추가 줄을 마지막 문단에 강제 줄바꿈으로 병합(문단 생성 대신)", after: summarize(after), partial: true })
  } else if (newLines.length < nonEmpty.length && nonEmpty.length > 1) {
    ctx.skipped.push({ reason: "셀 내 줄 삭제는 문단 제거 미지원 — 빈 문단 잔존(뷰어에 빈 줄 표시 가능)", before: summarize(before), after: summarize(after), partial: true })
  }
  // 바뀐 자리만 고친다(칸 안 굵은 조각 등 글자 모양 run 유지) — 새 글은 그 줄 마크다운 서식대로
  const styleFor = cellLineStyles(before, after, ctx.charBook)
  let staged = 0
  for (let i = 0; i < targets.length; i++) {
    if (assigned[i] === targets[i].rawText || normForMatch(assigned[i]) === normForMatch(targets[i].rawText)) continue
    staged += stageParaPatch(ctx.scans[targets[i].sectionIndex], targets[i], assigned[i], skip, ctx.keepLineseg,
      normForMatch(targets[i].rawText), styleFor(i, assigned[i]))
  }
  return staged > 0 ? 1 : 0
}

/** GFM 셀 마크다운 → 평문. 굵게 래핑(**…**)은 벗기되 내부 서식은 미지원(null) */
function gfmCellToPlain(md: string): string | null {
  const t = md.trim()
  if (/!\[|\]\(/.test(t)) return null
  // '<'는 HTML 태그/autolink 시작(뒤에 영문자·'/')일 때만 서식으로 간주 — 밑줄 <u> 는 강조 표지다.
  // 통계표의 부등호 셀("<0.01", "≤5") 등 평문 '<'는 허용. ('<br>'은 줄바꿈 셀로 별도 게이트가 처리)
  if (/<(?!br\s*\/?>|\/?u>)[a-zA-Z/]/i.test(t)) return null
  // 강조 표지(파서가 칸 글자 모양으로 단 ** · * · ~~ · <u>)는 걷고 역이스케이프한다 — PARA_TEXT 에 없는 표기
  return t.split(/(?<!\\)<br\s*\/?>/i).map(l => styledInline(l).plain).join("\n")
}

// ─── 한컴 압축 스트림 꼬리 ───────────────────────────

// CRC-32 (IEEE) — zlib.crc32 는 Node 22.2+ 전용이라 engines(>=18) 범위에서 직접 계산한다
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 한컴 압축 스트림 재현 — raw deflate 뒤 8바이트 꼬리(CRC32(비압축) LE + 비압축 크기 LE).
 * 한컴 실저장본의 BodyText/DocInfo 압축 스트림 전수에서 확인된 형식(#71, 코퍼스 실측 7/7).
 * 꼬리 없이도 inflateRawSync 는 열리지만, 원본 충실성을 위해 재작성 스트림에도 복원한다.
 */
export function compressWithTail(raw: Buffer): Buffer {
  const tail = Buffer.alloc(8)
  tail.writeUInt32LE(crc32(raw), 0)
  tail.writeUInt32LE(raw.length >>> 0, 4)
  return Buffer.concat([deflateRawSync(raw), tail])
}
