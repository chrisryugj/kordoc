/**
 * patchHwpx 표 행 추가/삭제 (v3.7 — table-rows.ts) 검증.
 * 합성 HWPX(markdownToHwpx)로 GFM/HTML 표의 행 삽입·삭제·동시 편집과
 * 보수적 게이트(병합 교차, 개체 포함, 렌더 불안정)를 확인한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"

const GFM_MD = `# 사업 개요

시범사업 현황표는 아래와 같다.

| 항목 | 담당자 | 비고 |
| --- | --- | --- |
| 예산 | 홍길동 | 1억원 |
| 기간 | 김철수 | 6개월 |
| 장소 | 박영희 | 본청 |

마지막 문단.`

// colspan만 있는 표 — builder가 HTML로 렌더하지만 세로 병합은 없음 (행 연산 가능)
const HTML_COLSPAN_MD = [
  "<table>",
  '<tr><th colspan="2">구분</th><th>비고</th></tr>',
  "<tr><td>예산</td><td>1억원</td><td>본예산</td></tr>",
  "<tr><td>기간</td><td>6개월</td><td>연내</td></tr>",
  "</table>",
].join("\n")

// rowspan 있는 표 — 교차 게이트 검증용
const HTML_ROWSPAN_MD = [
  "<table>",
  '<tr><th colspan="2">구분</th><th>내용</th></tr>',
  '<tr><td rowspan="2">사업</td><td>세부1</td><td>예산 100</td></tr>',
  "<tr><td>세부2</td><td>예산 200</td></tr>",
  "</table>",
].join("\n")

async function make(md: string): Promise<{ original: Uint8Array; markdown: string }> {
  const buf = await markdownToHwpx(md)
  const original = new Uint8Array(buf)
  const parsed = await parseHwpx(buf)
  assert.ok(parsed.success, "합성 HWPX 파싱 성공")
  return { original, markdown: parsed.markdown }
}

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function reparse(data: Uint8Array) {
  const r = await parseHwpx(toAB(data))
  assert.ok(r.success, "패치본 재파싱 성공")
  return r
}

async function sectionXml(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data)
  const name = Object.keys(zip.files).find(n => /section0\.xml$/i.test(n))!
  return zip.file(name)!.async("text")
}

async function assertNonSectionEntriesIdentical(a: Uint8Array, b: Uint8Array): Promise<void> {
  const za = await JSZip.loadAsync(a)
  const zb = await JSZip.loadAsync(b)
  assert.deepEqual(Object.keys(za.files).sort(), Object.keys(zb.files).sort(), "엔트리 목록 동일")
  for (const name of Object.keys(za.files)) {
    if (za.files[name].dir || /section\d+\.xml$/i.test(name)) continue
    const da = await za.file(name)!.async("uint8array")
    const db = await zb.file(name)!.async("uint8array")
    assert.equal(Buffer.compare(Buffer.from(da), Buffer.from(db)), 0, `엔트리 바이트 보존: ${name}`)
  }
}

// ─── GFM 표 행 연산 ─────────────────────────────────

describe("patchHwpx 행 연산: GFM 표", () => {
  it("끝에 행 추가 → rowCnt/rowAddr 갱신 + 무손실 라운드트립", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 장소 | 박영희 | 본청 |", "| 장소 | 박영희 | 본청 |\n| 신규 | 이몽룡 | 추가분 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 0, `skipped: ${JSON.stringify(res.skipped)}`)
    assert.deepEqual(res.verification?.stats, { added: 0, removed: 0, modified: 0, unchanged: res.verification!.stats.unchanged })

    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    await assertNonSectionEntriesIdentical(original, res.data!)

    const xml = await sectionXml(res.data!)
    assert.ok(/rowCnt="5"/.test(xml), "rowCnt 4→5")
    for (let r = 0; r < 5; r++) {
      assert.ok(xml.includes(`rowAddr="${r}"`), `rowAddr ${r} 존재`)
    }
    assert.ok(!xml.includes(`rowAddr="5"`), "잉여 rowAddr 없음")
  })

  it("중간에 행 삽입 → 이후 행 rowAddr 밀림", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 기간 | 김철수 | 6개월 |", "| 기간 | 김철수 | 6개월 |\n| 인력 | 성춘향 | 3명 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    // 순서 확인 — 삽입 행이 기존 두 행 사이에
    const md = r2.markdown
    assert.ok(md.indexOf("김철수") < md.indexOf("성춘향") && md.indexOf("성춘향") < md.indexOf("박영희"))
  })

  it("중간 행 삭제 → 이후 행 rowAddr 당김 + rowCnt 감소", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 기간 | 김철수 | 6개월 |\n", "")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.deepEqual(res.verification?.stats, { added: 0, removed: 0, modified: 0, unchanged: res.verification!.stats.unchanged })
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    assert.ok(!r2.markdown.includes("김철수"))

    const xml = await sectionXml(res.data!)
    assert.ok(/rowCnt="3"/.test(xml), "rowCnt 4→3")
    assert.ok(!xml.includes("김철수"), "삭제 행 텍스트 제거")
    assert.ok(!xml.includes(`rowAddr="3"`), "잉여 rowAddr 없음")
    await assertNonSectionEntriesIdentical(original, res.data!)
  })

  it("행 삭제 + 다른 행 셀 수정 동시 적용", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown
      .replace("| 기간 | 김철수 | 6개월 |\n", "")
      .replace("| 장소 | 박영희 | 본청 |", "| 장소 | 박영희 | 별관 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 2, `applied=${res.applied} skipped=${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("연속 2행 추가 → 순서 보존", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace(
      "| 장소 | 박영희 | 본청 |",
      "| 장소 | 박영희 | 본청 |\n| 추가1 | 갑 | a |\n| 추가2 | 을 | b |",
    )
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 2)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("헤더 바로 아래 삽입 → 데이터 행 서식으로 복제", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 예산 | 홍길동 | 1억원 |", "| 총괄 | 변학도 | 신설 |\n| 예산 | 홍길동 | 1억원 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    // 새 행 셀이 header 속성을 갖지 않아야 함 (데이터 행 템플릿)
    const xml = await sectionXml(res.data!)
    const newCell = xml.match(/<hp:tc[^>]*>(?:(?!<\/hp:tc>)[\s\S])*?변학도/)
    assert.ok(newCell && / header="0"/.test(newCell[0]), "삽입 행은 데이터 행 서식")
  })

  it("빈 행 삽입 → 서식 입력 행으로 남는다 (렌더가 앵커 칸이 다 빈 행을 보존, #144)", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 장소 | 박영희 | 본청 |", "| 장소 | 박영희 | 본청 |\n|  |  |  |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.deepEqual(res.skipped, [])
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown.trim(), edited.trim())
  })

  it("이미지 토큰 포함 행 삽입 → skip", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 장소 | 박영희 | 본청 |", "| 장소 | 박영희 | 본청 |\n| 사진 | ![image](x.png) | 첨부 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.ok(res.skipped.some(s => s.reason.includes("이미지")), `skipped: ${JSON.stringify(res.skipped)}`)
  })

  it("여러 줄(<br>) 셀 행 삽입 → 한 문단 병합 + 보고", async () => {
    const { original, markdown } = await make(GFM_MD)
    const edited = markdown.replace("| 장소 | 박영희 | 본청 |", "| 장소 | 박영희 | 본청 |\n| 특이 | 갑<br>을 | 메모 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.ok(res.skipped.some(s => s.reason.includes("병합")), `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.ok(r2.markdown.includes("갑 을"), "줄이 공백 병합됨")
  })

  it("변경 없음 → 원본 바이트 동일 (행 연산 경로 미발동)", async () => {
    const { original, markdown } = await make(GFM_MD)
    const res = await patchHwpx(original, markdown)
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.equal(Buffer.compare(Buffer.from(res.data!), Buffer.from(original)), 0)
  })
})

// ─── HTML 표 행 연산 ────────────────────────────────

describe("patchHwpx 행 연산: HTML 표", () => {
  it("colspan 표 끝에 행 추가 → 무손실 라운드트립", async () => {
    const { original, markdown } = await make(HTML_COLSPAN_MD)
    assert.ok(markdown.includes("<table>"), "HTML 표 렌더")
    const edited = markdown.replace(
      "<tr><td>기간</td><td>6개월</td><td>연내</td></tr>",
      "<tr><td>기간</td><td>6개월</td><td>연내</td></tr>\n<tr><td>인력</td><td>3명</td><td>파견</td></tr>",
    )
    assert.notEqual(edited, markdown)
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1, `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    await assertNonSectionEntriesIdentical(original, res.data!)
  })

  it("colspan 표 행 삭제", async () => {
    const { original, markdown } = await make(HTML_COLSPAN_MD)
    const edited = markdown.replace("\n<tr><td>예산</td><td>1억원</td><td>본예산</td></tr>", "")
    assert.notEqual(edited, markdown)
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1, `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    assert.ok(!r2.markdown.includes("본예산"))
  })

  it("rowspan을 가로지르는 위치 삽입 → skip", async () => {
    const { original, markdown } = await make(HTML_ROWSPAN_MD)
    const edited = markdown.replace(
      "<tr><td>세부2</td><td>예산 200</td></tr>",
      "<tr><td>끼움</td><td>예산 150</td></tr>\n<tr><td>세부2</td><td>예산 200</td></tr>",
    )
    assert.notEqual(edited, markdown)
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.ok(res.skipped.some(s => s.reason.includes("세로 병합")), `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, markdown, "원본 유지")
  })

  it("rowspan 시작 행 삭제 → skip", async () => {
    const { original, markdown } = await make(HTML_ROWSPAN_MD)
    const edited = markdown.replace('\n<tr><td rowspan="2">사업</td><td>세부1</td><td>예산 100</td></tr>', "")
    assert.notEqual(edited, markdown)
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.ok(res.skipped.some(s => s.reason.includes("세로 병합") || s.reason.includes("병합")), `skipped: ${JSON.stringify(res.skipped)}`)
  })
})

// ─── 정직한 보고 (P4 — partial 표시) ─────────────────

describe("patchHwpx 정직한 보고: 셀 줄 수 변경", () => {
  const MULTILINE_MD = "<table>\n<tr><th>항목</th><th>내용</th></tr>\n<tr><td>비고</td><td>첫줄<br>둘째줄</td></tr>\n</table>"

  it("셀 줄 삭제 → 칸 문단째 지움 (구조 편집, 기본)", async () => {
    const { original, markdown } = await make(MULTILINE_MD)
    const edited = markdown.replace("첫줄<br>둘째줄", "첫줄만")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.deepEqual(res.skipped, [])
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("셀 줄 추가 → 칸 문단 복제로 새 줄 (구조 편집, 기본)", async () => {
    const { original, markdown } = await make(MULTILINE_MD)
    const edited = markdown.replace("첫줄<br>둘째줄", "첫줄<br>끼운줄<br>둘째줄<br>셋째줄")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.deepEqual(res.skipped, [])
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("structure: false — 셀 줄 삭제 → 적용되지만 빈 문단 잔존을 partial로 보고", async () => {
    const { original, markdown } = await make(MULTILINE_MD)
    const edited = markdown.replace("첫줄<br>둘째줄", "첫줄만")
    assert.notEqual(edited, markdown)
    const res = await patchHwpx(original, edited, { structure: false })
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const note = res.skipped.find(s => s.reason.includes("줄 삭제"))
    assert.ok(note?.partial === true, `partial 보고: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited, "텍스트 자체는 편집대로 반영")
  })

  it("structure: false — 셀 줄 추가 병합 → partial로 보고", async () => {
    const { original, markdown } = await make(MULTILINE_MD)
    const edited = markdown.replace("첫줄<br>둘째줄", "첫줄<br>둘째줄<br>셋째줄")
    const res = await patchHwpx(original, edited, { structure: false })
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const note = res.skipped.find(s => s.reason.includes("병합 적용"))
    assert.ok(note?.partial === true, `partial 보고: ${JSON.stringify(res.skipped)}`)
  })
})

describe("행 추가 복제 행 테두리 — 머리 구분선·바깥선을 행마다 긋지 않는다", () => {
  /** 행마다 첫 칸이 참조하는 borderFill 의 윗변·아랫변 [type, width] */
  async function rowBorders(data: Uint8Array): Promise<Array<{ top: string; bottom: string }>> {
    const zip = await JSZip.loadAsync(data)
    const header = await zip.file("Contents/header.xml")!.async("string")
    const section = await zip.file("Contents/section0.xml")!.async("string")
    const side = (id: string, s: string) => {
      const def = header.match(new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`))![0]
      const m = def.match(new RegExp(`<hh:${s}Border type="(\\w+)" width="([^"]+)"`))!
      return `${m[1]} ${m[2]}`
    }
    return [...section.matchAll(/<hp:tr>[\s\S]*?<\/hp:tr>/g)].map(tr => {
      const id = tr[0].match(/<hp:tc [^>]*borderFillIDRef="(\d+)"/)![1]
      return { top: side(id, "top"), bottom: side(id, "bottom") }
    })
  }

  it("본문 1행 공문서 표를 8행으로 늘리면 이중선은 머리 아래 한 번, 굵은 바깥선은 새 마지막 행 아래에만", async () => {
    const buf = await markdownToHwpx("# 시험\n\n| 구분 | 내용 |\n| --- | --- |\n| 가 | 나 |\n", { gongmun: { preset: "official" } })
    const original = new Uint8Array(buf)
    const before = await rowBorders(original)
    assert.match(before[1].top, /^DOUBLE_SLIM/) // 머리 구분선
    const md = (await parseHwpx(buf)).markdown
    const edited = md.replace("| 가 | 나 |", Array.from({ length: 8 }, (_, i) => `| 항목${i + 1} | 내용${i + 1} |`).join("\n"))
    const r = await patchHwpx(original, edited)
    assert.ok(r.success && r.data, r.error)
    const rows = await rowBorders(r.data!)
    assert.equal(rows.length, 9)
    assert.equal(rows[1].top, before[1].top)
    for (let i = 2; i < 9; i++) assert.equal(rows[i].top, "SOLID 0.12 mm", `${i}행 윗변`)
    for (let i = 1; i < 8; i++) assert.equal(rows[i].bottom, "SOLID 0.12 mm", `${i}행 아랫변`)
    assert.equal(rows[8].bottom, before[1].bottom) // 바깥 아랫변은 새 마지막 행으로
  })
})
