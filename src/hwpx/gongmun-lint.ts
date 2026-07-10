/**
 * 공문서 표기법 검수기 — 「행정업무의 운영 및 혁신에 관한 규정」 시행규칙 및
 * 행정안전부 행정업무운영 편람의 날짜·시간·금액·기호 표기법을 정규식으로 검사.
 *
 * 원전: jkf87/hwpx-skill gonmun_lint.py(2025 편람 기준 13룰)를 kordoc에 맞게 이식
 * (v4.0.1). URL 쌍점 오탐 가드 등 일부 보강. 검사는 조언용이다 — 생성은 막지 않고
 * 경고만 낸다 (A2 폰트경고와 같은 원칙). 별도 CLI `kordoc lint`는 error 시 exit 1.
 */

export interface GongmunLintFinding {
  /** 1-based 줄 번호 */
  line: number
  /** 걸린 원문 조각 */
  match: string
  /** 규칙 코드 (DATE_NO_SPACE 등) */
  rule: string
  severity: "error" | "warning"
  message: string
  suggest?: string
}

interface LintRule {
  code: string
  severity: "error" | "warning"
  pattern: RegExp
  message: string
  suggest?: string
}

// 규칙 순서·코드·문구는 편람 기준 원전(gonmun_lint.py) 유지 — 대조 검증 용이성
const RULES: LintRule[] = [
  // 날짜 ─ 온점 뒤 한 칸, 0 패딩 금지, 연도 4자리, 끝 마침표
  { code: "DATE_NO_SPACE", severity: "error", pattern: /\b\d{4}\.\d{1,2}\.\d{1,2}\.?/g,
    message: "날짜 온점 뒤에 한 칸씩 띄워야 함", suggest: "예) 2025. 1. 6." },
  { code: "DATE_ZERO_PAD", severity: "error", pattern: /\b\d{4}\.\s*0\d\.|\.\s*0\d\./g,
    message: "월·일 앞의 '0'은 표기하지 않음", suggest: "예) 2025. 1. 6. (2025. 01. 06. ✕)" },
  { code: "DATE_2DIGIT_YR", severity: "error", pattern: /(?<!\d)['’]\d{2}\.\s*\d/g,
    message: "연도는 네 자리로 표기('24 ✕)", suggest: "예) 2025. 1. 6." },
  { code: "DATE_NO_END_DOT", severity: "warning", pattern: /\b\d{4}\.\s\d{1,2}\.\s\d{1,2}(?!\s*[.\d(])/g,
    message: "날짜의 '일' 다음에 마침표(.)를 찍어야 함", suggest: "예) 2025. 1. 6." },
  // 시간 ─ 24시각제, 쌍점 붙여쓰기
  { code: "TIME_AMPM", severity: "error", pattern: /(오전|오후|아침|밤|낮)\s*\d{1,2}\s*시/g,
    message: "24시각제 숫자로 표기(오전/오후 사용 안 함)", suggest: "예) 09:00, 15:30" },
  { code: "TIME_24H", severity: "warning", pattern: /(?<!\d)24\s*시(?!각)/g,
    message: "'24시'보다 익일 00:00 또는 '18:00까지' 권장", suggest: "예) 18:00" },
  { code: "TIME_COLON_SP", severity: "error", pattern: /\b\d{1,2}\s+:\s*\d{2}\b|\b\d{1,2}:\s+\d{2}\b/g,
    message: "시와 분 사이 쌍점은 양쪽을 붙여 씀", suggest: "예) 13:20" },
  // 금액 ─ '천원' 금지, 금+숫자 붙여쓰기
  { code: "MONEY_CHEONWON", severity: "error", pattern: /\d+\s*천\s*원/g,
    message: "금액은 '천원'으로 줄이지 않고 아라비아 숫자로", suggest: "예) 345,000원" },
  { code: "MONEY_GEUM_SP", severity: "warning", pattern: /금\s+\d/g,
    message: "'금'과 숫자 사이는 붙여 쓰는 것이 원칙", suggest: "예) 금113,560원" },
  // 붙임 ─ 쌍점 금지(2타 띄움)
  { code: "BUNIM_COLON", severity: "error", pattern: /붙\s*임\s*:/g,
    message: "'붙임' 다음에 쌍점(:)을 붙이지 않음(2타 띄움)", suggest: "예) 붙임  계획서 1부." },
  // 표기 ─ 물결표+까지 중복, 한글 먼저, 쌍점 띄어쓰기
  { code: "KKAJI_DUP", severity: "error", pattern: /[∼~～][^\n]{0,20}?까지/g,
    message: "물결표(∼)와 '까지'를 함께 쓰지 않음", suggest: "예) 2. 20.∼2. 24." },
  { code: "FOREIGN_FIRST", severity: "warning", pattern: /\b[A-Z]{2,5}\s*\([가-힣]/g,
    message: "한글을 먼저 쓰고 괄호 안에 외국어를 병기", suggest: "예) 업무 협약(MOU)" },
  // 쌍점 — URL(https:// 등)·시각(13:20)은 제외
  { code: "COLON_SPACE", severity: "warning", pattern: /\S\s+:\S|\S:(?!\/\/)[^\s\d]/g,
    message: "쌍점은 앞말에 붙이고 뒤는 한 칸 띄움", suggest: "예) 원장: 김갑동" },
]

/**
 * 텍스트(마크다운 포함) 표기법 검수. 마크다운 펜스 코드블록(``` ~ ```) 안은
 * 건너뛴다 — 코드·URL이 날짜/쌍점 규칙에 오탐되는 것 방지.
 */
export function lintGongmunText(text: string): GongmunLintFinding[] {
  const findings: GongmunLintFinding[] = []
  let inFence = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    for (const r of RULES) {
      r.pattern.lastIndex = 0
      for (const m of line.matchAll(r.pattern)) {
        findings.push({
          line: i + 1, match: m[0].trim(), rule: r.code,
          severity: r.severity, message: r.message, suggest: r.suggest,
        })
      }
    }
  }
  return findings
}

/** 검수 결과를 사람이 읽는 경고 문자열 배열로 — generate 경고 채널(A2와 동일)용 */
export function gongmunLintWarnings(text: string, limit: number = 10): string[] {
  const findings = lintGongmunText(text)
  const shown = findings.slice(0, limit).map(
    (f) => `표기법 [${f.rule}] L${f.line} "${f.match}" — ${f.message}${f.suggest ? ` (${f.suggest})` : ""}`,
  )
  if (findings.length > limit) shown.push(`표기법 경고 ${findings.length - limit}건 더 있음 — kordoc lint로 전체 확인`)
  return shown
}
