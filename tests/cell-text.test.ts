import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cellTextToString, type TextItem } from "../src/pdf/line-detector.js"
import { WrapLexicon } from "../src/pdf/line-wrap.js"

/** 헬퍼: 텍스트 아이템 생성 */
function ti(text: string, x: number, y: number, w = 30, fontSize = 12): TextItem {
  return { text, x, y, w, h: fontSize, fontSize, fontName: "Test" }
}

describe("cellTextToString", () => {
  it("빈 배열 → 빈 문자열", () => {
    assert.equal(cellTextToString([]), "")
  })

  it("소수점에서 꺾인 괄호 수는 잇는다 (\"(△12,428.\" / \"3)\" → \"(△12,428.3)\", 해외직접투자 증감률 칸)", () => {
    const box = { box: { x1: 300, x2: 345 } }
    assert.equal(cellTextToString([ti("(△12,428.", 302, 500, 40), ti("3)", 302, 486, 10)], box), "(△12,428.3)")
    // 글이 든 줄 끝 마침표 뒤 번호 줄은 그대로
    assert.equal(cellTextToString([ti("기준 1.", 302, 500, 30), ti("3)", 302, 486, 10)], box), "기준 1.\n3)")
  })

  it("두 음절 배분 정렬 칸은 붙인다 (\"중  동\" → \"중동\") — 보통 띄어쓰기 간격의 두 낱말은 그대로", () => {
    // 한컴 배분 정렬: 두 음절 사이가 글자폭의 2배 넘게 벌어진다 (건설업조사 보도자료 지역별 표 "중 동"·"유 럽")
    const lex = new WrapLexicon()
    lex.addLine("올해 중동에서 수주가 늘었다")
    const box = { box: { x1: 68, x2: 128 }, lex }
    assert.equal(cellTextToString([ti("중", 72.84, 175, 12), ti("동", 111.24, 175, 12)], box), "중동")
    assert.equal(cellTextToString([ti("그", 72, 175, 12), ti("외", 87, 175, 12)], box), "그 외")
    // 공백을 친 채 배분한 좁은 칸 "과 장" (간격 1.0배) — 원문에 공백이 있다
    assert.equal(cellTextToString([ti("과", 348.8, 175, 12), ti("장", 372.8, 175, 12)], { box: { x1: 345, x2: 388 }, lex }), "과 장")
    // 본문에 한 어절로 안 나오는 "성명"(서식 이름표 "성  명") — 그대로
    assert.equal(cellTextToString([ti("성", 106.9, 175, 12.7), ti("명", 154.5, 175, 12.7)], { box: { x1: 103, x2: 171 }, lex }), "성 명")
    // 넓은 칸 가운데 공백을 쳐서 벌린 "내  용" — 칸 폭을 채우지 않는다
    assert.equal(cellTextToString([ti("내", 130, 175, 12), ti("용", 160, 175, 12)], { box: { x1: 60, x2: 240 }, lex }), "내 용")
  })

  it("시도 이름표(\"서  울\")는 본문 어휘 증거 없이도 붙인다 — 표 머리글 \"전  체\" 는 원고에서 띄어 쓰기도 해 그대로", () => {
    const lex = new WrapLexicon()
    lex.addLine("건설공사액은 전년 대비 감소했다")
    const box = { box: { x1: 68, x2: 128 }, lex }
    assert.equal(cellTextToString([ti("서", 72.84, 175, 12), ti("울", 111.24, 175, 12)], box), "서울")
    assert.equal(cellTextToString([ti("전", 72.84, 175, 12), ti("체", 111.24, 175, 12)], box), "전 체")
  })

  it("단일 아이템 → 그대로 반환", () => {
    assert.equal(cellTextToString([ti("안녕", 10, 100)]), "안녕")
  })

  it("같은 행의 아이템들이 합쳐짐", () => {
    const items = [ti("대한", 10, 100), ti("민국", 50, 100)]
    const result = cellTextToString(items)
    assert.ok(result.includes("대한") && result.includes("민국"))
  })

  it("한글 간 작은 갭(< fontSize*0.3) → 공백 없이 병합", () => {
    // fontSize=12, 0.3*12=3.6pt. 갭 = 40 - 10 - 30 = 0 < 3.6
    const items = [ti("기", 10, 100, 30, 12), ti("준", 40, 100, 30, 12)]
    const result = cellTextToString(items)
    assert.equal(result, "기준", "한글 작은 갭은 공백 없이 연결")
  })

  it("한글 간 큰 갭(> fontSize*0.3) → 공백 삽입", () => {
    // fontSize=12, 갭 = 80 - 10 - 30 = 40 > 3.6
    const items = [ti("이름", 10, 100, 30, 12), ti("주소", 80, 100, 30, 12)]
    const result = cellTextToString(items)
    assert.equal(result, "이름 주소")
  })

  it("줄바꿈 병합: 짧은 한글 조각 (5자 이하) → 이전 줄에 연결", () => {
    // y=100 (위), y=80 (아래) — "전자여" + "권" = "전자여권"
    const items = [ti("전자여", 10, 100), ti("권", 10, 80)]
    const result = cellTextToString(items)
    assert.equal(result, "전자여권")
  })

  it("줄바꿈 병합: 8자 이하 한글 조각도 병합", () => {
    const items = [ti("대한민국", 10, 100), ti("여권번호", 10, 80)]
    const result = cellTextToString(items)
    // "여권번호" = 4자 (8자 이하) → 병합
    assert.equal(result, "대한민국여권번호")
  })

  it("줄바꿈 병합: 9자 이상은 별도 줄로 유지", () => {
    const items = [ti("대한민국", 10, 100), ti("여권번호가들어갑니다", 10, 80)]
    const result = cellTextToString(items)
    assert.ok(result.includes("\n"), "9자 이상 텍스트는 줄바꿈 유지")
  })

  it("줄바꿈 병합: 공백 포함 한글은 병합하지 않음", () => {
    const items = [ti("대한민국", 10, 100), ti("서울 강남", 10, 80)]
    const result = cellTextToString(items)
    assert.ok(result.includes("\n"), "공백 포함 텍스트는 줄바꿈 유지")
  })

  it("단독 1글자 한글 (조사) → 이전 줄에 연결", () => {
    // "기준" + "을" → "기준을"
    const items = [ti("기준", 10, 100), ti("을", 10, 80)]
    const result = cellTextToString(items)
    assert.equal(result, "기준을")
  })
})
