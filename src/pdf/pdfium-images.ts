/**
 * pdfjs 사본에서 지운 큰 그림(image-blank.ts)의 픽셀을 PDFium 으로 원본에서 디코딩한다 (#186).
 *
 * @hyzyla/pdfium 래퍼는 Form XObject 안 그림을 돌지 않고 GetImagePixelSize 결과 칸을 2바이트로 잡아,
 * wasm 함수를 직접 부른다. 픽셀은 FPDFImageObj_GetBitmap — pdfjs 디코딩처럼 그래픽 상태(ExtGState 소프트 마스크·투명도)를
 * 반영하지 않는다. 자체 마스크가 있는 그림은 애초에 지우지 않아 여기 오지 않는다.
 */

import { createHash } from "node:crypto"
import { SMALL_IMAGE_DIM, type BlankedImages } from "./image-blank.js"

/** 쓰는 wasm 함수만 */
interface PdfiumModule {
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
  wasmExports: { malloc(size: number): number; free(ptr: number): void }
  _FPDF_LoadPage(doc: number, index: number): number
  _FPDF_ClosePage(page: number): void
  _FPDFPage_CountObjects(page: number): number
  _FPDFPage_GetObject(page: number, index: number): number
  _FPDFPageObj_GetType(obj: number): number
  _FPDFFormObj_CountObjects(form: number): number
  _FPDFFormObj_GetObject(form: number, index: number): number
  _FPDFPage_GetAnnotCount(page: number): number
  _FPDFPage_GetAnnot(page: number, index: number): number
  _FPDFPage_CloseAnnot(annot: number): void
  _FPDFAnnot_GetObjectCount(annot: number): number
  _FPDFAnnot_GetObject(annot: number, index: number): number
  _FPDFImageObj_GetImagePixelSize(obj: number, width: number, height: number): number
  _FPDFImageObj_GetImageDataRaw(obj: number, buffer: number, length: number): number
  _FPDFImageObj_GetBitmap(obj: number): number
  _FPDFBitmap_GetBuffer(bitmap: number): number
  _FPDFBitmap_GetWidth(bitmap: number): number
  _FPDFBitmap_GetHeight(bitmap: number): number
  _FPDFBitmap_GetStride(bitmap: number): number
  _FPDFBitmap_GetFormat(bitmap: number): number
  _FPDFBitmap_Destroy(bitmap: number): void
}

const IMAGE_OBJECT = 3
const FORM_OBJECT = 5

/** 큰 그림 하나 — 핸들은 그 쪽을 닫기 전까지만 유효하다 */
export interface PdfiumImage {
  width: number
  height: number
  /** 원본 스트림 SHA-1 — 같으면 픽셀도 같다 */
  raw: string
  /** pdfjs 사본에서 표본을 지웠다 — PDFium 으로만 디코딩할 수 있다 */
  blanked: boolean
  /** 같은 원본을 쓰는 그림이 모두 같은 사전이다 — 원본 해시만으로 같은 그림이라 볼 수 있다 */
  sameRawSamePixels: boolean
  handle: number
}

export interface PdfiumImages {
  /** 쪽(1-based)의 큰 그림(가로·세로 한쪽이라도 128px 초과)을 그리는 순서로(Form XObject 안, 주석 모양 포함). 앞 쪽 핸들은 닫힌다 */
  page(pageNumber: number): PdfiumImage[]
  /** 8bit RGBA. 실패하면 null */
  decode(image: PdfiumImage): Uint8Array | null
  close(): void
}

/** PDFium 이 없거나 문서를 못 열면 null — 호출자는 지우지 않은 사본으로 pdfjs 경로를 쓴다 */
export async function openPdfiumImages(buffer: ArrayBuffer, blanked: BlankedImages): Promise<PdfiumImages | null> {
  const mod = await import("@hyzyla/pdfium").catch(() => null)
  if (!mod) return null
  const lib = await mod.PDFiumLibrary.init().catch(() => null)
  if (!lib) return null
  const doc = await lib.loadDocument(new Uint8Array(buffer)).catch(() => null)
  if (!doc) { lib.destroy(); return null }
  const m = (lib as unknown as { module: PdfiumModule }).module
  const docHandle = (doc as unknown as { documentIdx: number }).documentIdx
  let open: { page: number; annots: number[] } | null = null

  const closePage = () => {
    if (!open) return
    for (const a of open.annots) m._FPDFPage_CloseAnnot(a)
    m._FPDF_ClosePage(open.page)
    open = null
  }
  const pixelSize = (obj: number): [number, number] => {
    const p = m.wasmExports.malloc(8)
    const ok = m._FPDFImageObj_GetImagePixelSize(obj, p, p + 4)
    const size: [number, number] = ok ? [m.HEAPU32[p >> 2], m.HEAPU32[(p >> 2) + 1]] : [0, 0]
    m.wasmExports.free(p)
    return size
  }
  const rawHash = (obj: number): string => {
    const n = m._FPDFImageObj_GetImageDataRaw(obj, 0, 0)
    if (!n) return ""
    const p = m.wasmExports.malloc(n)
    m._FPDFImageObj_GetImageDataRaw(obj, p, n)
    const hash = createHash("sha1").update(m.HEAPU8.subarray(p, p + n)).digest("hex")
    m.wasmExports.free(p)
    return hash
  }

  return {
    page(pageNumber) {
      closePage()
      const page = m._FPDF_LoadPage(docHandle, pageNumber - 1)
      if (!page) return []
      open = { page, annots: [] }
      const out: PdfiumImage[] = []
      const walk = (count: number, get: (i: number) => number, depth: number) => {
        for (let i = 0; i < count; i++) {
          const obj = get(i)
          const type = m._FPDFPageObj_GetType(obj)
          if (type === FORM_OBJECT && depth < 32) walk(m._FPDFFormObj_CountObjects(obj), j => m._FPDFFormObj_GetObject(obj, j), depth + 1)
          if (type !== IMAGE_OBJECT) continue
          const [width, height] = pixelSize(obj)
          if (width <= SMALL_IMAGE_DIM && height <= SMALL_IMAGE_DIM) continue
          const raw = rawHash(obj)
          out.push({ width, height, raw, blanked: blanked.byRaw.has(raw), sameRawSamePixels: blanked.byRaw.get(raw) === true, handle: obj })
        }
      }
      walk(m._FPDFPage_CountObjects(page), i => m._FPDFPage_GetObject(page, i), 0)
      // pdfjs 는 주석 모양을 쪽 본문 뒤에 그린다
      for (let i = 0; i < m._FPDFPage_GetAnnotCount(page); i++) {
        const annot = m._FPDFPage_GetAnnot(page, i)
        if (!annot) continue
        open.annots.push(annot)
        walk(m._FPDFAnnot_GetObjectCount(annot), j => m._FPDFAnnot_GetObject(annot, j), 0)
      }
      return out
    },
    decode(image) {
      const bitmap = m._FPDFImageObj_GetBitmap(image.handle)
      if (!bitmap) return null
      try {
        const w = m._FPDFBitmap_GetWidth(bitmap), h = m._FPDFBitmap_GetHeight(bitmap)
        const stride = m._FPDFBitmap_GetStride(bitmap), format = m._FPDFBitmap_GetFormat(bitmap)
        // 1 Gray · 2 BGR · 3 BGRx · 4 BGRA
        const bpp = format === 1 ? 1 : format === 2 ? 3 : format === 3 || format === 4 ? 4 : 0
        if (!bpp || w !== image.width || h !== image.height) return null
        const src = m.HEAPU8, base = m._FPDFBitmap_GetBuffer(bitmap)
        const rgba = new Uint8Array(w * h * 4)
        for (let y = 0; y < h; y++) {
          for (let x = 0, s = base + y * stride, d = y * w * 4; x < w; x++, s += bpp, d += 4) {
            if (bpp === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = src[s]; rgba[d + 3] = 255; continue }
            rgba[d] = src[s + 2]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s]; rgba[d + 3] = format === 4 ? src[s + 3] : 255
          }
        }
        return rgba
      } finally {
        m._FPDFBitmap_Destroy(bitmap)
      }
    },
    close() {
      closePage()
      doc.destroy()
      lib.destroy()
    },
  }
}
