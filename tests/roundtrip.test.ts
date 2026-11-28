/** 서식 보존 무손실 라운드트립 (patchHwpx) 테스트 — v3.0 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { inflateRawSync } from "node:zlib"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { scanSectionXml, buildParagraphSplices, applySplices, escapeXmlText, decodeXmlEntities } from "../src/roundtrip/source-map.js"
import { patchZipEntries, readZipEntries } from "../src/roundtrip/zip-patch.js"
import { splitMarkdownUnits, parseGfmTable, parseHtmlTable, extractTopLevelTables, alignUnits } from "../src/roundtrip/markdown-units.js"

// ─── 헬퍼 ────────────────────────────────────────────

const SYNTH_MD = `# 사업 개요

본 사업은 2026년 주민 복지 향상을 위한 시범사업이다.

특수문자 검증 문단: A&B <C> "따옴표" 100%

| 항목 | 담당자 | 비고 |
| --- | --- | --- |
| 예산 | 홍길동 | 1억원 |
| 기간 | 김철수 | 6개월 |

동일한 반복 문단입니다.

동일한 반복 문단입니다.

마지막 문단.`

async function makeSynthetic(): Promise<{ original: Uint8Array; markdown: string }> {
  const buf = await markdownToHwpx(SYNTH_MD)
  const original = new Uint8Array(buf)
  const parsed = await parseHwpx(buf, { layoutTables: "keep" })
  assert.ok(parsed.success, "합성 HWPX 파싱 성공")
  return { original, markdown: parsed.markdown }
}

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function reparse(data: Uint8Array) {
  const r = await parseHwpx(toAB(data), { layoutTables: "keep" })
  assert.ok(r.success, "패치본 재파싱 성공")
  return r
}

/** section XML 외 모든 ZIP 엔트리가 바이트 동일한지 확인 */
async function assertNonSectionEntriesIdentical(a: Uint8Array, b: Uint8Array): Promise<void> {
  const za = await JSZip.loadAsync(a)
  const zb = await JSZip.loadAsync(b)
  assert.deepEqual(Object.keys(za.files).sort(), Object.keys(zb.files).sort(), "엔트리 목록 동일")
  for (const name of Object.keys(za.files)) {
    if (za.files[name].dir || /section\d+\.xml$/i.test(name) || name === "Preview/PrvText.txt") continue  // 미리보기 글은 고친 본문으로 다시 쓴다 (#248)
    const da = await za.file(name)!.async("uint8array")
    const db = await zb.file(name)!.async("uint8array")
    assert.equal(Buffer.compare(Buffer.from(da), Buffer.from(db)), 0, `엔트리 바이트 보존: ${name}`)
  }
}

// ─── patchHwpx — 합성 문서 ──────────────────────────

describe("patchHwpx: 문단 텍스트 수정", () => {
  it("문장 1개 수정 → 반영 + 나머지 동일 + 검증 잔차 0", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("주민 복지 향상을 위한 시범사업이다.", "주민 안전 강화를 위한 본사업이다.")
    assert.notEqual(edited, markdown)

    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 0)
    assert.ok(res.data)
    assert.deepEqual(res.verification?.stats, { added: 0, removed: 0, modified: 0, unchanged: res.verification!.stats.unchanged })

    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited, "재파싱 마크다운 = 편집 마크다운")
    await assertNonSectionEntriesIdentical(original, res.data!)
  })

  it("변경 없음 → applied 0, 원본 바이트 그대로", async () => {
    const { original, markdown } = await makeSynthetic()
    const res = await patchHwpx(original, markdown)
    assert.ok(res.success)
    assert.equal(res.applied, 0)
    assert.equal(Buffer.compare(Buffer.from(res.data!), Buffer.from(original)), 0)
  })

  it("특수문자 (& < > 이모지) → XML 이스케이프 후 정상 라운드트립", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("마지막 문단.", "특문 & 꺾쇠 <태그> 그리고 \"인용\" 이모지 😊 검증")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.ok(r2.markdown.includes("특문 & 꺾쇠 <태그> 그리고 \"인용\" 이모지 😊 검증"))
    assert.equal(r2.markdown, edited)
  })

  it("같은 텍스트 중복 문단 — 두 번째만 수정해도 올바른 문단이 바뀜", async () => {
    const { original, markdown } = await makeSynthetic()
    const target = "동일한 반복 문단입니다."
    const first = markdown.indexOf(target)
    const second = markdown.indexOf(target, first + 1)
    assert.ok(second > first, "중복 문단 존재")
    const edited = markdown.slice(0, second) + "두 번째만 수정된 문단입니다." + markdown.slice(second + target.length)

    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    // 첫 번째 등장은 그대로, 두 번째가 바뀌었는지 순서로 확인
    assert.ok(r2.markdown.indexOf(target) < r2.markdown.indexOf("두 번째만 수정된"))
  })

  it("같은 글 단위가 여럿이면 제자리끼리 짝짓는다 — 떨어져 있든 붙어 있든 고침이 추가·삭제로 보이지 않게", () => {
    // 떨어진 같은 글: 편집본 2번을 원본 0번(앞쪽 같은 글)과 짝지으면 0·1 은 추가, 원본 1·2 는 삭제로 보였다
    assert.deepEqual(alignUnits(["가", "나", "가", "다"], ["가 고침", "나 고침", "가", "다 고침"]), [[0, 0], [1, 1], [2, 2], [3, 3]])
    assert.deepEqual(alignUnits(["머리", "같음", "같음", "끝"], ["머리", "같음", "고침", "끝"]), [[0, 0], [1, 1], [2, 2], [3, 3]])
  })
})

describe("patchHwpx: 표 셀 수정", () => {
  it("굵은 칸이 있는 GFM 표도 칸 글만 고친다 — 강조 표지는 hp:t 에 쓰지 않고 굵은 run 은 그대로", async () => {
    const original = new Uint8Array(await markdownToHwpx("| 필수 과제 | 비고 |\n| --- | --- |\n| **자율 과제** (예시) | 가 |"))
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    assert.ok(markdown.includes("| **자율 과제** (예시) | 가 |"), markdown)
    const edited = markdown.replace("| **자율 과제** (예시) | 가 |", "| **자율 과제** (예시) 수정 | 가 |")
    const res = await patchHwpx(original, edited)
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped, [])
    assert.equal((await reparse(res.data!)).markdown, edited)
    const xml = await (await JSZip.loadAsync(res.data!)).file("Contents/section0.xml")!.async("string")
    assert.ok(!xml.includes("**"), "강조 표지가 글로 새지 않는다")
    // 강조를 빼고 고치면 글만 적용하고 그렇다고 알린다 (원문 굵은 run 유지)
    const unbold = await patchHwpx(original, markdown.replace("| **자율 과제** (예시) | 가 |", "| 자율 과제 (예시) 고침 | 가 |"))
    assert.equal(unbold.applied, 1)
    assert.ok(unbold.skipped.some(s => s.partial && /강조/.test(s.reason)), JSON.stringify(unbold.skipped))
  })

  it("1열 표의 여러 줄 칸(제목 상자)도 줄마다 표 좌표로 고친다 — 원문 글 찾기가 못 맞대는 사용자 정의 글자(《》) 칸", async () => {
    // 한글 문서의 《》는 사용자 정의 영역 글자(U+F0854·U+F0855)로 저장되고 파서가 《》로 바꿔 낸다
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 법무부 위원회 발족<br>및 조사 권고 |\n| --- |\n| - 신뢰 회복의 첫걸음 - |"))
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    assert.ok(sec.includes("위원회"))
    zip.file("Contents/section0.xml", sec.replace("위원회", "\u{F0854}위원회\u{F0855}"))
    const original = await zip.generateAsync({ type: "uint8array" })
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    assert.ok(markdown.includes("법무부 《위원회》 발족\n및 조사 권고\n- 신뢰 회복의 첫걸음 -"), JSON.stringify(markdown))
    const edited = markdown.replace("및 조사 권고", "및 조사 권고 수정")
    const res = await patchHwpx(original, edited)
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped, [])
    assert.equal((await reparse(res.data!)).markdown, edited)
  })

  it("여러 줄 칸의 균등배분 꼴 줄(ㅇ 발 표)도 칸 전체 정리 기준으로 고친다 — 줄 하나만 보면 \"ㅇ발표\"로 붙는다", async () => {
    const original = new Uint8Array(await markdownToHwpx("| 구분 | 내용 |\n| --- | --- |\n| 세션 | ◼ 세션 1 : 실용·혁신의 협력 방안 모색<br>ㅇ 발 표 |"))
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    assert.ok(markdown.includes("◼ 세션 1 : 실용·혁신의 협력 방안 모색<br>ㅇ 발 표"), JSON.stringify(markdown))
    const edited = markdown.replace("<br>ㅇ 발 표", "<br>ㅇ 발 표 수정")
    const res = await patchHwpx(original, edited)
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped, [])
    assert.equal((await reparse(res.data!)).markdown, edited)
  })

  const REAL = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus", "korea-kr")
  const realDoc = existsSync(REAL) ? readdirSync(REAL).find(f => f.startsWith("156765958_") && f.includes("기본계획 시안") && f.endsWith(".hwpx")) : undefined
  const realDoc2 = existsSync(REAL) ? readdirSync(REAL).find(f => f.startsWith("156766011_") && f.endsWith(".hwpx")) : undefined
  it("균등배분 꼴 줄이 든 여러 줄 칸 GFM 표(실문서) — 칸 끝 고침을 표 좌표로 반영한다", { skip: !realDoc2 }, async () => {
    const original = new Uint8Array(readFileSync(join(REAL, realDoc2!)))
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    const unit = splitMarkdownUnits(markdown).find(u => u.kind === "gfm-table" && u.raw.includes("세션 1"))!
    const lines = unit.raw.split("\n")
    let k = 0
    for (let li = 2; li < lines.length && k < 2; li++) lines[li] = lines[li].replace(/\| ([^|]*?[가-힣][^|]*?) \|/, (_m, t) => (k++, `| ${t} 수정 |`))
    const res = await patchHwpx(original, markdown.replace(unit.raw, lines.join("\n")))
    assert.equal(res.applied, 2, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped.filter(s => !s.partial), [])
  })

  it("굵은 칸·두 줄 칸 GFM 표(실문서) — 칸 끝 고침을 표 좌표로 반영한다", { skip: !realDoc }, async () => {
    const original = new Uint8Array(readFileSync(join(REAL, realDoc!)))
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    const unit = splitMarkdownUnits(markdown).find(u => u.kind === "gfm-table" && u.raw.includes("**자율 과제**"))!
    const lines = unit.raw.split("\n")
    lines[2] = lines[2].replace(/\| ([^|]*?[가-힣][^|]*?) \|/, (_m, t) => `| ${t} 수정 |`)
    const res = await patchHwpx(original, markdown.replace(unit.raw, lines.join("\n")))
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped.filter(s => !s.partial), [])
  })

  it("GFM 셀 1개 수정 → 해당 셀만 반영", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("| 예산 | 홍길동 | 1억원 |", "| 예산 | 박영희 | 1억원 |")
    assert.notEqual(edited, markdown)

    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    assert.equal(res.skipped.length, 0)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
    assert.ok(r2.markdown.includes("박영희"))
    assert.ok(!r2.markdown.includes("홍길동"))
  })

  it("셀을 빈 값으로 변경", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("| 기간 | 김철수 | 6개월 |", "| 기간 |  | 6개월 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.ok(!r2.markdown.includes("김철수"))
    assert.equal(r2.markdown, edited)
  })

  it("표 행 추가 → 인접 행 복제로 반영 (v3.7)", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("| 기간 | 김철수 | 6개월 |", "| 기간 | 김철수 | 6개월 |\n| 신규 | 행추가 | 반영 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.equal(res.applied, 1)
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })
})

describe("patchHwpx: graceful skip", () => {
  it("문단 삭제 → 반영 (구조 편집, 기본)", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("\n\n마지막 문단.", "")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.deepEqual(res.skipped, [])
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("문단 추가 → 반영 (구조 편집, 기본)", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown + "\n\n완전히 새로 추가된 문단."
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.deepEqual(res.skipped, [])
    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited)
  })

  it("structure: false — 문단 삭제 → skip 보고 + 원본 유지", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("\n\n마지막 문단.", "")
    const res = await patchHwpx(original, edited, { structure: false })
    assert.ok(res.success)
    assert.ok(res.skipped.some(s => s.reason.includes("삭제")), `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.ok(r2.markdown.includes("마지막 문단."), "삭제 미지원 — 원본 유지")
    // 검증 리포트에 잔차가 정직하게 보고됨
    assert.equal(res.verification?.stats.removed, 1)
  })

  it("structure: false — 문단 추가 → skip 보고", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown + "\n\n완전히 새로 추가된 문단."
    const res = await patchHwpx(original, edited, { structure: false })
    assert.ok(res.success)
    assert.ok(res.skipped.some(s => s.reason.includes("추가")), `skipped: ${JSON.stringify(res.skipped)}`)
    const r2 = await reparse(res.data!)
    assert.ok(!r2.markdown.includes("새로 추가된 문단"))
  })

  it("HWPX 아닌 입력 → success false + error", async () => {
    const res = await patchHwpx(new Uint8Array([1, 2, 3, 4]), "# 아무거나")
    assert.equal(res.success, false)
    assert.ok(res.error)
  })
})

describe("patchHwpx: ZIP 무결성", () => {
  it("mimetype 첫 엔트리 + STORE 보존", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited = markdown.replace("마지막 문단.", "수정된 마지막 문단.")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.data)
    const d = res.data!
    // 로컬 헤더: PK\x03\x04, 압축방식(offset 8) = 0(STORE), 이름(offset 30~) = mimetype
    assert.equal(d[0], 0x50); assert.equal(d[1], 0x4b); assert.equal(d[2], 0x03); assert.equal(d[3], 0x04)
    assert.equal(d[8] | (d[9] << 8), 0, "mimetype STORE")
    assert.equal(Buffer.from(d.subarray(30, 38)).toString(), "mimetype")
  })

  it("여러 번 수정해도 ZIP 구조 유지 (패치본 재패치)", async () => {
    const { original, markdown } = await makeSynthetic()
    const edited1 = markdown.replace("마지막 문단.", "1차 수정 문단.")
    const res1 = await patchHwpx(original, edited1)
    assert.ok(res1.success)
    const r1 = await reparse(res1.data!)
    const edited2 = r1.markdown.replace("1차 수정 문단.", "2차 수정 문단.")
    const res2 = await patchHwpx(res1.data!, edited2)
    assert.ok(res2.success)
    const r2 = await reparse(res2.data!)
    assert.ok(r2.markdown.includes("2차 수정 문단."))
  })
})

// ─── 소스맵 단위 테스트 ──────────────────────────────

const SECTION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hs="x" xmlns:hp="y"><hp:p id="1"><hp:run charPrIDRef="0"><hp:t>첫 문단 &amp;텍스트</hp:t></hp:run></hp:p><hp:p id="2"><hp:run charPrIDRef="1"><hp:t>둘째</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t> 문단</hp:t></hp:run></hp:p><hp:p id="3"><hp:run charPrIDRef="3"/></hp:p><hp:tbl rowCnt="1" colCnt="2"><hp:tr><hp:tc><hp:subList><hp:p id="4"><hp:run><hp:t>셀A</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc><hp:tc><hp:subList><hp:p id="5"><hp:run><hp:t>셀B</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl></hs:sec>`

describe("source-map: scanSectionXml", () => {
  it("본문 문단 / 셀 문단 / 표 앵커 추적", () => {
    const scan = scanSectionXml(SECTION_XML, 0)
    assert.equal(scan.bodyParagraphs.length, 3)
    assert.equal(scan.bodyParagraphs[0].text, "첫 문단 &텍스트")
    assert.equal(scan.bodyParagraphs[1].text, "둘째 문단")
    assert.equal(scan.bodyParagraphs[1].tRanges.length, 2)
    assert.equal(scan.tables.length, 1)
    assert.equal(scan.tables[0].rows.length, 1)
    const cellB = scan.tables[0].cellByAnchor.get("0,1")
    assert.ok(cellB)
    assert.equal(cellB!.paragraphs[0].text, "셀B")
  })

  it("buildParagraphSplices — 첫 t 치환 + 나머지 비움 + XML 이스케이프", () => {
    const scan = scanSectionXml(SECTION_XML, 0)
    const splices = buildParagraphSplices(scan.bodyParagraphs[1], "새 텍스트 <A&B>")!
    const out = applySplices(SECTION_XML, splices)
    assert.ok(out.includes("<hp:t>새 텍스트 &lt;A&amp;B&gt;</hp:t>"))
    assert.ok(out.includes('<hp:run charPrIDRef="2"><hp:t></hp:t></hp:run>'))
    // 다른 문단은 바이트 그대로
    assert.ok(out.includes("<hp:t>첫 문단 &amp;텍스트</hp:t>"))
    const rescan = scanSectionXml(out, 0)
    assert.equal(rescan.bodyParagraphs[1].text, "새 텍스트 <A&B>")
  })

  it("자기닫힘 <hp:run/> 빈 문단에 텍스트 삽입", () => {
    const scan = scanSectionXml(SECTION_XML, 0)
    const emptyPara = scan.bodyParagraphs[2]
    assert.equal(emptyPara.tRanges.length, 0)
    const splices = buildParagraphSplices(emptyPara, "채운 텍스트", SECTION_XML)!
    assert.ok(splices.length > 0)
    const out = applySplices(SECTION_XML, splices)
    assert.ok(out.includes('<hp:run charPrIDRef="3"><hp:t>채운 텍스트</hp:t></hp:run>'))
  })

  it("escape/decode 왕복", () => {
    const s = `a&b<c>"d"'e'`
    assert.equal(decodeXmlEntities(escapeXmlText(s)), s)
    assert.equal(decodeXmlEntities("&#xAC00;&#44033;"), "가각")
  })
})

// ─── ZIP 패치 단위 테스트 ────────────────────────────

describe("zip-patch: patchZipEntries", () => {
  it("교체 엔트리만 변경, 나머지 raw 바이트 보존 + 순서 유지", async () => {
    const zip = new JSZip()
    zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
    zip.file("a.xml", "<a>원본</a>")
    zip.file("b.bin", new Uint8Array([1, 2, 3, 250]))
    const orig = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))

    const patched = patchZipEntries(orig, new Map([["a.xml", new TextEncoder().encode("<a>수정</a>")]]))

    const z2 = await JSZip.loadAsync(patched)
    assert.equal(await z2.file("a.xml")!.async("text"), "<a>수정</a>")
    assert.equal(await z2.file("mimetype")!.async("text"), "application/hwp+zip")
    assert.deepEqual(Array.from(await z2.file("b.bin")!.async("uint8array")), [1, 2, 3, 250])

    // 미변경 엔트리 압축 바이트까지 동일
    const ea = readZipEntries(orig)
    const eb = readZipEntries(patched)
    assert.equal(Buffer.compare(Buffer.from(ea.get("b.bin")!.compData), Buffer.from(eb.get("b.bin")!.compData)), 0)
    assert.equal(Buffer.compare(Buffer.from(ea.get("mimetype")!.compData), Buffer.from(eb.get("mimetype")!.compData)), 0)
    // mimetype 첫 엔트리 유지
    assert.equal(Buffer.from(patched.subarray(30, 38)).toString(), "mimetype")
  })

  it("없는 엔트리 교체 시도 → 예외", async () => {
    const zip = new JSZip()
    zip.file("x", "1")
    const orig = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    assert.throws(() => patchZipEntries(orig, new Map([["없음", new Uint8Array()]])))
  })

  it("Node Buffer 입력 — 호출자의 원본 버퍼를 오염시키지 않음 (Buffer.slice는 view)", async () => {
    const zip = new JSZip()
    zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
    zip.file("a.xml", "<a>원본</a>")
    const asBuffer = Buffer.from(new Uint8Array(await zip.generateAsync({ type: "uint8array" })))
    const snapshot = Buffer.from(asBuffer)

    const patched = patchZipEntries(asBuffer, new Map([["a.xml", new TextEncoder().encode("<a>수정</a>")]]))
    assert.equal(Buffer.compare(asBuffer, snapshot), 0, "원본 Buffer 바이트 불변")
    const z2 = await JSZip.loadAsync(patched, { checkCRC32: true })
    assert.equal(await z2.file("a.xml")!.async("text"), "<a>수정</a>")
  })

  it("EOCD comment 안 가짜 시그니처에 속지 않음", async () => {
    const zip = new JSZip()
    zip.file("a.xml", "<a>원본</a>")
    const base = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    // 진짜 EOCD의 commentLen을 26으로 늘리고 comment 영역에 가짜 EOCD 시그니처 심기
    const evil = new Uint8Array(base.length + 26)
    evil.set(base, 0)
    const dv = new DataView(evil.buffer)
    let eocd = -1
    for (let i = base.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
    }
    dv.setUint16(eocd + 20, 26, true)
    dv.setUint32(base.length, 0x06054b50, true) // 역방향 탐색이 먼저 만나는 가짜

    // 가짜에 속으면 "ZIP에 없는 엔트리" 예외 (가짜 EOCD는 entries=0)
    const patched = patchZipEntries(evil, new Map([["a.xml", new TextEncoder().encode("<a>수정</a>")]]))
    // JSZip은 comment 검증을 안 해 가짜에 속으므로, comment-aware인 readZipEntries로 확인
    const entry = readZipEntries(patched).get("a.xml")
    assert.ok(entry, "진짜 EOCD로 엔트리 발견")
    const text = entry!.method === 0
      ? Buffer.from(entry!.compData).toString("utf-8")
      : inflateRawSync(entry!.compData).toString("utf-8")
    assert.equal(text, "<a>수정</a>", "진짜 EOCD로 정상 패치")
  })
})

// ─── 마크다운 유닛 단위 테스트 ───────────────────────

describe("markdown-units", () => {
  it("splitMarkdownUnits — 텍스트/GFM/HTML 표/구분선 분할", () => {
    const md = "문단 하나\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n<table>\n<tr><td>x</td></tr>\n</table>\n\n---\n\n끝"
    const units = splitMarkdownUnits(md)
    assert.deepEqual(units.map(u => u.kind), ["text", "gfm-table", "html-table", "separator", "text"])
  })

  it("parseGfmTable — 이스케이프 파이프 보존", () => {
    const rows = parseGfmTable(["| a\\|b | c |", "| --- | --- |", "| 1 | 2 |"])
    assert.equal(rows[0][0], "a\\|b")
    assert.equal(rows[1][1], "2")
  })

  it("parseHtmlTable — 중첩 표는 셀 inner로 흡수", () => {
    const rows = parseHtmlTable("<table>\n<tr><th>머리</th></tr>\n<tr><td><table>\n<tr><td>중첩</td></tr>\n</table></td></tr>\n</table>")!
    assert.equal(rows.length, 2)
    assert.ok(rows[1].cells[0].inner.includes("<table>"))
    const nested = extractTopLevelTables(rows[1].cells[0].inner)
    assert.equal(nested.length, 1)
    assert.ok(nested[0].includes("중첩"))
  })
})

// ─── 실파일 e2e (bench/corpus, gitignore — 존재할 때만) ─

// import.meta.dirname은 Node 20.11+ — Node 18 ESM 호환을 위해 fileURLToPath 사용
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")

describe("patchHwpx: 실파일 e2e (corpus 존재 시)", { skip: !existsSync(CORPUS) }, () => {
  it("seoul 결재문서 — 문단+HTML 셀 수정, 바이트 보존", async () => {
    const dir = join(CORPUS, "seoul")
    if (!existsSync(dir)) return
    const name = readdirSync(dir).find(f => f.endsWith(".hwpx"))
    if (!name) return
    const original = new Uint8Array(readFileSync(join(dir, name)))
    const parsed = await parseHwpx(toAB(original), { layoutTables: "keep" })
    assert.ok(parsed.success)
    const md = parsed.markdown

    // 첫 번째 충분히 긴 평문 라인 수정
    const line = md.split("\n").find(l => {
      const t = l.trim()
      return t.length > 20 && !/^[|<#!*]/.test(t) && !t.includes("](")
    })
    if (!line) return
    const edited = md.replace(line, line + " [라운드트립검증]")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    assert.ok(res.applied >= 1)

    const r2 = await reparse(res.data!)
    assert.equal(r2.markdown, edited, "수정 반영 + 나머지 전체 동일")
    await assertNonSectionEntriesIdentical(original, res.data!)
  })
})
