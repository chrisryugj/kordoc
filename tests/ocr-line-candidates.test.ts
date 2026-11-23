/**
 * OCR 줄의 읽기 후보(ocrLineCandidates) — 인식 모델(CTC)의 읽기를 확률 높은 순으로 줄마다 낸다.
 *
 * 잠근 계약:
 *  1. prefix beam search(ctcCandidates) — 같은 글이 되는 정렬을 모두 더한 확률. 모든 정렬을 세어 구한 참값과 같고(시점 셋까지, 그 뒤는 참값 이하),
 *     같은 글자 반복은 사이에 blank 가 있을 때만, n 이 읽기 수보다 크면 있는 만큼, softmax 가 아닌 출력은 정규화, 앞뒤 공백은 떼고 합친다
 *  2. 가장 유력한 정렬 하나(greedy)와 가장 확률 높은 글은 다를 수 있다
 *  3. 옵션 값 — 0~5 정수, ocrLines 와 함께. 그 밖은 parse() 실패 결과·워커 INVALID_OPTIONS
 *  4. 옵션 → 엔진 설정(tuning.lineCandidates), 줄 묶음은 후보를 그대로 싣는다. 끄면 기본 설정 객체 그대로
 *  5. 내장 OCR E2E(모델 있을 때만): 켜도 나머지 결과는 같고, 후보는 확률 내림차순·n 개 이하·합 1 이하, 깨끗한 인쇄 줄의 첫 후보는 줄 글
 *  6. CLI --ocr-line-candidates·protocol 2 응답이 parse() 와 같다
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
import { ctcCandidates } from "../src/ocr/ctc-beam.js"
import { DEFAULT_OCR_TUNING, ctcDecode } from "../src/ocr/engine.js"
import { getOcrModelStatus } from "../src/ocr/models.js"
import { validateOcrOptions } from "../src/ocr/options.js"
import { DEFAULT_BUILTIN_OCR, builtinOcrConfig, pageLines, toOcrLine } from "../src/ocr/pdf-ocr.js"
import type { ParseResult } from "../src/types.js"
import { scanFixtures } from "./fixtures/sdk-docs.js"

/** 클래스: 0 blank, 1 "가", 2 "나", 3 공백 */
const DICT = ["가", "나"]
const C = DICT.length + 2
const matrix = (rows: number[][]) => Float32Array.from(rows.flat())

/** 모든 정렬(C^T)을 세어 구한 참값 — 연속 중복을 접고 blank 를 뺀 글마다 확률을 더한다 (앞뒤 공백은 뗀다) */
function bruteForce(rows: number[][]): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (t: number, p: number, prev: number, text: string) => {
    if (t === rows.length) { const key = text.trim(); if (key) out.set(key, (out.get(key) ?? 0) + p); return }
    for (let c = 0; c < C; c++) {
      if (rows[t][c] === 0) continue
      walk(t + 1, p * rows[t][c], c, c === 0 || c === prev ? text : text + (c <= DICT.length ? DICT[c - 1] : " "))
    }
  }
  walk(0, 1, -1, "")
  return out
}
/** 결정적 난수(LCG)로 만든 확률 행렬 — 값은 rec 출력처럼 32비트 실수로 맞춘다(참값 계산과 같은 입력) */
function randomRows(T: number, seed: number): number[][] {
  let s = seed
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  return Array.from({ length: T }, () => { const v = Array.from({ length: C }, () => rnd() ** 3 + 0.01); const sum = v.reduce((a, b) => a + b, 0); return v.map(x => Math.fround(x / sum)) })
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

describe("CTC prefix beam search (ctcCandidates)", () => {
  it("같은 글이 되는 정렬을 모두 더한다 — 가·가, 가·blank, blank·가 는 모두 \"가\"", () => {
    const rows = [[0.4, 0.6, 0, 0], [0.4, 0.6, 0, 0]]
    const got = ctcCandidates(matrix(rows), 2, C, DICT, 5)
    assert.equal(got.length, 1, "두 시점으로는 \"가가\" 를 쓸 수 없다(사이에 blank 가 있어야 한다)")
    assert.equal(got[0].text, "가")
    assert.ok(near(got[0].probability, 0.36 + 0.24 + 0.24))
  })

  it("가장 유력한 정렬 하나(greedy)는 빈 글이어도, 정렬을 더하면 \"가\" 가 더 확률 높다", () => {
    const rows = [[0.6, 0.4, 0, 0], [0.6, 0.4, 0, 0]]
    assert.equal(ctcDecode(matrix(rows), 2, C, DICT), null)
    const got = ctcCandidates(matrix(rows), 2, C, DICT, 3)
    assert.deepEqual(got.map(c => c.text), ["가"])
    assert.ok(near(got[0].probability, 1 - 0.36))
  })

  it("같은 글자 반복은 사이에 blank 가 있을 때만 두 글자", () => {
    const rows = [[0.1, 0.9, 0, 0], [0.8, 0.2, 0, 0], [0.1, 0.9, 0, 0]]
    const got = ctcCandidates(matrix(rows), 3, C, DICT, 5)
    const want = bruteForce(rows)
    assert.deepEqual(got.map(c => c.text), ["가가", "가"])
    assert.ok(near(got[0].probability, 0.9 * 0.8 * 0.9), "가·blank·가 한 정렬뿐")
    for (const c of got) assert.ok(near(c.probability, want.get(c.text)!), c.text)
  })

  it("모든 정렬을 센 참값과 견준다 — 시점 셋까지는 순서·확률이 같고, 그 뒤는 빔이 버린 정렬만큼만 작다(참값을 넘지 않는다)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const T = 2 + (seed % 4)
      const rows = randomRows(T, seed)
      const truth = bruteForce(rows)
      const want = [...truth].sort((a, b) => b[1] - a[1])
      const all = ctcCandidates(matrix(rows), T, C, DICT, 1000)
      assert.equal(all[0].text, want[0][0], `seed ${seed} 1위`)
      // 시점 셋까지는 접두가 빔 폭(32)을 넘기 전에 끝나 버린 정렬이 없다
      if (T <= 3) for (let i = 0; i < Math.min(5, all.length); i++) {
        assert.equal(all[i].text, want[i][0], `seed ${seed} ${i + 1}위`)
        assert.ok(near(all[i].probability, want[i][1], 1e-9), `seed ${seed} ${i + 1}위 ${all[i].probability} ≠ ${want[i][1]}`)
      }
      for (const c of all) assert.ok(c.probability <= truth.get(c.text)! + 1e-9, `seed ${seed} ${c.text}`)
      assert.ok(all.length <= want.length && all.every((c, i) => i === 0 || all[i - 1].probability >= c.probability), "내림차순")
      assert.ok(all.reduce((s, c) => s + c.probability, 0) <= 1 + 1e-9, "합은 1 이하")
      // n 이 읽기 수보다 크면 있는 만큼, 작으면 앞에서부터
      assert.deepEqual(ctcCandidates(matrix(rows), T, C, DICT, 3), all.slice(0, 3))
    }
  })

  it("softmax 가 아닌 출력(로짓)은 시점마다 정규화한다", () => {
    const rows = randomRows(4, 7)
    const logits = rows.map(r => r.map(p => Math.log(p) + 3))
    const a = ctcCandidates(matrix(rows), 4, C, DICT, 4), b = ctcCandidates(matrix(logits), 4, C, DICT, 4)
    assert.deepEqual(b.map(c => c.text), a.map(c => c.text))
    b.forEach((c, i) => assert.ok(near(c.probability, a[i].probability, 1e-5)))
  })

  it("앞뒤 공백만 다른 읽기는 하나로 합치고, 가운데 공백은 남긴다", () => {
    // 가, (공백 또는 blank), 나 — "가 나" 와 "가나"
    const rows = [[0, 1, 0, 0], [0.5, 0, 0, 0.5], [0, 0, 1, 0], [0.5, 0, 0, 0.5]]
    const got = ctcCandidates(matrix(rows), 4, C, DICT, 5)
    assert.deepEqual(got.map(c => c.text).sort(), ["가 나", "가나"])
    for (const c of got) assert.ok(near(c.probability, 0.5), `${c.text} ${c.probability}`)
  })

  it("n 이 0 이하면 빈 목록, 시점이 많아도 확률이 0 으로 꺼지지 않는다(로그로 더한다)", () => {
    assert.deepEqual(ctcCandidates(matrix([[0.4, 0.6, 0, 0]]), 1, C, DICT, 0), [])
    const T = 2000
    const rows = Array.from({ length: T }, (_, t) => t % 2 ? [0.6, 0.4, 0, 0] : [0.4, 0, 0.6, 0])
    const got = ctcCandidates(matrix(rows), T, C, DICT, 2)
    assert.ok(got.length >= 1 && got.every(c => c.text.length > 0 && Number.isFinite(c.probability) && c.probability >= 0))
  })
})

describe("ocrLineCandidates 옵션 값", () => {
  it("0~5 정수, ocrLines 와 함께", () => {
    for (const ok of [{ ocrLineCandidates: 0 }, { ocrLines: true, ocrLineCandidates: 1 }, { ocrLines: "all", ocrLineCandidates: 5 }] as const) assert.equal(validateOcrOptions(ok), null, JSON.stringify(ok))
    for (const bad of [-1, 6, 10, 2.5, "3", true, null]) assert.match(validateOcrOptions({ ocrLines: true, ocrLineCandidates: bad as never }) ?? "", /ocrLineCandidates 는 0~5 정수/, JSON.stringify(bad))
    assert.match(validateOcrOptions({ ocrLineCandidates: 3 }) ?? "", /ocrLines 와 함께/)
    assert.match(validateOcrOptions({ ocrLines: false, ocrLineCandidates: 3 }) ?? "", /ocrLines 와 함께/)
  })

  it("parse()·워커가 문서를 읽기 전에 거부한다", async () => {
    const r = await parse(Buffer.from("%PDF-1.4\n"), { ocrLines: true, ocrLineCandidates: 6 })
    assert.match(r.success ? "" : r.error, /ocrLineCandidates/)
    for (const bad of [{ ocrLines: true, ocrLineCandidates: 6 }, { ocrLines: true, ocrLineCandidates: 1.5 }, { ocrLines: true, ocrLineCandidates: "3" }, { ocrLineCandidates: 3 }]) {
      assert.throws(() => toParseOptions(bad, "/x"), (e: unknown) => e instanceof WorkerProtocolError && e.code === "INVALID_OPTIONS", JSON.stringify(bad))
    }
    assert.deepEqual(toParseOptions({ ocrLines: true, ocrLineCandidates: 3 }, "/x"), { filePath: "/x", ocrLines: true, ocrLineCandidates: 3 })
  })

  it("CLI 플래그 → ParseOptions (숫자가 아니면 받은 글 그대로 넘겨 parse() 가 거부)", () => {
    assert.deepEqual(cliOcrEngineOptions({ ocrLines: true, ocrLineCandidates: "3" }), { ocrLines: true, ocrLineCandidates: 3 })
    assert.match(validateOcrOptions(cliOcrEngineOptions({ ocrLines: true, ocrLineCandidates: "abc" })) ?? "", /ocrLineCandidates.*"abc"/)
    assert.match(validateOcrOptions(cliOcrEngineOptions({ ocrLineCandidates: "3" })) ?? "", /ocrLines 와 함께/)
  })
})

describe("엔진 설정·줄 묶음", () => {
  it("옵션 → tuning.lineCandidates, 끄면 기본 설정 객체 그대로", () => {
    assert.equal(builtinOcrConfig({ ocrLines: true }).tuning, DEFAULT_OCR_TUNING)
    assert.equal(builtinOcrConfig({ ocrLines: true, ocrLineCandidates: 0 }).tuning, DEFAULT_OCR_TUNING)
    assert.equal(builtinOcrConfig({ ocrLineCandidates: 0 }), DEFAULT_BUILTIN_OCR)
    assert.deepEqual(builtinOcrConfig({ ocrLines: true, ocrLineCandidates: 3 }).tuning, { ...DEFAULT_OCR_TUNING, lineCandidates: 3 })
    assert.deepEqual(builtinOcrConfig({ ocrLines: "all", ocrLineCandidates: 2, ocrDetLongSide: 1280 }).tuning, { ...DEFAULT_OCR_TUNING, detLongSide: 1280, lineCandidates: 2 })
    assert.equal("lineCandidates" in DEFAULT_OCR_TUNING, false)
    assert.throws(() => builtinOcrConfig({ ocrLines: true, ocrLineCandidates: 6 }), /ocrLineCandidates/)
  })

  it("줄은 후보가 있을 때만 candidates 를 싣는다", () => {
    const item = { text: "정부 2026", x: 1, y: 2, w: 30, h: 10, confidence: 0.98 }
    assert.deepEqual(toOcrLine(item), { text: "정부 2026", box: { x: 1, y: 2, w: 30, h: 10 }, confidence: 0.98 })
    const candidates = [{ text: "정부 2026", probability: 0.81 }, { text: "정부2026", probability: 0.12 }]
    assert.deepEqual(toOcrLine({ ...item, candidates }), { text: "정부 2026", box: { x: 1, y: 2, w: 30, h: 10 }, confidence: 0.98, candidates })
    assert.deepEqual(pageLines(1, 100, 100, 3, 0, [item], [{ ...item, y: 50, candidates }]).lines.map(l => [l.dropped ?? false, l.candidates?.length ?? 0]), [[false, 0], [true, 2]])
  })
})

const withoutCandidates = (r: ParseResult) => JSON.parse(JSON.stringify(r, (k, v) => k === "candidates" ? undefined : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))
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

describe("내장 OCR E2E — 읽기 후보 (모델 있을 때만)", () => {
  async function fixtures(t: { skip(msg: string): void }) {
    if (!(await getOcrModelStatus()).every(s => s.verified)) { t.skip("OCR 모델 미설치"); return null }
    const f = await scanFixtures()
    if (!f) t.skip("sharp 미설치")
    return f
  }

  it("이미지·PDF: 켜도 나머지 결과는 같고, 후보는 확률 내림차순·n 개 이하, 깨끗한 인쇄 줄의 첫 후보는 줄 글", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    for (const [name, doc, base] of [["png", f.png, {}], ["pdf", f.pdf, { ocr: true }]] as const) {
      const off = await parse(doc, { ...base, ocrLines: "all" })
      const on = await parse(doc, { ...base, ocrLines: "all", ocrLineCandidates: 3 })
      assert.ok(off.success && on.success, name)
      assert.equal(JSON.stringify(off).includes("candidates"), false, name)
      assert.deepEqual(withoutCandidates(on), toWire(off), name)
      const lines = on.ocrLines![0].lines
      assert.ok(lines.length >= 2 && lines.every(l => l.candidates), name)
      for (const l of lines) {
        const cs = l.candidates!
        assert.ok(cs.length >= 1 && cs.length <= 3, `${name} ${l.text}`)
        assert.ok(cs.every((c, i) => c.text && c.probability > 0 && c.probability <= 1 && (i === 0 || cs[i - 1].probability >= c.probability)), `${name} ${JSON.stringify(cs)}`)
        assert.ok(cs.reduce((s, c) => s + c.probability, 0) <= 1 + 1e-9)
        assert.equal(new Set(cs.map(c => c.text)).size, cs.length, "서로 다른 읽기")
        assert.equal(cs[0].text.replace(/\s/g, ""), l.text.replace(/\s/g, ""), `${name} 첫 후보 = 줄 글`)
      }
      // n 을 줄이면 앞에서부터 같은 후보
      const one = await parse(doc, { ...base, ocrLines: "all", ocrLineCandidates: 1 })
      assert.ok(one.success)
      assert.deepEqual(one.ocrLines![0].lines.map(l => l.candidates), lines.map(l => l.candidates!.slice(0, 1)), name)
    }
  })

  it("--ocr-line-candidates·protocol 2 응답이 parse() 와 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-candidates-"))
    try {
      const file = join(dir, "스캔 그림.png")
      writeFileSync(file, f.png)
      const want = toWire(await parse(file, { ocrLines: true, ocrLineCandidates: 2 }))
      assert.ok(want.success && want.ocrLines[0].lines[0].candidates.length >= 1)
      const cli = await run([file, "--format", "json", "--silent", "--ocr-lines", "--ocr-line-candidates", "2"])
      assert.equal(cli.code, 0)
      assert.deepEqual(JSON.parse(cli.out), want)
      const bad = await run([file, "--format", "json", "--silent", "--ocr-lines", "--ocr-line-candidates", "6"])
      assert.equal(bad.code, 1)
      assert.match(JSON.parse(bad.out).error, /ocrLineCandidates/)
      const worker = await run(["parse-worker", "--protocol", "2"], [
        { id: 1, cmd: "parse", file, options: { ocrLines: true, ocrLineCandidates: 2 } },
        { id: 2, cmd: "parse", file, options: { ocrLineCandidates: 2 } },
      ].map(m => JSON.stringify(m)).join("\n") + "\n")
      const res = worker.out.split("\n").filter(Boolean).map(l => JSON.parse(l))
      assert.deepEqual(res[1].result, want)
      assert.equal(res[2].error.code, "INVALID_OPTIONS")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
