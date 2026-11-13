import { it } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { parse } from "../src/index.js"

/** 2×2 RGB 그림 + 16×16 SMask(왼쪽 절반 alpha 0) 한 쪽 */
function smaskLargerPdf(): Buffer {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), a = Buffer.alloc(256)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) a[y * 16 + x] = x < 8 ? 0 : 255
  const content = "q 80 0 0 80 100 600 cm /A Do Q"
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /A 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R /Length 12 >>\nstream\n${rgb.toString("latin1")}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 256 >>\nstream\n${a.toString("latin1")}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"; const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

it("SMask 가 그림보다 크면 pdf.js 처럼 큰 쪽 크기로 둘 다 가까운 화소로 늘린다", async () => {
  // 그림 크기(2×2)로 내면 alpha 를 잃고 MIN_DIM(8) 에 걸려 그림이 빠진다 — 아이콘·로고에서 흔하다
  const r = await parse(smaskLargerPdf(), { ocr: false })
  assert.ok(r.success)
  if (!r.success) return
  assert.equal(r.images?.length, 1)
  const { data, info } = await sharp(r.images![0].data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], [16, 16])
  const px = (x: number, y: number) => [...data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
  assert.deepEqual([px(0, 0), px(15, 0), px(0, 15), px(15, 15)], [[255, 0, 0, 0], [0, 255, 0, 255], [0, 0, 255, 0], [255, 255, 255, 255]])
})
