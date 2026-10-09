import type { IRBlock } from "../types.js"
import { FRAME_READING_UNITS, recordFrameReadingUnit } from "./frame-cell-blocks.js"

export interface ImageRegion { x1: number; y1: number; x2: number; y2: number }

/** 세로 괘선이 없는 그림 영역(원그래프 범례·차트 눈금)에서 OCR 글 정렬만으로 묶은 표 — 표로 받지 않고 행 문단으로 (pdf-ocr 가 적는다) */
export const UNRULED_REGION_TABLES = new WeakSet<IRBlock>()

/** Add OCR evidence only inside image regions with no PDF text layer. */
export function mergeOcrImageRegions(
  blocks: IRBlock[], page: number, regions: ImageRegion[], ocrBlocks: IRBlock[],
): number {
  let added = 0
  for (const region of regions) {
    const candidates = ocrBlocks.filter(block => {
      const b = block.bbox
      if (!b || b.page !== page || (block.type !== "table" && block.type !== "paragraph")) return false
      const overlapW = Math.max(0, Math.min(b.x + b.width, region.x2) - Math.max(b.x, region.x1))
      const overlapH = Math.max(0, Math.min(b.y + b.height, region.y2) - Math.max(b.y, region.y1))
      return overlapW * overlapH >= b.width * b.height * 0.8
    })
    const labels = candidates.filter(b => b.type === "paragraph" && b.bbox!.height <= 24 &&
      (b.text?.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2)
    const axisFragments = rotatedAxisFragments(candidates)
    const accepted = candidates.filter(b => {
      // 그림 속 글(차트 축·범례·로고 글) — 텍스트층이 없는 그림 영역의 OCR 문단
      if (b.type === "paragraph") return (b.text?.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2 ||
        (!axisFragments.has(b) && (supportedDiagramLabel(b, labels, region) || axisTick(b, candidates)))
      const t = b.table
      // 원그래프 범례가 머리 있는 표로 받아들여졌다(ODL 124·140) — 그림 속 진짜 표(110 점도 표·122 실험 표)는 영역 안 세로 괘선 5·8개, 범례는 0개
      if (b.type !== "table" || !t || UNRULED_REGION_TABLES.has(b)) return false
      if (t.rows === 1 && t.cols === 1) {
        const text = t.cells[0]?.[0]?.text ?? ""
        return (text.match(/\n/g)?.length ?? 0) >= 5 && (text.match(/\d/g)?.length ?? 0) >= text.length * 0.25
      }
      const headerLabels = t.cells[0]?.filter(c => c.text.replace(/[^A-Za-z가-힣]/g, "").length >= 2).length ?? 0
      return t.rows >= 2 && t.cols >= 2 && headerLabels >= t.cols * 0.75 &&
        t.cells.slice(1).some(row => row.filter(c => c.text.trim()).length >= 2)
    })
    // 표 모양이 아닌 OCR 표(머리 행 없는 화면 캡처 글줄 — ODL 072 유튜브 채널)는 버리지 않고 행마다 문단으로 — 그림 속 문단과 같은 대우
    const selected = candidates.flatMap(b => accepted.includes(b) ? [b] : b.type === "table" && b.table ? rowParagraphs(b)
      .filter(p => /[\p{L}\p{N}]{2}/u.test(p.text ?? "")) : [])
    // 원문 겹침은 이 영역을 넣기 전 블록(텍스트층 + 앞 영역)과만 잰다 — 같은 영역에서 방금 넣은 이웃 OCR 줄과 상자가 겹친다고
    // 다음 줄을 버리면 글이 사라졌다(ODL 102 "342 334"). 겹치는 두 그림 영역이 같은 글을 두 번 넣는 것은 그대로 막는다
    const before = blocks.slice()
    const hasOriginal = (block: IRBlock) => before.some(existing => {
      const b = block.bbox!
      if (existing.pageNumber !== page || !existing.bbox || existing.type === "image") return false
      const e = existing.bbox
      const x = Math.max(0, Math.min(e.x + e.width, b.x + b.width) - Math.max(e.x, b.x))
      const y = Math.max(0, Math.min(e.y + e.height, b.y + b.height) - Math.max(e.y, b.y))
      return x * y > b.width * b.height * 0.2
    })
    const selectedSet = new Set(selected), seen = new Set<IRBlock>(), placedHere = new Set<IRBlock>()
    for (const block of selected) {
      if (seen.has(block)) continue
      const frame = FRAME_READING_UNITS.get(block)
      const source = frame?.blocks.every(member => selectedSet.has(member)) ? frame.blocks : [block]
      source.forEach(member => seen.add(member))
      const available = source.filter(member => !hasOriginal(member))
      // A partial accepted or native-covered frame cannot reintroduce omitted text.
      const units = frame && available.length === source.length && source === frame.blocks
        ? [{ blocks: available, bbox: frame.bbox, atomic: true }]
        : available.map(member => ({ blocks: [member], bbox: member.bbox!, atomic: false }))
      for (const unit of units) {
        const b = unit.bbox
        // Source frame bounds keep later axis labels outside the whole legend,
        // including when the frame's paragraphs were already placed by this pass.
        const index = blocks.findIndex(existing => {
          const e = FRAME_READING_UNITS.get(existing)?.bbox ?? existing.bbox
          if (existing.pageNumber !== page || !e) return false
          const beside = e.y < region.y2 && e.y + e.height > region.y1 && e.x >= region.x2 - 1
          // 이 영역에서 방금 넣은 같은 줄 조각(세로 중심이 낮은 쪽 높이의 0.25 안)과는 왼→오 — 아래 끝만 보면 XY-Cut 이 가른 눈금 행 조각이
          // 처리 순서대로 이어져 "5 6 7 8 9 / 0 / 1 …" 이 됐다(ODL 128, 어긋남 0). 범례 라벨과 먼 축 눈금(0.33~0.42, 057)은 위→아래 그대로
          if (placedHere.has(existing) && Math.abs(e.y + e.height / 2 - b.y - b.height / 2) <= Math.min(e.height, b.height) * 0.25) return e.x > b.x
          return e.y < b.y || beside
        })
        // OCR image text is not typographic heading evidence.
        const placed = unit.blocks.map(member => member.type === "paragraph" ? { ...member, style: undefined } : member)
        if (unit.atomic) recordFrameReadingUnit(placed, unit.bbox)
        blocks.splice(index < 0 ? blocks.length : index, 0, ...placed)
        for (const member of placed) placedHere.add(member)
        added += placed.length
      }
    }
  }
  return added
}

/** 숫자 한 글자 라벨이 차트 눈금인지 — 같은 행(가로 축: 세로 중심이 작은 쪽 높이의 0.35 안)이나 오른끝을 맞춘 열(세로 축)에 숫자 라벨이
 *  둘 이상 더 있으면 눈금이다. 한 글자라 잡음으로 버리면 1~6·0~8 처럼 한 자리 눈금이 통째로 빠졌다(ODL 027). 눈금 열 옆 회전 축 이름 조각은
 *  숫자가 아니거나(a·t·S) 숫자 열과 오른끝이 어긋나 받지 않는다 */
function axisTick(block: IRBlock, candidates: IRBlock[]): boolean {
  const b = block.bbox!
  if (!/^\d$/u.test(block.text?.trim() ?? "")) return false
  const numeric = candidates.filter(o => o !== block && o.type === "paragraph" && o.bbox && /^[\d\s.,%+−-]+$/u.test(o.text?.trim() ?? "") &&
    /\d/u.test(o.text ?? "") && Math.max(o.bbox.height, b.height) <= Math.min(o.bbox.height, b.height) * 2)
  const cy = b.y + b.height / 2, right = b.x + b.width
  const row = numeric.filter(o => Math.abs(o.bbox!.y + o.bbox!.height / 2 - cy) <= Math.min(o.bbox!.height, b.height) * 0.35)
  const column = numeric.filter(o => Math.abs(o.bbox!.x + o.bbox!.width - right) <= Math.max(o.bbox!.height, b.height) * 0.5)
  return row.length >= 2 || column.length >= 2
}

/** A small one-character node label can be meaningful inside a numeric diagram.
 * Require several stronger labels, a word, two numeric rows and nearby aligned
 * labels both above and below; isolated OCR specks still have no such context. */
function supportedDiagramLabel(block: IRBlock, labels: IRBlock[], region: ImageRegion): boolean {
  const b = block.bbox, text = block.text?.trim() ?? ""
  if (!b || !/^[\p{L}\p{N}]$/u.test(text) || b.height < 4 || b.width < 1 || b.width > b.height * 2 ||
      b.x < region.x1 || b.y < region.y1 || b.x + b.width > region.x2 || b.y + b.height > region.y2 ||
      b.width * b.height > (region.x2 - region.x1) * (region.y2 - region.y1) * 0.005 ||
      labels.length < 3 || !labels.some(l => /\p{L}{3}/u.test(l.text ?? "")) ||
      labels.filter(l => !/\p{L}/u.test(l.text ?? "") && (l.text?.match(/\p{N}/gu)?.length ?? 0) >= 2).length < 2) return false
  let above = false, below = false
  for (const label of labels) {
    const a = label.bbox!, em = Math.max(b.height, a.height)
    if (b.x + b.width < a.x - em * 2 || b.x > a.x + a.width + em * 2) continue
    const upperGap = a.y - (b.y + b.height), lowerGap = b.y - (a.y + a.height)
    if (upperGap >= 0 && upperGap <= em * 4) above = true
    if (lowerGap >= 0 && lowerGap <= em * 4) below = true
  }
  return above && below
}

/** Rotated axis words can become a tight vertical stack of OCR fragments.
 * Require both a right-aligned numeric tick column and adjacent letter fragments
 * within six tick heights to its left; unrelated diagram nodes retain their context. */
function rotatedAxisFragments(candidates: IRBlock[]): Set<IRBlock> {
  const paragraphs = candidates.filter(b => b.type === "paragraph" && b.bbox!.height <= 24)
  const axes: IRBlock[][] = []
  for (const block of paragraphs) {
    const b = block.bbox!, text = block.text?.trim() ?? ""
    if (!/^[\d\s.,%+−-]+$/u.test(text) || !/\d/u.test(text) || b.width > b.height * 6) continue
    const axis = axes.find(a => Math.abs(a[0].bbox!.x + a[0].bbox!.width - b.x - b.width) <= Math.max(a[0].bbox!.height, b.height) * 0.5)
    if (axis) axis.push(block)
    else axes.push([block])
  }
  const fragments = new Set<IRBlock>()
  const aligned = (a: IRBlock, b: IRBlock) => {
    const x = a.bbox!, y = b.bbox!, tolerance = Math.max(x.height, y.height) * 0.5
    return Math.abs(x.x - y.x) <= tolerance || Math.abs(x.x + x.width - y.x - y.width) <= tolerance
  }
  for (const axis of axes) {
    if (axis.length < 3) continue
    const bottom = Math.min(...axis.map(a => a.bbox!.y)), top = Math.max(...axis.map(a => a.bbox!.y + a.bbox!.height))
    const em = Math.max(...axis.map(a => a.bbox!.height)), right = axis[0].bbox!.x + axis[0].bbox!.width
    if (top - bottom < em * 6) continue
    const left = paragraphs.filter(block => {
      const b = block.bbox!, text = block.text?.trim() ?? ""
      return /\p{Script=Latin}/u.test(text) && (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= 3 &&
        b.width <= b.height * 3 && b.x + b.width >= right - em * 6 &&
        b.x + b.width <= right - Math.max(em, b.height) && b.y >= bottom && b.y + b.height <= top
    })
    const stack = left.filter(a => left.some(b => {
      if (a === b || !aligned(a, b)) return false
      const x = a.bbox!, y = b.bbox!, gap = Math.max(x.y, y.y) - Math.min(x.y + x.height, y.y + y.height)
      return gap >= -Math.min(x.height, y.height) * 0.5 && gap <= Math.max(x.height, y.height)
    }))
    if (stack.length < 2) continue
    for (const block of paragraphs) {
      const b = block.bbox!
      if (b.y >= bottom && b.y + b.height <= top && b.x + b.width >= right - em * 6 && b.x + b.width <= right - Math.max(em, b.height) &&
          /^[\p{L}\p{N}]$/u.test(block.text?.trim() ?? "") && stack.some(s => aligned(s, block))) fragments.add(block)
    }
  }
  return fragments
}

/** OCR 표 → 행마다 문단(빈 칸 뺀 칸 글을 공백으로), 행 높이만큼 나눈 상자 */
function rowParagraphs(block: IRBlock): IRBlock[] {
  const t = block.table!, b = block.bbox!
  const h = b.height / t.rows
  return t.cells.map((row, r) => ({
    type: "paragraph" as const, pageNumber: block.pageNumber, text: row.map(c => c.text.trim()).filter(Boolean).join(" "),
    bbox: { ...b, y: b.y + h * (t.rows - 1 - r), height: h },
  }))
}
