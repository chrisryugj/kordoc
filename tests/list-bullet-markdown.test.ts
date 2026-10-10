/** 목록 블록 Markdown — 글이 이미 목록 부호로 시작하면 부호를 또 붙이지 않는다 (src/table/builder.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blocksToMarkdown } from "../src/table/builder.js"

describe("list block markdown", () => {
  it("does not double a dash bullet already in the text", () => {
    // PDF 목록 감지는 "- 영업보고" 줄을 부호째 목록 블록으로 둔다 — "- - 영업보고" 가 되던 것 (rhwp issue_157)
    assert.equal(blocksToMarkdown([{ type: "list", listType: "unordered", text: "- 영업보고" }]).trim(), "- 영업보고")
  })

  it("keeps the number of an evenly spaced numbered item (여수 업무계획 목차 \"13. 농 업 기 술 센 터\")", () => {
    // 균등배분 접기가 번호 뒤 공백까지 지워 "13.농업기술센터" → 번호 목록이 아닌 줄로 보고 "1. " 를 또 붙였다
    assert.equal(blocksToMarkdown([{ type: "list", listType: "ordered", text: "13. 농 업 기 술 센 터\t525" }]).trim(), "13. 농업기술센터\t525")
    assert.equal(blocksToMarkdown([{ type: "paragraph", text: "현 장 대 응 단 장" }]).trim(), "현장대응단장")
  })

  it("still prefixes other bullet symbols and plain items", () => {
    assert.equal(blocksToMarkdown([{ type: "list", listType: "unordered", text: "○ 추진 배경" }]).trim(), "- ○ 추진 배경")
    assert.equal(blocksToMarkdown([{ type: "list", listType: "unordered", text: "항목" }]).trim(), "- 항목")
  })
})

describe("list block footnote", () => {
  it("renders footnoteText of a list item like a paragraph", () => {
    // PDF 각주를 목록 항목에 붙이면 빌더가 목록 경로에서 footnoteText 를 버려 각주 글이 사라졌다 (DOCX 목록 항목 각주도 같음)
    assert.equal(blocksToMarkdown([{ type: "list", listType: "unordered", text: "- 추가경정예산을 편성한다2)", footnoteText: "2) 지방자치법 제145조" }]).trim(),
      "- 추가경정예산을 편성한다2) (주: 2) 지방자치법 제145조)")
  })
})
