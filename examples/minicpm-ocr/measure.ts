#!/usr/bin/env node
/**
 * MiniCPM-OCR 페이지 경로의 처리 시간과(정답을 주면) 문자 오류율(CER)을 잰다.
 *
 * 사용:
 *   MINICPM_OCR_ENDPOINT=http://127.0.0.1:18499/v1/chat/completions \
 *     node --import tsx examples/minicpm-ocr/measure.ts 스캔본.pdf --gt 정답.txt
 *
 * 주의:
 *  - OcrProvider 경로는 쪽 단위 텍스트만 돌려주므로 줄 좌표가 없다 — 정확도는
 *    "줄 단위"가 아니라 쪽 단위 CER 이다. 줄 단위 정확도는 내장 엔진 경로
 *    (`ocrLines`)에서만 잴 수 있다.
 *  - 정답(--gt)은 같은 쪽들을 사람이 옮겨 적은 텍스트여야 한다. 내장 OCR 결과를
 *    정답으로 쓰면 두 엔진의 차이만 재게 된다.
 *  - 서버·코퍼스가 없으면 시간만 잰다.
 */
import { readFile } from "node:fs/promises"
import { parse } from "kordoc"
import { createMiniCPMOcrProvider, type MiniCPMOcrOptions } from "./provider.js"

const args = process.argv.slice(2)
const file = args.find(arg => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--gt")
const gtPath = valueOf("--gt")
const endpoint = process.env.MINICPM_OCR_ENDPOINT

if (!file || !endpoint) {
  console.error("사용: MINICPM_OCR_ENDPOINT=... node --import tsx examples/minicpm-ocr/measure.ts <파일> [--gt 정답.txt]")
  process.exit(2)
}

const baseOptions: MiniCPMOcrOptions = {
  endpoint,
  model: process.env.MINICPM_OCR_MODEL,
  apiKey: process.env.MINICPM_OCR_API_KEY,
  prompt: process.env.MINICPM_OCR_PROMPT,
  maxTokens: process.env.MINICPM_OCR_MAX_TOKENS ? Number(process.env.MINICPM_OCR_MAX_TOKENS) : undefined,
}

const pageTimes: number[] = []
const result = await (async () => {
  const provider = createMiniCPMOcrProvider(baseOptions)
  const timed = async (...providerArgs: Parameters<typeof provider>) => {
    const startedAt = performance.now()
    try {
      return await provider(...providerArgs)
    } finally {
      pageTimes.push(performance.now() - startedAt)
    }
  }
  return parse(file, { ocr: timed })
})()

if (!result.success) {
  console.error(`파싱 실패: ${result.error}`)
  process.exit(1)
}

const totalSeconds = pageTimes.reduce((sum, ms) => sum + ms, 0) / 1000
const meanMs = pageTimes.length ? totalSeconds * 1000 / pageTimes.length : 0

console.log(`pages:            ${result.pageCount ?? "?"}`)
console.log(`provider calls:   ${pageTimes.length}`)
console.log(`provider total:   ${totalSeconds.toFixed(1)}s`)
console.log(`provider mean:    ${meanMs.toFixed(0)}ms/page`)

if (gtPath) {
  const reference = normalize(await readFile(gtPath, "utf8"))
  const hypothesis = normalize(result.markdown)
  console.log(`reference chars:  ${reference.length}`)
  console.log(`output chars:     ${hypothesis.length}`)
  console.log(`CER:              ${(characterErrorRate(reference, hypothesis) * 100).toFixed(2)}%`)
}

/** 마크다운 장식·공백을 걷어낸 비교용 텍스트. */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 이미지 링크
    .replace(/[#>*_`~|-]/g, "")           // 마크다운 기호
    .replace(/\s+/g, "")
}

/** 문자 오류율 = 편집 거리 / 정답 길이. */
function characterErrorRate(reference: string, hypothesis: string): number {
  const maxChars = 20_000
  const ref = reference.slice(0, maxChars)
  const hyp = hypothesis.slice(0, maxChars)
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1

  let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[hyp.length] / ref.length
}

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
