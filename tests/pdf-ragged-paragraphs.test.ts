import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { bodyLineJoins, type WrapLine } from "../src/pdf/line-wrap.js"
import { extractPageBlocksFallback } from "../src/pdf/page-blocks.js"

const line = (text: string, left: number, right: number, y: number): WrapLine =>
  ({ text, left, right, y, fontSize: 10 })

const paragraphs = (lines: WrapLine[]) => extractPageBlocksFallback(lines.map(l => ({
  text: l.text, x: l.left, y: l.y, w: l.right - l.left, h: l.fontSize, fontSize: l.fontSize, fontName: "Test",
})), 1, false, false).map(b => b.text)

describe("bodyLineJoins — 짧은 문단과 공백 없는 글자 단위 꺾임", () => {
  it("짧은 문단을 더해도 양쪽 정렬 문단의 끝줄을 잇지 않는다", () => {
    // Chromium A4 인쇄 실측: Arial 10pt, line-height 1.2, 폭 300pt, justify, p margin 0 / text-indent 1em.
    // 찬 줄 2개 + 끝줄 3개. 끝줄을 정렬 판정의 분모로 세면 3문단이 한 문단으로 합쳐졌다.
    const lines = [
      line("We utilize these datasets as benchmarks for evaluation and", 80, 371, 762),
      line("report the average scores for six tasks in the appendix, e.g., H6.", 70, 353, 750),
      line("Model merging. Model merging methods can boost model", 80, 370, 738),
      line("performance without further training or additional data collection.", 70, 354, 726),
      line("Results were satisfactory.", 80, 193, 714),
    ]
    const expected = [lines[0].text + " " + lines[1].text, lines[2].text + " " + lines[3].text, lines[4].text]
    assert.deepEqual(bodyLineJoins(lines), [" ", "\n", " ", "\n"])
    assert.deepEqual(paragraphs(lines), expected)
    // 마지막 줄 하나만 빼는 보정으로는 부족하다 — 짧은 독립 문단이 여럿이어도 같다.
    const notes = [line("A short note.", 80, 138, 702), line("A final note.", 80, 134, 690)]
    assert.deepEqual(paragraphs([...lines, ...notes]), [...expected, ...notes.map(l => l.text)])
  })

  it("일본어 PDF 실측 줄의 단어 내부에 공백을 넣지 않는다", () => {
    // Chromium A4 인쇄 실측: IPAPGothic 10pt, line-height 1.2, 폭 240pt, left, p margin 0.
    const lines = [
      line("本契約は著作権者と出版社との間で締結されるものであ", 70, 307, 762),
      line("り、著作権者は出版社に対して次の権利を許諾するものと", 70, 309, 750),
      line("する。出版社は本契約に定める条件に従って著作物を利", 70, 303, 738),
      line("用できるものとし、著作物の利用状況について毎年報告", 70, 301, 726),
      line("書を作成する。報告書は著作権者に対して遅滞なく送付", 70, 302, 714),
      line("するものとし、契約の終了後も必要な記録を保存しなけれ", 70, 308, 702),
      line("ばならない。", 70, 121, 690),
    ]
    assert.equal(paragraphs(lines).join(""), lines.map(l => l.text).join(""))
  })

  for (const [language, text] of [
    ["일본어", ["著作権者は出版社との間で契約を締結す", "るものとし契約条件に従って利用でき", "る著作物の種類と範囲について定め", "るものとする。"]],
    ["중국어", ["著作权人与出版社之间签订合同并确认权", "利范围以及双方应当遵守的所有合同条", "款出版社应当定期向著作权人报告使", "用情况。"]],
  ] as const) {
    it(`${language}의 들쭉날쭉한 글자 단위 꺾임은 공백 없이 잇는다`, () => {
      const lines = [line(text[0], 70, 263, 700), line(text[1], 70, 266, 688), line(text[2], 70, 270, 676), line(text[3], 70, 130, 664)]
      assert.deepEqual(bodyLineJoins(lines), ["", "", ""])
      assert.deepEqual(paragraphs(lines), [text.join("")])
    })

    it(`${language}의 다음 글자가 들어갈 자리가 있으면 다음 줄 전체를 어절로 보아 잇지 않는다`, () => {
      const lines = [line(text[0], 70, 200, 700), line(text[1], 70, 240, 688), line(text[2], 70, 270, 676), line(text[3], 70, 130, 664)]
      assert.equal(bodyLineJoins(lines)[0], "\n")
    })
  }
})

describe("bodyLineJoins — 표시 서식과 무관한 줄 경계", () => {
  const cjk = [
    line("著作権者は出版社との間で契約を締結す", 70, 263, 700),
    line("るものとし契約条件に従って利用でき", 70, 266, 688),
    line("る著作物の種類と範囲について定め", 70, 270, 676),
    line("るものとする。", 70, 130, 664),
  ]
  const numbered = [
    line("5 사용 원자재 또는 기계장치", 70, 223, 700),
    line("5.1 채취용기(1.5L 유리병)", 90, 229, 681),
    line("5.2 배수용 물통", 90, 176, 662),
  ]
  for (const [name, format] of [
    ["밑줄", (text: string) => "<u>" + text + "</u>"],
    ["취소선", (text: string) => "~~" + text + "~~"],
  ] as const) {
    it(name + " 중·일문도 동일한 공백 없는 줄 경계를 유지한다", () => {
      const formatted = cjk.map(l => ({ ...l, text: format(l.text) }))
      assert.deepEqual(bodyLineJoins(formatted), bodyLineJoins(cjk))
      assert.deepEqual(paragraphs(formatted), [formatted.map(l => l.text).join("")])
    })
    it(name + " 다단계 번호도 새 항목으로 유지한다", () => {
      assert.deepEqual(bodyLineJoins(numbered.map(l => ({ ...l, text: format(l.text) }))), bodyLineJoins(numbered))
    })
  }
})

describe("bodyLineJoins — 중·일문 들여 쓴 첫 줄", () => {
  it("들여 쓴 첫 줄이 찬 줄이고 다음 줄이 왼쪽 여백에서 시작하면 넓은 줄 간격이어도 잇는다", () => {
    const a: WrapLine = { text: "上述著作物（以下称“本著作物”）的著作权人（Proprietor） ，与海外", left: 92, right: 523, y: 379, fontSize: 11 }
    const b: WrapLine = { text: "出版社(Publisher) 对本著作物授权事宜达成如下协议：", left: 72, right: 439, y: 351, fontSize: 11 }
    assert.deepEqual(bodyLineJoins([a, b]), [""])
    // 쪽 바닥 각주(작은 글자·번호 표지)는 잇지 않는다
    const note: WrapLine = { text: "1 この契約書のモデルは、韓国出版社または著者権", left: 57, right: 300, y: 347, fontSize: 9 }
    const end: WrapLine = { text: "なお、出版物の具体的な仕様については別途規定するものと", left: 68, right: 538, y: 379, fontSize: 10 }
    assert.deepEqual(bodyLineJoins([end, note]), ["\n"])
  })
})
