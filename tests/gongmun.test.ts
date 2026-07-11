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

  it("markerWidth — 함초롬바탕 실측 폭 합산 + 1타(부호-내용 간격)", () => {
    const body = 1500 // 15pt
    // 실측 advance(em×1000): 숫자 550, 온점 320, 한글·원문자 970, 괄호 320, 공백 500
    assert.equal(markerWidth("1.", body), Math.round(((550 + 320 + 500) / 1000) * body)) // 2055
    assert.equal(markerWidth("가.", body), Math.round(((970 + 320 + 500) / 1000) * body)) // 2685
    assert.equal(markerWidth("①", body), Math.round(((970 + 500) / 1000) * body)) // 2205
    assert.equal(markerWidth("(1)", body), Math.round(((320 + 550 + 320 + 500) / 1000) * body)) // 2535
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
    // v4.1.0 GAP-10: 기안문 여백 = 실결재 지배값 20/15/20/15 (정보소통광장 60건 중 41건 실측)
    assert.deepEqual(off.margins, { top: 20, bottom: 15, left: 20, right: 15 })
    const rep = resolveGongmun({ preset: "report" })
    assert.equal(rep.numbering, "report")
    // v4.1.0: 보고서 계열 여백 = 실측 상하 15mm (t2 「2_보고서 양식」 계열)
    assert.deepEqual(rep.margins, { top: 15, bottom: 15, left: 20, right: 20 })
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

  it("리스트 사이 표가 끼어도 번호 run 지속 (공문 관행)", async () => {
    const withTable = `1. 첫째 항목
2. 둘째 항목

| 구분 | 내용 |
| --- | --- |
| A | B |

3. 셋째 항목`
    const texts = await sectionTexts(await markdownToHwpx(withTable, { gongmun: { preset: "official" } }))
    assert.ok(texts.includes("1. 첫째 항목"))
    assert.ok(texts.includes("2. 둘째 항목"))
    assert.ok(texts.includes("3. 셋째 항목"), `표 사이 항목번호가 이어져야 함: ${texts}`)
  })

  it("하위 항목 사이 표 — 깊이별 카운터도 지속", async () => {
    const withTable = `1. 첫째
  - 하나

| A | B |
| --- | --- |
| 1 | 2 |

  - 둘
2. 둘째`
    const texts = await sectionTexts(await markdownToHwpx(withTable, { gongmun: { preset: "official" } }))
    assert.ok(texts.includes("가. 하나"), `하위 첫 항목: ${texts}`)
    assert.ok(texts.includes("나. 둘"), `표 뒤 하위 항목이 나.로 이어져야 함: ${texts}`)
    assert.ok(texts.includes("2. 둘째"))
  })

  it("리스트 뒤 본문 문단은 run을 끊는다 (표만 예외)", async () => {
    const withPara = `1. 첫째 항목
2. 둘째 항목

일반 본문 문단입니다.

1. 새 첫째
2. 새 둘째`
    const texts = await sectionTexts(await markdownToHwpx(withPara, { gongmun: { preset: "official" } }))
    assert.ok(texts.includes("1. 첫째 항목"))
    assert.ok(texts.includes("1. 새 첫째"), `문단으로 끊긴 리스트는 1.부터 재시작: ${texts}`)
    assert.ok(texts.includes("2. 새 둘째"))
  })

  // v4.1.0 GAP-10: 기안문 여백 = 실결재 지배값 20/15/20/15 (편람 공식 20/10/20/20에서 교체 —
  // 서울 정보소통광장 실결재 60건 중 41건 실측. margins 옵션으로 공식값 지정 가능)
  it("기안문 여백(위20/아래15/좌20/우15) + 머리말·꼬리말 0", async () => {
    const buf = await markdownToHwpx("# 제목\n\n본문", { gongmun: { preset: "official" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    const m = sec.match(/<hp:margin header="(\d+)" footer="(\d+)" gutter="0" left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/)!
    assert.ok(m, "secPr margin 존재")
    assert.equal(m[5], "5669") // top 20mm
    assert.equal(m[6], "4252") // bottom 15mm
    assert.equal(m[3], "5669") // left 20mm
    assert.equal(m[4], "4252") // right 15mm
    assert.equal(m[1], "0") // header
    assert.equal(m[2], "0") // footer
  })

  // v4.1.0 GAP-01: colPr 미방출 시 한글이 컬럼을 좌우 10mm 좁게 잡아 본문 미달·표 우측 침범
  // (COM 실렌더 실측). secPr 뒤 같은 run에 단 컬럼 정의가 반드시 있어야 한다
  it("colPr 방출 — secPr 뒤 같은 run에 단 컬럼 정의", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "official" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    assert.match(sec, /<\/hp:secPr><hp:ctrl><hp:colPr[^>]*colCount="1"/)
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

// ─── 개조식(gaejosik) 프리셋 ─────────────────────────

describe("gaejosik 개조식 보고서", () => {
  const md = `# 테스트 보고서 제목

## 1. 데이터 개요

### 핵심 요약

- 첫째 요점
  - 둘째 세부
- ※ 참고 문구입니다

> 인용 참고

## 2. 분석 결과

본문 문단.

※ 문단형 참고
`

  it("프리셋 별칭 해석 (개조식/정부보고서 → gaejosik)", () => {
    for (const p of ["gaejosik", "개조식", "정부보고서", "정부표준개조식보고서"] as const) {
      const g = resolveGongmun({ preset: p })
      assert.equal(g.preset, "gaejosik")
      assert.equal(g.numbering, "gaejosik")
      assert.ok(g.cover, "표지 기본 켜짐")
      assert.equal(g.toc, true)
    }
    // 다른 프리셋은 표지·목차 기본 꺼짐
    const off = resolveGongmun({ preset: "official" })
    assert.equal(off.cover, null)
    assert.equal(off.toc, false)
  })

  it("표지·목차·장 헤더 로마숫자 생성", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { date: "2026. 7. 10.", org: "테스트기관" } } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("테스트 보고서 제목"), "표지 제목")
    assert.ok(texts.includes("2026. 7. 10."), "표지 날짜")
    assert.ok(texts.includes("테스트기관"), "표지 기관명")
    assert.ok(texts.includes("목  차"), "목차 라벨")
    assert.ok(texts.includes("Ⅰ") && texts.includes("Ⅱ"), "로마숫자 장 번호")
    assert.ok(texts.some((t) => t.includes("데이터 개요") && !t.includes("1.")), "장 제목 선행번호 제거")
  })

  it("h3→□, 리스트 시프트(○/-), ※·인용→참고 스타일", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("□ 핵심 요약"), "h3 → □")
    assert.ok(texts.includes("○ 첫째 요점"), "h3 있으면 리스트 depth0 → ○")
    assert.ok(texts.includes("- 둘째 세부"), "depth1 → - (하이픈, 실무 관행 — ― 아님)")
    assert.ok(texts.includes("※ 참고 문구입니다"), "※ 항목은 부호 없이 유지")
    assert.ok(texts.includes("※ 인용 참고"), "인용문 → ※")
    assert.ok(texts.includes("※ 문단형 참고"), "※ 문단 유지")
  })

  it("h3 없으면 리스트 depth0 → □", async () => {
    const noH3 = `## 장 제목\n\n- 대항목\n  - 중항목`
    const buf = await markdownToHwpx(noH3, { gongmun: { preset: "개조식", cover: false, toc: false } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("□ 대항목"))
    assert.ok(texts.includes("○ 중항목"))
  })

  it("header: 부호별 폰트(헤드라인M·휴먼명조·한양중고딕)와 개조식 borderFill", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const hdr = await headerXml(buf)
    for (const face of ["HY헤드라인M", "휴먼명조", "한양중고딕", "한양신명조"]) {
      assert.ok(hdr.includes(`face="${face}"`), `폰트 ${face}`)
    }
    // □ 16pt 헤드라인M(id 11), ※ 13pt 한양중고딕(id 13), 장 로마 17pt 흰색(id 15)
    assert.match(hdr, /<hh:charPr id="11" height="1600"/)
    assert.match(hdr, /<hh:charPr id="13" height="1300"/)
    assert.match(hdr, /<hh:charPr id="15" height="1700" textColor="#FFFFFF"/)
    // 장헤더 음영·목차 박스 색 (실측)
    assert.ok(hdr.includes("#193AAA") && hdr.includes("#514BAC") && hdr.includes("#F2F2F2"))
  })

  it("표지·목차 끄기 + 쪽나눔 플래그", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: false, toc: false } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(!sec.includes("목  차"), "목차 없음")
    assert.ok(!sec.includes('pageBreak="1"'), "전면부 없으면 쪽나눔 없음")
    const withAll = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const sec2 = await (await JSZip.loadAsync(withAll)).file("Contents/section0.xml")!.async("text")
    assert.ok((sec2.match(/pageBreak="1"/g) || []).length >= 2, "표지→목차→본문 쪽나눔 2회")
  })

  it("기존 프리셋 회귀 없음 (official 항목부호·report 불릿)", async () => {
    const buf = await markdownToHwpx("1. 항목\n  - 하위 가\n  - 하위 나\n2. 항목 둘", { gongmun: { preset: "official" } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("1. 항목") && texts.includes("가. 하위 가") && texts.includes("2. 항목 둘"))
    const rep = await markdownToHwpx("- 항목", { gongmun: { preset: "report" } })
    assert.ok((await sectionTexts(rep)).includes("□ 항목"))
  })

  it("장 헤더 keepWithNext — 쪽 하단 고아 헤더 방지", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const hdr = await headerXml(buf)
    const chapterPr = hdr.match(/<hh:paraPr id="23"[\s\S]*?<\/hh:paraPr>/)![0]
    assert.match(chapterPr, /keepWithNext="1"/)
  })

  it("목차 항목 내어쓰기 — 줄바꿈 시 로마숫자 밑 감김 방지", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const hdr = await headerXml(buf)
    const tocPr = hdr.match(/<hh:paraPr id="22"[\s\S]*?<\/hh:paraPr>/)![0]
    const intent = tocPr.match(/<hc:intent value="(-\d+)"/)
    assert.ok(intent, "내어쓰기(음수 intent) 존재")
  })

  it("표지 수직 배치 — 빈5/제목/빈5/날짜/25pt빈4/기관명 (실측 구조)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { date: "2026. 7. 10.", org: "테스트기관" } } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    // 날짜~기관명 사이 빈 문단은 25pt(charPr 18) — 실측 원본과 동일한 간격 체계
    const between = sec.slice(sec.indexOf("2026. 7. 10."), sec.indexOf("테스트기관"))
    const subEmpties = between.match(/charPrIDRef="18"><hp:t><\/hp:t>/g) || []
    assert.equal(subEmpties.length, 4)
  })

  it("표 공문서 스타일 — 내용 비례 열폭·헤더 음영·맑은 고딕 12pt", async () => {
    const tblMd = `## 장\n\n| 항목 | 값 |\n|---|---|\n| 기간 | 2026.01.01 ~ 07.09 실사용자 체험 메시지 전수 기준으로 집계한 장문 셀 내용 |\n| 계정 | **975개** |\n`
    const buf = await markdownToHwpx(tblMd, { gongmun: { preset: "개조식", cover: false, toc: false } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    const hdr = await headerXml(buf)
    // 셀 전용 charPr 22(맑은 고딕 12pt)·bold 23, 폰트 목록에 맑은 고딕
    assert.match(hdr, /<hh:charPr id="22" height="1200"/)
    assert.match(hdr, /<hh:charPr id="23" height="1200"[^>]*bold="1"/)
    assert.ok(hdr.includes(`face="맑은 고딕"`))
    assert.ok(sec.includes('charPrIDRef="22"'), "표 셀 본문 charPr 22")
    assert.ok(sec.includes('charPrIDRef="23"'), "표 셀 강조 charPr 23")
    // 헤더행 음영(#E6E6E6) + 하변 이중선(DOUBLE_SLIM) — 동적 bf 레지스트리 (실측 문법)
    assert.match(hdr, /<hh:borderFill id="\d+"[\s\S]*?DOUBLE_SLIM[\s\S]*?#E6E6E6|<hh:borderFill id="\d+"[\s\S]*?#E6E6E6[\s\S]*?<\/hh:borderFill>/)
    assert.match(hdr, /DOUBLE_SLIM/)
    assert.match(hdr, /width="0\.4 mm"/)
    assert.match(sec, /repeatHeader="1"/)
    // 열폭 내용 비례 — "값" 열(장문)이 "항목" 열보다 훨씬 넓다 (장헤더 표 제외, 데이터 표만)
    const dataTbl = sec.slice(sec.indexOf('repeatHeader="1"'))
    const widths = [...dataTbl.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => +m[1])
    const [w0, w1] = widths
    assert.ok(w1 > w0 * 2, `내용 비례 열폭 (항목 ${w0} < 값 ${w1})`)
    // 표 전체 폭 = 본문 폭 − 1800 (실측: 데이터 표는 본문폭보다 좁게 + 우측 배치)
    assert.equal(w0 + w1, mmToHwpunit(170) - 1800)
  })

  it("표 스타일 — 비공문서 모드는 기존 유지(음영·반복 없음), 열폭만 비례", async () => {
    const tblMd = `| 라벨 | 아주 길게 늘어나는 내용 열입니다 반복 반복 반복 반복 |\n|---|---|\n| a | 짧음 |\n`
    const buf = await markdownToHwpx(tblMd)
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    assert.match(sec, /repeatHeader="0"/)
    assert.ok(!sec.includes('borderFillIDRef="9"'), "비공문서엔 음영 bf 없음")
    const widths = [...sec.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => +m[1])
    assert.ok(widths[1] > widths[0], "열폭 내용 비례")
  })

  it("열폭 배분 — 열 많은 표에서도 음수·최소폭 미달 없음 (합계 = 표 폭)", async () => {
    const long = "이것은 아주 길게 늘어나는 셀 내용이라 비례 배분에서 큰 몫을 요구한다"
    const header = `| ${[...Array(10)].map((_, i) => `h${i}`).join(" | ")} |`
    const sep = `|${"---|".repeat(10)}`
    const row = `| ${long} | ${long} | ${long} | ${long} | ${long} | a | b | c | d | e |`
    const buf = await markdownToHwpx(`## 장\n\n${header}\n${sep}\n${row}\n`, { gongmun: { preset: "개조식", cover: false, toc: false } })
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const dataTbl = sec.slice(sec.indexOf('repeatHeader="1"'))
    const firstRow = dataTbl.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)![0]
    const widths = [...firstRow.matchAll(/<hp:cellSz width="(-?\d+)"/g)].map((m) => +m[1])
    assert.equal(widths.length, 10)
    const tblW = mmToHwpunit(170) - 1800 // 데이터 표 축폭 (실측 관행)
    const minW = Math.floor(tblW * 0.06)
    for (const w of widths) assert.ok(w >= minW, `열폭 ${w} ≥ 최소폭`)
    assert.equal(widths.reduce((a, b) => a + b, 0), tblW)
  })

  it("GFM 셀 <br> — 문단 분리로 렌더 (리터럴 노출 금지)", async () => {
    const buf = await markdownToHwpx(`| a | b |\n|---|---|\n| 첫줄<br>둘째줄 | x |\n`)
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    assert.ok(!sec.includes("&lt;br&gt;"), "리터럴 <br> 없음")
    const cell = sec.slice(sec.indexOf("첫줄") - 200, sec.indexOf("둘째줄") + 100)
    assert.ok((cell.match(/<hp:p /g) || []).length >= 2, "<br>이 문단 분리로")
  })

  it("theme 표헤더 옵션은 공문서 표 스타일에 누수되지 않음", async () => {
    const tblMd = `## 장\n\n| 항목 | 값 |\n|---|---|\n| a | b |\n`
    const buf = await markdownToHwpx(tblMd, { theme: { tableHeaderBold: true }, gongmun: { preset: "개조식", cover: false, toc: false } })
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const dataTbl = sec.slice(sec.indexOf('repeatHeader="1"'))
    assert.ok(!dataTbl.includes('charPrIDRef="9"'), "공문서 표엔 CHAR_TABLE_HEADER(9) 미사용")
    assert.ok(dataTbl.includes('charPrIDRef="22"'), "표 전용 charPr 22 사용")
  })

  it("표지 장식 바 셀 — 전용 소형 charPr(6pt)·저줄간격으로 바 높이 유지", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { date: "2026. 7. 10." } } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    const hdr = await headerXml(buf)
    assert.match(hdr, /<hh:charPr id="24" height="600"/)
    const coverTbl = sec.slice(sec.indexOf("<hp:tbl"), sec.indexOf("</hp:tbl>"))
    assert.ok(coverTbl.includes(`paraPrIDRef="24" styleIDRef="0"><hp:run charPrIDRef="24"`), "바 셀 빈 문단이 전용 스타일")
  })

  it("볼드 charPr — <hh:bold/> 자식 요소 방출 (실측 한컴 정본)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const hdr = await headerXml(buf)
    const roman = hdr.match(/<hh:charPr id="15"[\s\S]*?<\/hh:charPr>/)![0]
    assert.ok(roman.includes("<hh:bold/>"), "장 로마숫자 bold 요소")
  })

  it("긴 표지 제목 — 30pt로 2줄 초과 시 25pt 자동 축소", async () => {
    const longTitle = "3단계 Chat Log 분석 — Waka Shorts 2026 사용자 니즈 종합 정리 (8,522건)"
    const buf = await markdownToHwpx(`# ${longTitle}\n\n## 장\n\n내용`, { gongmun: { preset: "개조식" } })
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const titleRun = sec.slice(0, sec.indexOf(escapeStub(longTitle)) + 10).lastIndexOf('charPrIDRef="18"')
    assert.ok(titleRun >= 0, "긴 제목은 charPr 18(25pt)")
    const short = await markdownToHwpx(`# 짧은 제목\n\n## 장\n\n내용`, { gongmun: { preset: "개조식" } })
    const sec2 = await (await JSZip.loadAsync(short)).file("Contents/section0.xml")!.async("text")
    assert.ok(sec2.slice(0, sec2.indexOf("짧은 제목")).includes('charPrIDRef="17"'), "짧은 제목은 30pt 유지")
  })

  it("fonts·sizes 커스터마이징 — 역할별 폰트명·요소별 pt 오버라이드", async () => {
    const tblMd = `# 제목\n\n## 장\n\n### 대항목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`
    const buf = await markdownToHwpx(tblMd, {
      gongmun: {
        preset: "개조식",
        fonts: { heading: "나눔스퀘어", table: "바탕" },
        sizes: { dae: 20, table: 11 },
      },
    })
    const hdr = await headerXml(buf)
    assert.ok(hdr.includes(`face="나눔스퀘어"`), "heading 폰트 오버라이드")
    assert.ok(hdr.includes(`face="바탕"`), "table 폰트 오버라이드")
    assert.ok(!hdr.includes(`face="HY헤드라인M"`), "기본 heading 폰트 대체됨")
    assert.match(hdr, /<hh:charPr id="11" height="2000"/) // dae 20pt
    assert.match(hdr, /<hh:charPr id="22" height="1100"/) // table 11pt
  })
})

describe("어절 줄나눔 저장값 — breakNonLatinWord 이름 역전 매핑", () => {
  // 한컴 실구현: "BREAK_WORD"=어절 유지, "KEEP_WORD"=글자 단위 (2026-07 한글 COM 실렌더 실측).
  // 일반·공문서·개조식 전 경로가 어절(BREAK_WORD)로 방출돼야 한다.
  it("전 경로 breakNonLatinWord=BREAK_WORD(어절)·breakLatinWord=KEEP_WORD(단어)", async () => {
    const md = "# 제목\n\n본문 문단입니다."
    const optsList = [undefined, { gongmun: { preset: "official" as const } }, { gongmun: { preset: "개조식" } }]
    for (const opts of optsList) {
      const hdr = await headerXml(await markdownToHwpx(md, opts as Parameters<typeof markdownToHwpx>[1]))
      assert.ok(!hdr.includes('breakNonLatinWord="KEEP_WORD"'), "글자 단위(KEEP_WORD)가 남아 있음")
      assert.ok(hdr.includes('breakNonLatinWord="BREAK_WORD"'), "어절(BREAK_WORD) 방출 없음")
      assert.ok(hdr.includes('breakLatinWord="KEEP_WORD"'), "라틴 단어 유지 없음")
      assert.ok(!hdr.includes('breakLatinWord="BREAK_WORD"'), "라틴이 글자 단위로 방출됨")
    }
  })
})

describe("공문서 v4 구조 요소 — 쪽번호·제목박스·배너·결재란·끝표시", () => {
  const md = "# 보고서 제목\n\n## 첫 장\n\n- 항목 하나\n\n## 둘째 장\n\n- 항목 둘"
  const sectionOf = async (buf: ArrayBuffer) =>
    await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")

  it("쪽번호 — 개조식 하단 중앙 + 본문 newNum 1 리셋 (실측 GT3)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { org: "기관" } } })
    const sec = await sectionOf(buf)
    assert.ok(sec.includes('<hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/>'), "쪽번호 ctrl")
    assert.ok(sec.includes('<hp:newNum num="1" numType="PAGE"/>'), "본문 쪽번호 1 리셋")
    // 머리말·꼬리말 영역 15mm (실측 GT3 4251)
    assert.match(sec, /header="4251" footer="4251"/)
    // 기안문(official)은 기본 꺼짐
    const off = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "official" } }))
    assert.ok(!off.includes("<hp:pageNum"), "기안문 기본 쪽번호 없음")
  })

  it("본문 첫 페이지 제목박스 — 표지 축소판 3×3, 22pt, 새 페이지 선두 (실측 GT3 표④)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { org: "기관" } } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    assert.match(hdr, /<hh:charPr id="25" height="2200"/)
    const boxAt = sec.indexOf('charPrIDRef="25"')
    assert.ok(boxAt > 0, "본문 제목박스 charPr 25 사용")
    const host = sec.lastIndexOf("<hp:p pageBreak=\"1\"", boxAt)
    assert.ok(host > 0, "제목박스가 새 페이지 선두")
    // bodyTitleBox: false로 끌 수 있음
    const off = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { org: "기관" }, bodyTitleBox: false } }))
    assert.ok(!off.includes('charPrIDRef="25"'), "옵션 끄기")
  })

  it("목차 라벨 배너 — 1×7 스트라이프 표 + 라벤더 bf 9 (실측 GT3 표②)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "개조식" } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    assert.match(hdr, /<hh:borderFill id="9"[\s\S]*?#E0E5FA/)
    const bannerAt = sec.indexOf('colCnt="7"')
    assert.ok(bannerAt > 0, "1×7 배너 표")
    const banner = sec.slice(bannerAt, sec.indexOf("</hp:tbl>", bannerAt))
    assert.ok(banner.includes("목  차"), "배너 안 라벨")
    assert.ok(banner.includes('borderFillIDRef="9"'), "라벤더 스트라이프 셀")
  })

  it("결재란 — 직위 라벨 + 서명 공란 2행, 우측 배치 (실측 GT12 간이형)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "official", approval: ["담당", "팀장", "과장"] } })
    const sec = await sectionOf(buf)
    const at = sec.indexOf("담당")
    assert.ok(at > 0)
    const tblStart = sec.lastIndexOf("<hp:tbl", at)
    const tbl = sec.slice(tblStart, sec.indexOf("</hp:tbl>", tblStart))
    assert.match(tbl, /rowCnt="2" colCnt="3"/)
    assert.ok(tbl.includes("팀장") && tbl.includes("과장"))
    // 호스트 문단 우측정렬 (GONGMUN_RIGHT=17)
    const host = sec.slice(sec.lastIndexOf("<hp:p ", tblStart), tblStart)
    assert.ok(host.includes('paraPrIDRef="17"'), "결재란 호스트 RIGHT")
  })

  it('"끝." 표시 — 기안문 기본, 중복 방지', async () => {
    const buf = await markdownToHwpx("# 알림\n\n본문입니다.", { gongmun: { preset: "official" } })
    const sec = await sectionOf(buf)
    assert.ok(sec.includes("  끝."), "끝. 문단")
    // 이미 끝.으로 마감된 본문엔 중복 추가 안 함
    const dup = await sectionOf(await markdownToHwpx("# 알림\n\n붙임 1부.  끝.", { gongmun: { preset: "official" } }))
    assert.equal((dup.match(/끝\./g) || []).length, 1)
    // 보고서 프리셋은 기본 꺼짐
    const rep = await sectionOf(await markdownToHwpx("# 보고\n\n본문", { gongmun: { preset: "report" } }))
    assert.ok(!rep.includes("  끝."), "report 기본 없음")
  })

  it("<right> 태그 — 출처행 우측정렬 (실측 GT2/GT6/GT7 관행)", async () => {
    const buf = await markdownToHwpx("# 제목\n\n<right>2026. 7. 11. 홍보담당관</right>\n\n본문", { gongmun: { preset: "report" } })
    const sec = await sectionOf(buf)
    const at = sec.indexOf("홍보담당관")
    const para = sec.slice(sec.lastIndexOf("<hp:p ", at), at)
    assert.ok(para.includes('paraPrIDRef="17"'), "출처행 RIGHT paraPr")
  })

  it("report/plan 제목박스 — 색상바+제목+gradient 3단 (실측 GT2/GT6/GT7)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "report" } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    assert.match(hdr, /<hc:gradation[\s\S]*?#0080C0[\s\S]*?#3CBFFF/)
    assert.match(hdr, /#0080C0/)
    const at = sec.indexOf(escapeStub("보고서 제목"))
    const tblStart = sec.lastIndexOf("<hp:tbl", at)
    assert.ok(tblStart > 0, "제목이 표 안에")
    assert.match(sec.slice(tblStart, at), /rowCnt="3" colCnt="1"/)
  })

  it("표 실측 문법 — 헤더 bold·하변 이중선·외곽 0.4mm·라벨열 음영·호스트 RIGHT", async () => {
    const tblMd = `## 장\n\n| 구분 | 내용 |\n|---|---|\n| 기간 | 2026년 상반기 실사용 데이터 전수 기준으로 집계한 결과이며 부서별 세부 집계표와 월별 추이 분석 자료를 함께 첨부하여 보고하는 장문 셀 |\n| 대상 | 전 부서 |\n`
    const buf = await markdownToHwpx(tblMd, { gongmun: { preset: "개조식", cover: false, toc: false } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    const dataTbl = sec.slice(sec.indexOf('repeatHeader="1"'), sec.indexOf("</hp:tbl>", sec.indexOf('repeatHeader="1"')))
    // 헤더행 셀 charPr 23(bold)
    const firstRow = dataTbl.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)![0]
    assert.ok(firstRow.includes('charPrIDRef="23"'), "헤더 bold")
    // 라벨열(2열 표 짧은 1열) 음영 #E7E7E7 + bold
    assert.match(hdr, /#E7E7E7/)
    // 이중선·굵은 외곽 (동적 bf)
    assert.match(hdr, /DOUBLE_SLIM/)
    assert.match(hdr, /width="0\.4 mm"/)
    // 호스트 RIGHT + 셀 문단 전용 paraPr(18=CENTER 130% / 19=LEFT 130%)
    const host = sec.slice(sec.lastIndexOf("<hp:p ", sec.indexOf('repeatHeader="1"')), sec.indexOf('repeatHeader="1"'))
    assert.ok(host.includes('paraPrIDRef="17"'), "데이터 표 호스트 RIGHT")
    assert.ok(dataTbl.includes('paraPrIDRef="18"'), "셀 CENTER 130%")
    assert.ok(dataTbl.includes('paraPrIDRef="19"'), "장문 열 LEFT 130%")
  })

  it("A3 기하 크기연동 — chapter/coverTitle 크기를 키우면 표 높이도 비례", async () => {
    const base = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { org: "기관" } } }))
    const big = await sectionOf(await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: { org: "기관" }, sizes: { chapter: 34, coverTitle: 60 } } }))
    const rowH = (s: string) => +(s.match(/colCnt="3"[\s\S]*?<hp:cellSz width="3327" height="(\d+)"/)?.[1] ?? 0)
    assert.equal(rowH(base), 2832)
    assert.equal(rowH(big), 5664) // 17pt→34pt 2배
  })
})

/** 제목 검색용 — XML 이스케이프된 형태로 (— 등은 그대로) */
function escapeStub(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ─── v4.0.1 QA 수정 (실측 폰트·h2 말머리·표기법 린터) ──

describe("v4.0.1 실측 폰트 프리셋 (QA-1)", () => {
  const md = `# 제목\n\n## 개요\n\n본문 **강조** 문장임\n\n- 대항목\n\n※ 자료: 행안부`

  it("보고서 프리셋 — 휴먼명조 본문·HY헤드라인M 제목·한양중고딕 ※ 폰트 세트", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "보고서" } })
    const head = await headerXml(buf)
    for (const f of ["휴먼명조", "HY헤드라인M", "한양중고딕", "맑은 고딕"]) {
      assert.ok(head.includes(`face="${f}"`), `폰트 세트에 ${f}`)
    }
    // 본문(0)·볼드(1) = 휴먼명조(id 4), h2(6) = HY헤드라인M(id 3, bold 없음)
    assert.match(head, /<hh:charPr id="0" height="1500"[^>]*>\s*<hh:fontRef hangul="4"/)
    assert.match(head, /<hh:charPr id="1" height="1500"[^>]*bold="1"[^>]*>\s*<hh:fontRef hangul="4"/)
    assert.match(head, /<hh:charPr id="6" height="1600"[^>]*>\s*<hh:fontRef hangul="3"/)
    assert.ok(!/<hh:charPr id="6"[^>]*bold="1"/.test(head), "h2는 HY헤드라인M 자체 굵기 (bold 없음)")
  })

  it("볼드 폰트 치환 제거 — 범용·기안문 볼드가 원 폰트 유지 (HY견고딕 참조 없음)", async () => {
    for (const opts of [undefined, { gongmun: { preset: "기안문" as const } }]) {
      const head = await headerXml(await markdownToHwpx("**굵게** 본문", opts))
      assert.match(head, /<hh:charPr id="1" [^>]*bold="1"[^>]*>\s*<hh:fontRef hangul="0"/)
    }
  })

  it("보고서 ※ 문단 — 참고 스타일(charPr 13)·리스트 □는 HY헤드라인M(charPr 11)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "보고서" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(sec.includes(`charPrIDRef="13"><hp:t>※ 자료: 행안부</hp:t>`), "※ → 한양중고딕 참고")
    assert.ok(sec.includes(`charPrIDRef="11"><hp:t>□ 대항목</hp:t>`), "리스트 □ → HY헤드라인M 16pt")
  })
})

describe("v4.0.1 h2 말머리 (QA-2)", () => {
  const md = `# 문서 제목\n\n## 개요\n\n내용임\n\n## 1. 추진 성과\n\n내용임`

  it("보고서·계획서 기본 — h2에 □ 말머리 + 선행 번호 제거", async () => {
    for (const preset of ["보고서", "계획서"] as const) {
      const texts = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset } }))
      assert.ok(texts.includes("□ 개요"), `${preset} h2 → □ 개요`)
      assert.ok(texts.includes("□ 추진 성과"), `${preset} 선행 번호 제거 후 □`)
    }
  })

  it("h2Marker number — 아라비아 순번 재부여", async () => {
    const texts = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "number" } }))
    assert.ok(texts.includes("1. 개요"))
    assert.ok(texts.includes("2. 추진 성과"))
  })

  it("h2Marker none — 말머리 없음, 기안문 기본도 없음", async () => {
    const t1 = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "none" } }))
    assert.ok(t1.includes("개요") && !t1.includes("□ 개요"))
    const t2 = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "기안문" } }))
    assert.ok(t2.includes("개요") && !t2.includes("□ 개요"), "기안문은 기본 말머리 없음")
  })

  it("개조식 h2는 장 헤더가 소비 — h2Marker 영향 없음", async () => {
    const texts = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: false, toc: false } }))
    assert.ok(!texts.includes("□ 개요"), "개조식 h2 = 로마숫자 장헤더 (□ 아님)")
  })
})
