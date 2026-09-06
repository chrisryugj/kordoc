/** HWPX 역변환 (generator) 테스트 — 라운드트립 검증 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { parse } from "../src/index.js"

describe("markdownToHwpx", () => {
  it("단순 텍스트 → HWPX → 라운드트립", async () => {
    const md = "대한민국 헌법 제1조"
    const hwpxBuf = await markdownToHwpx(md)

    assert.ok(hwpxBuf instanceof ArrayBuffer, "ArrayBuffer 반환")
    assert.ok(hwpxBuf.byteLength > 0, "비어있지 않음")

    // 라운드트립: 생성된 HWPX를 다시 파싱
    const result = await parse(hwpxBuf)
    assert.equal(result.success, true, `파싱 실패: ${result.success === false ? result.error : ""}`)
    if (result.success) {
      assert.ok(result.markdown.includes("대한민국 헌법 제1조"), "원본 텍스트 보존")
    }
  })

  it("멀티 단락 → 라운드트립", async () => {
    const md = "첫 번째 단락\n\n두 번째 단락\n\n세 번째 단락"
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("첫 번째 단락"))
      assert.ok(result.markdown.includes("두 번째 단락"))
      assert.ok(result.markdown.includes("세 번째 단락"))
    }
  })

  it("테이블 → HWPX → 라운드트립", async () => {
    const md = "| 이름 | 직급 |\n| --- | --- |\n| 홍길동 | 과장 |"
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("이름"), "헤더 보존")
      assert.ok(result.markdown.includes("홍길동"), "데이터 보존")
      // table 블록 존재
      assert.ok(result.blocks.some(b => b.type === "table"), "테이블 블록 존재")
    }
  })

  it("헤딩 + 본문 혼합", async () => {
    const md = "# 제1장 총강\n\n대한민국은 민주공화국이다.\n\n# 제2장 권리\n\n모든 국민은 법 앞에 평등하다."
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("제1장 총강"))
      assert.ok(result.markdown.includes("민주공화국"))
      assert.ok(result.markdown.includes("제2장 권리"))
    }
  })

  it("헤딩 레벨 왕복 보존 — OUTLINE paraPr 기반 (h5/h6은 h4로 압축)", async () => {
    const md = "# 장제목\n\n## 절제목\n\n### 관제목\n\n#### 항제목\n\n##### 목제목\n\n본문 문단입니다."
    const result = await parse(await markdownToHwpx(md))
    assert.equal(result.success, true)
    if (result.success) {
      const seq = [...result.markdown.matchAll(/^(#{1,6}) (.+)$/gm)].map(m => `${m[1].length}|${m[2].trim()}`)
      assert.deepEqual(seq, ["1|장제목", "2|절제목", "3|관제목", "4|항제목", "4|목제목"], "레벨+텍스트 시퀀스 보존")
      // 번호 서식이 비어 있으므로 "1." 같은 개요 번호 접두가 발명되면 안 됨
      assert.ok(!/# \d+\./.test(result.markdown), "개요 번호 접두 없음")
      const h = result.blocks.filter(b => b.type === "heading")
      assert.equal(h.length, 5, "heading 블록 5개")
    }
  })

  it("공문서 모드 헤딩 왕복 보존", async () => {
    const md = "# 사업계획\n\n1. 관련: 근거 공문\n\n2. 추진 개요입니다.\n\n## 세부 일정"
    const result = await parse(await markdownToHwpx(md, { gongmun: { preset: "기안문" } }))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(/^# 사업계획$/m.test(result.markdown), "h1 보존")
      // v5 기안문 본문의 h2는 법정 1단계 항목("3. 세부 일정")이 되고 스타일 "개요 2"로 헤딩 의미를 남긴다
      assert.ok(/^## 3\. 세부 일정$/m.test(result.markdown) || result.markdown.includes("세부 일정"), "h2 텍스트 보존")
      assert.ok(result.markdown.includes("1. 관련: 근거 공문"), "항목부호 유지")
    }
  })

  it("마스킹 별표 런 왕복 보존 — 이스케이프 대칭 (HR/볼드 오독 금지)", async () => {
    // 파서 escapeGfm 출력 형태의 md (개인정보 마스킹 별표)
    const md = "성명: 홍\\*\\*\n\n\\*\\*\\*\\*\\*\\*\n\n| 항목 | 값 |\n| --- | --- |\n| 주민번호 | \\*\\*\\*\\*\\*\\* |"
    const result = await parse(await markdownToHwpx(md))
    assert.equal(result.success, true)
    if (result.success) {
      // hwpx 본문에는 리터럴 별표 (백슬래시 없음, 강조/HR 소비 없음)
      assert.ok(result.blocks.some(b => b.type === "paragraph" && b.text === "******"), "별표 런 리터럴 보존")
      assert.ok(!result.blocks.some(b => b.text?.includes("\\")), "백슬래시 문서 혼입 없음")
      assert.ok(!result.markdown.includes("────"), "HR 오독 없음")
      // md 재출력은 다시 이스케이프 (왕복 고정점)
      assert.ok(result.markdown.includes("홍\\*\\*"), "이름 마스킹 재이스케이프")
      assert.ok(result.markdown.includes("\\*\\*\\*\\*\\*\\* |") || result.markdown.includes("| \\*\\*\\*\\*\\*\\*"), "셀 마스킹 재이스케이프")
    }
  })

  it("인라인 강조·인용 왕복 보존 — run-span 채널 (v4.0.6 회귀)", async () => {
    const md = "본문 **굵게** *기울임* `코드` ***겹강조***\n\n> 인용문\n"
    const result = await parse(await markdownToHwpx(md))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("**굵게**"), "볼드 마커 재방출")
      assert.ok(result.markdown.includes("*기울임*"), "이탤릭 마커 재방출")
      assert.ok(result.markdown.includes("`코드`"), "인라인 코드 마커 재방출")
      assert.ok(result.markdown.includes("***겹강조***"), "볼드이탤릭 마커 재방출")
      assert.ok(/^> 인용문$/m.test(result.markdown), "인용 접두 재방출")
      // 마커가 텍스트를 오염시키지 않음 — 평문화하면 원문과 동일
      const spans = result.blocks.find(b => b.spans)?.spans
      assert.ok(spans && spans.length >= 5, "run-span 채널 존재")
      assert.equal(spans!.map(s => s.text).join(""), "본문 굵게 기울임 코드 겹강조", "span 연결 = 문단 평문")
    }
  })

  it("셀 인라인 강조 왕복 — GFM 셀 마커 재방출 (v4.0.4 확장)", async () => {
    const md = "| 구분 | 내용 |\n|---|---|\n| **강조** | 평문 *기울임* |\n"
    const result = await parse(await markdownToHwpx(md))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("**강조**"), `셀 볼드 마커 재방출: ${result.markdown}`)
      assert.ok(result.markdown.includes("*기울임*"), "셀 이탤릭 마커 재방출")
    }
  })

  it("파서 indent 슬롯 — gongmun 리스트 깊이가 paraPr hc:left로 관찰된다 (v4.0.4)", async () => {
    const md = "1. 첫 항목\n   가. 둘째 단계 항목\n"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "기안문" } })
    const result = await parse(buf)
    assert.equal(result.success, true)
    if (result.success) {
      const first = result.blocks.find(b => (b.text ?? "").includes("첫 항목"))
      const second = result.blocks.find(b => (b.text ?? "").includes("둘째 단계"))
      assert.ok(second, "둘째 단계 문단 존재")
      // depth1(가.)은 hc:left 누적으로 depth0보다 깊다 — 마크다운 방출은 불변(관찰 슬롯)
      assert.ok((second!.indent ?? 0) > (first?.indent ?? 0),
        `indent 슬롯: depth1 ${second!.indent} > depth0 ${first?.indent ?? 0}`)
    }
  })

  it("외래(비 kordoc) hwpx — 실속성 볼드는 복원, 자사 id 규약(코드·인용)은 꺼진다 (v4.0.5 일반화)", async () => {
    // generator 산출물에서 content.hpf의 kordoc 메타만 제거해 외래 파일을 모사
    const JSZip = (await import("jszip")).default
    const buf = await markdownToHwpx("본문 **굵게** 평문 `코드`\n\n> 인용문\n")
    const zip = await JSZip.loadAsync(buf)
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    zip.file("Contents/content.hpf", hpf.replace(/<opf:metadata>[\s\S]*?<\/opf:metadata>\s*/, ""))
    const foreign = await zip.generateAsync({ type: "arraybuffer" })
    const result = await parse(foreign)
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("**굵게**"), "외래 실속성 볼드 마커 방출")
      assert.ok(!result.markdown.includes("`"), "외래 파일엔 자사 코드 id 규약 미적용")
      assert.ok(!/^> /m.test(result.markdown), "외래 파일엔 인용 접두 미방출")
      assert.ok(result.markdown.includes("본문"), "본문 텍스트는 보존")
    }
  })

  it("외래 hwpx 인접 동일서식 run 분할은 마커 1쌍으로 병합 (v4.0.5)", async () => {
    const JSZip = (await import("jszip")).default
    const buf = await markdownToHwpx("본문 **굵게** 평문\n")
    const zip = await JSZip.loadAsync(buf)
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    zip.file("Contents/content.hpf", hpf.replace(/<opf:metadata>[\s\S]*?<\/opf:metadata>\s*/, ""))
    // 한컴 편집 이력 run 분할 모사: bold run을 두 개로 쪼갬
    const sec = await zip.file("Contents/section0.xml")!.async("string")
    zip.file("Contents/section0.xml", sec.replace(
      '<hp:run charPrIDRef="1"><hp:t>굵게</hp:t></hp:run>',
      '<hp:run charPrIDRef="1"><hp:t>굵</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>게</hp:t></hp:run>'))
    const result = await parse(await zip.generateAsync({ type: "arraybuffer" }))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("**굵게**"), `분할 run 병합 재방출: ${result.markdown}`)
      assert.ok(!result.markdown.includes("****"), "run 경계 마커 오염 없음")
    }
  })

  it("외래 hwpx 전체 볼드 셀은 마커 억제(구조 서식), 혼합 셀만 복원 (v4.0.5)", async () => {
    const JSZip = (await import("jszip")).default
    const buf = await markdownToHwpx("| 라벨 | 값 |\n|---|---|\n| **전부볼드** | 평문 **부분** |\n")
    const zip = await JSZip.loadAsync(buf)
    const hpf = await zip.file("Contents/content.hpf")!.async("string")
    zip.file("Contents/content.hpf", hpf.replace(/<opf:metadata>[\s\S]*?<\/opf:metadata>\s*/, ""))
    const result = await parse(await zip.generateAsync({ type: "arraybuffer" }))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("| 전부볼드 |"), `전체 볼드 셀 억제: ${result.markdown}`)
      assert.ok(result.markdown.includes("평문 **부분**"), "혼합 셀은 복원")
    }
  })

  it("리스트 번호·마커 왕복 보존 (재시작·기호 변형 금지)", async () => {
    const md = "2. 위원별 의결서 각 1부.\n3. 안건심의결과 1부.\n\n- 항목 하나\n* 항목 둘"
    const result = await parse(await markdownToHwpx(md))
    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("2. 위원별 의결서"), "시작 번호 보존 (1로 재시작 금지)")
      assert.ok(result.markdown.includes("3. 안건심의결과"), "연번 보존")
      assert.ok(result.markdown.includes("- 항목 하나"), "대시 마커 보존 (· 변형 금지)")
    }
  })

  it("빈 마크다운 → 유효한 HWPX (빈 내용)", async () => {
    const hwpxBuf = await markdownToHwpx("")
    assert.ok(hwpxBuf.byteLength > 0, "ZIP은 생성됨")

    const result = await parse(hwpxBuf)
    // 빈 섹션이면 파싱은 성공하지만 내용 없음
    assert.equal(result.success, true)
  })

  it("특수문자 XML 이스케이프", async () => {
    const md = "A < B & C > D \"E\""
    const hwpxBuf = await markdownToHwpx(md)
    const result = await parse(hwpxBuf)

    assert.equal(result.success, true)
    if (result.success) {
      assert.ok(result.markdown.includes("A < B"), "< 보존")
      assert.ok(result.markdown.includes("& C"), "& 보존")
    }
  })
})
