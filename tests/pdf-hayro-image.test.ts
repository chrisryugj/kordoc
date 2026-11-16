import { it } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { deflateSync } from "node:zlib"
import { parse } from "../src/index.js"
import { openHayro } from "../src/pdf/hayro.js"
import { encodePng } from "../src/image/transcode.js"

function buildPdf(objs: string[]): Buffer {
  let pdf = "%PDF-1.4\n"; const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

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
  return buildPdf(objs)
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

it("한 쪽 그림이 디코딩 상한(128MB)을 넘어도 그림을 물으면 모두 준다", async () => {
  const z = deflateSync(Buffer.alloc(3000 * 3000 * 3, 0x55)).toString("latin1")
  const img = `<< /Type /XObject /Subtype /Image /Width 3000 /Height 3000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n${z}\nendstream`
  const content = [0, 1, 2, 3, 4].map(i => `q 80 0 0 80 ${i * 90} 600 cm /I${i} Do Q`).join(" ")
  const doc = await openHayro(buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << ${[0, 1, 2, 3, 4].map(i => `/I${i} ${5 + i} 0 R`).join(" ")} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, img, img, img, img, img,
  ]))
  doc.events(0)
  assert.deepEqual([5, 6, 7, 8, 9].map(n => doc.image(`g_hy_${n}_0`)?.width), [3000, 3000, 3000, 3000, 3000])
})

it("그림 번호와 쪽은 처음 그린 순서 — Form XObject 안·여러 쪽 반복·같은 쪽에서 다시 그린 그림", async () => {
  const stream = (dict: string, data: string) => `${dict.replace(/>>\s*$/, ` /Length ${Buffer.byteLength(data, "latin1")} >>`)}\nstream\n${data}\nendstream`
  /** 가로 그러데이션 RGB 표본(압축 없음) */
  const rgb = (w: number, h: number, seed: number) => {
    const raw = Buffer.alloc(w * h * 3), rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const v = [(i % w) * 255 / w, (Math.floor(i / w) * 255) / h, seed].map(Math.round)
      raw.set(v, i * 3); rgba.set([...v, 255], i * 4)
    }
    return { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 >>`, data: raw.toString("latin1"), png: encodePng(w, h, rgba) }
  }
  const a = rgb(200, 150, 10), b = rgb(160, 300, 20), small = rgb(40, 40, 30), last = rgb(48, 48, 40)
  const draw = (name: string) => `q 100 0 0 80 100 500 cm /${name} Do Q\n`
  // 쪽 객체 3·5·7·9, 내용 4·6·8·10, 그림 A 11·B 12·S 13, 폼 F 14(안에 B), 그림 T 15
  const pages = [
    { content: draw("A") + draw("S"), res: "/A 11 0 R /S 13 0 R" },
    { content: draw("F") + draw("A"), res: "/A 11 0 R /F 14 0 R" },
    { content: draw("A") + draw("F"), res: "/A 11 0 R /F 14 0 R" },
    { content: draw("A") + draw("A") + draw("T"), res: "/A 11 0 R /T 15 0 R" },
  ]
  const r = await parse(buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.flatMap((p, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << ${p.res} >> >> /Contents ${4 + i * 2} 0 R >>`, stream("<< >>", p.content)]),
    stream(a.dict, a.data), stream(b.dict, b.data), stream(small.dict, small.data),
    stream("<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /B 12 0 R >> >> >>", "/B Do"),
    stream(last.dict, last.data),
  ]), { ocr: false })
  assert.ok(r.success)
  if (!r.success) return
  assert.deepEqual(r.blocks.filter(x => x.type === "image").map(x => [x.pageNumber, x.text]),
    [[1, "image_001.png"], [1, "image_002.png"], [2, "image_003.png"], [4, "image_004.png"]])
  assert.deepEqual(r.images?.map(x => Buffer.from(x.data)), [a.png, small.png, b.png, last.png].map(x => Buffer.from(x)))
})
