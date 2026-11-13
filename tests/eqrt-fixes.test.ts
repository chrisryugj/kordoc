/** 수식·왕복 회귀 (eqrt-1~6) — escapeGfm 수식 스팬 보호, replaceFrac 분자 인접,
 *  findKeywordToken 개행 경계, [별표 N]·이탤릭 escapeGfm, render-worker stdin 견고성 */

import { describe, it, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { hmlToLatex } from "../src/hwpx/equation.js"
import { blocksToMarkdown } from "../src/index.js"
import type { IRBlock } from "../src/types.js"

const P = (text: string): IRBlock => ({ type: "paragraph", text } as IRBlock)

describe("수식·왕복 이스케이프 회귀 (eqrt-1~4)", () => {
  it("eqrt-1: escapeGfm 이 $...$ 수식 스팬 내부 ~/* 를 건드리지 않는다", () => {
    const md = blocksToMarkdown([P("본문 $a ~ b$ 와 $f(x) * g$ 끝")])
    assert.match(md, /\$a ~ b\$/, "인라인 수식 ~ 미이스케이프")
    assert.match(md, /\$f\(x\) \* g\$/, "인라인 수식 * 미이스케이프")
    // 수식 밖 별표는 여전히 이스케이프(회귀 아님)
    assert.match(blocksToMarkdown([P("일반 홍** 별표")]), /홍\\\*\\\*/)
  })
  it("eqrt-2: replaceFrac 분자 인접 토큰 — 비인접 콘텐츠 미삭제", () => {
    assert.equal(hmlToLatex("sqrt {x} + 1 over 2"), "\\sqrt { x } + \\frac{ 1 } { 2 }")
    assert.equal(hmlToLatex("{a} over {b} + x over y"), "\\frac{ a } { b } + \\frac{ x } { y }")
    assert.equal(hmlToLatex("{a} over {b}"), "\\frac{ a } { b }") // 대조군 무회귀
  })
  it("eqrt-3: findKeywordToken 이 개행/탭 경계 예약어를 인식", () => {
    assert.match(hmlToLatex("{a} over\n{b}"), /\\frac/, "개행 구분 over 변환")
  })
  it("eqrt-4: [별표 N] 헤딩·(조 관련) 이탤릭 특례에도 escapeGfm", () => {
    assert.match(blocksToMarkdown([P("[별표 1] 담당자 홍** 김** 명단")]), /홍\\\*\\\*/, "별표 헤딩 이스케이프")
    assert.match(blocksToMarkdown([P("(제3조 홍** 관련)")]), /홍\\\*\\\*/, "이탤릭 특례 이스케이프")
  })
  it("eqrt-2/3: 분자 측 개행/탭도 무음 유실 없이 분자 보존 (공백류 정합)", () => {
    // eqrt-2 분자 역탐색 공백류를 eqrt-3 경계(/\s/)와 정합 — 다중줄 스크립트에서 분자 유실 방지
    assert.match(hmlToLatex("{a}\nover\n{b}"), /\\frac\{\s*a\s*\}/, "분자 측 개행에도 {a} 보존")
    assert.match(hmlToLatex("x\tover y"), /\\frac\{\s*x\s*\}/, "탭 경계 분자 x 보존")
    assert.equal(hmlToLatex("{a} over {b}"), "\\frac{ a } { b }", "대조군(단일 공백) 무회귀")
  })
})

describe("render-worker stdin 견고성 (eqrt-5/6)", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const runWorker = (input: string, timeoutMs = 10000): Promise<{ out: string; code: number | null }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", CLI, "render-worker"], { stdio: ["pipe", "pipe", "ignore"] })
      let out = ""
      child.stdout.on("data", (d) => { out += String(d) })
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ out, code: null }) }, timeoutMs)
      child.on("exit", (code) => { clearTimeout(timer); resolve({ out, code }) })
      child.stdin.write(input)
    })

  test("eqrt-5: 'null' 라인에 크래시하지 않고 오류 응답 후 생존", async () => {
    const { out } = await runWorker('null\n{"cmd":"quit"}\n')
    assert.match(out, /"ok":false/, "null 에 오류 응답(전체 크래시 아님)")
  })
  test("eqrt-6: {\"cmd\":\"quit\"} 로 프로세스가 종료된다", async () => {
    const { code } = await runWorker('{"cmd":"quit"}\n')
    assert.equal(code, 0, "quit 후 exit 0 로 종료(무기한 잔류 아님)")
  })
})
