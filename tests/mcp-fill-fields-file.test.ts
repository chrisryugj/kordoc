import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerFormTools } from "../src/mcp/tools-form.js"
import { markdownToHwpx, parse } from "../src/index.js"

const SECRET = "900315-1234567"

/** fill_form 콜백을 가짜 서버로 잡아 임시 KORDOC_ROOT 안에서 돌린다 */
async function fixture(run: (root: string, fill: (args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "kordoc-fields-file-"))
  const previousRoot = process.env.KORDOC_ROOT
  try {
    process.env.KORDOC_ROOT = root
    let callback: any
    registerFormTools({ tool(name: string, ...args: any[]) { if (name === "fill_form") callback = args.at(-1) } } as any)
    await writeFile(join(root, "form.hwpx"), Buffer.from(await markdownToHwpx("| 성명 |  |\n|---|---|\n| 주민등록번호 |  |\n")))
    await run(root, async args => {
      const result = await callback({ output_format: "hwpx-preserve", ...args })
      return { isError: result.isError, text: result.content.map((c: { text: string }) => c.text).join("\n") }
    })
  } finally {
    if (previousRoot === undefined) delete process.env.KORDOC_ROOT
    else process.env.KORDOC_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
}

test("fill_form fields_file: 파일의 값으로 채우고 응답에는 값 대신 글자 수만 낸다", async () => {
  await fixture(async (root, fill) => {
    await writeFile(join(root, "values.json"), "﻿" + JSON.stringify({ 성명: "홍길동", 주민등록번호: SECRET }))
    const out = join(root, "out.hwpx")
    const r = await fill({ file_path: join(root, "form.hwpx"), fields_file: join(root, "values.json"), output_path: out })
    assert.ok(!r.isError, r.text)
    assert.doesNotMatch(r.text, /홍길동|900315/)
    assert.match(r.text, /\[14자\]/)
    const reparsed = await parse(out)
    assert.ok(reparsed.success)
    if (reparsed.success) assert.match(reparsed.markdown, new RegExp(SECRET))
  })
})

test("fill_form fields_file: mask_values: false 면 값을 보여 준다", async () => {
  await fixture(async (root, fill) => {
    await writeFile(join(root, "values.json"), JSON.stringify({ 성명: "홍길동" }))
    const r = await fill({ file_path: join(root, "form.hwpx"), fields_file: join(root, "values.json"), mask_values: false })
    assert.ok(!r.isError, r.text)
    assert.match(r.text, /홍길동/)
  })
})

test("fill_form: fields 와 fields_file 은 하나만 — 둘 다·둘 다 없음은 거부", async () => {
  await fixture(async (root, fill) => {
    await writeFile(join(root, "values.json"), JSON.stringify({ 성명: "홍길동" }))
    const both = await fill({ file_path: join(root, "form.hwpx"), fields: { 성명: "김철수" }, fields_file: join(root, "values.json") })
    assert.ok(both.isError)
    assert.match(both.text, /fields_file/)
    const none = await fill({ file_path: join(root, "form.hwpx") })
    assert.ok(none.isError)
  })
})

test("fill_form fields_file: 잘못된 파일은 거부하고 오류 문구에 값을 싣지 않는다", async () => {
  await fixture(async (root, fill) => {
    const form = join(root, "form.hwpx")
    await writeFile(join(root, "broken.json"), `{"주민등록번호": "${SECRET}",`)
    const broken = await fill({ file_path: form, fields_file: join(root, "broken.json") })
    assert.ok(broken.isError)
    assert.doesNotMatch(broken.text, /900315/)
    await writeFile(join(root, "nested.json"), JSON.stringify({ 주민등록번호: { value: SECRET } }))
    const nested = await fill({ file_path: form, fields_file: join(root, "nested.json") })
    assert.ok(nested.isError)
    assert.doesNotMatch(nested.text, /900315/)
    await writeFile(join(root, "values.txt"), JSON.stringify({ 성명: "홍길동" }))
    const ext = await fill({ file_path: form, fields_file: join(root, "values.txt") })
    assert.ok(ext.isError)
    assert.match(ext.text, /확장자/)
  })
})

test("fill_form fields_file: 반복 양식용 배열 값도 받는다", async () => {
  await fixture(async (root, fill) => {
    await writeFile(join(root, "rep.hwpx"), Buffer.from(await markdownToHwpx("| 성명 |  |\n|---|---|\n\n중간 본문\n\n| 성명 |  |\n|---|---|\n")))
    await writeFile(join(root, "values.json"), JSON.stringify({ 성명: ["홍길동", "김철수"] }))
    const out = join(root, "out.hwpx")
    const r = await fill({ file_path: join(root, "rep.hwpx"), fields_file: join(root, "values.json"), output_path: out })
    assert.ok(!r.isError, r.text)
    const reparsed = await parse(out)
    assert.ok(reparsed.success)
    if (reparsed.success) {
      assert.match(reparsed.markdown, /홍길동/)
      assert.match(reparsed.markdown, /김철수/)
    }
  })
})
