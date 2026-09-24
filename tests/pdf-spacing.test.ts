/**
 * PDF 글 정규화 — 균등배분 문자열 안전망·표 행·헤딩·열 표 칸·날짜 빈칸·줄 꺾임 어휘·줄 간격 (v4.15 T3a).
 * 사례는 hwpx↔pdf 752쌍에서 원문(HWPX)과 어긋나던 자리를 합성 입력으로 옮긴 것
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { collapseEvenSpacing, mergeLineSimple, type NormItem } from "../src/pdf/text-line.js"
import { cleanPdfText } from "../src/pdf/text-clean.js"
import { detectHeadings } from "../src/pdf/block-detect.js"
import { extractWithColumns } from "../src/pdf/columns.js"
import { WrapLexicon, wrapJoiner, bodyLineJoins, type WrapLine } from "../src/pdf/line-wrap.js"
import { cellTextToString, type TextItem } from "../src/pdf/line-detector.js"
import type { IRBlock } from "../src/types.js"

const item = (text: string, x: number, w: number, y = 700, fontSize = 10, extra: Partial<NormItem> = {}): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "f", isHidden: false, ...extra })

describe("collapseEvenSpacing — 홀로 선 한 글자 셋 이상만 균등배분으로", () => {
  it("낱말에 붙은 한 글자(10월·6명·제12조)는 균등배분 run 이 아니다", () => {
    assert.equal(collapseEvenSpacing("▪ 10월 중 첫 국정감사 준비"), "▪ 10월 중 첫 국정감사 준비")
    assert.equal(collapseEvenSpacing("경제인단체 6명 등 33명으로 구성되며"), "경제인단체 6명 등 33명으로 구성되며")
    assert.equal(collapseEvenSpacing("제12조 및 제13조를"), "제12조 및 제13조를")
    assert.equal(collapseEvenSpacing("베트남 40톤 등 총 140톤의"), "베트남 40톤 등 총 140톤의")
  })

  it("밑줄 표지(<u>·</u>)에 맞닿은 한 글자 연속은 홀로 선 것으로 본다", () => {
    assert.equal(collapseEvenSpacing("<u>이 력 서</u>", false), "<u>이력서</u>")
    assert.equal(collapseEvenSpacing("<참 고 사 항>", false), "<참 고 사 항>")
  })

  it("홀로 선 한 글자 연속은 종전대로 붙이고 날짜 빈칸은 둔다", () => {
    assert.equal(collapseEvenSpacing("과장 홍 보 담 당 관", false), "과장 홍보담당관")
    assert.equal(collapseEvenSpacing("발급일 년 월 일"), "발급일 년 월 일")
  })

  it("whole=false 는 줄 전체 한 글자 비율 규칙을 끈다 (기호·쌍점 토큰까지 세던 것)", () => {
    assert.equal(collapseEvenSpacing("□ 개 요"), "□개요")
    assert.equal(collapseEvenSpacing("□ 개 요", false), "□ 개 요")
    assert.equal(collapseEvenSpacing("N = 잠수펌프의 수", false), "N = 잠수펌프의 수")
    assert.equal(collapseEvenSpacing("홍 보 담 당 관", false), "홍보담당관")
  })
})

describe("cleanPdfText — 표 행은 칸마다, 마커 뒤 두 글자 합침 없음", () => {
  it("짧은 칸이 늘어선 머리 행을 통째로 붙이지 않는다", () => {
    const md = "| 시 간 | 분 | 내 용 | 비 고 |\n| --- | --- | --- | --- |\n| 13:00～13:05 | 5 | 개회 |  |"
    assert.match(cleanPdfText(md), /^\| 시 간 \| 분 \| 내 용 \| 비 고 \|$/m)
  })

  it("칸 안 균등배분(홀로 선 한 글자 셋+)은 칸마다 종전대로 붙인다 — <br> 줄마다", () => {
    const md = "| 과장 | 홍 보 담 당 관<br>(현 부의장) |\n| --- | --- |\n| 1 | 2 |"
    assert.match(cleanPdfText(md), /\| 과장 \| 홍보담당관<br>\(현 부의장\) \|/)
  })

  it("□ 뒤 두 글자를 붙이지 않는다 (원문이 공백을 쳐 띄운 표제·낱말 머리)", () => {
    assert.equal(cleanPdfText("□ 일 시 : 2026. 9. 14.(월)"), "□ 일 시 : 2026. 9. 14.(월)")
    assert.equal(cleanPdfText("□ 본 보도자료의 수록 내용"), "□ 본 보도자료의 수록 내용")
  })

  it("줄 전체 한 글자 비율 규칙을 쓰지 않는다 (□ 개 요, 등호식)", () => {
    assert.equal(cleanPdfText("□ 개 요\n\n본문 문단"), "□ 개 요\n\n본문 문단")
    assert.equal(cleanPdfText("N = 잠수펌프의 수"), "N = 잠수펌프의 수")
  })
})

describe("detectHeadings — 헤딩 균등배분은 홀로 선 한 글자 셋 이상만", () => {
  it("□ 개 요 헤딩은 띄어쓰기를 지키고, 기 본 현 황 은 붙인다", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "□ 개 요", style: { fontSize: 16 } },
      { type: "paragraph", text: "기 본 현 황", style: { fontSize: 16 } },
    ]
    detectHeadings(blocks, 10)
    assert.equal(blocks[0].type, "heading")
    assert.equal(blocks[0].text, "□ 개 요")
    assert.equal(blocks[1].text, "기본현황")
  })
})

describe("열 표(extractWithColumns) 칸 글 — 글꼴 바뀜으로 쪼개진 조각은 공백 규칙대로", () => {
  it("한 칸에 든 조각 사이 틈이 없으면 붙인다 (입+력하+면)", () => {
    // 3열 × 3행 — 열 x 50 / 200 / 350, 1행 둘째 칸이 글꼴 전환으로 세 조각
    const lines: NormItem[][] = [
      [item("구분", 50, 20, 700), item("입", 200, 10, 700), item("력하", 210, 20, 700), item("면", 230, 10, 700), item("비고", 350, 20, 700)],
      [item("가", 50, 10, 680), item("나다", 200, 20, 680), item("라", 350, 10, 680)],
      [item("마", 50, 10, 660), item("바사", 200, 20, 660), item("아", 350, 10, 660)],
    ]
    const out = extractWithColumns(lines, [50, 200, 350])
    assert.match(out, /입력하면/)
    assert.doesNotMatch(out, /입 력하 면/)
  })
})

describe("균등배분 좌표 감지 — 날짜 단위 빈칸은 붙이지 않는다", () => {
  it("공백 글리프 없이 벌린 '년   월   일' 은 띄운다", () => {
    const line = [item("년", 300, 12, 700, 12), item("월", 330, 12, 700, 12), item("일", 360, 12, 700, 12)]
    assert.equal(mergeLineSimple(line), "년 월 일")
  })
  it("같은 모양의 한 글자 균등배분 표제는 종전대로 붙인다", () => {
    const line = [item("기", 300, 12, 700, 12), item("업", 330, 12, 700, 12), item("체", 360, 12, 700, 12)]
    assert.equal(mergeLineSimple(line), "기업체")
  })
})

describe("wrapJoiner — 줄 머리 어미·조사 확장 (hwpx↔pdf 꺾임 자리 실측)", () => {
  it("하다·되다 활용을 더 넓게: 하기·하게·하거나·함으로써·되지·되면서 — 명사 끝 지(유지·방지)는 보조 용언 자리가 아니다", () => {
    assert.equal(wrapJoiner("비교적 안전을 유지", "하기 위하여 필요한"), "")
    assert.equal(wrapJoiner("결과제출은 ’28.6월까지", "할 계획인 만큼"), " ")
    assert.equal(wrapJoiner("운항허가증에 규정된 사항을 부과", "함으로써 제한되어야"), "")
    assert.equal(wrapJoiner("외부 요인으로 오염", "되지 않도록 설계"), "")
  })
  it("닫는 따옴표 뒤 인용 조사는 떼고 본다 (마련⏎하겠다”라고)", () => {
    assert.equal(wrapJoiner("안전한 국외이전을 위한 정책을 마련", "하겠다”라고 밝혔다."), "")
  })
  it("주격 가 뒤 되다(…가 되다)와 -려 뒤 하다는 보조 용언이라 띄운다", () => {
    assert.equal(wrapJoiner("사회적 대타협의 모범 사례가", "되도록 하겠다”고 밝혔다."), " ")
    assert.equal(wrapJoiner("외화 수령 전에 선입금을 하려", "하거나, 상대방과"), " ")
  })
  it("줄에서 갈린 두 음절 조사 (에⏎서, 이⏎나)", () => {
    assert.equal(wrapJoiner("개인정보가 국외에", "서 처리되는 경우"), "")
    assert.equal(wrapJoiner("해당 정보는 서면이", "나 적절한 경우"), "")
  })
  it("받침 뒤 이다 관형형·어미 (효과적⏎인, 선장⏎이어야), 접미사 -적 (자체⏎적으로)", () => {
    assert.equal(wrapJoiner("탈출할 수 있는 효과적", "인 설비를 갖추어야"), "")
    assert.equal(wrapJoiner("본선에 탑재하여 자체", "적으로 안전을 유지하는"), "")
    assert.equal(wrapJoiner("수도공고의 근본", "적인 변화가 필요하다는"), "")
    // 적다(적은·적게)는 접미사가 아니다
    assert.equal(wrapJoiner("선발예정인원과 같거나 그보다", "적은 경우에는"), " ")
  })
  it("두 음절+ 명사 뒤 한 은 하다 관형형 (필요⏎한), 수 관형사 자리는 띄운다", () => {
    assert.equal(wrapJoiner("박람회의 성공적인 개최에 필요", "한 범정부적 지원과"), "")
    assert.equal(wrapJoiner("법정기한(10월 1일)보다", "한 달 앞당겨"), " ")
    assert.equal(wrapJoiner("2027년", "한 해에만 500개"), " ")
  })
  it("어절 머리에 못 오는 어미 (갖추⏎어야, 가지⏎므로)", () => {
    assert.equal(wrapJoiner("충분한 공간을 두", "어야 한다."), "")
    assert.equal(wrapJoiner("큰 예비부력을 가지", "므로 국제만재흘수선협약에서"), "")
  })
  it("가운뎃점을 겹쳐 쓴 말줄임 뒤는 이어진 낱말이 아니다 (주의···⏎관세청)", () => {
    assert.equal(wrapJoiner("해외 반입 ‘짝퉁 마운자로’ 주의···", "관세청, 유해 의약품"), " ")
    assert.equal(wrapJoiner("누전차단기 등 소방·", "가스·전기 분야의"), "")
  })
  it("글자 쌍 증거가 갈리면 이어 붙인 꼴이 문서 줄 안 한 어절로 나왔는지 본다 (개인정보⏎처리자가)", () => {
    const lex = new WrapLexicon()
    for (const l of ["해당 개인정보처리자가 신고한다", "관련 개인정보 처리 방침을 둔다"]) lex.addLine(l)
    assert.equal(wrapJoiner("국외에서 처리되는 경우 개인정보", "처리자가 이를 알려야", lex), "")
    // 한 어절로 나온 적 없으면 종전대로 띄움
    assert.equal(wrapJoiner("국외에서 처리되는 경우 개인정보", "보호책임자를 지정", lex), " ")
    // 같은 문서가 두 조각을 띄어 쓴 이웃 어절로도 썼으면 붙이지 않는다 (배달종사자·배달 종사자 혼용)
    const mixed = new WrapLexicon()
    for (const l of ["공제조합 배달종사자의 참여", "안전운전 배달 종사자의 관심"]) mixed.addLine(l)
    assert.equal(wrapJoiner("안전운전에 대한 배달", "종사자의 자발적인", mixed), " ")
  })
  it("줄을 넘어온 문장 끝 뒤에 개정 표기가 붙어도 붙인다 (한⏎다;<개정 …>)", () => {
    assert.equal(wrapJoiner("다음을 만족해야 한", "다;<개정 2008. 9. 8>"), "")
    assert.equal(wrapJoiner("다음 요건을 만족해야 한", "다:"), "")
  })
})

describe("bodyLineJoins — 줄 간격 200% 본문", () => {
  const L = (text: string, y: number, right = 538): WrapLine => ({ text, left: 80, right, y, fontSize: 14 })
  it("같은 묶음 줄 간격이 모두 2em 이면 한 문단의 줄 간격이다", () => {
    const lines = [
      L("하는 소상공인에겐 전혀 다를 수 있다”며, “간극을 메꾸기 위해 지속적", 465),
      L("으로 현장을 찾겠다”고 덧붙였다. 이어 참석자들은 현장의 어려움을 전달하", 437),
      L("였다. 참석자들은 지원 확대를 요청했다.", 409, 300),
    ]
    assert.deepEqual(bodyLineJoins(lines), ["", ""])
  })
  it("다른 줄쌍 없이 홀로 2em 이상 벌어진 쌍은 종전대로 잇지 않는다", () => {
    const lines = [L("가나다라마바사아자차카타파하 가나다라마바사아자차카타파하 가나다라", 465), L("마바사 끝.", 430, 200)]
    assert.deepEqual(bodyLineJoins(lines), ["\n"])
  })
})

describe("칸 줄 꺾임 — 칸 글의 오른끝까지 찬 줄 (오른 안 여백이 넓은 칸)", () => {
  const ti = (text: string, x: number, w: number, y: number): TextItem => ({ text, x, y, w, h: 10, fontSize: 10 })
  it("다음 글자가 칸 안쪽에 반 글자 못 미치게 남아도 세 줄 이상 칸의 찬 줄은 꺾임으로 본다", () => {
    // 칸 x 100~300, 왼 여백 6 → 안쪽 오른끝 294. 찬 줄이 288.6 에서 끝남(0.54em 앞) — 종전 기하(넘침 0.46em < 0.5em)로는 꺾임이 아니었다
    const items = [
      ti("개인정보를", 106, 50, 700), ti("국외에", 160, 128.6, 700),
      ti("서", 106, 10, 686), ti("처리하는 경우 처리 방침 기재", 120, 168.6, 686),
      ti("의무", 106, 20, 672),
    ]
    const out = cellTextToString(items, { box: { x1: 100, x2: 300 } })
    assert.match(out, /국외에서 처리하는/)
  })
})

describe("cleanPdfText 한글 줄 이음 — 블록 안 줄바꿈도 어절 판정으로", () => {
  it("다음 줄이 조사로 시작하면 붙인다 (강등 표 글·글상자 줄)", () => {
    assert.equal(cleanPdfText("수출말소가등록 신청은 관할 세관\n에서 처리한다"), "수출말소가등록 신청은 관할 세관에서 처리한다")
    assert.equal(cleanPdfText("영상 결합 제품의 수출\n현황을 점검한다"), "영상 결합 제품의 수출 현황을 점검한다")
    assert.equal(cleanPdfText("협력의 새로운 이정표입\n니다."), "협력의 새로운 이정표입니다.")
  })
})
