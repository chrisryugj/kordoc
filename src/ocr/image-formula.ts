/**
 * 이미지 OCR 의 수식 — `formulaOcr` 를 켜면 래스터에서 수식 영역을 검출·인식해(PDF 경로와 같은 모델) 그 자리의 OCR 글상자를
 * `$LaTeX$` 상자로 바꾼다. 수식은 글 인식기가 읽으면 "y =$x{+3"·"1og,b= 3" 같은 조각이 된다(수능 수학 쪽).
 * 수식 영역이 상자 넓이 절반 넘게 덮으면 상자를 빼고, 일부만 덮으면(글줄 안 인라인 수식) 덮인 x 구간을 글자 비율로 잘라 낸다
 */

import type { OcrItem } from "./engine.js"
import type { ParseWarning } from "../types.js"

export async function applyImageFormulas(items: OcrItem[], rgba: Uint8Array, width: number, height: number, warnings: ParseWarning[]): Promise<OcrItem[]> {
  let regions: FormulaBox[]
  try {
    const { FormulaPipeline, ensureFormulaModels } = await import("../pdf/formula/index.js")
    await ensureFormulaModels()
    const pipeline = await FormulaPipeline.create()
    try { regions = await pipeline.recognizeFrame({ width, height, data: rgba }) } finally { await pipeline.destroy() }
  } catch (e) {
    warnings.push({ page: 1, message: `수식 OCR 실패: ${e instanceof Error ? e.message : String(e)}`, code: "PARTIAL_PARSE" })
    return items
  }
  return replaceFormulaItems(items, regions)
}

type FormulaBox = { bbox: { x1: number; y1: number; x2: number; y2: number }; latex?: string; kind: string }

/** 수식 영역으로 글상자 바꾸기 (모델 결과 → 상자, 테스트용 export) */
export function replaceFormulaItems(items: OcrItem[], regions: FormulaBox[]): OcrItem[] {
  // 수식 구조(분수·첨자·근호·적분·등호·부등호)가 있고 장식 상자·잡음 기호가 없으며, 덮은 OCR 글이 한글 위주가 아닌 영역만 —
  // 문항 번호 상자(\fbox{17})·그림 속 글·영어 본문을 수식으로 바꿔 국어·영어·한국사 쪽 글이 깨졌다
  // 덮인 글 — 상자마다 영역이 덮는 x 구간의 글자만(글자 수 비율)
  const covered = (r: FormulaBox) => items.filter(it =>
    Math.min(it.x + it.w, r.bbox.x2) - Math.max(it.x, r.bbox.x1) > 0 && Math.min(it.y + it.h, r.bbox.y2) - Math.max(it.y, r.bbox.y1) >= it.h * 0.5)
    .map(it => { const cs = [...it.text], n = cs.length, at = (x: number) => Math.max(0, Math.min(n, Math.round(((x - it.x) / it.w) * n))); return cs.slice(at(r.bbox.x1), at(r.bbox.x2)).join("") }).join("")
  const hangulShare = (t: string) => { const l = t.match(/[\p{L}\p{N}]/gu) ?? []; return l.length ? l.filter(c => /[가-힣]/.test(c)).length / l.length : 0 }
  const formulas = regions.filter(r => {
    const latex = r.latex?.trim() ?? ""
    return latex && /\\frac|\^|_\{|_[a-z0-9]|\\sqrt|\\int|\\sum|\\lim|\\log|=|\\leq|\\geq|<|>/.test(latex) &&
      !/\\fbox|\\Xi|\\exists|\\models|\\mathcal|\\mathrm\{[a-z~]{3,}/.test(latex) && hangulShare(covered(r)) < 0.3
  })
  if (!formulas.length) return items
  const out: OcrItem[] = []
  for (const it of items) {
    let pieces: OcrItem[] = [it]
    for (const f of formulas) {
      const next: OcrItem[] = []
      for (const p of pieces) {
        const ox = Math.min(p.x + p.w, f.bbox.x2) - Math.max(p.x, f.bbox.x1)
        const oy = Math.min(p.y + p.h, f.bbox.y2) - Math.max(p.y, f.bbox.y1)
        if (ox <= 0 || oy < p.h * 0.5) { next.push(p); continue }
        if (ox >= p.w * 0.5) continue
        // 글줄 안 인라인 수식 — 덮인 x 구간 밖 글만 남긴다(글자 수 비율로 자른다)
        const chars = [...p.text], n = chars.length
        const cut = (x: number) => Math.max(0, Math.min(n, Math.round(((x - p.x) / p.w) * n)))
        const a = cut(f.bbox.x1), b = cut(f.bbox.x2)
        const left = chars.slice(0, a).join("").trimEnd(), right = chars.slice(b).join("").trimStart()
        if (left) next.push({ ...p, text: left, w: Math.max(1, f.bbox.x1 - p.x) })
        if (right) next.push({ ...p, text: right, x: f.bbox.x2, w: Math.max(1, p.x + p.w - f.bbox.x2) })
      }
      pieces = next
    }
    out.push(...pieces)
  }
  for (const f of formulas) {
    const text = f.kind === "display" ? `$$${f.latex!.trim()}$$` : `$${f.latex!.trim()}$`
    out.push({ text, x: f.bbox.x1, y: f.bbox.y1, w: f.bbox.x2 - f.bbox.x1, h: f.bbox.y2 - f.bbox.y1, confidence: 1 })
  }
  return out
}
