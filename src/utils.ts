/** kordoc 공용 유틸리티 */

import { format } from "util"

/** 빌드 타임에 tsup define으로 주입되는 버전 */
declare const __KORDOC_VERSION__: string
export const VERSION: string = typeof __KORDOC_VERSION__ !== "undefined" ? __KORDOC_VERSION__ : "0.0.0-dev"

/**
 * Node.js Buffer → ArrayBuffer 변환
 * pool Buffer의 공유 ArrayBuffer 문제를 안전하게 처리.
 * offset=0이고 전체 ArrayBuffer를 차지하면 복사 없이 직접 반환.
 */
export function toArrayBuffer(buf: Buffer): ArrayBuffer {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer as ArrayBuffer
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/**
 * kordoc 내부 에러 클래스 — 사용자에게 노출해도 안전한 메시지만 포함.
 * MCP 에러 정제에서 instanceof로 판별하여 allowlist 패턴 매칭 없이 안전하게 통과.
 */
export class KordocError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KordocError"
  }
}

/**
 * ENOENT 판별 — 입력 경로가 존재하지 않음.
 * 래핑된 KordocError 를 뚫고 올라온 경우도 있으므로 메시지까지 함께 본다.
 */
function isFileNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return true
  const msg = (err as Error).message
  return typeof msg === "string" && /ENOENT|no such file or directory/i.test(msg)
}

/**
 * 에러 메시지 정제 — KordocError는 그대로, ENOENT 만 구분 문구, 나머지는 일반 메시지로 대체.
 * 파일시스템 경로, 스택 트레이스 등 내부 정보 노출 방지.
 */
export function sanitizeError(err: unknown): string {
  if (err instanceof KordocError) return err.message
  // 없는 파일은 문서 문제가 아니라 고칠 수 있는 입력 문제다 — 사유를 숨기지 않는다.
  // 경로는 노출하지 않는다(어느 파일인지는 stderr·실패 JSON 의 basename 이 알린다).
  // 문구는 MCP describeError 의 ENOENT 힌트와 같은 표현을 쓴다.
  if (isFileNotFound(err)) return "파일 또는 디렉토리를 찾을 수 없습니다"
  return "문서 처리 중 오류가 발생했습니다"
}

/**
 * ZIP 엔트리 경로의 경로 순회 여부 판별.
 * 백슬래시 정규화, .., 절대경로, Windows 드라이브 문자 모두 차단.
 */
export function isPathTraversal(name: string): boolean {
  if (name.includes("\x00")) return true
  const normalized = name.replace(/\\/g, "/")
  const segments = normalized.split("/")
  return segments.some(s => s === "..") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
}

// ─── HWPX 섹션 href 해석 (parser/roundtrip 공용) ────────────────────

/**
 * manifest href를 본문 섹션 경로(`Contents/sectionN.xml`)로 정규화.
 * 비본문 XML(header/script/settings)·path traversal·드라이브 경로는 null로 거른다.
 * 백슬래시 구분자를 슬래시로 통일해 parser와 roundtrip이 동일한 목록을 만든다.
 */
export function normalizeSectionHref(href: string): string | null {
  if (!href) return null
  let normalized = href.replace(/\\/g, "/").replace(/^\/+/, "")
  if (isPathTraversal(normalized)) return null
  if (/^[Ss]ection\d+\.xml$/.test(normalized)) normalized = "Contents/" + normalized
  return /(?:^|\/)[Ss]ection\d+\.xml$/.test(normalized) ? normalized : null
}

/** sectionN.xml을 N 숫자 순서로 정렬 (section10 > section2). */
export function compareSectionPaths(a: string, b: string): number {
  const ai = Number(a.match(/[Ss]ection(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
  const bi = Number(b.match(/[Ss]ection(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
  return ai === bi ? a.localeCompare(b) : ai - bi
}

// ─── ZIP 안전 로딩 (ZIP bomb 방지) ────────────────────

/**
 * ZIP bomb 사전 검사 — Central Directory에서 비압축 합계와 엔트리 수 확인.
 * HWPX/XLSX/DOCX 등 모든 ZIP 기반 포맷에서 공통 사용.
 */
export function precheckZipSize(
  buffer: ArrayBuffer,
  maxUncompressedSize = 256 * 1024 * 1024, // parser-shared MAX_DECOMPRESS_SIZE 와 동기
  maxEntries = 500,
): { totalUncompressed: number; entryCount: number } {
  try {
    const data = new DataView(buffer)
    const len = buffer.byteLength
    // EOCD 시그니처 역방향 스캔
    let eocdOffset = -1
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (data.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break }
    }
    if (eocdOffset < 0) return { totalUncompressed: 0, entryCount: 0 }

    const entryCount = data.getUint16(eocdOffset + 10, true)
    if (entryCount > maxEntries) {
      throw new KordocError(`ZIP 엔트리 수 초과: ${entryCount} (최대 ${maxEntries})`)
    }

    const cdSize = data.getUint32(eocdOffset + 12, true)
    const cdOffset = data.getUint32(eocdOffset + 16, true)
    if (cdOffset + cdSize > len) return { totalUncompressed: 0, entryCount }

    let totalUncompressed = 0
    let pos = cdOffset
    for (let i = 0; i < entryCount && pos + 46 <= cdOffset + cdSize; i++) {
      if (data.getUint32(pos, true) !== 0x02014b50) break
      totalUncompressed += data.getUint32(pos + 24, true)
      const nameLen = data.getUint16(pos + 28, true)
      const extraLen = data.getUint16(pos + 30, true)
      const commentLen = data.getUint16(pos + 32, true)
      pos += 46 + nameLen + extraLen + commentLen
    }

    if (totalUncompressed > maxUncompressedSize) {
      throw new KordocError(`ZIP 비압축 크기 초과: ${(totalUncompressed / 1024 / 1024).toFixed(1)}MB (최대 ${maxUncompressedSize / 1024 / 1024}MB)`)
    }

    return { totalUncompressed, entryCount }
  } catch (err) {
    if (err instanceof KordocError) throw err
    return { totalUncompressed: 0, entryCount: 0 }
  }
}

/**
 * XML 파싱 전 프롤로그 정리 — 선두 BOM 제거 + DOCTYPE 제거(XXE/Billion Laughs 방지).
 *
 * BOM: 일부 OpenXML 라이터가 `[Content_Types].xml`·`.rels` 앞에 EF BB BF를 붙인다.
 * XML 스펙상 적법(엔티티는 BOM으로 시작할 수 있음)이고 엑셀·리브레오피스는 여는데,
 * xmldom은 "선언이 문서 시작이 아님" fatalError로 파일 전체를 거부했다 (#63).
 */
export function stripDtd(xml: string): string {
  return xml.replace(/^\uFEFF/, "").replace(/<!DOCTYPE\s[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
}

/** 하이퍼링크 URL 살균 — javascript: 등 XSS 위험 스킴 차단 */
const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|#)/i
const HREF_ESCAPE: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E", "\"": "%22", "'": "%27", "`": "%60" }
export function sanitizeHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || !SAFE_HREF_RE.test(trimmed)) return null
  // 괄호 percent-encoding — 마크다운 링크 목적지에서 불균형 ')'는 링크를 조기 종료시켜
  // 문법이 깨진다 (원문 하이퍼링크에 ')'가 박힌 실문서 존재). %28/%29는 의미 동일.
  // 공백·<>"'` 도 — 스킴만 보고 통과시키면 "mailto:a <img src=x onerror=…>" 가 링크 목적지를 깨고 날 태그로
  // 렌더됐다(pdfjs 는 mailto·tel URI 를 정규화하지 않는다, v4.14.4 리뷰 재현). 인코딩해도 같은 주소다
  return trimmed.replace(/[()<>"'`]/g, c => HREF_ESCAPE[c]).replace(/\s/g, c => encodeURIComponent(c))
}

/**
 * HTML 엔티티 이스케이프 — 글은 `& < >`, 속성값(attr)은 `"` 까지. HTML 표 경로(builder tableToHtml)와
 * 인쇄 렌더러가 같이 쓰는 한 벌. 읽는 쪽은 unescapeHtml 로 푼다
 */
export function escapeHtml(text: string, attr = false): string {
  const s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return attr ? s.replace(/"/g, "&quot;") : s
}

/** escapeHtml 의 역 (+ 손으로 쓴 HTML 표의 &#39;) — 한 번에 풀어 "&amp;lt;" 는 "&lt;" 로 남는다 */
export function unescapeHtml(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => HTML_ENTITY[e])
}
const HTML_ENTITY: Record<string, string> = { lt: "<", gt: ">", quot: "\"", "#39": "'", amp: "&" }

/**
 * console.log·info·warn·debug 를 stderr 로 — stdout 이 기계 출력 채널(MCP JSON-RPC·CLI 마크다운/JSON·parse-worker
 * NDJSON)인 진입점용. 라이브러리(pdfjs 등)가 console 로 찍는 경고가 그 채널을 깨지 않게 한다
 */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => void process.stderr.write(format(...args) + "\n")
  console.log = toStderr
  console.info = toStderr
  console.warn = toStderr
  console.debug = toStderr
}

// ─── 안전한 min/max (스택 오버플로 방지) ─────────────

/** Math.min(...arr) 대체 — 대형 배열에서 스택 오버플로 방지 */
export function safeMin(arr: number[]): number {
  let min = Infinity
  for (let i = 0; i < arr.length; i++) if (arr[i] < min) min = arr[i]
  return min
}

/** Math.max(...arr) 대체 — 대형 배열에서 스택 오버플로 방지 */
export function safeMax(arr: number[]): number {
  let max = -Infinity
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i]
  return max
}

// ─── 에러 분류 ──────────────────────────────────────

import type { ErrorCode } from "./types.js"

/** 에러를 구조화된 ErrorCode로 분류 — KordocError 메시지 패턴 매칭 */
export function classifyError(err: unknown): ErrorCode {
  if (!(err instanceof Error)) return "PARSE_ERROR"
  const msg = err.message
  // 입력 파일 없음 — 문서 내용 문제가 아니라 호출자의 경로 문제라 PARSE_ERROR 로 덮지 않는다.
  if (isFileNotFound(err)) return "FILE_NOT_FOUND"
  // DRM 을 암호화보다 먼저 — "DRM 암호화된 HWPX…" 류 메시지가 ENCRYPTED 로 떨어지지 않도록
  if (msg.includes("DRM")) return "DRM_PROTECTED"
  if (msg.includes("암호화") || msg.includes("암호로 보호")) return "ENCRYPTED"
  if (msg.includes("optional dependency")) return "MISSING_DEPENDENCY"
  // V8 문자열 한계 초과 — 이미지 base64 총량이 큰 문서의 JSON 직렬화 (#65)
  if (msg.includes("Invalid string length") || msg.includes("Cannot create a string longer")) return "OUTPUT_TOO_LARGE"
  if (msg.includes("ZIP bomb") || msg.includes("ZIP 비압축 크기 초과") || msg.includes("ZIP 엔트리 수 초과")) return "ZIP_BOMB"
  if (msg.includes("bomb") || msg.includes("크기 초과") || msg.includes("압축 해제")) return "DECOMPRESSION_BOMB"
  if (msg.includes("이미지 기반")) return "IMAGE_BASED_PDF"
  if (msg.includes("섹션") && (msg.includes("찾을 수 없") || msg.includes("없음"))) return "NO_SECTIONS"
  if (msg.includes("시그니처") || msg.includes("복구할 수 없")) return "CORRUPTED"
  return "PARSE_ERROR"
}
