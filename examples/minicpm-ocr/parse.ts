#!/usr/bin/env node
/**
 * 스캔 PDF·이미지 하나를 MiniCPM-OCR 로 읽어 마크다운을 stdout 에 낸다.
 *
 * 사용:
 *   MINICPM_OCR_ENDPOINT=http://127.0.0.1:18499/v1/chat/completions \
 *     node --import tsx examples/minicpm-ocr/parse.ts 스캔본.pdf > out.md
 *
 * 환경 변수:
 *   MINICPM_OCR_ENDPOINT   (필수) OpenAI 호환 chat/completions URL
 *   MINICPM_OCR_MODEL      기본 minicpm-ocr
 *   MINICPM_OCR_API_KEY    서버를 --api-key 로 띄웠을 때만
 *   MINICPM_OCR_PROMPT     기본 "Text Recognition:"
 *   MINICPM_OCR_MAX_TOKENS 기본 8192
 */
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { parse } from "kordoc"
import { createMiniCPMOcrProvider } from "./provider.js"

const file = process.argv[2]
if (!file) {
  console.error("사용: node --import tsx examples/minicpm-ocr/parse.ts <PDF 또는 이미지>")
  process.exit(2)
}

const endpoint = process.env.MINICPM_OCR_ENDPOINT
if (!endpoint) {
  console.error("MINICPM_OCR_ENDPOINT 를 지정하세요 (예: http://127.0.0.1:18499/v1/chat/completions)")
  process.exit(2)
}

const provider = createMiniCPMOcrProvider({
  endpoint,
  model: process.env.MINICPM_OCR_MODEL,
  apiKey: process.env.MINICPM_OCR_API_KEY,
  prompt: process.env.MINICPM_OCR_PROMPT,
  maxTokens: process.env.MINICPM_OCR_MAX_TOKENS ? Number(process.env.MINICPM_OCR_MAX_TOKENS) : undefined,
})

const startedAt = performance.now()
const result = await parse(file, {
  ocr: provider,
  onProgress: (current, total) => console.error(`OCR ${current}/${total} — ${basename(file)}`),
})
const elapsed = performance.now() - startedAt

if (!result.success) {
  console.error(`파싱 실패: ${result.error}`)
  process.exit(1)
}

for (const warning of result.warnings ?? []) {
  console.error(`경고: [${warning.code}] ${warning.message}`)
}
console.error(`완료: ${result.pageCount ?? "?"}쪽, ${(elapsed / 1000).toFixed(1)}초`)

process.stdout.write(result.markdown)
