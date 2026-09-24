/** parsePageRange 유틸 단위 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parsePageRange, hasRequestedPagesAfter } from "../src/page-range.js"

describe("hasRequestedPagesAfter", () => {
  it("작은 범위에서는 기존 파서의 관대한 문법·반올림·클램핑과 결과가 같다", () => {
    const specs: Array<string | number[]> = [
      "", " ", "1-10", "0-3", "9-2", "1 - 4, 8", "3abc,5.9,6-foo", "+7,-2,foo", "99", "1,1,4",
      [], [0, 1, 3.4, 3.5, 11], [NaN, Infinity, -Infinity, 7.6],
    ]
    for (const spec of specs) for (const total of [0, 1, 5, 10]) for (const after of [0, 1, 3, 5, 10]) {
      assert.equal(hasRequestedPagesAfter(spec, after, total), [...parsePageRange(spec, total)].some(p => p > after), JSON.stringify({ spec, after, total }))
    }
  })

  it("10억 쪽 범위도 열거하지 않고 상한 이후 요청 여부를 판정한다", () => {
    assert.equal(hasRequestedPagesAfter("1-1000000000", 5000, 1_000_000_000), true)
    assert.equal(hasRequestedPagesAfter("1-5000", 5000, 1_000_000_000), false)
    assert.equal(hasRequestedPagesAfter("5001-1000000000", 5000, 5000), false)
    assert.equal(hasRequestedPagesAfter("1000000000-5001", 5000, 1_000_000_000), false)
    assert.equal(hasRequestedPagesAfter([5000.49, 5000.5], 5000, 5001), true)
    assert.equal(hasRequestedPagesAfter("5001suffix", 5000, 5001), true)
  })
})

describe("parsePageRange", () => {
  describe("배열 입력", () => {
    it("숫자 배열 → Set 변환", () => {
      const result = parsePageRange([1, 2, 3], 10)
      assert.deepEqual([...result].sort(), [1, 2, 3])
    })

    it("범위 밖 값 클램핑", () => {
      const result = parsePageRange([0, 1, 5, 11], 5)
      assert.deepEqual([...result].sort(), [1, 5])
    })

    it("빈 배열 → 빈 Set", () => {
      const result = parsePageRange([], 10)
      assert.equal(result.size, 0)
    })

    it("중복 제거", () => {
      const result = parsePageRange([1, 1, 2, 2], 10)
      assert.equal(result.size, 2)
    })

    it("소수점 반올림", () => {
      const result = parsePageRange([1.4, 2.6], 10)
      assert.ok(result.has(1))
      assert.ok(result.has(3))
    })
  })

  describe("문자열 입력", () => {
    it("단일 범위 '1-3'", () => {
      const result = parsePageRange("1-3", 10)
      assert.deepEqual([...result].sort(), [1, 2, 3])
    })

    it("개별 번호 '1,3,5'", () => {
      const result = parsePageRange("1,3,5", 10)
      assert.deepEqual([...result].sort(), [1, 3, 5])
    })

    it("혼합 '1,3,5-7'", () => {
      const result = parsePageRange("1,3,5-7", 10)
      assert.deepEqual([...result].sort(), [1, 3, 5, 6, 7])
    })

    it("공백 포함 '1 - 3, 5'", () => {
      const result = parsePageRange("1 - 3, 5", 10)
      assert.deepEqual([...result].sort(), [1, 2, 3, 5])
    })

    it("범위 초과 클램핑", () => {
      const result = parsePageRange("1-100", 5)
      assert.deepEqual([...result].sort(), [1, 2, 3, 4, 5])
    })

    it("빈 문자열 → 빈 Set", () => {
      const result = parsePageRange("", 10)
      assert.equal(result.size, 0)
    })

    it("공백만 → 빈 Set", () => {
      const result = parsePageRange("   ", 10)
      assert.equal(result.size, 0)
    })

    it("잘못된 형식 무시", () => {
      const result = parsePageRange("abc,1,xyz", 10)
      assert.deepEqual([...result], [1])
    })
  })

  describe("경계값", () => {
    it("maxPages 0 → 빈 Set", () => {
      const result = parsePageRange([1, 2], 0)
      assert.equal(result.size, 0)
    })

    it("maxPages 1, 범위 '1-1'", () => {
      const result = parsePageRange("1-1", 1)
      assert.deepEqual([...result], [1])
    })

    it("역순 범위 '3-1' → 빈 (start > end이면 아무것도 안 넣음)", () => {
      const result = parsePageRange("3-1", 10)
      assert.equal(result.size, 0)
    })
  })
})
