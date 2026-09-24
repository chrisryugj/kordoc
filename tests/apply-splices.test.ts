/**
 * applySplices 선형화 (v4.15.0) — 종전 "뒤에서부터 slice+치환+slice" 는 splice 마다 전체를 복사해 큰 섹션
 * (1,020만 자·2.7만 splice)의 patch·fill·seal 이 32초였다. 결과가 종전 알고리즘과 같은지, 큰 입력이 빠른지 본다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { applySplices, type SpliceEdit } from "../src/roundtrip/source-map.js"

/** 종전 구현 그대로 — 대조 기준 */
function applySplicesOld(xml: string, splices: SpliceEdit[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error("소스맵 splice 범위 겹침 — 내부 오류")
  }
  let result = xml
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    result = result.slice(0, s.start) + s.replacement + result.slice(s.end)
  }
  return result
}

/** 결정적 난수 (시드 고정) */
function rng(seed: number): () => number {
  let x = seed
  return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32)
}

describe("applySplices — 선형 재구성", () => {
  it("무작위 splice(같은 자리 삽입·맞닿은 범위 포함)에서 종전 결과와 같다", () => {
    const rand = rng(20260924)
    for (let t = 0; t < 300; t++) {
      const xml = Array.from({ length: 40 + Math.floor(rand() * 60) }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
      const splices: SpliceEdit[] = []
      let pos = 0
      while (pos < xml.length) {
        pos += Math.floor(rand() * 6)
        if (pos > xml.length) break
        const len = rand() < 0.3 ? 0 : Math.floor(rand() * 4)
        const end = Math.min(xml.length, pos + len)
        splices.push({ start: pos, end, replacement: rand() < 0.5 ? "" : `<${t}:${pos}>` })
        if (rand() < 0.2) splices.push({ start: end, end, replacement: "+" }) // 맞닿은 삽입
        pos = end
      }
      for (let i = splices.length - 1; i > 0; i--) { // 넣은 순서 섞기 — 같은 시작의 삽입 순서는 정렬 안정성이 정한다
        if (rand() < 0.3 && splices[i].start !== splices[i - 1].start) [splices[i], splices[i - 1]] = [splices[i - 1], splices[i]]
      }
      assert.equal(applySplices(xml, splices), applySplicesOld(xml, splices), `t=${t}`)
    }
  })

  it("겹치는 범위는 종전처럼 내부 오류", () => {
    assert.throws(() => applySplices("abcdef", [{ start: 0, end: 3, replacement: "" }, { start: 2, end: 4, replacement: "" }]), /겹침/)
    assert.throws(() => applySplices("abcdef", [{ start: 0, end: 3, replacement: "" }, { start: 1, end: 1, replacement: "x" }]), /겹침/)
  })

  it("200만 자·2만 splice 가 1초 안 (종전 구현 3.5초, 선형 5ms — 이 기계 실측)", () => {
    const unit = "<hp:linesegarray><hp:lineseg/></hp:linesegarray><hp:t>본문</hp:t>"
    const xml = unit.repeat(Math.ceil(2_000_000 / unit.length))
    const splices: SpliceEdit[] = []
    for (let at = xml.indexOf("<hp:linesegarray>"); at >= 0 && splices.length < 20_000; at = xml.indexOf("<hp:linesegarray>", at + 1)) {
      splices.push({ start: at, end: at + "<hp:linesegarray><hp:lineseg/></hp:linesegarray>".length, replacement: "" })
    }
    const t0 = performance.now()
    const out = applySplices(xml, splices)
    const ms = performance.now() - t0
    assert.equal(out.length, xml.length - splices.length * "<hp:linesegarray><hp:lineseg/></hp:linesegarray>".length)
    assert.ok(ms < 1000, `${ms.toFixed(0)}ms`)
  })
})
