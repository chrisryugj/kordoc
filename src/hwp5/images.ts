/**
 * HWP5 BinData 이미지 추출.
 *
 * - DocInfo BIN_DATA의 binDataId(1-based) → storage_id 매핑은 parser.ts(pictureToImageBlock)에서 수행
 * - 이 모듈은 BinData 스토리지 엔트리("BIN%04X.ext" — storage_id는 16진!)를 storageId 키로 수집하고
 *   블록 트리(셀 내부 blocks 포함)의 image 블록과 매칭해 ExtractedImage로 변환한다.
 */

import { decompressStream } from "./record.js"
import type { LenientCfbContainer } from "./cfb-lenient.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"

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
  // 배치 헤더 없는 표준 WMF — mtType 1(메모리)·2(디스크) + mtHeaderSize 9워드. 한컴 BinData 의 .wmf 는 대개 이 꼴
  // (법령 서식 BIN0001.wmf 실측 01 00 09 00 00 03). 종전엔 "알 수 없는 형식"이라 셀에 [이미지: …] 글이 박혔다
  if ((data[0] === 0x01 || data[0] === 0x02) && data[1] === 0x00 && data[2] === 0x09 && data[3] === 0x00) return "image/wmf"
  if (data[0] === 0x01 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x00) return "image/emf"
  // TIFF — 리틀(II*\0)·빅(MM\0*) 엔디언 (행정업무편람 BIN016C.TIF 실측)
  if ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a)) return "image/tiff"
  return null
}

/** MIME → 추출 파일 확장자 (HWPX images.ts mimeToExt 와 같은 표) */
function mimeExt(mime: string): string {
  if (mime.includes("jpeg")) return "jpg"
  if (mime.includes("png")) return "png"
  if (mime.includes("gif")) return "gif"
  if (mime.includes("bmp")) return "bmp"
  if (mime.includes("tiff")) return "tif"
  if (mime.includes("wmf")) return "wmf"
  if (mime.includes("emf")) return "emf"
  return "bin"
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

/** 블록 트리 재귀 깊이 상한 — hwpx collectImageBlocks(MAX_XML_DEPTH)와 동일 값.
 *  손상/악성 문서의 자기참조·초심층 트리 스택 오버플로 방지 */
const MAX_BLOCK_DEPTH = 200

/** 블록 트리(셀 내부 blocks 포함)에서 image 블록 수집.
 *  hwpx 쪽과 안전장치 합집합: depth 가드 + children 순회 (둘 다 수행) */
function collectImageBlocks(blocks: IRBlock[], out: IRBlock[], depth = 0): void {
  if (depth > MAX_BLOCK_DEPTH) return
  for (const b of blocks) {
    if (b.type === "image") out.push(b)
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.blocks) collectImageBlocks(cell.blocks, out, depth + 1)
        }
      }
    }
    if (b.children) collectImageBlocks(b.children, out, depth + 1)
  }
}

/**
 * 이미지 sentinel("![image](hwp5bin:ID)")을 추출된 파일명으로 치환 — 표 셀 텍스트, 그리고 머리말·각주·캡션처럼
 * 표를 평문으로 편 글(ir-assemble tableFlatText)에도 남으므로 블록 트리 전체(문단 글·각주·캡션·셀)를 훑는다.
 * 파일명이 없으면(BinData 없음·페이지 필터로 스윕 안 함) "[이미지]"
 */
const IMAGE_SENTINEL_RE = /!\[image\]\(hwp5bin:(\d+)\)/g
function resolveImageSentinels(blocks: IRBlock[], renamed: Map<number, string>, depth = 0): void {
  if (depth > MAX_BLOCK_DEPTH) return
  const fix = (s: string): string => s.includes("hwp5bin:")
    ? s.replace(IMAGE_SENTINEL_RE, (_m, idStr: string) => {
      const filename = renamed.get(Number(idStr))
      return filename ? `![image](${filename})` : "[이미지]"
    })
    : s
  for (const b of blocks) {
    if (b.text) b.text = fix(b.text)
    if (b.footnoteText) b.footnoteText = fix(b.footnoteText)
    if (b.table) {
      if (b.table.caption) b.table.caption = fix(b.table.caption)
      for (const row of b.table.cells) {
        for (const cell of row) {
          cell.text = fix(cell.text)
          if (cell.blocks) resolveImageSentinels(cell.blocks, renamed, depth + 1)
        }
      }
    }
    if (b.children) resolveImageSentinels(b.children, renamed, depth + 1)
  }
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
          const ext = mimeExt(mime)
          img = { filename: `image_${String(imageIndex).padStart(3, "0")}.${ext}`, data: new Uint8Array(bin.data), mime }
          resolved.set(storageId, img)
          images.push({ filename: img.filename, data: img.data, mimeType: img.mime, source: bin.name })
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
      const ext = mimeExt(mime)
      const filename = `image_${String(imageIndex).padStart(3, "0")}.${ext}`
      const data = new Uint8Array(bin.data)
      images.push({ filename, data, mimeType: mime, source: bin.name })
      blocks.push({ type: "image", text: filename, imageData: { data, mimeType: mime, filename: bin.name } })
      // 머리말·각주 안 표를 편 글의 sentinel 도 이 파일을 가리킨다 (본문 image 블록이 없던 그림)
      renamed.set(storageId, filename)
    }
  }

  resolveImageSentinels(blocks, renamed)
  return images
}

/** BinData 스토리지의 모든 파일을 FileIndex 순회로 수집 — 엔트리명은 "BIN%04X.ext" 16진.
 *  파서(이미지 추출)와 렌더 어댑터(#75 HWP5)가 공유한다 */
export function collectHwp5BinData(fileIndex: BinCfbEntry[] | undefined): Map<number, { data: Buffer; name: string }> {
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
  return binDataMap
}

/** Lenient CFB: BinData 엔트리 수집 — 엔트리명 "BIN%04X.ext" 16진 */
export function collectHwp5BinDataLenient(lcfb: LenientCfbContainer): Map<number, { data: Buffer; name: string }> {
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
  return binDataMap
}

/** OLE2 BinData 스토리지(FileIndex)에서 이미지 추출, blocks의 image 블록과 매핑 */
export function extractHwp5Images(
  fileIndex: BinCfbEntry[] | undefined,
  blocks: IRBlock[],
  warnings: ParseWarning[],
  sweepUnreferenced?: boolean,
): ExtractedImage[] {
  const binDataMap = collectHwp5BinData(fileIndex)

  if (binDataMap.size === 0) {
    // 이미지 블록이 있는데 BinData가 없으면 sentinel 정리만 수행
    resolveImageSentinels(blocks, new Map())
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
  const binDataMap = collectHwp5BinDataLenient(lcfb)
  if (binDataMap.size === 0) {
    resolveImageSentinels(blocks, new Map())
    return []
  }
  return resolveImageBlocks(binDataMap, blocks, warnings, sweepUnreferenced)
}
