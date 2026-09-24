/**
 * OCR 인식 문자열 후처리 — 한국 공문서 표기 관행 복원.
 *
 * PP-OCRv5 korean 인식기의 사전(11,945자)에는 공문서 글머리·표기 기호 일부가 없다
 * (○ U+25CB·△ U+25B3·◎·■·「」·【】 — 사전 실측). 모델은 사전 안의 닮은 글자로
 * 읽는다: ○ → 라틴 O(코퍼스 박스 단위 실측 145회)·o, △ → 증가 기호 ∆(29회).
 * 공문서에서 쓰이지 않는 쪽만 되돌린다 — 모호한 것(ㅇ 글머리는 실제 자모, 0 은
 * "0원" 같은 숫자)은 건드리지 않는다.
 *
 * 따옴표: 모델은 ‘ ’ 를 곧은 ' 로 읽는다(114회). 공문서 텍스트층은 둥근 따옴표가 압도적
 * (코퍼스 GT ‘’ 129 : ' 7 — 한컴 자동 고침) → 여닫음 문맥으로 둥근 따옴표를 복원한다.
 */

const HANGUL_START = /^[\uac00-\ud7a3]/

/** 박스 텍스트 한 줄 후처리 (위치 독립 규칙) */
export function restoreSymbols(text: string): string {
  let s = text
  // ○ 글머리: 줄 머리 O/o + (공백) + 한글
  s = s.replace(/^([Oo])(\s?)(?=[\uac00-\ud7a3])/, "\u25cb$2")
  // ○○ 자리표시(○○시·○○○ 과장): 라틴 글자와 붙지 않은 O 2개 이상이 한글과 (공백 하나 사이로) 이웃
  s = s.replace(/(?<![A-Za-z])O{2,}(?![A-Za-z])/g, (m, i: number) =>
    /[\uac00-\ud7a3]$/.test(s.slice(Math.max(0, i - 2), i).trimEnd()) || /^\s?[\uac00-\ud7a3]/.test(s.slice(i + m.length))
      ? "\u25cb".repeat(m.length) : m)
  // △ 감액 표시: 사전 밖 → ∆(U+2206)·그리스 Δ(U+0394) 로 읽힘
  s = s.replace(/[\u2206\u0394]/g, "\u25b3")
  // "(cid:NN)" 은 PDF 텍스트 추출기가 유니코드 없는 글리프에 쓰는 표기 — 인식기가 학습 자료에서 배워 티끌·가는
  // 막대 박스에 낸다(pcccr·rda-planfarm·yeosu 실측, 박스 5~16px). 인쇄된 글자일 수 없으니 지운다
  s = s.replace(/\(cid:\d*\)/g, "")
  return smartQuotes(joinDigitGroups(s))
}

/**
 * 천 단위 숫자 안의 끼어든 공백 제거 — 모델이 쉼표 뒤에 공백을 넣는다("385, 426"·"4,802, 164",
 * 예산서 표에서 수십 회 실측). 쉼표 앞이 1~3자리, 뒤가 정확히 3자리인 무리만 잇는다
 * ("1, 2, 3" 같은 목록·"10, 20명"은 뒤가 3자리가 아니라 그대로).
 */
export function joinDigitGroups(s: string): string {
  return s.replace(/(?<![\d,])\d{1,3}(?:, ?\d{3})+(?![\d])/g, m => m.replace(/, /g, ","))
}

/**
 * 곧은 따옴표 → 둥근 따옴표. 한 줄 안의 따옴표를 짝으로 보고 여닫음을 번갈아 준다 —
 * OCR 띄어쓰기가 불안정해("내에서'기록관리시스템'") 앞 글자가 공백인지로는 여는 자리를
 * 가를 수 없다. 개수가 홀수면(줄바꿈에 걸친 인용) 첫 따옴표가 여는 자리(줄 머리·공백·
 * 여는 괄호 뒤)가 아닐 때 닫는 것부터. 연도 생략 '24 는 짝에서 빼고 ’.
 */
export function smartQuotes(s: string): string {
  if (!/['"]/.test(s)) return s
  const chars = [...s]
  for (const q of ["'", '"']) {
    const [open, close] = q === "'" ? ["\u2018", "\u2019"] : ["\u201c", "\u201d"]
    const pos: number[] = []
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== q) continue
      const prev = i > 0 ? chars[i - 1] : ""
      if (q === "'" && !/[\p{L}\p{N}]/u.test(prev) && /^\d{2}(?!\d)/.test(chars.slice(i + 1, i + 4).join(""))) {
        chars[i] = close // 연도 생략
        continue
      }
      pos.push(i)
    }
    if (pos.length === 0) continue
    const first = pos[0]
    const prev = first > 0 ? chars[first - 1] : ""
    const atOpen = prev === "" || /[\s(\[{<\u300c\u300e\u3010\u3008\u300a\u2018\u201c·,:]/.test(prev)
    let isOpen = pos.length % 2 === 0 || atOpen
    for (const i of pos) { chars[i] = isOpen ? open : close; isOpen = !isOpen }
  }
  return chars.join("")
}

/** 점류만으로 된 조각 — 목차 리더·잡티(".", "..", "…", "·"). 단독으로는 뜻이 없다 */
export function isDotFragment(text: string): boolean {
  return /^[\s.\u00b7\u2024\u2025\u2026\u2027\u2219\u22c5\u318d]+$/.test(text)
}

type Placed = { text: string; x: number; y: number; w: number; h: number; confidence: number }

/**
 * 목차 한 줄 잇기. 텍스트층은 목차 줄을 리더 글자까지 한 아이템("제목 ······ 12")으로 주는데, 검출기는 리더
 * 가운데를 비워 [제목 ···] [··· 12] 두 박스로 낸다. 그러면 줄마다 큰 틈이 생겨 클러스터 표 감지가 목차·머리
 * 영역을 표로 잡고, 그 뒤 2단 본문을 줄 단위로 섞어 읽었다(assembly-minutes-1179 1면 — 목차 쪽번호 하나를 더
 * 제대로 읽자 표 감지가 발화). 엔진이 박스 끝에서 확인한 리더 점(ends: lead = 박스가 점으로 시작, trail = 점으로
 * 끝남)이 마주 보는 같은 줄 가장 가까운 이웃과 "제목 … 12" 한 아이템으로 합친다.
 */
export function joinLeaderItems<T extends Placed>(items: T[], ends: Map<T, { lead: boolean; trail: boolean }>): T[] {
  const gone = new Set<T>()
  const sameLine = (a: T, b: T) => Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= Math.max(a.h, b.h) / 2
  const merge = (left: T, right: T): void => {
    const x2 = Math.max(left.x + left.w, right.x + right.w), y2 = Math.max(left.y + left.h, right.y + right.h)
    left.text = left.text.replace(/\s*\u2026$/, "") + " \u2026 " + right.text.replace(/^\u2026\s*/, "")
    left.x = Math.min(left.x, right.x)
    left.y = Math.min(left.y, right.y)
    left.w = x2 - left.x
    left.h = y2 - left.y
    left.confidence = Math.min(left.confidence, right.confidence)
    gone.add(right)
  }
  const neighbor = (it: T, toLeft: boolean): T | null => {
    let best: T | null = null
    for (const o of items) {
      if (o === it || gone.has(o) || !sameLine(o, it)) continue
      if (toLeft ? o.x + o.w > it.x + 2 : o.x < it.x + it.w - 2) continue
      if (!best || (toLeft ? o.x + o.w > best.x + best.w : o.x < best.x)) best = o
    }
    return best
  }
  // 오른쪽부터 — 쪽번호 쪽("… 12")을 왼쪽 이웃에 붙이고, 제목 쪽("제목 …")은 오른쪽 이웃을 당겨 붙인다
  for (const it of [...items].sort((a, b) => b.x - a.x)) {
    if (gone.has(it) || !ends.get(it)?.lead) continue
    const left = neighbor(it, true)
    if (left) merge(left, it)
  }
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    if (gone.has(it) || !ends.get(it)?.trail) continue
    const right = neighbor(it, false)
    if (right) merge(it, right)
  }
  // 리더 점을 못 찾은 목차 줄 — 잡음·흐림에 점이 덜 잡히면 몇 줄만 [제목][쪽번호] 두 아이템으로 남고, 이어진 줄들 사이의
  // 그 두 줄이 클러스터 표를 불러 목차 전체를 칸에 섞었다(archives-record-duty 잡음 σ12: 29줄 중 3줄). 같은 쪽에서 리더로
  // 이은 줄 둘 이상과 오른쪽 끝(쪽번호 열)이 맞는 숫자 아이템은 쪽번호로 보고 같은 줄 왼쪽 이웃과 잇는다
  const toc = items.filter(it => !gone.has(it) && /\s\u2026\s\d{1,4}$/.test(it.text))
  if (toc.length >= 2) {
    for (const it of items) {
      if (gone.has(it) || toc.includes(it) || !/^[\s.:\u00b7\u2026]*\d{1,4}$/.test(it.text)) continue
      const x2 = it.x + it.w
      if (toc.filter(t => Math.abs(t.x + t.w - x2) <= Math.max(t.h, it.h)).length < 2) continue
      const left = neighbor(it, true)
      if (!left || toc.includes(left)) continue
      left.text = left.text.replace(/[\s.:\u00b7\u2026]+$/, "")
      it.text = it.text.replace(/^[\s.:\u00b7\u2026]+/, "")
      merge(left, it)
    }
  }
  return items.filter(it => !gone.has(it))
}

/**
 * 이웃 인지 ○ 복원 — 글머리 ○ 가 제 박스로 떨어져 "O" 한 글자로 읽힌 경우,
 * 같은 줄(세로 중심 차 < 높이 절반) 바로 오른쪽(글자 높이 3배 이내) 박스가 한글로 시작하면 ○.
 */
export function restoreBulletItems<T extends { text: string; x: number; y: number; w: number; h: number }>(items: T[]): void {
  for (const it of items) {
    if (it.text !== "O" && it.text !== "o") continue
    const cy = it.y + it.h / 2
    let next: T | null = null
    for (const o of items) {
      if (o === it || o.x < it.x + it.w * 0.5) continue
      if (Math.abs(o.y + o.h / 2 - cy) > Math.max(it.h, o.h) / 2) continue
      if (o.x - (it.x + it.w) > it.h * 3) continue
      if (!next || o.x < next.x) next = o
    }
    if (next && HANGUL_START.test(next.text.trimStart())) it.text = "\u25cb"
  }
}
