/**
 * HWPX 이미지 추출 (parser.ts에서 분리).
 * blocks의 image ref를 ZIP 바이너리로 해제 — ref 단위 dedupe·실패 캐시·ZIP bomb 가드.
 */

import type JSZip from "jszip"
import { KordocError, isPathTraversal } from "../utils.js"
import type { ExtractedImage, IRBlock, IRCell, ParseWarning } from "../types.js"
import { MAX_DECOMPRESS_SIZE, MAX_XML_DEPTH } from "./parser-shared.js"
import { detectImageMime } from "../hwp5/images.js"

// ─── 이미지 추출 ───────────────────────────────────

/** 확장자 → MIME 타입 */
function imageExtToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg": case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "bmp": return "image/bmp"
    case "tif": case "tiff": return "image/tiff"
    case "wmf": return "image/wmf"
    case "emf": return "image/emf"
    case "svg": return "image/svg+xml"
    default: return "application/octet-stream"
  }
}

/** MIME → 확장자 */
function mimeToExt(mime: string): string {
  if (mime.includes("jpeg")) return "jpg"
  if (mime.includes("png")) return "png"
  if (mime.includes("gif")) return "gif"
  if (mime.includes("bmp")) return "bmp"
  if (mime.includes("tiff")) return "tif"
  if (mime.includes("wmf")) return "wmf"
  if (mime.includes("emf")) return "emf"
  if (mime.includes("svg")) return "svg"
  return "bin"
}

/** 이미지 블록 재귀 수집 — 표 셀 내부(IRCell.blocks)에 중첩된 이미지 포함 (v3.0) */
function collectImageBlocks(blocks: IRBlock[], out: { block: IRBlock; ownerCell?: IRCell }[], ownerCell?: IRCell, depth = 0): void {
  if (depth > MAX_XML_DEPTH) return
  for (const block of blocks) {
    if (block.type === "image") {
      out.push({ block, ownerCell })
    } else if (block.type === "table" && block.table) {
      for (const row of block.table.cells) {
        for (const cell of row) {
          if (cell.blocks?.length) collectImageBlocks(cell.blocks, out, cell, depth + 1)
        }
      }
    }
  }
}

/**
 * blocks에서 type="image" 블록의 참조를 ZIP에서 실제 바이너리로 변환.
 *
 * sweepUnreferenced가 참이면(전체 문서 파싱 시) 본문 워크가 못 닿는 BinData
 * 이미지 — 머리말/꼬리말 안 그림, borderFill imgBrush(셀 배경 이미지) 등 — 를
 * 문서 끝에 image 블록으로 보강한다. 위치는 부정확하지만 바이트 무음 유실을 막는다.
 */
export async function extractImagesFromZip(
  zip: JSZip,
  blocks: IRBlock[],
  decompressed: { total: number },
  warnings?: ParseWarning[],
  sweepUnreferenced?: boolean,
): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = []
  let imageIndex = 0
  // 본문 참조로 소비된 ZIP 경로 — 스윕 단계에서 중복 추출 방지
  const usedPaths = new Set<string>()

  const imageBlocks: { block: IRBlock; ownerCell?: IRCell }[] = []
  collectImageBlocks(blocks, imageBlocks)

  // 같은 ref를 참조하는 개체가 수천 개일 수 있다(도형 반복 등) — ref당 1회만
  // 해제·변환하고 데이터 버퍼를 공유한다 (블록마다 zip 재해제하면 메모리 폭발).
  // 실패도 캐시해 경고는 1회만. 캐시 히트는 새 해제가 아니므로 ZIP bomb 가드에 가산하지 않는다.
  const resolved = new Map<string, ExtractedImage | null>()

  for (const { block, ownerCell } of imageBlocks) {
    if (block.type !== "image" || !block.text) continue

    const ref = block.text
    let img = resolved.get(ref)
    if (img === undefined) {
      img = null
      // BinData/ 폴더 내에서 참조 파일 찾기
      // HWPX binaryItemIDRef는 확장자 없이 오는 경우가 많음 (예: "image1" → "BinData/image1.bmp")
      const candidates = [
        `BinData/${ref}`,
        `Contents/BinData/${ref}`,
        ref, // 절대 경로일 수도 있음
      ]

      // 확장자 없는 ref인 경우 ZIP에서 매칭 파일 탐색
      let resolvedPath: string | null = null
      if (!ref.includes(".")) {
        const prefixes = [`BinData/${ref}`, `Contents/BinData/${ref}`]
        for (const prefix of prefixes) {
          const match = zip.file(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-zA-Z0-9]+$`))
          if (match.length > 0) { resolvedPath = match[0].name; break }
        }
      }

      const allCandidates = resolvedPath ? [resolvedPath, ...candidates] : candidates
      for (const path of allCandidates) {
        if (isPathTraversal(path)) continue
        const file = zip.file(path)
        if (!file) continue

        try {
          const data = await file.async("uint8array")
          decompressed.total += data.length
          if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")

          const ext = path.includes(".") ? (path.split(".").pop() || "png") : "png"
          const mimeType = imageExtToMime(ext)
          imageIndex++
          const filename = `image_${String(imageIndex).padStart(3, "0")}.${mimeToExt(mimeType)}`

          img = { filename, data, mimeType }
          images.push(img)
          usedPaths.add(path)
          break
        } catch (err) {
          if (err instanceof KordocError) throw err
          // 개별 이미지 실패는 경고로 처리
        }
      }

      if (!img) warnings?.push({ page: block.pageNumber, message: `이미지 파일 없음: ${ref}`, code: "SKIPPED_IMAGE" })
      resolved.set(ref, img)
    }

    if (!img) {
      // image 블록을 paragraph로 전환 (참조만 남김 — 사용자 그림설명이 있으면 함께)
      block.type = "paragraph"
      block.text = `[이미지: ${ref}]`
      // 교체값은 함수로 — 문자열이면 ref 안의 $&, $' 등이 특수 패턴으로 확장된다
      if (ownerCell) ownerCell.text = ownerCell.text.replace(`![image](${ref})`, () => `[이미지: ${ref}]`)
      continue
    }

    // 블록 텍스트를 참조 파일명으로 교체
    const filename = img.filename
    block.text = filename
    block.imageData = { data: img.data, mimeType: img.mimeType, filename: ref }
    // 셀 내부 이미지 — 셀 평탄화 텍스트의 참조도 파일명으로 갱신 (교체값 함수 — $ 확장 방지)
    if (ownerCell) ownerCell.text = ownerCell.text.replace(`![image](${ref})`, () => `![image](${filename})`)
  }

  // 본문 미참조 BinData 이미지 스윕 — 꼬리말/머리말 안 pic, imgBrush 배경 등.
  // 확장자 없거나 낯선 확장자는 매직바이트로 판별하고, 이미지가 아니면(OLE 등) 건너뛴다.
  if (sweepUnreferenced) {
    const binEntries = zip.file(/(?:^|\/)BinData\//i)
    for (const file of binEntries) {
      if (file.dir || usedPaths.has(file.name) || isPathTraversal(file.name)) continue
      try {
        const data = await file.async("uint8array")
        decompressed.total += data.length
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")

        const ext = file.name.includes(".") ? (file.name.split(".").pop() || "") : ""
        let mimeType = imageExtToMime(ext)
        if (mimeType === "application/octet-stream") {
          const sniffed = detectImageMime(data)
          if (!sniffed) continue // 이미지 아님 (OLE 개체 등)
          mimeType = sniffed
        }
        imageIndex++
        const filename = `image_${String(imageIndex).padStart(3, "0")}.${mimeToExt(mimeType)}`
        const img: ExtractedImage = { filename, data, mimeType }
        images.push(img)
        blocks.push({ type: "image", text: filename, imageData: { data, mimeType, filename: file.name } })
      } catch (err) {
        if (err instanceof KordocError) throw err
        warnings?.push({ message: `이미지 추출 실패: ${file.name}`, code: "SKIPPED_IMAGE" })
      }
    }
  }

  return images
}
