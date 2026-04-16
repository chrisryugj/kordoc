/**
 * HWPX DRM 문서 COM fallback — 한컴 오피스 COM API (GetPageText) 활용
 *
 * DRM 암호화된 HWPX 파일을 한컴 오피스의 HWPFrame.HwpObject COM으로 열어
 * 페이지별 텍스트를 추출한다. Windows + 한컴 오피스 설치 필수.
 *
 * 흐름: manifest.xml에 encryption-data 발견 → COM으로 Open → GetPageText(1..N) → Markdown
 */

import { execFileSync } from "child_process"
import { platform } from "os"
import type { InternalParseResult, ParseWarning, DocumentMetadata, IRBlock } from "../types.js"

/** COM fallback 사용 가능 여부 (Windows만) */
export function isComFallbackAvailable(): boolean {
  return platform() === "win32"
}

/** manifest.xml 내용에서 encryption-data 존재 여부 확인 */
export function isEncryptedHwpx(manifestXml: string): boolean {
  return manifestXml.includes("encryption-data")
}

/**
 * COM API로 DRM HWPX 파일의 텍스트를 추출
 * @param filePath 디스크 상의 HWPX 파일 절대 경로
 */
export function extractTextViaCom(filePath: string): { pages: string[]; pageCount: number; warnings: ParseWarning[] } {
  if (!isComFallbackAvailable()) {
    throw new Error("COM fallback은 Windows에서만 사용 가능합니다")
  }

  // PowerShell 스크립트를 인라인으로 실행
  // - RegisterModule: 보안 경고 억제
  // - GetPageText: DRM 우회 텍스트 추출
  // filePath를 single-quote로 이스케이프 (내부 ' → '')
  const escaped = filePath.replace(/'/g, "''")
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.RegisterModule('FilePathCheckerModule', 'FilePathCheckerModuleExample') | Out-Null
  $hwp.Open('${escaped}', '', '') | Out-Null
  $pc = $hwp.PageCount
  $result = @{ pageCount = $pc; pages = @() }
  for ($p = 1; $p -le $pc; $p++) {
    $t = $hwp.GetPageText($p, 0)
    $result.pages += @($t)
  }
  $hwp.Clear(1)
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  $result | ConvertTo-Json -Depth 3 -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`

  const stdout = execFileSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", ps1,
  ], {
    encoding: "utf-8",
    timeout: 120_000,      // 2분 타임아웃
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,  // 50MB
  })

  // COM 메서드 반환값 등 JSON 앞의 garbage 제거
  const trimmed = stdout.trim()
  const jsonStart = trimmed.indexOf("{")
  if (jsonStart < 0) throw new Error(`COM 출력에 JSON이 없습니다: ${trimmed.slice(0, 200)}`)
  const json = JSON.parse(trimmed.slice(jsonStart))
  if (json.error) {
    throw new Error(`COM 텍스트 추출 실패: ${json.error}`)
  }

  const warnings: ParseWarning[] = []
  const pages: string[] = Array.isArray(json.pages) ? json.pages : []
  const pageCount: number = json.pageCount ?? pages.length

  if (pages.length === 0) {
    warnings.push({ message: "COM으로 텍스트를 추출하지 못했습니다", code: "COM_EMPTY" })
  }

  return { pages, pageCount, warnings }
}

/**
 * COM 추출 결과를 InternalParseResult로 변환
 */
export function comResultToParseResult(
  pages: string[],
  pageCount: number,
  warnings: ParseWarning[],
): InternalParseResult {
  const blocks: IRBlock[] = []
  const lines: string[] = []

  for (let i = 0; i < pages.length; i++) {
    const text = (pages[i] ?? "").trim()
    if (!text) continue

    // 페이지 텍스트를 paragraph 블록들로 변환
    const paragraphs = text.split(/\n/)
    for (const para of paragraphs) {
      const trimmed = para.trim()
      if (!trimmed) continue
      blocks.push({ type: "paragraph", text: trimmed, pageNumber: i + 1 })
      lines.push(trimmed)
    }
  }

  const markdown = lines.join("\n\n")
  const metadata: DocumentMetadata = { pageCount }

  warnings.push({
    message: "DRM 문서: 한컴 COM API로 텍스트 추출 (서식/표 정보 제한적)",
    code: "DRM_COM_FALLBACK",
  })

  return {
    markdown,
    blocks,
    metadata,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}
