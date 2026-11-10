/**
 * MiniCPM-OCR(자체 호스팅)을 kordoc 의 OcrProvider 로 쓰는 예제.
 *
 * kordoc 은 본체에서 외부 통신을 하지 않습니다. 이 파일은 사용자 쪽에서 도는
 * 함수이고, kordoc 은 `parse(file, { ocr: provider })` 로 페이지 이미지만
 * 넘겨 줍니다 — 결과 텍스트만 돌려주면 됩니다(좌표 없음).
 *
 * 서버는 OpenAI 호환 /v1/chat/completions 를 여는 아무 런타임이나 됩니다
 * (vLLM·SGLang·llama.cpp·Ollama). vLLM 공식 배포 예:
 *
 *   vllm serve openbmb/MiniCPM-OCR-1.0 \
 *     --served-model-name minicpm-ocr \
 *     --mm-processor-kwargs '{"downsample_mode":"4x"}' \
 *     --trust-request-mm-kwargs
 *
 * `--trust-request-mm-kwargs` 가 없으면 이 예제가 보내는 mm_processor_kwargs 를
 * 서버가 거부합니다.
 */
import type { OcrProvider } from "kordoc"

export interface MiniCPMOcrOptions {
  /** OpenAI 호환 엔드포인트. 예: http://127.0.0.1:18499/v1/chat/completions */
  endpoint: string
  /** --served-model-name 과 같은 이름. 기본 "minicpm-ocr" */
  model?: string
  /** --api-key 로 띄운 서버에만 필요. 없으면 Authorization 헤더를 보내지 않는다 */
  apiKey?: string
  /** 페이지에 보낼 인식 프롬프트. 기본 "Text Recognition:" */
  prompt?: string
  /** 페이지당 최대 토큰. 기본 8192 — 잘리면(finish_reason=length) 늘린다 */
  maxTokens?: number
  /** 페이지당 타임아웃(ms). 기본 180000 */
  timeoutMs?: number
  /** 이미지 슬라이스 상한. 기본 9 — 빽빽한 쪽에서 작은 글자를 더 살린다 */
  maxSliceNums?: number
  /** 시각 토큰 다운샘플 모드. 기본 "4x" (16x 보다 4배 많은 토큰) */
  downsampleMode?: string
}

const DEFAULT_MODEL = "minicpm-ocr"
const DEFAULT_PROMPT = "Text Recognition:"
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_SLICE_NUMS = 9
const DEFAULT_DOWNSAMPLE_MODE = "4x"

/**
 * 페이지 이미지 하나를 MiniCPM-OCR 에 보내 텍스트를 받는 OcrProvider 를 만든다.
 *
 * PDF 경로는 항상 image/png, 이미지 직접 입력은 원본 mime 이 그대로 들어온다.
 * 좌표가 없으므로 `ocrLines` 와 함께 쓰지 않는다(kordoc 문서 참고).
 */
export function createMiniCPMOcrProvider(options: MiniCPMOcrOptions): OcrProvider {
  const endpoint = options.endpoint
  const model = options.model ?? DEFAULT_MODEL
  const prompt = options.prompt ?? DEFAULT_PROMPT
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxSliceNums = options.maxSliceNums ?? DEFAULT_MAX_SLICE_NUMS
  const downsampleMode = options.downsampleMode ?? DEFAULT_DOWNSAMPLE_MODE
  const apiKey = options.apiKey

  return async (pageImage, pageNumber, mimeType) => {
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [
            // 이미지가 텍스트보다 앞 — 모델의 자체 클라이언트와 같은 순서다.
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${Buffer.from(pageImage).toString("base64")}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: maxTokens,
      // 공식 배포 가이드의 검증된 디코딩 값.
      temperature: 0.01,
      top_p: 0.001,
      top_k: 1,
      repetition_penalty: 1.0,
      no_repeat_ngram_size: 100,
      // thinking 을 켜면 인식 결과가 content 가 아니라 reasoning_content 로 간다.
      chat_template_kwargs: { enable_thinking: false },
      mm_processor_kwargs: { downsample_mode: downsampleMode, max_slice_nums: maxSliceNums },
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`MiniCPM-OCR 요청 실패 (page ${pageNumber}): ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new Error(`MiniCPM-OCR HTTP ${response.status} (page ${pageNumber}): ${detail}`)
    }

    const json = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>
      error?: { message?: string }
    }
    if (json.error?.message) {
      throw new Error(`MiniCPM-OCR 오류 (page ${pageNumber}): ${json.error.message}`)
    }

    const choice = json.choices?.[0]
    if (!choice) {
      throw new Error(`MiniCPM-OCR 응답에 choices 가 없습니다 (page ${pageNumber})`)
    }

    const content = choice.message?.content
    const text = typeof content === "string" ? content : contentToText(content)

    // length 는 잘렸다는 뜻이다. 빈 쪽으로 실패시키는 대신 경고만 남기고
    // 부분 결과를 쓴다 — maxTokens 를 늘리면 해결된다.
    if (choice.finish_reason === "length") {
      console.warn(`MiniCPM-OCR: page ${pageNumber} 응답이 max_tokens(${maxTokens})에서 잘렸습니다 — MINICPM maxTokens 를 늘리세요`)
    }

    return stripCodeFences(text).trim()
  }
}

/** 게이트웨이에 따라 content 가 문자열 대신 parts 배열로 올 수 있다. */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("")
}

/** 모델이 답 전체를 ```markdown … ``` 로 감싼 경우 벗긴다. */
function stripCodeFences(text: string): string {
  const match = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text)
  return match ? match[1] : text
}
