import { describe, it } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { parse } from "../src/index.js"
import { inlineImagesIntoMarkdown } from "../src/image/transcode.js"

/** 그림 둘 — A: 40×30 RGB + SMask(왼쪽 절반 alpha 0, 그 아래 RGB 는 0 이 아님 → pdfjs 경로), B: 200×150 RGB(PDFium 경로) */
function pdfWithImages(): { pdf: Buffer; originals: Uint8Array[] } {
  const make = (w: number, h: number, seed: number, alpha?: (x: number) => number) => {
    const rgb = Buffer.alloc(w * h * 3), a = Buffer.alloc(w * h), rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = [(x * 255 / w) | 0, (y * 255 / h) | 0, seed], al = alpha ? alpha(x) : 255
      rgb.set(v, i * 3); a[i] = al; rgba.set([...v, al], i * 4)
    }
    return { rgb, a, rgba }
  }
  const A = make(40, 30, 77, x => (x < 20 ? 0 : 200)), B = make(200, 150, 9)
  const img = (w: number, h: number, data: Buffer, extra = "") =>
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8${extra} /Length ${data.length} >>\nstream\n${data.toString("latin1")}\nendstream`
  const content = "q 80 0 0 60 100 600 cm /A Do Q q 200 0 0 150 100 300 cm /B Do Q BT /F1 12 Tf 72 760 Td (images) Tj ET"
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /A 6 0 R /B 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    img(40, 30, A.rgb, " /SMask 8 0 R"), img(200, 150, B.rgb),
    `<< /Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${A.a.length} >>\nstream\n${A.a.toString("latin1")}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"; const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return { pdf: Buffer.from(pdf, "latin1"), originals: [A.rgba, B.rgba] }
}

const decode = async (b: Uint8Array) => new Uint8Array((await sharp(b).ensureAlpha().raw().toBuffer()))

describe("PDF 그림 WebP (#188, imageFormat)", () => {
  it("무손실 WebP 를 디코딩하면 원본 RGBA 와 같다 — 완전 투명 화소의 RGB 포함(exact). 기본은 PNG 그대로", async () => {
    const { pdf, originals } = pdfWithImages()
    const def = await parse(pdf, { ocr: false }), png = await parse(pdf, { ocr: false, imageFormat: "png" }), webp = await parse(pdf, { ocr: false, imageFormat: "webp" })
    assert.ok(def.success && png.success && webp.success)
    if (!def.success || !png.success || !webp.success) return
    assert.equal(png.markdown, def.markdown)
    assert.deepEqual(png.images, def.images)
    assert.deepEqual(png.images!.map(i => [i.filename, i.mimeType]), [["image_001.png", "image/png"], ["image_002.png", "image/png"]])
    assert.deepEqual(webp.images!.map(i => [i.filename, i.mimeType]), [["image_001.webp", "image/webp"], ["image_002.webp", "image/webp"]])
    assert.equal(webp.markdown, png.markdown.replaceAll(".png)", ".webp)"))
    for (const [k, original] of originals.entries()) {
      assert.deepEqual(await decode(webp.images![k].data), original, webp.images![k].filename)
      assert.deepEqual(await decode(png.images![k].data), original, png.images![k].filename)
    }
    // A 의 투명 화소(0,0)는 alpha 0 이고 RGB 가 남아 있다
    assert.deepEqual([...originals[0].subarray(0, 4)], [0, 0, 77, 0])
    // images: false 면 인코딩하지 않는다
    const none = await parse(pdf, { ocr: false, images: false, imageFormat: "webp" })
    assert.ok(none.success && none.images === undefined && none.markdown.includes("image_001.png"))
  })

  it("WebP 한도(가로·세로 16,383px)를 넘는 그림은 PNG 로 낸다 — 파싱은 계속된다", async () => {
    const w = 16_400, h = 8, rgb = Buffer.alloc(w * h * 3, 0x5a)
    const content = "q 500 0 0 4 50 400 cm /W Do Q BT /F1 12 Tf 72 760 Td (wide) Tj ET"
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /W 6 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n${rgb.toString("latin1")}\nendstream`,
    ]
    let pdf = "%PDF-1.4\n"; const offsets: number[] = []
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
    const xref = Buffer.byteLength(pdf, "latin1")
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const r = await parse(Buffer.from(pdf, "latin1"), { ocr: false, imageFormat: "webp" })
    assert.ok(r.success)
    if (!r.success) return
    assert.deepEqual(r.images!.map(i => [i.filename, i.mimeType]), [["image_001.png", "image/png"]])
    assert.ok(r.markdown.includes("image_001.png"))
    assert.equal((await sharp(r.images![0].data).metadata()).format, "png")
    assert.ok(r.warnings?.some(w => w.message.includes("16,383px") && w.message.includes("1개")))
  })

  it("WebP 인코딩이 실패한 그림은 PNG 로 낸다 — 파일명·MIME·바이트·마크다운·블록이 한 이름", async () => {
    const { pdf, originals } = pdfWithImages()
    const proto = sharp.prototype as unknown as { webp: unknown }
    const webp = proto.webp
    proto.webp = () => { throw new Error("mock") }
    let r: Awaited<ReturnType<typeof parse>>
    try { r = await parse(pdf, { ocr: false, imageFormat: "webp" }) } finally { proto.webp = webp }
    assert.ok(r.success)
    if (!r.success) return
    assert.deepEqual(r.images!.map(i => [i.filename, i.mimeType]), [["image_001.png", "image/png"], ["image_002.png", "image/png"]])
    for (const [k, original] of originals.entries()) {
      assert.equal((await sharp(r.images![k].data).metadata()).format, "png")
      assert.deepEqual(await decode(r.images![k].data), original)
    }
    const names = ["image_001.png", "image_002.png"]
    assert.deepEqual(r.blocks.filter(b => b.type === "image").map(b => b.text), names)
    for (const n of names) assert.ok(r.markdown.includes(`(${n})`), n)
    assert.ok(!r.markdown.includes(".webp"))
    assert.ok(r.warnings?.some(w => w.message.includes("WebP 인코딩 실패로 그림 2개")))
  })

  it("inlineImages 는 WebP 바이트를 다시 인코딩하지 않고 data:image/webp 로 싣는다. PDF 는 inlineImages 대상이 아니라 참조를 둔다", async () => {
    const { pdf } = pdfWithImages()
    const r = await parse(pdf, { ocr: false, imageFormat: "webp", inlineImages: true })
    assert.ok(r.success)
    if (!r.success) return
    assert.ok(r.markdown.includes("(image_001.webp)") && !r.markdown.includes("data:"))
    const md = inlineImagesIntoMarkdown(r.markdown, r.images!, { compress: true })
    for (const img of r.images!) assert.ok(md.includes(`(data:image/webp;base64,${Buffer.from(img.data).toString("base64")})`), img.filename)
  })
})
