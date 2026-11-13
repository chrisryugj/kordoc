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
const BI_RLE8 = 1
const BI_RLE4 = 2
const BI_BITFIELDS = 3
const BI_ALPHABITFIELDS = 6
/** 폭·높이 상한 — 비정상 헤더에 의한 과대 할당 방지 */
const MAX_DIM = 0x7fff
/**
 * 총 픽셀(W×H) 상한 — MAX_DIM 은 각 변만 제한하므로 곱의 폭주(과대 할당 + 긴 deflateSync
 * 동기 블로킹)를 별도로 차단한다. raw 저장 BMP 는 상위 inflate 100MB 캡을 우회하므로 필요.
 * 36MP = A4 전면 600dpi 스캔(≈35MP)까지 허용 — 그 이상은 rgba+raw 로 300MB 를 넘겨
 * MCP 서버 이벤트루프를 수 초 세우므로 원본 바이트 폴백으로 돌린다.
 */
export const MAX_PIXELS = 36_000_000

/**
 * BMP → PNG(8bit RGBA). 지원 범위는 bmpToRgba 와 같다. 읽지 못하면 null 을 반환하여
 * 호출부가 원본 바이트로 폴백하게 한다.
 */
export function bmpToPng(bmp: Uint8Array): Uint8Array | null {
  const px = bmpToRgba(bmp)
  return px && encodePng(px.width, px.height, px.data)
}

/**
 * BMP → 8bit RGBA 픽셀 (Microsoft BMP 공개 명세). 지원: OS/2 BITMAPCOREHEADER(12)·BITMAPINFOHEADER(40) 이상(V4·V5),
 * 1·4·8비트 팔레트, 16비트(555·BITFIELDS)·24·32비트(BI_RGB·BITFIELDS), BI_RLE8·BI_RLE4, bottom-up(양수 높이)/top-down(음수).
 * 그 밖(BI_JPEG·BI_PNG 등)·잘린 파일·상한을 넘는 크기는 null
 */
export function bmpToRgba(bmp: Uint8Array): { data: Uint8Array; width: number; height: number } | null {
  if (bmp.length < 26 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) return null // "BM"
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength)
  const dataOffset = dv.getUint32(10, true)
  const headerSize = dv.getUint32(14, true)
  const core = headerSize === 12
  if ((!core && headerSize < 40) || bmp.length < 14 + headerSize) return null

  const width = core ? dv.getUint16(18, true) : dv.getInt32(18, true)
  const rawHeight = core ? dv.getInt16(20, true) : dv.getInt32(22, true)
  const bitCount = dv.getUint16(core ? 24 : 28, true)
  const compression = core ? BI_RGB : dv.getUint32(30, true)
  if (width <= 0 || rawHeight === 0) return null
  if (width > MAX_DIM || Math.abs(rawHeight) > MAX_DIM) return null
  const topDown = rawHeight < 0
  const height = Math.abs(rawHeight)
  // 총 픽셀 상한 검사 — rgba/raw 할당·deflate 전에 조기 차단 (각 변은 MAX_DIM 이하여도 곱은 폭주 가능)
  if (width * height > MAX_PIXELS) return null

  const rle = compression === BI_RLE8 || compression === BI_RLE4
  if (rle && (topDown || bitCount !== (compression === BI_RLE8 ? 8 : 4))) return null
  // 16·32비트 채널 마스크 — 16비트 BI_RGB 는 555. 마스크는 40바이트 헤더 바로 뒤든 V2 이상 헤더 안이든 항상 파일 오프셋 54 에 있다
  const fields = compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS
  let masks: number[] | null = null
  if (fields) {
    if ((bitCount !== 16 && bitCount !== 32) || bmp.length < 70) return null
    const alpha = compression === BI_ALPHABITFIELDS || headerSize >= 56
    masks = [dv.getUint32(54, true), dv.getUint32(58, true), dv.getUint32(62, true), alpha ? dv.getUint32(66, true) : 0]
  } else if (compression === BI_RGB && bitCount === 16) masks = [0x7c00, 0x03e0, 0x001f, 0]
  else if (compression !== BI_RGB && !rle) return null
  if (![1, 4, 8, 16, 24, 32].includes(bitCount)) return null

  // 팔레트(1·4·8비트) — 헤더 뒤(40바이트 헤더의 BITFIELDS 마스크 뒤). 항목은 BGR(core) 또는 BGRx
  let palette: Uint8Array | null = null
  if (bitCount <= 8) {
    const start = 14 + headerSize + (headerSize === 40 && fields ? (compression === BI_ALPHABITFIELDS ? 16 : 12) : 0)
    const entry = core ? 3 : 4
    const want = (core ? 0 : dv.getUint32(46, true)) || 1 << bitCount
    const count = Math.min(want, 256, Math.floor((Math.min(dataOffset, bmp.length) - start) / entry))
    if (count <= 0) return null
    palette = new Uint8Array(256 * 3) // 범위 밖 인덱스는 검정
    for (let k = 0; k < count; k++) {
      const o = start + k * entry
      palette[k * 3] = bmp[o + 2]; palette[k * 3 + 1] = bmp[o + 1]; palette[k * 3 + 2] = bmp[o]
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  const putIndex = (dst: number, k: number) => {
    rgba[dst] = palette![k * 3]; rgba[dst + 1] = palette![k * 3 + 1]; rgba[dst + 2] = palette![k * 3 + 2]; rgba[dst + 3] = 255
  }
  if (rle) {
    if (dataOffset >= bmp.length) return null
    decodeRle(bmp, dataOffset, compression === BI_RLE4, width, height, (x, y, k) => putIndex(((height - 1 - y) * width + x) * 4, k))
    return { data: rgba, width, height }
  }

  // 행 스트라이드 — 4바이트 경계 패딩
  const rowStride = ((width * bitCount + 31) >>> 5) * 4
  if (dataOffset + rowStride * height > bmp.length) return null // 잘린 파일
  const channels = masks?.map(maskChannel)
  let anyAlpha = 0
  for (let y = 0; y < height; y++) {
    // bottom-up 은 첫 행이 이미지 맨 아래 → 뒤집어 읽는다
    const row = dataOffset + (topDown ? y : height - 1 - y) * rowStride
    let dst = y * width * 4
    for (let x = 0; x < width; x++, dst += 4) {
      if (palette) {
        const bit = x * bitCount
        putIndex(dst, (bmp[row + (bit >>> 3)] >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1))
      } else if (channels) {
        const v = bitCount === 16 ? dv.getUint16(row + x * 2, true) : dv.getUint32(row + x * 4, true)
        for (let c = 0; c < 4; c++) rgba[dst + c] = channels[c](v)
      } else {
        // BMP 픽셀은 BGR(A) 순
        const src = row + x * (bitCount >> 3)
        rgba[dst] = bmp[src + 2]     // R
        rgba[dst + 1] = bmp[src + 1] // G
        rgba[dst + 2] = bmp[src]     // B
        const a = bitCount === 32 ? bmp[src + 3] : 255
        rgba[dst + 3] = a
        anyAlpha |= a
      }
    }
  }

  // 32bpp BI_RGB 의 4번째 바이트는 "미정의" — 전부 0 이면 전면 투명으로 오해되므로
  // 불투명(255)으로 승격한다. 실제 알파가 있으면(anyAlpha!=0) 그대로 보존.
  if (bitCount === 32 && !channels && anyAlpha === 0) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  }

  return { data: rgba, width, height }
}

/** 마스크 하나 → 8비트 채널 값. 마스크가 0 이면(알파 없음) 255 */
function maskChannel(mask: number): (v: number) => number {
  if (!mask) return () => 255
  let shift = 0
  while (!((mask >>> shift) & 1)) shift++
  const max = mask >>> shift
  return v => Math.round((((v & mask) >>> shift) * 255) / max)
}

/**
 * BI_RLE8·BI_RLE4 — (반복 수, 값) 쌍. 반복 수 0 은 escape: 0 EOL(줄 끝) · 1 EOB(비트맵 끝) · 2 delta(dx, dy) · 3 이상은
 * absolute mode(그 수만큼 픽셀을 그대로 저장, 2바이트 경계까지 패딩). RLE4 는 한 바이트에 픽셀 둘(상위 4비트 먼저). 건너뛴 픽셀은 팔레트 0번.
 * y 는 아래에서 위로 센다
 */
function decodeRle(b: Uint8Array, start: number, four: boolean, width: number, height: number, put: (x: number, y: number, k: number) => void): void {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 0)
  const set = (x: number, y: number, k: number) => { if (x < width && y < height) put(x, y, k) }
  let x = 0, y = 0, i = start
  while (i + 1 < b.length && y < height) {
    const n = b[i], v = b[i + 1]
    i += 2
    if (n > 0) {
      for (let k = 0; k < n; k++, x++) set(x, y, four ? (k & 1 ? v & 15 : v >> 4) : v)
    } else if (v === 0) {
      x = 0; y++
    } else if (v === 1) {
      return
    } else if (v === 2) {
      x += b[i] ?? 0; y += b[i + 1] ?? 0; i += 2
    } else {
      for (let k = 0; k < v; k++, x++) set(x, y, four ? ((b[i + (k >> 1)] ?? 0) >> (k & 1 ? 0 : 4)) & 15 : b[i + k] ?? 0)
      const bytes = four ? (v + 1) >> 1 : v
      i += bytes + (bytes & 1)
    }
  }
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

/** 8bit RGBA 픽셀 버퍼 → PNG (PDF 이미지 XObject 추출에서도 사용) */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
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

interface InlineImage {
  filename: string
  data: Uint8Array
  mimeType: string
}

/**
 * 마크다운의 이미지 참조를 base64 data URI 로 치환해 자체 완결형 마크다운을 만든다.
 * 두 방출 형태를 모두 커버한다:
 * - `![image](FILENAME)` / `![image](images/FILENAME)` — 일반 문단 (CLI 접두사 포함)
 * - `<img src="FILENAME">` — 병합/중첩 표 셀 (table/builder.ts HTML 표 경로).
 *   이걸 빼면 CLI `--inline-images` 가 이미지 저장을 생략하면서 표 셀 이미지만
 *   dangling 참조로 유실된다.
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
  // 파일명 → data URI 사전 구축 후 단일 패스 치환 — 이미지 k개마다 전문 재스캔하던
  // O(k²) 제거. 맵에 없는 파일명 참조는 원문 그대로 둔다 (기존 계약 동일).
  const uris = new Map<string, string>()
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
    uris.set(img.filename, `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`)
  }
  if (uris.size === 0) return markdown
  // FILENAME 과 images/FILENAME 접두사를 모두 정확한 파일명 기준으로 치환
  let out = markdown.replace(/!\[image\]\((?:images\/)?([^()\s]+)\)/g, (m, name: string) => {
    const uri = uris.get(name)
    return uri !== undefined ? `![image](${uri})` : m
  })
  out = out.replace(/(<img\b[^>]*\bsrc=")(?:images\/)?([^"]*)(")/g, (m, pre: string, name: string, post: string) => {
    const uri = uris.get(name)
    return uri !== undefined ? `${pre}${uri}${post}` : m
  })
  return out
}
