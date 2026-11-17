/**
 * COM 폴백 PowerShell — 한컴 보안 승인 모듈 등록 인수
 *
 * RegisterModule 의 첫 인수(모듈 종류)는 한컴 오토메이션이 정한 'FilePathCheckDLL' 이어야 한다.
 * 다른 이름이면 DLL 을 레지스트리에 등록해 둔 환경에서도 늘 False 라 접근 확인 창 억제가 걸리지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

describe("COM 폴백 — 보안 승인 모듈 등록", () => {
  it("RegisterModule 은 모듈 종류 'FilePathCheckDLL' 로 부른다", async () => {
    const { comPowerShellInvocation } = await import("../src/hwpx/com-fallback.js")
    const { args } = comPowerShellInvocation("C:\\in\\a.hwpx")
    const script = args[args.length - 1]
    assert.ok(script.includes("$hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample')"), script)
    assert.ok(!script.includes("RegisterModule('FilePathCheckerModule'"))
  })
  it("임시 폴더 만들기·복사는 try 안에 있어 실패해도 finally 가 지운다 (#177)", async () => {
    const { comPowerShellInvocation } = await import("../src/hwpx/com-fallback.js")
    const script = comPowerShellInvocation("C:\\in\\a.hwpx").args.at(-1)!
    const tryAt = script.indexOf("try {")
    assert.ok(tryAt > 0 && tryAt < script.indexOf("New-Item -ItemType Directory"), script)
    assert.ok(tryAt < script.indexOf("Copy-Item -LiteralPath"), script)
    assert.ok(script.indexOf("$tmpDir = Join-Path") < tryAt, "finally 가 쓸 경로는 try 앞에서 정한다")
  })
  it("벤치 한컴 PDF 스크립트도 같은 종류 이름을 쓴다", () => {
    const ps1 = readFileSync(new URL("../bench/hangul-com-pdf.ps1", import.meta.url), "utf8")
    assert.ok(ps1.includes("RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample')"))
  })
})

describe("COM 폴백 — 끄기·실행 위치", () => {
  it("PowerShell 은 System32 전체 경로로 띄운다 (이름만이면 작업 폴더의 같은 이름 실행 파일이 먼저 잡힌다)", async () => {
    const { powershellPath } = await import("../src/hwpx/com-fallback.js")
    const saved = process.env.SystemRoot
    process.env.SystemRoot = "D:\\Windows"
    try {
      assert.equal(powershellPath(), "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    } finally {
      if (saved === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = saved
    }
  })

  it("hancomFallback:false 나 KORDOC_NO_HANCOM=1 이면 Windows 에서도 한글을 띄우지 않는다", async () => {
    const os = await import("node:os")
    const { syncBuiltinESMExports } = await import("node:module")
    const { hancomAllowed, isComFallbackAvailable } = await import("../src/hwpx/com-fallback.js")
    const original = os.default.platform
    os.default.platform = () => "win32"
    syncBuiltinESMExports()
    const saved = process.env.KORDOC_NO_HANCOM
    try {
      delete process.env.KORDOC_NO_HANCOM
      assert.equal(hancomAllowed(), true)
      assert.equal(isComFallbackAvailable({ hancomFallback: false }), false)
      process.env.KORDOC_NO_HANCOM = "1"
      assert.equal(hancomAllowed(), false)
      assert.equal(isComFallbackAvailable(), false)
    } finally {
      os.default.platform = original
      syncBuiltinESMExports()
      if (saved === undefined) delete process.env.KORDOC_NO_HANCOM
      else process.env.KORDOC_NO_HANCOM = saved
    }
    assert.equal(hancomAllowed(), process.platform === "win32" && process.env.KORDOC_NO_HANCOM !== "1")
  })
})
