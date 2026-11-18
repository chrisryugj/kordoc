/**
 * HWPX DRM 문서 COM fallback — 한컴 오피스 COM API (GetPageText) 활용
 *
 * DRM 암호화된 HWPX 파일을 한컴 오피스의 HWPFrame.HwpObject COM으로 열어
 * 페이지별 텍스트를 추출한다. Windows + 한컴 오피스 설치 필수.
 *
 * 흐름: manifest.xml에 encryption-data 발견 → COM으로 Open → GetPageText(1..N) → Markdown
 */

import { execFile } from "child_process"
import { platform } from "os"
import { win32 } from "path"
import { promisify } from "util"
import type { InternalParseResult, ParseWarning, DocumentMetadata, IRBlock } from "../types.js"

const execFileAsync = promisify(execFile)

/** Windows PowerShell 전체 경로. 이름("powershell")만 주면 Windows 는 현재 폴더를 시스템 폴더보다 먼저 찾아,
 *  작업 폴더(받은 압축을 푼 폴더 등)에 같은 이름 실행 파일이 있으면 그것이 뜬다 */
export function powershellPath(): string {
  return win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

/** 한컴오피스 한글 자동화로 대신 읽기를 끄는 환경 변수 (CLI·MCP·감싼 앱이 옵션 없이 끌 때) */
export const NO_HANCOM_ENV = "KORDOC_NO_HANCOM"

/** 한컴오피스 한글 자동화(COM)를 띄워도 되는가 — Windows 이고, 옵션 hancomFallback 이 false 가 아니고, KORDOC_NO_HANCOM=1 이 아닐 때 */
export function hancomAllowed(options?: { hancomFallback?: boolean }): boolean {
  return platform() === "win32" && options?.hancomFallback !== false && process.env[NO_HANCOM_ENV] !== "1"
}

/** COM fallback 사용 가능 여부 (Windows, 끄지 않았을 때) */
export function isComFallbackAvailable(options?: { hancomFallback?: boolean }): boolean {
  return hancomAllowed(options)
}

/** manifest.xml 내용에서 encryption-data 존재 여부 확인 */
export function isEncryptedHwpx(manifestXml: string): boolean {
  return manifestXml.includes("encryption-data")
}

/**
 * COM API로 DRM HWPX 파일의 텍스트를 추출
 * @param filePath 디스크 상의 HWPX 파일 절대 경로
 */
export async function extractTextViaCom(filePath: string): Promise<{ pages: string[]; pageCount: number; warnings: ParseWarning[] }> {
  if (platform() !== "win32") {
    throw new Error("COM fallback은 Windows에서만 사용 가능합니다")
  }
  const { args, env } = comPowerShellInvocation(filePath)
  // 비동기로: 한글을 띄워 쪽마다 글을 받는 동안(길면 2분) 호출한 프로그램의 이벤트 루프를 막지 않는다
  const { stdout } = await execFileAsync(powershellPath(), args, {
    encoding: "utf-8",
    env,
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

/** COM 추출 PowerShell 인자·환경 — 파일 경로는 인자(스크립트)에 넣지 않고 환경 변수 KORDOC_COM_SRC 로만 넘긴다 */
export function comPowerShellInvocation(filePath: string): { args: string[]; env: NodeJS.ProcessEnv } {
  // PowerShell 스크립트를 인라인으로 실행
  //
  // 핵심 우회: 파일을 %TEMP%로 복사한 뒤 해당 경로로 Open.
  //   한컴 오피스는 파일 경로가 "신뢰 영역"(사용자 Temp/AppData 등) 밖일 때
  //   FilePathChecker가 경고 팝업을 띄운다. FilePathCheckerModuleExample DLL이
  //   등록된 개발 환경에서는 RegisterModule이 작동해 경고가 억제되지만, 일반
  //   사용자 환경에는 해당 DLL이 없다.
  //   %TEMP% 하위 경로로 복사하면 신뢰 영역 규칙에 의해 경고가 나오지 않아
  //   DLL 등록 없이도 안정적으로 DRM 텍스트를 추출할 수 있다.
  //
  // - RegisterModule: 보안 경고 1차 억제(DLL 없어도 해가 없음). 첫 인수는 한컴 오토메이션이 정한 모듈 종류
  //   'FilePathCheckDLL' 이고, 둘째 인수는 HKCU\Software\HNC\HwpAutomation\Modules 에 DLL 경로를 담은 값 이름이다.
  //   종류를 'FilePathCheckerModule' 로 주면 DLL 을 등록해 둔 환경에서도 늘 False 라 억제가 걸리지 않는다(한글 2022 실측)
  // - GetPageText: DRM 우회 텍스트 추출
  // 경로는 스크립트 문자열에 넣지 않고 환경 변수로 넘긴다 — PowerShell 은 ASCII ' 말고도 ‘ ’ ‚ ‛ 를 작은따옴표로 받아,
  // 따옴표 이스케이프만으로는 파일 이름(공격자가 정한다)에 명령을 심는 것을 막지 못한다
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$src = $env:KORDOC_COM_SRC
$tmpDir = Join-Path $env:TEMP ('hwp-com-' + [guid]::NewGuid().ToString('N'))

try {
  # 폴더 만들기·복사도 try 안 — 복사가 실패해도 finally 가 임시 폴더를 지운다 (#177)
  [void](New-Item -ItemType Directory -Path $tmpDir -Force)
  $tmpFile = Join-Path $tmpDir (Split-Path $src -Leaf)
  Copy-Item -LiteralPath $src -Destination $tmpFile -Force
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample') | Out-Null
  # suspendpassword: 열기 암호가 걸린 문서는 암호 입력 창을 띄우지 않고 바로 실패 — 숨은 창이 입력을 기다리며 멈추던 것 (#93)
  $opened = $hwp.Open($tmpFile, '', 'suspendpassword:TRUE;forceopen:TRUE;versionwarning:FALSE')
  if (-not $opened) { throw 'Open 실패 (열기 암호가 걸린 문서일 수 있음)' }
  $pc = $hwp.PageCount
  $result = @{ pageCount = $pc; pages = @() }
  for ($p = 1; $p -le $pc; $p++) {
    $t = $hwp.GetPageText($p, 0)
    $result.pages += @($t)
  }
  $hwp.Clear(1) | Out-Null
  try { $hwp.Quit() | Out-Null } catch { }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  $result | ConvertTo-Json -Depth 3 -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  # 임시 파일 정리 + 좀비 Hwp.exe 방지용 garbage collect
  try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`

  return {
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps1],
    env: { ...process.env, KORDOC_COM_SRC: filePath },
  }
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
  // COM GetPageText는 실제 페이지 단위 (#66)
  const metadata: DocumentMetadata = { pageCount, pageMode: "layout" }

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
