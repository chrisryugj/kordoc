/**
 * PDF 이미지 XObject 바이트 추출 — 페이지 operatorList의 paint 이미지를
 * page.objs/commonObjs(hayro 가 디코딩한 화소)로 받아 PNG(imageFormat "webp" 면 WebP)로 인코딩한다.
 */

import { createHash } from "node:crypto"
import { OPS, ImageKind } from "./ops.js"
import { encodePng } from "../image/transcode.js"
import { isBlankRgba } from "../image/blank.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"
import type { QrReader } from "../qr.js"
import type { WebpEncoder } from "../image/webp.js"
import { extractImageRegions, type ImageRegion } from "./image-regions.js"

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
/** 인코딩 중인 WebP 의 RGBA 바이트 상한 (64MB) — 넘으면 가장 먼저 건 인코딩부터 기다린다 */
const MAX_PENDING_RAW_BYTES = 64 * 1024 * 1024

/** 문서 단위 추출 상태 — 페이지 간 중복(로고·워터마크) 억제 + 상한 추적 */
export interface PdfImageState {
  imageIndex: number
  totalBytes: number
  /** 내용 해시 → 파일명 (이전 페이지에서 이미 추출된 이미지) */
  seen: Map<string, string>
  /** 문서 공용 객체 id("g_…") → 내용 해시 키. 같은 id 는 늘 같은 디코딩 객체(commonObjs)라 다시 훑지 않는다 */
  globalKeys: Map<string, string>
  capWarned: boolean
  /** imageFormat "webp" (#188) — 없으면 PNG */
  webp?: WebpEncoder
  /** 건 순서대로 기다릴 WebP 인코딩과 그 RGBA 바이트 */
  pending: { done: Promise<void>; raw: number }[]
  pendingRaw: number
  /** WebP 인코딩에 실패해 PNG 로 낸 그림의 이름 — `image_NNN.webp` → `image_NNN.png` */
  renamed: Map<string, string>
  /** WebP 한도(16,383px)를 넘어 PNG 로 낸 그림 수 */
  oversize: number
  /** imagePlacement "flow" — 그림 블록에 쪽 위 자리(bbox)를 붙인다 */
  placement: boolean
  /** dropBlankImages — 거의 한 색인 그림은 블록·바이트를 내지 않는다 */
  dropBlank: boolean
}

export function createPdfImageState(webp?: WebpEncoder, placement = false, dropBlank = false): PdfImageState {
  return { imageIndex: 0, totalBytes: 0, seen: new Map(), globalKeys: new Map(), capWarned: false, webp, pending: [], pendingRaw: 0, renamed: new Map(), oversize: 0, placement, dropBlank }
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
 * 메모리 보호용이라 이때는 걸리지 않는다. `readQr`(qrCodes, #187)가 있으면 디코딩한 픽셀로 QR 을 읽어 블록 `qr` 에 붙인다.
 */
export async function extractPageImages(
  page: PdfPageObjs,
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
  pageNumber: number,
  state: PdfImageState,
  warnings: ParseWarning[],
  withBytes = true,
  readQr?: QrReader,
): Promise<{ blocks: IRBlock[]; images: ExtractedImage[] }> {
  const blocks: IRBlock[] = []
  const images: ExtractedImage[] = []
  const pageSeenIds = new Set<string>()
  // 그림 op 의 쪽 위 자리 — 글 블록 bbox 와 같은 좌표(쪽 원점 이동 op 까지 따라간다)
  const regions = state.placement ? new Map<number, ImageRegion>() : undefined
  if (regions) extractImageRegions(fnArray, argsArray, false, regions)
  const placed = (block: IRBlock, i: number): IRBlock => {
    const r = regions?.get(i)
    if (r) block.bbox = { page: pageNumber, x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1 }
    return block
  }

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    let imgData: PdfImgData | null = null
    let dedupeId: string | null = null

    if (op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat) {
      const objId = argsArray[i]?.[0]
      if (typeof objId !== "string") continue
      if (pageSeenIds.has(objId)) continue
      // 상한 뒤에는 디코딩하지 않는다
      if (await capReached(state, pageNumber, warnings)) continue
      pageSeenIds.add(objId)
      dedupeId = objId
    } else if (op !== OPS.paintInlineImageXObject) {
      continue
    }

    // 상한 도달 검사 — resolveImgData(이미지당 최대 5초 대기) 앞에서 중단해야
    // 상한 이후 이미지들이 페이지마다 디코딩 대기 시간만 소모하지 않는다
    if (await capReached(state, pageNumber, warnings)) continue

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

    const rgba = toRgba(imgData, withBytes || !!readQr || state.dropBlank)
    if (!rgba) continue // 미지원 픽셀 형태 (bitmap 전용 등)
    // 빈 그림 — 같은 내용은 다시 판정하지 않는다(seen 에 이름 없이)
    if (state.dropBlank && isBlankRgba(rgba)) { state.seen.set(hash, ""); continue }

    state.imageIndex++
    const filename = imageFilename(state, w, h)
    state.seen.set(hash, filename)
    if (withBytes) await pushImage(state, filename, w, h, rgba, images)
    const qr = readQr ? await readQr({ data: rgba, width: w, height: h }) : []
    blocks.push(placed({ type: "image", text: filename, pageNumber, ...(qr.length ? { qr } : {}) }, i))
  }

  return { blocks, images }
}

/** 문서당 상한(개수·바이트) — 처음 닿을 때 한 번 경고 */
async function capReached(state: PdfImageState, pageNumber: number, warnings: ParseWarning[]): Promise<boolean> {
  // 인코딩 중인 WebP 가 상한을 넘길 수 있으면(RGBA ×1.1 + 1KB 를 크기 상한으로 본다) 모두 기다린다 — 판정이 인코딩 완료 시점에 따라 바뀌지 않게
  if (state.pending.length && state.totalBytes + state.pendingRaw * 1.1 + 1024 * state.pending.length >= MAX_TOTAL_IMAGE_BYTES) await drain(state, 0)
  if (state.imageIndex < MAX_IMAGES_PER_DOC && state.totalBytes < MAX_TOTAL_IMAGE_BYTES) return false
  if (!state.capWarned) {
    state.capWarned = true
    warnings.push({ page: pageNumber, message: `이미지 추출 상한 도달 (${MAX_IMAGES_PER_DOC}개/128MB) — 이후 이미지 생략`, code: "SKIPPED_IMAGE" })
  }
  return true
}

/** 그림 바이트를 images 에 넣는다. WebP 는 인코딩을 걸어 두고 자리만 먼저 넣어 순서·파일명이 PNG 와 같다 */
async function pushImage(state: PdfImageState, filename: string, w: number, h: number, rgba: Uint8Array, images: ExtractedImage[]): Promise<void> {
  if (!webpable(state, w, h)) {
    if (state.webp) state.oversize++
    const png = encodePng(w, h, rgba)
    state.totalBytes += png.length
    images.push({ filename, data: png, mimeType: "image/png" })
    return
  }
  await drain(state, MAX_PENDING_RAW_BYTES - rgba.length)
  const image: ExtractedImage = { filename, data: NO_BYTES, mimeType: "image/webp" }
  images.push(image)
  const done = state.webp!(rgba, w, h).then(
    webp => { image.data = webp; state.totalBytes += webp.length },
    // 실패해도 파싱은 계속한다 — 그 그림만 PNG 로. 블록의 이름은 flushPdfImages 가 바꾼다
    () => {
      image.data = encodePng(w, h, rgba)
      image.mimeType = "image/png"
      image.filename = filename.replace(/\.webp$/, ".png")
      state.totalBytes += image.data.length
      state.renamed.set(filename, image.filename)
    },
  )
  state.pending.push({ done, raw: rgba.length })
  state.pendingRaw += rgba.length
}

/** 인코딩 중인 RGBA 가 keep 바이트 이하가 될 때까지 먼저 건 것부터 기다린다 */
async function drain(state: PdfImageState, keep: number): Promise<void> {
  while (state.pending.length && state.pendingRaw > keep) {
    const p = state.pending.shift()!
    state.pendingRaw -= p.raw
    await p.done
  }
}

/** 걸어 둔 WebP 인코딩을 모두 기다리고, PNG 로 낸 그림은 블록 이름도 바꾼다 — 그림 블록 주입(injectPageImageBlocks) 전에 부른다 */
export async function flushPdfImages(state: PdfImageState, warnings: ParseWarning[], pageImages: Map<number, IRBlock[]>): Promise<void> {
  await drain(state, 0)
  if (state.oversize) warnings.push({ message: `WebP 한도(가로·세로 16,383px)를 넘는 그림 ${state.oversize}개를 PNG 로 냈습니다`, code: "SKIPPED_IMAGE" })
  if (!state.renamed.size) return
  for (const list of pageImages.values()) for (const b of list) b.text = state.renamed.get(b.text!) ?? b.text
  warnings.push({ message: `WebP 인코딩 실패로 그림 ${state.renamed.size}개를 PNG 로 냈습니다`, code: "SKIPPED_IMAGE" })
}

/** WebP 는 가로·세로 16,383px 까지 — 넘는 그림은 처음부터 PNG 로 낸다 */
const WEBP_MAX_DIM = 16_383
const webpable = (state: PdfImageState, w: number, h: number) => !!state.webp && w <= WEBP_MAX_DIM && h <= WEBP_MAX_DIM
const imageFilename = (state: PdfImageState, w: number, h: number) => `image_${String(state.imageIndex).padStart(3, "0")}.${webpable(state, w, h) ? "webp" : "png"}`

/**
 * 페이지별 image 블록을 본문 블록 열에 주입 — 각 페이지의 마지막 블록 뒤.
 * 페이지 루프 중 바로 끼워 넣으면 페이지 경계에서 표 블록 인접성이 깨져
 * mergeCrossPageTables가 무산되므로, 병합이 끝난 뒤 호출해야 한다.
 * 읽기 순서 제자리(imagePlacement "flow")는 블록 판정이 끝난 뒤 moveImagesInFlow 가 옮긴다
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

/**
 * 쪽 끝에 넣어 둔 그림 블록(최상위, 자리 bbox 가 있는 것)을 읽기 순서 제자리로 옮긴다 (imagePlacement "flow").
 * 자리를 정할 블록이 없는 쪽의 그림은 쪽 끝에 그대로 둔다
 */
export function moveImagesInFlow(blocks: IRBlock[]): void {
  const pageImages = new Map<number, IRBlock[]>()
  const rest: IRBlock[] = []
  for (const b of blocks) {
    if (b.type === "image" && b.bbox && b.pageNumber !== undefined) (pageImages.get(b.pageNumber) ?? pageImages.set(b.pageNumber, []).get(b.pageNumber)!).push(b)
    else rest.push(b)
  }
  if (!pageImages.size) return
  blocks.length = 0
  for (const b of rest) blocks.push(b)
  placeImagesInFlow(blocks, pageImages)
  injectPageImageBlocks(blocks, pageImages)
}

/**
 * 자리(bbox)가 있는 그림 블록을 같은 쪽 글 블록 사이에 끼운다 — 같은 단(가로로 겹치는 블록, 없으면 쪽의 모든 블록)에서
 * 그림 위쪽 변 이상 높이에서 시작하는 마지막 블록 뒤, 그런 블록이 없으면 그 단의 첫 블록 앞. 쪽 안 그림은 위→아래·왼→오른 순서로
 * 같은 자리에 쌓는다. 끼운 그림은 `pageImages` 에서 뺀다 — 자리 있는 블록이 없는 쪽의 그림은 그대로 남아 쪽 끝으로 간다
 */
function placeImagesInFlow(blocks: IRBlock[], pageImages: Map<number, IRBlock[]>): void {
  const byPage = new Map<number, number[]>()
  for (let i = 0; i < blocks.length; i++) {
    const p = blocks[i].pageNumber
    if (p !== undefined && blocks[i].bbox && pageImages.has(p)) (byPage.get(p) ?? byPage.set(p, []).get(p)!).push(i)
  }
  /** 블록 인덱스 → 그 앞에 끼울 그림들 */
  const before = new Map<number, IRBlock[]>()
  for (const [p, images] of pageImages) {
    const placed = byPage.get(p)
    if (!placed) continue
    const top = (b: IRBlock) => b.bbox!.y + b.bbox!.height
    const flowing = images.filter(b => b.bbox).sort((a, b) => top(b) - top(a) || a.bbox!.x - b.bbox!.x)
    for (const image of flowing) {
      const box = image.bbox!
      const overlaps = placed.filter(i => { const b = blocks[i].bbox!; return b.x < box.x + box.width && box.x < b.x + b.width })
      const column = overlaps.length ? overlaps : placed
      const above = column.filter(i => top(blocks[i]) >= top(image))
      const at = above.length ? above[above.length - 1] + 1 : column[0]
      ;(before.get(at) ?? before.set(at, []).get(at)!).push(image)
    }
    const rest = images.filter(b => !flowing.includes(b))
    if (rest.length) pageImages.set(p, rest)
    else pageImages.delete(p)
  }
  if (!before.size) return
  const result: IRBlock[] = []
  for (let i = 0; i <= blocks.length; i++) {
    for (const image of before.get(i) ?? []) result.push(image)
    if (i < blocks.length) result.push(blocks[i])
  }
  blocks.length = 0
  for (const b of result) blocks.push(b)
}
