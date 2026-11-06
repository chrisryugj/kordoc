/**
 * pdfjs 에 줄 PDF 사본에서 큰 그림의 표본 바이트를 0 으로 지운다 (#186).
 *
 * pdfjs 는 쪽 op 목록을 만들 때 그림 op 를 먼저 넣고 디코딩은 따로 돌린다. 사전의 /BitsPerComponent 를 0 으로 바꾸면 pdfjs 는
 * 디코딩 전(PDFImage 생성)에 실패하고 실패를 문서 공용으로 기억한다 — op·위치·글·선은 그대로다. 표본도 0 으로 지운다:
 * 표본만 지우면 pdfjs 가 0 바이트를 전체 크기로 색 변환하고 공용 캐시에도 못 넣어 쪽마다 다시 했다(273쪽 문서 3.1 → 9.1초).
 * 지운 그림의 픽셀은 PDFium 이 원본에서 디코딩한다(image-extract.ts).
 * 가로·세로 128px 이하 그림은 지우지 않는다 — 그림 글머리표·화살표 판정(image-bullets.ts·flow-boxes.ts)이 pdfjs 픽셀을 본다.
 *
 * 문서 전체를 문자열로 바꾸지 않고 바이트에서 낱말 자리를 찾아 그 둘레만 문자열로 본다 — Node 문자열 상한(약 512MB)을 넘는
 * PDF 를 문자열로 읽으면 RangeError 로 파싱 전체가 실패했다.
 */

import { createHash } from "node:crypto"

/** 이 크기 이하 그림은 pdfjs 가 디코딩한다 — image-bullets.ts·flow-boxes.ts 의 픽셀 판정 상한과 같다 */
export const SMALL_IMAGE_DIM = 128

export interface BlankedImages {
  /**
   * 원본 스트림(필터 그대로)의 SHA-1 → 같은 원본을 쓰는 그림 사전이 모두 같은가.
   * 해시는 PDFium FPDFImageObj_GetImageDataRaw 와 맞댄다. 사전(색 공간·Decode)이 다르면 원본이 같아도 픽셀이 다르다
   */
  byRaw: Map<string, boolean>
  /** 지운 그림 크기 "가로x세로" — PDFium 이 못 찾는 자리(소프트 마스크 그룹·패턴 안)의 op 가 지운 그림인지 가린다 */
  sizes: Set<string>
}

/** 낱말 앞뒤로 보는 너비 — "N G obj" 의 객체 번호·세대, "/Length N G R", "N endobj" 가 이 안에 든다 */
const NEAR = 64
const isWordByte = (c: number | undefined) => c !== undefined && (c === 0x5f || (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a))

/**
 * `bytes` 를 제자리에서 고친다. /Width·/Height 가 직접 값이고 길이를 아는 그림 스트림만 지운다.
 * 암호 문서, 자체 마스크(/SMask·/Mask·/SMaskInData)가 있는 그림, 다른 그림의 마스크로 쓰이는 스트림,
 * 이미지 마스크(/ImageMask true — pdfjs 는 마스크 op 로 그려 추출하지 않는다)는 건드리지 않는다.
 */
export function blankLargeImageStreams(bytes: Uint8Array): BlankedImages {
  const blanked: BlankedImages = { byRaw: new Map(), sizes: new Set() }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (a: number, b: number) => buf.toString("latin1", Math.max(0, a), Math.min(buf.length, b))
  /** `word` 가 나오는 자리마다(뒤가 낱말 글자가 아닐 때만, 정규식 \b 와 같다) */
  const each = function* (word: string) {
    for (let i = buf.indexOf(word); i >= 0; i = buf.indexOf(word, i + 1)) if (!isWordByte(buf[i + word.length])) yield i
  }
  // 암호 문서는 PDFium 이 돌려주는 원본 바이트가 복호화 뒤라 해시가 맞지 않는다
  if (!each("/Encrypt").next().done) return blanked
  const masks = new Set<string>()
  for (const key of ["/SMask", "/Mask"]) {
    for (const i of each(key)) {
      const ref = /^\s+(\d+)\s+(\d+)\s+R\b/.exec(str(i + key.length, i + key.length + NEAR))
      if (ref) masks.add(`${ref[1]} ${ref[2]}`)
    }
  }
  let lengths: Map<string, number> | undefined
  const dicts = new Map<string, string>()

  // "N G obj" — 앞 숫자 둘은 둘레 문자열로 확인한다
  let pos = 0
  for (;;) {
    let at = buf.indexOf("obj", pos)
    let m: RegExpExecArray | null = null
    // 정규식처럼 일치는 pos 뒤에서만 시작한다 — 앞 숫자를 pos 앞에서 찾지 않는다
    while (at >= 0 && (isWordByte(buf[at + 3]) || !(m = /(\d+)\s+(\d+)\s+$/.exec(str(Math.max(pos, at - NEAR), at))))) at = buf.indexOf("obj", at + 1)
    if (at < 0 || !m) break
    pos = at + 3
    const head = buf.indexOf("stream", pos)
    const end = buf.indexOf("endobj", pos)
    if (head < 0 || (end >= 0 && end < head)) continue
    const dict = str(pos, head)
    const dictStart = pos
    const start = head + 6 + (buf[head + 6] === 0x0d ? 2 : 1)
    let length: number | undefined
    const direct = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict)
    if (direct) length = Number(direct[1])
    else {
      const ref = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(dict)
      if (ref) {
        // 간접 /Length 는 평문 객체 "N G obj 123 endobj" 로 찾는다 (객체 스트림 안이면 모른다)
        lengths ??= indirectLengths()
        length = lengths.get(`${ref[1]} ${ref[2]}`)
      }
    }
    const stop = length === undefined ? -1 : start + length
    // 길이를 모르거나 틀리면 다음 endstream 까지 건너뛴다 — 스트림 바이트를 객체로 읽지 않는다
    if (stop < 0 || !/^\s*endstream/.test(str(stop, stop + 16))) {
      const e = buf.indexOf("endstream", start)
      if (e < 0) break
      pos = e
      continue
    }
    pos = stop
    // 자체 마스크가 있는 그림은 pdfjs 가 알파까지 디코딩한다 — PDFium GetBitmap 은 마스크를 반영하지 않는다
    if (!/\/Subtype\s*\/Image\b/.test(dict) || masks.has(`${m[1]} ${m[2]}`) || /\/(?:SMask|Mask|SMaskInData)\b/.test(dict) || /\/(?:ImageMask|IM)\s+true\b/.test(dict)) continue
    const w = /\/Width\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict), h = /\/Height\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict)
    if (!w || !h || (Number(w[1]) <= SMALL_IMAGE_DIM && Number(h[1]) <= SMALL_IMAGE_DIM)) continue
    // 직접 값 /BitsPerComponent 하나만 — 없거나(JPX)·간접이거나·/DecodeParms 안에도 있으면 어느 것이 그림 값인지 몰라 지우지 않는다
    const bpcs = [...dict.matchAll(/\/BitsPerComponent\s+(\d+)\b(?!\s+\d+\s+R)/g)]
    if (bpcs.length !== 1 || (dict.match(/\/BitsPerComponent\b/g) ?? []).length !== 1) continue
    const bpc = bpcs[0]
    const digits = dictStart + bpc.index! + bpc[0].length - bpc[1].length
    bytes.fill(0x20, digits, digits + bpc[1].length - 1)
    bytes[digits + bpc[1].length - 1] = 0x30 // "0" — 길이 그대로
    const data = bytes.subarray(start, stop)
    const raw = createHash("sha1").update(data).digest("hex")
    const shape = dict.replace(/\s+/g, " ").trim()
    blanked.byRaw.set(raw, (blanked.byRaw.get(raw) ?? true) && (dicts.get(raw) ?? shape) === shape)
    blanked.sizes.add(`${w[1]}x${h[1]}`)
    dicts.set(raw, shape)
    data.fill(0)
  }
  return blanked

  /** 평문 길이 객체 "N G obj 123 endobj" 모두 */
  function indirectLengths(): Map<string, number> {
    const found = new Map<string, number>()
    for (let i = buf.indexOf("obj"); i >= 0; i = buf.indexOf("obj", i + 1)) {
      const num = /(\d+)\s+(\d+)\s+$/.exec(str(i - NEAR, i))
      const value = num && /^\s*(\d+)\s*endobj/.exec(str(i + 3, i + 3 + NEAR))
      if (value) found.set(`${num[1]} ${num[2]}`, Number(value[1]))
    }
    return found
  }
}
