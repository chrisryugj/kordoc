/**
 * 이미지 입력 OCR 좌표 스케일 (image-ocr.ts imageScale).
 *
 * 잠근 계약:
 *  1. 메타데이터 DPI 100~1200 은 그대로 (px/pt = dpi/72), 72·96 은 기본값이라 불신
 *  2. DPI 가 없으면 A판(√2)·Letter(11/8.5) 판형으로 추정 — 150dpi A4 스캔이 216dpi 로
 *     가정돼 페이지가 0.69배로 쪼그라들던 것 방지
 *  3. 판형도 아니면 종전 216dpi (3 px/pt)
 *  4. decodeToRgba: EXIF 방향대로 세운다(Orientation 6 세로 촬영 JPEG — 종전엔 누운 글을 읽어 한글 131자 → 쓰레기 57자),
 *     픽셀이 MAX_OCR_PIXELS 를 넘으면 그 안으로 줄이고 배율(shrink)을 알린다(16000² PNG 1.84GB 회귀)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { imageScale, decodeToRgba } from "../src/ocr/image-ocr.js"
import { MAX_OCR_PIXELS } from "../src/ocr/pdf-ocr.js"

describe("imageScale — 이미지 px/pt", () => {
  it("메타데이터 DPI 우선", () => {
    assert.equal(imageScale(2480, 3508, 300), 300 / 72)
    assert.equal(imageScale(1000, 1000, 200), 200 / 72)
  })
  it("72·96 DPI 는 무시하고 판형 추정", () => {
    assert.ok(Math.abs(imageScale(1240, 1754, 72) - 1754 / 842) < 1e-9)
    assert.ok(Math.abs(imageScale(1240, 1754, 96) - 1754 / 842) < 1e-9)
  })
  it("A4 판형 (세로·가로)", () => {
    const s150 = imageScale(1240, 1754)
    assert.ok(Math.abs(s150 * 72 - 150) < 1.5, `150dpi 추정 ${s150 * 72}`)
    const s300 = imageScale(3508, 2480)
    assert.ok(Math.abs(s300 * 72 - 300) < 3, `300dpi 가로 추정 ${s300 * 72}`)
  })
  it("Letter 판형", () => {
    assert.ok(Math.abs(imageScale(2550, 3300) * 72 - 300) < 3)
  })
  it("판형 아님 → 216dpi 가정", () => {
    assert.equal(imageScale(420, 80), 3)
    assert.equal(imageScale(1614, 2211), 3)
  })
})

describe("decodeToRgba — EXIF 방향·픽셀 상한", () => {
  async function loadSharp() {
    try { return (await import("sharp")).default } catch { return null }
  }
  const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

  it("Orientation 6 JPEG 은 세워서 디코딩", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    // 바로 선 그림: 가로 80 × 세로 40, 왼쪽 절반 검정 → 반시계로 눕혀 저장하고 "시계 방향 90° 돌려 보라"(6) 표시
    const upright = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: { create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .png().toBuffer()
    const sideways = await sharp(upright).rotate(-90).jpeg({ quality: 95 }).toBuffer()
    const jpeg = await sharp(sideways).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer()
    const r = await decodeToRgba(ab(jpeg))
    assert.deepEqual([r.width, r.height], [80, 40])
    const lum = (x: number, y: number) => r.data[(y * r.width + x) * 4]
    assert.ok(lum(10, 20) < 60 && lum(70, 20) > 200, `왼쪽 검정·오른쪽 흰색: ${lum(10, 20)} ${lum(70, 20)}`)
    assert.equal(r.shrink, 1)
  })

  it("픽셀 상한을 넘는 이미지는 그 안으로 줄이고 배율을 알린다", async (t) => {
    const sharp = await loadSharp()
    if (!sharp) { t.skip("sharp 미설치"); return }
    const png = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer()
    const r = await decodeToRgba(ab(png))
    assert.ok(r.width * r.height <= MAX_OCR_PIXELS, `${r.width}×${r.height}`)
    assert.ok(Math.abs(r.shrink - r.width / 6000) < 1e-9 && r.shrink < 1)
    assert.ok(Math.abs(r.width / r.height - 6000 / 5000) < 0.01, "비율 유지")
  })
})
