import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import MarkdownIt from "markdown-it"
import { parse } from "../src/index.js"
import { moveImagesInFlow } from "../src/pdf/image-extract.js"
import type { IRBlock } from "../src/types.js"

/** 한 쪽 PDF — 글은 [x, y, 글], 그림은 [x, y, w, h, rgb 함수] (이미지 좌표는 pt, 화소는 w×h 그대로), 클립은 그림마다 그림 영역 */
function pdf(texts: [number, number, string][], images: [number, number, number, number, (x: number, y: number) => number[]][], clip = false): Buffer {
  const xobj = images.map((_, k) => `/I${k} ${6 + k} 0 R`).join(" ")
  const draw = images.map(([x, y, w, h], k) => `q ${clip ? `${x} ${y} ${w} ${h} re W n ` : ""}${w} 0 0 ${h} ${x} ${y} cm /I${k} Do Q`).join(" ")
  const content = `${draw} ${texts.map(([x, y, t]) => `BT /F1 10 Tf ${x} ${y} Td (${t}) Tj ET`).join(" ")}`
  const img = ([, , w, h, px]: (typeof images)[number]) => {
    const rgb = Buffer.alloc(w * h * 3)
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) rgb.set(px(xx, yy), (yy * w + xx) * 3)
    return `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n${rgb.toString("latin1")}\nendstream`
  }
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << ${xobj} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...images.map(img),
  ]
  let out = "%PDF-1.4\n"; const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

const pattern = (x: number, y: number) => [(x * 37) % 256, (y * 53) % 256, ((x + y) * 11) % 256]
const blank = () => [235, 240, 248]
/** 마크다운 최상위 토큰 순서(문단 글·그림 이름) — markdown-it 으로 구조를 본다 */
const order = (md: string) => new MarkdownIt().parse(md, {}).filter(t => t.type === "inline").map(t => t.children?.find(c => c.type === "image")?.attrGet("src") ?? t.content)

describe("PDF 그림 자리 imagePlacement", () => {
  it('"flow" 는 그림을 같은 단의 글 사이(위쪽 변 기준)에 끼운다. 기본 "page-end" 는 종전대로 쪽 끝', async () => {
    // 2단: 왼쪽 단 글 3줄 사이에 그림, 오른쪽 단 글 2줄 아래에 그림
    const buf = pdf(
      [[60, 760, "Left one"], [60, 740, "Left two"], [60, 560, "Left three"], [330, 760, "Right one"], [330, 740, "Right two"]],
      [[60, 600, 160, 120, pattern], [330, 560, 160, 120, (x, y) => pattern(y, x)]],
    )
    const def = await parse(buf, { ocr: false }), flow = await parse(buf, { ocr: false, imagePlacement: "flow" })
    assert.ok(def.success && flow.success)
    if (!def.success || !flow.success) return
    // page-end 는 그림을 쪽 끝에 모은다. flow 는 같은 단에서 그림 위쪽 변보다 높게 시작하는 마지막 블록 뒤 — 왼쪽 그림은 "Left two" 뒤,
    // 오른쪽 그림은 "Right two" 뒤. 글 순서는 그대로
    const d = order(def.markdown), f = order(flow.markdown)
    assert.deepEqual(d.slice(-2), ["image_001.png", "image_002.png"])
    assert.deepEqual(f.filter(t => !t.startsWith("image_")), d.filter(t => !t.startsWith("image_")))
    assert.equal(f[f.indexOf("image_001.png") - 1], "Left two")
    assert.equal(f[f.indexOf("image_002.png") - 1], "Right two")
    // page-end(기본)는 그림 블록에 bbox 가 없고, flow 는 쪽 위 자리를 붙인다
    assert.equal(def.blocks.find(b => b.type === "image")?.bbox, undefined)
    assert.deepEqual(flow.blocks.find(b => b.type === "image")?.bbox, { page: 1, x: 60, y: 600, width: 160, height: 120 })
  })

  it("같은 단 블록이 없으면 쪽의 블록 기준, 위에 블록이 없으면 단의 첫 블록 앞, 자리 없는 그림은 쪽 끝", () => {
    const box = (x: number, y: number, w: number, h: number) => ({ page: 1, x, y, width: w, height: h })
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "A", pageNumber: 1, bbox: box(60, 700, 200, 20) },
      { type: "paragraph", text: "B", pageNumber: 1, bbox: box(60, 500, 200, 20) },
      { type: "paragraph", text: "C", pageNumber: 2, bbox: box(60, 700, 200, 20) },
    ]
    // 쪽 끝에 넣어 둔 그림(블록 판정이 끝난 뒤의 모양)
    blocks.splice(2, 0,
      { type: "image", text: "top", pageNumber: 1, bbox: box(80, 750, 100, 40) }, // A 보다 위 → A 앞
      { type: "image", text: "side", pageNumber: 1, bbox: box(400, 600, 100, 40) }, // 겹치는 블록 없음 → 쪽 블록 기준 A 뒤
      { type: "image", text: "nobox", pageNumber: 1 }) // 자리 없음 → 쪽 끝 그대로
    blocks.push({ type: "image", text: "alone", pageNumber: 3, bbox: box(80, 750, 100, 40) }) // 글 없는 쪽 → 쪽 순서 자리 그대로
    moveImagesInFlow(blocks)
    assert.deepEqual(blocks.map(b => b.text), ["top", "A", "side", "B", "nobox", "C", "alone"])
  })
})

describe("빈 그림 빼기 dropBlankImages", () => {
  it("PDF: 거의 한 색인 그림만 빼고 남은 그림으로 번호를 매긴다. 기본과 images: false 는 그대로", async () => {
    const buf = pdf([[60, 760, "Body"]], [[60, 600, 120, 80, blank], [60, 400, 120, 80, pattern], [60, 200, 120, 80, (x) => [200 + (x % 20), 210, 220]]])
    const def = await parse(buf, { ocr: false }), drop = await parse(buf, { ocr: false, dropBlankImages: true })
    assert.ok(def.success && drop.success)
    if (!def.success || !drop.success) return
    assert.deepEqual(def.images!.map(i => i.filename), ["image_001.png", "image_002.png", "image_003.png"])
    // images: false 면 판정하지 않는다 — 자리 표시 셋 그대로
    const none = await parse(buf, { ocr: false, images: false, dropBlankImages: true })
    assert.ok(none.success && none.blocks.filter(b => b.type === "image").length === 3)
    assert.deepEqual(drop.images!.map(i => i.filename), ["image_001.png"])
    assert.deepEqual(order(drop.markdown), ["Body", "image_001.png"])
  })

  it("DOCX: 빈 BMP 는 images·블록·마크다운에서 빠지고 남은 그림 이름은 그대로", async () => {
    const bmp = (px: (x: number, y: number) => number[]) => {
      const w = 40, h = 30, stride = (w * 3 + 3) & ~3, out = new Uint8Array(54 + stride * h), v = new DataView(out.buffer)
      out.set([0x42, 0x4d]); v.setUint32(2, out.length, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true)
      v.setInt32(18, w, true); v.setInt32(22, -h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); out.set([b, g, r], 54 + y * stride + x * 3) }
      return out
    }
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    const blip = (i: number) => `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId${200 + i}"/></w:drawing></w:r></w:p>`
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>본문</w:t></w:r></w:p>${blip(0)}${blip(1)}</w:body></w:document>`)
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[0, 1].map(i => `<Relationship Id="rId${200 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.bmp"/>`).join("")}</Relationships>`)
    zip.file("word/media/image1.bmp", bmp(blank))
    zip.file("word/media/image2.bmp", bmp(pattern))
    const buf = await zip.generateAsync({ type: "arraybuffer" })
    const def = await parse(buf), drop = await parse(buf, { dropBlankImages: true })
    assert.ok(def.success && drop.success)
    if (!def.success || !drop.success) return
    assert.deepEqual(def.images!.map(i => i.filename), ["image_001.bmp", "image_002.bmp"])
    assert.deepEqual(drop.images!.map(i => i.filename), ["image_002.bmp"])
    assert.deepEqual(drop.blocks.filter(b => b.type === "image").map(b => b.text), ["image_002.bmp"])
    assert.deepEqual(order(drop.markdown), ["본문", "image_002.bmp"])
  })
})

describe("그림 클립은 표 칸이 아니다", () => {
  it("띠 그림마다 클립을 깔아 쌓은 상자는 1열 표가 아니라 문단이다", async () => {
    // 띠 4장(높이 20pt)을 맞대어 쌓고 그 위에 글 3줄 — 띠마다 그림 영역 그대로 클립
    const strips: [number, number, number, number, (x: number, y: number) => number[]][] = [0, 1, 2, 3].map(k => [80, 600 + k * 20, 400, 20, (x: number) => [230 - k, 236, 246 - (x % 3)]])
    const buf = pdf([[90, 665, "Article 2 Definitions"], [90, 645, "the term means"], [90, 625, "a housing area"]], strips, true)
    const r = await parse(buf, { ocr: false })
    assert.ok(r.success)
    if (!r.success) return
    assert.equal(r.blocks.filter(b => b.type === "table").length, 0, r.markdown)
    assert.ok(/Article 2 Definitions/.test(r.markdown) && /a housing area/.test(r.markdown))
  })
})
