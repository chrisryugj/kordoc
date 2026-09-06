/**
 * 시각 오라클 순수 로직 — 페이지-crop aHash · 도장 red-mass. verify-visual.mjs 가 사용.
 * 분리 이유: 한컴 캡처 없이 기존 out/*.png 로 오라클 감도·노이즈를 오프라인 재검증하기 위해.
 *
 * gate-2 (2026-07-05) 실측 근거:
 *  - 구 방식(창 crop 전체를 sips 32×32)은 한컴 작업영역 배경이 crop 의 37%를 차지해
 *    전역 평균을 254→169 로 눌렀고, 도장은 얇은 붉은 테두리+흰 속이라 32×32 셀 평균이
 *    209~220 까지만 내려가 40mm 도장도 0/1024 비트 — 크기 확대 무효였다.
 *  - 배경은 테마 따라 검정(~30)도 밝은 회색(239)도 된다. 밝은 회색은 페이지 안 콘텐츠
 *    열(열평균 최저 205)보다 밝아 휘도 임계로는 분리 불가 → 종이만 갖는 순백(≥248)
 *    픽셀 비율로 페이지 열/행을 찾는다.
 *  - 페이지-crop aHash: 노이즈 0/1024(동일 문서 2캡처), 감도 15/25/40mm 도장 9/93/117
 *    비트. 15mm 가 임계(16) 미달이라 도장 소실·오배치는 red-mass·중심좌표가 잡는다
 *    (도장 없음 0px vs 기본 753 · 15mm 3,228px — 완전 분리). red 는 유채색 콘텐츠와
 *    충돌하므로(chart 케이스 20,301px) 도장 케이스에만 opt-in.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"

const WHITE_MIN = 248 // 종이 순백 판정 하한
const PAGE_FRAC = 0.5 // 열/행의 순백 비율이 이 이상이면 페이지
const OUTSIDE_FRAC = 0.03 // 행의 순백 비율이 이 미만이면 종이 밖(작업영역·쪽 사이 띠)

export function decodeBmp(b) {
  const off = b.readUInt32LE(10)
  const w = b.readInt32LE(18)
  const hRaw = b.readInt32LE(22)
  const h = Math.abs(hRaw)
  const bpp = b.readUInt16LE(28) / 8
  if (w <= 0 || h <= 0 || bpp < 3) throw new Error(`BMP 파싱 실패 w${w} h${h} bpp${bpp * 8}`)
  const rowSize = Math.ceil((w * bpp) / 4) * 4
  const topDown = hRaw < 0
  // 픽셀은 BGR(A) — row(y) 는 top-down 좌표 y 의 행 시작 오프셋
  const row = (y) => off + (topDown ? y : h - 1 - y) * rowSize
  return { buf: b, w, h, bpp, row }
}

export function loadBmp(pngPath) {
  const bmpPath = pngPath.replace(/\.[^.]+$/, ".bmp")
  execFileSync("sips", ["-s", "format", "bmp", pngPath, "--out", bmpPath], { stdio: "pipe" })
  const img = decodeBmp(readFileSync(bmpPath))
  rmSync(bmpPath)
  return img
}

/** 순백 픽셀 비율 ≥ PAGE_FRAC 인 열/행의 첫~끝 = 페이지 경계. 검출 실패 시 전체 프레임. */
export function pageRect(img) {
  const { buf, w, h, bpp, row } = img
  const stepY = Math.max(1, Math.floor(h / 256))
  const stepX = Math.max(1, Math.floor(w / 256))
  const isWhite = (p) => buf[p] >= WHITE_MIN && buf[p + 1] >= WHITE_MIN && buf[p + 2] >= WHITE_MIN
  // 열: 순백 ≥PAGE_FRAC 인 첫~끝. 행: 종이 밖(작업영역 회색·쪽 사이 띠)은 순백이 거의 없고(<OUTSIDE_FRAC),
  // 본문 행은 글자가 있어도 순백이 남는다. 그래서 행을 "밖" 행으로 분절하고, 순백 ≥PAGE_FRAC 인 강한 행이 가장
  // 많은 분절을 종이로 삼는다 — crop 에 다음 쪽 상단이 함께 들어와도(표지 문서는 첫 쪽이 위로 당겨져 2쪽이 보인다)
  // 첫~끝처럼 두 쪽과 사이 띠를 한 종이로 묶지 않고, 가로로 넓은 채움 띠·표 괘선 행에서 끊기지도 않는다.
  let x0 = -1, x1 = -1
  for (let x = 0; x < w; x++) {
    let white = 0, n = 0
    for (let y = 0; y < h; y += stepY) { if (isWhite(row(y) + x * bpp)) white++; n++ }
    if (white / n >= PAGE_FRAC) { if (x0 < 0) x0 = x; x1 = x }
  }
  const frac = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    const r = row(y)
    let white = 0, n = 0
    for (let x = 0; x < w; x += stepX) { if (isWhite(r + x * bpp)) white++; n++ }
    frac[y] = white / n
  }
  let y0 = -1, y1 = -1, bestStrong = 0
  for (let y = 0; y < h; ) {
    if (frac[y] < OUTSIDE_FRAC) { y++; continue }
    let end = y, strong = 0
    while (end < h && frac[end] >= OUTSIDE_FRAC) { if (frac[end] >= PAGE_FRAC) strong++; end++ }
    if (strong > bestStrong) { bestStrong = strong; y0 = y; y1 = end - 1 }
    y = end
  }
  return { x0, x1, y0, y1 }
}

/**
 * 캡처 PNG → { bits, red, cx, cy, rect }
 *  bits: 페이지 영역 32×32 면적평균 aHash (1024비트 문자열)
 *  red : 붉은 픽셀 수 (R≥100 ∧ R−G≥50 ∧ R−B≥50, 페이지 영역)
 *  cx/cy: red 픽셀 중심의 페이지 상대좌표 0~1 (red=0 이면 null)
 */
export function analyzePng(pngPath) {
  const img = loadBmp(pngPath)
  const { x0, x1, y0, y1 } = pageRect(img)
  const { buf, bpp, row } = img
  const cw = (x1 - x0 + 1) / 32
  const ch = (y1 - y0 + 1) / 32
  const sum = new Float64Array(1024)
  const cnt = new Float64Array(1024)
  let red = 0, redX = 0, redY = 0
  for (let y = y0; y <= y1; y++) {
    const cy32 = Math.min(31, ((y - y0) / ch) | 0)
    let p = row(y) + x0 * bpp
    for (let x = x0; x <= x1; x++, p += bpp) {
      const B = buf[p], G = buf[p + 1], R = buf[p + 2]
      const i = cy32 * 32 + Math.min(31, ((x - x0) / cw) | 0)
      sum[i] += (B + G + R) / 3
      cnt[i]++
      if (R >= 100 && R - G >= 50 && R - B >= 50) { red++; redX += x; redY += y }
    }
  }
  const gray = new Array(1024)
  let avg = 0
  for (let i = 0; i < 1024; i++) { gray[i] = sum[i] / cnt[i]; avg += gray[i] }
  avg /= 1024
  return {
    bits: gray.map((v) => (v >= avg ? "1" : "0")).join(""),
    red,
    cx: red ? (redX / red - x0) / (x1 - x0 + 1) : null,
    cy: red ? (redY / red - y0) / (y1 - y0 + 1) : null,
    rect: { x0, x1, y0, y1 },
  }
}

export const hamming = (a, b) => {
  if (a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/** baseline 직렬화 — 1행 bits, 2행 red 메트릭. 2행 없는 파일은 구 포맷(창 전체 aHash). */
export function formatBaseline(a) {
  const f = (v) => (v == null ? "-" : v.toFixed(4))
  return `${a.bits}\nred=${a.red} cx=${f(a.cx)} cy=${f(a.cy)}\n`
}

export function parseBaseline(text) {
  const [bits = "", meta = ""] = text.trim().split("\n")
  const out = { bits, red: null, cx: null, cy: null }
  for (const m of meta.matchAll(/(red|cx|cy)=(-|[\d.]+)/g)) out[m[1]] = m[2] === "-" ? null : Number(m[2])
  return out
}
