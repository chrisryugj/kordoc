import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blankLargeImageStreams } from "../src/pdf/image-blank.js"

// ─── 합성 PDF (pdf-resource-regression.test.ts 와 같은 꼴) ─────────────

const stream = (dict: string, data: string): string => `${dict.replace(/>>\s*$/, ` /Length ${Buffer.byteLength(data, "latin1")} >>`)}\nstream\n${data}\nendstream`

function pdfFrom(objects: string[], trailerExtra = ""): Buffer {
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

/** 1 카탈로그, 2 쪽 트리, 3 Helvetica, 쪽마다 쪽 객체 + 내용 스트림, 그 뒤 extra (번호 4 + 2×쪽수 부터) */
function simplePdf(pages: { content: string; res: string }[], extra: string[]): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]
  pages.forEach((p, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> ${p.res} >> /Contents ${5 + i * 2} 0 R >>`)
    objs.push(stream("<< >>", p.content))
  })
  return pdfFrom([...objs, ...extra])
}

/** 가로 그러데이션 RGB 표본 (압축 없음 — pdfjs·PDFium 픽셀이 같다) */
function rgb(w: number, h: number, seed: number): { data: string; rgba: Uint8Array } {
  const raw = Buffer.alloc(w * h * 3), rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = [(i % w) * 255 / w, (Math.floor(i / w) * 255) / h, seed].map(Math.round)
    raw.set(v, i * 3); rgba.set([...v, 255], i * 4)
  }
  return { data: raw.toString("latin1"), rgba }
}
const imageDict = (w: number, h: number, extra = "") => `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${extra}>>`
const text = (s: string) => `BT /F1 12 Tf 1 0 0 1 72 760 Tm (${s}) Tj ET\n`

describe("PDF 큰 그림 — pdfjs 사본 표본 지우기 (#186)", () => {
  it("큰 그림만 지운다 — 128px 이하·자체 마스크·마스크 대상·암호 문서는 그대로", () => {
    const big = rgb(200, 150, 1), small = rgb(64, 64, 2)
    const pdf = simplePdf([{ content: text("x"), res: "" }], [
      stream(imageDict(200, 150), big.data), // 6
      stream(imageDict(64, 64), small.data), // 7
      stream(imageDict(200, 150, "/SMask 9 0 R "), big.data), // 8 자체 마스크
      stream("<< /Type /XObject /Subtype /Image /Width 200 /Height 150 /ColorSpace /DeviceGray /BitsPerComponent 8 >>", "\x80".repeat(200 * 150)), // 9 마스크 대상
    ])
    const copy = new Uint8Array(pdf)
    const blanked = blankLargeImageStreams(copy)
    assert.deepEqual([...blanked.sizes], ["200x150"])
    assert.equal(blanked.byRaw.size, 1)
    const text1 = Buffer.from(copy).toString("latin1")
    assert.equal(Buffer.byteLength(text1, "latin1"), pdf.length) // 길이·오프셋 그대로
    assert.equal((text1.match(/\x00{90000}/g) ?? []).length, 1) // 6번(200×150×3)만 지웠다
    assert.ok(text1.includes(small.data) && text1.includes("\x80".repeat(200 * 150)))

    const encrypted = Buffer.from(pdf.toString("latin1").replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 99 0 R"), "latin1")
    assert.equal(blankLargeImageStreams(new Uint8Array(encrypted)).byRaw.size, 0)
  })
})
