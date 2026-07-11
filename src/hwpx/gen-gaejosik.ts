/**
 * 개조식 보고서 전용 XML 조립 — 표지·목차·장 헤더 표 (gen-section에서 사용).
 * 스타일 값·기하는 실측 상수(gaejosik.ts), id 매핑은 gen-ids.ts.
 */

import { type ResolvedGongmun } from "./gongmun.js"
import { TOC_GEOM, formatGaejosikDate, gaejosikSizes, coverGeom, chapterGeom, tocBannerGeom, bodyTitleGeom, COVER_GEOM } from "./gaejosik.js"
import { simulateWrap } from "./text-metrics.js"
import {
  GONGMUN_CENTER, PARA_NORMAL, CHAR_NORMAL,
  GJ_CHAR_CHAPTER_NUM, GJ_CHAR_CHAPTER_TITLE, GJ_CHAR_COVER_TITLE, GJ_CHAR_COVER_SUB,
  GJ_CHAR_TOC_LABEL, GJ_CHAR_TOC_ROMAN, GJ_CHAR_TOC_ITEM, GJ_CHAR_BAR, GJ_CHAR_BODY_TITLE,
  GJ_PARA_COVER, GJ_PARA_TOC_ITEM, GJ_PARA_CHAPTER, GJ_PARA_BAR,
  GJ_BF_CHAPTER_NUM, GJ_BF_CHAPTER_GAP, GJ_BF_CHAPTER_TITLE,
  GJ_BF_BAR_DARK, GJ_BF_BAR_LIGHT, GJ_BF_TOC_BOX, GJ_BF_TOC_STRIPE,
  escapeXml,
} from "./gen-ids.js"

// ─── 공통 조각 ──────────────────────────────────────

/** 장 로마숫자 — 정본 단일 문자 Ⅰ~Ⅻ(U+2160~), 초과 시 조합 */
export function chapterRoman(n: number): string {
  if (n >= 1 && n <= 12) return String.fromCodePoint(0x215f + n)
  const t: [number, string][] = [[10, "Ⅹ"], [9, "Ⅸ"], [5, "Ⅴ"], [4, "Ⅳ"], [1, "Ⅰ"]]
  let s = ""
  for (const [v, r] of t) while (n >= v) { s += r; n -= v }
  return s
}

function emptyPara(paraPrId: number = PARA_NORMAL, pageBreak = false, charPrId: number = CHAR_NORMAL): string {
  const brk = pageBreak ? ` pageBreak="1"` : ""
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"${brk}><hp:run charPrIDRef="${charPrId}"><hp:t></hp:t></hp:run></hp:p>`
}

let gjTableId = 9_200_000
function cell(opts: {
  bf: number; col: number; w: number; h: number
  row?: number; colSpan?: number; paras?: string; vertAlign?: string
}): string {
  const paras = opts.paras ?? emptyPara()
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${opts.bf}">`
    + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${opts.vertAlign ?? "CENTER"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras}</hp:subList>`
    + `<hp:cellAddr colAddr="${opts.col}" rowAddr="${opts.row ?? 0}"/>`
    + `<hp:cellSpan colSpan="${opts.colSpan ?? 1}" rowSpan="1"/>`
    + `<hp:cellSz width="${opts.w}" height="${opts.h}"/>`
    + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
    + `</hp:tc>`
}

function table(rows: string[], w: number, h: number, cols: number, tblBf: number = 1): string {
  // 본문폭급 표(표지·본문 제목박스 48180)는 outMargin 좌우 0 — 실측(t2): 283을 주면
  // treatAsChar 진행폭이 컬럼폭을 넘어 좌우 1mm씩 밀려 우측 여백을 침범한다 (GAP-01 잔여).
  // 실물도 48180 표지 표 2개만 0, 좁은 표(배너·목차박스·장헤더)는 283.
  const outLR = w + 566 > 48000 ? 0 : 283
  return `<hp:tbl id="${++gjTableId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${tblBf}" noAdjust="1">`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="${outLR}" right="${outLR}" top="283" bottom="283"/>`
    + `<hp:inMargin left="141" right="141" top="141" bottom="141"/>`
    + rows.map((r) => `<hp:tr>${r}</hp:tr>`).join("")
    + `</hp:tbl>`
}

// ─── 표지 ───────────────────────────────────────────

/**
 * 표지 페이지 문단들 — 파랑 장식 바(상: 긴 진파랑+짧은 연파랑 / 하: 반전) 사이
 * 제목 30pt, 아래에 날짜·기관명 25pt (실측 양식 구조 재현).
 */
export function buildGaejosikCover(title: string, gongmun: ResolvedGongmun): string[] {
  // 제목칸 높이는 coverTitle 크기에 비례 스케일 (A3 기하연동)
  const g = coverGeom(gongmun.bodyHeight, gongmun.sizes)
  // 긴 제목 자동 축소 — 30pt로 2줄을 넘으면(꼬리 한두 글자 3줄행 방지) 25pt로.
  // 실측 관행: 원본 양식도 제목 1줄 30pt / 길면 25pt (report-template 역분석과 일치)
  const sz = gaejosikSizes(gongmun.bodyHeight, gongmun.sizes)
  const innerW = g.totalW - 282 // 셀 좌우 마진 제외
  const titleCharPr = simulateWrap(title, innerW, innerW, sz.coverTitle, 100, "keep").lines > 2
    ? GJ_CHAR_COVER_SUB
    : GJ_CHAR_COVER_TITLE
  const titlePara = `<hp:p paraPrIDRef="${GJ_PARA_COVER}" styleIDRef="0"><hp:run charPrIDRef="${titleCharPr}"><hp:t>${escapeXml(title)}</hp:t></hp:run></hp:p>`
  // 장식 바 셀 빈 문단 — 전용 소형 charPr(6pt)·저줄간격 paraPr. 기본(15pt·160%)이면
  // 줄높이가 바 높이 818을 넘어 한컴이 행을 3배로 확장한다 (실측 원본도 전용 소형 charPr 사용)
  const barEmpty = emptyPara(GJ_PARA_BAR, false, GJ_CHAR_BAR)
  // 실측 양식과 동일한 3열 그리드 + colSpan 배열 — 행별 셀 폭이 달라도 열 정합 유지
  // (열폭: 10466 / 27753 / 9961 → 상단 바 = 열0+1, 하단 연한 바 = 열1+2)
  const topRow = cell({ bf: GJ_BF_BAR_DARK, col: 0, colSpan: 2, row: 0, w: g.topDarkW, h: g.barH, paras: barEmpty })
    + cell({ bf: GJ_BF_BAR_LIGHT, col: 2, row: 0, w: g.topLightW, h: g.barH, paras: barEmpty })
  const titleRow = cell({ bf: 1, col: 0, colSpan: 3, row: 1, w: g.totalW, h: g.titleH, paras: titlePara })
  const botRow = cell({ bf: GJ_BF_BAR_DARK, col: 0, row: 2, w: g.botDarkW, h: g.botBarH, paras: barEmpty })
    + cell({ bf: GJ_BF_BAR_LIGHT, col: 1, colSpan: 2, row: 2, w: g.botLightW, h: g.botBarH, paras: barEmpty })
  const tbl = table([topRow, titleRow, botRow], g.totalW, g.barH + g.titleH + g.botBarH, 3)
  const host = `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${tbl}</hp:run></hp:p>`
  const date = gongmun.cover?.date ?? formatGaejosikDate(new Date())
  const org = gongmun.cover?.org ?? ""
  const sub = (t: string) =>
    `<hp:p paraPrIDRef="${GJ_PARA_COVER}" styleIDRef="0"><hp:run charPrIDRef="${GJ_CHAR_COVER_SUB}"><hp:t>${escapeXml(t)}</hp:t></hp:run></hp:p>`
  // 실측 양식 수직 배치: 빈 5 → 제목 표 → 빈 5 → 날짜 → 빈 4(25pt 행) → 기관명
  // (날짜~기관명 사이 빈 문단은 원본이 25pt charPr — 본문 빈 줄보다 간격이 넓다)
  const subEmpty = emptyPara(GJ_PARA_COVER, false, GJ_CHAR_COVER_SUB)
  return [
    ...Array(5).fill(emptyPara()),
    host,
    ...Array(5).fill(emptyPara()),
    sub(date),
    ...(org ? [...Array(4).fill(subEmpty), sub(org)] : []),
  ]
}

// ─── 목차 ───────────────────────────────────────────

/**
 * "목  차" 장식 배너 — 실측(GT3 표②) 1×7 스트라이프 표:
 * 네이비(#193AAA) | 무 | 라벤더(#E0E5FA) | 라벨 | 라벤더 | 무 | 네이비,
 * 열폭 [565,565,1414,13191,1414,565,565] 좌우 대칭, 표 외곽 0.12mm 검정.
 */
function buildTocBanner(gongmun: ResolvedGongmun): string {
  const g = tocBannerGeom(gongmun.bodyHeight, gongmun.sizes)
  const bfs = [GJ_BF_BAR_DARK, 1, GJ_BF_TOC_STRIPE, 1, GJ_BF_TOC_STRIPE, 1, GJ_BF_BAR_DARK]
  const filler = emptyPara(GJ_PARA_BAR, false, GJ_CHAR_BAR)
  const label = `<hp:p paraPrIDRef="${GONGMUN_CENTER}" styleIDRef="0"><hp:run charPrIDRef="${GJ_CHAR_TOC_LABEL}"><hp:t>목  차</hp:t></hp:run></hp:p>`
  const row = g.colWs.map((w, c) =>
    cell({ bf: bfs[c], col: c, w, h: g.h, paras: c === 3 ? label : filler }),
  ).join("")
  const banner = table([row], g.colWs.reduce((a, b) => a + b, 0), g.h, 7, 2)
  // 호스트 저줄간격(GJ_PARA_BAR 70%) — 160% 줄간격이 표 줄높이에 곱해져
  // 배너+박스가 한 페이지를 넘는 문제 방지 (실렌더 확인)
  return `<hp:p paraPrIDRef="${GJ_PARA_BAR}" styleIDRef="0" pageBreak="1"><hp:run charPrIDRef="${CHAR_NORMAL}">${banner}</hp:run></hp:p>`
}

/** 목차 페이지 문단들 — 스트라이프 배너 라벨 + 보라 테두리 박스 안 Ⅰ Ⅱ Ⅲ… 항목 */
export function buildGaejosikToc(chapters: string[], gongmun: ResolvedGongmun): string[] {
  const label = buildTocBanner(gongmun)
  const items = chapters.map((title, i) =>
    `<hp:p paraPrIDRef="${GJ_PARA_TOC_ITEM}" styleIDRef="0">`
    + `<hp:run charPrIDRef="${GJ_CHAR_TOC_ROMAN}"><hp:t>${chapterRoman(i + 1)}</hp:t></hp:run>`
    + `<hp:run charPrIDRef="${GJ_CHAR_TOC_ITEM}"><hp:t>. ${escapeXml(title)}</hp:t></hp:run>`
    + `</hp:p>`,
  ).join("")
  // 실측: 박스 셀 수직 CENTER — 항목 블록이 고정 높이 박스 안에서 가운데 배치
  const box = table(
    [cell({ bf: GJ_BF_TOC_BOX, col: 0, w: TOC_GEOM.boxW, h: TOC_GEOM.boxH, paras: items })],
    TOC_GEOM.boxW, TOC_GEOM.boxH, 1,
  )
  // 박스 호스트·간격 문단도 저줄간격 — 배너와 같은 페이지 유지 (실렌더 확인)
  const host = `<hp:p paraPrIDRef="${GJ_PARA_BAR}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${box}</hp:run></hp:p>`
  return [label, emptyPara(GJ_PARA_BAR, false, GJ_CHAR_BAR), host]
}

// ─── 본문 첫 페이지 제목 박스 (B6) ────────────────────

/**
 * 본문 첫 페이지 제목 반복 박스 — 실측(GT3 표④): 표지 표①의 축소판 3×3
 * (투톤 바 600 + 제목칸 3566 + 투톤 바 600), 제목 HY헤드라인M 22pt.
 * 목차 뒤·첫 장 앞에 배치. 실무(GT12)는 실제 문서 제목을 넣는다.
 */
export function buildGaejosikBodyTitle(title: string, gongmun: ResolvedGongmun): string {
  const g = COVER_GEOM
  const bt = bodyTitleGeom(gongmun.bodyHeight, gongmun.sizes)
  const barEmpty = emptyPara(GJ_PARA_BAR, false, GJ_CHAR_BAR)
  const titlePara = `<hp:p paraPrIDRef="${GONGMUN_CENTER}" styleIDRef="0"><hp:run charPrIDRef="${GJ_CHAR_BODY_TITLE}"><hp:t>${escapeXml(title)}</hp:t></hp:run></hp:p>`
  const topRow = cell({ bf: GJ_BF_BAR_DARK, col: 0, colSpan: 2, row: 0, w: g.topDarkW, h: bt.barH, paras: barEmpty })
    + cell({ bf: GJ_BF_BAR_LIGHT, col: 2, row: 0, w: g.topLightW, h: bt.barH, paras: barEmpty })
  const titleRow = cell({ bf: 1, col: 0, colSpan: 3, row: 1, w: g.totalW, h: bt.titleH, paras: titlePara })
  const botRow = cell({ bf: GJ_BF_BAR_DARK, col: 0, row: 2, w: g.botDarkW, h: bt.barH, paras: barEmpty })
    + cell({ bf: GJ_BF_BAR_LIGHT, col: 1, colSpan: 2, row: 2, w: g.botLightW, h: bt.barH, paras: barEmpty })
  const box = table([topRow, titleRow, botRow], g.totalW, bt.barH * 2 + bt.titleH, 3)
  return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${box}</hp:run></hp:p>`
}

// ─── 장 헤더 표 ─────────────────────────────────────

/**
 * 장 헤더 — [Ⅰ(흰 글자·파랑 음영)] [간격(좌선)] [제 목(회색 상하선·연회색 음영)]
 * 1×3 표, 실측 기하. n은 1-based 장 번호.
 */
export function buildGaejosikChapter(n: number, title: string, gongmun?: ResolvedGongmun): string {
  // 행높이는 chapter 크기에 비례 스케일 (A3 기하연동), 폭은 실측 고정
  const g = gongmun ? chapterGeom(gongmun.bodyHeight, gongmun.sizes) : chapterGeom(1500)
  const numPara = `<hp:p paraPrIDRef="${GONGMUN_CENTER}" styleIDRef="0"><hp:run charPrIDRef="${GJ_CHAR_CHAPTER_NUM}"><hp:t>${chapterRoman(n)}</hp:t></hp:run></hp:p>`
  const titlePara = `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${GJ_CHAR_CHAPTER_TITLE}"><hp:t> ${escapeXml(title)}</hp:t></hp:run></hp:p>`
  const row = cell({ bf: GJ_BF_CHAPTER_NUM, col: 0, w: g.numW, h: g.rowH, paras: numPara })
    + cell({ bf: GJ_BF_CHAPTER_GAP, col: 1, w: g.gapW, h: g.rowH })
    + cell({ bf: GJ_BF_CHAPTER_TITLE, col: 2, w: g.titleW, h: g.rowH, paras: titlePara })
  const tbl = table([row], g.numW + g.gapW + g.titleW, g.rowH, 3)
  return `<hp:p paraPrIDRef="${GJ_PARA_CHAPTER}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${tbl}</hp:run></hp:p>`
}
