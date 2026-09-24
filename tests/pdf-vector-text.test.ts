/**
 * 벡터 글자 쪽 감지(needsOcr 사유 vector_text) + OCR 경로 벡터 괘선 배선.
 *
 * 합성 PDF: 한글 음절처럼 떨어진 윤곽 2개(ㄱ자 + 세로획)를 한 번에 채운 경로를 글줄로 늘어놓은 쪽 = 글자를 곡선으로
 * 그린 쪽(rhwp cairo 렌더와 같은 모양). 반례: 같은 모양 반복(점선 칸)·윗선 들쭉날쭉(아이콘 무리)·홑윤곽 도형(글머리
 * 원)·텍스트층이 덮은 윤곽(투명 텍스트층)·텍스트층 글이 대부분인 쪽.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { computePageQuality } from "../src/pdf/quality.js"
import { ocrVectorOps, type GlyphPath } from "../src/pdf/vector-glyphs.js"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"

/** 1페이지 합성 PDF (Helvetica, 612×792) */
function buildPdf(content: string): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
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

/** 음절 모양 채움 경로 하나: ㄱ자 윤곽(선분 5) + 세로획 윤곽(선분 3), 윗선 top 에 맞춤. k 로 폭·높이를 바꾼다(15가지) */
function glyph(x: number, top: number, k: number): string {
  const wA = 4 + (k % 5) * 0.6, hA = 4 + (k % 2), hB = 7.5 + (k % 3)
  const f = (n: number) => n.toFixed(2)
  return `${f(x)} ${f(top)} m ${f(x + wA)} ${f(top)} l ${f(x + wA)} ${f(top - hA)} l ${f(x + wA - 1)} ${f(top - hA)} l ${f(x + wA - 1)} ${f(top - 1)} l ${f(x)} ${f(top - 1)} l h ` +
    `${f(x + wA + 1)} ${f(top)} m ${f(x + wA + 2)} ${f(top)} l ${f(x + wA + 2)} ${f(top - hB)} l ${f(x + wA + 1)} ${f(top - hB)} l h f\n`
}

/** 글줄 lines 개 × 글자 perLine 개 (글자 간격 10pt, 줄 간격 20pt) */
function glyphLines(lines: number, perLine: number, opts: { same?: boolean; jitter?: boolean } = {}): string {
  let s = "0 0 0 rg\n"
  for (let r = 0; r < lines; r++) {
    for (let c = 0; c < perLine; c++) {
      const k = opts.same ? 0 : r * perLine + c
      // jitter: 윗선이 글자마다 0~3pt 들쭉날쭉 (아이콘 무리)
      s += glyph(60 + c * 10, 700 - r * 20 - (opts.jitter ? (c % 4) * 1 : 0), k)
    }
  }
  return s
}

async function parsePage(content: string) {
  const { parsePdfDocument } = await import("../src/pdf/parser.js")
  return parsePdfDocument(buildPdf(content))
}

describe("computePageQuality — vector_text", () => {
  it("곡선 글자가 쪽 글자의 대부분 → vector_text (ASCII 가 조금 있어도)", () => {
    const q = computePageQuality(1, "2026. 6. 25. (5) -9235 06/25 :", 300)
    assert.equal(q.needsOcr, true)
    assert.equal(q.ocrReason, "vector_text")
  })

  it("텍스트층이 비어도 곡선 글자가 있으면 low_text 가 아니라 vector_text", () => {
    assert.equal(computePageQuality(1, "", 50).ocrReason, "vector_text")
  })

  it("곡선 글자가 적으면(로고 수준 < 40) 발화 안 함", () => {
    const q = computePageQuality(1, "이 쪽은 텍스트층에 제목이 있는 표지입니다 발간등록번호", 34)
    assert.notEqual(q.ocrReason, "vector_text")
  })

  it("텍스트층 글이 대부분이면(곡선 비율 < 25%) 발화 안 함 — 차트 라벨만 곡선인 쪽", () => {
    const body = "정상적인 한글 본문이 충분히 긴 쪽입니다. ".repeat(20)
    const q = computePageQuality(1, body, 62)
    assert.equal(q.needsOcr, false)
  })

  it("vectorGlyphs 생략 시 종전과 같다", () => {
    assert.equal(computePageQuality(1, "").ocrReason, "low_text")
  })
})

describe("합성 PDF — 벡터 글자 쪽 감지", () => {
  it("음절 모양 채움 경로 글줄(6줄×12자) + ASCII 한 줄 → vector_text + NEEDS_OCR 경고", async () => {
    const r = await parsePage(glyphLines(6, 12) + "BT /F1 10 Tf 60 750 Td (Page 1 - 2026) Tj ET")
    assert.equal(r.pageQuality?.[0].ocrReason, "vector_text", JSON.stringify(r.pageQuality))
    assert.ok(r.warnings?.some(w => w.code === "NEEDS_OCR" && w.page === 1 && w.message.includes("곡선")), JSON.stringify(r.warnings))
  })

  it("반례: 같은 모양 반복(점선 칸·무늬) → 발화 안 함", async () => {
    const r = await parsePage(glyphLines(6, 12, { same: true }) + "BT /F1 10 Tf 60 750 Td (Page 1 - 2026) Tj ET")
    assert.notEqual(r.pageQuality?.[0].ocrReason, "vector_text")
  })

  it("반례: 윗선·밑선이 들쭉날쭉한 도형 줄(아이콘 무리) → 발화 안 함", async () => {
    const r = await parsePage(glyphLines(6, 12, { jitter: true }) + "BT /F1 10 Tf 60 750 Td (Page 1 - 2026) Tj ET")
    assert.notEqual(r.pageQuality?.[0].ocrReason, "vector_text")
  })

  it("반례: 홑윤곽 도형(원 글머리·체크박스 사각형) 격자 → 발화 안 함", async () => {
    let s = "0 0 0 rg\n"
    for (let r = 0; r < 6; r++) for (let c = 0; c < 12; c++) {
      const x = 60 + c * 10, y = 700 - r * 20
      // 원(베지어 4개)과 사각형(re) 번갈아
      s += c % 2
        ? `${x} ${y - 4} m ${x} ${y - 1.8} ${x + 1.8} ${y} ${x + 4} ${y} c ${x + 6.2} ${y} ${x + 8} ${y - 1.8} ${x + 8} ${y - 4} c ${x + 8} ${y - 6.2} ${x + 6.2} ${y - 8} ${x + 4} ${y - 8} c ${x + 1.8} ${y - 8} ${x} ${y - 6.2} ${x} ${y - 4} c h f\n`
        : `${x} ${y - 8} 8 8 re f\n`
    }
    const r = await parsePage(s + "BT /F1 10 Tf 60 750 Td (Page 1 - 2026) Tj ET")
    assert.notEqual(r.pageQuality?.[0].ocrReason, "vector_text")
  })

  it("반례: 윤곽 위에 투명 텍스트층(3 Tr)이 덮은 쪽 → 글이 있는 쪽이라 발화 안 함", async () => {
    let text = ""
    for (let r = 0; r < 6; r++) text += `BT 3 Tr /F1 10 Tf 60 ${691 - r * 20} Td (WWWWWWWWWWWWW) Tj ET\n`
    const r = await parsePage(glyphLines(6, 12) + text)
    assert.notEqual(r.pageQuality?.[0].ocrReason, "vector_text", JSON.stringify(r.pageQuality))
  })

  it("반례: 텍스트층 본문이 대부분인 쪽의 곡선 글자 줄(차트 라벨) → 발화 안 함", async () => {
    let text = ""
    for (let r = 0; r < 12; r++) text += `BT /F1 10 Tf 60 ${560 - r * 14} Td (This page has a normal text layer with plenty of body text, line ${r}.) Tj ET\n`
    const r = await parsePage(glyphLines(6, 12) + text)
    assert.equal(r.pageQuality?.[0].needsOcr, false, JSON.stringify(r.pageQuality))
  })
})

describe("OCR 경로 — 벡터 글자 쪽은 그 쪽 괘선으로 표 복원", () => {
  it("ocrVectorOps 는 글자 경로의 연산자와 클립만 뺀다 (괘선·채움·그림은 남김)", async () => {
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const fn = [OPS.save, OPS.constructPath, OPS.fill, OPS.constructPath, OPS.clip, OPS.endPath, OPS.constructPath, OPS.stroke, OPS.restore]
    const opList = { fnArray: fn, argsArray: fn.map((_, i) => [i]) }
    const paths = [{ ops: [1, 2] }] as unknown as GlyphPath[]
    const out = ocrVectorOps(opList, paths)
    assert.deepEqual(out.fnArray, [OPS.save, OPS.constructPath, OPS.endPath, OPS.constructPath, OPS.stroke, OPS.restore])
    assert.deepEqual(out.argsArray, [[0], [3], [5], [6], [7], [8]])
  })

  it("ocrItemsToBlocks 에 쪽 연산자 목록을 주면 벡터 괘선 2×2 격자로 OCR 글자를 칸에 넣는다", async () => {
    // 2×2 표 괘선 (x 100~300, y 500~600 — PDF 좌표)
    const grid = "0.5 w 100 600 m 300 600 l S 100 550 m 300 550 l S 100 500 m 300 500 l S " +
      "100 500 m 100 600 l S 200 500 m 200 600 l S 300 500 m 300 600 l S"
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const doc = await getDocument({ data: new Uint8Array(buildPdf(grid)), isEvalSupported: false }).promise
    const opList = await (await doc.getPage(1)).getOperatorList()
    // OCR 박스(렌더 픽셀 = pt, 위쪽 원점): 칸 가운데 글줄
    const H = 792
    const at = (text: string, x: number, yPdfTop: number) => ({ text, x, y: H - yPdfTop, w: 40, h: 10, confidence: 0.99 })
    const items = [at("구분", 120, 580), at("내용", 220, 580), at("성명", 120, 530), at("홍길동", 220, 530)]
    const withLines = ocrItemsToBlocks(items, 1, 612, H, 1, undefined, true, opList)
    const table = withLines.find(b => b.type === "table")?.table
    assert.ok(table, JSON.stringify(withLines))
    assert.equal(table.rows, 2)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[1][1].text, "홍길동")
    // 연산자 목록이 없으면(종전 기본값) 괘선이 없어 이 격자는 표가 되지 않는다
    const without = ocrItemsToBlocks(items, 1, 612, H, 1, undefined, true)
    assert.ok(!without.some(b => b.type === "table" && b.table?.rows === 2 && b.table.cols === 2 && b.table.cells[1][1].text === "홍길동"))
    await doc.destroy()
  })

  it("음영 머리 칸에만 클립을 깐 표(cairo 모양)도 ocrVectorOps 로는 머리 행과 본문 행이 한 표", async () => {
    // 머리 행 두 칸: 클립(W n) + 같은 기하 음영 채움, 본문 행은 클립 없음 — 부분 클립 격자가 표를 쪼개지 않아야 한다
    const shade = (x: number) => `q ${x} 550 100 50 re W n 0.8 g ${x} 550 100 50 re f Q `
    const grid = shade(100) + shade(200) + "0 g 0.5 w 100 600 m 300 600 l S 100 550 m 300 550 l S 100 500 m 300 500 l S " +
      "100 500 m 100 600 l S 200 500 m 200 600 l S 300 500 m 300 600 l S"
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const doc = await getDocument({ data: new Uint8Array(buildPdf(grid)), isEvalSupported: false }).promise
    const opList = await (await doc.getPage(1)).getOperatorList()
    const H = 792
    const at = (text: string, x: number, yPdfTop: number) => ({ text, x, y: H - yPdfTop, w: 40, h: 10, confidence: 0.99 })
    const items = [at("구분", 120, 580), at("내용", 220, 580), at("성명", 120, 530), at("홍길동", 220, 530)]
    const tables = ocrItemsToBlocks(items, 1, 612, H, 1, undefined, true, ocrVectorOps(opList, [])).filter(b => b.type === "table")
    assert.equal(tables.length, 1, JSON.stringify(tables.map(b => b.table?.cells.map(r => r.map(c => c.text)))))
    const t = tables[0].table!
    assert.deepEqual(t.cells.map(r => r.map(c => c.text)), [["구분", "내용"], ["성명", "홍길동"]])
    await doc.destroy()
  })
})

// ─── 코퍼스 (rhwp 자체 렌더 cairo PDF — gitignore, 있을 때만) ───
const CAIRO = fileURLToPath(new URL("../bench/corpus/rhwp/task2243/36382819_gyeoljae_pm_traffic.pdf", import.meta.url))
const HANCOM = fileURLToPath(new URL("../bench/corpus/rhwp/task2243/36382819_gyeoljae_pm_traffic.hwpx", import.meta.url))

describe("코퍼스: rhwp cairo 렌더 결재문서", { skip: !existsSync(CAIRO) }, () => {
  it("3쪽 전부 vector_text (텍스트층 한글 0자) — 짝 HWPX 는 한글 문서", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const buf = readFileSync(CAIRO)
    const r = await parsePdfDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    assert.deepEqual(r.pageQuality?.map(q => q.ocrReason), ["vector_text", "vector_text", "vector_text"])
    assert.equal((r.markdown.match(/[가-힣]/g) ?? []).length, 0)
    assert.ok(existsSync(HANCOM))
  })
})
