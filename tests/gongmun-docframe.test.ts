// v4.1.0 실측 벤치마킹 신규 동작 — bullet2·리스트 간격·두문결문·공고문·보도자료·* 참고
import { describe, it } from "node:test"
import assert from "node:assert"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { resolveGongmun } from "../src/hwpx/gongmun.js"

async function part(buf: ArrayBuffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return await zip.file(name)!.async("text")
}
const texts = (sec: string) => [...sec.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).filter(Boolean)

describe("bullet2 ㅇ/○ (GAP-06)", () => {
  it("기본값 — 보고서 ○, 통지·보도자료 ㅇ", () => {
    assert.equal(resolveGongmun({ preset: "report" }).bullet2, "○")
    assert.equal(resolveGongmun({ preset: "notice" }).bullet2, "ㅇ")
    assert.equal(resolveGongmun({ preset: "press" }).bullet2, "ㅇ")
  })
  it("보고서 리스트 2단계 부호 전환", async () => {
    const md = "- 대항목\n  - 중항목"
    const on = texts(await part(await markdownToHwpx(md, { gongmun: { preset: "report", bullet2: "ㅇ" } }), "Contents/section0.xml"))
    assert.ok(on.some((t) => t.startsWith("ㅇ ")), `ㅇ 부호: ${on}`)
    const off = texts(await part(await markdownToHwpx(md, { gongmun: { preset: "report" } }), "Contents/section0.xml"))
    assert.ok(off.some((t) => t.startsWith("○ ")), `○ 부호: ${off}`)
  })
})

describe("report 리스트 문단 위 간격 실측값 (GAP-05)", () => {
  it("□3000/○2000/-1200 — t2 양식 저장값", async () => {
    const buf = await markdownToHwpx("- a\n  - b\n    - c", { gongmun: { preset: "report" } })
    const head = await part(buf, "Contents/header.xml")
    // 리스트 paraPr 8·9·10의 prev(문단 위) — gaejosikSpaceBefore와 동일 스케일
    const prevs = [...head.matchAll(/<hh:paraPr id="(8|9|10)"[\s\S]*?<hc:prev value="(\d+)"/g)].map((m) => [m[1], m[2]])
    assert.deepEqual(prevs, [["8", "3000"], ["9", "2000"], ["10", "1200"]])
  })
})

describe("기안문 두문·결문 (GAP-02)", () => {
  it("docHead/docFoot 문단 방출 — 별지 제1호서식 골격", async () => {
    const buf = await markdownToHwpx("본문입니다.", {
      gongmun: {
        preset: "official",
        docHead: { org: "행정안전부", to: "수신자 제위", title: "협조 요청" },
        docFoot: { sender: "행정안전부장관", drafter: "홍길동", approver: "김과장", docNum: "혁신과-123", phone: "044-205-1234", disclosure: "대국민공개" },
      },
    })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.ok(ts.includes("행정안전부"))
    assert.ok(ts.includes("수신  ") && ts.includes("수신자 제위"))
    assert.ok(ts.includes("(경유)"))
    assert.ok(ts.includes("제목  ") && ts.includes("협조 요청"))
    assert.ok(ts.includes("행정안전부장관"))
    assert.ok(ts.some((t) => t.includes("기안자 홍길동") && t.includes("결재권자 김과장")))
    assert.ok(ts.some((t) => t.includes("시행  혁신과-123")))
    assert.ok(ts.some((t) => t.includes("전화 044-205-1234") && t.includes("대국민공개")))
    // 결문은 "끝." 뒤에 온다 (별지서식 순서)
    const endIdx = ts.findIndex((t) => t.trim() === "끝.")
    const senderIdx = ts.indexOf("행정안전부장관")
    assert.ok(endIdx >= 0 && senderIdx > endIdx, `끝.(${endIdx}) 뒤 발신명의(${senderIdx})`)
  })
  it("docframe 미사용 시 charPr 불변 (기존 산출물 보존)", async () => {
    const buf = await markdownToHwpx("본문", { gongmun: { preset: "official" } })
    const head = await part(buf, "Contents/header.xml")
    assert.ok(!/height="2200"/.test(head), "발신명의 22pt charPr 미방출")
  })
})

describe("공고문 두문·결문 (GAP-08)", () => {
  it("공고번호 선두·날짜/발신명의 우측 + h2 아라비아 기본", async () => {
    const buf = await markdownToHwpx("# 공고 제목\n\n## 사업개요\n\n본문", {
      gongmun: { preset: "notice", noticeHead: { no: "행정안전부 공고 제2026-190호", date: "2026년 7월 11일", sender: "행정안전부장관" } },
    })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.equal(ts[0], "행정안전부 공고 제2026-190호")
    assert.ok(ts.includes("1. 사업개요"), `h2 number 기본: ${ts}`)
    assert.ok(ts.indexOf("행정안전부장관") > ts.indexOf("본문"))
  })
})

describe("보고정보 행 (GAP-04)", () => {
  it("최상단 우측 12pt", async () => {
    const buf = await markdownToHwpx("- 항목", { gongmun: { preset: "report", reportInfo: "(2026. 7. 11., 과장 홍길동, ☎02-120)" } })
    const sec = await part(buf, "Contents/section0.xml")
    const ts = texts(sec)
    assert.equal(ts[0], "(2026. 7. 11., 과장 홍길동, ☎02-120)")
    const head = await part(buf, "Contents/header.xml")
    assert.match(head, /height="1200"/)
  })
})

describe("보도자료 프리셋 (GAP-03)", () => {
  it("머리박스·제목 25pt·부제·ㅇ 부호·* 각주·담당 표", async () => {
    const md = "# 철도의 날 기념행사 개최\n\n- 국토교통부는 기념식을 개최함\n  - 이번 기념식은 성과를 공유함\n    - (주최) 국토교통부"
    const buf = await markdownToHwpx(md, {
      gongmun: {
        preset: "보도자료",
        press: { release: "2026. 7. 14.(월) 조간", distribute: "2026. 7. 11.(금)", sub: ["해외진출 성과 공유"], contact: { dept: "철도정책과", manager: "김주무관", phone: "044-201-3939" } },
      },
    })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.ok(ts.includes("보도자료"))
    assert.ok(ts.some((t) => t.includes("보도시점 : 2026. 7. 14.(월) 조간") && t.includes("배포 : 2026. 7. 11.(금)")))
    assert.ok(ts.includes("철도의 날 기념행사 개최"))
    assert.ok(ts.includes("- 해외진출 성과 공유 -"))
    assert.ok(ts.some((t) => t.startsWith("ㅇ ")), `2단계 ㅇ: ${ts}`)
    assert.ok(ts.some((t) => t.startsWith("* ")), `3단계 * 각주: ${ts}`)
    assert.ok(ts.includes("철도정책과") && ts.includes("044-201-3939"))
    const head = await part(buf, "Contents/header.xml")
    assert.match(head, /height="2500"/) // 제목 25pt
  })
})

describe("* 참고 문단 (GAP-15)", () => {
  it("실측 프리셋에서 '*' 마커 항목 → ※ 참고 스타일(한양중고딕 13pt)", async () => {
    const buf = await markdownToHwpx("- 항목\n\n* 정부 예산 범위 내에서 지원 예정", { gongmun: { preset: "report" } })
    const sec = await part(buf, "Contents/section0.xml")
    // 참고 문단은 GJ_PARA_CHAM(20)·GJ_CHAR_CHAM(13) 참조, 부호 '*' 유지
    assert.match(sec, /<hp:p paraPrIDRef="20"[^>]*><hp:run charPrIDRef="13"[^>]*><hp:t>\* 정부 예산/)
    // '-' 마커 항목은 여전히 □ 리스트
    assert.ok(texts(sec).some((t) => t.startsWith("□ 항목")))
  })
})

describe("QA 반려 결함 회귀 (v4.0.2)", () => {
  it("단일 형제도 기본은 부호 부여 — 부호 없는 계단 금지 (실무자 QA)", async () => {
    const buf = await markdownToHwpx("- 하나뿐인 항목\n  - 하위도 하나", { gongmun: { preset: "official" } })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.ok(ts.includes("1. 하나뿐인 항목"), `depth0 부호: ${ts}`)
    assert.ok(ts.includes("가. 하위도 하나"), `depth1 부호: ${ts}`)
  })
  it("suppressSingle 옵트인 시 부호 생략 + 내어쓰기 없는 전용 paraPr(25+depth)", async () => {
    // 단일 형제 체인 [0,1] → 전부 부호 생략 → plain paraPr 25·26 사용, 유령 내어쓰기 금지
    const buf = await markdownToHwpx("- 하나뿐인 항목\n  - 하위도 하나", { gongmun: { preset: "official", suppressSingle: true } })
    const sec = await part(buf, "Contents/section0.xml")
    // 첫 문단은 secPr·colPr가 run에 주입되므로 paraPr id와 텍스트만 확인
    assert.match(sec, /<hp:p paraPrIDRef="25"[^>]*>[\s\S]*?<hp:t>하나뿐인 항목/)
    assert.match(sec, /<hp:p paraPrIDRef="26"[^>]*>[\s\S]*?<hp:t>하위도 하나/)
    const head = await part(buf, "Contents/header.xml")
    // plain paraPr 25는 intent 0 (유령 내어쓰기 금지)
    const m = head.match(/<hh:paraPr id="25"[\s\S]*?<hc:intent value="(-?\d+)"/)
    assert.ok(m && m[1] === "0", `plain paraPr intent=0: ${m?.[1]}`)
  })
  it("표 짧은 열 — 실패딩(inMargin 1020) 반영 폭으로 세로 쪼개짐 방지", async () => {
    const md = "| 구분 | 추진과제 | 소요예산(백만원) | 추진일정 | 담당부서 |\n| --- | --- | --- | --- | --- |\n| 단기 | 문서 자동화 시스템 구축 및 시범 운영 실시 | 350 | 2026. 3.~6. | 정보화담당관 |"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "plan" } })
    const sec = await part(buf, "Contents/section0.xml")
    // "구분" 열 폭 = 첫 셀 width — 15pt 2자(2910) + 실패딩(1020) 이상이어야 세로로 안 갈라짐
    const w = Number(sec.match(/<hp:cellSz width="(\d+)"/)![1])
    assert.ok(w >= 3930, `구분 열폭 ${w} ≥ 3930 (2자+실패딩)`)
  })
})

describe("h2 number + 법정 8단계 위계 (v4.0.2 QA)", () => {
  it("h2가 1단계(1. 2.)를 차지하면 리스트는 가.부터 + 1자 들여쓰기", async () => {
    const md = "## 추진 배경\n\n- 첫 항목\n  - 하위 항목\n- 둘째 항목"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "notice" } })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.ok(ts.includes("1. 추진 배경"), `h2 번호: ${ts}`)
    assert.ok(ts.includes("가. 첫 항목") && ts.includes("나. 둘째 항목"), `리스트 가.나. 시프트: ${ts}`)
    assert.ok(ts.includes("1) 하위 항목"), `하위 1): ${ts}`)
    assert.ok(!ts.includes("1. 첫 항목"), "h2와 동일 부호 중복 금지")
  })
})
