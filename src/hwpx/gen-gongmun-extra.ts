/**
 * 공문서 부속 요소 XML 조립 — 결재란·"끝." 표시·1페이지형 제목박스.
 *
 * 실측 근거:
 *   결재란 — GT12 「발행 계획안」 결재선(주무관 라벨 + 서명 공란, 외곽 0.4mm·내부 0.12mm,
 *            굴림체 10pt CENTER, 전 셀 vAlign CENTER)의 간이형. 문서 최상단 우측 배치 관행.
 *   제목박스 — GT2/GT6/GT7 공통 3단(색상 바 #0080C0 + 제목 HY헤드라인M + gradient 바
 *            #0080C0→#3CBFFF RADIAL, 외곽 0.12mm). 1페이지 계획·요약보고서 서두 골격.
 *   "끝." — 행정업무규정(본문 끝 2타+"끝.") + GT12 실측(단독 문단).
 */

import { type ResolvedGongmun } from "./gongmun.js"
import { PARA_NORMAL, CHAR_NORMAL, CHAR_BOLD, GONGMUN_RIGHT, GONGMUN_TBL_CENTER, escapeXml } from "./gen-ids.js"
import { TableBfRegistry } from "./gen-table-bf.js"

let extraTableId = 9_300_000

export function tbl(rows: string[], w: number, h: number, cols: number): string {
  return `<hp:tbl id="${++extraTableId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="1" noAdjust="1">`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="283" right="283" top="283" bottom="283"/>`
    + `<hp:inMargin left="141" right="141" top="141" bottom="141"/>`
    + rows.map((r) => `<hp:tr>${r}</hp:tr>`).join("")
    + `</hp:tbl>`
}

export function tc(opts: { bf: number; row: number; col: number; w: number; h: number; colSpan?: number; paras: string }): string {
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${opts.bf}">`
    + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${opts.paras}</hp:subList>`
    + `<hp:cellAddr colAddr="${opts.col}" rowAddr="${opts.row}"/>`
    + `<hp:cellSpan colSpan="${opts.colSpan ?? 1}" rowSpan="1"/>`
    + `<hp:cellSz width="${opts.w}" height="${opts.h}"/>`
    + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
    + `</hp:tc>`
}

export function para(text: string, paraPrId: number, charPrId: number): string {
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
}

// ─── 결재란 (B5) ────────────────────────────────────

/** 결재란 칸 폭 — 25mm(실무 서명칸 관행) */
const APPROVAL_COL_W = 7085
/** 라벨 행·서명 행 높이 */
const APPROVAL_LABEL_H = 1100
const APPROVAL_SIGN_H = 4200

/**
 * 간이 결재란 — 직위 라벨 행 + 서명 공란 행 (2×N). 호스트 문단 RIGHT 정렬.
 * 실측(GT12 결재선)의 간이형: 외곽 0.4mm·내부 0.12mm, 라벨 CENTER.
 */
export function buildApprovalTable(labels: string[], gongmun: ResolvedGongmun, reg: TableBfRegistry): string {
  const n = labels.length
  const w = APPROVAL_COL_W * n
  const bfAt = (row: number, col: number) =>
    reg.get({
      t: row === 0 ? "thick" : "thin",
      b: row === 1 ? "thick" : "thin",
      l: col === 0 ? "thick" : "thin",
      r: col === n - 1 ? "thick" : "thin",
    })
  const labelRow = labels.map((label, c) =>
    tc({ bf: bfAt(0, c), row: 0, col: c, w: APPROVAL_COL_W, h: APPROVAL_LABEL_H, paras: para(label, GONGMUN_TBL_CENTER, CHAR_NORMAL) }),
  ).join("")
  const signRow = labels.map((_, c) =>
    tc({ bf: bfAt(1, c), row: 1, col: c, w: APPROVAL_COL_W, h: APPROVAL_SIGN_H, paras: para("", GONGMUN_TBL_CENTER, CHAR_NORMAL) }),
  ).join("")
  const table = tbl([labelRow, signRow], w, APPROVAL_LABEL_H + APPROVAL_SIGN_H, n)
  return `<hp:p paraPrIDRef="${GONGMUN_RIGHT}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${table}</hp:run></hp:p>`
}

// ─── "끝." 표시 (B11) ────────────────────────────────

/** 본문이 이미 "끝."으로 마감되었는지 — 중복 방지 */
export function hasEndMark(lastText: string): boolean {
  return /끝\s*\.?\s*$/.test(lastText.trim())
}

/** "끝." 문단 — 규정(2타 공백 후 "끝.") 반영, 단독 문단(실측 GT12 변형) */
export function buildEndMark(): string {
  return para("  끝.", PARA_NORMAL, CHAR_NORMAL)
}

// ─── 1페이지형 제목박스 (G04 — report/plan/notice 서두) ──

/** 제목박스 기하 — 실측 GT6/GT7: 바 h382, 전체폭 47907(본문폭 −280여) */
const TITLE_BOX = { barH: 382, titleH: 2850, color: "#0080C0", gradient: ["#0080C0", "#3CBFFF"] as [string, string] }

/**
 * 색상 바 + 제목 + gradient 바 3단 제목박스 — GT2/GT6/GT7 공통 서두 골격.
 * 제목 문단은 CENTER, 헤딩 h1 charPr(호출부 전달)로 렌더.
 */
export function buildTitleBox(title: string, titleCharPr: number, bodyWidth: number, reg: TableBfRegistry): string {
  const w = bodyWidth - 280
  const outer = { t: "thin", b: "thin", l: "thin", r: "thin" } as const
  const barTop = reg.get({ ...outer, fill: TITLE_BOX.color })
  const barBottom = reg.get({ ...outer, fill: { gradient: TITLE_BOX.gradient } })
  const mid = reg.get(outer)
  // 바 셀 빈 문단 — 1pt 극소 스페이서(실측: GT6/GT7 함초롬바탕 1pt 빈런, TBL-12).
  // 전용 charPr 없이 CHAR_BOLD 아닌 CHAR_NORMAL을 쓰되 행높이는 셀 h로 강제된다.
  const barPara = `<hp:p paraPrIDRef="${GONGMUN_TBL_CENTER}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}"><hp:t></hp:t></hp:run></hp:p>`
  const rows = [
    tc({ bf: barTop, row: 0, col: 0, w, h: TITLE_BOX.barH, paras: barPara }),
    tc({ bf: mid, row: 1, col: 0, w, h: TITLE_BOX.titleH, paras: para(title, GONGMUN_TBL_CENTER, titleCharPr) }),
    tc({ bf: barBottom, row: 2, col: 0, w, h: TITLE_BOX.barH, paras: barPara }),
  ]
  const table = tbl(rows, w, TITLE_BOX.barH * 2 + TITLE_BOX.titleH, 1)
  return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${table}</hp:run></hp:p>`
}
