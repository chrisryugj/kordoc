/** XLSX 칸 하이퍼링크·PPTX 글 링크 → "[글](주소)" (DOCX 링크와 같은 꼴) */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CT = (main: string, type: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="${type}"/></Types>`
const ROOT = (target: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="${target}"/></Relationships>`

describe("오피스 링크", () => {
  it("XLSX: 바깥 링크 칸은 [글](주소), 문서 안 위치 링크·허용 안 된 스킴은 평문", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", CT("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"))
    zip.file("_rels/.rels", ROOT("xl/workbook.xml"))
    zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="목록" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheetData>`
      + `<row r="1"><c r="A1" t="inlineStr"><is><t>누리집</t></is></c><c r="B1" t="inlineStr"><is><t>시트 이동</t></is></c><c r="C1" t="inlineStr"><is><t>스크립트</t></is></c></row></sheetData>`
      + `<hyperlinks><hyperlink ref="A1" r:id="rId7"/><hyperlink ref="B1" location="목록!A1"/><hyperlink ref="C1" r:id="rId8"/></hyperlinks></worksheet>`)
    zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="${REL}/hyperlink" Target="https://www.gwangjin.go.kr/" TargetMode="External"/><Relationship Id="rId8" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`)
    const r = await parse(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(r.success)
    if (!r.success) return
    assert.match(r.markdown, /\[누리집\]\(https:\/\/www\.gwangjin\.go\.kr\/\)/)
    assert.match(r.markdown, /\| 시트 이동 \|/)
    assert.doesNotMatch(r.markdown, /javascript/)
  })

  it("PPTX: 같은 주소가 이어진 조각은 한 링크, 링크 없는 조각은 그대로", async () => {
    const zip = new JSZip()
    const P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"`
    zip.file("[Content_Types].xml", CT("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"))
    zip.file("_rels/.rels", ROOT("ppt/presentation.xml"))
    zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId10"/></p:sldIdLst></p:presentation>`)
    zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`)
    const run = (t: string, link?: string) => `<a:r><a:rPr lang="ko-KR">${link ? `<a:hlinkClick r:id="${link}"/>` : ""}</a:rPr><a:t>${t}</a:t></a:r>`
    zip.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p>${run("자세한 내용은 ")}${run("구청 ", "rId3")}${run("누리집", "rId3")}${run(" 참고")}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
    zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="${REL}/hyperlink" Target="https://www.gwangjin.go.kr/" TargetMode="External"/></Relationships>`)
    const r = await parse(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(r.success)
    if (!r.success) return
    assert.match(r.markdown, /자세한 내용은 \[구청 누리집\]\(https:\/\/www\.gwangjin\.go\.kr\/\) 참고/)
  })
})
