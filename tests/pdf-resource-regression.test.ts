import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { parse } from "../src/index.js"
import { buildTableGrids } from "../src/pdf/table-grid.js"
import { normalizeItems, filterHiddenText, type NormItem, type PdfTextItem } from "../src/pdf/text-line.js"
import { createPdfImageState, extractPageImages, injectPageImageBlocks } from "../src/pdf/image-extract.js"
import type { IRBlock, IRTable, ParseWarning } from "../src/types.js"

// ─── 합성 PDF ─────────────────────────────────────────

const stream = (dict: string, data: string): string => `${dict.replace(/>>\s*$/, ` /Length ${Buffer.byteLength(data, "latin1")} >>`)}\nstream\n${data}\nendstream`

/** 객체 본문 목록(1번부터) → PDF 바이트 */
function pdfFrom(objects: string[], trailerExtra = ""): Buffer {
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(pdf, "latin1")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

interface Pg { content: string; box?: string; res?: string }
/** 1 카탈로그, 2 쪽 트리, 3 Helvetica, 쪽마다 쪽 객체 + 내용 스트림, 그 뒤 extra (번호 4 + 2×쪽수 부터) */
function simplePdf(pages: Pg[], extra: string[] = []): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]
  pages.forEach((p, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R ${p.box ?? "/MediaBox [0 0 595 842]"} /Resources << /Font << /F1 3 0 R >> ${p.res ?? ""} >> /Contents ${5 + i * 2} 0 R >>`)
    objs.push(stream("<< >>", p.content))
  })
  return pdfFrom([...objs, ...extra])
}

const text = (x: number, y: number, s: string, size = 12): string => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET\n`

/** 표준 보안 처리기 R2(RC4 40bit) 사용자 암호 PDF */
function encryptedPdf(userPw: string): Buffer {
  const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex")
  const rc4 = (key: Buffer, data: Buffer): Buffer => {
    const s = [...Array(256).keys()]
    let j = 0
    for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]] }
    const out = Buffer.alloc(data.length)
    let i = 0; j = 0
    for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[k] = data[k] ^ s[(s[i] + s[j]) & 255] }
    return out
  }
  const md5 = (...b: Buffer[]): Buffer => createHash("md5").update(Buffer.concat(b)).digest()
  const pad = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32)
  const O = rc4(md5(pad("owner")).subarray(0, 5), pad(userPw))
  const P = -44
  const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex")
  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(P)
  const key = md5(pad(userPw), O, pBuf, id).subarray(0, 5)
  const U = rc4(key, PAD)
  const objKey = md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10)
  const content = rc4(objKey, Buffer.from("BT /F1 24 Tf 72 700 Td (Secret text) Tj ET\n", "latin1")).toString("latin1")
  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("<< >>", content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`,
  ], `/Encrypt 6 0 R /ID [<${id.toString("hex")}><${id.toString("hex")}>] `)
}

const ok = async (buf: Buffer | ArrayBuffer, opts?: Parameters<typeof parse>[1]) => {
  const r = await parse(buf, opts)
  assert.ok(r.success, r.success ? "" : r.error)
  return r as Extract<typeof r, { success: true }>
}
const codes = (w?: ParseWarning[]): string[] => (w ?? []).map(x => x.code)
// ─── 2 긴 괘선 ─────────────────────────────────────────

describe("PDF 견고성 — 좌표가 큰 괘선 (버킷 루프)", () => {
  const H = [100, 150, 200].map(y => ({ x1: 100, y1: y, x2: 400, y2: y, lineWidth: 0.5 }))
  const V = (y2: number) => [{ x1: 100, y1: 100, x2: 100, y2, lineWidth: 0.5 }, { x1: 250, y1: 100, x2: 250, y2: 200, lineWidth: 0.5 }, { x1: 400, y1: 100, x2: 400, y2: 200, lineWidth: 0.5 }]

  it("길이 1e9 세로선 하나가 있어도 짧은 선과 같은 격자를 곧바로 낸다 (종전 버킷 1,000만 개·Map 한계 초과로 쪽 소실)", () => {
    const t0 = performance.now()
    const long = buildTableGrids(H.map(l => ({ ...l })), V(1e9))
    const ms = performance.now() - t0
    const short = buildTableGrids(H.map(l => ({ ...l })), V(200))
    assert.deepEqual(long.map(g => [g.rowYs, g.colXs]), short.map(g => [g.rowYs, g.colXs]))
    assert.equal(long.length, 1)
    assert.ok(ms < 2000, `${ms}ms`)
  })

  it("가로 1e9·세로 ±1e9 긴 선 수백 개·400자리 좌표 문서도 표를 잃지 않는다", async () => {
    const table = "100 700 m 400 700 l S 100 650 m 400 650 l S 100 600 m 400 600 l S 100 600 m 100 700 l S 250 600 m 250 700 l S 400 600 m 400 700 l S\n"
      + text(110, 670, "cell a", 10) + text(260, 670, "cell b", 10) + text(110, 620, "cell c", 10) + text(260, 620, "cell d", 10)
    const many = Array.from({ length: 200 }, (_, k) => `${120 + k} -1000000000 m ${120 + k} 1000000000 l S -1000000000 ${110 + k * 2} m 1000000000 ${110 + k * 2} l S\n`).join("")
    for (const content of [`100 100 m 1000000000 100 l S\n${table}`, `100 100 m 100 1${"0".repeat(400)} l S\n${table}`, many + table]) {
      const r = await ok(simplePdf([{ content: "0.5 w 0 G\n" + content }]))
      assert.ok(!codes(r.warnings).includes("PARTIAL_PARSE"), JSON.stringify(r.warnings))
      assert.match(r.markdown, /cell a/)
      assert.match(r.markdown, /cell d/)
    }
  })
})

// ─── 4 쪽 캐시 해제 + 10 그림 중복 판정 ──────────────────

describe("PDF 견고성 — 쪽마다 캐시를 놓아도 그림 중복 판정은 그대로", () => {
  it("세 쪽이 같은 그림 XObject 를 그리면 그림은 하나 (쪽 로컬 → 문서 공용 g_ 승격 경계 포함)", async () => {
    const img = stream("<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>", "@".repeat(16 * 16 * 3))
    const pg = (s: string): Pg => ({ content: `q 50 0 0 50 100 600 cm /Im1 Do Q ${text(72, 760, s)}`, res: "/XObject << /Im1 10 0 R >>" })
    const r = await ok(simplePdf([pg("one"), pg("two"), pg("three")], [img]))
    assert.equal(r.images?.length, 1)
    assert.equal(r.blocks.filter(b => b.type === "image").length, 1)
  })

  it("문서 공용 id(g_)는 내용 해시를 한 번만 — 같은 id 반복·다른 id 같은 내용은 하나, 다른 내용은 따로, images:false 도 같은 자리 표시", async () => {
    const px = (v: number) => ({ width: 16, height: 16, kind: ImageKind.RGB_24BPP, data: new Uint8Array(16 * 16 * 3).fill(v) })
    const store: Record<string, unknown> = { g_d0_img_p0_1: px(10), g_d0_img_p0_2: px(10), g_d0_img_p1_3: px(99), img_p2_1: px(99) }
    const page = { objs: { get: (id: string, cb?: (d: unknown) => void) => cb?.(store[id]) }, commonObjs: { get: (id: string, cb?: (d: unknown) => void) => cb?.(store[id]) } }
    const run = async (withBytes: boolean) => {
      const state = createPdfImageState()
      const out: IRBlock[] = []
      let images = 0
      for (const [n, ids] of [[1, ["g_d0_img_p0_1", "g_d0_img_p0_2"]], [2, ["g_d0_img_p0_1", "g_d0_img_p1_3"]], [3, ["img_p2_1", "g_d0_img_p0_1"]]] as const) {
        const r = await extractPageImages(page, ids.map(() => OPS.paintImageXObject), ids.map(id => [id]), n, state, [], withBytes)
        out.push(...r.blocks)
        images += r.images.length
      }
      return { out, images, cached: state.globalKeys.size }
    }
    const full = await run(true), lean = await run(false)
    assert.equal(full.images, 2, "내용 10·99 두 가지")
    assert.deepEqual(full.out.map(b => b.text), ["image_001.png", "image_002.png"])
    assert.deepEqual(lean.out, full.out)
    assert.equal(lean.images, 0)
    assert.equal(full.cached, 3, "g_ id 셋의 키를 기억")
  })
})

// ─── 5 전개 push ───────────────────────────────────────

describe("PDF 견고성 — 블록 13만 개 이상", () => {
  it("injectPageImageBlocks 가 20만 블록에서도 RangeError 없이 쪽 말미에 그림을 넣는다", () => {
    const blocks: IRBlock[] = Array.from({ length: 200_000 }, (_, i) => ({ type: "paragraph", text: `p${i}`, pageNumber: 1 + Math.floor(i / 100) }))
    injectPageImageBlocks(blocks, new Map([[1, [{ type: "image", text: "image_001.png", pageNumber: 1 }]], [2000, [{ type: "image", text: "image_002.png", pageNumber: 2000 }]]]))
    assert.equal(blocks.length, 200_002)
    assert.equal(blocks[100].text, "image_001.png")
    assert.equal(blocks[200_001].text, "image_002.png")
  })
})

// ─── 6 회전·원점 이동·CropBox ───────────────────────────

describe("PDF 견고성 — 회전·원점 이동·CropBox 쪽의 보이는 글", () => {
  const lines: Array<[number, number, string]> = [[72, 800, "TOP LINE y800"], [72, 700, "LINE y700"], [72, 600, "LINE y600"], [72, 400, "MIDDLE y400"], [72, 100, "BOTTOM y100"]]
  const content = (dx = 0, dy = 0) => lines.map(([x, y, s]) => text(x + dx, y + dy, s)).join("")

  for (const [name, box, dx, dy] of [["Rotate 90", "/MediaBox [0 0 595 842] /Rotate 90", 0, 0], ["Rotate 270", "/MediaBox [0 0 595 842] /Rotate 270", 0, 0], ["원점 (200,300)", "/MediaBox [200 300 795 1142]", 200, 300]] as const) {
    it(`${name}: 다섯 줄 모두 남고 숨은 글·이미지 기반 판정이 없다 (종전 y>679 줄 소실)`, async () => {
      const r = await ok(simplePdf([{ content: content(dx, dy), box }]))
      for (const [, , s] of lines) assert.match(r.markdown, new RegExp(s))
      assert.ok(!codes(r.warnings).includes("HIDDEN_TEXT_FILTERED"), JSON.stringify(r.warnings))
      assert.ok(!r.isImageBased)
    })
  }

  it("CropBox 윗절반: 보이는 세 줄을 낸다 (종전 전부 숨은 글·이미지 기반 오판)", async () => {
    const r = await ok(simplePdf([{ content: content(), box: "/MediaBox [0 0 595 842] /CropBox [0 421 595 842]" }]))
    for (const s of ["TOP LINE y800", "LINE y700", "LINE y600"]) assert.match(r.markdown, new RegExp(s))
    assert.ok(!r.isImageBased)
    assert.ok(!codes(r.warnings).includes("NEEDS_OCR"))
  })

  it("이동한 원점의 본문·괘선·반복 문단도 원점 0인 문서와 같다", async () => {
    const make = (dy: number) => simplePdf([0, 1, 2].map(i => ({
      box: `/MediaBox [0 ${dy} 595 ${842 + dy}]`,
      content: text(72, 650 + dy, "Repeated body text") + text(72, 400 + dy, `Unique paragraph ${i}`)
        + text(110, 170 + dy, "alpha") + text(260, 170 + dy, "beta") + text(110, 120 + dy, "gamma") + text(260, 120 + dy, "delta")
        + `100 ${100 + dy} m 400 ${100 + dy} l S 100 ${150 + dy} m 400 ${150 + dy} l S 100 ${200 + dy} m 400 ${200 + dy} l S 100 ${100 + dy} m 100 ${200 + dy} l S 250 ${100 + dy} m 250 ${200 + dy} l S 400 ${100 + dy} m 400 ${200 + dy} l S`,
    })))
    const base = await ok(make(0))
    const shifted = await ok(make(300))
    assert.equal(shifted.markdown, base.markdown)
    const geometry = (blocks: IRBlock[]) => JSON.stringify(blocks, (key, value) => key === "fontName" ? undefined : value)
    assert.equal(geometry(shifted.blocks), geometry(base.blocks))
    assert.ok(shifted.blocks.some(b => b.table))
    assert.equal((shifted.markdown.match(/Repeated body text/g) ?? []).length, 3)
  })

  it("filterHiddenText 는 쪽 상자 원점 기준 — 원점 0 이면 종전과 같다", () => {
    const it0 = (y: number): NormItem => ({ text: "a", x: 272, y, w: 10, h: 10, fontSize: 10, fontName: "", isHidden: false })
    assert.equal(filterHiddenText([it0(1100)], 595, 842).hiddenCount, 1)
    assert.equal(filterHiddenText([it0(1100)], 595, 842, 200, 300).hiddenCount, 0)
    assert.equal(filterHiddenText([it0(100)], 595, 842, 200, 300).hiddenCount, 1)
  })
})

// ─── 8 호출자 버퍼 ─────────────────────────────────────

describe("PDF 견고성 — parse(Buffer) 가 호출자 버퍼를 건드리지 않는다", () => {
  it("버퍼 전체를 가진 Buffer 도 파싱 뒤 길이가 그대로이고 다시 파싱된다 (종전 detach 로 길이 0 → EMPTY_INPUT)", async () => {
    const pdf = simplePdf([{ content: text(72, 700, "Hello buffer") }])
    const ab = new ArrayBuffer(pdf.length)
    new Uint8Array(ab).set(pdf)
    const buf = Buffer.from(ab)
    assert.equal(buf.byteOffset, 0)
    await ok(buf)
    assert.equal(buf.length, pdf.length)
    const again = await ok(buf)
    assert.match(again.markdown, /Hello buffer/)
    await ok(ab)
    assert.equal(ab.byteLength, pdf.length)
  })
})

// ─── 9 쪽 수 상한 ─────────────────────────────────────

describe("PDF 견고성 — 5,000쪽 상한", () => {
  const many = (n: number): Buffer => pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${5 + i} 0 R`).join(" ")}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("<< >>", text(20, 100, "page body", 10)),
    ...Array.from({ length: n }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"),
  ])

  it("상한 뒤쪽을 요청하면 잘렸다고 PARTIAL_PARSE 로 알린다 (종전 무경고)", async () => {
    const pdf = many(5003)
    const cut = await ok(pdf, { pages: "5001-5003" })
    assert.ok(cut.warnings?.some(w => w.code === "PARTIAL_PARSE" && w.message.includes("5003쪽")), JSON.stringify(cut.warnings))
    const head = await ok(pdf, { pages: "1" })
    assert.ok(!codes(head.warnings).includes("PARTIAL_PARSE"))
  })
})

// ─── 16 Form XObject /Matrix ────────────────────────────

describe("PDF 견고성 — Form XObject 안에 그린 표", () => {
  it("/Matrix 0.7배 폼 안 4×3 괘선 표도 칸이 글과 맞는다 (종전 괘선만 원래 크기라 표가 뭉개짐)", async () => {
    let t = "0.8 w 0 G\n"
    const xs = [50, 200, 350, 500], ys = [700, 670, 640, 610, 580]
    for (const y of ys) t += `${xs[0]} ${y} m ${xs[3]} ${y} l S\n`
    for (const x of xs) t += `${x} ${ys[4]} m ${x} ${ys[0]} l S\n`
    const cells = [["Item", "Qty", "Price"], ["Apple", "3", "1200"], ["Pear", "5", "900"], ["Plum", "7", "300"]]
    cells.forEach((row, r) => row.forEach((s, q) => { t += text(xs[q] + 8, ys[r] - 20, s, 11) }))
    const form = stream("<< /Type /XObject /Subtype /Form /BBox [0 0 595 842] /Matrix [0.7 0 0 0.7 60 150] /Resources << /Font << /F1 3 0 R >> >> >>", t)
    const r = await ok(simplePdf([{ content: "q /Fm1 Do Q\n", res: "/XObject << /Fm1 6 0 R >>" }], [form]))
    const tables = r.blocks.filter(b => b.table)
    assert.equal(tables.length, 1)
    assert.deepEqual(tables[0].table!.cells.map(row => row.map(c => c.text)), cells)
  })
})

// ─── 17 암호 · 18 문서 밖 pages · 19 쪽 마크다운 ────────────

describe("PDF 견고성 — 암호·쪽 범위·쪽 마크다운", () => {
  it("사용자 암호 PDF 는 ENCRYPTED (종전 PARSE_ERROR), 빈 사용자 암호는 그대로 열린다", async () => {
    const locked = await parse(encryptedPdf("secret"))
    assert.equal(locked.success, false)
    assert.equal(!locked.success && locked.code, "ENCRYPTED")
    const open = await ok(encryptedPdf(""))
    assert.match(open.markdown, /Secret text/)
  })

  it("문서 밖 pages(\"9999\")는 이미지 기반·OCR 필요로 오판하지 않는다", async () => {
    const r = await ok(simplePdf([{ content: text(72, 700, "Only page") }]), { pages: "9999" })
    assert.equal(r.markdown, "")
    assert.ok(!r.isImageBased)
    assert.ok(!codes(r.warnings).includes("NEEDS_OCR"))
  })

  it("pages[].markdown 도 문서 마크다운과 같은 PDF 마무리(쪽번호 줄 제거 등)를 거친다", async () => {
    const pg = (body: string, num: string): Pg => ({ content: text(72, 700, body) + text(280, 40, num, 10) })
    const r = await ok(simplePdf([pg("Body one", "1 / 2"), pg("Body two", "2 / 2")]))
    assert.equal(r.markdown, "Body one\n\nBody two")
    assert.deepEqual(r.pages, [{ pageNumber: 1, markdown: "Body one" }, { pageNumber: 2, markdown: "Body two" }])
  })
})
