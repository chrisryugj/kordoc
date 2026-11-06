import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import sharp from "sharp"
import { parse } from "../src/index.js"
import { bmpToRgba, encodePng } from "../src/image/transcode.js"
import { convertImages } from "../src/image/format.js"
import type { ExtractedImage, IRBlock } from "../src/types.js"

const W = 200, H = 150
/** 단순한 무늬 RGBA — WebP 로 잘 줄어든다 */
function flat(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) rgba.set([(i % W) < 100 ? 200 : 30, 90, 160, 255], i * 4)
  return rgba
}
function bmp24(rgba: Uint8Array): Uint8Array {
  const stride = (W * 3 + 3) & ~3, out = new Uint8Array(54 + stride * H), v = new DataView(out.buffer)
  out.set([0x42, 0x4d]); v.setUint32(2, out.length, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true)
  v.setInt32(18, W, true); v.setInt32(22, -H, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (y * W + x) * 4, d = 54 + y * stride + x * 3
    out.set([rgba[s + 2], rgba[s + 1], rgba[s]], d)
  }
  return out
}

/** 그림 여섯 장: BMP·PNG·잡음 JPEG·ICC 프로필 PNG·움직이는 GIF·WMF(바꿀 수 없다) */
async function docx(): Promise<{ buf: ArrayBuffer; media: Uint8Array[] }> {
  const noise = Buffer.alloc(W * H * 3); for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  const raw = { raw: { width: W, height: H, channels: 4 as const } }
  const media = [
    bmp24(flat()),
    encodePng(W, H, flat()),
    new Uint8Array(await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 20 }).toBuffer()),
    new Uint8Array(await sharp(Buffer.from(flat()), raw).withIccProfile("p3").png().toBuffer()),
    new Uint8Array(await sharp([Buffer.from(encodePng(W, H, flat())), Buffer.from(encodePng(W, H, flat().reverse()))], { join: { animated: true } }).gif().toBuffer()),
    Uint8Array.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]
  const exts = ["bmp", "png", "jpeg", "png", "gif", "wmf"]
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  const blip = (i: number) => `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId${200 + i}"/></w:drawing></w:r></w:p>`
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>그림</w:t></w:r></w:p>${media.map((_, i) => blip(i)).join("")}</w:body></w:document>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${media.map((_, i) => `<Relationship Id="rId${200 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${exts[i]}"/>`).join("")}</Relationships>`)
  media.forEach((m, i) => zip.file(`word/media/image${i + 1}.${exts[i]}`, m))
  return { buf: await zip.generateAsync({ type: "arraybuffer" }), media }
}

const rgbaOf = async (b: Uint8Array) => new Uint8Array(await sharp(b).ensureAlpha().raw().toBuffer())

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50
const isWebp = (b: Uint8Array) => Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP"

describe("원본 그림 파일 형식 맞추기 (#188, imageFormat — HWP·HWPX·HWP3·DOCX·PPTX)", () => {
  it("명시하면 모든 그림이 그 형식 — 파일명·MIME·바이트·블록·마크다운이 한 이름. 바꿀 수 없는 그림(WMF)은 원본·경고. 기본은 원본 그대로", async () => {
    const { buf, media } = await docx()
    assert.equal((await sharp(media[4], { pages: -1 }).metadata()).pages, 2, "움직이는 GIF 표본")
    const def = await parse(buf)
    assert.ok(def.success)
    if (!def.success) return
    const names = ["image_001.bmp", "image_002.png", "image_003.jpeg", "image_004.png", "image_005.gif", "image_006.wmf"]
    assert.deepEqual(def.images!.map(i => i.filename), names)
    for (const [k, m] of media.entries()) assert.deepEqual(def.images![k].data, m)
    for (const format of ["png", "webp"] as const) {
      const r = await parse(buf, { imageFormat: format })
      assert.ok(r.success)
      if (!r.success) return
      const want = names.map((n, k) => (k === 5 ? n : n.replace(/\.[^.]+$/, "." + format)))
      assert.deepEqual(r.images!.map(i => i.filename), want, format)
      assert.deepEqual(r.images!.map(i => i.mimeType), want.map((_, k) => (k === 5 ? "image/wmf" : "image/" + format)))
      for (const k of [0, 1, 2, 3, 4]) assert.ok((format === "png" ? isPng : isWebp)(r.images![k].data), `${format} ${k}`)
      // 결과 JSON(워커 protocol)에서 Buffer 는 {type, data} 로 바뀐다 — 순수 Uint8Array 여야 한다
      for (const img of r.images!) assert.ok(!Buffer.isBuffer(img.data), `${format} ${img.filename} Buffer`)
      assert.deepEqual(r.images![5].data, media[5])
      // 화소: BMP·PNG 는 원본과 같다. 이미 PNG 인 그림은 바이트 그대로
      assert.deepEqual(await rgbaOf(r.images![0].data), bmpToRgba(media[0])!.data)
      assert.deepEqual(await rgbaOf(r.images![1].data), await rgbaOf(media[1]))
      if (format === "png") { assert.deepEqual(r.images![1].data, media[1]); assert.deepEqual(r.images![3].data, media[3]) }
      assert.deepEqual(r.blocks.filter(b => b.type === "image").map(b => b.text), want)
      let md = def.markdown
      for (const [k, n] of names.entries()) md = md.replace(`(${n})`, `(${want[k]})`)
      assert.equal(r.markdown, md)
      assert.ok(r.warnings?.some(w => w.message.includes(`그림 1개는 ${format.toUpperCase()} 로 바꾸지 못해`) && w.message.includes("image/wmf")), format)
    }
    // images: false 면 바꾸지 않는다
    const none = await parse(buf, { imageFormat: "webp", images: false })
    assert.ok(none.success && none.markdown === def.markdown)
  })

  it("글에 박힌 참조(표 칸 글·머리말 문단·각주·캡션의 \"![image](이름)\")도 바꾼 이름으로 고친다", async () => {
    const images: ExtractedImage[] = [{ filename: "image_001.bmp", data: bmp24(flat()), mimeType: "image/bmp" }, { filename: "image_002.wmf", data: new Uint8Array(10), mimeType: "image/wmf" }]
    const ref = "![image](image_001.bmp) / ![image](image_002.wmf)", fixed = "![image](image_001.webp) / ![image](image_002.wmf)"
    const blocks: IRBlock[] = [
      { type: "paragraph", text: ref, footnoteText: ref },
      { type: "table", table: { rows: 1, cols: 1, caption: ref, cells: [[{ text: ref, colSpan: 1, rowSpan: 1, blocks: [{ type: "image", text: "image_001.bmp" }] }]] } },
    ]
    assert.equal(await convertImages(blocks, images, "webp", []), true)
    assert.deepEqual([blocks[0].text, blocks[0].footnoteText, blocks[1].table!.caption, blocks[1].table!.cells[0][0].text, blocks[1].table!.cells[0][0].blocks![0].text], [fixed, fixed, fixed, fixed, "image_001.webp"])
  })
})
