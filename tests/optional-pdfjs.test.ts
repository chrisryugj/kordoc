/**
 * pdfjs-dist 선택적 의존성 테스트 — 미설치 환경에서의 동작 검증
 *
 * pdfjs-dist가 없는 환경에서도 HWP/HWPX 파싱이 정상 동작하는지,
 * PDF 파싱 시 친절한 에러 메시지가 반환되는지 검증.
 * 빌드 결과물(dist/) 기준으로 별도 Node 프로세스를 실행하여 테스트.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execSync, execFileSync } from "child_process"
import { existsSync, renameSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const PDFJS_PATH = resolve(ROOT, "node_modules/pdfjs-dist")
const PDFJS_HIDDEN = resolve(ROOT, "node_modules/_pdfjs-dist-hidden")

// ─── pdfjs-dist 미설치 환경 시뮬레이션 ──────────────────

describe("pdfjs-dist 선택적 의존성 — 미설치 환경", () => {
  before(() => {
    execSync("npm run build", { cwd: ROOT, stdio: "ignore" })
    if (existsSync(PDFJS_PATH)) {
      renameSync(PDFJS_PATH, PDFJS_HIDDEN)
    }
  })

  after(() => {
    if (existsSync(PDFJS_HIDDEN)) {
      renameSync(PDFJS_HIDDEN, PDFJS_PATH)
    }
  })

  // ─── 라이브러리 API ─────────────────────────────────────

  it("ESM import → pdfjs-dist 없이 성공", () => {
    const result = execFileSync("node", [
      "--input-type=module",
      "-e",
      `import('./dist/index.js').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1) })`,
    ], { cwd: ROOT, encoding: "utf-8" })
    assert.equal(result.trim(), "OK")
  })

  it("HWPX 파싱 → pdfjs-dist 없이 정상 동작", () => {
    const result = execFileSync("node", [
      "--input-type=module",
      "-e",
      `
      import { parse } from './dist/index.js';
      import { readFileSync } from 'fs';
      const buf = readFileSync('tests/fixtures/dummy.hwpx');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const r = await parse(ab);
      console.log(JSON.stringify({ success: r.success, fileType: r.fileType }));
      `,
    ], { cwd: ROOT, encoding: "utf-8" })
    const parsed = JSON.parse(result.trim())
    assert.equal(parsed.success, true)
    assert.equal(parsed.fileType, "hwpx")
  })

  it("PDF 파싱 → MISSING_DEPENDENCY 에러 반환", () => {
    const result = execFileSync("node", [
      "--input-type=module",
      "-e",
      `
      import { parsePdf } from './dist/index.js';
      const buf = new ArrayBuffer(10);
      new Uint8Array(buf).set([0x25, 0x50, 0x44, 0x46]); // %PDF
      const r = await parsePdf(buf);
      console.log(JSON.stringify({ success: r.success, code: r.code }));
      `,
    ], { cwd: ROOT, encoding: "utf-8" })
    const parsed = JSON.parse(result.trim())
    assert.equal(parsed.success, false)
    assert.equal(parsed.code, "MISSING_DEPENDENCY")
  })

  // ─── CLI ────────────────────────────────────────────────

  it("CLI HWPX 파싱 → pdfjs-dist 없이 정상 동작", () => {
    const result = execFileSync("node", [
      "dist/cli.js",
      "tests/fixtures/dummy.hwpx",
      "--silent",
    ], { cwd: ROOT, encoding: "utf-8" })
    assert.ok(result.includes("서면자문 의견서"))
  })

  it("CLI PDF 파싱 → crash 없이 graceful 실패", () => {
    const tmpPdf = resolve(ROOT, "tests/fixtures/_tmp_test.pdf")
    execSync(`printf '%%PDF-1.4 dummy' > "${tmpPdf}"`, { cwd: ROOT })

    try {
      execFileSync("node", [
        "dist/cli.js",
        tmpPdf,
        "--silent",
      ], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? ""
      const stdout = err.stdout?.toString() ?? ""
      assert.ok(
        stderr.includes("FAIL") || stderr.includes("pdfjs-dist") || stdout.includes("pdfjs-dist"),
        `에러 메시지에 pdfjs-dist 안내가 포함되어야 함. stderr: ${stderr}, stdout: ${stdout}`,
      )
      assert.ok(!stderr.includes("throw"), "Node.js crash가 발생하면 안 됨")
    } finally {
      execSync(`rm -f "${tmpPdf}"`)
    }
  })
})
