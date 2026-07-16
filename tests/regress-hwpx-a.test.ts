/**
 * HWPX 계열 결함 회귀 테스트 (담당 A) — 결함별 잠금.
 *
 * 1  P0 containsInlineMath ReDoS (builder.ts)
 * 2  P0 HTML 표 span 무클램프 + 속성 따옴표 형태 (markdown-units/gen-table)
 * 3  P1 md-runs 구분행 판정 대시 1개 오매치 (`| - | - |` 데이터 행 소실)
 * 4  P1 md-runs 나이브 파이프 분할 (`\|` 셀 왕복 붕괴)
 * 5  P1 alt-text 정규식 무앵커 오삭제 (builder/section-walker/markdown-units)
 * 6  P1 닫히지 않은 <table>이 EOF까지 삼킴 (md-runs)
 * 7  P2 멀티섹션에서 한 섹션 XML fatalError가 전체 실패 (ZipBombError 분리)
 * 8  P2 escapeGfm `_`·백틱 미이스케이프
 * 9  P2 문단 내부 재귀 깊이 가드 (extractTextFromNode/extractParagraphInfo.walk)
 * 10 P3 `─{10,}` separator 복원이 외래 문서에도 발동
 * 11 P3 drawText 경로 resolveParaHeading이 빈 문단 카운터 미소비
 * 12 P3 start="0" numbering 미사용 오판
 * 13 P3 images.ts replace 교체 문자열 `$` 확장
 * 14 P3 text-metrics astral 문자 서로게이트 분해 (폭 2배)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"

import { blocksToMarkdown, MAX_COLS, MAX_ROWS } from "../src/table/builder.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { parseHtmlTable, sanitizeText, escapeGfm, unescapeGfmCell } from "../src/roundtrip/markdown-units.js"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { extractTextFromNode, ZipBombError } from "../src/hwpx/parser-shared.js"
import { KordocError } from "../src/utils.js"
import { simulateWrap, measureTextWidth } from "../src/hwpx/text-metrics.js"
import { extractImagesFromZip } from "../src/hwpx/images.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

// ─── 픽스처 헬퍼 (hwpx-v3.test.ts 컨벤션) ─────────────

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function sec(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`
}

function para(text: string, attrs = ""): string {
  const prAttr = attrs.includes("paraPrIDRef") ? "" : `paraPrIDRef="0"`
  return `<hp:p id="0" ${prAttr} ${attrs}><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`
}

async function makeHwpx(sectionXml: string, opts: { headerXml?: string; extraFiles?: Record<string, string> } = {}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  if (opts.headerXml) zip.file("Contents/header.xml", opts.headerXml)
  zip.file("Contents/section0.xml", sectionXml)
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) zip.file(name, content)
  return await zip.generateAsync({ type: "arraybuffer" })
}

/** NUMBER 자동번호 헤더 — paraPr id=10이 numbering id=1 level1을 참조 */
function numberingHeader(start: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">
 <hh:refList>
  <hh:numberings itemCnt="1">
   <hh:numbering id="1" start="${start}">
    <hh:paraHead start="${start}" level="1" numFormat="DIGIT">^1.</hh:paraHead>
   </hh:numbering>
  </hh:numberings>
 </hh:refList>
 <hh:paraProperties>
  <hh:paraPr id="10"><hh:heading type="NUMBER" idRef="1" level="0"/></hh:paraPr>
 </hh:paraProperties>
</hh:head>`
}

function mergedTableBlock(cellText: string): IRBlock {
  const cell = (text: string, colSpan = 1): IRCell => ({ text, colSpan, rowSpan: 1 })
  const table: IRTable = {
    rows: 2, cols: 2, hasHeader: true,
    cells: [
      [cell(cellText, 2), cell("", 1)],
      [cell("가", 1), cell("나", 1)],
    ],
  }
  return { type: "table", table }
}

// ─── 1. P0 ReDoS ──────────────────────────────────────

describe("regress-a 1: containsInlineMath ReDoS", () => {
  it('"$"+백슬래시 60개 입력이 100ms 내 반환된다', () => {
    const payload = "$" + "\\".repeat(60)
    const t0 = performance.now()
    const md = blocksToMarkdown([mergedTableBlock(payload)])
    const elapsed = performance.now() - t0
    assert.ok(elapsed < 100, `blocksToMarkdown ${elapsed.toFixed(0)}ms — ReDoS 재발`)
    assert.ok(md.length > 0)
  })

  it("정상 인라인 수식 표는 여전히 GFM 경로(수식 보존)로 간다", () => {
    const md = blocksToMarkdown([mergedTableBlock("에너지 $E=mc^2$ 공식")])
    assert.ok(!md.includes("<table>"), "인라인 수식 병합 표는 HTML 표로 강등되지 않아야 한다")
  })
})

// ─── 2. P0 span 무클램프 + 속성 따옴표 ────────────────

describe("regress-a 2: HTML 표 span 클램프·따옴표 형태", () => {
  it("colspan/rowspan이 파서 한도(MAX_COLS/MAX_ROWS)로 클램핑된다", () => {
    const rows = parseHtmlTable(`<table><tr><td colspan="999999" rowspan="999999">a</td></tr></table>`)
    assert.ok(rows)
    assert.equal(rows![0].cells[0].colSpan, MAX_COLS)
    assert.equal(rows![0].cells[0].rowSpan, MAX_ROWS)
  })

  it("작은따옴표·무따옴표 colspan도 인식한다", () => {
    const single = parseHtmlTable(`<table><tr><td colspan='3'>a</td></tr></table>`)
    assert.equal(single![0].cells[0].colSpan, 3)
    const bare = parseHtmlTable(`<table><tr><td colspan=4 rowspan=2>a</td></tr></table>`)
    assert.equal(bare![0].cells[0].colSpan, 4)
    assert.equal(bare![0].cells[0].rowSpan, 2)
  })
})

// ─── 3. P1 구분행 대시 1개 오매치 ─────────────────────

describe("regress-a 3: md-runs 구분행 판정", () => {
  it("`| - | - |` 데이터 행('해당없음' 표기)이 소실되지 않는다", () => {
    const blocks = parseMarkdownToBlocks("| 항목 | 값 |\n| --- | --- |\n| - | - |")
    const table = blocks.find(b => b.type === "table")
    assert.ok(table?.rows)
    assert.equal(table!.rows!.length, 2, "헤더 + 데이터 행 2개")
    assert.deepEqual(table!.rows![1], ["-", "-"])
  })

  it("`---` 구분행은 여전히 스킵된다 (정렬 콜론 포함)", () => {
    const blocks = parseMarkdownToBlocks("| a | b |\n| :--- | ---: |\n| 1 | 2 |")
    const table = blocks.find(b => b.type === "table")
    assert.equal(table!.rows!.length, 2)
  })
})

// ─── 4. P1 이스케이프 파이프 분할 ─────────────────────

describe("regress-a 4: md-runs \\| 셀 분할", () => {
  it("셀 안 \\| 가 열 분할되지 않고 | 로 복원된다", () => {
    const blocks = parseMarkdownToBlocks("| a\\|b | c |\n| --- | --- |\n| 1 | 2 |")
    const table = blocks.find(b => b.type === "table")
    assert.equal(table!.rows![0].length, 2, "\\| 는 열 구분자가 아니다")
    assert.equal(table!.rows![0][0], "a|b")
  })
})

// ─── 5. P1 alt-text 무앵커 오삭제 ─────────────────────

describe("regress-a 5: HWP 도형 alt-text 앵커링", () => {
  it("본문 중간의 '표 입니다.'는 삭제되지 않는다 (sanitizeText)", () => {
    assert.equal(sanitizeText("붙임 문서는 표 입니다. 참고하세요"), "붙임 문서는 표 입니다. 참고하세요")
  })

  it("문단 전체가 alt-text면 여전히 제거된다 (sanitizeText)", () => {
    assert.equal(sanitizeText("사각형입니다."), "")
    assert.equal(sanitizeText("모서리가 둥근 직사각형입니다."), "")
  })

  it("HWPX 파싱 경로에서도 본문 중간 문장이 보존된다 (section-walker)", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("붙임 문서는 표 입니다. 참고하세요"))))
    assert.ok(result.markdown.includes("붙임 문서는 표 입니다. 참고하세요"), "본문 중간 '표 입니다.'가 삭제됨")
  })

  it("HWPX 파싱 경로에서 단독 alt-text 문단은 여전히 제거된다", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("사각형입니다.") + para("실제 본문"))))
    assert.ok(!result.markdown.includes("사각형입니다"))
    assert.ok(result.markdown.includes("실제 본문"))
  })
})

// ─── 6. P1 닫히지 않은 <table> EOF 삼킴 ───────────────

describe("regress-a 6: md-runs 미종결 <table> 폴백", () => {
  it("닫는 </table> 없는 표가 문서 잔여를 삼키지 않는다", () => {
    const blocks = parseMarkdownToBlocks("<table><tr><td>a</td></tr>\n\n뒤따르는 본문 문단\n\n# 뒤따르는 헤딩")
    assert.ok(!blocks.some(b => b.type === "html_table"), "미종결 표는 html_table이 아니다")
    assert.ok(blocks.some(b => b.type === "paragraph" && b.text?.includes("뒤따르는 본문 문단")))
    assert.ok(blocks.some(b => b.type === "heading" && b.text === "뒤따르는 헤딩"))
  })

  it("짝이 맞는 <table>은 종전대로 html_table 블록", () => {
    const blocks = parseMarkdownToBlocks("<table><tr><td>a</td></tr></table>\n\n본문")
    assert.equal(blocks.filter(b => b.type === "html_table").length, 1)
    assert.ok(blocks.some(b => b.type === "paragraph" && b.text === "본문"))
  })
})

// ─── 7. P2 섹션 fatalError vs ZIP bomb 가드 ───────────

describe("regress-a 7: 멀티섹션 부분 실패 강등", () => {
  it("한 섹션 XML 손상은 PARTIAL_PARSE 경고로 강등되고 나머지는 살아남는다", async () => {
    const zip = new JSZip()
    zip.file("mimetype", "application/hwp+zip")
    zip.file("Contents/section0.xml", sec(para("첫 섹션 본문")))
    zip.file("Contents/section1.xml", "<<<이것은 XML이 아님")
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const result = await parseHwpxDocument(buffer)
    assert.ok(result.markdown.includes("첫 섹션 본문"), "정상 섹션 파싱 유지")
    assert.ok(result.warnings?.some(w => w.code === "PARTIAL_PARSE" && w.page === 2), "손상 섹션은 PARTIAL_PARSE 경고")
  })

  it("ZipBombError는 KordocError 서브클래스 (sanitizeError allowlist 통과)", () => {
    const err = new ZipBombError("테스트")
    assert.ok(err instanceof KordocError)
    assert.ok(err instanceof ZipBombError)
  })
})

// ─── 8. P2 escapeGfm _ ` ────────────────────────────

describe("regress-a 8: escapeGfm 언더스코어·백틱", () => {
  it("blocksToMarkdown 문단의 _ 와 ` 가 이스케이프된다", () => {
    const md = blocksToMarkdown([{ type: "paragraph", text: "snake_case와 `tick` 문자" }])
    assert.ok(md.includes("snake\\_case"), "_ 이스케이프")
    assert.ok(md.includes("\\`tick\\`"), "` 이스케이프")
  })

  it("markdown-units 쌍둥이 escapeGfm/unescapeGfmCell 왕복", () => {
    const src = "a_b `c` ~d~ *e*"
    assert.equal(unescapeGfmCell(escapeGfm(src)), src)
  })

  it("이미지 참조·링크 URL 속 _ 는 이스케이프하지 않는다 (문법 보호)", () => {
    assert.equal(escapeGfm("![image](image_001.png)"), "![image](image_001.png)")
    const md = blocksToMarkdown([{ type: "paragraph", text: "목차항목", href: "#_Toc123" }])
    assert.ok(md.includes("[목차항목](#_Toc123)"), md)
  })
})

// ─── 9. P2 문단 내부 재귀 깊이 가드 ───────────────────

describe("regress-a 9: 재귀 깊이 가드", () => {
  it("extractTextFromNode가 초심층 DOM에서 스택 오버플로 없이 반환된다", () => {
    const doc = new DOMParser().parseFromString("<root/>", "text/xml")
    let cur = doc.documentElement!
    for (let i = 0; i < 30000; i++) {
      const el = doc.createElement("x")
      cur.appendChild(el)
      cur = el
    }
    cur.appendChild(doc.createTextNode("깊은 텍스트"))
    assert.doesNotThrow(() => extractTextFromNode(doc.documentElement! as unknown as Node))
  })

  it("문단 내부 walk도 MAX_XML_DEPTH를 넘는 텍스트를 안전하게 차단한다", async () => {
    // <hp:t>를 미지 태그 300겹 안에 중첩 — 가드(200) 초과분은 드롭되어야 한다
    const open = "<hp:x>".repeat(300)
    const close = "</hp:x>".repeat(300)
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${open}<hp:t>초심층텍스트</hp:t>${close}</hp:run></hp:p>` + para("정상 문단")
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.ok(!result.markdown.includes("초심층텍스트"), "깊이 가드 초과 텍스트는 차단")
    assert.ok(result.markdown.includes("정상 문단"))
  })
})

// ─── 10. P3 separator 복원 게이트 ─────────────────────

const KORDOC_HPF = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/">
 <opf:metadata>
  <opf:meta name="generator" content="kordoc"/>
  <opf:meta name="kordoc-layout" content="default"/>
 </opf:metadata>
</opf:package>`

describe("regress-a 10: ─ separator 복원 게이트", () => {
  it("외래 문서(kordocLayout 없음)의 ─ 연속 문단은 separator로 둔갑하지 않는다", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("─".repeat(12)))))
    assert.ok(!result.blocks.some(b => b.type === "separator"))
    assert.ok(result.blocks.some(b => b.type === "paragraph" && /^─+$/.test(b.text ?? "")))
  })

  it("kordocLayout 채널 있는 자사 문서는 종전대로 separator 복원", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("─".repeat(12))), { extraFiles: { "Contents/content.hpf": KORDOC_HPF } }))
    assert.ok(result.blocks.some(b => b.type === "separator"))
  })
})

// ─── 11. P3 drawText 빈 번호 문단 카운터 소비 ─────────

describe("regress-a 11: drawText resolveParaHeading 통일", () => {
  it("글상자 안 빈 번호 문단도 카운터를 소비한다 (본문 경로와 동일)", async () => {
    const inner =
      `<hp:p paraPrIDRef="10"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>` +
      `<hp:p paraPrIDRef="10"><hp:run charPrIDRef="0"><hp:t>둘째 항목</hp:t></hp:run></hp:p>`
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:rect><hp:drawText><hp:subList>${inner}</hp:subList></hp:drawText></hp:rect></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: numberingHeader(1) }))
    const item = result.blocks.find(b => b.text?.includes("둘째 항목"))
    assert.ok(item)
    assert.equal(item!.text, "2. 둘째 항목", "빈 번호 문단이 1을 소비해 다음이 2")
  })
})

// ─── 12. P3 start="0" numbering ───────────────────────

describe('regress-a 12: start="0" numbering', () => {
  it("start=0 자동번호가 0., 1. 로 증가한다 (미사용 오판 없음)", async () => {
    const body = para("첫 항목", `paraPrIDRef="10"`) + para("둘째 항목", `paraPrIDRef="10"`)
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: numberingHeader(0) }))
    const texts = result.blocks.map(b => b.text)
    assert.ok(texts.includes("0. 첫 항목"), `start=0 초기값: ${texts.join(" / ")}`)
    assert.ok(texts.includes("1. 둘째 항목"), `start=0 증가: ${texts.join(" / ")}`)
  })
})

// ─── 13. P3 images.ts replace $ 확장 ──────────────────

describe("regress-a 13: 이미지 ref 교체 시 $ 확장 방지", () => {
  it("ref에 $& 가 있어도 셀 텍스트 교체가 리터럴로 수행된다", async () => {
    const ref = "im$&g"
    const cell: IRCell = { text: `![image](${ref})`, colSpan: 1, rowSpan: 1, blocks: [{ type: "image", text: ref }] }
    const blocks: IRBlock[] = [{ type: "table", table: { rows: 1, cols: 1, hasHeader: false, cells: [[cell]] } }]
    await extractImagesFromZip(new JSZip(), blocks, { total: 0 })
    assert.equal(cell.text, `[이미지: ${ref}]`, "$& 확장 없이 리터럴 교체")
  })
})

// ─── 14. P3 astral 문자 폭 ────────────────────────────

describe("regress-a 14: text-metrics astral 문자", () => {
  it("charAll 모드에서 astral 문자가 서로게이트 반쪽 2개로 계산되지 않는다", () => {
    const astral = "\u{1D400}" // 𝐀 MATHEMATICAL BOLD CAPITAL A
    const wrap = simulateWrap(astral, 1_000_000, 1_000_000, 1000, 100, "charAll")
    const expected = measureTextWidth(astral, 1000, 100)
    assert.ok(Math.abs(wrap.lastLineWidth - expected) < 0.5,
      `astral 폭 ${wrap.lastLineWidth} ≠ 기대 ${expected} (2배면 서로게이트 분해)`)
  })
})
