/**
 * 공문서 표기법 검수기 — 「행정업무의 운영 및 혁신에 관한 규정」 시행규칙 및
 * 행정안전부 행정업무운영 편람의 날짜·시간·금액·기호 표기법을 정규식으로 검사.
 *
 * 원전: jkf87/hwpx-skill gonmun_lint.py(2025 편람 기준 13룰)를 kordoc에 맞게 이식
 * (v4.0.1). URL 쌍점 오탐 가드 등 일부 보강. v4.12.1 에 금액 한글 병기·물결표·두음법칙·
 * 외래어·차별 표현·"끝." 누락 6룰 보강 (pyhwpxlib Gongmun 검사 항목 대조). 검사는 조언용이다 — 생성은 막지 않고
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

/** 외래어 오기 → 표준 표기 (국립국어원 외래어 표기법 용례) — 순서 무관, 긴 형태 우선 매칭 */
export const LOANWORD_FIXES: ReadonlyArray<readonly [string, string]> = [
  ["컨텐츠", "콘텐츠"], ["어플리케이션", "애플리케이션"], ["메세지", "메시지"], ["리더쉽", "리더십"],
  ["워크샵", "워크숍"], ["스케쥴", "스케줄"], ["악세사리", "액세서리"], ["네비게이션", "내비게이션"],
  ["타겟", "타깃"], ["화이팅", "파이팅"], ["비지니스", "비즈니스"], ["프리젠테이션", "프레젠테이션"],
  ["라이센스", "라이선스"], ["캐비넷", "캐비닛"], ["렌트카", "렌터카"], ["플랭카드", "플래카드"],
  ["플랜카드", "플래카드"], ["컨셉", "콘셉트"], ["심볼", "심벌"], ["카달로그", "카탈로그"],
  ["팜플렛", "팸플릿"], ["팜플릿", "팸플릿"], ["리모콘", "리모컨"], ["에어콘", "에어컨"], ["알콜", "알코올"],
  ["발란스", "밸런스"], ["매니아", "마니아"], ["코메디", "코미디"], ["판넬", "패널"], ["앵콜", "앙코르"],
  ["로보트", "로봇"], ["바베큐", "바비큐"], ["부페", "뷔페"], ["초코렛", "초콜릿"], ["카페트", "카펫"],
  ["케잌", "케이크"], ["도너츠", "도넛"], ["슈퍼마켙", "슈퍼마켓"], ["써비스", "서비스"], ["센타", "센터"],
]
const LOANWORD_RE = new RegExp(LOANWORD_FIXES.map(([w]) => w).sort((a, b) => b.length - a.length).join("|"), "g")

/** 차별·비하 표현 → 순화어 (행안부 공문서 작성 지침·국립국어원) */
export const DISCRIM_FIXES: ReadonlyArray<readonly [string, string]> = [
  ["장애자", "장애인"], ["장애우", "장애인"], ["불구자", "장애인"], ["정신박약", "지적장애"], ["정상인", "비장애인"],
  ["편부모", "한부모"], ["결손가정", "한부모가정"], ["미망인", "고인의 배우자"], ["학부형", "학부모"],
  ["불우이웃", "어려운 이웃"], ["유모차", "유아차"], ["저출산", "저출생"], ["잡상인", "이동상인"],
  ["파출부", "가사도우미"], ["청소부", "환경미화원"], ["간호원", "간호사"], ["운전수", "운전기사"],
  ["노가다", "건설노동자"], ["조선족", "중국동포"], ["매매춘", "성매매"], ["사생아", "혼외자"],
  ["벙어리", "언어장애인"], ["절름발이", "지체장애인"], ["애꾸눈", "시각장애인"], ["귀머거리", "청각장애인"],
]
const DISCRIM_RE = new RegExp(DISCRIM_FIXES.map(([w]) => w).sort((a, b) => b.length - a.length).join("|"), "g")

// 규칙 순서·코드·문구는 편람 기준 원전(gonmun_lint.py) 유지 — 대조 검증 용이성
const RULES: LintRule[] = [
  // 날짜 ─ 온점 뒤 한 칸, 0 패딩 금지, 연도 4자리, 끝 마침표
  { code: "DATE_NO_SPACE", severity: "error", pattern: /\b\d{4}\.\d{1,2}\.\d{1,2}\.?/g,
    message: "날짜 온점 뒤에 한 칸씩 띄워야 함", suggest: "예) 2025. 1. 6." },
  { code: "DATE_ZERO_PAD", severity: "error", pattern: /\b\d{4}\.\s*0\d\.|\b\d{4}\.\s*\d{1,2}\.\s*0\d/g,
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
  { code: "COLON_SPACE", severity: "warning", pattern: /\S\s+:(?!\/\/)|\S:(?!\/\/)[^\s\d]/g,
    message: "쌍점은 앞말에 붙이고 뒤는 한 칸 띄움", suggest: "예) 원장: 김갑동" },
  // ── 편람 보강 (v4.12.1) — pyhwpxlib Gongmun 검사·hwpx-skill gonmun_lint 대조로 빈 축 보충 ──
  // 금액 한글 병기 — 규정 시행규칙 제2조: 아라비아 숫자 다음 괄호 안에 한글로 적는다
  { code: "MONEY_NO_HANGUL", severity: "warning", pattern: /금\d[\d,]*원(?![\s]*[(（])/g,
    message: "금액은 숫자 다음 괄호 안에 한글 병기", suggest: "예) 금113,560원(금일십일만삼천오백육십원)" },
  // 물결표 앞뒤 붙여쓰기 — 기간·범위는 "2. 20.∼2. 24." 처럼 붙여 씀. 숫자·날짜·시각 범위(앞은 숫자·
  // 온점·괄호·년월일시분, 뒤는 숫자·연도 생략부호)에만 건다 — "기간( 부터 ~ 까지)" 기입란·"~ ※ 비고"·
  // "~ 수리완료시까지" 처럼 낱말이 붙는 물결표는 범위 표기가 아니다 (v4.12.2, 별지서식 47→30·기안문 32→27 실측)
  { code: "TILDE_SPACE", severity: "warning", pattern: /(?<=[\d.)일월년시분’'])[ \t]+[∼~～]|[∼~～][ \t]+(?=[\d'’])/g,
    message: "물결표(∼) 앞뒤는 붙여 씀", suggest: "예) 2. 20.∼2. 24., 09:00∼18:00" },
  // 두음법칙 — 어두의 "년도·년간·년말…" 은 "연도·연간·연말" (숫자 뒤 '2026년도' 는 정상). 서식의
  // 기입란("    년도", "( 년간)", "2026 년도")과 셀 하나가 "년도" 뿐인 표 머리글은 어두가 아니라
  // 빈칸 뒤 접미라 제외한다 (v4.12.2, 별지서식 실측 28건 전부 이 꼴·기안문 0건)
  { code: "DUEUM_ERROR", severity: "warning",
    pattern: /(?<![가-힣\d])(?<!\d[ \t]{1,3})(?<![(（>|][ \t]*)(?<![ \t][ \t])년(?:도별|도|간|말|초|차|세|내)(?![가-힣])(?![ \t]*(?:<\/t[dh]>|\|))/g,
    message: "어두의 '년'은 두음법칙에 따라 '연'으로 적음", suggest: "예) 연도, 연간, 연말, 연초" },
  // 외래어 표기 — 국립국어원 표기법 기준 흔한 오기 (사전 매칭)
  { code: "LOANWORD_ERROR", severity: "warning", pattern: LOANWORD_RE,
    message: "외래어 표기법에 맞지 않는 표기", suggest: "예) 콘텐츠·애플리케이션·메시지·워크숍·스케줄·콘셉트" },
  // 차별·비하 표현 — 행안부 공문서 작성 지침·국립국어원 순화어
  { code: "DISCRIMINATORY_TERM", severity: "warning", pattern: DISCRIM_RE,
    message: "차별·비하 표현은 순화어로", suggest: "예) 장애자→장애인, 편부모→한부모, 학부형→학부모, 미망인→고인의 배우자" },
  // ── AI 문체 흔적(슬롭) — 편람 원전 외 kordoc 자체 룰 (v4.9.0) ──────────────
  // 생성형 AI 초안이 공문서로 흘러들 때 남는 기계 문체를 걸러낸다. 조언용 warning.
  { code: "AI_EM_DASH", severity: "warning", pattern: /[—–―]/g,
    message: "줄표(— – ―)는 공문서 표기 관행에 맞지 않음(생성형 AI 문체 흔적)", suggest: "쉼표·괄호·가운뎃점(·)으로 풀어쓰기" },
  { code: "AI_BOLD_OVERUSE", severity: "warning", pattern: /(?:\*\*[^*\n]+\*\*[^*\n]*){3}/g,
    message: "한 줄에 강조(**) 3회 이상 — 강조 남발은 생성형 AI 문체 흔적", suggest: "리드어·핵심 수치 한 곳만 강조" },
]

/**
 * 텍스트(마크다운 포함) 표기법 검수. 마크다운 펜스 코드블록(``` ~ ```) 안은
 * 건너뛴다 — 코드·URL이 날짜/쌍점 규칙에 오탐되는 것 방지.
 */
export function lintGongmunText(text: string, opts?: { document?: boolean }): GongmunLintFinding[] {
  const findings: GongmunLintFinding[] = []
  // 펜스는 같은 마커 종류(``` 또는 ~~~)로만 닫힌다 — 다른 마커 줄이 안쪽에 있어도
  // 조기에 열리거나 닫히지 않게 여는 마커 종류를 기억한다.
  let fenceMarker: string | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      const kind = fence[1][0]
      if (fenceMarker === null) fenceMarker = kind
      else if (kind === fenceMarker) fenceMarker = null
      continue
    }
    if (fenceMarker !== null) continue
    for (const r of RULES) {
      r.pattern.lastIndex = 0
      for (const m of line.matchAll(r.pattern)) {
        findings.push({
          line: i + 1, match: m[0].trim(), rule: r.code,
          severity: r.severity, message: r.message, suggest: dictSuggest(r.code, m[0]) ?? r.suggest,
        })
      }
    }
  }
  // 문서 단위(opts.document) — 붙임이 있는데 "끝." 표시가 없다 (규정: 본문·붙임 표시 끝에 "끝.").
  // 생성 경로는 official 프리셋이 endMark 로 자동 방출하므로 기본(generate 경고)에서는 끄고
  // `kordoc lint` 완성 원고 검사에서만 켠다
  if (opts?.document && /^\s*붙\s*임(?![가-힣])/m.test(text) && !/끝\.\s*$/m.test(text)) {
    findings.push({ line: lines.length, match: "붙임", rule: "END_MARK_MISSING", severity: "warning",
      message: "붙임 표시 뒤에 '끝.' 표시가 없음", suggest: "예) 붙임  계획서 1부.  끝." })
  }
  return findings
}

/** 사전 규칙(외래어·차별 표현)은 걸린 낱말의 표준 표기를 바로 제안 */
function dictSuggest(code: string, match: string): string | undefined {
  const table = code === "LOANWORD_ERROR" ? LOANWORD_FIXES : code === "DISCRIMINATORY_TERM" ? DISCRIM_FIXES : null
  if (!table) return undefined
  const hit = table.find(([w]) => w === match.trim())
  return hit ? `${hit[0]} → ${hit[1]}` : undefined
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
