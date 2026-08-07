/** 폐쇄망 하드닝 — KORDOC_OFFLINE 아웃바운드 차단 + KORDOC_ROOT 파일 접근 제한.
 *  내부망 보안성 검토 대비(v4.7.2): 두 변수 미설정 시 기존 동작이 그대로여야 한다. */

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertNetworkAllowed,
  assertWithinRoot,
  getAccessRoot,
  isOfflineMode,
  isWithinRoot,
} from "../src/shared/offline.js"
import { PARSE_EXTENSIONS, safePath, safeOutputPath } from "../src/mcp.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "kordoc-root-")))
const inside = join(root, "doc.pdf")
writeFileSync(inside, "%PDF-1.4\n")
mkdirSync(join(root, "sub"))

// 형제 디렉토리 — 문자열 prefix 매칭이면 통과해버리는 함정 케이스
const sibling = realpathSync(mkdtempSync(join(tmpdir(), "kordoc-other-")))
const outside = join(sibling, "secret.pdf")
writeFileSync(outside, "%PDF-1.4\n")

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

afterEach(() => {
  delete process.env.KORDOC_OFFLINE
  delete process.env.KORDOC_ROOT
})

describe("KORDOC_OFFLINE — 아웃바운드 킬스위치", () => {
  it("미설정이면 오프라인 모드가 아니고 통신이 허용된다", () => {
    withEnv({ KORDOC_OFFLINE: undefined }, () => {
      assert.equal(isOfflineMode(), false)
      assert.doesNotThrow(() => assertNetworkAllowed("모델 다운로드"))
    })
  })

  it("1/true/yes/on(대소문자·공백 무관)은 오프라인, 0/false/빈값은 아니다", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) {
      withEnv({ KORDOC_OFFLINE: v }, () => assert.equal(isOfflineMode(), true, v))
    }
    for (const v of ["0", "false", "", "no"]) {
      withEnv({ KORDOC_OFFLINE: v }, () => assert.equal(isOfflineMode(), false, JSON.stringify(v)))
    }
  })

  it("오프라인이면 차단 사유와 대안이 함께 담긴 에러로 즉시 끊는다", () => {
    withEnv({ KORDOC_OFFLINE: "1" }, () => {
      assert.throws(
        () => assertNetworkAllowed("모델 다운로드", "kordoc models --import 로 반입하세요"),
        (err: Error) => /폐쇄망 모드/.test(err.message) && /models --import/.test(err.message),
      )
    })
  })
})

describe("KORDOC_ROOT — 파일 접근 루트 제한", () => {
  it("미설정이면 루트가 없고 어떤 경로도 막지 않는다 (기존 동작 보존)", () => {
    withEnv({ KORDOC_ROOT: undefined }, () => {
      assert.equal(getAccessRoot(), null)
      assert.doesNotThrow(() => assertWithinRoot(outside))
    })
  })

  it("isWithinRoot: 루트 자신·하위는 허용, 형제 prefix 디렉토리는 거부", () => {
    assert.equal(isWithinRoot(root, root), true)
    assert.equal(isWithinRoot(join(root, "sub", "a.pdf"), root), true)
    assert.equal(isWithinRoot(`${root}x/a.pdf`, root), false)
    assert.equal(isWithinRoot(join(root, "..", "a.pdf"), root), false)
  })

  it("safePath: 루트 하위는 통과, 밖은 거부", () => {
    withEnv({ KORDOC_ROOT: root }, () => {
      assert.equal(safePath(inside, PARSE_EXTENSIONS), inside)
      assert.throws(() => safePath(outside, PARSE_EXTENSIONS), /KORDOC_ROOT/)
    })
  })

  it("safeOutputPath: 부모가 없는 신규 경로도 루트 밖이면 거부", () => {
    withEnv({ KORDOC_ROOT: root }, () => {
      const exts = new Set([".hwpx"])
      assert.equal(safeOutputPath(join(root, "out.hwpx"), exts), join(root, "out.hwpx"))
      assert.throws(() => safeOutputPath(join(sibling, "nope", "out.hwpx"), exts), /KORDOC_ROOT/)
    })
  })

  it("루트를 심볼릭 링크로 우회할 수 없다 (realpath 기준 판정)", () => {
    withEnv({ KORDOC_ROOT: root }, () => {
      const link = join(root, "escape.pdf")
      try {
        symlinkSync(outside, link)
      } catch {
        return // 심볼릭 링크 미지원 환경(Windows 비관리자)에서는 검증 생략
      }
      assert.throws(() => safePath(link, PARSE_EXTENSIONS), /KORDOC_ROOT/)
    })
  })
})
