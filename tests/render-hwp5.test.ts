/** #75 Task 7 — HWP5 렌더 어댑터: DocInfo → 스타일, 레코드 → 동형 section DOM, 통합 렌더(scene/region/sourceId), 코퍼스·pairs 파리티 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildHwp5RenderStyles, hwp5SectionToXml, renderHwp5Records } from "../src/render/hwp5-scene.js"
import { renderDocument, renderDocumentToScene } from "../src/render/index.js"
import { extractTables } from "../src/table/visual.js"
import { parse, collectTableBlocks } from "../src/index.js"
import { indexHwp5Tables } from "../src/hwp5/table-ids.js"
import { parseDocInfo } from "../src/hwp5/record.js"
import {
  idMappings, faceName, docCharShape, docParaShape, docBorderFill, binDataItem,
  simplePara, tableCtrl, ctrlHeader, pageDef, shapeComponent, shapePicture, listHeader, tableRec, paraHeader, paraText, charShape, lineSeg,
} from "./fixtures/hwp5-records.js"
import { TINY_PNG } from "./fixtures/render-fixture.js"

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")
const HWP5_DIR = join(CORPUS, "hwp5"), PAIRS_DIR = join(CORPUS, "pairs")

/** 합성 DocInfo: 글꼴 2(한글 1) · charShape 3 · paraShape 2 · borderFill 3 */
function docInfoRecords() {
  return [
    idMappings([1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 1, 0, 0, 2, 1, 0]),
    binDataItem(1),
    faceName("한컴돋움"),
    docBorderFill([[0, 0], [0, 0], [0, 0], [0, 0]]),                                       // 1: 없음
    docBorderFill([[1, 1], [1, 1], [1, 1], [1, 1]]),                                       // 2: 실선 0.12mm
    docBorderFill([[1, 6], [8, 7], [0, 0], [1, 1, 0x0000ff]], 0x00f7e6df),                 // 3: 0.4 / 이중 0.5 / 없음 / 빨강 + 배경 #DFE6F7
    docCharShape({ baseSize: 1000 }),
    docCharShape({ baseSize: 1500, bold: true, color: 0x0000ff }),
    docCharShape({ baseSize: 1200, italic: true, underline: true, relSize: 50, ratio: 90, spacing: -5 }),
    docParaShape({ align: 0 }),
    docParaShape({ align: 3, lineSpacing: 130 }),
  ]
}

/** 합성 섹션: 문단 A(구역 정의) · 문단 B(글자 모양 2개) · 문단 C(TAC 표 1×2) · 문단 D(그림) */
function sectionRecords(o: { twoPages?: boolean } = {}) {
  const recs = [
    ...simplePara("", [{ vertpos: 0, horzsize: 48190 }], { parts: [{ ctrl: "secd" }, { ctrl: "cold" }], ctrls: [ctrlHeader(1, "secd"), pageDef(2), ctrlHeader(1, "cold")] }),
  ]
  // 문단 B: "가나다라" — 앞 2자 charShape 1(굵게), 뒤 2자 charShape 2
  recs.push(paraHeader(0, 1), paraText(1, ["가나다라"]), charShape(1, [[0, 1], [2, 2]]), lineSeg(1, [{ vertpos: 1000, horzsize: 48190 }]))
  // 문단 C: TAC 표
  recs.push(...simplePara("", [{ vertpos: 3000, height: 5000, horzsize: 48190 }], { parts: [{ ctrl: "tbl " }], ctrls: tableCtrl(0, [{ text: "왼칸", w: 20000, h: 4000, bf: 2 }, { text: "오른칸", w: 20000, h: 4000, bf: 3 }]) }))
  // 문단 D: 그림(gso $pic, binDataId 1)
  recs.push(...simplePara("", [{ vertpos: 9000, height: 6000, horzsize: 48190 }], {
    parts: [{ ctrl: "gso " }],
    ctrls: [ctrlHeader(1, "gso ", { tac: true, w: 6000, h: 3000 }), shapeComponent(2, "$pic", { orgW: 6000, orgH: 3000 }), shapePicture(2, 1)],
  }))
  if (o.twoPages) recs.push(...simplePara("둘째 쪽", [{ vertpos: 0, horzsize: 48190 }]))
  return recs
}

const tableIdsOf = (recs: ReturnType<typeof sectionRecords>) => indexHwp5Tables(recs).ids

describe("hwp5-scene: DocInfo → RenderStyles", () => {
  it("charPr: 크기(baseSize×relSize)·굵게·기울임·밑줄·색·장평·자간·글꼴 스택", () => {
    const st = buildHwp5RenderStyles(docInfoRecords())
    assert.equal(st.charPr.size, 3)
    assert.deepEqual({ ...st.charPr.get("0")!, fontFamily: undefined }, { height: 1000, bold: false, italic: false, underline: false, ratio: 100, spacing: 0, face: "한컴돋움", fontFamily: undefined })
    assert.ok(st.charPr.get("0")!.fontFamily!.includes("HCR Dotum"))
    const c1 = st.charPr.get("1")!
    assert.equal(c1.height, 1500); assert.equal(c1.bold, true); assert.equal(c1.color, "#FF0000")
    const c2 = st.charPr.get("2")!
    assert.equal(c2.height, 600); assert.equal(c2.italic, true); assert.equal(c2.underline, true); assert.equal(c2.ratio, 90); assert.equal(c2.spacing, -5)
  })
  it("paraAlign·paraGeom: 정렬 코드 → JUSTIFY/CENTER, 줄간격", () => {
    const st = buildHwp5RenderStyles(docInfoRecords())
    assert.equal(st.paraAlign.get("0"), "JUSTIFY")
    assert.equal(st.paraAlign.get("1"), "CENTER")
    assert.equal(st.paraGeom.get("1")!.lineSpacingValue, 130)
  })
  it("borderFill: 1-based id, 변 type/width(mm→pt)/색, NONE 은 생략, 배경색 COLORREF→#RRGGBB", () => {
    const st = buildHwp5RenderStyles(docInfoRecords())
    assert.equal(st.borderFill.size, 3)
    assert.deepEqual(st.borderFill.get("1"), {})
    const b2 = st.borderFill.get("2")!
    assert.equal(b2.left!.type, "SOLID"); assert.ok(Math.abs(b2.left!.widthPt - 0.34) < 0.01); assert.equal(b2.left!.color, "#000000")
    const b3 = st.borderFill.get("3")!
    assert.ok(Math.abs(b3.left!.widthPt - 1.134) < 0.01, "0.4mm")
    assert.equal(b3.right!.type, "DOUBLE_SLIM"); assert.ok(Math.abs(b3.right!.widthPt - 1.417) < 0.01, "0.5mm")
    assert.equal(b3.top, undefined)
    assert.equal(b3.bottom!.color, "#FF0000")
    assert.equal(b3.fill, "#DFE6F7")
  })
  it("DocInfo 가 비어도 기본 테이블", () => {
    const st = buildHwp5RenderStyles([])
    assert.equal(st.charPr.size, 0); assert.equal(st.borderFill.size, 0)
  })
})

describe("hwp5-scene: 레코드 → section DOM", () => {
  it("문단·run 분할·lineseg·secPr(pagePr)·표(cellAddr/cellSz/pos)·그림(img ref) 이 HWPX 동형 속성으로 나온다", () => {
    const recs = sectionRecords()
    const xml = hwp5SectionToXml(recs, { tableIds: tableIdsOf(recs), imageRef: (id) => `bin${id}`, warnings: [] })
    assert.ok(xml.startsWith("<hs:sec ") && xml.endsWith("</hs:sec>"))
    assert.ok(xml.includes('<hp:pagePr landscape="WIDELY" width="59528" height="84188"><hp:margin left="5669" right="5669" top="4252" bottom="4252"'))
    assert.ok(xml.includes('<hp:colPr colCount="1"/>'))
    // 글자 모양 경계에서 run 교체
    assert.ok(xml.includes('<hp:run charPrIDRef="1"><hp:t>가나</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>다라</hp:t></hp:run>'), xml.slice(0, 900))
    assert.ok(xml.includes('<hp:lineseg textpos="0" vertpos="1000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48190" flags="393216"/>'))
    assert.ok(xml.includes('<hp:tbl id="t1" textWrap="SQUARE" rowCnt="1" colCnt="2"'))
    assert.ok(xml.includes('<hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'))
    assert.ok(xml.includes('<hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="20000" height="4000"/>'))
    assert.ok(xml.includes('<hp:tc borderFillIDRef="3">'))
    assert.ok(xml.includes('<hp:pic textWrap="SQUARE"><hp:sz width="6000" height="3000"/>') && xml.includes('<hp:img binaryItemIDRef="bin1"/>'), xml)
    assert.ok(xml.includes('<hp:imgDim dimwidth="6000" dimheight="3000"/>') && !xml.includes("imgClip"), "크롭 없음")
  })
  it("탭·줄바꿈·묶음빈칸은 슬롯 모델대로(탭=8슬롯 hp:tab, 0x1e=nbSpace), 외부 연결 이미지는 ref 없음", () => {
    const tab = Buffer.alloc(16); tab.writeUInt16LE(9, 0); tab.writeUInt16LE(9, 14)
    const recs = [paraHeader(0), paraText(1, ["A", { ctrl: "x", ch: 9 }, "B"]), charShape(1, [[0, 0]]), lineSeg(1, [{ vertpos: 0, horzsize: 1000 }])]
    // paraText 는 ctrl 을 16B 확장으로 쓴다 — 탭(인라인 9)도 같은 폭
    const xml = hwp5SectionToXml(recs, { tableIds: new Map(), imageRef: () => null, warnings: [] })
    assert.ok(xml.includes("<hp:t>A</hp:t><hp:tab/><hp:t>B</hp:t>"), xml)
    const recs2 = sectionRecords()
    const xml2 = hwp5SectionToXml(recs2, { tableIds: tableIdsOf(recs2), imageRef: () => null, warnings: [] })
    assert.ok(xml2.includes("<hp:img/>"))
    void tab
  })
  it("부유 그림은 textWrap 을 갖고(BEHIND_TEXT 직인이 밀어내기로 오르지 않게), 묶음 개체 자식은 접두 없는 레이아웃으로 읽는다", () => {
    const recs = [
      ...simplePara("", [{ vertpos: 0, horzsize: 48190 }], {
        parts: [{ ctrl: "gso " }, { ctrl: "gso " }],
        ctrls: [
          ctrlHeader(1, "gso ", { tac: false, w: 6000, h: 3000, wrap: 2 }), shapeComponent(2, "$pic", { orgW: 6000, orgH: 3000 }), shapePicture(2, 1),
          ctrlHeader(1, "gso ", { tac: false, w: 9000, h: 5000, wrap: 1 }), shapeComponent(2, "$con", { orgW: 9000, orgH: 5000 }),
          shapeComponent(3, "$rec", { orgW: 4000, orgH: 2000, xoff: 100, yoff: 200, nested: true }),
          shapeComponent(3, "$con", { orgW: 3000, orgH: 1000, xoff: 5000, yoff: 3000, nested: true }),
          shapeComponent(4, "$ell", { orgW: 1000, orgH: 1000, xoff: 10, yoff: 20, nested: true }),
        ],
      }),
    ]
    const xml = hwp5SectionToXml(recs, { tableIds: new Map(), imageRef: (id) => `bin${id}`, warnings: [] })
    assert.ok(xml.includes('<hp:pic textWrap="BEHIND_TEXT"><hp:sz width="6000" height="3000"/><hp:pos treatAsChar="0"'), xml)
    assert.ok(xml.includes('<hp:container textWrap="TOP_AND_BOTTOM">'))
    assert.ok(xml.includes('<hp:rect><hp:sz width="4000" height="2000"/><hp:offset x="100" y="200"/>'), xml)
    assert.ok(xml.includes('<hp:container><hp:sz width="3000" height="1000"/><hp:offset x="5000" y="3000"/><hp:ellipse><hp:sz width="1000" height="1000"/><hp:offset x="10" y="20"/>'), xml)
    assert.ok(!xml.includes("<hp:ole"), "자식이 ole 로 새지 않는다")
  })
  it("가로 용지(PAGE_DEF attr bit0) → landscape NARROWLY", () => {
    const recs = [...simplePara("", [{ vertpos: 0, horzsize: 72852 }], { parts: [{ ctrl: "secd" }], ctrls: [ctrlHeader(1, "secd"), pageDef(2, { landscape: true })] })]
    const xml = hwp5SectionToXml(recs, { tableIds: new Map(), imageRef: () => null, warnings: [] })
    assert.ok(xml.includes('landscape="NARROWLY"'))
  })
})

describe("hwp5-scene: 통합 렌더(renderHwp5Records)", () => {
  const styles = () => buildHwp5RenderStyles(docInfoRecords())
  const docInfo = () => parseDocInfo(docInfoRecords())
  const bin = () => new Map([[1, { data: TINY_PNG, name: "BIN0001.png" }]])

  it("scene.format hwp, A4 페이지 크기, region 유형별 결정적 id, 표 sourceId t1, 이미지 심볼·텍스트", () => {
    const { scene, pageSvgs } = renderHwp5Records(docInfo(), styles(), [sectionRecords()], bin())
    assert.equal(scene.format, "hwp")
    assert.equal(scene.pages.length, 1)
    assert.ok(Math.abs(scene.pages[0].width - 595.28) < 0.1 && Math.abs(scene.pages[0].height - 841.88) < 0.1)
    const tables = scene.regions.filter(r => r.type === "table")
    assert.equal(tables.length, 1)
    assert.equal(tables[0].sourceId, "t1")
    assert.equal(tables[0].id, "table-000001")
    // TAC 표: x = 왼 여백, 폭 = 표 폭
    assert.ok(Math.abs(tables[0].regions[0].x - 56.69) < 0.1, String(tables[0].regions[0].x))
    assert.ok(Math.abs(tables[0].regions[0].width - 400) < 0.1)
    assert.equal(scene.regions.filter(r => r.type === "image").length, 1)
    assert.equal(scene.stats.images, 1)
    assert.ok(scene.regions.filter(r => r.type === "paragraph").length >= 3)
    const svg = pageSvgs.get(1)!
    assert.ok(svg.includes(">가나<") && svg.includes(">다라<") && svg.includes(">왼칸<"))
    assert.ok(svg.includes('font-weight="bold"') && svg.includes('fill="#FF0000"'))
    assert.ok(svg.includes('<symbol id="bin0"') && svg.includes('href="#bin0"'))
    // 셀 배경 #DFE6F7 + 0.4mm 왼변
    assert.ok(svg.includes('fill="#DFE6F7"'))
    assert.ok(svg.includes('stroke-width="1.13"'))
    assert.deepEqual(scene.warnings, [])
  })
  it("vertpos 역행 → 2쪽, 2쪽 region 은 페이지 로컬 좌표", () => {
    const { scene, pageSvgs } = renderHwp5Records(docInfo(), styles(), [sectionRecords({ twoPages: true })], bin())
    assert.equal(scene.pages.length, 2)
    const p2 = scene.regions.filter(r => r.page === 2)
    assert.ok(p2.length >= 1)
    assert.ok(p2[0].regions[0].y < 100)
    assert.equal(pageSvgs.size, 2)
  })
  it("select 로 페이지 선택 시 비선택 페이지 SVG 는 만들지 않는다", () => {
    const { scene, pageSvgs } = renderHwp5Records(docInfo(), styles(), [sectionRecords({ twoPages: true })], bin(), undefined, new Set([2]))
    assert.equal(scene.pages.length, 2)
    assert.deepEqual([...pageSvgs.keys()], [2])
  })
  it("이미지 바이너리 누락은 placeholder + 경고, 표 순번은 구역 누적", () => {
    const { scene } = renderHwp5Records(docInfo(), styles(), [sectionRecords(), sectionRecords()], new Map())
    assert.ok(scene.warnings.some(w => w.includes("이미지 바이너리 누락")))
    assert.deepEqual(scene.regions.filter(r => r.type === "table").map(r => r.sourceId), ["t1", "t2"])
    assert.equal(scene.pages.length, 2)
  })
  it("구역 전부 null 이면 KordocError", () => {
    assert.throws(() => renderHwp5Records(null, styles(), [null], new Map()), /렌더할 구역이 없습니다/)
  })
})

describe("hwp5-scene: 코퍼스 (bench/corpus/hwp5)", { skip: !existsSync(HWP5_DIR) }, () => {
  it("merging-cell.hwp — 표 region 1 · sourceId t1 · 파서 IRTable.sourceId 와 일치", async () => {
    const f = join(HWP5_DIR, "merging-cell.hwp")
    assert.ok(existsSync(f), "코퍼스 hwp5/merging-cell.hwp 필요")
    const { scene } = await renderDocumentToScene(f)
    assert.equal(scene.format, "hwp")
    const tables = scene.regions.filter(r => r.type === "table")
    assert.equal(tables.length, 1)
    assert.equal(tables[0].sourceId, "t1")
    const parsed = await parse(readFileSync(f).buffer as ArrayBuffer)
    assert.ok(parsed.success)
    const ir = collectTableBlocks(parsed.blocks)
    assert.equal(ir.length, 1)
    assert.equal(ir[0].table!.sourceId, "t1")
  })
  it("renderDocument png/svg 가 .hwp 에서 동작한다", async () => {
    const f = join(HWP5_DIR, "merging-cell.hwp")
    assert.ok(existsSync(f))
    const png = await renderDocument(f, { format: "png", maxWidthPx: 400 })
    assert.equal(png.assets.length, 1)
    assert.equal((png.assets[0].data as Buffer)[0], 0x89)
    const svg = await renderDocument(f, { format: "svg" })
    assert.ok((svg.assets[0].data as string).includes("data-kordoc-type=\"table\""))
  })
  it("extractTables — HWP5 도 region 조인·crop (경고 없음)", async () => {
    const f = join(HWP5_DIR, "merging-cell.hwp")
    assert.ok(existsSync(f))
    const out = await extractTables(f, { policy: "all" })
    assert.equal(out.length, 1)
    assert.equal(out[0].sourceId, "t1")
    assert.equal(out[0].regions.length, 1)
    assert.equal(out[0].crops.length, 1)
    assert.deepEqual(out[0].warnings, [])
  })
  it("코퍼스 전 파일이 예외 없이 렌더된다(10MB 초과 제외)", async () => {
    for (const n of readdirSync(HWP5_DIR).filter(n => n.endsWith(".hwp"))) {
      const f = join(HWP5_DIR, n)
      if (readFileSync(f).length > 5 * 1024 * 1024) continue
      const { scene } = await renderDocumentToScene(f)
      assert.ok(scene.pages.length >= 1, n)
    }
  })
})

describe("hwp5-scene: hwp↔hwpx pairs 파리티", { skip: !existsSync(PAIRS_DIR) }, () => {
  it("같은 문서의 HWP5·HWPX 렌더는 페이지 수·페이지 크기·표 수·첫 표 bbox 가 같다", async () => {
    const stems = [...new Set(readdirSync(PAIRS_DIR).filter(n => n.endsWith(".hwp")).map(n => n.slice(0, -4)))].filter(s => existsSync(join(PAIRS_DIR, s + ".hwpx")))
    assert.ok(stems.length > 0)
    for (const s of stems) {
      const a = (await renderDocumentToScene(join(PAIRS_DIR, s + ".hwp"))).scene
      const b = (await renderDocumentToScene(join(PAIRS_DIR, s + ".hwpx"))).scene
      assert.equal(a.pages.length, b.pages.length, `${s} pages`)
      assert.deepEqual(a.pages.map(p => [p.width, p.height]), b.pages.map(p => [p.width, p.height]), `${s} page size`)
      const ta = a.regions.filter(r => r.type === "table"), tb = b.regions.filter(r => r.type === "table")
      assert.equal(ta.length, tb.length, `${s} tables`)
      if (ta.length && tb.length) {
        const [x, y] = [ta[0].regions[0], tb[0].regions[0]]
        for (const k of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(x[k] - y[k]) < 0.5, `${s} tbl1 ${k}: ${x[k]} vs ${y[k]}`)
        assert.equal(x.page, y.page)
      }
    }
  })
})
