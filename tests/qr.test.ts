import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import MarkdownIt from "markdown-it"
import { blocksToMarkdown, markdownToHwpx, parse } from "../src/index.js"
import { toHtmlTables } from "../src/html-tables.js"
import { encodePng } from "../src/image/transcode.js"
import { imagePixelCount } from "../src/qr.js"
import type { IRBlock } from "../src/types.js"

// "https://example.com/kordoc" QR (25×25 모듈, zxing-wasm writer 로 만든 것)
const URL_ = "https://example.com/kordoc"
const MODULES = [
  "#######..#.#.#..#.#######", "#.....#....######.#.....#", "#.###.#.##.##.#...#.###.#", "#.###.#.#.#..###..#.###.#",
  "#.###.#.#..###..#.#.###.#", "#.....#.#..#..##..#.....#", "#######.#.#.#.#.#.#######", "........##....#.#........",
  "#.#####....###....#####..", "...#....####.#...#.#...#.", "#..####....#.####..#.#.##", "#..###.###.##.###.##....#",
  ".#..#.##....####.##.#.###", "##...#......##..#..#.#.#.", "#.#.#.#####..#.#..####.##", "#.####.###.##.#######...#",
  "#.#...#.###.###.#####.#..", "........#..#.#.##...##...", "#######......##.#.#.#.###", "#.....#.#..#..#.#...##...",
  "#.###.#.#..##########.#..", "#.###.#.##.#..##.##.#####", "#.###.#.#.#.##.#.....##.#", "#.....#..##.....##.###..#",
  "#######.#...###..########",
]
const SCALE = 6, QUIET = 4, SIDE = (MODULES.length + QUIET * 2) * SCALE

/** QR 을 키운 RGB 표본(흰 여백 4모듈) — 한 변 `side(scale)` px */
const side = (scale: number) => (MODULES.length + QUIET * 2) * scale
function qrRgb(scale = SCALE): Uint8Array {
  const n = side(scale), rgb = new Uint8Array(n * n * 3).fill(255)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const my = Math.floor(y / scale) - QUIET, mx = Math.floor(x / scale) - QUIET
    if (MODULES[my]?.[mx] === "#") rgb.fill(0, (y * n + x) * 3, (y * n + x) * 3 + 3)
  }
  return rgb
}
function qrPng(): Uint8Array {
  const rgb = qrRgb(), rgba = new Uint8Array(SIDE * SIDE * 4)
  for (let i = 0; i < SIDE * SIDE; i++) rgba.set([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255], i * 4)
  return encodePng(SIDE, SIDE, rgba)
}

async function docxWithQr(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const blip = `<w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId200"/></w:drawing></w:r>`
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
    <w:p><w:r><w:t>신청</w:t></w:r></w:p><w:p>${blip}</w:p><w:p><w:r><w:t>끝</w:t></w:r></w:p>
  </w:body></w:document>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId200" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file("word/media/image1.png", qrPng())
  return zip.generateAsync({ type: "arraybuffer" })
}

function pdfWithQr(scale = SCALE): Buffer {
  const data = Buffer.from(qrRgb(scale)).toString("latin1"), content = `q 120 0 0 120 100 500 cm /Q Do Q BT /F1 12 Tf 72 760 Td (apply) Tj ET`
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /XObject << /Q 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /XObject /Subtype /Image /Width ${side(scale)} /Height ${side(scale)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n${data}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"; const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

const qrOf = (blocks: IRBlock[]): string[][] => {
  const out: string[][] = []
  const walk = (bs?: IRBlock[]) => { for (const b of bs ?? []) { if (b.qr) out.push(b.qr); walk(b.children); for (const row of b.table?.cells ?? []) for (const c of row) walk(c.blocks) } }
  walk(blocks)
  return out
}

describe("QR 코드 읽기 (#187, qrCodes)", () => {
  it("DOCX 그림 바이트 — 그림 다음 줄에 값. 끄면 옵션 없을 때와 같다", async () => {
    const buf = await docxWithQr()
    const off = await parse(buf), offFalse = await parse(buf, { qrCodes: false }), on = await parse(buf, { qrCodes: true })
    assert.ok(off.success && offFalse.success && on.success)
    if (!off.success || !offFalse.success || !on.success) return
    assert.deepEqual(offFalse, off)
    assert.deepEqual(qrOf(off.blocks), [])
    assert.deepEqual(qrOf(on.blocks), [[URL_]])
    assert.ok(on.markdown.includes(`![image](image_001.png)\n<${URL_}>\n`), on.markdown)
    assert.equal(on.markdown.replace(`\n<${URL_}>`, ""), off.markdown)
    // images: false — DOCX·PPTX 는 이때 그림 파일을 안 읽었다. QR 을 켜면 읽고 바이트만 뗀다
    const noImages = await parse(buf, { qrCodes: true, images: false })
    assert.ok(noImages.success)
    if (!noImages.success) return
    assert.deepEqual(qrOf(noImages.blocks), [[URL_]])
    assert.equal(noImages.images, undefined)
  })

  it("표 칸 그림의 값은 칸 안에서 <br> 로 잇는다 — GFM·HTML 표", () => {
    const image: IRBlock = { type: "image", text: "image_001.png", qr: [URL_, "BEGIN:VCARD\nN:Kim\nEND:VCARD"] }
    const table = (rows: number): IRBlock => ({ type: "table", table: { rows, cols: 2, hasHeader: false, cells: [
      [{ text: "안내", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1, blocks: [image] }],
      ...(rows > 1 ? [[{ text: "가", colSpan: 2, rowSpan: 1 }, { text: "", colSpan: 0, rowSpan: 0 }]] : []),
    ] } })
    // 값 안 줄바꿈(명함 vCard)도 칸을 깨지 않는다
    const gfm = blocksToMarkdown([table(1)], { tableFormat: "gfm" })
    assert.ok(gfm.includes(`![image](image_001.png)<br><${URL_}><br>BEGIN:VCARD<br>N:Kim<br>END:VCARD |`), gfm)
    assert.ok(blocksToMarkdown([table(2)]).includes(`<img src="image_001.png" alt="image"><br>${URL_}<br>BEGIN:VCARD<br>N:Kim<br>END:VCARD`))
  })

  it("표 밖 그림의 값은 그림 자리 문단을 끊지 않는다 — 값의 줄마다 한 줄(빈 줄 뺌), 줄머리 블록 표지는 \\", () => {
    const qr = ["BEGIN:VCARD\r\nN:홍길동\r\n\r\n  # 제목\u2028- 항목\rEND:VCARD", "- 목록", "+ 목록", "> 인용", "1. 번호", "1) 번호", "===", "---", "  ", URL_]
    const md = blocksToMarkdown([{ type: "paragraph", text: "앞" }, { type: "image", text: "image_001.png", qr }, { type: "paragraph", text: "뒤" }])
    assert.ok(md.includes([
      "![image](image_001.png)", "BEGIN:VCARD", "N:홍길동", "\\# 제목", "\\- 항목", "END:VCARD",
      "\\- 목록", "\\+ 목록", "\\> 인용", "1\\. 번호", "1\\) 번호", "\\===", "\\---", `<${URL_}>`,
    ].join("\n") + "\n\n뒤"), md)
    // GFM 파서로 읽어도 문단 셋(앞·그림+값·뒤)뿐이고 값 글자는 그대로다
    const tokens = new MarkdownIt({ html: true }).parse(md, {})
    assert.deepEqual(tokens.map(t => t.type), Array(3).fill(["paragraph_open", "inline", "paragraph_close"]).flat())
    const html = new MarkdownIt({ html: true }).render(md)
    for (const v of ["- 목록", "+ 목록", "&gt; 인용", "1. 번호", "1) 번호", "===", "---", "# 제목", "- 항목"]) assert.ok(html.includes(v), v)
  })

  it("http(s) 주소 값은 GFM 자동 링크 <…> — 링크 주소에 이스케이프 \\ 가 섞이지 않는다", () => {
    const url = "https://m.site.kr/~user/_next/v?id=1|2&x=*y*", qr = [url, "javascript:alert(1)"]
    const line = blocksToMarkdown([{ type: "image", text: "image_001.png", qr }])
    const cell = blocksToMarkdown([{ type: "table", table: { rows: 1, cols: 2, hasHeader: false, cells: [[
      { text: "안내", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1, blocks: [{ type: "image", text: "image_001.png", qr }] },
    ]] } }], { tableFormat: "gfm" })
    for (const md of [line, cell]) {
      const links = new MarkdownIt().parse(md, {}).flatMap(t => t.children ?? []).filter(t => t.type === "link_open")
      assert.deepEqual(links.map(t => decodeURI(t.attrGet("href")!)), [url], md)
      assert.ok(!md.includes("<javascript:"), md)
    }
  })

  it("후속 처리 — htmlTables·마크다운→HWPX 는 주소 글만(꺾쇠 없음)", async () => {
    const md = (await parse(await docxWithQr(), { qrCodes: true })).markdown
    const xml = await (await JSZip.loadAsync(await markdownToHwpx(md))).file("Contents/section0.xml")!.async("string")
    assert.ok(xml.includes(`>${URL_}<`) && !xml.includes("&lt;http"), xml)
    const cell = (blocks: IRBlock[]) => ({ text: "", colSpan: 1, rowSpan: 1, blocks })
    const gfm = blocksToMarkdown([{ type: "table", table: { rows: 1, cols: 2, hasHeader: false, cells: [[cell([{ type: "paragraph", text: "안내" }]), cell([{ type: "image", text: "image_001.png", qr: [URL_ + "?a=1|2"] }])]] } }], { tableFormat: "gfm" })
    // GFM 표 셀 안 URL 의 | 는 %7C (remark 는 링크 안의 \| 를 풀지 않는다)
    assert.ok(gfm.includes(`<${URL_}?a=1%7C2>`), gfm)
    const html = toHtmlTables(gfm)
    assert.ok(html.includes(`${URL_}?a=1%7C2`) && !html.includes("&lt;http"), html)
  })

  it("그림 화소 수는 헤더로 — 상한을 넘는 그림은 디코딩하지 않는다", () => {
    assert.equal(imagePixelCount(encodePng(300, 200, new Uint8Array(300 * 200 * 4))), 60_000)
    // JPEG: SOI · APP0(길이 16) · SOF0(높이 100·너비 9000)
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0, 100, 0x23, 0x28, 3])
    assert.equal(imagePixelCount(jpeg), 900_000)
    const bmp = new Uint8Array(54); bmp.set([0x42, 0x4d]); new DataView(bmp.buffer).setInt32(18, 8000, true); new DataView(bmp.buffer).setInt32(22, -6000, true)
    assert.equal(imagePixelCount(bmp), 48_000_000)
    assert.equal(imagePixelCount(Uint8Array.from([0x47, 0x49, 0x46])), 0)
  })

  it("PDF 는 디코딩한 픽셀로 읽는다 — PDFium 이 내는 큰 그림(198px)·pdfjs 가 내는 128px 이하 그림(99px), images: false 여도", async () => {
    for (const [scale, images] of [[6, true], [6, false], [3, true], [3, false]] as const) {
      const off = await parse(pdfWithQr(scale), { images, ocr: false }), on = await parse(pdfWithQr(scale), { images, ocr: false, qrCodes: true })
      assert.ok(off.success && on.success)
      if (!off.success || !on.success) return
      assert.deepEqual(qrOf(off.blocks), [])
      assert.deepEqual(qrOf(on.blocks), [[URL_]])
      assert.ok(on.markdown.includes(`![image](image_001.png)\n<${URL_}>`), on.markdown)
      assert.equal(on.markdown.replace(`\n<${URL_}>`, ""), off.markdown)
    }
  })
})
