/**
 * 패치 중 셀 테두리 변형 — 기존 borderFill 정의에서 몇 변만 바꾼 정의를 header.xml 에 덧붙인다 (table-rows 행 추가).
 *
 * 견본 행을 복제해 행을 늘리면 그 행의 테두리도 그대로 따라온다. 머리 행 바로 아래 행은 윗변이 머리 구분선(이중선)이고
 * 마지막 행은 아랫변이 표 바깥선이라, 그 행을 복제한 새 행마다 이중선·바깥선이 그어졌다. 새 행은 안쪽 행이므로 그 변만
 * 안쪽 선으로 바꾼 정의를 쓴다.
 */

export type Side = "left" | "right" | "top" | "bottom"
export type Sides = Record<Side, string>

export interface BorderVariants {
  /** borderFill 정의의 네 변 요소 XML (`<hh:topBorder …/>`) — 정의가 없으면 null */
  sides(id: number): Sides | null
  /** id 정의에서 주어진 변만 바꾼 정의의 id — 바뀌는 게 없으면 id 그대로, 같은 변형은 재사용 */
  variant(id: number, change: Partial<Sides>): number
  /** 새로 만든 정의 XML (header.xml 의 borderFills 끝에 덧붙일 것) */
  added(): string[]
}

const SIDE_RE = (side: Side) => new RegExp(`<hh:${side}Border\\b[^>]*/>`)

export function createBorderVariants(headerXml: string, nextId: () => number): BorderVariants {
  const defs = new Map<number, string>()
  for (const m of headerXml.matchAll(/<hh:borderFill\b[^>]*\bid="(\d+)"[^>]*>[\s\S]*?<\/hh:borderFill>/g)) defs.set(+m[1], m[0])
  const memo = new Map<string, number>()
  const added: string[] = []
  const sides = (id: number): Sides | null => {
    const def = defs.get(id)
    if (!def) return null
    const out = {} as Sides
    for (const side of ["left", "right", "top", "bottom"] as Side[]) {
      const m = def.match(SIDE_RE(side))
      if (!m) return null
      out[side] = m[0]
    }
    return out
  }
  return {
    sides,
    variant(id, change) {
      const cur = sides(id)
      if (!cur) return id
      // 다른 변의 요소를 옮겨 쓰면 태그 이름만 이 변으로 바꾼다
      const want = Object.entries(change).map(([side, el]) => [side as Side, el!.replace(/<hh:\w+Border\b/, `<hh:${side}Border`)] as const)
        .filter(([side, el]) => el !== cur[side])
      if (!want.length) return id
      const key = `${id}|${want.map(([s, el]) => s + el).join("|")}`
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const nid = nextId()
      let def = defs.get(id)!.replace(/\bid="\d+"/, `id="${nid}"`)
      for (const [side, el] of want) def = def.replace(SIDE_RE(side), el)
      defs.set(nid, def)
      memo.set(key, nid)
      added.push(def)
      return nid
    },
    added: () => added,
  }
}

/** header.xml 의 borderFills 끝에 정의를 덧붙이고 itemCnt 를 늘린다 — 구조를 못 찾으면 그대로 */
export function appendBorderFills(headerXml: string, defs: string[]): string {
  if (!defs.length) return headerXml
  const close = headerXml.indexOf("</hh:borderFills>")
  if (close < 0) return headerXml
  const out = headerXml.slice(0, close) + defs.join("") + headerXml.slice(close)
  return out.replace(/(<hh:borderFills\b[^>]*\bitemCnt=")(\d+)"/, (_, a, n) => `${a}${+n + defs.length}"`)
}
