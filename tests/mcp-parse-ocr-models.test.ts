/** parse_document 의 OCR 모델 인수 ocr_rec·ocr_det·ocr_det_long_side (#165) — 프리셋 이름만 받아 parse() 옵션으로 넘긴다 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { registerParseTools } from "../src/mcp/tools-parse.js"
import { scanFixtures } from "./fixtures/sdk-docs.js"

/** parse_document 를 가짜 서버로 잡는다 — 인수 스키마와 콜백 */
function parseDocument() {
  let shape: Record<string, z.ZodTypeAny> = {}
  let callback: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }> = async () => ({ content: [] })
  registerParseTools({ tool(name: string, ...args: any[]) { if (name === "parse_document") { shape = args[1]; callback = args.at(-1) } } } as any)
  return { schema: z.object(shape), call: async (args: Record<string, unknown>) => { const r = await callback(args); return { isError: r.isError, text: r.content.map(c => c.text).join("\n") } } }
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

describe("parse_document OCR 모델 인수 (#165)", () => {
  it("프리셋 이름만 받는다 — 로컬 모델 경로·모르는 이름·범위 밖 해상도는 거부", () => {
    const { schema } = parseDocument()
    assert.ok(schema.safeParse({ file_path: "/a.png", ocr_rec: "handwriting", ocr_det: "server", ocr_det_long_side: 2048 }).success)
    assert.ok(schema.safeParse({ file_path: "/a.png", ocr_rec: "auto" }).success)
    assert.ok(schema.safeParse({ file_path: "/a.png", ocr_det: "medium" }).success)
    assert.ok(schema.safeParse({ file_path: "/a.png", ocr_det: "mobile", ocr_det_long_side: 32 }).success)
    for (const bad of [{ ocr_rec: "/m/rec.onnx" }, { ocr_rec: "Handwriting" }, { ocr_det: "large" }, { ocr_det_long_side: 16 }, { ocr_det_long_side: 5000 }, { ocr_det_long_side: 960.5 }])
      assert.equal(schema.safeParse({ file_path: "/a.png", ...bad }).success, false, JSON.stringify(bad))
  })

  it("고른 검출 모델을 parse() 로 넘긴다 — 폐쇄망 빈 캐시면 server det 를 받지 않고 실패로 알린다 (모델 불필요)", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const dir = mkdtempSync(join(tmpdir(), "kordoc-mcp-ocr-"))
    try {
      const png = join(dir, "scan.png")
      writeFileSync(png, f.png)
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: join(dir, "cache") }, async () => {
        const r = await parseDocument().call({ file_path: png, ocr_det: "server" })
        assert.equal(r.isError, true)
        assert.match(r.text, /폐쇄망 모드\(KORDOC_OFFLINE\)에서 차단됨: PP-OCRv5 server det/)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
