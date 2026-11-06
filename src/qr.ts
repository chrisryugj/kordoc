/**
 * 그림 속 QR 코드 값 읽기 (#187, `qrCodes: true` 일 때만).
 *
 * zxing-wasm(zxing-cpp)은 켰을 때만 불러온다. wasm 은 패키지 안 파일을 넘긴다 — 넘기지 않으면 CDN 에서 받는다.
 * QR 형식만 읽고, 해독한 값만 그림마다 중복 없이 낸다. 읽기 실패는 값 없음으로 둔다.
 */

import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { MAX_PIXELS } from "./image/transcode.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "./types.js"

/** RGBA 픽셀 (PDF 는 디코딩한 픽셀이 이미 있다) */
export interface QrPixels { data: Uint8Array; width: number; height: number }
/** 그림 파일 바이트(PNG·JPEG·BMP·GIF) 또는 RGBA 픽셀 → 해독한 QR 값(읽은 순서, 중복 없음) */
export type QrReader = (image: Uint8Array | QrPixels) => Promise<string[]>

let loading: Promise<QrReader | null> | undefined

/** zxing-wasm 이 없거나 못 열면 null */
export function loadQrReader(): Promise<QrReader | null> {
  return loading ??= (async () => {
    try {
      const zx = await import("zxing-wasm/reader")
      const wasm = await readFile(createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm"))
      await zx.prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(wasm).buffer }, fireImmediately: true })
      return async image => {
        const input = image instanceof Uint8Array ? image
          : { data: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength), width: image.width, height: image.height, colorSpace: "srgb" as const }
        const found = await zx.readBarcodes(input as Parameters<typeof zx.readBarcodes>[0], { formats: ["QRCode"] }).catch(() => [])
        return [...new Set(found.filter(r => r.isValid && r.text).map(r => r.text))]
      }
    } catch {
      return null
    }
  })()
}

/** PNG·JPEG·BMP 헤더의 가로×세로 화소 수 — 그 밖 형식은 0 (zxing 이 읽는 GIF 는 작다) */
export function imagePixelCount(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b[0] === 0x89 && b[1] === 0x50 && b.length >= 24) return v.getUint32(16) * v.getUint32(20)
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return Math.abs(v.getInt32(18, true) * v.getInt32(22, true))
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0
  // JPEG — SOFn(C0~CF, C4·C8·CC 제외) 의 높이·너비
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return v.getUint16(i + 5) * v.getUint16(i + 7)
    if (m === 0xff) { i++; continue } // 채움 바이트
    i += m === 0x01 || (m >= 0xd0 && m <= 0xd8) ? 2 : 2 + v.getUint16(i + 2) // 길이 없는 표지 · 길이 있는 구간
  }
  return 0
}

export const QR_UNAVAILABLE: ParseWarning = {
  code: "PARTIAL_PARSE",
  message: "QR 코드를 읽으려면 optional dependency 'zxing-wasm' 이 필요합니다 — `npm install zxing-wasm` 후 다시 실행하세요",
}

/**
 * 블록 트리(자식·표 칸·캡션)의 그림 블록에 QR 값(`qr`)을 붙인다. 그림 바이트는 결과 `images`(파일명) 또는 블록 `imageData`.
 * 값을 하나라도 붙였으면 true
 */
export async function readImageQrCodes(blocks: IRBlock[], images: ExtractedImage[] | undefined, warnings: ParseWarning[]): Promise<boolean> {
  const targets: IRBlock[] = []
  const walk = (list: IRBlock[] | undefined, depth: number) => {
    if (!list || depth > 64) return
    for (const b of list) {
      if (b.type === "image" && b.text) targets.push(b)
      walk(b.children, depth + 1)
      if (b.table) {
        for (const row of b.table.cells) for (const cell of row) walk(cell.blocks, depth + 1)
        walk(b.table.captionBlocks, depth + 1)
      }
    }
  }
  walk(blocks, 0)
  if (!targets.length) return false
  const read = await loadQrReader()
  if (!read) { warnings.push(QR_UNAVAILABLE); return false }
  const bytes = new Map(images?.map(i => [i.filename, i.data]))
  // 같은 그림(파일명)은 한 번만 읽는다
  const byName = new Map<string, string[]>()
  let found = false
  for (const b of targets) {
    const name = b.text!
    if (!byName.has(name)) {
      const data = bytes.get(name) ?? b.imageData?.data
      // zxing 이 wasm 안에서 RGBA 로 풀고 wasm 메모리는 줄지 않는다 — PDF 그림과 같은 화소 상한
      byName.set(name, data && imagePixelCount(data) <= MAX_PIXELS ? await read(data) : [])
    }
    const qr = byName.get(name)!
    if (qr.length) { b.qr = qr; found = true }
  }
  return found
}
