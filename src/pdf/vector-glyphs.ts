/**
 * 벡터 글자 감지 — 글자를 글꼴이 아니라 채운 곡선 경로로 그린 쪽 (needsOcr 사유 vector_text).
 *
 * rhwp 자체 렌더러(Producer "cairo 1.18.0")는 DejaVu 글꼴에 없는 한글을 자모를 조합한 채움 경로로 그린다.
 * 텍스트층에는 ASCII·기호만 남고(한글 0자) 눈으로는 한글이 읽힌다 — rhwp/hwpx_sample2 1쪽 연산자는
 * constructPath 975·fill 857 vs showText 66. "글꼴을 곡선으로" 인쇄한 PDF 도 같은 모양이다. 텍스트층만 보는
 * 품질 신호(quality.ts)는 이런 쪽을 못 알아봐(ASCII 가 조금 있어 low_text 도 아님) 한글 없는 마크다운을 경고 없이 냈다.
 *
 * 판정은 연산자 목록 기하로만 한다:
 *  ① 글자 모양 채움 경로 — 높이 3~40pt·폭 ≤ 높이×2·선분 8개+·닫힌 윤곽 2개+(한글 음절은 초성·중성이 떨어진
 *     윤곽이라 2개 이상이다. 원·사각·삼각·화살표 같은 도형 조각과 라틴 한 획 글자는 여기서 빠진다), 가운데가
 *     텍스트층 글 상자 밖(투명 텍스트층을 얹은 윤곽 PDF 는 글이 있는 쪽이다).
 *  ② 글줄 조각(run) — 세로 가운데가 반 높이 안인 경로를 한 줄로, 줄 안에서 x 틈 1.5em 이내를 한 조각으로.
 *  ③ 글줄다움 — 3개+·윗선이나 밑선이 가지런함(중앙 편차 ≤ 0.05em)·가로 겹침 드묾(≤ 20%)·한 색(≥ 90%)·
 *     모양이 제각각(서로 다른 모양 ≥ 50%).
 * 코퍼스 PDF 1,561개(16,775쪽) 실측 — 비-cairo 15,875쪽 가운데 ①의 경로가 있는 쪽 275, ② 조각이 있는 쪽 71,
 * ③을 넘는 글자가 있는 쪽 39. 그 가운데 가장 많은 쪽이 68개(광진소식 지면: 텍스트층 0자, 본문 전부 곡선 — 진짜
 * 벡터 글자)이고 다음이 차트 라벨 62(보도자료 안내서, 텍스트층 372자)·표지 로고 34·30 이다. ③이 떨어낸 것:
 * 표지·간지 원형 아이콘 무리(ice-arc: 정렬 편차 0.1~0.3em·겹침 0.2~0.75), 서식 점선 칸 줄(synam-001: 모양 1종
 * 반복), 클립아트 세부(hwp3-sample11 네트워크 그림: 겹침 ~1.0·색 제각각). ③의 조건을 하나씩 빼 봐도 오탐은 없지만
 * (여유가 줄 뿐), ③을 통째로 빼면 비-cairo 17쪽이 판정을 넘는다 — 텍스트층 0자 광진소식 5쪽 말고도 삽화·아이콘 쪽 12
 * (cbe-record-guide 표지·간지 6, ice-arc-2026 간지 6). 쪽 판정(글자 수·비율)은 quality.ts 가 한다.
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

/** 글자 모양 채움 경로 (쪽 좌표, CTM 적용) */
export interface GlyphPath {
  x1: number; y1: number; x2: number; y2: number
  /** 선분(직선·곡선) 수 */
  segs: number
  /** 닫힌 윤곽(부분 경로) 수 */
  subs: number
  /** 채움 색 (0xRRGGBB) */
  color: number
  /** 이 경로를 만든 연산자 번호 (constructPath 들 + 채움) — OCR 경로가 괘선만 남길 때 뺀다 */
  ops: number[]
}

const GLYPH_MIN_H = 3
const GLYPH_MAX_H = 40
const GLYPH_MAX_ASPECT = 2
const GLYPH_MIN_SEGS = 8
const GLYPH_MIN_SUBS = 2
/** 줄 안 이웃 경로 x 틈 상한 (em) — 낱말 사이 띄어쓰기·양쪽 정렬 벌어짐까지 한 조각 */
const RUN_GAP_EM = 1.5
const RUN_MIN = 3
/** 윗선·밑선 중앙 편차 상한 (em) — cairo 글줄 0.00~0.07, 아이콘 무리 0.1~0.3 */
const RUN_ALIGN_EM = 0.05
/** 앞 경로 끝보다 0.1em 넘게 앞에서 시작하는 이웃 비율 상한 — 글자는 차례로 놓인다 */
const RUN_MAX_OVERLAP = 0.2
const RUN_MIN_COLOR = 0.9
const RUN_MIN_SHAPES = 0.5

type Mat = number[]
const mul = (m: Mat, t: Mat): Mat => [
  m[0] * t[0] + m[2] * t[1],
  m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3],
  m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4],
  m[1] * t[4] + m[3] * t[5] + m[5],
]

/**
 * 글자 모양 채움 경로 수집. pdfjs v4 constructPath 인자 [subOps, coords, minMax] 의 minMax 는 곡선 끝점을
 * 빼먹으므로 좌표를 직접 훑는다. 사각형(re)만으로 된 채움(칸 음영·막대·체크박스)은 글자가 아니다.
 */
export function collectGlyphPaths(fnArray: Uint32Array | number[], argsArray: unknown[][]): GlyphPath[] {
  const out: GlyphPath[] = []
  let ctm: Mat = [1, 0, 0, 1, 0, 0]
  let color = 0
  const stack: Array<[Mat, number]> = []
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  let segs = 0, subs = 0, rects = 0
  let ops: number[] = []
  const add = (x: number, y: number) => {
    const tx = ctm[0] * x + ctm[2] * y + ctm[4], ty = ctm[1] * x + ctm[3] * y + ctm[5]
    if (tx < x1) x1 = tx
    if (tx > x2) x2 = tx
    if (ty < y1) y1 = ty
    if (ty > y2) y2 = ty
  }
  const reset = () => { x1 = Infinity; y1 = Infinity; x2 = -Infinity; y2 = -Infinity; segs = 0; subs = 0; rects = 0; ops = [] }
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    const args = argsArray[i]
    switch (op) {
      case OPS.save: stack.push([ctm, color]); break
      case OPS.restore: [ctm, color] = stack.pop() ?? [[1, 0, 0, 1, 0, 0], 0]; break
      case OPS.transform: ctm = mul(ctm, args as number[]); break
      case OPS.paintFormXObjectBegin: {
        stack.push([ctm, color])
        const m = (args as unknown[])[0]
        if (Array.isArray(m) && m.length >= 6) ctm = mul(ctm, m as number[])
        break
      }
      case OPS.paintFormXObjectEnd: [ctm, color] = stack.pop() ?? [[1, 0, 0, 1, 0, 0], 0]; break
      case OPS.setFillRGBColor: {
        const c = args as unknown as ArrayLike<number>
        color = (c[0] << 16) | (c[1] << 8) | c[2]
        break
      }
      case OPS.constructPath: {
        const [subOps, coords] = args as [number[], number[]]
        if (!Array.isArray(subOps) || !Array.isArray(coords)) break
        ops.push(i)
        let ci = 0
        for (const s of subOps) {
          if (s === OPS.moveTo) { add(coords[ci], coords[ci + 1]); ci += 2; subs++ }
          else if (s === OPS.lineTo) { add(coords[ci], coords[ci + 1]); ci += 2; segs++ }
          else if (s === OPS.curveTo) { add(coords[ci], coords[ci + 1]); add(coords[ci + 2], coords[ci + 3]); add(coords[ci + 4], coords[ci + 5]); ci += 6; segs++ }
          else if (s === OPS.curveTo2 || s === OPS.curveTo3) { add(coords[ci], coords[ci + 1]); add(coords[ci + 2], coords[ci + 3]); ci += 4; segs++ }
          else if (s === OPS.rectangle) {
            const rx = coords[ci], ry = coords[ci + 1], rw = coords[ci + 2], rh = coords[ci + 3]
            add(rx, ry); add(rx + rw, ry + rh); add(rx, ry + rh); add(rx + rw, ry)
            ci += 4; rects++; subs++; segs += 4
          }
        }
        break
      }
      case OPS.fill: case OPS.eoFill: case OPS.fillStroke: case OPS.eoFillStroke:
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: {
        const w = x2 - x1, h = y2 - y1
        if (segs > rects * 4 && h >= GLYPH_MIN_H && h <= GLYPH_MAX_H && w <= h * GLYPH_MAX_ASPECT &&
            segs >= GLYPH_MIN_SEGS && subs >= GLYPH_MIN_SUBS) {
          out.push({ x1, y1, x2, y2, segs, subs, color, ops: [...ops, i] })
        }
        reset()
        break
      }
      case OPS.stroke: case OPS.closeStroke: case OPS.endPath:
        reset()
        break
    }
  }
  return out
}

/** 텍스트층 글 상자 (NormItem 과 같은 모양 — y 는 베이스라인) */
export interface TextBox { text: string; x: number; y: number; w: number; h: number }

/** 가운데가 텍스트층 글 상자 안 — 글 위에 겹쳐 그린 윤곽(투명 텍스트층을 얹은 윤곽 PDF, 글자 테두리 효과) */
function coveredByText(b: GlyphPath, texts: TextBox[]): boolean {
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2
  for (const t of texts) {
    if (cx >= t.x - 1 && cx <= t.x + t.w + 1 && cy >= t.y - t.h * 0.3 - 1 && cy <= t.y + t.h + 1 && t.text.trim()) return true
  }
  return false
}

const median = (a: number[]): number => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1] }
const spread = (a: number[]): number => { const c = median(a); return median(a.map(v => Math.abs(v - c))) }

/** 글줄다움 — 머리 주석 ③ (m 은 x 순) */
function isTextRun(m: GlyphPath[], em: number): boolean {
  if (m.length < RUN_MIN) return false
  if (Math.min(spread(m.map(b => b.y2)), spread(m.map(b => b.y1))) > em * RUN_ALIGN_EM) return false
  let overlaps = 0
  for (let i = 1; i < m.length; i++) if (m[i].x1 < m[i - 1].x2 - em * 0.1) overlaps++
  if (overlaps > (m.length - 1) * RUN_MAX_OVERLAP) return false
  const colors = new Map<number, number>()
  for (const b of m) colors.set(b.color, (colors.get(b.color) ?? 0) + 1)
  if (Math.max(...colors.values()) < m.length * RUN_MIN_COLOR) return false
  const shapes = new Set(m.map(b => `${Math.round((b.x2 - b.x1) * 2)}:${Math.round((b.y2 - b.y1) * 2)}:${b.segs}`))
  return shapes.size >= m.length * RUN_MIN_SHAPES
}

export interface VectorGlyphScan {
  /** 글줄다운 조각에 든 글자 모양 경로 수 — 텍스트층에 없는 곡선 글자 수 추정 */
  glyphs: number
  /** 글자 모양 채움 경로 전부 (텍스트층이 덮은 것 포함) */
  paths: GlyphPath[]
}

/** 쪽의 벡터 글자 신호. texts 는 그 쪽 텍스트층 글 상자 */
export function scanVectorGlyphs(fnArray: Uint32Array | number[], argsArray: unknown[][], texts: TextBox[]): VectorGlyphScan {
  const paths = collectGlyphPaths(fnArray, argsArray)
  if (paths.length < RUN_MIN) return { glyphs: 0, paths }
  const free = paths.filter(b => !coveredByText(b, texts))
  // 줄 묶기: 세로 가운데 순으로 훑어 첫 경로 가운데에서 반 높이 안이면 같은 줄
  const sorted = free.slice().sort((a, b) => (a.y1 + a.y2) - (b.y1 + b.y2))
  let glyphs = 0
  let row: GlyphPath[] = []
  let rowCy = 0, rowH = 0
  const flushRow = () => {
    if (row.length < RUN_MIN) return
    row.sort((a, b) => a.x1 - b.x1)
    const em = median(row.map(b => b.y2 - b.y1))
    let start = 0, maxX = row[0].x2
    for (let i = 1; i <= row.length; i++) {
      if (i < row.length && row[i].x1 - maxX <= em * RUN_GAP_EM) { if (row[i].x2 > maxX) maxX = row[i].x2; continue }
      const run = row.slice(start, i)
      if (isTextRun(run, em)) glyphs += run.length
      if (i < row.length) { start = i; maxX = row[i].x2 }
    }
  }
  for (const b of sorted) {
    const cy = (b.y1 + b.y2) / 2, h = b.y2 - b.y1
    if (row.length && Math.abs(cy - rowCy) <= Math.max(h, rowH) * 0.5) { row.push(b); continue }
    flushRow()
    row = [b]; rowCy = cy; rowH = h
  }
  flushRow()
  return { glyphs, paths }
}

/**
 * OCR 로 가는 벡터 글자 쪽의 그래픽 — 글자 모양 경로와 클립을 뺀 연산자 목록(괘선·채움·그림). 그 쪽 표 구조를 래스터
 * 괘선 감지 대신 실제 괘선으로 복원한다(pdf-ocr.ts).
 *
 * 클립을 빼는 까닭: 클립 칸 격자(clip-cells.ts)는 한컴 PDF 내보내기의 "칸마다 W n 클립" 관행에 기댄 경로인데, 글자를 곡선으로
 * 그린 쪽은 코퍼스에서 전부 비한컴 제작기(rhwp cairo)이고 한컴 PDF 1,480개(10,976쪽)에는 한 쪽도 없다. cairo 는 음영 칸과
 * 그림에만 클립을 깔아(hwpx_sample2 2쪽: 클립 17 = 같은 기하 채움 17) 부분 클립 격자가 선 격자와 한 표를 둘로 쪼갠다 — kftc
 * 붙임 표는 머리 행이 따로 1×5 표, 본문 행은 3×6 에 섞였다. 텍스트층 없음 13쌍 46표 OCR 실측: 클립 포함 exact 16·F1 0.510·
 * NED 0.310, 클립 뺌 exact 20·F1 0.587·NED 0.445 (종전 래스터 괘선 14·0.502·0.295)
 */
export function ocrVectorOps(
  opList: { fnArray: Uint32Array | number[]; argsArray: unknown[][] },
  paths: GlyphPath[],
): { fnArray: number[]; argsArray: unknown[][] } {
  const drop = new Set<number>()
  for (const p of paths) for (const i of p.ops) drop.add(i)
  const fnArray: number[] = []
  const argsArray: unknown[][] = []
  for (let i = 0; i < opList.fnArray.length; i++) {
    const op = opList.fnArray[i]
    if (drop.has(i) || op === OPS.clip || op === OPS.eoClip) continue
    fnArray.push(op)
    argsArray.push(opList.argsArray[i])
  }
  return { fnArray, argsArray }
}
