/**
 * OCR 후처리 (postprocess.ts) — 사전 밖 공문서 기호 복원·둥근 따옴표·점류 조각.
 *
 * 잠근 계약:
 *  1. ○ 글머리: 줄 머리 O/o(+공백)+한글만 ○ — "OECD"·"0원"·"ㅇ 글머리"는 그대로
 *  2. ○○ 자리표시: 라틴 글자와 붙지 않은 O 2개+ 가 한글과 이웃
 *  3. △: 모델이 내는 ∆(U+2206)·Δ(U+0394) → △
 *  4. 따옴표: 줄 안 짝 여닫음, 연도 생략 '24 → ’24, 홀수 개는 첫 따옴표 자리로 판정
 *  5. 점류 조각(리더·잡티)만 폐기 — "-"·":"·"•"·"1." 은 뜻이 있으니 유지
 *  6. 제 박스로 떨어진 글머리 "O" 는 같은 줄 오른쪽 이웃이 한글로 시작할 때만 ○
 *  7. 천 단위 숫자 안의 쉼표 뒤 공백만 제거 — 목록 "1, 2, 3"·"10, 20명"은 그대로
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreSymbols, smartQuotes, isDotFragment, restoreBulletItems, joinDigitGroups } from "../src/ocr/postprocess.js"

describe("restoreSymbols — 사전 밖 기호 복원", () => {
  it("줄 머리 O/o + 한글 → ○", () => {
    assert.equal(restoreSymbols("O사회적경제 육성"), "○사회적경제 육성")
    assert.equal(restoreSymbols("o 추진계획"), "○ 추진계획")
  })
  it("라틴 약어·숫자·ㅇ 글머리는 그대로", () => {
    assert.equal(restoreSymbols("OECD 국가"), "OECD 국가")
    assert.equal(restoreSymbols("0원"), "0원")
    assert.equal(restoreSymbols("ㅇ 주요 세목"), "ㅇ 주요 세목")
    assert.equal(restoreSymbols("Office 365"), "Office 365")
  })
  it("○○ 자리표시", () => {
    assert.equal(restoreSymbols("OO시 OOO 과장"), "○○시 ○○○ 과장")
    assert.equal(restoreSymbols("GOOD 사례"), "GOOD 사례")
  })
  it("∆·Δ → △ (감액 표시)", () => {
    assert.equal(restoreSymbols("∆1,240"), "△1,240")
    assert.equal(restoreSymbols("Δ25,684"), "△25,684")
  })
})

describe("smartQuotes — 둥근 따옴표", () => {
  it("띄어쓰기 없는 짝도 여닫음", () => {
    assert.equal(smartQuotes("지침내에서'기록관리시스템'이라는"), "지침내에서‘기록관리시스템’이라는")
    assert.equal(smartQuotes("'플랫폼')으로"), "‘플랫폼’)으로")
  })
  it("연도 생략은 ’ 이고 짝 셈에서 빠진다", () => {
    assert.equal(smartQuotes("('24년 25회)"), "(’24년 25회)")
    assert.equal(smartQuotes("'NFC' ('11.3월 구성)"), "‘NFC’ (’11.3월 구성)")
  })
  it("홀수 개: 첫 따옴표가 여는 자리가 아니면 닫는 것부터", () => {
    assert.equal(smartQuotes("결제'또는"), "결제’또는")
    assert.equal(smartQuotes("'모바일 결제"), "‘모바일 결제")
  })
  it("큰따옴표", () => {
    assert.equal(smartQuotes('"인용" 끝'), "“인용” 끝")
  })
})

describe("isDotFragment — 점류 조각", () => {
  it("리더·잡티는 참", () => {
    for (const t of [".", "..", "…", "·", " . ", "ㆍ", "…·."]) assert.equal(isDotFragment(t), true, t)
  })
  it("뜻 있는 기호·글자는 거짓", () => {
    for (const t of ["1.", "-", ":", "•", "가.", "※"]) assert.equal(isDotFragment(t), false, t)
  })
})

describe("restoreBulletItems — 떨어진 글머리 O", () => {
  const item = (text: string, x: number, y = 100) => ({ text, x, y, w: text.length * 30, h: 30 })
  it("오른쪽 이웃이 한글로 시작하면 ○", () => {
    const items = [item("O", 100), item("사회적경제 육성", 140)]
    restoreBulletItems(items)
    assert.equal(items[0].text, "○")
  })
  it("이웃이 없거나 라틴·멀리 떨어짐·다른 줄이면 그대로", () => {
    const a = [item("O", 100)]
    restoreBulletItems(a)
    assert.equal(a[0].text, "O")
    const b = [item("O", 100), item("KAIST", 140)]
    restoreBulletItems(b)
    assert.equal(b[0].text, "O")
    const c = [item("O", 100), item("사업", 400)]
    restoreBulletItems(c)
    assert.equal(c[0].text, "O", "글자 높이 3배 넘게 떨어짐")
    const d = [item("O", 100, 100), item("사업", 140, 200)]
    restoreBulletItems(d)
    assert.equal(d[0].text, "O", "다른 줄")
  })
})

describe("joinDigitGroups — 천 단위 숫자 공백", () => {
  it("쉼표 뒤 공백 제거", () => {
    assert.equal(joinDigitGroups("385, 426"), "385,426")
    assert.equal(joinDigitGroups("4,802, 164"), "4,802,164")
    assert.equal(joinDigitGroups("△1,157, 683 천원"), "△1,157,683 천원")
  })
  it("천 단위가 아니면 그대로", () => {
    assert.equal(joinDigitGroups("1, 2, 3"), "1, 2, 3")
    assert.equal(joinDigitGroups("10, 20명"), "10, 20명")
    assert.equal(joinDigitGroups("2021, 2022년"), "2021, 2022년")
    assert.equal(joinDigitGroups("1,234, 5678"), "1,234, 5678")
  })
})
