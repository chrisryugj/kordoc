/**
 * 공문서 옵션 표면 SSOT (v4.0.4, 인벤토리 영역1-1) — CLI(commander)와 MCP(zod)가
 * 각자 손배선하던 GongmunOptions 조립을 한 곳으로 모은다.
 *
 * 실측 드리프트의 뿌리는 두 가지였다:
 *   1. 값 집합(열거·중첩 키 목록·범위)이 세 곳(gongmun.ts 타입 / commander 검증 /
 *      zod shape)에 각자 사경 — line_spacing이 MCP에 빠지고 sizes.bodyTitle이
 *      zod에 누락되는 식. → 여기의 상수에서 양쪽이 파생한다.
 *   2. 조립 의미론(cover 우선순위, 조건부 대입)이 두 벌 복붙. → buildGongmunOptions
 *      하나로 통일 — 옵션 신설 시 이 파일과 표면별 플래그/파라미터 선언만 만지면 된다.
 *
 * 표면 문법(플래그 이름·설명문·kv 파싱)은 각 표면의 것 — 여기는 값과 의미만 담는다.
 */

import type { GongmunOptions, GongmunPreset } from "./gongmun.js"

// ─── 값 집합 (CLI 검증·MCP zod 공통 파생원) ──────────────

export const BODY_FONTS = ["myeongjo", "gothic"] as const
export const H2_MARKERS = ["box", "number", "none"] as const
export const BULLET2_CHARS = ["ㅇ", "○"] as const

/** 요소별 글꼴 오버라이드 역할 키 (GongmunOptions.fonts) */
export const FONT_ROLE_KEYS = ["body", "heading", "ref", "table"] as const
/** 개조식 요소별 크기 키 (gaejosik.ts GaejosikSizeOverrides와 정합 — 드리프트 시 컴파일 에러) */
export const SIZE_KEYS = [
  "dae", "cham", "chapter", "coverTitle", "coverSub",
  "tocLabel", "tocRoman", "tocItem", "table", "bodyTitle",
] as const
/** 단계별 위계 타이포 키 (GongmunOptions.levels[depth]) */
export const LEVEL_STYLE_KEYS = ["font", "pt", "bold"] as const
/** 기안문 두문 키 (별지 제1호서식) */
export const DOC_HEAD_KEYS = ["org", "to", "via", "title"] as const
/** 기안문 결문 키 */
export const DOC_FOOT_KEYS = [
  "sender", "drafter", "reviewer", "approver", "cooperator", "docNum", "receive",
  "address", "site", "phone", "fax", "email", "disclosure",
] as const
/** 공고문 두문·결문 키 */
export const NOTICE_HEAD_KEYS = ["no", "date", "sender"] as const
/** 보도자료 담당 표 키 */
export const PRESS_CONTACT_KEYS = ["dept", "manager", "phone"] as const

/** 수치 범위 — MCP zod와 문서화가 공유 (라이브러리 검증은 gongmun.ts 방어선) */
export const BODY_PT_RANGE = { min: 6, max: 40 } as const
export const LINE_SPACING_RANGE = { min: 50, max: 300 } as const
export const SIZE_PT_RANGE = { min: 6, max: 60 } as const
export const APPROVAL_MAX = 6

// SIZE_KEYS ⊆ GaejosikSizeOverrides 컴파일 타임 잠금 — gaejosik.ts에 키가 늘면
// 여기(와 이를 파생하는 MCP zod·CLI 안내문)도 갱신을 강제한다
type SizeKey = (typeof SIZE_KEYS)[number]
type _SizeKeysMatch = SizeKey extends keyof NonNullable<GongmunOptions["sizes"]>
  ? (keyof NonNullable<GongmunOptions["sizes"]> extends SizeKey ? true : never)
  : never
const _sizeKeysLock: _SizeKeysMatch = true
void _sizeKeysLock

// ─── 조립 (두 표면 공통 의미론) ──────────────────────────

/**
 * 표면 중립 입력 — CLI는 플래그·kv 파싱 결과를, MCP는 zod 통과 파라미터를 이 모양으로
 * 넘긴다. 모든 필드가 "명시된 것만 정의"(미지정 undefined) 규약 — --no-x 기본값 같은
 * 표면 고유 사정은 어댑터가 undefined로 정돈해서 넘겨야 한다.
 */
export interface GongmunSurfaceInput {
  preset: GongmunPreset
  font?: (typeof BODY_FONTS)[number]
  bodyPt?: number
  lineSpacing?: number
  org?: string
  date?: string
  cover?: boolean
  toc?: boolean
  approval?: string[]
  pageNumbers?: boolean
  endMark?: boolean
  bodyTitleBox?: boolean
  h2Marker?: (typeof H2_MARKERS)[number]
  fonts?: NonNullable<GongmunOptions["fonts"]>
  sizes?: NonNullable<GongmunOptions["sizes"]>
  levels?: NonNullable<GongmunOptions["levels"]>
  bullet2?: (typeof BULLET2_CHARS)[number]
  suppressSingle?: boolean
  docHead?: NonNullable<GongmunOptions["docHead"]>
  docFoot?: NonNullable<GongmunOptions["docFoot"]>
  reportInfo?: string
  noticeHead?: NonNullable<GongmunOptions["noticeHead"]>
  press?: NonNullable<GongmunOptions["press"]>
}

/**
 * 중립 입력 → GongmunOptions. 종전 CLI(cli.ts:535~612)·MCP(mcp.ts:792~814) 복붙
 * 두 벌의 의미론을 그대로 보존한 단일 조립:
 * - cover: false(끄기)가 최우선 → org/date 지정 시 객체(=켜짐) → true(강제 켜기)
 *   → 미지정이면 프리셋 기본(resolveGongmun)
 * - 나머지는 "명시된 것만 대입" — 프리셋 기본값을 undefined로 덮지 않는다
 */
export function buildGongmunOptions(input: GongmunSurfaceInput): GongmunOptions {
  const g: GongmunOptions = { preset: input.preset }
  if (input.font) g.bodyFont = input.font
  // NaN도 대입 — CLI의 비숫자 플래그(--pt abc)가 라이브러리 방어선(assertFiniteRange)
  // 에서 명시적 에러로 죽는 기존 경로 보존 (truthiness로 거르면 무증상 폐기가 된다)
  if (input.bodyPt !== undefined) g.bodyPt = input.bodyPt
  if (input.lineSpacing !== undefined) g.lineSpacing = input.lineSpacing
  if (input.cover === false) {
    g.cover = false
  } else if (input.org || input.date) {
    g.cover = { ...(input.org ? { org: input.org } : {}), ...(input.date ? { date: input.date } : {}) }
  } else if (input.cover === true) {
    g.cover = true
  }
  if (input.toc !== undefined) g.toc = input.toc
  if (input.approval && input.approval.length > 0) g.approval = input.approval
  if (input.pageNumbers !== undefined) g.pageNumbers = input.pageNumbers
  if (input.endMark !== undefined) g.endMark = input.endMark
  if (input.bodyTitleBox !== undefined) g.bodyTitleBox = input.bodyTitleBox
  if (input.h2Marker) g.h2Marker = input.h2Marker
  if (input.fonts) g.fonts = input.fonts
  if (input.sizes) g.sizes = input.sizes
  if (input.levels && Object.keys(input.levels).length > 0) g.levels = input.levels
  if (input.bullet2) g.bullet2 = input.bullet2
  if (input.suppressSingle !== undefined) g.suppressSingle = input.suppressSingle
  if (input.docHead) g.docHead = input.docHead
  if (input.docFoot) g.docFoot = input.docFoot
  if (input.reportInfo) g.reportInfo = input.reportInfo
  if (input.noticeHead) g.noticeHead = input.noticeHead
  if (input.press) g.press = input.press
  return g
}

/**
 * `--levels` 문법 파싱 — `0=HY견고딕/17/bold,1=한컴돋움/15/bold,2=휴먼명조/14`.
 * 항목은 쉼표, depth 뒤 `=`, 속성은 `/` 구분: 숫자=pt, bold·b=굵게, plain=굵게 해제, 그 외=글꼴명.
 * 값 범위·depth 검증은 라이브러리 방어선(validateGongmunOptions)이 맡는다.
 */
export function parseLevelsSpec(spec: string): NonNullable<GongmunOptions["levels"]> {
  const out: NonNullable<GongmunOptions["levels"]> = {}
  for (const item of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = item.indexOf("=")
    if (eq <= 0) throw new Error(`--levels: '${item}' — 'depth=글꼴/pt/bold' 꼴이어야 함`)
    const depth = item.slice(0, eq).trim()
    const st: NonNullable<GongmunOptions["levels"]>[string] = {}
    for (const part of item.slice(eq + 1).split("/").map((s) => s.trim()).filter(Boolean)) {
      if (/^\d+(\.\d+)?$/.test(part)) st.pt = Number(part)
      else if (/^(bold|b)$/i.test(part)) st.bold = true
      else if (/^plain$/i.test(part)) st.bold = false
      else st.font = part
    }
    out[depth] = st
  }
  return out
}

/** levels 의 글꼴명을 unknownFontWarnings 입력(역할 → 글꼴명)으로 — 역할 이름은 `levels.<depth>` */
export function levelFontRecord(levels: NonNullable<GongmunOptions["levels"]>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(levels).map(([d, st]) => [`levels.${d}`, st.font]))
}
