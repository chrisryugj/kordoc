/**
 * buildTableGrids 적층 표 분리 단위 테스트 (v4.0.6 회귀).
 *
 * 회귀 1: 위아래로 붙은 별개 표 두 개(채용공고 머리 스트립+응시원서 본표)가 경계
 * 수평선 하나를 공유하면 Union-Find가 한 그룹으로 묶어 22x10류 프랑켄 그리드가
 * 되고, 공유 경계선 위 vertex가 반대편 표의 수직선 x를 날라 열 경계도 오염되던 것.
 *
 * 회귀 2: 분리 신호(관통 수직선 없음)를 물리 세그먼트로 판정하면, 외곽 수직선을
 * 섹션별로 쪼개 그은 단일 표(nrich 지원서 — 세그먼트가 정확히 맞닿음)가 섹션
 * 경계마다 산산조각 나던 것 — 체인 뷰(맞닿은 세그먼트를 논리 수직선으로) 판정.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTableGrids } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 1 })

describe("buildTableGrids — 적층 표 분리 (v4.0.6 회귀)", () => {
  it("한 셀의 밑줄이 오른쪽 테두리에 닿아도 행으로 나누지 않는다", () => {
    const horizontals = [
      h(760, 58, 539), h(735, 58, 539), h(84, 58, 539),
      ...[518, 493, 468, 442, 417, 392, 367, 342, 316].map(y => h(y, 314, 538)),
    ]
    const verticals = [v(58, 84, 760), v(300, 84, 760), v(539, 84, 760)]
    const grids = buildTableGrids(horizontals, verticals)
    assert.equal(grids.length, 1)
    assert.deepEqual(grids[0].rowYs, [760, 735, 84])
    assert.deepEqual(grids[0].colXs, [58, 300, 539])
  })

  it("경계선을 공유한 머리 스트립+본표를 두 그리드로 분리하고 열 경계 오염을 막는다", () => {
    // pair05 응시원서 실측 축소: 스트립(1행, 내부 구분 x=200·300)이 본표(3행,
    // 내부 구분 x=150·350) 위에 경계선 y=600을 공유하고 얹힘. 수직선은 각자
    // 영역에서 끊기며 사이에 실간격(스트립 601.5 vs 본표 598.5 = 3pt)이 있다.
    const horizontals = [
      h(650, 100, 500), // 스트립 상변
      h(600, 100, 500), // 공유 경계 (스트립 하변 = 본표 상변)
      h(500, 100, 500),
      h(400, 100, 500),
      h(300, 100, 500), // 본표 하변
    ]
    const verticals = [
      // 스트립: 좌우 테두리 + 내부 구분 2
      v(100, 601.5, 650), v(500, 601.5, 650), v(200, 601.5, 650), v(300, 601.5, 650),
      // 본표: 좌우 테두리 + 내부 구분 2 (스트립과 다른 열 구조)
      v(100, 300, 598.5), v(500, 300, 598.5), v(150, 300, 598.5), v(350, 300, 598.5),
    ]
    const grids = buildTableGrids(horizontals, verticals)
    assert.equal(grids.length, 2, "스트립과 본표가 별개 그리드여야 함")
    const [strip, main] = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)
    assert.equal(strip.rowYs.length - 1, 1)
    assert.deepEqual(strip.colXs, [100, 200, 300, 500], "스트립 열에 본표 구분선(150·350) 유입 금지")
    assert.equal(main.rowYs.length - 1, 3)
    assert.deepEqual(main.colXs, [100, 150, 350, 500], "본표 열에 스트립 구분선(200·300) 유입 금지")
  })

  it("외곽 수직선이 섹션별 세그먼트로 쪼개진 단일 표는 분리하지 않는다 (체인 뷰)", () => {
    // pair10 지원서 실측 축소: 좌우 외곽선이 y=450에서 정확히 맞닿는 두 세그먼트로
    // 그려짐. 섹션 경계 y=450은 전폭 수평선 + 내부 수직선 구조가 위아래로 다르지만
    // (위 x=200, 아래 x=380) 맞닿은 외곽 세그먼트 체인이 관통하므로 한 표다.
    const horizontals = [
      h(600, 100, 500),
      h(500, 100, 500),
      h(450, 100, 500), // 섹션 경계 (전폭)
      h(350, 100, 500),
      h(250, 100, 500),
    ]
    const verticals = [
      // 좌우 외곽 — 섹션별 세그먼트 (gap 0으로 맞닿음)
      v(100, 450, 600), v(100, 250, 450),
      v(500, 450, 600), v(500, 250, 450),
      // 섹션별 내부 구분 (서로 다른 열 구조)
      v(200, 450, 600),
      v(380, 250, 450),
    ]
    const grids = buildTableGrids(horizontals, verticals)
    assert.equal(grids.length, 1, "세그먼트 외곽선 단일 표를 절단하면 안 됨")
    assert.equal(grids[0].rowYs.length - 1, 4)
  })

  it("한 표 내부의 전폭 구조변화 경계(연속 외곽선 관통)는 분리하지 않는다", () => {
    // 응시원서 섹션 헤더류: 외곽 수직선이 표 전체를 한 획으로 관통
    const horizontals = [
      h(600, 100, 500),
      h(450, 100, 500), // 전폭 구조변화 경계
      h(300, 100, 500),
    ]
    const verticals = [
      v(100, 300, 600), v(500, 300, 600), // 연속 외곽
      v(250, 450, 600), // 위 구간 내부
      v(400, 300, 450), // 아래 구간 내부
    ]
    const grids = buildTableGrids(horizontals, verticals)
    assert.equal(grids.length, 1)
  })
})
