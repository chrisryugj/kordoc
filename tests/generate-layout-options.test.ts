import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const cli = join(root, "src", "cli.ts")
const mcp = join(root, "src", "mcp.ts")
const pdf = join(root, "tests", "fixtures", "embedded-cid-font-ucs2.pdf")
const markdown = "# 보고서\n\n본문입니다.\n"

test("CLI rejects --layout with --plain and accepts it with the default preset", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-cli-layout-"))
  try {
    const input = join(dir, "report.md")
    const output = join(dir, "report.hwpx")
    const missing = join(dir, "missing.pdf")
    writeFileSync(input, markdown)
    const generate = (...args: string[]) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "-o", output, "--json"], {
        cwd: root, encoding: "utf8", timeout: 20000, env: { ...process.env, KORDOC_OFFLINE: "1" },
      })
      assert.ifError(result.error)
      return result
    }

    for (const args of [["generate", input, "--plain", "--layout", pdf], ["--plain", "generate", input, "--layout", missing]]) {
      const result = generate(...args)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /--layout.*--plain/)
      assert.equal(result.stdout, "")
      assert.equal(existsSync(output), false)
    }

    const result = generate("generate", input, "--layout", pdf)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /PDF 모양 적용/)
    assert.equal(JSON.parse(result.stdout).preset, "official")
    assert.ok(existsSync(output))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("MCP requires a preset when layout_path is supplied", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-mcp-layout-"))
  const client = new Client({ name: "layout-options-regression", version: "1.0.0" })
  try {
    const layout_path = join(dir, "layout.pdf")
    const output_path = join(dir, "report.hwpx")
    copyFileSync(pdf, layout_path)
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", mcp], cwd: root, stderr: "pipe",
      env: { KORDOC_OFFLINE: "1", KORDOC_ROOT: dir },
    }))
    const generate = async (options: { layout_path?: string; preset?: string }) => {
      const result = await client.callTool({
        name: "generate_document", arguments: { markdown, output_path, ...options },
      }, undefined, { timeout: 10000 })
      const content = result.content as { type: string; text?: string }[]
      return { isError: result.isError, text: content.filter(item => item.type === "text").map(item => item.text).join("\n") }
    }

    for (const path of [layout_path, join(dir, "missing.pdf"), ""]) {
      const result = await generate({ layout_path: path })
      assert.equal(result.isError, true, result.text)
      assert.match(result.text, /layout_path.*preset/)
      assert.equal(existsSync(output_path), false)
    }

    const result = await generate({ layout_path, preset: "report" })
    assert.notEqual(result.isError, true, result.text)
    assert.match(result.text, /PDF 모양 적용/)
    assert.ok(existsSync(output_path))
  } finally {
    try { await client.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
