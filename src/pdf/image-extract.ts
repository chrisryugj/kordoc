/**
 * PDF 이미지 XObject 바이트 추출 — 페이지 operatorList의 paint 이미지를
 * page.objs/commonObjs에서 디코딩된 픽셀로 받아 PNG로 인코딩한다.
 *
 * getOperatorList()가 이미 디코딩 비용을 지불하므로(선 감지용으로 항상 호출)
 * 여기서는 RGBA 변환 + PNG deflate만 추가된다. 순수 JS (node:zlib) 전용.
 */

import { createHash } from "node:crypto"
import { OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { encodePng } from "../image/transcode.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"
import type { PdfiumImage, PdfiumImages } from "./pdfium-images.js"
import { SMALL_IMAGE_DIM } from "./image-blank.js"

/** 디코딩된 이미지 픽셀 (pdfjs page.objs 반환 형태의 최소 부분) */
interface PdfImgData {
  width: number
  height: number
  kind?: number
  data?: Uint8Array | Uint8ClampedArray
}

/** 페이지 프록시의 최소 형태 — objs/commonObjs 만 사용 */
interface PdfObjects {
  get(id: string, callback?: (data: unknown) => void): unknown
}
interface PdfPageObjs {
  objs: PdfObjects
  commonObjs: PdfObjects
}

/** 개별 이미지 디코딩 대기 상한 — 실패 시에도 null 로 resolve 되므로 안전망 성격 */
const IMAGE_RESOLVE_TIMEOUT_MS = 5_000

/**
 * 이미지 객체 대기 해제 — 디코딩은 getOperatorList() resolve 후에도 워커에서
 * 비동기로 진행되므로(pdfjs buildPaintImageXObject 는 await 하지 않음) 동기
 * has()/get() 은 이미 완료된 것만 잡힌다. 콜백형 get()으로 완료를 기다리며,
 * 디코딩 실패는 pdfjs 가 null 로 resolve 하므로 무한 대기는 없다.
 */
function resolveImgData(page: PdfPageObjs, objId: string): Promise<PdfImgData | null> {
  // canvas.js 규약과 동일 — "g_" 접두사는 문서 공용 객체
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, IMAGE_RESOLVE_TIMEOUT_MS)
    try {
      store.get(objId, (data: unknown) => {
        if (!done) { done = true; clearTimeout(timer); resolve((data ?? null) as PdfImgData | null) }
      })
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve(null) }
    }
  })
}

/** 폭·높이 하한 — 괘선/불릿 등 장식 조각 제외 */
const MIN_DIM = 8
/** 총 픽셀 상한 — transcode.ts MAX_PIXELS와 동일 근거 (deflateSync 동기 블로킹 방지) */
const MAX_PIXELS = 36_000_000
/** 문서당 추출 이미지 수 상한 */
const MAX_IMAGES_PER_DOC = 200
/** 문서당 PNG 누적 바이트 상한 (128MB) */
const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024

/** 문서 단위 추출 상태 — 페이지 간 중복(로고·워터마크) 억제 + 상한 추적 */
export interface PdfImageState {
  imageIndex: number
  totalBytes: number
  /** 내용 해시 → 파일명 (이전 페이지에서 이미 추출된 이미지) */
  seen: Map<string, string>
  /** 문서 공용 객체 id("g_…") → 내용 해시 키. 같은 id 는 늘 같은 디코딩 객체(commonObjs)라 다시 훑지 않는다 */
  globalKeys: Map<string, string>
  capWarned: boolean
  /** pdfjs 사본에서 표본을 지운 큰 그림 처리 (#186, image-blank.ts) */
  blanked?: BlankedImageSource
  /** 지운 그림 원본 스트림 해시 → 내용 해시 키. 같은 원본은 다시 디코딩하지 않는다 */
  rawKeys: Map<string, string>
  /** 문서 공용 객체 id("g_…") → 짝지은 PDFium 그림. 같은 id 는 같은 XObject 라 다음 쪽은 PDFium 쪽을 열지 않아도 된다 */
  pdfiumGlobal: Map<string, PdfiumImage>
}

/** 지운 그림을 디코딩하는 길 — PDFium 이 기본, PDFium 이 못 찾는 그림은 지우지 않은 pdfjs 문서 */
export interface BlankedImageSource {
  decoder: PdfiumImages
  /** 지운 그림 크기 "가로x세로" */
  sizes: Set<string>
  pristine(): Promise<{ getPage(n: number): Promise<PdfPageObjs & { getOperatorList(): Promise<{ fnArray: Uint32Array | number[]; argsArray: unknown[][] }>; cleanup(): void }> }>
}

export function createPdfImageState(blanked?: BlankedImageSource): PdfImageState {
  return { imageIndex: 0, totalBytes: 0, seen: new Map(), globalKeys: new Map(), capWarned: false, blanked, rawKeys: new Map(), pdfiumGlobal: new Map() }
}

/** 픽셀 버퍼 내용 해시 — 네이티브 SHA-1. 종전 FNV-1a JS 루프는 맥미니에서 0.93GB/s(SHA-1 2.97GB/s)라, 쪽마다 같은 그림을
 *  새로 그리는 행정업무운영 편람 384쪽(그림 968번·8.1GB)에서 파싱 시간의 78%를 먹었다. 키는 중복 판정에만 쓴다 */
function contentHash(data: Uint8Array | Uint8ClampedArray): string {
  return createHash("sha1").update(data).digest("hex")
}

/** 바이트를 안 뽑을 때(images:false) toRgba 가 변환 대신 돌려주는 표지 — 판정(null 여부)만 같게 */
const NO_BYTES = new Uint8Array(0)

/** kind별 픽셀 → 8bit RGBA. 미지원/불일치 형태는 null. convert=false 면 판정만 하고 NO_BYTES (w×h×4 할당·변환 생략) */
function toRgba(img: PdfImgData, convert = true): Uint8Array | null {
  const { width: w, height: h, kind, data } = img
  if (!data || !w || !h) return null

  if (kind === ImageKind.RGBA_32BPP) {
    if (data.length < w * h * 4) return null
    if (!convert) return NO_BYTES
    const rgba = new Uint8Array(w * h * 4)
    rgba.set(data.subarray(0, w * h * 4))
    return rgba
  }
  if (kind === ImageKind.RGB_24BPP) {
    if (data.length < w * h * 3) return null
    if (!convert) return NO_BYTES
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0, s = 0, d = 0; i < w * h; i++, s += 3, d += 4) {
      rgba[d] = data[s]; rgba[d + 1] = data[s + 1]; rgba[d + 2] = data[s + 2]; rgba[d + 3] = 255
    }
    return rgba
  }
  if (kind === ImageKind.GRAYSCALE_1BPP) {
    // 행 단위 비트 패킹 (stride = ceil(w/8)), 1=백 0=흑
    const stride = (w + 7) >> 3
    if (data.length < stride * h) return null
    if (!convert) return NO_BYTES
    const rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const d = (y * w + x) * 4
        rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; rgba[d + 3] = 255
      }
    }
    return rgba
  }
  return null
}

/**
 * 한 페이지의 operatorList에서 이미지를 추출해 image 블록·바이너리로 반환.
 * 같은 페이지 내 반복 paint(타일링)는 1회만, 이전 페이지와 동일 내용(로고·
 * 워터마크)은 블록·바이너리 모두 재방출하지 않는다.
 *
 * `withBytes` 가 false(images:false)면 PNG 인코딩을 건너뛰고 image 블록만 낸다.
 * 거르기·중복 판정은 같아서 자리 표시가 바이트를 뽑을 때와 같다. 바이트 누적 상한은
 * 메모리 보호용이라 이때는 걸리지 않는다.
 */
export async function extractPageImages(
  page: PdfPageObjs,
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
  pageNumber: number,
  state: PdfImageState,
  warnings: ParseWarning[],
  withBytes = true,
): Promise<{ blocks: IRBlock[]; images: ExtractedImage[] }> {
  const blocks: IRBlock[] = []
  const images: ExtractedImage[] = []
  const pageSeenIds = new Set<string>()
  // 큰 그림 op 를 PDFium 큰 그림과 그리는 순서·크기로 짝짓는다. 지운 그림은 pdfjs 가 검게 디코딩하기도 해서 pdfjs 결과로는 못 가린다.
  // 같은 그림을 다시 그린 op 도 PDFium 쪽 하나를 먹는다. 쪽에서 크기별 개수가 다르면(소프트 마스크 그룹·패턴 안 그림은
  // PDFium 객체로 나오지 않는다) 그 크기는 짝짓지 않는다
  let pdfiumQueue: PdfiumImage[] | undefined
  let unpairedSizes: Set<string> | undefined
  const pdfiumById = new Map<string, PdfiumImage | null>()
  const takePdfium = (match: (image: PdfiumImage) => boolean): PdfiumImage | undefined => {
    const k = pdfiumQueue!.findIndex(match)
    return k < 0 ? undefined : pdfiumQueue!.splice(k, 1)[0]
  }
  // 공용 id 로 앞 쪽 짝을 그대로 쓴 그림 — PDFium 쪽을 나중에 열면 그 몫을 먼저 뺀다
  const reusedRaws: string[] = []
  const consume = (raw: string) => { if (pdfiumQueue) takePdfium(x => x.raw === raw); else reusedRaws.push(raw) }
  const pairable = (w: number | undefined, h: number | undefined): boolean => {
    if (!pdfiumQueue) {
      pdfiumQueue = state.blanked!.decoder.page(pageNumber)
      unpairedSizes = pairingCounts(fnArray, argsArray, pdfiumQueue)
      for (const raw of reusedRaws) takePdfium(x => x.raw === raw)
    }
    return w !== undefined && !unpairedSizes!.has(`${w}x${h}`) && !unpairedSizes!.has("repeat")
  }

  let pristine: { page: PdfPageObjs & { cleanup(): void }; ids: unknown[] } | undefined
  /** 그림 op 순번 — 지우지 않은 문서와 짝짓는다(쪽 원점 이동 op 가 앞에 붙기도 해서 op 인덱스는 다르다) */
  let paintIndex = -1

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    let imgData: PdfImgData | null = null
    let dedupeId: string | null = null
    let fromPristine = false

    if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) {
      paintIndex++
      // paintImageXObjectRepeat 는 같은 그림 여러 번 — 인자 [objId, scaleX, scaleY, positions(x,y 쌍)]
      const paints = op === OPS.paintImageXObjectRepeat ? ((argsArray[i]?.[3] as ArrayLike<number> | undefined)?.length ?? 2) / 2 : 1
      const objId = argsArray[i]?.[0]
      if (typeof objId !== "string") continue
      if (pageSeenIds.has(objId)) {
        const first = pdfiumById.get(objId)
        if (first) for (let k = 0; k < paints; k++) consume(first.raw)
        continue
      }
      // 상한 뒤에는 PDFium 쪽도 열지 않는다
      if (capReached(state, pageNumber, warnings)) continue
      if (state.blanked) {
        const w = op === OPS.paintImageXObject ? argsArray[i]?.[1] as number : undefined
        const h = op === OPS.paintImageXObject ? argsArray[i]?.[2] as number : undefined
        const large = w === undefined || h === undefined || w > SMALL_IMAGE_DIM || h > SMALL_IMAGE_DIM
        // 앞 쪽에서 짝지은 공용 그림 — 이미 내보낸 지운 그림이거나 pdfjs 가 그리는 그림이면 PDFium 쪽을 열지 않는다
        const known = state.pdfiumGlobal.get(objId)
        const reuse = known && (!known.blanked || (known.sameRawSamePixels && state.rawKeys.has(known.raw)))
        let image: PdfiumImage | null
        if (reuse) {
          image = known
          for (let k = 0; k < paints; k++) consume(known.raw)
        } else {
          image = large && pairable(w, h) ? takePdfium(x => x.width === w && x.height === h) ?? null : null
          if (image) for (let k = 1; k < paints; k++) consume(image.raw)
          if (image && objId.startsWith("g_")) state.pdfiumGlobal.set(objId, image)
        }
        pdfiumById.set(objId, image)
        const block = image?.blanked ? extractPdfiumImage(image, pageNumber, state, warnings, withBytes, images) : UNDECODED
        if (block !== UNDECODED) {
          pageSeenIds.add(objId)
          if (block) blocks.push(block)
          continue
        }
        // PDFium 이 못 찾거나 못 그린 지운 그림은 pdfjs 사본으로는 못 그린다 — 지우지 않은 문서로
        fromPristine = large && (!!image?.blanked || (!image && (w === undefined || state.blanked.sizes.has(`${w}x${h}`))))
      }
      pageSeenIds.add(objId)
      dedupeId = objId
    } else if (op !== OPS.paintInlineImageXObject) {
      continue
    }

    // 상한 도달 검사 — resolveImgData(이미지당 최대 5초 대기) 앞에서 중단해야
    // 상한 이후 이미지들이 페이지마다 디코딩 대기 시간만 소모하지 않는다
    if (capReached(state, pageNumber, warnings)) continue

    if (fromPristine) {
      if (!pristine) {
        const p = await (await state.blanked!.pristine()).getPage(pageNumber)
        const ops = await p.getOperatorList()
        pristine = { page: p, ids: paintImageIds(ops.fnArray, ops.argsArray) }
      }
      // 지운 사본과 그림 op 순서가 같다 — 객체 id 만 다르다
      dedupeId = pristine.ids[paintIndex] as string
      if (typeof dedupeId !== "string") continue
      imgData = await resolveImgData(pristine.page, dedupeId)
    } else if (dedupeId) {
      imgData = await resolveImgData(page, dedupeId)
    } else {
      imgData = argsArray[i]?.[0] as PdfImgData
    }

    if (!imgData?.data || !imgData.width || !imgData.height) continue
    const { width: w, height: h } = imgData
    if (w < MIN_DIM || h < MIN_DIM) continue // 괘선/불릿 장식
    if (w * h > MAX_PIXELS) {
      warnings.push({ page: pageNumber, message: `이미지 크기 초과로 추출 생략 (${w}×${h})`, code: "SKIPPED_IMAGE" })
      continue
    }

    // 페이지 간 내용 중복 — 로고·워터마크 재추출 방지
    const globalId = dedupeId?.startsWith("g_") ? dedupeId : undefined
    let hash = globalId ? state.globalKeys.get(globalId) : undefined
    if (hash === undefined) {
      hash = `${w}x${h}k${imgData.kind ?? "?"}h${contentHash(imgData.data)}${dedupeId ? "" : "inline"}`
      if (globalId) state.globalKeys.set(globalId, hash)
    }
    if (state.seen.has(hash)) continue

    const rgba = toRgba(imgData, withBytes)
    if (!rgba) continue // 미지원 픽셀 형태 (bitmap 전용 등)

    state.imageIndex++
    const filename = `image_${String(state.imageIndex).padStart(3, "0")}.png`
    state.seen.set(hash, filename)
    if (withBytes) {
      const png = encodePng(w, h, rgba)
      state.totalBytes += png.length
      images.push({ filename, data: png, mimeType: "image/png" })
    }
    blocks.push({ type: "image", text: filename, pageNumber })
  }

  pristine?.page.cleanup()
  return { blocks, images }
}

/** 그림 op(paintImageXObject·Repeat)의 객체 id 를 순서대로 */
function paintImageIds(fnArray: Uint32Array | number[], argsArray: unknown[][]): unknown[] {
  const ids: unknown[] = []
  for (let i = 0; i < fnArray.length; i++) if (fnArray[i] === OPS.paintImageXObject || fnArray[i] === OPS.paintImageXObjectRepeat) ids.push(argsArray[i]?.[0])
  return ids
}

/** pdfjs 큰 그림 op 와 PDFium 큰 그림의 크기별 개수가 다른 크기 — 같은 그림을 여러 번 그린 op(repeat)가 있으면 "repeat" */
function pairingCounts(fnArray: Uint32Array | number[], argsArray: unknown[][], pdfium: PdfiumImage[]): Set<string> {
  const count = new Map<string, number>()
  const unpaired = new Set<string>()
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === OPS.paintImageXObjectRepeat) unpaired.add("repeat")
    if (fnArray[i] !== OPS.paintImageXObject) continue
    const w = argsArray[i]?.[1] as number, h = argsArray[i]?.[2] as number
    if (w > SMALL_IMAGE_DIM || h > SMALL_IMAGE_DIM) count.set(`${w}x${h}`, (count.get(`${w}x${h}`) ?? 0) + 1)
  }
  for (const x of pdfium) count.set(`${x.width}x${x.height}`, (count.get(`${x.width}x${x.height}`) ?? 0) - 1)
  for (const [size, n] of count) if (n !== 0) unpaired.add(size)
  return unpaired
}

/** 문서당 상한(개수·바이트) — 처음 닿을 때 한 번 경고 */
function capReached(state: PdfImageState, pageNumber: number, warnings: ParseWarning[]): boolean {
  if (state.imageIndex < MAX_IMAGES_PER_DOC && state.totalBytes < MAX_TOTAL_IMAGE_BYTES) return false
  if (!state.capWarned) {
    state.capWarned = true
    warnings.push({ page: pageNumber, message: `이미지 추출 상한 도달 (${MAX_IMAGES_PER_DOC}개/128MB) — 이후 이미지 생략`, code: "SKIPPED_IMAGE" })
  }
  return true
}

/** PDFium 이 디코딩하지 못했다 — 호출자가 지우지 않은 pdfjs 문서로 다시 그린다 */
const UNDECODED = Symbol("undecoded")

/** 지운 그림 하나 — 거르기·중복·번호는 pdfjs 경로와 같다. 같은 원본 스트림은 디코딩하지 않고 앞 판정을 쓴다 */
function extractPdfiumImage(
  image: PdfiumImage,
  pageNumber: number,
  state: PdfImageState,
  warnings: ParseWarning[],
  withBytes: boolean,
  images: ExtractedImage[],
): IRBlock | null | typeof UNDECODED {
  const { width: w, height: h } = image
  if (w < MIN_DIM || h < MIN_DIM) return null // 괘선 장식 — pdfjs 경로와 같다
  if (w * h > MAX_PIXELS) {
    warnings.push({ page: pageNumber, message: `이미지 크기 초과로 추출 생략 (${w}×${h})`, code: "SKIPPED_IMAGE" })
    return null
  }
  // 원본·사전이 같은 그림은 이미 내보냈다
  if (image.sameRawSamePixels && state.rawKeys.has(image.raw)) return null
  const rgba = state.blanked!.decoder.decode(image)
  if (!rgba) return UNDECODED
  const hash = `${w}x${h}kPh${contentHash(rgba)}`
  state.rawKeys.set(image.raw, hash)
  if (state.seen.has(hash)) return null
  state.imageIndex++
  const filename = `image_${String(state.imageIndex).padStart(3, "0")}.png`
  state.seen.set(hash, filename)
  if (withBytes) {
    const png = encodePng(w, h, rgba)
    state.totalBytes += png.length
    images.push({ filename, data: png, mimeType: "image/png" })
  }
  return { type: "image", text: filename, pageNumber }
}

/**
 * 페이지별 image 블록을 본문 블록 열에 주입 — 각 페이지의 마지막 블록 뒤.
 * 페이지 루프 중 바로 끼워 넣으면 페이지 경계에서 표 블록 인접성이 깨져
 * mergeCrossPageTables가 무산되므로, 병합이 끝난 뒤 호출해야 한다.
 */
export function injectPageImageBlocks(blocks: IRBlock[], pageImages: Map<number, IRBlock[]>): void {
  if (pageImages.size === 0) return

  // 페이지별 마지막 블록 위치 → 위치별 페이지 역인덱스
  const lastIndexForPage = new Map<number, number>()
  for (let i = 0; i < blocks.length; i++) {
    const p = blocks[i].pageNumber
    if (p !== undefined) lastIndexForPage.set(p, i)
  }
  const pageAtIndex = new Map<number, number>()
  for (const [p, last] of lastIndexForPage) pageAtIndex.set(last, p)

  const result: IRBlock[] = []
  const injected = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    result.push(blocks[i])
    const p = pageAtIndex.get(i)
    if (p !== undefined && pageImages.has(p)) {
      result.push(...pageImages.get(p)!)
      injected.add(p)
    }
  }
  // 텍스트 블록이 하나도 없는 페이지(전면 이미지 등) — 페이지 순서 위치에 삽입
  for (const p of [...pageImages.keys()].sort((a, b) => a - b)) {
    if (injected.has(p)) continue
    let at = result.length
    for (let i = 0; i < result.length; i++) {
      const bp = result[i].pageNumber
      if (bp !== undefined && bp > p) { at = i; break }
    }
    result.splice(at, 0, ...pageImages.get(p)!)
  }

  blocks.length = 0
  for (const b of result) blocks.push(b) // push(...result) 는 블록 약 13만 개부터 RangeError — 그림 1장 든 3,500쪽 문서가 통째 실패했다
}
