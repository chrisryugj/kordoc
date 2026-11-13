/**
 * 이미지 입력 형식 확장 — TIFF(멀티페이지·G4)·HEIC·AVIF·BMP 도 받아 LLM 이 읽는 이미지로 정규화하고 OCR 한다.
 *
 * 잠근 계약:
 *  1. 멀티페이지 TIFF 는 페이지마다 따로 디코딩한다(imagePageCount·decodeToRgba page)
 *  2. HEIC 는 optional dependency libheif-js 로 디코딩한다 — 이미지 파일·문서 속 이미지 모두
 *  3. AVIF 디코딩 뒤 libvips operation cache 를 비우고, 호스트가 설정한 캐시 한도는 유지한다(heif 로더가 디코딩한 픽셀을 캐시에 남겨 메모리가 쌓였다)
 *  4. parse: 이미지 파일은 페이지별로 이미지 블록과 정규화 이미지(images)를 출력한다. OCR 은 ocr 옵션을 따르고(false 면 생략),
 *     OcrProvider 에는 페이지를 PNG 로 전달한다. pages 로 페이지를 선택한다
 *  5. 감지는 되지만 지원하지 않는 이미지 포맷은 포맷 이름을 넣어 UNSUPPORTED_FORMAT
 *  6. 비트맵 하나만 그리는 WMF 는 그 비트맵으로 변환, 선·텍스트 레코드가 있는 WMF 는 원본 유지. 빈 WMF 는 빈 이미지로 처리
 *  7. PCX(1비트·8비트 팔레트·24비트)·DCX(여러 페이지) 디코딩
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { decodeToRgba, imagePageCount } from "../src/ocr/image-ocr.js"
import { convertImages } from "../src/image/format.js"
import { dropBlankImages } from "../src/image/blank.js"
import { dcxPages, pcxToRgba } from "../src/image/pcx.js"
import { parse } from "../src/index.js"

const fixture = (name: string) => { const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
/** (x, y) 픽셀의 RGB */
const at = (r: { data: Uint8Array; width: number }, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)]
const has = async (name: string) => { try { await import(name); return true } catch { return false } }

/** WMF(placeable 없음) — 레코드는 [함수 번호, 인자 바이트] */
function wmf(records: Array<[number, Uint8Array]>): Uint8Array {
  const body = records.flatMap(([fn, p]) => { const r = new Uint8Array(6 + p.length + (p.length & 1)), v = new DataView(r.buffer); v.setUint32(0, r.length / 2, true); v.setUint16(4, fn, true); r.set(p, 6); return [...r] })
  const out = new Uint8Array(18 + body.length + 6), v = new DataView(out.buffer)
  v.setUint16(0, 1, true); v.setUint16(2, 9, true); v.setUint16(4, 0x300, true); v.setUint32(6, out.length / 2, true)
  out.set(body, 18); v.setUint32(18 + body.length, 3, true) // EOF
  return out
}
/** 2×1 24비트 DIB(빨강·파랑)를 그리는 STRETCHDIB 인자 — srcW 로 원본 사각형 너비를 바꿀 수 있다 */
function stretchDib(srcW = 2): Uint8Array {
  const p = new Uint8Array(22 + 40 + 8), v = new DataView(p.buffer)
  v.setUint32(0, 0x00cc0020, true); v.setInt16(6, 1, true); v.setInt16(8, srcW, true); v.setInt16(14, 1, true); v.setInt16(16, 2, true)
  v.setUint32(22, 40, true); v.setInt32(26, 2, true); v.setInt32(30, 1, true); v.setUint16(34, 1, true); v.setUint16(36, 24, true)
  p.set([0, 0, 255, 255, 0, 0], 62) // BGR: 빨강, 파랑
  return p
}
/** PCX 헤더 + RLE 본문(0xC0 이상 값은 반복 횟수 1 로 인코딩) */
function pcx(bits: number, planes: number, w: number, h: number, line: number, rows: number[], tail?: number[]): Uint8Array {
  const head = new Uint8Array(128), v = new DataView(head.buffer)
  head.set([0x0a, 5, 1, bits]); v.setUint16(8, w - 1, true); v.setUint16(10, h - 1, true); v.setUint16(12, 300, true); head[65] = planes; v.setUint16(66, line, true)
  head.set([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0], 16) // 헤더 16색: 검정·흰색·빨강·초록
  return Uint8Array.from([...head, ...rows.flatMap(b => (b >= 0xc0 ? [0xc1, b] : [b])), ...(tail ?? [])])
}

describe("이미지 입력 형식", () => {
  // 64×48 G4 3페이지 — k 페이지(0부터)는 x = k*20+2 … k*20+17 에 검은 사각형
  it("멀티페이지 TIFF 는 페이지마다 디코딩한다", async (t) => {
    if (!await has("sharp")) { t.skip("sharp 미설치"); return }
    const tif = fixture("image-3page-g4.tif")
    assert.equal(await imagePageCount(tif), 3)
    for (let k = 0; k < 3; k++) {
      const r = await decodeToRgba(tif, k)
      for (let j = 0; j < 3; j++) assert.deepEqual(at(r, j * 20 + 10, 24), j === k ? [0, 0, 0] : [255, 255, 255], `${k + 1}페이지 사각형 ${j}`)
    }
    assert.equal((await decodeToRgba(tif, 0)).density, 200)
  })

  it("HEIC 는 libheif-js 로 디코딩한다", async (t) => {
    if (!await has("sharp") || !await has("libheif-js/libheif-wasm/libheif-bundle.js")) { t.skip("sharp·libheif-js 미설치"); return }
    // 64×48, 왼쪽 반 빨강·오른쪽 반 파랑 (손실 압축이라 근삿값)
    const r = await decodeToRgba(fixture("image-red-blue.heic"))
    assert.deepEqual([r.width, r.height], [64, 48])
    const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) < 40)
    assert.ok(near(at(r, 10, 24), [255, 0, 0]), String(at(r, 10, 24)))
    assert.ok(near(at(r, 54, 24), [0, 0, 255]), String(at(r, 54, 24)))
    // 문서 속 HEIC 도 기본 정규화로 PNG
    const images = [{ filename: "image_001.heic", data: new Uint8Array(fixture("image-red-blue.heic")), mimeType: "image/heic" }]
    const blocks = [{ type: "image" as const, text: "image_001.heic" }]
    assert.equal(await convertImages(blocks, images, undefined, []), true)
    assert.deepEqual([images[0].filename, images[0].mimeType, blocks[0].text, images[0].data[1]], ["image_001.png", "image/png", "image_001.png", 0x50])
  })

  it("AVIF 디코딩 뒤 libvips 캐시를 비우고 캐시 한도는 유지한다", async (t) => {
    if (!await has("sharp")) { t.skip("sharp 미설치"); return }
    const sharp = (await import("sharp")).default
    const before = sharp.cache()
    sharp.cache({ memory: 77, files: 7, items: 77 })
    try {
      const avif = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 128, b: 0 } } }).avif().toBuffer()
      const r = await decodeToRgba(avif.buffer.slice(avif.byteOffset, avif.byteOffset + avif.byteLength) as ArrayBuffer)
      assert.deepEqual([r.width, r.height], [32, 32])
      const after = sharp.cache()
      assert.deepEqual([after.memory.max, after.files.max, after.items.max, after.items.current], [77, 7, 77, 0])
    } finally {
      sharp.cache({ memory: before.memory.max, files: before.files.max, items: before.items.max })
    }
  })

  it("parse — 이미지 파일은 페이지별 이미지 블록·정규화 이미지를 출력하고, OCR 은 ocr 옵션을 따른다", async (t) => {
    if (!await has("sharp")) { t.skip("sharp 미설치"); return }
    const sharp = (await import("sharp")).default
    const seen: string[] = []
    const ocr = async (img: Uint8Array, page: number, mime: string) => {
      seen.push(`${page} ${mime} ${img[1] === 0x50 && img[2] === 0x4e && img[3] === 0x47 ? "png" : "?"}`)
      return `쪽 ${page}`
    }
    const all = await parse(fixture("image-3page-g4.tif"), { ocr })
    assert.ok(all.success)
    if (!all.success) return
    assert.equal(all.pageCount, 3)
    assert.deepEqual(all.blocks.map(b => [b.pageNumber, b.text]), [[1, "image_001.png"], [1, "쪽 1"], [2, "image_002.png"], [2, "쪽 2"], [3, "image_003.png"], [3, "쪽 3"]])
    assert.deepEqual(seen, ["1 image/png png", "2 image/png png", "3 image/png png"])
    // 2페이지 이미지는 2페이지 픽셀(가운데 사각형만 검정)
    const p2 = await sharp(all.images![1].data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([0, 1, 2].map(j => at({ data: p2.data, width: p2.info.width }, j * 20 + 10, 24)), [[255, 255, 255], [0, 0, 0], [255, 255, 255]])
    // ocr: false — OCR 없이 고른 페이지의 이미지만, imageFormat 형식으로
    const two = await parse(fixture("image-3page-g4.tif"), { ocr: false, pages: "2", imageFormat: "webp" })
    assert.ok(two.success)
    if (!two.success) return
    assert.deepEqual([two.markdown, two.images!.map(i => [i.filename, i.mimeType])], ["![image](image_002.webp)", [["image_002.webp", "image/webp"]]])
    assert.equal(seen.length, 3)
    // 멀티페이지 픽셀 합계 상한: 헤더에 40000×40000 이라고 적힌 2페이지 TIFF 는 디코딩하지 않고 멈춘다
    const tags = [[256, 4, 40000], [257, 4, 40000], [258, 3, 1], [259, 3, 4], [262, 3, 0], [273, 4, 8], [278, 4, 40000], [279, 4, 1]]
    const ifd = 2 + tags.length * 12 + 4, huge = new Uint8Array(8 + 2 * ifd), hv = new DataView(huge.buffer)
    huge.set([0x49, 0x49, 42, 0]); hv.setUint32(4, 8, true)
    for (let k = 0; k < 2; k++) {
      const at = 8 + k * ifd
      hv.setUint16(at, tags.length, true)
      tags.forEach(([tag, type, val], j) => { const e = at + 2 + j * 12; hv.setUint16(e, tag, true); hv.setUint16(e + 2, type, true); hv.setUint32(e + 4, 1, true); if (type === 3) hv.setUint16(e + 8, val, true); else hv.setUint32(e + 8, val, true) })
      hv.setUint32(at + 2 + tags.length * 12, k ? 0 : 8 + ifd, true)
    }
    const big = await parse(huge.buffer, { ocr: false })
    assert.ok(big.success && big.blocks.length === 0 && big.warnings?.some(w => w.code === "PARTIAL_PARSE" && w.message.includes("픽셀 합계 상한")), JSON.stringify(big).slice(0, 300))
    // 이미 LLM 이 읽는 PNG 는 바이트 그대로
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer()
    const one = await parse(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, { ocr: false })
    assert.ok(one.success && one.markdown === "![image](image_001.png)" && Buffer.from(one.images![0].data).equals(png))
  })

  it("WMF — 비트맵 하나만 그리면 그 비트맵으로, 선이 섞이거나 일부만 그리면 원본 유지, 빈 WMF 는 빈 이미지", async () => {
    const one = wmf([[0x020c, new Uint8Array(4)], [0x0f43, stretchDib()]])
    const withLine = wmf([[0x0f43, stretchDib()], [0x0325, Uint8Array.from([2, 0, 0, 0, 0, 0, 5, 0, 5, 0])]])
    const crop = wmf([[0x0f43, stretchDib(1)]])
    const empty = wmf([[0x020c, new Uint8Array(4)], [0x012d, new Uint8Array(2)]])
    const images = [one, withLine, crop, empty].map((data, k) => ({ filename: `image_00${k + 1}.wmf`, data, mimeType: "image/wmf" }))
    const warnings: { code: string; message: string }[] = []
    await convertImages([], images, undefined, warnings as never)
    assert.deepEqual(images.map(i => i.filename), ["image_001.png", "image_002.wmf", "image_003.wmf", "image_004.wmf"])
    const sharp = (await import("sharp")).default
    const px = await sharp(images[0].data).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([px.info.width, px.info.height, ...px.data.subarray(0, 3), ...px.data.subarray(px.info.channels, px.info.channels + 3)], [2, 1, 255, 0, 0, 0, 0, 255])
    assert.ok(warnings.some(w => w.message.includes("그림 3개는 PNG 로 바꾸지 못해")))
    // dropBlankImages: 빈 WMF 만 제거
    const left = images.slice(1)
    assert.equal(await dropBlankImages([], left, []), true)
    assert.deepEqual(left.map(i => i.filename), ["image_002.wmf", "image_003.wmf"])
  })

  it("PCX — 1비트·8비트 팔레트·24비트, DCX 는 페이지마다", async () => {
    const rgb = (r: { data: Uint8Array } | null) => r && [...r.data].filter((_, i) => i % 4 !== 3)
    // 1비트 3×1: 1 0 1 → 흰·검·흰
    assert.deepEqual(rgb(pcxToRgba(pcx(1, 1, 3, 1, 2, [0b10100000, 0]))), [255, 255, 255, 0, 0, 0, 255, 255, 255])
    // 1비트 2 plane 2×1: 인덱스 2(빨강)·3(초록) — plane0 = 01, plane1 = 11
    assert.deepEqual(rgb(pcxToRgba(pcx(1, 2, 2, 1, 2, [0b01000000, 0, 0b11000000, 0]))), [255, 0, 0, 0, 255, 0])
    // 8비트 2×1 + 파일 끝 팔레트(인덱스 200 = 파랑), 0xC8 은 RLE 로 인코딩
    const pal = new Array(768).fill(0); pal.splice(200 * 3, 3, 0, 0, 255)
    assert.deepEqual(rgb(pcxToRgba(pcx(8, 1, 2, 1, 2, [200, 0], [0x0c, ...pal]))), [0, 0, 255, 0, 0, 0])
    // 24비트 1×1 (plane 마다 짝수 줄 길이 2)
    assert.deepEqual(rgb(pcxToRgba(pcx(8, 3, 1, 1, 2, [10, 0, 20, 0, 30, 0]))), [10, 20, 30])
    // 잘린 파일, 너비에 비해 터무니없이 큰 BytesPerLine(디코딩 버퍼가 RGBA 상한 초과)
    assert.equal(pcxToRgba(pcx(8, 3, 1, 1, 2, [10, 0, 20])), null)
    assert.equal(pcxToRgba(pcx(1, 4, 1, 60000, 65534, [])), null)
    // DCX 2페이지 → ocr: false 로 페이지 이미지 둘
    const pages = [pcx(1, 1, 3, 1, 2, [0b10100000, 0]), pcx(1, 1, 3, 1, 2, [0b01000000, 0])]
    const dcx = new Uint8Array(16 + pages[0].length + pages[1].length), dv = new DataView(dcx.buffer)
    dcx.set([0xb1, 0x68, 0xde, 0x3a]); dv.setUint32(4, 16, true); dv.setUint32(8, 16 + pages[0].length, true)
    dcx.set(pages[0], 16); dcx.set(pages[1], 16 + pages[0].length)
    // 오프셋이 겹치면(같은 페이지를 두 번 가리키면) 거부
    const dup = dcx.slice(); new DataView(dup.buffer).setUint32(8, 16, true)
    assert.deepEqual(dcxPages(dup), [])
    const r = await parse(dcx.buffer, { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    assert.deepEqual([r.pageCount, r.markdown.match(/image_\d+\.\w+/g)], [2, ["image_001.png", "image_002.png"]])
    const sharp = (await import("sharp")).default
    assert.deepEqual([...(await sharp(r.images![1].data).extractChannel(0).raw().toBuffer())], [0, 255, 0])
  })

  it("지원하지 않는 이미지 포맷은 포맷 이름을 넣어 거절한다", async () => {
    const jp2 = new Uint8Array(64)
    jp2.set([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
    const r = await parse(jp2.buffer)
    assert.equal(r.success, false)
    assert.ok(!r.success && r.code === "UNSUPPORTED_FORMAT" && r.error.includes("JPEG 2000"), JSON.stringify(r))
  })
})
