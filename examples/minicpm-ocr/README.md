# MiniCPM-OCR 로 읽기 (자체 호스팅 VLM)

kordoc 본체는 외부 통신을 하지 않습니다. 이 예제는 kordoc 의 `OcrProvider`
확장점(`parse(file, { ocr: function })`)에 자체 호스팅 [MiniCPM-OCR](https://github.com/OpenBMB/MiniCPM-OCR)
호출을 넣는 방법을 보여 줍니다 — kordoc 은 페이지 이미지만 넘기고, 네트워크는
이 예제 코드가 담당합니다.

중국어·영어 문서를 자체 호스팅 환경에서 읽고 싶을 때 씁니다. MiniCPM-OCR 1.0 의
공식 지원 언어는 중국어·영어입니다 — 한국어·일본어 등은 공식 지원 범위가 아니므로,
한국어 문서는 내장 엔진(PP-OCRv5 korean)이 기준입니다.

## 준비물

- Node.js 20 이상, `kordoc` (저장소에서 바로 돌릴 때는 `npm run build` 후)
- OpenAI 호환 `/v1/chat/completions` 를 여는 MiniCPM-OCR 서버
  (vLLM·SGLang·llama.cpp·Ollama 중 아무거나)

vLLM 공식 배포 예 — `--trust-request-mm-kwargs` 가 있어야 이 예제가 보내는
`mm_processor_kwargs` 를 받습니다:

```bash
vllm serve openbmb/MiniCPM-OCR-1.0 \
  --served-model-name minicpm-ocr \
  --max-model-len 40960 \
  --limit-mm-per-prompt '{"image":36,"video":0}' \
  --mm-processor-kwargs '{"downsample_mode":"4x"}' \
  --trust-request-mm-kwargs
```

## 쓰기

```typescript
import { parse } from "kordoc"
import { createMiniCPMOcrProvider } from "./provider.ts"

const provider = createMiniCPMOcrProvider({
  endpoint: "http://127.0.0.1:18499/v1/chat/completions",
  // model·prompt·maxTokens·timeoutMs·maxSliceNums·downsampleMode 는 기본값이 있다
})

const result = await parse("스캔본.pdf", { ocr: provider })
if (result.success) console.log(result.markdown)
```

CLI 로 바로:

```bash
MINICPM_OCR_ENDPOINT=http://127.0.0.1:18499/v1/chat/completions \
  node --import tsx examples/minicpm-ocr/parse.ts 스캔본.pdf > out.md
```

## 이 경로의 한계

- **좌표가 없다.** OcrProvider 는 쪽 텍스트만 돌려주므로 `ocrLines`
  (`true`/`"all"`)와 함께 쓸 수 없습니다. 줄 단위 상자·확신도가 필요하면 내장
  엔진 경로를 써야 합니다.
- **강제 전 페이지 OCR 은 provider 에 없다.** `ocr: "force"` 는 내장 엔진 전용이고,
  provider 는 kordoc 이 OCR 이 필요하다고 판정한 쪽(텍스트층 없음·깨짐)과
  이미지 기반 PDF 전체, HWP·HWPX 삽입 그림에서만 호출됩니다. 텍스트층이 깨끗한
  PDF 는 provider 를 지정해도 호출되지 않습니다.
- **페이지 단위 호출이다.** 모델의 공식 SDK 처럼 PP-DocLayout 으로 영역을 나눠
  표·수식 프롬프트를 따로 보내지는 않습니다. 표·수식이 많은 스캔본은 내장
  엔진이나 SDK 경로가 나을 수 있습니다.
- `finish_reason` 이 `length` 면 잘린 것이므로 `maxTokens` 를 올리세요. 예제는
  경고만 남기고 부분 결과를 씁니다.

## 실측

`measure.ts` 는 provider 호출 시간과(정답 텍스트를 주면) 쪽 단위 CER 을 냅니다.
OcrProvider 경로는 줄 좌표가 없어 **줄 단위 정확도는 잴 수 없습니다**.

```bash
MINICPM_OCR_ENDPOINT=http://127.0.0.1:18499/v1/chat/completions \
  node --import tsx examples/minicpm-ocr/measure.ts 스캔본.pdf --gt 정답.txt
```

정답은 같은 쪽을 사람이 옮겨 적은 텍스트여야 합니다. 내장 OCR 결과를 정답으로
쓰면 두 엔진의 차이만 재게 됩니다. 이 저장소의 `bench/ocr-accuracy.mjs` 는
텍스트층 PDF 를 정답지로 쓰는데, provider 경로는 `force` 가 없어 그 벤치에
그대로 꽂히지 않습니다 — 스캔본 + 사람 정답으로 재는 편이 낫습니다.

## 참고

- 모델·SDK·프롬프트: <https://github.com/OpenBMB/MiniCPM-OCR>
- 배포 가이드(vLLM·SGLang·llama.cpp·Ollama): <https://github.com/OpenBMB/MiniCPM-OCR/blob/main/docs/minicpm_ocr_tutorial_en.md>
- kordoc 의 OcrProvider 계약: [`src/types.ts`](../../src/types.ts) 의 `OcrProvider`
