/** kordoc MCP 공용 — 경로·확장자 검증, 파일 읽기, 오류 문구, 응답 상한 (도구 모듈 공유) */

import { realpathSync, openSync, readSync, closeSync, lstatSync } from "fs"
import { readFile, stat, realpath } from "fs/promises"
import { resolve, isAbsolute, extname, dirname, basename } from "path"
import { detectFormat } from "../index.js"
import { toArrayBuffer, sanitizeError, classifyError, KordocError } from "../utils.js"
import { assertWithinRoot } from "../shared/offline.js"

/** 허용 파일 확장자 */
export const ALLOWED_EXTENSIONS = new Set([".hwp", ".hwpx", ".hml", ".pdf", ".xls", ".xlsx", ".docx"])
/** 파싱 계열 도구(parse_*·detect_format) 입력 확장자 — 문서 + 이미지(자동 OCR).
 *  이미지 3종은 detect.ts 매직바이트 지원 범위와 동일. 쓰기·패치 계열은 ALLOWED_EXTENSIONS 유지 */
export const PARSE_EXTENSIONS = new Set([...ALLOWED_EXTENSIONS, ".png", ".jpg", ".jpeg", ".webp"])
/** 도장/서명 이미지 허용 확장자 (place_seal image_path) */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp"])
/** 서식 프로필 허용 확장자 (generate_document profile_path) */
export const PROFILE_EXTENSIONS = new Set([".json"])
/** 최대 파일 크기 (500MB) */
export const MAX_FILE_SIZE = 500 * 1024 * 1024

/** 경로 정규화 및 보안 검증 */
export function safePath(filePath: string, allowedExts: ReadonlySet<string> = ALLOWED_EXTENSIONS): string {
  if (!filePath) throw new KordocError("파일 경로가 비어있습니다")
  const resolved = resolve(filePath)
  let real: string
  try {
    real = realpathSync(resolved)
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new KordocError(`파일을 찾을 수 없습니다: ${resolved}`)
    if (err?.code === "EACCES" || err?.code === "EPERM") throw new KordocError(`파일 접근 권한이 없습니다: ${resolved}`)
    throw new KordocError(`경로 처리 오류 [${err?.code ?? "UNKNOWN"}]`)
  }
  if (!isAbsolute(real)) throw new KordocError("절대 경로만 허용됩니다")
  assertWithinRoot(real)
  const ext = extname(real).toLowerCase()
  if (!allowedExts.has(ext)) throw new KordocError(`지원하지 않는 확장자입니다: ${ext} (허용: ${[...allowedExts].join(", ")})`)
  return real
}

/**
 * 출력 경로 정규화 및 검증 — 확장자 allowlist + 가장 가까운 실재 조상 realpath (safePath의 쓰기 대응).
 * 종전엔 부모만 realpath 해서 KORDOC_ROOT 안 심볼릭 링크로 쓰기가 샜다(v4.14.4 리뷰 재현): 최종 경로가 밖을 가리키는
 * 링크면 writeFile 이 따라가 덮어썼고, 부모가 없으면 문자열로만 판정해 mkdir(recursive) 가 조상의 디렉토리 링크를
 * 따라가 밖에 만들었다. 그래서 최종 경로가 링크면 거부하고, 실재하는(링크 포함) 가장 가까운 조상을 realpath 로 푼 뒤
 * 남은 세그먼트를 이어 판정한다
 */
export function safeOutputPath(outputPath: string, allowedExts: ReadonlySet<string>): string {
  if (!outputPath) throw new KordocError("출력 경로가 비어있습니다")
  const resolved = resolve(outputPath)
  const ext = extname(resolved).toLowerCase()
  if (!allowedExts.has(ext)) {
    throw new KordocError(`지원하지 않는 출력 확장자입니다: ${ext || "(없음)"} (허용: ${[...allowedExts].join(", ")})`)
  }
  const entry = (p: string) => { try { return lstatSync(p) } catch { return null } }
  if (entry(resolved)?.isSymbolicLink()) throw new KordocError(`출력 경로가 심볼릭 링크입니다: ${resolved}`)
  let base = dirname(resolved)
  const rest = [basename(resolved)]
  while (!entry(base) && dirname(base) !== base) {
    rest.unshift(basename(base))
    base = dirname(base)
  }
  let real: string
  try {
    real = resolve(realpathSync(base), ...rest) // 끊긴 링크 조상은 여기서 ENOENT — 거부
  } catch (err: any) {
    throw new KordocError(`출력 경로 처리 오류 [${err?.code ?? "UNKNOWN"}]: ${base}`)
  }
  assertWithinRoot(real)
  return real
}

/**
 * MCP 오류 응답 텍스트 — KordocError는 그대로, fs 계열(ENOENT 등)은 경로 노출 없이
 * 코드별 힌트, 그 외는 classifyError 분류를 병기해 일반화 ("문서 처리 중 오류" 뭉개기 방지)
 */
export function describeError(err: unknown): string {
  if (err instanceof KordocError) return err.message
  const code = (err as NodeJS.ErrnoException)?.code
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    const hints: Record<string, string> = {
      ENOENT: "파일 또는 디렉토리를 찾을 수 없습니다",
      EACCES: "접근 권한이 없습니다",
      EPERM: "작업 권한이 없습니다",
      EISDIR: "파일이 아니라 디렉토리입니다",
      ENOTDIR: "경로 중간이 디렉토리가 아닙니다",
      ENOSPC: "디스크 공간이 부족합니다",
    }
    return `파일 시스템 오류 [${code}]: ${hints[code] ?? "경로와 권한을 확인하세요"}`
  }
  const cls = classifyError(err)
  return cls === "PARSE_ERROR" ? sanitizeError(err) : `문서 처리 중 오류가 발생했습니다 (${cls})`
}

/** MCP 응답 본문 상한 — 사진 몇 장·대형 문서로 클라이언트 도구 응답 한도를 넘기지 않게 */
export const MAX_RESPONSE_CHARS = 200_000
export function capResponseText(text: string, maxChars = MAX_RESPONSE_CHARS): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) +
    `\n\n… [응답이 ${maxChars.toLocaleString()}자 상한을 넘어 절단됨 (전체 ${text.length.toLocaleString()}자) — parse_pages로 페이지 범위를 나눠 읽으세요]`
}

/** 최대 파일 크기 — metadata 전용 (50MB, 전체 파싱보다 보수적) */
export const MAX_METADATA_FILE_SIZE = 50 * 1024 * 1024

/** 파일 읽기 + 크기 검증 공통 로직 — MCP는 장수 stdio 프로세스라 비동기 I/O (이벤트루프 블로킹 방지) */
export async function readValidatedFile(filePath: string, maxSize = MAX_FILE_SIZE, allowedExts: ReadonlySet<string> = ALLOWED_EXTENSIONS): Promise<{ buffer: ArrayBuffer; resolved: string }> {
  const resolved = safePath(filePath, allowedExts)
  let fileSize: number
  try {
    fileSize = (await stat(resolved)).size
  } catch (err: any) {
    throw new KordocError(`파일 상태 읽기 실패 [${err?.code ?? "UNKNOWN"}]: ${resolved}`)
  }
  if (fileSize > maxSize) {
    throw new KordocError(`파일이 너무 큽니다: ${(fileSize / 1024 / 1024).toFixed(1)}MB (최대 ${maxSize / 1024 / 1024}MB)`)
  }
  let raw: Buffer
  try {
    raw = await readFile(resolved)
  } catch (err: any) {
    throw new KordocError(`파일 읽기 실패 [${err?.code ?? "UNKNOWN"}]: ${resolved}`)
  }
  return { buffer: toArrayBuffer(raw), resolved }
}

/** 파일 헤더(512바이트)만 읽어 포맷 감지 — 전체 파일 로드 불필요.
 *  16바이트로는 HWP3 매직(30B)·HWPML(<?xml…<HWPML, 최대 512B 윈도)이 안 잡힌다 */
export function detectFormatFromHeader(resolved: string): ReturnType<typeof detectFormat> {
  const fd = openSync(resolved, "r")
  try {
    const headerBuf = Buffer.alloc(512)
    const bytesRead = readSync(fd, headerBuf, 0, 512, 0)
    return detectFormat(toArrayBuffer(headerBuf.subarray(0, bytesRead)))
  } finally {
    closeSync(fd)
  }
}
