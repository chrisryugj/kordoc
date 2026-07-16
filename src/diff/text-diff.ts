/** 텍스트 유사도 및 diff 유틸리티 — 외부 의존성 없음 */

export interface TextChange {
  type: "equal" | "insert" | "delete"
  text: string
}

/** 두 문자열의 유사도 (0-1). 1 = 동일, 0 = 완전히 다름 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/** 공백 정규화 후 유사도 비교 (HWP/HWPX 포맷 차이 흡수) */
export function normalizedSimilarity(a: string, b: string): number {
  return similarity(normalize(a), normalize(b))
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** 최대 입력 길이 합 — 초과 시 길이 차이 기반 빠른 추정 (O(m*n) CPU 폭발 방지) */
const MAX_LEVENSHTEIN_LEN = 10_000

/**
 * 초과 길이 근사 거리 — 문자 bigram(shingle) 다중집합의 Dice 유사도 기반.
 * 위치 정렬 샘플 비교는 접두 삽입/삭제(shift)에 전량 불일치로 폭주하던 것을 교정.
 */
function approxDistance(a: string, b: string): number {
  const bigramCounts = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ca = bigramCounts(a)
  const cb = bigramCounts(b)
  let inter = 0
  for (const [g, n] of ca) inter += Math.min(n, cb.get(g) ?? 0)
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0)
  const dice = total > 0 ? (2 * inter) / total : 1
  return Math.round(Math.max(a.length, b.length) * (1 - dice))
}

/** Levenshtein 편집 거리 — O(min(m,n)) 공간 최적화 */
function levenshtein(a: string, b: string): number {
  if (a.length + b.length > MAX_LEVENSHTEIN_LEN) {
    return approxDistance(a, b)
  }
  if (a.length > b.length) [a, b] = [b, a]
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: m + 1 }, (_, i) => i)
  let curr = new Array(m + 1)

  for (let j = 1; j <= n; j++) {
    curr[0] = j
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1]
      } else {
        curr[i] = 1 + Math.min(prev[i - 1], prev[i], curr[i - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[m]
}

/** 단어 단위 diff — LCS 기반 */
export function textDiff(a: string, b: string): TextChange[] {
  const wordsA = a.split(/(\s+)/)
  const wordsB = b.split(/(\s+)/)
  const lcs = lcsWords(wordsA, wordsB)

  const changes: TextChange[] = []
  let ia = 0, ib = 0, il = 0

  while (il < lcs.length) {
    // lcs 원소 이전에 있는 것들
    while (ia < wordsA.length && wordsA[ia] !== lcs[il]) {
      changes.push({ type: "delete", text: wordsA[ia++] })
    }
    while (ib < wordsB.length && wordsB[ib] !== lcs[il]) {
      changes.push({ type: "insert", text: wordsB[ib++] })
    }
    changes.push({ type: "equal", text: lcs[il] })
    ia++; ib++; il++
  }
  // 나머지
  while (ia < wordsA.length) changes.push({ type: "delete", text: wordsA[ia++] })
  while (ib < wordsB.length) changes.push({ type: "insert", text: wordsB[ib++] })

  return mergeChanges(changes)
}

function lcsWords(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length
  // 대형 문서 보호: 5000 단어 초과 시 간이 비교
  if (m * n > 25_000_000) return simpleIntersect(a, b)

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const result: string[] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.push(a[i - 1]); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--
    else j--
  }
  return result.reverse()
}

/**
 * 대형 입력 LCS 폴백 — 그리디 순서 매칭. 결과가 a·b 양쪽의 부분수열이 되도록
 * b에서 항상 앞으로만 전진한다 (집합 교집합은 b의 순서를 무시해 textDiff 재생 시
 * 가짜 equal을 만들던 계약 위반 교정). O(m+n) 상각.
 */
function simpleIntersect(a: string[], b: string[]): string[] {
  const pos = new Map<string, number[]>()
  for (let i = 0; i < b.length; i++) {
    let list = pos.get(b[i])
    if (!list) pos.set(b[i], (list = []))
    list.push(i)
  }
  const ptr = new Map<string, number>()
  const result: string[] = []
  let j = 0
  for (const w of a) {
    const list = pos.get(w)
    if (!list) continue
    let k = ptr.get(w) ?? 0
    while (k < list.length && list[k] < j) k++
    if (k < list.length) {
      result.push(w)
      j = list[k] + 1
      ptr.set(w, k + 1)
    } else {
      ptr.set(w, k)
    }
  }
  return result
}

function mergeChanges(changes: TextChange[]): TextChange[] {
  if (changes.length === 0) return changes
  const merged: TextChange[] = [changes[0]]
  for (let i = 1; i < changes.length; i++) {
    const last = merged[merged.length - 1]
    if (last.type === changes[i].type) {
      last.text += changes[i].text
    } else {
      merged.push({ ...changes[i] })
    }
  }
  return merged
}
