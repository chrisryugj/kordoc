/**
 * 문서 파일 마스킹 공용 도구 — 텍스트 단위 탐지(룰 + 리터럴), 바이너리 안 문자열 조각 훑기,
 * 빈 미리보기 이미지. redact-hwpx.ts·redact-hwp5.ts 가 쓰고 redact-doc.ts 가 묶는다.
 */

import { createRequire } from "module"
import JSZip from "jszip"
import { redactText, normalizeForDetect, mdMarkerRanges, type RedactRule, type RedactHit } from "./redact.js"
import { deflateSync, inflateSync } from "zlib"

const require = createRequire(import.meta.url)
const CFB: { parse(data: Buffer): { FileIndex: Array<{ type?: number; content?: Buffer | Uint8Array }>; FullPaths: string[] } } = require("cfb")

/** 파일 안 위치 분류 (리포트용) */
export type RedactWhere =
  | "body" | "table" | "textbox" | "header" | "footer" | "footnote" | "endnote" | "caption" | "memo"
  | "hidden" | "field" | "attribute" | "metadata" | "preview" | "slack" | "other"

/** 파일 안에서 가린(또는 남은) PII 한 건 — 원본 값 없이 masked 만 */
export interface RedactFileHit {
  rule: RedactRule
  masked: string
  /** 컨테이너 파트 — ZIP 엔트리 이름 또는 OLE 스트림 경로 */
  part: string
  where: RedactWhere
}

// ─── 공용: 텍스트 단위 탐지 + 리터럴 ───────────────────

/** 본문 마크다운에서 라벨·표 머리글 문맥으로 찾은 값 — 문맥 없는 파일 위치(미리보기·다른 셀)에서도 가린다 */
export interface Literal {
  norm: string
  value: string
  masked: string
  rule: RedactRule
}

export interface ScrubCtx {
  rules: readonly RedactRule[]
  maskChar: string
  literals: readonly Literal[]
}

/** 어떤 룰도 못 걸리는 텍스트 빠른 배제 — "@" 가 없고 숫자가 4개 미만 (바이너리 문자열 조각 대부분) */
function cannotContainPii(text: string): boolean {
  if (text.includes("@") || text.includes("＠")) return false
  let digits = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x30 && c <= 0x39) || (c >= 0xff10 && c <= 0xff19)) { if (++digits >= 4) return false }
  }
  return true
}

/** 리터럴 색인 — 정규화 값 앞 6글자 → 후보 (긴 값 우선). 목록마다 1회. 수천 개(대형 명단)여도 본문 길이에 선형 */
const LIT_KEY = 6
const literalIndex = new WeakMap<readonly Literal[], Map<string, Literal[]>>()
function literalBuckets(lits: readonly Literal[]): Map<string, Literal[]> {
  let m = literalIndex.get(lits)
  if (!m) {
    m = new Map()
    for (const l of [...lits].sort((a, b) => b.norm.length - a.norm.length)) {
      const k = l.norm.slice(0, LIT_KEY)
      const list = m.get(k)
      if (list) list.push(l)
      else m.set(k, [l])
    }
    literalIndex.set(lits, m)
  }
  return m
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[0-9A-Za-z]/.test(c)

/** 텍스트 안 리터럴 위치 (영숫자 경계, 겹치지 않게 앞에서부터) */
export function findLiterals(norm: string, lits: readonly Literal[]): Array<{ index: number; lit: Literal }> {
  const out: Array<{ index: number; lit: Literal }> = []
  if (lits.length === 0) return out
  const buckets = literalBuckets(lits)
  for (let i = 0; i + LIT_KEY <= norm.length; i++) {
    if (isAlnum(norm[i - 1]) && isAlnum(norm[i])) continue
    const cand = buckets.get(norm.slice(i, i + LIT_KEY))
    if (!cand) continue
    const lit = cand.find((l) => norm.startsWith(l.norm, i) && !(isAlnum(norm[i + l.norm.length - 1]) && isAlnum(norm[i + l.norm.length])))
    if (!lit) continue
    out.push({ index: i, lit })
    i += lit.norm.length - 1
  }
  return out
}

/**
 * 텍스트 한 단위(문단·텍스트 노드·줄)에서 PII 위치 — 룰 탐지 + 리터럴 일치.
 * 반환 hit 의 masked 는 text 원문 글자에 마스킹을 입힌 것 (길이 동일).
 */
export function findPii(text: string, ctx: ScrubCtx): RedactHit[] {
  if (text.length < 5 || cannotContainPii(text)) return []
  const hits = redactText(text, { rules: ctx.rules, maskChar: ctx.maskChar }).hits
  if (ctx.literals.length === 0) return hits
  for (const { index: i, lit } of findLiterals(normalizeForDetect(text), ctx.literals)) {
    const end = i + lit.norm.length
    if (hits.some((h) => i < h.index + h.length && end > h.index)) continue
    let masked = ""
    for (let k = 0; k < lit.norm.length; k++) masked += lit.masked[k] !== lit.value[k] ? ctx.maskChar : text[i + k]
    hits.push({ rule: lit.rule, masked, index: i, length: lit.norm.length })
  }
  return hits.sort((a, b) => a.index - b.index)
}

/** 마크다운 탐지 결과 → 리터럴 (인라인 서식 표지 제거, 값 기준 중복 제거, 너무 짧은 값 제외) */
export function literalsFromMarkdown(markdown: string, hits: readonly RedactHit[]): Literal[] {
  const out = new Map<string, Literal>()
  const lineMarkers = new Map<number, Array<[number, number]>>()
  for (const h of hits) {
    const rawValue = markdown.slice(h.index, h.index + h.length)
    // 표지 글자는 masked 에서도 같은 자리에 그대로 있다 — 같은 자리를 둘 다에서 뺀다 (짝 판정은 줄 전체로)
    const lineStart = markdown.lastIndexOf("\n", h.index - 1) + 1
    let ranges = lineMarkers.get(lineStart)
    if (!ranges) {
      const lineEnd = markdown.indexOf("\n", h.index)
      ranges = mdMarkerRanges(markdown.slice(lineStart, lineEnd < 0 ? undefined : lineEnd))
      lineMarkers.set(lineStart, ranges)
    }
    const drop = new Set<number>()
    for (const [ms, me] of ranges) {
      for (let p = ms + lineStart; p < me + lineStart; p++) if (p >= h.index && p < h.index + h.length) drop.add(p - h.index)
    }
    const value = rawValue.split("").filter((_, k) => !drop.has(k)).join("")
    const masked = h.masked.split("").filter((_, k) => !drop.has(k)).join("")
    const norm = normalizeForDetect(value)
    if (norm.replace(/[^0-9A-Za-z]/g, "").length < 6 || out.has(norm)) continue
    out.set(norm, { norm, value, masked, rule: h.rule })
  }
  return [...out.values()]
}

// ─── 공용: 빈 미리보기 이미지 ────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** 같은 크기의 흰 PNG (8bit 회색조) */
function blankPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const row = Buffer.alloc(width + 1, 0xff)
  row[0] = 0 // filter none
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0)),
  ])
}

/** 논리 화면만 원본 크기인 흰 GIF (1×1 흰 프레임 + 흰 배경) */
function blankGif(width: number, height: number): Buffer {
  const b = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0x80, 0, 0, // GIF89a, 화면 크기, 전역 팔레트 2색
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, // 이미지 1×1 @(0,0)
    0x02, 0x02, 0x44, 0x01, 0x00, 0x3b, // LZW: clear·0·end, 트레일러
  ])
  b.writeUInt16LE(Math.min(width, 0xffff), 6)
  b.writeUInt16LE(Math.min(height, 0xffff), 8)
  return b
}

/**
 * 미리보기 이미지(첫 쪽 렌더) → 같은 크기의 흰 이미지. 724×1024 급이라 본문 글자가 읽힌다 — PII 를
 * 가린 문서라면 함께 지운다. 한컴은 저장할 때 다시 만든다. 모르는 형식은 null.
 */
export function blankPreviewImage(img: Uint8Array): Buffer | null {
  const b = Buffer.from(img.buffer, img.byteOffset, img.byteLength)
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    const w = b.readUInt32BE(16)
    const h = b.readUInt32BE(20)
    if (w > 0 && h > 0 && w <= 8192 && h <= 8192) return blankPng(w, h)
    return blankPng(1, 1)
  }
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") return blankGif(b.readUInt16LE(6), b.readUInt16LE(8))
  if (b.length >= 26 && b.toString("latin1", 0, 2) === "BM") {
    // BMP — 헤더·팔레트 유지, 화소 배열만 0xFF (24/32bit 는 흰색, 팔레트형은 마지막 색)
    const out = Buffer.from(b)
    const pixelOffset = out.readUInt32LE(10)
    if (pixelOffset > 0 && pixelOffset < out.length) out.fill(0xff, pixelOffset)
    return out
  }
  return null
}

// ─── 공용: UTF-16LE / 1바이트 문자열 조각 훑기 ────────────

const isTextUnit = (u: number): boolean =>
  (u >= 0x20 && u < 0x7f) || (u >= 0xa0 && u <= 0xd7ff) || (u >= 0xe000 && u <= 0xfffd) || u === 0x09

/**
 * 서식 데이터 연결 경로 — 셀·누름틀 이름으로 쓰이는 XPath 꼴("./DataArea/…/Job.Code@code.Name").
 * 이메일 모양이 섞여 있어도 PII 가 아니고, 가리면 fill_form 이 이름으로 찾던 필드가 끊긴다.
 * 경로 꼴(./ 로 시작·[n]/ 포함)이거나 대문자 "X.Code@code.Name" 꼴만 — 소문자 실주소(hong@code.org)는 아니다.
 * 속성값·HWP5 레코드 문자열(셀 이름·필드 데이터)에서만 건너뛴다 — 본문·미리보기 텍스트는 그대로 검사
 */
export function isBindingPath(s: string): boolean {
  const t = s.trim()
  return /^\.?\/[^\s]*\//.test(t) || /^[^\s]*\[\d+\][^\s]*\//.test(t) || /[A-Za-z]\.Code@code\.[A-Z]/.test(t)
}

/**
 * 바이너리 레코드·스트림 안의 UTF-16LE 문자열 조각을 찾아 PII 를 같은 길이로 가린다 (buf 제자리 수정).
 * 짝수·홀수 정렬을 모두 본다 — 길이 접두 문자열이 홀수 오프셋에서 시작하는 레코드가 있다(필드 명령).
 * 엉뚱한 정렬로 읽은 ASCII 문자열은 U+3xxx 대 한자처럼 풀려 숫자 패턴이 생기지 않는다.
 * skipBinding: 데이터 연결 경로 조각은 건너뛴다 (HWP5 셀·필드 레코드용)
 */
export function scrubUtf16Runs(
  buf: Buffer, ctx: ScrubCtx, mode: "mask" | "check", onHit: (h: RedactHit) => void, skipBinding = false,
): boolean {
  let changed = false
  const mc = ctx.maskChar.charCodeAt(0)
  for (let align = 0; align < 2; align++) {
    let runStart = -1
    let text = ""
    const flush = (): void => {
      if (runStart >= 0 && text.length >= 6 && !(skipBinding && isBindingPath(text))) {
        for (const h of findPii(text, ctx)) {
          onHit(h)
          if (mode !== "mask") continue
          const orig = text.slice(h.index, h.index + h.length)
          for (let k = 0; k < h.length; k++) {
            if (h.masked[k] !== orig[k]) { buf.writeUInt16LE(mc, runStart + (h.index + k) * 2); changed = true }
          }
        }
      }
      runStart = -1
      text = ""
    }
    for (let off = align; off + 1 < buf.length; off += 2) {
      const u = buf.readUInt16LE(off)
      if (isTextUnit(u)) {
        if (runStart < 0) runStart = off
        text += String.fromCharCode(u)
      } else flush()
    }
    flush()
  }
  return changed
}

/**
 * 1바이트 문자열(ASCII·CP949 의 ASCII 부분) 조각 — VT_LPSTR 메타데이터·스크립트용. 멀티바이트 마스크
 * 문자는 길이를 바꾸므로 여기서는 "*" 로 가린다.
 */
export function scrubAsciiRuns(buf: Buffer, ctx: ScrubCtx, mode: "mask" | "check", onHit: (h: RedactHit) => void): boolean {
  let changed = false
  let runStart = -1
  const byteCtx: ScrubCtx = { ...ctx, maskChar: "*" }
  const flush = (end: number): void => {
    if (runStart >= 0 && end - runStart >= 6) {
      const text = buf.toString("latin1", runStart, end)
      for (const h of findPii(text, byteCtx)) {
        onHit({ ...h, masked: h.masked.split("*").join(ctx.maskChar) })
        if (mode !== "mask") continue
        for (let k = 0; k < h.length; k++) {
          if (h.masked[k] !== text[h.index + k]) { buf[runStart + h.index + k] = 0x2a; changed = true }
        }
      }
    }
    runStart = -1
  }
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 0x20 && c < 0x7f) { if (runStart < 0) runStart = i } else flush(i)
  }
  flush(buf.length)
  return changed
}

/** 컨테이너 한 번 훑은 결과 (mask 모드는 data 가 수정본, check 모드는 입력 그대로) */
export interface ScrubResult {
  data: Uint8Array
  hits: RedactFileHit[]
  warnings: string[]
  /** 글자가 들어 있을 자리인데 읽지 못한 파트 (인코딩 불명 텍스트 엔트리 등) — 잔존과 같은 실패로 다룬다 */
  unscanned: string[]
}

/** NUL 이 섞인 텍스트 엔트리가 BOM 없는 UTF-16LE 인가 — 한컴 Scripts/*.js 전량이 이 꼴(코퍼스 213건) */
export function looksUtf16le(b: Uint8Array): boolean {
  if (b.length < 2 || b.length % 2 !== 0) return false
  let text = 0
  let asciiHi0 = 0
  const n = b.length / 2
  for (let i = 0; i < b.length; i += 2) {
    const u = b[i] | (b[i + 1] << 8)
    if (isTextUnit(u) || u === 0x0a || u === 0x0d || u === 0xfeff) text++
    if (b[i + 1] === 0 && b[i] !== 0) asciiHi0++
  }
  return text / n >= 0.95 && asciiHi0 > 0
}

// ─── 공용: 이미지 메타데이터 (XMP·JPEG 주석·PNG 텍스트) ──────

/** UTF-8 바이트 → 글자별 바이트 위치가 붙은 문자열 (잘못된 바이트는 U+FFFD 한 글자) */
function utf8WithOffsets(b: Buffer, start: number, end: number): { text: string; at: number[] } {
  const text: string[] = []
  const at: number[] = []
  let i = start
  while (i < end) {
    const c = b[i]
    const len = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
    const ch = len === 1 && c >= 0x80 ? "\ufffd" : b.toString("utf8", i, Math.min(end, i + len))
    for (let k = 0; k < ch.length; k++) { text.push(ch[k]); at.push(i) }
    i += len
  }
  return { text: text.join(""), at }
}

/** 텍스트 구간(바이트) 탐지 → ASCII 자리만 "*" 로 (바이트 길이 불변) */
function scrubTextBytes(b: Buffer, start: number, end: number, ctx: ScrubCtx, mode: "mask" | "check", onHit: (h: RedactHit) => void): boolean {
  const { text, at } = utf8WithOffsets(b, start, end)
  let changed = false
  for (const h of findPii(text, { ...ctx, maskChar: "*" })) {
    onHit({ ...h, masked: h.masked.split("*").join(ctx.maskChar) })
    if (mode !== "mask") continue
    for (let k = 0; k < h.length; k++) {
      const pos = at[h.index + k]
      if (h.masked[k] !== text[h.index + k] && b[pos] < 0x80) { b[pos] = 0x2a; changed = true }
    }
  }
  return changed
}

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0"

/**
 * 이미지 메타데이터의 글자 — JPEG XMP(APP1, 포토샵 레이어 이름·설명 등)·JPEG 주석(COM)·PNG tEXt/iTXt.
 * 같은 길이로 가린다(ASCII 자리만 "*"). PNG 는 청크 CRC 를 다시 계산한다. 압축 텍스트(zTXt·압축 iTXt)는
 * 가리지 않고 잔존으로 보고되게 탐지만 한다. 화소 데이터는 보지 않는다(오탐·손상 방지). buf 제자리 수정.
 */
export function scrubImageMeta(buf: Buffer, ctx: ScrubCtx, mode: "mask" | "check", onHit: (h: RedactHit) => void): boolean {
  let changed = false
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let o = 2; o + 4 <= buf.length;) {
      if (buf[o] !== 0xff) break
      const m = buf[o + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue }
      const len = buf.readUInt16BE(o + 2)
      const segStart = o + 4
      const segEnd = Math.min(buf.length, o + 2 + len)
      if (m === 0xe1 && buf.toString("latin1", segStart, segStart + XMP_HEADER.length) === XMP_HEADER) {
        if (scrubTextBytes(buf, segStart + XMP_HEADER.length, segEnd, ctx, mode, onHit)) changed = true
      } else if (m === 0xfe) {
        if (scrubTextBytes(buf, segStart, segEnd, ctx, mode, onHit)) changed = true
      }
      if (m === 0xda) break // 영상 데이터 시작 — 메타데이터 끝
      o += 2 + len
    }
  } else if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    for (let o = 8; o + 12 <= buf.length;) {
      const len = buf.readUInt32BE(o)
      const type = buf.toString("latin1", o + 4, o + 8)
      const dStart = o + 8
      const dEnd = Math.min(buf.length, dStart + len)
      let chunkChanged = false
      if (type === "tEXt" || type === "iTXt") {
        const k = buf.indexOf(0, dStart)
        let textStart = k + 1
        if (type === "iTXt" && k >= 0) {
          const compressed = buf[k + 1] === 1
          const lang = buf.indexOf(0, k + 3)
          const trans = lang >= 0 ? buf.indexOf(0, lang + 1) : -1
          textStart = trans + 1
          if (compressed) {
            // 압축 텍스트는 제자리에서 못 가린다 — 재검사(check)에서만 보고해 잔존으로 드러나게
            if (mode === "check") {
              try { for (const h of findPii(inflateSync(buf.subarray(textStart, dEnd)).toString("utf8"), ctx)) onHit(h) } catch { /* 깨진 청크 */ }
            }
            textStart = -1
          }
        }
        if (k >= 0 && textStart > 0 && textStart <= dEnd) chunkChanged = scrubTextBytes(buf, textStart, dEnd, ctx, mode, onHit)
      } else if (type === "zTXt" && mode === "check") {
        const k = buf.indexOf(0, dStart)
        try {
          for (const h of findPii(inflateSync(buf.subarray(k + 2, dEnd)).toString("latin1"), ctx)) onHit(h)
        } catch { /* 깨진 청크 */ }
      }
      if (chunkChanged) {
        changed = true
        buf.writeUInt32BE(crc32(buf.subarray(o + 4, dEnd)), dEnd)
      }
      if (type === "IEND") break
      o += 12 + len
    }
  }
  return changed
}

// ─── 공용: 삽입 개체(BinData) 판별·재검사 ─────────────────

const OLE_SIG = Buffer.from("d0cf11e0a1b11ae1", "hex")

/** 삽입 OLE 개체 — HWP·HWPX BinData 의 .ole 은 4바이트 크기 + OLE 복합 파일 */
export function isOleBin(b: Buffer): boolean {
  const i = b.indexOf(OLE_SIG)
  return i >= 0 && i < 16
}

/** 메타데이터 글자를 가릴 수 있는 그림 — JPEG·PNG */
export function isMetaImage(b: Buffer): boolean {
  return (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b.length > 8 && b.readUInt32BE(0) === 0x89504e47)
}

/** EMF 메타파일 — 글자 레코드(EXTTEXTOUTW)가 UTF-16 이다 */
export function isEmf(b: Buffer): boolean {
  return b.length > 44 && b.readUInt32LE(0) === 1 && b.readUInt32LE(40) === 0x464d4520
}

const decodeXmlEntities = (s: string): string => s
  .replace(/&#x([0-9a-fA-F]+);/g, (e, h) => { const c = parseInt(h, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : e })
  .replace(/&#(\d+);/g, (e, d) => { const c = Number(d); return c <= 0x10ffff ? String.fromCodePoint(c) : e })
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

/** XML 글자(태그 묶음은 공백 하나로 — run 에 갈린 번호도 이어진다)와 속성값 — 재검사 전용 */
function checkXmlText(xml: string, ctx: ScrubCtx, onHit: (h: RedactHit) => void): void {
  for (const h of findPii(decodeXmlEntities(xml.replace(/(?:<[^>]*>)+/g, " ")), ctx)) onHit(h)
  for (const m of xml.matchAll(/=\s*"([^"]{5,})"/g)) for (const h of findPii(decodeXmlEntities(m[1]), ctx)) onHit(h)
}

/**
 * 삽입 OLE 개체 재검사 — 제자리에서 가릴 수 없어 찾기만 한다(잔존 보고용). 안쪽 스트림을 열어 XML(차트
 * OOXMLChartContents)·ZIP(삽입 OOXML 문서 Package)은 글자와 속성값을, 엑셀 Workbook 은 UTF-16 과 1바이트
 * 문자열(숫자·이메일은 1바이트로 저장)을, 그 밖(차트 Contents·OlePres 메타파일·Ole10Native)은 UTF-16
 * 문자열 조각을 본다. 메타파일·그림의 1바이트 조각은 화소 자료에서 오탐이 많아 보지 않는다.
 */
export async function checkEmbeddedOle(data: Buffer, ctx: ScrubCtx, onHit: (h: RedactHit) => void): Promise<void> {
  let inner: ReturnType<typeof CFB.parse>
  try { inner = CFB.parse(data.subarray(data.indexOf(OLE_SIG))) } catch { scrubUtf16Runs(Buffer.from(data), ctx, "check", onHit); return }
  for (let i = 0; i < inner.FullPaths.length; i++) {
    const e = inner.FileIndex[i]
    if (e.type !== 2 || !e.content) continue
    const c = Buffer.from(e.content)
    if (c.length >= 4 && c.readUInt32LE(0) === 0x04034b50) {
      let zip: JSZip | null = null
      try { zip = await JSZip.loadAsync(c) } catch { /* 깨진 ZIP — 원시 조각만 */ }
      if (!zip) { scrubUtf16Runs(c, ctx, "check", onHit); continue }
      for (const [name, z] of Object.entries(zip.files)) {
        if (z.dir) continue
        const b = Buffer.from(await z.async("uint8array"))
        if (/\.(xml|rels|vml)$/i.test(name)) checkXmlText(b.toString("utf8"), ctx, onHit)
        else scrubUtf16Runs(b, ctx, "check", onHit)
      }
    } else if (/^(?:\xef\xbb\xbf)?\s*<(?:\?xml|[A-Za-z])/.test(c.toString("latin1", 0, 64))) {
      checkXmlText(c.toString("utf8"), ctx, onHit)
    } else {
      scrubUtf16Runs(c, ctx, "check", onHit)
      if (/(?:^|\/)(?:Workbook|Book)$/.test(inner.FullPaths[i])) scrubAsciiRuns(c, ctx, "check", onHit)
    }
  }
}
