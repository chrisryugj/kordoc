/**
 * HWP 5.x → HWPX 변환 공용 — 레코드 커서·레코드 트리·XML 조각·색·열거 이름.
 *
 * 열거 이름과 값 대응은 공개 HWP 5.0 문서 형식과 OWPML(KS X 6101)을 따르고, 같은 문서를 한글이 .hwp·.hwpx 로 함께 저장한
 * 짝(bench/hwp2hwpx.mjs 정답 짝)에서 대조해 맞춘 것이다.
 */

export interface Rec { tagId: number; level: number; data: Buffer }

/** 레코드와 자식(바로 아래 수준의 뒤따르는 레코드) */
export interface RecNode { rec: Rec; kids: RecNode[] }

/** 평평한 레코드 열을 수준으로 트리로 — 자식은 부모보다 수준이 1 깊은 뒤따르는 레코드 */
export function recordTree(recs: Rec[]): RecNode[] {
  const top: RecNode[] = []
  const stack: RecNode[] = []
  for (const rec of recs) {
    const node: RecNode = { rec, kids: [] }
    while (stack.length && stack[stack.length - 1].rec.level >= rec.level) stack.pop()
    if (stack.length) stack[stack.length - 1].kids.push(node)
    else top.push(node)
    stack.push(node)
  }
  return top
}

/** 레코드 데이터 순차 읽기 — 짧은(옛 판) 레코드는 모자란 필드를 0 으로 읽는다 */
export class Cur {
  constructor(readonly d: Buffer, public o = 0) {}
  get rest(): number { return this.d.length - this.o }
  u8(): number { const v = this.o < this.d.length ? this.d[this.o] : 0; this.o += 1; return v }
  i8(): number { const v = this.u8(); return v > 127 ? v - 256 : v }
  u16(): number { const v = this.o + 2 <= this.d.length ? this.d.readUInt16LE(this.o) : 0; this.o += 2; return v }
  i16(): number { const v = this.u16(); return v > 32767 ? v - 65536 : v }
  u32(): number { const v = this.o + 4 <= this.d.length ? this.d.readUInt32LE(this.o) : 0; this.o += 4; return v }
  i32(): number { return this.u32() | 0 }
  /** WORD 글자 수 + UTF-16LE 글 */
  str(): string {
    const n = this.u16()
    const s = this.d.toString("utf16le", Math.min(this.o, this.d.length), Math.min(this.d.length, this.o + n * 2))
    this.o += n * 2
    return s
  }
  skip(n: number): this { this.o += n; return this }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g
/** XML 속성 값 — XML 이 허용하지 않는 제어 문자는 뺀다 */
export function esc(s: string): string {
  return s.replace(XML_FORBIDDEN, "").replace(/[&<>"]/g, c => ESC[c])
}
/** 글 마디 — 한글처럼 따옴표는 그대로 둔다 */
export function escText(s: string): string {
  return s.replace(XML_FORBIDDEN, "").replace(/[&<>]/g, c => ESC[c])
}

/** 속성 목록 → ` a="1" b="x"` (값 그대로 이스케이프) */
export function attrs(list: Array<[string, string | number]>): string {
  let s = ""
  for (const [k, v] of list) s += ` ${k}="${typeof v === "number" ? v : esc(v)}"`
  return s
}

/** 요소 하나 — 내용이 없으면(undefined) 빈 요소 */
export function el(name: string, list: Array<[string, string | number]>, inner?: string): string {
  return inner === undefined ? `<${name}${attrs(list)}/>` : `<${name}${attrs(list)}>${inner}</${name}>`
}

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0")
/**
 * COLORREF(0xAABBGGRR) → "#RRGGBB", 0xFFFFFFFF → "none". 투명도 바이트가 있으면 한글처럼 그 바이트를 앞자리 0 없이 붙인다
 * ("#FF000000"·"#10000000", 0x0A 는 "#A10FCA0" — 한글 저장본의 테두리·무늬·선·각주 구분선 색)
 */
export function color(c: number): string {
  c >>>= 0
  if (c === 0xffffffff) return "none"
  const a = c >>> 24
  return "#" + (a ? a.toString(16).toUpperCase() : "") + hex2(c & 0xff) + hex2((c >>> 8) & 0xff) + hex2((c >>> 16) & 0xff)
}

/** 0/1 플래그 */
export const bit = (v: number, n: number): number => (v >>> n) & 1
/** 비트 구간 값 */
export const bits = (v: number, from: number, width: number): number => (v >>> from) & ((1 << width) - 1)
/** 열거 이름 — 범위 밖이면 첫 값 */
export const pick = (names: readonly string[], i: number): string => names[i] ?? names[0]

/** 테두리 선 종류 (BORDER_FILL 4변·대각선, 문단 테두리) — 0 은 없음 */
export const BORDER_TYPES = ["NONE", "SOLID", "DOT", "DASH", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM",
  "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLE_WAVE", "THICK_3D", "THICK_3D_REVERSE", "3D", "3D_REVERSE"] as const
/** 밑줄·취소선·구분선 모양 — 0 은 실선 */
export const LINE_SHAPES = BORDER_TYPES.slice(1)
/** 테두리 선 굵기 */
export const BORDER_WIDTHS = ["0.1 mm", "0.12 mm", "0.15 mm", "0.2 mm", "0.25 mm", "0.3 mm", "0.4 mm", "0.5 mm", "0.6 mm", "0.7 mm",
  "1.0 mm", "1.5 mm", "2.0 mm", "3.0 mm", "4.0 mm", "5.0 mm"] as const
/** 번호 모양 */
export const NUM_FORMATS = ["DIGIT", "CIRCLED_DIGIT", "ROMAN_CAPITAL", "ROMAN_SMALL", "LATIN_CAPITAL", "LATIN_SMALL", "CIRCLED_LATIN_CAPITAL",
  "CIRCLED_LATIN_SMALL", "HANGUL_SYLLABLE", "CIRCLED_HANGUL_SYLLABLE", "HANGUL_JAMO", "CIRCLED_HANGUL_JAMO", "HANGUL_PHONETIC",
  "IDEOGRAPH", "CIRCLED_IDEOGRAPH", "DECAGON_CIRCLE", "DECAGON_CIRCLE_HANJA"] as const

export type Param = number | string | number[] | ParamSet
export interface ParamSet { [id: number]: Param }

/** 매개변수 묶음(CTRL_DATA) — 묶음 id(WORD)·항목 수(DWORD), 항목마다 id(WORD)·종류(WORD)·값. 묶음 안 묶음(0x8000)·배열(0x8001: 개수 WORD·0·종류+값)은 펼친다 */
export function readParamSet(d: Buffer, at: { o: number }): ParamSet {
  const set: ParamSet = {}
  if (at.o + 6 > d.length) return set
  const n = d.readUInt32LE(at.o + 2)
  at.o += 6
  for (let i = 0; i < n && at.o + 4 <= d.length; i++) {
    const id = d.readUInt16LE(at.o), type = d.readUInt16LE(at.o + 2)
    at.o += 4
    if (type === 0x8000) set[id] = readParamSet(d, at)
    else if (type === 0x8001) {
      const cnt = d.readUInt16LE(at.o), arr: number[] = []
      at.o += 4
      for (let j = 0; j < cnt && at.o + 6 <= d.length; j++, at.o += 6) arr.push(d.readUInt32LE(at.o + 2))
      set[id] = arr
    } else if (type === 0x8002) { set[id] = d.readUInt16LE(at.o); at.o += 2 }
    else if (type === 1) {
      const n = d.readUInt16LE(at.o)
      set[id] = d.toString("utf16le", at.o + 2, Math.min(d.length, at.o + 2 + n * 2))
      at.o += 2 + n * 2
    }
    else { set[id] = d.readInt32LE(at.o); at.o += 4 }
  }
  return set
}

/** 묶음 안 묶음(SET) 하나 — 없으면 null */
export function subSet(set: ParamSet | undefined, id: number): ParamSet | null {
  const v = set?.[id]
  return v && typeof v === "object" && !Array.isArray(v) ? v : null
}
