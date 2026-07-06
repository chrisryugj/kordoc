/**
 * 순수 JS BMP → PNG 트랜스코더 + 마크다운 이미지 인라이너.
 *
 * HWP5 BinData 임베드 이미지는 비압축 BMP(수 MB)인 경우가 많다. AI 에이전트가
 * 자체 완결형 마크다운을 받도록, BMP 를 PNG(무손실 압축)로 변환한 뒤 base64
 * data URI 로 마크다운에 인라인한다.
 *
 * 의존성 최소화 원칙 — Node 내장(node:zlib, Buffer)만 사용한다.
 */

import { deflateSync } from "node:zlib"

// ─── CRC32 (PNG 청크용) ──────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

/** 표준 PNG CRC32 (다항식 0xEDB88320) */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ─── BMP 디코드 ──────────────────────────────────────

const BI_RGB = 0
/** 폭·높이 상한 — 비정상 헤더에 의한 과대 할당 방지 */
const MAX_DIM = 0x7fff

/**
 * 비압축 BMP(24/32bpp, BI_RGB) → PNG(8bit RGBA).
 *
 * 지원: BITMAPFILEHEADER + BITMAPINFOHEADER(biSize>=40), biBitCount 24/32,
 * biCompression BI_RGB, bottom-up(양수 biHeight)/top-down(음수), 24bpp 4바이트 행 패딩.
 * 미지원 변형(팔레트/8bpp·RLE·BITFIELDS·OS/2 헤더 등)은 null 을 반환하여
 * 호출부가 원본 바이트로 폴백하게 한다.
 */
export function bmpToPng(bmp: Uint8Array): Uint8Array | null {
  // BITMAPFILEHEADER(14) + BITMAPINFOHEADER(40)
  if (bmp.length < 54) return null
  if (bmp[0] !== 0x42 || bmp[1] !== 0x4d) return null // "BM"

  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength)
  const dataOffset = dv.getUint32(10, true)
  const headerSize = dv.getUint32(14, true)
  if (headerSize < 40) return null // OS/2 BITMAPCOREHEADER 등 미지원

  const width = dv.getInt32(18, true)
  const rawHeight = dv.getInt32(22, true)
  const bitCount = dv.getUint16(28, true)
  const compression = dv.getUint32(30, true)

  if (compression !== BI_RGB) return null // RLE / BITFIELDS 미지원
  if (bitCount !== 24 && bitCount !== 32) return null // 팔레트 / 8bpp 등 미지원
  if (width <= 0 || rawHeight === 0) return null
  if (width > MAX_DIM || Math.abs(rawHeight) > MAX_DIM) return null

  const topDown = rawHeight < 0
  const height = Math.abs(rawHeight)
  const bytesPerPixel = bitCount >> 3
  // 행 스트라이드 — 4바이트 경계 패딩 (24bpp 에서 유효)
  const rowStride = (width * bytesPerPixel + 3) & ~3
  if (dataOffset + rowStride * height > bmp.length) return null // 잘린 파일

  const rgba = new Uint8Array(width * height * 4)
  let anyAlpha = 0

  for (let y = 0; y < height; y++) {
    // bottom-up 은 첫 행이 이미지 맨 아래 → 뒤집어 읽는다
    const srcRow = topDown ? y : height - 1 - y
    let src = dataOffset + srcRow * rowStride
    let dst = y * width * 4
    for (let x = 0; x < width; x++) {
      // BMP 픽셀은 BGR(A) 순
      rgba[dst] = bmp[src + 2]     // R
      rgba[dst + 1] = bmp[src + 1] // G
      rgba[dst + 2] = bmp[src]     // B
      const a = bitCount === 32 ? bmp[src + 3] : 255
      rgba[dst + 3] = a
      anyAlpha |= a
      src += bytesPerPixel
      dst += 4
    }
  }

  // 32bpp BI_RGB 의 4번째 바이트는 "미정의" — 전부 0 이면 전면 투명으로 오해되므로
  // 불투명(255)으로 승격한다. 실제 알파가 있으면(anyAlpha!=0) 그대로 보존.
  if (bitCount === 32 && anyAlpha === 0) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  }

  return encodePng(width, height, rgba)
}

// ─── PNG 인코드 (8bit RGBA, color type 6) ────────────

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/** [4B 길이][4B 타입][데이터][4B CRC] 청크 조립. CRC 는 (타입+데이터) 기준. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length)
  body[0] = type.charCodeAt(0)
  body[1] = type.charCodeAt(1)
  body[2] = type.charCodeAt(2)
  body[3] = type.charCodeAt(3)
  body.set(data, 4)

  const out = new Uint8Array(8 + data.length + 4)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false) // 길이(데이터만, big-endian)
  out.set(body, 4)
  dv.setUint32(8 + data.length, crc32(body), false)
  return out
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // IHDR: width, height, bit depth 8, color type 6(RGBA), compression 0, filter 0, interlace 0
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, width, false)
  iv.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 6

  // IDAT: 각 스캔라인 앞에 필터 바이트 0(None) 을 붙인 raw 데이터를 zlib deflate
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: None
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1)
  }
  const idat = deflateSync(raw)

  const ihdrChunk = chunk("IHDR", ihdr)
  const idatChunk = chunk("IDAT", idat)
  const iendChunk = chunk("IEND", new Uint8Array(0))

  const out = new Uint8Array(PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
  let o = 0
  out.set(PNG_SIGNATURE, o); o += PNG_SIGNATURE.length
  out.set(ihdrChunk, o); o += ihdrChunk.length
  out.set(idatChunk, o); o += idatChunk.length
  out.set(iendChunk, o)
  return out
}

// ─── 마크다운 이미지 인라이너 ────────────────────────

/** 정규식 메타문자 이스케이프 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface InlineImage {
  filename: string
  data: Uint8Array
  mimeType: string
}

/**
 * 마크다운의 `![image](FILENAME)` 및 `![image](images/FILENAME)`(CLI 접두사) 참조를
 * base64 data URI 로 치환한다. 별도 이미지 파일 없이 자체 완결형 마크다운이 되어
 * MCP/AI 에이전트 소비에 적합하다.
 *
 * @param opts.compress 기본 true. `image/bmp` 는 PNG 로 트랜스코딩 후 인라인하며,
 *                      트랜스코딩 실패 시 원본 바이트+원본 MIME 으로 폴백한다.
 */
export function inlineImagesIntoMarkdown(
  markdown: string,
  images: ReadonlyArray<InlineImage>,
  opts?: { compress?: boolean },
): string {
  const compress = opts?.compress !== false
  let out = markdown
  for (const img of images) {
    let bytes = img.data
    let mime = img.mimeType
    if (compress && mime === "image/bmp") {
      const png = bmpToPng(img.data)
      if (png) {
        bytes = png
        mime = "image/png"
      }
    }
    const base64 = Buffer.from(bytes).toString("base64")
    const dataUri = `data:${mime};base64,${base64}`
    // FILENAME 과 images/FILENAME 접두사를 모두 정확한 파일명 기준으로 치환
    const re = new RegExp(`!\\[image\\]\\((?:images/)?${escapeRegExp(img.filename)}\\)`, "g")
    out = out.replace(re, () => `![image](${dataUri})`)
  }
  return out
}
