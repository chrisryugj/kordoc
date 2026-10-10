/**
 * 서식 보존 회귀: 광진구 실문서 31건 검수(채우기·패치)에서 드러난 결함을 합성 문서로 고정한다.
 *  1. 채우기·패치가 섹션 전체의 줄 배치 캐시(linesegarray)를 지워 손대지 않은 쪽까지 다시 짜이던 것
 *  2. 패치가 굵게·밑줄 표지(** · <u>)를 글자로 찍고 run 서식(굵게·색)을 첫 run 하나로 합치던 것
 *  3. 균등 띄어쓰기 줄("기   간")을 건너뛰거나 공백을 접던 것
 *  4. 라벨 칸 채우기가 머리 칸·라벨 칸·다른 사람 칸을 덮어쓰던 것
 *  5. 서식 프로필이 underline type="NONE" 을 밑줄로 읽던 것
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx, hwpxToProfile } from "../src/index.js"
import { fillHwpx } from "../src/form/filler-hwpx.js"
import { extractFormSchema } from "../src/form/recognize.js"

const LINESEG = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function sectionOf(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return await zip.file("Contents/section0.xml")!.async("text")
}

/** 생성 문서의 section0.xml 을 고쳐 다시 묶는다 (한컴 저장본 꼴 재현용) */
async function withSection(buf: ArrayBuffer | Uint8Array, edit: (xml: string) => string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(buf)
  const xml = await zip.file("Contents/section0.xml")!.async("text")
  zip.file("Contents/section0.xml", edit(xml))
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
}

/** 모든 문단 끝에 줄 배치 캐시를 단다: 한컴 저장본처럼 */
const addLinesegs = (xml: string): string => xml.replace(/<\/hp:p>/g, `${LINESEG}</hp:p>`)

/** 안쪽 문단(다른 문단을 품지 않은 hp:p)의 글 → 캐시 유무 */
function innerParaSegs(xml: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const m of xml.matchAll(/<hp:p\b[^>]*>((?:(?!<hp:p\b)[\s\S])*?)<\/hp:p>/g)) {
    const text = [...m[1].matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(t => t[1]).join("")
    out.set(text, m[1].includes("<hp:linesegarray>"))
  }
  return out
}

async function markdownOf(data: Uint8Array): Promise<string> {
  const r = await parseHwpx(toAB(data), { layoutTables: "keep" })
  assert.ok(r.success)
  return r.markdown
}

// ─── 1. 줄 배치 캐시는 바뀐 문단만 ───────────────────────

describe("줄 배치 캐시(linesegarray): 글이 바뀐 문단만 지운다", () => {
  const MD = "첫 문단 글입니다.\n\n둘째 문단 글입니다.\n\n| 가나 | 다라 |\n| --- | --- |\n| 하나 | 두울 |\n\n끝 문단입니다."

  it("patchHwpx 본문 문단 수정: 그 문단 캐시만 지우고 나머지는 그대로", async () => {
    const original = await withSection(await markdownToHwpx(MD), addLinesegs)
    const before = (await sectionOf(original)).match(/<hp:linesegarray>/g)!.length
    const md = await markdownOf(original)
    const res = await patchHwpx(original, md.replace("둘째 문단 글입니다.", "둘째 문단을 고친 글입니다."))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    const segs = innerParaSegs(xml)
    assert.equal(segs.get("둘째 문단을 고친 글입니다."), false, "고친 문단 캐시 제거")
    assert.equal(segs.get("첫 문단 글입니다."), true, "앞 문단 캐시 유지")
    assert.equal(segs.get("끝 문단입니다."), true, "뒤 문단 캐시 유지")
    assert.equal(segs.get("하나"), true, "표 칸 캐시 유지")
    assert.equal(xml.match(/<hp:linesegarray>/g)!.length, before - 1)
  })

  it("patchHwpx 표 칸 수정: 그 칸 문단 캐시만 지우고 표를 담은 호스트 문단 캐시는 둔다", async () => {
    const original = await withSection(await markdownToHwpx(MD), addLinesegs)
    const before = (await sectionOf(original)).match(/<hp:linesegarray>/g)!.length
    const md = await markdownOf(original)
    const res = await patchHwpx(original, md.replace("| 하나 | 두울 |", "| 하나 | 두울셋 |"))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    const segs = innerParaSegs(xml)
    assert.equal(segs.get("두울셋"), false, "고친 칸 캐시 제거")
    assert.equal(segs.get("하나"), true, "옆 칸 캐시 유지")
    assert.equal(segs.get("첫 문단 글입니다."), true)
    assert.equal(xml.match(/<hp:linesegarray>/g)!.length, before - 1, "칸 문단만 (호스트 문단 글은 그대로)")
  })

  it("fillHwpx: 채운 칸 문단 캐시만 지운다 (호스트 문단·라벨 칸·본문은 그대로)", async () => {
    const original = await withSection(await markdownToHwpx("| 성명 | |\n| --- | --- |\n| 소속 | |\n\n다른 문단입니다."), addLinesegs)
    const before = (await sectionOf(original)).match(/<hp:linesegarray>/g)!.length
    const r = await fillHwpx(toAB(original), { 성명: "홍길동" })
    assert.equal(r.filled.length, 1)
    const xml = await sectionOf(r.buffer)
    const segs = innerParaSegs(xml)
    assert.equal(segs.get("홍길동"), false, "채운 칸 캐시 제거")
    assert.equal(segs.get("성명"), true, "라벨 칸 캐시 유지")
    assert.equal(segs.get("다른 문단입니다."), true, "본문 캐시 유지")
    assert.equal(xml.match(/<hp:linesegarray>/g)!.length, before - 1)
  })

  it("fillHwpx 누름틀: 채운 누름틀 문단의 캐시만 지운다", async () => {
    const gian = readFileSync(fileURLToPath(new URL("../templates/일반기안문_서식.hwpx", import.meta.url)))
    const original = await withSection(gian, addLinesegs)
    const before = (await sectionOf(original)).match(/<hp:linesegarray>/g)!.length
    const r = await fillHwpx(toAB(original), { 제목: "합성 제목 글" })
    assert.equal(r.filled.length, 1)
    const xml = await sectionOf(r.buffer)
    const p = [...xml.matchAll(/<hp:p\b[^>]*>((?:(?!<hp:p\b)[\s\S])*?)<\/hp:p>/g)].find(m => m[1].includes("합성 제목 글"))!
    assert.ok(!p[1].includes("<hp:linesegarray>"), "채운 누름틀 문단 캐시 제거")
    const after = xml.match(/<hp:linesegarray>/g)!.length
    assert.equal(after, before - 1, "나머지 캐시 유지")
  })
})

// ─── 2. 굵게·밑줄 표지와 run 서식 ─────────────────────────

describe("patchHwpx: 강조 표지를 글자로 찍지 않고 run 서식을 지킨다", () => {
  it("굵은 소제목 + 보통 글 문단: ** 가 글자로 남지 않고 굵은 run·보통 run 이 각자 고친 글을 받는다", async () => {
    const original = new Uint8Array(await markdownToHwpx("**□ 기획안** 내용입니다\n\n다음 문단."))
    const md = await markdownOf(original)
    assert.ok(md.includes("**□ 기획안** 내용입니다"), md)
    const edited = md.replace("**□ 기획안** 내용입니다", "**□ 새 기획안** 바뀐 내용입니다")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(!xml.includes("**"), "표지가 글자로 찍히면 안 된다")
    assert.match(xml, /<hp:run charPrIDRef="1">(?:(?!<\/hp:run>)[\s\S])*<hp:t>□ 새 기획안<\/hp:t><\/hp:run>/, "굵은 run 유지")
    assert.match(xml, /<hp:run charPrIDRef="0"><hp:t> 바뀐 내용입니다<\/hp:t><\/hp:run>/, "보통 run 유지")
    assert.ok((await markdownOf(res.data!)).includes("**□ 새 기획안** 바뀐 내용입니다"))
  })

  it("밑줄 표지(<u>)도 글자로 찍지 않는다", async () => {
    const original = new Uint8Array(await markdownToHwpx("공고 문단입니다.\n\n다음 문단."))
    const md = await markdownOf(original)
    const res = await patchHwpx(original, md.replace("공고 문단입니다.", "<u>일시</u>: 2026. 11. 3."))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(!xml.includes("&lt;u&gt;") && !xml.includes("<u>"), "밑줄 표지가 글자로 남으면 안 된다")
    assert.ok(xml.includes("일시: 2026. 11. 3."))
  })

  it("한 run 안만 고치면 다른 run(다른 글자 모양)은 바이트 그대로", async () => {
    const gen = await markdownToHwpx("첫 문단.\n\n앞쪽 글과 뒤쪽 글") // 첫 문단 run 은 secPr 를 나른다
    const original = await withSection(gen, xml => xml.replace(
      `<hp:run charPrIDRef="0"><hp:t>앞쪽 글과 뒤쪽 글</hp:t></hp:run>`,
      `<hp:run charPrIDRef="0"><hp:t>앞쪽 글과 </hp:t></hp:run><hp:run charPrIDRef="9"><hp:t>뒤쪽 글</hp:t></hp:run>`,
    ))
    const md = await markdownOf(original)
    const res = await patchHwpx(original, md.replace("앞쪽 글과 뒤쪽 글", "앞쪽 문장과 뒤쪽 글"))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(xml.includes(`<hp:run charPrIDRef="0"><hp:t>앞쪽 문장과 </hp:t></hp:run><hp:run charPrIDRef="9"><hp:t>뒤쪽 글</hp:t></hp:run>`), "두 run 유지")
  })

  it("표 칸(여러 색 제목 상자)도 바뀐 자리만 고쳐 다른 run 을 지킨다", async () => {
    const gen = await markdownToHwpx("첫 문단.\n\n| 머리 | 둘째 |\n| --- | --- |\n| 앞쪽 칸과 뒤쪽 칸 | 값 |")
    const original = await withSection(gen, xml => xml.replace(
      /<hp:run charPrIDRef="(\d+)"><hp:t>앞쪽 칸과 뒤쪽 칸<\/hp:t><\/hp:run>/,
      `<hp:run charPrIDRef="$1"><hp:t>앞쪽 칸과 </hp:t></hp:run><hp:run charPrIDRef="9"><hp:t>뒤쪽 칸</hp:t></hp:run>`,
    ))
    assert.ok((await sectionOf(original)).includes(`<hp:run charPrIDRef="9"><hp:t>뒤쪽 칸</hp:t></hp:run>`), "픽스처 run 분할")
    const md = await markdownOf(original)
    const res = await patchHwpx(original, md.replace("앞쪽 칸과 뒤쪽 칸", "앞쪽 셀과 뒤쪽 칸"))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(xml.includes(`<hp:t>앞쪽 셀과 </hp:t></hp:run><hp:run charPrIDRef="9"><hp:t>뒤쪽 칸</hp:t></hp:run>`), "칸 안 두 run 유지")
  })
})

// ─── 3. 균등 띄어쓰기 ──────────────────────────────────

describe("patchHwpx: 균등 띄어쓰기 줄", () => {
  it("원문이 여러 칸 띄운 굵은 머리(**□ 일    시**)는 같은 띄어쓰기로 고칠 수 있다", async () => {
    const gen = await markdownToHwpx("**□ 일 시**: 2026. 10. 1.\n\n다음 문단.")
    const original = await withSection(gen, xml => xml.replace("<hp:t>□ 일 시</hp:t>", "<hp:t>□ 일    시</hp:t>"))
    const md = await markdownOf(original)
    assert.ok(md.includes("**□ 일    시**: 2026. 10. 1."), md)
    const res = await patchHwpx(original, md.replace("2026. 10. 1.", "2027. 3. 5."))
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(xml.includes("<hp:t>□ 일    시</hp:t>"), "균등 띄어쓰기 보존")
    assert.ok(xml.includes("2027. 3. 5."))
  })

  it("마크다운이 접어 보인 띄어쓰기(대 상)는 고치지 않은 자리에서 원문 그대로 남는다", async () => {
    const gen = await markdownToHwpx("대상 문단: 9세 여성\n\n다음 문단.")
    const original = await withSection(gen, xml => xml.replace("<hp:t>대상 문단: 9세 여성</hp:t>", "<hp:t>대    상: 9세 여성</hp:t>"))
    const md = await markdownOf(original)
    assert.ok(md.includes("대 상: 9세 여성"), md)
    const res = await patchHwpx(original, md.replace("대 상: 9세 여성", "대 상: 12세 여성 청소년"))
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    const xml = await sectionOf(res.data!)
    assert.ok(xml.includes("<hp:t>대    상: 12세 여성 청소년</hp:t>"), xml.slice(xml.indexOf("상:") - 40, xml.indexOf("상:") + 40))
  })
})

// ─── 4. 라벨 칸 채우기 ─────────────────────────────────

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

interface CellDef { r: number; c: number; text: string; cs?: number; rs?: number }

function tcXml(d: CellDef): string {
  const run = d.text ? `<hp:run charPrIDRef="0"><hp:t>${d.text}</hp:t></hp:run>` : `<hp:run charPrIDRef="0"/>`
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${run}</hp:p></hp:subList><hp:cellAddr colAddr="${d.c}" rowAddr="${d.r}"/><hp:cellSpan colSpan="${d.cs ?? 1}" rowSpan="${d.rs ?? 1}"/><hp:cellSz width="2000" height="500"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
}

/** 행별 칸 정의(병합 좌표 직접 지정) → 표 문단 */
function tableXml(rows: CellDef[][]): string {
  const trs = rows.map(cells => `<hp:tr>${cells.map(tcXml).join("")}</hp:tr>`).join("")
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl>${trs}</hp:tbl></hp:run></hp:p>`
}

async function makeHwpx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

/** 채운 섹션에서 칸 좌표 → 글 */
async function cellTexts(buf: ArrayBuffer): Promise<Map<string, string>> {
  const xml = await sectionOf(buf)
  const out = new Map<string, string>()
  for (const m of xml.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)) {
    const a = /colAddr="(\d+)" rowAddr="(\d+)"/.exec(m[0])!
    out.set(`${a[2]},${a[1]}`, [...m[0].matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(t => t[1]).join(""))
  }
  return out
}

describe("fillHwpx: 라벨 칸 채우기 방향과 덮어쓰기", () => {
  it("표 가운데 머리 행(왼쪽 구역 라벨 rowSpan): 값은 머리 아래 칸에, 머리 칸은 그대로", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "성명" }, { r: 0, c: 1, text: "", cs: 3 }],
      [{ r: 1, c: 0, text: "학력사항", rs: 2 }, { r: 1, c: 1, text: "학교명" }, { r: 1, c: 2, text: "전 공" }, { r: 1, c: 3, text: "재학기간" }],
      [{ r: 2, c: 1, text: "" }, { r: 2, c: 2, text: "" }, { r: 2, c: 3, text: "" }],
    ]))
    const r = await fillHwpx(buf, { 성명: "김가온", 학교명: "가온고등학교", "전 공": "사회체육학", 재학기간: "2001~2004" })
    const t = await cellTexts(r.buffer)
    assert.equal(t.get("0,1"), "김가온")
    assert.equal(t.get("1,2"), "전 공", "머리 칸 보존")
    assert.equal(t.get("1,3"), "재학기간", "머리 칸 보존")
    assert.equal(t.get("2,1"), "가온고등학교")
    assert.equal(t.get("2,2"), "사회체육학")
    assert.equal(t.get("2,3"), "2001~2004")
    assert.deepEqual(r.unmatched, [])
  })

  it("머리 아래 첫 칸이 줄 이름표(고등학교·대학원)면 스칼라 값은 아래 행으로 내려가 이름표를 덮지 않는다", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "학력사항", rs: 3 }, { r: 0, c: 1, text: "학교명" }, { r: 0, c: 2, text: "전 공" }, { r: 0, c: 3, text: "재학기간" }],
      [{ r: 1, c: 1, text: "고등학교" }, { r: 1, c: 2, text: "" }, { r: 1, c: 3, text: "" }],
      [{ r: 2, c: 1, text: "대학원" }, { r: 2, c: 2, text: "" }, { r: 2, c: 3, text: "" }],
    ]))
    const r = await fillHwpx(buf, { 학교명: "가온고등학교", "전 공": "사회체육학" })
    const t = await cellTexts(r.buffer)
    assert.equal(t.get("1,1"), "고등학교")
    assert.equal(t.get("2,1"), "대학원", "아래 줄 이름표 보존")
    assert.equal(t.get("1,2"), "사회체육학")
    assert.deepEqual(r.unmatched, ["학교명"])
  })

  it("머리 행 왼쪽에 rowSpan 칸이 있어도 값이 한 칸씩 밀리지 않는다 (칸 좌표로 맞춘다)", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "후 보 자", rs: 2 }, { r: 0, c: 1, text: "성 명" }, { r: 0, c: 2, text: "소속" }, { r: 0, c: 3, text: "직급" }],
      [{ r: 1, c: 1, text: "" }, { r: 1, c: 2, text: "" }, { r: 1, c: 3, text: "" }],
    ]))
    const r = await fillHwpx(buf, { "성 명": "김가온", 소속: "총무과", 직급: "행정6급" })
    const t = await cellTexts(r.buffer)
    assert.equal(t.get("1,1"), "김가온")
    assert.equal(t.get("1,2"), "총무과")
    assert.equal(t.get("1,3"), "행정6급")
    assert.equal(t.get("0,2"), "소속")
  })

  it("아래 행이 통째로 빈 머리 행: 긴 머리(라벨 꼴이 아닌 글)도 덮지 않고 아래 칸에 쓴다", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "설치예정위치", cs: 2 }, { r: 0, c: 2, text: "검토의견 (의견제출 내용)", cs: 4 }],
      [{ r: 1, c: 0, text: "", cs: 2 }, { r: 1, c: 2, text: "", cs: 4 }],
    ]))
    const r = await fillHwpx(buf, { 설치예정위치: "버스정류장 앞", "검토의견 (의견제출 내용)": "찬성합니다" })
    const t = await cellTexts(r.buffer)
    assert.equal(t.get("0,2"), "검토의견 (의견제출 내용)")
    assert.equal(t.get("1,0"), "버스정류장 앞")
    assert.equal(t.get("1,2"), "찬성합니다")
  })

  it("같은 라벨이 두 곳: 두 번째의 이미 적힌 내용(수신자 명단)은 덮지 않는다", async () => {
    const buf = await makeHwpx(
      tableXml([[{ r: 0, c: 0, text: "수신자" }, { r: 0, c: 1, text: "수신자 참조" }]])
      + tableXml([[{ r: 0, c: 0, text: "수신자" }, { r: 0, c: 1, text: "홍길동 의원님, 김철수 의원님" }]]),
    )
    const r = await fillHwpx(buf, { 수신자: "내부결재" })
    const xml = await sectionOf(r.buffer)
    assert.ok(xml.includes("<hp:t>내부결재</hp:t>"), "첫 등장은 채운다")
    assert.ok(xml.includes("홍길동 의원님, 김철수 의원님"), "끝의 수신자 명단 보존")
    assert.equal(r.filled.length, 1)
  })

  it("법령 서식(칸 안 라벨): 옆 라벨 칸·다른 사람의 (전화번호: ) 칸은 덮지 않고 라벨 칸 안에 쓴다", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "신고인", rs: 2 }, { r: 0, c: 1, text: "건축주", cs: 4 }],
      [{ r: 1, c: 1, text: "전화번호", cs: 4 }],
      [{ r: 2, c: 0, text: "대지위치", cs: 3 }, { r: 2, c: 3, text: "① 지번", cs: 2 }],
      [{ r: 3, c: 0, text: "허가번호", cs: 3 }, { r: 3, c: 3, text: "허가일자", cs: 2 }],
      [{ r: 4, c: 0, text: "설계자", rs: 2 }, { r: 4, c: 1, text: "성명", cs: 4 }],
      [{ r: 5, c: 1, text: "사무소 주소(전화번호:  )", cs: 4 }],
    ]))
    const r = await fillHwpx(buf, { 건축주: "김가온", 전화번호: "010-0000-1234", 대지위치: "가상동 100-1", 허가번호: "2026-1", 허가일자: "2026. 9. 1." })
    const t = await cellTexts(r.buffer)
    assert.equal(t.get("2,3"), "① 지번", "옆 라벨 칸 보존")
    assert.equal(t.get("5,1"), "사무소 주소(전화번호:  )", "다른 사람의 전화번호 칸 보존")
    assert.equal(t.get("0,1"), "건축주 김가온")
    assert.equal(t.get("1,1"), "전화번호 010-0000-1234")
    assert.equal(t.get("2,0"), "대지위치 가상동 100-1")
    assert.equal(t.get("3,0"), "허가번호 2026-1")
    assert.equal(t.get("3,3"), "허가일자 2026. 9. 1.")
    assert.deepEqual(r.unmatched, [])
  })

  it("양식 스키마도 머리 행은 아래 칸을 값으로 본다 (채우기와 같은 방향)", async () => {
    const buf = await makeHwpx(tableXml([
      [{ r: 0, c: 0, text: "후 보 자", rs: 2 }, { r: 0, c: 1, text: "성 명" }, { r: 0, c: 2, text: "소속" }, { r: 0, c: 3, text: "직급" }],
      [{ r: 1, c: 1, text: "" }, { r: 1, c: 2, text: "" }, { r: 1, c: 3, text: "" }],
    ]))
    const parsed = await parseHwpx(buf, { layoutTables: "keep" })
    assert.ok(parsed.success)
    const fields = extractFormSchema(parsed.blocks).fields
    const labels = fields.map(f => f.label)
    assert.ok(!labels.includes("후 보 자"), `구역 라벨은 칸이 아니다: ${labels.join(",")}`)
    for (const l of ["성 명", "소속", "직급"]) {
      const f = fields.find(x => x.label === l)
      assert.ok(f, `${l} 없음: ${labels.join(",")}`)
      assert.equal(f!.row, 1)
      assert.equal(f!.empty, true)
    }
  })
})

// ─── 5. 서식 프로필 밑줄 ───────────────────────────────

describe("hwpxToProfile: 밑줄 판별", () => {
  it("<hh:underline type=\"NONE\"> 은 밑줄이 아니고 BOTTOM 만 밑줄이다", async () => {
    const gen = await markdownToHwpx("| a | b |\n|---|---|\n| 1 | 2 |")
    const zip = await JSZip.loadAsync(gen)
    let header = await zip.file("Contents/header.xml")!.async("text")
    header = header.replace(/(<hh:charPr id="0"[^>]*>)/, `$1<hh:underline type="NONE" shape="SOLID" color="#000000"/>`)
    zip.file("Contents/header.xml", header)
    const none = await hwpxToProfile(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(Object.values(none.tables[0].used_char_prs ?? {}).every(cp => !cp.underline), "NONE 은 밑줄 아님")

    zip.file("Contents/header.xml", header.replace(`<hh:underline type="NONE"`, `<hh:underline type="BOTTOM"`))
    const bottom = await hwpxToProfile(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(Object.values(bottom.tables[0].used_char_prs ?? {}).some(cp => cp.underline), "BOTTOM 은 밑줄")
  })
})
