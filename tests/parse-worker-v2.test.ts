/** parse-worker --protocol 2 — SDK(Java·Python)용 워커 계약. protocol 1 은 바이트 단위로 그대로 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../src/index.js"
import { VERSION } from "../src/utils.js"
import { toParseOptions, externalizeImages, WorkerProtocolError } from "../src/cli/parse-worker-v2.js"
import type { IRBlock, ParseResult } from "../src/types.js"
import { IMAGE_BYTES, imageDocx, gfmTablesHwpx, badXrefPdf } from "./fixtures/sdk-docs.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const FIXTURES = fileURLToPath(new URL("../sdk/fixtures/protocol-v2.json", import.meta.url))
const toWire = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))

interface Run { out: string[]; err: string; code: number | null }

/** 워커를 띄워 입력(문자열 또는 바이트 조각)을 보내고 stdin 을 닫은 뒤 출력 줄·종료 코드를 모은다 */
function runWorker(input: (string | Buffer)[], args: string[] = ["--protocol", "2"], timeoutMs = 60000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "parse-worker", ...args], { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let err = ""
    child.stdout.on("data", (d: Buffer) => chunks.push(d))
    child.stderr.on("data", (d) => { err += String(d) })
    const done = (code: number | null) => resolve({ out: Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean), err, code })
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(null) }, timeoutMs)
    child.on("exit", (code) => { clearTimeout(timer); done(code) })
    void (async () => {
      for (const part of input) {
        child.stdin.write(part)
        await new Promise((r) => setTimeout(r, 20)) // 조각마다 따로 read 되게
      }
      child.stdin.end()
    })()
  })
}

const line = (o: unknown) => JSON.stringify(o) + "\n"

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-pw2-"))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe("parse-worker protocol 1 — 바이트 단위 불변", () => {
  test("ready·오류 줄이 종전 그대로", async () => {
    const { out, code } = await runWorker(["not json\n", line({ id: 3 }), line({ cmd: "quit" })], [])
    assert.equal(code, 0)
    assert.deepEqual(out, [
      JSON.stringify({ ready: true, version: VERSION, protocol: 1 }),
      JSON.stringify({ error: "잘못된 JSON 라인" }),
      JSON.stringify({ id: 3, error: "file 필수" }),
    ])
  })

  test("--protocol 1 명시도 같은 경로", async () => {
    const { out } = await runWorker([line({ cmd: "quit" })], ["--protocol", "1"])
    assert.deepEqual(out, [JSON.stringify({ ready: true, version: VERSION, protocol: 1 })])
  })

  test("지원하지 않는 protocol 은 ready 없이 명시적으로 실패", async () => {
    const { out, err, code } = await runWorker([], ["--protocol", "3"])
    assert.notEqual(code, 0)
    assert.deepEqual(out, [])
    assert.match(err, /protocol/)
  })
})

describe("parse-worker protocol 2 — 요청·응답", () => {
  test("ready 에 version·protocol 2·capabilities", async () => {
    const { out, code } = await runWorker([line({ cmd: "quit" })])
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(out[0]), {
      ready: true, version: VERSION, protocol: 2,
      capabilities: ["parse", "options", "transport.images.inline", "transport.images.files"],
    })
  })

  test("options 를 넘긴 결과가 Node parse() 와 같다 (gfm·기본)", () => withDir(async (dir) => {
    const file = join(dir, "중첩 표.hwpx")
    writeFileSync(file, await gfmTablesHwpx())
    const { out } = await runWorker([
      line({ id: 1, cmd: "parse", file, options: { tableFormat: "gfm" } }),
      line({ id: 2, cmd: "parse", file }),
    ])
    const r1 = JSON.parse(out[1]), r2 = JSON.parse(out[2])
    assert.equal(r1.id, 1)
    assert.ok(typeof r1.rss === "number" && r1.rss > 0)
    assert.deepEqual(r1.result, toWire(await parse(file, { tableFormat: "gfm" })))
    assert.deepEqual(r2.result, toWire(await parse(file)))
    assert.match(r1.result.markdown, /<!-- <table id="t4" parent_id="t3" \/> -->/)
  }))

  test("파싱 실패는 result.success:false — 프로토콜 오류와 구분", () => withDir(async (dir) => {
    const { out } = await runWorker([line({ id: 1, cmd: "parse", file: join(dir, "없음.hwp") })])
    const r = JSON.parse(out[1])
    assert.equal(r.result.success, false)
    assert.ok(r.result.code)
    assert.equal(r.error, undefined)
  }))

  test("공유 fixture 의 잘못된 요청마다 정해진 오류 code (워커는 계속 응답)", async () => {
    const cases: { name: string; request: unknown; error: string; id?: number }[] = JSON.parse(readFileSync(FIXTURES, "utf8")).invalid
    const { out, code } = await runWorker([...cases.map((c) => typeof c.request === "string" ? c.request + "\n" : line(c.request)), line({ cmd: "quit" })])
    assert.equal(code, 0)
    const msgs = out.slice(1).map((l) => JSON.parse(l))
    assert.equal(msgs.length, cases.length)
    cases.forEach((c, i) => {
      assert.equal(msgs[i].error?.code, c.error, c.name)
      assert.equal(typeof msgs[i].error.message, "string", c.name)
      assert.equal(msgs[i].id, c.id, `${c.name}: id`)
      assert.equal(msgs[i].result, undefined, c.name)
    })
  })

  test("같은 id 를 다시 쓰면 DUPLICATE_ID", () => withDir(async (dir) => {
    const file = join(dir, "a.docx")
    writeFileSync(file, await imageDocx())
    const { out } = await runWorker([line({ id: 5, cmd: "parse", file }), line({ id: 5, cmd: "parse", file })])
    assert.equal(JSON.parse(out[1]).result.success, true)
    assert.deepEqual(JSON.parse(out[2]).error.code, "DUPLICATE_ID")
  }))

  test("한국어·공백 경로, 멀티바이트 글자가 read 경계에서 잘려도 그대로", () => withDir(async (dir) => {
    const file = join(dir, "가나 다 문서.docx")
    writeFileSync(file, await imageDocx("한글 본문"))
    const bytes = Buffer.from(line({ id: 1, cmd: "parse", file }))
    const cut = bytes.indexOf(Buffer.from("가")) + 1 // '가'(3바이트) 한가운데
    const { out } = await runWorker([bytes.subarray(0, cut), bytes.subarray(cut)])
    const r = JSON.parse(out[1])
    assert.equal(r.result.success, true)
    assert.match(r.result.markdown, /한글 본문/)
  }))

  test("요청 줄 상한을 넘으면 REQUEST_TOO_LARGE, 다음 요청은 처리", () => withDir(async (dir) => {
    const file = join(dir, "a.docx")
    writeFileSync(file, await imageDocx())
    const { out } = await runWorker([
      line({ id: 1, cmd: "parse", file, pad: "x".repeat(5000) }),
      line({ id: 2, cmd: "parse", file }),
    ], ["--protocol", "2", "--max-request-bytes", "1024"])
    assert.equal(JSON.parse(out[1]).error.code, "REQUEST_TOO_LARGE")
    assert.equal(JSON.parse(out[2]).id, 2)
    assert.equal(JSON.parse(out[2]).result.success, true)
  }))

  test("응답 상한을 넘으면 잘린 성공이 아니라 RESPONSE_TOO_LARGE", () => withDir(async (dir) => {
    const file = join(dir, "big.docx")
    writeFileSync(file, await imageDocx("가나다라마바사 ".repeat(20_000)))
    const { out } = await runWorker([line({ id: 1, cmd: "parse", file }), line({ id: 2, cmd: "parse", file, options: { images: false } })],
      ["--protocol", "2", "--max-response-bytes", "65536"])
    const r = JSON.parse(out[1])
    assert.equal(r.id, 1)
    assert.equal(r.error.code, "RESPONSE_TOO_LARGE")
    assert.equal(r.result, undefined)
    assert.equal(JSON.parse(out[2]).id, 2) // 워커는 살아 있다
  }))

  test("stdin 이 닫혀도 마지막 큰 응답을 끝까지 쓰고 종료", () => withDir(async (dir) => {
    const file = join(dir, "big.docx")
    writeFileSync(file, await imageDocx("가나다라마바사 ".repeat(300_000)))
    const { out, code } = await runWorker([line({ id: 7, cmd: "parse", file, options: { images: false } })])
    assert.equal(code, 0)
    const last = JSON.parse(out[out.length - 1])
    assert.equal(last.id, 7)
    assert.ok(last.result.markdown.length > 2_000_000)
  }))

  test("stdout 은 NDJSON 만 — pdfjs 경고는 stderr 로", () => withDir(async (dir) => {
    const file = join(dir, "bad.pdf")
    writeFileSync(file, badXrefPdf())
    const { out } = await runWorker([line({ id: 1, cmd: "parse", file })])
    for (const l of out) JSON.parse(l)
    assert.equal(JSON.parse(out[1]).result.success, true)
  }))
})

describe("parse-worker protocol 2 — 이미지 전송", () => {
  test("inline(기본)은 protocol 1·--format json 과 같은 base64", () => withDir(async (dir) => {
    const file = join(dir, "a.docx")
    writeFileSync(file, await imageDocx())
    const { out } = await runWorker([line({ id: 1, cmd: "parse", file, transport: { images: "inline" } })])
    assert.equal(JSON.parse(out[1]).result.images[0].data, Buffer.from(IMAGE_BYTES).toString("base64"))
  }))

  test("files 는 요청별 디렉터리에 바이트를 쓰고 dataRef 로 가리킨다 — 동명 문서도 덮어쓰지 않는다", () => withDir(async (dir) => {
    const assets = join(dir, "assets")
    mkdirSync(assets)
    const a = join(dir, "doc.docx"), b = join(dir, "sub", "doc.docx")
    mkdirSync(join(dir, "sub"))
    writeFileSync(a, await imageDocx())
    writeFileSync(b, await imageDocx())
    const { out } = await runWorker([
      line({ id: 1, cmd: "parse", file: a, transport: { images: "files", assetsDir: assets } }),
      line({ id: 2, cmd: "parse", file: b, transport: { images: "files", assetsDir: assets } }),
    ])
    const r1 = JSON.parse(out[1]), r2 = JSON.parse(out[2])
    for (const r of [r1, r2]) {
      assert.ok(isAbsolute(r.assetsDir) && r.assetsDir.startsWith(realpathSync(assets)))
      const img = r.result.images[0]
      assert.equal(img.data, undefined)
      assert.equal(img.filename, "image_001.png") // Markdown 의 이름은 그대로
      assert.deepEqual(readFileSync(join(r.assetsDir, img.dataRef.path)), Buffer.from(IMAGE_BYTES))
      assert.equal(img.dataRef.byteLength, IMAGE_BYTES.length)
    }
    assert.notEqual(r1.assetsDir, r2.assetsDir)
    assert.equal(readdirSync(assets).length, 2)
  }))

  test("files 인데 assetsDir 가 없거나 상대경로면 INVALID_REQUEST", () => withDir(async (dir) => {
    const file = join(dir, "a.docx")
    writeFileSync(file, await imageDocx())
    const { out } = await runWorker([
      line({ id: 1, cmd: "parse", file, transport: { images: "files" } }),
      line({ id: 2, cmd: "parse", file, transport: { images: "files", assetsDir: "rel/dir" } }),
      line({ id: 3, cmd: "parse", file, transport: { images: "files", assetsDir: join(dir, "없는 폴더") } }),
    ])
    assert.deepEqual(out.slice(1).map((l) => JSON.parse(l).error?.code), ["INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST"])
  }))

  test("externalizeImages — children·셀 blocks·captionBlocks·filename 없는 이미지까지, 같은 바이트는 한 파일", () => withDir(async (root) => {
    const img = (n: number, filename?: string) => ({ data: Uint8Array.from([n, n, n]), mimeType: "image/png", ...(filename ? { filename } : {}) })
    const shared = Uint8Array.from([9, 9, 9])
    const cellBlock: IRBlock = { type: "image", text: "c.png", imageData: img(3, "c.png") }
    const blocks: IRBlock[] = [
      { type: "image", text: "image_001.png", imageData: { data: shared, mimeType: "image/png", filename: "image_001.png" } },
      { type: "list", text: "목록", children: [{ type: "image", imageData: img(2) }] },
      { type: "table", table: { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "", colSpan: 1, rowSpan: 1, blocks: [cellBlock] }]],
        captionBlocks: [{ type: "image", imageData: img(4, "../evil.png") }] } },
    ]
    const result: ParseResult = { success: true, fileType: "docx", markdown: "", blocks,
      images: [{ filename: "image_001.png", data: shared, mimeType: "image/png" }, { filename: "image_001.png", data: Uint8Array.from([7]), mimeType: "image/png" }] }
    const dir = await externalizeImages(result, root, 1)
    assert.ok(dir && dir.startsWith(realpathSync(root)))
    const refs: { path: string; byteLength: number }[] = []
    const walk = (bs?: IRBlock[]) => { for (const b of bs ?? []) {
      if (b.imageData) { assert.equal((b.imageData as { data?: unknown }).data, undefined); refs.push((b.imageData as unknown as { dataRef: { path: string; byteLength: number } }).dataRef) }
      walk(b.children); walk(b.table?.captionBlocks); for (const row of b.table?.cells ?? []) for (const cell of row) walk(cell.blocks)
    } }
    walk(result.blocks)
    assert.equal(refs.length, 4)
    const top = (result as { images: { dataRef: { path: string } }[] }).images.map((i) => i.dataRef.path)
    assert.equal(top[0], refs[0].path, "같은 바이트는 같은 파일")
    assert.notEqual(top[1], top[0], "이름이 같아도 바이트가 다르면 다른 파일")
    for (const r of refs) {
      assert.ok(!r.path.includes("..") && !r.path.includes("/") && !r.path.includes("\\"), r.path)
    }
    assert.equal(new Set(readdirSync(dir!)).size, 5)
  }))

  test("externalizeImages — assetsDir 가 링크여도 그 밖으로 쓰지 않고, 실패하면 만든 디렉터리를 지운다", () => withDir(async (root) => {
    const real = join(root, "real")
    mkdirSync(real)
    symlinkSync(real, join(root, "link"))
    const ok: ParseResult = { success: true, fileType: "docx", markdown: "", blocks: [], images: [{ filename: "a.png", data: Uint8Array.from([1]), mimeType: "image/png" }] }
    const dir = await externalizeImages(ok, join(root, "link"), 1)
    assert.ok(dir!.startsWith(realpathSync(real)))
    const bad: ParseResult = { success: true, fileType: "docx", markdown: "", blocks: [], images: [{ filename: "a.png", data: "not bytes" as unknown as Uint8Array, mimeType: "image/png" }] }
    await assert.rejects(() => externalizeImages(bad, real, 2), WorkerProtocolError)
    assert.deepEqual(readdirSync(real).filter((n) => n.includes("-2-")), [])
  }))
})

describe("toParseOptions — 허용 목록과 false·미지정 구분", () => {
  test("ocr false 는 false 로, 미지정은 키 없음, filePath 는 워커가 정한다", () => {
    assert.deepEqual(toParseOptions({ ocr: false }, "/a/b.pdf"), { filePath: "/a/b.pdf", ocr: false })
    assert.deepEqual(toParseOptions({}, "/a/b.pdf"), { filePath: "/a/b.pdf" })
    assert.deepEqual(toParseOptions({ ocr: "force", pages: [1, 3], tableFormat: "gfm", layoutTables: "keep" }, "/x"),
      { filePath: "/x", ocr: "force", pages: [1, 3], tableFormat: "gfm", layoutTables: "keep" })
  })

  test("모든 허용 옵션이 지나간다", () => {
    const all = {
      tableFormat: "gfm", layoutTables: "visual", classifyTables: true, tables: false,
      plain: true, scriptTags: false, removeHeaderFooter: false, dedupeRunningHeaders: true,
      keepTrailingEmptyCols: true, keepEmptyParagraphs: true, includeFieldPlaceholders: true,
      pages: "1-3", images: false, inlineImages: true, ocr: true, formulaOcr: false, password: "pw",
    }
    assert.deepEqual(toParseOptions(all, "/x"), { filePath: "/x", ...all })
    assert.deepEqual(toParseOptions({ htmlTables: true }, "/x"), { filePath: "/x", htmlTables: true })
  })

  test("모르는 옵션·함수형·파일 경로·잘못된 타입·htmlTables+tableFormat 은 거부", () => {
    for (const bad of [{ filePath: "/etc/passwd" }, { onProgress: 1 }, { nope: true }, { ocr: "auto" }, { pages: [0] },
      { tableFormat: "html" }, { htmlTables: true, tableFormat: "gfm" }, { images: "no" }]) {
      assert.throws(() => toParseOptions(bad, "/x"), (e: unknown) => e instanceof WorkerProtocolError && e.code === "INVALID_OPTIONS", JSON.stringify(bad))
    }
  })
})
