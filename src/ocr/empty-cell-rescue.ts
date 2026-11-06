/**
 * 빈 칸 다시 읽기 — 쪽 검출은 긴 변 960px 로 줄여 보므로, 좁은 칸에 촘촘히 쌓인 작은 글(관보 토지조서 소재지 "서울시 / 노원구 / 월계동")이
 * 칸 테두리에 묻혀 상자가 아예 안 나온다(같은 칸을 잘라 읽으면 세 줄 다 잡힌다). 괘선으로 네 변이 닫힌 칸 가운데 안쪽에 잉크가 있는데
 * 읽힌 글과 겹치지 않는 칸만 잘라 제 해상도로 다시 검출·인식한다. 쪽 전체 해상도를 올리면 글·손글씨가 나빠졌다(긴 변 1280 일괄 반려)
 */
import type { OcrEngine, OcrItem, OcrPageStats, OcrTuning } from "./engine.js"
import type { RulingLines } from "./ruling-lines.js"

/** 쪽마다 다시 읽는 칸 상한 — 빈 서식 칸이 많은 쪽에서 시간이 늘지 않게 */
const MAX_CELLS = 60
const TOL = 3
const PAD = 16

export async function rescueEmptyCells(
  engine: OcrEngine, tuning: Readonly<OcrTuning>, rgba: Uint8Array, width: number, height: number,
  ruling: RulingLines, items: OcrItem[],
): Promise<OcrItem[]> {
  const hs = ruling.horizontals, vs = ruling.verticals
  if (hs.length < 2 || vs.length < 2) return []
  const uniq = (vals: number[]) => {
    const out: number[] = []
    for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > TOL) out.push(v)
    return out
  }
  const ys = uniq(hs.map(h => h.y1)), xs = uniq(vs.map(v => v.x1))
  const hAt = (y: number, a: number, b: number) => hs.some(h => Math.abs(h.y1 - y) <= TOL && Math.min(h.x1, h.x2) <= a + TOL && Math.max(h.x1, h.x2) >= b - TOL)
  const vAt = (x: number, a: number, b: number) => vs.some(v => Math.abs(v.x1 - x) <= TOL && Math.min(v.y1, v.y2) <= a + TOL && Math.max(v.y1, v.y2) >= b - TOL)
  const cells: Array<{ x: number; y: number; w: number; h: number }> = []
  for (let j = 0; j + 1 < xs.length && cells.length < MAX_CELLS; j++) {
    for (let i = 0; i + 1 < ys.length && cells.length < MAX_CELLS; i++) {
      // 아래로 걸친 칸 — 이 열을 가로지르는 다음 가로선까지
      let k = i + 1
      while (k + 1 < ys.length && !hAt(ys[k], xs[j], xs[j + 1])) k++
      const [y1, y2, x1, x2] = [ys[i], ys[k], xs[j], xs[j + 1]]
      i = k - 1
      if (y2 - y1 < 15 || x2 - x1 < 20 || (x2 - x1) * (y2 - y1) > width * height * 0.05) continue
      if (!hAt(y1, x1, x2) || !hAt(y2, x1, x2) || !vAt(x1, y1, y2) || !vAt(x2, y1, y2)) continue
      // 괘선 두께만큼 안쪽 — 테두리 잉크를 세지 않는다
      const bx = Math.ceil(x1 + 4), by = Math.ceil(y1 + 4), box = { x: bx, y: by, w: Math.floor(x2 - 4) - bx, h: Math.floor(y2 - 4) - by }
      if (box.w < 10 || box.h < 8) continue
      if (items.some(it => Math.min(it.x + it.w, box.x + box.w) > Math.max(it.x, box.x) && Math.min(it.y + it.h, box.y + box.h) > Math.max(it.y, box.y))) continue
      let ink = 0
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x, p = (y * width + x) * 4; x < box.x + box.w; x++, p += 4) {
        if (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29 < 128 * 256) ink++
      }
      if (ink >= 40 && ink >= box.w * box.h * 0.01) cells.push(box)
    }
  }
  const out: OcrItem[] = []
  for (const c of cells) {
    // 흰 여백을 둘러 읽는다 — 칸에 딱 맞춘 그림은 가장자리 글자를 검출기가 조각냈다
    const w = c.w + PAD * 2, h = c.h + PAD * 2
    const crop = new Uint8Array(w * h * 4).fill(255)
    for (let y = 0; y < c.h; y++) crop.set(rgba.subarray(((c.y + y) * width + c.x) * 4, ((c.y + y) * width + c.x + c.w) * 4), ((y + PAD) * w + PAD) * 4)
    const stats: OcrPageStats = { droppedLowConf: 0 }
    const found = await engine.recognizePage(crop, w, h, stats, { ...tuning, orientPage: false })
    for (const it of found) out.push({ ...it, x: it.x + c.x - PAD, y: it.y + c.y - PAD })
  }
  return out
}
