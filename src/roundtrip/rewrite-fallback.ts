/**
 * patch 로 다 못 고친 편집본의 대체본 — 원본 서식으로 문서 전체를 새로 쓴다.
 *
 * patch 는 원본 바이트를 제자리에서 고쳐 서식이 가장 정확하지만, 표 열·병합을 바꾸거나 개체가 낀 자리처럼 제자리 반영이
 * 안 되는 편집은 건너뛴다. 그때 "미적용"만 돌려주면 받는 쪽(사람·에이전트)이 칸을 비우거나 체크리스트로 미루게 된다.
 * 그래서 편집 내용을 다 담은 판을 같이 만든다: HWPX 원본은 그 문서를 견본으로(글꼴·문단·표 서식·쪽 설정 — generate
 * template 과 같은 경로). HWP 5.x 원본은 서식 그대로 HWPX 로 바꾼 판에 HWPX patch(문단 추가·삭제 포함)를 하고, 거기서도
 * 남는 편집이 있으면 바꾼 판을 견본으로 쓴다. 바꿀 수 없는 HWP(배포용 등)만 kordoc 기본 서식 HWPX 로.
 */

import { markdownToHwpx } from "../hwpx/generator.js"
import { parseHwpxDocument } from "../hwpx/parser.js"
import { hwpToHwpx } from "../hwp5/to-hwpx/index.js"
import { parseHwp5Document } from "../hwp5/parser.js"
import { patchHwpx } from "./patcher.js"
import { alignUnits, editedFromVisual, editedFromWideCols, splitMarkdownUnits } from "./markdown-units.js"
import type { PatchResult } from "../types.js"

/** 대체본을 만든 길 — patch: HWP 를 서식 그대로 바꾼 HWPX 에 편집을 제자리 반영 · template: 원본(바꾼 판)을 견본으로 새로 씀 · plain: kordoc 기본 서식 */
export type RewriteHow = "patch" | "template" | "plain"

/** 대체본이 필요한 결과인가 — 패치 실패, 또는 글을 반영 못 한(부분 적용이 아닌) 건너뜀이 있음 */
export function needsRewrite(result: PatchResult): boolean {
  return !result.success || !result.data || result.skipped.some(s => !s.partial)
}

/** 대체본 경로 — 출력 경로 옆 `<이름>.rewrite.hwpx` */
export function rewritePath(outPath: string): string {
  return outPath.replace(/\.hwpx?$/i, "") + ".rewrite.hwpx"
}

/**
 * 편집 마크다운 전체를 원본 서식으로 새로 쓴다. plainOk 면 원본을 견본으로 못 쓸 때 kordoc 기본 서식으로라도 쓴다 — 패치가
 * 원본을 읽고도 일부를 못 고친 경우만 켠다(원본이 문서로 읽히지도 않으면 대체본도 만들지 않는다). 만들지 못하면 null
 */
export async function rewriteEdited(
  original: Uint8Array, isHwpx: boolean, markdown: string, plainOk: boolean,
): Promise<{ data: Uint8Array; how: RewriteHow; warnings: string[] } | null> {
  const warnings: string[] = []
  let template: Uint8Array | null = isHwpx ? original : null
  if (!isHwpx) {
    try {
      template = await hwpToHwpx(original)
      const done = await patchConverted(original, template, markdown)
      if (done) return { ...done, how: "patch" }
    } catch {
      // 바꿀 수 없는 HWP(배포용 등)는 아래 기본 서식으로, 바꾼 판에 patch 가 던지면 바꾼 판을 견본으로
    }
  }
  if (!template && !plainOk) return null
  try {
    const buf = await markdownToHwpx(markdown, template ? { template, warnings } : { warnings })
    return { data: new Uint8Array(buf), how: template ? "template" : "plain", warnings }
  } catch {
    if (!template || !plainOk) return null
    try {
      // 견본으로 못 읽는 HWPX(서식 구조 비정형) — 기본 서식으로라도 내용을 다 담는다
      const buf = await markdownToHwpx(markdown, { warnings })
      return { data: new Uint8Array(buf), how: "plain", warnings }
    } catch {
      return null
    }
  }
}

/**
 * HWP 원본을 서식 그대로 바꾼 HWPX 에 편집을 제자리 반영한다. 편집은 HWP parse 기준인데 HWP·HWPX 파서는 같은 문서에도 표지를
 * 달리 단다(HWP 는 글자 크기로 # 제목, HWPX 는 ** 굵게) — 그대로 대면 손대지 않은 문단까지 서식 변경으로 보여 건너뛴다. 그래서
 * 편집을 바꾼 판 parse 위로 옮겨 싣고 patch 한 뒤 편집 글이 다 들어갔는지 확인한다. 못 하면 null
 */
async function patchConverted(original: Uint8Array, hwpx: Uint8Array, markdown: string): Promise<{ data: Uint8Array; warnings: string[] } | null> {
  const buf = Buffer.from(original)
  const trimmed = parseHwp5Document(buf, { layoutTables: "keep" }).markdown
  const wideMd = parseHwp5Document(buf, { layoutTables: "keep", keepTrailingEmptyCols: true }).markdown
  const wide = editedFromWideCols(trimmed, wideMd, markdown)
  const base = wide ? wideMd : trimmed
  if (editedFromVisual(base, parseHwp5Document(buf, { keepTrailingEmptyCols: wide }).markdown, markdown)) return null
  const opts = { layoutTables: "keep" as const, keepTrailingEmptyCols: wide }
  const rebased = rebaseEdits(base, markdown, (await parseHwpxDocument(arrayBufferOf(hwpx), opts)).markdown)
  if (rebased === null) return null
  const r = await patchHwpx(hwpx, rebased)
  if (!r.success || !r.data || needsRewrite(r)) return null
  if (!holdsEdits(base, markdown, (await parseHwpxDocument(arrayBufferOf(r.data), opts)).markdown)) return null
  return { data: r.data, warnings: r.warnings ?? [] }
}

const arrayBufferOf = (d: Uint8Array): ArrayBuffer => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer
const unitsOf = (md: string): string[] => splitMarkdownUnits(md).map(u => u.raw)

/**
 * 단위 원문 → 표지를 걷은 글과 글자마다의 원문 구간. # 제목 머리·** 굵게·태그는 두 파서가 달리 달고, 띄어쓰기도 다르다(HWP 는
 * 균등 배분 글자 "재 무 상 태 표" 를 붙여 낸다) — 이것들은 글로 치지 않는다
 */
interface Plain { text: string; at: number[]; to: number[]; head: number }
function plainOf(raw: string): Plain {
  let text = ""
  const at: number[] = [], to: number[] = []
  const head = /^#{1,6} /.exec(raw)?.[0].length ?? 0
  let i = head
  while (i < raw.length) {
    const tag = raw[i] === "<" ? /^<\/?[a-zA-Z][^<>]*>/.exec(raw.slice(i, i + 300)) : null
    if (tag) { i += tag[0].length; continue }
    if (raw.startsWith("**", i)) { i += 2; continue }
    if (/\s/.test(raw[i])) { i++; continue }
    const n = raw[i] === "\\" && i + 1 < raw.length ? 2 : 1
    text += raw[i + n - 1]
    at.push(i); to.push(i + n)
    i += n
  }
  return { text, at, to, head }
}

/** 옮기지 않는 자리 — 굵게·태그 경계, 줄, GFM 칸 경계 */
const BOUNDARY = /\*\*|<\/?[a-zA-Z]|\n|(?<!\\)\|/
/** 줄·칸 경계 — 표지 대조로도 옮기지 않는다 */
const STRUCT = /\n|(?<!\\)\||<br\s*\/?>/i
/** 굵게·태그 표지 (역슬래시 이스케이프 글자는 건너뛴다 — plainOf 와 같은 읽기) */
const MARK_RE = /\\[\s\S]|\*\*|<\/?[a-zA-Z][^<>]*>/g
const marksOf = (x: string): string => (x.match(MARK_RE) ?? []).filter(m => m[0] !== "\\").join(" ")

/**
 * 고친 단위의 글 차이만 바꾼 판 단위에 옮긴다 — 바뀐 자리(앞 공통부 끝 ~ 뒤 공통부 시작, 그 사이 띄어쓰기 포함)를 편집본의 같은
 * 자리로 갈아 끼우고 그 밖 바꾼 판의 표지는 그대로 둔다. 차이가 경계를 가로지르거나 표지만 바꾼 편집이면 null
 */
function transplant(b: string, e: string, t: string): string | null {
  const pb = plainOf(b), pe = plainOf(e), pt = plainOf(t)
  if (!pb.text || !pe.text || pb.text !== pt.text || pb.text === pe.text) return null
  let p = 0
  while (p < pb.text.length && p < pe.text.length && pb.text[p] === pe.text[p]) p++
  let s = 0
  while (s < pb.text.length - p && s < pe.text.length - p && pb.text[pb.text.length - 1 - s] === pe.text[pe.text.length - 1 - s]) s++
  const span = (q: Plain): [number, number] => [p > 0 ? q.to[p - 1] : q.at[0], s > 0 ? q.at[q.at.length - s] : q.to[q.at.length - 1]]
  const [ts, te] = span(pt), [es, ee] = span(pe)
  const put = e.slice(es, ee)
  if (!BOUNDARY.test(t.slice(ts, te)) && !BOUNDARY.test(put)) return t.slice(0, ts) + put + t.slice(te)
  // 표지가 걸리면 단위 끝까지 넓힌 자리로 — 편집이 굵게·태그 표지를 그대로 두었을 때만, 바꾼 판 자리에 같은 표지가 있으면 그대로,
  // 표지가 없으면 걷어서 옮긴다 ("**제목** 수정" 처럼 굵은 글 뒤에 붙인 글. 두 파서가 다 굵게를 달면 종전엔 늘 견본으로 갔다)
  const wide = (q: Plain, raw: string): [number, number] => [p > 0 ? q.to[p - 1] : q.head, s > 0 ? q.at[q.at.length - s] : raw.length]
  const [ws, we] = wide(pt, t), [xs, xe] = wide(pe, e), [bs, be] = wide(pb, b)
  const wput = e.slice(xs, xe), treg = t.slice(ws, we)
  if (STRUCT.test(wput) || STRUCT.test(treg)) return null
  const mb = marksOf(b.slice(bs, be)), me = marksOf(wput), mt = marksOf(treg)
  if (me !== mb) return null
  if (mt === mb) return t.slice(0, ws) + wput + t.slice(we)
  if (mt === "") return t.slice(0, ws) + wput.replace(MARK_RE, m => m[0] === "\\" ? m : "") + t.slice(we)
  return null
}

/** 편집(base → edited)을 바꾼 판 parse(target) 위로 옮긴다. 편집된 단위를 바꾼 판에서 못 찾거나 못 옮기면 null */
export function rebaseEdits(base: string, edited: string, target: string): string | null {
  const B = unitsOf(base), E = unitsOf(edited), T = unitsOf(target)
  const bText = B.map(u => plainOf(u).text), tText = T.map(u => plainOf(u).text)
  const tOf = new Map<number, number>()
  for (const [i, k] of alignUnits(bText, tText)) if (i !== null && k !== null) tOf.set(i, k)
  const put = new Map<number, string | null>(), after = new Map<number, string[]>()
  let last = -1
  for (const [i, j] of alignUnits(B, E)) {
    if (i === null) { after.set(last, [...(after.get(last) ?? []), E[j!]]); continue }
    const k = tOf.get(i)
    if (k === undefined) { if (j === null || E[j] !== B[i]) return null; continue }
    last = k
    if (j === null) {
      if (bText[i] !== tText[k]) return null
      put.set(k, null)
    } else if (E[j] !== B[i]) {
      const moved = transplant(B[i], E[j], T[k])
      if (moved === null) return null
      put.set(k, moved)
    }
  }
  const out = [...(after.get(-1) ?? [])]
  T.forEach((u, k) => {
    const v = put.has(k) ? put.get(k) : u
    if (typeof v === "string") out.push(v)
    out.push(...(after.get(k) ?? []))
  })
  return out.join("\n\n")
}

/**
 * 편집 글이 결과에 다 들어갔는가 — 고친·넣은 단위의 글은 있고, 지운 단위의 글은 편집본보다 많이 남지 않는다. 표지와 앞머리 번호는
 * 보지 않는다(자동 번호는 앞 항목을 지우면 당겨진다)
 */
function holdsEdits(base: string, edited: string, result: string): boolean {
  const key = (u: string): string => plainOf(u).text.replace(/^(\(?(\d{1,3}|[가나다라마바사아자차카타파하])[.)]|[①-⑳])/, "")
  const B = unitsOf(base), E = unitsOf(edited)
  const count = (list: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const u of list) m.set(key(u), (m.get(key(u)) ?? 0) + 1)
    return m
  }
  const got = count(unitsOf(result)), want = count(E)
  for (const [i, j] of alignUnits(B, E)) {
    if (j !== null && (i === null || B[i] !== E[j]) && !got.has(key(E[j]))) return false
    if (i !== null && j === null && (got.get(key(B[i])) ?? 0) > (want.get(key(B[i])) ?? 0)) return false
  }
  return true
}
