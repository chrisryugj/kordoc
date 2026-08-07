/**
 * 폐쇄망(내부망) 배포용 아웃바운드 통신 킬스위치 + 파일 접근 루트 제한.
 *
 * kordoc 자체는 문서 파서라 상시 외부 통신이 없지만, 두 경로만 나간다:
 *   1. OCR/수식 모델 최초 1회 다운로드 (huggingface.co)
 *   2. `kordoc watch --webhook` 사용자가 명시한 URL
 *
 * `KORDOC_OFFLINE=1` 이면 위 경로를 **시도 전에** 차단한다. 보안성 검토에서
 * "외부 통신 없음"을 런타임으로 증명하기 위한 단일 관문 — 새 아웃바운드 경로를
 * 추가하면 반드시 `assertNetworkAllowed()` 를 먼저 통과시킬 것.
 *
 * `KORDOC_ROOT` 는 파일 접근을 특정 디렉토리 하위로 제한한다(미설정 시 제한 없음 —
 * 기존 동작 보존). 내부망 배포에서는 두 변수를 함께 고정하는 것을 권장.
 */

import { realpathSync } from "fs"
import { isAbsolute, relative, resolve, sep } from "path"
import { KordocError } from "../utils.js"

const TRUTHY = new Set(["1", "true", "yes", "on"])

function envFlag(name: string): boolean {
  const v = process.env[name]
  return !!v && TRUTHY.has(v.trim().toLowerCase())
}

/** 폐쇄망 모드 여부 (`KORDOC_OFFLINE=1|true|yes|on`) */
export function isOfflineMode(): boolean {
  return envFlag("KORDOC_OFFLINE")
}

/**
 * 아웃바운드 통신 관문. 폐쇄망 모드면 요청을 보내기 전에 예외로 끊는다.
 * @param what 차단 대상 설명 (사용자에게 노출됨 — 호스트/URL 은 넣지 말 것)
 * @param hint 대안 안내 (오프라인 사이드로드 방법 등)
 */
export function assertNetworkAllowed(what: string, hint?: string): void {
  if (!isOfflineMode()) return
  throw new KordocError(
    `폐쇄망 모드(KORDOC_OFFLINE)에서 차단됨: ${what}` + (hint ? ` — ${hint}` : ""),
  )
}

/** 파일 접근 루트 (`KORDOC_ROOT`). 미설정이면 null = 제한 없음 */
export function getAccessRoot(): string | null {
  const raw = process.env.KORDOC_ROOT
  if (!raw || !raw.trim()) return null
  const resolved = resolve(raw.trim())
  try {
    return realpathSync(resolved)
  } catch {
    // 루트가 실재하지 않으면 모든 접근이 막히는 게 안전한 기본값
    return resolved
  }
}

/** 경로가 루트 하위인지 (루트 자신 포함). 경계 문자열 매칭이 아닌 세그먼트 단위 비교 */
export function isWithinRoot(realPath: string, root: string): boolean {
  if (realPath === root) return true
  const rel = relative(root, realPath)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`)
}

/**
 * `KORDOC_ROOT` 가 설정된 경우 경로가 루트 하위인지 검증한다.
 * 인자는 이미 realpath 로 해석된 절대경로여야 한다 (심볼릭 링크 탈출 방지).
 */
export function assertWithinRoot(realPath: string): void {
  const root = getAccessRoot()
  if (!root) return
  if (!isWithinRoot(realPath, root)) {
    throw new KordocError(`허용된 작업 디렉토리(KORDOC_ROOT) 밖의 경로입니다: ${realPath}`)
  }
}
