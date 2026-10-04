import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WrapLexicon, wrapJoiner, startsNewItem, bodyLineJoins, joinPageBreakWraps, splitPageBreakWraps, PARA_LAST_LINE, PARA_FIRST_LEFT, type WrapLine } from "../src/pdf/line-wrap.js"
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

  it("한글 없는 중·일문 꺾임은 붙인다 — 띄어쓰기가 없는 글 (kpipa 계약서 중문·일문, LibreOffice)", () => {
    assert.equal(wrapJoiner("和海外出版社或海外著作权代理商（代", "理中介商）之间有用。"), "")
    assert.equal(wrapJoiner("有很多种类，", "因此很难提出一个模式"), "")
    assert.equal(wrapJoiner("著作権者に支払う", "ものとする。"), "")
    // 한글이 섞인 줄(국한문)은 이 규칙 밖 — 어절 사이 꺾임
    assert.equal(wrapJoiner("大韓民國 政府", "國務總理 발표"), " ")
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

  it("여백 밖에 매단 줄 끝 구두점(LibreOffice 중문 \"，\")이 묶음 오른끝을 끌어올려도 나머지 찬 줄을 잇는다", () => {
    // kpipa 계약서 중문 각주 실측: 찬 줄 오른끝 522~523, "，" 로 끝난 줄만 533 — 줄 간격 22pt(10pt 글자)
    const joins = bodyLineJoins([
      line("该合同模式在韩国出版社或著作权代理商（代理中介商）和海外出版社或海外著作权代理商（代", 94, 522, 207, 10),
      line("理中介商）之间有用。 但是，著作作品在海外出版或公众发送的所有权利基本上归著作人（著作", 98, 523, 185, 10),
      line("的各项权利。 另外，在外国，为了翻译出版及排他性发行而签订的合同和韩国一样，有很多种类，", 98, 533, 163, 10),
      line("因此很难提出一个模式，对于出版及其他与发行相关的出版权及排他性发行权等权利内容，外国", 98, 522, 141, 10),
      line("合同对方国家的著作权相关法律中也有规定，因此需要注意。", 98, 368, 119, 10),
      // 쪽 번호 — 가장 좁은 줄 간격(14pt)이지만 줄 간격 근거가 아니다
      line("1", 296, 300, 105, 10),
    ])
    assert.deepEqual(joins, ["", "", "", "", "\n"])
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

  it("왼쪽 정렬 묶음은 다음 줄 첫 어절이 남은 자리에 못 들어간 줄을 잇고 늘 띄운다", () => {
    // Chromium 인쇄 왼쪽 정렬 A4 실측 오른끝 — 11pt, 줄 간격 16.5pt, 문단 사이 24.5pt. 찬 줄은 가장 긴 1.1 첫 줄뿐
    const joins = bodyLineJoins([
      line("1.1 이 문서는 왼쪽 정렬 문단에서 자동 줄바꿈이 어떻게 처리되는지 확인하기 위해 작성한", 72, 517.3, 700, 11),
      line("예시 문서이며, 각 항목은 여러 줄에 걸쳐 이어집니다.", 90, 355, 683.5, 11),
      line("2.1 문서 담당자는 작성한 문서를 검토자에게 전달하고 검토 의견을 반영하여 최종본을", 72, 499.7, 659, 11),
      line("확정할 책임이 있으며, 확정된 문서는 지정된 보관 장소에 보관합니다.", 90, 435.2, 642.5, 11),
      line("2.2 검토자는 전달받은 문서의 내용이 관련 기준에 맞는지 확인하고 필요한 경우 수정", 72, 492, 618, 11),
      line("사항을 기록하여 담당자에게 돌려보내야 합니다.", 90, 330.8, 601.5, 11),
    ])
    assert.deepEqual(joins, [" ", "\n", " ", "\n", " "])
  })

  it("왼쪽 정렬 묶음에서 다단계 번호(\"5.1 \")로 여는 줄은 새 조항이라 잇지 않는다", () => {
    // SOP 실측: 짧은 줄만 모인 묶음이라 오른끝이 229 — "5 …기계장치"(223) 끝에 "5.1" 이 못 들어간다
    const joins = bodyLineJoins([
      line("5 사용 원자재 또는 기계장치", 70, 223, 700, 11),
      line("5.1 채취용기(1.5L 유리병)", 90, 229, 681, 11),
      line("5.2 배수용 물통", 90, 176, 662, 11),
    ])
    // 둘째 자리("5.1 …" → "5.2 …")는 묶음에서 가장 넓은 찬 줄이라 기존 full 판정이 잇는다 — 이 규칙의 몫이 아니다
    assert.equal(joins[0], "\n")
  })

  it("양쪽 정렬 묶음의 덜 찬 줄은 문단 끝줄이라 잇지 않는다 (ODL 188 \"e.g., H6.\" ⏎ \"Model merging.\")", () => {
    const joins = bodyLineJoins([
      line("et al., 2021). We utilize these datasets as benchmarks for", 72, 290, 700),
      line("evaluation and also report the average scores for the", 72, 290, 688),
      line("six tasks in the table below and in the appendix, e.g., H6.", 72, 280, 676),
      line("Model merging. Model merging methods such as Yadav", 72, 290, 664),
      line("et al. (2023) can boost model performance without further", 72, 290, 652),
    ])
    assert.deepEqual(joins, [" ", " ", "\n", " "])
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
  it("목차 줄·글자 크기가 다른 블록·항목 기호로 여는 블록은 잇지 않는다 (코퍼스 쪽 넘김 오결합)", () => {
    // 목차: 앞 쪽 끝줄이 쪽 번호로 끝남
    const toc = pages(530, "2.3.1. 회의록 작성대상 \t 8")
    toc[1].text = "2.3. 회의록의 구성 \t 7"
    joinPageBreakWraps(toc)
    assert.equal(toc.length, 3)
    const slide = pages(530, "벽#2·문서 장벽")
    slide[1].text = "PART 02·공무원업무의벽\t13/39"
    joinPageBreakWraps(slide)
    assert.equal(slide.length, 3)
    // 다음 쪽 첫 블록 글자 크기가 1pt 라도 다르고 짧은 제목꼴이면 제목·캡션 (15 → 16)
    const bigger = pages(530, "세부 행사 일정")
    bigger[2].style = { fontSize: 11 }
    joinPageBreakWraps(bigger)
    assert.equal(bigger.length, 3)
    // 항목 기호: 사용자 정의 영역 글머리(U+F000)·ㅇ·꺾쇠 제목·사각 기호 (eval-perf-2025 9쪽 "415건 최종 회신 ⏎  민생 안정과…")
    for (const head of ["\uF000 민생 안정과 경제 성장을 지원하는 법제 구축", "ㅇ 진출기업 세무안정", "< 2022년도 과제추진 계획 >", "[1] 공문서 작성 일반원칙", "〔서식 4-1〕가격입찰서", "▮ 2029년", "❐ 약 ․ 특용작물"]) {
      const bs = pages(530, head)
      joinPageBreakWraps(bs)
      assert.equal(bs.length, 3, head)
    }
  })
  it("크기가 1pt 달라도 긴 본문·문장으로 끝나는 블록은 잇는다 — 쪽마다 반올림 크기가 흔들리는 문서 (HWPX 원문 같은 문단)", () => {
    const long = pages(530, "들은 인공지능을 미래의 동반자로 그려냈으며 다음 세대의 일상을 바꾸어 나갈 것으로 기대를 모으고 있다는 평가가 이어졌다")
    long[2].style = { fontSize: 11 }
    joinPageBreakWraps(long)
    assert.equal(long.length, 2)
    const sentence = pages(530, "들은 발송되지 않습니다.")
    sentence[2].style = { fontSize: 11 }
    joinPageBreakWraps(sentence)
    assert.equal(sentence.length, 2)
  })
  it("앞 쪽 문단이 문장으로 끝나면 잇지 않는다 — HWPX 쌍 대조에서 이 이음 26곳 중 20곳이 원문 문단 경계", () => {
    for (const tail of ["상담사들을 격려했다.", "전했다.”", "요청할 예정입니까?"]) {
      const bs = pages(530, "현수엽 제1차관은 이어서 말했다")
      bs[1].text = "모습을 보여준다. " + tail
      joinPageBreakWraps(bs)
      assert.equal(bs.length, 3, tail)
    }
  })
  it("문장 끝이어도 다음 쪽 첫 줄이 왼끝에서 시작하면 잇고, 들여 시작하면 끊는다 (HWPX 쌍: 왼끝 4곳 중 같은 문단 3, 들여씀 20곳 중 경계 19)", () => {
    const flush = pages(530, "따라서 mkswap을 부주의하게 사용하면 중요한 파일을 잃는다")
    flush[1].text = "모습을 보여준다. 판별해 주지 않기 때문이다."
    PARA_FIRST_LEFT.set(flush[2].bbox!, 72)
    joinPageBreakWraps(flush)
    assert.equal(flush.length, 2)
    const indent = pages(530, "현수엽 제1차관은 이어서 말했다")
    indent[1].text = "모습을 보여준다. 상담사들을 격려했다."
    PARA_FIRST_LEFT.set(indent[2].bbox!, 82)
    joinPageBreakWraps(indent)
    assert.equal(indent.length, 3)
  })
  it("용어·설명 행(짧은 머리 + 탭)과 점 조항 번호(.13)는 새 항목, 앞 문단에 같은 사각 기호가 있으면 문장 속 나열로 잇는다", () => {
    for (const head of ["N\t- 앞쪽에서 입력했었던 문자의 다음 앞 단어를 검색", ".13 사용되는 무선주파수 및 유지되는 당직을 포함하여"]) {
      const bs = pages(530, head)
      joinPageBreakWraps(bs)
      assert.equal(bs.length, 3, head)
    }
    const inline = pages(530, "▲빈곤선 설정 및 연관 빈곤율 추정 ▲국가별 빈곤선 비교")
    inline[1].text = "금번 연수의 주요 내용은 ▲ 가계조사 자료를 활용한 복지지표 구축"
    joinPageBreakWraps(inline)
    assert.equal(inline.length, 2)
  })
  it("탭으로 칸을 나눈 행 다음 쪽 첫 줄이 짧은 제목꼴이면 끊고, 탭 뒤 문장이 이어지면 잇는다", () => {
    const row = pages(530, "반수체 수명 주기")
    row[1].text = "‘상록수’의 별도 정의\t일 년 내내 푸른 잎을 가짐"
    joinPageBreakWraps(row)
    assert.equal(row.length, 3)
    const prose = pages(530, "무엇인가?")
    prose[1].text = "Server 의 crash로 인해서\tclinet에 hang이 걸리지 않도록 지정하는 option은"
    joinPageBreakWraps(prose)
    assert.equal(prose.length, 2)
    const clause = pages(530, "가정한다;")
    clause[1].text = ".2.3\t손상을 입은 후 선박이 경사된 현측의 구명뗏목은 하강 준비로 스윙 아웃되었다 고"
    joinPageBreakWraps(clause)
    assert.equal(clause.length, 2)
  })
  it("쪽별 사영은 이은 문단을 쪽 경계에서 다시 가른다 — 뒤 쪽 글이 앞 쪽에 실리지 않게 (#136)", () => {
    const blocks = pages(530, "들은 인공지능을 미래의 동반자로 그려냈다.\n다음 문단도 같은 쪽이다.")
    joinPageBreakWraps(blocks)
    const split = splitPageBreakWraps(blocks)
    assert.deepEqual(split.map(b => [b.pageNumber, b.text]), [
      [1, "앞 문단"], [1, "모습을 보여준다. 아이"], [2, "들은 인공지능을 미래의 동반자로 그려냈다.\n다음 문단도 같은 쪽이다."],
    ])
    // 문서 블록은 이은 그대로
    assert.equal(blocks.length, 2)
  })
  it("세 쪽에 걸친 문단도 쪽마다 가른다", () => {
    const fs = { fontSize: 10 }
    const mk = (page: number, text: string, y: number): IRBlock => ({ type: "paragraph", text, pageNumber: page, bbox: { page, x: 72, y, width: 458, height: 10 }, style: fs })
    const a = mk(1, "첫 쪽 끝 문장이 이어", 80), b = mk(2, "지고 둘째 쪽을 다 채운 뒤 또", 80), c = mk(3, "셋째 쪽으로 넘어간다.", 700)
    PARA_LAST_LINE.set(a.bbox!, { right: 530, width: 458, fontSize: 10 })
    PARA_LAST_LINE.set(b.bbox!, { right: 530, width: 458, fontSize: 10 })
    const blocks = [a, b, c]
    joinPageBreakWraps(blocks)
    assert.equal(blocks.length, 1)
    assert.deepEqual(splitPageBreakWraps(blocks).map(x => [x.pageNumber, x.text]), [
      [1, "첫 쪽 끝 문장이 이어"], [2, "지고 둘째 쪽을 다 채운 뒤 또"], [3, "셋째 쪽으로 넘어간다."],
    ])
  })
  it("이음 뒤 글이 앞부분에서 바뀌었으면 가르지 않는다 (잘못 가르느니 종전대로)", () => {
    const blocks = pages(530, "들은 인공지능을")
    joinPageBreakWraps(blocks)
    blocks[1] = { ...blocks[1], text: "(주) " + blocks[1].text }
    assert.deepEqual(splitPageBreakWraps(blocks).map(x => x.pageNumber), [1, 1])
  })
})

it("keeps an uncertain Latin line-end hyphen boundary unless the intact compound occurs in the document", () => {
  assert.equal(wrapJoiner("an inter-", "national agreement"), " ")
  assert.equal(wrapJoiner("a well-", "known example", lexOf("one well-known example")), "")
  assert.equal(wrapJoiner("생산-", "가공 단계"), "")
  assert.equal(wrapJoiner("ISO-", "9001 인증"), "")
})

it("preserves hyphenated terms embedded in Korean prose", () => {
  assert.equal(wrapJoiner("안전 규격의 fire-", "resistant 용어"), "")
  assert.equal(wrapJoiner("해상도 (high-", "definition television)"), "")
})
