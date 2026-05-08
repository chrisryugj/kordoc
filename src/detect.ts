/** 매직 바이트 기반 파일 포맷 감지 */

import JSZip from "jszip"
import type { FileType } from "./types.js"
import { parseLenientCfb } from "./hwp5/cfb-lenient.js"

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

/**
 * HWP 3.x (한글 워드프로세서 3.0): "HWP Document File V3.00 \x1A\x01\x02\x03\x04\x05" 30 byte.
 * CFB(OLE2) 컨테이너 아닌 단일 binary stream — isOldHwpFile 과 magic 이 다르다.
 */
const HWP3_PREFIX = new TextEncoder().encode("HWP Document File V3.00")
export function isHwp3File(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < HWP3_PREFIX.length) return false
  const head = new Uint8Array(buffer, 0, HWP3_PREFIX.length)
  for (let i = 0; i < HWP3_PREFIX.length; i++) {
    if (head[i] !== HWP3_PREFIX[i]) return false
  }
  return true
}

/** PDF 문서: %PDF */
export function isPdfFile(buffer: ArrayBuffer): boolean {
  const b = magicBytes(buffer)
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46
}

/** HWPML (XML 기반 한컴 문서): <?xml ... <HWPML */
export function isHwpmlFile(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength))
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "")
  return head.trimStart().startsWith("<?xml") && head.includes("<HWPML")
}

/** 동기 포맷 감지 — ZIP은 모두 "hwpx"로 반환 (하위 호환) */
export function detectFormat(buffer: ArrayBuffer): FileType {
  if (buffer.byteLength < 4) return "unknown"
  if (isHwp3File(buffer)) return "hwp3"
  if (isZipFile(buffer)) return "hwpx"
  if (isOldHwpFile(buffer)) return "hwp"
  if (isPdfFile(buffer)) return "pdf"
  if (isHwpmlFile(buffer)) return "hwpml"
  return "unknown"
}

/**
 * OLE2 컨테이너 내부 스트림 기반 포맷 세분화.
 * HWP 5.x, XLS 모두 OLE2이므로 스트림 이름으로 구분.
 *  - "Workbook" 또는 "Book" → 'xls'
 *  - 그 외 (FileHeader 등) → 'hwp'
 */
export function detectOle2Format(buffer: ArrayBuffer): "hwp" | "xls" | "unknown" {
  try {
    const cfb = parseLenientCfb(Buffer.from(buffer))
    const names = cfb.entries().map(e => e.name)
    if (names.includes("Workbook") || names.includes("Book")) return "xls"
    if (names.includes("FileHeader")) return "hwp"
    // FileHeader 없어도 BodyText/DocInfo 있으면 hwp
    if (names.some(n => n === "DocInfo" || n.startsWith("Section"))) return "hwp"
    return "unknown"
  } catch {
    return "unknown"
  }
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
