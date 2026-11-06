/**
 * OCR 쪽 그림 속 차트 글 — 스캔·이미지 쪽의 선·막대 그래프(생존 곡선 "100 90 … 10" 세로 눈금 + "0 6 12 … 84" 가로 눈금)는
 * 눈금·범례·곡선 위 표지가 낱글자 조각("H"·"+H #√ #"·"S")으로 흩어져 본문 사이에 끼었다. 원본 문서(HWP·PDF)에서 이런 차트는
 * 그림이라 글이 아니다(약품 설명서 Kaplan-Meier 곡선 쪽: 정답 글 4줄에 조각 40개).
 * 두 축이 다 있을 때만 차트로 본다: 왼쪽 세로 눈금(수 하나짜리 상자 4개+, 오른쪽 끝 맞춤, 값이 위→아래 한 간격으로 줄고 높이와 직선)과
 * 그 아래 가로 눈금(한 줄의 수 4개+, 한 간격). 축이 감싼 판 안 상자와 축 이름표 줄까지 뺀다
 */
import type { OcrItem } from "./engine.js"

const NUMBER = /^-?\d+(?:\.\d+)?%?$/

const value = (t: string) => Number(t.replace(/%$/, ""))

interface Axis { x1: number; x2: number; y1: number; y2: number; h: number }

/** 위→아래(왼→오) 차례 눈금에서 값이 한 간격으로 바뀌고 자리 간격도 고른 가장 긴 구간 — 축 끝에 붙은 원점 "0"·범례 수를 떼어 낸다 */
function evenRun(ticks: Array<{ pos: number; value: number }>): Array<{ pos: number; value: number }> {
  let best: typeof ticks = []
  for (let s = 0; s + 1 < ticks.length; s++) {
    const step = ticks[s + 1].value - ticks[s].value, gap = ticks[s + 1].pos - ticks[s].pos
    if (step === 0 || gap <= 0) continue
    let e = s + 1
    // 값은 한 간격(OCR 이 눈금 하나쯤 잘못 읽은 "35" 는 자리로 넘긴다), 자리 간격은 첫 간격의 ±35%
    while (e + 1 < ticks.length) {
      const d = ticks[e + 1].pos - ticks[e].pos, v = ticks[e + 1].value - ticks[e].value
      if (Math.abs(d - gap) > gap * 0.35 || Math.abs(v - step) > Math.abs(step) * 0.25) break
      e++
    }
    if (e - s + 1 > best.length) best = ticks.slice(s, e + 1)
  }
  return best
}

const number = (t: string) => NUMBER.test(t.replace(/-$/, "").trim()) ? value(t.replace(/-$/, "").trim()) : null

/** 세로 눈금 — 오른쪽 끝이 맞는 수 하나 상자들 가운데 위→아래 값이 한 간격으로 줄고 자리도 고른 4개+ */
function valueAxes(items: OcrItem[]): Axis[] {
  const nums = items.filter(it => number(it.text) !== null)
  const out: Axis[] = []
  const used = new Set<OcrItem>()
  for (const seed of nums) {
    if (used.has(seed)) continue
    const col = nums.filter(it => Math.abs(it.x + it.w - seed.x - seed.w) <= seed.h * 0.8).sort((a, b) => a.y - b.y)
    const run = evenRun(col.map(it => ({ pos: it.y + it.h / 2, value: number(it.text)!, it })))
    if (run.length < 4 || run[1].value > run[0].value) continue
    const ticks = run.map(r => (r as unknown as { it: OcrItem }).it)
    for (const it of ticks) used.add(it)
    const h = ticks.reduce((a, it) => a + it.h, 0) / ticks.length
    out.push({ x1: Math.min(...ticks.map(it => it.x)), x2: Math.max(...ticks.map(it => it.x + it.w)), y1: ticks[0].y, y2: ticks[ticks.length - 1].y + ticks[ticks.length - 1].h, h })
  }
  return out
}

/** 가로 눈금 — 한 줄에 놓인 수만 든 상자들(OCR 이 "18 24 30"·"54" 로 나눠 읽는다)을 낱 수로 펼쳐, 왼→오 값이 한 간격으로 느는 4개+ */
function timeAxes(items: OcrItem[]): Axis[] {
  const numeric = items.filter(it => { const t = it.text.trim().split(/\s+/); return t.length > 0 && t.every(x => NUMBER.test(x)) })
  const out: Axis[] = []
  const used = new Set<OcrItem>()
  for (const seed of numeric) {
    if (used.has(seed)) continue
    const row = numeric.filter(it => Math.abs(it.y + it.h / 2 - seed.y - seed.h / 2) <= Math.min(it.h, seed.h) * 0.6).sort((a, b) => a.x - b.x)
    // 상자 안 수는 글자 수 비례로 자리를 나눈다
    const ticks = row.flatMap(it => {
      const text = it.text.trim(), per = it.w / Math.max(1, text.length)
      return [...text.matchAll(/\S+/g)].map(m => ({ pos: it.x + (m.index! + m[0].length / 2) * per, value: value(m[0]), it }))
    })
    const run = evenRun(ticks)
    if (run.length < 4 || run[1].value < run[0].value) continue
    const boxes = [...new Set(run.map(r => (r as unknown as { it: OcrItem }).it))]
    for (const it of boxes) used.add(it)
    out.push({ x1: Math.min(...boxes.map(it => it.x)), x2: Math.max(...boxes.map(it => it.x + it.w)), y1: Math.min(...boxes.map(it => it.y)), y2: Math.max(...boxes.map(it => it.y + it.h)), h: seed.h })
  }
  return out
}

/** 차트 판 안 상자 번호 — 세로 눈금 아래 붙은 가로 눈금이 있는 판만 */
export function chartPlotItems(items: OcrItem[]): Set<number> {
  const drop = new Set<number>()
  const verticals = valueAxes(items)
  if (!verticals.length) return drop
  const horizontals = timeAxes(items)
  for (const v of verticals) {
    // 가로 눈금은 세로 눈금 맨 아래 밑(줄 다섯 안 — 사이에 범례 줄이 끼기도 한다)에서 세로 눈금 오른쪽으로 뻗는다
    const hz = horizontals.find(a => a.y1 >= v.y2 - v.h && a.y1 <= v.y2 + 5 * v.h && a.x1 >= v.x1 - v.h && a.x1 <= v.x2 + 4 * v.h && a.x2 > v.x2 + 8 * v.h)
    if (!hz) continue
    // 판: 세로 눈금 왼쪽 축 이름(세로로 쓴 "SURVIVAL")부터 가로 눈금 오른쪽 끝까지, 맨 위 눈금 위 한 줄부터 가로 눈금 아래 축 이름 한 줄까지
    const x1 = v.x1 - 5 * v.h, x2 = hz.x2 + 2 * v.h, y1 = v.y1 - 1.5 * v.h, y2 = hz.y2 + 2.5 * v.h
    items.forEach((it, i) => {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2
      if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2 && it.x >= x1 - v.h && it.x + it.w <= x2 + v.h) drop.add(i)
    })
  }
  return drop
}
