/**
 * 세로쓰기 글상자 — 한글 글자를 한 자씩 위에서 아래로 쌓은 기둥이 오른쪽에서 왼쪽으로 늘어선 영역(rhwp tbox-v-flow-01).
 * 가로 줄로 읽으면 기둥마다 한 글자씩 섞여 "오걸그모별나…"가 된다. 기둥 둘 이상이 윗머리를 맞춰 나란하고 그 영역에 다른
 * 글이 없을 때만 기둥마다 한 줄로 잇고(글자 높이보다 넓게 벌어진 자리는 띄어쓰기), 영역 안에 오른쪽 기둥부터 위→아래로
 * 한 줄씩 놓는다. 표의 세로 머리 칸("구⏎분")은 기둥이 하나라 그대로다.
 */

import type { NormItem } from "./text-line.js"

const CJK = /^[ㄱ-ㆎ가-힣一-鿿]$/
const PUNCT = /^[、。，．,.·ㆍ!?]$/

interface Column { x: number; items: NormItem[] }

export function joinVerticalColumns(items: NormItem[]): NormItem[] {
  const singles = items.filter(i => !i.rotated && CJK.test(i.text) && i.fontSize > 0)
  if (singles.length < 8) return items
  // 같은 x(글자 폭의 0.15배 안)의 한 글자들 → 기둥 후보
  const cols: Column[] = []
  for (const it of [...singles].sort((a, b) => a.x - b.x)) {
    const c = cols.find(col => Math.abs(col.x - it.x) <= it.fontSize * 0.15)
    if (c) c.items.push(it)
    else cols.push({ x: it.x, items: [it] })
  }
  // 기둥: 네 글자 이상이 글자 높이 1~2배 간격으로 이어짐
  const columns = cols.filter(c => {
    if (c.items.length < 4) return false
    c.items.sort((a, b) => b.y - a.y)
    const fs = c.items[0].fontSize
    for (let k = 1; k < c.items.length; k++) {
      const step = c.items[k - 1].y - c.items[k].y
      if (step < fs * 0.8 || step > fs * 2) return false
    }
    return true
  }).sort((a, b) => b.x - a.x)
  if (columns.length < 2) return items

  // 오른쪽부터 이웃 기둥끼리 묶음: 간격이 글자 폭 1.2~4배(연 사이 빈 기둥 하나), 윗머리가 한 글자 안
  const groups: Column[][] = []
  for (const col of columns) {
    const g = groups[groups.length - 1]
    const last = g?.[g.length - 1]
    const fs = col.items[0].fontSize
    if (last && last.x - col.x >= fs * 1.2 && last.x - col.x <= fs * 4 && Math.abs(last.items[0].y - col.items[0].y) <= fs * 1.2) g.push(col)
    else groups.push([col])
  }

  const drop = new Set<NormItem>()
  const add: NormItem[] = []
  for (const g of groups) {
    if (g.length < 2) continue
    const fs = g[0].items[0].fontSize
    // 세로쓰기는 기둥 안 글자 간격이 기둥 사이보다 좁다 — 행마다 "팀장"·"대리"가 쌓인 표 칸은 행 간격이 글자 간격보다 넓다
    const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]
    const step = med(g.flatMap(c => c.items.slice(1).map((it, k) => c.items[k].y - it.y)))
    const colGap = med(g.slice(1).map((c, k) => g[k].x - c.x))
    if (step > colGap * 0.8 || step > fs * 1.15) continue
    // 문장이면 기둥 안에 낱말 틈(글자 높이 1.3배 넘는 간격)이 있다 — 지역명·직위를 한 칸에 한 글자씩 쌓은 표 열은 간격이 고르다
    const gapped = g.filter(c => c.items.slice(1).some((it, k) => c.items[k].y - it.y > fs * 1.3)).length
    if (gapped * 2 < g.length) continue
    const x1 = Math.min(...g.map(c => c.x)), x2 = Math.max(...g.map(c => c.x)) + fs
    const top = Math.max(...g.map(c => c.items[0].y)) + fs * 0.2
    const bottom = Math.min(...g.map(c => c.items[c.items.length - 1].y)) - fs * 0.2
    const members = new Set(g.flatMap(c => c.items))
    // 세로 구두점("、")은 기둥 오른쪽으로 비켜 찍힌다 — 가장 가까운 왼쪽 기둥에 넣는다
    const inside = items.filter(i => !members.has(i) && i.x + i.w / 2 >= x1 - 1 && i.x + i.w / 2 <= x2 + 1 && i.y <= top && i.y >= bottom - fs)
    if (inside.some(i => !PUNCT.test(i.text))) continue
    // 기둥 하나가 한 문단이다(시·연 줄) — 새 줄들은 문단 간격으로 벌려 놓되, 그 자리에 다른 글이 있으면 영역 안에 촘촘히
    const spread = fs * 2.2
    const lineH = items.some(i => !members.has(i) && !inside.includes(i) && i.x + i.w > x1 && i.x < x2 && i.y < bottom && i.y >= top - spread * g.length)
      ? (top - bottom) / g.length : spread
    for (const p of inside) {
      const col = [...g].filter(c => c.x <= p.x).sort((a, b) => b.x - a.x)[0]
      if (col) { col.items.push(p); members.add(p) }
    }
    // 한글 세로쓰기의 、。 는 원문 쉼표·마침표를 세로 모양으로 찍은 것이다(한글 PDF 가 문자표도 U+3001·3002 로 단다) — 한글 기둥이면 되돌린다
    const hangul = g.some(c => c.items.some(it => /[가-힣]/.test(it.text)))
    g.forEach((col, k) => {
      col.items.sort((a, b) => b.y - a.y)
      let text = ""
      for (let n = 0; n < col.items.length; n++) {
        const it = col.items[n]
        if (n > 0 && col.items[n - 1].y - it.y > fs * 1.3 && !PUNCT.test(it.text)) text += " "
        text += hangul ? it.text.replace(/[、，]/g, ",").replace(/[。．]/g, ".") : it.text
      }
      // 폭은 글자 수의 반 — 글상자 틀(1칸 표) 안에서 칸 폭을 채우고 꺾인 줄로 읽혀 다음 기둥에 이어 붙지 않게
      add.push({ ...col.items[0], text, x: x1, y: top - fs * 0.2 - k * lineH, w: [...text].length * fs * 0.5, h: fs })
    })
    for (const m of members) drop.add(m)
  }
  return drop.size ? [...items.filter(i => !drop.has(i)), ...add] : items
}
