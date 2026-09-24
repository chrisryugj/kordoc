/**
 * patchHwpx/patchHwp 포맷 선택 — parse() 처럼 확장자가 아니라 매직 바이트로 패처를 고른다.
 * 정책브리핑 보도자료는 .hwpx 이름에 HWP 5.x 바이너리를 싣기도 해서(v4.14.4 korea-kr-pairs 6건) 확장자대로 부르면
 * parse 는 되는데 no-op 패치가 "손상된 HWPX"/"CFB 컨테이너 파싱 실패" 로 실패했다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "module"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, parseHwpx, patchHwpx, patchHwp, markdownToHwpx, openHwpxDocument } from "../src/index.js"
import { parseHwp5Document } from "../src/hwp5/parser.js"

const CFB = createRequire(import.meta.url)("cfb")

// 최소 HWP 5.x: 순수 텍스트 문단(PARA_HEADER + PARA_TEXT + CHAR_SHAPE + LINE_SEG)만 든 비압축 BodyText
function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}
function paragraph(text: string): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(text.length + 1, 0) // nChars (문단끝 포함)
  header.writeUInt16LE(1, 12)              // charShapeCount
  header.writeUInt16LE(1, 16)              // lineSegCount
  return Buffer.concat([
    rec(0x42, 0, header),
    rec(0x43, 1, Buffer.concat([Buffer.from(text, "utf16le"), Buffer.from([0x0d, 0x00])])),
    rec(0x44, 1, Buffer.alloc(8)),
    rec(0x45, 1, Buffer.alloc(36)),
  ])
}
function buildHwp(paras: Buffer[]): Uint8Array {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "ascii")
  fileHeader[35] = 5
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/DocInfo", Buffer.alloc(0))
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", Buffer.concat(paras))
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer)
}

describe("patchHwpx/patchHwp — 컨테이너 매직 바이트로 패처 선택 (parse 와 같은 입력)", () => {
  const isOle2 = (b: Uint8Array) => Buffer.from(b.subarray(0, 4)).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
  const isZip = (b: Uint8Array) => Buffer.from(b.subarray(0, 4)).equals(Buffer.from("PK\x03\x04", "latin1"))

  it("patchHwpx 에 HWP 5.x 바이트 — no-op 바이트 동일, 수정은 HWP5 로 적용", async () => {
    const hwp = buildHwp([paragraph("첫 문단입니다"), paragraph("둘째 문단입니다")])
    const md = parseHwp5Document(Buffer.from(hwp)).markdown
    const noop = await patchHwpx(hwp, md)
    assert.equal(noop.success, true, noop.error)
    assert.deepEqual(Buffer.from(noop.data!), Buffer.from(hwp))

    const r = await patchHwpx(hwp, md.replace("둘째 문단입니다", "고친 둘째 문단"))
    assert.equal(r.success, true, r.error)
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.ok(isOle2(r.data!), "원본과 같은 OLE2 컨테이너로 나온다")
    assert.ok(parseHwp5Document(Buffer.from(r.data!)).markdown.includes("고친 둘째 문단"))
  })

  it("patchHwp 에 HWPX(ZIP) 바이트 — no-op 바이트 동일, 수정은 HWPX 로 적용", async () => {
    const hwpx = new Uint8Array(await markdownToHwpx("첫 문단입니다\n\n둘째 문단입니다"))
    const parsed = await parseHwpx(hwpx.slice().buffer)
    assert.ok(parsed.success)
    const noop = await patchHwp(hwpx, parsed.markdown)
    assert.equal(noop.success, true, noop.error)
    assert.deepEqual(Buffer.from(noop.data!), Buffer.from(hwpx))

    const r = await patchHwp(hwpx, parsed.markdown.replace("둘째 문단입니다", "고친 둘째 문단"))
    assert.equal(r.success, true, r.error)
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    assert.ok(isZip(r.data!), "원본과 같은 ZIP 컨테이너로 나온다")
    const re = await parseHwpx(r.data!.slice().buffer)
    assert.ok(re.success && re.markdown.includes("고친 둘째 문단"))
  })

  it("Buffer 뷰(byteOffset≠0) — 판정은 뷰 첫 바이트로 (밑 ArrayBuffer 앞머리 PK 에 속지 않음)", async () => {
    const hwp = Buffer.from(buildHwp([paragraph("뷰 문단입니다")]))
    const ab = new ArrayBuffer(8 + hwp.length)
    new Uint8Array(ab).set(Buffer.from("PK\x03\x04-pad", "latin1"), 0)
    new Uint8Array(ab).set(hwp, 8)
    const view = Buffer.from(ab, 8) // Buffer.slice 는 view — .buffer 앞머리는 PK
    const md = parseHwp5Document(hwp).markdown
    const r = await patchHwpx(view, md)
    assert.equal(r.success, true, r.error)
    assert.deepEqual(Buffer.from(r.data!), hwp)
  })

  it("HWPX 세션(openHwpxDocument)은 HWP 5.x 바이트를 손상 오보 대신 포맷을 밝혀 거절", async () => {
    await assert.rejects(openHwpxDocument(buildHwp([paragraph("본문")])), /HWPX 세션은 HWPX 문서만.*hwp\)/)
  })

  it("패처가 없는 포맷(HWP 3.x·PDF)은 손상 오보 대신 감지 포맷을 밝혀 거절", async () => {
    const hwp3 = new Uint8Array(Buffer.concat([Buffer.from("HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05", "latin1"), Buffer.alloc(200)]))
    const r3 = await patchHwp(hwp3, "본문")
    assert.equal(r3.success, false)
    assert.match(r3.error!, /HWPX·HWP 5\.x 문서만 지원.*hwp3/)
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"))
    const rp = await patchHwpx(pdf, "본문")
    assert.equal(rp.success, false)
    assert.match(rp.error!, /감지된 포맷: pdf/)
  })
})

// 실파일: 코퍼스(gitignore, 없으면 skip)에서 확장자와 매직 바이트가 어긋난 문서를 찾아 확장자대로 패처를 부른다
// (bench/perf.mjs 와 같은 선택 — v4.14.4 에서 korea-kr-pairs 6건이 no-op 실패)
const MISNAMED_DIRS = ["korea-kr-pairs", "korea-kr-pairs2"]
  .map(d => join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus", d))
  .filter(d => existsSync(d))

describe("patchHwpx/patchHwp e2e: 확장자와 속이 다른 실파일", { skip: MISNAMED_DIRS.length === 0 }, () => {
  it("no-op 패치 바이트 동일", async () => {
    for (const dir of MISNAMED_DIRS) {
      for (const f of readdirSync(dir).filter(f => /\.hwpx?$/i.test(f))) {
        const buf = readFileSync(join(dir, f))
        const ole = buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
        const hwpxName = /\.hwpx$/i.test(f)
        if (hwpxName !== ole) continue // 이름과 속이 맞는 문서는 bench/perf.mjs no-op 줄이 잰다
        const parsed = await parse(buf)
        assert.ok(parsed.success, `${f}: parse 실패`)
        const r = hwpxName ? await patchHwpx(new Uint8Array(buf), parsed.markdown) : await patchHwp(new Uint8Array(buf), parsed.markdown)
        assert.equal(r.success, true, `${f}: ${r.error}`)
        assert.deepEqual(Buffer.from(r.data!), buf, `${f}: no-op 바이트 불일치`)
      }
    }
  })
})
