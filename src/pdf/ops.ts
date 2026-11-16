/**
 * PDF 그리기 명령 번호·그림 형식·글 정규화 — 연산자 목록(fnArray·argsArray)을 읽는 모듈이 함께 쓴다.
 *
 * 번호는 pdf.js 연산자 목록과 같다(pdf.js 4.10, Apache-2.0 — NOTICE). kordoc 의 판정 모듈은 이 모양의 목록을 읽고,
 * hayro 어댑터(hayro-ops.ts)가 같은 모양으로 만든다.
 */

export const OPS = {
  dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5, setDash: 6, setRenderingIntent: 7, setFlatness: 8,
  setGState: 9, save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18,
  rectangle: 19, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30, beginText: 31, endText: 32, setCharSpacing: 33, setWordSpacing: 34,
  setHScale: 35, setLeading: 36, setFont: 37, setTextRenderingMode: 38, setTextRise: 39, moveText: 40, setLeadingMoveText: 41,
  setTextMatrix: 42, nextLine: 43, showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  setCharWidth: 48, setCharWidthAndBounds: 49, setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52,
  setStrokeColorN: 53, setFillColor: 54, setFillColorN: 55, setStrokeGray: 56, setFillGray: 57, setStrokeRGBColor: 58,
  setFillRGBColor: 59, setStrokeCMYKColor: 60, setFillCMYKColor: 61, shadingFill: 62, beginInlineImage: 63, beginImageData: 64,
  endInlineImage: 65, paintXObject: 66, markPoint: 67, markPointProps: 68, beginMarkedContent: 69, beginMarkedContentProps: 70,
  endMarkedContent: 71, beginCompat: 72, endCompat: 73, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76,
  endGroup: 77, beginAnnotation: 80, endAnnotation: 81, paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85, paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90, constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93,
}

/** 그림 화소 형식 — 1비트 회색(행마다 바이트 맞춤)·RGB·RGBA */
export const ImageKind = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const

let normalizeRegex: RegExp | undefined
/** 합자(ﬁ ﬂ)·호환 글자를 NFKC 로 풀어 쓴다 — 글 조각의 글자열을 pdf.js 와 같은 규칙으로 */
export function normalizeUnicode(str: string): string {
  normalizeRegex ??= /([ µ;ຳ -  Ωﬀ-ﬄﬆﬠ-זּטּ-לּמּנּ-סּףּ-פּצּ-ﮡﮤ-ﮩﮮ-ﮱﯓ-ﯜﯞ-ﯧﯪ-ﯸﯼ-ﯽﰀ-ﱝﱤ-ﳱﳵ-ﴽﶈﷴﷺ-ﷻﹱﹷﹹﹻﹽ]+)|(ﬅ+)/gu
  return str.replaceAll(normalizeRegex, (_, p1: string | undefined, p2: string) => p1 ? p1.normalize("NFKC") : String(p2 === "ﬅ" ? "ſt" : undefined))
}
