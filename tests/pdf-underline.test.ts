import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markUnderlineItems, wrapUnderlineRuns } from "../src/pdf/underline.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

// 밑줄 = baseline 바로 아래 밀착한 얇은 수평선. 표 괘선 오탐 방어 4겹
// (수직선 접촉·동일 스팬 반복·런 union 밀착·컬럼급 구멍) 검증.

const item = (text: string, x: number, y: number, w: number, h = 12): NormItem =>
  ({ text, x, y, w, h, fontSize: h, fontName: "Test", isHidden: false })

const hline = (x1: number, x2: number, y: number, lineWidth = 0.5): LineSegment =>
  ({ x1, y1: y, x2, y2: y, lineWidth })

const vline = (x: number, y1: number, y2: number, lineWidth = 0.5): LineSegment =>
  ({ x1: x, y1, x2: x, y2, lineWidth })

describe("markUnderlineItems — 기본 매칭", () => {
  it("baseline 2pt 아래 선 → underline 마킹", () => {
    const items = [item("밑줄 제목", 100, 700, 80)]
    markUnderlineItems(items, [hline(98, 182, 698)], [])
    assert.equal(items[0].underline, true)
  })

  it("CJK 전각 박스 하단(0.6em 아래) 선도 마킹", () => {
    const items = [item("한글밑줄", 100, 700, 80, 12)]
    markUnderlineItems(items, [hline(99, 181, 700 - 7.2)], [])
    assert.equal(items[0].underline, true)
  })

  it("허용 깊이(0.72em)보다 깊은 선은 미마킹 — 아랫줄 영역", () => {
    const items = [item("본문", 100, 700, 80, 12)]
    markUnderlineItems(items, [hline(99, 181, 700 - 10)], [])
    assert.equal(items[0].underline, undefined)
  })

  it("글자 중심을 지나는 선(취소선 영역)은 밑줄 아님", () => {
    const items = [item("삭제 텍스트", 100, 700, 80, 12)]
    markUnderlineItems(items, [hline(99, 181, 704.8)], [])
    assert.equal(items[0].underline, undefined)
  })

  it("굵은 선(>2pt)은 배경 채움/테두리 — 미마킹", () => {
    const items = [item("제목", 100, 700, 80)]
    markUnderlineItems(items, [hline(98, 182, 698, 3.0)], [])
    assert.equal(items[0].underline, undefined)
  })

  it("텍스트 없는 밑줄(폼 빈칸)은 무해 통과", () => {
    const items = [item("이름:", 100, 700, 30)]
    markUnderlineItems(items, [hline(140, 300, 698)], [])
    assert.equal(items[0].underline, undefined)
  })
})

describe("markUnderlineItems — 표 괘선 오탐 방어", () => {
  it("수직선이 접촉하는 수평선(셀 하변)은 미마킹", () => {
    const items = [item("셀 텍스트", 100, 700, 80)]
    const verticals = [vline(98, 690, 715), vline(182, 690, 715)]
    markUnderlineItems(items, [hline(98, 182, 698)], verticals)
    assert.equal(items[0].underline, undefined)
  })

  it("텍스트 union을 크게 벗어나는 전폭 구분선은 미마킹", () => {
    const items = [item("제목", 100, 700, 60)]
    markUnderlineItems(items, [hline(50, 500, 698)], [])
    assert.equal(items[0].underline, undefined)
  })

  it("매칭 런 사이 컬럼급 구멍 → 표 행 괘선으로 판정, 미마킹", () => {
    const items = [item("좌측", 100, 700, 40), item("우측", 400, 700, 40)]
    markUnderlineItems(items, [hline(98, 442, 698)], [])
    assert.equal(items[0].underline, undefined)
    assert.equal(items[1].underline, undefined)
  })

  it("동일 스팬 수평선 3+ 레벨 반복(수평 괘선 서식) → 미마킹", () => {
    const items = [
      item("첫 행 텍스트", 100, 700, 200),
      item("둘째 행 텍스트", 100, 675, 200),
      item("셋째 행 텍스트", 100, 650, 200),
    ]
    const rules = [hline(95, 305, 698), hline(95, 305, 673), hline(95, 305, 648)]
    markUnderlineItems(items, rules, [])
    for (const i of items) assert.equal(i.underline, undefined)
  })

  it("상하변이 마주보는 배지/칩 박스(라운드 모서리)의 하변은 미마킹", () => {
    // 라운드 배지: 상하변만 직선으로 추출되고 좌우변은 곡선이라 수직선이 없다
    const items = [item("일반", 500, 700, 24)]
    const rules = [hline(495, 530, 698), hline(495, 530, 712)]
    markUnderlineItems(items, rules, [])
    assert.equal(items[0].underline, undefined)
  })

  it("위쪽에 폭이 크게 다른 선(표 하변 등)이 있어도 밑줄은 유지", () => {
    const items = [item("개정 문구", 100, 700, 80)]
    const rules = [hline(98, 182, 698), hline(50, 550, 715)]
    markUnderlineItems(items, rules, [])
    assert.equal(items[0].underline, true)
  })

  it("단어 간격 수준의 다중 런은 하나의 밑줄로 마킹", () => {
    const items = [item("개정", 100, 700, 24), item("조문", 130, 700, 24)]
    markUnderlineItems(items, [hline(99, 155, 698)], [])
    assert.equal(items[0].underline, true)
    assert.equal(items[1].underline, true)
  })
})

describe("wrapUnderlineRuns — <u> 래핑", () => {
  it("연속 run은 하나의 <u>...</u>로 감싼다", () => {
    const items = [item("개정", 100, 700, 24), item("조문", 130, 700, 24)]
    for (const i of items) i.underline = true
    wrapUnderlineRuns(items)
    assert.equal(items[0].text, "<u>개정")
    assert.equal(items[1].text, "조문</u>")
  })

  it("같은 줄에서 1em 넘게 떨어진 구간은 별도 run — 사이 텍스트 오염 방지", () => {
    const items = [item("앞구간", 100, 700, 40), item("뒷구간", 300, 700, 40)]
    for (const i of items) i.underline = true
    wrapUnderlineRuns(items)
    assert.equal(items[0].text, "<u>앞구간</u>")
    assert.equal(items[1].text, "<u>뒷구간</u>")
  })

  it("마킹 없는 아이템은 건드리지 않는다", () => {
    const items = [item("본문", 100, 700, 40)]
    wrapUnderlineRuns(items)
    assert.equal(items[0].text, "본문")
  })
})
