/**
 * 서울 방침서 앞장 — 사전 검토항목 점검표·목차 (표지는 gen-frame-seoul buildReportCover).
 *
 * 사전 검토항목 점검표 — 시장방침 결재문서(bench/corpus-gen/seoul-bangchim) 16건 모두 표지 다음 쪽에 든 고정 서식.
 *
 * 16건 모두 같은 틀: 19×5 w48518, 열 5781/30517/3130/3130/5960, 주황 #FFA500 괘선·#E5E5E5 이름칸, 맑은 고딕
 * (옛 판 2건만 축제·행사 문항이 없는 18×5). 문항 글과 줄마다 맞춘 자간·장평·행 높이는 서식 원본
 * 「청년취업사관학교 2.0」 추진계획(34906816) 그대로 옮긴다 — 작성자가 고치지 않는 서식이라 계산하지 않는다.
 * 첫 행 제목 배너는 원본이 그림(주황 그라데이션 + 체크 아이콘 + "사전 검토항목")이라 같은 색 2색 그라데이션 칸 + 글로 대신한다.
 * 칸 표시: 원본은 작성자가 검토완료·해당없음 칸에 ■ 를 친다. 생성기는 호출자가 준 것만 친다(주지 않으면 빈 서식).
 */

import { tc, para } from "./gen-gongmun-extra.js"
import { fitOneLine } from "./fit-line.js"
import { escapeTextXml } from "./gen-ids.js"
import { ftbl, host, type FrameCtx } from "./gen-frame-seoul.js"
import type { BorderSide } from "./gen-ids.js"
import type { ResolvedGongmun } from "./gongmun.js"

const FONT = "맑은 고딕"
const ORANGE = "#FF9D19"
const BLUE = "#0000FF"
/** [글, 자간 %, 장평 %, 색, pt] — 생략 = 0·100·검정·10 */
type Run = [string, number?, number?, string?, number?]
/** indent2 — 둘째 문단(※ 줄·괄호 줄) 내어쓰기, 생략 0 */
interface Item { h: number; indent: number; indent2?: number; lineSp: number; paras: Run[][]; note?: Run }
interface Category { label: string; spacing: number; items: Item[] }

const O = (t: string): Run => [t, 4, 100, ORANGE]
/** 정책일반 문항 머리 " ◆ " (원본 자간 4·3) */
const HEAD1 = (gap = 4): Run[] => [[" ", 4], O("◆"), [" ", gap]]

const GROUPS: { title: string; h: number; cats: Category[] }[] = [
  {
    title: "1. 일반사항", h: 2553, cats: [{
      label: "정책일반", spacing: 0, items: [
        { h: 3914, indent: -2076, lineSp: 150, paras: [[...HEAD1(3), ["제반 법규와 실태, 실제 현장의 의견 등을 검토하였습니까?", -5, 85], ["(법령, 규칙, 통계·빅데이터, 시민의견 등)", 1, 85]]] },
        { h: 5031, indent: -2080, lineSp: 160, paras: [[...HEAD1(), ["정책(사업) 집행의 직·간접적 영향 및 효과성을 분석하였습니까?(갈등, 약자, 일자리, 안전, 탄소 감축 등)", -1, 95]], [["     ※ 약자 : 하단 세부 검토항목 점검", -13, 100, BLUE, 9]]] },
        { h: 3914, indent: -2080, lineSp: 150, paras: [[...HEAD1(), ["정책·계획·전시물·홍보물 등이 역사적 사실에 부합하는지 검토하였습니까?", 1, 90]]] },
        { h: 2431, indent: 0, lineSp: 150, paras: [[...HEAD1(), ["불필요한 외국어·외래어 표현 대신 바른 우리말을 사용하였습니까?", -2, 93]]] },
        { h: 2431, indent: 0, lineSp: 150, paras: [[...HEAD1(), ["정책·계획 등의 지속가능성을 검토하였습니까?(경제·사회·환경 등)", -1, 95]]] },
      ],
    }],
  },
  {
    title: "2. 약자와의 동행", h: 3380, cats: [
      {
        label: "목적", spacing: -6, items: [
          { h: 2431, indent: -2212, lineSp: 150, paras: [[O("◆ "), ["경제적으로 취약한 약자를 지원하기 위한 사업인가?", -4, 96]]] },
          { h: 3731, indent: -1544, lineSp: 150, paras: [[O("◆"), [" ", -8], ["주거, 생계, 의료, 교육, 기타 분야 중 어느 것에 해당하는가?", -11]]], note: ["주거/생계/의료/교육/기타", -14, 86] },
          { h: 4014, indent: -1568, indent2: -1568, lineSp: 150, paras: [[O("◆"), [" ", -4], ["단순지원 사업과 사다리지원 사업 중 어느 것에 해당하는가?", -9, 101]], [["   ", -16, 101], ["(단순 : 어려움 즉시 개선 / 사다리 : 계층 상향 또는 안정 유도)", -11, 101]]], note: ["단순지원/사다리지원"] },
          { h: 3914, indent: -1560, lineSp: 150, paras: [[O("◆ "), ["경제적으로 취약한 약자가 아니라 하더라도", -7], [", 다양한 분야의 사회적 약자를 배려할 수 있는 수단을 포함하였는가?", -4]]] },
        ],
      },
      {
        label: "계획수립", spacing: -6, items: [
          { h: 3914, indent: -1560, lineSp: 150, paras: [[O("◆ "), ["사업 대상자가 쉽고 편리하게 서비스를 활용할 수 있도록 사업을 구성하였는가?", -8]]] },
          { h: 4014, indent: -1560, lineSp: 160, paras: [[O("◆"), [" ", 4], ["축제‧행사계획에 약자 참여 기회 확대 및 약자 친화적 환경 조성 등 약자동행 관점을 반영하였는가?     ", -8], ["※ ", -13, 100, undefined, 9], ["축제·행사에 한함", -8]]] },
        ],
      },
      {
        label: "집행·홍보", spacing: -6, items: [
          { h: 3914, indent: -1560, lineSp: 150, paras: [[O("◆ "), ["집행과정에서 발생할 수 있는 역효과를 최소화하기 위한 대안을 고려하였는가?(‘약자’ 낙인효과, 역차별 등)", -5]]] },
          { h: 2431, indent: -1560, lineSp: 150, paras: [[O("◆ "), ["사업 대상자에게 적절한 홍보 수단을 채택하였는가?", -5]]] },
        ],
      },
      {
        label: "평가·환류", spacing: -6, items: [
          { h: 3914, indent: -1560, lineSp: 150, paras: [[O("◆ "), ["사업효과를 측정할 수 있는 지표(산출, 과정, 성과 등)는 마련하였는가?", -12], ["아닐 경우, 성과를 평가할 수 있는 대체·보완 수단이 존재하는가? ", -5]]] },
        ],
      },
    ],
  },
]

/** 문항 수 — 점검표 `na` 번호(1부터)의 상한 */
export const CHECKLIST_ITEMS = GROUPS.reduce((n, g) => n + g.cats.reduce((m, c) => m + c.items.length, 0), 0)

/** 문항별 표시(1부터): "done" 검토완료 ■, "na" 해당없음 ■, 없으면 두 칸 모두 □. 비고 없으면 원본 안내 글(7 주거/생계/…, 8 단순지원/사다리지원) */
type ChecklistInput = NonNullable<ResolvedGongmun["checklist"]>

const COLS = [5781, 30517, 3130, 3130, 5960]
const W = 48518
const LINE = (w: string, c: string): BorderSide => [w, c]
const OR01 = LINE("0.1 mm", "#FFA500"), OR07 = LINE("0.7 mm", "#FFA500"), OR10 = LINE("1.0 mm", "#FFA500"), OR025 = LINE("0.25 mm", "#FFA500")
const WH01 = LINE("0.1 mm", "#FFFFFF"), WH02 = LINE("0.2 mm", "#FFFFFF"), GOLD01 = LINE("0.1 mm", "#DE9E17")
const GRAY = "#E5E5E5", WHITE = "#FFFFFF"

export function buildSeoulChecklist(inp: ChecklistInput, ctx: FrameCtx): string {
  const { reg, bf } = ctx
  const runXml = (r: Run, bold = false) =>
    `<hp:run charPrIDRef="${reg.char({ font: FONT, pt: r[4] ?? 10, bold, spacing: r[1] ?? 0, ratio: r[2] ?? 100, ...(r[3] ? { color: r[3] } : {}) })}"><hp:t>${escapeTextXml(r[0])}</hp:t></hp:run>`
  const p = (runs: string, spec: Parameters<typeof reg.para>[0]) => `<hp:p paraPrIDRef="${reg.para(spec)}" styleIDRef="0">${runs}</hp:p>`
  const center = (lineSp = 160) => ({ align: "CENTER" as const, lineSp })
  const rows: string[] = []
  // 제목 배너 — 원본 그림의 위·아래 색(#FED12E → #FC8F00)
  const banner = bf.get({ t: "none", b: "none", l: "none", r: "none", fill: { gradient: ["#FED12E", "#FC8F00"], type: "LINEAR", angle: 90 } })
  rows.push(tc({ bf: banner, row: 0, col: 0, colSpan: 5, w: W, h: 3814, paras: p(runXml(["☑ 사전 검토항목", 0, 100, "#3A2A00", 20], true), center()) }))
  // 안내 줄
  const guide = [["☞ 해당사항이 있는 부분에 ‘ ", 0, 95, BLUE, 12], ["’ 표시하시기 바랍니다. ", 0, 95, BLUE, 12]] as Run[]
  const guideXml = runXml(guide[0]) + runXml(["■ ", -10, 85, undefined, 12], true) + runXml(guide[1])
    + `<hp:run charPrIDRef="${reg.char({ font: FONT, pt: 12, italic: true, spacing: -2, ratio: 90, color: BLUE })}"><hp:t>(</hp:t></hp:run>`
    + `<hp:run charPrIDRef="${reg.char({ font: FONT, pt: 12, italic: true, spacing: -2, ratio: 90, color: "#FF0000" })}"><hp:t>※ 비고 : 필요시 검토내용 기재</hp:t></hp:run>`
    + `<hp:run charPrIDRef="${reg.char({ font: FONT, pt: 12, italic: true, spacing: -2, ratio: 90, color: BLUE })}"><hp:t>)</hp:t></hp:run>`
  rows.push(tc({ bf: bf.get({ t: "none", b: OR10, l: "none", r: "none" }), row: 1, col: 0, colSpan: 5, w: W, h: 2382, paras: p(guideXml, { align: "LEFT", lineSp: 180 }) }))
  // 머리 행
  const hdr: [string, number, boolean, string | undefined, string, ReturnType<typeof bf.get>][] = [
    ["구 분", 11, true, ORANGE, "DISTRIBUTE", bf.get({ t: "none", r: WH01, b: OR07, l: "none", fill: GRAY })],
    ["사전 검토항목 점검 사항", 15, false, undefined, "CENTER", bf.get({ l: WH01, r: GOLD01, t: OR025, b: OR07, fill: WHITE })],
    ["검토완료", 12, false, undefined, "CENTER", bf.get({ l: GOLD01, r: GOLD01, t: "none", b: OR07, fill: WHITE })],
    ["해당없음", 12, false, undefined, "CENTER", bf.get({ l: GOLD01, r: GOLD01, t: "none", b: OR07, fill: WHITE })],
    ["비 고", 12, false, undefined, "CENTER", bf.get({ l: GOLD01, r: "none", t: "none", b: OR07, fill: WHITE })],
  ]
  rows.push(hdr.map(([t, pt, bold, color, align, b], c) => tc({
    bf: b, row: 2, col: c, w: COLS[c], h: 3142,
    paras: p(runXml([t, 0, 100, color, pt], bold), align === "DISTRIBUTE" ? { align: "DISTRIBUTE", left: 500, right: 500, lineSp: 160 } : center(c === 1 ? 160 : 110)),
  })).join(""))
  // 묶음 · 이름칸 · 문항
  let row = 3, no = 0
  const last = GROUPS.at(-1)!.cats.at(-1)!.items.at(-1)!
  for (const g of GROUPS) {
    rows.push(tc({ bf: bf.get({ t: WH02, b: OR01, l: "none", r: "none", fill: GRAY }), row, col: 0, colSpan: 5, w: W, h: g.h,
      paras: p(runXml([g.title, 0, 100, undefined, 14], true), { align: "LEFT", left: 500, right: 500, lineSp: 160 }) }))
    row++
    for (const cat of g.cats) {
      cat.items.forEach((it, k) => {
        no++
        const end = it === last
        const bottom = end ? OR10 : OR01
        const cells: string[] = []
        if (k === 0) {
          const h = cat.items.reduce((s, x) => s + x.h, 0)
          cells.push(tc({ bf: bf.get({ t: WH02, b: cat.items.at(-1) === last ? OR10 : WH02, l: "none", r: "none", fill: GRAY }), row, col: 0, rowSpan: cat.items.length, w: COLS[0], h,
            paras: p(runXml([cat.label, cat.spacing, 100, ORANGE, 11], true), { align: "DISTRIBUTE", left: 500, right: 500, lineSp: 160 }) }))
        }
        const q = it.paras.map((runs, i) => p(runs.map((r) => runXml(r)).join(""), { align: "LEFT", indent: i === 0 ? it.indent : it.indent2 ?? 0, lineSp: it.lineSp })).join("")
        cells.push(tc({ bf: bf.get({ t: OR01, b: bottom, l: "none", r: OR01, fill: WHITE }), row, col: 1, w: COLS[1], h: it.h, paras: q }))
        const mark = inp.marks.get(no)
        for (const [c, on] of [[2, mark === "done"], [3, mark === "na"]] as const) {
          cells.push(tc({ bf: bf.get({ t: OR01, b: bottom, l: OR01, r: OR01, fill: WHITE }), row, col: c, w: COLS[c], h: it.h,
            paras: p(on ? runXml(["■", -5, 80, undefined, 13]) : runXml(["□", 0, 100, undefined, 13]), center()) }))
        }
        const note: Run = inp.notes.has(no) ? [inp.notes.get(no)!] : it.note ?? [""]
        cells.push(tc({ bf: bf.get({ t: OR01, b: bottom, l: OR01, r: "none", fill: WHITE }), row, col: 4, w: COLS[4], h: it.h, paras: p(runXml(note), center()) }))
        rows.push(cells.join(""))
        row++
      })
    }
  }
  const h = 3814 + 2382 + 3142 + GROUPS.reduce((s, g) => s + g.h + g.cats.reduce((m, c) => m + c.items.reduce((a, x) => a + x.h, 0), 0), 0)
  return host(ftbl(rows, W, h, 5), reg.para({ align: "CENTER", lineSp: 100 }), reg.char({ font: FONT, pt: 10 }))
}

// ─── 목차 ───────────────────────────────────────────

/**
 * 목차 — 정본(34906816)·상암 재창조(35753992) 같은 틀: "목    차" HY헤드라인M 29 기울임(왼쪽 3000·위 5000·줄간격 70%) +
 * 3열 표 w47450 [번호 3650 | 제목 39336 밑줄 0.12 | 쪽 4464 오른쪽·아래 0.12], 항목 사이 빈 행.
 * 번호 로마 숫자는 HY견명조 20 굵게 "Ⅰ." + 제목 HY헤드라인M 18 양쪽(로마 번호 목차 4건 중 3), 그 밖(1·가)은 번호·제목 HY견고딕 18 +
 * 제목 왼쪽(비로마 번호 목차 3건 중 2). 목차 있는 7건 모두 쪽번호를 적었지만
 * 쪽은 조판 전에 알 수 없어 칸만 둔다(업무보고 목차와 같은 방침) — 한글에서 조판 뒤 채운다.
 */
/** 목차 쪽 칸 이름 — 조판 뒤 생성기(fillTocPages)가 이 칸에 쪽 번호를 넣는다. 장 행 다음 붙임 행 차례로 0부터 */
export const TOC_PAGE_CELL = "__kordoc_tocpage_"

/**
 * 목차 — "목    차" + 장마다 번호·제목·쪽 칸, 붙임 줄은 장 아래 같은 표에(서울시 보고서 양식 목차: 붙임 행 높이 3196,
 * 「붙임   1. …」 한컴돋움 15 굵게·이어지는 붙임은 7칸 들여 맞춤, 쪽 HY견고딕 17, 밑줄은 마지막 붙임 행만)
 */
export function buildBangchimToc(chapters: { label: string; title: string }[], ctx: FrameCtx, attach: string[] = []): string[] {
  const { reg, bf } = ctx
  const cols = [3650, 39336, 4464], w = 47450
  const thin: BorderSide = ["0.12 mm", "#000000"]
  const none = bf.get({ t: "none", b: "none", l: "none", r: "none" })
  const under = bf.get({ t: "none", b: thin, l: "none", r: "none" })
  const pageBox = bf.get({ t: "none", b: thin, l: "none", r: thin })
  const pageSide = bf.get({ t: "none", b: "none", l: "none", r: thin })
  const pCenter = (lineSp: number) => reg.para({ align: "CENTER", lineSp })
  const blank = reg.char({ font: "HY헤드라인M", pt: 10 })
  const spacer = (row: number, h: number) => cols.map((cw, c) => tc({ bf: none, row, col: c, w: cw, h, paras: para("", pCenter(160), blank) })).join("")
  const rows: string[] = [spacer(0, 1729)]
  let h = 1729
  chapters.forEach((ch, i) => {
    if (i > 0) { rows.push(spacer(rows.length, 3112)); h += 3112 }
    const roman = /^[Ⅰ-Ⅻ]+$/u.test(ch.label)
    const cNum = roman ? reg.char({ font: "HY견명조", pt: 20, bold: true }) : reg.char({ font: "HY견고딕", pt: 18 })
    const titleFont = roman ? "HY헤드라인M" : "HY견고딕"
    const fit = fitOneLine(ch.title, titleFont, 18, cols[1] - 400, 15)
    const cTitle = reg.char({ font: titleFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
    const row = rows.length
    rows.push(tc({ bf: none, row, col: 0, w: cols[0], h: 5859, paras: para(roman ? `${ch.label}.` : ch.label, pCenter(roman ? 150 : 160), cNum) })
      + tc({ bf: under, row, col: 1, w: cols[1], h: 5859, paras: para(ch.title, reg.para({ align: roman ? "JUSTIFY" : "LEFT", lineSp: 160 }), cTitle) })
      + tc({ bf: pageBox, row, col: 2, w: cols[2], h: 5859, paras: para("", pCenter(160), reg.char({ font: "HY견고딕", pt: 18 })), name: `${TOC_PAGE_CELL}${i}` }))
    h += 5859
  })
  if (attach.length) {
    rows.push(spacer(rows.length, 3112)); h += 3112
    const cAttach = reg.char({ font: "한컴돋움", pt: 15, bold: true }), cPage = reg.char({ font: "HY견고딕", pt: 17 })
    attach.forEach((line, k) => {
      const row = rows.length, last = k === attach.length - 1
      const body = line.replace(/\s+끝\.?\s*$/, "")
      const text = k === 0 ? body.replace(/^\s*붙\s*임\s*[:：]?\s*/, "붙임   ") : `       ${body.trim()}`
      rows.push(tc({ bf: none, row, col: 0, w: cols[0], h: 3196, paras: para("", pCenter(160), blank) })
        + tc({ bf: last ? under : none, row, col: 1, w: cols[1], h: 3196, paras: para(text, reg.para({ align: "LEFT", lineSp: 160 }), cAttach) })
        + tc({ bf: last ? pageBox : pageSide, row, col: 2, w: cols[2], h: 3196, paras: para("", pCenter(160), cPage), name: `${TOC_PAGE_CELL}${chapters.length + k}` }))
      h += 3196
    })
  }
  const head = para("목    차", reg.para({ align: "JUSTIFY", left: 3000, before: 5000, lineSp: 70 }), reg.char({ font: "HY헤드라인M", pt: 29, italic: true }))
  return [head, host(ftbl(rows, w, h, 3), reg.para({ align: "CENTER", lineSp: 100 }), blank)]
}
