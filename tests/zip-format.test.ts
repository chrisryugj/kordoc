/** ZIP 포맷 세분화 + PPTX 미지원 오류 (#80). */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { detectFormat, detectZipFormat, fillForm, parse } from "../src/index.js"
import { renderDocumentToScene } from "../src/render/document.js"

async function archive(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}

const presentation = '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
const section = '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>복구할 본문</hp:t></hp:run></hp:p></hs:sec>'

describe("ZIP 포맷 감지", () => {
  for (const [entry, expected] of [
    ["xl/workbook.xml", "xlsx"],
    ["word/document.xml", "docx"],
    ["ppt/presentation.xml", "pptx"],
    ["Contents/content.hpf", "hwpx"],
    ["Contents/section0.xml", "hwpx"],
    ["mimetype", "hwpx"],
    ["readme.txt", "unknown"],
  ] as const) {
    it(`${entry} → ${expected} (동기 감지는 ZIP 하위 호환 유지)`, async () => {
      const buffer = await archive({ [entry]: "" })
      assert.equal(await detectZipFormat(buffer), expected)
      assert.equal(detectFormat(buffer), "hwpx")
    })
  }

  it("PPTX 표식은 일반 mimetype/Contents 휴리스틱보다 우선한다", async () => {
    const buffer = await archive({
      "ppt/presentation.xml": presentation,
      "mimetype": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Contents/notes.txt": "not an HWPX section",
    })
    assert.equal(await detectZipFormat(buffer), "pptx")
    const result = await parse(buffer)
    assert.equal(result.success, false)
    assert.equal(result.fileType, "pptx")
  })

  it("잘못된 ZIP/빈 버퍼는 예외 없이 unknown", async () => {
    for (const buffer of [new ArrayBuffer(0), new Uint8Array([0x50, 0x4b, 3, 4]).buffer]) {
      assert.equal(await detectZipFormat(buffer), "unknown")
    }
  })
})

describe("PPTX 라우팅 (#80)", () => {
  it("ArrayBuffer와 슬라이스된 Buffer 입력 모두 PPTX 미지원 오류", async () => {
    const buffer = await archive({ "ppt/presentation.xml": presentation })
    const padded = Buffer.concat([Buffer.from("prefix"), Buffer.from(buffer), Buffer.from("suffix")])
    for (const input of [buffer, padded.subarray(6, 6 + buffer.byteLength)]) {
      const result = await parse(input)
      assert.equal(result.success, false)
      assert.equal(result.fileType, "pptx")
      if (result.success) assert.fail("PPTX 파싱은 지원하지 않음")
      assert.equal(result.code, "UNSUPPORTED_FORMAT")
      assert.match(result.error, /PPTX/)
      assert.match(result.error, /지원하지 않/)
      assert.doesNotMatch(result.error, /HWPX|섹션/)
    }
  })

  it("렌더와 원본 보존 채우기도 HWPX로 처리하지 않고 pptx를 명시한다", async () => {
    const buffer = await archive({ "ppt/presentation.xml": presentation })
    await assert.rejects(renderDocumentToScene(buffer), /미지원 형식\(pptx\)/)
    await assert.rejects(fillForm(buffer, {}, "hwpx-preserve"), /감지된 포맷: pptx/)
  })
})

describe("HWPX 호환성", () => {
  it("감지 표식 없이 루트에 section XML만 있는 HWPX도 파싱한다", async () => {
    const buffer = await archive({ "section0.xml": section })
    assert.equal(await detectZipFormat(buffer), "unknown")
    const result = await parse(buffer)
    assert.equal(result.success, true)
    assert.equal(result.fileType, "hwpx")
    if (result.success) assert.match(result.markdown, /복구할 본문/)
  })

  it("중앙 디렉토리가 손상된 HWPX의 Local File Header 복구를 유지한다", async () => {
    const buffer = Buffer.from(await archive({ "Contents/section0.xml": section }))
    const centralDirectory = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(centralDirectory > 0)
    const broken = buffer.subarray(0, centralDirectory)
    assert.equal(await detectZipFormat(broken.buffer.slice(broken.byteOffset, broken.byteOffset + broken.byteLength)), "unknown")
    const result = await parse(broken)
    assert.equal(result.success, true)
    assert.equal(result.fileType, "hwpx")
    if (result.success) {
      assert.match(result.markdown, /복구할 본문/)
      assert.ok(result.warnings?.some(w => w.code === "BROKEN_ZIP_RECOVERY"))
    }
  })
})
