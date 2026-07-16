/**
 * 한국 공문서 PII(개인정보) 탐지·마스킹 순수 로직.
 *
 * 텍스트 in → 마스킹된 텍스트 + 히트 리포트 out. 문서 파싱/patch는 기존 인프라가
 * 담당하고 여기서는 텍스트만 다룬다 (CLI/MCP 배선은 별도).
 *
 * 원칙:
 * - 서식 보존 마스킹 — 자릿수·구분자를 유지해 마스킹 전후 길이가 동일
 * - 히트 리포트에 원본 PII를 절대 담지 않는다 (`masked` 필드만 존재)
 * - 룰 우선순위 겹침 처리 — 우선순위순으로 매치를 수집하고, 이미 점유된
 *   구간과 겹치는 하위 룰 매치는 스킵 (RULE_PRIORITY 참조)
 * - 정규식은 모듈 로드 시 1회 컴파일 (matchAll은 내부 클론이라 lastIndex 안전)
 */

export type RedactRule = "rrn" | "phone" | "email" | "card" | "account" | "passport" | "driver"

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
  /** 적용할 룰 (기본: DEFAULT_REDACT_RULES — passport·driver는 기본 OFF) */
  rules?: RedactRule[]
  /** 마스크 문자 — 1글자(UTF-16 1단위), 영숫자 금지. 기본 "●" (마크다운 특수문자 아님) */
  maskChar?: string
}

/** 기본 적용 룰 — passport(여권)·driver(운전면허)는 오탐 여지가 있어 opt-in */
export const DEFAULT_REDACT_RULES: readonly RedactRule[] = [
  "rrn",
  "phone",
  "email",
  "card",
  "account",
]

/**
 * 룰 우선순위 (앞이 높음). 스펙 요구는 rrn > card > phone > account —
 * 나머지는 포섭 관계로 배치: email을 phone 앞에(로컬파트 숫자에 전화 패턴 오탐 방지),
 * driver를 account 앞에(면허번호 12자리 4그룹이 계좌 패턴에 포섭됨).
 */
const RULE_PRIORITY: readonly RedactRule[] = [
  "rrn",
  "email",
  "card",
  "phone",
  "driver",
  "account",
  "passport",
]

interface RuleDef {
  pattern: RegExp
  /** 오탐 필터 — false면 매치 스킵 */
  validate?: (m: RegExpMatchArray) => boolean
  /** 매치 → 같은 길이의 마스킹 문자열 */
  mask: (m: RegExpMatchArray, mc: string) => string
}

/** Luhn 체크섬 (카드번호 오탐 축소) */
function luhnValid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** 주민번호 앞 6자리(YYMMDD)의 월 01-12, 일 01-31 검증 */
function birthdateValid(front6: string): boolean {
  const mm = Number(front6.slice(2, 4))
  const dd = Number(front6.slice(4, 6))
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
}

// 전체 정규식은 모듈 로드 시 1회 컴파일
const RULES: Record<RedactRule, RuleDef> = {
  // 주민/외국인등록번호 — 뒷자리 첫 숫자 1-8 + 생년월일 유효성으로 오탐 축소.
  // 유니코드 대시 변형(‐ ‑ – —)은 rrn만 허용. 앞 6자리 유지, 뒤 7자리 전부 마스크.
  rrn: {
    pattern: /(?<!\d)(\d{6})([-‐‑–—])([1-8]\d{6})(?!\d)/g,
    validate: (m) => birthdateValid(m[1]),
    mask: (m, mc) => m[1] + m[2] + mc.repeat(7),
  },
  // 이메일 — 로컬파트 첫 글자만 남기고 마스크, 도메인 유지
  email: {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    mask: (m, mc) => {
      const at = m[0].indexOf("@")
      return m[0][0] + mc.repeat(at - 1) + m[0].slice(at)
    },
  },
  // 카드번호 — 구분자 필수(무구분 16자리는 오탐 높아 제외), 동일 구분자 강제(\2),
  // Luhn 체크. 가운데 8자리 마스크.
  card: {
    pattern: /(?<!\d)(\d{4})([- ])(\d{4})\2(\d{4})\2(\d{4})(?!\d)/g,
    validate: (m) => luhnValid(m[1] + m[3] + m[4] + m[5]),
    mask: (m, mc) => m[1] + m[2] + mc.repeat(4) + m[2] + mc.repeat(4) + m[2] + m[5],
  },
  // 전화번호 — 휴대폰(01[016789])·서울(02)·지역(0[3-6]\d)·인터넷(070)은 구분자
  // -·.·공백 또는 무구분(동일 구분자 강제), 대표번호(15xx/16xx/18xx)는 구분자 필수.
  // 가운데 자리만 마스크 (대표번호는 뒤 4자리). 선행 [\d-] 금지 — 계좌 부분매치 방지.
  phone: {
    pattern:
      /(?<![\d-])(?:(01[016789]|070|02|0[3-6]\d)([-. ]?)(\d{3,4})\2(\d{4})|(1[568]\d{2})([-. ])(\d{4}))(?!\d)/g,
    mask: (m, mc) =>
      m[1] !== undefined
        ? m[1] + m[2] + mc.repeat(m[3].length) + m[2] + m[4]
        : m[5] + m[6] + mc.repeat(4),
  },
  // 운전면허 (기본 OFF) — 신형 12자리만 (지역명 2글자 선행 구버전은 스킵). 뒷 8자리 마스크.
  driver: {
    pattern: /(?<![\d-])(\d{2})-(\d{2})-\d{6}-\d{2}(?!-?\d)/g,
    mask: (m, mc) => m[1] + "-" + m[2] + "-" + mc.repeat(6) + "-" + mc.repeat(2),
  },
  // 계좌번호 — 3~4그룹 + 총 자릿수 10~16. rrn·card·phone과 겹치면 그쪽 우선.
  // 마지막 그룹 빼고 전부 마스크. 사업자등록번호(3-2-5, 10자리)도 걸린다 — 계약상 의도
  // (테스트로 명시). 날짜(2026-07-16)는 8자리라 총자릿수 검증에서 탈락.
  account: {
    pattern: /(?<!\d)(?<!\d-)\d{2,6}(?:-\d{2,6}){1,2}-\d{2,8}(?!-?\d)/g,
    validate: (m) => {
      const digits = m[0].replace(/-/g, "").length
      return digits >= 10 && digits <= 16
    },
    mask: (m, mc) => {
      const parts = m[0].split("-")
      return parts.map((p, i) => (i === parts.length - 1 ? p : mc.repeat(p.length))).join("-")
    },
  },
  // 여권번호 (기본 OFF) — 단어 경계, 첫 글자만 남기고 전부 마스크
  passport: {
    pattern: /\b([MSRODG])\d{8}(?![0-9A-Za-z])/g,
    mask: (m, mc) => m[1] + mc.repeat(8),
  },
}

/**
 * 텍스트에서 PII를 탐지해 서식 보존 마스킹.
 *
 * @param text - 대상 텍스트 (마크다운 포함)
 * @param options - 룰 선택·마스크 문자 (기본: rrn·phone·email·card·account, "●")
 * @returns 마스킹된 텍스트 + 히트 리포트 (index 오름차순, 원본 PII 미포함)
 */
export function redactText(text: string, options?: RedactOptions): RedactTextResult {
  const maskChar = options?.maskChar ?? "●"
  if (maskChar.length !== 1 || /[0-9A-Za-z]/.test(maskChar)) {
    throw new Error(`maskChar는 영숫자가 아닌 1글자여야 함: ${JSON.stringify(maskChar)}`)
  }

  const enabled = options?.rules ?? DEFAULT_REDACT_RULES
  const hits: RedactHit[] = []
  if (text === "" || enabled.length === 0) return { text, hits }

  // 우선순위순으로 매치 수집 — 점유 구간과 겹치는 하위 룰 매치는 스킵
  const occupied: Array<{ start: number; end: number }> = []
  for (const rule of RULE_PRIORITY) {
    if (!enabled.includes(rule)) continue
    const def = RULES[rule]
    for (const m of text.matchAll(def.pattern)) {
      if (def.validate && !def.validate(m)) continue
      const start = m.index as number
      const end = start + m[0].length
      if (occupied.some((o) => start < o.end && end > o.start)) continue
      occupied.push({ start, end })
      hits.push({ rule, masked: def.mask(m, maskChar), index: start, length: m[0].length })
    }
  }

  hits.sort((a, b) => a.index - b.index)

  let out = ""
  let cursor = 0
  for (const h of hits) {
    out += text.slice(cursor, h.index) + h.masked
    cursor = h.index + h.length
  }
  out += text.slice(cursor)
  return { text: out, hits }
}

/**
 * 마크다운 문서 전용 래퍼 — base64 이미지(data URI) 라인은 마스킹에서 제외한다.
 * base64 페이로드의 숫자열이 phone 등에 오탐되면 이미지가 깨지기 때문.
 * hits의 index는 문서 전체 기준 절대 오프셋으로 환산된다.
 */
export function redactMarkdown(markdown: string, options?: RedactOptions): RedactTextResult {
  const lines = markdown.split("\n")
  const hits: RedactHit[] = []
  let offset = 0
  const outLines = lines.map((line) => {
    if (line.includes("data:image/")) {
      offset += line.length + 1
      return line
    }
    const r = redactText(line, options)
    for (const h of r.hits) hits.push({ ...h, index: h.index + offset })
    offset += line.length + 1
    return r.text
  })
  return { text: outLines.join("\n"), hits }
}
