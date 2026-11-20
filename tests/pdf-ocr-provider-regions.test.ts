/**
 * 사용자 OcrProvider 와 PDF 그림 영역 (#225) — 텍스트층이 멀쩡한 쪽의 글 없는 큰 그림(차트)도 ocr: true 처럼 영역을 골라
 * 프로바이더에 넘긴다. 쪽 전체가 아니라 영역을 잘라 넘기고, 결과는 그 영역 자리에 들어간다. 본문 글은 그대로.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parse } from "../src/index.js"
import type { OcrProvider } from "../src/types.js"

const W = 595, H = 842

/** 본문 글 다섯 줄(위) + JPEG 그림 하나(가운데, 쪽 면적 약 16%) + 맺음 글 한 줄(아래) */
function textAndChartPdf(jpeg: Buffer, iw: number, ih: number): ArrayBuffer {
  const lines = ["World population outlook report", "The body text layer on this page is intact.", "Population grows until the middle of the century.",
    "Regional shares change over the coming decades.", "The chart below shows shares by region."]
  const text = lines.map((t, i) => `BT /F1 12 Tf 72 ${760 - i * 20} Td (${t}) Tj ET`).join("\n")
  return onePagePdf(`${text}\nq 395 0 0 200 100 300 cm /Im0 Do Q\nBT /F1 12 Tf 72 250 Td (Source: population survey tables.) Tj ET`, jpeg, iw, ih)
}

/** 본문 글 한 줄 + 괘선 2×2 표: 머리 행 글 두 칸, 몸 행 왼쪽 칸 글·오른쪽 칸 JPEG 그림(쪽 면적 약 9%) — 레이아웃 표 칸에 든 차트 */
function tableChartPdf(jpeg: Buffer, iw: number, ih: number): ArrayBuffer {
  const rules = "0.8 w 72 300 450 300 re S 297 300 m 297 600 l S 72 560 m 522 560 l S"
  const cells = [[80, 575, "Regional timeline"], [305, 575, "Shares by age group"],
    [80, 530, "World 2002 2039 2070"], [80, 510, "Asia 2012 2035 2054"], [80, 490, "Europe 1996 2023"]]
    .map(([x, y, t]) => `BT /F1 11 Tf ${x} ${y} Td (${t}) Tj ET`).join("\n")
  return onePagePdf(`BT /F1 12 Tf 72 700 Td (World population outlook report) Tj ET\n${rules}\n${cells}\nq 210 0 0 220 305 320 cm /Im0 Do Q`, jpeg, iw, ih)
}

/** 쪽 하나(콘텐츠 스트림 + 그림 XObject Im0 + Helvetica F1)짜리 PDF */
function onePagePdf(contentText: string, jpeg: Buffer, iw: number, ih: number): ArrayBuffer {
  const parts: Buffer[] = []
  const offsets: number[] = []
  let len = 0
  const push = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b; parts.push(buf); len += buf.length }
  const obj = (n: number, body: Buffer | string, stream?: Buffer) => {
    offsets[n] = len
    push(`${n} 0 obj\n`)
    push(body)
    if (stream) { push("\nstream\n"); push(stream); push("\nendstream") }
    push("\nendobj\n")
  }
  const content = Buffer.from(contentText, "latin1")
  push("%PDF-1.4\n")
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 6 0 R >> /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg)
  obj(5, `<< /Length ${content.length} >>`, content)
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const xref = len
  push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}`)
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const all = Buffer.concat(parts)
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer
}

async function chartJpeg(width: number, height: number): Promise<Buffer | null> {
  let sharp: typeof import("sharp")["default"]
  try { sharp = (await import("sharp")).default } catch { return null }
  const sx = width / 790, sy = height / 400 // 790×400 기준 막대를 늘인다
  const bars = [0.2, 0.35, 0.25, 0.2].map((f, i) => `<rect x="${(40 + i * 180) * sx}" y="${(300 - f * 600) * sy}" width="${120 * sx}" height="${f * 600 * sy}" fill="#${["36c", "c63", "3a6", "a3c"][i]}"/>`).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/>${bars}</svg>`
  return sharp(Buffer.from(svg)).jpeg().toBuffer()
}

async function chartPdf(): Promise<ArrayBuffer | null> {
  const jpeg = await chartJpeg(790, 400)
  return jpeg ? textAndChartPdf(jpeg, 790, 400) : null
}

const pngSize = (png: Uint8Array) => ({ width: Buffer.from(png).readUInt32BE(16), height: Buffer.from(png).readUInt32BE(20) })

describe("OcrProvider: 텍스트층 쪽의 그림 영역 (#225)", () => {
  it("그림 영역만 잘라 프로바이더를 부르고, 결과를 그림 자리(본문 글 사이)에 넣는다", async (t) => {
    const pdf = await chartPdf()
    if (!pdf) { t.skip("sharp 미설치"); return }
    const calls: { width: number; height: number; page: number }[] = []
    const ocr: OcrProvider = async (image, page) => { calls.push({ ...pngSize(image), page }); return "2050 Asia 54% Africa 26%" }
    const r = await parse(pdf, { filename: "chart.pdf", ocr })
    assert.ok(r.success)
    const md = r.success ? r.markdown : ""
    assert.equal(calls.length, 1, "그림 하나에 한 번")
    assert.equal(calls[0].page, 1)
    // 쪽 전체(가로 595pt)가 아니라 그림 영역(395×200pt)만 — 가로세로 비가 그림과 같다
    assert.ok(Math.abs(calls[0].width / calls[0].height - 395 / 200) < 0.05, JSON.stringify(calls[0]))
    const at = md.indexOf("2050 Asia 54%")
    assert.ok(at > md.indexOf("shows shares by region") && at < md.indexOf("Source: population"), md)
    assert.ok(md.includes("The body text layer on this page is intact."), "본문 글은 그대로")
    assert.ok(r.warnings?.some(w => w.code === "OCR_APPLIED" && w.message.includes("사용자 프로바이더")), JSON.stringify(r.warnings))
  })

  it("프로바이더가 빈 글을 돌려주면 본문만 남고 OCR_FAILED 경고", async (t) => {
    const pdf = await chartPdf()
    if (!pdf) { t.skip("sharp 미설치"); return }
    const r = await parse(pdf, { filename: "chart.pdf", ocr: async () => "  " })
    assert.ok(r.success)
    assert.ok((r.success ? r.markdown : "").includes("The body text layer on this page is intact."))
    assert.ok(r.warnings?.some(w => w.code === "OCR_FAILED"), JSON.stringify(r.warnings))
  })

  it("ocr: false 면 프로바이더 경로가 없다 — 그림 영역은 고르지 않는다", async (t) => {
    const pdf = await chartPdf()
    if (!pdf) { t.skip("sharp 미설치"); return }
    const r = await parse(pdf, { filename: "chart.pdf", ocr: false })
    assert.ok(r.success)
    assert.ok(!r.warnings?.some(w => w.code === "OCR_APPLIED"))
  })
})

async function tableChartPdfOrNull(): Promise<ArrayBuffer | null> {
  const jpeg = await chartJpeg(420, 440)
  return jpeg ? tableChartPdf(jpeg, 420, 440) : null
}

describe("OcrProvider: 표 칸 안 그림 영역 (#225)", () => {
  it("레이아웃 표 칸에 든 그림의 결과는 표와 겹쳐도 버리지 않고 그 칸에 넣는다", async (t) => {
    const pdf = await tableChartPdfOrNull()
    if (!pdf) { t.skip("sharp 미설치"); return }
    const calls: { width: number; height: number }[] = []
    const ocr: OcrProvider = async (image) => { calls.push(pngSize(image)); return "2050 Asia 54% Africa 26%" }
    const r = await parse(pdf, { filename: "table-chart.pdf", ocr })
    assert.ok(r.success)
    if (!r.success) return
    assert.equal(calls.length, 1, "그림 하나에 한 번")
    assert.ok(Math.abs(calls[0].width / calls[0].height - 210 / 220) < 0.05, JSON.stringify(calls[0]))
    const table = r.blocks.find(b => b.type === "table")?.table
    assert.ok(table, JSON.stringify(r.blocks.map(b => b.type)))
    const row = table.cells.find(cs => cs.some(c => c.text.includes("World 2002")))
    assert.ok(row, JSON.stringify(table.cells))
    const left = row.find(c => c.text.includes("World 2002"))!, right = row.find(c => c !== left)!
    assert.ok(right.text.includes("2050 Asia 54%"), "그림이 놓인 오른쪽 칸에 " + JSON.stringify(row))
    assert.ok(right.blocks?.some(b => b.type === "paragraph" && b.text?.includes("2050 Asia 54%")), "칸 blocks 에도")
    assert.ok(!left.text.includes("2050"), "왼쪽 칸 글은 그대로")
    assert.equal(r.markdown.split("2050 Asia 54%").length - 1, 1, "표 밖에 다시 나오지 않는다\n" + r.markdown)
    assert.ok(!r.warnings?.some(w => w.code === "SKIPPED_IMAGE"), JSON.stringify(r.warnings))
  })

  it("ocr: false 면 그 칸은 비어 있다", async (t) => {
    const pdf = await tableChartPdfOrNull()
    if (!pdf) { t.skip("sharp 미설치"); return }
    const r = await parse(pdf, { filename: "table-chart.pdf", ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    const table = r.blocks.find(b => b.type === "table")?.table
    assert.ok(table)
    assert.ok(table.cells.flat().every(c => !c.blocks?.some(b => b.type === "paragraph" && /2050/.test(b.text ?? ""))))
    assert.ok(!r.warnings?.some(w => w.code === "OCR_APPLIED"))
  })
})
