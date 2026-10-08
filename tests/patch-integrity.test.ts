/**
 * HWPX 패치 무결성 검사 (checkPatchIntegrity) — 재파싱 검증이 놓치는 손상을 바이트·구조로 잡는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { checkPatchIntegrity } from "../src/roundtrip/integrity.js"
import { patchZipEntries } from "../src/roundtrip/zip-patch.js"

const SECTION = "Contents/section0.xml"
const XML = `<hs:sec xmlns:hs="a" xmlns:hp="b"><hp:p id="1"><hp:run charPrIDRef="0"><hp:t>원래 글</hp:t></hp:run><hp:linesegarray><hp:lineseg vertpos="0"/></hp:linesegarray></hp:p></hs:sec>`

async function original(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file(SECTION, XML, { compression: "DEFLATE" })
  zip.file("BinData/image1.png", new Uint8Array([1, 2, 3, 4]), { compression: "STORE" })
  return zip.generateAsync({ type: "uint8array" })
}

const enc = (s: string) => new TextEncoder().encode(s)
const at = XML.indexOf("원래 글")
const textSplice = { start: at, end: at + 4, replacement: "고친 글" }
const sections = [{ name: SECTION, xml: XML, splices: [textSplice] }]

describe("checkPatchIntegrity", () => {
  it("글만 고치고 줄 레이아웃 캐시를 비운 정상 패치는 문제 없음", async () => {
    const orig = await original()
    const fixed = XML.replace("원래 글", "고친 글").replace(/<hp:linesegarray>.*?<\/hp:linesegarray>/, "")
    const replacements = new Map([[SECTION, enc(fixed)]])
    assert.deepEqual(checkPatchIntegrity(orig, patchZipEntries(orig, replacements), replacements, sections), [])
  })

  it("교체하지 않은 엔트리의 바이트가 바뀌면 잡는다", async () => {
    const orig = await original()
    const replacements = new Map([[SECTION, enc(XML.replace("원래 글", "고친 글"))]])
    const patched = patchZipEntries(orig, new Map([...replacements, ["BinData/image1.png", new Uint8Array([9, 9, 9, 9])]]))
    assert.match(checkPatchIntegrity(orig, patched, replacements, sections).join(), /교체하지 않은 엔트리의 바이트가 바뀜: BinData\/image1\.png/)
  })

  it("교체한 XML 이 깨졌으면 잡는다 (관대한 재파싱이 복구해 버리는 꼴)", async () => {
    const orig = await original()
    const replacements = new Map([[SECTION, enc(XML.replace("</hp:t>", ""))]])
    assert.match(checkPatchIntegrity(orig, patchZipEntries(orig, replacements), replacements, []).join(), /교체한 XML 이 올바르지 않음/)
  })

  it("글만 고친 섹션에서 태그·속성이 바뀌면 잡는다", async () => {
    const orig = await original()
    const replacements = new Map([[SECTION, enc(XML.replace("원래 글", "고친 글").replace('charPrIDRef="0"', 'charPrIDRef="7"'))]])
    assert.match(checkPatchIntegrity(orig, patchZipEntries(orig, replacements), replacements, sections).join(), /글만 고친 섹션의 태그·속성이 바뀜/)
  })
})
