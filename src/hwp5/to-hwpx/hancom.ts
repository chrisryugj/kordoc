/**
 * 한/글(한컴오피스) 자체 저장으로 HWPX 변환 — Windows + 한/글 설치 환경에서만. 한/글이 직접 저장하므로 서식이 한/글 저장본과 같다.
 * HWP 3.x·HWPML 도 서식 그대로 옮긴다(kordoc 엔진은 글·표만).
 *
 * 팝업 없이 돈다:
 * - 승인(보안) 창: 한/글은 자동화가 "신뢰 영역" 밖 파일을 열거나 저장하면 접근 승인 창을 띄운다. 원본을 사용자 임시 폴더로 복사해 열고
 *   저장도 임시 폴더에 한 뒤 결과만 꺼낸다(src/hwpx/com-fallback.ts 와 같은 우회). 보안 모듈 등록(RegisterModule)도 함께 건다
 * - 메시지 창: SetMessageBoxMode 로 확인·예 자동 응답(없으면 HWPX 저장 확인 창에서 멈춘다)
 * - 암호 창: suspendpassword — 열기 암호가 걸린 문서는 창을 띄우지 않고 실패로 알린다
 * - 버전 경고 창: versionwarning:FALSE, 한/글 창은 숨긴다
 * 경로는 스크립트 문자열에 넣지 않고 환경 변수로만 넘긴다(파일 이름에 명령을 심는 것 방지 — com-fallback.ts 참고)
 */

import { execFileSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { platform, tmpdir } from "os"
import { join } from "path"
import { KordocError } from "../../utils.js"

/** 이 환경에서 한/글 자동화(HWPFrame.HwpObject)를 쓸 수 있는가 — Windows 에서 COM 클래스가 등록돼 있을 때만 */
export function hancomAvailable(): boolean {
  if (platform() !== "win32") return false
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "if ([type]::GetTypeFromProgID('HWPFrame.HwpObject')) { 'yes' } else { 'no' }"], { encoding: "utf-8", timeout: 30_000, windowsHide: true })
    return out.trim().endsWith("yes")
  } catch {
    return false
  }
}

/** 한/글 저장 PowerShell 인자·환경 — 입력·출력 경로는 환경 변수 KORDOC_COM_SRC·KORDOC_COM_OUT 로만 */
export function hancomSaveInvocation(src: string, out: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$src = $env:KORDOC_COM_SRC
$out = $env:KORDOC_COM_OUT
$tmpDir = Join-Path $env:TEMP ('hwp-com-' + [guid]::NewGuid().ToString('N'))
try {
  [void](New-Item -ItemType Directory -Path $tmpDir -Force)
  $tmpFile = Join-Path $tmpDir ('src' + [System.IO.Path]::GetExtension($src))
  $tmpOut = Join-Path $tmpDir 'out.hwpx'
  Copy-Item -LiteralPath $src -Destination $tmpFile -Force
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample') | Out-Null
  try { $hwp.XHwpWindows.Item(0).Visible = $false } catch { }
  $hwp.SetMessageBoxMode(0x2FFF1) | Out-Null
  $opened = $hwp.Open($tmpFile, '', 'suspendpassword:TRUE;forceopen:TRUE;versionwarning:FALSE')
  if (-not $opened) { throw 'OPEN' }
  $saved = $hwp.SaveAs($tmpOut, 'HWPX', '')
  $hwp.Clear(1) | Out-Null
  try { $hwp.Quit() | Out-Null } catch { }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  if (-not $saved -or -not (Test-Path -LiteralPath $tmpOut)) { throw 'SAVE' }
  Copy-Item -LiteralPath $tmpOut -Destination $out -Force
  'OK'
} catch {
  'ERR ' + $_.Exception.Message
} finally {
  try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`
  return {
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps1],
    env: { ...process.env, KORDOC_COM_SRC: src, KORDOC_COM_OUT: out },
  }
}

/** 한/글 문서(HWP 5.x·HWP 3.x·HWPML) → HWPX, 한/글 자체 저장. 원본 확장자는 detectFormat 결과로 붙인다(한/글이 확장자로 형식을 고른다) */
export function hwpToHwpxViaHancom(bytes: Uint8Array, ext: "hwp" | "hml"): Uint8Array {
  if (platform() !== "win32") throw new KordocError("한/글 저장 변환은 Windows + 한/글 설치 환경에서만 씁니다 — engine 을 \"kordoc\" 이나 \"auto\" 로 주세요")
  const dir = mkdtempSync(join(tmpdir(), "kordoc-hancom-"))
  try {
    const src = join(dir, `in.${ext}`), out = join(dir, "out.hwpx")
    writeFileSync(src, bytes)
    const { args, env } = hancomSaveInvocation(src, out)
    const res = execFileSync("powershell", args, { encoding: "utf-8", env, timeout: 300_000, windowsHide: true }).trim()
    const last = res.split(/\r?\n/).pop() ?? ""
    if (last !== "OK") {
      if (last === "ERR OPEN") throw new KordocError("한/글이 문서를 열지 못했습니다 — 열기 암호가 걸린 문서는 engine \"kordoc\" 과 password 로 바꾸세요")
      throw new KordocError(`한/글 저장 변환 실패: ${last.replace(/^ERR\s*/, "") || res.slice(0, 200)}`)
    }
    return new Uint8Array(readFileSync(out))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
