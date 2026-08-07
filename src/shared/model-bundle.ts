/**
 * OCR/수식 모델 오프라인 사이드로드 — 폐쇄망 배포용.
 *
 * 온라인 PC 에서 `--export` 로 캐시를 디렉토리에 내보내고, 반입 매체로 옮긴 뒤
 * 내부망 PC 에서 `--import` 로 캐시에 설치한다. 양방향 모두 코드에 박힌 SHA-256
 * 스펙으로 검증한다 — 별도 manifest 를 만들지 않는 이유는 스펙이 SSOT 이기 때문.
 */

import { copyFile, mkdir } from "fs/promises"
import { join } from "path"
import {
  type ModelSpec,
  ALL_FORMULA_MODELS,
  getModelStatusIn,
  getModelsDir,
} from "../pdf/formula/models.js"
import { ALL_OCR_MODELS } from "../ocr/models.js"

/** 모델군 — 캐시 하위 디렉토리 이름이 곧 번들 디렉토리 이름 */
export interface ModelGroup {
  readonly subdir: string
  readonly label: string
  readonly specs: ReadonlyArray<ModelSpec>
}

export const MODEL_GROUPS: ReadonlyArray<ModelGroup> = [
  { subdir: "ppocr", label: "텍스트 OCR (PP-OCRv5 korean)", specs: ALL_OCR_MODELS },
  { subdir: "pix2text", label: "수식 OCR (Pix2Text)", specs: ALL_FORMULA_MODELS },
]

export interface BundleFileResult {
  group: string
  filename: string
  status: "copied" | "missing" | "invalid"
  reason?: string
}

export interface BundleResult {
  files: BundleFileResult[]
  /**
   * 성공 판정 — 하나라도 옮겼고 검증 실패가 없으면 성공.
   * 안 쓰는 모델군이 통째로 없는 건(전부 missing) 흔한 정상 상황이라 실패로 보지 않는다.
   * 반면 SHA 불일치는 반입 매체 오염 신호이므로 항상 실패.
   */
  ok: boolean
}

function summarize(files: BundleFileResult[]): BundleResult {
  const copied = files.filter((f) => f.status === "copied").length
  const tampered = files.some((f) => f.status === "invalid")
  return { files, ok: copied > 0 && !tampered }
}

/** 로컬 캐시 → 번들 디렉토리. SHA 검증을 통과한 파일만 내보낸다. */
export async function exportModels(destDir: string): Promise<BundleResult> {
  const files: BundleFileResult[] = []
  for (const group of MODEL_GROUPS) {
    const srcDir = getModelsDir(group.subdir)
    const outDir = join(destDir, group.subdir)
    const status = await getModelStatusIn(srcDir, group.specs)
    let dirReady = false
    for (const s of status) {
      if (!s.exists) {
        files.push({ group: group.subdir, filename: s.spec.filename, status: "missing", reason: "캐시에 없음" })
        continue
      }
      if (!s.verified) {
        files.push({ group: group.subdir, filename: s.spec.filename, status: "invalid", reason: s.invalidReason })
        continue
      }
      if (!dirReady) {
        await mkdir(outDir, { recursive: true })
        dirReady = true
      }
      await copyFile(s.localPath, join(outDir, s.spec.filename))
      files.push({ group: group.subdir, filename: s.spec.filename, status: "copied" })
    }
  }
  return summarize(files)
}

/** 번들 디렉토리 → 로컬 캐시. SHA 검증을 통과한 파일만 설치한다. */
export async function importModels(srcDir: string): Promise<BundleResult> {
  const files: BundleFileResult[] = []
  for (const group of MODEL_GROUPS) {
    const inDir = join(srcDir, group.subdir)
    const cacheDir = getModelsDir(group.subdir)
    const status = await getModelStatusIn(inDir, group.specs)
    let dirReady = false
    for (const s of status) {
      if (!s.exists) {
        files.push({ group: group.subdir, filename: s.spec.filename, status: "missing", reason: "번들에 없음" })
        continue
      }
      if (!s.verified) {
        files.push({ group: group.subdir, filename: s.spec.filename, status: "invalid", reason: s.invalidReason })
        continue
      }
      if (!dirReady) {
        await mkdir(cacheDir, { recursive: true })
        dirReady = true
      }
      await copyFile(s.localPath, join(cacheDir, s.spec.filename))
      files.push({ group: group.subdir, filename: s.spec.filename, status: "copied" })
    }
  }
  return summarize(files)
}

/** 캐시에 설치된 모델 상태 (다운로드·복사 없이 확인만) */
export async function modelCacheStatus(): Promise<
  Array<{ group: string; label: string; dir: string; allReady: boolean; models: Array<{ filename: string; sizeMb: number; exists: boolean; verified: boolean; invalidReason?: string }> }>
> {
  const out = []
  for (const group of MODEL_GROUPS) {
    const dir = getModelsDir(group.subdir)
    const status = await getModelStatusIn(dir, group.specs)
    out.push({
      group: group.subdir,
      label: group.label,
      dir,
      allReady: status.every((s) => s.verified),
      models: status.map((s) => ({
        filename: s.spec.filename,
        sizeMb: s.spec.sizeMb,
        exists: s.exists,
        verified: s.verified,
        invalidReason: s.invalidReason,
      })),
    })
  }
  return out
}
