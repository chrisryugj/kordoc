/**
 * hwpToHwpx (HWP 5.x → HWPX 서식 그대로 변환) — 합성 CFB 문서로 구조를, 코퍼스가 있으면 한글 저장 짝으로 글을 확인한다.
 * 속성 단위 일치율은 bench/hwp2hwpx.mjs 가 잰다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "module"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { hwpToHwpx, convertToHwpx, parse, patchHwp, fillForm } from "../src/index.js"
import { registerConvertTools } from "../src/mcp/tools-convert.js"
import { registerFormTools } from "../src/mcp/tools-form.js"
import { needsRewrite, rewriteEdited } from "../src/roundtrip/rewrite-fallback.js"

const require = createRequire(import.meta.url)
const CFB = require("cfb")

const rec = (tagId: number, level: number, data: Buffer): Buffer => {
  const h = Buffer.alloc(4)
  h.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([h, data])
}
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")

/** 문단 — runs: [글자 위치, 글자 모양 id] */
function paragraph(text: string, runs: Array<[number, number]> = [[0, 0]], level = 0, instanceId = 0, paraShape = 0): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(text.length + 1, 0)
  header.writeUInt16LE(paraShape, 8)
  header.writeUInt16LE(runs.length, 12)
  header.writeUInt16LE(1, 16)
  header.writeUInt32LE(instanceId, 18)
  const cs = Buffer.alloc(8 * runs.length)
  runs.forEach(([p, id], i) => { cs.writeUInt32LE(p, i * 8); cs.writeUInt32LE(id, i * 8 + 4) })
  const seg = Buffer.alloc(36)
  seg.writeInt32LE(1000, 8)
  return Buffer.concat([rec(0x42, level, header), rec(0x43, level + 1, Buffer.concat([utf16(text), Buffer.from([0x0d, 0])])),
    rec(0x44, level + 1, cs), rec(0x45, level + 1, seg)])
}

/** 2×2 표 앵커 문단 */
function table2x2(cells: string[][]): Buffer {
  const anchor = Buffer.alloc(16)
  anchor.writeUInt16LE(0x0b, 0)
  anchor.write(" lbt", 2, "ascii")
  anchor.writeUInt16LE(0x0b, 14)
  const text = Buffer.concat([anchor, Buffer.from([0x0d, 0])])
  const header = Buffer.alloc(24)
  header.writeUInt32LE(text.length / 2, 0)
  header.writeUInt32LE(1 << 11, 4)
  header.writeUInt16LE(1, 12)
  const ctrl = Buffer.alloc(46)
  ctrl.write(" lbt", 0, "ascii")
  ctrl.writeUInt32LE((1 << 0) | (2 << 26), 4) // 글자처럼 취급 · 표 번호
  ctrl.writeUInt32LE(20000, 16)
  ctrl.writeUInt32LE(2000, 20)
  ctrl.writeUInt32LE(777, 36) // 인스턴스 id
  const table = Buffer.alloc(26)
  table.writeUInt32LE(0b0110, 0) // 셀 단위 나눔 · 제목 줄 반복
  table.writeUInt16LE(2, 4)
  table.writeUInt16LE(2, 6)
  table.writeUInt16LE(2, 18)
  table.writeUInt16LE(2, 20)
  table.writeUInt16LE(1, 22) // 테두리
  const parts = [rec(0x42, 0, header), rec(0x43, 1, text), rec(0x44, 1, Buffer.alloc(8)), rec(0x47, 1, ctrl), rec(0x4d, 2, table)]
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const lh = Buffer.alloc(34)
    lh.writeUInt16LE(1, 0)
    lh.writeUInt16LE(c, 8)
    lh.writeUInt16LE(r, 10)
    lh.writeUInt16LE(1, 12)
    lh.writeUInt16LE(1, 14)
    lh.writeUInt32LE(10000, 16)
    lh.writeUInt32LE(1000, 20)
    parts.push(rec(0x48, 2, lh), paragraph(cells[r][c], [[0, 0]], 2, 0x80000000))
  }
  return Buffer.concat(parts)
}

/** 문단 모양 기록(58바이트) — 왼쪽 여백·속성2 */
function paraShapeRec(left: number, attr2 = 0): Buffer {
  const d = Buffer.alloc(58)
  d.writeInt32LE(left, 4)
  d.writeInt32LE(160, 24)
  d.writeUInt32LE(attr2, 42)
  d.writeUInt32LE(160, 50)
  return rec(0x19, 0, d)
}

function buildHwp(section: Buffer, docInfo = Buffer.alloc(0), extra: Record<string, Buffer> = {}): Uint8Array {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "ascii")
  fileHeader.writeUInt32LE(0x05010100, 32)
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/DocInfo", docInfo)
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", section)
  CFB.utils.cfb_add(cfb, "/PrvText", utf16("미리보기"))
  for (const [path, data] of Object.entries(extra)) CFB.utils.cfb_add(cfb, path, data)
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer)
}

async function sectionOf(hwpx: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(hwpx)).file("Contents/section0.xml")!.async("string")
}

describe("hwpToHwpx — 합성 문서", () => {
  it("문단 글을 글자 모양 구간마다 run 으로 나누고 문단 id·줄 캐시를 옮긴다", async () => {
    const hwp = buildHwp(Buffer.concat([paragraph("굵은앞 보통뒤", [[0, 1], [3, 0]], 0, 1234), paragraph("둘째 문단")]))
    const xml = await sectionOf(await hwpToHwpx(hwp))
    assert.match(xml, /<hp:p id="1234" paraPrIDRef="0"/)
    assert.match(xml, /<hp:run charPrIDRef="1"><hp:t>굵은앞<\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:t> 보통뒤<\/hp:t><\/hp:run>/)
    assert.match(xml, /<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000"/)
  })

  it("표를 칸·주소·병합째 옮기고 개체 뒤 빈 글 자리를 둔다", async () => {
    const hwp = buildHwp(Buffer.concat([paragraph("표 앞"), table2x2([["가", "나"], ["다", "라"]])]))
    const out = await hwpToHwpx(hwp)
    const xml = await sectionOf(out)
    assert.match(xml, /<hp:tbl id="777"[^>]* numberingType="TABLE"[^>]* pageBreak="CELL" repeatHeader="1" rowCnt="2" colCnt="2"/)
    assert.match(xml, /<hp:pos treatAsChar="1"/)
    assert.equal((xml.match(/<hp:tc /g) ?? []).length, 4)
    assert.match(xml, /<\/hp:tbl><hp:t\/><\/hp:run>/)
    const md = (await parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer)).markdown
    for (const s of ["표 앞", "가", "나", "다", "라"]) assert.ok(md.includes(s), md)
  })

  it("기록이 같은 문단 모양은 하나로 합쳐 참조를 다시 매기고, 홀수 여백은 HwpUnitChar 갈래에 CHAR, 글 방향은 속성2 비트 3", async () => {
    const docInfo = Buffer.concat([paraShapeRec(0), paraShapeRec(1, 1 << 3), paraShapeRec(0)])
    const hwp = buildHwp(Buffer.concat([paragraph("첫", [[0, 0]], 0, 0, 2), paragraph("둘", [[0, 0]], 0, 0, 1)]), docInfo)
    const zip = await JSZip.loadAsync(await hwpToHwpx(hwp))
    const header = await zip.file("Contents/header.xml")!.async("string")
    assert.match(header, /<hh:paraProperties itemCnt="2">/)
    assert.match(header, /<hh:paraPr id="0"[^>]* textDir="AUTO">/)
    assert.match(header, /<hh:paraPr id="1"[^>]* textDir="LTR">[\s\S]*?HwpUnitChar"><hh:margin><hc:intent value="0" unit="HWPUNIT"\/><hc:left value="0" unit="CHAR"\/>/)
    assert.match(header, /<hp:default><hh:margin><hc:intent value="0" unit="HWPUNIT"\/><hc:left value="1" unit="HWPUNIT"\/>/)
    assert.deepEqual([...(await sectionOf(await zip.generateAsync({ type: "uint8array" }))).matchAll(/<hp:p [^>]*paraPrIDRef="(\d+)"/g)].map(m => m[1]), ["0", "1"])
  })

  it("MemoExtended 스트림(메모 id·부모 id 쌍)을 Contents/memoExtended.xml 로 옮긴다", async () => {
    const data = Buffer.alloc(20)
    data.writeUInt32LE(2, 0)
    ;[11, 21, 12, 22].forEach((v, i) => data.writeUInt32LE(v, 4 + i * 4))
    const zip = await JSZip.loadAsync(await hwpToHwpx(buildHwp(paragraph("본문"), Buffer.alloc(0), { "/MemoExtended": rec(0x65, 0, data) })))
    assert.match(await zip.file("Contents/memoExtended.xml")!.async("string"),
      /<he:memosEx xmlns:he="http:\/\/www\.hancom\.co\.kr\/hwpml\/2021\/extended"><he:memo id="11" parentId="21"\/><he:memo id="12" parentId="22"\/><\/he:memosEx>$/)
    assert.match(await zip.file("Contents/content.hpf")!.async("string"), /<opf:item id="memoextended" href="Contents\/memoExtended\.xml" media-type="application\/xml"\/>/)
  })

  it("패키지에 한글이 읽는 항목을 갖춘다", async () => {
    const zip = await JSZip.loadAsync(await hwpToHwpx(buildHwp(paragraph("본문"))))
    for (const n of ["mimetype", "version.xml", "Contents/header.xml", "Contents/section0.xml", "Contents/content.hpf",
      "META-INF/container.xml", "META-INF/manifest.xml", "META-INF/container.rdf", "settings.xml", "Preview/PrvText.txt"]) {
      assert.ok(zip.file(n), n)
    }
    assert.equal(await zip.file("mimetype")!.async("string"), "application/hwp+zip")
    assert.equal(await zip.file("Preview/PrvText.txt")!.async("string"), "미리보기")
  })
})

describe("patch 대체본 — HWP 원본", () => {
  it("HWP 제자리 수정이 못 하는 문단 추가를 서식 그대로 바꾼 HWPX 에 그 자리에서 반영한다", async () => {
    const hwp = buildHwp(Buffer.concat([paragraph("첫 문단", [[0, 0]], 0, 11), paragraph("둘째 문단", [[0, 1]], 0, 12), paragraph("셋째 문단", [[0, 0]], 0, 13)]))
    const edited = "첫 문단 고침\n\n둘째 문단\n\n늘린 문단\n\n셋째 문단"
    assert.ok(needsRewrite(await patchHwp(hwp, edited)))
    const r = await rewriteEdited(hwp, false, edited, true)
    assert.ok(r)
    assert.equal(r.how, "patch")
    const md = (await parse(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer, { layoutTables: "keep" })).markdown
    assert.equal(md.trim(), edited)
    const xml = await sectionOf(r.data)
    for (const id of [11, 12, 13]) assert.match(xml, new RegExp(`<hp:p id="${id}"`))
    assert.match(xml, /<hp:run charPrIDRef="1"><hp:t>둘째 문단<\/hp:t>/)
  })
})

describe("convertToHwpx·CLI·MCP — 저장 경로", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-to-hwpx-"))
  const src = join(dir, "보고.hwp")
  writeFileSync(src, buildHwp(paragraph("본문")))
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", timeout: 60000 })
  let callback: any
  registerConvertTools({ tool(name: string, ...args: any[]) { if (name === "convert_to_hwpx") callback = args.at(-1) } } as any)

  it("HWP 5.x 는 서식 그대로, HWPX 는 그대로 돌려준다", async () => {
    const r = await convertToHwpx(buildHwp(paragraph("본문")))
    assert.equal(r.mode, "preserve")
    assert.deepEqual(await convertToHwpx(r.data).then(x => x.data), r.data)
    await assert.rejects(convertToHwpx(new TextEncoder().encode("%PDF-1.7 아님")), /HWP 문서가 아닙니다/)
  })

  it("CLI: -o·--password 가 루트 명령에 잡혀도 하위 명령이 쓴다, 기본 경로에 파일이 있으면 덮어쓰지 않는다", () => {
    const out = join(dir, "따로", "결과.hwpx")
    const a = run(["to-hwpx", src, "-o", out])
    assert.equal(a.status, 0, a.stderr)
    assert.ok(existsSync(out))
    assert.ok(!existsSync(join(dir, "보고.hwpx")), "-o 를 무시하고 입력 옆에 쓰면 안 된다")
    writeFileSync(join(dir, "보고.hwpx"), "한글 저장본")
    const b = run(["to-hwpx", src])
    assert.equal(b.status, 2)
    assert.match(b.stderr, /이미 있습니다/)
    assert.equal(readFileSync(join(dir, "보고.hwpx"), "utf8"), "한글 저장본")
  })

  it("MCP convert_to_hwpx: 같은 규칙으로 저장하고 결과를 알린다", async () => {
    const res = await callback({ file_path: src })
    assert.ok(res.isError, "기본 경로(보고.hwpx)가 이미 있으면 실패")
    assert.match(res.content[0].text, /이미 있습니다/)
    const out = join(dir, "mcp.hwpx")
    const ok = await callback({ file_path: src, output_path: out })
    assert.ok(!ok.isError, ok.content[0].text)
    assert.match(ok.content[0].text, /서식 그대로/)
    assert.ok((await parse(new Uint8Array(readFileSync(out)).buffer)).markdown.includes("본문"))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("fill_form·fill — HWP 서식을 원본 서식으로 채우기", () => {
  it("HWP 5.x 서식을 서식 그대로 HWPX 로 바꿔 표 칸을 채운다 (라이브러리·MCP·CLI)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-fill-hwp-"))
    const previousRoot = process.env.KORDOC_ROOT
    process.env.KORDOC_ROOT = dir
    try {
      const src = join(dir, "신청서.hwp")
      writeFileSync(src, buildHwp(Buffer.concat([paragraph("신청서"), table2x2([["성명", ""], ["연락처", ""]])])))
      let fill: any
      registerFormTools({ tool(name: string, ...args: any[]) { if (name === "fill_form") fill = args.at(-1) } } as any)
      const out = join(dir, "mcp.hwpx")
      const r = await fill({ file_path: src, fields: { 성명: "홍길동" }, output_format: "hwpx-preserve", output_path: out, mask_values: false })
      assert.ok(!r.isError, r.content[0].text)
      assert.match(r.content[0].text, /HWP 를 서식 그대로 HWPX 로 바꿔 채움/)
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
      const cliOut = join(dir, "cli.hwpx")
      const c = spawnSync(process.execPath, ["--import", "tsx", cli, "fill", src, "-f", "성명=김철수", "-o", cliOut], { encoding: "utf8", timeout: 60000 })
      assert.equal(c.status, 0, c.stderr)
      assert.match(c.stderr, /서식 그대로 HWPX 로 바꿔 채웁니다/)
      const lib = await fillForm(readFileSync(src), { 성명: "이영희" }, "hwpx-preserve")
      for (const [data, name] of [[new Uint8Array(readFileSync(out)), "홍길동"], [new Uint8Array(readFileSync(cliOut)), "김철수"],
        [new Uint8Array(lib.output as ArrayBuffer), "이영희"]] as const) {
        assert.match(await sectionOf(data), /<hp:tbl id="777"/) // 원본 표째 — 새로 짠 표가 아니다
        assert.ok((await parse(data.buffer)).markdown.includes(name))
      }
    } finally {
      if (previousRoot === undefined) delete process.env.KORDOC_ROOT
      else process.env.KORDOC_ROOT = previousRoot
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("HWP 5.x 에 도장을 찍으면 서식 그대로 바꾼 HWPX 에 찍는다 (MCP·CLI)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-seal-hwp-"))
    const previousRoot = process.env.KORDOC_ROOT
    process.env.KORDOC_ROOT = dir
    try {
      const src = join(dir, "확인서.hwp")
      writeFileSync(src, buildHwp(Buffer.concat([paragraph("확인서", [[0, 0]], 0, 31), paragraph("신청인 홍길동 (인)", [[0, 0]], 0, 32)])))
      const png = join(dir, "도장.png")
      writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
      let seal: any
      registerFormTools({ tool(name: string, ...args: any[]) { if (name === "place_seal") seal = args.at(-1) } } as any)
      const out = join(dir, "mcp.hwpx")
      const r = await seal({ file_path: src, image_path: png, output_path: out, anchor: "(인)" })
      assert.ok(!r.isError, r.content[0].text)
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
      const c = spawnSync(process.execPath, ["--import", "tsx", cli, "seal", src, "--image", png], { encoding: "utf8", timeout: 60000 })
      assert.equal(c.status, 0, c.stderr)
      assert.match(c.stderr, /서식 그대로 HWPX 로 바꿔 찍습니다/)
      for (const file of [out, join(dir, "확인서.sealed.hwpx")]) {
        const zip = await JSZip.loadAsync(readFileSync(file))
        assert.ok(zip.file("BinData/image1.png"), file)
        assert.match(await zip.file("Contents/section0.xml")!.async("string"), /<hp:p id="32"/) // 원본 문단째
      }
    } finally {
      if (previousRoot === undefined) delete process.env.KORDOC_ROOT
      else process.env.KORDOC_ROOT = previousRoot
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const RHWP = join(import.meta.dirname, "..", "bench", "corpus", "rhwp")
describe("메모 달기 — HWP 원본 (#180)", () => {
  it("HWP 5.x 에 메모를 달면 서식 그대로 바꾼 HWPX 에 단다 (MCP·CLI)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-memo-hwp-"))
    const previousRoot = process.env.KORDOC_ROOT
    process.env.KORDOC_ROOT = dir
    try {
      const src = join(dir, "확인서.hwp")
      writeFileSync(src, buildHwp(Buffer.concat([paragraph("확인서", [[0, 0]], 0, 31), paragraph("신청인 홍길동 (인)", [[0, 0]], 0, 32)])))
      let memo: any
      registerFormTools({ tool(name: string, ...args: any[]) { if (name === "add_memo") memo = args.at(-1) } } as any)
      const out = join(dir, "mcp.hwpx")
      const r = await memo({ file_path: src, anchor: "홍길동", text: "성명 확인", occurrence: 0, output_path: out })
      assert.ok(!r.isError, r.content[0].text)
      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
      const c = spawnSync(process.execPath, ["--import", "tsx", cli, "memo", src, "--anchor", "홍길동", "--text", "성명 확인\\n둘째 줄", "--author", "검토자"], { encoding: "utf8", timeout: 60000 })
      assert.equal(c.status, 0, c.stderr)
      assert.match(c.stderr, /서식 그대로 HWPX 로 바꿔 메모를 답니다/)
      const read = async (file: string) => { const p = await parse(readFileSync(file), { filename: "x.hwpx" }); assert.ok(p.success); return p.memos }
      assert.deepEqual((await read(out))?.map(m => [m.anchor, m.text, m.author]), [["홍길동", "성명 확인", "kordoc"]])
      assert.deepEqual((await read(join(dir, "확인서.memo.hwpx")))?.map(m => [m.anchor, m.text, m.author]), [["홍길동", "성명 확인\n둘째 줄", "검토자"]])
    } finally {
      if (previousRoot === undefined) delete process.env.KORDOC_ROOT
      else process.env.KORDOC_ROOT = previousRoot
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hwpToHwpx — 확장 바탕쪽(코퍼스)", { skip: !existsSync(join(RHWP, "hwpx", "exam_kor.hwpx")) }, () => {
  it("구역 끝 바탕쪽을 한글 저장본처럼 마지막 쪽·임의 쪽으로 쓴다", async () => {
    const kinds = async (zip: JSZip): Promise<string[]> => {
      const out: string[] = []
      for (let i = 0; zip.file(`Contents/section${i}.xml`); i++) {
        const sec = await zip.file(`Contents/section${i}.xml`)!.async("string")
        for (const [, id] of sec.matchAll(/<hp:masterPage idRef="([^"]+)"\/>/g)) {
          const mp = await zip.file(`Contents/${id}.xml`)!.async("string")
          out.push(`${i}:${mp.match(/type="(\w+)" pageNumber="(\d+)"/)!.slice(1).join("/")}`)
        }
      }
      return out
    }
    const ours = await kinds(await JSZip.loadAsync(await hwpToHwpx(new Uint8Array(readFileSync(join(RHWP, "exam_kor.hwp"))))))
    const hancom = await kinds(await JSZip.loadAsync(readFileSync(join(RHWP, "hwpx", "exam_kor.hwpx"))))
    assert.deepEqual(ours, hancom)
    assert.ok(ours.includes("2:OPTIONAL_PAGE/4") && ours.includes("0:LAST_PAGE/0"), ours.join(" "))
  })
})

describe("hwpToHwpx — 양식 개체(코퍼스)", { skip: !existsSync(join(RHWP, "hwpx", "form-01.hwpx")) }, () => {
  it("단추·선택 상자·라디오·콤보·입력 칸을 한글 저장본과 같게 쓴다", async () => {
    const forms = async (zip: JSZip): Promise<string[]> =>
      [...(await zip.file("Contents/section0.xml")!.async("string")).matchAll(/<hp:(btn|checkBtn|radioBtn|comboBox|edit) [\s\S]*?<\/hp:\1>/g)].map(m => m[0])
    const ours = await forms(await JSZip.loadAsync(await hwpToHwpx(new Uint8Array(readFileSync(join(RHWP, "form-01.hwp"))))))
    const hancom = await forms(await JSZip.loadAsync(readFileSync(join(RHWP, "hwpx", "form-01.hwpx"))))
    assert.equal(ours.length, 5)
    assert.deepEqual(ours, hancom)
  })
})

describe("hwpToHwpx — 메모(코퍼스)", { skip: !existsSync(join(RHWP, "hwpx", "aift.hwpx")) }, () => {
  it("구역 끝 메모 글을 MEMO 필드의 subList 로 한글 저장본과 같게 쓴다", async () => {
    const memos = async (zip: JSZip): Promise<string[]> => {
      const out: string[] = []
      for (let i = 0; zip.file(`Contents/section${i}.xml`); i++) {
        const s = await zip.file(`Contents/section${i}.xml`)!.async("string")
        for (const m of s.matchAll(/<hp:fieldBegin [^>]*type="MEMO"[\s\S]*?<\/hp:subList><\/hp:fieldBegin>/g)) out.push(m[0])
      }
      return out
    }
    const ours = await memos(await JSZip.loadAsync(await hwpToHwpx(new Uint8Array(readFileSync(join(RHWP, "aift.hwp"))))))
    const hancom = await memos(await JSZip.loadAsync(readFileSync(join(RHWP, "hwpx", "aift.hwpx"))))
    assert.equal(ours.length, 2)
    // 생성 시각은 한글처럼 지역 시각으로 쓴다 — 시간대가 다른 곳에서도 돌도록 그 칸만 빼고 맞댄다
    const noTime = (x: string): string => x.replace(/<hp:stringParam name="CreateDateTime">[^<]*<\/hp:stringParam>/, "")
    assert.deepEqual(ours.map(noTime), hancom.map(noTime))
  })
})

const CORPUS = join(import.meta.dirname, "..", "bench", "corpus", "korea-kr-pairs")
describe("hwpToHwpx — 한글 저장 짝(코퍼스)", { skip: !existsSync(CORPUS) }, () => {
  it("변환본의 글이 한글이 저장한 HWPX 의 글과 같다", async () => {
    const tText = (xml: string): string => [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(m => m[1]).join("")
    let n = 0
    for (const f of readdirSync(CORPUS).filter(f => f.endsWith(".hwp")).slice(0, 8)) {
      const truth = join(CORPUS, f + "x")
      if (!existsSync(truth)) continue
      const ours = await sectionOf(await hwpToHwpx(new Uint8Array(readFileSync(join(CORPUS, f)))))
      const hancom = await (await JSZip.loadAsync(readFileSync(truth))).file("Contents/section0.xml")!.async("string")
      assert.equal(tText(ours), tText(hancom), f)
      n++
    }
    assert.ok(n > 0)
  })
})
