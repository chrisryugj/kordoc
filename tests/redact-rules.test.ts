/**
 * redact 룰 확장 단위 테스트 — 표면형(전각·유니코드 대시·국제/괄호 전화·AMEX·여권 신형 …),
 * 검증기(생년월일 세기·사업자/법인 체크섬), 라벨 문맥(가장 가까운 라벨·표 머리글), 인라인 서식 표지,
 * 그리고 실코퍼스 오탐 실측에서 나온 음성(예산과목 코드·NCS 코드·출원번호·자리표시자·연도 범위).
 * ※ 번호는 전부 합성 — 체크섬만 맞춘 가상 값.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { redactText, redactMarkdown, normalizeForDetect, ALL_REDACT_RULES, type RedactRule } from "../src/redact.js"

const ALL = [...ALL_REDACT_RULES]
const rulesOf = (text: string, rules: readonly RedactRule[] = ALL): string[] => redactText(text, { rules }).hits.map((h) => h.rule)
const masked = (text: string, rules: readonly RedactRule[] = ALL): string => redactText(text, { rules }).text

describe("정규화 — 같은 길이 그림자 문자열", () => {
  it("전각 숫자·전각 하이픈·유니코드 대시·NBSP 를 ASCII 로, 길이 동일", () => {
    const s = "０１０－２３４５–６７８９ x"
    const n = normalizeForDetect(s)
    assert.equal(n, "010-2345-6789 x")
    assert.equal(n.length, s.length)
  })
  it("마스킹은 원문 글자에 — 전각 구분자는 전각 그대로", () => {
    assert.equal(masked("연락처 ０１０－２３４５－６７８９"), "연락처 ０１０－●●●●－６７８９")
  })
})

describe("rrn — 주민·외국인등록번호", () => {
  it("하이픈 앞뒤 공백·유니코드 대시 허용", () => {
    assert.equal(masked("주민등록번호 030303 - 3589242"), "주민등록번호 030303 - ●●●●●●●")
    assert.deepEqual(rulesOf("850315—2758675"), ["rrn"])
  })
  it("생년월일 세기 검증 — 2000년대생(3·4)은 미래 연도·윤년 아닌 2월 29일 거부", () => {
    assert.deepEqual(rulesOf("990101-3123456"), []) // 2099년생
    assert.deepEqual(rulesOf("010229-3123456"), []) // 2001-02-29 없음
    assert.deepEqual(rulesOf("000229-3123456"), ["rrn"]) // 2000년은 윤년
    assert.deepEqual(rulesOf("920229-1585869"), ["rrn"])
  })
  it("무구분 13자리는 주민/외국인등록번호 라벨이 있을 때만", () => {
    assert.deepEqual(rulesOf("주민등록번호 9001011694788"), ["rrn"])
    assert.deepEqual(rulesOf("외국인등록번호: 8807205757962"), ["rrn"])
    assert.deepEqual(rulesOf("(예) 1310091000023 등"), []) // 기록물 등록번호 예시 — 체크섬이 맞아도 라벨 없음
    assert.deepEqual(rulesOf("바코드 8801234567893"), [])
  })
  it("앞을 드러낸 가림형(900101-1******)은 남은 성별 자리를 가린다", () => {
    assert.equal(masked("주민등록번호 900101-1******"), "주민등록번호 900101-●******")
    assert.deepEqual(rulesOf("주민등록번호 900101-*******"), [])
  })
  it("법인등록번호 라벨이 가장 가까우면 주민번호로 보지 않는다 (crn 은 opt-in)", () => {
    assert.deepEqual(rulesOf("법인등록번호: 160111-3934448", ["rrn"]), [])
    assert.deepEqual(rulesOf("법인등록번호: 160111-3934448"), ["crn"])
    // 대표자 주민번호 라벨이 더 가까우면 주민번호
    assert.deepEqual(rulesOf("법인등록번호 110111-1022287, 대표자 주민등록번호 900101-1694788", ["rrn"]), ["rrn"])
  })
})

describe("crn — 법인등록번호 (opt-in)", () => {
  it("라벨 없이도 뒷자리 0 시작 + 체크섬이면 법인번호, 체크섬 틀리면 아님", () => {
    assert.deepEqual(rulesOf("160111-0993017", ["crn"]), ["crn"])
    assert.deepEqual(rulesOf("160111-0993018", ["crn"]), [])
  })
})

describe("phone — 표면형", () => {
  it("괄호 지역번호·닫는 괄호형", () => {
    assert.equal(masked("전화 (02) 123-4567"), "전화 (02) ●●●-4567")
    assert.equal(masked("(042)481-6300"), "(042)●●●-6300")
    assert.equal(masked("☎ 02)450-1234"), "☎ 02)●●●-1234")
  })
  it("국제 표기 +82", () => {
    assert.equal(masked("Mobile: +82 10-2345-6789"), "Mobile: +82 10-●●●●-6789")
    assert.equal(masked("+82 (0)10 2345 6789"), "+82 (0)10 ●●●● 6789")
    assert.equal(masked("+821098765432"), "+8210●●●●5432")
  })
  it("안심번호 050x·080 수신자부담", () => {
    assert.deepEqual(rulesOf("0505-123-4567"), ["phone"])
    assert.deepEqual(rulesOf("080-123-4567"), ["phone"])
  })
  it("앞뒤 공백 붙은 하이픈 구분자 (서식 칸 입력)", () => {
    assert.equal(masked("연락처 (044) 202 - 2912"), "연락처 (044) ●●● - 2912")
    assert.equal(masked("031 - 234 - 5678"), "031 - ●●● - 5678")
  })
  it("Tel.·☎ 에 붙은 번호, 범위 표기(∼9) 앞 번호", () => {
    assert.deepEqual(rulesOf("Tel.044-202-1234"), ["phone"])
    assert.deepEqual(rulesOf("세무2과(02-450-7448∼9)"), ["phone"])
  })
  it("대표번호: 하이픈이면 무문맥, 온점·공백 구분은 전화 라벨 필요, 연도 범위는 제외", () => {
    assert.deepEqual(rulesOf("1588-1234"), ["phone"])
    assert.deepEqual(rulesOf("콜센터(1644.5678)"), ["phone"])
    assert.deepEqual(rulesOf("면적 1644.5678"), [])
    assert.deepEqual(rulesOf("임진왜란(1592-1598)"), [])
    assert.deepEqual(rulesOf("조선, 그 마지막 10년의 기록(1888-1897)"), [])
  })
})

describe("phone — 실코퍼스 오탐 음성", () => {
  it("예산과목 코드의 일부(뒤에 -숫자 또는 - 가 붙음)", () => {
    assert.deepEqual(rulesOf("☞ : 064-1100-1131-301-210 : 문화재"), [])
    assert.deepEqual(rulesOf("☞ : 064-7100-7130- - : 문화재"), [])
  })
  it("NCS 능력단위 코드·쉼표 숫자 목록·strace 8진 플래그", () => {
    assert.deepEqual(rulesOf("문서작성(0202030201_22v3)"), [])
    assert.deepEqual(rulesOf("5005,0507502002,6001"), [])
    assert.deepEqual(rulesOf("open(\"/lib\",0,04000000000)=3"), [])
  })
  it("가입자 번호 전부 0 인 자리표시자", () => {
    assert.deepEqual(rulesOf("연락처: 010-0000-0000"), [])
    assert.deepEqual(rulesOf("(☎ 031-000-0000)"), [])
  })
  it("구분자가 있으면 국번 0 시작도 번호로 (실결재 팩스 02-02xx-xxxx)", () => {
    assert.deepEqual(rulesOf("/전송 02-0256-8199"), ["phone"])
    assert.deepEqual(rulesOf("0202568199"), []) // 무구분이면 코드로 본다
  })
})

describe("email", () => {
  it("전각 @·괄호·꺾쇠·mailto 문맥", () => {
    assert.equal(masked("이메일 hong＠example.com"), "이메일 h●●●＠example.com")
    assert.deepEqual(rulesOf("<jung@example.net>"), ["email"])
    assert.deepEqual(rulesOf("문의: choi+pii@example.com입니다"), ["email"])
  })
  it("파일명(image@2x.png)은 이메일 아님", () => {
    assert.deepEqual(rulesOf("image@2x.png"), [])
  })
  it("이미 가린 로컬파트의 꼬리(j*********5@…)는 새 이메일로 보지 않는다, 한 글자 로컬파트는 전부 가린다", () => {
    assert.deepEqual(rulesOf("j*********5@example.com"), [])
    assert.equal(masked("메일 a@example.com"), "메일 ●@example.com")
  })
})

describe("card", () => {
  it("AMEX 4-6-5 + Luhn", () => {
    assert.equal(masked("카드번호 3769-766368-71631"), "카드번호 3769-●●●●●●-●1631")
    assert.deepEqual(rulesOf("3769-766368-71632", ["card"]), []) // Luhn 불일치 — 기본 룰셋에선 계좌로 폴백(4-4-4-4 와 같은 계약)
    assert.deepEqual(rulesOf("3769-766368-71632"), ["account"])
  })
  it("무구분 16자리는 카드 라벨 + Luhn 일 때만", () => {
    assert.deepEqual(rulesOf("카드번호 4518683527057046"), ["card"])
    assert.deepEqual(rulesOf("4518683527057046"), [])
  })
  it("0000-0000-0000-0000 자리표시자·뒤에 그룹이 더 붙은 IBAN 류는 아님", () => {
    assert.deepEqual(rulesOf("카드번호 0000-0000-0000-0000"), [])
    assert.deepEqual(rulesOf("IBAN CH93 0076 2011 6238 5295 7"), [])
  })
})

describe("account", () => {
  it("무구분 계좌는 계좌·은행 라벨이 있을 때만 (뒤 4자리 유지)", () => {
    assert.equal(masked("입금계좌: 국민은행 12345678901234"), "입금계좌: 국민은행 ●●●●●●●●●●1234")
    assert.deepEqual(rulesOf("민원번호 20260730900186"), [])
  })
  it("10자리 하이픈형은 계좌 라벨 필요 — 예산과목 4-3-3 코드 제외", () => {
    assert.deepEqual(rulesOf("예산과목 1011-250-260(일반연구비)"), [])
    assert.deepEqual(rulesOf("계좌 1011-250-260"), ["account"])
  })
  it("특허·상표 출원번호, 비개인 식별번호 라벨(과제번호), 날짜로 시작하는 관리번호 제외", () => {
    assert.deepEqual(rulesOf("【출원번호】 10-2007-1234567"), [])
    assert.deepEqual(rulesOf("과제번호 1345-123-45678"), [])
    assert.deepEqual(rulesOf("2024-01-15-1234"), [])
  })
  it("체크섬 맞는 3-2-5 는 사업자번호 몫 — 계좌 라벨이 있으면 계좌", () => {
    assert.deepEqual(rulesOf("업체 214-86-57090 계약", ["account"]), [])
    assert.deepEqual(rulesOf("계좌번호 214-86-57090", ["account", "brn"]), ["account"])
  })
})

describe("brn — 사업자등록번호", () => {
  it("체크섬 유효하면 무문맥, 뒤 5자리 마스크", () => {
    assert.equal(masked("업체 214-86-57090 계약"), "업체 214-86-●●●●● 계약")
  })
  it("체크섬이 틀려도 사업자 라벨이면, 무구분은 라벨 필요", () => {
    assert.deepEqual(rulesOf("사업자등록번호 123-45-67890"), ["brn"])
    assert.deepEqual(rulesOf("사업자번호 4081394487"), ["brn"])
    assert.deepEqual(rulesOf("4081394487"), [])
  })
  it("000-00-00000 자리표시자는 아님", () => {
    assert.deepEqual(rulesOf("사업자등록번호: 000-00-00000"), [])
  })
})

describe("passport·driver", () => {
  it("여권 신형은 무문맥, 구형은 여권 라벨 필요", () => {
    assert.equal(masked("신규 여권 M987B6543 발급"), "신규 여권 M●●●●●●●● 발급")
    assert.deepEqual(rulesOf("M987B6543"), ["passport"])
    assert.deepEqual(rulesOf("M12345678"), [])
    assert.deepEqual(rulesOf("Passport No. S98765432"), ["passport"])
    assert.deepEqual(rulesOf("문서 ID D20260716"), [])
  })
  it("운전면허 신형(지역코드 11~28)·구형(지역명)·무구분(라벨)", () => {
    assert.equal(masked("11-23-456789-01"), "11-23-●●●●●●-●●")
    assert.equal(masked("운전면허 서울 12-345678-90"), "운전면허 서울 12-●●●●●●-●●")
    assert.deepEqual(rulesOf("운전면허번호 112345678901"), ["driver"])
  })
})

describe("ip (opt-in)", () => {
  it("첫 옥텟 10 이상 또는 IP 라벨, 뒤 두 옥텟 마스크", () => {
    assert.equal(masked("접속 IP: 192.168.10.25"), "접속 IP: 192.168.●●.●●")
    assert.deepEqual(rulesOf("제1.2.3.4항 · 버전 4.14.2.1"), [])
    assert.deepEqual(rulesOf("192.168.10.25", ["phone", "email"]), [])
  })
})

describe("redactMarkdown — 표 머리글 문맥·인라인 표지", () => {
  it("GFM 표: 열 머리글이 주민등록번호면 무구분 13자리도 잡는다 (다른 열은 아님)", () => {
    const md = "| 성명 | 주민등록번호 | 비고 |\n| --- | --- | --- |\n| 홍길동 | 8503152002390 | 1310091000023 |"
    const r = redactMarkdown(md)
    assert.deepEqual(r.hits.map((h) => h.rule), ["rrn"])
    assert.ok(r.text.includes("850315●●●●●●●") && r.text.includes("1310091000023"))
  })
  it("HTML 표: 첫 행 머리글(colspan 반영)", () => {
    const md = "<table>\n<tr><th>성명</th><th colspan=\"2\">계좌번호</th></tr>\n<tr><td>홍길동</td><td>신한</td><td>110987654321</td></tr>\n</table>"
    assert.deepEqual(redactMarkdown(md).hits.map((h) => h.rule), ["account"])
  })
  it("법인등록번호 열의 6-7 번호는 주민번호로 가리지 않는다", () => {
    const md = "| 상호 | 법인등록번호 |\n| --- | --- |\n| ○○건설(주) | 110171-1213434 |"
    assert.deepEqual(redactMarkdown(md).hits, [])
  })
  it("굵게 표지가 번호를 갈라도 잡고, 표지는 그대로 둔다", () => {
    const r = redactMarkdown("분할 연락처 010-98**76-5431 끝**")
    assert.equal(r.text, "분할 연락처 010-●●**●●-5431 끝**")
    assert.equal(r.hits[0].length, "010-98**76-5431".length)
  })
  it("이스케이프된 가림표(900101-1\\*…)·밑줄 태그", () => {
    assert.equal(redactMarkdown("주민등록번호: 900101-1\\*\\*\\*\\*\\*\\*").text, "주민등록번호: 900101-●\\*\\*\\*\\*\\*\\*")
    assert.equal(redactMarkdown("<u>010-2345</u>-6789").text, "<u>010-●●●●</u>-6789")
  })
})

describe("마스크 문자 검증", () => {
  it("표·태그를 깨는 문자·공백은 거부", () => {
    for (const bad of ["|", "<", "&", "\"", " ", "\\"]) assert.throws(() => redactText("x", { maskChar: bad }), /maskChar/)
    assert.equal(redactText("010-2345-6789", { maskChar: "#" }).text, "010-####-6789")
  })
})
