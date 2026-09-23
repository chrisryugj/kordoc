/**
 * 이미지 입력 OCR 좌표 스케일 (image-ocr.ts imageScale).
 *
 * 잠근 계약:
 *  1. 메타데이터 DPI 100~1200 은 그대로 (px/pt = dpi/72), 72·96 은 기본값이라 불신
 *  2. DPI 가 없으면 A판(√2)·Letter(11/8.5) 판형으로 추정 — 150dpi A4 스캔이 216dpi 로
 *     가정돼 페이지가 0.69배로 쪼그라들던 것 방지
 *  3. 판형도 아니면 종전 216dpi (3 px/pt)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { imageScale } from "../src/ocr/image-ocr.js"

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
