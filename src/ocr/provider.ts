/**
 * OCR 프로바이더 브릿지 — PDF 페이지를 이미지로 렌더링하여 OCR 호출
 *
 * kordoc은 OCR 라이브러리를 번들하지 않음.
 * 사용자가 OcrProvider 함수를 제공하면 이미지 기반 PDF도 텍스트 추출 가능.
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 *
 * const result = await parse(buffer, {
 *   ocr: async (pageImage, pageNumber, mimeType) => {
 *     // Tesseract, Claude Vision, Google Vision 등 사용
 *     return await myOcrService.recognize(pageImage)
 *   }
 * })
 * ```
 */

import type { OcrProvider, IRBlock } from "../types.js"

/**
 * 이미지 기반 PDF 페이지에 OCR을 적용하여 IRBlock[] 반환.
 *
 * pdfjs page 객체에서 viewport + render를 통해 PNG 생성 후
 * 사용자 제공 OcrProvider 호출.
 *
 * canvas 미설치 시 pdfjs render 불가하므로 에러 반환.
 */
export async function ocrPages(
  doc: { numPages: number; getPage(n: number): Promise<PdfPageProxy> },
  provider: OcrProvider,
  pageFilter: Set<number> | null,
  effectivePageCount: number
): Promise<IRBlock[]> {
  const blocks: IRBlock[] = []

  for (let i = 1; i <= effectivePageCount; i++) {
    if (pageFilter && !pageFilter.has(i)) continue
    const page = await doc.getPage(i)
    try {
      const imageData = await renderPageToPng(page)
      const text = await provider(imageData, i, "image/png")
      if (text.trim()) {
        blocks.push({ type: "paragraph", text: text.trim(), pageNumber: i })
      }
    } catch {
      blocks.push({ type: "paragraph" as const, text: `[OCR 실패: 페이지 ${i}]` })
    }
  }

  return blocks
}

interface PdfPageProxy {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> }
}

/**
 * PDF 페이지를 PNG로 렌더링.
 * node-canvas가 설치되어 있어야 동작.
 * 미설치 시 에러 throw → 호출측에서 catch.
 */
async function renderPageToPng(page: PdfPageProxy): Promise<Uint8Array> {
  // node-canvas 동적 로드 (선택적 의존성)
  let createCanvas: (w: number, h: number) => { getContext(t: string): unknown; toBuffer(t: string): Buffer }
  try {
    const canvasModule = await import("canvas")
    createCanvas = canvasModule.createCanvas
  } catch {
    throw new Error("OCR을 사용하려면 'canvas' 패키지를 설치하세요: npm install canvas")
  }

  const scale = 2.0 // 300 DPI 근사
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height))
  const ctx = canvas.getContext("2d")

  await page.render({ canvasContext: ctx, viewport }).promise
  return new Uint8Array(canvas.toBuffer("image/png"))
}
