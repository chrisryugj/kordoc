/**
 * HWP 5.x(OLE2) 컨테이너 PII 수술 — 모든 스트림의 글자를 같은 길이 UTF-16 코드 단위 치환으로 가린다.
 *
 * - BodyText/Section*: 레코드를 풀어 PARA_TEXT 는 문단 단위로(탭·줄바꿈·수식·자동 번호·각주 표지는 구분자,
 *   필드·책갈피·표·그림·조판 제어·하이픈 등 나머지는 파서처럼 투명) 탐지해 PII 글자 자리만 덮어쓴다. 머리말·꼬리말·각주·미주·
 *   표 셀·글상자·숨은 설명 문단도 전부 PARA_TEXT 라 같은 경로다. 그 밖의 레코드(필드 명령 문자열·
 *   개체 설명문 등)는 UTF-16 문자열 조각 단위로 훑는다(서식 데이터 연결 경로는 건너뜀). 레코드 크기·
 *   nChars·글자모양 위치·LINE_SEG 는 그대로 — 길이가 같아 연쇄 갱신이 필요 없다
 * - DocInfo·Scripts·DocHistory 등 압축 스트림: 풀어서 문자열 조각 단위. 다시 압축할 때 한컴 꼬리
 *   (CRC32+크기 8바이트)가 있던 스트림은 꼬리도 붙인다
 * - PrvText(첫 쪽 텍스트 캐시)·\x05HwpSummaryInformation(제목 = 흔히 본문 첫 줄, 작성자, 설명):
 *   UTF-16 문자열 조각 (+ VT_LPSTR 대비 1바이트 조각)
 * - PrvImage(첫 쪽 렌더): PII 를 가린 문서면 같은 크기 흰 이미지로 교체
 * - BinData: 풀어서 그림 메타데이터(XMP·JPEG 주석·PNG 텍스트)는 가리고, 삽입 OLE 개체(차트 XML·삽입
 *   문서·엑셀 포함)·EMF 의 글자는 재검사에서 보고한다(가릴 수 없음 → 잔존). 화소는 미검사로 알린다
 * - 미할당 섹터: 늘 0으로 비운다 — 한컴이 저장하며 남긴 옛 스트림 사본(압축 안 된 PrvText·압축된
 *   BodyText)이 있다. 비운 자리에 있던 PII 는 "slack" 위치로 보고한다
 * 스트림 교체는 ole-surgeon(섹터 수술, 해제 섹터 0 채움)으로 — 나머지 바이트는 원본 그대로.
 * 배포용·암호·DRM 문서는 본문이 암호화돼 있어 거부한다.
 */

import { createRequire } from "module"
import { deflateRawSync, inflateRawSync, constants as zlibConstants } from "zlib"
import {
  decompressStream, parseFileHeader, readRecords, isExtendedOnlyCtrlChar,
  TAG_PARA_TEXT, TAG_CTRL_HEADER, TAG_CTRL_DATA,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DISTRIBUTION, FLAG_DRM,
} from "./hwp5/record.js"
import { replaceOleStream, wipeFreeSectors } from "./roundtrip/ole-surgeon.js"
import { compressWithTail } from "./roundtrip/hwp5-patch.js"
import {
  findPii, blankPreviewImage, crc32, scrubImageMeta, scrubUtf16Runs, scrubAsciiRuns,
  checkEmbeddedOle, isOleBin, isMetaImage, isEmf,
  type ScrubCtx, type ScrubResult, type RedactFileHit, type RedactWhere,
} from "./redact-scrub.js"
import type { RedactHit } from "./redact.js"

const require = createRequire(import.meta.url)
const CFB: CfbModule = require("cfb")

interface CfbEntry { name?: string; type?: number; content?: Buffer | Uint8Array; size?: number }
interface CfbContainer { FileIndex: CfbEntry[]; FullPaths: string[] }
interface CfbModule {
  parse(data: Buffer): CfbContainer
  find(cfb: CfbContainer, path: string): CfbEntry | null
}

/** 컨트롤 ID(4글자) → 그 안 문단의 위치 분류 */
const CTRL_WHERE: Record<string, RedactWhere> = {
  "tbl ": "table", head: "header", foot: "footer", "fn  ": "footnote", "en  ": "endnote",
  "gso ": "textbox", tcmt: "hidden",
}

/**
 * 문단 글자 흐름을 끊는 확장 컨트롤 — 파서(body.ts)가 그 자리에 글자를 내는 것: 수식(LaTeX)·자동 번호·
 * 각주/미주 번호 표지. 표·그림·필드·책갈피·구역/단 정의·머리말 등은 파서도 아무것도 내지 않아 투명
 */
const BREAKING_CTRLS = new Set(["eqed", "atno", "fn  ", "en  "])

/** CTRL_HEADER 첫 4바이트 → "tbl " 꼴 (파일엔 LE 로 뒤집혀 저장) */
function ctrlName(data: Buffer): string {
  if (data.length < 4) return ""
  const id = data.readUInt32LE(0)
  return String.fromCharCode(id >>> 24, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff)
}

/**
 * PARA_TEXT 한 레코드 → 탐지용 텍스트 + 글자별 바이트 오프셋(-1 = 가상 구분자).
 * record.ts appendParaText 의 3분류(char 1단위 / inline·extended 8단위)를 그대로 따른다.
 */
function decodeParaText(data: Buffer): { text: string; pos: number[] } {
  let text = ""
  const pos: number[] = []
  let i = 0
  const sep = (c = " "): void => { text += c; pos.push(-1) }
  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    if (ch >= 0x20) { text += String.fromCharCode(ch); pos.push(i); i += 2; continue }
    if (ch === 0x0d) { sep("\n"); i += 2; continue }
    if (ch === 0x0a) {
      // 0x0a + 0x0b 수식 래퍼(확장 16바이트)는 개체 — 나머지는 강제 줄바꿈 1단위
      if (i + 18 <= data.length && data.readUInt16LE(i + 2) === 0x0b) { sep(); i += 18; continue }
      sep("\n"); i += 2; continue
    }
    const extended = isExtendedOnlyCtrlChar(ch)
    if ((extended || (ch >= 4 && ch <= 9) || ch === 19 || ch === 20) && i + 16 <= data.length) {
      // 탭과 파서가 글자를 내는 컨트롤만 끊는다 — 나머지(필드·책갈피·표·그림·구역/단 정의·머리말)는 파서
      // (record.ts appendParaText)처럼 투명: 누름틀·하이퍼링크 안 번호, 컨트롤이 끼어든 번호가 이어지게
      if (ch === 9 || (extended && BREAKING_CTRLS.has(ctrlName(data.subarray(i + 2, i + 6))))) sep()
      i += 16
      continue
    }
    if (ch === 0x1e || ch === 0x1f) sep() // 묶음·고정폭 빈칸
    i += 2 // 하이픈(24)·예약(25~29) 등은 투명
  }
  return { text, pos }
}

type Report = (rule: RedactFileHit["rule"], masked: string, where: RedactWhere) => void

function scrubParaText(data: Buffer, ctx: ScrubCtx, mode: "mask" | "check", where: RedactWhere, report: Report): boolean {
  const { text, pos } = decodeParaText(data)
  let changed = false
  const mc = ctx.maskChar.charCodeAt(0)
  for (const h of findPii(text, ctx)) {
    report(h.rule, h.masked, where)
    if (mode !== "mask") continue
    for (let k = 0; k < h.length; k++) {
      const p = pos[h.index + k]
      if (p >= 0 && h.masked[k] !== text[h.index + k]) { data.writeUInt16LE(mc, p); changed = true }
    }
  }
  return changed
}

/** 레코드 스트림(BodyText 섹션·DocInfo) — data 는 압축 해제본, 제자리 수정 */
function scrubRecords(data: Buffer, ctx: ScrubCtx, mode: "mask" | "check", report: Report): boolean {
  let changed = false
  const ctrlStack: Array<{ level: number; id: string }> = []
  for (const rec of readRecords(data)) {
    while (ctrlStack.length > 0 && ctrlStack[ctrlStack.length - 1].level >= rec.level) ctrlStack.pop()
    if (rec.tagId === TAG_PARA_TEXT) {
      let where: RedactWhere = "body"
      for (let i = ctrlStack.length - 1; i >= 0; i--) {
        const w = CTRL_WHERE[ctrlStack[i].id]
        if (w) { where = w; break }
      }
      if (scrubParaText(rec.data, ctx, mode, where, report)) changed = true
      continue
    }
    let where: RedactWhere = "other"
    if (rec.tagId === TAG_CTRL_HEADER) {
      const id = ctrlName(rec.data)
      ctrlStack.push({ level: rec.level, id })
      where = id.startsWith("%") ? "field" : "attribute"
    } else if (rec.tagId === TAG_CTRL_DATA) where = "field"
    // 셀·누름틀 이름으로 쓰이는 데이터 연결 경로("./DataArea/…@code.Name")는 건너뛴다 (fill_form 이 찾는 이름)
    if (scrubUtf16Runs(rec.data, ctx, mode, (h) => report(h.rule, h.masked, where), true)) changed = true
  }
  return changed
}

/**
 * 스트림 원시 바이트 — UTF-16 문자열 조각, ascii 면 1바이트 조각도(VT_LPSTR 속성·풀린 스크립트).
 * 바이너리 스트림에 1바이트 조각 검사를 켜면 우연히 번호 모양이 된 바이트를 덮어쓸 수 있어 끈다.
 */
function scrubRaw(data: Buffer, ctx: ScrubCtx, mode: "mask" | "check", where: RedactWhere, report: Report, ascii: boolean): boolean {
  const a = scrubUtf16Runs(data, ctx, mode, (h) => report(h.rule, h.masked, where))
  const b = ascii && scrubAsciiRuns(data, ctx, mode, (h) => report(h.rule, h.masked, where))
  return a || b
}

function tryInflate(data: Buffer): Buffer | null {
  try { return decompressStream(data) } catch { return null }
}

/** 한컴 압축 스트림 꼬리(CRC32(비압축) LE + 비압축 크기 LE 8바이트)가 붙어 있었는가 — raw 는 가리기 전 해제본 */
function hasHancomTail(stream: Buffer, raw: Buffer): boolean {
  return stream.length >= 8 && stream.readUInt32LE(stream.length - 4) === raw.length >>> 0 && stream.readUInt32LE(stream.length - 8) === crc32(raw)
}

/** 원래 모양대로 다시 압축 — 꼬리가 있던 스트림은 꼬리까지 (hwp5-patch 와 같은 형식) */
const recompress = (raw: Buffer, tail: boolean): Buffer => (tail ? compressWithTail(raw) : deflateRawSync(raw))

// ─── 미할당 영역 ─────────────────────────────────────

const BLOCK = 64 // 미니 섹터 — 작은 스트림의 옛 사본은 미니 스트림 안 64바이트 경계에서 시작한다

/** 두 버퍼를 64바이트 블록 단위로 비교한 바뀐 구간 (비운 미할당 영역) */
function changedSpans(a: Buffer, b: Buffer): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const n = Math.min(a.length, b.length)
  let start = -1
  for (let o = 0; o < n; o += BLOCK) {
    const e = Math.min(n, o + BLOCK)
    const diff = a.compare(b, o, e, o, e) !== 0
    if (diff && start < 0) start = o
    else if (!diff && start >= 0) { spans.push([start, o]); start = -1 }
  }
  if (start >= 0) spans.push([start, n])
  return spans
}

/** raw deflate 블록 머리로 시작할 수 있는가 — 잘못된 블록 형식(3)·길이 보수 불일치 저장 블록은 바로 거른다 */
function mayStartDeflate(b: Buffer, o: number): boolean {
  const type = (b[o] >> 1) & 3
  if (type === 3) return false
  if (type === 0) return o + 5 <= b.length && (b.readUInt16LE(o + 1) ^ b.readUInt16LE(o + 3)) === 0xffff
  return true
}

/**
 * 비운 영역(원래 바이트)에 있던 PII — 압축 안 된 UTF-16 조각과, 블록 경계에서 시작하는 옛 압축 스트림
 * (끝이 잘렸어도 풀린 만큼). 한컴은 다시 저장할 때 옛 BodyText 압축 사본을 미할당 섹터에 남긴다.
 */
function scanSlack(before: Buffer, after: Buffer, ctx: ScrubCtx, onHit: (h: RedactHit) => void): number {
  let bytes = 0
  for (const [s, e] of changedSpans(before, after)) {
    bytes += e - s
    const region = Buffer.from(before.subarray(s, e))
    scrubUtf16Runs(region, ctx, "check", onHit)
    for (let o = 0; o + 8 <= region.length; o += BLOCK) {
      if (!mayStartDeflate(region, o)) continue
      let out: Buffer
      try {
        out = inflateRawSync(region.subarray(o), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 })
      } catch { continue }
      if (out.length >= 16) scrubUtf16Runs(out, ctx, "check", onHit)
    }
  }
  return bytes
}

const nameList = (names: string[]): string => names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} 외 ${names.length - 5}개`

/**
 * HWP5 한 파일을 훑는다. mask: 가린 파일 + 가린 곳 목록, check: 찾은 곳만 (data 는 입력 그대로 —
 * 삽입 OLE 개체·미할당 섹터 등 원시 바이트까지 본다).
 */
export async function scrubHwp5(original: Uint8Array, ctx: ScrubCtx, mode: "mask" | "check"): Promise<ScrubResult> {
  const file = Buffer.from(original.buffer, original.byteOffset, original.byteLength)
  const cfb = CFB.parse(file)
  const headerEntry = CFB.find(cfb, "/FileHeader")
  if (!headerEntry?.content) throw new Error("HWP FileHeader 스트림이 없습니다")
  const header = parseFileHeader(Buffer.from(headerEntry.content))
  if (header.flags & (FLAG_ENCRYPTED | FLAG_DISTRIBUTION | FLAG_DRM)) {
    throw new Error("배포용·암호·DRM 문서는 본문이 암호화돼 있어 마스킹할 수 없습니다")
  }
  const compressed = (header.flags & FLAG_COMPRESSED) !== 0

  const hits: RedactFileHit[] = []
  const warnings: string[] = []
  const replaced = new Map<string, Buffer>()
  const pictures: string[] = []
  const embedded: string[] = []
  let previewPath: string | null = null

  for (let idx = 0; idx < cfb.FullPaths.length; idx++) {
    const entry = cfb.FileIndex[idx]
    if (entry.type !== 2 || !entry.content) continue // 스트림만
    const path = cfb.FullPaths[idx].replace(/^[^/]*\//, "") // "Root Entry/" 제거
    const content = Buffer.from(entry.content)
    const part = path.replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    const report: Report = (rule, masked, where) => hits.push({ rule, masked, part, where })

    if (path === "FileHeader") continue
    if (path === "PrvImage") { previewPath = path; continue }

    let next: Buffer | null = null
    if (path.startsWith("BinData/")) {
      // 개체별 압축 여부는 DocInfo BIN_DATA 속성 — 풀리면 푼 것으로 본다
      const inflated = tryInflate(content)
      const data = inflated ?? Buffer.from(content)
      const tail = inflated ? hasHancomTail(content, inflated) : false
      if (isOleBin(data) || isEmf(data)) {
        // OLE 개체(차트·삽입 문서·엑셀)·EMF — 제자리에서 못 가린다. 재검사에서 안의 글자를 보고해 잔존으로
        // 드러낸다 (압축된 채로는 원시 바이트 검사에 안 보인다 — 한컴 실저장본 OLE 는 전부 압축)
        embedded.push(part)
        if (mode === "check") {
          if (isOleBin(data)) await checkEmbeddedOle(data, ctx, (h) => report(h.rule, h.masked, "other"))
          else scrubUtf16Runs(data, ctx, "check", (h) => report(h.rule, h.masked, "other"))
        }
      } else {
        pictures.push(part)
        if (isMetaImage(data) && scrubImageMeta(data, ctx, mode, (h) => report(h.rule, h.masked, "metadata"))) next = inflated ? recompress(data, tail) : data
      }
    } else if (/^BodyText\/Section\d+$/.test(path) || path === "DocInfo") {
      const data = compressed ? decompressStream(content) : Buffer.from(content)
      const tail = compressed && hasHancomTail(content, data)
      if (scrubRecords(data, ctx, mode, report)) next = compressed ? recompress(data, tail) : data
    } else if (path === "PrvText") {
      const data = Buffer.from(content)
      if (scrubUtf16Runs(data, ctx, mode, (h) => report(h.rule, h.masked, "preview"))) next = data
    } else if (path.startsWith("\x05")) {
      const data = Buffer.from(content)
      if (scrubRaw(data, ctx, mode, "metadata", report, true)) next = data
    } else {
      // Scripts·DocHistory·DocOptions·XMLTemplate 등 — 압축이면 풀어서, 아니면 원시 그대로.
      // 1바이트 조각은 스크립트(JScript 원문)만
      const inflated = compressed ? tryInflate(content) : null
      const data = inflated ?? Buffer.from(content)
      const tail = inflated ? hasHancomTail(content, inflated) : false
      if (scrubRaw(data, ctx, mode, "other", report, path.startsWith("Scripts/"))) next = inflated ? recompress(data, tail) : data
      if (path.startsWith("DocHistory/")) warnings.push(`문서 이력(${path})이 들어 있습니다 — 이전 판의 글자는 문자열 조각 단위로만 검사했습니다`)
    }
    if (next) replaced.set(path, next)
  }

  let data: Uint8Array = original
  if (mode === "mask") {
    if (previewPath && (hits.length > 0 || ctx.literals.length > 0)) {
      const img = CFB.find(cfb, "/PrvImage")?.content
      const blank = img ? blankPreviewImage(Buffer.from(img)) : null
      if (blank) {
        replaced.set(previewPath, blank)
        warnings.push("미리보기 이미지(PrvImage)를 같은 크기의 흰 이미지로 바꿨습니다 — 한컴에서 저장하면 다시 만들어집니다")
      } else warnings.push("미리보기 이미지(PrvImage) 형식을 몰라 지우지 못했습니다 — 첫 쪽 렌더에 PII 가 보일 수 있습니다")
    }
    if (pictures.length > 0) warnings.push(`삽입 그림 ${pictures.length}개(${nameList(pictures)})는 화소 속 글자(스캔 문서 등)를 탐지하지 못합니다 — JPEG·PNG 메타데이터만 검사했습니다`)
    if (embedded.length > 0) warnings.push(`삽입 개체 ${embedded.length}개(${nameList(embedded)} — OLE·EMF)는 가리지 못합니다 — 안의 글자에 PII 가 있으면 재검사 잔존으로 보고됩니다`)

    let out: Buffer = Buffer.from(file)
    for (const [path, content] of replaced) out = replaceOleStream(out, path, content)
    // 미할당 영역은 PII 유무와 상관없이 늘 비운다 — 옛 사본이 압축돼 있으면 탐지로는 못 보기 때문
    try {
      const wiped = wipeFreeSectors(out)
      const before = hits.length
      const seen = new Set<string>()
      const bytes = scanSlack(out, wiped, ctx, (h) => {
        const key = `${h.rule}\0${h.masked}`
        if (seen.has(key)) return
        seen.add(key)
        hits.push({ rule: h.rule, masked: h.masked, part: "(미할당 섹터)", where: "slack" })
      })
      if (bytes > 0) {
        const found = hits.length - before
        warnings.push(`미할당 영역(한컴이 남긴 옛 스트림 사본 등) ${Math.ceil(bytes / 1024)}KB를 0으로 비웠습니다${found > 0 ? ` — 그 안에 개인정보 ${found}건이 있었습니다` : ""}`)
      }
      out = wiped
    } catch (err) {
      warnings.push(`미할당 섹터를 비우지 못했습니다 (${err instanceof Error ? err.message : String(err)}) — 옛 스트림 사본이 남을 수 있습니다`)
    }
    if (!out.equals(file)) data = new Uint8Array(out)
  } else {
    // 원시 바이트 전체의 UTF-16 조각(압축 안 된 스트림·미할당 영역) + 미할당 영역의 옛 압축 사본 —
    // 스트림 단위에서 못 본 것만 추가
    const add = (part: string, where: RedactWhere) => (h: RedactHit): void => {
      if (!hits.some((x) => x.masked === h.masked && x.rule === h.rule)) hits.push({ rule: h.rule, masked: h.masked, part, where })
    }
    scrubUtf16Runs(Buffer.from(file), ctx, "check", add("(OLE 원시 바이트)", "other"))
    try { scanSlack(file, wipeFreeSectors(Buffer.from(file)), ctx, add("(미할당 섹터)", "slack")) } catch { /* 구조가 깨져 비울 수 없는 파일 — 원시 바이트 검사로 대신 */ }
  }
  return { data, hits, warnings, unscanned: [] }
}
