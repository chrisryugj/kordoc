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
 * 자간 넓힌 한글 줄의 가짜 공백 — pdfjs 는 글자 사이 TJ 이동이 글자 크기 0.102~0.6배면 아이템 글 안에 공백을 넣는다. 한글 자간을 10% 넘게
 * 벌린 줄(머리 칸·제목)은 글자마다 이 문턱을 넘어 "한 국 정부 가"·"목 적" 이 된다. 한컴 PDF 는 친 공백을 늘 공백 글리프로 찍으니 글리프
 * 흐름에 공백 글리프가 없는 자리의 한글–한글 사이 공백은 자간이다(한컴 PDF 짝 1,379곳 실측: 정답이 붙여 씀 1,238·띄어 씀 0, 나머지는
 * 그림 속 글 등 정답에 없음). 워드·Distiller PDF 는 낱말 사이도 TJ 이동으로 벌려(정답 띄어 씀 57곳) 한컴 PDF 에만 쓴다.
 * 자간 이동은 같은 TJ 안 글자 사이 이동이 TRACKING_MAX_EM 이하인 자리만 — 균등배분 칸은 글자 사이가 0.16~0.59em 으로 벌어지고 0.6em
 * 문턱 근처에서 아이템이 갈려("증" | "감 률") 일부만 지우면 균등배분 판정이 깨진다. 자간 넓힌 줄 실측 0.103~0.145em.
 * 세 글자 넘게 한 글자씩 띄운 아이템("증 감 률", "과 학 · 기 술")은 균등배분 판정(splitEvenSpacedItem·칸 글)이 기호까지 붙여 맞히니
 * 두고, 섞인 꼴("고 려해", "대테 러")·두 글자("목 적")만 고친다 — 일부만 지우면 그 판정이 깨져 "증 감률" 이 됐다(해외직접투자 표).
 * 아이템 글을 글자 단위로 제 글꼴 흐름과 맞추고, 어긋나는 글꼴은 손대지 않는다
 */
/** 자간으로 볼 글자 사이 TJ 이동 상한(em) — joinTrackedHangul */
const TRACKING_MAX_EM = 0.15

export function joinTrackedHangul(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): void {
  if (!items.some(it => typeof it.str === "string" && /[가-힣] [가-힣]/.test(it.str))) return
  // 글꼴별 글리프 흐름 — gap 은 같은 TJ 안 앞 글리프 뒤 이동(em, 연산 첫 글리프는 null)
  const streams = new Map<string, Array<{ u: string; gap: number | null }>>()
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
      let gap: number | null = null
      for (const g of args[0] as unknown[]) {
        if (typeof g === "number") { if (gap !== null) gap -= g / 1000; continue }
        if (g && typeof g === "object" && typeof (g as { unicode?: unknown }).unicode === "string") {
          list.push({ u: normalizeUnicode((g as { unicode: string }).unicode), gap })
          gap = 0
        }
      }
    }
  }
  const isSpace = (g: { u: string } | undefined) => g !== undefined && /^\s+$/.test(g.u)
  const cursor = new Map<string, number>()
  const failed = new Set<string>()
  const edits: Array<[PdfTextItem, Set<number>]> = []
  for (const it of items) {
    const f = it.fontName ?? ""
    const glyphs = streams.get(f)
    if (!glyphs || failed.has(f) || typeof it.str !== "string" || !it.str) continue
    let gi = cursor.get(f) ?? 0
    const s = it.str
    if (!s.trim()) {
      while (isSpace(glyphs[gi])) gi++
      cursor.set(f, gi)
      continue
    }
    while (gi < glyphs.length && /^\s*$/.test(glyphs[gi].u)) gi++
    const fake = new Set<number>()
    let ok = true
    for (let k = 0; k < s.length && ok; k++) {
      if (/\s/.test(s[k])) {
        if (isSpace(glyphs[gi])) {
          while (isSpace(glyphs[gi])) gi++
          while (k + 1 < s.length && /\s/.test(s[k + 1])) k++
        } else {
          const gap = glyphs[gi]?.gap
          if (gap != null && gap <= TRACKING_MAX_EM && /[가-힣]/.test(s[k - 1] ?? "") && /[가-힣]/.test(s[k + 1] ?? "")) fake.add(k)
        }
        continue
      }
      // 아이템 글 사이 공백 글리프를 pdfjs 가 지운 자리(줄 끝 등)는 건너뛰고, 글리프 하나가 여러 글자(합자)일 수 있다
      let g = ""
      while (gi < glyphs.length && !g) g = glyphs[gi++].u.replace(/\s+/g, "")
      if (!g || s.slice(k, k + g.length) !== g) ok = false
      else k += g.length - 1
    }
    if (!ok) { failed.add(f); continue }
    cursor.set(f, gi)
    if (fake.size && !/^\S(?: \S){2,}$/.test(s)) edits.push([it, fake])
  }
  for (const [it, fake] of edits) if (!failed.has(it.fontName ?? "")) it.str = [...it.str].filter((_, k) => !fake.has(k)).join("")
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
/**
 * 아이템 머리 소프트 하이픈 — 한글 문서는 U+00AD 를 보이는 붙임표로 찍는다(글머리 "­ 42개 공공기관을…", 증감 칸 "­7,445" = −7,445).
 * pdfjs 는 이 글리프를 아이템 글에서 지워 글머리와 음수 부호가 사라졌다. 아이템 첫 글자 앞(공백만 사이에 둔) 글리프가 폭 있는 U+00AD 면
 * "-" 를 되살린다(뒤가 수면 음수 부호로 붙여, 아니면 글머리로 띄워). 앞 줄 끝 라틴 글자 바로 뒤에 찍혀 다음 줄이 소문자로 이어지면 낱말 꺾임 표시(영문 "infor­mation")라 둔다.
 * 글리프 흐름과 아이템 글을 연산 순서로 맞추고 어긋나면 그 쪽의 나머지는 손대지 않는다. 아이템 글을 바꾸는 복원들보다 먼저 맞추고,
 * 되살리기는 돌려준 함수로 그 복원들 뒤에 한다
 */
export function softHyphenHeads(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): () => void {
  const glyphs: Array<{ u: string; w: number }> = []
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] !== OPS.showText) continue
    for (const g of (argsArray as unknown[][])[i][0] as unknown[]) {
      const o = g as { unicode?: unknown; width?: unknown }
      if (g && typeof g === "object" && typeof o.unicode === "string") glyphs.push({ u: o.unicode, w: typeof o.width === "number" ? o.width : 0 })
    }
  }
  if (!glyphs.some(g => g.u === "\u00ad" && g.w > 0)) return () => {}
  const text = items.filter(it => typeof it.str === "string" && it.str.trim())
  const heads: Array<[PdfTextItem, string]> = []
  let gi = 0
  for (let k = 0; k < text.length; k++) {
    const it = text[k], prev = text[k - 1]
    const want = it.str.replace(/\s+/g, "")
    let soft = -1, spaced = false
    while (gi < glyphs.length && (/^\s*$/.test(glyphs[gi].u) || glyphs[gi].u === "\u00ad")) {
      if (glyphs[gi].u === "\u00ad") { soft = glyphs[gi].w > 0 ? gi : -1; spaced = false }
      else if (soft >= 0) spaced = true
      gi++
    }
    if (soft >= 0) {
      const before = glyphs[soft - 1]?.u ?? ""
      const wrapped = !!prev && Math.abs(prev.transform[5] - it.transform[5]) >= 3 && /\p{Script=Latin}$/u.test(before) && /^\p{Ll}/u.test(it.str.trimStart())
      // 뒤 낱말이 수(7,445·1.1%)면 음수 부호로 붙이고, 아니면 글머리 — 한컴 PDF 는 글머리 뒤 공백 글리프를 빼고 찍는다("­3D 프린터로" = "- 3D …")
      if (!wrapped) heads.push([it, spaced || !/^[\d.,]+%?(?:\s|$)/.test(it.str.trimStart()) ? "- " : "-"])
    }
    const pushed = heads.length
    let got = ""
    while (gi < glyphs.length && got.length < want.length) {
      if (glyphs[gi].u !== "\u00ad") got += normalizeUnicode(glyphs[gi].u).replace(/\s+/g, "")
      gi++
    }
    if (got !== want) { if (pushed && heads[pushed - 1][0] === it) heads.pop(); break }
  }
  return () => { for (const [it, head] of heads) it.str = head + it.str }
}
/** 줄 끝 공백 글리프를 찍는 쪽 판정 — 줄 끝 수 하한과 공백 글리프 비율 (hwpx↔pdf 744쌍 문서별 비율: 찍는 제작기 0.2 이상) */
const EMIT_MIN_LINES = 5
const EMIT_MIN_RATIO = 0.2
