/**
 * 개조식 보고서 문체 검수기 — 서식이 맞아도 문체가 다르면 그 부서 문서로 읽히지 않는다.
 *
 * 표기법 검수(gongmun-lint.ts)가 "어떻게 적는가"를 본다면 이 모듈은 "어떤 꼴로 끝나는가"를
 * 본다. 개조식은 서술형 문장이 아니라 명사구로 끝나는 짧은 줄을 층층이 쌓는 문체다.
 *
 * 근거: 지자체 실무부서의 요약보고·기본계획·검토보고 15건(2,288줄) 실측 통계 —
 * jkf87/hwpx-skill v1.17.0 이 references/bogo-munche.md 로 공개한 수치를 임계값 근거로
 * 삼았다(서술형 `~다` 종결 0/264 항목, 항목 중앙 31자, 결론 중앙 30자, 물음표·느낌표
 * 본문 0건). 규칙 코드·정규식·판정 로직은 kordoc 자체 구현이다.
 *
 * 범위: 검수는 조언용이다 — 생성은 막지 않고 경고만 낸다(표기법 검수·폰트 경고와 같은
 * 원칙). 문체 *변환*은 여전히 엔진 범위 밖이다(gongmunseo-engine-spec.md).
 * 상세 규칙과 예문은 docs/gaejosik-munche.md.
 */

import { normalizeGongmunPreset } from "./gongmun.js"

export interface MuncheLintFinding {
  /** 1-based 줄 번호 */
  line: number
  /** 걸린 원문 조각 */
  match: string
  /** 규칙 코드 (DA_ENDING 등) */
  rule: string
  severity: "error" | "warning"
  /** 판정된 줄 종류 — 같은 문장도 층에 따라 허용 여부가 다르다 */
  kind: MuncheLineKind
  message: string
  suggest?: string
}

/**
 * 개조식 문체를 쓰는 프리셋 — 보고서·계획서·개조식보고서.
 * 기안문·시행문(official)은 경어 종결(`~하시기 바랍니다`), 통지·회의록·보도자료도
 * 각기 다른 문체 관행이라 이 검수를 적용하지 않는다. 적용 범위를 좁히는 것이
 * 오탐을 막는 가장 확실한 수단이다.
 */
export function usesGaejosikMunche(preset?: string): boolean {
  const p = normalizeGongmunPreset(preset)
  return p === "gaejosik" || p === "report" || p === "plan"
}

// ─── 줄 종류 ────────────────────────────────────────

/** □ 소제목 / ❍ 항목 / - 세부 / ⇒ 결론 / > 리드문 / ※ 참고 / 그 밖 */
export type MuncheLineKind = "dae" | "item" | "sub" | "concl" | "lead" | "note" | "para"

/** 실측 길이 임계 — 항목 중앙 31자(2줄 한계), 결론 중앙 30자, 리드문 40~120자 */
const ITEM_MAX = 70
const CONCL_MAX = 60
const LEAD_MAX = 140

/**
 * 줄 종류 판정. 원고는 두 가지 꼴로 온다 — 개조식 부호를 직접 쓴 것(□ ○ ❍ - ⇒ ※)과
 * 마크다운 목록으로 계층을 표현한 것(들여쓰기 깊이). 둘 다 받는다.
 * null 은 검사 대상 아님(빈 줄·헤딩·표·이미지).
 */
function classify(raw: string): { kind: MuncheLineKind; body: string } | null {
  const indent = raw.length - raw.trimStart().length
  const t = raw.trim()
  if (!t) return null
  // 헤딩·표·구분선·이미지는 문체 검사 대상이 아니다
  if (t.startsWith("#") || t.startsWith("|") || t.startsWith("![") || /^[-=*_]{3,}$/.test(t)) return null
  if (t.startsWith(">")) return { kind: "lead", body: t.slice(1).trim() }
  if (/^(?:⇒|=>|➡|→)/.test(t)) return { kind: "concl", body: t.replace(/^(?:⇒|=>|➡|→)\s*/, "") }
  if (/^(?:※|\*\s)/.test(t)) return { kind: "note", body: t.replace(/^(?:※|\*)\s*/, "") }
  if (t.startsWith("□")) return { kind: "dae", body: t.slice(1).trim() }
  if (/^(?:○|❍|ㅇ|◦)/.test(t)) return { kind: "item", body: t.slice(1).trim() }
  // 하이픈·중점 목록과 마크다운 목록은 들여쓰기로 항목/세부를 가른다
  const li = /^(?:[-•ㆍ·]|\d+[.)])\s+(.*)$/.exec(t)
  if (li) return { kind: indent >= 2 ? "sub" : "item", body: li[1].trim() }
  return { kind: "para", body: t }
}

/** 마크다운 강조·링크 껍데기를 걷어낸 알맹이 — 길이 판정과 종결 판정 모두 본문 기준 */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .trim()
}

/** 인용부호·괄호 안은 원문 인용이라 문체 판정에서 제외한다 (실측도 인용문 안에만 ?! 존재) */
function stripQuoted(s: string): string {
  return s.replace(/[“"'‘][^”"'’]{0,80}[”"'’]/g, "").replace(/\([^)]{0,80}\)/g, "")
}

// ─── 종결 판정 ──────────────────────────────────────

/**
 * 서술형 종결 — 명사·명사구로 끝나야 할 자리에서 `~다`로 끝나는 줄.
 * 명사형 종결(`~함/됨/임/음/있음/없음`)은 `다`로 끝나지 않으므로 자연히 통과한다.
 */
const DA_ENDING = /[가-힣]다\.?$/
/** 당위 종결 — 개조식은 판단을 `⇒ ○○ 필요`로 적지 `~해야 한다`로 적지 않는다 */
const DEONTIC = /(?:해야|하여야|되어야|돼야|필요가 있)\s*(?:한다|함|합니다|하겠음)\.?$|할 것\.?$/
/** `~것이다/것임` — 실측 1건뿐인 꼴 */
const GEOSIDA = /것(?:이다|임)\.?$/
/** 리드문 종결 — `~하고자 함.` 한 문장 */
const LEAD_ENDING = /(?:하고자|하려|고자)\s*함\.?$/

/**
 * `A가 아니라 B` 대조. B 자리에 구체 명사(제도·장소·절차)가 오면 두 선택지를 가르는
 * 정상 표현이고, 추상어·가치어가 오면 수사(修辭)다 — 실측에서 수사는 0건이다.
 */
const NOT_A_BUT = /(?:아니라|아닌|아니고|아니며)\s*,?\s*([가-힣]{1,12})/g
/** 가치어·추상어 — 이 자리에 오면 수사로 본다 */
const ABSTRACT = [
  "사람", "마음", "본질", "전환", "태도", "문화", "철학", "가치", "정신", "관계",
  "신뢰", "과정", "질문", "이야기", "경험", "시간", "공간", "연결", "변화", "미래",
  "시작", "용기", "의지", "방법", "자세", "의식", "역량",
]

/** 대구(對句) — 쉼표로 가른 두 구절이 같은 주격·주제 조사로 대칭을 이루는 슬로건 꼴 */
const COUPLET = /[은는이가]\s*[^,]{2,15},\s*[^,]{2,15}[은는이가]\s*[^,]{2,15}$/

/** 연·월·일을 글자로 적은 날짜 — 실측 표기는 `2026. 8. 22.` */
const DATE_KOREAN = /\d{4}년\s*\d{1,2}월/

// ─── 검수 ───────────────────────────────────────────

/**
 * 원고(마크다운/텍스트) 문체 검수. 코드펜스 안은 건너뛴다 — 예시 코드가 종결·대조
 * 규칙에 오탐되는 것 방지(표기법 검수와 같은 원칙).
 */
export function lintMuncheText(text: string): MuncheLintFinding[] {
  const findings: MuncheLintFinding[] = []
  const lines = text.split(/\r?\n/)
  let fenceMarker: string | null = null
  let frontMatter = false
  /** 연속된 `>` 줄은 리드문 한 덩어리 — 마지막 줄에서 통째로 판정한다 */
  let leadBuf: { line: number; body: string }[] = []

  const add = (
    line: number, kind: MuncheLineKind, severity: "error" | "warning",
    rule: string, match: string, message: string, suggest?: string,
  ) => {
    findings.push({ line, kind, severity, rule, match: match.slice(0, 60), message, suggest })
  }

  const flushLead = () => {
    if (!leadBuf.length) return
    const block = leadBuf.map((l) => l.body).join(" ").trim()
    const at = leadBuf[0].line
    leadBuf = []
    if (block.length < 20) return // 짧은 인용은 리드문이 아니다
    if (!LEAD_ENDING.test(block)) {
      add(at, "lead", "warning", "LEAD_ENDING", block,
        "리드문은 '~하고자 함.' 한 문장", "[수단]하고, [수단]하여 [목적]하고자 함.")
    }
    const sentences = (block.match(/\./g) ?? []).length
    if (block.length > LEAD_MAX || sentences > 1) {
      add(at, "lead", "warning", "LEAD_LONG", block,
        `리드문 ${block.length}자·문장 ${sentences}개 — 실측은 한 문장 40~120자`, "수단 둘·목적 하나로 압축")
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const no = i + 1
    // YAML 프런트매터는 본문이 아니다 (문서 앞머리의 --- ~ --- 만)
    if (raw.trim() === "---" && (frontMatter || no <= 3)) {
      if (no <= 3 || frontMatter) frontMatter = !frontMatter
      continue
    }
    if (frontMatter) continue
    const fence = raw.match(/^\s*(```+|~~~+)/)
    if (fence) {
      const kind = fence[1][0]
      if (fenceMarker === null) fenceMarker = kind
      else if (kind === fenceMarker) fenceMarker = null
      continue
    }
    if (fenceMarker !== null) continue

    const c = classify(raw)
    if (!c) {
      flushLead()
      continue
    }
    if (c.kind === "lead") {
      leadBuf.push({ line: no, body: plain(c.body) })
      continue
    }
    flushLead()

    const b = plain(c.body)
    if (!b) continue
    const q = stripQuoted(b) // 인용 제외 본문 — 종결·수사 판정용

    // 1) 종결 — 항목·세부·결론·본문 (□ 소제목과 ※ 참고는 명사구 제약 밖)
    if (c.kind === "item" || c.kind === "sub" || c.kind === "concl" || c.kind === "para") {
      if (DA_ENDING.test(q)) {
        add(no, c.kind, "error", "DA_ENDING", b,
          "'~다' 서술형 종결 — 실측 0%(항목 0/264)", "명사·명사구 또는 '~함/있음'으로")
      }
      if (GEOSIDA.test(q)) {
        add(no, c.kind, "warning", "GEOSIDA", b, "'~것이다/것임' — 실측 1건뿐", "명사 종결로")
      }
    }
    if (DEONTIC.test(q)) {
      add(no, c.kind, "error", "DEONTIC", b,
        "'~해야 한다' 당위 종결 — 판단은 명사로 끝맺음", "예) ⇒ 지역맞춤형 보급 필요")
    }

    // 2) 수사 — `A가 아니라 B`의 B가 추상어면 수사, 구체 선택지면 정상
    NOT_A_BUT.lastIndex = 0
    for (const m of q.matchAll(NOT_A_BUT)) {
      const tail = m[1] ?? ""
      if (ABSTRACT.some((w) => tail.includes(w))) {
        add(no, c.kind, "error", "RHETORIC_CONTRAST", m[0].trim(),
          `'아니라 ${tail}' — B가 추상어·가치어면 수사(실측 0건)`, "두 구체 선택지를 가르는 경우만 허용")
      } else {
        add(no, c.kind, "warning", "CONTRAST_CHECK", m[0].trim(),
          `'아니라 ${tail}' — B가 구체 선택지(제도·장소·절차)인지 확인`)
      }
    }

    // 3) 물음표·느낌표 — 본문 실측 0건 (인용문 안은 stripQuoted로 이미 제외)
    if (c.kind !== "note" && /[?!？！]/.test(q)) {
      add(no, c.kind, "error", "QUESTION_EXCLAIM", b, "물음표·느낌표 — 본문 실측 0건")
    }

    // 4) 대구·슬로건
    if ((c.kind === "item" || c.kind === "para" || c.kind === "dae") && COUPLET.test(q)) {
      add(no, c.kind, "warning", "COUPLET", b, "대구(對句)로 보임 — 슬로건 문장은 실측 0건", "목표 수치·명사로")
    }

    // 5) 길이 — 항목은 제목처럼 짧게, 세부는 설명처럼
    if (c.kind === "item" && b.length > ITEM_MAX) {
      add(no, c.kind, "warning", "ITEM_LONG", b,
        `항목 ${b.length}자 — 실측 중앙 31자, 2줄 한계`, "근거·예시는 세부(-)로 내림")
    }
    if (c.kind === "concl" && b.length > CONCL_MAX) {
      add(no, c.kind, "warning", "CONCL_LONG", b,
        `결론 ${b.length}자 — 실측 중앙 30자`, "판단 하나만 남김")
    }

    // 6) 날짜 글자 표기 (표기법 룰은 gongmun-lint 가 SSOT — 여기서는 문체 원고에 잦은 꼴만)
    if (DATE_KOREAN.test(b)) {
      add(no, c.kind, "warning", "DATE_KOREAN", b, "연·월을 글자로 표기", "예) 2026. 8. 22.")
    }
  }
  flushLead()
  return findings
}

/** 검수 결과를 사람이 읽는 경고 문자열 배열로 — generate 경고 채널(표기법과 동일)용 */
export function muncheLintWarnings(text: string, limit: number = 10): string[] {
  const findings = lintMuncheText(text)
  const shown = findings.slice(0, limit).map(
    (f) => `문체 [${f.rule}] L${f.line} "${f.match}" — ${f.message}${f.suggest ? ` (${f.suggest})` : ""}`,
  )
  if (findings.length > limit) shown.push(`문체 경고 ${findings.length - limit}건 더 있음 — kordoc lint --munche로 전체 확인`)
  return shown
}
