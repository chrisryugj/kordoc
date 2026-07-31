/**
 * 모호 라벨 거부 가드(fillWithUniqueGuard)와 누름틀의 상호작용 회귀 테스트.
 *
 * 누름틀 name은 서식 제작자가 선언한 계약이라 같은 이름이 여러 곳에 있어도 모호가
 * 아니다. 라벨 추정 매칭과 같이 집계하면 동명 누름틀 서식(머리말·본문에 같은 필드)이
 * require_unique 에서 통째로 거부돼 한 곳도 채워지지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ValueCursor, fillWithUniqueGuard, normalizeLabel } from "../src/form/match.js"
import { fillClickHereInXml } from "../src/form/click-here.js"
import type { FillValue, FormField } from "../src/types.js"

const clickHere = (id: number, name: string) =>
  `<hp:p><hp:run><hp:ctrl><hp:fieldBegin id="${id}" type="CLICK_HERE" name="${name}"/></hp:ctrl>` +
  `<hp:t>여기를 누르세요</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="${id}"/></hp:ctrl></hp:run></hp:p>`

const toCursor = (vals: Record<string, FillValue>) =>
  new ValueCursor(new Map(Object.entries(vals).map(([k, v]) => [normalizeLabel(k), v])))

const runOn = (xml: string) => (vals: Record<string, FillValue>, blocked?: Set<string>) => {
  const out = fillClickHereInXml(xml, toCursor(vals), blocked)
  return { filled: out.filled, xml: out.xml }
}

describe("fillWithUniqueGuard — 누름틀", () => {
  it("동명 누름틀 2곳을 모두 채운다 (거부하지 않는다)", async () => {
    const xml = `<hs:sec xmlns:hp="x">${clickHere(1, "제목")}${clickHere(2, "제목")}</hs:sec>`
    const r = await fillWithUniqueGuard({ 제목: "2026년 사업계획" }, runOn(xml))
    assert.deepEqual(r.rejected, [])
    assert.equal(r.filled.length, 2)
    assert.ok(r.xml, "치환된 XML이 있어야 한다")
    assert.ok(r.filled.every((f: FormField) => f.value === "2026년 사업계획"))
  })

  it("누름틀 filled에 source 표시가 실린다", () => {
    const xml = `<hs:sec xmlns:hp="x">${clickHere(1, "제목")}</hs:sec>`
    const out = fillClickHereInXml(xml, toCursor({ 제목: "값" }))
    assert.equal(out.filled[0].source, "clickhere")
  })

  it("라벨 추정 매칭의 다중 등장은 종전대로 거부한다", async () => {
    // 누름틀이 아닌 경로(source 없음)를 흉내낸 run — 같은 키가 2곳에 매칭됨
    const run = (vals: Record<string, FillValue>) => ({
      filled: Object.keys(vals).flatMap((label) =>
        [0, 1].map((row) => ({ label, value: String(vals[label]), row, col: 1, key: normalizeLabel(label) })),
      ),
    })
    const r = await fillWithUniqueGuard({ 성명: "홍길동" }, run)
    assert.deepEqual(r.rejected, ["성명"])
  })
})
