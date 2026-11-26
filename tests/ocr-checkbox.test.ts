/**
 * 서식 체크 칸 (line-split checkboxFrames · glyph-restore checkboxes) — 스캔·사진 서식의 □·[ ] 칸과 그 안의 체크 표시.
 *
 * 잠근 계약:
 *  1. 가는 테두리 □ 는 칸으로 찾고, 안이 비면 빈칸·안에 V 표시가 있으면 체크다 — 표시가 테두리를 덮고 지나가도 찾는다
 *  2. 네 귀퉁이만 꺾인 [ ] 는 꺾쇠 칸, 둥근 괄호 ( )·원 글머리 ○·굵은 글자 획 덩어리는 칸이 아니다
 *  3. 칸 안 "1" 같은 가는 세로 획 하나는 표시가 아니다
 *  4. 인식 글이 칸 자리를 √ 로 읽었으면 ☑, 빈칸을 빠뜨렸으면 뒤 글 앞에 □ 를 넣는다. V·M 같은 영문·숫자·괄호로 읽은 자리는
 *     같은 줄에 다른 칸 증거(□ 로 읽힌 칸·넣은 □·√ 류)가 있을 때만 바꾼다(일반 글의 "5 V에서"·"VC(운용사)")
 *  5. 칸 자리를 다른 글자(한글·영문 낱말 속 글자)가 덮었으면 글을 바꾸지 않는다
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { checkboxFrames, inkStats } from "../src/ocr/line-split.js"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

const W = 240, H = 48

/** 흰 바탕(245) 줄 crop — draw 로 어두운 점을 찍는다 */
function crop() {
  const g = new Uint8Array(W * H).fill(245)
  const dot = (x: number, y: number, v = 40) => { if (x >= 0 && x < W && y >= 0 && y < H) g[y * W + x] = v }
  const rect = (x0: number, y0: number, x1: number, y1: number, v = 40) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) dot(x, y, v) }
  /** 한 변 s·두께 2 의 □ — 왼쪽 위 (x, y) */
  const box = (x: number, y: number, s: number, v = 60) => { rect(x, y, x + s, y + 1, v); rect(x, y + s - 1, x + s, y + s, v); rect(x, y, x + 1, y + s, v); rect(x + s - 1, y, x + s, y + s, v) }
  /** 두께 4 의 V 표시 — 왼쪽 위 (x, y) 에서 아래 가운데를 거쳐 오른쪽 위로 */
  const vmark = (x: number, y: number, s: number) => {
    for (let t = 0; t <= s; t++) { const yy = y + Math.round(t), xa = x + Math.round(t / 2), xb = x + s - Math.round(t / 2); rect(xa, yy, xa + 3, yy); rect(xb - 3, yy, xb, yy) }
  }
  return { g, dot, rect, box, vmark }
}
const frames = (g: Uint8Array) => checkboxFrames(g, W, H, inkStats(g))

describe("서식 체크 칸 모양", () => {
  it("가는 테두리 □ — 빈칸과 V 표시 칸", () => {
    const c = crop()
    c.box(20, 12, 24)
    c.box(120, 12, 24)
    c.vmark(118, 4, 28) // 위 변을 덮고 지나간다
    const f = frames(c.g)
    const at = (x: number) => f.find(q => q.x0 <= x && x <= q.x1)
    assert.equal(at(32)?.kind, "□")
    assert.equal(at(32)?.checked, false)
    assert.equal(at(132)?.kind, "□")
    assert.equal(at(132)?.checked, true)
  })

  it("[ ] 꺾쇠 칸은 찾고, 둥근 괄호와 굵은 글자 덩어리는 칸이 아니다", () => {
    const c = crop()
    // [ ] — 줄기 두께 2, 귀퉁이 갈고리 길이 6
    c.rect(20, 12, 21, 36, 60); c.rect(20, 12, 26, 13, 60); c.rect(20, 35, 26, 36, 60)
    c.rect(43, 12, 44, 36, 60); c.rect(38, 12, 44, 13, 60); c.rect(38, 35, 44, 36, 60)
    // ( ) — 위아래 끝이 줄기 열에서 벗어난다
    for (let y = 12; y <= 36; y++) { const dx = Math.round(Math.abs(y - 24) ** 2 / 30); c.rect(120 + dx, y, 121 + dx, y, 60); c.rect(144 - dx, y, 145 - dx, y, 60) }
    // 굵은 글자 획 덩어리
    c.rect(190, 10, 200, 38); c.rect(210, 10, 220, 38); c.rect(190, 10, 220, 16)
    const f = frames(c.g)
    assert.ok(f.some(q => q.kind === "[]" && q.x0 <= 22 && q.x1 >= 43 && !q.checked), JSON.stringify(f))
    assert.ok(!f.some(q => q.x0 >= 110 && q.x1 <= 150), "둥근 괄호")
    assert.ok(!f.some(q => q.x0 >= 185), "굵은 획")
  })

  it("원 글머리 ○ 는 칸이 아니다", () => {
    const c = crop()
    for (let a = 0; a < 360; a += 2) { const r = 12, x = Math.round(40 + r * Math.cos((a * Math.PI) / 180)), y = Math.round(24 + r * Math.sin((a * Math.PI) / 180)); c.rect(x, y, x + 1, y + 1, 60) }
    assert.deepEqual(frames(c.g), [])
  })

  it("칸 안 가는 세로 획 하나(숫자 1)는 표시가 아니다", () => {
    const c = crop()
    c.box(20, 12, 24)
    c.rect(31, 17, 33, 31)
    const f = frames(c.g).find(q => q.x0 <= 32 && 32 <= q.x1)
    assert.equal(f?.checked, false)
  })
})

/** 한 줄 페이지 — 칸 하나와 뒤 라벨(한글 두 자 흉내: 굵은 ㅏ·ㅣ 획). steps 는 글자마다 CTC 자리(stepPx=4) */
function page(drawBox: (c: ReturnType<typeof crop>) => void) {
  const c = crop()
  drawBox(c)
  // 라벨 — 칸 뒤 x 70~110, 칸 꼴이 아닌 굵은 획
  c.rect(70, 12, 74, 36); c.rect(75, 22, 82, 25); c.rect(92, 12, 96, 36); c.rect(100, 12, 104, 36)
  const rgba = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = c.g[i]; rgba[i * 4 + 3] = 255 }
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }
/** cx(i) = (steps[i] + 0.5) × 4 — 칸 가운데 32 ↔ step 7.5, 라벨 76·98 ↔ 18.5·24 */
const restore = (rgba: Uint8Array, text: string, steps: number[]) => restoreGlyphs(rgba, W, box, text, steps, 4)

describe("서식 체크 칸 글 고치기", () => {
  it("칸 자리를 √ 로 읽은 체크 칸은 ☑", () => {
    const rgba = page(c => { c.box(20, 12, 24); c.vmark(18, 4, 28) })
    assert.equal(restore(rgba, "√가나", [7.5, 18.5, 24]), "☑가나")
  })

  it("V 로 읽은 칸은 같은 줄에 다른 칸이 있을 때만 ☑", () => {
    // 두 번째 칸(x 120~144)은 모델이 □ 로 읽었다. 서식의 나란한 칸
    const two = page(c => { c.box(20, 12, 24); c.vmark(18, 4, 28); c.box(120, 12, 24) })
    assert.equal(restore(two, "V가나□다", [7.5, 18.5, 24, 32.5, 40]), "☑가나□다")
    // 칸 꼴 하나뿐인 줄의 V 는 글자일 수 있다("5 V에서")
    const one = page(c => { c.box(20, 12, 24); c.vmark(18, 4, 28) })
    assert.equal(restore(one, "V가나", [7.5, 18.5, 24]), "V가나")
  })

  it("빠뜨린 빈칸은 뒤 글 앞에 □ 를 넣는다", () => {
    const rgba = page(c => c.box(20, 12, 24))
    assert.equal(restore(rgba, "가나", [18.5, 24]), "□ 가나")
  })

  it("칸 자리를 다른 글자가 덮으면 바꾸지 않는다", () => {
    const rgba = page(c => { c.box(20, 12, 24); c.vmark(18, 4, 28) })
    assert.equal(restore(rgba, "다가나", [7.5, 18.5, 24]), "다가나")
    // 낱말 속 영문(앞 글자가 붙은 M) — "AM가나" 의 M 자리
    assert.equal(restore(rgba, "AM가나", [3, 7.5, 18.5, 24]), "AM가나")
  })
})
