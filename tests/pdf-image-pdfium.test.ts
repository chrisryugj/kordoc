import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parse } from "../src/index.js"
import { blankLargeImageStreams } from "../src/pdf/image-blank.js"
import { encodePng } from "../src/image/transcode.js"

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
  it("큰 그림만 지운다 — 128px 이하·자체 마스크·마스크 대상·이미지 마스크·암호 문서는 그대로", () => {
    const big = rgb(200, 150, 1), small = rgb(64, 64, 2)
    const pdf = simplePdf([{ content: text("x"), res: "" }], [
      stream(imageDict(200, 150), big.data), // 6
      stream(imageDict(64, 64), small.data), // 7
      stream(imageDict(200, 150, "/SMask 9 0 R "), big.data), // 8 자체 마스크
      stream("<< /Type /XObject /Subtype /Image /Width 200 /Height 150 /ColorSpace /DeviceGray /BitsPerComponent 8 >>", "\x80".repeat(200 * 150)), // 9 마스크 대상
      stream("<< /Type /XObject /Subtype /Image /Width 200 /Height 150 /ImageMask true /BitsPerComponent 1 >>", "\x55".repeat(25 * 150)), // 10 이미지 마스크
    ])
    const copy = new Uint8Array(pdf)
    const blanked = blankLargeImageStreams(copy)
    assert.deepEqual([...blanked.sizes], ["200x150"])
    assert.equal(blanked.byRaw.size, 1)
    const text1 = Buffer.from(copy).toString("latin1")
    assert.equal(Buffer.byteLength(text1, "latin1"), pdf.length) // 길이·오프셋 그대로
    assert.equal((text1.match(/\x00{90000}/g) ?? []).length, 1) // 6번(200×150×3)만 지웠다
    assert.ok(text1.includes(small.data) && text1.includes("\x80".repeat(200 * 150)))
    assert.ok(text1.includes("/ImageMask true /BitsPerComponent 1 ") && text1.includes("\x55".repeat(25 * 150)))

    const encrypted = Buffer.from(pdf.toString("latin1").replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 99 0 R"), "latin1")
    assert.equal(blankLargeImageStreams(new Uint8Array(encrypted)).byRaw.size, 0)
  })

  it("지운 큰 그림은 PDFium 원본 픽셀로 — 번호·쪽·바이트가 원본과 같다(쪽 본문·Form XObject 안·여러 쪽 반복·공용 id 재사용)", async () => {
    const a = rgb(200, 150, 10), b = rgb(160, 300, 20), small = rgb(40, 40, 30), last = rgb(48, 48, 40)
    const draw = (name: string) => `q 100 0 0 80 100 500 cm /${name} Do Q\n`
    const pdf = simplePdf([
      { content: draw("A") + draw("S") + text("one"), res: "/XObject << /A 12 0 R /S 14 0 R >>" },
      { content: draw("F") + draw("A") + text("two"), res: "/XObject << /A 12 0 R /F 15 0 R >>" },
      // 셋째 쪽부터 pdfjs 는 A 에 문서 공용 id 를 붙인다 — 앞 쪽 짝을 다시 쓰고 PDFium 쪽은 B 를 위해서만 연다
      { content: draw("A") + draw("F") + text("three"), res: "/XObject << /A 12 0 R /F 15 0 R >>" },
      // 같은 쪽에서 다시 그린 공용 그림 — PDFium 쪽을 열기 전에 두 번째 몫을 셈한다(종전엔 여기서 쪽 추출이 멈춰 T 가 빠졌다)
      { content: draw("A") + draw("A") + draw("T") + text("four"), res: "/XObject << /A 12 0 R /T 16 0 R >>" },
    ], [
      stream(imageDict(200, 150), a.data), // 12
      stream(imageDict(160, 300), b.data), // 13
      stream(imageDict(40, 40), small.data), // 14
      stream("<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /B 13 0 R >> >> >>", "/B Do"), // 15
      stream(imageDict(48, 48), last.data), // 16
    ])
    const r = await parse(pdf, { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    assert.deepEqual(r.blocks.filter(x => x.type === "image").map(x => [x.pageNumber, x.text]),
      [[1, "image_001.png"], [1, "image_002.png"], [2, "image_003.png"], [4, "image_004.png"]])
    assert.deepEqual(r.images?.map(x => Buffer.from(x.data)),
      [encodePng(200, 150, a.rgba), encodePng(40, 40, small.rgba), encodePng(160, 300, b.rgba), encodePng(48, 48, last.rgba)].map(x => Buffer.from(x)))
  })
})
