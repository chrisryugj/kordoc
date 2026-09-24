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
import { isDotFragment, joinDigitGroups, joinLeaderItems, restoreBulletItems, restoreSymbols, smartQuotes } from "../src/ocr/postprocess.js"

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

describe("restoreSymbols — 추출기 표기 환각", () => {
  it("\"(cid:NN)\" 은 지운다 (티끌\u00b7가는 막대 박스 환각)", () => {
    assert.equal(restoreSymbols("(cid:)"), "")
    assert.equal(restoreSymbols("8,000 (cid:12)"), "8,000 ")
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

describe("joinLeaderItems — 목차 한 줄 잇기", () => {
  // 검출기는 목차 줄의 리더 가운데를 비워 [제목 …][… 12] 두 박스로 낸다 — 텍스트층처럼 한 아이템으로 잇는다.
  // 두 박스로 두면 줄마다 큰 틈이 생겨 클러스터 표 감지가 목차를 표로 잡고 2단 본문을 섞어 읽었다(assembly-minutes-1179)
  const it0 = (text: string, x: number, w: number, y = 100, h = 20) => ({ text, x, y, w, h, confidence: 0.9 })
  it("쪽번호 쪽이 리더로 시작하면(lead) 같은 줄 왼쪽 이웃에 붙는다", () => {
    const title = it0("1. 청원서 심사보고 시정의 건", 100, 400), page = it0("\u20261", 900, 40, 102, 16)
    const other = it0("다음 줄", 100, 200, 160)
    const out = joinLeaderItems([title, page, other], new Map([[page, { lead: true, trail: false }]]))
    assert.equal(out.length, 2)
    assert.equal(out[0].text, "1. 청원서 심사보고 시정의 건 \u2026 1")
    assert.equal(out[0].x, 100)
    assert.equal(out[0].x + out[0].w, 940)
  })
  it("제목 쪽이 리더로 끝나면(trail) 오른쪽 이웃을 당겨 붙인다", () => {
    const title = it0("Ⅱ. 대내외 여건 \u2026", 100, 600), page = it0("4", 900, 20)
    const out = joinLeaderItems([title, page], new Map([[title, { lead: false, trail: true }]]))
    assert.equal(out.length, 1)
    assert.equal(out[0].text, "Ⅱ. 대내외 여건 \u2026 4")
  })
  it("리더 표시 없는 아이템끼리는 잇지 않는다", () => {
    const a = it0("구분", 100, 60), b = it0("내용", 400, 60)
    assert.equal(joinLeaderItems([a, b], new Map()).length, 2)
  })
  it("리더를 못 찾은 줄도 이은 목차 줄 둘 이상의 쪽번호 열에 맞는 숫자면 잇는다 (잡음에 점이 덜 잡힌 줄)", () => {
    const t1 = it0("1. 목적 \u2026 1", 100, 840, 100), t2 = it0("2. 적용 범위 \u2026 1", 100, 840, 140)
    const title = it0("3. 근거\u2026", 100, 150, 180), page = it0("\u20262", 915, 25, 182, 16)
    const out = joinLeaderItems([t1, t2, title, page], new Map())
    assert.equal(out.length, 3)
    assert.equal(out[2].text, "3. 근거 \u2026 2")
  })
  it("쪽번호 열에 안 맞거나 숫자가 아니면 그대로 둔다", () => {
    const t1 = it0("1. 목적 \u2026 1", 100, 840, 100), t2 = it0("2. 적용 범위 \u2026 1", 100, 840, 140)
    const a = it0("구분", 100, 60, 180), b = it0("12", 500, 30, 180)
    const c = it0("구분", 100, 60, 220), d = it0("내용", 900, 40, 220)
    assert.equal(joinLeaderItems([t1, t2, a, b, c, d], new Map()).length, 6)
  })
})
