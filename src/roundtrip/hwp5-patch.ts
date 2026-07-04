/**
 * HWP 5.x 바이너리 서식 보존 무손실 라운드트립 패치 — patchHwpx의 HWP5 대응.
 *
 * parse()로 얻은 마크다운을 편집한 뒤 patchHwp()에 넘기면, 원본 HWP의
 * CFB/레코드 구조를 그대로 두고 변경된 문단/표 셀의 PARA_TEXT만 치환한다.
 * 연쇄 갱신: PARA_HEADER nChars, CHAR_SHAPE 위치, LINE_SEG 재구성, 레코드
 * 크기 재계산 → 섹션 스트림 재직렬화 → deflate 재압축 → CFB 재조립.
 *
 * 안전 게이트 (하나라도 깨지면 해당 수정은 graceful skip — 파일 무결성 우선):
 *  - 섹션 레코드 재직렬화가 원본과 바이트 동일해야 패치 허용
 *  - ctrlMask=0(순수 텍스트) + PARA_TEXT 1개 + 레코드 텍스트 재구성 일치 문단만 수정
 *  - 배포용/암호화/DRM 문서는 전체 거부
 *
 * 지원: 본문 문단/헤딩 텍스트 수정, GFM 표 셀 텍스트 수정 (좌표 기반).
 * 미지원(graceful skip): 블록 추가/삭제, 표 구조 변경, HTML 표 셀, 캡션·각주·
 * 머리말/꼬리말, 컨트롤(탭/개체/필드) 포함 문단. skipped[]에 사유 보고.
 */

import { deflateRawSync } from "zlib"
import { createRequire } from "module"
import { parseHwp5Document } from "../hwp5/parser.js"
import {
  decompressStream, parseFileHeader, createParaTextState, appendParaText, isExtendedOnlyCtrlChar,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DISTRIBUTION, FLAG_DRM,
} from "../hwp5/record.js"
import type { IRBlock, IRTable, PatchOptions, PatchResult, PatchSkip, DiffResult } from "../types.js"
import {
  buildOrigUnits, alignUnits, diffUnitLists, textUnitToPlain, type OrigUnit,
} from "./patcher.js"
import {
  splitMarkdownUnits, normForMatch, sanitizeText, parseGfmTable, unescapeGfmCell, unescapeGfm, escapeGfm, summarize,
  replicateTableToHtml, replicateHtmlTable, parseHtmlTable, htmlCellInnerToLines, extractTopLevelTables,
  AUTONUM_PREFIX_RE,
  type MdUnit,
} from "./markdown-units.js"
import { stripCellTokens, extractCellTokens, extractImgTags } from "./table-patch.js"
import { replaceOleStream } from "./ole-surgeon.js"

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

function serializeRecords(recs: RawRecord[], repl?: Map<number, Buffer>, inserts?: Map<number, RawRecord[]>): Buffer {
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
    push(recs[i].tagId, recs[i].level, repl?.get(i) ?? recs[i].data)
  }
  return Buffer.concat(parts)
}

// ─── 섹션 스캔 ───────────────────────────────────────

interface ScanPara5 {
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
  /** extractText 결과 (트림 전 원문) */
  rawText: string
}

interface ScanCell5 { paras: ScanPara5[] }

interface ScanTable5 {
  sectionIndex: number
  rows: number
  cols: number
  /** "row,col" → 셀 (앵커 좌표 기준) */
  cells: Map<string, ScanCell5>
}

interface SectionScan5 {
  records: RawRecord[]
  /** 재직렬화 바이트 동일성 통과 여부 — 실패 시 이 섹션 패치 금지 */
  safe: boolean
  paras: ScanPara5[]
  tables: ScanTable5[]
  compressed: boolean
  /** 수정 스테이징: 레코드 인덱스 → 새 데이터 */
  repl: Map<number, Buffer>
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
    for (let j = i + 1; j < records.length && records[j].level > rec.level; j++) {
      if (records[j].level !== rec.level + 1) continue
      const t = records[j].tagId
      if (t === TAG_PARA_TEXT) {
        textIdx = textIdx === -1 ? j : -2
        appendParaText(state, records[j].data)
      } else if (t === TAG_CHAR_SHAPE && charShapeIdx === -1) charShapeIdx = j
      else if (t === TAG_PARA_LINE_SEG && lineSegIdx === -1) lineSegIdx = j
    }

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
      rawText: state.text,
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
 * @param original 원본 HWP 바이트 (OLE2/CFB)
 * @param editedMarkdown parse(original).markdown을 편집한 마크다운
 */
export async function patchHwp(
  original: Uint8Array,
  editedMarkdown: string,
  options?: PatchOptions,
): Promise<PatchResult> {
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

  // 2) 원본 파싱 (기존 파서 그대로 — IR 블록 확보)
  let origBlocks: IRBlock[]
  try {
    origBlocks = parseHwp5Document(originalBuf).blocks
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
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      const orig = origUnits[oi]
      const edited = editedUnits[ei]
      if (orig.raw === edited.raw) continue
      applied += handleModified(orig, edited, {
        origBlocks, paraMap, scans, tableMap, skipped,
      })
    } else if (oi !== null) {
      skipped.push({ reason: "블록 삭제는 미지원 (v1) — 원본 유지", before: summarize(origUnits[oi].raw) })
    } else if (ei !== null) {
      skipped.push({ reason: "블록 추가는 미지원 (v1)", after: summarize(editedUnits[ei].raw) })
    }
  }

  // 6) 섹션 재직렬화 + 재압축 + 섹터 레벨 in-place 교체 — 컨테이너 전체 재조립 없음
  //    (수정된 섹션의 데이터 섹터/FAT 체인/디렉토리 start·size 외에는 원본 바이트 유지)
  let data: Uint8Array
  const dirty = scans.some(s => s.repl.size > 0 || s.inserts.size > 0)
  if (!dirty) {
    data = new Uint8Array(original)
  } else {
    try {
      let out = originalBuf
      for (let i = 0; i < scans.length; i++) {
        if (scans[i].repl.size === 0 && scans[i].inserts.size === 0) continue
        const newStream = serializeRecords(scans[i].records, scans[i].repl, scans[i].inserts)
        const content = compressed ? deflateRawSync(newStream) : newStream
        out = replaceOleStream(out, sectionPaths[i], content)
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
      const reparsed = parseHwp5Document(Buffer.from(data))
      verification = diffUnitLists(splitMarkdownUnits(reparsed.markdown), editedUnits)
    } catch (err) {
      return { success: false, applied, skipped, error: `패치본 재파싱 실패 — 패치 중단: ${msg(err)}` }
    }
  }

  return { success: true, data, applied, skipped, verification }

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
 * 단, 같은 텍스트가 여러 위치에 있고 본문 문단만으로 구성되지 않으면 모호 — 매핑 포기.
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
  /** 중복 텍스트는 전부 본문 문단일 때만 등장 순서 페어링 신뢰 가능 */
  const usable = (list: ScanPara5[]): boolean =>
    list.length === 1 || list.every(p => p.kind === "body")

  const counters = new Map<string, number>()
  const result = new Map<number, ParaMapping5>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "heading") || !b.text) continue
    let key = normForMatch(b.text)
    let prefixStripped = false
    if (!buckets.has(key)) {
      // 자동번호/글머리 접두 제거 후 재시도 (파서가 붙인 headMarker)
      const sp = b.text.indexOf(" ")
      if (sp > 0) {
        const alt = normForMatch(b.text.slice(sp + 1))
        if (alt && buckets.has(alt)) { key = alt; prefixStripped = true }
      }
    }
    const list = buckets.get(key)
    if (!list || !usable(list)) { result.set(i, {}); continue }
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

// ── 문단 ──

function patchParagraph(
  block: IRBlock, orig: OrigUnit, edited: MdUnit, ctx: PatchCtx5,
  skip: (reason: string) => number,
): number {
  const mapping = ctx.paraMap.get(orig.blockIdx)
  if (!mapping?.para) return skip("문단 소스맵 매핑 실패 (머리말/글상자/캡션 영역이거나 텍스트 불일치)")
  if (block.text && block.text.includes("\n")) {
    return skip("문단 내 강제 줄바꿈 포함 — 수정 시 줄바꿈 보존 불가로 미지원 (v1)")
  }

  let newPlain = textUnitToPlain(edited.raw, block)

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

  // 자동번호 접두 — 레코드에 없는 텍스트이므로 떼고 기록
  if (mapping.prefixStripped) {
    const origPrefix = block.text!.split(" ", 1)[0]
    const sp = newPlain.indexOf(" ")
    const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain
    if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
      newPlain = sp > 0 ? newPlain.slice(sp + 1) : ""
    } else {
      ctx.skipped.push({ reason: "자동번호 접두 식별 실패 — 번호 포함 텍스트로 적용 (뷰어에서 중복 표시 가능)", after: summarize(newPlain) })
    }
  }

  const origPlain = textUnitToPlain(orig.raw, block)
  if (newPlain === origPlain) return skip("텍스트 외 변경(헤딩 레벨/서식)만 감지 — 스타일 변경은 미지원")
  if (sanitizeText(newPlain) !== newPlain) {
    return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")
  }

  return stageParaPatch(ctx.scans[mapping.para.sectionIndex], mapping.para, newPlain, skip)
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
        applied += stageParaPatch(ctx.scans[para.sectionIndex], para, after, cellSkip)
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
  if (table.rows === 1 && table.cols === 1) {
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

  if (table.cols === 1 && table.rows >= 2) {
    const replica: { line: string; gridR: number }[] = []
    for (let r = 0; r < table.rows; r++) {
      const line = escapeGfm(sanitizeText(table.cells[r][0].text)).replace(/\n/g, " ")
      if (line) replica.push({ line, gridR: r })
    }
    if (replica.map(x => x.line).join("\n") !== orig.lines.join("\n")) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
    if (edited.lines.length !== replica.length) return skip("표 행 추가/삭제는 미지원 (표 구조 변경)")
    let applied = 0
    for (let i = 0; i < replica.length; i++) {
      if (replica[i].line === edited.lines[i]) continue
      if (extractCellTokens(replica[i].line) !== extractCellTokens(edited.lines[i])) {
        skip("셀 내 이미지 변경은 미지원")
        continue
      }
      const newLines = [stripCellTokens(unescapeGfm(edited.lines[i])).trim()].filter(Boolean)
      applied += applyCellEdit5(table, scanTable, replica[i].gridR, 0, newLines, ctx, replica[i].line, edited.lines[i], 1)
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
  if (irCell && normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (irCell.blocks ?? []).filter(b => b.type === "paragraph" || b.type === "heading")
      const flatJoined = flatBlocks.map(b => b.text ?? "").join("\n")
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

  // 라인 → 문단 순서 매핑 (넘치는 줄은 마지막 문단에 병합, 줄어든 줄은 비움)
  const assigned: string[] = []
  for (let i = 0; i < targets.length; i++) {
    if (i < newLines.length) {
      assigned.push(i === targets.length - 1 && newLines.length > targets.length
        ? newLines.slice(i).join(" ")
        : newLines[i])
    } else {
      assigned.push("")
    }
  }
  if (newLines.length > targets.length) {
    ctx.skipped.push({ reason: "셀 내 줄 추가는 문단 생성 미지원 — 마지막 문단에 병합 적용", after: summarize(after), partial: true })
  } else if (newLines.length < nonEmpty.length && nonEmpty.length > 1) {
    ctx.skipped.push({ reason: "셀 내 줄 삭제는 문단 제거 미지원 — 빈 문단 잔존(뷰어에 빈 줄 표시 가능)", before: summarize(before), after: summarize(after), partial: true })
  }
  let staged = 0
  for (let i = 0; i < targets.length; i++) {
    if (assigned[i] === targets[i].rawText || normForMatch(assigned[i]) === normForMatch(targets[i].rawText)) continue
    staged += stageParaPatch(ctx.scans[targets[i].sectionIndex], targets[i], assigned[i], skip)
  }
  return staged > 0 ? 1 : 0
}

/** GFM 셀 마크다운 → 평문. 굵게 래핑(**…**)은 벗기되 내부 서식은 미지원(null) */
function gfmCellToPlain(md: string): string | null {
  let t = md.trim()
  const bold = t.match(/^\*\*([\s\S]+)\*\*$/)
  if (bold) t = bold[1]
  if (/[*`]|!\[|\]\(/.test(t)) return null
  // '<'는 HTML 태그/autolink 시작(뒤에 영문자·'/')일 때만 서식으로 간주.
  // 통계표의 부등호 셀("<0.01", "≤5") 등 평문 '<'는 허용. ('<br>'은 줄바꿈 셀로 별도 게이트가 처리)
  if (/<(?!br\s*\/?>)[a-zA-Z/]/i.test(t)) return null
  return unescapeGfm(unescapeGfmCell(t))
}

// ─── 바이너리 패치 스테이징 ──────────────────────────

/**
 * PARA_TEXT를 [선두 비가시 control][순수 텍스트 코어][말미 비가시 control/문단끝]로 분해.
 * - 코어는 0x20+ 일반 문자(서로게이트 포함)만. 탭·하이픈·NBSP·줄바꿈 등 "가시 control"이
 *   코어 안이나 가장자리에 있으면 텍스트 재매핑이 모호하므로 null(미지원).
 * - 선두/말미에는 개체 앵커(0x0b)·필드(0x03/0x04)·자동번호 등 "비가시 control"과 문단끝(0x0d)만 허용.
 * appendParaText(record.ts)의 바이트 전진 규칙을 그대로 미러한다 — 어긋나면 한컴 변조감지.
 */
export function splitParaText(data: Buffer):
  | { prefix: Buffer; prefixUnits: number; core: string; suffix: Buffer; suffixUnits: number }
  | null {
  interface Tok { start: number; end: number; units: number; plain: boolean; visible: boolean }
  const toks: Tok[] = []
  let i = 0
  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    const start = i
    i += 2
    if (ch >= 0x20) {
      let units = 1
      if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < data.length) {
        const lo = data.readUInt16LE(i)
        if (lo >= 0xdc00 && lo <= 0xdfff) { i += 2; units = 2 }
      }
      toks.push({ start, end: i, units, plain: true, visible: true })
      continue
    }
    switch (ch) {
      case 0x00: case 0x18: case 0x19: case 0x1e: case 0x1f:
        // 줄바꿈/고정폭·비분리 공백/하이픈 — 가시(텍스트에 기여), 2바이트
        toks.push({ start, end: i, units: 1, plain: false, visible: true }); break
      case 0x09: // 탭 — 가시, 2+14바이트
        if (i + 14 <= data.length) i += 14
        toks.push({ start, end: i, units: 1, plain: false, visible: true }); break
      case 0x0d: // 문단끝 — 비가시
        toks.push({ start, end: i, units: 1, plain: false, visible: false }); break
      case 0x0a: // 강제 줄바꿈(char 2바이트) — 단, 뒤에 0x000b 수식 래퍼면 확장 처리
        if (i + 16 <= data.length && data.readUInt16LE(i) === 0x000b) {
          i += 16; toks.push({ start, end: i, units: 1, plain: false, visible: false })  // 수식 등 비가시
        } else {
          // bare 0x000a = 2바이트 줄바꿈. 14바이트 소비 금지(appendParaText와 대칭 — 어긋나면 한컴 변조감지).
          toks.push({ start, end: i, units: 1, plain: false, visible: true })            // "\n" 가시, 2바이트
        }
        break
      default: {
        const ext = isExtendedOnlyCtrlChar(ch)
        const inl = (ch >= 4 && ch <= 9) || (ch >= 19 && ch <= 20)
        if ((ext || inl) && i + 14 <= data.length) i += 14
        toks.push({ start, end: i, units: 1, plain: false, visible: false })  // 개체/필드 등 비가시
        break
      }
    }
  }
  if (i !== data.length) return null  // 토큰화가 데이터를 정확히 소비 못함 — 안전상 미지원

  let firstP = -1, lastP = -1
  for (let k = 0; k < toks.length; k++) if (toks[k].plain) { if (firstP < 0) firstP = k; lastP = k }
  if (firstP < 0) {
    // 일반 텍스트가 전혀 없는 문단(빈/개체만) — 가시 control이 있으면 위치 모호로 미지원.
    // 문단끝(0x0d)부터를 suffix로 삼아 새 텍스트가 [선두 개체 뒤, 문단끝 앞]에 들어가게 한다.
    if (toks.some(t => t.visible)) return null
    let cut = data.length
    for (const t of toks) if (data.readUInt16LE(t.start) === 0x0d) { cut = t.start; break }
    return {
      prefix: data.subarray(0, cut),
      prefixUnits: cut / 2,
      core: "",
      suffix: data.subarray(cut),
      suffixUnits: (data.length - cut) / 2,
    }
  }
  for (let k = firstP; k <= lastP; k++) if (!toks[k].plain) return null            // 코어 내부에 control
  for (let k = 0; k < firstP; k++) if (toks[k].visible) return null                // 선두에 가시 control
  for (let k = lastP + 1; k < toks.length; k++) if (toks[k].visible) return null   // 말미에 가시 control

  const prefixEnd = toks[firstP].start
  const coreEnd = toks[lastP].end
  // nChars·char shape position은 WCHAR 개수 단위 — control의 확장 WCHAR(개체/필드=8 WCHAR 등)도
  // 모두 포함한다. 바이트÷2로 계산해야 한컴의 nChars(=PARA_TEXT WCHAR 총수)와 일치한다.
  const prefixUnits = prefixEnd / 2
  const suffixUnits = (data.length - coreEnd) / 2
  return {
    prefix: data.subarray(0, prefixEnd),
    prefixUnits,
    core: data.subarray(prefixEnd, coreEnd).toString("utf16le"),
    suffix: data.subarray(coreEnd),
    suffixUnits,
  }
}

/**
 * CHAR_SHAPE(글자모양 run) 레코드를 코어 시작 위치 기준으로 재구성.
 * 선두 control 영역의 run은 보존하고 코어 이후는 코어 첫 글자 서식으로 단일화한다
 * — 텍스트 길이가 바뀌어도 position이 안정 (기존 "첫 run 통일" 정책의 일반화).
 */
function rebuildCharShape(csData: Buffer, coreStartUnit: number): { buf: Buffer; count: number } {
  const pairs: Array<[number, number]> = []
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)])
  if (pairs.length === 0) return { buf: Buffer.from(csData.subarray(0, 8)), count: 1 }
  let coreId = pairs[0][1]
  for (const [p, id] of pairs) if (p <= coreStartUnit) coreId = id
  const kept = pairs.filter(([p]) => p < coreStartUnit)
  if (kept.length === 0 || kept[kept.length - 1][1] !== coreId) kept.push([coreStartUnit, coreId])
  const buf = Buffer.alloc(kept.length * 8)
  kept.forEach(([p, id], k) => { buf.writeUInt32LE(p >>> 0, k * 8); buf.writeUInt32LE(id >>> 0, k * 8 + 4) })
  return { buf, count: kept.length }
}

/**
 * 문단 텍스트 교체를 섹션 repl 맵에 스테이징.
 * PARA_TEXT 치환 + PARA_HEADER nChars + CHAR_SHAPE/LINE_SEG 정합화.
 * 개체 앵커·필드 등 비가시 control이 문단 가장자리에 있어도 그 블록은 보존하고 코어만 교체한다.
 */
function stageParaPatch(
  scan: SectionScan5, para: ScanPara5, newPlain: string,
  skip: (reason: string) => number,
): number {
  if (!scan.safe) return skip("섹션 레코드 재직렬화 불일치 — 안전을 위해 이 섹션은 미지원")
  if (para.textIdx === -2) return skip("복수 PARA_TEXT 레코드 문단 — 미지원 (v1)")
  // 컨트롤 문자(개체 앵커/필드 등)는 splitParaText에서 가장자리 보존 가능 여부를 판정한다.
  if (para.rangeTagCount > 0) return skip("범위 태그(형광펜/교정부호) 문단 — 미지원 (v1)")
  if (para.charShapeIdx < 0 || para.lineSegIdx < 0) return skip("문단 레코드 구성 비정형 — 미지원")
  if (scan.repl.has(para.headerIdx)) return skip("동일 문단 중복 수정 — 첫 수정만 적용")
  if (/[\u0000-\u001f]/.test(newPlain)) return skip("새 텍스트에 제어문자 포함 — 미지원")

  const records = scan.records
  const headerRec = records[para.headerIdx]
  const charShapeRec = records[para.charShapeIdx]
  if (charShapeRec.data.length < 8) {
    return skip("CHAR_SHAPE 레코드 비정형 — 미지원")
  }

  // PARA_TEXT 레코드가 없는 빈 문단(한컴 생략 저장형) — PARA_HEADER 직후에 신규 삽입.
  // 원본 nChars(하위 31비트)가 1이면 문단끝 1자를 계상한 것이므로 0x0d를 붙여 정합 유지.
  if (para.textIdx === -1) {
    const nCharsLow = para.nCharsRaw & 0x7fffffff
    if (nCharsLow > 1) return skip("PARA_TEXT 없는 문단의 nChars 비정형 — 미지원")
    const paraEnd = nCharsLow === 1 ? Buffer.from([0x0d, 0x00]) : Buffer.alloc(0)
    const at = para.headerIdx + 1
    const list = scan.inserts.get(at) ?? []
    list.push({ tagId: TAG_PARA_TEXT, level: headerRec.level + 1, data: Buffer.concat([Buffer.from(newPlain, "utf16le"), paraEnd]) })
    scan.inserts.set(at, list)

    const newHeader = Buffer.from(headerRec.data)
    newHeader.writeUInt32LE(((para.nCharsRaw & 0x80000000) | (newPlain.length + nCharsLow)) >>> 0, 0)
    const cs = rebuildCharShape(charShapeRec.data, 0)
    scan.repl.set(para.charShapeIdx, cs.buf)
    newHeader.writeUInt16LE(cs.count, 12)
    scan.repl.set(para.headerIdx, newHeader)
    return 1
  }

  const textRec = records[para.textIdx]

  // PARA_TEXT를 [선두 control][텍스트 코어][말미 control/문단끝]로 분해
  const seg = splitParaText(textRec.data)
  if (!seg) {
    return skip(para.ctrlMask !== 0
      ? "컨트롤 문자(탭/필드/특수공백 등 텍스트 중간) 포함 문단 — 미지원 (v1)"
      : "PARA_TEXT 재구성 불일치 — 원문 보존 불가로 미지원")
  }
  // 코어가 추출 텍스트(rawText)와 일치해야 안전 (가시 control 없음 보장)
  if (seg.core !== para.rawText) return skip("PARA_TEXT 재구성 불일치 — 원문 보존 불가로 미지원")

  // 원문 leading/trailing 공백 보존 (IR은 트림된 텍스트)
  const lead = para.rawText.match(/^\s*/)![0]
  const trail = para.rawText.match(/\s*$/)![0]
  const newRaw = para.rawText.trim() === para.rawText ? newPlain : lead + newPlain + trail

  // PARA_TEXT = 선두 control + 새 텍스트 + 말미 control/문단끝 (control 블록 바이트 보존)
  const newText = Buffer.concat([seg.prefix, Buffer.from(newRaw, "utf16le"), seg.suffix])
  scan.repl.set(para.textIdx, newText)

  // PARA_HEADER — nChars(상위 플래그 비트 보존) + charShapeCount/lineSegCount
  const newHeader = Buffer.from(headerRec.data)
  const nChars = seg.prefixUnits + newRaw.length + seg.suffixUnits
  newHeader.writeUInt32LE(((para.nCharsRaw & 0x80000000) | nChars) >>> 0, 0)

  // CHAR_SHAPE — 선두 control run 보존 + 코어는 첫 글자 서식으로 단일화
  const cs = rebuildCharShape(charShapeRec.data, seg.prefixUnits)
  scan.repl.set(para.charShapeIdx, cs.buf)
  newHeader.writeUInt16LE(cs.count, 12)

  // LINE_SEG는 원본 그대로 둔다 — 한컴은 줄 레이아웃(LINE_SEG)을 재계산하지 않고 그대로
  // 렌더하므로, 세그먼트를 줄이면(여러 줄→1줄) 글자가 한 줄에 겹쳐 박힌다. 텍스트 길이가
  // 바뀌어도 한컴이 마지막 세그 기준으로 재배치하므로 원본 유지가 안전하다.
  // (실측: 원본유지는 길이 변경에도 정상 오픈, 단일 세그먼트화하면 글자 겹침)

  scan.repl.set(para.headerIdx, newHeader)
  return 1
}
