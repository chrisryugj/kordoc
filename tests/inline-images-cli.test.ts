/** --inline-images 비-HWP5 이미지 유실 방지 회귀 (image-1)
 *
 * 이미지 인라인은 HWP5 경로(parser.ts)에서만 실제로 일어난다. CLI 가 --inline-images 만
 * 보고 모든 포맷에서 이미지 저장을 건너뛰면, 비-HWP5(HWPX/DOCX) 문서는 이미지 바이트가
 * 통째로 유실된다. 수정: 실제 인라인된 경우(fileType==="hwp")에만 저장/접두사를 생략한다.
 *
 * 검증 매개체로 DOCX 를 쓴다 — jszip 으로 이미지 1개짜리 최소 DOCX 를 합성해 실제 CLI 를
 * 돌린다. (DOCX 마크다운은 이미지 참조를 내지 않으므로 여기선 '바이트 유실 없음'을 검증한다.
 * HWP5 인라인 경로의 참조 치환은 실파일 E2E 로 별도 확인.)
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

/** BinData 로 남을 임의 바이트 — 유효 이미지일 필요 없음(파서가 바이트를 그대로 저장) */
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 22, 33, 44, 55, 66])

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:r><w:t>이미지 포함 문서</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
      </pic:pic>
    </a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  </w:body>
</w:document>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

/** 이미지 1개짜리 최소 DOCX 를 합성해 파일로 쓴다 */
async function buildImageDocx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", CONTENT_TYPES)
  zip.file("_rels/.rels", ROOT_RELS)
  zip.file("word/document.xml", DOCUMENT_XML)
  zip.file("word/_rels/document.xml.rels", DOC_RELS)
  zip.file("word/media/image1.png", IMAGE_BYTES)
  const buf = await zip.generateAsync({ type: "nodebuffer" })
  writeFileSync(path, buf)
}

test("image-1: --inline-images 로 비-HWP5(DOCX) 변환 시 이미지 바이트가 유실되지 않고 저장된다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-inline-docx-"))
  try {
    const docx = join(dir, "imgdoc.docx")
    await buildImageDocx(docx)
    const outDir = join(dir, "out")

    execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, docx, "--inline-images", "-d", outDir, "--silent"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 },
    )

    // 핵심: 인라인이 실제로 일어나지 않는 포맷이므로 이미지가 파일로 저장되어야 한다(바이트 유실 X)
    const savedImg = join(outDir, "images", "image_001.png")
    assert.ok(existsSync(savedImg), "비-HWP5 는 --inline-images 여도 이미지가 저장되어야 함")
    assert.deepEqual(new Uint8Array(readFileSync(savedImg)), IMAGE_BYTES, "저장된 이미지 바이트가 원본과 일치")

    // 비-HWP5 는 인라인되지 않으므로 마크다운에 data URI 가 새어나오면 안 된다
    const md = readFileSync(join(outDir, "imgdoc.md"), "utf-8")
    assert.ok(!md.includes("data:image"), "인라인되지 않은 포맷 출력에 data URI 가 없어야 함")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("image-1: --inline-images 없는 레거시 경로도 이미지를 그대로 저장한다(무변화)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-inline-docx-legacy-"))
  try {
    const docx = join(dir, "imgdoc.docx")
    await buildImageDocx(docx)
    const outDir = join(dir, "out")

    execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, docx, "-d", outDir, "--silent"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 30000 },
    )

    const savedImg = join(outDir, "images", "image_001.png")
    assert.ok(existsSync(savedImg), "레거시 경로도 이미지를 저장해야 함")
    assert.deepEqual(new Uint8Array(readFileSync(savedImg)), IMAGE_BYTES, "저장된 이미지 바이트가 원본과 일치")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
