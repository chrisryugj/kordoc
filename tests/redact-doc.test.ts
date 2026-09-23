/**
 * 문서 파일 단위 마스킹 e2e — 파일 안 모든 글자 저장소(본문·표·중첩표·머리말/꼬리말·각주·글상자·
 * 캡션·필드·그림 설명·메타데이터·미리보기 텍스트/이미지)에 합성 PII 를 심고, redactDocument 결과
 * "파일 바이트"를 구현과 독립된 오라클(tests/fixtures/redact-fixtures.ts)로 뒤져 잔존 0 을 확인한다.
 * 재파싱 마크다운만 보는 검사로는 머리말·각주·PrvText·요약정보 누출이 안 보인다(종전 경로 실측).
 */

import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { createRequire } from "node:module"
import { parse, redactMarkdown, patchHwpx } from "../src/index.js"
import { redactDocument } from "../src/redact-doc.js"
import { readRecords } from "../src/hwp5/record.js"
import {
  HWPX_PII, HWP5_PII, buildPiiHwpx, buildPiiHwp5, hwpxLeaks, hwp5Leaks, hwp5Stream,
} from "./fixtures/redact-fixtures.js"

const require = createRequire(import.meta.url)
const CFB = require("cfb")

describe("redactDocument — HWPX 컨테이너 전체", () => {
  let original: Uint8Array
  let r: Awaited<ReturnType<typeof redactDocument>>
  before(async () => {
    original = await buildPiiHwpx()
    r = await redactDocument(original)
  })

  it("픽스처 자체에는 심은 값이 전부 있다 (오라클 자기 검증)", async () => {
    const leaks = await hwpxLeaks(original, HWPX_PII)
    for (const key of Object.keys(HWPX_PII)) assert.ok(leaks.some((l) => l.startsWith(`${key} →`)), `픽스처에 ${key} 가 없음`)
  })

  it("결과 파일 어디에도 심은 PII 가 남지 않는다 (엔트리·태그 제거 텍스트·숫자 투영·원시 바이트)", async () => {
    assert.ok(r.data, "HWPX 결과 바이트 없음")
    assert.deepEqual(await hwpxLeaks(r.data!, HWPX_PII), [])
  })

  it("재검사 잔존 0, 위치별로 가린 곳이 보고된다", () => {
    assert.deepEqual(r.residual, [])
    const wheres = new Set(r.fileHits.map((h) => h.where))
    for (const w of ["body", "table", "header", "footer", "footnote", "textbox", "caption", "field", "attribute", "metadata", "preview"]) {
      assert.ok(wheres.has(w as never), `위치 ${w} 보고 없음 (보고: ${[...wheres].join(",")})`)
    }
  })

  it("리포트(fileHits·markdownHits·residual·warnings)에 원본 PII 가 없다", () => {
    const report = JSON.stringify({ f: r.fileHits, m: r.markdownHits, x: r.residual, w: r.warnings })
    for (const v of Object.values(HWPX_PII)) assert.ok(!report.includes(v), `리포트에 원문 ${v}`)
  })

  it("서식 보존 — run·글자모양·탭 수 그대로, 가린 글자 자리만 바뀜, 줄 배치 캐시는 제거", async () => {
    const a = await (await JSZip.loadAsync(original)).file("Contents/section0.xml")!.async("text")
    const b = await (await JSZip.loadAsync(r.data!)).file("Contents/section0.xml")!.async("text")
    const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length
    for (const re of [/<hp:run\b/g, /charPrIDRef="/g, /<hp:tab\b/g, /<hp:t>/g, /<hp:p\b/g, /<hp:fieldBegin\b/g]) {
      assert.equal(count(b, re), count(a, re), `${re} 개수 달라짐`)
    }
    assert.equal(count(b, /linesegarray/g), 0)
    assert.ok(b.includes(`010-●●●●-6789`))
    assert.ok(b.includes("R&amp;D &lt;담당&gt; 010-●●●●-8888"), "엔티티 앞 문단 위치 어긋남")
    // run 이 가른 번호 — 두 run 이 각자 자기 글자만 가린다
    assert.ok(b.includes("<hp:t>분할 연락처 010-●●</hp:t>") && b.includes("<hp:t>●●-5431 끝</hp:t>"))
  })

  it("바꾼 엔트리 외에는 원본 바이트 그대로, 미리보기 이미지는 같은 크기 흰 이미지", async () => {
    const za = await JSZip.loadAsync(original)
    const zb = await JSZip.loadAsync(r.data!)
    for (const name of ["Contents/header.xml", "BinData/image1.png", "META-INF/container.xml"]) {
      assert.deepEqual(await zb.file(name)!.async("uint8array"), await za.file(name)!.async("uint8array"), `${name} 변경됨`)
    }
    const pa = Buffer.from(await za.file("Preview/PrvImage.png")!.async("uint8array"))
    const pb = Buffer.from(await zb.file("Preview/PrvImage.png")!.async("uint8array"))
    assert.notDeepEqual(pb, pa)
    assert.equal(pb.readUInt32BE(16), pa.readUInt32BE(16))
    assert.equal(pb.readUInt32BE(20), pa.readUInt32BE(20))
    assert.ok(r.warnings.some((w) => w.includes("BinData")), "삽입 이미지 미검사 경고 없음")
  })

  it("결과 파일이 다시 파싱되고 마스킹 형태가 보인다", async () => {
    const p = await parse(r.data!.buffer.slice(r.data!.byteOffset, r.data!.byteOffset + r.data!.byteLength) as ArrayBuffer)
    assert.ok(p.success)
    assert.ok(p.markdown.includes("850315-●●●●●●●"))
    assert.ok(p.markdown.includes("h●●●@example.com"), "각주 이메일")
    assert.ok(p.markdown.includes("010-●●●●-7890"), "각주가 달린 문단")
  })

  it("종전 경로(redactMarkdown → patchHwpx)는 머리말·각주·미리보기에 PII 를 남긴다 — 회귀 기준", async () => {
    const parsed = await parse(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer)
    assert.ok(parsed.success)
    const patched = await patchHwpx(original, redactMarkdown(parsed.markdown).text)
    const leaks = patched.data ? await hwpxLeaks(patched.data, HWPX_PII) : ["patch 실패"]
    assert.ok(leaks.length > 0, "종전 경로가 새지 않는다면 이 테스트의 전제를 다시 볼 것")
  })

  it("dryRun 은 파일 바이트를 만들지 않고 같은 리포트를 낸다", async () => {
    const d = await redactDocument(original, { dryRun: true })
    assert.equal(d.data, undefined)
    assert.equal(d.fileHits.length, r.fileHits.length)
  })
})

describe("redactDocument — HWP5 컨테이너 전체", () => {
  let original: Uint8Array
  let r: Awaited<ReturnType<typeof redactDocument>>
  before(async () => {
    original = buildPiiHwp5()
    r = await redactDocument(original)
  })

  it("픽스처 자체에는 심은 값이 전부 있다 (오라클 자기 검증)", () => {
    const leaks = hwp5Leaks(original, HWP5_PII)
    for (const key of Object.keys(HWP5_PII)) assert.ok(leaks.some((l) => l.startsWith(`${key} →`)), `픽스처에 ${key} 가 없음`)
  })

  it("결과 파일의 모든 스트림(압축 해제 포함)·원시 바이트에 심은 PII 가 없다", () => {
    assert.equal(r.format, "hwp")
    assert.ok(r.data)
    assert.deepEqual(hwp5Leaks(r.data!, HWP5_PII), [])
    assert.deepEqual(r.residual, [])
  })

  it("머리말·각주·글상자·표·필드·미리보기·요약정보 위치가 보고된다", () => {
    const wheres = new Set(r.fileHits.map((h) => h.where))
    for (const w of ["body", "table", "header", "footnote", "textbox", "field", "preview", "metadata"]) {
      assert.ok(wheres.has(w as never), `위치 ${w} 보고 없음 (보고: ${[...wheres].join(",")})`)
    }
  })

  it("레코드 구조 보존 — 섹션 레코드 수·태그·크기 동일, 같은 길이 치환", () => {
    const a = readRecords(hwp5Stream(original, "/BodyText/Section0", true))
    const b = readRecords(hwp5Stream(r.data!, "/BodyText/Section0", true))
    assert.equal(b.length, a.length)
    for (let i = 0; i < a.length; i++) {
      assert.equal(b[i].tagId, a[i].tagId)
      assert.equal(b[i].size, a[i].size)
    }
    for (const p of ["/FileHeader", "/BinData/BIN0001.png"]) {
      assert.deepEqual(hwp5Stream(r.data!, p), hwp5Stream(original, p), `${p} 변경됨`)
    }
    const img = hwp5Stream(r.data!, "/PrvImage")
    assert.notDeepEqual(img, hwp5Stream(original, "/PrvImage"))
    assert.equal(img.readUInt32BE(16), 8)
  })

  it("결과 파일이 다시 파싱된다", async () => {
    const p = await parse(r.data!.buffer.slice(r.data!.byteOffset, r.data!.byteOffset + r.data!.byteLength) as ArrayBuffer)
    assert.ok(p.success)
    assert.ok(p.markdown.includes("010-●●●●-6789"))
  })

  it("리포트에 원본 PII 가 없다", () => {
    const report = JSON.stringify({ f: r.fileHits, m: r.markdownHits, x: r.residual, w: r.warnings })
    for (const v of Object.values(HWP5_PII)) assert.ok(!report.includes(v), `리포트에 원문 ${v}`)
  })

  it("미할당 섹터에 남은 옛 스트림 사본(한컴 실측)까지 0으로 비운다", async () => {
    // FAT 상 FREESECT 인 섹터를 파일 끝에 덧붙여 옛 PrvText 사본을 흉내 — CFB 파서에는 안 보인다
    const stale = Buffer.alloc(512)
    Buffer.from(`<신청인><${HWP5_PII.prvText}>`, "utf16le").copy(stale)
    const withSlack = new Uint8Array(Buffer.concat([Buffer.from(original), stale]))
    assert.ok(hwp5Leaks(withSlack, { prvText: HWP5_PII.prvText }).some((l) => l.includes("원시 바이트")))
    const w = await redactDocument(withSlack)
    assert.deepEqual(w.residual, [])
    assert.deepEqual(hwp5Leaks(w.data!, HWP5_PII), [])
    assert.ok(w.warnings.some((x) => x.includes("미할당")))
  })

  it("배포용 문서는 거부한다", async () => {
    const cfb = CFB.parse(Buffer.from(original))
    const fh = CFB.find(cfb, "/FileHeader")
    const hdr = Buffer.from(fh.content)
    hdr.writeUInt32LE(hdr.readUInt32LE(36) | 4, 36)
    fh.content = hdr
    const dist = new Uint8Array(CFB.write(cfb, { type: "buffer" }))
    await assert.rejects(() => redactDocument(dist), /배포용|암호|파싱 실패/)
  })
})

describe("redactDocument — 원본 형식 수술 대상이 아닌 포맷", () => {
  it("DOCX 는 원본을 건드리지 않고 마스킹된 마크다운 + 명시적 경고", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>연락처 010-2345-6789</w:t></w:r></w:p></w:body></w:document>`)
    const docx = await zip.generateAsync({ type: "uint8array" })
    const r = await redactDocument(docx)
    assert.equal(r.format, "docx")
    assert.equal(r.data, undefined)
    assert.ok(r.markdown.includes("010-●●●●-6789"))
    assert.ok(r.warnings.some((w) => w.includes("수정하지 않습니다")))
  })
})
