/**
 * 각주 글 patch (#240). 마크다운에 각주 글은 달린 문단·칸 끝 "(주: 1) 각주 글)" 로 나온다. 각주 글을 고친 편집은 그 각주의 본문 문단
 * (HWPX hp:footNote/hp:subList, HWP 5.x 각주 컨트롤의 LIST_HEADER 아래 문단)만 고치고, 각주 번호·다른 각주·달린 문단은 그대로 둔다.
 * 각주 수·번호가 바뀌는 편집은 건너뛰고 알린다 (HWPX·HWP 5.x)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, hwpxToHwp, parse, patchHwpx, patchHwp } from "../src/index.js"
import { planNoteEdits, noteParaEdit } from "../src/roundtrip/markdown-units.js"

const MD = `본문 문단에 각주가 있다.[^1]

| 항목 | 값 |
| --- | --- |
| 이름[^2] | 홍길동 |
| 부서 | 총무과 |

첫째[^3]와 둘째[^4]가 한 문단에 있다.

[^1]: 본문 문단의 각주.
[^2]: 표 칸의 각주.
[^3]: 첫째 각주.
[^4]: 둘째 각주.
`

let rhwp = true
try { await import("@rhwp/core") } catch { rhwp = false }

for (const kind of ["hwpx", "hwp"] as const) {
  describe(`patch ${kind}: 각주 글 고치기 (#240)`, { skip: kind === "hwp" && !rhwp }, () => {
    const load = async () => {
      const hwpx = await markdownToHwpx(MD)
      const doc = new Uint8Array(kind === "hwpx" ? hwpx : await hwpxToHwp(hwpx))
      const base = (await parse(Buffer.from(doc), { layoutTables: "keep" })).markdown
      const run = (md: string) => kind === "hwpx" ? patchHwpx(doc, md) : patchHwp(doc, md)
      return { base, run }
    }
    const reparse = async (data: Uint8Array) => (await parse(Buffer.from(data), { layoutTables: "keep" })).markdown

    it("문단 각주와 칸 각주의 글을 고치고 나머지는 그대로 둔다", async () => {
      const { base, run } = await load()
      assert.ok(base.includes("(주: 1) 본문 문단의 각주.)") && base.includes("(주: 2) 표 칸의 각주.)"), base)
      for (const [from, to] of [["본문 문단의 각주.", "본문 문단의 각주AA."], ["표 칸의 각주.", "고친 칸 각주CC."]]) {
        const edited = base.replace(from, to)
        const r = await run(edited)
        assert.equal(r.applied, 1, JSON.stringify(r.skipped))
        assert.deepEqual(r.skipped, [])
        assert.equal(await reparse(r.data!), edited)
      }
    })

    it("한 문단의 각주 둘 가운데 하나만, 또는 둘 다 고친다", async () => {
      const { base, run } = await load()
      assert.ok(base.includes("(주: 3) 첫째 각주.; 4) 둘째 각주.)"), base)
      for (const edited of [base.replace("둘째 각주.", "둘째 각주 고침."), base.replace("첫째 각주.", "첫째 고침.").replace("둘째 각주.", "둘째 고침.")]) {
        const r = await run(edited)
        assert.equal(r.applied, 1, JSON.stringify(r.skipped))
        assert.deepEqual(r.skipped, [])
        assert.equal(await reparse(r.data!), edited)
      }
    })

    it("본문과 각주 글을 함께 고친다", async () => {
      const { base, run } = await load()
      for (const edited of [
        base.replace("각주가 있다.1)", "각주가 있다BB.1)").replace("본문 문단의 각주.", "본문 문단의 각주AA."),
        base.replace("| 이름2)", "| 이름DD2)").replace("표 칸의 각주.", "표 칸의 각주CC."),
      ]) {
        const r = await run(edited)
        assert.equal(r.applied, 1, JSON.stringify(r.skipped))
        assert.deepEqual(r.skipped, [])
        assert.equal(await reparse(r.data!), edited)
      }
    })

    it("각주 번호를 고치거나 각주를 지운 편집은 건너뛰고 알린다", async () => {
      const { base, run } = await load()
      for (const edited of [base.replace("(주: 1) 본문", "(주: 9) 본문"), base.replace("첫째 각주.; 4) 둘째 각주.", "첫째 각주.")]) {
        const r = await run(edited)
        assert.equal(r.applied, 0, JSON.stringify(r.skipped))
        assert.deepEqual(r.skipped.map(s => s.reason), ["각주 번호 수정·각주 추가·삭제는 미지원 — 각주 글 수정 미적용"])
      }
    })
  })
}

describe("patch hwpx: 여러 문단 각주 (#240)", () => {
  /** 첫 각주 본문에 둘째 문단을 끼운 문서 — 파서는 각주 문단들을 공백으로 이어 한 글로 낸다 */
  const load = async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx(MD))
    const xml = await zip.file("Contents/section0.xml")!.async("string")
    const tail = "</hp:p></hp:subList></hp:footNote>"
    assert.ok(xml.includes(tail))
    zip.file("Contents/section0.xml", xml.replace(tail,
      `</hp:p><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="20"><hp:t>둘째 문단.</hp:t></hp:run></hp:p></hp:subList></hp:footNote>`))
    const doc = await zip.generateAsync({ type: "uint8array" })
    const base = (await parse(Buffer.from(doc), { layoutTables: "keep" })).markdown
    assert.ok(base.includes("(주: 1) 본문 문단의 각주. 둘째 문단.)"), base)
    return { doc, base }
  }
  const tTexts = async (data: Uint8Array) =>
    [...(await (await JSZip.loadAsync(data)).file("Contents/section0.xml")!.async("string")).matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(m => m[1])

  it("바뀐 자리가 든 문단만 고친다", async () => {
    const { doc, base } = await load()
    const r = await patchHwpx(doc, base.replace("둘째 문단.", "둘째 문단 고침."))
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.deepEqual(r.skipped, [])
    const ts = await tTexts(r.data!)
    assert.ok(ts.includes("둘째 문단 고침.") && ts.includes("본문 문단의 각주."), JSON.stringify(ts))
  })

  it("문단 경계에 걸친 편집은 건너뛰고 알린다", async () => {
    const { doc, base } = await load()
    const r = await patchHwpx(doc, base.replace("각주. 둘째", "각주.둘째"))
    assert.equal(r.applied, 0)
    assert.deepEqual(r.skipped.map(s => s.reason), ["각주의 여러 문단에 걸친 수정은 미지원 — 각주 글 수정 미적용"])
  })
})

describe("각주 글 편집 가르기 (#240)", () => {
  it("각주마다 본문 편집으로 가른다 — 번호 표기는 머리로 남긴다", () => {
    assert.deepEqual(planNoteEdits("1) 가; 2) 나", "1) 가; 2) 다", [" 가", " 나"]), [{ index: 1, before: "나", after: "다" }])
    assert.deepEqual(planNoteEdits("1) 가; 2) 나", "1) 가; 2) 나", ["가", "나"]), [])
  })
  it("번호·개수가 달라지거나 원문 각주와 못 맞대면 이유를 낸다", () => {
    assert.equal(typeof planNoteEdits("1) 가; 2) 나", "1) 가", ["가", "나"]), "string")
    assert.equal(typeof planNoteEdits("1) 가; 2) 나", "1) 가; 3) 나", ["가", "나"]), "string")
    assert.equal(typeof planNoteEdits("1) 가", "1) 다", ["가", "나"]), "string")
    assert.equal(typeof planNoteEdits("1) 가", "1) ", ["가"]), "string")
  })
  it("문단 하나에 든 편집만 싣는다", () => {
    assert.deepEqual(noteParaEdit(["가나", "다라"], "가나 다라", "가나 다마라"), { index: 1, before: "다라", after: "다마라" })
    assert.deepEqual(noteParaEdit(["가나", "다라"], "가나 다라", "가 다라"), { index: 0, before: "가나", after: "가" })
    assert.equal(noteParaEdit(["가나", "다라"], "가나 다라", "가나다라"), null)
  })
})
