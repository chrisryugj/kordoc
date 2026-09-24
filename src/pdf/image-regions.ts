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

/**
 * pdfjs operatorList에서 이미지 paint 영역을 추출.
 * save/restore/transform으로 CTM을 추적하고, 이미지는 단위 정사각형(0,0)-(1,1)에
 * CTM을 적용한 bbox로 계산한다 (PDF 이미지 렌더링 규약).
 */
export function extractImageRegions(
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
): ImageRegion[] {
  const regions: ImageRegion[] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    switch (op) {
      case OPS.save:
        stack.push(ctm)
        break
      case OPS.restore:
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
        break
      case OPS.transform: {
        const t = argsArray[i] as number[]
        if (Array.isArray(t) && t.length >= 6) ctm = multiplyTransform(ctm, t)
        break
      }
      // Form XObject 는 /Matrix 공간에서 그린다 — pdfjs 인자 [matrix, bbox], End 에서 복원 (line-extract.ts 와 같음)
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm)
        const m = (argsArray[i] as unknown[])?.[0]
        if (Array.isArray(m) && m.length >= 6) ctm = multiplyTransform(ctm, m as number[])
        break
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
        break
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat: {
        // 단위 정사각형 4꼭짓점에 CTM 적용
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]]
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
        for (const [u, v] of corners) {
          const x = ctm[0] * u + ctm[2] * v + ctm[4]
          const y = ctm[1] * u + ctm[3] * v + ctm[5]
          if (x < x1) x1 = x
          if (x > x2) x2 = x
          if (y < y1) y1 = y
          if (y > y2) y2 = y
        }
        if (x2 - x1 > 0 && y2 - y1 > 0) regions.push({ x1, y1, x2, y2 })
        break
      }
    }
  }
  return regions
}
