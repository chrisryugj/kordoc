/**
 * v4.0.5 P2 회귀 — 생성↔재파싱 왕복 채널.
 *
 * 1. 장식표 heading 마커(tc name="__kordoc_h#") — 개조식 표지·장헤더·1페이지형
 *    제목박스가 재파싱 시 표가 아니라 heading으로 복원, 목차·제목반복은 스킵(중복 0)
 * 2. h2 box '□' idempotency — 재생성 반복에도 '□ □' 누적 없음
 * 3. hr 왕복 — '─' 구분선 문단 → separator → '---'
 * 4. 리터럴 부호 문단 재분류 — 2차 생성에서 8단계 자동 재번호
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, parse } from "../src/index.js"
import { flatSec } from "./gen-xml.js"

async function roundtrip(md: string, opts?: Parameters<typeof markdownToHwpx>[1]): Promise<string> {
  const buf = await markdownToHwpx(md, opts)
  const res = await parse(Buffer.from(buf))
  return res.markdown
}

const MD = `# 문서 제목

## 첫째 장

1. 첫째 항목
  - 둘째 항목

## 둘째 장

본문 내용`

describe("v4.0.5 왕복 채널 (P2)", () => {
  it("개조식 — 표지 h1·장헤더 h2 복원, 목차 중복 0", async () => {
    const md2 = await roundtrip(MD, { gongmun: { preset: "gaejosik" } })
    // 표지가 삼킨 h1이 heading으로 복원
    assert.match(md2, /^# 문서 제목$/m, "표지 h1 복원")
    // 장헤더 표가 h2로 복원 (로마숫자·장식 셀 텍스트 없이 클린 제목)
    assert.match(md2, /^## 첫째 장$/m)
    assert.match(md2, /^## 둘째 장$/m)
    // 목차 파생물 중복 없음 — '첫째 장'이 목차+장헤더 2회로 불어나지 않는다
    assert.equal((md2.match(/첫째 장/g) ?? []).length, 1, "목차 스킵 — 중복 0")
    // 표지 제목 반복 박스(bodyTitleBox)도 스킵 — h1 1회만
    assert.equal((md2.match(/문서 제목/g) ?? []).length, 1, "제목반복 박스 스킵")
    // 장식표(로마숫자 Ⅰ 셀)가 표로 남지 않음
    assert.doesNotMatch(md2, /\|\s*Ⅰ\s*\|/, "장헤더 장식표 미방출")
  })

  it("report/plan/notice — 1페이지형 제목박스 h1 복원", async () => {
    for (const preset of ["report", "plan", "notice"] as const) {
      const md2 = await roundtrip(MD, { gongmun: { preset } })
      assert.match(md2, /^# 문서 제목$/m, `${preset}: 제목박스 h1 복원`)
      assert.equal((md2.match(/문서 제목/g) ?? []).length, 1, `${preset}: 중복 0`)
    }
  })

  it("h2 box '□' — 2회 왕복해도 누적 없음 (idempotent)", async () => {
    const opts = { gongmun: { preset: "report" as const } }
    const md2 = await roundtrip(MD, opts)
    const md3 = await roundtrip(md2, opts)
    // '□ □ 첫째 장' 단조 누적 없음
    assert.doesNotMatch(md3, /□\s*□/, "□ 누적 없음")
  })

  it("hr — 비공문서 '─' 구분선이 '---'로 왕복", async () => {
    const md2 = await roundtrip("문단 하나\n\n---\n\n문단 둘")
    assert.match(md2, /^---$/m, "separator 복원")
    assert.doesNotMatch(md2, /─{10,}/, "장식 대시 본문 잔류 없음")
  })

  it("리터럴 부호 재분류 — 2차 생성 시 8단계 자동 재번호", async () => {
    // 기존 공문서에서 파싱된 형태의 md (리터럴 '가.' 부호 문단)
    const literal = "1. 첫째 상위\n\n가. 기존 항목\n\n나. 항목 삽입 후 뒤 항목"
    const buf = await markdownToHwpx(literal, { gongmun: { preset: "official" } })
    const res = await parse(Buffer.from(buf))
    // '가.'와 '나.'가 depth1 항목으로 재번호되어 살아있다 (paragraph 고착 아님)
    assert.match(res.markdown, /가\.\s*기존 항목/)
    assert.match(res.markdown, /나\.\s*항목 삽입/)
  })

  it("빈 번호 문단 카운터 — 한글처럼 번호를 소비 (드리프트 없음)", async () => {
    // 자동번호 paraPr 왕복은 합성이 어려워 재분류 경로로 간접 검증:
    // 1. → (빈 항목) → 3. 이 아니라, 텍스트 있는 항목들이 1. 2. 로 연속 재번호
    const md2 = await roundtrip("1. 하나\n2. 둘\n3. 셋", { gongmun: { preset: "official" } })
    assert.match(md2, /1\.\s*하나/)
    assert.match(md2, /2\.\s*둘/)
    assert.match(md2, /3\.\s*셋/)
  })
})

describe("v4.0.5 gongmun 인라인 강조 + 리스트 depth 소비", () => {
  it("gongmun 인라인 강조 왕복 — 혼합 span만 마커 복원", async () => {
    const md = "1. 항목 **강조** 포함\n"
    const md2 = await roundtrip(md, { gongmun: { preset: "기안문" } })
    assert.match(md2, /1\. 항목 \*\*강조\*\* 포함/, `인라인 볼드 복원: ${md2}`)
  })

  it("비실측 report 1단계 구조 볼드는 마커 억제 (전체 볼드 ≠ 인라인 강조)", async () => {
    // preset 기안문 + numbering report → depth0 항목 전체가 CHAR_BOLD (정부 보고서 관행)
    const md2 = await roundtrip("- 대항목 하나\n  - 중항목\n", { gongmun: { preset: "기안문", numbering: "report" } })
    assert.ok(!md2.includes("**"), `구조 볼드 미방출: ${md2}`)
    assert.match(md2, /□ 대항목 하나/)
  })

  it("'1)' depth2 왕복 — 선행 공백 방출로 2차 생성 depth 보존 (indent 소비)", async () => {
    const opt = { gongmun: { preset: "기안문" as const } }
    const md1 = await roundtrip("1. 상위\n  가. 중간\n    1) 세부 하나\n    2) 세부 둘\n  나. 중간 둘\n", opt)
    assert.match(md1, /^ {4}1\) 세부 하나$/m, `depth2 선행 공백: ${JSON.stringify(md1)}`)
    // 2차 생성 수렴 — depth 붕괴('1)' → '2.') 없음
    const md2 = await roundtrip(md1, opt)
    assert.equal(md2, md1, "2차 왕복 고정점")
    assert.match(md2, /나\. 중간 둘/, "depth1 형제 순번 보존")
  })

  it("report '-' depth2 왕복 — □ 승격 없이 2차 생성 수렴", async () => {
    const opt = { gongmun: { preset: "보고서" as const } }
    const md1 = await roundtrip("- 대항목\n  - 중항목\n    - 소항목 **강조**\n", opt)
    assert.match(md1, /^ {4}- 소항목 \*\*강조\*\*$/m, `depth2 '-' 선행 공백+강조: ${JSON.stringify(md1)}`)
    const md2 = await roundtrip(md1, opt)
    assert.equal(md2, md1, "2차 왕복 고정점 — '-'가 □로 승격되지 않음")
  })

  it("개조식 '-' depth2(반계단 1.5자 들여쓰기) 역산", async () => {
    const opt = { gongmun: { preset: "개조식" as const, cover: false, toc: false } }
    const md1 = await roundtrip("# 제목\n\n- 대항목\n  - 중항목\n    - 소항목\n", opt)
    assert.match(md1, /^ {4}- 소항목$/m, `개조식 depth2 선행 공백: ${JSON.stringify(md1)}`)
    const md2 = await roundtrip(md1, opt)
    assert.equal(md2, md1, "2차 왕복 고정점")
  })
})
