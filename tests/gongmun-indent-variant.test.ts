/**
 * v4.0.5 P1-1 회귀 — 두 자리 이상 부호('10.'·'10)'·'(10)') 항목의 둘째 줄 내어쓰기.
 *
 * depth 공용 paraPr는 대표 부호('1.') 폭으로 내어쓰기가 고정돼, 10번째+ 항목의
 * 둘째 줄이 내용 첫 글자보다 ~0.55타 왼쪽으로 어긋났다. (depth, 부호폭) 전용
 * 변형 paraPr(GONGMUN_LIST_VARIANT_BASE+)를 문서별로 발급해 자기 부호폭에 정렬한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { precomputeGongmunList } from "../src/hwpx/gen-gongmun-fit.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { resolveGongmun, markerWidth, levelIndent } from "../src/hwpx/gongmun.js"
import { GONGMUN_LIST_BASE, GONGMUN_LIST_VARIANT_BASE } from "../src/hwpx/gen-ids.js"

async function parts(buf: ArrayBuffer): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(buf)
  return {
    header: await zip.file("Contents/header.xml")!.async("text"),
    section: await zip.file("Contents/section0.xml")!.async("text"),
  }
}

/** header에서 paraPr id의 hc:intent 값 추출 */
function intentOf(header: string, paraPrId: number): number {
  const m = header.match(new RegExp(`<hh:paraPr id="${paraPrId}"[\\s\\S]*?<hc:intent value="(-?\\d+)"`))
  assert.ok(m, `paraPr ${paraPrId} 존재`)
  return Number(m![1])
}

const items12 = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${i + 1}번째 항목 내용`).join("\n")

describe("v4.0.5 두 자리 부호 내어쓰기 회귀 (P1-1)", () => {
  it("선계산 — 10번째+ 항목에만 indentVariant 부여, 폭은 자기 부호 실폭", () => {
    const blocks = parseMarkdownToBlocks(items12)
    const g = resolveGongmun({ preset: "official" })
    const plan = precomputeGongmunList(blocks, g)
    const infos = blocks.map((_, i) => plan.items.get(i)).filter(Boolean)
    assert.equal(infos.length, 12)
    for (let i = 0; i < 9; i++) assert.equal(infos[i]!.indentVariant, undefined, `${i + 1}. 은 공용 paraPr`)
    for (let i = 9; i < 12; i++) assert.notEqual(infos[i]!.indentVariant, undefined, `${i + 1}. 은 변형 paraPr`)
    // '10.'~'12.' 는 같은 폭 → 같은 변형 하나만 발급
    assert.equal(plan.indentVariants.length, 1)
    assert.equal(plan.indentVariants[0].depth, 0)
    assert.equal(plan.indentVariants[0].widthHu, markerWidth("10.", g.bodyHeight))
  })

  it("생성 — '10.' 항목은 자기 부호폭 내어쓰기 paraPr, '9.'는 대표 부호폭 (v5 레지스트리)", async () => {
    const buf = await markdownToHwpx(items12, { gongmun: { preset: "official" } })
    const { header, section } = await parts(buf)
    const g = resolveGongmun({ preset: "official" })
    const rep = markerWidth("1.", g.bodyHeight)
    const wide = markerWidth("10.", g.bodyHeight)
    assert.ok(wide > rep, "두 자리 부호가 대표 부호보다 넓다")
    const intentOfText = (text: string) => {
      const pid = section.slice(section.lastIndexOf("<hp:p ", section.indexOf(text))).match(/paraPrIDRef="(\d+)"/)![1]
      return Number(header.match(new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?<hc:intent value="(-?\\d+)"`))![1])
    }
    assert.equal(intentOfText("10. 10번째"), -wide)
    assert.equal(intentOfText("9. 9번째"), -rep)
  })

  it("중첩 '(10)'·'10)' 도 각 depth 변형 발급 + 두 자리 없는 문서는 미발급", () => {
    const g = resolveGongmun({ preset: "official" })
    // depth2('1)')에 10개 이상 — v4.0.5 리스트 depth가 들여쓰기 스택 기준이 되어
    // 실제 2단 중첩으로 depth2 도달 (4칸 단독 점프는 이제 depth1)
    const deep = ["1. 상위", "  - 중간"].concat(
      Array.from({ length: 11 }, (_, i) => `    - ${i + 1}) 자리`),
    ).join("\n")
    const blocks = parseMarkdownToBlocks(deep)
    const plan = precomputeGongmunList(blocks, g)
    assert.ok(plan.indentVariants.some((v) => v.depth >= 1), "하위 depth 변형 발급")
    const plain = precomputeGongmunList(parseMarkdownToBlocks("1. 하나\n2. 둘"), g)
    assert.equal(plain.indentVariants.length, 0, "두 자리 항목 없으면 변형 0 — 기존 산출물 불변")
  })

  it("보고서 불릿(report)은 순번 무관 고정 부호 — 변형 미발급", () => {
    const g = resolveGongmun({ preset: "report" })
    const plan = precomputeGongmunList(parseMarkdownToBlocks(items12), g)
    assert.equal(plan.indentVariants.length, 0)
  })
})
