/**
 * HWP 5.x 표 칸의 줄(문단) 더하기·빼기 (#249). 칸 줄은 칸 문단 하나씩이다 — 마크다운 "<br>" 으로 이어진 줄과 1:1.
 *
 * 고치기 전 줄과 고친 줄을 LCS 로 맞대어 그대로인 줄은 두고, 사이 구간은 앞에서부터 짝지어 고치고(stageParaPatch), 남는 새 줄은
 * 앞 문단(없으면 뒤 문단)의 문단 모양·첫 글자 모양으로 새 문단을 끼우고(한글에서 Enter 와 같다), 남는 옛 줄은 문단 레코드를
 * 통째로 지운다. 칸 머리(LIST_HEADER) 문단 수와 마지막 문단 표시(PARA_HEADER 글자 수 맨 윗비트)를 맞춘다.
 * 새 문단에는 줄 나눔 정보(LINE_SEG)를 넣지 않는다 — 한글이 다시 짠다(patch 가 글을 바꾼 문단과 같다).
 *
 * 개체(표·그림·각주 등)가 든 칸, 지울 문단에 컨트롤이 든 칸, 소스맵 문단 수와 옛 줄 수가 다른 칸은 손대지 않는다(null).
 */
import { TAG_PARA_TEXT } from "../hwp5/record.js"
import { normForMatch } from "./markdown-units.js"
import { stageParaPatch } from "./hwp5-para-stage.js"
import type { ScanCell5, SectionScan5 } from "./hwp5-patch.js"

const TAG_PARA_HEADER = 0x42, TAG_CHAR_SHAPE = 0x44, TAG_CTRL_HEADER = 0x47
const LAST = 0x80000000

/** 문단 레코드 묶음 끝(다음 문단·칸 경계) — header 다음부터 레벨이 더 깊은 레코드까지 */
function groupEnd(scan: SectionScan5, headerIdx: number): number {
  const level = scan.records[headerIdx].level
  let j = headerIdx + 1
  while (j < scan.records.length && scan.records[j].level > level) j++
  return j
}

/** LCS 짝 (i, j) 목록 — 줄 수가 작아(칸 줄) O(n·m) 로 충분하다 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Array<[number, number]> = []
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/**
 * 칸 줄 편집을 스테이징한다. 적용하면 1, 손대지 않고 건너뛰면 0(skip 사유를 남긴다), 이 경로로 못 다루는 칸이면 null(호출자가 종전 처리).
 */
export function stageCellLines(
  scan: SectionScan5, cell: ScanCell5, before: string[], after: string[],
  skip: (reason: string) => number, keepLineseg: boolean,
): number | null {
  if (!scan.safe || cell.tables.length > 0 || before.length !== cell.paras.length || after.length === 0) return null
  const records = scan.records
  const level = records[cell.paras[0].headerIdx].level
  const hasCtrl = (h: number) => { for (let j = h + 1; j < groupEnd(scan, h); j++) if (records[j].tagId === TAG_CTRL_HEADER) return true; return false }

  // 짝짓기: 그대로인 줄(LCS) 사이 구간은 앞에서부터 고침, 남는 새 줄은 더함, 남는 옛 줄은 뺌
  type Op = { kind: "keep" | "edit"; i: number; j: number } | { kind: "add"; j: number } | { kind: "del"; i: number }
  const ops: Op[] = []
  const anchors = [...lcsPairs(before.map(normForMatch), after.map(normForMatch)), [before.length, after.length] as [number, number]]
  let pi = 0, pj = 0
  for (const [ai, aj] of anchors) {
    const gi = ai - pi, gj = aj - pj, both = Math.min(gi, gj)
    for (let k = 0; k < both; k++) ops.push({ kind: "edit", i: pi + k, j: pj + k })
    for (let k = both; k < gj; k++) ops.push({ kind: "add", j: pj + k })
    for (let k = both; k < gi; k++) ops.push({ kind: "del", i: pi + k })
    if (ai < before.length) ops.push({ kind: "keep", i: ai, j: aj })
    pi = ai + 1; pj = aj + 1
  }
  for (const op of ops) if (op.kind === "del" && (hasCtrl(cell.paras[op.i].headerIdx) || cell.paras[op.i].guides.length)) return skip("지울 칸 줄에 개체·누름틀이 있어 미지원")

  // 1) 고친 줄
  for (const op of ops) {
    if (op.kind !== "edit" || normForMatch(before[op.i]) === normForMatch(after[op.j])) continue
    if (!stageParaPatch(scan, cell.paras[op.i], after[op.j], skip, keepLineseg, before[op.i])) return 0
  }
  // 2) 뺀 줄 — 문단 레코드 묶음을 지운다
  for (const op of ops) {
    if (op.kind !== "del") continue
    const h = cell.paras[op.i].headerIdx
    for (let j = h; j < groupEnd(scan, h); j++) scan.repl.set(j, null)
  }
  // 3) 더한 줄 — 앞 문단 뒤(없으면 첫 문단 앞)에 새 문단. 문단 모양·글자 모양은 앞 문단(없으면 뒤 문단)에서
  const finalOrder: Array<{ header: number } | { added: { header: Buffer; recs: Array<{ tagId: number; level: number; data: Buffer }> } }> = []
  let prev = -1  // 마지막으로 놓인 옛 문단 i
  const addAt = (i: number) => (i >= 0 ? groupEnd(scan, cell.paras[i].headerIdx) : cell.paras[0].headerIdx)
  for (const op of ops) {
    if (op.kind === "keep" || op.kind === "edit") { prev = op.i; finalOrder.push({ header: cell.paras[op.i].headerIdx }); continue }
    if (op.kind === "del") { prev = op.i; continue }
    const tpl = cell.paras[prev >= 0 ? prev : 0]
    const th = records[tpl.headerIdx].data
    const shapeId = tpl.charShapeIdx >= 0 && records[tpl.charShapeIdx].data.length >= 8 ? records[tpl.charShapeIdx].data.readUInt32LE(4) : 0
    const text = after[op.j]
    const header = Buffer.from(th)
    header.writeUInt32LE((text ? text.length + 1 : 1) >>> 0, 0)  // 글 + 문단 끝(0x0d). 빈 줄은 PARA_TEXT 없이 1
    header.writeUInt32LE(0, 4)                                    // 컨트롤 없음
    header.writeUInt16LE(1, 12)                                   // 글자 모양 구간 1
    header.writeUInt16LE(0, 14)                                   // 범위 태그 없음
    header.writeUInt16LE(0, 16)                                   // 줄 나눔 정보 없음 — 한글이 다시 짠다
    const cs = Buffer.alloc(8)
    cs.writeUInt32LE(shapeId >>> 0, 4)
    const recs = [
      ...(text ? [{ tagId: TAG_PARA_TEXT, level: level + 1, data: Buffer.concat([Buffer.from(text, "utf16le"), Buffer.from([0x0d, 0x00])]) }] : []),
      { tagId: TAG_CHAR_SHAPE, level: level + 1, data: cs },
    ]
    const added = { header, recs }
    finalOrder.push({ added })
    const at = addAt(prev)
    const list = scan.inserts.get(at) ?? []
    list.push({ tagId: TAG_PARA_HEADER, level, data: header }, ...recs)
    scan.inserts.set(at, list)
  }
  // 4) 마지막 문단 표시·칸 문단 수
  finalOrder.forEach((p, k) => {
    const last = k === finalOrder.length - 1
    if ("added" in p) { p.added.header.writeUInt32LE(((p.added.header.readUInt32LE(0) & ~LAST) | (last ? LAST : 0)) >>> 0, 0); return }
    const cur = scan.repl.get(p.header) ?? records[p.header].data
    if (((cur.readUInt32LE(0) & LAST) !== 0) === last) return
    const next = Buffer.from(cur)
    next.writeUInt32LE(((next.readUInt32LE(0) & ~LAST) | (last ? LAST : 0)) >>> 0, 0)
    scan.repl.set(p.header, next)
  })
  const lh = Buffer.from(scan.repl.get(cell.listHeaderIdx) ?? records[cell.listHeaderIdx].data)
  lh.writeUInt16LE(finalOrder.length, 0)
  scan.repl.set(cell.listHeaderIdx, lh)
  return 1
}
