/** patch(HWP 5.x): 새 제목은 같은 수준 원문 제목을 본뜬다, 강조 든 새 문단은 서식만 다른 글자 모양으로 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, hwpxToHwp, parse, patchHwp } from "../src/index.js"

let rhwp = true
try { await import("@rhwp/core") } catch { rhwp = false }

describe("patch HWP 5.x 새 제목·강조 문단", { skip: !rhwp }, () => {
  it("## 새 절은 같은 수준 제목으로, **굵은** 조각은 굵게 다시 읽힌다", async () => {
    const hwp = await hwpxToHwp(await markdownToHwpx("# 보고서\n\n## 첫째 절\n\n첫째 본문 문단입니다.\n\n## 둘째 절\n\n둘째 본문 문단입니다.\n"))
    const base = await parse(hwp.buffer.slice(hwp.byteOffset, hwp.byteOffset + hwp.byteLength) as ArrayBuffer, { layoutTables: "keep" })
    assert.ok(base.success)
    if (!base.success) return
    assert.match(base.markdown, /## 둘째 절/)
    const edited = base.markdown.replace("둘째 본문 문단입니다.", "둘째 본문 문단입니다.\n\n## 셋째 절\n\n**굵은** 새 본문 문단입니다.")
    const r = await patchHwp(hwp, edited)
    assert.equal(r.applied, 2, JSON.stringify(r.skipped))
    assert.deepEqual(r.skipped, [])
    const out = await parse(r.data!.buffer.slice(r.data!.byteOffset, r.data!.byteOffset + r.data!.byteLength) as ArrayBuffer, { layoutTables: "keep" })
    assert.ok(out.success)
    if (!out.success) return
    assert.match(out.markdown, /## 셋째 절\n\n\*\*굵은\*\* 새 본문 문단입니다\./)
  })
})
