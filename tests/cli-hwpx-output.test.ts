import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { convertFiles } from "../src/cli/convert.js"
import { parse, validateHwpx } from "../src/index.js"

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  return zip.generateAsync({ type: "nodebuffer" })
}

test("-o 문서.hwpx 는 마크다운 글이 아니라 열리는 HWPX 를 쓴다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-hwpx-out-"))
  try {
    const input = join(dir, "a.docx"), output = join(dir, "a.hwpx")
    writeFileSync(input, await docx("본문 한 줄"))
    assert.equal(await convertFiles([input], { silent: true, format: "markdown", output }), true)
    const bytes = new Uint8Array(readFileSync(output))
    assert.equal(bytes[0], 0x50) // "PK" — zip
    assert.equal((await validateHwpx(bytes)).ok, true)
    const back = await parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    assert.ok(back.success && back.markdown.includes("본문 한 줄"))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
