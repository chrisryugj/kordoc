/**
 * HWP 5.x 크기 제목 판정의 본문 크기: 글자 수 가중 최빈값이 동률이면 작은 크기를 본문으로 본다 (#242).
 * 먼저 나온 크기를 쓰면 짧은 기안문에서 제목(14pt 15자)과 본문(12pt 15자)이 같을 때 제목 크기가 본문이 되어, 본문에 한 글자만
 * 더해도(patch) 손대지 않은 제목 줄이 굵은 문단에서 헤딩으로 바뀌어 검증에 modified 가 남았다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, hwpxToHwp, parse, patchHwp } from "../src/index.js"

const MD = `# 헤딩 수준 재현용 문서 제목

본문 문단이 하나 있다.

| 항목 | 값 |
| --- | --- |
| 이름 | 홍길동 |
| 부서 | 총무과 |
`

let rhwp = true
try { await import("@rhwp/core") } catch { rhwp = false }

describe("HWP 5.x 크기 제목: 본문 크기 동률 (#242)", { skip: !rhwp }, () => {
  it("본문 문단을 고쳐도 손대지 않은 제목 줄 판정이 그대로다", async () => {
    const hwp = new Uint8Array(await hwpxToHwp(await markdownToHwpx(MD, { gongmun: { preset: "official" } })))
    const base = (await parse(Buffer.from(hwp), { layoutTables: "keep" })).markdown
    const r = await patchHwp(hwp, base.replace("하나 있다.", "하나 있다B."))
    assert.equal(r.applied, 1)
    const re = (await parse(Buffer.from(r.data!), { layoutTables: "keep" })).markdown
    assert.equal(re.split("\n")[0], base.split("\n")[0])
    assert.equal(base.split("\n")[0], "### 헤딩 수준 재현용 문서 제목")
    assert.equal(r.verification?.stats.modified, 0)
  })
})
