/**
 * 레이아웃 보존 렌더 (src/render/) — 단위 + 실파일 e2e.
 * 실파일 검증은 bench/corpus (gitignore) 존재 시에만.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { toInt32, solveBoundaries, solveRowHeights } from "../src/render/layout.js"
import { renderHwpxToSvg } from "../src/render/index.js"
import { buildPara, escapeXml } from "../src/render/svg-render.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import JSZip from "jszip"

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")

describe("render: toInt32 (uint32 음수)", () => {
  it("4294967103 → -193 (사진대지 vertOffset 실측)", () => {
    assert.equal(toInt32("4294967103"), -193)
  })
  it("일반 양수·음수 문자열·결측", () => {
    assert.equal(toInt32("17645"), 17645)
    assert.equal(toInt32("-850"), -850)
    assert.equal(toInt32(undefined, 7), 7)
    assert.equal(toInt32("abc", 3), 3)
  })
})

describe("render: 열 경계 전파 솔버", () => {
  it("span-1 셀 없는 그리드도 제약 전파로 풀림 (트레일러 축소판)", () => {
    // 3경계 그리드: |0..2|=30, |2..3|=10, 전체=40 → x=[0,?,30,40], 첫 제약으로 x2=30
    const x = solveBoundaries([
      { a: 0, b: 2, size: 30 },
      { a: 2, b: 3, size: 10 },
    ], 3, 40)
    assert.equal(x[0], 0)
    assert.equal(x[2], 30)
    assert.equal(x[3], 40)
  })
  it("역방향 전파 — 오른쪽 끝에서 왼쪽으로", () => {
    // x4=100 확정, |3..4|=20 → x3=80, |1..3|=50 → x1=30
    const x = solveBoundaries([
      { a: 3, b: 4, size: 20 },
      { a: 1, b: 3, size: 50 },
    ], 4, 100)
    assert.equal(x[3], 80)
    assert.equal(x[1], 30)
  })
  it("미해결 경계는 균등 보간", () => {
    const x = solveBoundaries([], 4, 100)
    assert.deepEqual(x, [0, 25, 50, 75, 100])
  })
})

describe("render: 행 높이 솔버", () => {
  it("h=1 더미(헤어라인 장식 셀)가 섞여도 rs=1 max가 이김", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 2700 },
      { rowAddr: 0, rowSpan: 1, height: 1 },
    ], 1)
    assert.equal(h[0], 2700)
  })
  it("rowSpan 잔여 균등분배 + 콘텐츠 초과 성장 (사진대지 실측 모델)", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 16441, contentH: 22209 }, // 사진이 설계보다 큼
      { rowAddr: 1, rowSpan: 1, height: 3042 },
    ], 2)
    assert.equal(h[0], 22209)
    assert.equal(h[1], 3042)
    assert.equal(h[0] + h[1], 25251) // 표 sz 실측 일치
  })
})

describe("render: 조판 캐시 없는 파일 거부", () => {
  it("markdownToHwpx 산출물(lineseg 없음) → KordocError", async () => {
    const hwpx = await markdownToHwpx("# 제목\n\n본문 문단입니다.")
    await assert.rejects(
      renderHwpxToSvg(hwpx),
      (err: Error) => err.message.includes("조판 캐시"),
    )
  })

  it('본문 텍스트에 "linesegarray" 단어가 있어도 캐시로 오판하지 않는다 (리뷰 #11)', async () => {
    const hwpx = await markdownToHwpx("본문에 linesegarray 라는 단어가 나오는 문서입니다.")
    // 캐시 없음으로 정확히 거부돼야 한다 (오판 시 무음 백지 렌더)
    await assert.rejects(
      renderHwpxToSvg(hwpx),
      (err: Error) => err.message.includes("조판 캐시"),
    )
    // reflow 옵션으로는 텍스트가 실제로 렌더된다
    const r = await renderHwpxToSvg(hwpx, { reflow: true })
    assert.ok(r.svg.includes("linesegarray"), "본문 텍스트가 백지로 생략됨")
  })
})

describe("render: 문단별 줄나눔 wrapMode (breakSetting 이름 역전 매핑)", () => {
  it("parseRenderStyles — BREAK_WORD→keep(어절) / KEEP_WORD→charAll(글자) / 없음→undefined", async () => {
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const head = `<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
      <hh:paraPr id="0"><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD"/></hh:paraPr>
      <hh:paraPr id="1"><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD"/></hh:paraPr>
      <hh:paraPr id="2"><hh:align horizontal="LEFT"/></hh:paraPr>
    </hh:head>`
    const styles = parseRenderStyles(head)
    assert.equal(styles.paraGeom.get("0")?.wrapMode, "keep")
    assert.equal(styles.paraGeom.get("1")?.wrapMode, "charAll")
    assert.equal(styles.paraGeom.get("2")?.wrapMode, undefined)
  })

  it("reflow — 문단 breakSetting 선언이 reflowMode 옵션보다 우선", async () => {
    // 생성 문서는 전 문단 BREAK_WORD(어절) 선언 → charAll 옵션을 줘도 선언이 이겨
    // 두 렌더가 동일해야 한다 (선언 파싱이 깨지면 줄바꿈점이 달라져 SVG가 달라짐)
    const md = "대한민국 헌법에 따라 보장되는 기본권과 자유민주적 기본질서를 확인하는 문장을 반복한다. ".repeat(6)
    const hwpx = await markdownToHwpx(md)
    const keep = await renderHwpxToSvg(hwpx, { reflow: true, reflowMode: "keep" })
    const charAll = await renderHwpxToSvg(hwpx, { reflow: true, reflowMode: "charAll" })
    assert.equal(charAll.svg, keep.svg)
  })
})

describe("render: 탭 슬롯 (리뷰 #16)", () => {
  it("hp:tab은 inline 컨트롤 8슬롯 — 1슬롯로 세면 lineseg textpos가 밀린다", () => {
    const xml = `<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" paraPrIDRef="0">` +
      `<hp:run charPrIDRef="0"><hp:t>a<hp:tab/>b</hp:t></hp:run></hp:p>`
    const doc = createXmlParser().parseFromString(xml, "text/xml")
    const m = buildPara(doc.documentElement as unknown as Element)
    assert.equal(m.chars.length, 10) // a(1) + tab(8) + b(1)
    assert.equal(m.chars[0].ch, "a")
    assert.equal(m.chars[9].ch, "b")
    assert.ok(m.chars.slice(1, 9).every(c => c.ch === ""), "탭 필러 슬롯은 폭 0")
  })
})

describe("render: 이미지 dataURI 1회 참조 (리뷰 #10)", () => {
  it("같은 바이너리 2회 그려도 dataURI는 defs에 1번만, 본문은 <use> 2개", async () => {
    const base = await markdownToHwpx("이미지 중복 참조 테스트")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const pic = (id: number) =>
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None">` +
      `<hp:sz width="5000" widthRelTo="ABSOLUTE" height="5000" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:img binaryItemIDRef="dupimg"/></hp:pic></hp:run></hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${pic(9001)}${pic(9002)}${m}`)
    zip.file(secName, sec)
    // PNG 매직바이트만 있는 최소 바이너리 — 파일명 휴리스틱(BinData/*dupimg*)으로 매칭
    zip.file("BinData/dupimg.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    const dataUris = (r.svg.match(/data:image/g) ?? []).length
    const uses = (r.svg.match(/<use href="#bin0"/g) ?? []).length
    assert.equal(dataUris, 1, `dataURI가 ${dataUris}회 중복 emit됨`)
    assert.equal(uses, 2, `<use> 참조가 ${uses}개 (기대 2)`)
  })
})

describe("render: reflow 표 밀어내기 (셀 콘텐츠 성장)", () => {
  it("긴 셀로 자란 표 뒤 문단이 표 바닥 아래에 온다 (리뷰#6 겹침)", async () => {
    // 셀 폭(약 22000HWPUNIT)을 여러 줄로 감는 긴 텍스트 — 선언 행높이 1500을 훌쩍 넘긴다
    const long = "서울특별시 도시기반시설 관리 실태 전수조사 결과에 따라 노후 시설물의 안전등급 재산정과 보수보강 우선순위 조정이 필요하며 연차별 투자계획을 수립하여 시행한다."
    const hwpx = await markdownToHwpx(`| 항목 | 내용 |\n| --- | --- |\n| 개요 | ${long} |\n\n표뒤문단입니다.`)
    const r = await renderHwpxToSvg(hwpx, { reflow: true })
    // 표 바닥 = 수평 border(<line y1==y2>) 최대 y, 뒤 문단 = 해당 <text>의 y
    const borderYs = [...r.svg.matchAll(/<line x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g)]
      .filter(m => m[1] === m[2]).map(m => parseFloat(m[1]))
    const tableBottom = Math.max(...borderYs)
    const after = [...r.svg.matchAll(/<text [^>]*y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
      .find(m => m[2].includes("표뒤문단"))
    assert.ok(after, "표 뒤 문단 텍스트가 렌더에 없음")
    assert.ok(parseFloat(after[1]) > tableBottom,
      `표 뒤 문단(y=${after[1]})이 표 바닥(y=${tableBottom}) 위에 겹침`)
    // 성장 자체가 일어났는지 — 선언 표높이(행 1500×2=3000u=30pt)보다 실제 표가 크다
    const tableTop = Math.min(...borderYs)
    assert.ok(tableBottom - tableTop > 30, "재현 전제(셀 성장) 자체가 깨짐 — 테스트 입력 확인 필요")
  })
})

describe("render: reflow 인라인 표 나란히 배치 (결재란 겹침)", () => {
  it("한 문단의 인라인 표 2개는 가로로 전진 배치 — 같은 x에 겹치지 않는다", async () => {
    // 공문 결재란 구조 재현: 호스트 문단(실텍스트 0) 안에 treatAsChar 표 2개 연속.
    // reflow가 합성한 lineseg textpos가 chars.length로 폴백하면 plan.start가 개체
    // index보다 커져 advanceTo 가로 전진에서 개체가 전부 빠지고 같은 x에 겹친다.
    const hwpx = await markdownToHwpx(
      "| 라벨표 |\n| --- |\n| 결재일자 |\n\n| 스탬프표 |\n| --- |\n| 주무관 |",
    )
    const zip = await JSZip.loadAsync(hwpx)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    // 두 번째 표를 첫 표의 호스트 문단으로 이동 (연속 인라인 개체)
    const starts = [...sec.matchAll(/<hp:tbl /g)].map(m => m.index!)
    assert.equal(starts.length, 2, "재현 전제: 표 2개 생성")
    const t2End = sec.indexOf("</hp:tbl>", starts[1]) + "</hp:tbl>".length
    const t2 = sec.slice(starts[1], t2End)
    const host2Start = sec.lastIndexOf("<hp:p ", starts[1])
    const host2End = sec.indexOf("</hp:p>", t2End) + "</hp:p>".length
    sec = sec.slice(0, host2Start) + sec.slice(host2End) // 둘째 호스트 문단 제거
    const t1End = sec.indexOf("</hp:tbl>") + "</hp:tbl>".length
    sec = sec.slice(0, t1End) + t2 + sec.slice(t1End) // 첫 표 바로 뒤에 삽입
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })

    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    const textX = (t: string): number => {
      const m = [...r.svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
        .find(mm => mm[2].includes(t))
      assert.ok(m, `"${t}" 텍스트가 렌더에 없음`)
      return parseFloat(m![1])
    }
    const x1 = textX("결재일자")
    const x2 = textX("주무관")
    // 표1 폭만큼 전진해야 한다 (겹침이면 둘 다 문단 원점 부근 — 차이 수 pt 이하)
    assert.ok(x2 - x1 > 50, `둘째 인라인 표가 전진하지 않고 겹침: x1=${x1}, x2=${x2}`)
  })
})

describe("render: 가로(landscape) 문서 페이지 방향", () => {
  it('landscape="NARROWLY"면 페이지 W/H를 회전 — 무시하면 가로 문서 오른쪽이 잘린다', async () => {
    const hwpx = await markdownToHwpx("가로 문서 본문입니다.")
    const zip = await JSZip.loadAsync(hwpx)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/landscape="WIDELY"/, 'landscape="NARROWLY"')
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    // A4 세로 595.28×841.88 → 가로 841.88×…
    assert.equal(r.width, 841.88, `가로 문서 페이지 폭이 회전되지 않음: ${r.width}`)
  })
})

describe("render: 페이지 분할 — vertpos 동일(0) 문단 연속", () => {
  it("페이지 전체가 개체 하나인 문단(v0)이 연속되면 각각 새 페이지다 (의사일정 겹침)", async () => {
    // 한컴 저장본 패턴 합성: 최상위 문단 3개, 각각 lineseg vertpos=0 (페이지 로컬 리셋).
    // strict 역행(v < prevV)만 보면 0→0이 안 걸려 뒤 페이지들이 전부 겹친다.
    const base = await markdownToHwpx("페이지 분할 테스트")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const seg = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000"` +
      ` textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`
    const para = (t: string) =>
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>${seg}</hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${para("첫페이지")}${para("둘째페이지")}${para("셋째페이지")}${m}`)
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf)) // 캐시 있음 — Tier-1 경로
    const pages = [...r.svg.matchAll(/data-page="(\d+)"/g)].map(m => +m[1])
    const nPages = pages.length ? Math.max(...pages) + 1 : 1
    assert.ok(nPages >= 3, `v0 연속 문단이 페이지로 갈라지지 않음 (pages=${nPages})`)
  })
})

describe("render: 실파일 e2e (corpus 존재 시)", { skip: !existsSync(CORPUS) }, () => {
  const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS, rel)))
  // base64 데이터 URI엔 "NaN"이 유효 부분열로 우연히 등장한다 — 좌표 검사에서 제외
  const geometry = (svg: string): string => svg.replace(/href="[^"]*"/g, "")

  it("결재문서(36427937) — 텍스트·이미지·표, NaN 없음", async () => {
    const file = "review/36427937_결재문서본문.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.ok(r.svg.startsWith("<svg"))
    assert.equal(r.width, 595.28)
    assert.ok(r.svg.includes("시행"))
    assert.ok(r.svg.includes("문화예술과"))
    assert.equal(r.stats.images, 2) // 로고 PNG 2
    assert.ok(r.stats.tables >= 3)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })

  it("사진대지(10772982) — uint32 음수 오프셋 사진 2장 모두, 셀 좌/우 배치", async () => {
    const file = "hwp5/10772982_4. 도시시설물 관리개선 사진.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.equal(r.stats.images, 2)
    const xs = [...r.svg.matchAll(/<use href="#bin\d+" x="([\d.]+)"/g)].map(m => parseFloat(m[1]))
    assert.equal(xs.length, 2)
    // 두 사진은 서로 다른 열 셀 — x 간격이 셀 폭(238pt)급으로 벌어져야 함
    assert.ok(Math.abs(xs[0] - xs[1]) > 150, `사진 x 좌표가 같은 셀에 몰림: ${xs}`)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })
})

describe("render: TAC 인라인 표 outMargin 좌/우 가로 배선 (rhwp #3396 동종)", () => {
  // 한글 문자 규칙: TAC 표의 가로 전진폭 = om좌 + 표폭 + om우, 괘선(표 자체)은 pen + om좌.
  // om 유무 두 렌더의 x 델타로 검증 — 폰트 폭 테이블에 무의존. om좌≠om우(비대칭)로 좌우 뒤바뀜도 잡는다.
  const OM_L = 850 // 8.5pt
  const OM_R = 283 // 2.83pt

  /** Tier-1(조판 캐시 명시) 문서: [앞표식][TAC 표(셀칸)][뒤표식] 한 줄. omL=null이면 outMargin 요소 자체 생략 */
  async function renderTacDoc(omL: number | null, omR: number, paraPrId = "0"): Promise<string> {
    const base = await markdownToHwpx("기준")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const seg = (horzsize: number) =>
      `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000"` +
      ` textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="${horzsize}" flags="393216"/></hp:linesegarray>`
    const tbl =
      `<hp:tbl id="777" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">` +
      `<hp:sz width="6000" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      (omL === null ? "" : `<hp:outMargin left="${omL}" right="${omR}" top="0" bottom="0"/>`) +
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:tr><hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>셀칸</hp:t></hp:run>${seg(6000)}</hp:p>` +
      `</hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `<hp:cellSz width="6000" height="2000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/>` +
      `</hp:tc></hp:tr></hp:tbl>`
    const host =
      `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:t>앞표식</hp:t>${tbl}<hp:t>뒤표식</hp:t></hp:run>${seg(42520)}</hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${host}${m}`)
    zip.file(secName, sec)
    if (paraPrId !== "0") {
      // 우정렬 paraPr 주입 — parseRenderStyles는 트리 전체를 걸으므로 위치 무관
      const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
      let head = await zip.file(headName)!.async("string")
      head = head.replace(
        /<\/hh:head>/,
        `<hh:paraPr id="${paraPrId}"><hh:align horizontal="RIGHT"/></hh:paraPr></hh:head>`,
      )
      zip.file(headName, head)
    }
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    return (await renderHwpxToSvg(new Uint8Array(buf))).svg
  }

  const textX = (svg: string, marker: string): number => {
    const m = [...svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].find(mm => mm[2].includes(marker))
    assert.ok(m, `"${marker}" 텍스트가 렌더에 없음`)
    return parseFloat(m![1])
  }

  it("JUSTIFY host — 괘선은 pen+om좌, 후속 텍스트는 om좌+om우만큼 추가 전진", async () => {
    const svg0 = await renderTacDoc(0, 0)
    const svg1 = await renderTacDoc(OM_L, OM_R)
    // 표 앞 텍스트는 불변
    assert.equal(textX(svg1, "앞표식"), textX(svg0, "앞표식"))
    // (b) 표 자체(셀 텍스트 = 표 x + cellMargin 0) = pen + om좌
    const dCell = textX(svg1, "셀칸") - textX(svg0, "셀칸")
    assert.ok(Math.abs(dCell - OM_L / 100) < 0.02, `표 x 시프트 ${dCell}pt (기대 ${OM_L / 100}pt = om좌)`)
    // (a) 후속 텍스트 전진폭 = om좌 + 표폭 + om우 → om합만큼 추가로 밀린다
    const dAfter = textX(svg1, "뒤표식") - textX(svg0, "뒤표식")
    assert.ok(Math.abs(dAfter - (OM_L + OM_R) / 100) < 0.02, `후속 텍스트 시프트 ${dAfter}pt (기대 ${(OM_L + OM_R) / 100}pt = om합)`)
  })

  it("RIGHT host — 전체 폭에 om 포함: 시작이 om합만큼 왼쪽, 표 우단은 om우만큼 안쪽, 우단 텍스트 불변", async () => {
    const svg0 = await renderTacDoc(0, 0, "77")
    const svg1 = await renderTacDoc(OM_L, OM_R, "77")
    // (c) 정렬용 전체 폭에 om 포함 → 줄 시작이 om합만큼 왼쪽으로
    const dFront = textX(svg0, "앞표식") - textX(svg1, "앞표식")
    assert.ok(Math.abs(dFront - (OM_L + OM_R) / 100) < 0.02, `우정렬 시작 시프트 ${dFront}pt (기대 ${(OM_L + OM_R) / 100}pt)`)
    // 표는 om우만큼 안쪽 (rhwp 오라클: 우정렬 표 우측 괘선 = 우여백 − om우)
    const dCell = textX(svg0, "셀칸") - textX(svg1, "셀칸")
    assert.ok(Math.abs(dCell - OM_R / 100) < 0.02, `우정렬 표 시프트 ${dCell}pt (기대 ${OM_R / 100}pt = om우)`)
    // 줄 끝(우단) 텍스트는 그대로 우여백에 붙는다
    const dAfter = textX(svg1, "뒤표식") - textX(svg0, "뒤표식")
    assert.ok(Math.abs(dAfter) < 0.02, `우단 텍스트가 움직임: ${dAfter}pt`)
  })

  it("om=0 문서는 outMargin 요소 유무와 무관하게 SVG 바이트 동일 (무회귀)", async () => {
    // 모든 가산이 +0이라 om 미배선 시절과 같은 좌표 — 요소가 아예 없는 문서(num(null)=0
    // 폴백)와도 바이트 동일해야 한다
    assert.equal(await renderTacDoc(0, 0), await renderTacDoc(null, 0))
  })
})

describe("render: XML 1.0 비허용 제어문자 방어 (rhwp #3382 동종)", () => {
  it("C0 제어문자를 제거해 산출 SVG가 well-formed XML을 유지한다", () => {
    // 제어문자를 그대로 흘리면 "PCDATA invalid Char value 3"으로 뷰어가 렌더를 중단한다.
    assert.equal(escapeXml("a\x03b"), "ab")
    for (const c of ["\x00", "\x08", "\x0B", "\x0C", "\x0E", "\x1F"]) {
      assert.equal(escapeXml(`x${c}y`), "xy", `제어문자 U+${c.charCodeAt(0).toString(16)}`)
    }
  })
  it("탭·개행·복귀는 XML 1.0 허용 문자라 유지한다", () => {
    assert.equal(escapeXml("a\tb\nc\rd"), "a\tb\nc\rd")
  })
  it("기존 마크업 이스케이프·한글·이모지는 무회귀", () => {
    assert.equal(escapeXml('<a & b>"'), "&lt;a &amp; b&gt;&quot;")
    assert.equal(escapeXml("한글 A😀"), "한글 A😀")
  })
  it("제어문자가 섞인 텍스트도 산출 SVG가 XML 파서를 통과한다", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${escapeXml("사업\x03개요")}</text></svg>`
    const doc = createXmlParser().parseFromString(svg, "text/xml")
    assert.equal(doc.getElementsByTagName("text")[0]?.textContent, "사업개요")
  })
})
