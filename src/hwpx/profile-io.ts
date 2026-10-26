/**
 * FormatProfile JSON 경계 검증 — CLI(--profile)와 MCP(profile_path)가 공유하는 1벌
 * 스키마 (이슈 #41 표면 노출, v4.0.6). 라이브러리 API(markdownToHwpx options.profile)는
 * 타입 계약을 신뢰하고, 파일에서 들어오는 JSON(손편집 가능)만 여기서 검증한다.
 */

import { z } from "zod"
import { KordocError } from "../utils.js"
import type { FormatProfile } from "./gen-profile.js"

// 괘선 값 검증 (v4.0.4) — type/width/color는 XML에 원문 방출되므로 손편집 오타가
// 한컴 로드 실패·무시로 번지기 전에 여기서 잡는다.
// type: HWPX LineType2 열거(KS X 6101). 실측 코퍼스 등장: NONE·SOLID·DASH·DOUBLE_SLIM·SLIM_THICK
const borderType = z.enum([
  "NONE", "SOLID", "DASH", "DOT", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE",
  "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLEWAVE",
])
const mmWidth = z.string().regex(/^\d+(\.\d+)? ?mm$/, '"0.12 mm" 형식(mm 단위)이어야 합니다')
const hexColor = z.string().regex(/^(#[0-9A-Fa-f]{6}|none)$/i, '"#RRGGBB" 또는 "none"이어야 합니다')

const borderDef = z.object({
  type: borderType,
  width: mmWidth,
  color: hexColor,
})

const borderFillDef = z.object({
  leftBorder: borderDef.optional(),
  rightBorder: borderDef.optional(),
  topBorder: borderDef.optional(),
  bottomBorder: borderDef.optional(),
  fill: z.object({ faceColor: hexColor }).optional(),
})

const charPrDef = z.object({
  height_hwpunit: z.string().optional(),
  textColor: hexColor.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  fontRef_hangul: z.string().optional(),
  fontName_hangul: z.string().optional(),
})

const cellProfile = z.object({
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  rowSpan: z.number().int().min(1).optional(),
  colSpan: z.number().int().min(1).optional(),
  width_hwpunit: z.string().optional(),
  height_hwpunit: z.string().optional(),
  borderFillIDRef: z.string().optional(),
  charPrIDRef: z.string().optional(),
})

const tableProfile = z.object({
  table_index: z.number().int().min(0),
  rows: z.number().int().min(1),
  cols: z.number().int().min(1),
  anchor_text: z.string().optional(),
  anchor_row: z.string().optional(),
  width_hwpunit: z.string().optional(),
  col_widths_hwpunit: z.array(z.string()).optional(),
  cells: z.array(cellProfile),
  used_border_fills: z.record(z.string(), borderFillDef),
  used_char_prs: z.record(z.string(), charPrDef).optional(),
})

export const formatProfileSchema = z.object({
  schema_version: z.string().optional(),
  tables: z.array(tableProfile),
})

/** 프로필 JSON 텍스트 → 검증된 FormatProfile. 실패 시 KordocError(위치·사유 요약) */
export function parseFormatProfileJson(text: string): FormatProfile {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, "")) // Windows 메모장·PowerShell 저장본의 UTF-8 BOM
  } catch (e) {
    throw new KordocError(`프로필 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
  const r = formatProfileSchema.safeParse(raw)
  if (!r.success) {
    const first = r.error.issues.slice(0, 3).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join(" / ")
    throw new KordocError(`프로필 스키마 불일치: ${first}`)
  }
  return r.data as FormatProfile
}
