/**
 * PDF 에서 잰 모양(measurePdfLayout)을 공문서 생성 옵션으로: 사용자가 직접 준 값은 그대로 두고 빈 자리만 채운다.
 *
 * 채우는 것: 단계별 글꼴·크기(levels, 굵기는 프리셋 값. PDF 에서 굵기를 알 수 없다), 2단계 부호(bullet2), ※ 글꼴(fonts.ref),
 * 줄간격(lineSpacing), 여백(margins: 잰 가장자리에서 프리셋 머리말·꼬리말 높이를 뺀 값), 띠 제목 번호칸 색(bandColor, 띠 표 장 머리 프리셋만).
 */

import type { PdfLayoutSpec } from "../pdf/layout-measure.js"
import { resolveGongmun, type GongmunOptions } from "./gongmun.js"
import { pickScheme } from "./gongmun-scheme.js"
import { usesV5Engine } from "./gen-gongmun.js"
import { GAEJOSIK_COLORS } from "./gaejosik.js"

const HU_PER_MM = 283.465

export interface MeasuredLayoutResult {
  gongmun: GongmunOptions
  /** 적용한 항목(사람이 읽는 한 줄씩) */
  applied: string[]
  warnings: string[]
}

export function applyMeasuredLayout(base: GongmunOptions, spec: PdfLayoutSpec): MeasuredLayoutResult {
  const g: GongmunOptions = { ...base }
  const applied: string[] = []
  const warnings = [...spec.warnings]
  const resolved = resolveGongmun(base)
  const scheme = usesV5Engine(resolved.preset) ? pickScheme(resolved, true, false) : null
  if (Math.abs(spec.page.widthMm - 210) > 3 || Math.abs(spec.page.heightMm - 297) > 3) {
    warnings.push(`PDF 쪽 크기 ${spec.page.widthMm}×${spec.page.heightMm}mm 는 A4 세로가 아닙니다. 용지는 paper 옵션으로 정하세요`)
  }
  // 단계: 직접 준 단계는 그대로
  const levels: NonNullable<GongmunOptions["levels"]> = { ...(base.levels ?? {}) }
  for (const lv of spec.levels) {
    if (levels[lv.depth] !== undefined) continue
    levels[lv.depth] = { ...(lv.font ? { font: lv.font } : {}), pt: lv.pt, bold: scheme?.levels[lv.depth]?.bold ?? false }
    applied.push(`${lv.depth}단계 ${lv.marker} ${lv.font ?? "(프리셋 글꼴)"} ${lv.pt}pt`)
  }
  if (Object.keys(levels).length) g.levels = levels
  const second = spec.levels.find((l) => l.depth === 1)?.marker
  if (!base.bullet2 && (second === "ㅇ" || second === "○")) { g.bullet2 = second; applied.push(`2단계 부호 ${second}`) }
  if (spec.ref?.font && !base.fonts?.ref) { g.fonts = { ...(base.fonts ?? {}), ref: spec.ref.font }; applied.push(`※ ${spec.ref.font}`) }
  if (spec.lineSpacing && base.lineSpacing === undefined) { g.lineSpacing = spec.lineSpacing; applied.push(`줄간격 ${spec.lineSpacing}%`) }
  if (spec.edges && !base.margins) {
    const hf = resolved.headerFooter / HU_PER_MM
    const clamp = (v: number) => Math.min(60, Math.max(5, Math.round(v * 2) / 2))
    g.margins = { top: clamp(spec.edges.top - hf), bottom: clamp(spec.edges.bottom - hf), left: clamp(spec.edges.left), right: clamp(spec.edges.right) }
    applied.push(`여백 위 ${g.margins.top}·아래 ${g.margins.bottom}·왼쪽 ${g.margins.left}·오른쪽 ${g.margins.right}mm(머리말·꼬리말 ${Math.round(hf)}mm 별도)`)
  }
  if (spec.chapterFill && !base.bandColor) {
    if (resolved.h2Marker === "band") { g.bandColor = spec.chapterFill; applied.push(`장 번호칸 ${spec.chapterFill}`) }
    else if (!(resolved.preset === "gaejosik" && spec.chapterFill === GAEJOSIK_COLORS.primary)) warnings.push(`장 번호칸 색 ${spec.chapterFill} 은 띠 표 장 머리(h2Marker band, 보고서·계획서)에만 씁니다`)
  }
  if (!applied.length) warnings.push("PDF 에서 적용할 모양을 찾지 못했습니다. 프리셋 서식 그대로 만듭니다")
  return { gongmun: g, applied, warnings }
}
