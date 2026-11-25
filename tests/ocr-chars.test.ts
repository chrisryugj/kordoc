/**
 * OCR 줄의 글자(ocrChars) — 글자마다 신뢰도·상자, 고르면 같은 시점의 대안 글자.
 *
 * 잠근 계약:
 *  1. ctcDecode 의 글자 점수 — 글자 신뢰도는 그 글자를 고른 시점(구간 첫 시점)의 확률, 대안은 같은 시점에서 고른 글자를 뺀 확률 높은 순·
 *     n 개 이하·0.001 이상·한 글자짜리만. 여러 글자짜리 사전 항목은 글자마다 같은 신뢰도·대안 없음. 로짓 출력은 정규화. 주지 않으면 결과가 전과 같다
 *  2. 글자 상자 — 줄 상자를 빈틈·겹침 없이 왼→오른으로 나눈다. 글자 수가 시점과 맞지 않으면 없다. 빈 칸 다시 읽기는 줄과 함께 옮긴다
 *  3. 옵션 값 — true·false 또는 0~5 정수, ocrLines 와 함께. 그 밖은 parse() 실패 결과·워커 INVALID_OPTIONS
 *  4. 옵션 → 엔진 설정(tuning.chars, true 는 0), 줄 묶음은 글자를 그대로 싣는다. 끄면 기본 설정 객체 그대로
 *  5. 내장 OCR E2E(모델 있을 때만): 켜도 나머지 결과는 같고, 글자를 이으면 줄 글, 상자는 줄 상자 안, 대안은 n 개 이하·내림차순
 *  6. CLI --ocr-chars·protocol 2 응답이 parse() 와 같다
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../src/index.js"
import { cliOcrEngineOptions } from "../src/cli/convert.js"
import { toParseOptions, WorkerProtocolError } from "../src/cli/parse-worker-v2.js"
import { DEFAULT_OCR_TUNING, ctcDecode, lineChars, type OcrEngine } from "../src/ocr/engine.js"
import { rescueEmptyCells } from "../src/ocr/empty-cell-rescue.js"
import { getOcrModelStatus } from "../src/ocr/models.js"
import { validateOcrOptions } from "../src/ocr/options.js"
import { DEFAULT_BUILTIN_OCR, builtinOcrConfig, pageLines, toOcrLine } from "../src/ocr/pdf-ocr.js"
import type { ParseResult } from "../src/types.js"
import { scanFixtures } from "./fixtures/sdk-docs.js"

/** 클래스: 0 blank, 1 "가", 2 "나", 3 "다", 4 "ab"(여러 글자짜리 사전 항목), 5 공백 */
const DICT = ["가", "나", "다", "ab"]
const C = DICT.length + 2
const matrix = (rows: number[][]) => Float32Array.from(rows.flat())
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

describe("ctcDecode 글자 점수", () => {
  // 가(0.7, 대안 나 0.2·다 0.0495, ab 0.05 는 여러 글자) · 가(이어짐) · blank · ab(0.6, 여러 글자라 대안 없음) · 공백 · 나(0.5, 대안 다 0.0005 는 하한 아래)
  const rows = [
    [0, 0.7, 0.2, 0.0495, 0.05, 0.0005],
    [0.1, 0.9, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [0.05, 0, 0.3, 0, 0.6, 0.05],
    [0, 0, 0, 0, 0, 1],
    [0.4995, 0, 0.5, 0.0005, 0, 0],
  ].map(r => r.map(Math.fround))

  it("글자 신뢰도는 그 글자를 고른 첫 시점의 확률, 대안은 같은 시점에서 고른 글자를 뺀 확률 높은 순", () => {
    const r = ctcDecode(matrix(rows), rows.length, C, DICT, 5)!
    assert.equal(r.text, "가ab 나")
    const s = r.charScores!
    assert.equal(s.length, [...r.text].length, "글자(코드 포인트)마다 하나")
    assert.equal(s.length, r.steps.length)
    assert.ok(near(s[0].confidence, 0.7))
    assert.deepEqual(s[0].alternatives!.map(a => a.text), ["나", "다"])
    assert.ok(near(s[0].alternatives![0].confidence, 0.2) && near(s[0].alternatives![1].confidence, 0.0495))
    // "ab" 는 두 글자 모두 같은 점수에 대안 없음 (대안에도 여러 글자짜리 항목은 오지 않는다 — 위 "가")
    assert.ok(near(s[1].confidence, 0.6) && near(s[2].confidence, 0.6))
    assert.equal(s[1].alternatives, undefined)
    assert.equal(s[2].alternatives, undefined)
    assert.ok(near(s[3].confidence, 1))
    assert.equal(s[3].alternatives, undefined, "대안이 없으면 키도 없다")
    assert.equal(s[4].alternatives, undefined, "0.001 아래는 대안이 아니다")
    // 줄 신뢰도는 고른 글자 신뢰도의 평균 (여러 글자짜리 항목은 한 번)
    assert.ok(near(r.confidence, (0.7 + 0.6 + 1 + 0.5) / 4))
  })

  it("대안은 n 개까지, 0 이면 신뢰도만", () => {
    const one = ctcDecode(matrix(rows), rows.length, C, DICT, 1)!.charScores!
    assert.deepEqual(one[0].alternatives!.map(a => a.text), ["나"])
    const none = ctcDecode(matrix(rows), rows.length, C, DICT, 0)!.charScores!
    assert.ok(none.every(c => c.alternatives === undefined))
    assert.deepEqual(none.map(c => c.confidence), one.map(c => c.confidence))
  })

  it("주지 않으면 결과가 전과 같다(charScores 없음)", () => {
    const r = ctcDecode(matrix(rows), rows.length, C, DICT)!
    assert.deepEqual(Object.keys(r).sort(), ["confidence", "steps", "text"])
    const { charScores: _, ...withAlts } = ctcDecode(matrix(rows), rows.length, C, DICT, 5)!
    assert.deepEqual(withAlts, r)
  })

  it("softmax 가 아닌 출력(로짓)은 시점마다 정규화한다", () => {
    const logits = rows.map(r => r.map(p => Math.log(p + 1e-9) + 3))
    const a = ctcDecode(matrix(rows), rows.length, C, DICT, 5)!.charScores!
    const b = ctcDecode(matrix(logits), rows.length, C, DICT, 5)!.charScores!
    assert.equal(b.length, a.length)
    b.forEach((c, i) => {
      assert.ok(near(c.confidence, a[i].confidence, 1e-5))
      assert.deepEqual(c.alternatives?.map(x => x.text), a[i].alternatives?.map(x => x.text))
      c.alternatives?.forEach((x, k) => assert.ok(near(x.confidence, a[i].alternatives![k].confidence, 1e-5)))
    })
  })
})

describe("글자 상자 (lineChars)", () => {
  const scores = (n: number) => Array.from({ length: n }, () => ({ confidence: 0.9 }))
  it("줄 상자를 시점 가운데 사이 중점에서 나눈다 — 빈틈·겹침 없이 왼→오른", () => {
    // 상자 x=100 에서 시점 하나가 4px, 글자 시점 2·6·12 → 가운데 110·126·150, 경계 118·138
    const got = lineChars("가나다", [2, 6, 12], scores(3), 100, 4, { x: 102, y: 20, w: 60, h: 16 })!
    assert.deepEqual(got.map(c => c.box), [
      { x: 102, y: 20, w: 16, h: 16 },
      { x: 118, y: 20, w: 20, h: 16 },
      { x: 138, y: 20, w: 24, h: 16 },
    ])
    assert.deepEqual(got.map(c => c.text), ["가", "나", "다"])
  })

  it("경계가 줄 상자 밖이면 상자 끝에 붙인다, 글자 수가 시점·점수와 다르면 null", () => {
    const got = lineChars("가나", [0, 1], scores(2), 0, 10, { x: 30, y: 0, w: 20, h: 8 })!
    assert.deepEqual(got.map(c => [c.box.x, c.box.w]), [[30, 0], [30, 20]])
    assert.equal(lineChars("가나", [0], scores(2), 0, 10, { x: 0, y: 0, w: 20, h: 8 }), null)
    assert.equal(lineChars("가나", [0, 1], scores(1), 0, 10, { x: 0, y: 0, w: 20, h: 8 }), null)
  })
})

describe("빈 칸 다시 읽기 — 글자 상자도 줄과 함께 쪽 좌표로", () => {
  it("칸을 잘라 읽은 줄의 글자 상자를 줄 상자와 같은 만큼 옮긴다", async () => {
    const W = 1000, H = 800, rgba = new Uint8Array(W * H * 4).fill(255)
    for (let y = 130; y < 150; y++) for (let x = 120; x < 180; x += 2) rgba.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3)
    const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, thicknessPx: 1 })
    const ruling = { horizontals: [seg(100, 100, 200, 100), seg(100, 200, 200, 200)], verticals: [seg(100, 100, 100, 200), seg(200, 100, 200, 200)] }
    const read = { text: "서울", x: 20, y: 30, w: 40, h: 20, confidence: 0.9,
      chars: [{ text: "서", box: { x: 20, y: 30, w: 20, h: 20 }, confidence: 0.9 }, { text: "울", box: { x: 40, y: 30, w: 20, h: 20 }, confidence: 0.9 }] }
    const engine = { recognizePage: async () => [read] } as unknown as OcrEngine
    const [line] = await rescueEmptyCells(engine, DEFAULT_OCR_TUNING, rgba, W, H, ruling as never, [])
    const dx = line.x - read.x, dy = line.y - read.y
    assert.ok(dx !== 0 && dy !== 0, "칸 좌표로 옮겨졌다")
    assert.deepEqual(line.chars!.map(c => c.box), read.chars.map(c => ({ ...c.box, x: c.box.x + dx, y: c.box.y + dy })))
  })
})

describe("ocrChars 옵션 값", () => {
  it("true·false 또는 0~5 정수, ocrLines 와 함께", () => {
    for (const ok of [{ ocrChars: false }, { ocrChars: 0 }, { ocrLines: true, ocrChars: true }, { ocrLines: true, ocrChars: 1 }, { ocrLines: "all", ocrChars: 5 }] as const) {
      assert.equal(validateOcrOptions(ok), null, JSON.stringify(ok))
    }
    for (const bad of [-1, 6, 2.5, "3", null]) assert.match(validateOcrOptions({ ocrLines: true, ocrChars: bad as never }) ?? "", /ocrChars 는 true·false 또는 0~5 정수/, JSON.stringify(bad))
    assert.match(validateOcrOptions({ ocrChars: true }) ?? "", /ocrLines 와 함께/)
    assert.match(validateOcrOptions({ ocrLines: false, ocrChars: 3 }) ?? "", /ocrLines 와 함께/)
  })

  it("parse()·워커가 문서를 읽기 전에 거부한다", async () => {
    const r = await parse(Buffer.from("%PDF-1.4\n"), { ocrLines: true, ocrChars: 6 })
    assert.match(r.success ? "" : r.error, /ocrChars/)
    for (const bad of [{ ocrLines: true, ocrChars: 6 }, { ocrLines: true, ocrChars: 1.5 }, { ocrLines: true, ocrChars: "3" }, { ocrChars: true }]) {
      assert.throws(() => toParseOptions(bad, "/x"), (e: unknown) => e instanceof WorkerProtocolError && e.code === "INVALID_OPTIONS", JSON.stringify(bad))
    }
    assert.deepEqual(toParseOptions({ ocrLines: true, ocrChars: true }, "/x"), { filePath: "/x", ocrLines: true, ocrChars: true })
    assert.deepEqual(toParseOptions({ ocrLines: true, ocrChars: 3 }, "/x"), { filePath: "/x", ocrLines: true, ocrChars: 3 })
  })

  it("CLI 플래그 → ParseOptions (값 없이 주면 true, 숫자가 아니면 받은 글 그대로 넘겨 parse() 가 거부)", () => {
    assert.deepEqual(cliOcrEngineOptions({ ocrLines: true, ocrChars: true }), { ocrLines: true, ocrChars: true })
    assert.deepEqual(cliOcrEngineOptions({ ocrLines: true, ocrChars: "3" }), { ocrLines: true, ocrChars: 3 })
    assert.match(validateOcrOptions(cliOcrEngineOptions({ ocrLines: true, ocrChars: "abc" })) ?? "", /ocrChars.*"abc"/)
    assert.match(validateOcrOptions(cliOcrEngineOptions({ ocrChars: true })) ?? "", /ocrLines 와 함께/)
  })
})

describe("엔진 설정·줄 묶음", () => {
  it("옵션 → tuning.chars (true 는 대안 0), 끄면 기본 설정 객체 그대로", () => {
    assert.equal(builtinOcrConfig({ ocrLines: true, ocrChars: false }).tuning, DEFAULT_OCR_TUNING)
    assert.equal(builtinOcrConfig({ ocrLines: true, ocrChars: 0 }).tuning, DEFAULT_OCR_TUNING)
    assert.equal(builtinOcrConfig({ ocrChars: false }), DEFAULT_BUILTIN_OCR)
    assert.deepEqual(builtinOcrConfig({ ocrLines: true, ocrChars: true }).tuning, { ...DEFAULT_OCR_TUNING, chars: 0 })
    assert.deepEqual(builtinOcrConfig({ ocrLines: true, ocrChars: 3, ocrLineCandidates: 2 }).tuning, { ...DEFAULT_OCR_TUNING, chars: 3, lineCandidates: 2 })
    assert.equal("chars" in DEFAULT_OCR_TUNING, false)
    assert.throws(() => builtinOcrConfig({ ocrLines: true, ocrChars: 6 }), /ocrChars/)
  })

  it("줄은 글자가 있을 때만 chars 를 싣는다", () => {
    const item = { text: "가나", x: 1, y: 2, w: 30, h: 10, confidence: 0.98 }
    assert.deepEqual(toOcrLine(item), { text: "가나", box: { x: 1, y: 2, w: 30, h: 10 }, confidence: 0.98 })
    const chars = [{ text: "가", box: { x: 1, y: 2, w: 15, h: 10 }, confidence: 0.99 }, { text: "나", box: { x: 16, y: 2, w: 15, h: 10 }, confidence: 0.97, alternatives: [{ text: "다", confidence: 0.02 }] }]
    assert.deepEqual(toOcrLine({ ...item, chars }), { text: "가나", box: { x: 1, y: 2, w: 30, h: 10 }, confidence: 0.98, chars })
    assert.deepEqual(pageLines(1, 100, 100, 3, 0, [item], [{ ...item, y: 50, chars }]).lines.map(l => [l.dropped ?? false, l.chars?.length ?? 0]), [[false, 0], [true, 2]])
  })
})

const withoutChars = (r: ParseResult) => JSON.parse(JSON.stringify(r, (k, v) => k === "chars" ? undefined : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))
const toWire = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

/** CLI 를 띄워 stdout 을 모은다 (stdin 은 받은 줄을 쓰고 닫는다) */
function run(args: string[], input = ""): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => chunks.push(d))
    child.stderr.resume()
    child.on("close", (code) => resolve({ out: Buffer.concat(chunks).toString("utf8"), code }))
    child.stdin.end(input)
  })
}

describe("내장 OCR E2E — 글자 (모델 있을 때만)", () => {
  async function fixtures(t: { skip(msg: string): void }) {
    if (!(await getOcrModelStatus()).every(s => s.verified)) { t.skip("OCR 모델 미설치"); return null }
    const f = await scanFixtures()
    if (!f) t.skip("sharp 미설치")
    return f
  }

  it("이미지·PDF: 켜도 나머지 결과는 같고, 글자를 이으면 줄 글, 상자는 줄 상자 안, 대안은 n 개 이하·내림차순", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    for (const [name, doc, base] of [["png", f.png, {}], ["pdf", f.pdf, { ocr: true }]] as const) {
      const off = await parse(doc, { ...base, ocrLines: "all" })
      const on = await parse(doc, { ...base, ocrLines: "all", ocrChars: 3 })
      assert.ok(off.success && on.success, name)
      assert.equal(JSON.stringify(off).includes("\"chars\""), false, name)
      assert.deepEqual(withoutChars(on), toWire(off), name)
      const lines = on.ocrLines![0].lines
      assert.ok(lines.length >= 2 && lines.every(l => l.chars), name)
      for (const l of lines) {
        const cs = l.chars!
        assert.equal(cs.map(c => c.text).join(""), l.text, `${name} ${l.text}`)
        const end = l.box.x + l.box.w
        for (const [i, c] of cs.entries()) {
          assert.equal([...c.text].length, 1)
          assert.ok(c.confidence > 0 && c.confidence <= 1, `${name} ${c.text} ${c.confidence}`)
          assert.ok(c.box.x >= l.box.x && c.box.x + c.box.w <= end && c.box.y === l.box.y && c.box.h === l.box.h, `${name} ${l.text} ${i} ${JSON.stringify(c.box)}`)
          assert.ok(i === 0 || cs[i - 1].box.x + cs[i - 1].box.w === c.box.x, "빈틈·겹침 없이")
          const alts = c.alternatives ?? []
          assert.ok(alts.length <= 3 && alts.every((a, k) => a.text !== c.text && a.confidence >= 0.001 && a.confidence <= c.confidence && (k === 0 || alts[k - 1].confidence >= a.confidence)), `${name} ${JSON.stringify(c)}`)
        }
      }
      // true 면 같은 글자·신뢰도에 대안만 없다
      const bare = await parse(doc, { ...base, ocrLines: "all", ocrChars: true })
      assert.ok(bare.success)
      assert.deepEqual(bare.ocrLines![0].lines.map(l => l.chars), lines.map(l => l.chars!.map(({ alternatives: _, ...c }) => c)), name)
    }
  })

  it("--ocr-chars·protocol 2 응답이 parse() 와 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-chars-"))
    try {
      const file = join(dir, "스캔 그림.png")
      writeFileSync(file, f.png)
      const want = toWire(await parse(file, { ocrLines: true, ocrChars: 2 }))
      assert.ok(want.success && want.ocrLines[0].lines[0].chars.length >= 1)
      const cli = await run([file, "--format", "json", "--silent", "--ocr-lines", "--ocr-chars", "2"])
      assert.equal(cli.code, 0)
      assert.deepEqual(JSON.parse(cli.out), want)
      const bare = await run([file, "--format", "json", "--silent", "--ocr-lines", "--ocr-chars"])
      assert.equal(bare.code, 0)
      assert.deepEqual(JSON.parse(bare.out), toWire(await parse(file, { ocrLines: true, ocrChars: true })))
      const bad = await run([file, "--format", "json", "--silent", "--ocr-lines", "--ocr-chars", "6"])
      assert.equal(bad.code, 1)
      assert.match(JSON.parse(bad.out).error, /ocrChars/)
      const worker = await run(["parse-worker", "--protocol", "2"], [
        { id: 1, cmd: "parse", file, options: { ocrLines: true, ocrChars: 2 } },
        { id: 2, cmd: "parse", file, options: { ocrChars: 2 } },
      ].map(m => JSON.stringify(m)).join("\n") + "\n")
      const res = worker.out.split("\n").filter(Boolean).map(l => JSON.parse(l))
      assert.deepEqual(res[1].result, want)
      assert.equal(res[2].error.code, "INVALID_OPTIONS")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
