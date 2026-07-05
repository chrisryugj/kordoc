/**
 * closeOpenTableEdges (개방변 표 테두리 합성) 단위 테스트.
 *
 * 회귀: 끝점 정렬 그룹핑이 폭만 보고 y-간격 제약이 없어, 위아래로 쌓인 두 개방변 표를
 * yMin~yMax 관통 가상 수직테두리로 "용접"하고 사이 본문을 거대 병합셀로 흡수하던 자료손상.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { closeOpenTableEdges, preprocessLines } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"

const h = (y: number): LineSegment => ({ x1: 100, y1: y, x2: 500, y2: y, lineWidth: 0.5 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })

describe("closeOpenTableEdges — 상하 스택 표 용접 방지", () => {
  it("스택된 두 개방변 표를 사이 본문 관통 테두리로 용접하지 않는다", () => {
    // 표 A: y660/680/700, 표 B: y560/580/600 (둘 다 x100~500, 좌우 테두리 없음)
    // 사이 본문 프로즈: y600~660
    const horizontals = [h(560), h(580), h(600), h(660), h(680), h(700)]
    const verticals = [v(300, 560, 600), v(300, 660, 700)]  // 각 표의 내부 수직선
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))

    // 프로즈 간격(600~660)을 관통하는 합성 테두리가 없어야 한다 (용접 금지)
    const welds = synth.filter(s => s.y1 <= 600 && s.y2 >= 660)
    assert.equal(welds.length, 0, `표 사이를 용접하는 테두리 발생: ${JSON.stringify(welds)}`)
    // 각 표는 개별적으로 닫혀야 한다 (표당 좌우 2개 → 4개)
    assert.equal(synth.length, 4, `표별 좌우 테두리가 합성돼야 함: ${JSON.stringify(synth)}`)
    // 합성 테두리는 표 A(660~700) 또는 표 B(560~600) 한쪽에만 걸쳐야 함
    for (const s of synth) {
      const inB = s.y1 >= 560 - 1 && s.y2 <= 600 + 1
      const inA = s.y1 >= 660 - 1 && s.y2 <= 700 + 1
      assert.ok(inA || inB, `테두리가 한 표 안에 있어야 함: ${JSON.stringify(s)}`)
    }
  })

  it("연속 단일 개방변 표에는 y-간격 분할이 발동하지 않는다 (무회귀)", () => {
    // 균일 간격(20) 단일 표 — 분할 없이 표 전체를 닫는 좌우 테두리 2개
    const horizontals = [h(600), h(620), h(640), h(660)]
    const verticals = [v(300, 600, 660)]
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))

    assert.equal(synth.length, 2, `단일 표는 좌우 테두리 2개: ${JSON.stringify(synth)}`)
    for (const s of synth) {
      assert.ok(s.y1 <= 601 && s.y2 >= 659, `테두리가 표 전체(600~660)를 닫아야 함: ${JSON.stringify(s)}`)
    }
  })

  it("한 행만 유난히 큰 간격은 분할하지 않는다 (한쪽 괘선 수 부족)", () => {
    // 3줄 + 큰 간격 + 1줄: 아래쪽이 최소 괘선 수(3) 미만이라 쪼개지 않음 → 단일 표 유지
    const horizontals = [h(600), h(620), h(640), h(760)]
    const verticals = [v(300, 600, 760)]
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))
    // 분할되지 않고 전체 y범위(600~760)를 닫는 테두리
    const spanning = synth.filter(s => s.y1 <= 601 && s.y2 >= 759)
    assert.ok(spanning.length >= 1, `단일 표로 유지돼 전체를 닫아야 함: ${JSON.stringify(synth)}`)
  })

  it("병합 큰 행에 관통 수직선이 있으면 분할하지 않는다 (pline-1)", () => {
    // 위 3괘선 + 병합 큰 행(140~200, 60pt) + 아래 3괘선. 병합 셀 좌우 구분선이 밴드를
    // 관통하면 표 내부이므로 단일 표로 유지 — 정당한 개방변 표를 두 표로 절단하던 회귀 방지.
    const horizontals = [h(100), h(120), h(140), h(200), h(220), h(240)]
    const verticals = [v(300, 100, 240)]
    const result = closeOpenTableEdges(horizontals, verticals)
    const synth = result.filter(s => !verticals.includes(s))
    const spanning = synth.filter(s => s.y1 <= 101 && s.y2 >= 239)
    assert.ok(spanning.length >= 1, `병합 행 관통 수직선이 있으면 단일 표(y100~240): ${JSON.stringify(synth)}`)
  })
})

describe("dropShadingStacks — 플러시 테두리 삼킴 방지 (리뷰 #12)", () => {
  const hl = (y: number, w: number): LineSegment => ({ x1: 100, y1: y, x2: 500, y2: y, lineWidth: w })

  it("스택과 x범위·근접이 동일해도 폭이 다른 말단 테두리는 살린다", () => {
    const stack: LineSegment[] = []
    for (let i = 0; i < 20; i++) stack.push(hl(101.5 + i * 0.5, 0.1))
    const lines = [hl(100, 0.75), ...stack, hl(112.5, 0.75)] // 패딩 0 글상자 상하변
    const { horizontals } = preprocessLines(lines, [])
    const ys = horizontals.map(l => l.y1)
    assert.ok(ys.includes(100), "상변 테두리가 스택과 함께 드랍됨")
    assert.ok(ys.includes(112.5), "하변 테두리가 스택과 함께 드랍됨")
    assert.ok(!ys.some(y => y > 101 && y < 112), "그라디언트 스택은 드랍돼야 함")
  })

  it("폭까지 같아도 내부 pitch보다 크게 벌어진 말단은 테두리로 살린다", () => {
    const stack: LineSegment[] = []
    for (let i = 0; i < 20; i++) stack.push(hl(101.5 + i * 0.5, 0.1))
    const lines = [hl(100, 0.1), ...stack] // 같은 0.1pt 폭, 1.5pt 간격(내부 0.5pt의 3배)
    const { horizontals } = preprocessLines(lines, [])
    assert.ok(horizontals.some(l => l.y1 === 100), "pitch-이질 말단이 드랍됨")
  })

  it("순수 스택(테두리 없음)은 기존대로 전부 드랍", () => {
    const stack: LineSegment[] = []
    for (let i = 0; i < 26; i++) stack.push(hl(200 + i * 0.5, 0.1))
    const { horizontals } = preprocessLines(stack, [])
    assert.equal(horizontals.length, 0)
  })

  it("동폭이어도 fromFill 스택 사이 stroke 테두리는 살린다 (pline-3)", () => {
    // 그라디언트 밴드를 fill rect 스택으로 그리면 fill 선분이 마지막 stroke 폭(0.75)을
    // 상속해 테두리와 동폭이 된다 — 폭 판별만으론 상하변을 못 살린다. fromFill 로 구분.
    const stack: LineSegment[] = []
    for (let i = 0; i < 20; i++) stack.push({ x1: 100, y1: 101.5 + i * 0.5, x2: 500, y2: 101.5 + i * 0.5, lineWidth: 0.75, fromFill: true })
    const top: LineSegment = { x1: 100, y1: 100.9, x2: 500, y2: 100.9, lineWidth: 0.75, fromFill: false }
    const bot: LineSegment = { x1: 100, y1: 112.1, x2: 500, y2: 112.1, lineWidth: 0.75, fromFill: false }
    const { horizontals } = preprocessLines([top, ...stack, bot], [])
    const ys = horizontals.map(l => l.y1)
    assert.ok(ys.includes(100.9), "상변 stroke 테두리 보존(동폭이어도 fromFill 구분)")
    assert.ok(ys.includes(112.1), "하변 stroke 테두리 보존")
    assert.ok(!ys.some(y => y > 101 && y < 112), "fill 스택은 드랍")
  })
})
