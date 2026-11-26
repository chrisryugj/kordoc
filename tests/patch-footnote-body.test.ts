/**
 * 각주가 달린 문단·표 칸의 본문 patch (#240). 마크다운에 각주는 본문 뒤 "1) (주: 1) 각주 글)" 로 나온다(파서가 각주 자리에 번호를 끼우고
 * 각주 글을 끝에 붙인다). 본문만 고친 편집은 각주를 그대로 두고 적용한다 (HWPX·HWP 5.x). 각주 글을 고친 편집은 patch-footnote-text.test.ts
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, hwpxToHwp, parse, patchHwpx, patchHwp } from "../src/index.js"

const MD = `본문 문단에 각주가 있다.[^1]

| 항목 | 값 |
| --- | --- |
| 이름[^2] | 홍길동 |
| 부서 | 총무과 |

[^1]: 본문 문단의 각주.
[^2]: 표 칸의 각주.
`

let rhwp = true
try { await import("@rhwp/core") } catch { rhwp = false }

for (const kind of ["hwpx", "hwp"] as const) {
  describe(`patch ${kind}: 각주가 달린 문단·칸 (#240)`, { skip: kind === "hwp" && !rhwp }, () => {
    const load = async () => {
      const hwpx = await markdownToHwpx(MD)
      const doc = new Uint8Array(kind === "hwpx" ? hwpx : await hwpxToHwp(hwpx))
      const base = (await parse(Buffer.from(doc), { layoutTables: "keep" })).markdown
      const run = (md: string) => kind === "hwpx" ? patchHwpx(doc, md) : patchHwp(doc, md)
      return { base, run }
    }
    const reparse = async (data: Uint8Array) => (await parse(Buffer.from(data), { layoutTables: "keep" })).markdown

    it("각주가 달린 문단과 칸의 본문을 고치고 각주는 그대로 둔다", async () => {
      const { base, run } = await load()
      assert.ok(base.includes("(주: 1) 본문 문단의 각주.)") && base.includes("(주: 2) 표 칸의 각주.)"), base)
      for (const md of [base.replace("각주가 있다.1)", "각주가 있다BB.1)"), base.replace("| 이름2)", "| 이름DD2)")]) {
        const r = await run(md)
        assert.equal(r.applied, 1, JSON.stringify(r.skipped))
        const re = await reparse(r.data!)
        assert.ok(/BB|DD/.test(re), re)
        assert.ok(re.includes("(주: 1) 본문 문단의 각주.)") && re.includes("(주: 2) 표 칸의 각주.)"), re)
      }
    })
  })
}
