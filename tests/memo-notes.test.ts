/**
 * 메모(한글 "메모 넣기") 읽기 (#180) — 결과 memos 목록(메모 글·붙은 글·문단·작성자·시각·번호·블록 순번)과 memos 옵션의 마크다운 끝 "메모" 절.
 * 본문 마크다운에는 섞지 않는다(기본 출력 불변).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import JSZip from "jszip"
import { addMemoHwpx, markdownToHwpx, parse } from "../src/index.js"

const MEMO_PARAMS = `<hp:parameters cnt="7" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">MEMO/65535/1/0/0/홍길동/\;;</hp:stringParam><hp:stringParam name="ID">memo1</hp:stringParam><hp:integerParam name="Number">1</hp:integerParam><hp:stringParam name="Author">홍길동</hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535</hp:stringParam><hp:stringParam name="CreateDateTime">2026-10-31T09:30:00Z</hp:stringParam></hp:parameters>`

/** 가운데 문단의 "가운데 부분" 앞뒤로 메모 필드를 넣은 HWPX — 한글 저장본(aift.hwpx)과 같은 꼴 */
async function memoHwpx(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n이 문장의 가운데 부분에 메모를 달았다\n\n끝 문단"))
  const xml = await zip.file("Contents/section0.xml")!.async("string")
  const sub = `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>메모 글입니다</hp:t></hp:run></hp:p></hp:subList>`
  const begin = `</hp:t><hp:ctrl><hp:fieldBegin id="7" type="MEMO" name="" editable="1" dirty="1" zorder="1" fieldid="623209829">${MEMO_PARAMS}${sub}</hp:fieldBegin></hp:ctrl><hp:t>`
  const end = `</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="7" fieldid="623209829"/></hp:ctrl><hp:t>`
  const out = xml.replace("이 문장의 가운데 부분에 메모를 달았다", `이 문장의 ${begin}가운데 부분${end}에 메모를 달았다`)
  assert.notEqual(out, xml)
  zip.file("Contents/section0.xml", out)
  return zip.generateAsync({ type: "nodebuffer" })
}

describe("메모 읽기 (#180)", () => {
  it("HWPX: 메모 글·붙은 글·문단·작성자·시각·번호·블록 순번 — 본문 마크다운엔 섞지 않는다", async () => {
    const r = await parse(await memoHwpx(), { filename: "a.hwpx" })
    assert.ok(r.success)
    assert.deepEqual(r.memos, [{ text: "메모 글입니다", anchor: "가운데 부분", paragraph: "이 문장의 가운데 부분에 메모를 달았다", offset: 6, blockIndex: 1, author: "홍길동", createdAt: "2026-10-31T09:30:00Z", number: 1 }])
    assert.ok(!r.markdown.includes("메모 글입니다"))
    assert.ok(r.markdown.includes("이 문장의 가운데 부분에 메모를 달았다"))
  })

  it("memos 옵션: 마크다운 끝에 메모 절", async () => {
    const r = await parse(await memoHwpx(), { filename: "a.hwpx", memos: true })
    assert.ok(r.success)
    assert.ok(r.markdown.endsWith("**메모**\n\n1. (홍길동, 2026-10-31 09:30) 「가운데 부분」 — 메모 글입니다\n"), r.markdown)
  })

  const RHWP = join(import.meta.dirname, "..", "bench", "corpus", "rhwp")
  it("HWP 5.x·HWPX 한글 저장 짝은 같은 메모를 낸다 (코퍼스)", { skip: !existsSync(join(RHWP, "aift.hwp")) || !existsSync(join(RHWP, "hwpx", "aift.hwpx")) }, async () => {
    const hwp = await parse(readFileSync(join(RHWP, "aift.hwp")), { filename: "aift.hwp" })
    const hwpx = await parse(readFileSync(join(RHWP, "hwpx", "aift.hwpx")), { filename: "aift.hwpx" })
    assert.ok(hwp.success && hwpx.success)
    assert.equal(hwp.memos?.length, 2)
    assert.deepEqual(hwp.memos, hwpx.memos)
    assert.equal(hwp.memos![0].text, "기업 소개 및 본 과제 관련 기술력 소개")
    assert.equal(hwp.memos![0].anchor, "- 공동기관1 : 두아즈")
  })
})

const ab = (b: ArrayBuffer | Uint8Array): ArrayBuffer => b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer : b

describe("메모 달기 (#180)", () => {
  const SRC = "첫 문단\n\n이 문장의 가운데 부분에 메모를 달았다\n\n끝 문단 가운데 부분"
  const at = new Date(2026, 9, 31, 10, 20, 0)

  it("앵커 문구에 단 메모가 다시 읽으면 나오고, 본문 마크다운은 그대로다", async () => {
    const src = await markdownToHwpx(SRC)
    const before = await parse(ab(src), { filename: "a.hwpx" })
    const r = await addMemoHwpx(ab(src), [{ anchor: "가운데 부분", text: "근거 자료를\n붙여 주세요", author: "검토자" }], at)
    assert.deepEqual(r.placed, [{ anchor: "가운데 부분", occurrence: 0, number: 1, sectionIndex: 0 }])
    const after = await parse(r.buffer, { filename: "a.hwpx" })
    assert.ok(before.success && after.success)
    assert.equal(after.markdown, before.markdown)
    assert.deepEqual(after.memos, [{ text: "근거 자료를\n붙여 주세요", anchor: "가운데 부분", paragraph: "이 문장의 가운데 부분에 메모를 달았다", offset: 6, blockIndex: 1, author: "검토자", createdAt: "2026-10-31T10:20:00Z", number: 1 }])
    const zip = await JSZip.loadAsync(r.buffer)
    assert.match(await zip.file("Contents/header.xml")!.async("string"), /<hh:memoProperties itemCnt="1"><hh:memoPr id="1"/)
    assert.match(await zip.file("Contents/section0.xml")!.async("string"), /<hp:secPr\b[^>]*memoShapeIDRef="1"/)
  })

  it("같은 앵커는 occurrence 로 고르고, 메모가 있는 문서엔 다음 번호로 단다", async () => {
    const first = await addMemoHwpx(ab(await markdownToHwpx(SRC)), [{ anchor: "가운데 부분", text: "둘째", occurrence: 1 }], at)
    const second = await addMemoHwpx(first.buffer, [{ anchor: "첫 문단", text: "첫째" }], at)
    assert.equal(second.placed[0].number, 2)
    const r = await parse(second.buffer, { filename: "a.hwpx" })
    assert.ok(r.success)
    assert.deepEqual(r.memos?.map(m => [m.number, m.anchor, m.paragraph, m.text, m.author]), [
      [2, "첫 문단", "첫 문단", "첫째", "kordoc"],
      [1, "가운데 부분", "끝 문단 가운데 부분", "둘째", "kordoc"],
    ])
  })

  it("앵커가 없거나 등장 수를 넘으면 등장 수를 알려 주며 실패한다", async () => {
    const src = ab(await markdownToHwpx(SRC))
    await assert.rejects(addMemoHwpx(src, [{ anchor: "없는 글", text: "x" }]), /0회 등장/)
    await assert.rejects(addMemoHwpx(src, [{ anchor: "가운데 부분", text: "x", occurrence: 2 }]), /2회 등장 — occurrence 0\.\.1/)
  })
})
