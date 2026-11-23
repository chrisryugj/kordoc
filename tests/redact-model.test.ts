/**
 * redact 학습 모델(opt-in, redact-model.ts) — 모델 파일 없이 도는 부분만 본다: WordPiece 오프셋(파이썬 tokenizers 대조
 * 픽스처), BIOES 해독, 가짜 세션으로 창 나누기·임계값·UTF-16 오프셋, 모델 스팬의 서식 보존 마스킹(성·시·군·구 남김),
 * 룰 엔진과의 우선순위(번호형 먼저)·룰 꺼짐, 마크다운 줄·표지 좌표, 문서 단위(리터럴 전파·잔존 0).
 * 실제 모델 정확도는 bench/redact-bench.mjs --model 로 잰다.
 * ※ 이름은 관용 예시명·흔한 합성 이름, 주소는 공공청사이거나 번지를 지어낸 합성 값
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import JSZip from "jszip"
import { redactText, redactMarkdown, type RedactRule } from "../src/redact.js"
import { redactDocument } from "../src/redact-doc.js"
import { markdownToHwpx } from "../src/index.js"
import {
  PII_MODEL_LABELS, createPiiModel, createWordPiece, decodeBioes,
  type ModelSpan, type PiiModel, type PiiOrt, type PiiSession, type TokenizerJson,
} from "../src/redact-model.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/pii-wordpiece-parity.json", import.meta.url), "utf8")) as {
  tokenizer: TokenizerJson
  cases: Array<{ text: string; ids: number[]; offsets: Array<[number, number]> }>
}

const TEXT: RedactRule[] = ["rrn", "phone", "email", "name", "address"]
/** 문자열에서 값 자리를 찾아 모델 스팬을 만든다 (가짜 모델) */
const span = (text: string, value: string, rule: ModelSpan["rule"], from = 0): ModelSpan => {
  const index = text.indexOf(value, from)
  assert.ok(index >= 0, `${value} 가 없음`)
  return { rule, index, length: value.length, score: 0.99 }
}

describe("WordPiece — 파이썬 tokenizers 와 같은 id·오프셋", () => {
  const tok = createWordPiece(fixture.tokenizer)
  for (const c of fixture.cases) {
    const nfc = c.text.normalize("NFC") === c.text
    it(`${nfc ? "id·오프셋" : "id (NFD — 음절이 자모 전체를 덮는다)"}: ${JSON.stringify(c.text).slice(0, 32)}`, () => {
      const got = tok.encode(c.text)
      assert.deepEqual(got.ids, c.ids)
      if (nfc) assert.deepEqual(got.offsets, c.offsets)
      else got.offsets.forEach(([s, e], k) => { assert.equal(s, c.offsets[k][0]); assert.ok(e >= c.offsets[k][1]) })
    })
  }
  it("템플릿 토큰 <s>·</s> 를 읽고, 모르는 토크나이저는 거부한다", () => {
    assert.equal(tok.bos, 0)
    assert.equal(tok.eos, 1)
    assert.throws(() => createWordPiece({ ...fixture.tokenizer, model: { ...fixture.tokenizer.model, type: "BPE" } }), /토크나이저 모델/)
    assert.throws(() => createWordPiece({ ...fixture.tokenizer, normalizer: { type: "NFKC" } }), /정규화/)
  })
})

describe("decodeBioes — 완결된 열만, 점수는 최소 확률", () => {
  const off = (n: number): Array<[number, number]> => Array.from({ length: n }, (_, k) => [k, k + 1])
  it("B E · 끝 없는 B I · S · 홀로 E", () => {
    assert.deepEqual(decodeBioes([1, 3, 5, 6, 4, 7], [0.9, 0.6, 0.9, 0.9, 0.8, 0.9], off(6), PII_MODEL_LABELS), [
      [0, 2, "private_person", 0.6],
      [4, 5, "private_person", 0.8],
    ])
  })
  it("그룹이 바뀌면 끊는다", () => {
    assert.deepEqual(decodeBioes([1, 7], [0.9, 0.9], off(2), PII_MODEL_LABELS), [])
  })
})

/** 가짜 런타임 — 토큰 id → 라벨 번호 표로 logits 를 만든다 */
function fakeModel(tagOf: Record<number, number>, prob = 0.9, extra?: { maxTokens?: number; overlapTokens?: number; threshold?: number }) {
  const calls: number[][] = []
  class Tensor { constructor(readonly type: string, readonly data: BigInt64Array, readonly dims: number[]) {} }
  const L = PII_MODEL_LABELS.length
  const session: PiiSession = {
    async run(feeds) {
      const ids = Array.from((feeds.input_ids as Tensor).data, Number)
      calls.push(ids)
      const data = new Float32Array(ids.length * L)
      const rest = Math.log((1 - prob) / (L - 1))
      ids.forEach((id, k) => {
        const tag = tagOf[id] ?? 0
        for (let j = 0; j < L; j++) data[k * L + j] = j === tag ? Math.log(prob) : rest
      })
      return { logits: { data, dims: [1, ids.length, L] } }
    },
  }
  const model = createPiiModel({
    ort: { Tensor } as unknown as PiiOrt, session, tokenizer: fixture.tokenizer, threshold: extra?.threshold ?? 0.5,
    maxTokens: extra?.maxTokens, overlapTokens: extra?.overlapTokens,
  })
  return { model, calls }
}
const vocab = fixture.tokenizer.model.vocab
// 김 ##민 ##수 → 인명, 서울 ##특별시 → 주소
const TAGS = { [vocab["김"]]: 1, [vocab["##민"]]: 2, [vocab["##수"]]: 3, [vocab["서울"]]: 5, [vocab["##특별시"]]: 7 }

describe("createPiiModel — 가짜 세션", () => {
  it("UTF-16 오프셋 (앞에 이모지)", async () => {
    const { model } = fakeModel(TAGS)
    const text = "😀 김민수 서울특별시"
    const got = await model.detect(text)
    assert.deepEqual(got.map((s) => [s.rule, text.slice(s.index, s.index + s.length)]), [["name", "김민수"], ["address", "서울특별시"]])
  })
  it("임계값 미만은 버린다", async () => {
    const { model } = fakeModel(TAGS, 0.6, { threshold: 0.7 })
    assert.deepEqual(await model.detect("김민수"), [])
  })
  it("긴 글은 창으로 나누고, 겹친 창에서 두 번 나온 스팬은 하나만", async () => {
    const { model, calls } = fakeModel(TAGS, 0.9, { maxTokens: 8, overlapTokens: 3 })
    const text = "피고 원고 피고 원고 김민수 피고 원고 피고"
    const got = await model.detect(text)
    assert.ok(calls.length > 1)
    for (const ids of calls) { assert.ok(ids.length <= 8); assert.equal(ids[0], 0); assert.equal(ids.at(-1), 1) }
    assert.deepEqual(got.map((s) => text.slice(s.index, s.index + s.length)), ["김민수"])
  })
  it("빈 글·공백은 세션을 부르지 않는다", async () => {
    const { model, calls } = fakeModel(TAGS)
    assert.deepEqual(await model.detect(""), [])
    assert.deepEqual(await model.detect("   "), [])
    assert.equal(calls.length, 0)
  })
})

describe("modelSpans — 룰 엔진과 같은 서식 보존 마스킹", () => {
  it("인명은 성을 남기고, 주소는 시·도·시·군·구를 남긴다 — 길이 그대로", () => {
    const s = "피고 김민수의 주소는 서울특별시 강남구 테헤란로 521이다."
    const r = redactText(s, { rules: TEXT, modelSpans: [span(s, "김민수", "name"), span(s, "서울특별시 강남구 테헤란로 521", "address")] })
    assert.equal(r.text, "피고 김●●의 주소는 서울특별시 강남구 ●●●● ●●●이다.")
    assert.equal(r.text.length, s.length)
  })
  it("사전 룰이 일부러 놓치는 모양 — 맨 이름·띄어 쓴 이름·가린 이름·동만 있는 주소", () => {
    const s = "이수아는 정 하 늘, 강○희, 최민*과 함께 백현동 542-1 에 갔다."
    assert.deepEqual(redactText(s, { rules: TEXT }).hits, [], "사전 룰만으로는 0건이어야 비교가 된다")
    const spans = [span(s, "이수아", "name"), span(s, "정 하 늘", "name"), span(s, "강○희", "name"), span(s, "최민*", "name"), span(s, "백현동 542-1", "address")]
    assert.equal(redactText(s, { rules: TEXT, modelSpans: spans }).text, "이●●는 정 ● ●, 강○●, 최●*과 함께 ●●● ●●●-● 에 갔다.")
  })
  it("공백 뺀 두 글자 이하 인명은 다 가린다 — 성 없는 이름(\"지훈이랑\")의 첫 글자를 남기지 않게", () => {
    const s = "어제 지훈이랑 민지 만났다."
    assert.equal(redactText(s, { rules: TEXT, modelSpans: [span(s, "지훈", "name"), span(s, "민지", "name")] }).text, "어제 ●●이랑 ●● 만났다.")
  })
  it("겹성은 두 글자를 남긴다", () => {
    const s = "신청인 남궁민수"
    assert.equal(redactText(s, { rules: TEXT, modelSpans: [span(s, "남궁민수", "name")] }).text, "신청인 남궁●●")
  })
  it("가릴 글자가 없는 스팬(이미 가린 이름)은 히트로 남기지 않는다 — 리터럴·잔존 검사에 걸리지 않게", () => {
    const s = "원고 이○○은 피고 최민*에게"
    const r = redactText(s, { rules: TEXT, modelSpans: [span(s, "이○○", "name"), span(s, "최민*", "name")] })
    assert.deepEqual(r.hits.map((h) => h.masked), ["최●*"])
  })
  it("번지가 0 뿐인 자리표시자 주소는 모델이 찾아도 버린다", () => {
    const s = "주소: 서울특별시 광진구 자양로 000"
    assert.deepEqual(redactText(s, { rules: TEXT, modelSpans: [span(s, "서울특별시 광진구 자양로 000", "address")] }).hits, [])
  })
  it("번호형 룰이 먼저 — 전화와 겹친 모델 스팬은 버리고, 룰이 꺼져 있으면 모델 스팬도 안 쓴다", () => {
    const s = "연락처 010-2345-6789 김민수"
    const spans = [span(s, "010-2345-6789", "address"), span(s, "김민수", "name")]
    assert.deepEqual(redactText(s, { rules: TEXT, modelSpans: spans }).hits.map((h) => h.rule), ["phone", "name"])
    assert.deepEqual(redactText(s, { rules: ["phone"], modelSpans: spans }).hits.map((h) => h.rule), ["phone"])
  })
  it("사전 룰은 남은 자리에서 그대로 돈다 (합집합)", () => {
    const s = "성명: 홍길동, 이수아는 참고인이다."
    const r = redactText(s, { rules: TEXT, modelSpans: [span(s, "이수아", "name")] })
    assert.deepEqual(r.hits.map((h) => s.slice(h.index, h.index + h.length)), ["홍길동", "이수아"])
  })
  it("마크다운 — 문서 오프셋 스팬을 줄·인라인 표지 좌표로 옮긴다", () => {
    const md = "# 제목\n\n원고 **이수아**는 피고 김민수에게\n\n| 성명 | 주소 |\n| --- | --- |\n| 정 하 늘 | 부산광역시 해운대구 우동 1408 |"
    const spans = [span(md, "이수아", "name"), span(md, "김민수", "name"), span(md, "정 하 늘", "name"), span(md, "부산광역시 해운대구 우동 1408", "address")]
    const r = redactMarkdown(md, { rules: TEXT, modelSpans: spans })
    assert.ok(r.text.includes("원고 **이●●**는 피고 김●●에게"), r.text)
    assert.ok(r.text.includes("| 정 ● ● | 부산광역시 해운대구 ●● ●●●● |"), r.text)
    assert.equal(r.text.length, md.length)
    for (const h of r.hits) assert.equal(h.masked.length, h.length)
  })
})

describe("redactDocument — model 옵션", () => {
  /** 넘겨받은 글에서 이름 목록을 찾아 스팬으로 돌려주는 가짜 모델 */
  const fakeDocModel = (names: string[]): PiiModel => ({
    variant: "custom",
    async detect(text) {
      const out: ModelSpan[] = []
      for (const n of names) for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) out.push({ rule: "name", index: i, length: n.length, score: 0.99 })
      return out.sort((a, b) => a.index - b.index)
    },
    async release() {},
  })

  it("HWPX — 모델이 찾은 맨 이름을 파일 문단에서 가리고, 같은 이름이 다시 나와도 리터럴로 가린다 (잔존 0)", async () => {
    const doc = await markdownToHwpx("이수아는 거래처 대표에게 연락했다.\n\n회의록 작성: 이수아")
    const plain = await redactDocument(doc, { rules: ["name"] })
    assert.equal(plain.changed, false, "사전 룰만으로는 이 맨 이름을 가리지 않는다")
    const res = await redactDocument(doc, { model: fakeDocModel(["이수아"]) })
    assert.deepEqual(res.residual, [])
    assert.deepEqual(res.unscanned, [])
    const xml = await (await JSZip.loadAsync(res.data!)).file("Contents/section0.xml")!.async("text")
    assert.ok(!xml.includes("이수아") && xml.includes("이●●"), "본문 두 곳 모두 가려져야 함")
    assert.ok(res.markdownHits.every((h) => h.rule === "name"))
  })
  it("model 을 켜면 rules 에 name·address 가 없어도 더한다", async () => {
    const doc = await markdownToHwpx("담당: 이수아 (010-2345-6789)")
    const res = await redactDocument(doc, { rules: ["phone"], model: fakeDocModel(["이수아"]) })
    assert.deepEqual(res.markdownHits.map((h) => h.rule).sort(), ["name", "phone"])
  })
})
