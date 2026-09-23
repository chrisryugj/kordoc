/**
 * 한국 공문서 PII(개인정보) 탐지·마스킹 순수 로직.
 *
 * 텍스트 in → 마스킹된 텍스트 + 히트 리포트 out. 문서 파일 단위 마스킹(머리말·각주·미리보기·메타데이터
 * 포함)은 redact-doc.ts 가 이 엔진을 불러 쓴다.
 *
 * 원칙:
 * - 서식 보존 마스킹 — 자릿수·구분자를 유지해 마스킹 전후 길이(UTF-16 단위)가 동일
 * - 히트 리포트에 원본 PII를 절대 담지 않는다 (`masked` 필드만 존재)
 * - 탐지는 같은 길이로 정규화한 그림자 문자열에서 한다 — 전각 숫자·영문·@, 유니코드 대시(‐‑–—−－·─·ㅡ),
 *   NBSP·전각 공백을 ASCII 로 1:1 치환하므로 오프셋이 그대로이고, 마스킹은 원문 글자에 적용한다
 * - 번호 모양만으로 모호한 형태(구분자 없는 13자리·10~14자리, 여권 구형 등)는 바로 앞 라벨
 *   ("주민등록번호", "계좌", "여권" …) 이나 표 열 머리글이 해당 유형일 때만 잡는다. 가장 가까운
 *   라벨이 이긴다 — "법인등록번호" 옆 6-7 번호는 주민번호로 보지 않는다
 * - 체크섬: 카드 Luhn, 사업자·법인등록번호 가중합. 주민·외국인등록번호는 2020-10 이후 뒷자리가
 *   임의 번호라 체크섬으로 거르지 않고 생년월일(세기 포함)·성별 자리만 검증한다
 * - 룰 우선순위 겹침 처리 — 우선순위순으로 매치를 수집하고, 이미 점유된 구간과 겹치는 하위 룰
 *   매치는 스킵 (RULE_PRIORITY 참조)
 * - 정규식은 모듈 로드 시 1회 컴파일 (matchAll은 내부 클론이라 lastIndex 안전)
 *
 * 룰별 근거·오탐 실측은 bench/redact-bench.mjs (합성 정답 셋 + 실코퍼스) 참조.
 */

import { RULES, RULE_PRIORITY, labelsBefore, labelsIn, type Ctx, type Match, type Variant } from "./redact-rules.js"

export type RedactRule =
  | "rrn" | "phone" | "email" | "card" | "account" | "passport" | "driver" | "brn" | "crn" | "ip"

export interface RedactHit {
  rule: RedactRule
  /** 마스킹 후 문자열 — 원본 PII는 리포트에 담지 않는다 */
  masked: string
  /** 원문 내 시작 오프셋 (UTF-16 단위) */
  index: number
  /** 매치 길이 (서식 보존이라 마스킹 전후 동일) */
  length: number
}

export interface RedactTextResult {
  text: string
  hits: RedactHit[]
}

export interface RedactOptions {
  /** 적용할 룰 (기본: DEFAULT_REDACT_RULES — crn·ip는 기본 OFF) */
  rules?: readonly RedactRule[]
  /** 마스크 문자 — 1글자(UTF-16 1단위). 영숫자·공백·제어문자·마크다운/XML 특수문자(|\<>&"')는 금지. 기본 "●" */
  maskChar?: string
}

/**
 * 기본 적용 룰. 실코퍼스 2,303문서 오탐 실측 근거(bench/redact-bench.mjs --corpus):
 * - brn(사업자등록번호)은 종전 account 가 잡던 것을 체크섬으로 분리 — 기본 마스킹 범위 그대로
 * - passport 는 신형(M123A4567)만 무문맥, 구형(M12345678)은 "여권" 라벨이 있을 때만 → 기본 ON
 * - driver 는 지역코드(11~28)·지역명 검증으로 좁혔고 종전에도 account 로 가려지던 모양 → 기본 ON
 * - crn(법인등록번호)은 개인정보가 아니고, ip 는 "1.2.3.4" 절 번호·버전과 겹쳐 opt-in
 */
export const DEFAULT_REDACT_RULES: readonly RedactRule[] = [
  "rrn", "phone", "email", "card", "account", "brn", "passport", "driver",
]

/** 엔진이 아는 전체 룰 (CLI/MCP 입력 검증·벤치용) */
export const ALL_REDACT_RULES: readonly RedactRule[] = [...DEFAULT_REDACT_RULES, "crn", "ip"]

// ─── 정규화 (같은 길이) ───────────────────────────────

// 대시 모양 — 유니코드 하이픈·대시류 + 한글 문서에서 대시로 쓰는 괘선(─ ━)·한글 모음 ㅡ·장음 ー
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d, 0x2500, 0x2501, 0x3161, 0x30fc])
const SPACES = new Set([0x00a0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x3000])

/** 탐지용 그림자 문자열 — 모든 치환이 UTF-16 1단위 → 1단위라 오프셋이 원문과 같다 */
export function normalizeForDetect(text: string): string {
  let out = ""
  let changed = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    let r = c
    if (c >= 0xff01 && c <= 0xff5e) r = c - 0xfee0 // 전각 ASCII(！~～) → 반각
    if (DASHES.has(c)) r = 0x2d
    else if (SPACES.has(c)) r = 0x20
    if (r !== c) changed = true
    out += r === c ? text[i] : String.fromCharCode(r)
  }
  return changed ? out : text
}

/**
 * 매치 원문에 이름 그룹 범위를 maskChar 로 치환한 문자열 (길이 동일). 영숫자 판정은 정규화 텍스트로
 * 해서 전각 숫자도 가린다. maskAll 이면 구분자까지 전부.
 */
function maskMatch(orig: string, x: Match, v: Variant, maskChar: string): string {
  const base = x.m.index as number
  const norm = x.m[0]
  const chars = orig.split("")
  const idx = x.m.indices?.groups
  for (const name of v.mask) {
    const r = idx?.[name]
    if (!r) continue
    for (let i = r[0] - base; i < r[1] - base; i++) {
      if (v.maskAll || /[0-9A-Za-z]/.test(norm[i])) chars[i] = maskChar
    }
  }
  return chars.join("")
}

/**
 * 마스크 문자 검증 — 1글자(UTF-16 1단위). 금지: 영숫자(전각 포함 — 정규화하면 숫자라 재탐지됨), 공백·제어·
 * 서식·결합 문자·비문자(U+FFFE/FFFF 등 \\p{Z}\\p{C}\\p{M}), 표·태그를 깨는 |\\<>&"', 번호·주소 구분자
 * ._-@+:/,; (가린 결과가 다시 번호·이메일 모양이 되어 재검사 잔존으로 잡힌다)
 */
function assertMaskChar(maskChar: string): void {
  const n = normalizeForDetect(maskChar)
  if (
    maskChar.length !== 1 || /[0-9A-Za-z|\\<>&"'._\-@+:/,;]/.test(n)
    || /[\p{Z}\p{C}\p{M}]/u.test(maskChar) || /[\uFDD0-\uFDEF\uFFFE\uFFFF]/.test(maskChar)
  ) {
    throw new Error(`maskChar는 영숫자·공백·제어/결합 문자·구분 기호(|\\<>&"'._-@+:/,;)가 아닌 보이는 1글자여야 함: ${JSON.stringify(maskChar)}`)
  }
}

/** 나열 구분자 — 앞 값과 이 값 사이가 이것뿐이면 같은 라벨 아래 목록이다 ("계좌 110-…, 110-…") */
const LIST_SEP_RE = /^\s{0,2}(?:[,;/·、]|및|또는)?\s{0,2}$/

/**
 * 탐지 코어 — headerAt 은 오프셋 → 그 위치 표 열 머리글 텍스트 (redactMarkdown 이 표에서 제공).
 * 인라인 라벨이 없으면 (1) 바로 앞에 나열 구분자로 이어진 값이 있을 때 그 값의 라벨과 룰을 잇고,
 * (2) 그래도 없으면 머리글 라벨 집합을 쓴다.
 */
function detect(
  text: string, rules: readonly RedactRule[], maskChar: string, headerAt?: (index: number) => string | undefined,
): RedactHit[] {
  const norm = normalizeForDetect(text)
  const hits: RedactHit[] = []
  const occupied: Array<{ start: number; end: number; ctx: () => ReadonlySet<Ctx>; rule: RedactRule }> = []
  for (const rule of RULE_PRIORITY) {
    if (!rules.includes(rule)) continue
    for (const v of RULES[rule]) {
      for (const m of norm.matchAll(v.re)) {
        const start = m.index as number
        const end = start + m[0].length
        if (occupied.some((o) => start < o.end && end > o.start)) continue
        let cached: ReadonlySet<Ctx> | undefined
        const ctx = (): ReadonlySet<Ctx> => {
          if (!cached) {
            let c: ReadonlySet<Ctx> = labelsBefore(norm, start)
            if (c.size === 0) {
              const prev = occupied.find((o) => o.end < start && start - o.end <= 6 && LIST_SEP_RE.test(norm.slice(o.end, start)))
              // 앞 값의 라벨 + 앞 값이 무엇이었는지 자체가 문맥 (주민번호 다음 무구분 13자리도 주민번호)
              if (prev) c = prev.rule === "email" ? prev.ctx() : new Set<Ctx>([...prev.ctx(), prev.rule])
            }
            if (c.size === 0 && headerAt) {
              const h = headerAt(start)
              if (h) c = labelsIn(normalizeForDetect(h))
            }
            cached = c
          }
          return cached
        }
        const x: Match = { m, ctx }
        if (v.needs && !ctx().has(v.needs)) continue
        if (v.ok && !v.ok(x)) continue
        occupied.push({ start, end, ctx, rule })
        hits.push({ rule, masked: maskMatch(text.slice(start, end), x, v, maskChar), index: start, length: end - start })
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

function applyHits(text: string, hits: readonly RedactHit[]): string {
  let out = ""
  let cursor = 0
  for (const h of hits) {
    out += text.slice(cursor, h.index) + h.masked
    cursor = h.index + h.length
  }
  return out + text.slice(cursor)
}

/**
 * 텍스트에서 PII를 탐지해 서식 보존 마스킹.
 *
 * @param text - 대상 텍스트 (마크다운 포함)
 * @param options - 룰 선택·마스크 문자 (기본: DEFAULT_REDACT_RULES, "●")
 * @returns 마스킹된 텍스트 + 히트 리포트 (index 오름차순, 원본 PII 미포함)
 */
export function redactText(text: string, options?: RedactOptions): RedactTextResult {
  const maskChar = options?.maskChar ?? "●"
  assertMaskChar(maskChar)
  const rules = options?.rules ?? DEFAULT_REDACT_RULES
  if (text === "" || rules.length === 0) return { text, hits: [] }
  const hits = detect(text, rules, maskChar)
  return { text: applyHits(text, hits), hits }
}

// ─── 마크다운 표 머리글 문맥 ──────────────────────────

/** GFM 행의 셀 경계(이스케이프 안 된 파이프) 위치 */
function pipePositions(line: string): number[] {
  const out: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") out.push(i)
  }
  return out
}

const isGfmRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
const isGfmSep = (l: string): boolean => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(l)

interface HtmlCell { start: number; end: number; col: number; span: number; text: string }

/** HTML 표 행 한 줄의 셀 목록 (colspan 반영 열 번호) */
function htmlCells(line: string): HtmlCell[] {
  const out: HtmlCell[] = []
  let col = 0
  for (const m of line.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
    const span = Math.max(1, Number(m[2].match(/colspan="?(\d+)/i)?.[1] ?? 1))
    out.push({ start: m.index as number, end: (m.index as number) + m[0].length, col, span, text: m[3].replace(/<[^>]*>/g, " ") })
    col += span
  }
  return out
}

/**
 * 줄 번호 → (줄 내 오프셋 → 열 머리글 텍스트). GFM 표는 첫 행, HTML 표는 첫 <tr> 을 머리글로 본다
 * (병합·중첩 표에서는 근사 — 인라인 라벨이 없을 때만 쓰이는 보조 문맥).
 */
function tableHeaderContext(lines: string[]): Map<number, (offset: number) => string | undefined> {
  const out = new Map<number, (offset: number) => string | undefined>()
  for (let i = 0; i < lines.length; i++) {
    // GFM
    if (isGfmRow(lines[i]) && i + 1 < lines.length && isGfmSep(lines[i + 1])) {
      const head = lines[i]
      const hp = pipePositions(head)
      const headers = hp.slice(0, -1).map((p, k) => head.slice(p + 1, hp[k + 1]))
      let j = i + 2
      for (; j < lines.length && isGfmRow(lines[j]); j++) {
        const rp = pipePositions(lines[j])
        out.set(j, (off) => {
          let k = -1
          for (const p of rp) { if (p < off) k++; else break }
          return k >= 0 ? headers[k] : undefined
        })
      }
      i = j - 1
      continue
    }
    // HTML — 표 시작 줄부터 </table> 까지, 첫 <tr> 이 머리글
    if (/<table\b/i.test(lines[i])) {
      let headers: HtmlCell[] | null = null
      let depth = 0
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/<table\b/gi) ?? []).length
        if (/<tr\b/i.test(lines[j]) && depth === 1) {
          const cells = htmlCells(lines[j])
          if (!headers) headers = cells
          else if (cells.length > 0) {
            const hdr = headers
            out.set(j, (off) => {
              const c = cells.find((x) => off >= x.start && off < x.end)
              if (!c) return undefined
              const h = hdr.find((x) => c.col >= x.col && c.col < x.col + x.span)
              return h?.text
            })
          }
        }
        depth -= (lines[j].match(/<\/table>/gi) ?? []).length
        if (depth <= 0) { i = j; break }
      }
    }
  }
  return out
}

/**
 * 인라인 서식 표지 — 굵게·취소선·밑줄/HTML 강조 태그·백슬래시 이스케이프. 번호 한가운데 끼어도
 * (run 경계에서 굵게가 바뀐 "010-98**76-5431**", 이스케이프된 가림표 "900101-1\\*\\*…") 탐지되게
 * 지운 사본에서 찾고, 마스킹은 원문 글자 자리에만 입힌다 (표지는 그대로).
 * 항상 표지: ** __ ~~ (3개 이상 연속은 가림표일 수 있어 제외), 속성 없는 인라인 태그(href 속 값은 탐지
 * 대상으로 남긴다), 백슬래시 이스케이프.
 */
const MD_ALWAYS_MARKER_RE = new RegExp([
  "(?<!\\*)\\*\\*(?!\\*)", "(?<!_)__(?!_)", "(?<!~)~~(?!~)",
  "<\\/?(?:u|b|i|s|em|strong|sup|sub|del|span|mark|small|big|ins|strike|tt|code|kbd|samp|var|q|cite|abbr|dfn)>",
  "\\\\(?=[\\\\`*_{}[\\]()#+\\-.!|~>])",
].join("|"), "g")
/**
 * 짝지어야 표지 — 홑 * · 홑 _ · *** 기울임은 단어 경계의 여는 표지와 닫는 표지가 한 줄 안에서 짝을 이룰 때만.
 * 짝 없는 것은 가림표(900101-1694***, 010-****-5678)일 수 있어 둔다.
 */
const MD_OPEN_RE = /(?<![\w*\\])(\*\*\*|\*|_)(?=[0-9A-Za-z０-９])/g
const MD_CLOSE_RE = /(?<=[0-9A-Za-z０-９])(\*\*\*|\*|_)(?![\w*])/g

/** 마크다운 한 줄의 인라인 서식 표지 범위 [시작, 끝) — 오름차순 */
export function mdMarkerRanges(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of line.matchAll(MD_ALWAYS_MARKER_RE)) out.push([m.index as number, (m.index as number) + m[0].length])
  const taken = (a: number, b: number): boolean => out.some(([s, e]) => a < e && b > s)
  const closes = [...line.matchAll(MD_CLOSE_RE)].filter((m) => !taken(m.index as number, (m.index as number) + m[0].length))
  let from = 0
  for (const o of line.matchAll(MD_OPEN_RE)) {
    const os = o.index as number
    const oe = os + o[0].length
    if (os < from || taken(os, oe)) continue
    const c = closes.find((m) => (m.index as number) >= oe && m[0] === o[0])
    if (!c) continue
    out.push([os, oe], [c.index as number, (c.index as number) + c[0].length])
    from = (c.index as number) + c[0].length
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** 마크다운 한 줄 탐지 — 인라인 표지를 지운 사본에서 찾아 원문 오프셋·마스킹으로 되돌린다 */
function detectMarkdownLine(
  line: string, rules: readonly RedactRule[], maskChar: string, headerAt?: (index: number) => string | undefined,
): RedactHit[] {
  const markers = mdMarkerRanges(line)
  if (markers.length === 0) return detect(line, rules, maskChar, headerAt)
  let clean = ""
  const map: number[] = []
  let cursor = 0
  const keep = (to: number): void => {
    for (let i = cursor; i < to; i++) { clean += line[i]; map.push(i) }
  }
  for (const [ms, me] of markers) {
    keep(ms)
    cursor = me
  }
  keep(line.length)
  const hits = detect(clean, rules, maskChar, headerAt ? (i) => headerAt(map[i] ?? i) : undefined)
  return hits.map((h) => {
    const start = map[h.index]
    const end = map[h.index + h.length - 1] + 1
    const chars = line.slice(start, end).split("")
    for (let k = 0; k < h.length; k++) {
      if (h.masked[k] !== clean[h.index + k]) chars[map[h.index + k] - start] = maskChar
    }
    return { rule: h.rule, masked: chars.join(""), index: start, length: end - start }
  })
}

/**
 * 마크다운 문서 전용 래퍼 — base64 이미지(data URI) 라인은 마스킹에서 제외한다.
 * base64 페이로드의 숫자열이 phone 등에 오탐되면 이미지가 깨지기 때문.
 * 표 셀은 열 머리글("주민등록번호"·"계좌번호" …)을 라벨 문맥으로 쓰고, 인라인 서식 표지(**·\\ 이스케이프 등)가
 * 번호를 갈라도 잡는다. hits의 index는 문서 전체 기준 절대 오프셋으로 환산된다 (masked 에는 표지가 그대로).
 */
export function redactMarkdown(markdown: string, options?: RedactOptions): RedactTextResult {
  const maskChar = options?.maskChar ?? "●"
  assertMaskChar(maskChar)
  const rules = options?.rules ?? DEFAULT_REDACT_RULES
  const lines = markdown.split("\n")
  const headers = tableHeaderContext(lines)
  const hits: RedactHit[] = []
  let offset = 0
  const outLines = lines.map((line, i) => {
    if (line.includes("data:image/") || line === "" || rules.length === 0) {
      offset += line.length + 1
      return line
    }
    const lineHits = detectMarkdownLine(line, rules, maskChar, headers.get(i))
    for (const h of lineHits) hits.push({ ...h, index: h.index + offset })
    offset += line.length + 1
    return applyHits(line, lineHits)
  })
  return { text: outLines.join("\n"), hits }
}
