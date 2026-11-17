/**
 * PDF 보고서 모양 재기 — 글꼴 이름 대조·쪽 표본 측정(합성 표본)·공문서 옵션 합치기.
 * 실제 PDF 확인(코퍼스·서울시 보고서 양식 PDF): 서울시 양식에서 □ HY견고딕 17·ㅇ 한컴돋움 15·- 휴먼명조 14(서울방침 실측 스킴과 같음).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { pdfFontFace, measureLayoutFromPages, type LayoutPageSample, type LayoutTextItem } from "../src/pdf/layout-measure.js"
import { applyMeasuredLayout } from "../src/hwpx/layout-options.js"

describe("PDF 글꼴 이름 → 한컴 글꼴", () => {
  it("한컴이 적는 영문 이름·부분집합 접두", () => {
    assert.equal(pdfFontFace("ABCDEF+H2hdrM"), "HY헤드라인M")
    assert.equal(pdfFontFace("Haansoft Dotum"), "한컴돋움")
    assert.equal(pdfFontFace("H2gtrE"), "HY견고딕")
    assert.equal(pdfFontFace("TTD484DCD5tCID"), null)
  })

  it("CP949 이름이 UTF-8 로 풀려 깨진 꼴(휴먼명조)을 되찾는다", () => {
    // 「휴먼명조」의 CP949 바이트를 UTF-8 로 풀면 엔진이 주는 깨진 이름과 같다
    const broken = new TextDecoder("utf-8").decode(new Uint8Array([0xc8, 0xde, 0xb8, 0xd5, 0xb8, 0xed, 0xc1, 0xb6]))
    assert.ok(broken.includes("�"))
    assert.equal(pdfFontFace(broken), "휴먼명조")
  })
})

const it_ = (str: string, x: number, y: number, size: number, font: string | null, w = str.length * size): LayoutTextItem =>
  ({ str, x, y, w, size, font, pdfFont: font ?? "?" })

/** A4 한 쪽 — □ 3줄, ○ 3줄(둘째 줄로 꺾임 1.5배), - 3줄, 표 칸 안 「-」 1줄(오른쪽 멀리), 쪽 번호, 장 번호칸 Ⅰ(#193AAA) */
function page(): LayoutPageSample {
  const items: LayoutTextItem[] = [it_("Ⅰ", 66, 760, 17, null, 10), it_("보고 개요", 110, 760, 17, "HY헤드라인M")]
  let y = 720
  for (let k = 0; k < 3; k++) {
    items.push(it_("□", 56.7, y, 15, "HY헤드라인M", 15), it_("대항목 제목입니다", 78, y, 15, "HY헤드라인M"))
    y -= 24
    items.push(it_("○", 71.6, y, 14, "휴먼명조", 14), it_("중항목 내용이 길어서 다음 줄로 넘어갑니다", 91.4, y, 14, "휴먼명조"))
    y -= 21
    items.push(it_("둘째 줄 내용", 91.4, y, 14, "휴먼명조"))
    y -= 22
    items.push(it_("-", 86.6, y, 14, "휴먼명조", 6), it_("소항목", 99.3, y, 14, "휴먼명조"))
    y -= 22
  }
  items.push(it_("-", 330, 300, 10, "맑은 고딕", 5), it_("표 칸 안 글", 340, 300, 10, "맑은 고딕"))
  items.push(it_("- 1 -", 290, 40, 10, "휴먼명조", 25))
  return { width: 595.3, height: 841.9, items, fills: [{ color: "#193AAA", x1: 56.7, y1: 750, x2: 90, y2: 778 }] }
}

describe("쪽 표본 → 모양", () => {
  const spec = measureLayoutFromPages([page(), page()])

  it("단계별 부호·글꼴·크기·들여쓰기 — 표 칸 안 글머리는 뺀다", () => {
    assert.deepEqual(spec.levels.map((l) => [l.depth, l.marker, l.font, l.pt]), [[0, "□", "HY헤드라인M", 15], [1, "○", "휴먼명조", 14], [2, "-", "휴먼명조", 14]])
    assert.equal(spec.levels[0].markerMm, 20)
    assert.equal(spec.levels[2].lines, 6, "표 칸 안 「-」 는 단계에 들지 않는다")
  })

  it("꺾인 줄 간격 150%, 장 번호칸 색, 쪽 번호를 뺀 가장자리", () => {
    assert.equal(spec.lineSpacing, 150)
    assert.equal(spec.chapterFill, "#193AAA")
    assert.equal(spec.edges?.left, 20)
    assert.ok(spec.edges!.bottom > 50, "쪽 번호 줄은 아래 가장자리 측정에서 빠진다")
    assert.deepEqual(spec.measuredPages, [1, 2])
  })

  it("글머리 줄이 셋 미만인 쪽(표지·목차)은 재지 않는다", () => {
    const cover: LayoutPageSample = { width: 595.3, height: 841.9, items: [it_("서울시 AI 정책 추진 현황", 150, 500, 26, "HY헤드라인M")], fills: [] }
    assert.deepEqual(measureLayoutFromPages([cover, page()]).measuredPages, [2])
  })
})

describe("잰 모양 → 공문서 옵션", () => {
  const spec = measureLayoutFromPages([page(), page()])

  it("빈 자리만 채운다 — 직접 준 단계·줄간격은 그대로, 굵기는 프리셋 값", () => {
    const r = applyMeasuredLayout({ preset: "bangchim", lineSpacing: 200, levels: { 0: { font: "HY견고딕", pt: 17 } } }, spec)
    assert.deepEqual(r.gongmun.levels?.[0], { font: "HY견고딕", pt: 17 })
    assert.equal(r.gongmun.levels?.[1]?.font, "휴먼명조")
    assert.equal(r.gongmun.levels?.[1]?.bold, true, "서울방침 ㅇ 단계 굵게(프리셋)")
    assert.equal(r.gongmun.lineSpacing, 200)
    assert.equal(r.gongmun.bullet2, "○")
    assert.ok(r.gongmun.margins && r.gongmun.margins.left === 20)
  })

  it("장 번호칸 색은 띠 표 장 머리(보고서)에만, 서울방침(상자 장 머리)은 경고", () => {
    assert.equal(applyMeasuredLayout({ preset: "report" }, spec).gongmun.bandColor, "#193AAA")
    const b = applyMeasuredLayout({ preset: "bangchim" }, spec)
    assert.equal(b.gongmun.bandColor, undefined)
    assert.ok(b.warnings.some((w) => w.includes("#193AAA")))
  })
})
