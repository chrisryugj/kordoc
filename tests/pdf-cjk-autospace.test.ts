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
  })
  it("keeps real spaces and leaves Hangul alone", () => {
    assert.equal(isCjkLatinAutospace("鐘路区", "1", 5.6, 10), false)
    assert.equal(isCjkLatinAutospace("鐘路区", "1", 4.5, 10), false)
    assert.equal(isCjkLatinAutospace("中", "H", 3.0, 10, true), false) // 한글 줄 "中 H형강"
    assert.equal(isCjkLatinAutospace("제", "1", 2.0, 10), false)
    assert.equal(isCjkLatinAutospace("Ltd.,", "大韓民国", 5.6, 10), false)
  })
})
