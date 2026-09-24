/**
 * redact 인명·주소 룰(opt-in) — 주소 표면형(도로명·번길·상세·지번·공동주택·라벨)과 가림 범위(시·군·구까지 남김),
 * 인명 문맥(라벨·당사자·직함·호칭·연락처·나이·표 머리글·나열), 공문서 오탐 유혹(부서·직함 꾸밈말·역할어 뒤 라벨·
 * 성씨로 시작하는 보통명사·용언 조각·회사 — 코퍼스 5,081건 실측에서 나온 모양), 엔진(버린 문맥 매치 재시도),
 * 파일 단위(리터럴 전파·메타데이터·잔존 0).
 * ※ 이름은 관용 예시명·흔한 합성 이름, 주소는 공공청사이거나 번지를 지어낸 합성 값
 */

import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { redactText, redactMarkdown, ALL_REDACT_RULES, DEFAULT_REDACT_RULES, type RedactRule } from "../src/redact.js"
import { redactDocument } from "../src/redact-doc.js"
import { findLiterals, findPii, literalsFromMarkdown, scrubUtf16Runs } from "../src/redact-scrub.js"
import { markdownToHwpx } from "../src/index.js"
import { buildPiiHwp5, hwp5Leaks, hwpxLeaks } from "./fixtures/redact-fixtures.js"

const TEXT: RedactRule[] = ["name", "address"]
const found = (text: string, rules: readonly RedactRule[] = TEXT): string[] =>
  redactText(text, { rules }).hits.map((h) => `${h.rule}:${text.slice(h.index, h.index + h.length)}`)
const masked = (text: string, rules: readonly RedactRule[] = TEXT): string => redactText(text, { rules }).text

describe("address — 도로명·지번 주소", () => {
  it("도로명 + 건물번호: 시·도·시·군·구는 남기고 도로명 이하를 같은 길이로 가린다", () => {
    const s = "민원 현장은 강원특별자치도 강릉시 경강로 2091 앞이다."
    assert.equal(masked(s), "민원 현장은 강원특별자치도 강릉시 ●●● ●●●● 앞이다.")
    assert.equal(masked(s).length, s.length)
    assert.deepEqual(found("경기도 고양시 일산동구 중앙로 1275에서"), ["address:경기도 고양시 일산동구 중앙로 1275"])
  })
  it("번길·상세주소(쉼표 뒤 동·호·층)까지 스팬", () => {
    assert.deepEqual(found("서울시 동작구 상도로37가길 9, 105-1호에 있는"), ["address:서울시 동작구 상도로37가길 9, 105-1호"])
    assert.equal(masked("서울시 동작구 상도로37가길 9, 105-1호"), "서울시 동작구 ●●●●●●● ●, ●●●-●●")
    assert.deepEqual(found("세종특별자치시 도움4로 13, 정부세종청사 10동 3층 제약과"), ["address:세종특별자치시 도움4로 13, 정부세종청사 10동 3층"])
  })
  it("시·도 약칭·읍면·띄어 쓴 번길", () => {
    assert.deepEqual(found("3. 행정복지센터(충북 옥천군 옥천읍 삼양로 21길 17) 이전"), ["address:충북 옥천군 옥천읍 삼양로 21길 17"])
    assert.deepEqual(found("주소: 전남 곡성군 오곡면 섬진강로 5길 23, 대표전화"), ["address:전남 곡성군 오곡면 섬진강로 5길 23"])
  })
  it("지번 — 동·리 + 번지, 산 번지, N번지", () => {
    assert.deepEqual(found("대전광역시 서구 둔산동 1427에"), ["address:대전광역시 서구 둔산동 1427"])
    assert.deepEqual(found("창고 위치 경북 영주시 문수면 월호리 318-4, 관리인"), ["address:경북 영주시 문수면 월호리 318-4"])
    assert.deepEqual(found("위 치: 보성군 벌교읍 장좌리 2716번지 등 5필지"), ["address:보성군 벌교읍 장좌리 2716번지"])
    assert.deepEqual(found("사업장소 : 장성군 북이면 원덕리 산27 외 3필지"), ["address:장성군 북이면 원덕리 산27"])
  })
  it("동 + 건물 이름 + N동 N호 (번지 없이 공동주택만 적은 꼴)", () => {
    assert.deepEqual(found("충북 제천시 신백동 하늘아파트 204동 1103호로 이사"), ["address:충북 제천시 신백동 하늘아파트 204동 1103호"])
  })
  it("주소 라벨 뒤는 행정구역 없이도 (라벨은 스팬 밖)", () => {
    assert.deepEqual(found("주소: 자양로 117"), ["address:자양로 117"])
  })
  it("행정구역만·조례·금액·거리·자리표시자는 주소가 아니다 (외부 정답 N02 형)", () => {
    for (const s of [
      "대상 지역은 영동군 황간면 전역이다.", "부산 해운대구 일대의 교통 혼잡이 심하다.",
      "경상북도 안동시 옥동 일원의 지구단위계획을 변경한다.", "청주시 조례 제2031호에 따라 시행한다.",
      "부산광역시 건축 조례 제12조 제2항", "경기도 조례로 12개 시설을 지정한다.", "서울시 기준으로 3,000원을 지원한다.",
      "부산 해운대구 도로 12km 구간", "서울특별시 광진구 자양로 000",
    ]) assert.deepEqual(found(s), [], s)
    assert.deepEqual(found("서울특별시 금천구 시흥대로 517-0"), ["address:서울특별시 금천구 시흥대로 517-0"]) // 부번 0 은 번호
  })
})

describe("name — 문맥 게이트", () => {
  it("라벨 뒤 — 균등배분 라벨, 쌍점 뒤 두 글자, 표 칸 옆", () => {
    assert.deepEqual(found("성명: 홍길동"), ["name:홍길동"])
    assert.deepEqual(found("성 명 : 김철수 (서명 또는 인)"), ["name:김철수"])
    assert.deepEqual(found("성명: 문솔"), ["name:문솔"])
    assert.deepEqual(found("| 성명 | 이영희 | 연락처 |", ["name"]), ["name:이영희"])
    assert.deepEqual(found("이름: 남궁민수"), ["name:남궁민수"])
  })
  it("당사자 역할어 뒤 — 조사 떼기, 두 글자 이름은 조사·쉼표·괄호가 붙을 때만", () => {
    assert.deepEqual(found("피고인 최지훈은 공소사실을 모두 인정하였다."), ["name:최지훈"])
    assert.deepEqual(found("원고 황보은서는 피고 정하은을 상대로"), ["name:황보은서", "name:정하은"])
    assert.deepEqual(found("신청인 한서율(1985년생)의 영업 신고"), ["name:한서율"])
    assert.deepEqual(found("피해자 문솔의 휴대전화를 빼앗았다."), ["name:문솔"])
    assert.deepEqual(found("임대인 이재현과 임차인 박영희 사이에 맺은 계약"), ["name:이재현", "name:박영희"])
    assert.deepEqual(found("피고 1. ○○은행(대표자 오세진) 2. 윤지호는 연대하여"), ["name:오세진", "name:윤지호"])
  })
  it("직함 앞뒤 — 결재·담당자 안내. 약한 문맥(직함)은 흔한 성 세 글자", () => {
    assert.deepEqual(found("세부 사항은 담당 주무관 강민준에게 확인하시기 바랍니다."), ["name:강민준"])
    assert.deepEqual(found("임하나 회장은 정기총회 개최를 알렸다."), ["name:임하나"])
    assert.deepEqual(found("건설도시과장 박신우 | 도로시설팀장 김홍준 | 담당자 최준영 (☎6151)"), ["name:박신우", "name:김홍준", "name:최준영"])
    assert.deepEqual(found("남궁현 위원장은 탁서준 의원의 질의에 답했다."), ["name:남궁현"]) // 드문 성(탁)은 직함 뒤만으론 안 받는다
  })
  it("호칭·연락처·나이 괄호 (강한 문맥 — 두 글자·드문 성)", () => {
    assert.deepEqual(found("이도윤 씨와 서지안 씨가 계약서에 서명하였다."), ["name:이도윤", "name:서지안"])
    assert.deepEqual(found("홍길동님께 결과를 안내해 드립니다."), ["name:홍길동"])
    assert.deepEqual(found("관련 문의는 도로관리과 유다온(010-2345-7781)에게 연락"), ["name:유다온"])
    assert.deepEqual(found("농정과 한빛(☎ 043-234-3472)으로 연락"), ["name:한빛"])
    assert.deepEqual(found("사고 차량 운전자 박도현(만 52세)은 병원으로"), ["name:박도현"])
    assert.deepEqual(found("피해자 서하(여, 31세)는"), ["name:서하"])
    assert.deepEqual(found("도시과 편도윤 담당자(☎ 010-2345-3258)로 연락"), ["name:편도윤"])
  })
  it("외국 이름(라틴·한자)은 강한 문맥(당사자·호칭)에서만", () => {
    assert.deepEqual(found("외국인 참고인 Daniel Brown의 진술을"), ["name:Daniel Brown"])
    assert.equal(masked("외국인 참고인 Daniel Brown의 진술을"), "외국인 참고인 D●●●●● ●●●●●의 진술을")
    assert.deepEqual(found("원고 劉洋은 소를 취하하였다."), ["name:劉洋"])
    assert.deepEqual(found("Samsung Electronics 대표이사는"), [])
  })
  it("표 머리글이 성명·참석자인 열의 칸 전체 (마크다운 표 문맥)", () => {
    const md = "| 성명 | 소속 |\n| --- | --- |\n| 김민수 | 총무과 |\n| 남궁하린 | 기획과 |"
    assert.deepEqual(redactMarkdown(md, { rules: ["name"] }).hits.map((h) => md.slice(h.index, h.index + h.length)), ["김민수", "남궁하린"])
    const html = "<table>\n<tr><th>연번</th><th>참석자</th></tr>\n<tr><td>1</td><td>이서준</td></tr>\n</table>"
    assert.deepEqual(redactMarkdown(html, { rules: ["name"] }).hits.map((h) => html.slice(h.index, h.index + h.length)), ["이서준"])
    // 소속 열의 두 글자 부서명은 이름이 아니다
    assert.ok(!redactMarkdown(md, { rules: ["name"] }).text.includes("●무과"))
  })
  it("균등배분 직함·차수 직함·직함 뒤 한자 병기(한자까지 가림)", () => {
    assert.deepEqual(found("담당자 안지수 팀 장 (043-234-8760)"), ["name:안지수"])
    assert.deepEqual(found("보건복지부 강태오 제2차관은 현장을 점검했다."), ["name:강태오"])
    assert.equal(masked("○ 검찰연구관 박서진(朴瑞辰) (부산지검 검사)"), "○ 검찰연구관 박●●(朴●●) (부산지검 검사)")
    // 한자어 병기는 성씨 한자로 시작해도 문맥이 없거나 독음이 다르면 이름이 아니다
    for (const s of ["고층(高層) 건물이 늘어선 거리", "황하(黃河) 유역의 고대 문명", "공인(公印) (영 제40조)", "검사 원격지(遠隔地) 회의"]) {
      assert.deepEqual(found(s, ["name"]), [], s)
    }
  })
  it("결재란 — 직함 칸 옆 이름 칸, 기관이 붙은 직함 사이 이름. 머리글 행·서식 낱말 칸은 아니다", () => {
    const names = (md: string): string[] => redactMarkdown(md, { rules: ["name"] }).hits.map((h) => md.slice(h.index, h.index + h.length))
    const sign = "<table>\n<tr><td colspan=\"7\" rowspan=\"2\">주무관</td><td colspan=\"3\" rowspan=\"2\">김서준</td><td rowspan=\"2\"></td>" +
      "<td colspan=\"5\" rowspan=\"2\">복지기획팀장</td><td colspan=\"4\" rowspan=\"2\">유재민</td><td colspan=\"7\">화재안전조사관</td><td>나현서</td></tr>\n</table>"
    assert.deepEqual(names(sign), ["김서준", "유재민", "나현서"])
    assert.deepEqual(found("재난안전과장 정종민 자연재난팀장 임희정 담당자 안지수(☎6191)"), ["name:정종민", "name:임희정", "name:안지수"])
    assert.deepEqual(names("<table>\n<tr><th>병원</th><th>치과의원</th><th>한의원</th></tr>\n<tr><td>3</td><td>5</td><td>2</td></tr>\n</table>"), [])
    assert.deepEqual(names("<table>\n<tr><td>담당자</td><td>지출원</td></tr>\n<tr><td>감 사</td><td>이사회</td></tr>\n<tr><td>통일부장관</td><td>귀하</td></tr>\n</table>"), [])
    assert.deepEqual(names("| 운영 | 지원과 | 협력관 | 정책국 |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |"), [])
    assert.deepEqual(names("| 직위 | 성명 |\n| --- | --- |\n| 팀장 | 김미소 |"), ["김미소"])
  })
  it("나열 — 앞에서 찾은 이름에 쉼표로 이어진 이름", () => {
    assert.deepEqual(found("회장 : 도서연 부회장 : 문가윤, 방시우, 엄다인 등"), ["name:도서연", "name:문가윤", "name:방시우", "name:엄다인"])
  })
  it("성은 남기고 이름 글자만 가린다 — 길이 동일", () => {
    assert.equal(masked("성명: 홍길동, 담당 주무관 남궁민수에게"), "성명: 홍●●, 담당 주무관 남궁●●에게")
  })
  it("공문서 오탐 유혹은 잡지 않는다 — 코퍼스 실측 모양", () => {
    for (const s of [
      "담당 부서: 정보화담당관실", "정책 과장 회의 결과를 보고합니다.", "정부는 국민의 안전을 위하여 노력한다.",
      "고객님께 안내 드립니다. 선생님께서 말씀하셨다.", "신청인 주소 및 연락처를 적습니다.", "대표자 성명 (서명 또는 인)",
      "음성군 건축과 주택팀(043-234-5440)으로 문의", "환경과 수질팀(043-234-5238)에 연락",
      "충청북도지사 명의로 통보하였다.", "교장 공모제를 포함한 교장 임용제도 다양화", "노동시장 이중구조에 따른 격차",
      "토지등소유자 전체회의 의결권 보호", "경영능력이 우수한 교장에 대한 인센티브", "세면장 조도임", "기업날씨 쾌청!",
      "피고 한빛물산 주식회사는 원고에게", "피해자 구제 조치를 실시한다.", "담당자 | 서기관 | 조사일자",
      "전임강사 이상으로 재직한 경력", "신청인 유형(개인/법인)", "마음상담센터 한별 | 031-234-4948",
      "대리 신청하는 경우에만 제출", "(주)피앤씨 제조업", "의성군 대표 관광지 방문",
      "민원인 방문없이 바로 처리", "김해김씨 대종회", "그 구명설비 및 장치가 이 장의 규정을 준수", "보호담당관 현장속으로",
      "원본 그림의 이름: 공정위로고.png", "프로그램 이름 : Adobe Photoshop 2021", // 한컴 그림 개체 설명
    ]) assert.deepEqual(found(s, ["name"]), [], s)
  })
  it("문맥 없는 맨 이름은 잡지 않는다 — 정밀도 우선 (알려진 미탐)", () => {
    assert.deepEqual(found("이수아는 거래처 대표에게 입찰 정보를 미리 알려 주었다.", ["name"]), [])
  })
  it("기본 룰셋은 인명·주소를 켜지 않는다 (opt-in)", () => {
    assert.ok(!DEFAULT_REDACT_RULES.includes("name") && !DEFAULT_REDACT_RULES.includes("address"))
    assert.ok(ALL_REDACT_RULES.includes("name") && ALL_REDACT_RULES.includes("address"))
    assert.deepEqual(redactText("성명: 홍길동, 서울특별시 종로구 세종대로 209").hits, [])
  })
})

describe("엔진 — 문맥어를 매치에 넣는 변형(span)", () => {
  it("버린 매치가 뒤 문맥을 삼키지 않는다 — '담당 주무관'의 주무관을 버린 뒤 '주무관 강민준'을 본다", () => {
    assert.deepEqual(found("위원 탁서준: 담당 주무관 강민준에게 확인", ["name"]), ["name:탁서준", "name:강민준"])
  })
  it("번호 룰이 인명보다 먼저 돈다 — 이름 뒤 무구분 번호도 머리글 문맥으로 잡는다", () => {
    // "홍길동, 9001…" 의 쉼표는 번호 나열 구분자 모양이다 — 이름이 먼저 자리를 잡아 앞 값으로 이어지면 문맥이
    // {name} 이 되어 머리글 "주민등록번호" 문맥을 못 보고 무구분 13자리를 놓친다 (RULE_PRIORITY 에서 name 이 끝)
    const md = "| 주민등록번호 |\n| --- |\n| 성명: 홍길동, 9001011694788 |"
    const rules = redactMarkdown(md, { rules: ALL_REDACT_RULES }).hits.map((h) => h.rule).sort()
    assert.deepEqual(rules, ["name", "rrn"])
  })
})

describe("리터럴 — 본문에서 찾은 값을 문맥 없는 자리까지", () => {
  it("표 머리글로 찾은 이름도 리터럴, 한글 낱말 경계와 조사를 지킨다", () => {
    const md = "| 성명 |\n| --- |\n| 홍길동 |"
    const lits = literalsFromMarkdown(md, redactMarkdown(md, { rules: ["name"] }).hits)
    assert.deepEqual(lits.map((l) => [l.rule, l.value, l.masked]), [["name", "홍길동", "홍●●"]])
    const at = (s: string): number[] => findLiterals(s, lits).map((x) => x.index)
    assert.deepEqual(at("홍길동은 신청서를 냈다"), [0])
    assert.deepEqual(at("(홍길동 씨)"), [1])
    assert.deepEqual(at("김홍길동은"), []) // 앞이 한글 — 다른 낱말 한가운데
    assert.deepEqual(at("홍길동전 독후감"), []) // 뒤가 조사 아닌 한글
  })
  it("파서가 내보내는 모양(균등배분 \"홍 길 동\" → 붙임, 두 칸 공백 → 한 칸)으로 본 글에도 리터럴을 입힌다", () => {
    const lits = literalsFromMarkdown("성명: 홍길동", redactMarkdown("성명: 홍길동", { rules: ["name"] }).hits)
    const ctx = { rules: ["name"] as RedactRule[], maskChar: "●", literals: lits }
    assert.deepEqual(findPii("홍 길 동", ctx).map((h) => h.masked), ["홍 ● ●"])
    assert.deepEqual(findPii("홍 길 동 (서명)", ctx).map((h) => h.masked), ["홍 ● ●"])
    assert.deepEqual(findPii("홍 길 동 사 업 부 장 님", ctx).map((h) => h.masked), []) // 붙이면 "홍길동사업부장님" — 뒤가 조사 아닌 한글
    assert.deepEqual(findPii("홍 길동이 오면", ctx).map((h) => h.masked), []) // 한 글자 토큰이 70% 미만 — 파서도 붙이지 않는다
    // 두 칸 공백 — 파서는 한 칸으로 내보낸다 (토지 조서 칸의 "…아파트  204동")
    const addr = "주소: 서울특별시 종로구 세종대로 209"
    const addrLits = literalsFromMarkdown(addr, redactMarkdown(addr, { rules: ["address"] }).hits)
    const onlyLits = { rules: [] as RedactRule[], maskChar: "●", literals: addrLits }
    assert.deepEqual(findPii("서울특별시 종로구 세종대로  209", onlyLits).map((h) => h.masked), ["서울특별시 종로구 ●●●●  ●●●"])
  })
  it("바이너리에서 캐낸 조각에는 인명·주소 룰을 돌리지 않는다 — 리터럴만 (압축 데이터가 한자 이름 모양으로 풀린다)", () => {
    const lits = literalsFromMarkdown("성명: 홍길동", redactMarkdown("성명: 홍길동", { rules: ["name"] }).hits)
    const ctx = { rules: ["name"] as RedactRule[], maskChar: "●", literals: lits }
    assert.deepEqual(findPii("穰諪旲님 확인", ctx).map((h) => h.rule), ["name"]) // 글 단위에서는 호칭 앞 한자 이름
    const found: string[] = []
    scrubUtf16Runs(Buffer.from("穰諪旲님 확인 홍길동 담당", "utf16le"), ctx, "check", (h) => found.push(h.masked))
    assert.deepEqual(found, ["홍●●"])
  })
})

describe("redactDocument — 인명·주소 (파일 단위)", () => {
  let hwpx: Uint8Array
  let r: Awaited<ReturnType<typeof redactDocument>>
  const PII = { labelName: "홍길동", cellName: "김철수", headerName: "이영희", road: "세종대로 209" }
  before(async () => {
    const md = [
      "성명: 홍길동", "",
      "| 성명 | 주소 |", "| --- | --- |", "| 김철수 | 서울특별시 종로구 세종대로 209 |", "",
      "홍길동은 신청서를 제출하였다.", "",
      "김철수 관련 서류 일체",
    ].join("\n")
    const base = await markdownToHwpx(md, { page: { header: "담당 주무관 이영희" } })
    const zip = await JSZip.loadAsync(base)
    const hpf = await zip.file("Contents/content.hpf")!.async("text")
    zip.file("Contents/content.hpf", hpf.replace("<opf:metadata>", `<opf:metadata><opf:meta name="creator" content="text">홍길동</opf:meta>`))
    hwpx = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    r = await redactDocument(hwpx, { rules: ALL_REDACT_RULES })
  })

  it("HWPX — 라벨·표 칸·머리말·맨이름(리터럴)·작성자 메타데이터·주소가 파일 어디에도 남지 않는다", async () => {
    const planted = await hwpxLeaks(hwpx, PII)
    for (const k of Object.keys(PII)) assert.ok(planted.some((l) => l.startsWith(`${k} →`)), `픽스처에 ${k} 가 없음`)
    assert.ok(r.data)
    assert.deepEqual(await hwpxLeaks(r.data!, PII), [])
    assert.deepEqual(r.residual, [])
    assert.deepEqual(r.unscanned, [])
    assert.ok(r.fileHits.some((h) => h.rule === "name" && h.where === "metadata"), "작성자 메타데이터가 리터럴로 가려져야 함")
    assert.ok(r.fileHits.some((h) => h.rule === "address"))
  })

  it("HWPX — 마스킹된 마크다운에도 원문이 없고 리포트에 원본 값이 없다", () => {
    for (const v of Object.values(PII)) assert.ok(!r.markdown.includes(v), `마크다운에 ${v}`)
    const report = JSON.stringify({ f: r.fileHits, m: r.markdownHits, x: r.residual })
    for (const v of Object.values(PII)) assert.ok(!report.includes(v), `리포트에 ${v}`)
  })

  it("HWP5 — 표 칸 이름(머리글 문맥)은 리터럴로 셀 문단에서 가린다, 번호 룰 결과는 그대로", async () => {
    const hwp = buildPiiHwp5()
    const res = await redactDocument(hwp, { rules: [...DEFAULT_REDACT_RULES, "name", "address"] })
    assert.deepEqual(hwp5Leaks(hwp, { name: "홍길동" }).length > 0, true)
    assert.deepEqual(hwp5Leaks(res.data!, { name: "홍길동" }), [])
    assert.deepEqual(res.residual, [])
    assert.ok(res.fileHits.some((h) => h.rule === "name" && h.where === "table"))
  })

  it("HWPX — 균등배분 칸 이름(\"한 서 율\")은 파서가 붙인 값으로 찾고 파일의 띄어 쓴 글자를 가린다", async () => {
    const doc = await markdownToHwpx("| 직위 | 성명 |\n| --- | --- |\n| 주무관 | 한 서 율 |")
    const res = await redactDocument(doc, { rules: ["name"] })
    assert.deepEqual(res.residual, [])
    const xml = await (await JSZip.loadAsync(res.data!)).file("Contents/section0.xml")!.async("text")
    assert.ok(xml.includes("한 ● ●") && !xml.includes("서 율"), "셀 문단의 띄어 쓴 이름이 가려져야 함")
  })

  it("원본 형식 수술 대상이 아닌 포맷(DOCX) — 마크다운에서도 리터럴을 전파해 잔존 0", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>성명: 홍길동</w:t></w:r></w:p><w:p><w:r><w:t>홍길동은 신청서를 제출하였다.</w:t></w:r></w:p></w:body></w:document>`)
    const res = await redactDocument(await zip.generateAsync({ type: "uint8array" }), { rules: ["name"] })
    assert.equal(res.format, "docx")
    assert.ok(!res.markdown.includes("홍길동"), res.markdown)
    assert.equal(res.markdownHits.length, 2)
    assert.deepEqual(res.residual, [])
  })
})
