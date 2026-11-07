/**
 * 페이지 내 이미지 XObject 영역 추출 (정보손실 가시화용) — line-detector.ts에서 분리.
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

export interface ImageRegion {
  x1: number; y1: number; x2: number; y2: number
}

/** 2D 어파인 행렬 곱 — t 적용 후 m 적용 (pdfjs Util.transform과 동일 순서) */
function multiplyTransform(m: number[], t: number[]): number[] {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ]
}

function transformedRect(ctm: number[], x: number, y: number, w: number, h: number): ImageRegion {
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
  const xs = corners.map(([u, v]) => ctm[0] * u + ctm[2] * v + ctm[4])
  const ys = corners.map(([u, v]) => ctm[1] * u + ctm[3] * v + ctm[5])
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
}

function intersect(a: ImageRegion, b: ImageRegion | null): ImageRegion {
  return b ? { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) } : a
}

/**
 * pdfjs operatorList에서 이미지 paint 영역을 추출.
 * save/restore/transform으로 CTM을 추적하고, 이미지는 단위 정사각형(0,0)-(1,1)에
 * CTM을 적용한 bbox로 계산한다 (PDF 이미지 렌더링 규약).
 * respectClip은 읽기 순서용 가시 영역. OCR·그림 칸 판정은 기존 원본 영역을 유지한다.
 * byOp 를 주면 그림 op 인덱스 → 영역도 채운다(그림 블록 자리, imagePlacement).
 */
export function extractImageRegions(
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
  respectClip = false,
  byOp?: Map<number, ImageRegion>,
): ImageRegion[] {
  const regions: ImageRegion[] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  let clip: ImageRegion | null = null
  const stack: Array<{ ctm: number[]; clip: ImageRegion | null }> = []
  // 단일 사각형만 확정한다. 복합·곡선 경로는 보수적으로 기존 영역을 유지한다.
  let pathRect: ImageRegion | null | undefined
  let pendingClip = false

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    switch (op) {
      case OPS.save:
        stack.push({ ctm, clip })
        break
      case OPS.restore: {
        const state = stack.pop()
        ctm = state?.ctm ?? [1, 0, 0, 1, 0, 0]
        clip = state?.clip ?? null
        break
      }
      case OPS.transform: {
        const t = argsArray[i] as number[]
        if (Array.isArray(t) && t.length >= 6) ctm = multiplyTransform(ctm, t)
        break
      }
      // Form XObject 는 /Matrix 공간에서 그린다 — pdfjs 인자 [matrix, bbox], End 에서 복원 (line-extract.ts 와 같음)
      case OPS.paintFormXObjectBegin: {
        stack.push({ ctm, clip })
        const m = (argsArray[i] as unknown[])?.[0]
        if (Array.isArray(m) && m.length >= 6) ctm = multiplyTransform(ctm, m as number[])
        break
      }
      case OPS.paintFormXObjectEnd: {
        const state = stack.pop()
        ctm = state?.ctm ?? [1, 0, 0, 1, 0, 0]
        clip = state?.clip ?? null
        break
      }
      case OPS.constructPath: {
        const [ops, coords] = argsArray[i] as number[][]
        pathRect = pathRect === undefined && ops?.length === 1 && ops[0] === OPS.rectangle && coords?.length >= 4
          ? transformedRect(ctm, coords[0], coords[1], coords[2], coords[3]) : null
        break
      }
      case OPS.clip: case OPS.eoClip:
        pendingClip = true
        break
      case OPS.endPath: case OPS.stroke: case OPS.closeStroke: case OPS.fill: case OPS.eoFill:
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
        if (respectClip && pendingClip && pathRect) clip = intersect(pathRect, clip)
        pathRect = undefined
        pendingClip = false
        break
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat: {
        const { x1, y1, x2, y2 } = intersect(transformedRect(ctm, 0, 0, 1, 1), clip)
        if (x2 - x1 > 0 && y2 - y1 > 0) { regions.push({ x1, y1, x2, y2 }); byOp?.set(i, { x1, y1, x2, y2 }) }
        break
      }
    }
  }
  return regions
}
