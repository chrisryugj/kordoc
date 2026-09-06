/**
 * v4.13.0 라운드 2 — 표 열 역할(내용 넓게·비고 좁게) 열폭 배분.
 * 실측(서울 실결재 데이터표 462개, 3열+): 내용류 열 중앙값 51%(p75 63%), 비고 열 21%(p75 26%), 마지막 열 26%.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { computeColWidths, colRoles } from "../src/hwpx/gen-table.js"

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

describe("colRoles — 헤더 텍스트로 열 역할 판정", () => {
  it("비고·근거·참고사항·담당은 remark, 내용·사항·실적류는 content, 비고사항은 remark 우선", () => {
    assert.deepEqual(colRoles(["단계", "내용", "근거"]), [null, "content", "remark"])
    assert.deepEqual(colRoles(["구분", "**주요 내용**", "비 고"]), [null, "content", "remark"])
    assert.deepEqual(colRoles(["연번", "참고사항", "비고사항", "추진실적"]), [null, "remark", "remark", "content"])
    assert.deepEqual(colRoles(["구분", "담당자", "연락처"]), [null, "remark", "remark"])
  })
  it("내용 열이 있는 3열+ 표의 역할 없는 마지막 열은 remark — 2열·내용 열 없는 표는 그대로", () => {
    assert.deepEqual(colRoles(["구분", "사업내용", "추진일정"]), [null, "content", "remark"])
    assert.deepEqual(colRoles(["구분", "2024", "2025", "증감"]), [null, null, null, null])
    assert.deepEqual(colRoles(["항목", "내용"]), [null, "content"])
    assert.deepEqual(colRoles(["구분", "사업명", "사업내용"]), [null, null, "content"])
  })
})

describe("computeColWidths — 역할 가중", () => {
  it("긴 근거 열은 25% 상한, 내용 열이 잔여를 가져간다 (단계|내용|근거)", () => {
    // 단계 짧음 / 내용 중간 / 근거 가장 긺 — 종전엔 근거가 최광열
    const total = 41000
    const colMax = [2200, 21000, 30000]
    const colMinWord = [2200, 4500, 6000]
    const w = computeColWidths(colMax, total, colMinWord, colRoles(["단계", "내용", "근거"]))
    assert.equal(sum(w), total)
    assert.ok(w[2] <= Math.round(total * 0.25), `근거 열 ${w[2]} > 25%`)
    assert.ok(w[1] > w[2] * 2, `내용 열 ${w[1]} 이 근거 ${w[2]} 의 2배 미만`)
    // 역할 없이 돌리면 25% 상한이 없다 — 종전 동작 유지 확인
    const plain = computeColWidths(colMax, total, colMinWord)
    assert.ok(plain[2] > Math.round(total * 0.25), "역할 미지정이면 상한 미적용")
  })
  it("전 열 짧은 표(구분|내용|비고)는 내용 열 ≈ 50% (실측 중앙값 51%)", () => {
    const total = 40000
    const w = computeColWidths([2400, 2400, 2400], total, [2400, 2400, 2400], colRoles(["구분", "내용", "비고"]))
    assert.equal(sum(w), total)
    const share = w[1] / total
    assert.ok(share >= 0.45 && share <= 0.55, `내용 열 share ${share.toFixed(2)}`)
    assert.ok(w[2] <= Math.round(total * 0.25) + 1, `비고 열 ${w[2]} > 25%`)
  })
  it("remark 열의 최장 어절이 25%보다 길면 어절 폭까지는 허용(글자 세로 분해 금지)", () => {
    const total = 30000
    const w = computeColWidths([3000, 12000, 20000], total, [3000, 3000, 12000], colRoles(["구분", "내용", "근거"]))
    assert.equal(sum(w), total)
    assert.ok(w[2] >= 12000 + 1200, `근거 열 ${w[2]} 이 최장 어절+패딩 미만`)
  })
  it("무작위 역할 500케이스에서 합=totalWidth·전 열 양의 정수 유지", () => {
    const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const rnd = lcg(20260906)
    for (let t = 0; t < 500; t++) {
      const colCnt = 1 + Math.floor(rnd() * 10)
      const totalWidth = 8000 + Math.floor(rnd() * 60000)
      const colMax = Array.from({ length: colCnt }, () => Math.floor(rnd() * 30000))
      const colMinWord = colMax.map((w) => Math.floor(rnd() * (w + 1)))
      const roles = colMax.map(() => { const r = rnd(); return r < 0.25 ? "content" : r < 0.5 ? "remark" : null })
      const widths = computeColWidths(colMax, totalWidth, colMinWord, roles)
      assert.equal(widths.length, colCnt)
      assert.equal(sum(widths), totalWidth, `합 불변식 위반 (roles ${roles.join(",")})`)
      for (const w of widths) assert.ok(Number.isInteger(w) && w > 0, `비정상 폭 ${w}`)
    }
  })
})

describe("보고서 표 실물 — 단계|내용|근거", () => {
  it("v5 보고서 표에서 근거 열이 내용 열보다 좁고 25% 이내", async () => {
    const md = [
      "# 검토보고", "", "> 요약하고자 함", "", "## 추진 단계", "",
      "| 단계 | 내용 | 근거 |", "|---|---|---|",
      "| 1단계 | 지원대상 기준 정비 및 대상자 명단 확정 | 조례 제8조 |",
      "| 4단계 | 인공지능 기술·정책 자문단 검토 후 추진계획 반영 | 인공지능 기본조례 제6조, 고독사 예방 조례 제6조 |",
    ].join("\n")
    const buf = await markdownToHwpx(md, { gongmun: { preset: "보고서" } })
    const zip = await JSZip.loadAsync(buf)
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    const at = sec.indexOf("<hp:t>단계</hp:t>")
    assert.ok(at > 0)
    const tblStart = sec.lastIndexOf("<hp:tbl ", at)
    const tbl = sec.slice(tblStart, sec.indexOf("</hp:tbl>", tblStart))
    const widths = [...tbl.matchAll(/<hp:cellSz width="(\d+)"/g)].slice(0, 3).map((m) => Number(m[1]))
    const total = sum(widths)
    assert.ok(widths[2] < widths[1], `근거 ${widths[2]} ≥ 내용 ${widths[1]}`)
    assert.ok(widths[2] / total <= 0.26, `근거 열 share ${(widths[2] / total).toFixed(2)}`)
    assert.ok(widths[1] / total >= 0.5, `내용 열 share ${(widths[1] / total).toFixed(2)}`)
    // 내용 열 본문 셀은 한 줄에 들어가도 LEFT(장문 열 관행), 단계 열은 CENTER
    const hdr = await zip.file("Contents/header.xml")!.async("string")
    const alignOf = (text: string) => { const at = tbl.indexOf(`<hp:t>${text}`); const pid = tbl.slice(tbl.lastIndexOf("<hp:p ", at)).match(/paraPrIDRef="(\d+)"/)![1]; return hdr.match(new RegExp(`<hh:paraPr id="${pid}"[^>]*>[\\s\\S]*?horizontal="(\\w+)"`))![1] }
    assert.equal(alignOf("지원대상 기준 정비"), "LEFT")
    assert.equal(alignOf("1단계"), "CENTER")
  })
})
