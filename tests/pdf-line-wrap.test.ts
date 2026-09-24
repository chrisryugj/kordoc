import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WrapLexicon, wrapJoiner, startsNewItem, bodyLineJoins, joinPageBreakWraps, PARA_LAST_LINE, type WrapLine } from "../src/pdf/line-wrap.js"
import type { IRBlock } from "../src/types.js"
import { cellTextToString, type TextItem } from "../src/pdf/line-detector.js"
import { extractPageBlocksFallback } from "../src/pdf/page-blocks.js"
import { detectClusterTables, type ClusterItem } from "../src/pdf/cluster-detector.js"
import type { NormItem } from "../src/pdf/text-line.js"

/** 문서 줄 안 글을 쌓은 어휘 사전 */
function lexOf(...lines: string[]): WrapLexicon {
  const lex = new WrapLexicon()
  for (const l of lines) lex.addLine(l)
  return lex
}

describe("wrapJoiner — 꺾인 자리 붙임/띄움 (hwpx↔pdf 실측 사례)", () => {
  it("다음 줄 첫 어절이 조사·어미뿐이면 붙인다 (또⏎는, 제7조의9⏎에, 박물관’⏎으로)", () => {
    assert.equal(wrapJoiner("사망자 또는 행방불명자의 배우자 또", "는 자녀"), "")
    assert.equal(wrapJoiner("법률」 제7조의9", "에 따라 아래와 같이"), "")
    assert.equal(wrapJoiner("‘제1종 전문박물관’", "으로 정식 등록되었으며"), "")
    assert.equal(wrapJoiner("하였", "다. 이에 따라"), "")
  })

  it("받침에 맞을 때만 이·가 를 조사로 본다 (기업⏎이 / 우리나라⏎가)", () => {
    assert.equal(wrapJoiner("제약바이오 중소벤처기업", "이 현장에서 겪는"), "")
    assert.equal(wrapJoiner("“우리나라", "가 책임 있는"), "")
  })

  it("하다·되다 활용은 명사 뒤에만 붙이고, -야·-으로 뒤 보조 용언은 띄운다", () => {
    assert.equal(wrapJoiner("목표 100개소를 이미 달성", "하였으며, 현장지원"), "")
    assert.equal(wrapJoiner("통신할 수 있어야", "하며 선교내에서"), " ")
    assert.equal(wrapJoiner("설치를 기본으로", "하고 도시지역"), " ")
  })

  it("앞 줄이 조사·어미로 끝난 온전한 어절이면 띄운다 (특별공로자의⏎배우자, 서남해안과⏎제주)", () => {
    assert.equal(wrapJoiner("특별공로상이자 및 특별공로자의", "배우자"), " ")
    assert.equal(wrapJoiner("표시한 부분에 주의를", "기울이도록 해"), " ")
    // "과" 가 받침 뒤 조사 — 한 글자 증거("과제")가 있어도 어절 끝이 먼저
    assert.equal(wrapJoiner("우리나라도 서남해안과", "제주 연안을", lexOf("국가 과제 추진")), " ")
  })

  it("쉼표·쌍점 뒤는 띄우고, 가운뎃점 뒤는 붙인다", () => {
    assert.equal(wrapJoiner("4.19혁명공로자,", "공상공무원, 특별공로상이자"), " ")
    assert.equal(wrapJoiner("누전차단기 등 소방·", "가스·전기 분야의"), "")
  })

  it("문서 어휘 증거: 한 어절 안에만 나오면 붙이고, 두 어절로만 나오면 띄운다", () => {
    const joined = lexOf("대상 재일학도의용군인 및 가족", "공상공무원 특별공로상이자")
    assert.equal(wrapJoiner("무공수훈자, 보국수훈자, 재", "일학도의용군인, 4.19혁명부상자", joined), "")
    assert.equal(wrapJoiner("4.19혁명부상자, 공상공무", "원 및 특별공로상이자", joined), "")
    assert.equal(wrapJoiner("주요 기후", "위기 대응", lexOf("최근 기후 위기 극복")), " ")
    assert.equal(wrapJoiner("주요 기후", "위기 대응", lexOf("최근 기후위기 극복")), "")
  })

  it("한 음절 조각: 줄 안에서 홀로 선 적 없으면 붙이고 낱말(등)이면 띄운다", () => {
    // "등" 은 줄 안에서 홀로 선 어절로 나오지만 "등|주" 이웃 증거는 없다 — 조각 검사가 가른다
    const lex = lexOf("가 국제우편 등 기타 경로", "하나 둘")
    assert.equal(wrapJoiner("기상재난 대응체계를 살", "펴보고, 명절 기간", lex), "")
    assert.equal(wrapJoiner("특송화물 · 국제우편 등", "주요 반입경로에", lex), " ")
  })

  it("닫힌 부류 한 음절(및·등)은 앞 쪽에 아직 안 나왔어도 조각으로 보지 않는다 (첫 쪽 보전⏎및)", () => {
    const empty = new WrapLexicon()
    assert.equal(wrapJoiner("해양자원의 보전", "및 지속가능한 활용", empty), " ")
    assert.equal(wrapJoiner("국제우편 등", "주요 반입경로에", empty), " ")
    assert.equal(wrapJoiner("대응체계를 살", "펴보고", empty), "")
  })

  it("영문끼리·숫자끼리는 한 글자 증거에 속지 않고 띄운다", () => {
    const lex = lexOf("the data format", "2026 년 11:00 시작")
    assert.equal(wrapJoiner("the Accession of Costa Rica", "to the Digital", lex), " ")
    assert.equal(wrapJoiner("(일) 11:00", "2026. 9. 21.", lex), " ")
  })

  it("수 뒤 단위는 붙인다 (위원 2⏎명을)", () => {
    assert.equal(wrapJoiner("과기정통부가 추천한 위원 2", "명을 포함하고"), "")
  })

  it("날짜로 끝난 줄(서식 서명란)의 '일' 은 조각이 아니다 — 다음 줄이 괄호면 증거대로", () => {
    const empty = new WrapLexicon()
    assert.equal(wrapJoiner("년 월 일", "신고인 (서명 또는 인)", empty), " ")
    assert.equal(wrapJoiner("2026년 9월 24일", "신청인 (서명)", empty), " ")
    assert.equal(wrapJoiner("(청장 후보자 윤희근)은 7월 28일", "(목)부터 전국의", lexOf("신청은 7월 29일(금)까지 받는다")), "")
    // 날짜가 아닌 한 음절 조각은 종전대로 ("주시기 바⏎랍니다")
    assert.equal(wrapJoiner("납부하여 주시기 바", "랍니다.", empty), "")
  })

  it("되다 활용 앞 주격 '이'·인용 '-라' 뒤 하다는 띄우고, 명사 뒤 하다·되다는 붙인다", () => {
    assert.equal(wrapJoiner("내용 확인 후 최종 승인이", "되며, 기관담당자 변경"), " ")
    assert.equal(wrapJoiner("시행규칙(이하 “규칙”이라", "한다) 제3조제2항에"), " ")
    assert.equal(wrapJoiner("업무현황 파악이 용이", "하도록 하고"), "")
    assert.equal(wrapJoiner("‘가능성 희박’으로 평가", "되어 제외됐다"), "")
  })

  it("시·할·데·뒤·된·바 는 홀로 쓰는 한 음절 낱말이라 조각으로 붙이지 않는다", () => {
    const empty = new WrapLexicon()
    assert.equal(wrapJoiner("구제급여 지급신청 시", "제출한 서류는 제외합니다.", empty), " ")
    assert.equal(wrapJoiner("다음 각 호의 행위를 할", "수 있다.", empty), " ")
    assert.equal(wrapJoiner("경쟁력을 강화하는 데", "기여할 것으로", empty), " ")
    assert.equal(wrapJoiner("제재처분의 원인이 된", "사실의 경위", empty), " ")
    assert.equal(wrapJoiner("(모자 벗은 상반신으로", "뒤 그림 없이 6개월", empty), " ")
  })
})

describe("startsNewItem — 줄 머리 새 항목", () => {
  it("글머리표·번호·조항은 새 항목", () => {
    assert.equal(startsNewItem("앞 줄", "○ 통계분야에 대한 지식"), true)
    assert.equal(startsNewItem("앞 줄", "- 일급: 80,240원"), true)
    assert.equal(startsNewItem("앞 줄", "2.개인정보 보호책임자 지정"), true)
    assert.equal(startsNewItem("앞 줄", "제3조(목적) 이 법은"), true)
  })

  it("소수·붙임표 뒤 글·줄 넘어온 문장 끝은 이어진 글", () => {
    assert.equal(startsNewItem("전년 대비", "9.8% 증가했다"), false)
    assert.equal(startsNewItem("관련 애로를 논의하기 위한 한", "-EU 간 상시 협의"), false)
    assert.equal(startsNewItem("관계기관과 협의하였", "다. 이에 따라"), false)
  })
})

/** 본문 줄: 오른끝 530·줄 간격 16pt(글자 10pt) */
const line = (text: string, left: number, right: number, y: number, fontSize = 10): WrapLine => ({ text, left, right, y, fontSize })

describe("bodyLineJoins — 본문 꺾임 기하", () => {
  it("오른끝까지 찬 넓은 줄 다음 줄은 잇는다 (어절 중간이면 붙임)", () => {
    const joins = bodyLineJoins([
      line("사망자 또는 행방불명자의 배우자 또", 72, 530, 700),
      line("는 자녀를 포함한다.", 72, 250, 684),
    ])
    assert.deepEqual(joins, [""])
  })

  it("안 찬 줄·좁은 줄·문단 간격·글자 크기 변화·새 항목 앞은 잇지 않는다", () => {
    const base = line("실태를 확인했다. 이어 생산 현장을 점검하고 관계자와 간담회를", 72, 530, 700)
    assert.deepEqual(bodyLineJoins([line("짧은 줄에서 끝난 문단", 72, 300, 700), line("다음 문단", 72, 530, 684)]), ["\n"])
    assert.deepEqual(bodyLineJoins([line("통계청공고", 200, 300, 700), line("제2025-11호", 210, 290, 684)]), ["\n"])
    assert.deepEqual(bodyLineJoins([base, line("열었다.", 72, 120, 660)]), ["\n"])
    assert.deepEqual(bodyLineJoins([base, line("열었다.", 72, 120, 684, 14)]), ["\n"])
    assert.deepEqual(bodyLineJoins([base, line("○ 둘째 항목", 72, 200, 684)]), ["\n"])
    assert.deepEqual(bodyLineJoins([base, line("열었다.", 72, 120, 684)]), [" "])
  })
})

function ti(text: string, x: number, y: number, w: number, fontSize = 10): TextItem {
  return { text, x, y, w, h: fontSize, fontSize, fontName: "Test" }
}

describe("cellTextToString — 칸 상자가 있으면 꺾임을 기하·어휘로", () => {
  // 칸 x 58~301.6, 안쪽 여백 5.1 → 글 오른끝 296.5 (pair05 해외통계채용 가점 표 실측 기하)
  const box = { x1: 58, x2: 301.6 }
  it("오른끝까지 찬 줄의 어절 중간 꺾임은 붙이고, 어절 경계 꺾임은 줄바꿈으로 둔다", () => {
    const lex = lexOf("가 재일학도의용군인 나")
    const items = [
      ti("-", 63.1, 608, 5.6), ti("보국수훈자,", 224.8, 608, 55.7), ti("재", 285.7, 608, 10.8),
      ti("일학도의용군인,", 71.8, 594, 77.1), ti("특별공로자의", 231.7, 594, 64.8),
      ti("배우자", 71.8, 580, 32.4),
    ]
    items[1].hasSpaceBefore = true
    items[2].hasSpaceBefore = true
    items[4].hasSpaceBefore = true
    assert.equal(cellTextToString(items, { box, lex }), "- 보국수훈자, 재일학도의용군인, 특별공로자의\n배우자")
  })

  it("칸 안쪽에 다음 글자가 들어갈 자리가 있던 줄(문단 끝)은 잇지 않는다", () => {
    const items = [ti("기준", 70, 100, 20), ti("을", 70, 86, 10)]
    // 조사로 시작해도 앞 줄이 칸 폭의 한참 앞에서 끝났으면 원문 줄바꿈이다
    assert.equal(cellTextToString(items, { box }), "기준\n을")
    // 칸 상자 없는 호출(과소분할 재구성)은 종전 조각 규칙
    assert.equal(cellTextToString(items), "기준을")
  })
})

function ni(text: string, x: number, y: number, w: number, hasSpaceBefore = false): NormItem {
  return { text, x, y, w, h: 10, fontSize: 10, fontName: "Test", isHidden: false, hasSpaceBefore }
}

describe("extractPageBlocksFallback — 꺾인 본문 줄을 한 문단으로", () => {
  it("찬 줄로 꺾인 세 줄 → 문단 하나 (어절 중간은 붙이고 경계는 띄움)", () => {
    const items = [
      ni("○", 59, 700, 10), ni("가점을", 75, 700, 30, true), ni("받아", 110, 700, 20, true), ni("합격하는", 135, 700, 40, true),
      ni("사람의", 180, 700, 30, true), ni("수는", 215, 700, 20, true), ni("선발", 240, 700, 20, true), ni("인원을", 265, 700, 30, true),
      ni("산정", 300, 700, 20, true),
      ni("하는", 75, 684, 20), ni("경우", 100, 684, 20, true), ni("소수점", 125, 684, 30, true), ni("이하를", 160, 684, 30, true),
      ni("버리고", 195, 684, 30, true), ni("그", 230, 684, 10, true), ni("결과가", 245, 684, 30, true), ni("같거나", 280, 684, 40, true),
      ni("적은", 75, 668, 20), ni("경우에는", 100, 668, 40, true), ni("그러하지", 145, 668, 40, true), ni("아니하다.", 190, 668, 45, true),
    ]
    const blocks = extractPageBlocksFallback(items, 1, false, false)
    assert.equal(blocks.length, 1, JSON.stringify(blocks.map(b => b.text)))
    assert.equal(blocks[0].text, "○ 가점을 받아 합격하는 사람의 수는 선발 인원을 산정하는 경우 소수점 이하를 버리고 그 결과가 같거나 적은 경우에는 그러하지 아니하다.")
  })
})

describe("클러스터 표 칸 글 — 같은 줄 아이템은 공백 아이템·갭으로 잇는다", () => {
  const ci = (text: string, x: number, y: number, w: number, hasSpaceBefore = false): ClusterItem =>
    ({ text, x, y, w, h: 10, fontSize: 10, fontName: "T", hasSpaceBefore })
  it("글꼴·위치 바뀜으로 쪼개진 아이템(지운+다+.)에 공백을 넣지 않는다 (hwp3-sample11 실측 꼴)", () => {
    const items = [
      ci("명령", 50, 700, 20), ci("설명", 250, 700, 20),
      ci("rm", 50, 680, 12), ci("단일", 250, 680, 20), ci("파일을", 275, 680, 30, true), ci("지운", 310, 680, 20, true), ci("다", 330, 680, 10), ci(".", 340, 680, 3),
      ci("cp", 50, 660, 12), ci("파일을", 250, 660, 30), ci("복사", 285, 660, 20, true), ci("한다", 305, 660, 20), ci(".", 325, 660, 3),
      ci("mv", 50, 640, 12), ci("파일", 250, 640, 20), ci("이름을", 275, 640, 30, true), ci("바꾼", 310, 640, 20, true), ci("다", 330, 640, 10), ci(".", 340, 640, 3),
    ]
    const [res] = detectClusterTables(items, 1)
    assert.deepEqual(res.table.cells.map(row => row.map(c => c.text)), [
      ["명령", "설명"], ["rm", "단일 파일을 지운다."], ["cp", "파일을 복사한다."], ["mv", "파일 이름을 바꾼다."],
    ])
  })
})

describe("joinPageBreakWraps — 쪽 끝 문단이 다음 쪽 첫 문단으로 꺾여 넘어감", () => {
  /** 쪽 끝 문단(끝줄 기하 기록)·다음 쪽 첫 문단 */
  function pages(lastLineRight: number, nextText: string): IRBlock[] {
    const a: IRBlock = { type: "paragraph", text: "모습을 보여준다. 아이", pageNumber: 1, bbox: { page: 1, x: 72, y: 80, width: 458, height: 30 }, style: { fontSize: 10 } }
    const other: IRBlock = { type: "paragraph", text: "앞 문단", pageNumber: 1, bbox: { page: 1, x: 72, y: 300, width: 458, height: 10 }, style: { fontSize: 10 } }
    PARA_LAST_LINE.set(a.bbox!, { right: lastLineRight, width: lastLineRight - 72, fontSize: 10 })
    const b: IRBlock = { type: "paragraph", text: nextText, pageNumber: 2, bbox: { page: 2, x: 72, y: 700, width: 300, height: 10 }, style: { fontSize: 10 } }
    return [other, a, b]
  }
  it("끝줄이 본문 오른끝까지 찼고 다음 쪽이 이어지는 글이면 한 문단 (어절 중간은 붙임)", () => {
    const blocks = pages(530, "들은 인공지능을 미래의 동반자로 그려냈다.")
    joinPageBreakWraps(blocks)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].text, "모습을 보여준다. 아이들은 인공지능을 미래의 동반자로 그려냈다.")
  })
  it("끝줄이 안 찼거나 다음 쪽이 새 항목이면 두 문단 그대로", () => {
    const short = pages(300, "들은 인공지능을")
    joinPageBreakWraps(short)
    assert.equal(short.length, 3)
    const item = pages(530, "○ 다음 항목")
    joinPageBreakWraps(item)
    assert.equal(item.length, 3)
  })
})
