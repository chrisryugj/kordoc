/** 공문서 모드(gongmun) 테스트 — 항목부호 8단계·들여쓰기·여백·라운드트립 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse, validateHwpx } from "../src/index.js"
import { measureTextWidth, simulateWrap, faceClassForGen } from "../src/hwpx/text-metrics.js"
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
  needsGaejosikAssets,
} from "../src/hwpx/gongmun.js"

// ─── 순수 로직 ──────────────────────────────────────

/** 텍스트를 담은 문단의 paraPr/charPr XML (v5 레지스트리 id는 동적이라 조회로 확인) */
function prOf(sec: string, head: string, text: string): { para: string; char: string } {
  const at = sec.indexOf(`<hp:t>${text}`)
  if (at < 0) throw new Error(`문단 없음: ${text}`)
  const pStart = sec.lastIndexOf("<hp:p ", at)
  const pid = sec.slice(pStart).match(/paraPrIDRef="(\d+)"/)![1]
  const cid = sec.slice(sec.lastIndexOf("<hp:run ", at)).match(/charPrIDRef="(\d+)"/)![1]
  const para = head.match(new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?</hh:paraPr>`))![0]
  const char = head.match(new RegExp(`<hh:charPr id="${cid}"[\\s\\S]*?</hh:charPr>`))![0]
  return { para, char }
}
const fontIdOf = (head: string, face: string) => head.match(new RegExp(`<hh:fontface lang="HANGUL"[\\s\\S]*?<hh:font id="(\\d+)" face="${face}"`))?.[1]

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
    assert.equal(off.bodyHeight, 1200)
    assert.equal(off.numbering, "standard")
    // v4.1.0 GAP-10: 기안문 여백 = 실결재 지배값 20/15/20/15 (정보소통광장 60건 중 41건 실측)
    assert.deepEqual(off.margins, { top: 20, bottom: 15, left: 20, right: 15 })
    const rep = resolveGongmun({ preset: "report" })
    assert.equal(rep.numbering, "report")
    // v5: 서울 보고서형 기안 여백 = 실결재 개조식 문서 지배값 13/13/18/18 (머리·꼬리 13)
    assert.deepEqual(rep.margins, { top: 13, bottom: 13, left: 18, right: 18 })
    assert.equal(rep.headerFooter, 3600)
    const min = resolveGongmun({ preset: "minutes" })
    assert.equal(min.bodyHeight, 1400)
    assert.equal(min.lineSpacing, 130)
  })

  it("공문서 수치 옵션 — NaN·무한대·비정상 범위를 거부", () => {
    assert.throws(() => resolveGongmun({ bodyPt: Number.NaN }), /bodyPt/)
    assert.throws(() => resolveGongmun({ bodyPt: 5 }), /bodyPt/)
    assert.throws(() => resolveGongmun({ lineSpacing: Number.POSITIVE_INFINITY }), /lineSpacing/)
    assert.throws(() => resolveGongmun({ lineSpacing: 49 }), /lineSpacing/)
    assert.throws(
      () => resolveGongmun({ margins: { top: 20 } } as unknown as Parameters<typeof resolveGongmun>[0]),
      /margins\.bottom/,
    )
    assert.throws(() => resolveGongmun({ margins: { top: 20, bottom: 15, left: 110, right: 110 } }), /margins/)
    assert.throws(() => resolveGongmun({ sizes: { chapter: 61 } }), /sizes\.chapter/)
    assert.throws(() => resolveGongmun({ approval: ["1", "2", "3", "4", "5", "6", "7"] }), /approval/)
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

  it("기안문 본문 12pt(height 1200) — 서울시 실결재 104건 지배값", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "official" } })
    const head = await headerXml(buf)
    assert.match(head, /<hh:charPr id="0" height="1200"/)
  })

  it("계획서 기본 항목부호 — 서울 실측 □ → ㅇ → - (v5)", async () => {
    const buf = await markdownToHwpx("- 대항목\n  - 중항목\n    - 세부", { gongmun: { preset: "plan" } })
    const texts = await sectionTexts(buf)
    assert.ok(texts.includes("□ 대항목"))
    assert.ok(texts.includes("ㅇ 중항목"))
    assert.ok(texts.includes("- 세부"))
  })

  it("사용자 지정 폰트명 XML 특수문자 — 이스케이프 후 구조 검증 통과", async () => {
    const buf = await markdownToHwpx("본문", {
      gongmun: { preset: "report", fonts: { body: 'A&B"<폰트>' } },
    })
    const head = await headerXml(buf)
    assert.ok(head.includes('face="A&amp;B&quot;&lt;폰트&gt;"'))
    const validation = await validateHwpx(buf)
    assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join("\n"))
  })

  it("report 프리셋 불릿 □ㅇ- (단일 형제도 표시)", async () => {
    const rep = `1. 현황
  - 단독 자식`
    const texts = await sectionTexts(await markdownToHwpx(rep, { gongmun: { preset: "report" } }))
    assert.ok(texts.includes("□ 현황"))
    assert.ok(texts.includes("ㅇ 단독 자식")) // report는 단일 형제 생략 안 함
  })

  it("<center> → 가운데정렬 단락", async () => {
    const buf = await markdownToHwpx("<center>광 진 구 청</center>", { gongmun: { preset: "official" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    const head = await zip.file("Contents/header.xml")!.async("text")
    assert.match(prOf(sec, head, "광 진 구 청").para, /horizontal="CENTER"/)
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

  it("보고서 표지(서울형: 문서정보표·결재선·파랑 띠·기관명) — 목차는 v5 보고서에 없음", async () => {
    const buf = await markdownToHwpx(md, {
      gongmun: { preset: "report", cover: { date: "2026. 7. 11.", org: "테스트기관", dept: "스마트도시과" }, approval: ["주무관", "팀장", "과장"], docInfo: { docNum: "스마트도시과-1" } },
    })
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    assert.ok(!sec.includes("목  차"), "v5 보고서는 목차 없음")
    assert.ok(/테\s+스\s+트\s+기\s+관/.test(sec), "표지 기관명(자간 띄움)")
    assert.ok(sec.includes("(스마트도시과)") && sec.includes("문서번호") && sec.includes("스마트도시과-1"), "부서명·문서정보표")
    assert.ok((sec.match(/pageBreak="1"/g) || []).length >= 1, "표지→본문 쪽나눔")
    const validation = await validateHwpx(buf)
    assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join("\n"))
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
  it("범용·개조식(구 경로)은 어절(BREAK_WORD)·라틴 단어 유지", async () => {
    const md = "# 제목\n\n본문 문단입니다.\n\n- 항목 하나"
    for (const opts of [undefined, { gongmun: { preset: "개조식" } }]) {
      const hdr = await headerXml(await markdownToHwpx(md, opts as Parameters<typeof markdownToHwpx>[1]))
      assert.ok(!hdr.includes('breakNonLatinWord="KEEP_WORD"'), "글자 단위(KEEP_WORD)가 남아 있음")
      assert.ok(hdr.includes('breakNonLatinWord="BREAK_WORD"'), "어절(BREAK_WORD) 방출 없음")
      assert.ok(hdr.includes('breakLatinWord="KEEP_WORD"'), "라틴 단어 유지 없음")
      assert.ok(!hdr.includes('breakLatinWord="BREAK_WORD"'), "라틴이 글자 단위로 방출됨")
    }
  })
  // v5 본문은 글자 단위(KEEP_WORD)+양쪽정렬 — 서울 실결재 개조식 `-` 문단 76%(다줄 88%)·법정형 97%.
  // 라운드 1의 어절유지+양쪽정렬(실측 1.2%)은 긴 어절이 통째로 다음 줄로 밀려 앞 줄 어절 간격이 벌어졌다
  // (2026-09-06 실렌더, 유저 결정으로 전환). 라틴·숫자는 breakLatinWord=KEEP_WORD 로 계속 단어 유지.
  it("v5(기안문·보고서) 본문 항목·서술 문단은 글자 단위(KEEP_WORD)+양쪽정렬, 라틴 단어 유지", async () => {
    const md = "# 제목\n\n본문 문단입니다.\n\n- 항목 하나"
    for (const [preset, marker] of [["official", "1. 항목 하나"], ["report", "□ 항목 하나"]] as const) {
      const buf = await markdownToHwpx(md, { gongmun: { preset } })
      const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text"), hdr = await headerXml(buf)
      for (const text of [marker, "본문 문단입니다."]) {
        const { para } = prOf(sec, hdr, text)
        assert.ok(para.includes('breakNonLatinWord="KEEP_WORD"'), `${preset} ${text}: 글자 단위 아님`)
        assert.ok(para.includes('breakLatinWord="KEEP_WORD"'), `${preset} ${text}: 라틴 단어 유지 없음`)
        assert.ok(para.includes('horizontal="JUSTIFY"'), `${preset} ${text}: 양쪽정렬 아님`)
      }
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

  it("결재란 — 직위 라벨 + 서명 공란 2행, 우측 배치 (서울 결재선 12pt, v5)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "official", approval: ["담당", "팀장", "과장"] } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    const at = sec.indexOf("담당")
    assert.ok(at > 0)
    const tblStart = sec.lastIndexOf("<hp:tbl", at)
    const tbl = sec.slice(tblStart, sec.indexOf("</hp:tbl>", tblStart))
    assert.match(tbl, /rowCnt="2" colCnt="3"/)
    assert.ok(tbl.includes("팀장") && tbl.includes("과장"))
    assert.match(prOf(sec, hdr, "담당").char, /height="1200"/, "결재 라벨 12pt")
    const hostPid = sec.slice(sec.lastIndexOf("<hp:p ", tblStart), tblStart).match(/paraPrIDRef="(\d+)"/)![1]
    assert.match(hdr.match(new RegExp(`<hh:paraPr id="${hostPid}"[\\s\\S]*?</hh:paraPr>`))![0], /horizontal="RIGHT"/, "결재란 호스트 RIGHT")
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
    assert.match(prOf(sec, await headerXml(buf), "2026. 7. 11. 홍보담당관").para, /horizontal="RIGHT"/)
  })

  it("report/plan 제목표 — HY헤드라인M 25pt bold, 상 0.4mm 선, 왕복 마커 __kordoc_h1 (서울 실측, v5)", async () => {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "report" } })
    const sec = await sectionOf(buf)
    const hdr = await headerXml(buf)
    const at = sec.indexOf(escapeStub("보고서 제목"))
    const tblStart = sec.lastIndexOf("<hp:tbl", at)
    assert.ok(tblStart > 0, "제목이 표 안에")
    const box = sec.slice(tblStart, sec.indexOf("</hp:tbl>", tblStart))
    assert.match(box, /rowCnt="1" colCnt="1"/)
    assert.ok(box.includes('name="__kordoc_h1"'), "왕복 h1 마커")
    const { char } = prOf(sec, hdr, "보고서 제목")
    assert.match(char, /height="2500"[^>]*bold="1"/)
    assert.ok(char.includes(`hangul="${fontIdOf(hdr, "HY헤드라인M")}"`))
    const bfId = box.match(/borderFillIDRef="(\d+)"/g)![1].match(/\d+/)![0]
    assert.match(hdr.match(new RegExp(`<hh:borderFill id="${bfId}"[\\s\\S]*?</hh:borderFill>`))![0], /topBorder type="SOLID" width="0.4 mm"/)
    assert.ok(!hdr.includes("<hc:gradation"), "v5 제목표에 gradient 없음")
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

  it("보고서 프리셋 — 서울 실측 세트: □ HY견고딕 17b·ㅇ 한컴돋움 15b·- 휴먼명조 14·※ 한컴돋움 14 (v5)", async () => {
    const buf = await markdownToHwpx("# 제목\n\n- 대항목\n  - 중항목\n    - 소항목\n\n※ 자료: 행안부", { gongmun: { preset: "보고서" } })
    const head = await headerXml(buf)
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    for (const f of ["HY견고딕", "한컴돋움", "휴먼명조", "HY헤드라인M"]) assert.ok(head.includes(`face="${f}"`), `폰트 세트에 ${f}`)
    const expect = (text: string, face: string, h: number, bold: boolean) => {
      const { char } = prOf(sec, head, text)
      assert.match(char, new RegExp(`height="${h}"`), `${text} ${h}`)
      assert.equal(/bold="1"/.test(char), bold, `${text} bold=${bold}`)
      assert.ok(char.includes(`hangul="${fontIdOf(head, face)}"`), `${text} → ${face}`)
    }
    expect("□ 대항목", "HY견고딕", 1700, true)
    expect("ㅇ 중항목", "한컴돋움", 1500, true)
    expect("- 소항목", "휴먼명조", 1400, false)
    expect("※ 자료: 행안부", "한컴돋움", 1300, false)
  })

  it("볼드 폰트 치환 제거 — 범용·기안문 볼드가 원 폰트 유지 (HY견고딕 참조 없음)", async () => {
    for (const opts of [undefined, { gongmun: { preset: "기안문" as const } }]) {
      const head = await headerXml(await markdownToHwpx("**굵게** 본문", opts))
      assert.match(head, /<hh:charPr id="1" [^>]*bold="1"[^>]*>\s*<hh:fontRef hangul="0"/)
    }
  })

  it("보고서 들여쓰기 — □ 0타·ㅇ 1타·- 3타, 내어쓰기 = 부호폭+1타 (v5)", async () => {
    const buf = await markdownToHwpx("- 대항목\n  - 중항목\n    - 소항목", { gongmun: { preset: "보고서" } })
    const head = await headerXml(buf)
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const geom = (t: string) => { const p = prOf(sec, head, t).para; return { left: Number(p.match(/<hc:left value="(-?\d+)"/)![1]), indent: Number(p.match(/<hc:intent value="(-?\d+)"/)![1]) } }
    assert.deepEqual(geom("□ 대항목"), { left: 0, indent: -markerWidth("□", 1700) })
    assert.deepEqual(geom("ㅇ 중항목"), { left: 750, indent: -markerWidth("ㅇ", 1500) })
    assert.deepEqual(geom("- 소항목"), { left: 2100, indent: -markerWidth("-", 1400) })
  })
})

describe("v4.0.1 h2 말머리 (QA-2)", () => {
  const md = `# 문서 제목\n\n## 개요\n\n내용임\n\n## 1. 추진 성과\n\n내용임`

  it("보고서·계획서 기본 — h2는 띠 표(로마자 칸 + 제목 칸) + 선행 번호 제거, roman 지정 시 텍스트 장 (v5 라운드 3)", async () => {
    for (const preset of ["보고서", "계획서"] as const) {
      const buf = await markdownToHwpx(md, { gongmun: { preset } })
      const texts = await sectionTexts(buf)
      assert.ok(texts.includes("Ⅰ") && texts.includes("개요"), `${preset} 띠 표 번호칸·제목칸: ${texts}`)
      assert.ok(texts.includes("Ⅱ") && texts.includes("추진 성과"), `${preset} 선행 번호 제거 후 Ⅱ`)
      const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
      assert.ok(sec.includes('name="__kordoc_h2"'), "왕복 채널 셀 이름")
      assert.ok(/faceColor="#003366"/.test(await headerXml(buf)), "번호칸 채움 #003366")
      // 왕복 — 파서가 띠 표를 heading 2 로 복원 (표로 남지 않는다)
      const back = await parse(buf)
      assert.ok(back.success)
      const h2 = back.blocks.filter(b => b.type === "heading" && b.level === 2).map(b => b.text)
      assert.deepEqual(h2.slice(0, 2), ["개요", "추진 성과"])
      assert.ok(!back.blocks.some(b => b.type === "table" && b.table?.cells.some(r => r.some(c => c.text === "Ⅰ"))), "띠 표가 일반 표로 남지 않음")
    }
    const roman = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "roman" } }))
    assert.ok(roman.includes("Ⅰ. 개요") && roman.includes("Ⅱ. 추진 성과"), `roman 텍스트 장: ${roman}`)
  })

  it("h2Marker number — 아라비아 순번 재부여", async () => {
    const texts = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "number" } }))
    assert.ok(texts.includes("1. 개요"))
    assert.ok(texts.includes("2. 추진 성과"))
  })

  it("h2Marker none — 번호 없음 / 기안문 h2는 법정 1. 항목 (v5)", async () => {
    const t1 = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "none" } }))
    assert.ok(t1.includes("개요") && !t1.includes("□ 개요") && !t1.includes("Ⅰ. 개요"))
    const t2 = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "기안문" } }))
    assert.ok(t2.includes("1. 개요") && t2.includes("2. 추진 성과"), `기안문 h2 → 1. 2.: ${t2}`)
    const box = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "보고서", h2Marker: "box" } }))
    assert.ok(box.includes("□ 개요"), "box 모드는 장 없이 □")
  })

  it("개조식 h2는 장 헤더가 소비 — h2Marker 영향 없음", async () => {
    const texts = await sectionTexts(await markdownToHwpx(md, { gongmun: { preset: "개조식", cover: false, toc: false } }))
    assert.ok(!texts.includes("□ 개요"), "개조식 h2 = 로마숫자 장헤더 (□ 아님)")
  })
})

describe("v4.0.2 프로덕션 리뷰 회귀", () => {
  it("헤딩 위계 — 12pt 기안문에서 h4가 h3를 넘지 않는다 (15pt는 종전 유지)", async () => {
    const head = await headerXml(await markdownToHwpx("### 소제목\n\n#### 소소제목", { gongmun: { preset: "official" } }))
    const h3 = Number(head.match(/<hh:charPr id="7" height="(\d+)"/)![1])
    const h4 = Number(head.match(/<hh:charPr id="8" height="(\d+)"/)![1])
    assert.ok(h4 <= h3, `h4(${h4})가 h3(${h3})보다 크면 위계 역전`)
    const head15 = await headerXml(await markdownToHwpx("본문", { gongmun: { preset: "report" } }))
    assert.match(head15, /<hh:charPr id="8" height="1400"/)
  })

  it("통지 bodyFont gothic — 본문 문단이 맑은 고딕을 참조한다 (v5)", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "notice", bodyFont: "gothic" } })
    const head = await headerXml(buf)
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const id = fontIdOf(head, "맑은 고딕")
    assert.ok(id, "맑은 고딕 글꼴 등록")
    assert.ok(prOf(sec, head, "본문").char.includes(`hangul="${id}"`), "본문 charPr가 맑은 고딕 참조")
  })

  it("press 프리셋은 cover/toc 무시 — 머리박스·제목·부제 보존", async () => {
    const g = resolveGongmun({ preset: "press", cover: true, toc: true })
    assert.equal(g.cover, null)
    assert.equal(g.toc, false)
    const texts = await sectionTexts(await markdownToHwpx("# 제목\n\n내용", {
      gongmun: { preset: "press", cover: true, press: { sub: ["부제 문구"] } },
    }))
    assert.ok(texts.includes("- 부제 문구 -"), `부제 유실 금지: ${texts.join("|")}`)
  })

  it("bodyTitleBox 단독은 rich 자산을 방출하지 않는다 (표 폰트 불변)", async () => {
    assert.equal(needsGaejosikAssets(resolveGongmun({ preset: "minutes", bodyTitleBox: true })), false)
    const head = await headerXml(await markdownToHwpx("| a | b |\n| --- | --- |\n| 1 | 2 |", {
      gongmun: { preset: "minutes", bodyTitleBox: true },
    }))
    assert.ok(!head.includes('face="HY헤드라인M"'), "rich 폰트세트 미방출")
  })

  it("결재란 라벨 — 줄간격 100% paraPr (바 스페이서 재사용 금지)", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "official", approval: ["담당", "팀장"] } })
    const head = await headerXml(buf)
    const zip = await JSZip.loadAsync(buf)
    const secXml = await zip.file("Contents/section0.xml")!.async("text")
    assert.match(prOf(secXml, head, "담당").para, /<hh:lineSpacing[^>]*value="100"/, "라벨 줄간격 100% (실측 결재선)")
    const validation = await validateHwpx(buf)
    assert.equal(validation.ok, true, validation.issues.map((i) => i.message).join("\n"))
  })
})

describe("v5 실무 요청 (2026-09-06)", () => {
  const secOf = async (buf: ArrayBuffer) => (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")

  it("출처·자료·근거 항목 → ※ 참고 13pt (당구장표시, 작은 글씨)", async () => {
    const buf = await markdownToHwpx("- 대항목\n  - 2023년 45.4%\n  - 출처: KOSIS e-지방지표\n\n자료: 행안부", { gongmun: { preset: "보고서" } })
    const sec = await secOf(buf); const head = await headerXml(buf)
    const ts = await sectionTexts(buf)
    assert.ok(ts.includes("※ 출처: KOSIS e-지방지표") && ts.includes("※ 자료: 행안부"), `${ts}`)
    assert.ok(!ts.some((t) => t.startsWith("ㅇ 출처")))
    assert.match(prOf(sec, head, "※ 출처").char, /height="1300"/)
  })

  it("법령 인용 뒤 법제처 코드 (282791) 제거", async () => {
    const ts = await sectionTexts(await markdownToHwpx("- 인공지능기본법(282791) 제2조, 같은 법 시행령(288781) 제1조의2\n\n「고독사 예방 및 관리에 관한 법률」(254853) 제13조\n\n※ 광진구 인공지능 기본조례(2098845) 제3조\n\n- 출처: KOSIS e-지방지표 「1인가구비율(시도/시/군/구)」 DT_1YL21161, 통계 MCP 조회\n\n- 건축HUB 화양동(법정동코드 11215-10700) 표제부 집계, 건축허브 MCP 조회", { gongmun: { preset: "보고서" } }))
    const all = ts.join(" ")
    assert.ok(!/\(\d{6,7}\)/.test(all), `코드 잔존: ${all}`)
    assert.ok(all.includes("인공지능기본법 제2조") && all.includes("시행령 제1조의2") && all.includes("법률」 제13조") && all.includes("기본조례 제3조"))
    assert.ok(!/DT_|MCP|법정동코드/.test(all), `출처 내부 식별자 잔존: ${all}`)
    assert.ok(ts.includes("※ 출처: KOSIS e-지방지표 「1인가구비율(시도/시/군/구)」") && ts.includes("□ 건축HUB 화양동 표제부 집계"), `${ts}`)
  })

  it("고아 줄 — 한 줄 근접(가용폭 90~108%) 항목은 자간·장평을 줄여 한 줄에, 긴 문단은 그대로", async () => {
    // 15pt 한컴돋움 ㅇ 항목(left 750) — 추정폭이 가용폭의 ~100% 되도록 어절을 더한다 (실렌더는 추정보다 2~4% 넓어 꼬리가 넘침)
    const W = mmToHwpunit(210 - 18 - 18), first = W - 750
    const fc = faceClassForGen("한컴돋움")
    let long = "2023년 45.4% → 2024년 46.0% → 2025년 46.9% 서울 40.5% 전국 43.1%"
    for (let i = 0; i < 40 && measureTextWidth(`ㅇ ${long}`, 1500, 100, { faceClass: fc }) < first * 0.98; i++) long += i % 2 ? " 증가" : " 추세"
    const buf = await markdownToHwpx(`- 대항목\n  - ${long}`, { gongmun: { preset: "보고서" } })
    const sec = await secOf(buf); const head = await headerXml(buf)
    const { char } = prOf(sec, head, `ㅇ ${long.slice(0, 10)}`)
    const sp = Number(char.match(/<hh:spacing hangul="(-?\d+)"/)![1])
    const ratio = Number(char.match(/<hh:ratio hangul="(\d+)"/)![1])
    assert.ok(sp < 0 || ratio < 100, `자간/장평 축소 적용: spacing=${sp} ratio=${ratio}`)
    // 둘째 줄이 길면(40~85%) 손대지 않는다 — 어절 시뮬레이션으로 그런 길이를 만든다
    const cont = first - markerWidth("ㅇ", 1500)
    let longer = long
    for (let i = 0; i < 60; i++) {
      const w = simulateWrap(`ㅇ ${longer}`, first * 0.95, cont * 0.95, 1500, 100, "keep", { faceClass: fc })
      if (w.lines === 2 && w.lastLineWidth > cont * 0.4 && w.lastLineWidth < cont * 0.85) break
      longer += i % 2 ? " 세부내역" : " 참조"
    }
    const buf2 = await markdownToHwpx(`- 대항목\n  - ${longer}`, { gongmun: { preset: "보고서" } })
    const c2 = prOf(await secOf(buf2), await headerXml(buf2), `ㅇ ${long.slice(0, 10)}`).char
    assert.match(c2, /<hh:spacing hangul="0"/)
  })

  it("요약박스 — 제목 직후 인용문 한 문장, 부호는 벗기고 3줄 초과·부재는 경고", async () => {
    const md = "# 검토보고\n\n> ㅇ 안부확인 서비스 확대 방향을 검토하고자 함\n\n## 배경\n\n- 항목"
    const warnings: string[] = []
    const buf = await markdownToHwpx(md, { gongmun: { preset: "보고서" }, warnings })
    const sec = await secOf(buf)
    const at = sec.indexOf('name="__kordoc_summary"')
    assert.ok(at > 0, "요약박스")
    const cell = sec.slice(at, sec.indexOf("</hp:tc>", at))
    assert.ok(cell.includes("<hp:t>안부확인 서비스 확대 방향을 검토하고자 함</hp:t>"), "선두 ㅇ 제거·선두 공백 없음(문단 여백으로 대체)")
    // 실측(요약박스 133건): 문단 좌우 여백 1000/1000 55% — 글자가 테두리에 붙지 않게. 줄바꿈은 본문과 같은 글자 단위
    const { para } = prOf(sec, await headerXml(buf), "안부확인 서비스 확대 방향을 검토하고자 함")
    assert.ok(para.includes('<hc:left value="1000"') && para.includes('<hc:right value="1000"'), "요약박스 문단 좌우 여백 1000")
    assert.ok(para.includes('breakNonLatinWord="KEEP_WORD"'), "요약박스 글자 단위 줄바꿈")
    assert.ok(!warnings.some((w) => w.includes("요약박스")))
    const w3: string[] = []
    await markdownToHwpx(`# 검토보고\n\n> ${"매우 긴 문장을 반복해서 넣어 세 줄을 넘기게 한다 ".repeat(8)}\n\n- 항목`, { gongmun: { preset: "보고서" }, warnings: w3 })
    assert.ok(w3.some((w) => w.includes("줄입니다")), "3줄 초과 경고")
    const w2: string[] = []
    await markdownToHwpx("# 검토보고\n\n## 배경\n\n- 항목", { gongmun: { preset: "보고서" }, warnings: w2 })
    assert.ok(w2.some((w) => w.includes("요약박스")), "요약 없으면 경고")
  })
})

describe("v4.0.4 프로덕션 리뷰 회귀", () => {
  const sectionXml = async (buf: ArrayBuffer): Promise<string> => {
    const zip = await JSZip.loadAsync(buf)
    return zip.file("Contents/section0.xml")!.async("text")
  }

  it("참고(※) 항목이 법정번호(standard) 순번을 먹지 않는다 — 번호 증발 방지", async () => {
    const md = "## 배경\n- 첫째\n- ※ 근거: 정보화법\n- 셋째\n- 넷째"
    const sec = await sectionXml(await markdownToHwpx(md, { gongmun: { preset: "계획서", numbering: "standard" } }))
    // v5: h2 "배경"이 1단계(1.)를 차지하고 리스트는 가.부터 — 참고(※)가 순번을 먹으면 '다.'가 사라진다
    const marks = [...sec.matchAll(/<hp:t>([가-하])\. /g)].map((m) => m[1])
    assert.deepEqual(marks, ["가", "나", "다"], `참고 항목이 순번을 소비하면 안 됨: ${marks.join(",")}`)
  })

  it("개조식 장식표 폭 — 기본 여백은 48180 유지, 넓은 여백은 본문폭 이하로 스케일", async () => {
    const md = "# 종합계획\n\n## 배경\n- 항목"
    const base = await sectionXml(await markdownToHwpx(md, { gongmun: { preset: "개조식" } }))
    assert.ok(base.includes('width="48180"'), "기본 여백 표지 표 폭 48180 회귀 없음")
    const wide = await sectionXml(await markdownToHwpx(md, { gongmun: { preset: "개조식", margins: { top: 15, bottom: 15, left: 35, right: 35 } } }))
    const bodyW = mmToHwpunit(210 - 35 - 35)
    const widths = [...wide.matchAll(/<hp:sz width="(\d+)" widthRelTo="ABSOLUTE"/g)].map((m) => +m[1])
    assert.ok(Math.max(...widths) <= bodyW, `넓은 여백 표 폭이 본문폭(${bodyW}) 초과: ${Math.max(...widths)}`)
    assert.ok(!wide.includes('width="48180"'), "넓은 여백에서 48180 고정폭 잔존")
  })

  it("h3 위계 — bodyPt 18에서도 h1 ≥ h2 ≥ h3 (역전 방지)", async () => {
    const head = await headerXml(await markdownToHwpx("# 제목\n## 대분류\n### 소제목", { gongmun: { preset: "official", bodyPt: 18 } }))
    const h = (id: number) => Number(head.match(new RegExp(`<hh:charPr id="${id}" height="(\\d+)"`))![1])
    assert.ok(h(5) >= h(6) && h(6) >= h(7), `위계 역전: h1=${h(5)} h2=${h(6)} h3=${h(7)}`)
  })

  it("표 열폭에 소수(비정수 HWPUNIT)가 새지 않는다", async () => {
    const md = "## 실적\n| MOU | OECD | AI |\n|---|---|---|\n| a | b | c |"
    const sec = await sectionXml(await markdownToHwpx(md, { gongmun: { preset: "보고서" } }))
    const decimals = [...sec.matchAll(/width="\d+\.\d+"/g)]
    assert.equal(decimals.length, 0, `소수 폭 방출: ${decimals.map((m) => m[0]).join(",")}`)
  })

  it("옵션 필드 C0 제어문자 strip — well-formed XML 유지", async () => {
    const sec = await sectionXml(await markdownToHwpx("본문", { gongmun: { preset: "official", docHead: { title: "과제\x0B계획\x1F안" } } }))
    assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sec), "raw C0 제어문자 잔존")
  })

  it("원숫자 20 초과 — ⑳ 다음 ㉑, ㉟ 다음 ㊱ (순환 대신 확장 문자셋 ①~㊿)", () => {
    assert.equal(circledNumber(20), "㉑")
    assert.equal(circledNumber(34), "㉟")
    assert.equal(circledNumber(35), "㊱")
    assert.equal(circledNumber(35).codePointAt(0), 0x32b1)
  })
})
