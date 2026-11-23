/**
 * CTC prefix beam search — 줄 하나의 읽기 후보를 확률 내림차순으로 낸다 (`ocrLineCandidates`).
 *
 * greedy 디코드(engine.ts ctcDecode)는 시점마다 최고 클래스만 따라간 정렬 하나의 글이다. 여기서는 같은 글로 접히는 정렬을 모두 더해
 * 그 글의 확률 P(글 | 줄 그림)을 구한다 — 그래서 후보끼리 견줄 수 있고, 모든 글의 합이 1 을 넘지 않는다.
 * 빔 폭과 시점마다 보는 클래스 수를 묶어 둔 근사라, 값은 참값보다 조금 작을 수 있다(버린 정렬만큼).
 */

import type { OcrLineCandidate } from "../types.js"

/** 남기는 접두 수 — 후보 상한(5)의 여섯 배 남짓. 줄 하나의 일은 시점 수 × 이 값 × (FRAME_TOP_K + 1) 로 묶인다 */
const BEAM_WIDTH = 32
/** 시점마다 펼치는 글자 클래스 수 (blank 제외, 확률 높은 순) */
const FRAME_TOP_K = 8
/** 이보다 낮은 클래스는 펼치지 않는다 — 상위 후보에 닿지 못한다 */
const MIN_SYMBOL_PROB = 1e-4

const logAdd = (a: number, b: number): number => a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)))

/**
 * rec 출력(T 시점 × C 클래스, blank = 0, 1..N = 사전, N+1 = 공백) → 서로 다른 읽기 상위 n 개.
 * 글은 앞뒤 공백을 떼고, 그렇게 같아진 읽기는 확률을 더한다. 빈 글(모두 blank)은 후보로 내지 않는다.
 */
export function ctcCandidates(data: Float32Array, T: number, C: number, dict: string[], n: number): OcrLineCandidate[] {
  if (n <= 0 || T <= 0) return []
  // 접두는 클래스 번호를 글자 코드로 쓴 문자열 (C 는 사전 + 2 라 16비트 안) → [blank 로 끝난 로그 확률, 글자로 끝난 로그 확률]
  let beams = new Map<string, [number, number]>([["", [0, -Infinity]]])
  const top = new Int32Array(FRAME_TOP_K)
  const topP = new Float64Array(FRAME_TOP_K)
  for (let t = 0; t < T; t++) {
    const off = t * C
    // ctcDecode 와 같은 규칙 — 출력이 softmax 확률이 아니면(범위 밖 값) 그 시점을 정규화한다
    let max = -Infinity, negative = false
    for (let c = 0; c < C; c++) { const v = data[off + c]; if (v > max) max = v; if (v < 0) negative = true }
    const logits = negative || max > 1.0001
    let denom = 1
    if (logits) { denom = 0; for (let c = 0; c < C; c++) denom += Math.exp(data[off + c] - max) }
    const prob = (c: number) => logits ? Math.exp(data[off + c] - max) / denom : data[off + c]
    let k = 0
    for (let c = 1; c < C; c++) {
      const p = prob(c)
      if (p < MIN_SYMBOL_PROB || (k === FRAME_TOP_K && p <= topP[k - 1])) continue
      let i = k < FRAME_TOP_K ? k++ : k - 1
      for (; i > 0 && topP[i - 1] < p; i--) { top[i] = top[i - 1]; topP[i] = topP[i - 1] }
      top[i] = c; topP[i] = p
    }
    const blank = Math.log(prob(0))
    const next = new Map<string, [number, number]>()
    const slot = (key: string) => { let s = next.get(key); if (!s) next.set(key, s = [-Infinity, -Infinity]); return s }
    for (const [prefix, [pb, pnb]] of beams) {
      const total = logAdd(pb, pnb)
      const last = prefix ? prefix.charCodeAt(prefix.length - 1) : -1
      const same = slot(prefix)
      same[0] = logAdd(same[0], total + blank)
      // 같은 글자가 이어지면 접두는 그대로다 (상위 k 밖이어도 그 클래스의 값으로)
      if (last > 0) same[1] = logAdd(same[1], pnb + Math.log(prob(last)))
      for (let i = 0; i < k; i++) {
        const s = slot(prefix + String.fromCharCode(top[i]))
        // 같은 글자를 한 번 더 쓰려면 사이에 blank 가 있어야 한다
        s[1] = logAdd(s[1], (top[i] === last ? pb : total) + Math.log(topP[i]))
      }
    }
    const ranked = [...next].sort((a, b) => logAdd(b[1][0], b[1][1]) - logAdd(a[1][0], a[1][1]))
    beams = new Map(ranked.slice(0, BEAM_WIDTH))
  }
  const byText = new Map<string, number>()
  for (const [prefix, [pb, pnb]] of beams) {
    let text = ""
    for (let i = 0; i < prefix.length; i++) { const c = prefix.charCodeAt(i); text += c <= dict.length ? dict[c - 1] : c === dict.length + 1 ? " " : "" }
    text = text.trim()
    const p = Math.exp(logAdd(pb, pnb))
    // 확률 0 인 접두(같은 글자를 blank 없이 이어 쓴 것 등)는 읽기가 아니다
    if (text && p > 0) byText.set(text, (byText.get(text) ?? 0) + p)
  }
  return [...byText].sort((a, b) => b[1] - a[1]).slice(0, n).map(([text, p]) => ({ text, probability: Math.min(1, p) }))
}
