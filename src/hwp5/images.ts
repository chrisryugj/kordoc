/**
 * HWP5 BinData 이미지 추출.
 *
 * - DocInfo BIN_DATA의 binDataId(1-based) → storage_id 매핑은 parser.ts(pictureToImageBlock)에서 수행
 * - 이 모듈은 BinData 스토리지 엔트리("BIN%04X.ext" — storage_id는 16진!)를 storageId 키로 수집하고
 *   블록 트리(셀 내부 blocks 포함)의 image 블록과 매칭해 ExtractedImage로 변환한다.
 */

import { decompressStream } from "./record.js"
import type { LenientCfbContainer } from "./cfb-lenient.js"
import type { ExtractedImage, IRBlock, IRCell, ParseWarning } from "../types.js"

/** CFB FileIndex 엔트리 (cfb 모듈 호환 최소 형태) */
export interface BinCfbEntry { name?: string; content?: Buffer | Uint8Array }

/** MIME 타입 매직바이트 판별 */
export function detectImageMime(data: Buffer | Uint8Array): string | null {
  if (data.length < 4) return null
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png"
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif"
  if (data[0] === 0x42 && data[1] === 0x4d) return "image/bmp"
  if (data[0] === 0xd7 && data[1] === 0xcd && data[2] === 0xc6 && data[3] === 0x9a) return "image/wmf"
  if (data[0] === 0x01 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x00) return "image/emf"
  return null
}

/**
 * BinData 페이로드 정규화 — 항목별 압축 플래그가 문서 압축 플래그와 다를 수 있으므로
 * 매직바이트가 안 보이면 압축 해제를 시도하고, 실패하면 원본 유지.
 */
function normalizeBinPayload(data: Buffer): Buffer {
  if (detectImageMime(data)) return data
  try {
    const inflated = decompressStream(data)
    if (inflated.length > 0) return inflated
  } catch { /* 비압축 데이터 */ }
  return data
}

/** BinData 스토리지 엔트리명 — "BIN%04X.ext" (storage_id는 16진!) */
const BIN_ENTRY_RE = /(?:^|\/)BIN([0-9A-Fa-f]{4,8})(?:\.[^./\\]*)?$/

/** 블록 트리(셀 내부 blocks 포함)에서 image 블록 수집 */
function collectImageBlocks(blocks: IRBlock[], out: IRBlock[]): void {
  for (const b of blocks) {
    if (b.type === "image") out.push(b)
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.blocks) collectImageBlocks(cell.blocks, out)
        }
      }
    }
    if (b.children) collectImageBlocks(b.children, out)
  }
}

/** 블록 트리의 모든 표 셀 순회 (중첩표 포함) */
function forEachTableCell(blocks: IRBlock[], fn: (cell: IRCell) => void): void {
  for (const b of blocks) {
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          fn(cell)
          if (cell.blocks) forEachTableCell(cell.blocks, fn)
        }
      }
    }
    if (b.children) forEachTableCell(b.children, fn)
  }
}

/** 셀 텍스트의 이미지 sentinel("![image](hwp5bin:ID)")을 추출된 파일명으로 치환 */
const CELL_IMAGE_SENTINEL_RE = /!\[image\]\(hwp5bin:(\d+)\)/g
function resolveCellImageSentinels(blocks: IRBlock[], renamed: Map<number, string>): void {
  forEachTableCell(blocks, cell => {
    if (!cell.text.includes("hwp5bin:")) return
    cell.text = cell.text.replace(CELL_IMAGE_SENTINEL_RE, (_m, idStr: string) => {
      const filename = renamed.get(Number(idStr))
      return filename ? `![image](${filename})` : "[이미지]"
    })
  })
}

/** binDataMap 기반 이미지 블록 해결 — strict/lenient 공용 */
function resolveImageBlocks(
  binDataMap: Map<number, { data: Buffer; name: string }>,
  blocks: IRBlock[],
  warnings: ParseWarning[],
  sweepUnreferenced?: boolean,
): ExtractedImage[] {
  const imageBlocks: IRBlock[] = []
  collectImageBlocks(blocks, imageBlocks)

  const images: ExtractedImage[] = []
  const renamed = new Map<number, string>()
  // 같은 BinData를 참조하는 개체가 수천 개일 수 있다(도형 반복 등) — storageId당
  // 1회만 변환·추출하고 데이터 버퍼를 공유한다 (블록마다 복사하면 메모리 폭발)
  const resolved = new Map<number, { filename: string; data: Uint8Array; mime: string } | null>()
  let imageIndex = 0

  for (const block of imageBlocks) {
    if (!block.text) continue
    const storageId = parseInt(block.text, 10)
    if (isNaN(storageId)) continue

    let img = resolved.get(storageId)
    if (img === undefined) {
      const bin = binDataMap.get(storageId)
      if (!bin) {
        warnings.push({ page: block.pageNumber, message: `BinData ${storageId} 없음`, code: "SKIPPED_IMAGE" })
        resolved.set(storageId, null)
      } else {
        const mime = detectImageMime(bin.data)
        if (!mime) {
          warnings.push({ page: block.pageNumber, message: `BinData ${storageId}: 알 수 없는 이미지 형식`, code: "SKIPPED_IMAGE" })
          resolved.set(storageId, null)
        } else {
          imageIndex++
          const ext = mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("bmp") ? "bmp" : "bin"
          img = { filename: `image_${String(imageIndex).padStart(3, "0")}.${ext}`, data: new Uint8Array(bin.data), mime }
          resolved.set(storageId, img)
          images.push({ filename: img.filename, data: img.data, mimeType: img.mime })
          renamed.set(storageId, img.filename)
        }
      }
      img = resolved.get(storageId)
    }

    if (!img) {
      const bin = binDataMap.get(storageId)
      block.type = "paragraph"
      block.text = bin ? `[이미지: ${bin.name}]` : `[이미지: BinData ${storageId}]`
      continue
    }
    block.text = img.filename
    block.imageData = { data: img.data, mimeType: img.mime, filename: binDataMap.get(storageId)!.name }
  }

  // 본문 미참조 BinData 이미지 스윕 — pic 컨트롤이 닿지 않는 이미지(셀 배경 등)를
  // 문서 끝에 image 블록으로 보강한다. 이미지가 아닌 스트림(OLE 등)은 건너뛴다.
  if (sweepUnreferenced) {
    for (const [storageId, bin] of [...binDataMap.entries()].sort((a, b) => a[0] - b[0])) {
      if (resolved.has(storageId)) continue
      const mime = detectImageMime(bin.data)
      if (!mime) continue
      imageIndex++
      const ext = mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("bmp") ? "bmp" : "bin"
      const filename = `image_${String(imageIndex).padStart(3, "0")}.${ext}`
      const data = new Uint8Array(bin.data)
      images.push({ filename, data, mimeType: mime })
      blocks.push({ type: "image", text: filename, imageData: { data, mimeType: mime, filename: bin.name } })
    }
  }

  resolveCellImageSentinels(blocks, renamed)
  return images
}

/** OLE2 BinData 스토리지(FileIndex)에서 이미지 추출, blocks의 image 블록과 매핑 */
export function extractHwp5Images(
  fileIndex: BinCfbEntry[] | undefined,
  blocks: IRBlock[],
  warnings: ParseWarning[],
  sweepUnreferenced?: boolean,
): ExtractedImage[] {
  // BinData 스토리지의 모든 파일을 FileIndex 순회로 수집 — 엔트리명은 "BIN%04X.ext" 16진
  const binDataMap = new Map<number, { data: Buffer; name: string }>()
  if (fileIndex) {
    for (const entry of fileIndex) {
      if (!entry?.name || !entry.content) continue
      const match = entry.name.match(BIN_ENTRY_RE)
      if (!match) continue
      const idx = parseInt(match[1], 16)
      const data = normalizeBinPayload(Buffer.from(entry.content))
      binDataMap.set(idx, { data, name: entry.name })
    }
  }

  if (binDataMap.size === 0) {
    // 이미지 블록이 있는데 BinData가 없으면 sentinel 정리만 수행
    resolveCellImageSentinels(blocks, new Map())
    return []
  }
  return resolveImageBlocks(binDataMap, blocks, warnings, sweepUnreferenced)
}

/** Lenient CFB: BinData 이미지 추출 */
export function extractHwp5ImagesLenient(
  lcfb: LenientCfbContainer,
  blocks: IRBlock[],
  warnings: ParseWarning[],
  sweepUnreferenced?: boolean,
): ExtractedImage[] {
  // BinData 엔트리 수집 — 엔트리명 "BIN%04X.ext" 16진
  const binDataMap = new Map<number, { data: Buffer; name: string }>()
  const binRe = /^BIN([0-9A-Fa-f]{4,8})(?:\.|$)/
  for (const e of lcfb.entries()) {
    const match = e.name.match(binRe)
    if (!match) continue
    const idx = parseInt(match[1], 16)
    const raw = lcfb.findStream(e.name)
    if (!raw) continue
    binDataMap.set(idx, { data: normalizeBinPayload(raw), name: e.name })
  }
  if (binDataMap.size === 0) {
    resolveCellImageSentinels(blocks, new Map())
    return []
  }
  return resolveImageBlocks(binDataMap, blocks, warnings, sweepUnreferenced)
}
