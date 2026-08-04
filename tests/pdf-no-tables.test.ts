/**
 * #64 — PDF 표 감지 opt-out (`parse(buf, { tables: false })` · CLI `--no-tables`)
 *
 * 시각적 테두리 박스(시험지 안내문·보기 상자)가 선 기반 표로 잡히면 주변 본문이
 * 셀 매핑으로 끌려 들어가 읽기 순서가 뒤집히는데, 표 감지를 끌 방법이 없었다.
 * 끈 경로는 그리드·클러스터·한국어 특수표를 모두 건너뛰고 자연 읽기순 텍스트만 낸다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { parsePdfDocument } from "../src/pdf/parser.js"
import type { NormItem } from "../src/pdf/text-line.js"

function ni(text: string, x: number, y: number, w: number, h = 10, fontSize = 10): NormItem {
  return { text, x, y, w, h, fontSize, fontName: "f1", isHidden: false }
}

function lineOpList(segs: Array<[number, number, number, number]>): { fnArray: number[]; argsArray: unknown[][] } {
  const fnArray: number[] = []
  const argsArray: unknown[][] = []
  for (const [x1, y1, x2, y2] of segs) {
    fnArray.push(OPS.constructPath)
    argsArray.push([[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]])
    fnArray.push(OPS.stroke)
    argsArray.push([])
  }
  return { fnArray, argsArray }
}

/** 3행×2열 표 괘선 */
const GRID_SEGS: Array<[number, number, number, number]> = [
  [100, 550, 500, 550], [100, 600, 500, 600], [100, 650, 500, 650], [100, 700, 500, 700],
  [100, 550, 100, 700], [300, 550, 300, 700], [500, 550, 500, 700],
]

const cellItems = (): NormItem[] => [
  ni("구분", 110, 670, 30), ni("내용", 310, 670, 30),
  ni("항목A", 110, 615, 30), ni("1234", 310, 615, 30),
  ni("항목B", 110, 565, 30), ni("5678", 310, 565, 30),
]

function buildSyntheticPdf(contentStream: string): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n"
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  const buf = Buffer.from(pdf, "latin1")
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** 괘선 표(3행×2열)만 있는 PDF */
const tableOnlyPdf = () => buildSyntheticPdf(
  "1 w\n" +
  "100 550 m 500 550 l S\n100 600 m 500 600 l S\n100 650 m 500 650 l S\n100 700 m 500 700 l S\n" +
  "100 550 m 100 700 l S\n300 550 m 300 700 l S\n500 550 m 500 700 l S\n" +
  "BT /F1 10 Tf 110 665 Td (GUBUN) Tj ET\nBT /F1 10 Tf 310 665 Td (AMOUNT) Tj ET\n" +
  "BT /F1 10 Tf 110 615 Td (ALPHA) Tj ET\nBT /F1 10 Tf 310 615 Td (12345) Tj ET\n" +
  "BT /F1 10 Tf 110 565 Td (BRAVO) Tj ET\nBT /F1 10 Tf 310 565 Td (67890) Tj ET",
)

describe("#64 PDF 표 감지 opt-out", () => {
  it("기본값은 종전대로 괘선 그리드를 표로 낸다 (계약 불변)", () => {
    const blocks = extractPageBlocksWithLines(cellItems(), 1, lineOpList(GRID_SEGS), 612, 792)
    assert.ok(blocks.some(b => b.type === "table"), "기본 경로는 표 감지")
  })

  it("끄면 표 블록이 없고 셀 텍스트가 통째로 본문으로 남는다", () => {
    const blocks = extractPageBlocksWithLines(cellItems(), 1, lineOpList(GRID_SEGS), 612, 792, undefined, false)
    assert.ok(!blocks.some(b => b.type === "table"), "표 블록 없음")
    const text = blocks.map(b => b.text || "").join("\n")
    for (const t of ["구분", "내용", "항목A", "1234", "항목B", "5678"]) {
      assert.ok(text.includes(t), `${t} 유실: ${text}`)
    }
    // 같은 열 안에서는 위→아래 순서가 보존된다 (읽기 순서 역전 없음)
    assert.ok(text.indexOf("항목A") < text.indexOf("항목B"), text)
    assert.ok(text.indexOf("구분") < text.indexOf("항목A"), text)
  })

  it("parse 옵션 tables:false 가 마크다운 표 문법을 없앤다 (E2E)", async () => {
    const on = await parsePdfDocument(tableOnlyPdf())
    assert.ok(on.markdown.includes("|"), "기본 파싱은 마크다운 표를 낸다")

    const off = await parsePdfDocument(tableOnlyPdf(), { tables: false })
    assert.ok(!off.blocks.some(b => b.type === "table"), "표 블록 없음")
    assert.ok(!off.markdown.includes("|"), `표 문법 잔류: ${off.markdown}`)
    for (const t of ["GUBUN", "AMOUNT", "ALPHA", "12345", "BRAVO", "67890"]) {
      assert.ok(off.markdown.includes(t), `${t} 유실: ${off.markdown}`)
    }
  })
})
