/**
 * HWP 5.x patch 가 새 글을 마크다운 서식대로 넣을 때 쓰는 글자 모양 책 — DocInfo CHAR_SHAPE 마다 서식 비트(굵게·기울임·밑줄·취소선·
 * 첨자, 파서 body.ts 와 같은 판정)를 읽고, 서식 비트만 다른 짝을 찾는다. 짝이 없으면 DocInfo 를 다시 쓸 수 있을 때(creatable) 비트를
 * 뺀 사본을 CHAR_SHAPE 끝에 덧붙일 새 글자 모양으로 만든다(added — patchHwp 가 DocInfo 에 싣고 ID_MAPPINGS 개수를 올린다). 만들 수
 * 없으면 그 조각은 들어갈 run 서식 그대로(호출자가 부분 적용으로 알린다). HWPX 쪽은 char-pr.ts
 */

import { TAG_DOC_CHAR_SHAPE } from "../hwp5/record.js"
import { hasRealStrike, hasRealUnderline } from "../hwp5/body.js"
import { EMPH_BOLD, EMPH_ITALIC, EMPH_STRIKE, EMPH_UNDERLINE, EMPH_SUP, EMPH_SUB, styledInline, flagsPerChar } from "./inline-edit.js"
import { stripCellTokens } from "./table-patch.js"

/** CHAR_SHAPE 속성 u32 위치 (글꼴 id 7×2 · 장평·자간·상대 크기·위치 7×1 씩 · 기준 크기 4 뒤) */
const ATTR = 46
/** 서식 비트 자리 — 기울임 0 · 굵게 1 · 밑줄 종류 2-3 · 위첨자 15 · 아래첨자 16 · 취소선 18-20 · 취소선 모양 26-29 */
const MASK = 0x1 | 0x2 | (0x3 << 2) | (1 << 15) | (1 << 16) | (0x7 << 18) | (0xf << 26)

/** CHAR_SHAPE 속성의 서식 비트 */
export function hwpEmphasisFlags(attr: number): number {
  return (attr & 0x2 ? EMPH_BOLD : 0) | (attr & 0x1 ? EMPH_ITALIC : 0) | (hasRealStrike(attr) ? EMPH_STRIKE : 0)
    | (hasRealUnderline(attr) ? EMPH_UNDERLINE : 0) | (attr & (1 << 15) ? EMPH_SUP : 0) | (attr & (1 << 16) ? EMPH_SUB : 0)
}

export interface HwpCharBook {
  flagsOf(id: number): number | undefined
  /** id 와 서식 비트만 다른(flags) 글자 모양 — DocInfo 에 있으면 그 id, 없으면 비트를 빼고 더해(creatable 일 때) 만든 새 id, 아니면 undefined */
  variant(id: number, flags: number): number | undefined
  /** 만든 CHAR_SHAPE 레코드 데이터 (새 id 순 — 기존 개수부터) */
  added(): Buffer[]
}

/** 서식 비트를 켠 CHAR_SHAPE 속성 — 밑줄은 글자 아래(종류 1), 취소선은 종류 1·모양 실선(0) */
function withBitsAttr(attr: number, bits: number): number {
  let a = attr
  if (bits & EMPH_BOLD) a |= 0x2
  if (bits & EMPH_ITALIC) a |= 0x1
  if (bits & EMPH_UNDERLINE) a = (a & ~(0x3 << 2)) | (1 << 2)
  if (bits & EMPH_STRIKE) a = (a & ~(0x7 << 18) & ~(0xf << 26)) | (1 << 18)
  if (bits & EMPH_SUP) a = (a & ~(1 << 16)) | (1 << 15)
  if (bits & EMPH_SUB) a = (a & ~(1 << 15)) | (1 << 16)
  return a >>> 0
}

/** 서식 비트를 뺀 CHAR_SHAPE 속성 */
function withoutBits(attr: number, bits: number): number {
  let a = attr
  if (bits & EMPH_BOLD) a &= ~0x2
  if (bits & EMPH_ITALIC) a &= ~0x1
  if (bits & EMPH_UNDERLINE) a &= ~(0x3 << 2)
  if (bits & EMPH_STRIKE) a &= ~(0x7 << 18)
  if (bits & EMPH_SUP) a &= ~(1 << 15)
  if (bits & EMPH_SUB) a &= ~(1 << 16)
  return a >>> 0
}

export function hwpCharBook(docInfo: Array<{ tagId: number; data: Buffer }>, creatable = false): HwpCharBook {
  const datas = docInfo.filter(r => r.tagId === TAG_DOC_CHAR_SHAPE).map(r => r.data)
  const flags: Array<number | undefined> = [], keys: Array<string | undefined> = []
  const register = (d: Buffer): void => {
    if (d.length < ATTR + 4) { flags.push(undefined); keys.push(undefined); return }
    flags.push(hwpEmphasisFlags(d.readUInt32LE(ATTR)))
    const b = Buffer.from(d)
    b.writeUInt32LE((b.readUInt32LE(ATTR) & ~MASK) >>> 0, ATTR)
    keys.push(b.toString("hex"))
  }
  datas.forEach(register)
  const base = datas.length
  const added: Buffer[] = []
  return {
    flagsOf: id => flags[id],
    variant(id, f) {
      if (flags[id] === f) return id
      if (keys[id] === undefined) return undefined
      for (let j = 0; j < flags.length; j++) if (keys[j] === keys[id] && flags[j] === f) return j
      if (!creatable) return undefined
      const src = id < base ? datas[id] : added[id - base]
      const d = Buffer.from(src)
      d.writeUInt32LE(withBitsAttr(withoutBits(d.readUInt32LE(ATTR), flags[id]! & ~f), f & ~flags[id]!), ATTR)
      if (hwpEmphasisFlags(d.readUInt32LE(ATTR)) !== f) return undefined
      added.push(d)
      register(d)
      return base + added.length - 1
    },
    added: () => added,
  }
}

/** 새 글을 마크다운 서식대로 (patcher InsertStyle 의 HWP 판) */
export interface HwpInsertStyle {
  /** 새 평문 글자마다 서식 비트 */
  flags: number[]
  /** 원본 마크다운에 보이던 서식 비트 — 이 비트는 마크다운대로 끄고 켜고, 그 밖 비트는 새 글에 표시됐을 때 더하기만 한다(숨은 구조 서식은 안 지움) */
  known: number
  book: HwpCharBook
  /** 맞는 글자 모양이 DocInfo 에 없어 run 서식 그대로 둔 조각 수 */
  missed?: number
}

/**
 * CHAR_SHAPE 쌍 목록에서 새 글 [at, at + text.length)(문단 글자 위치)를 조각마다 바라는 글자 모양으로 덮는다 — 조각 뒤 글은 원래
 * 모양 그대로. 새 글이 받을 run 은 landing 자리 글자 모양(문단 끝에 붙인 글은 끝 표시 말고 마지막 글자 것 — 호출자가 준다).
 * toEnd 면 새 글 바로 뒤가 문단 끝 표시뿐이다 — 끝 표시가 새 글이 받은 run 과 같은 모양이면 마지막 조각 모양이 끝 표시까지 덮는다
 * (한글에서 문단 끝에 친 글처럼. 끝 표시만 남은 run 을 따로 두면 run 수가 늘어 파서의 대표 글자 모양 최빈값이 바뀌어 제목 판정이
 * 뒤집힌다). newAt 은 새 평문에서 text 가 시작하는 자리(style.flags 좌표). style 이 없으면 run 만 맞춘다. 다를 게 없으면 null
 */
export function restyleInserted(
  csData: Buffer, at: number, text: string, newAt: number, style: HwpInsertStyle | undefined, landing = at, toEnd = false,
): { buf: Buffer; count: number } | null {
  let pairs: Array<[number, number]> = []
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)])
  if (!pairs.length) return null
  const idAt = (p: number): number => pairs.reduce((id, [q, v]) => (q <= p ? v : id), pairs[0][1])
  const runId = idAt(landing)
  const runFlags = style?.book.flagsOf(runId)
  let changed = false
  for (let k = 0; k < text.length;) {
    const f = style?.flags[newAt + k] ?? 0
    let e = k + 1
    while (e < text.length && (style?.flags[newAt + e] ?? 0) === f) e++
    const want = runFlags === undefined || !style ? undefined : (runFlags & ~style.known) | f
    let id: number | undefined = want === undefined || want === runFlags ? runId : style!.book.variant(runId, want)
    if (id === undefined) { style!.missed = (style!.missed ?? 0) + 1; id = runId }
    if (id !== idAt(at + k)) {
      const a = at + k, b = at + e, after = idAt(b)
      pairs = pairs.filter(([p]) => p < a || p > b)
      pairs.push([a, id])
      if (!(toEnd && e === text.length && after === runId)) pairs.push([b, after])
      pairs.sort((x, y) => x[0] - y[0])
      changed = true
    }
    k = e
  }
  if (!changed) return null
  const kept = pairs.filter((r, k) => k === 0 || r[1] !== pairs[k - 1][1])
  const buf = Buffer.alloc(kept.length * 8)
  kept.forEach(([p, id], k) => { buf.writeUInt32LE(p >>> 0, k * 8); buf.writeUInt32LE(id >>> 0, k * 8 + 4) })
  return { buf, count: kept.length }
}

/**
 * 칸 줄마다 새 글 서식 — 편집 칸 마크다운(after)·원본(before)을 줄(<br>·줄바꿈)로 나눠 styledInline. 줄 i 의 평문이 그 문단에 쓸 글과
 * 같을 때만(앞 공백은 뗀다). 보이는 비트는 그 줄 것만(칸 문단은 통째 굵으면 표지를 숨긴다 — HWPX table-patch 와 같다)
 */
export function cellLineStyles(before: string, after: string, book: HwpCharBook | undefined): (i: number, text: string) => HwpInsertStyle | undefined {
  if (!book) return () => undefined
  const lines = (md: string) => md.split(/\n|(?<!\\)<br\s*\/?>/i).map(l => styledInline(stripCellTokens(l))).filter(l => l.plain.trim())
  const a = lines(after), b = lines(before)
  return (i, text) => {
    const st = a[i]
    if (!st || !b[i] || st.plain.trim() !== text) return undefined
    const lead = st.plain.length - st.plain.trimStart().length
    return { flags: flagsPerChar(st.segs, st.flags).slice(lead), known: b[i].flags.reduce((x, y) => x | y, 0), book }
  }
}
