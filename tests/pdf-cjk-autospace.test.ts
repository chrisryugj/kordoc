/** 한자·가나와 라틴·숫자 사이 자동 간격은 공백이 아니다 (LibreOffice·Word 일본어·중국어 문서, kpipa 계약서) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isCjkLatinAutospace } from "../src/pdf/text-line.js"

describe("isCjkLatinAutospace", () => {
  it("treats a narrow gap between kanji/kana and digits as no space", () => {
    assert.equal(isCjkLatinAutospace("第", "1", 2.0, 10), true)
    assert.equal(isCjkLatinAutospace("1", "番地", 2.2, 10), true)
    // 0.3em 공백 글리프로 찍힌 자동 간격도 ("第⏎3者" 3.00pt/10pt)
    assert.equal(isCjkLatinAutospace("第", "3", 3.0, 10), true)
    assert.equal(isCjkLatinAutospace("前払金", "USD", 3.0, 10), true)
    // 전각 문장부호 옆·밑줄 표지 너머도 같은 자동 간격 (kpipa 일문 "したり、 e-Book" 1.17pt, "ごとに <u>2部ずつ</u>")
    assert.equal(isCjkLatinAutospace("出版したり、", "e-Book(", 1.17, 10), true)
    assert.equal(isCjkLatinAutospace("各刷ごとに", "<u>2部ずつ</u>", 2.0, 10), true)
    assert.equal(isCjkLatinAutospace("請求内訳書", "(Invoice)に", 1.0, 10), true)
    // 따로 선 괄호 아이템 — "著作権の表記面" "(" "版権ページ" ")" "及び"
    assert.equal(isCjkLatinAutospace("著作権の表記面", "(", 1.0, 10), true)
    assert.equal(isCjkLatinAutospace(")", "及び公衆配信物", 1.0, 10), true)
    // 중·일문 글자·전각 부호·곡선 따옴표끼리 좁은 틈 (중문 계약서 "（Proprietor） ，与海外"·"附属权 ”）")
    assert.equal(isCjkLatinAutospace("（Proprietor）", "，与海外", 2.0, 11), true)
    assert.equal(isCjkLatinAutospace("（以下称“附属权", "”）产生的收入", 2.0, 11), true)
  })
  it("keeps real spaces and leaves Hangul alone", () => {
    assert.equal(isCjkLatinAutospace("鐘路区", "1", 5.6, 10), false)
    assert.equal(isCjkLatinAutospace("鐘路区", "1", 4.5, 10), false)
    assert.equal(isCjkLatinAutospace("中", "H", 3.0, 10, true), false) // 한글 줄 "中 H형강"
    assert.equal(isCjkLatinAutospace("제", "1", 2.0, 10), false)
    assert.equal(isCjkLatinAutospace("Ltd.,", "大韓民国", 5.6, 10), false)
    assert.equal(isCjkLatinAutospace("出版社", "对本著作物", 5.0, 11), false) // 0.35em 넘는 틈은 그대로(기입 빈칸)
  })
})

describe("반올림 전 좌표 공백 규칙 — 제작기", () => {
  it("한글 문서를 Microsoft Print To PDF 로 찍은 PDF·LibreOffice PDF 도 쓴다 (폭 0 공백 글리프 \"지원(1 인당\")", async () => {
    const { isPreciseGapProducer: isPrintedToPdf } = await import("../src/pdf/parser.js")
    assert.equal(isPrintedToPdf({ Producer: "Microsoft: Print To PDF" }), true)
    assert.equal(isPrintedToPdf({ Producer: "LibreOffice 26.2.3.2 (AARCH64)" }), true)
    assert.equal(isPrintedToPdf({ Producer: "Microsoft® Word 2016" }), false)
    assert.equal(isPrintedToPdf({}), false)
  })
})
