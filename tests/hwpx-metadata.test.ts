/**
 * HWPX 문서 정보 — 한컴 패키지 문서 Contents/content.hpf(OPF) 메타 (v4.14.3).
 *
 * 종전엔 meta.xml·docProps/core.xml 만 읽어 한컴 저장 HWPX 의 제목·지은이가 한 번도 안 나왔다
 * (한컴 저장 hwp↔hwpx 짝 210쌍에서 0건 → 209건). HWP5 요약 정보와 같은 필드: opf:title → title,
 * creator → author, description(비면 subject) → description, keyword → keywords, CreatedDate·ModifiedDate.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"
import { extractHwpxMetadataOnly } from "../src/hwpx/metadata.js"

/** 생성 HWPX 의 content.hpf opf:metadata 를 한컴 저장본 꼴로 바꿔 끼운다 */
async function withHancomMeta(meta: string): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(await markdownToHwpx("본문 문단"))
  const hpf = await zip.file("Contents/content.hpf")!.async("string")
  zip.file("Contents/content.hpf", hpf.replace(/<opf:metadata>[\s\S]*?<\/opf:metadata>/, `<opf:metadata>${meta}</opf:metadata>`))
  return await zip.generateAsync({ type: "arraybuffer" })
}

const m = (name: string, value = "") =>
  value ? `<opf:meta name="${name}" content="text">${value}</opf:meta>` : `<opf:meta name="${name}" content="text"/>`

describe("HWPX 메타데이터 — content.hpf", () => {
  it("한컴 저장본 opf:metadata → 제목·지은이·설명·키워드·날짜 (HWP5 요약 정보와 같은 필드)", async () => {
    const buf = await withHancomMeta(
      "<opf:title>사업개요</opf:title><opf:language>ko</opf:language>" + m("creator", "kimkh") + m("subject", "주제 글")
      + m("description", "설명 글") + m("lastsaveby", "ddt72") + m("CreatedDate", "2012-05-04T08:41:58Z")
      + m("ModifiedDate", "2026-03-26T05:17:02Z") + m("date", "2012년 5월 4일 금요일 오후 5:41:58") + m("keyword", "예산, 사업;개요"),
    )
    const res = await parse(buf, { filename: "a.hwpx" })
    assert.ok(res.success)
    const md = res.metadata!
    assert.equal(md.title, "사업개요")
    assert.equal(md.author, "kimkh")
    assert.equal(md.description, "설명 글", "설명이 주제보다 앞선다 (HWP5 6 설명 → 3 주제)")
    assert.deepEqual(md.keywords, ["예산", "사업", "개요"])
    assert.equal(md.createdAt, "2012-05-04T08:41:58Z")
    assert.equal(md.modifiedAt, "2026-03-26T05:17:02Z")
    // MCP parse_metadata 경로도 같은 값
    const only = await extractHwpxMetadataOnly(buf)
    assert.equal(only.title, "사업개요")
    assert.equal(only.author, "kimkh")
  })

  it("빈 요소는 없음 — 설명이 비면 주제, 빈 제목은 싣지 않는다", async () => {
    const buf = await withHancomMeta("<opf:title/>" + m("creator", "내부PC") + m("subject", "주제만") + m("description") + m("keyword"))
    const md = (await parse(buf, { filename: "b.hwpx" })).metadata!
    assert.equal(md.title, undefined)
    assert.equal(md.author, "내부PC")
    assert.equal(md.description, "주제만")
    assert.equal(md.keywords, undefined)
  })

  it("T·Z 없는 날짜는 시간대를 지어내지 않고 ISO 8601 현지 시각, FILETIME 0(1601-01-01)은 없음", async () => {
    const buf = await withHancomMeta(
      "<opf:title>민주평화통일자문회의 소개</opf:title>" + m("creator", "PEACE")
      + m("CreatedDate", "2025-07-01 19:50:36") + m("ModifiedDate", "1601-01-01 09:00:00"),
    )
    const md = (await parse(buf, { filename: "c.hwpx" })).metadata!
    assert.equal(md.createdAt, "2025-07-01T19:50:36")
    assert.equal(md.modifiedAt, undefined)
  })

  it("kordoc 생성 파일(generator 표지만)은 종전대로 제목·지은이 없음", async () => {
    const md = (await parse(await markdownToHwpx("본문"), { filename: "d.hwpx" })).metadata!
    assert.equal(md.title, undefined)
    assert.equal(md.author, undefined)
  })
})
