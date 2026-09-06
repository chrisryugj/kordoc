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

/** 텍스트를 담은 문단의 paraPr/charPr XML (v5 레지스트리 id는 동적이라 조회로 확인) */
function prOf(sec: string, head: string, text: string): { para: string; char: string } {
  const at = sec.indexOf(`<hp:t>${text}`)
  if (at < 0) throw new Error(`문단 없음: ${text}`)
  const pStart = sec.lastIndexOf("<hp:p ", at)
  const pid = sec.slice(pStart).match(/paraPrIDRef="(\d+)"/)![1]
  const cid = sec.slice(sec.lastIndexOf("<hp:run ", at)).match(/charPrIDRef="(\d+)"/)![1]
  const para = head.match(new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?</hh:paraPr>`))![0]
  const char = head.match(new RegExp(`<hh:charPr id="${cid}"[\\s\\S]*?</hh:charPr>`))![0]
  return { para, char }
}
const fontIdOf = (head: string, face: string) => head.match(new RegExp(`<hh:fontface lang="HANGUL"[\\s\\S]*?<hh:font id="(\\d+)" face="${face}"`))?.[1]

describe("bullet2 ㅇ/○ (GAP-06)", () => {
  it("기본값 — 서울 실결재 ㅇ(이응) 지배: 보고서·계획서·통지·보도자료 ㅇ, 중앙부처 개조식만 ○ (v5)", () => {
    assert.equal(resolveGongmun({ preset: "report" }).bullet2, "ㅇ")
    assert.equal(resolveGongmun({ preset: "plan" }).bullet2, "ㅇ")
    assert.equal(resolveGongmun({ preset: "notice" }).bullet2, "ㅇ")
    assert.equal(resolveGongmun({ preset: "press" }).bullet2, "ㅇ")
    assert.equal(resolveGongmun({ preset: "gaejosik" }).bullet2, "○")
  })
  it("보고서 리스트 2단계 부호 전환", async () => {
    const md = "- 대항목\n  - 중항목"
    const on = texts(await part(await markdownToHwpx(md, { gongmun: { preset: "report" } }), "Contents/section0.xml"))
    assert.ok(on.some((t) => t.startsWith("ㅇ ")), `ㅇ 부호(기본): ${on}`)
    const off = texts(await part(await markdownToHwpx(md, { gongmun: { preset: "report", bullet2: "○" } }), "Contents/section0.xml"))
    assert.ok(off.some((t) => t.startsWith("○ ")), `○ 부호: ${off}`)
  })
})

describe("report 리스트 문단 위 간격 — 코퍼스 실측", () => {
  // 종전 기대값 □3000/○2000/-1200 은 「2_보고서 양식」 한 파일의 저장값이었다(GAP-05).
  // 코퍼스 555건 실측은 정반대 — □ 582문단·○ 799문단 모두 prev=0 이 88%이고 2000·3000 은
  // 상위 6위에도 없다(2위 300). 줄간격 160%에 10pt 가 더해져 항목 사이가 1.4줄로 벌어지던
  // 것을 실측 최빈값으로 되돌렸다(□만 절 구분 위해 실측 2위 300 유지). gaejosik.ts 참조.
  it("□ 앞 간격은 10pt(빈 문단 대신) — 첫 □·ㅇ·- 는 0, 연속 □ 도 0 (v5 라운드 3)", async () => {
    // 빈 문단(27pt)이면 ㅇ→□ 기준선 55pt 로 본문 행간 30pt 의 1.8배 구멍(실렌더 캡처). 10pt 면 37pt·잉크 22pt — 실결재 그룹 간격 비율(1.5배)
    const buf = await markdownToHwpx("- a\n  - b\n    - c\n- d\n- e", { gongmun: { preset: "report" } })
    const head = await part(buf, "Contents/header.xml")
    const sec = await part(buf, "Contents/section0.xml")
    const prev = (t: string) => Number(prOf(sec, head, t).para.match(/<hc:prev value="(\d+)"/)![1])
    assert.equal(prev("□ a"), 0, "첫 □")
    assert.equal(prev("ㅇ b"), 0)
    assert.equal(prev("- c"), 0)
    assert.equal(prev("□ d"), 1000, "하위 항목 뒤 □ 앞 10pt")
    assert.equal(prev("□ e"), 0, "연속 □(하위 항목 없음) 사이는 빈 줄 없음 — 실측 52:48")
  })
})

describe("붙임 블록 — 실측 관행 보존", () => {
  // 실측(코퍼스 343건): 붙임은 본문과 한 줄 띄우고(95%), 여러 건이면 '1. 2. 3.' 번호를
  // 그대로 쓰며(부호 치환 0건), 둘째 항목은 선행 공백으로 첫 번호와 세로를 맞춘다(122/123).
  it("들여쓴 '2.' 가 항목부호로 치환되지 않고 번호·선행공백을 유지한다", async () => {
    const md = "○ 본문 항목\n\n붙임  1. 첫째 자료 1부.\n      2. 둘째 자료 1부.  끝.\n"
    const sec = await part(await markdownToHwpx(md, { gongmun: { preset: "report" } }), "Contents/section0.xml")
    const body = [...sec.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((m) => m[1])
    assert.ok(body.some((t) => t.startsWith("붙임  1.")), `붙임 머리: ${JSON.stringify(body)}`)
    assert.ok(body.some((t) => /^\s{2,}2\./.test(t)), `둘째 항목 선행공백 보존: ${JSON.stringify(body)}`)
    assert.ok(!body.some((t) => /^[ㆍ·]\s*둘째/.test(t)), `번호가 부호로 치환되면 안 됨: ${JSON.stringify(body)}`)
  })

  it("붙임 머리 앞에 한 줄 간격(문단 위) — 실측 95% 빈 줄", async () => {
    const md = "○ 본문 항목\n\n붙임  자료 1부.  끝.\n"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "report" } })
    const head = await part(buf, "Contents/header.xml")
    const sec = await part(buf, "Contents/section0.xml")
    const prev = Number(prOf(sec, head, "붙임  자료").para.match(/<hc:prev value="(\d+)"/)![1])
    assert.ok(prev > 0, `붙임 문단 위 간격: ${prev}`)
  })
})

describe("h3·h4 소제목 들여쓰기", () => {
  // □(h2) 대항목이 내어쓰기로 부호를 왼쪽에 내밀기 때문에, left 가 없던 h3 는 실렌더에서
  // 대항목보다 왼쪽에 놓여 계층이 사라졌다. h2 부호폭만큼 들여써 제목 글자와 맞춘다.
  it("h3 → □(0타), h4 → ㅇ(1타) — 헤딩 깊이가 항목 depth 로 (v5)", async () => {
    const buf = await markdownToHwpx("## 장\n\n### 소제목\n\n#### 소소제목\n", { gongmun: { preset: "report" } })
    const head = await part(buf, "Contents/header.xml")
    const sec = await part(buf, "Contents/section0.xml")
    const left = (t: string) => Number(prOf(sec, head, t).para.match(/<hc:left value="(-?\d+)"/)![1])
    assert.equal(left("□ 소제목"), 0)
    assert.equal(left("ㅇ 소소제목"), 750, "ㅇ 1타(15pt) — 실측 66%")
  })
})

describe("기안문 두문·결문 (GAP-02)", () => {
  it("docHead/docFoot 표 방출 — 서울 실결재 두문표·결문표 (v5)", async () => {
    const buf = await markdownToHwpx("본문입니다.", {
      gongmun: {
        preset: "official",
        docHead: { org: "행정안전부", to: "수신자 제위", title: "협조 요청" },
        docFoot: { sender: "행정안전부장관", drafter: "주무관 홍길동", approver: "과장 김과장", docNum: "혁신과-123", phone: "044-205-1234", disclosure: "대국민공개" },
      },
    })
    const ts = texts(await part(buf, "Contents/section0.xml"))
    assert.ok(ts.some((t) => t.replace(/\s/g, "") === "행정안전부"), "기관명(자간 띄움)")
    assert.ok(ts.includes(" 수신 ") && ts.includes("수신자 제위"))
    assert.ok(ts.includes("(경유)"))
    assert.ok(ts.includes(" 제목 ") && ts.includes("협조 요청"))
    assert.ok(ts.includes("행정안전부장관"), "발신명의(대외)")
    assert.ok(ts.includes("주무관") && ts.includes("홍길동") && ts.includes("과장") && ts.includes("김과장"), "결재선 직위·성명 셀")
    assert.ok(ts.includes("시행") && ts.includes("혁신과-123"))
    assert.ok(ts.includes("전화") && ts.includes("044-205-1234") && ts.includes("대국민공개"))
    // 결문은 "끝." 뒤에 온다 (별지서식 순서)
    const endIdx = ts.findIndex((t) => t.trim() === "끝.")
    const senderIdx = ts.indexOf("행정안전부장관")
    assert.ok(endIdx >= 0 && senderIdx > endIdx, `끝.(${endIdx}) 뒤 발신명의(${senderIdx})`)
    // 내부결재면 발신명의 생략
    const internal = texts(await part(await markdownToHwpx("본문", { gongmun: { preset: "official", docHead: { to: "내부결재" }, docFoot: { sender: "행정안전부장관" } } }), "Contents/section0.xml"))
    assert.ok(!internal.includes("행정안전부장관"), "내부결재 발신명의 생략")
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
  it("보고서는 제목표 담당자 행, 제목 없으면 우상단 12pt (v5)", async () => {
    const info = "(2026. 7. 11., 과장 홍길동, ☎02-120)"
    const withTitle = await markdownToHwpx("# 보고\n\n- 항목", { gongmun: { preset: "report", reportInfo: info } })
    const sec = await part(withTitle, "Contents/section0.xml")
    const at = sec.indexOf(info)
    assert.ok(at > 0 && sec.lastIndexOf("<hp:tbl", at) > 0, "제목표 안 담당자 행")
    const noTitle = await markdownToHwpx("- 항목", { gongmun: { preset: "report", reportInfo: info } })
    const ts = texts(await part(noTitle, "Contents/section0.xml"))
    assert.equal(ts[0], info)
    assert.match(await part(noTitle, "Contents/header.xml"), /height="1200"/)
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
  it("'*' 마커 항목 → ※ 참고(한컴돋움 13pt) (v5)", async () => {
    const buf = await markdownToHwpx("- 항목\n\n* 정부 예산 범위 내에서 지원 예정", { gongmun: { preset: "report" } })
    const sec = await part(buf, "Contents/section0.xml")
    const head = await part(buf, "Contents/header.xml")
    const { char } = prOf(sec, head, "※ 정부 예산")
    assert.match(char, /height="1300"/)
    assert.ok(char.includes(`hangul="${fontIdOf(head, "한컴돋움")}"`), "참고 글꼴 한컴돋움")
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
  it("suppressSingle 옵트인 시 부호 생략 + 내어쓰기 0 (v5)", async () => {
    const buf = await markdownToHwpx("- 하나뿐인 항목\n  - 하위도 하나", { gongmun: { preset: "official", suppressSingle: true } })
    const sec = await part(buf, "Contents/section0.xml")
    const head = await part(buf, "Contents/header.xml")
    const ts = texts(sec)
    assert.ok(ts.includes("하나뿐인 항목") && ts.includes("하위도 하나"), `부호 생략: ${ts}`)
    assert.match(prOf(sec, head, "하나뿐인 항목").para, /<hc:intent value="0"/)
  })
  it("표 짧은 열 — 실패딩(inMargin 1020) 반영 폭으로 세로 쪼개짐 방지", async () => {
    const md = "| 구분 | 추진과제 | 소요예산(백만원) | 추진일정 | 담당부서 |\n| --- | --- | --- | --- | --- |\n| 단기 | 문서 자동화 시스템 구축 및 시범 운영 실시 | 350 | 2026. 3.~6. | 정보화담당관 |"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "plan" } })
    const sec = await part(buf, "Contents/section0.xml")
    // "구분" 열 폭 = 첫 셀 width — 셀 12pt 2자(2400) + 실패딩(1020) 이상이어야 세로로 안 갈라짐 (v5 셀 12pt)
    const w = Number(sec.match(/<hp:cellSz width="(\d+)"/)![1])
    assert.ok(w >= 3420, `구분 열폭 ${w} ≥ 3420 (2자+실패딩)`)
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
