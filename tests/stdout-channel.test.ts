/**
 * stdout 기계 출력 채널 보호 — xref 가 어긋난 흔한 PDF 에서 pdfjs 가 "Warning: Indexing all PDF objects" 를
 * console.log(=stdout)로 찍어 MCP JSON-RPC 프레이밍과 CLI --format json 이 깨졌다 (v4.14.4 리뷰 재현).
 * 근원은 getDocument verbosity:0, 방어는 진입점의 routeConsoleToStderr (parse-worker 와 같은 처리).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../src/index.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const MCP = fileURLToPath(new URL("../src/mcp.ts", import.meta.url))
const UTILS = fileURLToPath(new URL("../src/utils.ts", import.meta.url))

/** 한 쪽짜리 PDF — startxref 를 7바이트 어긋나게 해 pdfjs 가 전 객체 색인(경고)으로 복구하게 한다 */
function badXrefPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 44 >>\nstream\nBT /F1 14 Tf 72 760 Td (Hello World) Tj ET\n\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xrefPos = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos + 7}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

describe("stdout 채널 — pdfjs 경고가 기계 출력에 섞이지 않는다", () => {
  it("parse: 어긋난 xref PDF 도 console.log 로 아무것도 찍지 않는다 (verbosity 0)", async () => {
    const logged: unknown[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { logged.push(a) }
    try {
      const r = await parse(badXrefPdf())
      assert.ok(r.success && r.markdown.includes("Hello World"))
    } finally {
      console.log = orig
    }
    assert.deepEqual(logged, [])
  })

  it("CLI --format json: stdout 전체가 JSON 하나", () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-stdout-"))
    try {
      const pdf = join(dir, "bad.pdf")
      writeFileSync(pdf, badXrefPdf())
      const r = spawnSync(process.execPath, ["--import", "tsx", CLI, pdf, "--format", "json", "--silent"], { encoding: "utf-8", timeout: 60000 })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(JSON.parse(r.stdout).success, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("routeConsoleToStderr: console.log·info·warn·debug 가 stderr 로", () => {
    const code = `import { routeConsoleToStderr } from ${JSON.stringify(UTILS)}; routeConsoleToStderr(); console.log("L"); console.info("I"); console.debug("D")`
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf-8", timeout: 60000 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, "")
    assert.equal(r.stderr, "L\nI\nD\n")
  })

  it("MCP parse_document: stdout 의 모든 줄이 JSON-RPC 메시지", { timeout: 90000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-mcp-stdout-"))
    const pdf = join(dir, "bad.pdf")
    writeFileSync(pdf, badXrefPdf())
    const srv = spawn(process.execPath, ["--import", "tsx", MCP], { stdio: ["pipe", "pipe", "pipe"] })
    try {
      const lines = await new Promise<string[]>((resolve, reject) => {
        const got: string[] = []
        let buf = ""
        const send = (o: unknown) => srv.stdin.write(JSON.stringify(o) + "\n")
        const timer = setTimeout(() => reject(new Error("MCP 응답 없음: " + JSON.stringify(got))), 80000)
        srv.stdout.on("data", (d: Buffer) => {
          buf += d.toString()
          for (let i; (i = buf.indexOf("\n")) >= 0;) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            got.push(line)
            let msg: { id?: number } | undefined
            try { msg = JSON.parse(line) } catch { continue }
            if (msg?.id === 1) {
              send({ jsonrpc: "2.0", method: "notifications/initialized" })
              send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "parse_document", arguments: { file_path: pdf } } })
            } else if (msg?.id === 2) {
              clearTimeout(timer)
              resolve(got)
            }
          }
        })
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } })
      })
      const nonJson = lines.filter(l => { try { JSON.parse(l); return false } catch { return true } })
      assert.deepEqual(nonJson, [])
      const resp = JSON.parse(lines[lines.length - 1])
      assert.ok(JSON.stringify(resp.result.content).includes("Hello World"))
    } finally {
      srv.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
