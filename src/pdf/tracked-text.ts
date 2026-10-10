/**
 * 자간 벌린 글 — 글자 간격(Tc)을 넓힌 줄은 pdfjs 가 글자마다 공백을 넣어 "E M A I L R E B E C C A" 가 되고 진짜 낱말 사이 공백과
 * 구별되지 않는다(ODL 103 "EMAIL REBECCA.ALLEN@MSJ.EDU FOR MORE INFORMATION"). 연산자 목록의 글리프 흐름에는 진짜 공백 글리프만
 * 있으니, 한 글자·공백이 번갈아 나오는 아이템을 같은 글꼴의 글리프 흐름으로 다시 짠다. 흐름이 어긋나는 글꼴은 손대지 않는다.
 */

import { OPS, normalizeUnicode } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { PdfTextItem } from "./text-line.js"

// 한글 균등배분("홍 보 지 원 반")은 normalizeItems·셀 글이 따로 다룬다 — 라틴·숫자·기호만
const TRACKED = /^(?:[^\s\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3] ){3,}[^\s\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]$/

export function restoreTrackedSpacing(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): number {
  if (!items.some(it => TRACKED.test(it.str ?? ""))) return 0
  // 글꼴별 글리프 글 흐름 (공백 글리프 포함)
  const streams = new Map<string, string[]>()
  const saved: string[] = []
  let font = ""
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = (argsArray as unknown[][])[i]
    if (fn === OPS.setFont) font = String(args[0])
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(font)
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) font = saved.pop() ?? font
    else if (fn === OPS.showText) {
      let list = streams.get(font)
      if (!list) streams.set(font, list = [])
      for (const g of args[0] as unknown[]) {
        if (g && typeof g === "object" && typeof (g as { unicode?: unknown }).unicode === "string") list.push(normalizeUnicode((g as { unicode: string }).unicode))
      }
    }
  }
  const cursor = new Map<string, number>()
  const failed = new Set<string>()
  let changed = 0
  for (const it of items) {
    const f = it.fontName ?? ""
    const glyphs = streams.get(f)
    if (!glyphs || failed.has(f) || typeof it.str !== "string") continue
    const want = it.str.replace(/\s+/g, "")
    if (!want) continue
    let gi = cursor.get(f) ?? 0
    // 아이템 첫 글자에 맞는 글리프까지 공백은 건너뛴다
    while (gi < glyphs.length && /^\s*$/.test(glyphs[gi])) gi++
    let got = "", text = ""
    while (gi < glyphs.length && got.length < want.length) {
      const g = glyphs[gi++]
      text += g
      got += g.replace(/\s+/g, "")
    }
    if (got !== want) { failed.add(f); continue }
    cursor.set(f, gi)
    if (TRACKED.test(it.str)) {
      const rebuilt = text.replace(/\s+/g, " ").trim()
      if (rebuilt.split(" ").length < it.str.split(" ").length) { it.str = rebuilt; changed++ }
    }
  }
  return changed
}

/**
 * pdfjs 가 글자 틈(TJ 자간 이동·위치 이동)을 보고 만들어 넣은 공백 아이템에 synthetic 표시 — 글리프 흐름에 공백 글리프가 없는 자리다.
 * 균등배분 판정은 "명시적 공백 글리프"에서만 run 을 끊어야 하는데(Type3 한 글자씩 배치 + 공백 글리프, "아침 브리핑"), 합성 공백까지
 * 경계로 보면 배분 정렬 칸 "보 [-777.8] 험 [-777.8] 업" 이 틈마다 끊겨 "보 험 업" 으로 남았다(해외직접투자 보도자료).
 * 공백만 든 아이템을 제 글꼴 흐름의 커서 자리 글리프와 맞춘다: 공백 글리프면 진짜, 아니면 합성. 흐름이 어긋나는 글꼴은 손대지 않는다.
 */
export function markSyntheticSpaces(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): void {
  if (!items.some(it => typeof it.str === "string" && it.str.length > 0 && !it.str.trim())) return
  const streams = new Map<string, string[]>()
  const saved: string[] = []
  let font = ""
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = (argsArray as unknown[][])[i]
    if (fn === OPS.setFont) font = String(args[0])
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(font)
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) font = saved.pop() ?? font
    else if (fn === OPS.showText) {
      let list = streams.get(font)
      if (!list) streams.set(font, list = [])
      for (const g of args[0] as unknown[]) {
        if (g && typeof g === "object" && typeof (g as { unicode?: unknown }).unicode === "string") list.push(normalizeUnicode((g as { unicode: string }).unicode))
      }
    }
  }
  const cursor = new Map<string, number>()
  const failed = new Set<string>()
  const marks: PdfTextItem[] = []
  for (const it of items) {
    const f = it.fontName ?? ""
    const glyphs = streams.get(f)
    if (!glyphs || failed.has(f) || typeof it.str !== "string" || !it.str) continue
    let gi = cursor.get(f) ?? 0
    if (!it.str.trim()) {
      if (gi < glyphs.length && /^\s+$/.test(glyphs[gi])) {
        while (gi < glyphs.length && /^\s+$/.test(glyphs[gi])) gi++
        cursor.set(f, gi)
      } else marks.push(it)
      continue
    }
    const want = it.str.replace(/\s+/g, "")
    while (gi < glyphs.length && /^\s*$/.test(glyphs[gi])) gi++
    let got = ""
    while (gi < glyphs.length && got.length < want.length) got += glyphs[gi++].replace(/\s+/g, "")
    if (got !== want) { failed.add(f); continue }
    cursor.set(f, gi)
  }
  for (const it of marks) if (!failed.has(it.fontName ?? "")) (it as PdfTextItem & { synthetic?: boolean }).synthetic = true
}

/**
 * 줄 끝 공백 글리프 — 아이템 글 뒤 글리프가 공백 글리프이고 다음 글 아이템이 다른 줄이면 spaceAfter 표시. 한컴 PDF 는 어절마다 뒤
 * 공백 글리프까지 찍어("원활한␣") 어절 경계에서 꺾인 줄 끝에도 공백 글리프가 남고, 어절 가운데서 꺾인 줄 끝("업무⏎수행에")에는 없다.
 * pdfjs 는 줄 끝 공백을 아이템 글에서 지워 이 차이가 글에 안 남는다. hwpx↔pdf 744쌍 줄 잇기 판정 4.4만 곳 실측: 표시된 꺾임 1.2만 곳 중
 * 원문이 붙여 쓴 곳 0. 공백 글리프는 다른 글꼴로 찍히기도 해 글꼴을 가리지 않고 연산 순서 흐름으로 맞춘다 — 글리프 이름 복원 따위가
 * 아이템 글을 바꾸기 전에 불러야 흐름과 글자 그대로 맞고, 어긋나면 그 쪽의 나머지는 손대지 않는다.
 * 줄 끝 공백 글리프를 찍는 쪽(줄 끝 EMIT_MIN_LINES 곳 이상 가운데 EMIT_MIN_RATIO 넘게)이면 공백 없는 줄 끝에 spaceAfter=false 도 단다 —
 * 찍지 않는 제작기(rhwp 렌더·일부 워드 PDF)에서는 공백 없음이 정보가 아니다
 */
export function markTrailingSpaceGlyphs(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): void {
  const glyphs: string[] = []
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] !== OPS.showText) continue
    for (const g of (argsArray as unknown[][])[i][0] as unknown[]) {
      if (g && typeof g === "object" && typeof (g as { unicode?: unknown }).unicode === "string") glyphs.push(normalizeUnicode((g as { unicode: string }).unicode))
    }
  }
  const text = items.filter(it => typeof it.str === "string" && it.str.trim())
  const ends: Array<[PdfTextItem, boolean]> = []
  let gi = 0
  for (let k = 0; k < text.length; k++) {
    const it = text[k]
    const want = it.str.replace(/\s+/g, "")
    while (gi < glyphs.length && /^\s*$/.test(glyphs[gi])) gi++
    let got = ""
    while (gi < glyphs.length && got.length < want.length) got += glyphs[gi++].replace(/\s+/g, "")
    if (got !== want) break
    let next = gi
    while (next < glyphs.length && glyphs[next] === "") next++
    const after = text[k + 1]
    if (after && Math.abs(after.transform[5] - it.transform[5]) < 3) continue
    ends.push([it, next < glyphs.length && /^\s+$/.test(glyphs[next])])
  }
  const spaced = ends.filter(([, s]) => s).length
  const emits = ends.length >= EMIT_MIN_LINES && spaced >= ends.length * EMIT_MIN_RATIO
  for (const [it, s] of ends) if (s || emits) (it as PdfTextItem & { spaceAfter?: boolean }).spaceAfter = s
}
/** 줄 끝 공백 글리프를 찍는 쪽 판정 — 줄 끝 수 하한과 공백 글리프 비율 (hwpx↔pdf 744쌍 문서별 비율: 찍는 제작기 0.2 이상) */
const EMIT_MIN_LINES = 5
const EMIT_MIN_RATIO = 0.2
