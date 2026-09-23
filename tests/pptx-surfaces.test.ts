/** #80: unsupported PPTX must remain an explicit failure across CLI and MCP. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import JSZip from "jszip"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const MCP = fileURLToPath(new URL("../src/mcp.ts", import.meta.url))
const TITLE = "ZIP metadata regression"
const CORE_PROPERTIES = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${TITLE}</dc:title>
</cp:coreProperties>`

async function makeZip(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(parts)) zip.file(path, content)
  zip.file("docProps/core.xml", CORE_PROPERTIES)
  return zip.generateAsync({ type: "nodebuffer" })
}

function makePptx(): Promise<Buffer> {
  return makeZip({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    </Types>`,
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>`,
  })
}

for (const format of ["markdown", "json", "chunks"]) {
  test(`#80 CLI ${format}: PPTX returns failure JSON and leaves output untouched`, { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-pptx-cli-"))
    try {
      const input = join(dir, "presentation.pptx")
      const output = join(dir, "output.txt")
      writeFileSync(input, await makePptx())
      // Exercise both no output creation and no overwrite of an existing file.
      if (format === "json") writeFileSync(output, "existing output")

      const result = spawnSync(process.execPath, [
        "--import", "tsx", CLI, input, "--format", format, "--output", output, "--silent",
      ], { cwd: ROOT, encoding: "utf-8", timeout: 20000, env: { ...process.env, KORDOC_OFFLINE: "1" } })

      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stderr)
      const failure = JSON.parse(result.stdout)
      assert.equal(failure.success, false)
      assert.equal(failure.fileType, "pptx")
      assert.equal(failure.code, "UNSUPPORTED_FORMAT")
      assert.match(failure.error, /PPTX/)
      assert.match(failure.error, /지원하지 않/)
      assert.match(result.stderr, /PPTX/)
      if (format === "json") assert.equal(readFileSync(output, "utf-8"), "existing output")
      else assert.equal(existsSync(output), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("#80 MCP: unsupported PPTX and supported ZIP metadata stay distinct", { timeout: 60000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-pptx-mcp-"))
  const client = new Client({ name: "pptx-regression", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP],
    cwd: ROOT,
    env: { KORDOC_OFFLINE: "1", KORDOC_ROOT: dir },
    stderr: "pipe",
  })
  let stderr = ""
  transport.stderr?.on("data", (data: Buffer) => { stderr += data.toString() })

  const callTool = async (name: string, path: string) => {
    const result = await client.callTool({ name, arguments: { file_path: path } }, undefined, { timeout: 10000 })
    const content = result.content as { type: string; text?: string }[]
    return { isError: result.isError, text: content.filter(item => item.type === "text").map(item => item.text).join("\n") }
  }

  try {
    const pptx = await makePptx()
    const renamed = join(dir, "presentation.hwpx")
    const original = join(dir, "presentation.pptx")
    writeFileSync(renamed, pptx)
    writeFileSync(original, pptx)
    try {
      await client.connect(transport, { timeout: 20000 })
    } catch (error) {
      throw new Error(`MCP connection failed: ${stderr}`, { cause: error })
    }

    await t.test("detect_format identifies PPTX content behind a .hwpx extension", async () => {
      const result = await callTool("detect_format", renamed)
      assert.notEqual(result.isError, true, result.text)
      assert.equal(result.text, `${renamed}: pptx`)
    })

    for (const tool of ["parse_document", "parse_metadata"]) {
      await t.test(`${tool} rejects PPTX content behind a .hwpx extension`, async () => {
        const result = await callTool(tool, renamed)
        assert.equal(result.isError, true, result.text)
        assert.match(result.text, /PPTX/)
        assert.match(result.text, /지원하지 않/)
      })
    }

    // 원본 보존 채우기·패치도 "감지된 포맷: hwpx" 가 아니라 실제 포맷을 안내한다
    for (const [tool, args] of [
      ["fill_form", { file_path: renamed, fields: { 성명: "홍길동" }, output_format: "hwpx-preserve" }],
      ["patch_document", { file_path: renamed, edited_markdown: "본문", output_path: join(dir, "patched.hwpx") }],
    ] as const) {
      await t.test(`${tool} names the refined PPTX format`, async () => {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10000 })
        const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? "").join("\n")
        assert.equal(result.isError, true, text)
        assert.match(text, /감지된 포맷: pptx/)
      })
    }

    for (const tool of ["detect_format", "parse_document", "parse_metadata"]) {
      await t.test(`${tool} continues to reject the unsupported .pptx extension`, async () => {
        const result = await callTool(tool, original)
        assert.equal(result.isError, true, result.text)
        assert.match(result.text, /지원하지 않는 확장자/)
        assert.match(result.text, /\.pptx/)
      })
    }

    const supported: Record<string, Record<string, string>> = {
      hwpx: {
        mimetype: "application/hwp+zip",
        "Contents/section0.xml": `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"/>`,
      },
      xlsx: {
        "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
        </workbook>`,
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
      },
      docx: {
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
      },
    }
    for (const [format, parts] of Object.entries(supported)) {
      await t.test(`parse_metadata still extracts ${format.toUpperCase()} metadata with its refined format`, async () => {
        // Use .hwpx for every ZIP so this verifies content detection rather than the filename.
        const path = join(dir, `${format}-metadata.hwpx`)
        writeFileSync(path, await makeZip(parts))
        const result = await callTool("parse_metadata", path)
        assert.notEqual(result.isError, true, result.text)
        const metadata = JSON.parse(result.text)
        assert.equal(metadata.format, format)
        assert.equal(metadata.title, TITLE)
      })
    }
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
