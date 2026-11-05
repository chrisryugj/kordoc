import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeUndersegmentedTable } from "../src/pdf/undersegmented.js"
import type { TextItem } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number): TextItem => ({
  text, x, y, w: 35, h: 8, fontSize: 8, fontName: "test",
})

describe("PDF 표의 긴 본문 행 복원", () => {
  it("3행 표의 머리글과 첫 자료 행은 보존하고 선 없는 본문만 줄별 행으로 나눈다", () => {
    const columns = [0, 100, 200, 300]
    const original = [
      [{ text: "연도" }, { text: "2025년\n(A)" }, { text: "2026년\n(B)" }],
      [{ text: "전국" }, { text: "100" }, { text: "110" }],
      [{ text: "서울\n부산\n대구\n인천\n광주\n대전\n울산\n세종" }, { text: "1\n2\n3\n4\n5\n6\n7\n8" }, { text: "11\n12\n13\n14\n15\n16\n17\n18" }],
    ]
    const body = Array.from({ length: 8 }, (_, i) => [
      item(`지역${i}`, 10, 140 - i * 15),
      item(String(i + 1), 110, 140 - i * 15),
      item(String(i + 11), 210, 140 - i * 15),
    ]).flat()
    const kept = new Map<number, number>()
    const result = normalizeUndersegmentedTable(original, columns, body, [200, 180, 160, 20], kept)
    assert.equal(result?.length, 10)
    // 그대로 둔 행만 새 행 번호 → 원래 행 번호로 알린다(호출측이 칸 합침을 잇는다)
    assert.deepEqual([...kept], [[0, 0], [1, 1]])
    assert.deepEqual(result?.slice(0, 2), original.slice(0, 2).map(row => row.map(cell => cell.text)))
    assert.deepEqual(result?.[2], ["지역0", "1", "11"])
    assert.deepEqual(result?.[9], ["지역7", "8", "18"])
  })

  it("5행 표의 여러 긴 본문 칸을 각각 복원하고 사이의 지역 행은 보존한다", () => {
    const columns = [0, 100, 200, 300]
    const original = [
      [{ text: "지역" }, { text: "2025" }, { text: "2026" }],
      [{ text: "강원" }, { text: "20" }, { text: "21" }],
      [{ text: "춘천\n원주\n강릉\n홍천\n횡성\n철원\n양구\n고성" }, { text: "1\n2\n3\n4\n5\n6\n7\n8" }, { text: "2\n3\n4\n5\n6\n7\n8\n9" }],
      [{ text: "충북" }, { text: "30" }, { text: "31" }],
      [{ text: "청주\n충주\n제천\n보은\n옥천\n영동\n진천\n괴산" }, { text: "9\n10\n11\n12\n13\n14\n15\n16" }, { text: "10\n11\n12\n13\n14\n15\n16\n17" }],
    ]
    const body = [2, 4].flatMap((r, group) => Array.from({ length: 8 }, (_, i) => [
      item(`지역${group}-${i}`, 10, (r === 2 ? 365 : 175) - i * 15),
      item(String(i + 1), 110, (r === 2 ? 365 : 175) - i * 15),
      item(String(i + 11), 210, (r === 2 ? 365 : 175) - i * 15),
    ]).flat())
    const result = normalizeUndersegmentedTable(original, columns, body, [500, 470, 450, 230, 210, 20])
    assert.equal(result?.length, 19)
    assert.deepEqual(result?.[1], ["강원", "20", "21"])
    assert.deepEqual(result?.[10], ["충북", "30", "31"])
    assert.deepEqual(result?.at(-1), ["지역1-7", "8", "18"])
  })
})

describe("가로선 없이 쌓은 하위 행", () => {
  const ocr = (text: string, x: number, y: number, h: number): TextItem => ({ text, x, y, w: 35, h, fontSize: h, fontName: "ocr" })
  // OCR 예산표: 줄 상자(14~20)가 줄 간격(13)보다 커 띠로는 한 행에 뭉친다 — 열마다 세 줄, k 번째 줄 높이가 맞는다
  const lines = [["예산지출(a)", "57,549", "66,657", "15.6"], ["·일반회계", "51,469", "59,082", "14.7"], ["·특별회계", "6,080", "7,576", "24.6"]]
  const cols = [0, 100, 200, 300, 400]

  it("글 든 열 셋 이상이 같은 줄 수(셋+)로 높이가 맞으면 줄마다 행으로 나눈다", () => {
    const items = lines.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 160 - i * 13 + (c === 3 && i === 1 ? -3 : 0), c === 3 ? 8 : 16)))
    const rebuilt = normalizeUndersegmentedTable([[{ text: "" }, { text: "" }, { text: "" }, { text: "" }]], cols, items)
    assert.deepEqual(rebuilt, lines)
  })

  it("한 칸에서 꺾인 긴 글(다른 열은 한 줄)은 나누지 않는다", () => {
    const items = [ocr("가나다라", 5, 160, 10), ocr("마바사아", 5, 147, 10), ocr("자차카타", 5, 134, 10), ocr("100", 105, 147, 10), ocr("200", 205, 147, 10), ocr("300", 305, 147, 10)]
    assert.equal(normalizeUndersegmentedTable([[{ text: "" }, { text: "" }, { text: "" }, { text: "" }]], cols, items), null)
  })
})

describe("행 합침 칸이 덮은 유령 행 묶음", () => {
  const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: 35, h: 10, fontSize: 10, fontName: "ocr" })
  const cols = [0, 100, 200, 300]
  // 머리 행 아래 묶음 하나가 격자 행 셋(유령 경계)에 걸친 행 합침 칸 — 두 줄("2020 예산"·"2021 예산")이 칸마다 쌓였다(관보 계속비)
  const original = [
    [{ text: "사업" }, { text: "총액" }, { text: "2020" }],
    [{ text: "2020 예산\n2021 예산", rowSpan: 3 }, { text: "2,480\n2,483", rowSpan: 3 }, { text: "96\n97", rowSpan: 3 }],
    [{ text: "" }, { text: "" }, { text: "" }],
    [{ text: "" }, { text: "" }, { text: "" }],
  ]
  const items = [["2020 예산", "2,480", "96"], ["2021 예산", "2,483", "97"]].flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 150 - i * 30)))

  it("묶음 높이 전체의 글로 두 줄도 행으로 나눈다", () => {
    const rebuilt = normalizeUndersegmentedTable(original, cols, items, [200, 180, 140, 120, 100])
    assert.deepEqual(rebuilt, [["사업", "총액", "2020"], ["2020 예산", "2,480", "96"], ["2021 예산", "2,483", "97"]])
  })
})

describe("줄 수가 다른 열의 하위 행 (OCR)", () => {
  const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: 60, h: 10, fontSize: 10, fontName: "ocr" })
  const cols = [0, 150, 250, 350]
  // 대차대조표: 이름표 열은 다섯 줄, 금액 열은 그 가운데 네 줄에만 값
  const labels = ["Ⅱ.비유동자산", "1.투자자산", "2.유형자산", "3.무형자산", "4.기타자산"]
  const items = [...labels.map((t, i) => ocr(t, 5, 150 - i * 14)), ...["9,174,154", "445,324", "12,866", "6,604"].map((t, i) => ocr(t, 155, 150 - (i + 1) * 14))]

  it("puts each value on the label line it stands beside", () => {
    const rebuilt = normalizeUndersegmentedTable([[{ text: "" }, { text: "" }, { text: "" }]], cols, items)
    assert.deepEqual(rebuilt, [["Ⅱ.비유동자산", "", ""], ["1.투자자산", "9,174,154", ""], ["2.유형자산", "445,324", ""], ["3.무형자산", "12,866", ""], ["4.기타자산", "6,604", ""]])
  })

  it("does not apply to text-layer items", () => {
    const text = items.map(it => ({ ...it, fontName: "Batang" }))
    assert.equal(normalizeUndersegmentedTable([[{ text: "" }, { text: "" }, { text: "" }]], cols, text), null)
  })
})

describe("세로쓰기 이름표와 값·증감률 두 줄 열 (OCR)", () => {
  const ocr = (text: string, x: number, y: number, h = 10): TextItem => ({ text, x, y, w: text.length > 1 ? 40 : 10, h, fontSize: h, fontName: "ocr" })
  const cols = [0, 40, 140, 240, 340]
  // 가축 마릿수: 세로쓰기 "산/란/계"(줄이 행과 안 맞음) | 하위 이름표 셋 | 값 셋 | 증감·(증감률) 여섯 줄
  const labels = ["3개월미만", "3~6개월미만", "6개월이상"], values = ["10,786", "9,473", "52,353"]
  const items = [
    ...["산", "란", "계"].map((t, i) => ocr(t, 15, 140 - i * 22)),
    ...labels.map((t, i) => ocr(t, 45, 150 - i * 30)),
    ...values.map((t, i) => ocr(t, 145, 150 - i * 30)),
    ...["1,216", "(11.6)", "1,000", "(12.3)", "-2,487", "(-4.2)"].map((t, i) => ocr(t, 245, 150 - i * 15)),
  ]
  const row = (first: string) => [[{ text: first }, { text: labels.join("\n") }, { text: values.join("\n") }, { text: "…" }]]

  it("splits rows on the value lines and puts the vertical label on the first", () => {
    assert.deepEqual(normalizeUndersegmentedTable(row("산란계"), cols, items), [
      ["산란계", "3개월미만", "10,786", "1,216"], ["", "", "", "(11.6)"],
      ["", "3~6개월미만", "9,473", "1,000"], ["", "", "", "(12.3)"],
      ["", "6개월이상", "52,353", "-2,487"], ["", "", "", "(-4.2)"],
    ])
  })

  it("leaves the vertical label to the spanning cell above when its own cell was empty", () => {
    assert.equal(normalizeUndersegmentedTable(row(""), cols, items)?.[0][0], "")
  })
})

describe("한 열만 가로선 조각으로 갈린 묶음 (OCR)", () => {
  const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: 35, h: 10, fontSize: 10, fontName: "ocr" })
  const cols = [0, 100, 200, 300]
  // 본문 넉 줄 — 0·1열은 두 격자 행에 걸친 칸, 2열만 가로선 조각에 둘로 갈렸다(연령별 혼인건수 2015 열)
  const lines = [["19세 이하", "0.9", "1.0"], ["20-24세", "9.4", "9.6"], ["25-29세", "78.5", "67.1"], ["30-34세", "132.5", "121.2"]]
  const items = lines.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 170 - i * 20)))
  const original = [
    [{ text: "연령" }, { text: "2013" }, { text: "2015" }],
    [{ text: "계" }, { text: "322.8" }, { text: "302.8" }],
    [{ text: lines.map(r => r[0]).join("\n"), rowSpan: 2 }, { text: lines.map(r => r[1]).join("\n"), rowSpan: 2 }, { text: "1.0\n9.6\n67.1" }],
    [{ text: "" }, { text: "" }, { text: "121.2" }],
  ]

  it("rebuilds the whole band line by line", () => {
    const rebuilt = normalizeUndersegmentedTable(original, cols, items, [220, 200, 185, 115, 90], undefined, 40)
    assert.deepEqual(rebuilt?.slice(2), lines)
  })
})

describe("두 줄 숫자 하위 행 (OCR)", () => {
  const ocr = (text: string, x: number, y: number, font = "ocr"): TextItem => ({ text, x, y, w: 40, h: 10, fontSize: 10, fontName: font })
  const cols = [0, 100, 200, 300]
  const rows = [["’00-’10년", "1.1", "1.3 -1.0"], ["’10-’21년", "0.7", "0.7 -0.1"]]
  const items = rows.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 150 - i * 16)))
  const cell = [[{ text: "’00-’10년\n’10-’21년" }, { text: "1.1\n0.7" }, { text: "1.3 -1.0\n0.7 -0.1" }]]

  it("splits two stacked lines when every column after the label holds numbers", () => {
    assert.deepEqual(normalizeUndersegmentedTable(cell, cols, items), rows)
  })

  it("keeps two stacked text lines together", () => {
    const words = [["정원", "현원", "비고"], ["기획", "운영", "기타"]].flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 150 - i * 16)))
    assert.equal(normalizeUndersegmentedTable(cell, cols, words), null)
  })
})

describe("펼친 행의 한 자리 수 열과 걸친 칸 글 (OCR)", () => {
  const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: text.length * 8, h: 10, fontSize: 10, fontName: "ocr" })
  const cols = [0, 100, 200, 300, 400]

  it("keeps a column of single digits as values, not a vertical label", () => {
    const rows = [["계", "174", "7", "5"], ["남자", "81", "5", "5"]]
    const items = rows.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 5, 150 - i * 16)))
    const cell = [[{ text: "계\n남자" }, { text: "174\n81" }, { text: "7\n5" }, { text: "5\n5" }]]
    assert.deepEqual(normalizeUndersegmentedTable(cell, cols, items), rows)
  })

  it("keeps the text of a cell spanning more rows than the rebuilt band", () => {
    // "2023년" 이 여섯 행에 걸쳐 글 중심이 이 행 띠 밖에 있다
    const lines = [["60~64세", "1,773", "73"], ["(구성비)", "(100.0)", "(4.1)"]]
    const items = lines.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c + 1] + 5, 150 - i * 16)))
    const original = [
      [{ text: "연도" }, { text: "연령" }, { text: "계" }, { text: "기초" }],
      [{ text: "2023년", rowSpan: 6 }, { text: "60~64세\n(구성비)" }, { text: "1,773\n(100.0)" }, { text: "73\n(4.1)" }],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
    ]
    const rebuilt = normalizeUndersegmentedTable(original, cols, items, [200, 170, 140, 120, 100], undefined, 40)
    assert.deepEqual(rebuilt?.slice(1, 3), [["2023년", ...lines[0]], ["", ...lines[1]]])
  })

  it("does not restore a column-spanning label whose lines landed in the next column", () => {
    // 두 열에 걸친 이름표 칸 글이 걸친 둘째 열로 펼쳐졌다(가축동향 "가구당 마릿수(마리) / - 산란계 / - 육용계")
    const lines = [["가구당 마릿수", "62,348", "100"], ["- 산란계", "76,757", "247"], ["- 육용계", "59,093", "-214"]]
    const items = lines.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c + 1] + 5, 160 - i * 16)))
    const original = [
      [{ text: "구분", colSpan: 2 }, { text: "" }, { text: "계" }, { text: "증감" }],
      [{ text: "가구당 마릿수\n- 산란계\n- 육용계", colSpan: 2 }, { text: "" }, { text: "62,348\n76,757\n59,093" }, { text: "100\n247\n-214" }],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
    ]
    const rebuilt = normalizeUndersegmentedTable(original, cols, items, [200, 170, 110, 100, 90], undefined, 40)
    assert.deepEqual(rebuilt?.slice(1, 4), lines.map(l => ["", ...l]))
  })
})

describe("부푼 OCR 상자의 행 띠 (OCR)", () => {
  // 지역 열 상자가 잉크 둘레 여백으로 부풀어(글자 10, 상자 30 — 값과 같은 글줄) 이웃 행 상자와 겹친다 — 겹침으로 띠를 묶으면 "서울부산…" 한 띠가 됐다
  const regions = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기"]
  const box = (text: string, x: number, y: number, h: number): TextItem => ({ text, x, y, w: 30, h, fontSize: 10, fontName: "ocr" })
  const items = regions.flatMap((t, i) => [box(t, 5, 300 - i * 16, 30), box(String(4000 + i), 105, 300 - i * 16, 10), box(String(5000 + i), 205, 300 - i * 16, 10)])
  const cell = [[{ text: "" }, { text: "" }, { text: "" }]]

  it("bands OCR rows by line centers, not by inflated box overlap", () => {
    const rebuilt = normalizeUndersegmentedTable(cell, [0, 100, 200, 300], items)
    assert.deepEqual(rebuilt?.map(r => r[0]), regions)
  })

  it("still joins a wrapped name line without numbers to its value line", () => {
    // "러시아" / "(연방) 6,492" — 꺾인 이름 윗줄은 수가 없어 겹침으로 값 줄과 한 띠다
    const y = 300 - 10 * 16
    const wrapped = [...items, box("러시아", 5, y + 7, 18), box("(연방)", 5, y - 5, 18), box("6,492", 105, y - 5, 10), box("7,120", 205, y - 5, 10)]
    const rebuilt = normalizeUndersegmentedTable(cell, [0, 100, 200, 300], wrapped)
    assert.deepEqual(rebuilt?.at(-1), ["러시아\n(연방)", "6,492", "7,120"])
  })
})

describe("줄 간격이 넓은 표에서 비켜 앉은 OCR 값", () => {
  it("assigns a value set off by more than half a glyph when lines are far apart", () => {
    const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: 40, h: 9, fontSize: 9, fontName: "ocr" })
    const labels = ["25만원미만", "25~50만원", "50~100만원", "100~200만원", "200만원이상"], values = ["9.2", "76.6", "14.2", "0.0", "-"]
    // 줄 간격 18, 글자 9 — "14.2" 만 5.5 비켜 앉았다
    const items = [...labels.map((t, i) => ocr(t, 5, 200 - i * 18)), ...values.map((t, i) => ocr(t, 105, 200 - i * 18 - (i === 2 ? 5.5 : 0))), ocr("구", 205, 190), ocr("성", 205, 170)]
    const rebuilt = normalizeUndersegmentedTable([[{ text: "" }, { text: "" }, { text: "" }]], [0, 100, 200, 300], items)
    assert.deepEqual(rebuilt?.map(r => r[1]), values)
  })
})

describe("OCR 숫자 열 하위 행의 줄 맞춤 허용치", () => {
  const ocr = (text: string, x: number, y: number): TextItem => ({ text, x, y, w: 15, h: 8, fontSize: 8, fontName: "ocr" })
  const cols = [0, 40, 60, 80, 100]
  const lines = [["2024.7월", "512", "98", "29"], ["8월", "511", "103", "30"], ["9월", "463", "91", "26"]]
  // 행 괘선 없이 한 격자 행에 쌓인 묶음 하나 (머리 행 아래 행마다 이 꼴로 부른다)
  const original = [[{ text: lines.map(l => l[0]).join("\n") }, { text: "" }, { text: "" }, { text: "" }]]

  it("줄 간격이 넓으면 글자 높이 반 넘게 비켜 앉은 숫자 상자도 같은 행이다 (시도별 전입 \"512\" 4.5px)", () => {
    const items = lines.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 2, 150 - i * 26 + (c === 1 ? 4.5 : 0))))
    assert.deepEqual(normalizeUndersegmentedTable(original, cols, items), lines)
  })
  it("줄 간격이 좁은 글 열은 종전 허용치 — 비켜 앉은 상자면 펼치지 않는다", () => {
    const words = [["가나", "다라", "마바", "사아"], ["자차", "카타", "파하", "거너"], ["더러", "머버", "서어", "저처"]]
    const items = words.flatMap((row, i) => row.map((t, c) => ocr(t, cols[c] + 2, 150 - i * 26 + (c === 1 ? 4.5 : 0))))
    assert.equal(normalizeUndersegmentedTable(original, cols, items), null)
  })
})

describe("OCR 묶음 첫 열의 글 이름표", () => {
  const ocr = (text: string, x: number, y: number, w = 30): TextItem => ({ text, x, y, w, h: 8, fontSize: 8, fontName: "ocr" })
  const cols = [0, 60, 140, 200]
  // "일반회계 / (국토해양부)" 가 묶음 높이 가운데에 놓여 첫 줄이 기준 줄(사업별 열) 위로 벗어났다(관보 계속비)
  const items = [
    ocr("일반회계", 5, 212, 40), ocr("(국토해양부)", 2, 195, 50),
    ocr("1. 울산신항북방파제", 62, 195, 70), ocr("- 2010 예산", 62, 177, 60), ocr("144,397,000", 142, 177, 50),
    ocr("- 2011 예산", 62, 160, 60), ocr("140,188,000", 142, 160, 50),
  ]
  it("기준 줄에 안 맞는 첫 열 글 이름표는 첫 하위 행에 두고 나머지 열을 펼친다", () => {
    assert.deepEqual(normalizeUndersegmentedTable([[{ text: "x" }, { text: "" }, { text: "" }]], cols, items), [
      ["일반회계 (국토해양부)", "1. 울산신항북방파제", ""], ["", "- 2010 예산", "144,397,000"], ["", "- 2011 예산", "140,188,000"],
    ])
  })
})
