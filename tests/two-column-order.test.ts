import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectColumnGutter, orderByGutter, type ColRect } from "../src/pdf/two-column.js"
import { extractPageBlocksFallback } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"

/**
 * #64 — 2단 시험지 읽기 순서. 좌표 모델은 이슈 제보 블록 덤프(2026학년도 수능
 * 물리학Ⅰ 4p) 실측 기하를 따른다: 좌단 x≈88~405, 우단 x≈437~754, 거터 x≈420.
 */

function rect(x: number, y: number, w: number, h: number): ColRect {
  return { x, y, w, h }
}

function item(text: string, x: number, y: number, w: number): NormItem {
  return { text, x, y, w, h: 12, fontSize: 10, fontName: "Test", isHidden: false }
}

/** 시험지형 2단 지면 rect 세트 (좌·우 각 14행 · 전폭 헤더 1개).
 * 실측처럼 좌·우 단의 베이스라인은 서로 어긋난다 (단끼리 독립 조판 — 동시 행이
 * 많으면 예산서류 행 짝 구조로 판정돼 기각되는 것이 맞다). */
function examRects(): ColRect[] {
  const rects: ColRect[] = [rect(88, 1040, 666, 40)] // 전폭 머리글 표
  for (let i = 0; i < 14; i++) {
    rects.push(rect(88, 950 - i * 60, 310, 12)) // 좌단
    rects.push(rect(440, 943 - i * 57, 310, 12)) // 우단 (위상 어긋남)
  }
  return rects
}

describe("detectColumnGutter", () => {
  it("2단 시험지 기하 → 거터 x 검출 (좌단 끝~우단 시작 사이)", () => {
    const gx = detectColumnGutter(examRects())
    assert.ok(gx !== null, "거터를 검출해야 함")
    assert.ok(gx! > 398 && gx! < 440, `거터 x=${gx}는 단 사이(398~440)여야 함`)
  })

  it("전폭 프로즈(단일 컬럼) → null", () => {
    const rects: ColRect[] = []
    for (let i = 0; i < 20; i++) {
      // 전폭 줄을 단어 rect 4개로 쪼갬 (단어 갭이 줄마다 다른 위치)
      const shift = (i % 4) * 13
      let x = 60 + shift
      for (const w of [150, 180, 140, 130]) {
        rects.push(rect(x, 900 - i * 30, w, 12))
        x += w + 8
      }
    }
    assert.equal(detectColumnGutter(rects), null)
  })

  it("좁은 라벨열 + 넓은 본문(비대칭) → null", () => {
    const rects: ColRect[] = []
    for (let i = 0; i < 12; i++) {
      rects.push(rect(60, 900 - i * 40, 60, 12)) // 라벨열 (좁음)
      rects.push(rect(260, 900 - i * 40, 340, 12)) // 본문열 (넓음)
    }
    assert.equal(detectColumnGutter(rects), null)
  })

  it("좌·우 폭이 대칭이어도 베이스라인 공유(라벨-값 유사표) → null", () => {
    // 예산서류: 같은 행에 좌(사업명)·우(금액)가 나란한 구조 — 단 분리 시 행이 찢긴다
    const rects: ColRect[] = []
    for (let i = 0; i < 14; i++) {
      rects.push(rect(60, 900 - i * 30, 250, 12))
      rects.push(rect(420, 900 - i * 30, 250, 12)) // 동일 베이스라인
    }
    assert.equal(detectColumnGutter(rects), null)
  })

  it("우측 상단 작은 사이드바(서명란류) → null", () => {
    const rects: ColRect[] = []
    for (let i = 0; i < 14; i++) rects.push(rect(60, 900 - i * 40, 300, 12)) // 본문 좌측
    for (let i = 0; i < 5; i++) rects.push(rect(450, 900 - i * 16, 120, 12)) // 상단 구석
    assert.equal(detectColumnGutter(rects), null)
  })
})

describe("orderByGutter", () => {
  it("전폭 유닛을 밴드 경계로 좌단 전체 → 우단 전체 순서", () => {
    // 밴드0: L1, R1 / 경계(전폭) / 밴드1: L2, L3, R2
    const units = [
      { name: "R2", r: rect(440, 100, 300, 200) },
      { name: "L1", r: rect(88, 900, 300, 80) },
      { name: "FULL", r: rect(88, 500, 666, 100) },
      { name: "L3", r: rect(88, 120, 300, 100) },
      { name: "R1", r: rect(440, 700, 300, 300) },
      { name: "L2", r: rect(88, 300, 300, 150) },
    ]
    const ordered = orderByGutter(units, u => u.r, 420).map(u => u.name)
    assert.deepEqual(ordered, ["L1", "R1", "FULL", "L2", "L3", "R2"])
  })
})

describe("extractPageBlocksFallback — 2단 시험지 읽기 순서 (#64)", () => {
  /** 좌단 문항 1·2, 우단 문항 3·4 — 각 7줄. 우단 베이스라인은 좌단과 어긋나게(실측 조판) */
  function examItems(): NormItem[] {
    const items: NormItem[] = []
    // 전폭 머리글 (거터를 가로지르는 아이템 포함 → 밴드 경계)
    items.push(item("2026학년도 대학수학능력시험 문제지", 250, 1040, 340))
    const question = (n: number, x: number, yTop: number) => {
      items.push(item(`${n}. 그림은 물리 현상을 나타낸 것이다`, x, yTop, 310))
      for (let l = 1; l < 7; l++) {
        items.push(item(`${n}번 본문 ${l}행 내용이 이어진다`, x + 10, yTop - l * 20, 290))
      }
    }
    question(1, 88, 950)
    question(2, 88, 700)
    question(3, 440, 943)
    question(4, 440, 691)
    return items
  }

  it("좌단 문항 전체 → 우단 문항 전체 순서로 복원", () => {
    const items = examItems()
    const blocks = extractPageBlocksFallback(items, 1, true, false)
    const text = blocks.map(b => b.text ?? "").join("\n")
    const idx = (s: string) => {
      const i = text.indexOf(s)
      assert.ok(i >= 0, `"${s}"가 출력에 있어야 함`)
      return i
    }
    // 머리글 → 1 → 2 → 3 → 4
    assert.ok(idx("문제지") < idx("1. 그림은"), "머리글이 본문보다 먼저")
    assert.ok(idx("1. 그림은") < idx("2. 그림은"), "좌단 위→아래")
    assert.ok(idx("2. 그림은") < idx("3. 그림은"), "좌단 전체가 우단보다 먼저")
    assert.ok(idx("3. 그림은") < idx("4. 그림은"), "우단 위→아래")
  })

  it("detectTables=true 기본 경로에서도 동일 순서", () => {
    const items = examItems()
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    const text = blocks.map(b => b.text ?? "").join("\n")
    const pos1 = text.indexOf("1. 그림은")
    const pos2 = text.indexOf("2. 그림은")
    const pos3 = text.indexOf("3. 그림은")
    const pos4 = text.indexOf("4. 그림은")
    assert.ok(pos1 >= 0 && pos2 >= 0 && pos3 >= 0 && pos4 >= 0, "문항 4개 모두 존재")
    assert.ok(pos1 < pos2 && pos2 < pos3 && pos3 < pos4, `순서 1→2→3→4 (실제: ${[pos1, pos2, pos3, pos4]})`)
  })
})
