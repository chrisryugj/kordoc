/**
 * 인식 결과 글리프 되살리기 — CTC 글자 자리(steps × stepPx, 박스 로컬 x)를 박스 픽셀로 옮겨 그 자리 잉크 조각 모양으로, 사전 밖이거나
 * 모델이 줄여·바꿔·빠뜨려 읽는 글자를 고친다(괄호 「」【】·여는 따옴표·원문자·로마 숫자·두 글자 사이에서 빠진 기호). 모양 판정은
 * line-split.ts, 여기는 글자열 배선만. 글자 배열은 CTC 글자와 1:1 로 두고 칸마다 바꿔 넣거나(빈 글·여러 글자 허용) 끝에 잇는다
 */
import { bracketFeatures, bracketShape, circledAt, dashRatio, discAt, gapGlyphs, grayCrop, inkStats, quoteHead, ringBullet, romanStems, serifOne, starRun } from "./line-split.js"
import type { InkStats } from "./line-split.js"
import type { Box } from "./crop.js"

/** 무늬 글자 판정 — 배경(상자 중앙값)과 이만큼 넘게 달라야 잉크 */
const INKLESS_DELTA = 32

interface Ctx { chars: string[]; cx: (i: number) => number; gray: Uint8Array; w: number; h: number; ink: InkStats }

/** text 는 CTC 글자와 1:1 이어야 한다 — 아니면 그대로 돌려준다. note.ringLead: 줄 머리 고리를 픽셀로 정했다(restoreSymbols 의 O → ○ 를 건너뛸 것) */
export function restoreGlyphs(rgba: Uint8Array, pageW: number, box: Box, text: string, steps: number[], stepPx: number, note: { ringLead?: boolean } = {}): string {
  const chars = [...text]
  if (chars.length !== steps.length) return text
  const gray = grayCrop(rgba, pageW, box)
  const c: Ctx = { chars, cx: i => (steps[i] + 0.5) * stepPx, gray, w: box.w, h: box.h, ink: inkStats(gray) }
  if (/[[\]]/.test(text)) brackets(c)
  if (/['"]/.test(text)) quotes(c)
  if (/(^|\D)[1-9](\D|$)/.test(text)) circled(c)
  if (text.includes("*")) stars(c)
  if (/[\u00b7\u2022]/.test(text)) discs(c)
  if (/[-\u2013\u2014]/.test(text)) dashes(c)
  gaps(c)
  note.ringLead = ring(c)
  if (/[I1Ⅰ-Ⅲ]|^\s*\./.test(text)) roman(c)
  return chars.join("")
}

/**
 * 줄 끝 무늬 글자 — 검출 상자가 제목 뒤 배경 무늬 띠까지 잡으면 CTC 가 무늬를 글자로 읽는다(선거 사례집 표지의 흰 무늬 띠
 * "D①D①①①①①①①정치관계법"). 줄 양 끝에서 이어지는 글자 중 제 자리(CTC 자리 앞뒤 한 칸, 줄 높이의 1/4 이상)에 배경과 뚜렷이
 * 다른 픽셀이 없는 글자를 떼어 낸다 — 배경은 상자 중앙값, 높이를 거의 다 덮는 세로 괘선 열은 잉크로 치지 않는다. 무늬는 배경과
 * 23 차이(232 → 255)라 떨어지고, 연한 회색 글씨·색 띠 위 흰 글씨(ODL 그림 "READERS")는 남는다. 남는 글자가 없으면 그대로 둔다
 */
export function trimInklessEnds(rgba: Uint8Array, pageW: number, box: Box, text: string, steps: number[], stepPx: number): { text: string; steps: number[] } {
  const chars = [...text], { w, h } = box
  // CTC 자리가 상자를 벗어난 줄(그림 속 짧은 글을 넓게 읽은 crop, 폭 92 에 자리 406)은 자리를 믿지 않는다
  if (chars.length !== steps.length || steps.some(s => (s + 0.5) * stepPx > w + stepPx)) return { text, steps }
  const gray = grayCrop(rgba, pageW, box)
  const hist = new Uint32Array(256)
  for (const v of gray) hist[v]++
  let bg = 0
  for (let n = 0; bg < 255 && (n += hist[bg]) < gray.length / 2;) bg++
  const cols = new Uint32Array(w)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(gray[y * w + x] - bg) > INKLESS_DELTA) cols[x]++
  // 글자 자리 앞뒤 창 — 시간 칸 하나(작은 상자는 4~5px)로는 끝 글자 "l" 잉크를 놓친다
  const half = Math.max(stepPx, h * 0.25)
  const inkless = (i: number) => {
    const cx = (steps[i] + 0.5) * stepPx
    for (let x = Math.max(0, Math.floor(cx - half)); x <= Math.min(w - 1, Math.ceil(cx + half)); x++) if (cols[x] && cols[x] < h * 0.9) return false
    return true
  }
  // 문장부호는 떼지 않는다 — 작은 따옴표는 CTC 자리가 잉크에서 벗어나기 쉽다(국회도서관 보도자료 1° 기울임 제목 머리 "“")
  const blank = (i: number) => !chars[i].trim()
  const mark = (i: number) => /\p{P}/u.test(chars[i])
  let a = 0, b = chars.length
  while (a < b && (blank(a) || !mark(a) && inkless(a))) a++
  while (b > a && (blank(b - 1) || !mark(b - 1) && inkless(b - 1))) b--
  const cut = (from: number, to: number) => chars.slice(from, to).some(c => c.trim())
  if (a === b || !cut(0, a) && !cut(b, chars.length)) return { text, steps }
  return { text: chars.slice(a, b).join(""), steps: steps.slice(a, b) }
}

/**
 * 사전 밖 괄호 — 인식 사전에 「」·【】 가 없어 모델은 모두 [ ] 로 읽는다(코퍼스 정답 「」44·｢｣23·【】41·[]159 쌍 ↔ OCR [ 274).
 * [ ] 자리 잉크 조각이 속이 찬 조각이면 【】, 윗변 가로 획만이면 「, 아랫변 가로 획만이면 」 ([ ] 는 위아래 모두)
 */
function brackets({ chars, cx, gray, w, h, ink }: Ctx) {
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "[" && chars[i] !== "]") continue
    const f = bracketFeatures(gray, w, h, ink, cx(i))
    const shape = f && bracketShape(f, chars[i] === "]")
    if (shape) chars[i] = shape
  }
}

/**
 * 여는 따옴표 — 곧은 ' " 로 읽은 자리의 머리가 뚜렷이 아래(line-split quoteHead ≥ 0.47, 실측 닫는 따옴표 최대 0.46 바로 위)면 ‘ “ 로 정한다. smartQuotes 문맥 규칙은
 * 연도 생략을 늘 ’ 로 두는데 "(‘11.3월 구성)"처럼 여는 따옴표로 쓴 문서가 있다. 닫는 쪽은 글꼴마다 겹쳐(작은 글씨 여는 따옴표 0.23~0.45,
 * 닫는 0.28~0.46 — 코퍼스 61곳 실측) 문맥에 맡긴다
 */
function quotes({ chars, cx, gray, w, h, ink }: Ctx) {
  // smartQuotes 는 남은 곧은 따옴표를 홀짝으로 여닫으니, 짝 계산에 드는 자리를 바꾸면 나머지가 어긋난다 — 짝에서 빠지는
  // 연도 생략('24)과 그 줄에 하나뿐인 곧은 따옴표만 본다. 짝을 기다리는 여는 따옴표 뒤는 닫는 자리다(모델이 여는 쪽만 ‘ 로 읽은 줄)
  const year = (i: number) => chars[i] === "'" && !/[\p{L}\p{N}]/u.test(chars[i - 1] ?? "") && /^\d{2}(?!\d)/.test(chars.slice(i + 1, i + 4).join(""))
  const single = { "'": chars.filter((c, i) => c === "'" && !year(i)).length === 1, '"': chars.filter(c => c === '"').length === 1 }
  const open = { "'": false, '"': false }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    const kind = c === "'" || c === "‘" || c === "’" ? "'" : c === '"' || c === "“" || c === "”" ? '"' : null
    if (!kind) continue
    if (c !== kind) { open[kind] = c === "‘" || c === "“"; continue }
    if (open[kind]) { open[kind] = false; continue }
    if (!year(i) && !single[kind]) continue
    const r = quoteHead(gray, w, h, ink, cx(i))
    if (r !== null && r >= 0.47) { chars[i] = kind === "'" ? "‘" : "“"; open[kind] = true }
  }
}

/**
 * 대시 길이 — 붙임표를 "–"·"—" 로, 긴 줄표를 "-" 로 읽은 자리를 획 길이(line-split dashRatio)로 다시 정한다. 0.65~0.75배 사이는 그대로.
 * 긴 줄표로 늘리는 건 글자가 있는 줄의 머리 글머리("―상하수도요금")만 — 숫자뿐인 쪽 번호 "- 3 -" 은 띠가 낮게 잡히고, 숫자 사이
 * "511-01" 은 스캔에서 번져 길게 잰다
 */
function dashes({ chars, cx, gray, w, h, ink }: Ctx) {
  const head = chars.findIndex(c => c.trim()), letters = chars.some(c => /[가-힣A-Za-z]/.test(c))
  for (let i = 0; i < chars.length; i++) {
    if (!/^[-\u2013\u2014]$/.test(chars[i])) continue
    const r = dashRatio(gray, w, h, ink, cx(i))
    if (r === null) continue
    if (r < 0.65) chars[i] = "-"
    else if (r > 0.75 && i === head && letters) chars[i] = "\u2014"
  }
}

/** 원문자 숫자 — 모델이 고리를 버리고 읽은 홀로 선 숫자 1~9(앞뒤가 숫자 아님)를 그 자리 고리 성분(line-split circledAt)으로 ①~⑨ */
function circled({ chars, cx, gray, w, h, ink }: Ctx) {
  const at = chars.flatMap((c, i) => /^[1-9]$/.test(c) && !/\d/.test(chars[i - 1] ?? "") && !/\d/.test(chars[i + 1] ?? "") ? [i] : [])
  if (!at.length) return
  const hit = circledAt(gray, w, h, ink, at.map(cx))
  at.forEach((i, k) => { if (hit[k]) chars[i] = String.fromCharCode(0x245f + Number(chars[i])) })
}

/** 별표 겹침 — CTC 가 붙은 같은 글자를 하나로 합친 "**" → "*" 를 그 자리 별표 조각 수(line-split starRun)만큼 채운다 */
function stars({ chars, cx, gray, w, h, ink }: Ctx) {
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "*" || chars[i - 1] === "*") continue
    let e = i
    while (chars[e + 1] === "*") e++
    const n = starRun(gray, w, h, ink, cx(i))
    if (n > e - i + 1 && n <= 4) chars[e] += "*".repeat(n - (e - i + 1))
    i = e
  }
}

/** 큰 속 찬 원 ● — 모델은 줄 중간 글머리 ● 를 가운뎃점 · · • 로 줄여 읽는다(목차 "…171●부록●186") */
function discs({ chars, cx, gray, w, h, ink }: Ctx) {
  for (let i = 0; i < chars.length; i++) if (/^[\u00b7\u2022]$/.test(chars[i]) && discAt(gray, w, h, ink, cx(i))) chars[i] = "\u25cf"
}

/**
 * 두 글자 사이에서 빠진 기호 — 빈 열로 떨어진 잉크 조각의 모양(line-split gapGlyphs)이 · . 。 ▲ 「 」 □ 인데 그 가까이(글자 간격 0.45)에
 * CTC 글자 자리가 없으면 앞 글자 뒤에 넣는다. 모델은 가운뎃점을 공백으로 읽기도 해("개발·보급" → "개발 보급") 그 구간의 공백은
 * · 로 바꾸고, □ 는 0·O 로 읽기도 해("□□-□□□" → "00-000") 그 구간의 한 글자가 그것이면 바꾼다
 */
function gaps({ chars, cx, gray, w, h, ink }: Ctx) {
  const { glyphs, bandH } = gapGlyphs(gray, w, h, ink)
  if (!glyphs.length) return
  const live = chars.map((c, i) => i).filter(i => chars[i].trim())
  if (!live.length) return
  // 글자 간격 — 이웃한 한글 두 자의 CTC 자리 차 중앙값(없으면 글줄 띠 높이). 조각 가운데에서 0.45 간격 안에 글자 자리가 있으면 덮인 것
  // (작은 점은 CTC 자리가 조각 x 구간을 1~2px 비껴 조각 구간만 보면 이미 읽은 "·" 옆에 또 넣었다)
  const d: number[] = []
  for (let k = 0; k + 1 < live.length; k++) if (/[가-힣]$/.test(chars[live[k]]) && /^[가-힣]/.test(chars[live[k + 1]])) d.push(cx(live[k + 1]) - cx(live[k]))
  const pitch = d.length >= 2 ? d.sort((a, b) => a - b)[d.length >> 1] : bandH
  const nearTo = (g: { x0: number; x1: number }) => (i: number) => Math.abs(cx(i) - (g.x0 + g.x1) / 2) <= Math.max(pitch * 0.45, (g.x1 - g.x0) / 2 + 1)
  const loose = glyphs.filter(g => /^[\u00b7.]/.test(g.mark) && !live.some(nearTo(g)))
  for (const g of glyphs.sort((a, b) => a.x0 - b.x0)) {
    const mid = (g.x0 + g.x1) / 2
    const near = nearTo(g)
    const cover = live.filter(near)
    if (g.mark === "\u00b7\u0001") {
      // 작은 점·글자에 붙은 점은 모델이 공백으로 읽은 자리만(덮임 판정 앞 — 공백 자리가 증거다) — 다른 점이 늘어서지 않고 앞뒤가 글자일 때
      const sp = chars.findIndex((c, i) => c === " " && near(i))
      const p = sp >= 0 ? chars.slice(0, sp).reverse().find(c => c.trim()) : undefined, q = sp >= 0 ? chars.slice(sp + 1).find(c => c.trim()) : undefined
      // 앞뒤 모두 한글 — 라틴 글은 소문자 i·j 의 점이 공백 옆에 붙어 걸렸다("Keeps open" → "Keeps·open", ODL 106)
      if (p && q && /[가-힣]$/.test(p) && /^[가-힣]/.test(q) && !loose.some(o => o !== g && Math.abs((o.x0 + o.x1) / 2 - mid) <= pitch * 1.5)) chars[sp] = "\u00b7"
      continue
    }
    if (cover.length) {
      if (g.mark.startsWith("\u25a1") && cover.length === 1 && /^[0Oo\u25cb]$/.test(chars[cover[0]])) chars[cover[0]] = "\u25a1"
      continue
    }
    if (g.mark === "\u25a1\u0000") continue
    // 앞뒤 글자 사이 — 줄 끝은 마침표만(문장 끝 "…습니다.")
    const before = live.filter(i => cx(i) < mid), after = live.filter(i => cx(i) > mid)
    // 줄 머리는 뒤가 한글인 。 · 「 ▲ 만(예산서 세부 항목 "。사무실운영" — □ 는 glyph 판정이 엄한 leadingBullet 몫)
    if (!before.length) {
      if (after.length && /^[\u3002\u00b7\u300c\u25b2]$/.test(g.mark) && /^[가-힣]/.test(chars[after[0]])) chars[after[0]] = g.mark + chars[after[0]]
      // 쪽번호 꼬리말 "- 1 -" 를 "1 -" 로 읽은 줄 — 뒤 막대가 읽혔으면 앞 막대도 붙인다
      else if (g.mark === "-" && /^[\dⅰ-ⅹivx]+\s*-$/.test(chars.join("").trim())) chars[after[0]] = "-" + chars[after[0]]
      continue
    }
    if (!after.length && g.mark !== ".") continue
    if (g.mark === "/" && !(/\d$/.test(chars[before[before.length - 1]]) && /^\d/.test(chars[after[0]]))) continue // 빗금은 숫자 사이만(분수)
    const prev = chars[before[before.length - 1]], next = after.length ? chars[after[0]] : ""
    if (g.mark === "\u00b7" || g.mark === ".") {
      // 목차 리더·말줄임(안 읽힌 점이 둘 이상 늘어섬, 옆 글자가 … · .)은 빠진 기호가 아니다. 가운뎃점은 쪽번호 앞 점도 아니다
      if (loose.some(o => o !== g && Math.abs((o.x0 + o.x1) / 2 - mid) <= pitch * 1.5)) continue
      if (/[\u2026.\u00b7]$/.test(prev) || /^[\u2026.\u00b7]/.test(next)) continue
    }
    if (g.mark === "\u00b7") {
      if (/^\d/.test(next)) continue
      const sp = chars.findIndex((c, i) => c === " " && near(i))
      if (sp >= 0) { chars[sp] = g.mark; continue }
    }
    chars[before[before.length - 1]] += g.mark
  }
}

/**
 * 줄 머리 고리 글머리 — 첫 글자가 ㅇ·O·o·0·○ 이고 뒤가 한글(여는 괄호 뒤 한글 포함)이면 그 자리 고리의 크기·채움(line-split ringBullet)으로 ○ / ㅇ / o 를 정한다.
 * 모델이 같은 도형 ○ 를 "O"(→ restoreSymbols 가 ○)·"ㅇ" 로 오락가락 읽고, 자모 글머리 ㅇ 도 "O" 로 읽어 ○ 가 됐다
 */
function ring({ chars, cx, gray, w, h, ink }: Ctx): boolean {
  const k = chars.findIndex(c => c.trim())
  if (k < 0 || !/^[\u3147Oo0\u25cb]$/.test(chars[k])) return false
  // 뒤 글이 한글이거나 여는 괄호 뒤 한글("❍(정책) 민생성장"), 숫자 뒤 한글("ｏ4대보험" 을 모델은 "04대보험" 으로 읽는다 — 숫자 0 은
  // 세로로 길어 ringBullet 이 고리로 보지 않는다)
  const rest = chars.slice(k + 1).join("").trimStart()
  if (!/^[(\[「【<]?\d*[가-힣]/.test(rest)) return false
  const r = ringBullet(gray, w, h, ink, cx(k))
  if (r) chars[k] = r
  return r !== null
}

/**
 * 로마 숫자 획 수 — 모델은 한 글리프 Ⅲ 을 "II"·"I" 로, Ⅱ 를 "I" 로 줄여 읽는다(장 제목 "Ⅲ. 2026년 …" → "II. 2026년 …").
 * 라틴 글자에 붙지 않은 I·Ⅰ~Ⅲ 토막마다 그 자리 세로 획 수(line-split romanStems)를 세어 읽은 수와 다르면 Ⅰ~Ⅲ 한 글자로 바꾼다
 * (토막 첫 칸에 넣고 나머지 칸은 비운다). 숫자를 빠뜨리고 "." 부터 읽은 줄은 점 앞 잉크로 채운다
 */
function roman({ chars, cx, gray, w, h, ink }: Ctx) {
  const ROMAN = /^[IⅠ-Ⅲ]$/, LATIN = /[A-Za-z]$/
  // 숫자 1 로 읽은 Ⅰ — 앞뒤가 숫자·라틴 글자가 아닌 홀로 선 1 이 좌우 대칭 세리프면(line-split serifOne). "토픽1" → "토픽Ⅰ"
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "1" || /[\dA-Za-z]$/.test(chars[i - 1] ?? "") || /^[\dA-Za-z,]/.test(chars[i + 1] ?? "")) continue
    if (serifOne(gray, w, h, ink, cx(i))) chars[i] = "Ⅰ"
  }
  // 로마 숫자에 붙은 1 은 같은 토막으로 센다 ("[표 Ⅱ-4]" → "[표I1-4]")
  const inRoman = (i: number) => ROMAN.test(chars[i]) || (chars[i] === "1" && (ROMAN.test(chars[i - 1] ?? "") || ROMAN.test(chars[i + 1] ?? "")))
  // 숫자를 통째로 빠뜨리고 "." 부터 읽은 제목 줄(".세입·세출 …") — 점 앞 잉크가 세로 획이면 되살린다
  const k = chars.findIndex(c => c.trim())
  if (chars[k] === "." && chars.slice(k + 1).some(c => /[가-힣A-Za-z0-9]/.test(c))) {
    const n = romanStems(gray, w, h, ink, -Infinity, cx(k))
    if (n) chars[k] = String.fromCharCode(0x215f + n) + chars[k]
  }
  for (let s = 0; s < chars.length;) {
    if (!inRoman(s) || (s > 0 && LATIN.test(chars[s - 1]))) { s++; continue }
    let e = s
    while (e < chars.length && inRoman(e)) e++
    const tok = chars.slice(s, e).join("")
    if (e < chars.length && /^[A-Za-z]/.test(chars[e])) { s = e; continue }
    let p = s - 1, q = e
    while (p >= 0 && !chars[p].trim()) p--
    while (q < chars.length && !chars[q].trim()) q++
    const n = romanStems(gray, w, h, ink, p >= 0 ? cx(p) : -Infinity, q < chars.length ? cx(q) : Infinity)
    const canon = n ? [["Ⅰ", "I"], ["Ⅱ", "II"], ["Ⅲ", "III"]][n - 1] : null
    if (canon && !canon.includes(tok)) { chars[s] = canon[0]; for (let i = s + 1; i < e; i++) chars[i] = "" }
    s = e
  }
}
