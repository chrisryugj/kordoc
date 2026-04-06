/** 매직 바이트 기반 파일 포맷 감지 */

import JSZip from "jszip"
import type { FileType } from "./types.js"

/** 매직 바이트 뷰 생성 (복사 없이 view) */
function magicBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength))
}

/** ZIP 파일 여부: PK\x03\x04 */
export function isZipFile(buffer: ArrayBuffer): boolean {
  const b = magicBytes(buffer)
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

/** HWPX (ZIP 기반 한컴 문서): PK\x03\x04 — 하위 호환용 */
export function isHwpxFile(buffer: ArrayBuffer): boolean {
  return isZipFile(buffer)
}

/** HWP 5.x (OLE2 바이너리 한컴 문서): \xD0\xCF\x11\xE0 */
export function isOldHwpFile(buffer: ArrayBuffer): boolean {
  const b = magicBytes(buffer)
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0
}

/** PDF 문서: %PDF */
export function isPdfFile(buffer: ArrayBuffer): boolean {
  const b = magicBytes(buffer)
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46
}

/** 동기 포맷 감지 — ZIP은 모두 "hwpx"로 반환 (하위 호환) */
export function detectFormat(buffer: ArrayBuffer): FileType {
  if (buffer.byteLength < 4) return "unknown"
  if (isZipFile(buffer)) return "hwpx"
  if (isOldHwpFile(buffer)) return "hwp"
  if (isPdfFile(buffer)) return "pdf"
  return "unknown"
}

/**
 * ZIP 내부 구조 기반 포맷 세분화.
 * HWPX, XLSX, DOCX 모두 ZIP이므로 내부 파일로 구분.
 */
export async function detectZipFormat(buffer: ArrayBuffer): Promise<"hwpx" | "xlsx" | "docx" | "unknown"> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    // XLSX: xl/workbook.xml
    if (zip.file("xl/workbook.xml")) return "xlsx"
    // DOCX: word/document.xml
    if (zip.file("word/document.xml")) return "docx"
    // HWPX: Contents/ 또는 content.hpf 또는 mimetype
    if (zip.file("Contents/content.hpf") || zip.file("mimetype")) return "hwpx"
    // 기타 ZIP 내에 section 파일이 있으면 HWPX로 추정
    const hasSection = Object.keys(zip.files).some(f => f.startsWith("Contents/"))
    if (hasSection) return "hwpx"
    return "unknown"
  } catch {
    return "unknown"
  }
}
