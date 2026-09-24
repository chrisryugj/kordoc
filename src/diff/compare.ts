/** 문서 비교 엔진 — IR 레벨 블록 비교로 신구대조표 생성 */

import { parse } from "../index.js"
import { normalizedSimilarity, textProfile, similarityUpperBound } from "./text-diff.js"
import type { IRBlock, IRTable, DiffResult, BlockDiff, CellDiff, DiffChangeType, ParseOptions } from "../types.js"

/** 유사도 임계값 — 이 이상이면 modified, 미만이면 removed+added */
const SIMILARITY_THRESHOLD = 0.4

/**
 * 두 문서를 비교하여 블록 단위 diff 생성.
 * 크로스 포맷 지원 — HWP vs HWPX 비교 가능 (IR 레벨).
 */
export async function compare(
  bufferA: ArrayBuffer,
  bufferB: ArrayBuffer,
  options?: ParseOptions
): Promise<DiffResult> {
  const [resultA, resultB] = await Promise.all([
    parse(bufferA, options),
    parse(bufferB, options),
  ])

  if (!resultA.success) throw new Error(`문서A 파싱 실패: ${resultA.error}`)
  if (!resultB.success) throw new Error(`문서B 파싱 실패: ${resultB.error}`)

  return diffBlocks(resultA.blocks, resultB.blocks)
}

/** IRBlock[] 간 diff — LCS 기반 정렬 */
export function diffBlocks(blocksA: IRBlock[], blocksB: IRBlock[]): DiffResult {
  const aligned = alignBlocks(blocksA, blocksB)
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 }
  const diffs: BlockDiff[] = []

  for (const [a, b] of aligned) {
    if (a && b) {
      const sim = blockSimilarity(a, b)
      if (sim >= 0.99) {
        diffs.push({ type: "unchanged", before: a, after: b, similarity: 1 })
        stats.unchanged++
      } else {
        const diff: BlockDiff = { type: "modified", before: a, after: b, similarity: sim }
        if (a.type === "table" && b.type === "table" && a.table && b.table) {
          diff.cellDiffs = diffTableCells(a.table, b.table)
        }
        diffs.push(diff)
        stats.modified++
      }
    } else if (a) {
      diffs.push({ type: "removed", before: a })
      stats.removed++
    } else if (b) {
      diffs.push({ type: "added", after: b })
      stats.added++
    }
  }

  return { stats, diffs }
}

// ─── 블록 정렬 (LCS 기반) ───────────────────────────

function alignBlocks(a: IRBlock[], b: IRBlock[]): [IRBlock | null, IRBlock | null][] {
  const m = a.length, n = b.length

  // 대형 문서 보호
  if (m * n > 10_000_000) return fallbackAlign(a, b)

  // 블록마다 한 번: 비교 글(표는 셀 글 이음 — blockSimilarity 와 같은 글)의 정규화 길이·글자 구성
  const textOf = (blk: IRBlock): string => blk.text !== undefined
    ? blk.text
    : blk.type === "table" && blk.table ? blk.table.cells.flat().map(c => c?.text ?? "").join(" ") : ""
  const pa = a.map(blk => textProfile(textOf(blk)))
  const pb = b.map(blk => textProfile(textOf(blk)))

  // 쌍마다 "유사도 ≥ 임계" 만 쓰인다 (값은 diffBlocks 가 짝지은 쌍만 다시 잰다) — 0 모름·1 이상·2 미만.
  // 종전 Map<"i,j", 유사도> 는 쌍마다 Levenshtein 을 돌려 2,000블록 쌍에 120초·수백 MB 였다 (v4.14.4 리뷰 실측)
  const passCache = new Uint8Array(m * n)
  const passes = (i: number, j: number): boolean => {
    const k = i * n + j
    if (passCache[k] === 0) passCache[k] = pairReaches(i, j) ? 1 : 2
    return passCache[k] === 1
  }
  const pairReaches = (i: number, j: number): boolean => {
    const x = a[i], y = b[j]
    if (x.type !== y.type) return false // blockSimilarity 0
    // 길이비 프리필터 — Levenshtein 하한(sim ≤ 1 − 길이차/max)으로 임계 미달이
    // 확정인 쌍은 계산 없이 0 (전쌍 O(len²) 캡). 표는 dimSim 0.3 가중이 있어
    // 6/7 초과일 때만 확정 (0.3 + 0.7×(1/7) = 0.4 = 임계).
    const mx = Math.max(pa[i].len, pb[j].len)
    const cut = x.type === "table" ? 6 / 7 : 1 - SIMILARITY_THRESHOLD
    if (mx > 0 && (mx - Math.min(pa[i].len, pb[j].len)) / mx > cut) return false
    // 글자 구성 상한(similarityUpperBound) — 값은 blockSimilarity 와 같고 계산만 건너뛴다. 상한 글이 실제 비교 글과
    // 같은 두 경우만: 둘 다 text 가 있는 블록, 둘 다 text 없는 표
    if (x.text !== undefined && y.text !== undefined) {
      if (similarityUpperBound(pa[i], pb[j]) < SIMILARITY_THRESHOLD) return false
    } else if (x.text === undefined && y.text === undefined && x.table && y.table) {
      if (tableDimSim(x.table, y.table) * 0.3 + similarityUpperBound(pa[i], pb[j]) * 0.7 < SIMILARITY_THRESHOLD) return false
    }
    return blockSimilarity(x, y) >= SIMILARITY_THRESHOLD
  }

  // LCS with similarity threshold
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (passes(i - 1, j - 1)) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // 역추적
  const pairs: [number, number][] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (passes(i - 1, j - 1) && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push([i - 1, j - 1]); i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  pairs.reverse()

  // 정렬 결과 조립
  const result: [IRBlock | null, IRBlock | null][] = []
  let ai = 0, bi = 0
  for (const [pi, pj] of pairs) {
    while (ai < pi) result.push([a[ai++], null])
    while (bi < pj) result.push([null, b[bi++]])
    result.push([a[ai++], b[bi++]])
  }
  while (ai < m) result.push([a[ai++], null])
  while (bi < n) result.push([null, b[bi++]])

  return result
}

function fallbackAlign(a: IRBlock[], b: IRBlock[]): [IRBlock | null, IRBlock | null][] {
  const result: [IRBlock | null, IRBlock | null][] = []
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    result.push([a[i] || null, b[i] || null])
  }
  return result
}

// ─── 블록 유사도 ────────────────────────────────────

function blockSimilarity(a: IRBlock, b: IRBlock): number {
  if (a.type !== b.type) return 0

  // 텍스트 기반 블록: paragraph, heading, list, image(alt text)
  if (a.text !== undefined && b.text !== undefined) {
    return normalizedSimilarity(a.text || "", b.text || "")
  }

  if (a.type === "table" && a.table && b.table) {
    return tableSimilarity(a.table, b.table)
  }

  // separator 등 텍스트 없는 동일 타입 → 완전 일치
  if (a.type === b.type) return 1

  return 0
}

/** 표 구조 유사도 (차원) */
function tableDimSim(a: IRTable, b: IRTable): number {
  return 1 - Math.abs(a.rows * a.cols - b.rows * b.cols) / Math.max(a.rows * a.cols, b.rows * b.cols, 1)
}

function tableSimilarity(a: IRTable, b: IRTable): number {
  const dimSim = tableDimSim(a, b)

  // 내용 유사도 (셀 텍스트) — ragged 입력 방어(?.)
  const textsA = a.cells.flat().map(c => c?.text ?? "").join(" ")
  const textsB = b.cells.flat().map(c => c?.text ?? "").join(" ")
  const contentSim = normalizedSimilarity(textsA, textsB)

  return dimSim * 0.3 + contentSim * 0.7
}

// ─── 테이블 셀 diff ─────────────────────────────────

function diffTableCells(a: IRTable, b: IRTable): CellDiff[][] {
  const maxRows = Math.max(a.rows, b.rows)
  const maxCols = Math.max(a.cols, b.cols)
  const result: CellDiff[][] = []

  for (let r = 0; r < maxRows; r++) {
    const row: CellDiff[] = []
    for (let c = 0; c < maxCols; c++) {
      // 선언 rows/cols보다 실제 cells가 짧은 비정합(ragged) 입력 방어
      const cellA = r < a.rows && c < a.cols ? a.cells[r]?.[c]?.text : undefined
      const cellB = r < b.rows && c < b.cols ? b.cells[r]?.[c]?.text : undefined

      let type: DiffChangeType
      if (cellA === undefined) type = "added"
      else if (cellB === undefined) type = "removed"
      else if (cellA === cellB) type = "unchanged"
      else type = "modified"

      row.push({ type, before: cellA, after: cellB })
    }
    result.push(row)
  }
  return result
}
