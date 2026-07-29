/**
 * 구조화 파싱 테스트 — blocks + metadata 통합 검증
 *
 * ParseSuccess에 blocks: IRBlock[]와 metadata?: DocumentMetadata가
 * 올바르게 포함되는지 검증.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import JSZip from "jszip"
import { parse, parseHwpx, parsePdf } from "../src/index.js"
import { toArrayBuffer } from "../src/utils.js"
import type { IRBlock } from "../src/types.js"

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures")
const DUMMY_HWPX = resolve(FIXTURES_DIR, "dummy.hwpx")
const FIXTURE_PDF = resolve(FIXTURES_DIR, "sample.pdf")

// ─── 헬퍼 ─────────────────────────────────────────

async function makeHwpxZip(sections: { name: string; xml: string }[], meta?: string): Promise<ArrayBuffer> {
  const zip = new JSZip()

  const spineRefs = sections.map((_, i) => `<opf:itemref idref="s${i}" />`).join("\n    ")
  const items = sections.map((s, i) =>
    `<opf:item id="s${i}" href="${s.name}" media-type="application/xml" />`
  ).join("\n    ")

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
  <opf:manifest>
    ${items}
  </opf:manifest>
  <opf:spine>
    ${spineRefs}
  </opf:spine>
</opf:package>`

  zip.file("Contents/content.hpf", manifest)
  for (const section of sections) {
    zip.file(`Contents/${section.name}`, section.xml)
  }

  if (meta) {
    zip.file("meta.xml", meta)
  }

  return await zip.generateAsync({ type: "arraybuffer" })
}

function wrapSectionXml(bodyContent: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2016/HwpMl"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2016/HwpMl">
  ${bodyContent}
</hs:sec>`
}

// ═══════════════════════════════════════════════════════
// blocks 검증
// ═══════════════════════════════════════════════════════

describe("구조화 파싱: blocks", () => {
  it("합성 HWPX 단락 → paragraph 블록 포함", async () => {
    const xml = wrapSectionXml(`
      <hp:p><hp:run><hp:t>첫번째 문단</hp:t></hp:run></hp:p>
      <hp:p><hp:run><hp:t>두번째 문단</hp:t></hp:run></hp:p>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parse(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(Array.isArray(result.blocks), "blocks는 배열")
      assert.ok(result.blocks.length >= 2, `최소 2개 블록: ${result.blocks.length}`)

      const paragraphs = result.blocks.filter(b => b.type === "paragraph")
      assert.ok(paragraphs.length >= 2, "paragraph 블록 2개 이상")
      assert.ok(paragraphs.some(b => b.text === "첫번째 문단"), "첫 단락 텍스트")
      assert.ok(paragraphs.some(b => b.text === "두번째 문단"), "둘째 단락 텍스트")
    }
  })

  it("합성 HWPX 테이블 → table 블록 포함 + IRTable 구조", async () => {
    const xml = wrapSectionXml(`
      <hp:tbl>
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>A</hp:t></hp:run></hp:p></hp:tc>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>B</hp:t></hp:run></hp:p></hp:tc>
        </hp:tr>
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>1</hp:t></hp:run></hp:p></hp:tc>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>2</hp:t></hp:run></hp:p></hp:tc>
        </hp:tr>
      </hp:tbl>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parse(buf)

    assert.equal(result.success, true)
    if (result.success) {
      const tables = result.blocks.filter(b => b.type === "table")
      assert.equal(tables.length, 1, "테이블 1개")

      const table = tables[0].table
      assert.ok(table, "table 객체 존재")
      assert.equal(table!.rows, 2, "2행")
      assert.equal(table!.cols, 2, "2열")
      assert.ok(Array.isArray(table!.cells), "cells 배열 존재")
      assert.equal(table!.cells[0][0].text, "A", "첫 셀 텍스트")
      assert.equal(table!.cells[1][1].text, "2", "마지막 셀 텍스트")
    }
  })

  it("빈 버퍼 → blocks 없음 (실패 결과)", async () => {
    const result = await parse(new ArrayBuffer(0))
    assert.equal(result.success, false)
    // ParseFailure에는 blocks가 없음
    assert.equal((result as { blocks?: unknown }).blocks, undefined)
  })
})

// ═══════════════════════════════════════════════════════
// metadata 검증
// ═══════════════════════════════════════════════════════

describe("구조화 파싱: metadata", () => {
  it("합성 HWPX + meta.xml → 메타데이터 추출", async () => {
    const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
          xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>테스트 문서 제목</dc:title>
  <dc:creator>홍길동</dc:creator>
  <dc:description>테스트 설명</dc:description>
  <dcterms:created>2024-01-15T10:30:00</dcterms:created>
  <dc:keyword>테스트,문서,한글</dc:keyword>
</metadata>`

    const xml = wrapSectionXml(`<hp:p><hp:run><hp:t>내용</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }], metaXml)
    const result = await parse(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.metadata, "metadata 존재")
      assert.equal(result.metadata!.title, "테스트 문서 제목")
      assert.equal(result.metadata!.author, "홍길동")
      assert.equal(result.metadata!.description, "테스트 설명")
      assert.equal(result.metadata!.createdAt, "2024-01-15T10:30:00")
      assert.deepEqual(result.metadata!.keywords, ["테스트", "문서", "한글"])
      assert.equal(result.metadata!.pageCount, 1)
    }
  })

  it("meta.xml 없는 HWPX → metadata에 pageCount만", async () => {
    const xml = wrapSectionXml(`<hp:p><hp:run><hp:t>내용</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parse(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.metadata, "metadata 객체 존재")
      assert.equal(result.metadata!.pageCount, 1)
    }
  })
})

// ═══════════════════════════════════════════════════════
// 페이지 범위 통합
// ═══════════════════════════════════════════════════════

describe("페이지 범위 파싱", () => {
  it("멀티섹션 HWPX — pages '1' → 첫 섹션만", async () => {
    const s0 = wrapSectionXml(`<hp:p><hp:run><hp:t>섹션A 내용</hp:t></hp:run></hp:p>`)
    const s1 = wrapSectionXml(`<hp:p><hp:run><hp:t>섹션B 내용</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([
      { name: "section0.xml", xml: s0 },
      { name: "section1.xml", xml: s1 },
    ])

    const result = await parse(buf, { pages: "1" })
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("섹션A 내용"), "첫 섹션 포함")
      assert.ok(!result.markdown.includes("섹션B 내용"), "둘째 섹션 미포함")
    }
  })

  it("멀티섹션 HWPX — pages '2' → 둘째 섹션만", async () => {
    const s0 = wrapSectionXml(`<hp:p><hp:run><hp:t>섹션A 내용</hp:t></hp:run></hp:p>`)
    const s1 = wrapSectionXml(`<hp:p><hp:run><hp:t>섹션B 내용</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([
      { name: "section0.xml", xml: s0 },
      { name: "section1.xml", xml: s1 },
    ])

    const result = await parse(buf, { pages: "2" })
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(!result.markdown.includes("섹션A 내용"), "첫 섹션 미포함")
      assert.ok(result.markdown.includes("섹션B 내용"), "둘째 섹션 포함")
    }
  })

  it("options 없이 → 전체 파싱", async () => {
    const s0 = wrapSectionXml(`<hp:p><hp:run><hp:t>전체A</hp:t></hp:run></hp:p>`)
    const s1 = wrapSectionXml(`<hp:p><hp:run><hp:t>전체B</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([
      { name: "section0.xml", xml: s0 },
      { name: "section1.xml", xml: s1 },
    ])

    const result = await parse(buf)
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("전체A"), "첫 섹션 포함")
      assert.ok(result.markdown.includes("전체B"), "둘째 섹션 포함")
    }
  })
})

// ═══════════════════════════════════════════════════════
// dummy fixture 검증
// ═══════════════════════════════════════════════════════

describe("dummy fixture: blocks + metadata", { skip: !existsSync(DUMMY_HWPX) && "dummy fixture 없음" }, () => {
  it("dummy HWPX → blocks 포함", async () => {
    const buf = toArrayBuffer(readFileSync(DUMMY_HWPX))
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(Array.isArray(result.blocks), "blocks 배열")
      assert.ok(result.blocks.length > 0, `blocks 비어있지 않음: ${result.blocks.length}`)

      // paragraph와 table 블록 모두 존재해야 함 (dummy는 텍스트+테이블 포함)
      const types = new Set(result.blocks.map(b => b.type))
      assert.ok(types.has("paragraph"), "paragraph 블록 존재")
      assert.ok(types.has("table"), "table 블록 존재")
    }
  })

  it("dummy HWPX → metadata.pageCount 존재", async () => {
    const buf = toArrayBuffer(readFileSync(DUMMY_HWPX))
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.metadata, "metadata 존재")
      assert.ok(typeof result.metadata!.pageCount === "number", "pageCount는 숫자")
      assert.ok(result.metadata!.pageCount! >= 1, "최소 1페이지")
    }
  })
})

// ═══════════════════════════════════════════════════════
// PDF fixture (로컬 전용)
// ═══════════════════════════════════════════════════════

describe("PDF: blocks + metadata", { skip: !existsSync(FIXTURE_PDF) && "PDF fixture 없음" }, () => {
  it("PDF → blocks 포함 (paragraph 타입)", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_PDF))
    const result = await parsePdf(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(Array.isArray(result.blocks), "blocks 배열")
      assert.ok(result.blocks.length > 0, "blocks 비어있지 않음")
      const VALID_TYPES = ["paragraph", "table", "heading", "list", "image", "separator"]
      assert.ok(result.blocks.every(b => VALID_TYPES.includes(b.type)), "유효한 블록 타입")
    }
  })

  it("PDF → metadata.pageCount 존재", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_PDF))
    const result = await parsePdf(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.metadata, "metadata 존재")
      assert.ok(typeof result.metadata!.pageCount === "number", "pageCount 숫자")
      assert.ok(result.metadata!.pageCount! >= 1, "최소 1페이지")
    }
  })
})
