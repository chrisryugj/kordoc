/** BMP→PNG 트랜스코드 + 마크다운 이미지 인라인 단위 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { inflateSync } from "node:zlib"
import { bmpToPng, inlineImagesIntoMarkdown } from "../src/image/transcode.js"

/** 24bpp BI_RGB(bottom-up) BMP 합성 — pixelsTopDown 은 [r,g,b] 배열(행 우선, 0행=최상단) */
function makeBmp24(width: number, height: number, pixelsTopDown: number[][]): Uint8Array {
  const rowStride = (width * 3 + 3) & ~3
  const pixelDataSize = rowStride * height
  const fileSize = 54 + pixelDataSize
  const buf = Buffer.alloc(fileSize)
  buf[0] = 0x42
  buf[1] = 0x4d // "BM"
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(54, 10) // bfOffBits
  buf.writeUInt32LE(40, 14) // biSize (BITMAPINFOHEADER)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22) // 양수 = bottom-up
  buf.writeUInt16LE(1, 26) // biPlanes
  buf.writeUInt16LE(24, 28) // biBitCount
  buf.writeUInt32LE(0, 30) // biCompression = BI_RGB
  buf.writeUInt32LE(pixelDataSize, 34)
  // bottom-up: 저장 첫 행 = 이미지 최하단 행
  for (let y = 0; y < height; y++) {
    const imgRow = height - 1 - y
    let off = 54 + y * rowStride
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelsTopDown[imgRow * width + x]
      buf[off] = b // BMP 는 BGR 순
      buf[off + 1] = g
      buf[off + 2] = r
      off += 3
    }
  }
  return new Uint8Array(buf)
}

/** PNG 에서 IDAT 청크들을 이어붙여 zlib inflate → raw 스캔라인 */
function inflateIdat(png: Uint8Array): Buffer {
  const buf = Buffer.from(png)
  const parts: Buffer[] = []
  let off = 8 // 시그니처 이후
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString("ascii", off + 4, off + 8)
    if (type === "IDAT") parts.push(buf.subarray(off + 8, off + 8 + len))
    if (type === "IEND") break
    off += 12 + len
  }
  return inflateSync(Buffer.concat(parts))
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe("bmpToPng", () => {
  // 이미지(top-down): [빨강, 초록 / 파랑, 흰색]
  const RED = [255, 0, 0]
  const GREEN = [0, 255, 0]
  const BLUE = [0, 0, 255]
  const WHITE = [255, 255, 255]

  it("2×2 24bpp bottom-up BMP → 유효 PNG, IDAT 가 기대 RGBA 스캔라인으로 복원된다", () => {
    const bmp = makeBmp24(2, 2, [RED, GREEN, BLUE, WHITE])
    const png = bmpToPng(bmp)
    assert.ok(png, "지원 BMP 는 non-null 이어야 함")

    // PNG 시그니처
    assert.deepEqual([...png!.subarray(0, 8)], PNG_SIG)

    // IHDR: 2×2, depth 8, colorType 6(RGBA)
    const b = Buffer.from(png!)
    assert.equal(b.readUInt32BE(16), 2, "IHDR width")
    assert.equal(b.readUInt32BE(20), 2, "IHDR height")
    assert.equal(b[24], 8, "bit depth")
    assert.equal(b[25], 6, "color type RGBA")

    // 스캔라인 복원 — 각 행 앞에 필터 바이트 0, BGR→RGB + bottom-up 뒤집힘 검증
    const raw = inflateIdat(png!)
    assert.equal(raw.length, 2 * (2 * 4 + 1), "raw = height*(width*4 + 1 필터)")
    // scanline 0 (top): 빨강, 초록
    assert.equal(raw[0], 0, "필터 바이트 0")
    assert.deepEqual([...raw.subarray(1, 5)], [255, 0, 0, 255], "(0,0) 빨강 RGBA")
    assert.deepEqual([...raw.subarray(5, 9)], [0, 255, 0, 255], "(1,0) 초록 RGBA")
    // scanline 1 (bottom): 파랑, 흰색
    assert.equal(raw[9], 0, "필터 바이트 0")
    assert.deepEqual([...raw.subarray(10, 14)], [0, 0, 255, 255], "(0,1) 파랑 RGBA")
    assert.deepEqual([...raw.subarray(14, 18)], [255, 255, 255, 255], "(1,1) 흰색 RGBA")
  })

  it("미지원/깨진 입력은 null 을 반환한다", () => {
    assert.equal(bmpToPng(new Uint8Array([1, 2, 3])), null, "너무 짧음")
    assert.equal(bmpToPng(new Uint8Array(54)), null, "'BM' 시그니처 아님")
    // 유효 헤더지만 8bpp(팔레트) → 미지원
    const bmp8 = Buffer.from(makeBmp24(2, 2, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]))
    bmp8.writeUInt16LE(8, 28) // biBitCount = 8
    assert.equal(bmpToPng(new Uint8Array(bmp8)), null, "8bpp 미지원")
  })
})

describe("inlineImagesIntoMarkdown", () => {
  const bmp = makeBmp24(2, 2, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]])
  const img = { filename: "foo.bmp", data: bmp, mimeType: "image/bmp" }

  it("![image](foo.bmp) 를 data:image/png data URI 로 치환한다", () => {
    const out = inlineImagesIntoMarkdown("앞\n![image](foo.bmp)\n뒤", [img])
    assert.match(out, /!\[image\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/)
    assert.ok(!out.includes("![image](foo.bmp)"), "원본 파일 참조는 남지 않아야 함")
    assert.ok(out.includes("앞") && out.includes("뒤"), "주변 텍스트는 보존")
  })

  it("images/ 접두사 참조도 치환한다", () => {
    const out = inlineImagesIntoMarkdown("![image](images/foo.bmp)", [img])
    assert.match(out, /!\[image\]\(data:image\/png;base64,/)
    assert.ok(!out.includes("images/foo.bmp"))
  })

  it("이미지 참조가 없는 텍스트는 그대로 둔다", () => {
    const text = "이미지 참조가 전혀 없는 문서\n일반 텍스트"
    assert.equal(inlineImagesIntoMarkdown(text, [img]), text)
  })

  it("compress:false 는 트랜스코딩 없이 원본 image/bmp 로 인라인한다", () => {
    const out = inlineImagesIntoMarkdown("![image](foo.bmp)", [img], { compress: false })
    assert.match(out, /!\[image\]\(data:image\/bmp;base64,[A-Za-z0-9+/=]+\)/)
    assert.ok(!out.includes("data:image/png"), "BMP 변환이 일어나면 안 됨")
    // base64 가 원본 BMP 바이트와 일치하는지 확인
    const b64 = out.match(/data:image\/bmp;base64,([A-Za-z0-9+/=]+)/)![1]
    assert.deepEqual(new Uint8Array(Buffer.from(b64, "base64")), bmp)
  })
})
