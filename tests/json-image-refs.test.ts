/** #65 — 이미지 다량 문서의 --format json 출력 계약
 *
 * ① `--image-refs`: 이미지 바이트를 base64 로 인라인하지 않고 저장 경로 참조만 남긴다.
 *    (수백 장 문서는 base64 총량이 V8 문자열 한계를 넘어 RangeError 로 터졌다)
 * ② 파싱 이후 단계에서 터져도 --format json 은 실패 JSON(원인 코드 포함)을 낸다 —
 *    종전엔 "OK" 로그 뒤 비-JSON 이라 파이프라인의 JSON.parse 가 원인 없이 깨졌다.
 *
 * 매개체는 inline-images-cli 회귀와 같은 합성 DOCX(이미지 1개).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 22, 33, 44, 55, 66])

async function buildImageDocx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:r><w:t>이미지 포함 문서</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
      </pic:pic>
    </a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  </w:body>
</w:document>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`)
  zip.file("word/media/image1.png", IMAGE_BYTES)
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }))
}

test("#65: --image-refs 는 base64 대신 저장 경로만 남기고 이미지는 파일로 저장한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-json-refs-"))
  try {
    const docx = join(dir, "imgdoc.docx")
    await buildImageDocx(docx)
    const outDir = join(dir, "out")

    execFileSync(process.execPath,
      ["--import", "tsx", CLI, docx, "--format", "json", "-d", outDir, "--image-refs", "--silent"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 })

    const json = JSON.parse(readFileSync(join(outDir, "imgdoc.json"), "utf-8"))
    assert.equal(json.success, true)
    assert.equal(json.images.length, 1)
    assert.equal(json.images[0].path, "images/image_001.png")
    assert.equal(json.images[0].data, undefined, "참조 모드에서 바이트가 인라인되면 안 됨")

    const savedImg = join(outDir, "images", "image_001.png")
    assert.ok(existsSync(savedImg), "참조가 가리키는 이미지가 실제로 저장되어야 함")
    assert.deepEqual(new Uint8Array(readFileSync(savedImg)), IMAGE_BYTES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("#65: --image-refs 없으면 종전대로 base64 인라인 (계약 불변)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-json-inline-"))
  try {
    const docx = join(dir, "imgdoc.docx")
    await buildImageDocx(docx)
    const outDir = join(dir, "out")

    execFileSync(process.execPath,
      ["--import", "tsx", CLI, docx, "--format", "json", "-d", outDir, "--silent"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 })

    const json = JSON.parse(readFileSync(join(outDir, "imgdoc.json"), "utf-8"))
    assert.equal(json.images[0].data, Buffer.from(IMAGE_BYTES).toString("base64"))
    assert.equal(json.images[0].path, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("#65: 파싱 성공 후 출력 단계가 실패해도 stdout 은 원인 코드가 담긴 JSON 이다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-json-failcontract-"))
  try {
    const docx = join(dir, "imgdoc.docx")
    await buildImageDocx(docx)
    // -o 목적지를 디렉토리로 만들어 두면 파싱 성공 뒤 writeFileSync 가 EISDIR 로 터진다
    const blocked = join(dir, "blocked.json")
    mkdirSync(blocked)

    let stdout = ""
    try {
      stdout = execFileSync(process.execPath,
        ["--import", "tsx", CLI, docx, "--format", "json", "-o", blocked, "--silent"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 })
      assert.fail("출력 실패인데 exit 0")
    } catch (err) {
      const e = err as { stdout?: string; status?: number }
      assert.equal(e.status, 1)
      stdout = e.stdout ?? ""
    }

    const json = JSON.parse(stdout)  // 비-JSON 이면 여기서 깨진다 (#65 본증상)
    assert.equal(json.success, false)
    assert.equal(json.fileType, "docx", "ZIP 세분화된 실제 포맷")
    assert.ok(typeof json.code === "string" && json.code.length > 0, "원인 코드 포함")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
