/**
 * patch 가 "수정 불가"로 끝내지 않게 하는 경로들:
 * - 강제 줄바꿈(<hp:lineBreak/>) 문단 수정
 * - 좌표 매핑이 어긋난 편집을 원문 글로 찾아 고치기 (text-fallback)
 * - 제자리 반영 못 한 편집이 남으면 원본 서식 새로쓰기 대체본 (rewrite-fallback)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { scanSectionXml, applySplices, type SpliceEdit } from "../src/roundtrip/source-map.js"
import { fallbackTextEdit, fallbackTableEdits } from "../src/roundtrip/text-fallback.js"
import { needsRewrite, rebaseEdits, rewriteEdited, rewritePath } from "../src/roundtrip/rewrite-fallback.js"

async function withSection(md: string, edit: (xml: string) => string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await markdownToHwpx(md))
  const xml = await zip.file("Contents/section0.xml")!.async("string")
  zip.file("Contents/section0.xml", edit(xml))
  return zip.generateAsync({ type: "uint8array" })
}

async function markdownOf(data: Uint8Array): Promise<string> {
  return (await parseHwpx(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, { layoutTables: "keep" })).markdown
}

async function sectionXml(data: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(data)).file("Contents/section0.xml")!.async("string")
}

describe("강제 줄바꿈 문단 수정", () => {
  it("줄바꿈 든 문단의 글을 고치면 줄바꿈은 그대로 두고 바뀐 자리만 쓴다", async () => {
    const src = await withSection("첫 문단\n\n둘째 줄 앞부분 뒷부분입니다\n\n셋째 문단", x => x.replace("앞부분 뒷부분", "앞부분<hp:lineBreak/>뒷부분"))
    const md = await markdownOf(src)
    assert.ok(md.includes("앞부분\n뒷부분입니다"), md)
    const r = await patchHwpx(src, md.replace("뒷부분입니다", "뒷부분을 고쳤습니다"))
    assert.equal(r.success, true)
    assert.equal(r.applied, 1)
    assert.deepEqual(r.skipped, [])
    assert.equal(r.verification!.stats.modified, 0)
    assert.ok((await sectionXml(r.data!)).includes("앞부분<hp:lineBreak/>뒷부분을 고쳤습니다"))
  })

  it("줄을 늘리면 같은 줄바꿈 요소로 쓴다", async () => {
    const src = await withSection("가나 다라", x => x.replace("가나 다라", "가나<hp:lineBreak/>다라"))
    const md = await markdownOf(src)
    const r = await patchHwpx(src, md.replace("다라", "다라\n마바"))
    assert.equal(r.applied, 1)
    assert.ok((await sectionXml(r.data!)).includes("다라<hp:lineBreak/>마바"))
    assert.equal(r.verification!.stats.modified, 0)
  })

  it("빈 줄(줄바꿈 둘)로 갈라진 조각도 고친다", async () => {
    const src = await withSection("앞 조각 뒤 조각입니다", x => x.replace("앞 조각 뒤", "앞 조각<hp:lineBreak/><hp:lineBreak/>뒤"))
    const md = await markdownOf(src)
    assert.ok(md.includes("앞 조각\n\n뒤 조각입니다"), md)
    const r = await patchHwpx(src, md.replace("뒤 조각입니다", "뒤 조각을 바꿈"))
    assert.equal(r.applied, 1)
    assert.deepEqual(r.skipped, [])
    assert.ok((await sectionXml(r.data!)).includes("앞 조각<hp:lineBreak/><hp:lineBreak/>뒤 조각을 바꿈"))
  })
})

describe("원문 글로 찾아 고치기 (text-fallback)", () => {
  const p = (t: string) => `<hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p>`
  const cell = (r: number, c: number, body: string) =>
    `<hp:tc><hp:subList>${body}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`

  it("여러 문단에 걸친 제목 상자 글 — 문단 번호가 그린 머리 부호는 원문에 없어도 맞대고, 바뀐 낱말만 고친다", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y"><hp:tbl><hp:tr>${cell(0, 0, p("제목 첫 줄") + p("- 부제 하나") + p("부제 둘 R&amp;D"))}</hp:tr></hp:tbl></hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const ctx = { scans: [scan], sectionSplices: [[]] as SpliceEdit[][] }
    const ok = fallbackTextEdit(ctx, "제목 첫 줄\n- 부제 하나\n- 부제 둘 R&D", "제목 첫 줄\n- 부제 하나 고침\n- 부제 셋 R&D")
    assert.equal(ok, true)
    const out = applySplices(xml, ctx.sectionSplices[0])
    assert.ok(out.includes(p("제목 첫 줄") + p("- 부제 하나 고침") + p("부제 셋 R&amp;D")), out)
  })

  it("같은 글이 여러 곳이면 IR 등장 순번으로 고른다", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y">${p("반복 문단")}${p("다른 문단")}${p("반복 문단")}</hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const ctx = { scans: [scan], sectionSplices: [[]] as SpliceEdit[][] }
    assert.equal(fallbackTextEdit(ctx, "반복 문단", "반복 문단 둘째", 1, 2), true)
    const out = applySplices(xml, ctx.sectionSplices[0])
    assert.equal(out, `<hs:sec xmlns:hs="x" xmlns:hp="y">${p("반복 문단")}${p("다른 문단")}${p("반복 문단 둘째")}</hs:sec>`)
  })

  it("표 칸: 행을 칸 글로 맞대 빈 칸을 채우고 글 칸을 고친다", () => {
    const empty = `<hp:p><hp:run charPrIDRef="0"/></hp:p>`
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y"><hp:tbl rowCnt="2" colCnt="2">`
      + `<hp:tr>${cell(0, 0, p("성명"))}${cell(0, 1, empty)}</hp:tr>`
      + `<hp:tr>${cell(1, 0, p("연락처"))}${cell(1, 1, p("010"))}</hp:tr></hp:tbl></hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const ctx = { scans: [scan], sectionSplices: [[]] as SpliceEdit[][] }
    const r = fallbackTableEdits(ctx, scan.tables[0], [["성명", ""], ["연락처", "010"]], [["성명", "홍길동"], ["연락처", "010-1234"]])
    assert.equal(r.applied, 2)
    assert.deepEqual(r.failed, [])
    const out = applySplices(xml, ctx.sectionSplices[0])
    assert.ok(out.includes("<hp:t>홍길동</hp:t>"), out)
    assert.ok(out.includes("<hp:t>010-1234</hp:t>"), out)
  })

  it("이미 고친 자리와 겹치면 쓰지 않는다", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y">${p("하나 둘")}</hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const t = scan.bodyParagraphs[0].tRanges[0]
    const ctx = { scans: [scan], sectionSplices: [[{ start: t.contentStart, end: t.contentEnd, replacement: "x" }]] }
    assert.equal(fallbackTextEdit(ctx, "하나 둘", "하나 셋"), false)
    assert.equal(ctx.sectionSplices[0].length, 1)
  })
})

describe("hp:t 안 탭 요소·엔티티·PUA 기호가 든 문단 수정", () => {
  it("굵은 run 은 그대로 두고 바뀐 자리만 쓴다 — 탭 요소·엔티티", async () => {
    const src = await withSection("첫 문단\n\n앞 글 A&B **굵은 글** 뒤 글\n\n끝 문단", x => x.replace(">앞 글", '><hp:tab width="4000" leader="0" type="1"/>앞 글'))
    assert.ok((await sectionXml(src)).includes('type="1"/>앞 글 A&amp;B'))
    const md = await markdownOf(src)
    assert.ok(md.includes("**굵은 글** 뒤 글"), md)
    const r = await patchHwpx(src, md.replace("뒤 글", "뒤 글 수정"))
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.ok((await markdownOf(r.data!)).includes("A&B **굵은 글** 뒤 글 수정"))
    assert.ok((await sectionXml(r.data!)).includes('type="1"/>앞 글 A&amp;B'))
  })

  it("PUA 기호는 원문 글자 그대로, 굵은 run 도 그대로", async () => {
    const src = await withSection("첫 문단\n\n앞 글 **굵은 글** 뒤 글\n\n끝 문단", x => x.replace(">앞 글", ">\uF0DC 앞 글"))
    const md = await markdownOf(src)
    assert.ok(!md.includes("\uF0DC"), "parse 는 PUA 표시값")
    const r = await patchHwpx(src, md.replace("뒤 글", "뒤 글 수정"))
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.ok((await markdownOf(r.data!)).includes("**굵은 글** 뒤 글 수정"))
    assert.ok((await sectionXml(r.data!)).includes("\uF0DC 앞 글"))
  })
})

describe("붙인 글의 서식은 마크다운대로", () => {
  it("굵은 제목 끝 표지 밖에 붙인 글은 굵게를 물려받지 않는다 — 표지 안이면 굵게", async () => {
    const src = new Uint8Array(await markdownToHwpx("첫 문단\n\n**굵은 제목**\n\n끝 문단"))
    const md = await markdownOf(src)
    assert.ok(md.includes("**굵은 제목**"), md)
    const r = await patchHwpx(src, md.replace("**굵은 제목**", "**굵은 제목** 붙인 글"))
    assert.equal(r.applied, 1)
    assert.deepEqual(r.skipped, [])
    assert.ok((await markdownOf(r.data!)).includes("**굵은 제목** 붙인 글"))
    const r2 = await patchHwpx(src, md.replace("**굵은 제목**", "**굵은 제목 안쪽**"))
    assert.ok((await markdownOf(r2.data!)).includes("**굵은 제목 안쪽**"))
  })

  it("굵게 없던 문단에 새로 쓴 굵은 낱말은 굵게로 — 원문에 안 보이던 서식 비트도 새 글에 표시했으면 더한다", async () => {
    const src = new Uint8Array(await markdownToHwpx("첫 문단\n\n보통 문단입니다\n\n끝 문단"))
    const md = await markdownOf(src)
    const r = await patchHwpx(src, md.replace("보통 문단입니다", "보통 **강조** 문단입니다"))
    assert.equal(r.applied, 1)
    assert.deepEqual(r.skipped, [])
    assert.ok((await markdownOf(r.data!)).includes("보통 **강조** 문단입니다"), await markdownOf(r.data!))
  })

  it("기울임·밑줄·취소선도 새 글에 표시했으면 넣는다 — kordoc 생성 header 처럼 밑줄·취소선 요소가 없는 글자 모양이면 만든다", async () => {
    const src = new Uint8Array(await markdownToHwpx("첫 문단\n\n보통 문단입니다\n\n끝 문단"))
    const md = await markdownOf(src)
    const want = "보통 *기울임* <u>밑줄</u> ~~취소~~ 문단입니다"
    const r = await patchHwpx(src, md.replace("보통 문단입니다", want))
    assert.deepEqual(r.skipped, [])
    assert.ok((await markdownOf(r.data!)).includes(want), await markdownOf(r.data!))
  })

  const PAIRS = join(import.meta.dirname, "..", "bench", "corpus", "pairs")
  const p01 = existsSync(PAIRS) ? readdirSync(PAIRS).find(f => f.startsWith("pair01-") && f.endsWith(".hwpx")) : undefined
  it("HTML 표 칸에 쓴 강조 표지는 글자로 박히지 않고 굵은 글자 모양으로 (코퍼스)", { skip: !p01 }, async () => {
    const src = new Uint8Array(readFileSync(join(PAIRS, p01!)))
    const md = await markdownOf(src)
    const cell = "<td>본인 확인, 자문위원 연임 확인, 범죄경력 조회</td>"
    assert.ok(md.includes(cell), "코퍼스 문서 꼴이 바뀜")
    const r = await patchHwpx(src, md.replace(cell, "<td>본인 확인, **강조** 자문위원 연임 확인, 범죄경력 조회</td>"))
    assert.equal(r.applied, 1)
    const xml = await sectionXml(r.data!)
    assert.ok(!xml.includes("**강조**"), "표지가 글자로 박힘")
    assert.match(xml, /<hp:run charPrIDRef="\d+"><hp:t>강조<\/hp:t><\/hp:run>/)
  })

  const SUP = join(import.meta.dirname, "..", "bench", "corpus", "korea-kr")
  const supFile = existsSync(SUP) ? readdirSync(SUP).find(f => f.startsWith("156765974_") && f.endsWith(".hwpx")) : undefined
  it("위첨자 끝에 붙인 글은 위첨자가 되지 않는다 (코퍼스)", { skip: !supFile }, async () => {
    const src = new Uint8Array(readFileSync(join(SUP, supFile!)))
    const md = await markdownOf(src)
    const unit = "**및 품질 제고**<sup>\\*\\*</sup>"
    assert.ok(md.includes(unit), "코퍼스 문서 꼴이 바뀜")
    const r = await patchHwpx(src, md.replace(unit, unit + " 수정"))
    assert.equal(r.applied, 1)
    assert.ok((await markdownOf(r.data!)).includes(unit + " 수정"))
  })
})

describe("한 문단 여러 곳 고치기", () => {
  it("처음·끝 낱말을 고쳐도 사이 run(마크다운에 안 보이는 글자 모양)은 그대로 — 바뀐 낱말 자리만 쓴다", async () => {
    const src = await withSection("첫 문단\n\n처음 가운데 끝\n\n끝 문단", xml => xml.replace(
      `<hp:run charPrIDRef="0"><hp:t>처음 가운데 끝</hp:t></hp:run>`,
      `<hp:run charPrIDRef="0"><hp:t>처음 </hp:t></hp:run><hp:run charPrIDRef="9"><hp:t>가운데</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t> 끝</hp:t></hp:run>`,
    ))
    const md = await markdownOf(src)
    assert.ok(md.includes("처음 가운데 끝"), md)
    const r = await patchHwpx(src, md.replace("처음 가운데 끝", "앞변경 가운데 뒤변경"))
    assert.equal(r.applied, 1)
    assert.deepEqual(r.skipped, [])
    const xml = await sectionXml(r.data!)
    assert.ok(xml.includes(`<hp:run charPrIDRef="9"><hp:t>가운데</hp:t></hp:run>`), "사이 run 유지")
    assert.ok((await markdownOf(r.data!)).includes("앞변경 가운데 뒤변경"))
  })
})

describe("글머리표 문단 수정 (#179)", () => {
  // 문단 모양 0 을 글머리표 1번(PUA U+F09F)으로 — 파서는 IR 글 앞에 PUA 그대로 붙이고 마크다운엔 표시값 "•" 로 낸다
  async function bulleted(): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n구축된 A 기반\n\n끝 문단"))
    const header = await zip.file("Contents/header.xml")!.async("string")
    const withBullet = header
      .replace(/(<hh:paraPr\b[^>]*\bid="0"[\s\S]*?)<hh:heading\b[^>]*\/>/, '$1<hh:heading type="BULLET" idRef="1" level="0"/>')
      .replace("</hh:refList>", '<hh:bullets itemCnt="1"><hh:bullet id="1" char="\uF09F" useImage="0"/></hh:bullets></hh:refList>')
    assert.notEqual(withBullet, header)
    zip.file("Contents/header.xml", withBullet)
    return zip.generateAsync({ type: "uint8array" })
  }

  it("마크다운의 글머리표(표시값)는 떼고 글만 고친다 — 글머리표가 두 번 나오지 않는다", async () => {
    const src = await bulleted()
    const md = await markdownOf(src)
    assert.ok(md.includes("• 구축된 A 기반"), md)
    const r = await patchHwpx(src, md.replace("• 구축된 A 기반", "• 구축된 A 기반 B"))
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.deepEqual(r.skipped, [])
    const out = await markdownOf(r.data!)
    assert.ok(out.includes("• 구축된 A 기반 B") && !out.includes("• •"), out)
  })

  it("글머리표 앞에 넣은 글은 글머리표 뒤에 넣고 알린다", async () => {
    const src = await bulleted()
    const md = await markdownOf(src)
    const r = await patchHwpx(src, md.replace("• 구축된 A 기반", "[표시] • 구축된 A 기반"))
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.ok(r.skipped.length > 0 && r.skipped.every(s => s.partial && s.reason.includes("앞에 넣은 글")), JSON.stringify(r.skipped))
    const out = await markdownOf(r.data!)
    assert.ok(out.includes("• [표시] 구축된 A 기반") && !out.includes("• •"), out)
  })
})

describe("새로쓰기 대체본 (rewrite-fallback)", () => {
  it("글을 반영 못 한 건너뜀이 있을 때만 대체본이 필요하다", () => {
    assert.equal(needsRewrite({ success: true, data: new Uint8Array(1), applied: 1, skipped: [] }), false)
    assert.equal(needsRewrite({ success: true, data: new Uint8Array(1), applied: 1, skipped: [{ reason: "강조", partial: true }] }), false)
    assert.equal(needsRewrite({ success: true, data: new Uint8Array(1), applied: 0, skipped: [{ reason: "미지원" }] }), true)
    assert.equal(needsRewrite({ success: false, applied: 0, skipped: [], error: "x" }), true)
    assert.equal(rewritePath("/a/b/out.hwpx"), "/a/b/out.rewrite.hwpx")
    assert.equal(rewritePath("/a/b/out.HWP"), "/a/b/out.rewrite.hwpx")
  })

  it("HWP parse 기준 편집을 바꾼 판 parse 위로 옮긴다 — 표지·띄어쓰기는 바꾼 판 것, 바뀐 글만 편집본 것", () => {
    // HWP 파서는 글자 크기로 # 제목을 달고 균등 배분 글자를 붙여 내고, HWPX 파서는 ** 굵게를 단다
    const base = "### 공고 제1호\n\n# 재무상태표\n\n지울 문단\n\n본문 끝"
    const target = "**공고 제1호**\n\n**재 무 상 태 표**\n\n지울 문단\n\n본문 끝"
    assert.equal(rebaseEdits(base, "### 공고 제2호\n\n# 재무상태표 수정\n\n본문 끝\n\n새 문단", target),
      "**공고 제2호**\n\n**재 무 상 태 표 수정**\n\n본문 끝\n\n새 문단")
  })

  it("굵은 글 뒤에 붙인 글 — 바꾼 판에 같은 굵게가 있으면 그 밖에, 없으면 표지를 걷어 옮긴다", () => {
    assert.equal(rebaseEdits("**□ 행사개요**\n\n본문", "**□ 행사개요** 수정\n\n본문", "**□ 행사개요**\n\n본문"), "**□ 행사개요** 수정\n\n본문")
    assert.equal(rebaseEdits("**□ 행사개요**\n\n본문", "**□ 행사개요** 수정\n\n본문", "□ 행사개요\n\n본문"), "□ 행사개요 수정\n\n본문")
    assert.equal(rebaseEdits("가 **나** 다", "가 **나** 새 다", "가 **나** 다"), "가 **나** 새 다")
    // 표지를 바꾼 편집(새 글을 굵게)은 옮기지 않는다 — 견본으로
    assert.equal(rebaseEdits("**가**\n\n본문", "**가** **새**\n\n본문", "**가**\n\n본문"), null)
  })

  it("바뀐 자리가 굵게·칸 경계를 가로지르거나 바꾼 판에서 짝을 못 찾으면 옮기지 않는다", () => {
    assert.equal(rebaseEdits("가 나 다", "가 라 다", "**가 나** 다"), null)
    assert.equal(rebaseEdits("<table><tr><td>A</td><td>B</td></tr></table>", "<table><tr><td>A1</td><td>B1</td></tr></table>",
      "<table><tr><td>**A**</td><td>B</td></tr></table>"), null)
    assert.equal(rebaseEdits("첫 문단\n\n둘째", "첫 문단 고침\n\n둘째", "전혀 다른 글\n\n둘째"), null)
  })

  it("HWPX 원본은 견본으로 편집 내용 전부를 새로 쓴다", async () => {
    const src = new Uint8Array(await markdownToHwpx("# 제목\n\n□ 첫 항목\n\n| 구분 | 값 |\n| --- | --- |\n| 가 | 1 |"))
    const r = await rewriteEdited(src, true, "# 새 제목\n\n□ 바꾼 항목\n\n□ 늘린 항목\n\n| 구분 | 값 | 비고 |\n| --- | --- | --- |\n| 가 | 1 | 열 추가 |", false)
    assert.ok(r)
    assert.equal(r.how, "template")
    const md = await markdownOf(r.data)
    for (const s of ["새 제목", "바꾼 항목", "늘린 항목", "열 추가"]) assert.ok(md.includes(s), md)
  })
})
