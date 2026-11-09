import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractImageRegions } from "../src/pdf/image-regions.js"

describe("PDF 이미지 가시 영역", () => {
  it("기존 OCR용 영역은 원래 그림 bbox를 유지한다", () => {
    assert.deepEqual(extractImageRegions([OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject],
      [[[OPS.rectangle], [10, 10, 2, 2]], [], [], [100, 0, 0, 100, 0, 0], []]), [{ x1: 0, y1: 0, x2: 100, y2: 100 }])
  })
  it("clip 사각형으로 큰 그림을 자르고 save/restore에서 clip도 복원한다", () => {
    const fn = [OPS.save, OPS.constructPath, OPS.eoClip, OPS.endPath, OPS.save, OPS.transform, OPS.paintImageXObject,
      OPS.restore, OPS.restore, OPS.transform, OPS.paintImageXObject]
    const args = [[], [[OPS.rectangle], [528, 0, 264, 612]], [], [], [], [564, 0, 0, 738, 364, -63], [],
      [], [], [20, 0, 0, 20, 10, 10], []]
    assert.deepEqual(extractImageRegions(fn, args, true), [{ x1: 528, y1: 0, x2: 792, y2: 612 }, { x1: 10, y1: 10, x2: 30, y2: 30 }])
  })
  it("중첩 clip은 교집합이며 완전히 가려진 그림은 영역을 만들지 않는다", () => {
    const fn = [OPS.constructPath, OPS.clip, OPS.endPath, OPS.constructPath, OPS.eoClip, OPS.endPath, OPS.transform, OPS.paintImageXObject]
    const args = [[[OPS.rectangle], [10, 10, 20, 20]], [], [], [[OPS.rectangle], [20, 20, 20, 20]], [], [], [50, 0, 0, 50, 0, 0], []]
    assert.deepEqual(extractImageRegions(fn, args, true), [{ x1: 20, y1: 20, x2: 30, y2: 30 }])
    args[6] = [5, 0, 0, 5, 0, 0]
    assert.deepEqual(extractImageRegions(fn, args, true), [])
  })
  it("변환된 clip 좌표를 그림 변환과 따로 계산한다", () => {
    const fn = [OPS.transform, OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject]
    const args = [[2, 0, 0, 2, 10, 10], [[OPS.rectangle], [5, 5, 10, 10]], [], [], [30, 0, 0, 30, 0, 0], []]
    assert.deepEqual(extractImageRegions(fn, args, true), [{ x1: 20, y1: 20, x2: 40, y2: 40 }])
  })
  it("clip 없는 획 사각형은 그림을 자르지 않는다", () => {
    assert.deepEqual(extractImageRegions([OPS.constructPath, OPS.stroke, OPS.transform, OPS.paintImageXObject],
      [[[OPS.rectangle], [10, 10, 2, 2]], [], [100, 0, 0, 100, 0, 0], []], true), [{ x1: 0, y1: 0, x2: 100, y2: 100 }])
  })
  it("복합 clip 경로를 마지막 사각형 하나로 오인하지 않는다", () => {
    const fn = [OPS.constructPath, OPS.constructPath, OPS.clip, OPS.endPath, OPS.transform, OPS.paintImageXObject]
    const args = [[[OPS.rectangle], [0, 0, 10, 10]], [[OPS.rectangle], [90, 90, 10, 10]], [], [], [100, 0, 0, 100, 0, 0], []]
    assert.deepEqual(extractImageRegions(fn, args, true), [{ x1: 0, y1: 0, x2: 100, y2: 100 }])
  })
})
