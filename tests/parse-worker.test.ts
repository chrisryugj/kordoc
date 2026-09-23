/** 4.14.3: 글자만 필요한 호출자용 두 가지
 *
 * ① `ParseOptions.images: false` / CLI `--no-images`: 이미지 바이트를 결과에 싣지 않는다
 *    (그림 자리 표시는 남김). 그림 많은 문서의 JSON 이 base64 이미지로 수십~수백 MB 가 됐다.
 * ② `parse-worker`: 파일마다 node 를 새로 띄우지 않는 상주 파싱 워커 (NDJSON).
 *
 * 매개체는 json-image-refs 회귀와 같은 합성 DOCX(이미지 1개).
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { parse } from "../src/index.js"
import type { IRBlock } from "../src/types.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 22, 33, 44, 55, 66])

async function buildDocx(path: string, bodyText = "이미지 포함 문서"): Promise<void> {
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
    <w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>
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

function hasImageData(blocks: IRBlock[] | undefined): boolean {
  for (const b of blocks ?? []) {
    if (b.imageData) return true
    if (hasImageData(b.children)) return true
    for (const row of b.table?.cells ?? []) for (const cell of row) if (hasImageData(cell.blocks)) return true
  }
  return false
}

describe("images: false", () => {
  test("API: 이미지 바이트는 빼고 글자·그림 자리 표시는 그대로", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-noimg-"))
    try {
      const docx = join(dir, "imgdoc.docx")
      await buildDocx(docx)
      const buf = readFileSync(docx)
      const full = await parse(buf)
      const lean = await parse(buf, { images: false })
      assert.ok(full.success && lean.success)
      assert.equal(full.images?.length, 1, "기본은 종전대로 이미지 추출 (계약 불변)")
      assert.equal(lean.images, undefined)
      assert.equal(hasImageData(lean.blocks), false, "블록의 imageData 도 떼야 함")
      assert.match(lean.markdown, /이미지 포함 문서/)
      assert.equal(lean.markdown, full.markdown, "마크다운(그림 자리 표시 포함)은 같아야 함")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("CLI --no-images: JSON 에 base64 가 없다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-noimg-cli-"))
    try {
      const docx = join(dir, "imgdoc.docx")
      await buildDocx(docx)
      const stdout = execFileSync(process.execPath,
        ["--import", "tsx", CLI, docx, "--format", "json", "--silent", "--no-images"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 })
      const json = JSON.parse(stdout)
      assert.equal(json.success, true)
      assert.equal(json.images, undefined)
      assert.ok(!stdout.includes(Buffer.from(IMAGE_BYTES).toString("base64")), "이미지 base64 가 출력에 있으면 안 됨")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parse-worker", () => {
  /** 입력 줄들을 보내고 stdin 을 닫은 뒤 출력 줄과 종료 코드를 모은다 */
  const runWorker = (lines: string[], timeoutMs = 60000): Promise<{ out: string[]; code: number | null }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", CLI, "parse-worker"], { stdio: ["pipe", "pipe", "ignore"] })
      let out = ""
      child.stdout.on("data", (d) => { out += String(d) })
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ out: out.split("\n").filter(Boolean), code: null }) }, timeoutMs)
      child.on("exit", (code) => { clearTimeout(timer); resolve({ out: out.split("\n").filter(Boolean), code }) })
      child.stdin.end(lines.map((l) => l + "\n").join(""))
    })

  test("ready → 요청마다 한 줄 응답 (성공·실패·잘못된 요청) → quit 으로 종료", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-pw-"))
    try {
      const docx = join(dir, "imgdoc.docx")
      await buildDocx(docx)
      const { out, code } = await runWorker([
        JSON.stringify({ id: 1, file: docx, images: false, ocr: "off" }),
        "not json",
        JSON.stringify({ id: 2, file: join(dir, "없는파일.hwp") }),
        JSON.stringify({ id: 3 }),
        JSON.stringify({ id: 4, file: docx }),
        JSON.stringify({ cmd: "quit" }),
      ])
      assert.equal(code, 0, "quit 후 exit 0")
      const msgs = out.map((l) => JSON.parse(l))
      assert.equal(msgs[0].ready, true)
      assert.equal(msgs[0].protocol, 1)

      const r1 = msgs.find((m) => m.id === 1)
      assert.equal(r1.result.success, true)
      assert.match(r1.result.markdown, /이미지 포함 문서/)
      assert.equal(r1.result.images, undefined, "images:false 요청")
      assert.ok(typeof r1.rss === "number" && r1.rss > 0, "rss 보고")

      assert.ok(msgs.some((m) => m.error === "잘못된 JSON 라인" && m.id === undefined), "비JSON 줄에도 응답")
      const r2 = msgs.find((m) => m.id === 2)
      assert.equal(r2.result.success, false, "없는 파일은 result 의 실패 JSON 으로")
      assert.ok(r2.result.code)
      assert.equal(msgs.find((m) => m.id === 3).error, "file 필수")
      const r4 = msgs.find((m) => m.id === 4)
      assert.equal(r4.result.images[0].data, Buffer.from(IMAGE_BYTES).toString("base64"), "기본은 --format json 과 같게 base64")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("stdin 이 닫혀도 마지막 큰 응답을 끝까지 쓰고 종료한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-pw-big-"))
    try {
      // 응답 한 줄이 수 MB. 비동기 파이프(맥·윈도)에서 바로 exit 하면 잘렸다
      const docx = join(dir, "big.docx")
      await buildDocx(docx, "가나다라마바사 ".repeat(300_000))
      const { out, code } = await runWorker([JSON.stringify({ id: 7, file: docx, images: false })])
      assert.equal(code, 0)
      const last = JSON.parse(out[out.length - 1])
      assert.equal(last.id, 7)
      assert.equal(last.result.success, true)
      assert.ok(last.result.markdown.length > 2_000_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
