/** PARSE_EXTENSIONS — 파싱 계열 MCP 도구의 이미지 입력 허용.
 *  parse_document 설명은 이미지(PNG/JPG/WebP)를 광고하는데 기본 allowlist가
 *  이미지 확장자를 막아 MCP 경로에서만 거부되던 회귀 방지 (v4.4.1). */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALLOWED_EXTENSIONS, PARSE_EXTENSIONS, safePath } from "../src/mcp.js"

const dir = mkdtempSync(join(tmpdir(), "kordoc-parse-ext-"))
const png = join(dir, "scan.png")
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

describe("PARSE_EXTENSIONS — 파싱 입력 이미지 허용", () => {
  it("문서 확장자 전체를 승계하고 이미지 3종(png/jpg/jpeg/webp)을 더한다", () => {
    for (const ext of ALLOWED_EXTENSIONS) assert.ok(PARSE_EXTENSIONS.has(ext), ext)
    for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) assert.ok(PARSE_EXTENSIONS.has(ext), ext)
  })

  it("safePath: .png는 PARSE_EXTENSIONS로 통과, 쓰기용 기본 allowlist로는 종전대로 거부", () => {
    assert.equal(typeof safePath(png, PARSE_EXTENSIONS), "string")
    assert.throws(() => safePath(png), /지원하지 않는 확장자/)
  })
})
