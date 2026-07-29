/** 누름틀(CLICK_HERE) 채우기 — 내장 표준 기안문 서식 + 필드 우선 매칭 회귀 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { fillHwpx } from "../src/form/filler-hwpx.js"
import { extractClickHereFields } from "../src/form/click-here.js"
import { BUILTIN_TEMPLATES, resolveBuiltinTemplate, readBuiltinTemplate, readBuiltinTemplateSample } from "../src/form/templates.js"
import { parse } from "../src/index.js"

const GIAN = fileURLToPath(new URL("../templates/일반기안문_서식.hwpx", import.meta.url))
const GIAN_SAMPLE = fileURLToPath(new URL("../templates/일반기안문_예시값.json", import.meta.url))
const SIMPLE = fileURLToPath(new URL("../templates/간이기안문_서식.hwpx", import.meta.url))
const SIMPLE_SAMPLE = fileURLToPath(new URL("../templates/간이기안문_예시값.json", import.meta.url))

function loadBuf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

const GIAN_FIELDS = [
  "행정기관명", "수신자", "경유", "제목", "본문", "붙임", "발신명의", "수신자명단",
  "기안자", "검토자", "결재권자", "협조자", "시행번호", "시행일", "접수번호", "접수일",
  "우편번호", "주소", "홈페이지", "전화번호", "팩스번호", "전자우편", "공개구분",
]
const SIMPLE_FIELDS = [
  "생산등록번호", "등록일", "결재일", "공개구분", "결재직위1", "결재직위2", "결재직위3",
  "결재직위4", "협조자", "제목", "요약설명", "작성일", "작성기관",
]

describe("extractClickHereFields — 내장 서식 필드 조사", () => {
  it("일반기안문: 누름틀 23곳의 이름을 문서 순서로 반환한다", async () => {
    const fields = await extractClickHereFields(loadBuf(GIAN))
    assert.deepEqual(fields.map(f => f.name), GIAN_FIELDS)
    assert.ok(fields.every(f => f.value === ""), "빈 서식 — 안내문은 값이 아니다")
    assert.equal(fields.find(f => f.name === "수신자")!.placeholder, "수신자(참조)")
  })

  it("간이기안문: 누름틀 13곳의 이름을 반환한다", async () => {
    const fields = await extractClickHereFields(loadBuf(SIMPLE))
    assert.deepEqual(fields.map(f => f.name), SIMPLE_FIELDS)
  })
})

describe("fillHwpx — 누름틀 채우기 (내장 표준 서식)", () => {
  it("일반기안문 예시값: 23/23 전부 매칭, unmatched 0", async () => {
    const values = JSON.parse(readFileSync(GIAN_SAMPLE, "utf-8"))
    const result = await fillHwpx(loadBuf(GIAN), values)
    assert.equal(result.unmatched.length, 0, `unmatched: ${result.unmatched.join(", ")}`)
    assert.equal(result.filled.length, 23, `filled: ${result.filled.map(f => f.label).join(", ")}`)
    assert.deepEqual(result.filled.map(f => f.label).sort(), [...GIAN_FIELDS].sort())
  })

  it("일반기안문 산출물: 재파싱 가능 + 채운 값·다문단 본문이 파싱 결과에 등장", async () => {
    const values = JSON.parse(readFileSync(GIAN_SAMPLE, "utf-8"))
    const result = await fillHwpx(loadBuf(GIAN), values)
    const reparsed = await parse(Buffer.from(result.buffer))
    assert.ok(reparsed.success, `재파싱 실패: ${reparsed.success ? "" : reparsed.error}`)
    const md = reparsed.markdown.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, "$1")
    assert.ok(md.includes("2026년 행정업무 자동화 시범사업 협조 요청"), "제목")
    assert.ok(md.includes("행정문서 자동화 시범사업"), "본문 중간 줄 (\\n 분리 값)")
    assert.ok(md.includes("중앙행정기관 및 지방자치단체"), "본문 마지막 줄")
    assert.ok(md.includes("행정사무관 ○○○"), "기안자")
    assert.ok(md.includes("www.example.go.kr"), "홈페이지")

    // \n → 문단 내 강제 줄바꿈(lineBreak) 요소로 들어간다
    const zip = await JSZip.loadAsync(result.buffer)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(/<hp:lineBreak\/>/.test(section), "다문단 본문의 lineBreak")
    assert.ok(!section.includes("linesegarray"), "수정 섹션의 조판 캐시 제거 (한컴 변조 경고 방지)")
  })

  it("간이기안문 예시값: 13/13 전부 매칭 + 재파싱 검증", async () => {
    const values = JSON.parse(readFileSync(SIMPLE_SAMPLE, "utf-8"))
    const result = await fillHwpx(loadBuf(SIMPLE), values)
    assert.equal(result.unmatched.length, 0, `unmatched: ${result.unmatched.join(", ")}`)
    assert.equal(result.filled.length, 13, `filled: ${result.filled.map(f => f.label).join(", ")}`)
    const reparsed = await parse(Buffer.from(result.buffer))
    assert.ok(reparsed.success)
    assert.ok(reparsed.markdown.includes("시범사업 추진계획 보고"), "제목")
    assert.ok(reparsed.markdown.includes("주무관"), "결재직위1")
  })

  it("값 안 준 필드는 원본 유지 — 안내문 파라미터·빈 영역 보존", async () => {
    const result = await fillHwpx(loadBuf(GIAN), { 제목: "부분 채움 테스트" })
    assert.equal(result.filled.length, 1)
    assert.equal(result.unmatched.length, 0)
    const after = await extractClickHereFields(result.buffer)
    assert.equal(after.find(f => f.name === "제목")!.value, "부분 채움 테스트")
    for (const f of after) {
      if (f.name === "제목") continue
      assert.equal(f.value, "", `값 안 준 필드 ${f.name}는 비어 있어야 한다`)
    }
    // 안내문(Clickhere Direction 파라미터)도 그대로
    assert.equal(after.find(f => f.name === "수신자")!.placeholder, "수신자(참조)")
  })

  it("#3380 회귀: 안내문과 동일한 값도 침묵 유실 없이 채워진다", async () => {
    // "수신자" 필드의 안내문이 "수신자(참조)" — 같은 값을 채워도 실 텍스트로 들어가야 한다
    const result = await fillHwpx(loadBuf(GIAN), { 수신자: "수신자(참조)" })
    assert.equal(result.filled.length, 1)
    assert.equal(result.filled[0].value, "수신자(참조)")
    const after = await extractClickHereFields(result.buffer)
    assert.equal(after.find(f => f.name === "수신자")!.value, "수신자(참조)")
    const reparsed = await parse(Buffer.from(result.buffer))
    assert.ok(reparsed.success && reparsed.markdown.replace(/\\([()])/g, "$1").includes("수신자(참조)"))
  })

  it("빈 문자열 값도 매칭으로 집계된다 (안내문 노출 유지, unmatched 아님)", async () => {
    const result = await fillHwpx(loadBuf(GIAN), { 경유: "", 협조자: "" })
    assert.equal(result.unmatched.length, 0)
    assert.equal(result.filled.length, 2)
    const after = await extractClickHereFields(result.buffer)
    assert.equal(after.find(f => f.name === "경유")!.value, "")
  })
})

// ─── 누름틀 + 라벨 경로 공존 ─────────────────────────

const CELL = (name: string, col: number, inner: string): string => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${inner}</hp:p></hp:subList><hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="2000" height="500"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`

async function makeMixedHwpx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
<hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>성명  </hp:t><hp:ctrl><hp:fieldBegin id="900001" type="CLICK_HERE" name="성명" editable="1"><hp:parameters cnt="1" name=""><hp:stringParam name="Command">Clickhere:set:48:Direction:wstring:2:이름 HelpState:wstring:0:  </hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="900001"/></hp:ctrl></hp:run></hp:p>
<hp:p id="2" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr>${CELL("l", 0, '<hp:run charPrIDRef="0"><hp:t>전화</hp:t></hp:run>')}${CELL("v", 1, '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>')}</hp:tr>${""}<hp:tr>${CELL("l2", 0, '<hp:run charPrIDRef="0"><hp:t>성명</hp:t></hp:run>')}${CELL("v2", 1, '<hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>')}</hp:tr></hp:tbl></hp:run></hp:p>
</hs:sec>`
  zip.file("Contents/section0.xml", sectionXml)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("fillHwpx — 누름틀 우선 매칭 + 라벨 경로 공존", () => {
  it("누름틀 name과 일치하는 키는 누름틀에만, 남은 키는 라벨 매칭으로 채워진다", async () => {
    const buffer = await makeMixedHwpx()
    const result = await fillHwpx(buffer, { 성명: "홍길동", 전화: "010-1234-5678" })

    assert.equal(result.unmatched.length, 0, `unmatched: ${result.unmatched.join(", ")}`)
    const byLabel = new Map(result.filled.map(f => [f.label, f]))
    assert.equal(byLabel.get("성명")?.value, "홍길동")
    assert.equal(byLabel.get("전화")?.value, "010-1234-5678")
    // 누름틀 우선 — "성명" 키는 누름틀에서 소진되어 표의 성명 라벨 셀에는 안 들어간다
    assert.equal(result.filled.filter(f => f.label === "성명").length, 1, "성명은 누름틀 1곳만")

    const zip = await JSZip.loadAsync(result.buffer)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    // 값이 fieldBegin ctrl과 fieldEnd ctrl 사이에 원래 run 서식으로 들어갔는지
    assert.match(section, /fieldBegin[\s\S]*?<\/hp:ctrl><hp:t>홍길동<\/hp:t><hp:ctrl><hp:fieldEnd/)
    assert.ok(section.includes("010-1234-5678"), "라벨 경로 값")
  })
})

// ─── 내장 템플릿 레지스트리 ───────────────────────────

describe("BUILTIN_TEMPLATES — 이름 해석과 자산 로드", () => {
  it("id·한글 별칭·templates: 접두사 표기를 모두 해석한다", () => {
    assert.equal(resolveBuiltinTemplate("gian")?.id, "gian")
    assert.equal(resolveBuiltinTemplate("gian-simple")?.id, "gian-simple")
    assert.equal(resolveBuiltinTemplate("일반기안문")?.id, "gian")
    assert.equal(resolveBuiltinTemplate("templates:간이기안문")?.id, "gian-simple")
    assert.equal(resolveBuiltinTemplate("없는서식"), undefined)
  })

  it("번들 서식 + 예시값으로 전 필드가 채워진다 (레지스트리 경로 왕복)", async () => {
    for (const t of BUILTIN_TEMPLATES) {
      const sample = readBuiltinTemplateSample(t)
      const result = await fillHwpx(readBuiltinTemplate(t), sample)
      assert.equal(result.unmatched.length, 0, `${t.id} unmatched: ${result.unmatched.join(", ")}`)
      assert.equal(result.filled.length, Object.keys(sample).length, `${t.id} filled`)
    }
  })
})
