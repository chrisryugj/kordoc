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

/** OCR 경로로 보내는 이미지 형식 */
export type ImageKind = "png" | "jpeg" | "webp" | "tiff" | "gif" | "avif" | "heic" | "bmp" | "pcx" | "dcx"

/** BMP info header 크기 — OS/2(12)·BITMAPINFOHEADER(40)·V2·V3·OS/2 2.x·V4·V5 */
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124])

/**
 * 매직 바이트로 이미지 형식을 판별 — PNG·JPEG·WebP·TIFF·GIF·AVIF·HEIC/HEIF·BMP·PCX·DCX. 아니면 null.
 * AVIF 와 HEIC 는 둘 다 ISOBMFF `ftyp` box 라 brand 로 구분한다(avif 가 있으면 AVIF). TGA 처럼 시그니처가 없는 형식은 판별하지 못한다
 */
export function imageFormat(buffer: ArrayBuffer): ImageKind | null {
  if (buffer.byteLength < 12) return null
  const b = new Uint8Array(buffer, 0, Math.min(128, buffer.byteLength))
  const at = (o: number, s: string) => o + s.length <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0))
  // PNG: \x89PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"
  // JPEG: \xFF\xD8\xFF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg"
  // WebP: RIFF....WEBP
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp"
  // TIFF·BigTIFF (II little / MM big endian)
  if (at(0, "II*\0") || at(0, "MM\0*") || at(0, "II+\0") || at(0, "MM\0+")) return "tiff"
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif"
  if (at(0, "BM") && buffer.byteLength >= 26 && BMP_HEADER_SIZES.has(new DataView(buffer).getUint32(14, true))) return "bmp"
  if (b[0] === 0xb1 && b[1] === 0x68 && b[2] === 0xde && b[3] === 0x3a) return "dcx"
  // PCX 시그니처는 첫 바이트 0x0A 하나뿐이라 헤더 128바이트(버전·RLE·비트 수·예약 0·plane 수)까지 확인한다
  if (b.length >= 128 && b[0] === 0x0a && [0, 2, 3, 4, 5].includes(b[1]) && b[2] === 1 && [1, 2, 4, 8].includes(b[3]) && b[64] === 0 && [1, 2, 3, 4].includes(b[65])) return "pcx"
  if (at(4, "ftyp")) {
    const size = Math.min(new DataView(buffer).getUint32(0), b.length)
    const brands: string[] = []
    for (let o = 8; o + 4 <= size; o += o === 8 ? 8 : 4) brands.push(String.fromCharCode(...b.subarray(o, o + 4)))
    if (brands.some(x => x === "avif" || x === "avis")) return "avif"
    if (brands.some(x => /^(?:hei[cxms]|hev[cxms]|mif1|msf1)$/.test(x))) return "heic"
  }
  return null
}

/** 래스터 이미지 — OCR 파싱 경로로 라우팅 */
export function isImageFile(buffer: ArrayBuffer): boolean {
  return imageFormat(buffer) !== null
}

/** 판별은 되지만 지원하지 않는 이미지 형식의 이름 — "지원하지 않는 파일 형식" 대신 이 이름을 오류에 담는다 */
export function unsupportedImageName(buffer: ArrayBuffer): string | null {
  const b = new Uint8Array(buffer, 0, Math.min(48, buffer.byteLength))
  const at = (o: number, s: string) => o + s.length <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (at(0, "\0\0\0\x0CjP  \r\n\x87\n") || (b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51)) return "JPEG 2000"
  if (at(0, "\0\0\0\x0CJXL \r\n\x87\n") || (b[0] === 0xff && b[1] === 0x0a)) return "JPEG XL"
  if (at(0, "8BPS")) return "PSD"
  if (b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return "WMF"
  if (b[0] === 1 && b[1] === 0 && b[2] === 0 && b[3] === 0 && at(40, " EMF")) return "EMF"
  if (at(0, "%!PS") || (b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6)) return "PostScript·EPS"
  if (at(0, "AT&TFORM")) return "DjVu"
  return null
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
  if (isImageFile(buffer)) return "image"
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
 * HWPX, XLSX, DOCX, PPTX 모두 ZIP이므로 내부 파일로 구분.
 */
export async function detectZipFormat(buffer: ArrayBuffer): Promise<"hwpx" | "xlsx" | "docx" | "pptx" | "unknown"> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    // XLSX: xl/workbook.xml
    if (zip.file("xl/workbook.xml")) return "xlsx"
    // DOCX: word/document.xml
    if (zip.file("word/document.xml")) return "docx"
    // PPTX: HWPX로 오인하지 않도록 presentation.xml 로 감지
    if (zip.file("ppt/presentation.xml")) return "pptx"
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
