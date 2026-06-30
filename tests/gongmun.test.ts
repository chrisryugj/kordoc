/** 공문서 모드(gongmun) 테스트 — 항목부호 8단계·들여쓰기·여백·라운드트립 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"
import {
  hangulOrdinal,
  circledNumber,
  circledHangul,
  standardMarker,
  reportMarker,
  markerWidth,
  levelIndent,
  computeSuppression,
  resolveGongmun,
  mmToHwpunit,
} from "../src/hwpx/gongmun.js"

// ─── 순수 로직 ──────────────────────────────────────

describe("gongmun 순수 로직", () => {
  it("가나다 순서 + 단모음 연속(가→하→거→너)", () => {
    assert.equal(hangulOrdinal(0), "가")
    assert.equal(hangulOrdinal(1), "나")
    assert.equal(hangulOrdinal(13), "하")
    assert.equal(hangulOrdinal(14), "거") // 단모음 연속
    assert.equal(hangulOrdinal(15), "너")
  })

  it("원숫자/원한글 단일 유니코드", () => {
    assert.equal(circledNumber(0), "①")
    assert.equal(circledNumber(0).codePointAt(0), 0x2460)
    assert.equal(circledHangul(0), "㉮")
    assert.equal(circledHangul(0).codePointAt(0), 0x326e)
  })

  it("8단계 표준 마커 — 5·6단계는 괄호 3글자, 7·8은 단일문자", () => {
    assert.equal(standardMarker(0, 0), "1.")
    assert.equal(standardMarker(1, 0), "가.")
    assert.equal(standardMarker(2, 0), "1)")
    assert.equal(standardMarker(3, 0), "가)")
    assert.equal(standardMarker(4, 0), "(1)")
    assert.equal(standardMarker(4, 0).length, 3) // 괄호 3글자
    assert.equal(standardMarker(5, 0), "(가)")
    assert.equal(standardMarker(6, 0), "①")
    assert.equal(standardMarker(7, 0), "㉮")
  })

  it("표준 마커 카운터 — 2번째 항목", () => {
    assert.equal(standardMarker(0, 1), "2.")
    assert.equal(standardMarker(1, 2), "다.")
  })

  it("report 불릿 □ ○ - ㆍ", () => {
    assert.equal(reportMarker(0), "□")
    assert.equal(reportMarker(1), "○")
    assert.equal(reportMarker(2), "-")
    assert.equal(reportMarker(3), "ㆍ")
  })

  it("markerWidth — 전각·반각·문장부호 폭 합산 + 1타(부호-내용 간격)", () => {
    const body = 1500 // 15pt
    assert.equal(markerWidth("1.", body), 1875) // 숫자750 + 온점375 + 1타750
    assert.equal(markerWidth("가.", body), 2625) // 한글1500 + 온점375 + 1타750
    assert.equal(markerWidth("①", body), 2250) // 원문자1500 + 1타750
    // 한글 부호가 숫자 부호보다 넓다(고정값으로는 못 맞추는 차이)
    assert.ok(markerWidth("가.", body) > markerWidth("1.", body))
  })

  it("levelIndent — left=누적 깊이, intent=부호 실제폭만큼 내어쓰기", () => {
    const body = 1500 // 15pt
    const d0 = levelIndent(0, body, "standard")
    // depth0: 첫 줄(부호) = left = 0(왼쪽 기본선), 둘째 줄 = left+|intent|
    assert.equal(d0.left, 0)
    assert.ok(d0.indent < 0, "내어쓰기는 음수 intent")
    // 둘째 줄 정렬 위치 = 부호 '1.'의 실제 렌더폭(markerWidth)
    assert.equal(d0.left - d0.indent, markerWidth("1.", body))
    const d1 = levelIndent(1, body, "standard")
    // depth1 첫 줄 = 2타(=body) 위치
    assert.equal(d1.left, body)
    // 부호마다 폭이 다르다 — '가.'(한글)는 '1.'(숫자)보다 넓게 내어쓴다
    assert.ok(Math.abs(d1.indent) > Math.abs(d0.indent))
    // 괄호 부호 '(1)'(5단계)도 '1.'보다 깊은 내어쓰기
    const d4 = levelIndent(4, body, "standard")
    assert.ok(Math.abs(d4.indent) > Math.abs(d0.indent))
  })

  it("단일 형제 부호 생략(2-pass)", () => {
    // [0,0,0] 형제 3 → 생략 없음
    assert.deepEqual(computeSuppression([0, 0, 0]), [false, false, false])
    // [0] 단독 → 생략
    assert.deepEqual(computeSuppression([0]), [true])
    // [0,1] depth1 형제 1개 → depth1 생략
    assert.deepEqual(computeSuppression([0, 1]), [true, true])
    // [0,1,1,0] depth1 형제 2 → 표시, depth0 형제 2 → 표시
    assert.deepEqual(computeSuppression([0, 1, 1, 0]), [false, false, false, false])
  })

  it("resolveGongmun 프리셋 기본값", () => {
    const off = resolveGongmun({ preset: "official" })
    assert.equal(off.bodyHeight, 1500)
    assert.equal(off.numbering, "standard")
    assert.deepEqual(off.margins, { top: 20, bottom: 10, left: 20, right: 20 })
    const rep = resolveGongmun({ preset: "report" })
    assert.equal(rep.numbering, "report")
    const min = resolveGongmun({ preset: "minutes" })
    assert.equal(min.bodyHeight, 1400)
    assert.equal(min.lineSpacing, 130)
  })

  it("mmToHwpunit 환산", () => {
    assert.equal(mmToHwpunit(20), 5669) // 20mm
    assert.equal(mmToHwpunit(10), 2835)
  })
})

// ─── 렌더링 통합 ────────────────────────────────────

async function sectionTexts(buf: ArrayBuffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf)
  const sec = await zip.file("Contents/section0.xml")!.async("text")
  return [...sec.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).filter(Boolean)
}
async function headerXml(buf: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return await zip.file("Contents/header.xml")!.async("text")
}

describe("gongmun 렌더링", () => {
  const md = `1. 첫째 항목
  - 둘째 가
  - 둘째 나
    - 셋째 가
    - 셋째 나
2. 둘째 항목`

  it("깊이→항목부호 강제 매핑 (마크다운 마커 종류 무시)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "official" } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("1. 첫째 항목"))
    assert.ok(texts.includes("가. 둘째 가"))
    assert.ok(texts.includes("나. 둘째 나"))
    assert.ok(texts.includes("1) 셋째 가")) // 하위 진입 시 카운터 리셋
    assert.ok(texts.includes("2) 셋째 나"))
    assert.ok(texts.includes("2. 둘째 항목"))
  })

  it("공식 여백(위20/아래10/좌20/우20) + 머리말·꼬리말 0", async () => {
    const buf = await markdownToHwpx("# 제목\n\n본문", { gongmun: { preset: "official" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    const m = sec.match(/<hp:margin header="(\d+)" footer="(\d+)" gutter="0" left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/)!
    assert.ok(m, "secPr margin 존재")
    assert.equal(m[5], "5669") // top 20mm
    assert.equal(m[6], "2835") // bottom 10mm
    assert.equal(m[3], "5669") // left 20mm
    assert.equal(m[4], "5669") // right 20mm
    assert.equal(m[1], "0") // header
    assert.equal(m[2], "0") // footer
  })

  it("본문 15pt(height 1500)", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "official" } })
    const head = await headerXml(buf)
    assert.match(head, /<hh:charPr id="0" height="1500"/)
  })

  it("report 프리셋 불릿 □○- (단일 형제도 표시)", async () => {
    const rep = `1. 현황
  - 단독 자식`
    const texts = await sectionTexts(await markdownToHwpx(rep, { gongmun: { preset: "report" } }))
    assert.ok(texts.includes("□ 현황"))
    assert.ok(texts.includes("○ 단독 자식")) // report는 단일 형제 생략 안 함
  })

  it("<center> → 가운데정렬 단락", async () => {
    const buf = await markdownToHwpx("<center>광 진 구 청</center>", { gongmun: { preset: "official" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    // 가운데정렬 paraPr(16) 사용 + 태그 제거된 텍스트
    assert.match(sec, /paraPrIDRef="16"/)
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("광 진 구 청"))
    assert.ok(!texts.some((t) => t.includes("<center>")))
  })

  it("라운드트립 — 생성 HWPX 재파싱 + 텍스트 보존", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "notice" } })
    const r = await parse(buf)
    assert.equal(r.success, true)
    if (r.success) {
      assert.ok(r.markdown.includes("첫째 항목"))
      assert.ok(r.markdown.includes("셋째 나"))
    }
  })

  it("gongmun 미지정 시 기존 동작 유지(본문 10pt, 기존 여백)", async () => {
    const buf = await markdownToHwpx("본문")
    const head = await headerXml(buf)
    assert.match(head, /<hh:charPr id="0" height="1000"/) // 기존 10pt
  })
})
