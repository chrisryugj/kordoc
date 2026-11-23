/**
 * 벡터 글머리 점 — 줄 머리 왼쪽에 채운 작은 원 경로로 그린 글머리를 "• " 로 되살린다 (ODL 163).
 * 같은 x 의 점이 두 줄 이상일 때만 — 한 번 나온 점은 글머리 증거가 아니다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parse } from "../src/index.js"

/** 중심 (cx, cy)·반지름 r 원 — 곡선 4개 + closePath, 채움 */
const circle = (cx: number, cy: number, r: number) => {
  const k = r * 0.5523
  return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h f`
}

function onePagePdf(content: string): ArrayBuffer {
  const parts: string[] = []
  const offsets: number[] = []
  let len = 0
  const push = (s: string) => { parts.push(s); len += Buffer.byteLength(s, "latin1") }
  const obj = (n: number, body: string) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`) }
  push("%PDF-1.4\n")
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
  obj(4, `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`)
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const xref = len
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const all = Buffer.from(parts.join(""), "latin1")
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer
}

const items = ["Check tidal conditions beforehand", "Stay within marked channels", "Pay attention to buoys and markers"]
const text = (y: number, t: string) => `BT /F1 10 Tf 80 ${y} Td (${t}) Tj ET`

describe("PDF 벡터 글머리 점", () => {
  it("같은 x 의 채운 원이 여러 줄 머리에 있으면 줄마다 • 를 붙여 항목을 가른다", async () => {
    const body = items.map((t, i) => `0.27 g ${circle(71.5, 703.5 - i * 14, 1.5)} 0 g ${text(700 - i * 14, t)}`).join("\n")
    const r = await parse(onePagePdf(`${text(740, "As a boater:")}\n${body}`), { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    for (const t of items) assert.ok(r.markdown.includes(`• ${t}`), r.markdown)
  })

  it("점이 한 줄에만 있으면 붙이지 않는다", async () => {
    const r = await parse(onePagePdf(`0 g ${circle(71.5, 703.5, 1.5)}\n${items.map((t, i) => text(700 - i * 14, t)).join("\n")}`), { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    assert.ok(!r.markdown.includes("•"), r.markdown)
  })

  it("점이 커서 글자 높이의 0.6배를 넘으면 글머리로 보지 않는다", async () => {
    const body = items.map((t, i) => `${circle(70, 703.5 - i * 14, 4)} ${text(700 - i * 14, t)}`).join("\n")
    const r = await parse(onePagePdf(body), { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    assert.ok(!r.markdown.includes("•"), r.markdown)
  })
})
