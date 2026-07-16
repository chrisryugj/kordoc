/** 양식 필드 매칭 공용 유틸 — filler.ts, filler-hwpx.ts에서 공유 */

import { LABEL_KEYWORDS } from "./recognize.js"

/**
 * 채울 값 — 문자열이면 같은 라벨 모든 등장에 동일값(단일 양식),
 * 배열이면 등장 순서대로 하나씩 소진(2~30장 반복 양식·명부형 표).
 */
export type FillValue = string | string[]

/**
 * 채울 값 입력 — 값만 주거나, 서식 변환(format)을 함께 지정한다.
 * 프로필엔 정준값 하나(생년월일 "19900315"), 서식마다 모양이 다를 때
 * format이 도구 안에서 변환한다 (claw-hwp secure-fill 포맷엔진 이식).
 */
export type FillInput = FillValue | { value: FillValue; format?: string }

// ─── 값 서식 변환 (claw-hwp secure-fill formatValue 이식) ─────────────

function parseYMD(v: string): { y: string; yy: string; m: string; d: string } | null {
  let y: string, m: string, day: string
  // 구분자(. - / 년월일 등)로 분리된 3토큰이면 미패딩 날짜(2026.7.5·2026년 7월 5일)로 우선 해석
  const parts = v.split(/[^0-9]+/).filter(Boolean)
  if (parts.length === 3) {
    const [yp, mp, dp] = parts
    const yn = +yp
    y = yp.length >= 3 ? yp : String(yn <= 29 ? 2000 + yn : 1900 + yn)
    m = mp.padStart(2, "0")
    day = dp.padStart(2, "0")
  } else {
    const d = v.replace(/\D/g, "")
    if (d.length >= 8) { y = d.slice(0, 4); m = d.slice(4, 6); day = d.slice(6, 8) }
    else if (d.length === 6) { const yy = +d.slice(0, 2); y = String(yy <= 29 ? 2000 + yy : 1900 + yy); m = d.slice(2, 4); day = d.slice(4, 6) }
    else return null
  }
  // 월 1-12·일 1-31 범위 밖이면 fail-open(쓰레기 날짜 무음 기입 방지)
  if (+m < 1 || +m > 12 || +day < 1 || +day > 31) return null
  return { y, yy: y.slice(2), m, d: day }
}

function fmtDate(v: string, style: string): string {
  const p = parseYMD(v)
  if (!p) return v
  // 토큰 치환(대소문자 무시 — yyyy-MM-dd 혼용 수용, 긴 것 우선). 단독 m/d(선행 0
  // 제거)는 영문 리터럴(예: "amended")을 오염시키지 않게 영문자에 비인접일 때만 치환.
  return (style || "yyyy-mm-dd")
    .replace(/yyyy/gi, p.y).replace(/yy/gi, p.yy)
    .replace(/mm/gi, p.m).replace(/dd/gi, p.d)
    .replace(/(?<![a-z])m(?![a-z])/gi, String(+p.m))
    .replace(/(?<![a-z])d(?![a-z])/gi, String(+p.d))
}

/** 숫자 마스크 — `#` 하나가 값의 다음 숫자 하나를 소비, 리터럴은 통과 */
function maskDigits(v: string, pattern: string): string {
  const ds = v.replace(/\D/g, "")
  const need = (pattern.match(/#/g) ?? []).length
  // # 개수와 숫자 개수가 다르거나 패턴에 # 가 없으면, 그럴듯한 오값·끝자리 폐기·
  // 값 삭제 대신 원형을 반환한다 (무음 왜곡 금지 — fail-open).
  if (need === 0 || ds.length !== need) return v
  let i = 0
  return pattern.replace(/#/g, () => ds[i++])
}

function fmtPhone(v: string, style: string): string {
  const d = v.replace(/\D/g, "")
  if (d.length < 9) return v
  // 서울(02)은 2자리 지역번호, 그 외(휴대폰 010·지역 0XX)는 3자리
  const areaLen = d.startsWith("02") ? 2 : 3
  const a = d.slice(0, areaLen), b = d.slice(areaLen, -4), c = d.slice(-4)
  switch (style) {
    case "digits": return d
    case "dot": return `${a}.${b}.${c}`
    case "space": return `${a} ${b} ${c}`
    case "intl": return `+82-${d.slice(1, areaLen)}-${b}-${c}`
    case "intl-paren": return `82)${d.slice(1, areaLen)}-${b}-${c}`
    default: return `${a}-${b}-${c}` // hyphen
  }
}

function fmtRRN(v: string, style: string): string {
  const d = v.replace(/\D/g, "")
  if (d.length !== 13) return v
  switch (style) {
    case "digits": return d
    case "front": return d.slice(0, 6)
    case "masked": return `${d.slice(0, 6)}-${d[6]}******`
    default: return `${d.slice(0, 6)}-${d.slice(6)}` // hyphen
  }
}

/**
 * 값 서식 변환 — `종류:스타일` 접두형(date:/phone:/rrn:/mask:/digits/upper/lower/nospace)
 * 또는 접두 없는 자유 패턴(`#` 포함 → 숫자마스크, yyyy·yy·mm·dd 포함 → 날짜 토큰).
 * 모르는 포맷은 값 원형 반환 (fail-open — 채움 자체는 진행).
 */
export function formatFillValue(value: string, format?: string): string {
  if (!format) return value
  const ci = format.indexOf(":")
  const kind = ci >= 0 ? format.slice(0, ci) : format
  const style = ci >= 0 ? format.slice(ci + 1) : ""
  if (kind === "date") return fmtDate(value, style)
  if (kind === "phone") return fmtPhone(value, style)
  if (kind === "rrn") return fmtRRN(value, style)
  if (kind === "mask") return maskDigits(value, style)
  if (kind === "digits") { const only = value.replace(/\D/g, ""); return only || value }
  if (kind === "upper") return value.toUpperCase()
  if (kind === "lower") return value.toLowerCase()
  if (kind === "nospace") return value.replace(/\s+/g, "")
  if (format.includes("#")) return maskDigits(value, format)
  if (/(yyyy|yy|mm|dd)/.test(format)) return fmtDate(value, format)
  return value
}

/**
 * 다중값 커서 — 라벨별 값 소비 상태를 추적한다.
 * 스칼라 값은 무한 반복(기존 동작), 배열 값은 적용 순서대로 소진되며
 * 다 쓰면 available=false가 되어 이후 등장은 채우지 않는다.
 */
export class ValueCursor {
  private nextIdx = new Map<string, number>()
  constructor(private values: Map<string, FillValue>) {}

  keys(): IterableIterator<string> {
    return this.values.keys()
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  isArray(key: string): boolean {
    return Array.isArray(this.values.get(key))
  }

  /** 남은 값이 있으면 true (스칼라는 항상 true) */
  available(key: string): boolean {
    const v = this.values.get(key)
    if (v === undefined) return false
    return typeof v === "string" || (this.nextIdx.get(key) ?? 0) < v.length
  }

  /** 현재 값 미리보기 (소진 없음) */
  peek(key: string): string | undefined {
    const v = this.values.get(key)
    if (v === undefined) return undefined
    if (typeof v === "string") return v
    const i = this.nextIdx.get(key) ?? 0
    return i < v.length ? v[i] : undefined
  }

  /** 값 소비 — 배열이면 커서 전진, 소진 시 undefined */
  consume(key: string): string | undefined {
    const v = this.values.get(key)
    if (v === undefined) return undefined
    if (typeof v === "string") return v
    const i = this.nextIdx.get(key) ?? 0
    if (i >= v.length) return undefined
    this.nextIdx.set(key, i + 1)
    return v[i]
  }
}

/** 라벨 정규화 — 콜론/공백/특수문자 제거, 비교용 */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/[:：\s()（）·]/g, "")
}

/**
 * 정규화된 셀 라벨과 입력 값 맵에서 최적 매칭 키를 찾음.
 *
 * 매칭 우선순위:
 * 1. 정확 매칭 (normalizedCellLabel === key)
 * 2. 접두사 기반 매칭 (60% 이상 겹침 필요)
 */
export function findMatchingKey(
  cellLabel: string,
  values: { has(key: string): boolean; keys(): Iterable<string> },
): string | undefined {
  // 1) 정확 매칭
  if (values.has(cellLabel)) return cellLabel

  // 2) 접두사 기반 매칭 — 가장 긴 매칭 우선 (= 가장 구체적)
  //    단, 길이 비율 60% 이상 겹쳐야 매칭 (오탐 방지)
  let bestKey: string | undefined
  let bestLen = 0

  for (const key of values.keys()) {
    if (cellLabel.startsWith(key)) {
      if (key.length >= cellLabel.length * 0.6 && key.length > bestLen) {
        bestLen = key.length
        bestKey = key
      }
    } else if (key.startsWith(cellLabel)) {
      // 역방향(짧은 셀이 긴 키를 흡수)은 0.75 — 0.6이면 셀 "대리인"이 키
      // "대리인성명"을 흡수해 성명 값이 대리인 라벨 옆에 들어간다
      if (cellLabel.length >= key.length * 0.75 && cellLabel.length > bestLen) {
        bestLen = cellLabel.length
        bestKey = key
      }
    }
  }

  return bestKey
}

/**
 * 값 셀이 키워드 라벨(섹션 헤더의 하위 라벨)인지 판별.
 * "성명", "주소" 같은 키워드 라벨이면 true → 스킵 대상.
 * "(한자：)" 같은 어노테이션이면 false → 채울 수 있음.
 */
export function isKeywordLabel(text: string): boolean {
  const trimmed = text.trim().replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰*※]+$/g, "").trim()
  if (!trimmed || trimmed.length > 15) return false
  for (const kw of LABEL_KEYWORDS) {
    if (trimmed.includes(kw)) return true
  }
  return false
}

/**
 * 셀 텍스트에서 인셀 패턴을 찾아 교체 — 체크박스 + 괄호 빈칸.
 *
 * 지원 패턴:
 * 1. 괄호 빈칸: `일반(  )통` → 키 "일반통" 또는 "일반" 매칭 시 → `일반(값)통`
 * 2. 체크박스: `□부` → 키 "부" 매칭 시 → `☑부` (값이 "☑","✓","v","V","true","1" 등)
 *
 * @returns 교체된 텍스트 + 매칭된 키 목록. null이면 교체 없음.
 */
export function fillInCellPatterns(
  cellText: string,
  values: ValueCursor,
  matchedLabels: Set<string>,
  /** require_unique 2차에서 거부된 라벨 셀 차단 (sfill-2 전략0) — 전략 1~3과 동일 계약 */
  blockedLabels?: Set<string>,
): { text: string; matches: Array<{ key: string; label: string; value: string }> } | null {
  let text = cellText
  const matches: Array<{ key: string; label: string; value: string }> = []

  // 1) 괄호 빈칸: keyword(\s+)suffix → keyword(value)suffix
  text = text.replace(
    /([가-힣A-Za-z]+)\(\s{1,}\)([가-힣A-Za-z]*)/g,
    (match, prefix: string, suffix: string) => {
      const label = prefix + suffix  // "일반" + "통" = "일반통"
      const normalizedLabel = normalizeLabel(label)
      // require_unique 2차: 이 라벨이 거부됐으면 접두사 폴백으로 남의 키에 재배정 금지 (sfill-2 전략0)
      if (blockedLabels?.has(normalizedLabel)) return match
      // 정확 매칭 → 접두사만 매칭 순
      const matchKey = values.available(normalizedLabel)
        ? normalizedLabel
        : values.available(normalizeLabel(prefix))
          ? normalizeLabel(prefix)
          : undefined
      if (matchKey === undefined) return match

      const newValue = values.consume(matchKey)!
      matchedLabels.add(matchKey)
      matches.push({ key: matchKey, label, value: newValue })
      return `${prefix}(${newValue})${suffix}`
    },
  )

  // 2) 체크박스: □keyword → ☑keyword (값이 truthy)
  text = text.replace(
    /□([가-힣A-Za-z]+)/g,
    (match, keyword: string) => {
      const normalizedKw = normalizeLabel(keyword)
      const matchKey = values.available(normalizedKw) ? normalizedKw : undefined
      if (matchKey === undefined) return match

      const val = values.peek(matchKey)!
      // 계약: 빈 문자열은 "체크 안 함" — 체크 의사는 ☑/true/1 등 명시 값으로만 표현한다
      const isTruthy = ["☑", "✓", "✔", "v", "V", "true", "1", "yes", "o", "O"].includes(val.trim())
      if (!isTruthy) return match

      values.consume(matchKey)
      matchedLabels.add(matchKey)
      matches.push({ key: matchKey, label: `□${keyword}`, value: "☑" })
      return `☑${keyword}`
    },
  )

  // 3) 어노테이션 빈칸: (keyword：\s+) → (keyword：value)
  //    예: "(한자：                  )" → "(한자：金民秀)"
  //    예: "(성명:        )" → "(성명: 홍길동)"
  text = text.replace(
    /\(([가-힣A-Za-z]+)[:：]\s{1,}\)/g,
    (match, keyword: string) => {
      const normalizedKw = normalizeLabel(keyword)
      const matchKey = values.available(normalizedKw) ? normalizedKw : undefined
      if (matchKey === undefined) return match

      const newValue = values.consume(matchKey)!
      matchedLabels.add(matchKey)
      matches.push({ key: matchKey, label: keyword, value: newValue })
      return `(${keyword}：${newValue})`
    },
  )

  return matches.length > 0 ? { text, matches } : null
}

// ─── 인라인 "라벨: 값" 세그먼트 분해 ─────────────────

export interface InlineSegment {
  /** 라벨 (콜론 제외) */
  label: string
  /** 라벨 시작 오프셋 */
  labelStart: number
  /** 값 시작 오프셋 (콜론·공백 뒤) */
  valueStart: number
  /** 값 끝 오프셋 (다음 라벨/구분자 직전, 우측 공백 제외) */
  valueEnd: number
  /** text.slice(valueStart, valueEnd) */
  value: string
  /**
   * 직전 어절을 포함한 확장 라벨 ("신청인 성명") — 정확 매칭 후보.
   * 직전 어절이 이전 라벨의 값("… 강남구 전화:")일 수 있으므로 정확 매칭에만
   * 쓰고, 접두사 매칭은 핵심 라벨(label)로만 한다. 직전 어절이 없으면 undefined.
   */
  extLabel?: string
  /** 확장 라벨 시작 오프셋 (직전 어절 첫 글자) — extLabel 있을 때만 */
  extStart?: number
}

const INLINE_LABEL_RE = /((?:[가-힣A-Za-z]{1,10} )?)([가-힣A-Za-z]{2,10})\s*[:：]/g

/**
 * 인라인 양식 한 줄을 라벨 단위로 분해 — 한 줄에 라벨이 여러 개인 양식
 * ("자문위원 성명:   작성일자:  ") 지원. 값은 다음 라벨 직전(또는
 * 구분자 [,;\n] / 100자 / 줄끝)에서 끝난다. 값이 빈 라벨도 세그먼트로
 * 반환한다 (value="", valueStart===valueEnd — 채움 대상).
 * "http://" 류 URL 스킴의 콜론은 라벨로 보지 않는다.
 */
export function scanInlineSegments(text: string): InlineSegment[] {
  const labels: Array<{ label: string; ext?: string; extStart?: number; start: number; end: number }> = []
  INLINE_LABEL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_LABEL_RE.exec(text)) !== null) {
    if (text[INLINE_LABEL_RE.lastIndex] === "/") continue // "://" — URL 스킴
    // m[1]=직전 어절(확장 라벨용, 공백 포함), m[2]=핵심 라벨. 세그먼트 좌표는
    // 핵심 라벨 기준(기존 값 경계 보존) — "신청인 성명:"과 "대리인 성명:"이 같은
    // "성명"으로 붕괴하지 않게 확장 라벨을 정확 매칭 후보로 함께 넘긴다.
    labels.push({
      label: m[2],
      ext: m[1] ? m[1] + m[2] : undefined,
      extStart: m[1] ? m.index : undefined,
      start: m.index + m[1].length,
      end: INLINE_LABEL_RE.lastIndex,
    })
  }

  const segments: InlineSegment[] = []
  for (let i = 0; i < labels.length; i++) {
    const cur = labels[i]
    let vs = cur.end
    while (vs < text.length && (text[vs] === " " || text[vs] === "\t")) vs++
    let ve = i + 1 < labels.length ? labels[i + 1].start : text.length
    if (ve < vs) ve = vs // 다음 라벨이 공백 스킵 구간 안에서 시작하는 경우
    const sep = text.slice(vs, ve).search(/[\n,;]/)
    if (sep !== -1) ve = vs + sep
    if (ve - vs > 100) ve = vs + 100
    while (ve > vs && /\s/.test(text[ve - 1])) ve--
    segments.push({
      label: cur.label,
      labelStart: cur.start,
      valueStart: vs,
      valueEnd: ve,
      value: text.slice(vs, ve),
      ...(cur.ext !== undefined ? { extLabel: cur.ext, extStart: cur.extStart } : {}),
    })
  }
  return segments
}

/**
 * 인라인 세그먼트 매칭 키 결정 — 확장 라벨("신청인 성명") 정확 매칭 우선,
 * 핵심 라벨("성명")은 기존 findMatchingKey(정확+접두사) 폴백.
 * 확장 라벨은 직전 어절이 이전 라벨의 값일 수 있어 정확 매칭만 허용한다 (과탐 방지).
 * @returns 매칭 키 + filled 보고용 라벨 + 확장 매칭 여부. blockedLabels(sfill-2)에 걸리면 undefined.
 */
export function matchInlineSegment(
  seg: InlineSegment,
  values: { has(key: string): boolean; keys(): Iterable<string> },
  blockedLabels?: Set<string>,
): { key: string; label: string; viaExt: boolean } | undefined {
  const nlabel = normalizeLabel(seg.label)
  if (seg.extLabel !== undefined) {
    const nExt = normalizeLabel(seg.extLabel)
    if (nExt !== nlabel && !blockedLabels?.has(nExt) && values.has(nExt)) {
      return { key: nExt, label: seg.extLabel, viaExt: true }
    }
  }
  if (blockedLabels?.has(nlabel)) return undefined
  const key = findMatchingKey(nlabel, values)
  return key !== undefined ? { key, label: seg.label, viaExt: false } : undefined
}

/**
 * 세그먼트 값의 유효 끝 — 다음 세그먼트가 확장 라벨로 매칭됐으면 값 범위가
 * 그 직전 어절(확장 라벨의 일부, "대리인 성명"의 "대리인")을 삼키지 않게 앞당긴다.
 */
export function clampSegmentEnd(
  text: string,
  seg: InlineSegment,
  next: InlineSegment | undefined,
  nextViaExt: boolean,
): number {
  let ve = seg.valueEnd
  if (nextViaExt && next?.extStart !== undefined && next.extStart < ve) ve = next.extStart
  while (ve > seg.valueStart && /\s/.test(text[ve - 1])) ve--
  return ve
}

/** 빈 자리(valueStart===valueEnd) 삽입 시 콜론·다음 라벨과 붙지 않게 공백 부착 */
export function padInsertion(text: string, pos: number, value: string): string {
  const lead = pos > 0 && !/\s/.test(text[pos - 1]) ? " " : ""
  const trail = pos < text.length && !/\s/.test(text[pos]) ? " " : ""
  return lead + value + trail
}

/**
 * 입력 values 맵을 정규화된 키로 변환 — format 지정(FillInput 객체형)은 여기서 값으로 변환.
 * @param warnings 정규화 후 키가 충돌하는 라벨("성 명"과 "성명")의 무음 덮어쓰기 경고 수집
 */
export function normalizeValues(values: Record<string, FillInput>, warnings?: string[]): Map<string, FillValue> {
  const map = new Map<string, FillValue>()
  for (const [label, raw] of Object.entries(values)) {
    const { value, format } = typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : { value: raw, format: undefined }
    const key = normalizeLabel(label)
    if (map.has(key)) {
      warnings?.push(`입력 라벨 "${label}"이 정규화 키 "${key}"에서 다른 라벨과 충돌 — 뒤 값으로 덮어씀`)
    }
    map.set(key, Array.isArray(value)
      ? value.map(v => formatFillValue(v, format))
      : formatFillValue(value, format))
  }
  return map
}

/**
 * 모호 라벨 거부 가드 — 한 입력 키(스칼라)가 서식의 2곳 이상에 채워지면 남의 블록
 * 오염 위험(대표자 행에 참여인력 값이 들어가는 류)이므로, 그 키는 채우지 않고
 * rejected로 보고한 뒤 나머지 키만으로 다시 채운다 (claw-hwp require_occurrence 이식).
 * 배열 값은 다중 등장 소진이 의도된 동작이라 거부 대상이 아니다.
 * @param run 같은 원본에 대해 결정적으로 재실행 가능한 채우기 함수
 */
export async function fillWithUniqueGuard<R extends { filled: Array<{ key?: string; label: string }> }>(
  values: Record<string, FillInput>,
  run: (vals: Record<string, FillInput>, blockedLabels?: Set<string>) => R | Promise<R>,
): Promise<R & { rejected: string[] }> {
  const first = await run(values)
  const counts = new Map<string, number>()
  for (const f of first.filled) {
    if (f.key) counts.set(f.key, (counts.get(f.key) ?? 0) + 1)
  }
  const isArrayValue = (normKey: string): boolean => {
    for (const [label, raw] of Object.entries(values)) {
      if (normalizeLabel(label) !== normKey) continue
      return Array.isArray(typeof raw === "object" && !Array.isArray(raw) ? raw.value : raw)
    }
    return false
  }
  const dup = new Set([...counts].filter(([k, n]) => n >= 2 && !isArrayValue(k)).map(([k]) => k))
  if (dup.size === 0) return { ...first, rejected: [] }
  // 거부된 키에 매칭됐던 셀 라벨들 — 2차에서 이 셀이 접두사 매칭으로 남은 다른 키에
  // 재배정되어 남의 값으로 오염되는 것을 차단한다 (sfill-2).
  const blockedLabels = new Set<string>()
  for (const f of first.filled) {
    if (f.key && dup.has(f.key)) blockedLabels.add(normalizeLabel(f.label))
  }
  const filtered = Object.fromEntries(Object.entries(values).filter(([label]) => !dup.has(normalizeLabel(label))))
  const second = await run(filtered, blockedLabels)
  const rejected = Object.keys(values).filter(label => dup.has(normalizeLabel(label)))
  return { ...second, rejected }
}

/** 매칭 안 된 라벨을 원본 키로 복원 */
export function resolveUnmatched(
  normalizedValues: Map<string, FillValue>,
  matchedLabels: Set<string>,
  originalValues: Record<string, FillInput>,
): string[] {
  return [...normalizedValues.keys()]
    .filter(k => !matchedLabels.has(k))
    .map(k => {
      for (const orig of Object.keys(originalValues)) {
        if (normalizeLabel(orig) === k) return orig
      }
      return k
    })
}
