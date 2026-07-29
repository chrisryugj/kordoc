/**
 * 내장 표준 서식 템플릿 — 정부 표준 기안문 (rhwp tools/forms 자산, MIT)
 *
 * templates/ 디렉토리의 누름틀(CLICK_HERE) 내장 HWPX 서식을 이름으로 제공한다.
 * 서식 원본은 「행정 효율과 협업 촉진에 관한 규정 시행규칙」 별지 제1·2호서식
 * (어트리뷰션: THIRD_PARTY/rhwp-forms.txt).
 */

import { existsSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { KordocError } from "../utils.js"

/** 내장 템플릿 메타데이터 */
export interface BuiltinTemplate {
  /** 영문 식별자 — CLI/MCP에서 쓰는 정식 이름 */
  id: string
  /** 한글 별칭 (`templates:일반기안문` 표기 포함 매칭) */
  aliases: string[]
  /** templates/ 안의 서식 파일명 */
  file: string
  /** templates/ 안의 예시값 JSON 파일명 */
  sampleFile: string
  /** 한 줄 소개 */
  title: string
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: "gian",
    aliases: ["일반기안문", "기안문", "일반기안문_서식"],
    file: "일반기안문_서식.hwpx",
    sampleFile: "일반기안문_예시값.json",
    title: "일반기안문 — 별지 제1호서식 (대외 시행문·협조문, 누름틀 23곳)",
  },
  {
    id: "gian-simple",
    aliases: ["간이기안문", "간이기안문_서식"],
    file: "간이기안문_서식.hwpx",
    sampleFile: "간이기안문_예시값.json",
    title: "간이기안문 — 별지 제2호서식 (내부결재 보고서·계획서, 결재란 표, 누름틀 13곳)",
  },
]

/**
 * 이름/별칭으로 내장 템플릿 해석 — `templates:` 접두사 허용.
 * 예: "gian", "gian-simple", "일반기안문", "templates:간이기안문"
 */
export function resolveBuiltinTemplate(name: string): BuiltinTemplate | undefined {
  const n = name.trim().replace(/^templates?:/i, "").trim()
  if (!n) return undefined
  const low = n.toLowerCase()
  return BUILTIN_TEMPLATES.find(t => t.id === low || t.aliases.includes(n))
}

/**
 * templates/ 디렉토리 위치 — 소스 실행(src/form/ → ../../templates)과
 * 번들 실행(dist/ → ../templates)을 모두 지원한다.
 */
export function builtinTemplateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "..", "templates"), // src/form/templates.ts → 패키지 루트
    join(here, "..", "templates"),       // dist/*.js (tsup 번들) → 패키지 루트
  ]
  for (const c of candidates) {
    if (existsSync(join(c, BUILTIN_TEMPLATES[0].file))) return c
  }
  throw new KordocError("내장 templates 디렉토리를 찾을 수 없습니다 (패키지 설치가 손상되었을 수 있습니다)")
}

/** 내장 템플릿 HWPX 버퍼 읽기 */
export function readBuiltinTemplate(t: BuiltinTemplate): ArrayBuffer {
  const buf = readFileSync(join(builtinTemplateDir(), t.file))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** 내장 템플릿 예시값 JSON 읽기 */
export function readBuiltinTemplateSample(t: BuiltinTemplate): Record<string, string> {
  return JSON.parse(readFileSync(join(builtinTemplateDir(), t.sampleFile), "utf-8"))
}
