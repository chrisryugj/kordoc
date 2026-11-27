/** DrawingML 차트·SmartArt 읽기 (src/shared/chart-xml.ts) + DOCX·XLSX·PPTX 연결 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"
import { parseChartXml, chartBlock, smartArtBlocks } from "../src/shared/chart-xml.js"
import { blocksToMarkdown } from "../src/table/builder.js"

const C = `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
const pts = (vals: string[]) => `<c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("")
const ser = (name: string, cats: string[], vals: string[]) =>
  `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>${pts([name])}</c:strCache></c:strRef></c:tx>`
  + `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$9</c:f><c:strCache>${pts(cats)}</c:strCache></c:strRef></c:cat>`
  + `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$9</c:f><c:numCache><c:formatCode>General</c:formatCode>${pts(vals)}</c:numCache></c:numRef></c:val></c:ser>`
const chartXml = (title: string, plot: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace ${C}><c:chart>${title}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea></c:chart></c:chartSpace>`
const richTitle = (t: string) => `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></c:rich></c:tx></c:title>`
const BAR = chartXml(richTitle("연도별 민원"), `<c:barChart><c:barDir val="col"/>${ser("접수", ["2024년", "2025년"], ["12", "0.52000000000000002"])}${ser("처리", ["2024년", "2025년"], ["10", "3"])}</c:barChart>`)

describe("차트 XML", () => {
  it("제목·종류·항목·계열을 읽고 계열 이름에 수식(c:f)을 섞지 않는다", () => {
    const c = parseChartXml(BAR)!
    assert.equal(c.title, "연도별 민원")
    assert.deepEqual(c.kinds, ["세로 막대형"])
    assert.deepEqual(c.categories, ["2024년", "2025년"])
    assert.deepEqual(c.series, [{ name: "접수", values: ["12", "0.52"] }, { name: "처리", values: ["10", "3"] }])
  })

  it("표 블록: 캡션은 제목과 종류, 첫 열은 항목", () => {
    const md = blocksToMarkdown([chartBlock(parseChartXml(BAR)!)])
    assert.match(md, /\*\*차트: 연도별 민원 \(세로 막대형\)\*\*/)
    assert.match(md, /\| 항목 \| 접수 \| 처리 \|/)
    assert.match(md, /\| 2025년 \| 0\.52 \| 3 \|/)
  })

  it("다단 항목은 바깥 단부터 「 / 」로 잇고 바깥 이름을 묶음 끝까지 이어 쓴다", () => {
    const multi = `<c:ser><c:tx><c:v>인원</c:v></c:tx><c:cat><c:multiLvlStrRef><c:f>x</c:f><c:multiLvlStrCache><c:ptCount val="3"/>`
      + `<c:lvl>${pts(["상반기", "하반기", "상반기"])}</c:lvl><c:lvl><c:ptCount val="3"/><c:pt idx="0"><c:v>2024</c:v></c:pt><c:pt idx="2"><c:v>2025</c:v></c:pt></c:lvl>`
      + `</c:multiLvlStrCache></c:multiLvlStrRef></c:cat><c:val><c:numRef><c:numCache>${pts(["1", "2", "3"])}</c:numCache></c:numRef></c:val></c:ser>`
    const c = parseChartXml(chartXml("", `<c:lineChart>${multi}</c:lineChart>`))!
    assert.deepEqual(c.categories, ["2024 / 상반기", "2024 / 하반기", "2025 / 상반기"])
    assert.equal(c.series[0].name, "인원")
    assert.equal(c.title, undefined)
  })

  it("분산형은 x 값이 항목 열, y 값이 계열", () => {
    const sc = `<c:ser><c:tx><c:v>측정</c:v></c:tx><c:xVal><c:numRef><c:numCache>${pts(["0.7", "1.8"])}</c:numCache></c:numRef></c:xVal>`
      + `<c:yVal><c:numRef><c:numCache>${pts(["2.7", "3.2"])}</c:numCache></c:numRef></c:yVal></c:ser>`
    const c = parseChartXml(chartXml("", `<c:scatterChart>${sc}</c:scatterChart>`))!
    assert.deepEqual(c.kinds, ["분산형"])
    assert.deepEqual(c.categories, ["0.7", "1.8"])
    assert.deepEqual(c.series[0].values, ["2.7", "3.2"])
  })

  it("글 없는 c:title 은 자동 제목: 계열이 하나면 계열 이름", () => {
    const auto = `<c:title><c:overlay val="0"/></c:title>`
    assert.equal(parseChartXml(chartXml(auto, `<c:pieChart>${ser("비율", ["가"], ["1"])}</c:pieChart>`))!.title, "비율")
    assert.equal(parseChartXml(chartXml(auto, `<c:pieChart>${ser("A", ["가"], ["1"])}${ser("B", ["가"], ["2"])}</c:pieChart>`))!.title, undefined)
  })

  it("계열이 없거나 깨진 XML 은 null", () => {
    assert.equal(parseChartXml(chartXml("", `<c:barChart/>`)), null)
    assert.equal(parseChartXml("<c:chartSpace"), null)
  })
})

const DGM = `xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
const node = (id: string, t: string) => `<dgm:pt modelId="${id}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></dgm:t></dgm:pt>`
const SMART = `<?xml version="1.0"?><dgm:dataModel ${DGM}><dgm:ptLst><dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:p/></dgm:t></dgm:pt>`
  + `${node("1", "총괄")}${node("2", "담당")}${node("3", "건축")}${node("4", "전기")}<dgm:pt modelId="9" type="parTrans"><dgm:t><a:p><a:r><a:t>숨은 글</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst>`
  + `<dgm:cxnLst><dgm:cxn modelId="a" srcId="0" destId="2" srcOrd="1"/><dgm:cxn modelId="b" srcId="0" destId="1" srcOrd="0"/>`
  + `<dgm:cxn modelId="c" srcId="2" destId="4" srcOrd="1"/><dgm:cxn modelId="d" srcId="2" destId="3" srcOrd="0"/></dgm:cxnLst></dgm:dataModel>`

describe("SmartArt 데이터", () => {
  it("노드 글을 연결 순서대로 중첩 목록으로, 연결선 점(parTrans)의 글은 뺀다", () => {
    const md = blocksToMarkdown(smartArtBlocks(SMART))
    assert.equal(md.trim(), "- 총괄\n- 담당\n  - 건축\n  - 전기")
  })
})

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const graphic = (rid: string) => `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">`
  + `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="${rid}"/></a:graphicData></a:graphic>`

describe("형식별 연결", () => {
  it("DOCX: 문단의 차트를 그 자리에 표로, mc:Fallback 사본은 한 번만", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>`
      + `<w:p><w:r><w:t>앞 문단</w:t></w:r></w:p>`
      + `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="c14"><w:drawing><wp:inline>${graphic("rId5")}</wp:inline></w:drawing></mc:Choice><mc:Fallback><w:drawing><wp:inline>${graphic("rId5")}</wp:inline></w:drawing></mc:Fallback></mc:AlternateContent></w:r></w:p>`
      + `<w:p><w:r><w:t>뒤 문단</w:t></w:r></w:p></w:body></w:document>`)
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="${REL}/chart" Target="charts/chart1.xml"/></Relationships>`)
    zip.file("word/charts/chart1.xml", BAR)
    const r = await parse(await zip.generateAsync({ type: "arraybuffer" }), { charts: true })
    assert.ok(r.success)
    if (!r.success) return
    const md = r.markdown
    assert.equal(md.match(/\*\*차트: 연도별 민원/g)?.length, 1)
    assert.ok(md.indexOf("앞 문단") < md.indexOf("차트: 연도별 민원") && md.indexOf("차트: 연도별 민원") < md.indexOf("뒤 문단"))
    // 원본 표 구조 모드(패치·양식 경로)는 차트를 표로 내지 않는다 — 표 서수가 원본 표와 같아야 한다
    const keep = await parse(await zip.generateAsync({ type: "arraybuffer" }), { layoutTables: "keep", charts: true })
    assert.ok(keep.success && !keep.blocks.some(b => b.type === "table"))
    // 기본(charts 끔)은 출력 불변
    const off = await parse(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(off.success && !off.blocks.some(b => b.type === "table"))
  })

  it("XLSX: 시트 → 그리기 → 차트 관계를 따라 시트 표 뒤에 차트 표", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="통계" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>칸 글</t></is></c></row></sheetData><drawing r:id="rId1"/></worksheet>`)
    zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`)
    zip.file("xl/drawings/drawing1.xml", `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:graphicFrame>${graphic("rId3")}</xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>`)
    zip.file("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="${REL}/chart" Target="../charts/chart1.xml"/></Relationships>`)
    zip.file("xl/charts/chart1.xml", BAR)
    const r = await parse(await zip.generateAsync({ type: "arraybuffer" }), { charts: true })
    assert.ok(r.success)
    if (!r.success) return
    assert.ok(r.markdown.indexOf("칸 글") >= 0 && r.markdown.indexOf("칸 글") < r.markdown.indexOf("차트: 연도별 민원"))
    assert.equal(r.blocks.find(b => b.table?.caption?.startsWith("차트"))?.pageNumber, 1)
  })

  it("PPTX: 그래픽 틀의 차트를 표로 읽고 미지원 경고를 내지 않는다", async () => {
    const zip = new JSZip()
    const P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"`
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)
    zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId10"/></p:sldIdLst></p:presentation>`)
    zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`)
    zip.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
      + `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="차트"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>${graphic("rId2")}</p:graphicFrame></p:spTree></p:cSld></p:sld>`)
    zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/chart" Target="../charts/chart1.xml"/></Relationships>`)
    zip.file("ppt/charts/chart1.xml", BAR)
    const r = await parse(await zip.generateAsync({ type: "arraybuffer" }), { charts: true })
    assert.ok(r.success)
    if (!r.success) return
    assert.match(r.markdown, /\| 2024년 \| 12 \| 10 \|/)
    assert.ok(!(r.warnings ?? []).some(w => w.code === "UNSUPPORTED_ELEMENT"))
  })
})
