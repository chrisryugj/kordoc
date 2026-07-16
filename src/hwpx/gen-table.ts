/**
 * HWPX 표 XML 생성 (generator.ts에서 분리) — GFM 그리드 표와
 * 병합(colspan/rowspan) HTML 표 경로.
 *
 * 열폭은 내용 실폭(text-metrics) 비례 배분 — 균등 1/n 분할 아님.
 * 공문서 모드는 실측 정부 양식 표 문법(헤더 음영·bold·하변 이중선, 외곽 0.4mm
 * 위계, 라벨열, 셀 CENTER 130%/LEFT, 축폭+우측 배치)을 적용한다 (style 인자).
 * 서식 프로필(#41, remap)이 표에 매칭되면 셀 좌표별 실측 서식(bf·charPr·행높이·열폭)이
 * 최우선 — 프로필 미매칭 셀만 기본/공문서 문법으로 채운다.
 */

import { parseHtmlTable, htmlCellInnerToLines, extractTopLevelTables, type HtmlRowInfo } from "../roundtrip/markdown-units.js"
import { MAX_COLS, MAX_ROWS } from "../table/builder.js"
import { clampSpan } from "./parser-shared.js"
import { CHAR_NORMAL, CHAR_BOLD, CHAR_TABLE_HEADER, PARA_NORMAL, escapeXml, type ResolvedTheme } from "./gen-ids.js"
import { generateRuns } from "./md-runs.js"
import { measureTextWidth } from "./text-metrics.js"
import { TableBfRegistry, dataCellSpec } from "./gen-table-bf.js"
import { takeProfile, normalizeAnchor, normalizeRowAnchor, type ProfileRemap, type TableRemap } from "./gen-profile.js"
import { DATA_TABLE_ID_BASE } from "./geometry.js"
import { ImageRegistry, splitImageRefs } from "./gen-image.js"

// 표 id 네임스페이스는 geometry.ts SSOT (v4.0.5 P0-3)
const TABLE_ID_BASE = DATA_TABLE_ID_BASE
let tableIdCounter = TABLE_ID_BASE
function nextTableId(): number { return ++tableIdCounter }
/** 문서 생성마다 표 id 카운터 리셋 — 같은 프로세스 연속 호출에도 결정적 출력 유지 */
export function resetTableIds(): void { tableIdCounter = TABLE_ID_BASE }

/** 공문서 표 스타일 — gen-section이 ResolvedGongmun에서 해석해 전달 */
export interface GongmunTableStyle {
  /** 표 전체 폭(HWPUNIT) — 본문 폭 맞춤 */
  totalWidth: number
  /** 셀 본문 charPr (개조식: 맑은 고딕 12pt) */
  charPr: number
  /** 셀 안 강조 charPr */
  boldCharPr: number
  /** 폭·행높이 측정용 글자 높이(charPr height) */
  charHeight: number
  /** 헤더행 음영 borderFill (#E6E6E6) — bfRegistry 부재 시 폴백 */
  headerBf: number
  /** 가운데정렬 paraPr */
  centerParaPr: number
  /** 표 셀 전용 paraPr — CENTER 130% (실측 GT1 표⑪). 미지정 시 centerParaPr */
  tblCenterParaPr?: number
  /** 표 셀 장문 열 paraPr — LEFT 130%. 미지정 시 PARA_NORMAL */
  tblLeftParaPr?: number
  /**
   * 표 테두리 위계 레지스트리 — 지정 시 실측 문법 적용:
   * 외곽 0.4mm / 내부 0.12mm / 헤더행 하변 DOUBLE_SLIM 0.5mm / 헤더 bold /
   * 라벨열 음영 / 축폭(본문폭 −1800) + 호스트 우측정렬 (gap_tables TBL-01~11)
   */
  bfRegistry?: TableBfRegistry
  /** 데이터 표 호스트 문단 paraPr(RIGHT) — bfRegistry와 함께 지정 */
  rightParaPr?: number
  /** 헤더행 음영색 (기본 #E6E6E6 — 실측 GT1·샘플양식1) */
  headerFill?: string
  /** 라벨열 음영색 (기본 #E7E7E7 — 실측 GT6/GT7 표3) */
  labelFill?: string
}

/** 실측 데이터 표 폭 여유 — GT6 46194·GT7 46372·GT11 46544 ≈ 본문폭 −1800 */
export const DATA_TABLE_INSET = 1800

// ─── 서식 프로필 매칭 헬퍼 (#41) ─────────────────────

/** 마크다운 셀 → 매칭 앵커. 이미지 참조는 원본 XML 텍스트에 없으므로 제거 후 정규화. */
function anchorOfMarkdownCell(cell: string): string {
  return normalizeAnchor(cell.replace(/!\[[^\]]*\]\([^)]*\)/g, ""))
}

/** HTML 셀 inner → 매칭 앵커. 중첩표 내용은 추출기 직속 텍스트 규칙에 맞춰 제외. */
function anchorOfHtmlCell(inner: string): string {
  const noNested = inner.replace(/<table[\s\S]*?<\/table>/gi, "")
  const { lines } = htmlCellInnerToLines(noNested)
  return normalizeAnchor(lines.join(""))
}

/** 프로필 열폭 — col_widths > width/cols. 없으면 null(호출부가 내용 비례 계산) */
function profileColWidths(tp: TableRemap | null, colCnt: number): number[] | null {
  if (!tp) return null
  if (tp.colWidths && tp.colWidths.length === colCnt) return tp.colWidths
  if (tp.width) return Array(colCnt).fill(Math.floor(tp.width / colCnt))
  return null
}

// ─── 열폭 계산 (내용 비례) ───────────────────────────

/** 셀 좌우 마진(141×2) + 조판 여유 */
// 셀 좌우 실패딩 = tbl inMargin 510×2(hasMargin=0이라 cellMargin 아닌 inMargin 적용)
// + 여유 180. 종전 582는 실패딩(1020)보다 작아 짧은 열("구분"·"단기")이 필요폭보다
// 좁게 배분돼 한 글자씩 세로로 갈라졌다 (v4.0.2 실렌더 QA 확인)
const CELL_PAD = 1200

/** 셀 텍스트 실폭 — 인라인 마크다운 부호·이미지 참조 제거, <br> 분리 후 최장 줄 기준 */
function cellContentWidth(text: string, charHeight: number): number {
  let max = 0
  for (const seg of text.replace(/!\[[^\]]*\]\([^)\s]+\)/g, "").replace(/\*\*|__|`/g, "").split(/<br\s*\/?>/i)) {
    const w = measureTextWidth(seg.trim(), charHeight, 100)
    if (w > max) max = w
  }
  return max
}

/** 셀 최장 '어절' 폭 — 열 하한의 기준. 이보다 좁으면 어절이 글자 단위로 세로 분해된다 */
function cellMinWordWidth(text: string, charHeight: number): number {
  let max = 0
  for (const seg of text.replace(/!\[[^\]]*\]\([^)\s]+\)/g, "").replace(/\*\*|__|`/g, "").split(/<br\s*\/?>/i)) {
    for (const word of seg.trim().split(/\s+/)) {
      const w = measureTextWidth(word, charHeight, 100)
      if (w > max) max = w
    }
  }
  return max
}

/**
 * 열폭 배분 — 짧은 열은 실폭 고정, 긴 열이 잔여를 내용폭 비례로 가져간다
 * (실제 공문서 표 관행: 라벨·수치 열은 한 줄에 딱 맞고 서술 열이 넓다).
 *
 * 1) 실폭(내용+패딩)이 균등분할분 이하인 열은 실폭으로 확정 — 수치 열이
 *    긴 서술 열에 밀려 "4,673"이 두 줄로 꺾이는 협착 방지 (실렌더 확인)
 * 2) 나머지 열은 잔여 폭을 내용폭 비례 배분. 최소폭(전체 6%) 보장·80% 캡.
 *    확정 열이 각자 균등분할분 이하만 가져가므로 잔여 ≥ 남은 열 수 × 균등분할분
 *    ≥ 남은 열 수 × minW — 음수 폭 불가 불변식 유지.
 */
export function computeColWidths(colMax: number[], totalWidth: number, colMinWord: number[] = []): number[] {
  const colCnt = colMax.length
  const minW = Math.min(Math.max(2000, Math.round(totalWidth * 0.06)), Math.floor(totalWidth / colCnt))
  const cap = Math.round(totalWidth * 0.8)
  const raw = colMax.map((w) => Math.min(Math.max(w + CELL_PAD, minW), cap))
  // 열 하한 = 최장 어절 폭 + 실패딩 — 이보다 좁으면 어절이 글자 단위로 세로 분해
  // ("구/분", "소요예/산" — v4.0.2 실렌더 QA). 어절 경계 줄바꿈은 허용.
  const floor = raw.map((r, i) => Math.min(Math.max(minW, (colMinWord[i] ?? 0) + CELL_PAD), r, cap))
  const widths = Array<number>(colCnt).fill(0)
  const free = new Set(raw.map((_, i) => i))
  let budget = totalWidth
  let sumFloorFree = floor.reduce((a, b) => a + b, 0)
  // 1) 짧은 열부터 실폭(×1.12 여유 — 측정은 함초롬 기준, 실제 셀 폰트가 더 넓을 수
  //    있음) 확정하고 최장 열(서술 열)만 유연하게 남긴다 — 실측 관행: 라벨·수치·날짜
  //    열은 한 줄에 딱 맞고 서술 열이 잔여를 흡수하며 줄바꿈. 종전 "균등분할분 이하만
  //    확정"은 "소요예산(백만원)"류 중간 폭 헤더가 비례 배분에 밀려 세로로 갈라지는
  //    결함. 남은 열들이 각자 하한을 못 받게 되면 확정 중단.
  for (const i of [...raw.keys()].sort((a, b) => raw[a] - raw[b])) {
    if (free.size <= 1) break
    const fixed = Math.round(raw[i] * 1.12)
    if (budget - fixed < sumFloorFree - floor[i]) break
    widths[i] = fixed; free.delete(i); budget -= fixed; sumFloorFree -= floor[i]
  }
  const sumFreeRaw = [...free].reduce((a, i) => a + raw[i], 0)
  if (budget > sumFreeRaw * 1.6) {
    // 전 열이 짧은 표(잔여 과잉) — 확정을 버리고 내용폭 비례로 전폭 배분
    // (마지막 한 열만 비대해지는 것 방지, 표 폭은 totalWidth 유지)
    const sumRaw = raw.reduce((a, b) => a + b, 0)
    // raw[i]는 measureTextWidth의 float — 다른 분기(round/floor)와 달리 정수화가 빠져
    // 소수 폭이 XML로 새면 HWPUNIT 정수 규약 위반·합 불변식 붕괴. round + 80% 캡 재적용.
    for (let i = 0; i < colCnt; i++) widths[i] = Math.min(cap, Math.round(raw[i]) + Math.floor((raw[i] / sumRaw) * (totalWidth - sumRaw)))
    free.clear()
  } else {
    // 2) 긴 열 비례 배분 — 하한(최장 어절) 미달 열은 하한 확정 후 재배분.
    //    잔여가 하한 합보다 작으면 하한 비례 축소(표 폭 불변식 유지)
    for (;;) {
      const sum = [...free].reduce((a, i) => a + raw[i], 0)
      const short = [...free].filter((i) => (raw[i] / sum) * budget < floor[i])
      if (short.length === 0) break
      const shortSum = short.reduce((a, i) => a + floor[i], 0)
      const scale = Math.min(1, (budget - (free.size - short.length) * minW) / shortSum)
      for (const i of short) { widths[i] = Math.max(minW, Math.floor(floor[i] * scale)); free.delete(i); budget -= widths[i] }
      if (free.size === 0) break
    }
    const sum = [...free].reduce((a, i) => a + raw[i], 0)
    for (const i of free) widths[i] = Math.floor((raw[i] / sum) * budget)
  }
  // 잔여 정산 — sum == totalWidth 불변식 (v4.0.5 P1-3: 음수 잔여도 정산).
  // 양수 잔여(내림 손실)는 내용폭 큰 열부터 1씩 — 단 80% 캡 초과 열은 건너뛴다
  // (전 열 캡 도달 시엔 합 불변식이 캡보다 우선). all-short 분기의 round 상향으로
  // sum > totalWidth가 되던 케이스는 음수 잔여 루프가 최광열부터 1씩 회수한다.
  let rem = totalWidth - widths.reduce((a, b) => a + b, 0)
  const order = [...raw.keys()].sort((a, b) => raw[b] - raw[a])
  for (let k = 0, skipped = 0; rem > 0; k = (k + 1) % colCnt, rem--) {
    // 캡 존중: colCnt회 연속 스킵이면 전 열 캡 — 그때만 캡 초과 허용
    while (widths[order[k]] >= cap && skipped < colCnt) { skipped++; k = (k + 1) % colCnt }
    skipped = 0
    widths[order[k]]++
  }
  for (let k = 0, spins = 0; rem < 0; k = (k + 1) % colCnt, rem++) {
    while (widths[order[k]] <= 1 && spins < colCnt) { spins++; k = (k + 1) % colCnt }
    if (widths[order[k]] <= 1) break // 전 열 1 이하(degenerate) — 더 회수 불가
    spins = 0
    widths[order[k]]--
  }
  return widths
}

/** 행 높이 추정 — 각 셀의 줄바꿈 수 시뮬레이션(최다 줄 기준) */
function estimateRowHeight(cells: string[], widths: number[], charHeight: number): number {
  let maxLines = 1
  cells.forEach((cell, c) => {
    const usable = Math.max((widths[c] ?? widths[widths.length - 1]) - CELL_PAD, 1000)
    let lines = 0
    for (const seg of cell.replace(/\*\*|__|`/g, "").split(/<br\s*\/?>/i)) {
      lines += Math.max(1, Math.ceil(measureTextWidth(seg.trim(), charHeight, 100) / usable))
    }
    if (lines > maxLines) maxLines = lines
  })
  return maxLines * Math.round(charHeight * 1.6) + 282
}

// ─── GFM 그리드 표 ──────────────────────────────────

export function generateTable(rows: string[][], theme: ResolvedTheme, style: GongmunTableStyle | null = null, remap: ProfileRemap | null = null, seq = 0, images: ImageRegistry | null = null): string {
  const rowCnt = rows.length
  const colCnt = Math.max(...rows.map(r => r.length), 1)
  const reg = style?.bfRegistry ?? null
  // 실측 모드: 데이터 표는 본문폭보다 좁게 + 호스트 우측정렬 (TBL-09)
  const totalW = style ? (reg ? style.totalWidth - DATA_TABLE_INSET : style.totalWidth) : 44000
  const measureH = style?.charHeight ?? 1000

  // 서식 프로필 매칭 (#41) — 매칭되면 셀 좌표별 실측 서식 최우선.
  // 첫 행 전체 지문(0.3.0)은 (0,0) 빈 셀일 때의 2순위 키 (이미지 참조는 앵커와 동일 규칙 제거)
  const rowAnchor = normalizeRowAnchor((rows[0] ?? []).map(c => c.replace(/!\[[^\]]*\]\([^)]*\)/g, "")))
  const prof = takeProfile(remap, rowCnt, colCnt, anchorOfMarkdownCell(rows[0]?.[0] ?? ""), seq, rowAnchor)

  // 열별 최대 내용폭 (헤더 포함 / 본문만) → 비례 열폭 + 짧은 열 가운데 정렬 판단
  const colMax = Array(colCnt).fill(0)
  const colMaxBody = Array(colCnt).fill(0)
  const colMinWord = Array(colCnt).fill(0)
  rows.forEach((row, r) => row.forEach((cell, c) => {
    const w = cellContentWidth(cell, measureH)
    if (w > colMax[c]) colMax[c] = w
    if (r > 0 && w > colMaxBody[c]) colMaxBody[c] = w
    const mw = cellMinWordWidth(cell, measureH)
    if (mw > colMinWord[c]) colMinWord[c] = mw
  }))
  const colWidths = profileColWidths(prof, colCnt) ?? computeColWidths(colMax, totalW, colMinWord)
  // 본문 셀이 전부 한 줄에 들어가는 열은 가운데 정렬 (숫자·라벨 열 관행)
  const colCentered = colWidths.map((w, c) => colMaxBody[c] + CELL_PAD <= w)
  // 라벨열 감지 — 2열 표에서 1열이 짧은 라벨이면 음영+bold (실측: GT6/GT7 표3 라벨|값 패턴)
  const labelCol0 = !!reg && colCnt === 2 && colCentered[0] && rows.every((r) => (r[0] ?? "").replace(/\*\*|__|`/g, "").length <= 12)

  const tblId = nextTableId()

  // theme.tableHeaderColor 또는 tableHeaderBold가 설정되면 첫 행 셀에 별도 charPr 사용
  // (공문서 style이 있으면 style이 우선 — charPr 9는 표 전용 폰트·크기와 어긋난다)
  const useHeaderStyle =
    !style && (theme.tableHeader !== theme.body || theme.tableHeaderBold)

  const mapId = style
    ? (id: number) => (id === CHAR_NORMAL ? style.charPr : id === CHAR_BOLD ? style.boldCharPr : id)
    : undefined

  const rowHeights = rows.map((row) => style ? estimateRowHeight(row, colWidths, measureH) : 1500)

  const trElements = rows.map((row, rowIdx) => {
    // 부족한 셀은 빈 문자열로 채워 colCnt 맞춤
    const cells: string[] = row.length < colCnt ? [...row, ...Array<string>(colCnt - row.length).fill("")] : row
    const isHeaderRow = rowIdx === 0
    const cellH = rowHeights[rowIdx]
    const baseCharPr = style ? style.charPr : CHAR_NORMAL
    const headerCharPr = isHeaderRow && useHeaderStyle ? CHAR_TABLE_HEADER : baseCharPr
    const tdElements = cells.map((cell, colIdx) => {
      const k = `${rowIdx},${colIdx}`
      const isLabelCell = labelCol0 && colIdx === 0
      // 헤더행·라벨열은 bold (실측: GT1 표⑪ 헤더 bold, GT6/GT7 라벨열 bold — TBL-05·06)
      const defaultCharPr = style
        ? (reg && (isHeaderRow || isLabelCell) ? style.boldCharPr : style.charPr)
        : (isHeaderRow ? headerCharPr : baseCharPr)
      const cellCharPr = prof?.cellChar.get(k) ?? defaultCharPr
      // 셀 문단 — 실측: 헤더·짧은 열 CENTER 130%, 장문 열 LEFT (JUSTIFY 아님, TBL-11)
      const centered = isHeaderRow || colCentered[colIdx]
      const paraPrId = style
        ? (centered ? (style.tblCenterParaPr ?? style.centerParaPr) : (reg ? (style.tblLeftParaPr ?? PARA_NORMAL) : PARA_NORMAL))
        : PARA_NORMAL
      // <br>은 kordoc GFM 셀 규약(파서가 셀 내 개행을 <br>로 방출) — 문단 분리로 복원.
      // 셀 안 이미지 참조는 placeholder <hp:pic>로 보존 (v4.0.5 — alt 텍스트 각인이
      // 이미지 열을 빈 열로 만들어 재파싱 후행 열 트림을 유발하던 결함)
      const p = cell.split(/<br\s*\/?>/i).map((seg) => {
        let picRuns = ""
        if (images) {
          const { text: rest, urls } = splitImageRefs(seg)
          if (urls.length > 0) {
            const pics = urls.map((u) => { const part = images.take(u); return part ? images.inlinePicXml(part) : null })
            if (pics.every(Boolean)) {
              seg = rest
              picRuns = `<hp:run charPrIDRef="${cellCharPr}">${pics.join("")}</hp:run>`
            }
          }
        }
        const runs = generateRuns(seg, cellCharPr, prof?.cellChar.has(k) ? undefined : mapId)
        const body = (runs || (picRuns ? "" : `<hp:run charPrIDRef="${cellCharPr}"><hp:t></hp:t></hp:run>`)) + picRuns
        return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${body}</hp:p>`
      }).join("")
      // 테두리 — 프로필 실측 최우선, 다음 위계 레지스트리(TBL-01·02), 폴백 기본
      const bf = prof?.cellBf.get(k)
        ?? (reg
          ? reg.get(dataCellSpec({
              row: rowIdx, rowEnd: rowIdx, col: colIdx, colEnd: colIdx,
              rowCnt, colCnt, headerRows: 1,
              fill: isHeaderRow ? (style!.headerFill ?? "#E6E6E6") : isLabelCell ? (style!.labelFill ?? "#E7E7E7") : undefined,
            }))
          : style && isHeaderRow ? style.headerBf : 2)
      const h = prof?.cellH.get(k) ?? cellH
      // <hp:tc> 필수 속성 + subList + cellAddr + cellSpan + cellSz + cellMargin
      return `<hp:tc name="" header="${isHeaderRow ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${bf}">`
        + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${style ? "CENTER" : "TOP"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p}</hp:subList>`
        + `<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`
        + `<hp:cellSpan colSpan="1" rowSpan="1"/>`
        + `<hp:cellSz width="${colWidths[colIdx]}" height="${h}"/>`
        + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
        + `</hp:tc>`
    }).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")

  const tblW = colWidths.reduce((a, b) => a + b, 0)
  const tblH = rowHeights.reduce((a, b) => a + b, 0)

  // <hp:tbl>에 필수 속성 + <hp:sz>/<hp:outMargin>/<hp:inMargin> (pos는 inline-level 기준)
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trElements

  // 공문서: 쪽 넘어가면 헤더행 반복 (repeatHeader)
  const tbl = `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="${style ? 1 : 0}" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">${tblInner}</hp:tbl>`

  // 실측 모드: 데이터 표 호스트 문단 RIGHT (실측: GT6/GT7/GT11 관행, TBL-09)
  const hostPr = reg && style?.rightParaPr !== undefined ? style.rightParaPr : 0
  return `<hp:p paraPrIDRef="${hostPr}" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
}

// ─── HTML 표 생성 (병합셀 colspan/rowspan + 중첩표 재귀) ───
//

// kordoc parse는 병합/중첩표를 <table><tr><th|td colspan rowspan>…</table> HTML로
// 내보낸다. 그 출력을 다시 HWPX로 만들 때 구조를 보존한다 — parse → 편집 →
// markdownToHwpx 라운드트립의 표 구멍을 막는 경로.

interface PlacedHtmlCell {
  r: number
  c: number
  colSpan: number
  rowSpan: number
  inner: string
  isHeader: boolean
}

/** HTML 행 목록 → 그리드 배치 (colspan/rowspan 점유 반영) */
function layoutHtmlRows(rows: HtmlRowInfo[]): { placed: PlacedHtmlCell[]; rowCnt: number; colCnt: number } {
  const occupied = new Set<string>()
  const placed: PlacedHtmlCell[] = []
  let colCnt = 0
  for (let r = 0; r < rows.length; r++) {
    let c = 0
    for (const cell of rows[r].cells) {
      while (occupied.has(`${r},${c}`)) c++
      // 파서 쪽(section-walker clampSpan)과 동일 한도 — 무클램프 시 거대 span이 점유 루프를 폭주시킨다
      const colSpan = clampSpan(cell.colSpan, MAX_COLS)
      const rowSpan = clampSpan(cell.rowSpan, MAX_ROWS)
      placed.push({ r, c, colSpan, rowSpan, inner: cell.inner, isHeader: rows[r].tag === "th" })
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr},${c + dc}`)
      }
      c += colSpan
      colCnt = Math.max(colCnt, c)
    }
  }
  // 격자 구멍 충전 (v4.0.5 P1-2) — colCnt보다 짧은 <tr>(rowspan 미커버)은 tc가 누락된
  // malformed 표가 된다(행 셀폭 합 ≠ tblW → 한컴 거부/오배치). GFM 경로의 빈 셀 패딩과
  // 대칭으로, 미점유 좌표를 빈 셀로 채워 "모든 행의 tc 폭 합 == tblW"를 보장한다.
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < colCnt; c++) {
      if (!occupied.has(`${r},${c}`)) {
        placed.push({ r, c, colSpan: 1, rowSpan: 1, inner: "", isHeader: rows[r].tag === "th" })
        occupied.add(`${r},${c}`)
      }
    }
  }
  placed.sort((a, b) => a.r - b.r || a.c - b.c)
  return { placed, rowCnt: rows.length, colCnt }
}

/** HTML 엔티티 복원 (sanitizeText 이스케이프의 역변환) — &amp;는 마지막에 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * HTML 표 원문 → <hp:tbl> XML. 병합셀은 cellSpan/cellAddr로, 셀 안 중첩표는
 * subList 안에 재귀 생성한다. 파싱 불가면 null (호출부가 문단 폴백).
 * @param totalWidth 표 전체 폭(HWPUNIT) — 중첩표는 부모 셀폭에 맞춰 축소
 */
export function generateHtmlTableXml(rawHtml: string, theme: ResolvedTheme, totalWidth: number = 44000, style: GongmunTableStyle | null = null, remap: ProfileRemap | null = null, seq = 0, images: ImageRegistry | null = null): string | null {
  const rows = parseHtmlTable(rawHtml)
  if (!rows || rows.length === 0) return null
  const { placed, rowCnt, colCnt } = layoutHtmlRows(rows)
  if (rowCnt === 0 || colCnt === 0) return null

  const measureH = style?.charHeight ?? 1000
  // 서식 프로필 매칭 (#41) — 첫 행 전체 지문(0.3.0)은 병합 셀의 시작 열 위치에 텍스트,
  // 커버 열은 빈 문자열 (추출기의 row0Texts 키 공간과 동일)
  const first = placed.find(p => p.r === 0 && p.c === 0) ?? placed[0]
  const row0 = Array.from({ length: colCnt }, () => "")
  for (const cell of placed) {
    if (cell.r === 0 && cell.c < colCnt) row0[cell.c] = anchorOfHtmlCell(cell.inner)
  }
  const prof = takeProfile(remap, rowCnt, colCnt, first ? anchorOfHtmlCell(first.inner) : "", seq, normalizeRowAnchor(row0))

  // 열별 최대 내용폭 — colSpan 셀은 폭/span 만큼 각 열에 기여
  const colMax = Array(colCnt).fill(0)
  const colMaxBody = Array(colCnt).fill(0)
  const colMinWord = Array(colCnt).fill(0)
  const cellParsed = placed.map((cell) => htmlCellInnerToLines(cell.inner))
  const cellLines = cellParsed.map((p) => p.lines)
  placed.forEach((cell, i) => {
    const w = Math.max(...cellLines[i].map((l) => measureTextWidth(unescapeHtml(l).trim(), measureH, 100)), 0) / cell.colSpan
    // 최장 어절(열 하한) — 병합 셀은 첫 열에만 기여 (분할 배분 시 하한 과대 방지)
    const mw = cell.colSpan === 1 ? Math.max(...cellLines[i].map((l) => cellMinWordWidth(unescapeHtml(l), measureH)), 0) : 0
    for (let dc = 0; dc < cell.colSpan; dc++) {
      const c = cell.c + dc
      if (w > colMax[c]) colMax[c] = w
      if (!cell.isHeader && w > colMaxBody[c]) colMaxBody[c] = w
      if (dc === 0 && mw > colMinWord[c]) colMinWord[c] = mw
    }
  })
  const colWidths = profileColWidths(prof, colCnt) ?? computeColWidths(colMax, totalWidth, colMinWord)
  const colCentered = colWidths.map((w, c) => colMaxBody[c] + CELL_PAD <= w)

  const cellH = style ? Math.round(measureH * 1.6) + 282 : 1500
  const tblW = colWidths.reduce((a, b) => a + b, 0)
  const tblId = nextTableId()
  const useHeaderStyle = !style && (theme.tableHeader !== theme.body || theme.tableHeaderBold)
  const spanW = (cell: PlacedHtmlCell) => colWidths.slice(cell.c, cell.c + cell.colSpan).reduce((a, b) => a + b, 0)

  const reg = style?.bfRegistry ?? null
  // 헤더 행 수 — 연속된 th 행 (이중선 경계 판정용)
  let htmlHeaderRows = 0
  while (htmlHeaderRows < rows.length && rows[htmlHeaderRows].tag === "th") htmlHeaderRows++

  // Pass 1 — 셀별 내용 높이를 재고 행별 최대치(tableRowHeights)를 확정한다.
  //   · rowSpan은 실제 그리드 행수로 클램프 — 오버스팬은 무효 HWPX + 맨아랫줄 병합셀
  //     하변 위계(thick) 오판을 부른다.
  //   · 높이는 명시 <br> 줄 수가 아니라 셀폭 기준 줄바꿈까지 시뮬 — GFM estimateRowHeight와
  //     정합(명시 개행 없는 긴 서술 셀이 타 뷰어에서 잘리는 것 방지).
  const tableRowHeights = Array<number>(rowCnt).fill(cellH)
  const meta = placed.map((cell, i) => {
    const rowSpan = Math.min(cell.rowSpan, rowCnt - cell.r)
    const lines = cellLines[i]
    // 중첩표 — 셀폭(마진 제외)에 맞춰 1회 재귀 생성, Pass 2에서 재사용(재호출 방지)
    let nestedH = 0
    const nestedXmls: string[] = []
    for (const nested of extractTopLevelTables(cell.inner)) {
      // 중첩표 폭 = 부모 셀폭 − 여유(1020), 가독 하한 4000 — 단 하한이 부모 셀폭을
      // 넘으면 셀 경계를 침범하므로 상한(셀폭 − 마진 282)에 양보한다 (v4.0.5 P1-3)
      const sw = spanW(cell)
      const nestedW = Math.max(Math.min(Math.max(sw - 1020, 4000), sw - 282), 500)
      const nestedXml = generateHtmlTableXml(nested, theme, nestedW, style ? { ...style, totalWidth: nestedW } : null)
      if (nestedXml) {
        nestedXmls.push(nestedXml)
        // 재귀가 확정한 실높이(hp:sz — 셀 성장·줄바꿈 반영)를 재사용. 행수×cellH 추정은
        // 중첩 셀이 접히면(긴 텍스트 wrap) 과소해 호스트 행이 중첩표를 못 담았다 (v4.0.4)
        const szH = nestedXml.match(/<hp:sz [^>]*height="(\d+)"/)?.[1]
        nestedH += (szH ? Number(szH) : ((nested.match(/<tr[\s>]/gi) ?? []).length) * cellH) + 300
      }
    }
    // 셀폭 기준 줄바꿈 수 — <br> 분리 각 줄이 폭을 넘으면 추가로 접힌다
    const usable = Math.max(spanW(cell) - CELL_PAD, 1000)
    let wrapLines = 0
    for (const line of lines) wrapLines += Math.max(1, Math.ceil(measureTextWidth(unescapeHtml(line).trim(), measureH, 100) / usable))
    const lineH = style ? Math.round(measureH * 1.6) : 800
    const contentH = Math.max(cellH * rowSpan, Math.max(wrapLines, 1) * lineH + nestedH)
    const cellHeight = Math.max(prof?.cellH.get(`${cell.r},${cell.c}`) ?? 0, contentH)
    const perRow = Math.ceil(cellHeight / rowSpan)
    for (let r = cell.r; r < cell.r + rowSpan; r++) tableRowHeights[r] = Math.max(tableRowHeights[r], perRow)
    return { cell, rowSpan, lines, nestedXmls, imgSrcs: cellParsed[i].imgSrcs }
  })

  // Pass 2 — 확정된 행높이로 셀 XML 생성. 셀 높이 = 점유 행들의 확정 높이 합이라
  //   같은 행 셀들의 높이가 일치하고 열별 합이 hp:sz(tableH)와 정확히 맞는다.
  const tcXmls = meta.map(({ cell, rowSpan, lines, nestedXmls, imgSrcs }) => {
    const k = `${cell.r},${cell.c}`
    const isHeader = cell.isHeader
    const baseCharPr = style ? style.charPr : CHAR_NORMAL
    const headerCharPr = isHeader && useHeaderStyle ? CHAR_TABLE_HEADER : baseCharPr
    const defaultCharPr = style && reg && isHeader ? style.boldCharPr : isHeader ? headerCharPr : baseCharPr
    const charPrId = prof?.cellChar.get(k) ?? defaultCharPr
    const centered = isHeader || colCentered[cell.c]
    const paraPrId = style
      ? (centered ? (reg ? (style.tblCenterParaPr ?? style.centerParaPr) : style.centerParaPr) : (reg ? (style.tblLeftParaPr ?? PARA_NORMAL) : PARA_NORMAL))
      : PARA_NORMAL
    // 셀 이미지 — <img src>(imgSrcs)와 라인 내 마크다운 참조를 placeholder pic으로 (v4.0.5)
    const picUrls: string[] = images ? [...imgSrcs] : []
    const paras: string[] = []
    for (const line of lines) {
      let text = unescapeHtml(line)
      if (images) {
        const { text: rest, urls } = splitImageRefs(text)
        if (urls.length > 0) { picUrls.push(...urls); text = rest }
      }
      // 이미지 참조만으로 구성된 라인은 텍스트 문단 생략 — 아래 pic 문단이 대체
      if (!images || text.trim() || picUrls.length === 0) {
        paras.push(`<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`)
      }
    }
    if (images && picUrls.length > 0) {
      const pics = picUrls.map((u) => { const part = images.take(u); return part ? images.inlinePicXml(part) : null }).filter(Boolean)
      if (pics.length > 0) {
        paras.push(`<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${charPrId}">${pics.join("")}</hp:run></hp:p>`)
      }
    }
    for (const nestedXml of nestedXmls) {
      paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${nestedXml}</hp:run></hp:p>`)
    }
    if (paras.length === 0) {
      paras.push(`<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${charPrId}"><hp:t></hp:t></hp:run></hp:p>`)
    }
    // 셀 높이 = 점유 행들의 확정 높이 합 (같은 행 셀 높이 일치, 합 = hp:sz)
    let cellHeight = 0
    for (let r = cell.r; r < cell.r + rowSpan; r++) cellHeight += tableRowHeights[r]
    const rowEnd = cell.r + rowSpan - 1
    // 테두리 — 프로필 최우선, 다음 위계(병합 셀은 끝 행·열 기준 — 클램프된 rowSpan), 폴백 기본
    const bf = prof?.cellBf.get(k)
      ?? (reg
        ? reg.get(dataCellSpec({
            row: cell.r, rowEnd, col: cell.c, colEnd: cell.c + cell.colSpan - 1,
            rowCnt, colCnt, headerRows: htmlHeaderRows,
            fill: isHeader ? (style!.headerFill ?? "#E6E6E6") : undefined,
          }))
        : style && isHeader ? style.headerBf : 2)
    return `<hp:tc name="" header="${isHeader ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${bf}">`
      + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${style ? "CENTER" : "TOP"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras.join("")}</hp:subList>`
      + `<hp:cellAddr colAddr="${cell.c}" rowAddr="${cell.r}"/>`
      + `<hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${rowSpan}"/>`
      + `<hp:cellSz width="${spanW(cell)}" height="${cellHeight}"/>`
      + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
      + `</hp:tc>`
  })

  // 행별로 tr 묶기 (placed는 행 순서 유지)
  const trXmls: string[] = []
  for (let r = 0; r < rowCnt; r++) {
    const rowTcs = tcXmls.filter((_, i) => placed[i].r === r)
    trXmls.push(`<hp:tr>${rowTcs.join("")}</hp:tr>`)
  }

  const tableH = tableRowHeights.reduce((sum, height) => sum + height, 0)

  return `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="${style ? 1 : 0}" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">`
    + `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tableH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trXmls.join("")
    + `</hp:tbl>`
}
