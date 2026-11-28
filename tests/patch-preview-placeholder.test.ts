/** patch·generate 회귀: 괄호 자리표시 빈칸(#247), 미리보기 글 갱신(#248), 본문 문단 <br>(#250) */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { patchHwpx } from "../src/roundtrip/patcher.js"
import { alignedTextEdits } from "../src/roundtrip/inline-edit.js"
import { previewTextFromBlocks } from "../src/roundtrip/preview-text.js"

const BASE = `# 재현 서식

| 항목 | 내용 |
|---|---|
| 유형 | [ ] 가 유형<br>[∨] 기타 ( ) |
| 경과 | 첫째 줄<br>둘째 줄<br>셋째 줄 |

본문 문단입니다.
`

/** generate 결과의 "( )" 를 공백 27칸 괄호로 바꾼 서식 (이슈 #247 재현 파일) */
async function reproHwpx(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await markdownToHwpx(BASE, { gongmun: { preset: "report" } } as never))
  const xml = await zip.file("Contents/section0.xml")!.async("string")
  assert.ok(xml.includes("[∨] 기타 ( )"), "생성본에 괄호 자리표시가 있어야 한다")
  zip.file("Contents/section0.xml", xml.replace("[∨] 기타 ( )", "[∨] 기타 (" + " ".repeat(27) + ")"))
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
}
const sectionOf = async (b: Uint8Array) => (await JSZip.loadAsync(b)).file("Contents/section0.xml")!.async("string")

describe("괄호 자리표시 빈칸 (#247)", () => {
  it("공백뿐인 괄호 안에 넣은 값은 공백 줄을 한 칸만 남기고 바꾼다 — 앞·뒤 어느 쪽에 붙은 삽입이든", () => {
    const raw = "[∨] 기타 (" + " ".repeat(27) + ")"
    for (const e of [alignedTextEdits(raw, "[∨] 기타 ( )", "[∨] 기타 ( 값 )")!]) {
      const out = [...e].sort((a, b) => b.start - a.start).reduce((t, x) => t.slice(0, x.start) + x.text + t.slice(x.end), raw)
      assert.equal(out, "[∨] 기타 ( 값 )")
    }
    // 괄호 자리표시가 아닌 공백 줄(균등 띄어쓰기 등)은 종전대로 둔다
    const spaced = "대" + " ".repeat(4) + "상"
    const e2 = alignedTextEdits(spaced, "대 상", "대 상자")!
    const out2 = e2.reduce((t, x) => t.slice(0, x.start) + x.text + t.slice(x.end), spaced)
    assert.equal(out2, "대    상자")
  })

  it("patch 결과 글에 공백 27칸이 남지 않는다", async () => {
    const hwpx = await reproHwpx()
    const md = (await parseHwpxDocument(hwpx.buffer.slice(0) as ArrayBuffer, { layoutTables: "keep" })).markdown
    assert.match(md, /기타 \( \)/)
    const r = await patchHwpx(hwpx, md.replace("기타 ( )", "기타 ( 값 )"))
    assert.equal(r.applied, 1)
    assert.match(await sectionOf(r.data!), /\[∨\] 기타 \( 값 \)/)
  })
})

describe("미리보기 글 (#248)", () => {
  it("patch 가 고친 본문으로 Preview/PrvText.txt 를 다시 쓴다 — 지운 줄이 남지 않음", async () => {
    const hwpx = await reproHwpx()
    const md = (await parseHwpxDocument(hwpx.buffer.slice(0) as ArrayBuffer, { layoutTables: "keep" })).markdown
    const r = await patchHwpx(hwpx, md.replace("첫째 줄<br>둘째 줄<br>셋째 줄", "첫째 줄<br>셋째 줄"))
    assert.ok(r.success)
    const prv = await (await JSZip.loadAsync(r.data!)).file("Preview/PrvText.txt")!.async("string")
    assert.match(prv, /첫째 줄 셋째 줄/)
    assert.doesNotMatch(prv, /둘째 줄/)
  })

  it("한글 꼴: 문단은 한 줄, 표는 행마다 칸 글을 <…> 로", () => {
    const t = previewTextFromBlocks([
      { type: "heading", level: 1, text: "제목" },
      { type: "table", table: { rows: 1, cols: 2, hasHeader: false, cells: [[{ text: "가", colSpan: 1, rowSpan: 1 }, { text: "나\n다", colSpan: 1, rowSpan: 1 }]] } },
      { type: "paragraph", text: "본문 <sup>1</sup>" },
    ])
    assert.equal(t, "제목\r\n<가><나 다>\r\n본문 1")
  })
})

describe("generate 본문 문단 <br> (#250)", () => {
  it("본문 문단의 <br> 은 hp:lineBreak, 코드 span 안은 글자 그대로, 미리보기 글엔 줄바꿈", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("# 시험\n\n첫째 줄<br>둘째 줄\n\n코드 `a<br>b` 그대로\n"))
    const xml = await zip.file("Contents/section0.xml")!.async("string")
    assert.match(xml, /첫째 줄<hp:lineBreak\/>둘째 줄/)
    assert.doesNotMatch(xml, /첫째 줄&lt;br/)
    assert.match(xml, /a&lt;br&gt;b/)
    const prv = await zip.file("Preview/PrvText.txt")!.async("string")
    assert.match(prv, /첫째 줄\n둘째 줄/)
    assert.match(prv, /`a<br>b`/)
  })
})
