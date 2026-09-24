/**
 * redact 배선 — CLI `kordoc redact` 와 MCP `redact_document` 가 문서 단위 마스킹(redactDocument)을 타고,
 * 결과 파일 바이트에 PII 가 남지 않으며(독립 오라클), 리포트 출력(stdout/stderr/MCP 응답)에 원본 PII 가
 * 없고, 재검사 잔존이 있으면 실패 신호(exit 2 / isError)를 내는지.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { registerFormTools } from "../src/mcp/tools-form.js"
import {
  HWPX_PII, HWP5_PII, HWP5_OLE_PII, HWP5_OLE_CHART_PII, buildPiiHwpx, buildPiiHwp5, buildHwp5, paragraph, hwpxLeaks, hwp5Leaks,
} from "./fixtures/redact-fixtures.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const runCli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf-8", timeout: 120000 })

const noRawPii = (out: string, values: Record<string, string>): void => {
  for (const v of Object.values(values)) assert.ok(!out.includes(v), `출력에 원본 PII ${v}`)
}

describe("CLI kordoc redact", () => {
  let dir: string
  before(() => { dir = mkdtempSync(join(tmpdir(), "kordoc-redact-")) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("HWPX: 결과 파일에 PII 0, JSON 리포트는 파일 안 위치·잔존 0, 출력에 원문 없음", async () => {
    const src = join(dir, "민원.hwpx")
    writeFileSync(src, await buildPiiHwpx())
    const out = join(dir, "민원.redacted.hwpx")
    const r = runCli(["redact", src, "-o", out, "--json"])
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(report.format, "hwpx")
    assert.equal(report.output, out)
    assert.deepEqual(report.residual, [])
    assert.ok(report.fileHits.some((h: { where: string }) => h.where === "footnote"))
    assert.deepEqual(await hwpxLeaks(readFileSync(out), HWPX_PII), [])
    noRawPii(r.stdout + r.stderr, HWPX_PII)
    assert.match(r.stderr, /footnote @ Contents\/section0\.xml/)
  })

  it("HWP5: 결과 파일의 모든 스트림에 PII 0", () => {
    const src = join(dir, "민원.hwp")
    writeFileSync(src, buildPiiHwp5())
    const r = runCli(["redact", src, "-d", join(dir, "out")])
    assert.equal(r.status, 0, r.stderr)
    const out = join(dir, "out", "민원.redacted.hwp")
    assert.ok(existsSync(out))
    assert.deepEqual(hwp5Leaks(readFileSync(out), HWP5_PII), [])
    noRawPii(r.stdout + r.stderr, HWP5_PII)
  })

  it("가릴 수 없는 곳(압축된 삽입 OLE 개체의 UTF-16·차트 XML)에 PII 가 남으면 exit 2 + 잔존 보고 (원문 미노출)", () => {
    const src = join(dir, "개체.hwp")
    writeFileSync(src, buildPiiHwp5({ withOlePii: true }))
    const r = runCli(["redact", src, "--json"])
    assert.equal(r.status, 2, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.deepEqual(report.residual.map((h: { masked: string; part: string }) => `${h.masked}@${h.part}`).sort(), [
      "010-●●●●-4444@BinData/BIN0002.OLE", "010-●●●●-7878@BinData/BIN0002.OLE",
    ])
    assert.match(r.stderr, /재검사에서 PII 2건이 남아/)
    for (const v of [HWP5_OLE_PII, HWP5_OLE_CHART_PII]) assert.ok(!(r.stdout + r.stderr).includes(v))
  })

  it("미할당 섹터에만 PII 가 있어도 결과 파일을 쓰고 slack 위치로 보고한다 (적대적 검토 HIGH-2)", () => {
    const src = join(dir, "옛사본.hwp")
    const stale = Buffer.alloc(512)
    Buffer.from("<신청인><010-2323-4545>", "utf16le").copy(stale)
    writeFileSync(src, Buffer.concat([Buffer.from(buildHwp5(paragraph(0, ["연락처는 지웠습니다"]))), stale]))
    const r = runCli(["redact", src, "--json"])
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.ok(report.output && existsSync(report.output), "출력 파일이 없다")
    assert.deepEqual(report.fileHits.map((h: { where: string; masked: string }) => `${h.where}:${h.masked}`), ["slack:010-●●●●-4545"])
    assert.ok(!readFileSync(report.output).includes(Buffer.from("010-2323-4545", "utf16le")))
    assert.ok(!(r.stdout + r.stderr).includes("010-2323-4545"))
  })

  it("파일 이름의 PII 는 결과 파일 이름·메시지·JSON 에서 가린다 (LOW-10)", async () => {
    const src = join(dir, "민원_홍길동_010-2345-6789.hwpx")
    writeFileSync(src, await buildPiiHwpx())
    const r = runCli(["redact", src, "--json"])
    assert.equal(r.status, 0, r.stderr)
    const out = join(dir, "민원_홍길동_010-●●●●-6789.redacted.hwpx")
    assert.ok(existsSync(out), r.stderr)
    assert.equal(JSON.parse(r.stdout).output, out)
    assert.ok(!(r.stdout + r.stderr).includes("010-2345-6789"), "출력에 파일 이름 속 번호가 그대로")
  })

  it("-o 가 입력 파일과 같으면 덮어쓰지 않고 exit 1 (LOW-14)", async () => {
    const src = join(dir, "같은경로.hwpx")
    const bytes = await buildPiiHwpx()
    writeFileSync(src, bytes)
    const r = runCli(["redact", src, "-o", src])
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /입력 파일과 같습니다/)
    assert.deepEqual(new Uint8Array(readFileSync(src)), bytes)
  })

  it("-d 로 이름이 같은 파일 여럿을 모으면 -2 를 붙여 덮어쓰지 않는다 (LOW-14)", async () => {
    for (const sub of ["a", "b"]) {
      mkdirSync(join(dir, sub), { recursive: true })
      writeFileSync(join(dir, sub, "신청서.hwpx"), await buildPiiHwpx())
    }
    const out = join(dir, "모음")
    const r = runCli(["redact", join(dir, "a", "신청서.hwpx"), join(dir, "b", "신청서.hwpx"), "-d", out])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(out, "신청서.redacted.hwpx")))
    assert.ok(existsSync(join(out, "신청서-2.redacted.hwpx")))
  })

  it("DOCX 는 마스킹된 마크다운만 — 원본 미수정을 명시", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>연락처 010-2345-6789</w:t></w:r></w:p></w:body></w:document>`)
    const src = join(dir, "메모.docx")
    writeFileSync(src, await zip.generateAsync({ type: "uint8array" }))
    const r = runCli(["redact", src])
    assert.equal(r.status, 0, r.stderr)
    const md = readFileSync(join(dir, "메모.redacted.md"), "utf-8")
    assert.ok(md.includes("010-●●●●-6789"))
    assert.match(r.stderr, /원본은 수정하지 않음/)
  })

  it("알 수 없는 룰은 exit 1, opt-in 룰(crn·ip·name·address)은 허용", () => {
    assert.equal(runCli(["redact", join(dir, "x.hwpx"), "--rules", "rrn,nope"]).status, 1)
    const r = runCli(["redact", join(dir, "없는파일.hwpx"), "--rules", "crn,ip", "--dry-run"])
    assert.doesNotMatch(r.stderr, /알 수 없는 룰/)
    const r2 = runCli(["redact", join(dir, "없는파일.hwpx"), "--rules", "name,address", "--dry-run"])
    assert.doesNotMatch(r2.stderr, /알 수 없는 룰/)
  })
})

describe("MCP redact_document", () => {
  let dir: string
  // 등록 핸들러만 뽑아 쓰는 가짜 서버 (zod 기본값은 여기서 채워지지 않으므로 인자를 다 준다)
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
  const schemas = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>()
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kordoc-redact-mcp-"))
    registerFormTools({ tool: (name: string, _d: string, s: never, handler: never) => { tools.set(name, handler); schemas.set(name, s) } } as never)
  })

  it("rules 입력 검증이 opt-in 인명·주소 룰을 받고 모르는 룰은 거부한다", async () => {
    const rules = schemas.get("redact_document")!.rules
    assert.equal(rules.safeParse(["name", "address", "crn"]).success, true)
    assert.equal(rules.safeParse(["nope"]).success, false)
    const src = join(dir, "명단.hwpx")
    const zip = await JSZip.loadAsync(await buildPiiHwpx())
    const sec = await zip.file("Contents/section0.xml")!.async("text")
    zip.file("Contents/section0.xml", sec.replace("</hs:sec>", `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>담당 주무관 이서준에게 문의</hp:t></hp:run></hp:p></hs:sec>`))
    writeFileSync(src, await zip.generateAsync({ type: "uint8array" }))
    const res = await tools.get("redact_document")!({ file_path: src, rules: ["name"], dry_run: true })
    assert.ok(!res.isError, res.content[0].text)
    assert.match(res.content[0].text, /\[name\] 이●●/)
    assert.ok(!res.content[0].text.includes("이서준"))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("HWPX 파일 저장 + 재검사 0건 보고, 응답에 원문 PII 없음", async () => {
    const src = join(dir, "민원.hwpx")
    writeFileSync(src, await buildPiiHwpx())
    const out = join(dir, "마스킹.hwpx")
    const res = await tools.get("redact_document")!({ file_path: src, output_path: out, dry_run: false })
    const text = res.content[0].text
    assert.ok(!res.isError, text)
    assert.match(text, /재검사: .*남은 PII 0건/)
    assert.match(text, /footer @ Contents\/section0\.xml/)
    noRawPii(text, HWPX_PII)
    assert.deepEqual(await hwpxLeaks(readFileSync(out), HWPX_PII), [])
  })

  it("dry_run 은 파일을 만들지 않는다", async () => {
    const src = join(dir, "민원.hwp")
    writeFileSync(src, buildPiiHwp5())
    const out = join(dir, "안생김.hwp")
    const res = await tools.get("redact_document")!({ file_path: src, output_path: out, dry_run: true })
    assert.ok(!res.isError, res.content[0].text)
    assert.ok(!existsSync(out))
    assert.match(res.content[0].text, /header @ BodyText\/Section0/)
  })

  it("잔존 PII 가 있으면 isError 로 알린다", async () => {
    const src = join(dir, "개체.hwp")
    writeFileSync(src, buildPiiHwp5({ withOlePii: true }))
    const res = await tools.get("redact_document")!({ file_path: src, output_path: join(dir, "개체.redacted.hwp"), dry_run: false })
    assert.ok(res.isError)
    assert.match(res.content[0].text, /재검사에서 PII 2건이 남아/)
    for (const v of [HWP5_OLE_PII, HWP5_OLE_CHART_PII]) assert.ok(!res.content[0].text.includes(v))
  })

  it("미할당 섹터에만 PII 가 있어도 파일을 저장한다 (HIGH-2)", async () => {
    const src = join(dir, "옛사본.hwp")
    const stale = Buffer.alloc(512)
    Buffer.from("<신청인><010-2323-4545>", "utf16le").copy(stale)
    writeFileSync(src, Buffer.concat([Buffer.from(buildHwp5(paragraph(0, ["연락처는 지웠습니다"]))), stale]))
    const out = join(dir, "옛사본.redacted.hwp")
    const res = await tools.get("redact_document")!({ file_path: src, output_path: out, dry_run: false })
    assert.ok(!res.isError, res.content[0].text)
    assert.ok(existsSync(out))
    assert.match(res.content[0].text, /slack @ \(미할당 섹터\)/)
    assert.ok(!readFileSync(out).includes(Buffer.from("010-2323-4545", "utf16le")))
  })

  it("output_path 가 입력 파일과 같으면 거부하고 원본을 그대로 둔다 (LOW-14)", async () => {
    const src = join(dir, "제자리.hwpx")
    const bytes = await buildPiiHwpx()
    writeFileSync(src, bytes)
    const res = await tools.get("redact_document")!({ file_path: src, output_path: src, dry_run: false })
    assert.ok(res.isError)
    assert.match(res.content[0].text, /입력 파일과 같습니다/)
    assert.deepEqual(new Uint8Array(readFileSync(src)), bytes)
  })

  it("수천 행 명단도 응답 줄 수를 자른다 (응답 폭주 방지)", async () => {
    const rows = ["| 번호 | 연락처 |", "| --- | --- |"]
    for (let i = 0; i < 120; i++) rows.push(`| ${i + 1} | 010-${String(2000 + i)}-${String(3000 + i)} |`)
    const { markdownToHwpx } = await import("../src/index.js")
    const src = join(dir, "명단.hwpx")
    writeFileSync(src, new Uint8Array(await markdownToHwpx(rows.join("\n"))))
    const res = await tools.get("redact_document")!({ file_path: src, output_path: join(dir, "명단.redacted.hwpx"), dry_run: false })
    const text = res.content[0].text
    assert.ok(!res.isError, text)
    assert.match(text, /… 외 \d+줄/)
    assert.ok(text.split("\n").length < 90, `응답 ${text.split("\n").length}줄`)
  })

  it("출력 확장자가 원본 형식과 다르면 거부", async () => {
    const src = join(dir, "민원2.hwpx")
    writeFileSync(src, await buildPiiHwpx())
    const res = await tools.get("redact_document")!({ file_path: src, output_path: join(dir, "x.md"), dry_run: false })
    assert.ok(res.isError)
  })
})
