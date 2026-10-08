/**
 * 본문 수치 ↔ 표 수치 대조 (`kordoc lint --numbers`) — 표를 소개·요약하는 본문의 수치가 그 표에 같은 숫자로 있는지 본다.
 * 정확한 대응 검증이 아니라 "표와 어긋난 숫자는 아닌지" 1차 점검이고, 결과는 오류가 아니라 확인 목록이다.
 * 문서 전체의 본문 수치를 다 대조하면 서술용 수치가 대부분 걸려(보도자료·업무계획 45개 중 34개) 범위를 좁힌다:
 *  - 표 앞뒤 NEAR 블록 안의 본문만, 숫자가 MIN_TABLE_NUMBERS 개 이상인 표만
 *  - 그 표에 같은 단위가 나오는 수치만 — 칸에 단위가 붙은 숫자("4대"·"218억원"), 또는 "(단위: 억원)" 같은 표 단위
 *    표기가 있으면 그 표의 모든 숫자와 짝짓는다. 날짜·차수·순번 단위는 대조하지 않는다
 *  - 기준값 표현("60% 이상"·"목표인 40%"·"1조원 내외")은 표에 없는 게 정상이라 대조하지 않는다
 *  - 찾을 때는 앞뒤 FIND_WINDOW 블록의 표를 다 보고, 소수점이 있거나 세 자리 이상인 수는 단위 없이 적힌 칸("(25.7)" 비중
 *    열)과도 같은 수로 본다 — 행 번호처럼 우연히 겹치는 흔한 수(11)는 단위가 맞아야 한다
 *    (코퍼스 HWP·HWPX 200건: 확인 목록 22건 → 2건. 빠진 20건은 기준값이거나 바로 아래 다른 표·단위 없는 비중 칸에 있던 값,
 *    남은 2건은 같은 보도자료 두 벌의 "4.56조원" 으로 문서의 어느 표에도 없다)
 * 착안·임계값: hwp-auto-docfit number_check.py (MIT, THIRD_PARTY/hwp-auto-docfit.LICENSE, 22개 문서 실측)
 */

/** 대조 입력 블록 — 표는 칸 글 행렬, 그 밖은 글 */
export interface NumberCheckBlock {
  type: "table" | "text"
  text?: string
  rows?: string[][]
}

export interface NumberReview {
  /** 걸린 본문 수치 ("218억원") */
  match: string
  /** 그 수치가 든 본문 (앞 80자) */
  context: string
}

const UNIT = String.raw`억\s?원|조\s?원|백만\s?원|천만\s?원|천\s?원|만\s?원|원|%p|％p|%|％|명|건|개소|곳|대|가구|세대|톤|㎡|㎢|km|㎞`
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`
/** 단위 뒤에 글자가 이어지면 단어의 일부("대부분"의 "대")다 — 끝이거나, 글자가 아니거나, 조사 하나로 끝날 때만 단위 */
const UNIT_END = String.raw`(?=$|[^가-힣A-Za-z]|(?:으로|에서|까지|부터|보다|이며|이고|은|는|이|가|을|를|의|에|로|과|와|도|만|씩)(?![가-힣A-Za-z]))`
const VALUE_UNIT = new RegExp(String.raw`(?<![\d.,])(${NUM})\s?(${UNIT})${UNIT_END}`, "g")
const BARE_NUMBER = new RegExp(String.raw`(?<![\d.])(${NUM})`, "g")
const TABLE_UNIT_NOTE = new RegExp(String.raw`[(（]\s*(?:단위\s*[:：]\s*)?(${UNIT})\s*[)）]|단위\s*[:：]\s*(${UNIT})`, "g")
const MIN_TABLE_NUMBERS = 5
/** 기준·목표값 — 수치 바로 뒤 "이상·이하·초과·미만·내외·수준", 또는 앞 8자 안의 "목표·기준·상한·하한" */
const THRESHOLD_AFTER = /^\s?(?:이상|이하|초과|미만|내외|수준|안팎|가량|정도)/
const THRESHOLD_BEFORE = /(?:목표|기준|상한|하한|최소|최대|약)[^\d]{0,8}$/
const NEAR = 3
const FIND_WINDOW = 10

const normNumber = (v: string): string => {
  const s = v.replace(/,/g, "")
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s
}
const normUnit = (u: string): string => u.replace(/\s/g, "").replace(/％/g, "%")

/** 표의 단위별 숫자 집합과 전체 숫자 수 */
function tableNumbers(rows: string[][]): { byUnit: Map<string, Set<string>>; all: Set<string>; count: number } {
  const all = new Set<string>()
  for (const row of rows) for (const cell of row) for (const m of (cell ?? "").matchAll(BARE_NUMBER)) all.add(normNumber(m[1]))
  const byUnit = new Map<string, Set<string>>()
  const add = (unit: string, values: Iterable<string>): void => {
    const set = byUnit.get(unit) ?? new Set<string>()
    for (const v of values) set.add(v)
    byUnit.set(unit, set)
  }
  for (const row of rows) {
    for (const cell of row) {
      for (const m of (cell ?? "").matchAll(VALUE_UNIT)) add(normUnit(m[2]), [normNumber(m[1])])
      for (const m of (cell ?? "").matchAll(TABLE_UNIT_NOTE)) add(normUnit(m[1] ?? m[2]), all)
    }
  }
  return { byUnit, all, count: all.size }
}

/** 표 가까이의 본문 수치 가운데 그 표에서 찾지 못한 것 */
export function checkTableNumbers(blocks: NumberCheckBlock[]): { checked: number; review: NumberReview[] } {
  const tables = blocks.flatMap((b, i) => {
    if (b.type !== "table" || !b.rows) return []
    const t = tableNumbers(b.rows)
    return t.count >= MIN_TABLE_NUMBERS ? [{ i, byUnit: t.byUnit, all: t.all }] : []
  })
  let checked = 0
  const review: NumberReview[] = []
  blocks.forEach((b, i) => {
    if (b.type !== "text" || !b.text) return
    const near = tables.filter(t => Math.abs(t.i - i) <= NEAR)
    if (!near.length) return
    const seen = new Set<string>()
    for (const m of b.text.matchAll(VALUE_UNIT)) {
      const at = m.index!, end = at + m[0].length
      if (THRESHOLD_AFTER.test(b.text.slice(end)) || THRESHOLD_BEFORE.test(b.text.slice(Math.max(0, at - 12), at))) continue
      const key = m[0].replace(/\s/g, "")
      if (seen.has(key)) continue
      seen.add(key)
      const unit = normUnit(m[2])
      if (!near.some(t => t.byUnit.has(unit))) continue
      checked++
      const value = normNumber(m[1])
      const distinctive = value.includes(".") || value.replace(/^0+/, "").length >= 3
      const found = tables.some(t => Math.abs(t.i - i) <= FIND_WINDOW
        && (t.byUnit.get(unit)?.has(value) || (distinctive && t.all.has(value))))
      if (!found) {
        review.push({ match: `${m[1]}${m[2]}`, context: b.text.replace(/\s+/g, " ").trim().slice(0, 80) })
      }
    }
  })
  return { checked, review }
}

/** 파싱한 문서 IR → 대조 블록 (표는 칸 글, 문단·제목·목록은 글. 칸 안 표는 겉 표 칸 글로만 본다) */
export function numberBlocksFromIR(blocks: Array<{ type: string; text?: string; table?: { cells: Array<Array<{ text: string } | undefined>> } }>): NumberCheckBlock[] {
  return blocks.flatMap((b): NumberCheckBlock[] => {
    if (b.type === "table" && b.table) return [{ type: "table", rows: b.table.cells.map(row => row.map(c => c?.text ?? "")) }]
    return b.text ? [{ type: "text", text: b.text }] : []
  })
}

/** 마크다운 원고 블록 → 대조 블록 */
export function numberBlocksFromMarkdown(blocks: Array<{ type: string; text?: string; rows?: string[][] }>): NumberCheckBlock[] {
  return blocks.flatMap((b): NumberCheckBlock[] => {
    if (b.type === "table" && b.rows) return [{ type: "table", rows: b.rows }]
    return b.text ? [{ type: "text", text: b.text }] : []
  })
}
