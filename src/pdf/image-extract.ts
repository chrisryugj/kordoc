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
}

export function createPdfImageState(): PdfImageState {
  return { imageIndex: 0, totalBytes: 0, seen: new Map(), globalKeys: new Map(), capWarned: false }
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

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    let imgData: PdfImgData | null = null
    let dedupeId: string | null = null

    if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) {
      const objId = argsArray[i]?.[0]
      if (typeof objId !== "string" || pageSeenIds.has(objId)) continue
      pageSeenIds.add(objId)
      dedupeId = objId
    } else if (op !== OPS.paintInlineImageXObject) {
      continue
    }

    // 상한 도달 검사 — resolveImgData(이미지당 최대 5초 대기) 앞에서 중단해야
    // 상한 이후 이미지들이 페이지마다 디코딩 대기 시간만 소모하지 않는다
    if (state.imageIndex >= MAX_IMAGES_PER_DOC || state.totalBytes >= MAX_TOTAL_IMAGE_BYTES) {
      if (!state.capWarned) {
        state.capWarned = true
        warnings.push({ page: pageNumber, message: `이미지 추출 상한 도달 (${MAX_IMAGES_PER_DOC}개/128MB) — 이후 이미지 생략`, code: "SKIPPED_IMAGE" })
      }
      continue
    }

    if (dedupeId) {
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

  return { blocks, images }
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
