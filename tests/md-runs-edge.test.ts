/**
 * v4.0.5 마크다운 파싱 부채 회귀 — md-runs.ts 4건.
 * 리스트 depth 들여쓰기 스택 · GFM 표 빈 데이터 행 · 여러 줄 인용문 조인 ·
 * 언더스코어 강조 단어 내부 비활성.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseMarkdownToBlocks, parseInlineMarkdown } from "../src/hwpx/md-runs.js"

/** 리스트 블록만 골라 indent 시퀀스 추출 */
function listIndents(md: string): number[] {
  return parseMarkdownToBlocks(md).filter(b => b.type === "list_item").map(b => b.indent ?? -1)
}

describe("v4.0.5 리스트 중첩 depth 회귀", () => {
  it("2칸 그리드 입력 depth 완전 불변 (gongmun 8단계 계약)", () => {
    const md = "- a\n  - b\n    - c\n      - d\n    - e\n  - f\n- g"
    assert.deepEqual(listIndents(md), [0, 1, 2, 3, 2, 1, 0])
  })

  it("4칸 한 단계 = depth 1씩 (2로 튀지 않음)", () => {
    assert.deepEqual(listIndents("- a\n    - b\n        - c"), [0, 1, 2])
  })

  it("탭 들여쓰기 자식이 형제로 붕괴하지 않음", () => {
    assert.deepEqual(listIndents("- a\n\t- b\n\t\t- c"), [0, 1, 2])
  })

  it("2칸/4칸/탭 혼합 입력이 같은 위계", () => {
    const two = listIndents("- a\n  - b\n    - c\n  - d")
    const four = listIndents("- a\n    - b\n        - c\n    - d")
    const tab = listIndents("- a\n\t- b\n\t\t- c\n\t- d")
    assert.deepEqual(four, two)
    assert.deepEqual(tab, two)
  })

  it("들여쓰기 감소 = 매칭 조상 레벨로 복귀", () => {
    assert.deepEqual(listIndents("- a\n    - b\n        - c\n    - d\n- e"), [0, 1, 2, 1, 0])
  })

  it("빈 줄은 run 유지, 다른 블록은 스택 초기화", () => {
    // 빈 줄을 사이에 둔 항목은 같은 위계 유지
    assert.deepEqual(listIndents("- a\n    - b\n\n    - c"), [0, 1, 1])
    // 문단이 끼면 새 run — 4칸 첫 항목은 종전 그리드 시드(÷2)로 depth 2
    assert.deepEqual(listIndents("- a\n    - b\n\n문단\n\n    - c"), [0, 1, 2])
  })

  it("ordered·marker 산출은 종전 그대로", () => {
    const blocks = parseMarkdownToBlocks("2. 하나\n\t- 둘").filter(b => b.type === "list_item")
    assert.deepEqual(blocks.map(b => [b.ordered, b.marker, b.text]), [
      [true, "2.", "하나"],
      [false, "-", "둘"],
    ])
  })
})

describe("v4.0.5 GFM 표 빈 데이터 행 회귀", () => {
  it("전부 빈 행 |  |  | 포함 4행이 4행으로 파싱", () => {
    const md = "| 가 | 나 |\n| --- | --- |\n|  |  |\n| 다 | 라 |\n| 마 | 바 |"
    const tables = parseMarkdownToBlocks(md).filter(b => b.type === "table")
    assert.equal(tables.length, 1)
    assert.deepEqual(tables[0].rows, [["가", "나"], ["", ""], ["다", "라"], ["마", "바"]])
  })

  it("구분행(:--- · ---: · :-:)은 여전히 스킵", () => {
    const md = "| a | b | c |\n| :--- | ---: | :-: |\n| 1 | 2 | 3 |"
    const tables = parseMarkdownToBlocks(md).filter(b => b.type === "table")
    assert.deepEqual(tables[0].rows, [["a", "b", "c"], ["1", "2", "3"]])
  })
})

describe("v4.0.5 여러 줄 인용문 조인 회귀", () => {
  it("공백줄 없는 연속 > 2줄 → 블록 1개 (개행 결합 — 줄 경계 보존)", () => {
    const quotes = parseMarkdownToBlocks("> 첫 줄 참고\n> 둘째 줄 참고").filter(b => b.type === "blockquote")
    assert.equal(quotes.length, 1)
    assert.equal(quotes[0].text, "첫 줄 참고\n둘째 줄 참고")
  })

  it("빈 > 줄 사이 두 인용 → 블록 2개", () => {
    const quotes = parseMarkdownToBlocks("> 하나\n>\n> 둘").filter(b => b.type === "blockquote")
    assert.deepEqual(quotes.map(q => q.text), ["하나", "둘"])
  })

  it("단일 줄 인용은 종전 그대로 블록 1개", () => {
    const quotes = parseMarkdownToBlocks("> 인용 참고").filter(b => b.type === "blockquote")
    assert.deepEqual(quotes.map(q => q.text), ["인용 참고"])
  })
})

describe("v4.0.5 언더스코어 단어내부 강조 회귀", () => {
  it("snake_case 밑줄쌍이 이탤릭으로 오염·삭제되지 않음", () => {
    const spans = parseInlineMarkdown("post_id 와 user_id 컬럼")
    assert.ok(spans.every(s => !s.italic && !s.bold), "강조 span 없음")
    assert.equal(spans.map(s => s.text).join(""), "post_id 와 user_id 컬럼")
  })

  it("던더(__init__)가 bold로 오염되지 않음", () => {
    const spans = parseInlineMarkdown("파이썬 __init__은 특별 메서드")
    assert.ok(spans.every(s => !s.bold && !s.italic), "강조 span 없음")
    assert.equal(spans.map(s => s.text).join(""), "파이썬 __init__은 특별 메서드")
  })

  it("정상 _강조_·__굵게__ 는 계속 동작", () => {
    const it1 = parseInlineMarkdown("이것은 _강조_ 입니다")
    assert.deepEqual(it1.filter(s => s.italic).map(s => s.text), ["강조"])
    const b1 = parseInlineMarkdown("이것은 __굵게__ 표시")
    assert.deepEqual(b1.filter(s => s.bold).map(s => s.text), ["굵게"])
  })

  it("*·** 강조는 불변 (단어 붙음 포함)", () => {
    const spans = parseInlineMarkdown("*이탤릭*과 **볼드**를 지원")
    assert.deepEqual(spans.filter(s => s.italic && !s.bold).map(s => s.text), ["이탤릭"])
    assert.deepEqual(spans.filter(s => s.bold).map(s => s.text), ["볼드"])
  })
})

describe("중첩 강조 회귀 — **a *b* c** 가 별 리터럴로 오염되던 문제", () => {
  const flags = (s: { bold: boolean; italic: boolean; code: boolean }) =>
    `${s.bold ? "B" : ""}${s.italic ? "I" : ""}${s.code ? "C" : ""}`

  it("굵게 안 기울임: **굵게 *기울임* 다시**", () => {
    const spans = parseInlineMarkdown("**굵게 *기울임* 다시**")
    assert.deepEqual(spans.map(s => [s.text, flags(s)]), [
      ["굵게 ", "B"], ["기울임", "BI"], [" 다시", "B"],
    ])
  })

  it("기울임 안 굵게: *기울임 **굵게** 다시*", () => {
    const spans = parseInlineMarkdown("*기울임 **굵게** 다시*")
    assert.deepEqual(spans.map(s => [s.text, flags(s)]), [
      ["기울임 ", "I"], ["굵게", "BI"], [" 다시", "I"],
    ])
  })

  it("별 강조 안 언더스코어 (교차 중첩): **a _u_ b** · __a *i* b__", () => {
    assert.deepEqual(parseInlineMarkdown("**a _u_ b**").map(s => [s.text, flags(s)]), [
      ["a ", "B"], ["u", "BI"], [" b", "B"],
    ])
    assert.deepEqual(parseInlineMarkdown("__a *i* b__").map(s => [s.text, flags(s)]), [
      ["a ", "B"], ["i", "BI"], [" b", "B"],
    ])
  })

  it("굵게 안 인라인 코드는 코드 서식 유지: **`code` 안**", () => {
    assert.deepEqual(parseInlineMarkdown("**`code` 안**").map(s => [s.text, flags(s)]), [
      ["code", "C"], [" 안", "B"],
    ])
  })

  it("기존 단독 강조·***셋다***·이스케이프 불변", () => {
    assert.deepEqual(parseInlineMarkdown("***셋다***").map(s => [s.text, flags(s)]), [["셋다", "BI"]])
    assert.deepEqual(parseInlineMarkdown("평문 **굵게** 뒤 *기울임*").map(s => [s.text, flags(s)]), [
      ["평문 ", ""], ["굵게", "B"], [" 뒤 ", ""], ["기울임", "I"],
    ])
    assert.deepEqual(parseInlineMarkdown("\\*리터럴\\* **굵게**").map(s => [s.text, flags(s)]), [
      ["*리터럴* ", ""], ["굵게", "B"],
    ])
  })

  it("미닫힘 굵게는 종전 폴백 그대로 (파싱 폭주 없음)", () => {
    const spans = parseInlineMarkdown("**미닫힘 *기울임*")
    assert.equal(spans.map(s => s.text).join(""), "*미닫힘 기울임*")
    assert.ok(spans.every(s => !s.bold))
  })
})
