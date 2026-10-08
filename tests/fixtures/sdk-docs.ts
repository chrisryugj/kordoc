/**
 * SDK·parse-worker 합성 문서 — 외부 코퍼스 없이 CI 에서 만든다.
 * Node 테스트가 직접 쓰고, SDK 잡은 `node --import tsx tests/fixtures/sdk-docs.ts <out>` 으로 문서와
 * Node `parse()` 기대 결과(expected/*.json)를 함께 만들어 결과 동등성을 대조한다.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../../src/index.js"
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
  for (const c of SDK_CASES) {
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
