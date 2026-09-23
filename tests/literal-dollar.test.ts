/**
 * v4.14.3 — IR 리터럴 `$` 규약: 원문의 `$` 는 `\$`, `$…$`·`$$…$$` 는 수식 스팬 전용 (HWPX·HWP5·HWP3).
 *
 * 둘이 같은 글자일 때 셸 변수 "echo $HOME $PATH" 가 escapeGfm 에서 수식 스팬으로 보호되고
 * 마크다운 렌더러·채점기에서 수식으로 읽혔다(rhwp HWP3 변환본 4건이 HWPX recall 게이트 미달).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { escapeGfm, escapeLiteralDollar } from "../src/table/builder.js"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { parseSection, createHwp5DocState } from "../src/hwp5/parser.js"
import { readRecords, TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CTRL_HEADER } from "../src/hwp5/record.js"
import { normForMatch, unescapeGfm, unescapeGfmCell } from "../src/roundtrip/markdown-units.js"
import { parseInlineMarkdown } from "../src/hwpx/md-runs.js"
import type { ParseWarning } from "../src/types.js"

describe("escapeLiteralDollar · escapeGfm", () => {
  it("리터럴 $ 는 \\$, 수식이 없으면 그대로", () => {
    assert.equal(escapeLiteralDollar("US$ 100"), "US\\$ 100")
    assert.equal(escapeLiteralDollar("달러 없음"), "달러 없음")
  })

  it("이스케이프된 $ 에서는 수식 스팬을 열지 않는다 — 스팬 밖이라 _ 도 이스케이프", () => {
    assert.equal(escapeGfm("echo \\$HOME \\$MY_VAR"), "echo \\$HOME \\$MY\\_VAR")
  })

  it("수식 스팬은 그대로 보호 (안의 _ 와 이스케이프된 \\$ 포함)", () => {
    assert.equal(escapeGfm("값 $x_1$ 과 \\$5"), "값 $x_1$ 과 \\$5")
    assert.equal(escapeGfm("$a \\$ b_2$"), "$a \\$ b_2$")
    assert.equal(escapeGfm("$$\\frac{a_1}{b}$$"), "$$\\frac{a_1}{b}$$")
  })
})

describe("리터럴 역슬래시 + 구두점 — CommonMark 가 이스케이프로 읽어 지우지 않게 \\\\ 로", () => {
  it("구두점 앞 역슬래시는 겹치고, 글자 앞은 그대로", () => {
    assert.equal(escapeGfm("C:\\.Pls"), "C:\\\\.Pls")
    assert.equal(escapeGfm("cd \\!*"), "cd \\\\!\\*")
    assert.equal(escapeGfm("C:\\WINDOWS\\SYSTEM"), "C:\\WINDOWS\\SYSTEM")
  })

  it("IR 이스케이프 \\$·\\| 는 건드리지 않는다 (원문 역슬래시 + 달러는 \\\\\\$)", () => {
    assert.equal(escapeGfm("US\\$ 5 \\| 6"), "US\\$ 5 \\| 6")
    assert.equal(escapeGfm("\\\\$HOME"), "\\\\\\$HOME")
  })

  it("라운드트립 역변환은 \\\\ 를 원문 역슬래시로", () => {
    assert.equal(unescapeGfm(escapeGfm("C:\\.Pls cd \\!*")), "C:\\.Pls cd \\!*")
  })
})

// ─── HWPX ────────────────────────────────────────────

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`
const para = (inner: string) => `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`

async function hwpx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("HWPX — 본문 $ 와 수식 $…$ 구분", () => {
  it("셸 변수는 \\$, 수식 개체는 $…$", async () => {
    const r = await parseHwpxDocument(await hwpx(
      para(`<hp:t>echo $HOME $PATH</hp:t>`) +
      para(`<hp:t>비율 </hp:t><hp:equation id="1" baseUnit="900"><hp:script>{1} over {2}</hp:script></hp:equation>`),
    ))
    const texts = r.blocks.filter(b => b.type === "paragraph").map(b => b.text)
    const frac = /\$\\frac\{\s*1\s*\}\s*\{\s*2\s*\}\$/ // 수식 스팬: 여닫이 $ 가 이스케이프되지 않는다
    assert.equal(texts[0], "echo \\$HOME \\$PATH")
    assert.match(texts[1] ?? "", frac)
    assert.ok(r.markdown.includes("echo \\$HOME \\$PATH"), r.markdown)
    assert.match(r.markdown, frac)
  })
})

// ─── HWP5 ────────────────────────────────────────────

function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")
/** 확장 컨트롤 문자 (16B): ch + ctrlId(on-disk 4B) + 8B + ch */
function extCtrlChar(ch: number, diskAscii: string): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt16LE(ch, 0)
  buf.write(diskAscii, 2, "ascii")
  buf.writeUInt16LE(ch, 14)
  return buf
}
/** 누름틀(%clk) CTRL_HEADER — hwp5-pair-parity.test.ts 와 같은 빌더 */
function clkCtrlData(guide: string): Buffer {
  const command = `Clickhere:set:${guide.length + 38}:Direction:wstring:${guide.length}:${guide} HelpState:wstring:0:  `
  const head = Buffer.alloc(7)
  head.writeUInt32LE(1, 0)
  head.writeUInt16LE(command.length, 5)
  return Buffer.concat([Buffer.from("klc%", "ascii"), head, utf16(command), Buffer.alloc(4)])
}
function parseHwp5(buffers: Buffer[]) {
  const warnings: ParseWarning[] = []
  return parseSection(readRecords(Buffer.concat(buffers)), null, warnings, 1, createHwp5DocState())
}

describe("HWP5 — 본문 $ 는 \\$ (필드 위치가 글자 기준이라 표지로 받았다가 마지막에 바꾼다)", () => {
  it("셸 변수", () => {
    const blocks = parseHwp5([rec(TAG_PARA_HEADER, 0, Buffer.alloc(12)), rec(TAG_PARA_TEXT, 1, utf16("echo $HOME $PATH"))])
    assert.equal(blocks[0].text, "echo \\$HOME \\$PATH")
  })

  it("$ 가 든 미기입 누름틀 안내문도 지운다 (안내문 원문과 맞대기)", () => {
    const guide = "US$ 금액"
    const blocks = parseHwp5([
      rec(TAG_PARA_HEADER, 0, Buffer.alloc(12)),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("단가 $3 "), extCtrlChar(0x03, "klc%"), utf16(guide), extCtrlChar(0x04, "klc%"), utf16(" 끝")])),
      rec(TAG_CTRL_HEADER, 1, clkCtrlData(guide)),
    ])
    assert.equal(blocks[0].text, "단가 \\$3  끝")
  })
})

// ─── 역변환 ──────────────────────────────────────────

describe("라운드트립·생성 — \\$ 를 원문 $ 로", () => {
  it("unescapeGfm·unescapeGfmCell·normForMatch", () => {
    assert.equal(unescapeGfm("echo \\$HOME"), "echo $HOME")
    assert.equal(unescapeGfmCell("US\\$ 5<br>\\$6"), "US$ 5\n$6")
    assert.equal(normForMatch("a \\$ b"), normForMatch("a $ b"))
  })

  it("마크다운 → HWPX 인라인 파싱은 \\$ 를 리터럴 $ 로", () => {
    const spans = parseInlineMarkdown("echo \\$HOME **\\$PATH**")
    assert.equal(spans.map(s => s.text).join(""), "echo $HOME $PATH")
    assert.ok(spans.some(s => s.bold && s.text === "$PATH"))
  })
})
