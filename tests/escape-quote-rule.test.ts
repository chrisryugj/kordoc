/**
 * #212: 일반 문단 줄 첫머리 ">"·하이픈 3개 이상만 든 줄("---")·윗줄 아래 setext 밑줄("==="·"--")을 문단 자리에서 이스케이프한다(escapeBlockStart).
 * 그대로 두면 마크다운 렌더·markdownToHwpx 왕복에서 글이 인용문·가로줄·제목이 되어 글자가 사라졌다.
 * 홀로 선 "===" 문단과 표 칸(블록 문법이 없음)에는 걸지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, parse, parseHwpx, patchHwpx, renderHtml } from "../src/index.js"
import { escapeGfm, escapeBlockStart } from "../src/table/builder.js"
import { unescapeGfm, unescapeGfmCell } from "../src/roundtrip/markdown-units.js"

const body = (html: string) => html.match(/<body>([\s\S]*)<\/body>/)![1].trim()

describe("#212 줄 첫 > · --- · === 이스케이프", () => {
  it("escapeBlockStart: 줄 첫 > 와 하이픈·= 만 든 줄은 이스케이프, 줄 가운데·글이 섞인 줄은 그대로", () => {
    const esc = (t: string) => escapeBlockStart(escapeGfm(t))
    assert.equal(esc("> 50% 이상"), "\\> 50% 이상")
    assert.equal(esc(">50%"), "\\>50%")
    assert.equal(esc("---"), "\\---")
    assert.equal(esc("  - - -  "), "  \\- - -  ")
    assert.equal(esc("제목\n==="), "제목\n\\===")
    assert.equal(esc("제목\n--"), "제목\n\\--")
    assert.equal(esc("가 > 나"), "가 > 나")
    assert.equal(esc("--- 구분 ---"), "--- 구분 ---")
    assert.equal(esc("1 = 1"), "1 = 1")
    assert.equal(esc("==="), "===", "홀로 선 === 는 마크다운에서도 글자")
    assert.equal(esc("--"), "--", "하이픈 둘은 윗줄이 없으면 가로줄이 아님")
    assert.equal(escapeGfm("---"), "---", "escapeGfm(표 칸에도 쓰임)은 그대로")
  })

  it("unescapeGfm·unescapeGfmCell 이 되돌린다", () => {
    for (const t of ["> 50% 이상", "---", "  - - -", "제목\n===", "제목\n--", "a\\>b", "a\\-b"]) {
      assert.equal(unescapeGfm(escapeBlockStart(escapeGfm(t))), t, t)
      assert.equal(unescapeGfmCell(escapeBlockStart(escapeGfm(t))), t, t)
    }
  })

  it("이슈 재현: 마크다운·렌더·HWPX 왕복에서 글이 그대로", async () => {
    const r = await parse(await markdownToHwpx("\\> 50% 이상\n\n\\---\n\n\\===\n\n\\# 참고"))
    assert.ok(r.success)
    assert.deepEqual(r.blocks.map(b => [b.type, b.text]), [["paragraph", "> 50% 이상"], ["paragraph", "---"], ["paragraph", "==="], ["paragraph", "# 참고"]])
    assert.equal(r.markdown, "\\> 50% 이상\n\n\\---\n\n===\n\n\\# 참고")
    assert.equal(body(renderHtml(r.markdown)), "<p>&gt; 50% 이상</p>\n<p>---</p>\n<p>===</p>\n<p># 참고</p>")
    const again = await parse(await markdownToHwpx(r.markdown))
    assert.ok(again.success)
    assert.deepEqual(again.blocks.map(b => [b.type, b.text, b.quote]), r.blocks.map(b => [b.type, b.text, b.quote]))
  })

  it("표 칸 글 \"=\"·\"---\" 는 이스케이프하지 않는다", async () => {
    const r = await parse(await markdownToHwpx("| 항목 | 값 |\n| --- | --- |\n| 합계 | = |\n| 줄 | \\--- |"))
    assert.ok(r.success)
    assert.match(r.markdown, /\| 합계 \| = \|/)
    assert.match(r.markdown, /\| 줄 \| --- \|/)
  })

  it("patchHwpx: --- 문단을 구분선으로 보지 않고 고친다", async () => {
    const original = await markdownToHwpx("앞 문단\n\n\\---\n\n\\> 50% 이상")
    const parsed = await parseHwpx(original)
    assert.ok(parsed.success)
    const res = await patchHwpx(new Uint8Array(original), parsed.markdown.replace("\\---", "\\--- 고침").replace("50% 이상", "60% 이상"))
    assert.ok(res.success, res.error)
    assert.equal(res.applied, 2, JSON.stringify(res.skipped))
    const re = await parseHwpx(res.data!.buffer.slice(res.data!.byteOffset, res.data!.byteOffset + res.data!.byteLength) as ArrayBuffer)
    assert.ok(re.success)
    assert.deepEqual(re.blocks.map(b => b.text), ["앞 문단", "--- 고침", "> 60% 이상"])
  })
})
