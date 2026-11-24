/**
 * 페이지 래스터 내보내기(pageImages) — kordoc 이 읽은 페이지 이미지를 PNG·무손실 WebP 로 결과에 싣는다.
 *
 * 잠근 계약:
 *  1. 옵션 값 — true·false·"png"·"webp" 만, 모르는 값은 parse() 실패 결과(문서를 읽기 전)
 *  2. 끄면 결과에 pageImages 가 없고, 켜도 나머지 결과는 끈 것과 같다
 *  3. 이미지 입력(OCR 끔): 실제 형식과 무관하게 PNG, 화소는 디코딩한 원본, EXIF 방향대로 세운 그림, 멀티페이지는 쪽마다(pages 로 고른 쪽만)
 *  4. "webp" 는 무손실 — 폭·높이·화소가 PNG 와 같다. WebP 로 못 내는 쪽(한 변 16,383px 초과)은 PNG 로 내고 경고
 *  5. 상한 — 누적 바이트(128MB)와 래스터 픽셀 합계(10억, 쪽마다 최소 100만 픽셀 = 1,000쪽)를 넘으면 그 뒤 쪽은 빼고 경고.
 *     픽셀 예산은 쪽을 그리거나 인코딩하기 전에 쪽 크기로 잡는다(큰 쪽·쪽 많은 PDF 를 끝없이 그리지 않는다)
 *  6. PDF(OCR 끔): 쪽마다 OCR 과 같은 배율(×3)로 그린 그림, pages 로 고른 쪽만. OCR 한 쪽은 OCR 이 읽은 래스터, 나머지 쪽만 따로 그린다
 *  7. 내장 OCR 을 돌리면(모델 있을 때만) ocrLines 와 같은 래스터 — 폭·높이가 같고, 기울기를 바로잡은 쪽은 바로잡은 래스터
 *  8. 전송: CLI --format json·parse-worker protocol 2 응답이 Node parse() 와 같고, files 전송은 페이지 이미지도 파일로 쓴다
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, parseImage } from "../src/index.js"
import { cliOcrEngineOptions } from "../src/cli/convert.js"
import { externalizeImages, toParseOptions, WorkerProtocolError } from "../src/cli/parse-worker-v2.js"
import { deskewPage } from "../src/ocr/deskew.js"
import { decodeToRgba } from "../src/ocr/image-ocr.js"
import { getOcrModelStatus } from "../src/ocr/models.js"
import { validateOcrOptions } from "../src/ocr/options.js"
import { PageImageSink } from "../src/ocr/page-images.js"
import { renderPdfPageImages, runPdfOcr } from "../src/ocr/pdf-ocr.js"
import type { PageImage, ParseOptions, ParseResult, ParseWarning } from "../src/types.js"
import { SCAN_SVG, TINY_BMP, scanFixtures, textPdf, tinyBmp, tinyBmpColor } from "./fixtures/sdk-docs.js"

const toAB = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const fixture = (name: string) => toAB(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const loadSharp = async () => { try { return (await import("sharp")).default } catch { return null } }
const hasPdfium = async () => { try { await import("@hyzyla/pdfium"); return true } catch { return false } }
/** pageImages 를 뺀 결과 — 끈 결과와 견준다 */
const withoutPageImages = (r: ParseResult) => { const { pageImages: _, ...rest } = r as { pageImages?: unknown }; return rest }
const isPng = (b: Uint8Array) => Buffer.from(b.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const isWebp = (b: Uint8Array) => Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP"
/** 페이지 이미지를 다시 디코딩한 RGBA */
async function pixels(sharp: NonNullable<Awaited<ReturnType<typeof loadSharp>>>, img: PageImage) {
  const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

const { width: BMP_W, height: BMP_H } = TINY_BMP
const bmp = tinyBmp, bmpColor = tinyBmpColor

describe("pageImages 옵션 값", () => {
  it("true·false·\"png\"·\"webp\" 만 받는다", () => {
    for (const ok of [true, false, "png", "webp"] as const) assert.equal(validateOcrOptions({ pageImages: ok }), null)
    for (const bad of ["gif", "PNG", 1, {}]) assert.match(validateOcrOptions({ pageImages: bad as never }) ?? "", /pageImages.*"png"·"webp"/, JSON.stringify(bad))
  })

  it("모르는 형식은 parse()·parseImage()·워커가 거부한다 (PNG 로 바꿔 내지 않는다)", async () => {
    const r = await parse(toAB(bmp()), { ocr: false, pageImages: "gif" as never })
    assert.equal(r.success, false)
    assert.match(r.success ? "" : r.error, /pageImages.*"gif"/)
    const direct = await parseImage(toAB(bmp()), { ocr: false, pageImages: "jpeg" as never })
    assert.match(direct.success ? "" : direct.error, /pageImages.*"jpeg"/)
    assert.throws(() => toParseOptions({ pageImages: "gif" }, "/x"), (e: unknown) => e instanceof WorkerProtocolError && e.code === "INVALID_OPTIONS")
    assert.deepEqual(toParseOptions({ pageImages: "webp" }, "/x"), { filePath: "/x", pageImages: "webp" })
  })

  it("CLI 플래그 → ParseOptions (형식은 받은 글 그대로 넘겨 parse() 가 거부)", () => {
    assert.deepEqual(cliOcrEngineOptions({}), {})
    assert.deepEqual(cliOcrEngineOptions({ pageImages: "webp" }), { pageImages: "webp" })
    assert.match(validateOcrOptions(cliOcrEngineOptions({ pageImages: "gif" })) ?? "", /pageImages.*"gif"/)
  })
})

describe("이미지 입력 (OCR 끔)", () => {
  it("BMP → PNG, 화소는 디코딩한 원본. 끄면 필드가 없고 켜도 나머지 결과는 같다", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    const off = await parse(toAB(bmp()), { ocr: false })
    const on = await parse(toAB(bmp()), { ocr: false, pageImages: true })
    assert.ok(off.success && on.success)
    assert.equal("pageImages" in off, false)
    assert.deepEqual(withoutPageImages(on), off)
    assert.equal(on.pageImages!.length, 1)
    const [p] = on.pageImages!
    assert.deepEqual([p.pageNumber, p.filename, p.mimeType, p.width, p.height], [1, "page_001.png", "image/png", BMP_W, BMP_H])
    assert.ok(isPng(p.data))
    const px = await pixels(sharp, p)
    assert.deepEqual([px.width, px.height], [BMP_W, BMP_H])
    for (let y = 0; y < BMP_H; y++) for (let x = 0; x < BMP_W; x++) {
      assert.deepEqual([...px.data.subarray((y * BMP_W + x) * 4, (y * BMP_W + x) * 4 + 4)], [...bmpColor(x, y), 255], `(${x}, ${y})`)
    }
    assert.deepEqual(px.data, (await decodeToRgba(toAB(bmp()))).data)
    // "png" 는 true 와 같다
    assert.deepEqual(await parse(toAB(bmp()), { ocr: false, pageImages: "png" }), on)
  })

  it("\"webp\" 는 무손실 — 폭·높이·화소가 PNG 와 같다", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    const png = await parse(toAB(bmp()), { ocr: false, pageImages: true })
    const webp = await parse(toAB(bmp()), { ocr: false, pageImages: "webp" })
    assert.ok(png.success && webp.success)
    const [p] = webp.pageImages!
    assert.deepEqual([p.filename, p.mimeType, p.width, p.height], ["page_001.webp", "image/webp", BMP_W, BMP_H])
    assert.ok(isWebp(p.data))
    assert.deepEqual(await pixels(sharp, p), await pixels(sharp, png.pageImages![0]))
    assert.deepEqual(withoutPageImages(webp), withoutPageImages(png))
  })

  it("EXIF 방향대로 세운 그림", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    // 바로 선 그림: 가로 80 × 세로 40, 왼쪽 절반 검정 → 눕혀 저장하고 Orientation 6 표시 (ocr-image.test.ts 와 같은 견본)
    const upright = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: { create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .png().toBuffer()
    const jpeg = await sharp(await sharp(upright).rotate(-90).jpeg({ quality: 95 }).toBuffer()).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer()
    const r = await parse(toAB(jpeg), { ocr: false, pageImages: true })
    assert.ok(r.success)
    const [p] = r.pageImages!
    assert.deepEqual([p.width, p.height, p.mimeType], [80, 40, "image/png"])
    const px = await pixels(sharp, p)
    assert.ok(px.data[(20 * 80 + 10) * 4] < 60 && px.data[(20 * 80 + 70) * 4] > 200, "왼쪽 검정·오른쪽 흰색")
    // 원본 페이지 이미지(images)는 그대로 JPEG 바이트
    assert.ok(Buffer.from(r.images![0].data).equals(jpeg))
  })

  it("멀티페이지 TIFF 는 쪽마다, pages 로 고른 쪽만", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    const tif = fixture("image-3page-g4.tif")
    const all = await parse(tif, { ocr: false, pageImages: true })
    assert.ok(all.success)
    assert.deepEqual(all.pageImages!.map(p => [p.pageNumber, p.filename, p.width, p.height]), [[1, "page_001.png", 64, 48], [2, "page_002.png", 64, 48], [3, "page_003.png", 64, 48]])
    for (const p of all.pageImages!) assert.deepEqual((await pixels(sharp, p)).data, (await decodeToRgba(tif, p.pageNumber - 1)).data, `${p.pageNumber}쪽`)
    const two = await parse(tif, { ocr: false, pageImages: true, pages: "2" })
    assert.ok(two.success)
    assert.deepEqual(two.pageImages!.map(p => p.pageNumber), [2])
    assert.deepEqual(two.pageImages![0].data, all.pageImages![1].data)
  })

  it("HEIC 도 PNG 로 — 화소는 디코딩한 원본", async (t) => {
    const sharp = await loadSharp()
    let heif = true
    try { await import("libheif-js") } catch { heif = false }
    if (!sharp || !heif) { t.skip("sharp·libheif-js 미설치"); return }
    const heic = fixture("image-red-blue.heic")
    const r = await parse(heic, { ocr: false, pageImages: true })
    assert.ok(r.success)
    const [p] = r.pageImages!
    const want = await decodeToRgba(heic)
    assert.deepEqual([p.mimeType, isPng(p.data), p.width, p.height], ["image/png", true, want.width, want.height])
    assert.deepEqual((await pixels(sharp, p)).data, want.data)
  })

  it("디코딩하지 못하는 이미지 — OCR 을 끈 파싱은 그대로 성공하고 페이지 이미지만 빼고 경고한다", async (t) => {
    if (!await loadSharp()) { t.skip("sharp 미설치"); return }
    // 압축 방식을 BI_JPEG(4)로 적은 BMP — kordoc 디코더가 읽지 못한다
    const bad = bmp()
    bad.writeUInt32LE(4, 30)
    const off = await parse(toAB(bad), { ocr: false })
    const on = await parse(toAB(bad), { ocr: false, pageImages: true })
    assert.ok(off.success && on.success, JSON.stringify(on).slice(0, 200))
    assert.deepEqual(on.pageImages, [])
    assert.deepEqual(on.warnings!.filter(w => !off.warnings?.some(o => o.message === w.message)).map(w => [w.page, w.code, /pageImages 생략.*BMP/.test(w.message)]), [[1, "SKIPPED_IMAGE", true]])
    assert.deepEqual([on.markdown, on.blocks, on.images?.length], [off.markdown, off.blocks, off.images?.length])
  })

  it("OcrProvider 를 줘도 디코딩해 세운 그림을 낸다", async (t) => {
    if (!await loadSharp()) { t.skip("sharp 미설치"); return }
    const r = await parse(toAB(bmp()), { ocr: async () => "읽은 글", pageImages: true })
    assert.ok(r.success)
    assert.match(r.markdown, /읽은 글/)
    assert.deepEqual(r.pageImages!.map(p => [p.pageNumber, p.width, p.height]), [[1, BMP_W, BMP_H]])
  })
})

describe("페이지 이미지 모음 (PageImageSink)", () => {
  const raster = (width: number, height: number) => ({ data: new Uint8Array(width * height * 4).fill(255), width, height })

  it("모르는 형식은 throw", () => {
    assert.throws(() => new PageImageSink("gif" as never), /pageImages/)
  })

  it("누적 상한을 넘긴 쪽부터는 담지 않고 경고한다", async () => {
    const sink = new PageImageSink("png", 100)
    for (let page = 3; page >= 1; page--) await sink.add(page, raster(4, 4))
    const warnings: ParseWarning[] = []
    const images = sink.finish(warnings)
    // 3쪽(먼저 넣은 쪽)만 상한 안 — 2쪽에서 넘었고 1쪽은 인코딩하지 않는다
    assert.deepEqual(images.map(i => i.pageNumber), [3])
    assert.deepEqual(warnings.map(w => w.code), ["SKIPPED_IMAGE"])
    assert.match(warnings[0].message, /pageImages 2페이지 생략/)
  })

  it("래스터 픽셀 합계 상한 — 쪽마다 최소 100만 픽셀로 세고, 넘긴 쪽은 인코딩하기 전에 뺀다", async () => {
    const sink = new PageImageSink("png", undefined, 2_500_000)
    for (const page of [1, 2, 3, 4]) await sink.add(page, raster(4, 4))
    const warnings: ParseWarning[] = []
    assert.deepEqual(sink.finish(warnings).map(i => i.pageNumber), [1, 2])
    assert.deepEqual(warnings.map(w => w.code), ["SKIPPED_IMAGE"])
    assert.match(warnings[0].message, /pageImages 2페이지 생략.*픽셀/)
    // 큰 쪽 하나가 예산을 넘으면 그리기 전에 거절한다
    const small = new PageImageSink("png", undefined, 10_000_000)
    assert.equal(small.reserve(24_000_000), false)
    assert.equal(small.reserve(1), false, "넘긴 뒤로는 계속 거절")
    assert.equal(new PageImageSink("png").reserve(24_000_000), true)
  })

  it("상한에 닿으면 full — 그 뒤 쪽은 만들지 않고 skip 으로 센다", async () => {
    const sink = new PageImageSink("png", 100)
    assert.equal(sink.full, false)
    await sink.add(1, raster(4, 4))
    await sink.add(2, raster(4, 4))
    assert.equal(sink.full, true)
    sink.skip(3)
    assert.deepEqual([1, 2, 3, 4].map(p => sink.has(p)), [true, true, true, false])
    const warnings: ParseWarning[] = []
    assert.deepEqual(sink.finish(warnings).map(i => i.pageNumber), [1])
    assert.match(warnings[0].message, /pageImages 2페이지 생략/)
    const pixels = new PageImageSink("png", undefined, 1_500_000)
    assert.equal(pixels.reserve(1), true)
    assert.equal(pixels.full, false)
    assert.equal(pixels.reserve(1), false)
    assert.equal(pixels.full, true)
  })

  it("쪽 번호 순으로 낸다", async () => {
    const sink = new PageImageSink("png")
    for (const page of [2, 3, 1]) await sink.add(page, raster(2, 2))
    assert.equal(sink.has(3), true)
    assert.equal(sink.has(4), false)
    const warnings: ParseWarning[] = []
    assert.deepEqual(sink.finish(warnings).map(i => [i.pageNumber, i.filename]), [[1, "page_001.png"], [2, "page_002.png"], [3, "page_003.png"]])
    assert.deepEqual(warnings, [])
  })

  it("WebP 한 변 한도(16,383px)를 넘는 쪽은 PNG 로 내고 경고한다", async (t) => {
    if (!await loadSharp()) { t.skip("sharp 미설치"); return }
    const sink = new PageImageSink("webp")
    await sink.add(1, raster(16_384, 1))
    await sink.add(2, raster(8, 8))
    const warnings: ParseWarning[] = []
    const images = sink.finish(warnings)
    assert.deepEqual(images.map(i => [i.filename, i.mimeType, isPng(i.data), isWebp(i.data)]), [["page_001.png", "image/png", true, false], ["page_002.webp", "image/webp", false, true]])
    assert.deepEqual(warnings.map(w => w.code), ["SKIPPED_IMAGE"])
    assert.match(warnings[0].message, /1페이지는 WebP 로 내지 못해/)
  })
})

describe("PDF (OCR 끔)", () => {
  it("쪽마다 OCR 과 같은 배율(×3)로 그린 그림, pages 로 고른 쪽만. 끄면 결과 불변", async (t) => {
    const sharp = await loadSharp()
    if (!sharp || !await hasPdfium()) { t.skip("sharp·pdfium 미설치"); return }
    const pdf = toAB(textPdf([[300, 300], [200, 100]]))
    const off = await parse(pdf, { ocr: false })
    const on = await parse(pdf, { ocr: false, pageImages: true })
    assert.ok(off.success && on.success)
    assert.equal("pageImages" in off, false)
    assert.deepEqual(withoutPageImages(on), off)
    assert.deepEqual(on.pageImages!.map(p => [p.pageNumber, p.filename, p.mimeType, p.width, p.height]),
      [[1, "page_001.png", "image/png", 900, 900], [2, "page_002.png", "image/png", 600, 300]])
    // 글이 그려진 쪽 — 흰 바탕에 어두운 화소가 있다
    const px = await pixels(sharp, on.pageImages![0])
    assert.deepEqual([px.width, px.height], [900, 900])
    let dark = 0
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i] < 100) dark++
    assert.ok(dark > 100 && dark < px.data.length / 40, `어두운 화소 ${dark}`)
    const second = await parse(pdf, { ocr: false, pageImages: "webp", pages: "2" })
    assert.ok(second.success)
    assert.deepEqual(second.pageImages!.map(p => [p.pageNumber, p.filename, p.mimeType, p.width, p.height]), [[2, "page_002.webp", "image/webp", 600, 300]])
    assert.deepEqual(await pixels(sharp, second.pageImages![0]), await pixels(sharp, on.pageImages![1]))
  })
})

describe("PDF — OCR 한 쪽과 그리기만 한 쪽", () => {
  it("OCR 한 쪽은 OCR 이 읽은 래스터를 받고, 나머지 쪽만 따로 그린다 (같은 배율)", async (t) => {
    if (!await loadSharp() || !await hasPdfium()) { t.skip("sharp·pdfium 미설치"); return }
    const pdf = toAB(textPdf([[300, 300], [200, 100], [100, 200]]))
    const sink = new PageImageSink("png")
    const seen: Array<[number, number, number]> = []
    const warnings: ParseWarning[] = []
    // 2쪽만 OCR(OcrProvider — 모델 불필요). 프로바이더가 받은 PNG 가 곧 그 페이지 이미지다
    await runPdfOcr(pdf, new Set([2]), async (png, page) => { seen.push([page, Buffer.from(png).readUInt32BE(16), Buffer.from(png).readUInt32BE(20)]); return "글" },
      warnings, undefined, true, undefined, undefined, undefined, undefined, sink)
    assert.deepEqual(seen, [[2, 600, 300]])
    assert.equal(sink.has(2), true)
    await renderPdfPageImages(pdf, [1, 3].filter(p => !sink.has(p)), sink, warnings)
    assert.deepEqual(sink.finish(warnings).map(p => [p.pageNumber, p.width, p.height]), [[1, 900, 900], [2, 600, 300], [3, 300, 600]])
    assert.deepEqual(warnings, [])
  })

  it("쪽이 많거나 큰 PDF — 픽셀 상한을 넘긴 쪽은 그리지 않고 경고한다", async (t) => {
    if (!await hasPdfium()) { t.skip("pdfium 미설치"); return }
    // 쪽 다섯(쪽마다 최소 100만 픽셀로 센다) — 상한 300만이면 세 쪽까지만
    const many = new PageImageSink("png", undefined, 3_000_000)
    const warnings: ParseWarning[] = []
    await renderPdfPageImages(toAB(textPdf(Array.from({ length: 5 }, () => [100, 100] as [number, number]))), [1, 2, 3, 4, 5], many, warnings)
    assert.deepEqual(many.finish(warnings).map(p => [p.pageNumber, p.width, p.height]), [[1, 300, 300], [2, 300, 300], [3, 300, 300]])
    assert.deepEqual(warnings.map(w => [w.code, /pageImages 2페이지 생략/.test(w.message)]), [["SKIPPED_IMAGE", true]])
    // 4000pt 정사각 쪽은 2,400만 픽셀 래스터 — 상한 1,000만이면 그리지 않는다. 뒤의 작은 쪽도 넘긴 뒤라 뺀다
    const big = new PageImageSink("png", undefined, 10_000_000)
    const bigWarnings: ParseWarning[] = []
    await renderPdfPageImages(toAB(textPdf([[4000, 4000], [100, 100]])), [1, 2], big, bigWarnings)
    assert.deepEqual(big.finish(bigWarnings), [])
    assert.match(bigWarnings[0].message, /pageImages 2페이지 생략/)
  })

  it("상한으로 뺀 OCR 쪽을 다시 그리려 하지 않는다 — 뺀 쪽은 한 번만 센다", async (t) => {
    if (!await loadSharp() || !await hasPdfium()) { t.skip("sharp·pdfium 미설치"); return }
    const pdf = toAB(textPdf([[100, 100], [100, 100], [100, 100]]))
    // 쪽마다 100만 픽셀로 센다 — 상한 150만이면 한 쪽만. 1·2쪽을 OCR(OcrProvider)하면 2쪽은 OCR 은 됐지만 페이지 이미지는 빠진다
    const sink = new PageImageSink("png", undefined, 1_500_000)
    const warnings: ParseWarning[] = []
    await runPdfOcr(pdf, new Set([1, 2]), async () => "글", warnings, undefined, true, undefined, undefined, undefined, undefined, sink)
    assert.deepEqual([1, 2, 3].map(p => sink.has(p)), [true, true, false])
    await renderPdfPageImages(pdf, [1, 2, 3].filter(p => !sink.has(p)), sink, warnings)
    assert.deepEqual(sink.finish(warnings).map(p => p.pageNumber), [1])
    assert.deepEqual(warnings.map(w => [w.code, /pageImages 2페이지 생략/.test(w.message)]), [["SKIPPED_IMAGE", true]])
  })

  it("parse() 기본 상한 — 1,001쪽 PDF 는 페이지 이미지 1,000개와 경고 하나", async (t) => {
    if (!await hasPdfium()) { t.skip("pdfium 미설치"); return }
    const r = await parse(toAB(textPdf(Array.from({ length: 1001 }, () => [40, 40] as [number, number]))), { ocr: false, pageImages: true })
    assert.ok(r.success)
    assert.equal(r.pageCount, 1001)
    assert.equal(r.pageImages!.length, 1000)
    assert.deepEqual([r.pageImages![0].pageNumber, r.pageImages![999].pageNumber, r.pageImages![0].width], [1, 1000, 120])
    assert.equal(r.warnings!.filter(w => w.code === "SKIPPED_IMAGE" && /pageImages 1페이지 생략.*픽셀/.test(w.message)).length, 1)
  })
})

describe("내장 OCR 과 같은 래스터 (모델 있을 때만)", () => {
  async function fixtures(t: { skip(msg: string): void }) {
    if (!(await getOcrModelStatus()).every(s => s.verified)) { t.skip("OCR 모델 미설치"); return null }
    const f = await scanFixtures()
    if (!f || !await hasPdfium()) { t.skip("sharp·pdfium 미설치"); return null }
    return f
  }

  it("이미지: 페이지 이미지의 폭·높이가 ocrLines 와 같고, 켜도 나머지 결과는 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const off = await parse(f.png, { ocrLines: true })
    const on = await parse(f.png, { ocrLines: true, pageImages: true })
    assert.ok(off.success && on.success)
    assert.deepEqual(withoutPageImages(on), off)
    const [line] = on.ocrLines!, [p] = on.pageImages!
    assert.deepEqual([p.pageNumber, p.width, p.height], [line.pageNumber, line.width, line.height])
    assert.equal(line.deskewAngle, 0)
    assert.deepEqual((await pixels((await loadSharp())!, p)).data, (await decodeToRgba(toAB(f.png))).data)
  })

  it("기울어진 스캔: 페이지 이미지는 OCR 이 바로잡은 래스터다 (줄 상자를 그대로 쓴다)", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const sharp = (await loadSharp())!
    // 글줄이 셋 이상이어야 기울기를 바로잡는다(두 줄 그림은 글꼴 모양에 따라 기울지 않아도 기울어 보여 보정하지 않는다, #233)
    const tilted = await sharp(Buffer.from(SCAN_SVG.replace("</svg>", `<text x="40" y="40" font-size="32" font-family="sans-serif">공공 문서 첫 줄 예시</text><text x="40" y="245" font-size="32" font-family="sans-serif">마지막 줄 끝 예시 문장</text></svg>`)))
      .rotate(2, { background: "white" }).png().toBuffer()
    const r = await parse(tilted, { ocrLines: true, pageImages: true })
    assert.ok(r.success)
    const [line] = r.ocrLines!, [p] = r.pageImages!
    assert.ok(Math.abs(line.deskewAngle) > 1, `deskewAngle ${line.deskewAngle}`)
    assert.deepEqual([p.width, p.height], [line.width, line.height])
    const decoded = await decodeToRgba(toAB(tilted))
    const px = (await pixels(sharp, p)).data
    assert.deepEqual(px, deskewPage(decoded.data, decoded.width, decoded.height).rgba)
    assert.notDeepEqual(px, decoded.data)
    assert.match(line.lines.map(l => l.text).join(" "), /대한민국/)
  })

  it("PDF: OCR 한 쪽의 페이지 이미지는 ocrLines 와 같은 폭·높이", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const off = await parse(f.pdf, { ocr: true, ocrLines: true })
    const on = await parse(f.pdf, { ocr: true, ocrLines: true, pageImages: true })
    assert.ok(off.success && on.success)
    assert.deepEqual(withoutPageImages(on), off)
    const [line] = on.ocrLines!, [p] = on.pageImages!
    assert.deepEqual([p.pageNumber, p.width, p.height], [1, line.width, line.height])
    assert.deepEqual([p.width, p.height, line.scale], [420 * 3, 130 * 3, 3])
  })
})

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const toWire = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))

/** CLI 를 띄워 stdout 을 모은다 (stdin 은 받은 줄을 쓰고 닫는다) */
function run(args: string[], input = ""): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => chunks.push(d))
    child.stderr.resume()
    child.on("close", (code) => resolve({ out: Buffer.concat(chunks).toString("utf8"), code }))
    child.stdin.end(input)
  })
}

describe("전송 — CLI·parse-worker", () => {
  it("files 전송은 페이지 이미지도 파일로 쓰고 dataRef 로 바꾼다", async () => {
    const root = mkdtempSync(join(tmpdir(), "kordoc-pageimages-"))
    try {
      const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
      const result = { success: true, fileType: "pdf", markdown: "", blocks: [],
        pageImages: [{ pageNumber: 1, filename: "page_001.png", width: 1, height: 1, mimeType: "image/png", data }] } as ParseResult
      const dir = await externalizeImages(result, root, 7)
      assert.ok(dir && result.success)
      const [p] = result.pageImages as unknown as Array<{ data?: unknown; dataRef: { path: string; byteLength: number } }>
      assert.equal(p.data, undefined)
      assert.deepEqual(p.dataRef, { path: "page_001.png", byteLength: 7 })
      assert.deepEqual(new Uint8Array(readFileSync(join(dir, "page_001.png"))), data)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("--page-images·protocol 2 응답이 parse() 와 같다", async (t) => {
    if (!await loadSharp() || !await hasPdfium()) { t.skip("sharp·pdfium 미설치"); return }
    const dir = mkdtempSync(join(tmpdir(), "kordoc-pageimages-"))
    try {
      const file = join(dir, "페이지.pdf")
      writeFileSync(file, textPdf([[300, 300], [200, 100]]))
      const want = toWire(await parse(file, { pageImages: true }))
      assert.ok(want.success && want.pageImages.length === 2 && typeof want.pageImages[0].data === "string")

      const cli = await run([file, "--format", "json", "--silent", "--page-images", "png"])
      assert.equal(cli.code, 0)
      assert.deepEqual(JSON.parse(cli.out), want)
      const webp = await run([file, "--format", "json", "--silent", "--page-images", "webp"])
      assert.deepEqual(JSON.parse(webp.out), toWire(await parse(file, { pageImages: "webp" })))
      const bad = await run([file, "--format", "json", "--silent", "--page-images", "gif"])
      assert.equal(bad.code, 1)
      assert.match(JSON.parse(bad.out).error, /pageImages.*"gif"/)
      // 옵션을 주지 않으면 필드가 없다
      const plain = await run([file, "--format", "json", "--silent"])
      assert.equal("pageImages" in JSON.parse(plain.out), false)

      const worker = await run(["parse-worker", "--protocol", "2"], [
        { id: 1, cmd: "parse", file, options: { pageImages: true } },
        { id: 2, cmd: "parse", file, options: { pageImages: "webp" }, transport: { images: "files", assetsDir: dir } },
        { id: 3, cmd: "parse", file, options: { pageImages: "gif" } },
      ].map(m => JSON.stringify(m)).join("\n") + "\n")
      const res = worker.out.split("\n").filter(Boolean).map(l => JSON.parse(l))
      assert.deepEqual(res[1].result, want)
      const refs = res[2].result.pageImages as Array<{ filename: string; mimeType: string; data?: string; dataRef: { path: string; byteLength: number } }>
      assert.deepEqual(refs.map(p => [p.filename, p.mimeType, p.dataRef.path, p.data]), [["page_001.webp", "image/webp", "page_001.webp", undefined], ["page_002.webp", "image/webp", "page_002.webp", undefined]])
      for (const p of refs) {
        const bytes = readFileSync(join(res[2].assetsDir, p.dataRef.path))
        assert.ok(isWebp(bytes) && bytes.length === p.dataRef.byteLength)
      }
      assert.equal(res[3].error.code, "INVALID_OPTIONS")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
