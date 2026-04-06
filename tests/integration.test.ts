/**
 * 통합 테스트 — 전체 파싱 파이프라인 검증
 *
 * 1부: 합성 HWPX — 프로그래밍적으로 생성한 문서로 정밀 마크다운 검증
 * 2부: 실제 문서 — tests/fixtures/에 있는 실제 공문서 파싱 (없으면 skip)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import JSZip from "jszip"
import { parse, parseHwpx, parseHwp, parsePdf, detectFormat } from "../src/index.js"
import { toArrayBuffer } from "../src/utils.js"

// ─── 헬퍼: 유효한 HWPX ZIP 생성 ─────────────────────────

async function makeHwpxZip(sections: { name: string; xml: string }[]): Promise<ArrayBuffer> {
  const zip = new JSZip()

  const spineRefs = sections.map((_, i) => `<opf:itemref idref="s${i}" />`).join("\n    ")
  const items = sections.map((s, i) =>
    `<opf:item id="s${i}" href="${s.name}" media-type="application/xml" />`
  ).join("\n    ")

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
  <opf:manifest>
    ${items}
  </opf:manifest>
  <opf:spine>
    ${spineRefs}
  </opf:spine>
</opf:package>`

  zip.file("Contents/content.hpf", manifest)
  for (const section of sections) {
    zip.file(`Contents/${section.name}`, section.xml)
  }

  return await zip.generateAsync({ type: "arraybuffer" })
}

function wrapSectionXml(bodyContent: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2016/HwpMl"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2016/HwpMl">
  ${bodyContent}
</hs:sec>`
}

// ─── fixture 경로 (dummy = CI용 커밋됨, sample = 로컬 실제 문서) ──

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures")

// CI에서도 돌아가는 dummy fixture (프로그래밍 생성, 커밋됨)
const DUMMY_HWPX = resolve(FIXTURES_DIR, "dummy.hwpx")

// 로컬 전용 실제 문서 fixture (gitignore, 있으면 추가 검증)
const FIXTURE_HWPX = resolve(FIXTURES_DIR, "sample.hwpx")
const FIXTURE_HWP = resolve(FIXTURES_DIR, "sample.hwp")
const FIXTURE_PDF = resolve(FIXTURES_DIR, "sample.pdf")

// ═══════════════════════════════════════════════════════
// 1부: 합성 HWPX 정밀 테스트
// ═══════════════════════════════════════════════════════

describe("합성 HWPX: 전체 파이프라인", () => {
  it("단일 단락 → 정확한 마크다운 출력", async () => {
    const xml = wrapSectionXml(`
      <hp:p><hp:run><hp:t>대한민국 헌법 제1조</hp:t></hp:run></hp:p>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parse(buf)

    assert.equal(result.success, true)
    assert.equal(result.fileType, "hwpx")
    if (result.success) {
      assert.equal(result.markdown.trim(), "대한민국 헌법 제1조")
      assert.ok(Array.isArray(result.blocks), "blocks 배열 존재")
      assert.ok(result.blocks.length >= 1, "최소 1개 블록")
    }
  })

  it("멀티 단락 → 줄바꿈으로 구분", async () => {
    const xml = wrapSectionXml(`
      <hp:p><hp:run><hp:t>첫 문장</hp:t></hp:run></hp:p>
      <hp:p><hp:run><hp:t>둘째 문장</hp:t></hp:run></hp:p>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("첫 문장") && result.markdown.includes("둘째 문장"),
        `두 단락 모두 포함: ${JSON.stringify(result.markdown)}`)
      const idx0 = result.markdown.indexOf("첫 문장")
      const idx1 = result.markdown.indexOf("둘째 문장")
      assert.ok(idx1 > idx0, "순서 보장")
    }
  })

  it("멀티 섹션 → 모든 섹션 텍스트 순서대로 포함", async () => {
    const s0 = wrapSectionXml(`<hp:p><hp:run><hp:t>제1장 총강</hp:t></hp:run></hp:p>`)
    const s1 = wrapSectionXml(`<hp:p><hp:run><hp:t>제2장 국민의 권리와 의무</hp:t></hp:run></hp:p>`)
    const buf = await makeHwpxZip([
      { name: "section0.xml", xml: s0 },
      { name: "section1.xml", xml: s1 },
    ])
    const result = await parse(buf)

    assert.equal(result.success, true)
    if (result.success) {
      const idx0 = result.markdown.indexOf("제1장 총강")
      const idx1 = result.markdown.indexOf("제2장 국민의 권리와 의무")
      assert.ok(idx0 >= 0 && idx1 > idx0, "섹션 순서 보장")
    }
  })

  it("테이블 → 마크다운 테이블 구조 정확", async () => {
    const xml = wrapSectionXml(`
      <hp:tbl>
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>이름</hp:t></hp:run></hp:p></hp:tc>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>직급</hp:t></hp:run></hp:p></hp:tc>
        </hp:tr>
        <hp:tr>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>홍길동</hp:t></hp:run></hp:p></hp:tc>
          <hp:tc><hp:cellSpan colSpan="1" rowSpan="1" /><hp:p><hp:run><hp:t>과장</hp:t></hp:run></hp:p></hp:tc>
        </hp:tr>
      </hp:tbl>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      // 헤더 행
      assert.ok(result.markdown.includes("| 이름 | 직급 |"),
        `헤더 행 정확: ${result.markdown}`)
      // 구분선
      assert.ok(result.markdown.includes("| --- | --- |"),
        `구분선 정확: ${result.markdown}`)
      // 데이터 행
      assert.ok(result.markdown.includes("| 홍길동 | 과장 |"),
        `데이터 행 정확: ${result.markdown}`)
    }
  })

  it("빈 단락은 마크다운에 포함되지 않음", async () => {
    const xml = wrapSectionXml(`
      <hp:p><hp:run><hp:t>첫 문장</hp:t></hp:run></hp:p>
      <hp:p></hp:p>
      <hp:p><hp:run><hp:t>마지막 문장</hp:t></hp:run></hp:p>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      // 빈 단락이 3줄 이상의 연속 줄바꿈을 만들지 않음
      assert.ok(!result.markdown.includes("\n\n\n"), "3연속 줄바꿈 없음")
    }
  })

  it("DOCTYPE → 제거 후 정상 파싱 (XXE 방어)", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE sec SYSTEM "evil.dtd">
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2016/HwpMl"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2016/HwpMl">
  <hp:p><hp:run><hp:t>안전한 텍스트</hp:t></hp:run></hp:p>
</hs:sec>`
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("안전한 텍스트"))
      assert.ok(!result.markdown.includes("DOCTYPE"))
    }
  })

  it("p > run > tbl 구조의 표를 정상 파싱 (issue #13)", async () => {
    const xml = wrapSectionXml(`
      <hp:p>
        <hp:run>
          <hp:tbl>
            <hp:tr>
              <hp:tc><hp:p><hp:run><hp:t>헤더1</hp:t></hp:run></hp:p></hp:tc>
              <hp:tc><hp:p><hp:run><hp:t>헤더2</hp:t></hp:run></hp:p></hp:tc>
            </hp:tr>
            <hp:tr>
              <hp:tc><hp:p><hp:run><hp:t>값1</hp:t></hp:run></hp:p></hp:tc>
              <hp:tc><hp:p><hp:run><hp:t>값2</hp:t></hp:run></hp:p></hp:tc>
            </hp:tr>
          </hp:tbl>
        </hp:run>
      </hp:p>
    `)
    const buf = await makeHwpxZip([{ name: "section0.xml", xml }])
    const result = await parseHwpx(buf)

    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.blocks.length > 0, "블록이 비어있지 않아야 함")
    assert.ok(result.markdown.includes("헤더1"), "표 헤더가 마크다운에 포함되어야 함")
    assert.ok(result.markdown.includes("값2"), "표 데이터가 마크다운에 포함되어야 함")
  })
})

describe("포맷 감지 + 에러 경로", () => {
  it("HWPX ZIP 매직바이트 감지", async () => {
    const buf = await makeHwpxZip([
      { name: "section0.xml", xml: wrapSectionXml(`<hp:p><hp:run><hp:t>test</hp:t></hp:run></hp:p>`) },
    ])
    assert.equal(detectFormat(buf), "hwpx")
  })

  it("빈 버퍼 → 에러 (크래시 없음)", async () => {
    const result = await parse(new ArrayBuffer(0))
    assert.equal(result.success, false)
  })

  it("랜덤 바이트 → unknown", async () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    const result = await parse(buf.buffer)
    assert.equal(result.success, false)
    assert.equal(result.fileType, "unknown")
  })
})

// ═══════════════════════════════════════════════════════
// 2부: dummy fixture (CI용 — 항상 실행)
// ═══════════════════════════════════════════════════════

describe("dummy fixture: HWPX 전체 파이프라인", { skip: !existsSync(DUMMY_HWPX) && "dummy fixture 없음" }, () => {
  it("dummy HWPX → success + 텍스트 포함", async () => {
    const buf = toArrayBuffer(readFileSync(DUMMY_HWPX))
    const result = await parseHwpx(buf)

    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.includes("서면자문"), "핵심 텍스트 포함")
      assert.ok(result.markdown.includes("홍길동"), "테이블 데이터 포함")
      assert.ok(result.markdown.includes("|"), "마크다운 테이블 존재")
    }
  })

  it("dummy HWPX → parse() 자동 감지", async () => {
    const buf = toArrayBuffer(readFileSync(DUMMY_HWPX))
    const result = await parse(buf)
    assert.equal(result.success, true)
    assert.equal(result.fileType, "hwpx")
  })
})

// ═══════════════════════════════════════════════════════
// 3부: 실제 문서 fixture (로컬 전용 — 없으면 skip)
// ═══════════════════════════════════════════════════════

describe("실제 문서: HWPX", { skip: !existsSync(FIXTURE_HWPX) && "fixture 없음" }, () => {
  it("실제 HWPX 파싱 → success + markdown 비어있지 않음", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_HWPX))
    const result = await parseHwpx(buf)

    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.length > 0, "마크다운 비어있지 않음")
      assert.ok(result.markdown.length > 50, `마크다운이 너무 짧음 (${result.markdown.length}자)`)
    }
  })

  it("실제 HWPX → 포맷 자동 감지 + parse()", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_HWPX))
    assert.equal(detectFormat(buf), "hwpx")

    const result = await parse(buf)
    assert.equal(result.success, true)
    assert.equal(result.fileType, "hwpx")
  })
})

describe("실제 문서: HWP 5.x", { skip: !existsSync(FIXTURE_HWP) && "fixture 없음" }, () => {
  it("실제 HWP 파싱 → success + markdown 비어있지 않음", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_HWP))
    const result = await parseHwp(buf)

    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.length > 0, "마크다운 비어있지 않음")
    }
  })

  it("실제 HWP → 포맷 자동 감지", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_HWP))
    assert.equal(detectFormat(buf), "hwp")
  })
})

describe("실제 문서: PDF", { skip: !existsSync(FIXTURE_PDF) && "fixture 없음" }, () => {
  it("실제 PDF 파싱 → success + markdown 비어있지 않음", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_PDF))
    const result = await parsePdf(buf)

    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.length > 0, "마크다운 비어있지 않음")
      assert.ok(result.markdown.length > 50, `마크다운이 너무 짧음 (${result.markdown.length}자)`)
    }
  })

  it("실제 PDF → 포맷 자동 감지", async () => {
    const buf = toArrayBuffer(readFileSync(FIXTURE_PDF))
    assert.equal(detectFormat(buf), "pdf")
  })
})

// ═══════════════════════════════════════════════════════
// 3부: 실제 문서 상호 비교 (동일 내용이 HWP/HWPX/PDF로 존재)
// ═══════════════════════════════════════════════════════

describe("실제 문서: 포맷 간 교차 검증", {
  skip: (!existsSync(FIXTURE_HWPX) || !existsSync(FIXTURE_HWP)) && "fixture 없음"
}, () => {
  it("같은 문서의 HWP와 HWPX 파싱 결과에 공통 텍스트 존재", async () => {
    const hwpxBuf = toArrayBuffer(readFileSync(FIXTURE_HWPX))
    const hwpBuf = toArrayBuffer(readFileSync(FIXTURE_HWP))

    const hwpxResult = await parseHwpx(hwpxBuf)
    const hwpResult = await parseHwp(hwpBuf)

    // 둘 다 성공해야 비교 의미 있음
    if (hwpxResult.success && hwpResult.success) {
      // 3글자 이상 한글 단어로 비교 (2글자는 "대한" 등 우연 매칭 가능)
      const hwpxWords = new Set(hwpxResult.markdown.match(/[가-힣]{3,}/g) || [])
      const hwpWords = new Set(hwpResult.markdown.match(/[가-힣]{3,}/g) || [])
      const smaller = Math.min(hwpxWords.size, hwpWords.size)
      const common = [...hwpxWords].filter(w => hwpWords.has(w))

      // 작은 쪽 대비 10% 이상 공통 단어 — 같은 문서라면 쉽게 넘음
      assert.ok(smaller > 0, "양쪽 모두 한글 단어가 있어야 함")
      const ratio = common.length / smaller
      assert.ok(ratio >= 0.1,
        `공통 단어 비율 ${(ratio * 100).toFixed(1)}% < 10% — HWPX: ${hwpxWords.size}개, HWP: ${hwpWords.size}개, 공통: ${common.length}개`)
    }
  })
})
