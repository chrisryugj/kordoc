import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectClusterTables, findTwoColumnProseCutX, sideTabGlyphs, type ClusterItem } from "../src/pdf/cluster-detector.js"

/** 헬퍼: 간단한 텍스트 아이템 생성 */
function item(text: string, x: number, y: number, w = 40, fontSize = 12): ClusterItem {
  return { text, x, y, w, h: fontSize, fontSize, fontName: "Test" }
}

describe("detectClusterTables", () => {
  it("고시안 머리 \"○○고시 제 호\" 아래 낱말 아이템 본문 줄은 표가 아니다", () => {
    // 본문 줄은 낱말마다 아이템이고 틈이 0.5em 안팎 — 쪽 폭을 덮어 머리 세 열에 다 맞았다(지역의사선발전형 고시안 2쪽, 글자 14pt)
    const line = (y: number, words: Array<[string, number, number]>) => words.map(([t, x, w]) => item(t, x, y, w, 14))
    const items: ClusterItem[] = [
      ...line(748, [["보건복지부고시", 71, 98], ["제", 183, 14], ["호", 253, 14]]),
      ...line(615, [["지역의사선발전형", 71, 112], ["선발", 190, 28], ["등에", 225, 28], ["관한", 260, 28], ["고시", 295, 28], ["일부를", 330, 42], ["다음과", 379, 42], ["같이", 428, 28], ["개정한다.", 463, 60]]),
      ...line(582, [["제4조", 71, 36], ["중", 114, 14], ["“별표와”를", 135, 66], ["“별표", 208, 34], ["1과”로", 249, 41], ["한다.", 297, 32]]),
      ...line(550, [["제4조의2를", 71, 72], ["다음과", 150, 42], ["같이", 199, 28], ["신설한다.", 234, 60]]),
      ...line(518, [["제4조의2(둘", 71, 79], ["이상의", 156, 42], ["진료권에", 204, 56], ["걸친", 265, 28], ["학교군", 299, 42], ["지역의", 347, 42], ["지정)", 394, 35], ["영", 435, 14], ["별표", 455, 28], ["2", 488, 8], ["제2", 502, 22]]),
      ...line(486, [["호가목", 85, 42], ["비고에", 132, 42], ["따라", 180, 28], ["보건복지부장관이", 214, 112], ["교육부장관과", 331, 84], ["협의하여", 421, 56], ["고시하", 482, 42]]),
      ...line(454, [["는", 85, 14], ["지역은", 106, 42], ["별표", 155, 28], ["2와", 190, 22], ["같다.", 219, 32]]),
    ]
    assert.deepEqual(detectClusterTables(items, 1), [])
  })

  it("2열 × 4행 정렬된 텍스트 → 테이블 감지", () => {
    // 2열 key-value 테이블 시뮬레이션
    const items: ClusterItem[] = [
      // col1(x=50), col2(x=200) — 갭이 fontSize*1.5 이상
      item("구분", 50, 400),    item("내용", 200, 400),
      item("이름", 50, 380),    item("홍길동", 200, 380),
      item("나이", 50, 360),    item("30세", 200, 360),
      item("주소", 50, 340),    item("서울시", 200, 340),
    ]

    const results = detectClusterTables(items, 1)
    assert.ok(results.length > 0, "테이블이 감지되어야 함")
    assert.equal(results[0].table.cols, 2)
    assert.ok(results[0].table.rows >= 3)
  })

  it("3열 × 3행 테���블 감지", () => {
    const items: ClusterItem[] = [
      item("번호", 50, 400), item("이름", 200, 400), item("금액", 350, 400),
      item("1", 50, 380),    item("사과", 200, 380), item("1000", 350, 380),
      item("2", 50, 360),    item("배", 200, 360),   item("2000", 350, 360),
    ]

    const results = detectClusterTables(items, 1)
    assert.ok(results.length > 0, "3열 테이블 감지")
    assert.equal(results[0].table.cols, 3)
  })

  it("단일 열 텍스트(문단) → 테이블 아님", () => {
    const items: ClusterItem[] = [
      item("첫째 줄 내용입니다", 50, 400, 200),
      item("둘째 줄 내용입니다", 50, 380, 200),
      item("셋째 줄 내용입니다", 50, 360, 200),
    ]

    const results = detectClusterTables(items, 1)
    assert.equal(results.length, 0, "단일 열은 테이블이 아님")
  })

  it("아이템이 너무 적으면 테이블 아님", () => {
    const items: ClusterItem[] = [
      item("A", 50, 400), item("B", 200, 400),
    ]
    const results = detectClusterTables(items, 1)
    assert.equal(results.length, 0)
  })

  it("빈 배열 → 빈 결과", () => {
    assert.deepEqual(detectClusterTables([], 1), [])
  })
})

/** 헬퍼: 2단 조판 본문 페이지 시뮬레이션 (국회 속기록류) */
function twoColumnProsePage(): ClusterItem[] {
  const items: ClusterItem[] = []
  // 좌단 x=50~280 / 우단 x=310~540, 각 12줄 — 마지막 줄 빼고 justify
  for (let r = 0; r < 12; r++) {
    const y = 700 - r * 20
    const lastL = r === 11
    const lastR = r === 5 // 우단 문단 끝 (짧은 줄)
    items.push({ text: "왼쪽단의본문문장조각입니다" + r, x: 50, y, w: lastL ? 120 : 230, h: 12, fontSize: 12, fontName: "T" })
    items.push({ text: "오른쪽단의본문문장조각입니다" + r, x: 310, y, w: lastR ? 110 : 230, h: 12, fontSize: 12, fontName: "T" })
  }
  return items
}

describe("findTwoColumnProseCutX (2단 조판 본문 판별)", () => {
  it("좌우 대칭 justify 본문 → 단 사이 컷 반환", () => {
    const cutX = findTwoColumnProseCutX(twoColumnProsePage())
    assert.ok(cutX !== null, "2단 본문으로 판별되어야 함")
    assert.ok(cutX > 280 && cutX < 310, `컷이 단 사이(280~310)여야 함: ${cutX}`)
  })

  it("짧은 라벨 열을 가진 진짜 표 → null", () => {
    const items: ClusterItem[] = []
    for (let r = 0; r < 12; r++) {
      const y = 700 - r * 20
      items.push({ text: "구분" + r, x: 50, y, w: 40, h: 12, fontSize: 12, fontName: "T" })
      items.push({ text: "내용값" + r, x: 310, y, w: 60, h: 12, fontSize: 12, fontName: "T" })
    }
    assert.equal(findTwoColumnProseCutX(items), null, "짧은 셀 표는 본문이 아님")
  })

  it("숫자 위주 2열(예산표) → null", () => {
    const items: ClusterItem[] = []
    for (let r = 0; r < 12; r++) {
      const y = 700 - r * 20
      items.push({ text: "1,234,567,890,123", x: 50, y, w: 230, h: 12, fontSize: 12, fontName: "T" })
      items.push({ text: "9,876,543,210,987", x: 310, y, w: 230, h: 12, fontSize: 12, fontName: "T" })
    }
    assert.equal(findTwoColumnProseCutX(items), null, "숫자 표는 본문이 아님")
  })

  it("detectClusterTables: 2단 조판 본문은 표로 감지하지 않음", () => {
    const results = detectClusterTables(twoColumnProsePage(), 1)
    assert.equal(results.length, 0, "2단 본문이 표로 흡수되면 안 됨")
  })

  it("오염 좌표(Infinity·과대 span)에서 폭주 없이 즉시 종료", () => {
    // 손상 PDF의 오염 CTM이 만드는 극단 좌표 — 스캔 루프 폭주 회귀 방지 (fuzz: bflip)
    const inf = twoColumnProsePage()
    inf.push({ text: "오염", x: Infinity, y: 700, w: 10, h: 12, fontSize: 12, fontName: "T" })
    const t0 = performance.now()
    findTwoColumnProseCutX(inf)
    const huge = twoColumnProsePage()
    huge.push({ text: "오염", x: 1e9, y: 700, w: 10, h: 12, fontSize: 12, fontName: "T" })
    findTwoColumnProseCutX(huge)
    assert.ok(performance.now() - t0 < 1000, "오염 좌표에서 1초 내 반환해야 함")
  })
})

describe("sideTabGlyphs — 쪽 옆 세로 색인 탭", () => {
  // 왼쪽 띠(x=37)에 한 자씩 찍힌 탭 글자 + 그 오른쪽 본문 줄(마지막 줄이 짧게 꺾임, 낱말마다 아이템)
  const tab = "응급의료기관평가기준집"
  const tabItems = [...tab].map((ch, k) => item(ch, 37, 700 - k * 12, 9, 9))
  const body: ClusterItem[] = [
    item("○ (목 적) 기존의 응급의료기관 평가와 재지정 평가를 통합 평가 체계로 일원화함으로써", 77, 700, 460, 10),
    item("응급의료기관", 96, 676, 71, 10), item("평가부터", 171, 676, 47, 10), item("시행", 222, 676, 24, 10), item(")", 246, 676, 4, 10),
    item("○ (평가체계)", 77, 652, 70, 10),
    item("- 1차 년도 : 서면평가", 90, 628, 125, 10),
    item("- 2차 년도 : 서면평가", 90, 604, 125, 10),
    item("- 3차 년도 : 현지평가, 재지정 평가 통합 시행", 90, 580, 260, 10),
    item("※ 전 지표는 매년 관리·운영 하여야 하며, 3년 주기 평가 지표는 전체 대상 기간을 평가 함", 97, 566, 410, 10),
  ]

  it("탭 글자 기둥을 찾는다(왼쪽·오른쪽)", () => {
    assert.equal(sideTabGlyphs([...tabItems, ...body]).size, tab.length)
    const mirrored = [...tabItems.map(i => ({ ...i, x: 560 })), ...body]
    assert.equal(sideTabGlyphs(mirrored).size, tab.length)
  })

  it("탭 글자와 옆 본문 줄을 표로 묶지 않는다", () => {
    assert.deepEqual(detectClusterTables([...tabItems, ...body], 1), [])
  })

  it("쪽 맨 왼쪽의 글머리 기호 기둥(▷·◦)은 탭이 아니다 — 책·장 이름은 글자·숫자다", () => {
    const rows: ClusterItem[] = []
    for (let k = 0; k < 8; k++) rows.push(item("▷", 40, 600 - k * 12, 8, 9), item(`목록 항목 ${k + 1} 의 본문 글`, 60, 604 - k * 12, 200, 9))
    assert.equal(sideTabGlyphs(rows).size, 0)
  })

  it("쪽의 다른 글보다 안쪽에 선 한 글자 기둥(서식 표의 세로 칸 이름)은 탭이 아니다", () => {
    const label = [..."응시자격요건"].map((ch, k) => item(ch, 70, 600 - k * 12, 9, 9))
    const body = [item("■ 공고문 제목은 쪽 왼끝에서 시작한다", 40, 680, 300), item("① 학사학위를 취득한 후 6년 이상 경력", 100, 590, 300)]
    assert.equal(sideTabGlyphs([...label, ...body]).size, 0)
  })

  it("두 줄로 세운 탭(나란히 붙은 기둥 둘)도 탭이고, 옆 본문 줄을 표로 묶지 않는다", () => {
    // 책자 오른쪽 띠: "구급차의 의료장비·" | "구급의약품 및 통신장비" 를 6pt 간격 두 기둥으로 (구급차 관리·운용 안내 제5판 31쪽 꼴)
    const outer = [..."구급차의의료장비·"].map((ch, k) => item(ch, 441, 400 - k * 7, 6, 6))
    const inner = [..."구급의약품및통신장비"].map((ch, k) => item(ch, 433, 400 - k * 7, 6, 6))
    const lines: ClusterItem[] = []
    for (let k = 0; k < 6; k++) lines.push(item(`본문 문장 ${k + 1} 줄은 쪽 오른끝 가까이까지 이어진다`, 70, 404 - k * 12, 330, 10))
    assert.equal(sideTabGlyphs([...outer, ...inner, ...lines]).size, outer.length + inner.length)
    assert.deepEqual(detectClusterTables([...outer, ...inner, ...lines], 1), [])
  })

  it("표의 번호 열(줄마다 다른 칸과 같은 줄)은 탭이 아니다", () => {
    const rows: ClusterItem[] = []
    for (let k = 0; k < 8; k++) {
      rows.push(item(String(k + 1), 50, 400 - k * 20, 7), item(`항목${k + 1}`, 120, 400 - k * 20), item(`${(k + 1) * 100}`, 300, 400 - k * 20))
    }
    assert.equal(sideTabGlyphs(rows).size, 0)
    assert.ok(detectClusterTables(rows, 1).length > 0)
  })
})

describe("detectClusterTables — 낱말마다 찍은 고정폭 글줄", () => {
  /** 고정폭 10pt(글자 5pt) 글줄을 낱말 아이템으로 — 낱말 사이 빈칸 하나(5pt) */
  function wordLine(text: string, x: number, y: number): ClusterItem[] {
    const out: ClusterItem[] = []
    for (const w of text.split(" ")) { out.push(item(w, x, y, w.length * 5, 10)); x += (w.length + 1) * 5 }
    return out
  }

  it("표 위 산문 줄은 낱말 시작이 열 x 에 걸려도 표 행이 아니다", () => {
    // HWP 3.x 한컴 PDF 기술 교재 꼴 — 무괘선 경로 표(빈칸 여럿으로 띄운 열) 위에 들여 쓴 설명 줄
    const items: ClusterItem[] = [
      ...wordLine("- in.routed is invoked at boot time by the inetinit script. It is used to", 40, 480),
      ...wordLine("update routing tables. On routers, by default, it broadcasts the routes", 50, 465),
      ...wordLine("#in.routed -q", 40, 450),
      ...wordLine("To start in.routed in quiet mode with the -q option to keep from it.", 70, 435),
      ...wordLine("#in.routed -s", 40, 420),
      ...wordLine("To make an non-router broadcast as if it were a router", 70, 405),
    ]
    const table = [["Destination", "Gateway", "Flags", "Ref", "Use"], ["localhost", "localhost", "UH", "0", "2272"],
      ["192.9.50.1.0", "chesapeake", "U", "3", "562"], ["195.200.200.0", "yogi-r", "UG", "10", "1562"]]
    table.forEach((row, r) => row.forEach((t, c) => items.push(item(t, [40, 120, 200, 240, 280][c], 300 - r * 15, t.length * 5, 10))))
    const found = detectClusterTables(items, 1)
    assert.equal(found.length, 1)
    assert.ok(found[0].table.cells.flat().every(cell => !/routed|router/.test(cell.text)))
  })

  it("머리 행 표 아래 산문 줄도 표 영역을 잇지 않는다", () => {
    // HWP 3.x 기술 교재 "기정 변수명 설 명" 표 — 머리 행 경로 영역이 아래 절 본문 줄까지 먹었다
    const items: ClusterItem[] = [item("변수명", 40, 500, 30, 10), item("설", 160, 500, 5, 10), item("명", 240, 500, 5, 10)]
    ;[["path", "명령어 검색 경로 directory명의 list"], ["home", "HOME DIR.의 절대 경로명"], ["shell", "default c-shell은 shell을"], ["cwd", "사용자의 현재 사용 directory"]]
      .forEach(([k, v], r) => items.push(item(k, 40, 485 - r * 15, k.length * 5, 10), ...wordLine(v, 160, 485 - r * 15)))
    items.push(...wordLine("15. shell 변수의 특성", 40, 410),
      ...wordLine("① shell script에서 정의되어 생성된 변수는 shell script가 수행되는 동안만 존재하므로 명령어", 50, 395),
      ...wordLine("입력 line에서 대화식으로 참조하거나 다른 shell script에서 사용할 수 없다.", 60, 380),
      ...wordLine("② terminal에서 keyboard 입력으로 변수를 설정한 경우 shell script내에서 대화식으로 사용한", 50, 365))
    const found = detectClusterTables(items, 1)
    assert.equal(found.length, 1)
    assert.ok(found[0].table.cells.flat().every(cell => !/terminal|대화식/.test(cell.text)))
  })

  it("비례 글꼴 머리 행(낱말 틈과 열 틈이 다름)은 낱말 줄이 아니다", () => {
    // ODL 117 꼴: "Saccharometer DI Water Glucose Solution Yeast Suspension" — 열 틈 6pt·낱말 틈 3pt
    const head = [["Saccharometer", 40, 70], ["DI", 116, 12], ["Water", 131, 30], ["Glucose", 200, 40], ["Solution", 243, 45], ["Yeast", 300, 30], ["Suspension", 333, 55]]
      .map(([t, x, w]) => item(t as string, x as number, 400, w as number, 12))
    const body = [1, 2, 3, 4].flatMap(r => [item(String(r), 40, 400 - r * 18, 6), item("12 ml", 116, 400 - r * 18, 30), item("12 ml", 200, 400 - r * 18, 30), item("4 ml", 300, 400 - r * 18, 25)])
    const found = detectClusterTables([...head, ...body], 1)
    assert.equal(found.length, 1)
    assert.ok(found[0].table.cells[0].some(cell => /Saccharometer/.test(cell.text)))
  })
})

describe("detectClusterTables — 글머리 ◎ 목차 (OCR)", () => {
  // 머리 행 "Ⅰ. 일반현황 5" 의 열 사이에 글머리 ◎ 가 서고, 부서명은 같은 칸 폭에 균등배분(다섯 자·세 자)
  const spread = (word: string, y: number) => {
    const chars = [...word], step = (339 - 13 - 158) / (chars.length - 1)
    return chars.map((c, k) => ({ ...item(c, Math.round(158 + k * step), y, 13, 15) }))
  }
  const rowsOf = (names: string[]) => names.flatMap((n, r) => [item("◎", 122, 569 - r * 22, 13, 14), ...spread(n, 569 - r * 22), item(String(19 + r * 20), 503, 569 - r * 22, 17, 13)])
  const toc = [item("Ⅰ.", 100, 667, 17, 15), item("일반현황", 140, 667, 77, 15), item("5", 511, 667, 9, 15), ...rowsOf(["기획예산실", "관광정책실", "총무과", "민원봉사과", "재무과"])]
  const texts = () => detectClusterTables(toc, 1)[0].table.cells.map(row => row.map(c => c.text.trim()).filter(Boolean).join(" "))
  it("◎ 가 부서명 앞 칸에 남는다", () => {
    assert.equal(texts()[1], "◎ 기획예산실 19")
  })
  it("넓게 벌린 세 자 부서명은 같은 폭 균등배분 낱말로 합쳐 제 행에 남는다", () => {
    assert.deepEqual(texts().slice(3), ["◎ 총무과 59", "◎ 민원봉사과 79", "◎ 재무과 99"])
  })
})
