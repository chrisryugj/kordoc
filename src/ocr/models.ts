/**
 * 내장 텍스트 OCR 모델 (PP-OCRv5 korean) 스펙 + 다운로드/검증.
 *
 * 캐시 위치: `~/.cache/kordoc/models/ppocr/` — 총 ~18MB (det 4.6 + rec 12.8 + dict 0.1).
 * 선택 모델 server det(88MB, `ocrDet: "server"`)·v6 medium det(62MB, `ocrDet: "medium"`)·손글씨 rec(15MB, `ocrRec: "handwriting"`)는 고를 때만 같은 곳에 받는다. 로컬 모델 파일(`ocrDet`·`ocrRec`·`ocrRecDict`
 * {path, sha256})은 캐시에 복사하지 않고 엔진이 그 경로에서 읽어 대조한다.
 * 다운로드 인프라는 수식 OCR 과 공용 (formula/models.ts ensureModelsIn).
 *
 * 모델 출처: PaddlePaddle 공식 HuggingFace org 의 ONNX 변환본 (Apache-2.0).
 * SHA-256 은 실제 다운로드 + HF API lfs.oid 대조로 검증됨 — 변경 금지.
 * 한국어 사전은 rec 리포의 inference.yml `PostProcess.character_dict` 에
 * 내장 (11,945자 — 완성형 한글 11,172 음절 전량 + 자모/라틴/기호).
 */

import { join } from "path"
import { stat } from "fs/promises"
import type { OcrModelFile, ParseOptions } from "../types.js"
import {
  type ModelSpec,
  type ModelStatus,
  type ProgressHandler,
  ensureModelsIn,
  getModelStatusIn,
  getModelsDir,
} from "../pdf/formula/models.js"

export const OCR_DET_MODEL: ModelSpec = {
  name: "PP-OCRv5 mobile det",
  filename: "det.onnx",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
  sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  sizeMb: 5,
}

/** 선택 모델 (`ocrDet: "server"`) — 기본 묶음(ALL_OCR_MODELS·`kordoc models`)에 넣지 않고 처음 고를 때 받는다.
 *  전·후처리(resize_long 960·DB thresh 0.3/0.6·unclip 1.5)는 inference.yml 상 mobile 과 같다 — 모델 파일만 바꾼다 */
export const OCR_SERVER_DET_MODEL: ModelSpec = {
  name: "PP-OCRv5 server det",
  filename: "det_server.onnx",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det_onnx/resolve/main/inference.onnx",
  sha256: "10803475a591f7dc623e24670fb5752ec94d39a1f8cf069aac1b6f0ce19cfc85",
  sizeMb: 88,
  // models --export/--import 묶음에 들지 않으니 그 안내 대신
  offlineHint: "온라인 PC에서 받은 파일을 이 PC 모델 캐시의 ppocr/det_server.onnx 로 반입하거나(SHA-256 을 검증한다), ocrDet 에 로컬 파일 {path, sha256} 을 지정하세요",
}

/** 선택 모델 (`ocrDet: "medium"`) — PP-OCRv6 medium det. 열화 입력(기울임·흐림·스캔·잡음)에 강하지만 깨끗한 PDF 는 기본 mobile 이
 *  낫다(OCR 벤치 CER 0.0305 vs 0.0250 — 표 묶기·읽기 순서가 v5 상자 모양에 맞춰져 있다). 입출력이 v5 det 와 같아 전·후처리는 그대로 쓴다 */
export const OCR_V6_MEDIUM_DET_MODEL: ModelSpec = {
  name: "PP-OCRv6 medium det",
  filename: "det_v6_medium.onnx",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/main/inference.onnx",
  sha256: "eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1",
  sizeMb: 62,
  offlineHint: "온라인 PC에서 받은 파일을 이 PC 모델 캐시의 ppocr/det_v6_medium.onnx 로 반입하거나(SHA-256 을 검증한다), ocrDet 에 로컬 파일 {path, sha256} 을 지정하세요",
}

export const OCR_REC_MODEL: ModelSpec = {
  name: "PP-OCRv5 korean rec",
  filename: "rec_korean.onnx",
  url: "https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
  sha256: "92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08",
  sizeMb: 13,
}

/** 선택 모델 (`ocrRec: "handwriting"`) — PP-OCRv5 korean rec 를 AI Hub 손글씨·공문서 데이터로 추가 학습한 공개 모델(Apache-2.0).
 *  출력 클래스·사전이 내장 rec 와 같아(사전 yml 바이트 동일) OCR_REC_DICT 를 그대로 쓴다. server det 처럼 기본 묶음에 넣지 않는다.
 *  주소는 Hugging Face revision 을 고정했다 — SHA-256 은 실제 다운로드 + HF API lfs.oid 대조로 검증됨 */
export const OCR_HANDWRITING_REC_MODEL: ModelSpec = {
  name: "Korean handwriting rec",
  filename: "rec_korean_hw.onnx",
  url: "https://huggingface.co/Rebeccaaaaaaaa/korean-handwriting-rec/resolve/bb4c2714cf6b05e5d13bfe22199d0e6d30866597/model/rec_korean_hw.onnx",
  sha256: "1655d6abd17989f1922855dd77922e532e74275fe237e5f07174b623993fef81",
  sizeMb: 15,
  offlineHint: "온라인 PC에서 받은 파일을 이 PC 모델 캐시의 ppocr/rec_korean_hw.onnx 로 반입하거나(SHA-256 을 검증한다), ocrRec 에 로컬 파일 {path, sha256} 을 지정하세요",
}

export const OCR_REC_DICT: ModelSpec = {
  name: "PP-OCRv5 korean dict",
  filename: "rec_korean.yml",
  url: "https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml",
  sha256: "f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998",
  sizeMb: 1,
}

export const ALL_OCR_MODELS: ReadonlyArray<ModelSpec> = [OCR_DET_MODEL, OCR_REC_MODEL, OCR_REC_DICT]

export function getOcrModelsDir(): string {
  return getModelsDir("ppocr")
}

/** 모든 텍스트 OCR 모델 다운로드/검증 (있으면 skip) */
export async function ensureOcrModels(onProgress?: ProgressHandler): Promise<void> {
  return ensureModelsIn(getOcrModelsDir(), ALL_OCR_MODELS, onProgress)
}

/** 텍스트 OCR 모델 상태 (다운로드 없이 확인만) */
export async function getOcrModelStatus(): Promise<ModelStatus[]> {
  return getModelStatusIn(getOcrModelsDir(), ALL_OCR_MODELS)
}

/** 엔진이 읽을 모델 파일 하나 — 캐시의 내장 모델(spec) 또는 호출자가 준 로컬 파일(file) */
export type OcrModelSource = { spec: ModelSpec } | { file: OcrModelFile }

/** det·rec·사전 선택. 옵션을 안 주면 DEFAULT_OCR_MODELS(종전 동작) */
export interface OcrModelSelection {
  det: OcrModelSource
  rec: OcrModelSource
  dict: OcrModelSource
}

export const DEFAULT_OCR_MODELS: Readonly<OcrModelSelection> = Object.freeze({
  det: { spec: OCR_DET_MODEL },
  rec: { spec: OCR_REC_MODEL },
  dict: { spec: OCR_REC_DICT },
})

/** 옵션 → 모델 선택 (validateOcrOptions 를 통과한 옵션). sha256 은 소문자로 맞춘다 */
export function resolveOcrModels(o: Pick<ParseOptions, "ocrDet" | "ocrRec" | "ocrRecDict"> | undefined): OcrModelSelection {
  const file = (f: OcrModelFile): OcrModelSource => ({ file: { path: f.path, sha256: f.sha256.toLowerCase() } })
  const det = o?.ocrDet
  return {
    det: det === undefined || det === "mobile" ? DEFAULT_OCR_MODELS.det : det === "server" ? { spec: OCR_SERVER_DET_MODEL } : det === "medium" ? { spec: OCR_V6_MEDIUM_DET_MODEL } : file(det),
    rec: o?.ocrRec === "handwriting" ? { spec: OCR_HANDWRITING_REC_MODEL } : o?.ocrRec && o.ocrRec !== "auto" && o.ocrRec !== "printed" ? file(o.ocrRec) : DEFAULT_OCR_MODELS.rec,
    dict: o?.ocrRecDict ? file(o.ocrRecDict) : DEFAULT_OCR_MODELS.dict,
  }
}

/** `ocrRec: "auto"` 가 손글씨 쪽을 다시 읽을 모델 — 같은 det·사전에 rec 만 손글씨 rec */
export function handwritingFallbackModels(sel: OcrModelSelection): OcrModelSelection {
  return { ...sel, rec: { spec: OCR_HANDWRITING_REC_MODEL } }
}

/** 엔진 캐시 키 — 같은 파일 셋이면 같은 세션을 쓴다 */
export function ocrSelectionKey(sel: OcrModelSelection): string {
  const k = (s: OcrModelSource) => "spec" in s ? `spec:${s.spec.filename}` : `file:${s.file.sha256}:${s.file.path}`
  return [k(sel.det), k(sel.rec), k(sel.dict)].join("|")
}

/** 모델 소스의 로컬 경로 (내장 모델은 캐시 경로) */
export function ocrSourcePath(s: OcrModelSource): string {
  return "spec" in s ? ocrModelPath(s.spec) : s.file.path
}

/** 이 프로세스에서 SHA-256 을 확인한 캐시 파일(경로 → 크기:수정 시각) — 엔진은 첫 로드 뒤 모델을 다시 읽지 않으니 파싱마다
 *  다시 해시할 까닭이 없다(server det 88MB 를 쪽 이미지·삽입 그림마다 해시했다) */
const verifiedInProcess = new Map<string, string>()
const fileStamp = async (path: string): Promise<string | null> => {
  try { const st = await stat(path); return `${st.size}:${st.mtimeMs}` } catch { return null }
}

/** 선택한 모델 가운데 내장 모델만 다운로드/검증한다 — 로컬 파일은 엔진 로드가 SHA-256 을 대조한다.
 *  내장 모델이 없으면(세 파일 모두 로컬) 캐시 디렉터리를 만들지도 않는다(읽기 전용 HOME) */
export async function ensureOcrModelsFor(sel: OcrModelSelection, onProgress?: ProgressHandler): Promise<void> {
  const dir = getOcrModelsDir()
  const todo: ModelSpec[] = []
  for (const s of [sel.det, sel.rec, sel.dict]) {
    if (!("spec" in s)) continue
    const path = join(dir, s.spec.filename)
    const stamp = await fileStamp(path)
    if (!stamp || verifiedInProcess.get(path) !== stamp) todo.push(s.spec)
  }
  if (!todo.length) return
  await ensureModelsIn(dir, todo, onProgress)
  for (const spec of todo) {
    const path = join(dir, spec.filename), stamp = await fileStamp(path)
    if (stamp) verifiedInProcess.set(path, stamp)
  }
}

/** 텍스트 OCR 모델 파일이 다 있나 — 해시 검증 없이 존재만(파싱마다 부르는 자동 OCR 판정용, 검증은 엔진 로드가 한다).
 *  sel 을 주면 그 선택의 파일(내장은 캐시, 로컬은 그 경로) — 자동 OCR 은 모델을 받지 않으니 고른 모델이 없으면 돌지 않는다 */
export async function ocrModelsCached(sel: OcrModelSelection = DEFAULT_OCR_MODELS): Promise<boolean> {
  for (const s of [sel.det, sel.rec, sel.dict]) {
    try { if (!(await stat(ocrSourcePath(s))).size) return false } catch { return false }
  }
  return true
}

/**
 * inference.yml 에서 `PostProcess.character_dict` 리스트를 추출.
 * 전체 YAML 파서 없이 해당 블록의 `- <char>` 라인만 순서대로 읽는다
 * (공식 yml 구조 고정 — 들여쓰기 2칸, 한 줄 한 글자).
 *
 * CTC 클래스 배열: index 0 = blank, 1..N = 사전 순서, N+1(마지막) = space.
 */
export function parseCharacterDict(yml: string): string[] {
  // 사용자 사전(ocrRecDict)은 CRLF 로 저장된 것도 받는다 — 줄 끝 \r 이 남으면 항목 줄이 하나도 안 맞았다
  const lines = yml.split(/\r?\n/)
  const chars: string[] = []
  let inDict = false
  let dictIndent = -1
  for (const line of lines) {
    if (!inDict) {
      const m = /^(\s*)character_dict:\s*$/.exec(line)
      if (m) {
        inDict = true
        dictIndent = m[1].length
      }
      continue
    }
    // 리스트 항목 — YAML 은 키와 같은 들여쓰기의 "- x" 도 허용 (공식 yml 실측: 둘 다 2칸)
    const m = /^(\s*)- (.*)$/.exec(line)
    if (m && m[1].length >= dictIndent) {
      let v = m[2]
      // YAML 인용 문자 처리 ('#' 같은 예약 문자는 인용됨)
      if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
        v = v.slice(1, -1).replace(/''/g, "'")
      }
      chars.push(v)
      continue
    }
    // 들여쓰기가 얕아지면 블록 종료 (빈 줄은 통과)
    if (line.trim() !== "") break
  }
  return chars
}

export function ocrModelPath(spec: ModelSpec): string {
  return join(getOcrModelsDir(), spec.filename)
}
