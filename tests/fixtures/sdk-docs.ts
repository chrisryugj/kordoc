/**
 * SDK·parse-worker 합성 문서 — 외부 코퍼스 없이 CI 에서 만든다.
 * Node 테스트가 직접 쓰고, SDK 잡은 `node --import tsx tests/fixtures/sdk-docs.ts <out>` 으로 문서와
 * Node `parse()` 기대 결과(expected/*.json)를 함께 만들어 결과 동등성을 대조한다.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../../src/index.js"
import { OCR_HANDWRITING_REC_DICT, OCR_HANDWRITING_REC_MODEL, OCR_REC_MODEL, ocrModelPath, ocrModelsCached } from "../../src/ocr/models.js"
import type { ParseOptions } from "../../src/types.js"

export const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 22, 33, 44, 55, 66])

/** 본문 글 + 이미지 1개 DOCX */
export async function imageDocx(bodyText = "이미지 포함 문서"): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
      </pic:pic>
    </a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  </w:body>
</w:document>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`)
  zip.file("word/media/image1.png", IMAGE_BYTES)
  return zip.generateAsync({ type: "nodebuffer" })
}

/** 4단 중첩 표 + rowSpan 2·3 혼재 표 HWPX (tableFormat "gfm" 대조용) */
export async function gfmTablesHwpx(): Promise<Buffer> {
  const nest = (n: number): string => n === 0 ? "" :
    `<table><tr><td>L${n} 항목</td><td>L${n} 내용${n > 1 ? "<br>" + nest(n - 1) : ""}</td></tr>` +
    `<tr><td>L${n} 비고</td><td>L${n} 값</td></tr></table>`
  const merged = "<table><tr><td>구분</td><td>항목</td><td>금액</td></tr>" +
    "<tr><td rowspan=\"3\">인건비</td><td>책임</td><td>100</td></tr><tr><td>선임</td><td>80</td></tr><tr><td>연구원</td><td>60</td></tr>" +
    "<tr><td rowspan=\"2\">운영비</td><td colspan=\"2\">임차·위탁</td></tr><tr><td>소모품</td><td>5</td></tr></table>"
  return Buffer.from(await markdownToHwpx(`# 예산\n\n${nest(4)}\n\n${merged}\n`))
}

/** 한 쪽 PDF — startxref 를 어긋나게 해 pdfjs 가 경고를 내며 복구한다(stdout 채널 회귀용) */
export function badXrefPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 200 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xrefPos = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos + 7}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** 쪽마다 글 한 줄(텍스트층)인 PDF — sizes 는 쪽별 [가로, 세로] pt. 글이 20자를 넘어 OCR 대상이 아니다 */
export function textPdf(sizes: Array<[number, number]>): Buffer {
  const content = "BT /F1 6 Tf 10 40 Td (Native text layer line with enough characters) Tj ET"
  const kids = sizes.map((_, i) => `${4 + i * 2} 0 R`).join(" ")
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${sizes.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...sizes.flatMap(([w, h], i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xrefPos = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** 5×3 24비트 BMP — (x, y) 화소는 tinyBmpColor(x, y) */
export const TINY_BMP = { width: 5, height: 3 } as const
export const tinyBmpColor = (x: number, y: number): [number, number, number] => [x * 50, y * 100, 255 - x * 40 - y * 20]
export function tinyBmp(): Buffer {
  const { width: w, height: h } = TINY_BMP
  const row = (w * 3 + 3) & ~3, out = Buffer.alloc(54 + row * h)
  out.write("BM"); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = tinyBmpColor(x, y), o = 54 + (h - 1 - y) * row + x * 3
    out[o] = b; out[o + 1] = g; out[o + 2] = r
  }
  return out
}

/** 글자 없이 JPEG 한 장만 찍힌 한 쪽 PDF (스캔본 꼴) — 쪽 w×h pt, 그림은 그 두 배 픽셀 */
export function imagePdf(jpeg: Buffer, w: number, h: number): Buffer {
  const parts: Buffer[] = []
  const offsets: number[] = []
  let len = 0
  const push = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b; parts.push(buf); len += buf.length }
  const obj = (n: number, body: string, stream?: Buffer) => {
    offsets[n] = len
    push(`${n} 0 obj\n${body}`)
    if (stream) { push("\nstream\n"); push(stream); push("\nendstream") }
    push("\nendobj\n")
  }
  const content = Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, "latin1")
  push("%PDF-1.4\n")
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w * 2} /Height ${h * 2} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg)
  obj(5, `<< /Length ${content.length} >>`, content)
  const xref = len
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

/** 텍스트층 글 두 줄 + 아래쪽에 글 그림(JPEG 840×260) 한 장인 한 쪽 PDF(420×300pt) — 그림 영역만 읽는 쪽(regionsOnly) */
export function figurePdf(jpeg: Buffer): Buffer {
  const parts: Buffer[] = []
  const offsets: number[] = []
  let len = 0
  const push = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b; parts.push(buf); len += buf.length }
  const obj = (n: number, body: string, stream?: Buffer) => {
    offsets[n] = len
    push(`${n} 0 obj\n${body}`)
    if (stream) { push("\nstream\n"); push(stream); push("\nendstream") }
    push("\nendobj\n")
  }
  // 텍스트층 글이 20자를 넘어야 low_text(쪽 전체 OCR)가 아니라 그림 영역만 읽는 쪽이 된다
  const content = Buffer.from("BT /F1 16 Tf 30 250 Td (Native text layer line) Tj 0 -24 Td (with enough characters to count) Tj ET q 420 0 0 130 0 20 cm /Im0 Do Q", "latin1")
  push("%PDF-1.4\n")
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 6 0 R >> /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>")
  obj(4, `<< /Type /XObject /Subtype /Image /Width 840 /Height 260 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg)
  obj(5, `<< /Length ${content.length} >>`, content)
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const xref = len
  push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}`)
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

/** OCR 줄 대조용 글 두 줄 그림 (840×260 px) */
export const SCAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="260"><rect width="840" height="260" fill="white"/>` +
  `<text x="40" y="100" font-size="56" font-family="sans-serif">대한민국 정부 2026</text>` +
  `<text x="40" y="200" font-size="40" font-family="sans-serif">문서 검증 테스트</text></svg>`

/** SCAN_SVG 를 PNG 와 스캔 PDF(420×130pt) 로 — sharp 가 없으면 null */
export async function scanFixtures(): Promise<{ png: Buffer; pdf: Buffer } | null> {
  let sharp: typeof import("sharp")["default"]
  try { sharp = (await import("sharp")).default } catch { return null }
  return {
    png: await sharp(Buffer.from(SCAN_SVG)).png().toBuffer(),
    pdf: imagePdf(await sharp(Buffer.from(SCAN_SVG)).jpeg().toBuffer(), 420, 130),
  }
}

/** 내장 OCR 대조 — 모델이 캐시에 있을 때만(CI 는 모델이 없어 빠진다). 로컬 rec 파일 옵션까지 SDK 를 지나게 캐시의 rec 를 그 SHA-256 으로 준다 */
async function ocrCases(): Promise<typeof SDK_CASES> {
  if (!(await ocrModelsCached())) return []
  const scan = await scanFixtures()
  if (!scan) return []
  const rec = ocrModelPath(OCR_REC_MODEL)
  const sha256 = createHash("sha256").update(readFileSync(rec)).digest("hex")
  return [
    { name: "pdf-ocr-lines", file: "스캔 문서.pdf", build: () => scan.pdf,
      options: { ocr: true, ocrLines: "all", ocrDet: "mobile", ocrDetLongSide: 1280, ocrRec: { path: rec, sha256 } } },
    { name: "image-ocr-lines", file: "스캔 그림.png", build: () => scan.png, options: { ocrLines: true } },
    { name: "image-ocr-candidates", file: "스캔 그림.png", build: () => scan.png, options: { ocrLines: "all", ocrLineCandidates: 3 } },
    // 손글씨 rec 프리셋 — 그 모델도 캐시에 있을 때만
    ...[OCR_HANDWRITING_REC_MODEL, OCR_HANDWRITING_REC_DICT].every(s => existsSync(ocrModelPath(s)))
      ? [{ name: "pdf-ocr-handwriting", file: "수기 스캔.pdf", build: () => scan.pdf, options: { ocr: true, ocrLines: "all", ocrRec: "handwriting" } } as const]
      : [],
  ]
}

/** 페이지 이미지(pageImages) 대조 — OCR 없이, sharp·pdfium 이 있을 때만. 이미지 입력은 PNG, PDF 는 WebP 로 받아 두 형식이 SDK 를 지난다 */
async function pageImageCases(): Promise<typeof SDK_CASES> {
  try { await import("sharp"); await import("@hyzyla/pdfium") } catch { return [] }
  return [
    { name: "image-page-images", file: "페이지.bmp", build: tinyBmp, options: { ocr: false, pageImages: true } },
    { name: "pdf-page-images-webp", file: "페이지.pdf", build: () => textPdf([[300, 300], [200, 100]]), options: { ocr: false, pageImages: "webp" } },
  ]
}

/** SDK 결과 동등성 대조 목록 — 파일 이름, 만드는 법, 대조할 옵션 */
export const SDK_CASES: { name: string; file: string; build: () => Promise<Buffer> | Buffer; options: ParseOptions }[] = [
  { name: "docx-image", file: "이미지 문서.docx", build: () => imageDocx(), options: {} },
  { name: "hwpx-gfm", file: "중첩 표.hwpx", build: gfmTablesHwpx, options: { tableFormat: "gfm" } },
  { name: "hwpx-default", file: "중첩 표.hwpx", build: gfmTablesHwpx, options: {} },
  { name: "pdf", file: "bad xref.pdf", build: badXrefPdf, options: {} },
  // 응답 한 줄이 수 MB — SDK readline 상한·UTF-8 해독
  { name: "docx-big", file: "큰 문서.docx", build: () => imageDocx("가나다라마바사 ".repeat(300_000)), options: { images: false } },
]

/** 문서와 Node parse() 기대 결과를 out 에 쓴다 — expected/<name>.json 은 parse-worker inline 전송과 같은 직렬화(이미지 base64) */
export async function writeSdkFixtures(out: string): Promise<void> {
  mkdirSync(join(out, "expected"), { recursive: true })
  const manifest = []
  for (const c of [...SDK_CASES, ...await pageImageCases(), ...await ocrCases()]) {
    const path = join(out, c.file)
    writeFileSync(path, await c.build())
    const result = await parse(path, { ...c.options })
    const json = JSON.stringify(result, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v)
    writeFileSync(join(out, "expected", `${c.name}.json`), json)
    manifest.push({ name: c.name, file: c.file, options: c.options })
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv[2]
  if (!out) { process.stderr.write("usage: sdk-docs.ts <out-dir>\n"); process.exit(2) }
  await writeSdkFixtures(resolve(out))
}
