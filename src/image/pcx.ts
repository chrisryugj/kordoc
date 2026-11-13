/**
 * PCX·DCX → 8bit RGBA (ZSoft PCX 공개 명세, Pillow PcxImagePlugin 과 같은 범위).
 * 지원: 1비트 1 plane(흑백)·2·4 plane(헤더 16색 팔레트), 8비트 1 plane(파일 끝 256색 팔레트, 없으면 그레이스케일), 8비트 3 plane(RGB).
 * DCX 는 팩스 소프트웨어가 PCX 여러 장을 묶은 포맷 — dcxPages 로 페이지를 분리한다. 그 외·잘린 파일·상한 초과는 null
 */

import { MAX_PIXELS } from "./transcode.js"

/** DCX 페이지(PCX 바이트) 목록 — 헤더 뒤 오프셋 표(최대 1,023개, 0 으로 끝). DCX 가 아니면 빈 배열 */
export function dcxPages(b: Uint8Array): Uint8Array[] {
  if (b.length < 8 || b[0] !== 0xb1 || b[1] !== 0x68 || b[2] !== 0xde || b[3] !== 0x3a) return []
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), offs: number[] = []
  for (let o = 4; o + 4 <= b.length && offs.length < 1023; o += 4) {
    const off = v.getUint32(o, true)
    if (!off) break
    // 오프셋이 겹치면 같은 페이지를 여러 번 디코딩하게 된다 — 엄격히 증가하지 않으면 거부
    if (off >= b.length || (offs.length && off <= offs[offs.length - 1])) return []
    offs.push(off)
  }
  return offs.map((off, i) => b.subarray(off, offs[i + 1] > off ? offs[i + 1] : b.length))
}

export function pcxToRgba(b: Uint8Array): { data: Uint8Array; width: number; height: number; dpi: number } | null {
  if (b.length < 128 || b[0] !== 0x0a || b[2] !== 1) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const bits = b[3], planes = b[65], line = v.getUint16(66, true)
  const width = v.getUint16(8, true) - v.getUint16(4, true) + 1, height = v.getUint16(10, true) - v.getUint16(6, true) + 1
  const mono = bits === 1 && [1, 2, 4].includes(planes), gray = bits === 8 && planes === 1, rgb = bits === 8 && planes === 3
  if (!(mono || gray || rgb) || width <= 0 || height <= 0 || width * height > MAX_PIXELS || line * 8 < width * bits) return null
  // 헤더의 BytesPerLine 이 너비보다 훨씬 커도 디코딩 버퍼는 RGBA 상한(MAX_PIXELS × 4) 안으로
  const stride = line * planes
  if (stride * height > MAX_PIXELS * 4) return null
  // RLE — 상위 두 비트가 11 인 바이트는 하위 6비트가 반복 횟수, 다음 바이트가 값
  const raw = new Uint8Array(stride * height)
  let i = 128, o = 0
  while (o < raw.length) {
    if (i >= b.length) return null // 잘린 파일
    const c = b[i++]
    if (c < 0xc0) { raw[o++] = c; continue }
    if (i >= b.length) return null
    raw.fill(b[i++], o, Math.min(o + (c & 0x3f), raw.length))
    o += c & 0x3f
  }
  // 8비트 팔레트는 파일 끝 0x0C + 768바이트, 1비트 multi-plane 은 헤더 16색
  const tail = b.length - 769
  const pal = gray ? (tail >= 128 && b[tail] === 0x0c ? b.subarray(tail + 1) : null) : b.subarray(16, 64)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      if (rgb) rgba.set([raw[row + x], raw[row + line + x], raw[row + 2 * line + x], 255], d)
      else {
        let k = 0
        if (mono) for (let p = 0; p < planes; p++) k |= ((raw[row + p * line + (x >> 3)] >> (7 - (x & 7))) & 1) << p
        else k = raw[row + x]
        if (mono && planes === 1) k *= 255
        else if (pal) { rgba.set([pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], 255], d); continue }
        rgba.set([k, k, k, 255], d)
      }
    }
  }
  return { data: rgba, width, height, dpi: v.getUint16(12, true) }
}
