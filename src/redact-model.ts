/**
 * redact 인명·주소 학습 모델 (opt-in) — Hugging Face `schift-io/schift-ko-pii-ax-v1`(skt/A.X-Encoder-base 를 미세조정한
 * BIOES 태거)을 onnxruntime-node 로 돌려 인명·주소 스팬을 찾는다.
 *
 * 사전·문맥 룰(redact-name-address.ts)은 정밀도를 위해 문맥 없는 맨 이름을 일부러 놓친다. 모델은 그런 이름, 가린 이름
 * (홍○동·김영*), 띄어 쓴 이름(정 하 늘), 지번만 있는 표 칸까지 문장 전체를 보고 잡는 대신 문서 한 건에 수백 ms 가 든다.
 * 찾은 스팬은 redactText·redactMarkdown 의 `modelSpans` 로 넘기면 룰 엔진이 name·address 자리(RULE_PRIORITY)에서 사전
 * 룰보다 먼저 차지하고, 같은 서식 보존 마스킹(성·시·군·구는 남김)을 입힌다. 번호형 룰이 먼저 잡은 곳과 겹치면 버린다.
 *
 * 모델 파일: 리비전 고정 + SHA-256 대조, 캐시 `~/.cache/kordoc/models/schift-pii/` (KORDOC_MODEL_CACHE 로 바꿈)
 *   - int8 (기본, 151MB) — 관보 홀드아웃 F1 .946 · q4 (4-bit, 81MB) — .940, 주소 재현율이 조금 낮다
 * 라이선스: 모델은 Schift License v2.0 (Apache 2.0 + 직전 회계연도 매출 1천만 달러 초과 법인의 영리 사용 제한, 연구·평가·
 *   비영리는 항상 허용). 저장소·npm 패키지에 넣지 않고, 사용자가 켤 때만 받는다.
 *
 * 추론: 512토큰 창(겹침 64). 스팬은 완결된 BIOES 열(B…E, S)만, 점수는 그 토큰들의 최소 확률, 파일별 보정 임계값(보정셋
 * 정밀도 0.95 기준 — 모델 저장소 pii_config.json) 이상만 남긴다. 토크나이저는 tokenizer.json 을 읽는 WordPiece 구현
 * (NFC·BertPreTokenizer·## 접두) — 오프셋이 필요해 @huggingface/tokenizers 대신 여기서 센다.
 */

import { join } from "path"
import { readFile } from "fs/promises"
import { type ModelSpec, type ProgressHandler, ensureModelsIn, getModelsDir } from "./pdf/formula/models.js"
import { disableOrtTelemetry } from "./ocr/runtime-env.js"

type Ort = typeof import("onnxruntime-node")

const REVISION = "d0fd48e688f383d5bca27f4b15e2f3b61a0b010e" // 2026-11-23 main
const BASE = `https://huggingface.co/schift-io/schift-ko-pii-ax-v1/resolve/${REVISION}/`
const offline = (f: string): string =>
  `온라인 PC에서 ${BASE}… 의 파일을 받아 이 PC 모델 캐시의 schift-pii/${f} 로 반입하세요(SHA-256 을 검증한다)`

/** 모델 스펙 (SHA-256 은 실제 다운로드 + HF API lfs.oid 대조로 검증됨 — 변경 금지) */
export const PII_TOKENIZER: ModelSpec = {
  name: "schift-ko-pii-ax-v1 tokenizer",
  filename: "tokenizer.json",
  url: `${BASE}tokenizer.json`,
  sha256: "ef9bebca9c6529bdefa19909059e07dfdfd7c2f8afeefbf4d230a784a3847d64",
  sizeMb: 1.1,
  offlineHint: offline("tokenizer.json"),
}
export const PII_MODEL_INT8: ModelSpec = {
  name: "schift-ko-pii-ax-v1 int8",
  filename: "pii_int8.onnx",
  url: `${BASE}onnx/pii_int8.onnx`,
  sha256: "9070138ab3d3d1ebb0d1c5211ff4a10f5db35c7c09ae17261001e1aa0084b81c",
  sizeMb: 151,
  offlineHint: offline("pii_int8.onnx"),
}
export const PII_MODEL_Q4: ModelSpec = {
  name: "schift-ko-pii-ax-v1 q4",
  filename: "pii_q4b128.onnx",
  url: `${BASE}onnx/pii_q4b128.onnx`,
  sha256: "f58a873a6eb23bea6ab03f1cdd7b8b59cacf8fc688c9c1741d822e1661ed0be9",
  sizeMb: 81,
  offlineHint: offline("pii_q4b128.onnx"),
}

export type PiiModelVariant = "int8" | "q4"

/** 파일별 보정 임계값 — 모델 저장소 pii_config.json 의 thresholds (리비전 고정이라 여기 적는다) */
const VARIANTS: Record<PiiModelVariant, { spec: ModelSpec; threshold: number }> = {
  int8: { spec: PII_MODEL_INT8, threshold: 0.625 },
  q4: { spec: PII_MODEL_Q4, threshold: 0.725 },
}

export const PII_MODEL_LABELS: readonly string[] = [
  "O",
  "B-private_person", "I-private_person", "E-private_person", "S-private_person",
  "B-private_address", "I-private_address", "E-private_address", "S-private_address",
]
const GROUP_RULE: Readonly<Record<string, "name" | "address">> = { private_person: "name", private_address: "address" }

/** 모델이 찾은 스팬 — index·length 는 detect() 에 넘긴 문자열 기준 UTF-16 단위 */
export interface ModelSpan {
  rule: "name" | "address"
  index: number
  length: number
  /** 스팬 토큰들의 최소 확률 */
  score: number
}

export interface PiiModel {
  readonly variant: PiiModelVariant | "custom"
  detect(text: string): Promise<ModelSpan[]>
  release(): Promise<void>
}

export interface PiiModelOptions {
  /** 기본 int8 */
  variant?: PiiModelVariant
  /** onnxruntime intraOp 스레드 수 (기본: onnxruntime 기본값) */
  threads?: number
  onProgress?: ProgressHandler
}

export function getPiiModelsDir(): string {
  return getModelsDir("schift-pii")
}

export const ALL_PII_MODELS: ReadonlyArray<ModelSpec> = [PII_TOKENIZER, PII_MODEL_INT8, PII_MODEL_Q4]

/** 모델 파일을 받고(이미 있으면 SHA 만 대조) 세션을 연다 */
export async function loadPiiModel(options?: PiiModelOptions): Promise<PiiModel> {
  const variant = options?.variant ?? "int8"
  const v = VARIANTS[variant]
  if (!v) throw new Error(`알 수 없는 PII 모델: ${variant} (int8 · q4)`)
  const dir = getPiiModelsDir()
  await ensureModelsIn(dir, [PII_TOKENIZER, v.spec], options?.onProgress)
  let ort: Ort
  try {
    disableOrtTelemetry() // OCR·수식 엔진과 같이 — 런타임을 처음 부르기 전에 (docs/offline-deployment.md)
    ort = await import("onnxruntime-node")
  } catch (e) {
    throw new Error(
      `인명·주소 모델을 쓰려면 optional dependency 'onnxruntime-node' 가 필요합니다. ` +
        `\`npm install onnxruntime-node\` 후 다시 실행하세요. 원인: ${(e as Error).message}`,
    )
  }
  const session = await ort.InferenceSession.create(join(dir, v.spec.filename), {
    graphOptimizationLevel: "all",
    executionProviders: ["cpu"],
    logSeverityLevel: 3,
    ...(options?.threads ? { intraOpNumThreads: options.threads } : {}),
  })
  const tokenizer = JSON.parse(await readFile(join(dir, PII_TOKENIZER.filename), "utf-8")) as TokenizerJson
  return createPiiModel({ ort, session, tokenizer, threshold: v.threshold, variant })
}

const shared = new Map<string, Promise<PiiModel>>()

/** 같은 프로세스에서 한 번만 여는 공용 모델 (CLI 다중 파일·MCP 반복 호출용). 실패하면 캐시하지 않는다 */
export function sharedPiiModel(options?: PiiModelOptions): Promise<PiiModel> {
  const key = `${options?.variant ?? "int8"}:${options?.threads ?? ""}`
  let p = shared.get(key)
  if (!p) {
    p = loadPiiModel(options)
    p.catch(() => shared.delete(key))
    shared.set(key, p)
  }
  return p
}

// ─── 추론 ─────────────────────────────────────────────

/** onnxruntime 중 이 모듈이 쓰는 부분 — 시험에서 가짜 세션을 넣을 수 있게 좁힌다 */
export interface PiiSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims?: readonly number[] }>>
  release?(): Promise<void>
}
export interface PiiOrt {
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown
}

export interface CreatePiiModelOptions {
  ort: PiiOrt
  session: PiiSession
  tokenizer: TokenizerJson
  threshold: number
  variant?: PiiModelVariant | "custom"
  labels?: readonly string[]
  /** 창 길이 (템플릿 토큰 2개 포함). 기본 512 */
  maxTokens?: number
  /** 이웃 창이 겹치는 토큰 수. 기본 64 */
  overlapTokens?: number
}

export function createPiiModel(o: CreatePiiModelOptions): PiiModel {
  const labels = o.labels ?? PII_MODEL_LABELS
  if (labels[0] !== "O") throw new Error("labels 첫 항목은 O 여야 함")
  const tok = createWordPiece(o.tokenizer)
  const width = (o.maxTokens ?? 512) - 2
  const overlap = o.overlapTokens ?? 64
  if (width <= overlap) throw new Error("maxTokens - 2 가 overlapTokens 보다 커야 함")
  const L = labels.length

  async function window(ids: number[], offsets: Array<[number, number]>): Promise<Array<[number, number, string, number]>> {
    const all = [tok.bos, ...ids, tok.eos]
    const n = all.length
    const out = await o.session.run({
      input_ids: new o.ort.Tensor("int64", BigInt64Array.from(all, BigInt), [1, n]),
      attention_mask: new o.ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
    })
    const logits = (out.logits ?? Object.values(out)[0]).data as Float32Array
    if (logits.length !== n * L) throw new Error(`logits 크기 ${logits.length} ≠ ${n}토큰 × ${L}라벨`)
    const tags: number[] = []
    const conf: number[] = []
    // 템플릿 토큰(첫·끝)은 빼고 ids[k] 는 k+1 행
    for (let k = 1; k < n - 1; k++) {
      let max = -Infinity
      let arg = 0
      for (let j = 0; j < L; j++) {
        const x = logits[k * L + j]
        if (x > max) { max = x; arg = j }
      }
      let z = 0
      for (let j = 0; j < L; j++) z += Math.exp(logits[k * L + j] - max)
      tags.push(arg)
      conf.push(1 / z)
    }
    return decodeBioes(tags, conf, offsets, labels).filter((s) => s[3] >= o.threshold)
  }

  return {
    variant: o.variant ?? "custom",
    async detect(text: string): Promise<ModelSpan[]> {
      if (!text) return []
      const { ids, offsets } = tok.encode(text)
      if (ids.length === 0) return []
      const found: Array<[number, number, string, number]> = []
      for (let i = 0; ; i += width - overlap) {
        const end = Math.min(i + width, ids.length)
        found.push(...await window(ids.slice(i, end), offsets.slice(i, end)))
        if (end >= ids.length) break
      }
      // 코드 포인트 → UTF-16, 창 겹침에서 두 번 나온 스팬·겹친 스팬은 앞선·긴 것 하나만
      const u16 = utf16Index(text)
      found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
      const spans: ModelSpan[] = []
      let lastEnd = -1
      for (const [s, e, group, score] of found) {
        const rule = GROUP_RULE[group]
        if (!rule || s < lastEnd) continue
        spans.push({ rule, index: u16[s], length: u16[e] - u16[s], score })
        lastEnd = e
      }
      return spans
    },
    async release(): Promise<void> {
      await o.session.release?.()
    },
  }
}

/** 완결된 BIOES 열 → [시작, 끝, 그룹, 최소 확률] (코드 포인트). B…(I)…E 가 같은 그룹으로 이어져야 하고 S 는 단독 */
export function decodeBioes(
  tags: readonly number[], conf: readonly number[], offsets: ReadonlyArray<[number, number]>, labels: readonly string[],
): Array<[number, number, string, number]> {
  const spans: Array<[number, number, string, number]> = []
  let open: [number, string, number] | null = null
  tags.forEach((t, k) => {
    const [s, e] = offsets[k]
    if (t === 0 || e <= s) { open = null; return }
    const dash = labels[t].indexOf("-")
    const pos = labels[t].slice(0, dash)
    const group = labels[t].slice(dash + 1)
    const p = conf[k]
    if (pos === "S") spans.push([s, e, group, p])
    if (pos === "E" && open && open[1] === group) spans.push([open[0], e, group, Math.min(open[2], p)])
    if (pos === "B") open = [s, group, p]
    else if (pos === "I" && open && open[1] === group) open = [open[0], group, Math.min(open[2], p)]
    else open = null
  })
  return spans
}

/** 코드 포인트 위치 → UTF-16 위치 (길이 = 코드 포인트 수 + 1) */
function utf16Index(text: string): number[] {
  const idx = [0]
  let u = 0
  for (const ch of text) { u += ch.length; idx.push(u) }
  return idx
}

// ─── WordPiece (tokenizer.json) ───────────────────────

export interface TokenizerJson {
  model: { type: string; vocab: Record<string, number>; unk_token: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number }
  added_tokens?: Array<{ id: number; content: string; special?: boolean }>
  normalizer?: { type: string } | null
  post_processor?: { type: string; special_tokens?: Record<string, { ids: number[] }> } | null
}

interface Encoding {
  ids: number[]
  /** 원문 코드 포인트 [시작, 끝) — id 마다 하나 */
  offsets: Array<[number, number]>
}

// Rust char::is_whitespace (Unicode White_Space) — BertPreTokenizer 가 쓰는 공백 집합
const WHITESPACE = new Set<number>([0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
for (let c = 0x2000; c <= 0x200a; c++) WHITESPACE.add(c)
const ASCII_PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
const isPunct = (ch: string): boolean => ASCII_PUNCT.has(ch) || /\p{P}/u.test(ch)
/** NFC 가 앞 글자에 합칠 수 있는 코드 포인트 — 결합 표시·한글 중성/종성 자모 */
const continuesCluster = (ch: string): boolean => {
  const c = ch.codePointAt(0)!
  return /\p{M}/u.test(ch) || (c >= 0x1160 && c <= 0x11ff) || (c >= 0xd7b0 && c <= 0xd7ff)
}

interface NormChar { ch: string; from: number; to: number }

/** 덩어리별 NFC — 정규화 글자마다 원문 코드 포인트 범위를 들고 간다 (NFD 자모 셋이 한 음절이면 셋 다 덮는다) */
function normalizeNfc(chars: readonly string[], base: number): NormChar[] {
  const out: NormChar[] = []
  let i = 0
  while (i < chars.length) {
    let j = i + 1
    while (j < chars.length && continuesCluster(chars[j])) j++
    const norm = Array.from(chars.slice(i, j).join("").normalize("NFC"))
    if (norm.length === j - i) norm.forEach((ch, k) => out.push({ ch, from: base + i + k, to: base + i + k + 1 }))
    else norm.forEach((ch) => out.push({ ch, from: base + i, to: base + j }))
    i = j
  }
  return out
}

export function createWordPiece(tj: TokenizerJson): { encode(text: string): Encoding; bos: number; eos: number } {
  if (tj.model?.type !== "WordPiece") throw new Error(`지원하지 않는 토크나이저 모델: ${tj.model?.type}`)
  const normType = tj.normalizer?.type ?? null
  if (normType !== null && normType !== "NFC") throw new Error(`지원하지 않는 정규화: ${normType}`)
  const vocab = new Map(Object.entries(tj.model.vocab))
  const unk = vocab.get(tj.model.unk_token)
  if (unk === undefined) throw new Error("unk_token 이 vocab 에 없음")
  const prefix = tj.model.continuing_subword_prefix ?? "##"
  const maxChars = tj.model.max_input_chars_per_word ?? 100
  const special = (tj.added_tokens ?? []).filter((a) => a.special)
    .map((a) => ({ id: a.id, content: Array.from(a.content) }))
    .sort((a, b) => b.content.length - a.content.length)
  const tmpl = tj.post_processor?.special_tokens ?? {}
  const bos = tmpl["<s>"]?.ids?.[0]
  const eos = tmpl["</s>"]?.ids?.[0]
  if (bos === undefined || eos === undefined) throw new Error("tokenizer post_processor 에 <s>·</s> 가 없음")

  function wordpiece(word: NormChar[], out: Encoding): void {
    const from = word[0].from
    const to = word[word.length - 1].to
    if (word.length > maxChars) { out.ids.push(unk!); out.offsets.push([from, to]); return }
    const chars = word.map((w) => w.ch)
    const pieces: Array<[number, number, number]> = []
    let start = 0
    while (start < chars.length) {
      let end = chars.length
      let id: number | undefined
      while (start < end) {
        id = vocab.get((start > 0 ? prefix : "") + chars.slice(start, end).join(""))
        if (id !== undefined) break
        end--
      }
      // 한 조각이라도 vocab 에 없으면 낱말 전체가 [UNK] 하나 (HF WordPiece 와 같다)
      if (id === undefined) { out.ids.push(unk!); out.offsets.push([from, to]); return }
      pieces.push([id, word[start].from, word[end - 1].to])
      start = end
    }
    for (const [id, s, e] of pieces) { out.ids.push(id); out.offsets.push([s, e]) }
  }

  function pretokenize(chars: NormChar[], out: Encoding): void {
    let word: NormChar[] = []
    const flush = (): void => { if (word.length) wordpiece(word, out); word = [] }
    for (const c of chars) {
      if (WHITESPACE.has(c.ch.codePointAt(0)!)) flush()
      else if (isPunct(c.ch)) { flush(); wordpiece([c], out) }
      else word.push(c)
    }
    flush()
  }

  function encode(text: string): Encoding {
    const chars = Array.from(text)
    const out: Encoding = { ids: [], offsets: [] }
    // 특수 토큰(<s>·<mask> …)은 정규화 전 원문에서 먼저 떼어 낸다
    let seg = 0
    let i = 0
    while (i < chars.length) {
      const hit = special.find((s) => s.content.length <= chars.length - i && s.content.every((ch, k) => chars[i + k] === ch))
      if (hit) {
        pretokenize(normalizeNfc(chars.slice(seg, i), seg), out)
        out.ids.push(hit.id)
        out.offsets.push([i, i + hit.content.length])
        i += hit.content.length
        seg = i
      } else i++
    }
    pretokenize(normalizeNfc(chars.slice(seg), seg), out)
    return out
  }

  return { encode, bos, eos }
}
