/**
 * 이미지 무음 유실 복구 테스트 (v4.0.8)
 *
 * 코퍼스 실측에서 발견된 4포맷 유실 케이스 재현:
 * - HWPX: 꼬리말/머리말 안 pic·borderFill imgBrush 배경 등 본문 워크 미도달 BinData 스윕
 * - HWP5: pic 컨트롤이 참조하지 않는 BinData 이미지 스윕
 * - DOCX: w:object 안 v:imagedata(r:id) 추출 + mc:Fallback 사본 제외 유지
 * - PDF: 이미지 XObject 픽셀 → PNG 인코딩 (비동기 디코딩 대기 포함)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { extractHwp5Images } from "../src/hwp5/images.js"
import { extractPageImages, injectPageImageBlocks, createPdfImageState } from "../src/pdf/image-extract.js"
import { parse } from "../src/index.js"
import type { IRBlock, ParseWarning } from "../src/types.js"

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ─── HWPX ───────────────────────────────────────────

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function sec(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`
}

function para(text: string): string {
  return `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`
}

async function makeHwpx(sectionXml: string, binData: Record<string, Uint8Array> = {}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", sectionXml)
  for (const [name, data] of Object.entries(binData)) zip.file(name, data)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("HWPX 본문 미참조 BinData 스윕", () => {
  it("pic이 참조하지 않는 BinData 이미지를 문서 끝 image 블록으로 보강한다", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("본문")), { "BinData/image1.png": PNG_STUB }))

    assert.equal(result.images?.length, 1, "스윕 추출")
    assert.equal(result.blocks.at(-1)?.type, "image", "문서 끝 image 블록")
    assert.ok(result.markdown.includes("![image](image_001.png)"), "마크다운 참조 보강")
  })

  it("이미지가 아닌 BinData(OLE 등)는 스윕하지 않는다", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(para("본문")), { "BinData/ole1.bin": new Uint8Array(16) }))

    assert.equal(result.images, undefined, "비이미지 미추출")
  })

  it("본문이 참조한 이미지는 스윕에서 중복 추출하지 않는다", async () => {
    const pic = `<hp:pic id="1"><hp:img binaryItemIDRef="image1"/></hp:pic>`
    const body = `<hp:p id="0"><hp:run>${pic}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { "BinData/image1.png": PNG_STUB }))

    assert.equal(result.images?.length, 1, "1회만 추출")
  })

  it("pages 옵션(부분 파싱) 시에는 스윕하지 않는다", async () => {
    const result = await parseHwpxDocument(
      await makeHwpx(sec(para("본문")), { "BinData/image1.png": PNG_STUB }),
      { pages: "1" },
    )

    assert.equal(result.images, undefined, "부분 파싱은 스윕 없음")
  })
})

// ─── HWP5 ───────────────────────────────────────────

describe("HWP5 본문 미참조 BinData 스윕", () => {
  it("image 블록이 없어도 BinData 이미지를 보강한다 (blank.hwp 케이스)", () => {
    const blocks: IRBlock[] = []
    const warnings: ParseWarning[] = []
    const images = extractHwp5Images([{ name: "BIN0001.png", content: Buffer.from(PNG_STUB) }], blocks, warnings, true)

    assert.equal(images.length, 1)
    assert.equal(images[0].mimeType, "image/png")
    assert.equal(blocks.at(-1)?.type, "image")
  })

  it("이미지 아닌 BinData 스트림은 스윕하지 않는다", () => {
    const blocks: IRBlock[] = []
    const images = extractHwp5Images([{ name: "BIN0001.ole", content: Buffer.from(new Uint8Array(16)) }], blocks, [], true)

    assert.equal(images.length, 0)
    assert.equal(blocks.length, 0)
  })

  it("스윕 비활성(부분 파싱) 시 미참조 BinData를 건드리지 않는다", () => {
    const blocks: IRBlock[] = []
    const images = extractHwp5Images([{ name: "BIN0001.png", content: Buffer.from(PNG_STUB) }], blocks, [], false)

    assert.equal(images.length, 0)
  })
})

// ─── DOCX ───────────────────────────────────────────

async function makeDocx(bodyXml: string, relationships: string, files: Record<string, Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships}
</Relationships>`)
  for (const [path, data] of Object.entries(files)) zip.file(path, data)
  return await zip.generateAsync({ type: "arraybuffer" })
}

const IMG_REL = (id: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`

describe("DOCX v:imagedata 추출", () => {
  it("w:object 안 v:imagedata(r:id)를 본문 위치에 추출한다", async () => {
    const body = `<w:p><w:r><w:object><v:shape><v:imagedata r:id="rId8"/></v:shape></w:object></w:r></w:p><w:p><w:r><w:t>뒤 문단</w:t></w:r></w:p>`
    const result = await parse(await makeDocx(body, IMG_REL("rId8", "media/image1.wmf"), { "word/media/image1.wmf": PNG_STUB }))

    assert.ok(result.success)
    assert.equal(result.images?.length, 1, "OLE 미리보기 이미지 추출")
    assert.equal(result.images?.[0].mimeType, "image/wmf")
    const imgIdx = result.markdown.indexOf("![image](image_001.wmf)")
    assert.ok(imgIdx >= 0 && imgIdx < result.markdown.indexOf("뒤 문단"), "본문 순서 위치에 인라인")
  })

  it("mc:Fallback 안 v:imagedata는 Choice(blip) 사본이므로 추출하지 않는다", async () => {
    const body = `<w:p><w:r><mc:AlternateContent>` +
      `<mc:Choice Requires="wps"><w:drawing><a:blip r:embed="rId10"/></w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId9"/></v:shape></w:pict></mc:Fallback>` +
      `</mc:AlternateContent></w:r></w:p>`
    const result = await parse(await makeDocx(body,
      IMG_REL("rId10", "media/image3.png") + IMG_REL("rId9", "media/image2.png"),
      { "word/media/image3.png": PNG_STUB, "word/media/image2.png": PNG_STUB }))

    assert.ok(result.success)
    assert.equal(result.images?.length, 1, "Choice blip만 추출 (Fallback 사본 제외)")
  })
})

// ─── PDF ────────────────────────────────────────────

/** pdfjs OPS 상수 (image-extract.ts와 동일 소스) */
import { OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"

/** 콜백형 get()을 갖는 가짜 PDFObjects — 비동기 해제 시뮬레이션 */
function fakePage(objects: Record<string, unknown>) {
  const store = {
    get(id: string, cb?: (d: unknown) => void) {
      const data = objects[id] ?? null
      if (cb) { setTimeout(() => cb(data), 0); return undefined }
      return data
    },
  }
  return { objs: store, commonObjs: store }
}

function rgbImage(w: number, h: number) {
  return { width: w, height: h, kind: ImageKind.RGB_24BPP, data: new Uint8Array(w * h * 3).fill(128) }
}

describe("PDF 이미지 XObject 추출", () => {
  it("getOperatorList 이후 비동기 해제되는 이미지를 PNG로 추출한다", async () => {
    const page = fakePage({ img_p0_1: rgbImage(16, 16) })
    const state = createPdfImageState()
    const { blocks, images } = await extractPageImages(page, [OPS.paintImageXObject], [["img_p0_1"]], 1, state, [])

    assert.equal(images.length, 1)
    assert.ok(images[0].data.length > 8)
    // PNG 시그니처
    assert.deepEqual([...images[0].data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.equal(blocks[0].type, "image")
    assert.equal(blocks[0].pageNumber, 1)
  })

  it("장식 조각(8px 미만)과 이전 페이지 동일 내용(로고)은 재추출하지 않는다", async () => {
    const state = createPdfImageState()
    const logo = rgbImage(32, 32)
    const p1 = await extractPageImages(fakePage({ a: logo, tiny: rgbImage(4, 4) }),
      [OPS.paintImageXObject, OPS.paintImageXObject], [["a"], ["tiny"]], 1, state, [])
    const p2 = await extractPageImages(fakePage({ b: logo }), [OPS.paintImageXObject], [["b"]], 2, state, [])

    assert.equal(p1.images.length, 1, "장식 조각 제외")
    assert.equal(p2.images.length, 0, "페이지 간 동일 내용 dedupe")
  })

  it("GRAYSCALE_1BPP 비트 패킹을 언팩한다", async () => {
    const w = 9, h = 2, stride = 2 // ceil(9/8)=2
    const data = new Uint8Array(stride * h).fill(0xff)
    const page = fakePage({ g: { width: w, height: h, kind: ImageKind.GRAYSCALE_1BPP, data } })
    const { images } = await extractPageImages(page, [OPS.paintImageXObject], [["g"]], 1, createPdfImageState(), [])

    assert.equal(images.length, 0, "8px 미만 높이는 장식 필터") // h=2 < MIN_DIM
    const page2 = fakePage({ g: { width: 16, height: 16, kind: ImageKind.GRAYSCALE_1BPP, data: new Uint8Array(2 * 16).fill(0xff) } })
    const r2 = await extractPageImages(page2, [OPS.paintImageXObject], [["g"]], 1, createPdfImageState(), [])
    assert.equal(r2.images.length, 1, "1bpp 언팩 추출")
  })

  it("injectPageImageBlocks가 페이지 경계 표 병합을 깨지 않고 페이지 말미에 주입한다", () => {
    // 병합 후 상태: 1페이지 표(2페이지에 걸침) + 2페이지 문단
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "p1", pageNumber: 1 },
      { type: "table", text: "", pageNumber: 1 },
      { type: "paragraph", text: "p2", pageNumber: 2 },
    ]
    const imgs = new Map<number, IRBlock[]>([
      [1, [{ type: "image", text: "image_001.png", pageNumber: 1 }]],
      [3, [{ type: "image", text: "image_002.png", pageNumber: 3 }]], // 텍스트 없는 페이지
    ])
    injectPageImageBlocks(blocks, imgs)

    assert.deepEqual(blocks.map(b => b.text), ["p1", "", "image_001.png", "p2", "image_002.png"])
  })
})
