/**
 * 페이지 콘텐츠 추출 → IRBlock[] (v2: 바운딩 박스 + 페이지 번호)
 *
 * 선 기반 테이블 감지(line-detector) → 클러스터 감지(cluster-detector) →
 * XY-Cut 읽기 순서의 계층 fallback으로 페이지 텍스트를 블록화하고,
 * 페이지 걸친 표 병합까지 담당한다.
 */

import type { IRBlock, IRTable, IRCell, BoundingBox, InlineStyle } from "../types.js"
import { safeMin, safeMax } from "../utils.js"
import { buildClipCellGrids, dropGridsInside, type ClipPage } from "./clip-cells.js"
import { dropShadingClipGrids } from "./table-grid.js"
import { chainShortSegments } from "./line-extract.js"
import { extractLines, preprocessLines, filterPageBorderLines, closeOpenTableEdges, bridgeSplitColumnVerticals, buildTableGrids, extractCells, mapTextToCells, cellTextToString, normalizeUndersegmentedTable, type TextItem, type TableGrid, type LineSegment } from "./line-detector.js"
import { detectClusterTables, findTwoColumnProseCutX, type ClusterItem, type ClusterTableResult } from "./cluster-detector.js"
import { type NormItem, collapseEvenSpacing, computeBBox, dominantStyle, groupByY, mergeSuperscriptLines, mergeLineSimple } from "./text-line.js"
import { findRuledColumnDivider } from "./ruled-columns.js"
import { xyCutOrder } from "./xy-cut.js"
import { detectColumnGutter, detectPersistentColumnGutter, orderByGutter, detectPanelGutters, orderByPanels, type ColRect } from "./two-column.js"
import { detectColumns, extractWithColumns } from "./columns.js"
import { shouldDemoteTable, demoteTableToText, detectListBlocks, detectSpecialKoreanTables } from "./block-detect.js"
import { markUnderlineItems, wrapUnderlineRuns } from "./underline.js"
import { extractImageRegions, type ImageRegion } from "./image-regions.js"
import { markImageCell } from "./table-trim.js"
import { CLIP_TABLES, CONT_PARTS, EMPTY_PARTS, FILLER_CELLS, TABLE_COLXS, recordCellLines } from "./table-meta.js"
import { WrapLexicon } from "./line-wrap.js"
import { closeOpenTableEnds } from "./open-table-ends.js"
import { extendHeaderBoxRows } from "./header-box-rows.js"
import { detectRuledBandTables, type RuledTable } from "./ruled-band-tables.js"
import { bridgeSkippedRowVerticals } from "./vertical-bridge.js"
import { splitSidebarTitleRegion, splitTrailingColumnRegion } from "./local-regions.js"
import { pushLineParagraphs } from "./paragraph-lines.js"
import { isChartTable, isTableOfContents, tocBlock } from "./table-roles.js"
import { splitTwoColumnProse, figureColumnBands, topTableBand, tieredHeaderTable, stackedTableBands, threeColumnCards, threeColumnInfographic } from "./page-regions.js"

/** 쪽 사이로 넘기는 칸 이어짐 상태 — 앞 쪽 번호와 그 쪽 클립 사실 (다음 쪽 첫 클립이 앞 쪽 마지막 칸의 이어짐인지 가른다, clip-cells) */
export interface PageCarry { page?: number; clip?: ClipPage }

/**
 * 선 기반 테이블 감지를 우선 시도, 실패 시 기존 휴리스틱 fallback.
 * @param extraLines 그래픽 ops 밖에서 얻은 선 (래스터 괘선 감지 등, PDF pt·bottom-up)
 * @param carry 쪽 순서대로 부를 때 넘기는 칸 이어짐 상태 — 바로 앞 쪽 것만 쓰고 이 쪽 것으로 바꿔 둔다
 * @param lexicon 문서 어휘 증거(줄 꺾임 이음 판정) — 문서 파싱 동안 쪽마다 쌓는다. 없으면 이 쪽만으로
 */
export function extractPageBlocksWithLines(
  items: NormItem[],
  pageNum: number,
  opList: { fnArray: Uint32Array | number[]; argsArray: unknown[][] },
  pageWidth: number,
  pageHeight: number,
  extraLines?: { horizontals: LineSegment[]; verticals: LineSegment[] },
  detectTables = true,
  carry?: PageCarry,
  lexicon?: WrapLexicon,
): IRBlock[] {
  if (items.length === 0) {
    if (carry) carry.clip = undefined
    return []
  }
  // 줄 꺾임 이음 판정의 어휘 증거 — 이 쪽 줄 글을 먼저 더해 쪽 안 어디서 판정하든 쪽 전체가 증거가 된다
  const lex = lexicon ?? new WrapLexicon()
  for (const line of streamLines(items)) lex.addLine(mergeLineSimple(line))

  // 1단계: PDF 그래픽 명령에서 선 추출
  const extracted = extractLines(opList.fnArray, opList.argsArray)
  let { horizontals, verticals } = extracted
  // 1.2단계: 셀 클립 사각형 → 테두리 없는 표 그리드 (법령 별지서식 외곽 표). 셀 기하가 확정돼
  // 있어 line 경로를 거치지 않고, 실선 표는 아래 line 경로가 그대로 맡는다 (clip-cells.ts)
  const prevPage = carry?.page === pageNum - 1 ? carry.clip : undefined
  const clipResult = detectTables
    ? buildClipCellGrids(extracted.clipRects, horizontals, verticals, pageWidth, pageHeight, items.map(it => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 })), extracted.fillRects, prevPage)
    : { grids: [], containers: [], page: undefined }
  if (carry) { carry.page = pageNum; carry.clip = clipResult.page }
  const clipGrids = clipResult.grids
  // 짧은 괘선 조각 잇기는 칸 클립 격자가 없는 쪽에서만 (line-extract chainShortSegments) — 칸마다 클립이 있는 쪽은 잇기가
  // 필요 없고, 한컴 조직도 박스 조각을 이으면 여러 클립 표를 가로지르는 큰 선 격자가 생겨 클립 격자 틈으로 살아남는다
  // (rhwp multi-table-002 조직도 17x19 빈 격자가 부서명을 삼킴). 예산서(부천·속초)·MS Print To PDF 글자 클립 쪽은 잇는다
  if (clipGrids.length === 0) {
    horizontals = chainShortSegments(horizontals, extracted.shortH, "h")
    verticals = chainShortSegments(verticals, extracted.shortV, "v")
  }
  if (extraLines) {
    horizontals = horizontals.concat(extraLines.horizontals)
    verticals = verticals.concat(extraLines.verticals)
  }
  ;({ horizontals, verticals } = filterPageBorderLines(horizontals, verticals, pageWidth, pageHeight))

  // 1.5단계: 선 전처리 (ODL LinesPreprocessingConsumer 포팅)
  // 굵은 선 필터 + 음영 스택 제거 + 근접 평행 선 병합
  ;({ horizontals, verticals } = preprocessLines(horizontals, verticals))

  // 1.6단계: 개방 변 표 테두리 합성 — 좌/우 바깥 테두리 생략 스타일(행정문서 관행)의
  // 가장자리 열 소실 방지. 내부 수직선이 실존하는 정렬 괘선 묶음에만 발동.
  horizontals = closeOpenTableEnds(horizontals, verticals)
  verticals = closeOpenTableEdges(horizontals, verticals)

  // 1.65단계: 무괘선 요약행 밴드(예산서 재원구분 시/구 행 등)로 끊긴 동일 열
  // 수직선 브리지 — 표 파편화로 헤더행·부서/정책 요약행이 그리드에서 탈락하는 것 방지
  verticals = bridgeSplitColumnVerticals(horizontals, verticals)
  if (detectTables && clipGrids.length === 0) verticals = bridgeSkippedRowVerticals(horizontals, verticals, items)
  if (detectTables && clipGrids.length === 0) ({ horizontals, verticals } = extendHeaderBoxRows(horizontals, verticals, items))

  // 1.7단계: 취소선 감지 — 텍스트 중심을 가로지르는 얇은 수평선 (ODL StrikethroughProcessor)
  markStrikethroughItems(items, horizontals)
  wrapStrikethroughRuns(items)

  // 1.75단계: 밑줄 감지 — baseline 바로 아래에 밀착한 얇은 수평선.
  // 개정문 추가·변경 표시, 제목 강조 보존용 (pdf-inspector underline 휴리스틱 참조)
  // 글자 밑줄은 표 행 경계가 아니다 — 칸 안 링크 밑줄이 행을 가르던 것(ODL 180)
  const underlines = new Set(markUnderlineItems(items, horizontals, verticals))
  if (underlines.size) horizontals = horizontals.filter(l => !underlines.has(l))
  wrapUnderlineRuns(items)

  // 2단계: 선으로 테이블 그리드 구성 (표 감지 opt-out 시 건너뜀 — #64)
  const lineGrids = detectTables ? buildTableGrids(horizontals, verticals) : []
  // 배경 칠한 칸에만 클립을 거는 제작기(cairo·한컴 구버전)의 음영 조각 격자는 버리고 온전한 선 표에 맡긴다 (dropShadingClipGrids)
  const tableClipGrids = dropShadingClipGrids(clipGrids, lineGrids, extracted.fillRects, verticals)
  const grids = [...tableClipGrids, ...dropGridsInside(lineGrids, tableClipGrids, clipResult.containers)]

  // A rotated illustration can project a one-cell square far beyond the page.
  // Its lines are not evidence that all page text belongs to one table.
  if (grids.length === 1 && grids[0].rowYs.length === 2 && grids[0].colXs.length === 2 &&
      grids[0].bbox.x2 - grids[0].bbox.x1 > pageWidth * 1.2 &&
      grids[0].bbox.y2 - grids[0].bbox.y1 > pageHeight * 1.2) {
    return extractPageBlocksFallback(items, pageNum, true, detectTables, lex)
  }

  // 가로 괘선만 있는 표(booktabs)는 표를 먼저 세우고 나머지 글은 격자 경로의 두 단·밴드 순서를 따른다
  const ruled = detectTables && clipGrids.length === 0 ? detectRuledBandTables(horizontals, verticals, items, pageNum) : []
  if (ruled.length > 0) {
    const imageRegions = extractImageRegions(opList.fnArray, opList.argsArray).filter(r => r.x2 - r.x1 >= 8 && r.y2 - r.y1 >= 8)
    return extractBlocksWithGrids(items, pageNum, pageWidth, pageHeight, grids, horizontals, verticals, imageRegions, lex, ruled)
  }

  // Repeated dense rows with explicit captions form independent table bands.
  // A broad decorative line grid can otherwise swallow the whole page.
  if (detectTables && stackedTableBands(items)) {
    return extractPageBlocksFallback(items, pageNum, true, detectTables, lex)
  }

  // A small decorative box in the page margin is not a content grid. It must
  // not force a sidebar title and its prose through the table-first path.
  const sidebar = splitSidebarTitleRegion(items)
  if (sidebar && grids.every(grid => grid.rowYs.length === 2 && grid.colXs.length === 2 &&
      !items.some(item => item.x + item.w / 2 >= grid.bbox.x1 && item.x + item.w / 2 <= grid.bbox.x2 &&
        item.y + item.h / 2 >= grid.bbox.y1 && item.y + item.h / 2 <= grid.bbox.y2))) {
    return sidebar.flatMap((region, index) => extractPageBlocksFallback(region, pageNum, false, index === 2 ? false : detectTables, lex))
  }

  if (grids.length > 0) {
    // 셀 안 그림(로고·서명 등) — 8pt 미만 조각은 장식이라 제외
    const imageRegions = extractImageRegions(opList.fnArray, opList.argsArray).filter(r => r.x2 - r.x1 >= 8 && r.y2 - r.y1 >= 8)
    return extractBlocksWithGrids(items, pageNum, pageWidth, pageHeight, grids, horizontals, verticals, imageRegions, lex)
  }

  // Fallback: 기존 휴리스틱 (선이 없는 PDF). 단 안의 그림은 글이 없는 자리라 거터 판정에 점유 사각형으로 넘긴다
  const figures = extractImageRegions(opList.fnArray, opList.argsArray).filter(r => r.x2 - r.x1 >= 40 && r.y2 - r.y1 >= 40)
    .map(r => ({ x: r.x1, y: r.y1, w: r.x2 - r.x1, h: r.y2 - r.y1 }))
  return extractPageBlocksFallback(items, pageNum, true, detectTables, lex, figures)
}

// ─── 취소선 감지 (ODL StrikethroughProcessor 포팅) ─────
// Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
// https://github.com/opendataloader-project/opendataloader-pdf

/** 취소선 최대 두께 (pt) — 굵은 선은 배경 채움/테두리 */
const STRIKE_MAX_THICKNESS = 2.0
/** 취소선 두께 / 텍스트 높이 최대 비율 */
const STRIKE_MAX_THICKNESS_RATIO = 0.25
/** 선 Y와 텍스트 중심 Y의 허용 오차 (텍스트 높이 비율) */
const STRIKE_CENTER_TOLERANCE = 0.25
/** 선이 텍스트를 덮어야 하는 최소 수평 비율 */
const STRIKE_MIN_OVERLAP_RATIO = 0.8
/** 선 폭 / 매칭 텍스트 총폭 최대 비율 — 표 구분선/배경선 오탐 방지 */
const STRIKE_MAX_LINE_TO_TEXT_RATIO = 1.5

/**
 * 텍스트 중심을 가로지르는 얇은 수평선을 찾아 해당 아이템에 strike 마킹.
 * 법령 개정문(신구조문대비표)의 삭제 표시 텍스트 보존용.
 */
function markStrikethroughItems(items: NormItem[], horizontals: LineSegment[]): void {
  if (items.length === 0 || horizontals.length === 0) return

  for (const line of horizontals) {
    if (line.lineWidth > STRIKE_MAX_THICKNESS) continue
    const matches: NormItem[] = []
    for (const item of items) {
      const h = item.h > 0 ? item.h : item.fontSize
      if (h <= 0 || item.w <= 0) continue
      if (line.lineWidth > h * STRIKE_MAX_THICKNESS_RATIO) continue
      // 글자 중심 근사: baseline(y) + 높이의 40% (한글 x-height 중앙)
      const centerY = item.y + h * 0.4
      if (Math.abs(line.y1 - centerY) > h * STRIKE_CENTER_TOLERANCE) continue
      const overlap = Math.min(line.x2, item.x + item.w) - Math.max(line.x1, item.x)
      if (overlap / item.w < STRIKE_MIN_OVERLAP_RATIO) continue
      matches.push(item)
    }
    if (matches.length === 0) continue
    // 선 폭이 매칭 텍스트 총폭의 1.5배 이내여야 취소선 (표 괘선 오탐 방지)
    let totalW = 0
    for (const m of matches) totalW += m.w
    if (totalW <= 0 || (line.x2 - line.x1) / totalW > STRIKE_MAX_LINE_TO_TEXT_RATIO) continue
    for (const m of matches) m.strike = true
  }
}

/**
 * strike 마킹된 연속 아이템 run을 ~~...~~ 마크다운으로 감싼다.
 * (같은 시각적 줄에서 인접한 마킹 아이템들을 하나의 run으로 묶음)
 */
function wrapStrikethroughRuns(items: NormItem[]): void {
  const struck = items.filter(i => i.strike)
  if (struck.length === 0) return

  // 줄 단위 그룹핑 (y ±3) 후 x 순 정렬
  const lines = new Map<number, NormItem[]>()
  for (const item of struck) {
    const key = Math.round(item.y / 3)
    const arr = lines.get(key) || []
    arr.push(item)
    lines.set(key, arr)
  }
  for (const arr of lines.values()) {
    arr.sort((a, b) => a.x - b.x)
    arr[0].text = "~~" + arr[0].text
    arr[arr.length - 1].text = arr[arr.length - 1].text + "~~"
  }
}

// ─── 프로즈 박스 감지 (라벨탭 위 전폭 프로즈) ──────────
/** 내부 수직 구분선 없는 전폭 행이 표 높이에서 차지해야 할 최소 비율 (기하 신호) */
const PROSEBOX_FULLWIDTH_MIN = 0.6
/** 긴 프로즈 셀 판정 글자수 */
const PROSEBOX_LONG_CELL_CHARS = 80
/** 프로즈 박스 판정 최소 긴 셀 수 */
const PROSEBOX_LONG_CELL_MIN = 3
/** 긴 셀이 채운 셀에서 차지해야 할 최소 비율 (텍스트 신호) */
const PROSEBOX_LONG_CELL_RATIO = 0.4
/** 열 경계 부근 수직선 매칭 tolerance (pt) */
const PROSEBOX_X_TOL = 8

/** 열 경계 x 부근 수직선들이 [yMin,yMax]를 덮는 union 길이 (프로즈 박스 판정용) */
function verticalCoverageAt(verticals: LineSegment[], x: number, yMin: number, yMax: number): number {
  const tol = PROSEBOX_X_TOL
  const spans: Array<[number, number]> = []
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) > tol) continue
    const lo = Math.max(v.y1, yMin), hi = Math.min(v.y2, yMax)
    if (hi > lo) spans.push([lo, hi])
  }
  if (spans.length === 0) return 0
  spans.sort((a, b) => a[0] - b[0])
  let total = 0, s = spans[0][0], e = spans[0][1]
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] <= e) { if (spans[i][1] > e) e = spans[i][1] }
    else { total += e - s; s = spans[i][0]; e = spans[i][1] }
  }
  return total + (e - s)
}

/**
 * 프로즈 박스 판정 — 상단 라벨탭(제목 칩)이 박스 테두리에 걸쳐 만든 가짜 열 위로
 * 본문이 전폭 프로즈로 흐르는 표(예: 검정고시 응시자격 박스). 셀 텍스트 조인(demote)은
 * 찢긴 조각을 그대로 이어 스크램블되므로, 이 표는 버리고 아이템을 프로즈 폴백(자연
 * 읽기순)으로 재추출한다. 판정은 두 신호의 교집합 —
 *   (a) 기하: 내부 수직 구분선 없는 전폭 행의 높이 합이 표 높이의 60%+
 *   (b) 텍스트: 80자+ 긴 셀이 3개+ 이고 채운 셀의 40%+
 * 기하만으론 다줄셀 정규표, 텍스트만으론 서술형 2열표(용어설명·Q&A)와 구분되지 않아
 * 둘 다 충족할 때만 발동한다.
 */
function isProseBoxGrid(grid: TableGrid, verticals: LineSegment[], table: IRTable): boolean {
  const numCols = grid.colXs.length - 1
  if (numCols < 2 || grid.rowYs.length < 3) return false

  const gyMax = grid.rowYs[0], gyMin = grid.rowYs[grid.rowYs.length - 1]
  const span = gyMax - gyMin
  if (span <= 0) return false
  const interior = grid.colXs.slice(1, -1)
  let fullWidthHeight = 0
  for (let r = 0; r < grid.rowYs.length - 1; r++) {
    const top = grid.rowYs[r], bot = grid.rowYs[r + 1]
    const h = top - bot
    if (h <= 0) continue
    // 내부 열 경계 어느 하나라도 이 행의 절반 이상을 덮는 수직선이 있으면 구분된 행
    const hasDivider = interior.some(cx => verticalCoverageAt(verticals, cx, bot, top) >= h * 0.5)
    if (!hasDivider) fullWidthHeight += h
  }
  if (fullWidthHeight < span * PROSEBOX_FULLWIDTH_MIN) return false

  const texts = table.cells.flat().map(c => c.text.trim()).filter(Boolean)
  const longCells = texts.filter(s => s.length > PROSEBOX_LONG_CELL_CHARS).length
  if (longCells < PROSEBOX_LONG_CELL_MIN || longCells < texts.length * PROSEBOX_LONG_CELL_RATIO) return false

  return true
}

/** 셀 텍스트 정리 — 페이지 번호 표시("- 2 -") 제거 + 줄별 균등배분 공백 제거("경 제 총 괄 반" → "경제총괄반") */
function cleanCellText(text: string): string {
  const stripped = text.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim()
  return stripped.split("\n").map(line => collapseEvenSpacing(line)).join("\n")
}

/** 틀 셀 좌표와 같은 부모를 가진 중첩표를 pending 에서 꺼낸다 (제자리 제거) */
const FRAME_RECT_TOL = 1.5
function takePendingNested(
  pending: Array<{ parent: { x1: number; y1: number; x2: number; y2: number }; block: IRBlock }>,
  cellBox: { x1: number; y1: number; x2: number; y2: number },
): IRBlock[] {
  const out: IRBlock[] = []
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i].parent
    if (Math.abs(p.x1 - cellBox.x1) <= FRAME_RECT_TOL && Math.abs(p.x2 - cellBox.x2) <= FRAME_RECT_TOL
      && Math.abs(p.y1 - cellBox.y1) <= FRAME_RECT_TOL && Math.abs(p.y2 - cellBox.y2) <= FRAME_RECT_TOL) {
      out.push(pending[i].block)
      pending.splice(i, 1)
    }
  }
  return out
}

/**
 * 틀 셀의 blocks 조립 — 셀 자기 글(문단)과 안쪽 표를 위→아래 순서로 섞는다. 표의 y 띠 위·옆에
 * 있는 글은 표 앞 문단, 아래 글은 다음 덩어리. text 는 blocks 평탄화(하위 호환, IRCell 계약)
 */
function buildFrameCellBlocks(cellItems: TextItem[], nested: IRBlock[], pageNum: number, wrap: CellWrap): { blocks: IRBlock[]; text: string } {
  const tables = [...nested].sort((a, b) => (b.bbox!.y + b.bbox!.height) - (a.bbox!.y + a.bbox!.height))
  const blocks: IRBlock[] = []
  let rest = [...cellItems]
  const pushParagraphs = (items: TextItem[]) => {
    if (items.length === 0) return
    for (const line of cleanCellText(cellTextToString(items, wrap)).split("\n")) {
      const t = line.trim()
      if (t) blocks.push({ type: "paragraph", text: t, pageNumber: pageNum })
    }
  }
  for (const tb of tables) {
    const bottom = tb.bbox!.y
    pushParagraphs(rest.filter(it => it.y >= bottom))
    rest = rest.filter(it => it.y < bottom)
    blocks.push(tb)
  }
  pushParagraphs(rest)
  const text = blocks
    .map(b => b.type === "table" && b.table ? b.table.cells.flat().map(c => c.text).filter(Boolean).join("\n") : (b.text ?? ""))
    .filter(Boolean)
    .join("\n")
  return { blocks, text }
}

/**
 * 선 기반 그리드가 감지된 경우: 테이블 영역의 텍스트는 셀에 매핑,
 * 나머지는 일반 텍스트 블록으로 처리.
 */
function extractBlocksWithGrids(
  items: NormItem[],
  pageNum: number,
  pageWidth: number,
  pageHeight: number,
  grids: TableGrid[],
  horizontals: LineSegment[],
  verticals: LineSegment[],
  imageRegions: ImageRegion[] = [],
  lex?: WrapLexicon,
  ruled: RuledTable[] = [],
): IRBlock[] {
  const blocks: IRBlock[] = []
  const usedItems = new Set<NormItem>()
  for (const r of ruled) {
    for (const it of r.items) usedItems.add(it)
    blocks.push(r.block)
  }
  const proseSidebars = new Set<IRBlock>()
  // 중첩 클립 그리드(clipParent)에서 만든 표 — 틀 셀을 처리할 때 그 셀의 blocks 로 들어간다.
  // 면적 오름차순 처리라 안쪽 표가 항상 틀보다 먼저 여기 쌓인다
  const pendingNested: Array<{ parent: { x1: number; y1: number; x2: number; y2: number }; block: IRBlock }> = []

  // 그리드를 Y좌표 내림차순 정렬 (위→아래). 셀이 확정된 클립 그리드가 먼저 글을 가져간다 —
  // 틀 표(3×3 테두리 등)가 위에서 먼저 삼키면 안쪽 "발신명의 | 직인" 표가 빈 채로 죽는다.
  // 클립 그리드끼리는 작은 것(중첩표)이 틀(1×1)보다 먼저다.
  // 블록 순서는 마지막에 Y 로 다시 정렬되므로 처리 순서가 출력 순서를 바꾸지 않는다
  const gridArea = (g: TableGrid): number => (g.bbox.x2 - g.bbox.x1) * (g.bbox.y2 - g.bbox.y1)
  const sortedGrids = [...grids].sort((a, b) =>
    (b.cells ? 1 : 0) - (a.cells ? 1 : 0)
    || (a.cells && b.cells ? gridArea(a) - gridArea(b) : 0) // 클립 그리드끼리는 면적 오름차순 — 중첩표가 틀보다 먼저
    || b.bbox.y2 - a.bbox.y2)

  for (const grid of sortedGrids) {
    // 1행 다열 그리드는 테이블 헤더일 가능성 높음 → 스킵하여 클러스터 감지에 위임.
    // 클립 그리드(grid.cells)는 셀 기하가 확정된 실제 표라 1행·1열이어도 그대로 낸다
    // (지정서의 "발신명의 | 직인" 1×2 표 실측)
    const numGridRows = grid.rowYs.length - 1
    const numGridCols = grid.colXs.length - 1
    const gridW = grid.bbox.x2 - grid.bbox.x1
    if (!grid.cells && numGridRows === 1 && numGridCols >= 2) continue
    // Full-width one-column frames are usually page layout. The compact
    // repeated-row candidate is checked again after text is mapped to cells.
    if (!grid.cells && numGridCols === 1 && numGridRows >= 2 &&
        (numGridRows < 5 || gridW > pageWidth * 0.7)) continue
    // 그리드 영역 내 텍스트 아이템 수집
    const tableItems: NormItem[] = []
    const pad = 3
    for (const item of items) {
      if (usedItems.has(item)) continue
      // Y 범위 체크
      if (item.y < grid.bbox.y1 - pad || item.y > grid.bbox.y2 + pad) continue
      // X 범위 체크 — 아이템의 시작과 끝이 모두 그리드 안에 있어야 함
      if (item.x < grid.bbox.x1 - pad || item.x + item.w > grid.bbox.x2 + pad) continue
      // 좁은 그리드(120px 미만)에서 큰 아이템이 경계에 걸치면 제외
      // 제목 텍스트가 인접 그리드에 잡히는 것을 방지
      if (gridW < 120 && item.x + item.w > grid.bbox.x2 - 2) continue
      tableItems.push(item)
      usedItems.add(item)
    }

    // 셀 추출 — 클립 그리드는 셀이 확정돼 있다
    const cells = grid.cells ?? extractCells(grid, horizontals, verticals)
    if (cells.length === 0) continue

    // 텍스트→셀 매핑 (hasSpaceBefore 전파 — 셀 텍스트 단어 공백 복원)
    const textItems: TextItem[] = tableItems.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore, seq: i.seq,
    }))
    const cellTextMap = mapTextToCells(textItems, cells)

    // 셀 미배정 아이템 수집 — mapTextToCells는 교차비율 > 0.3만 배정하므로,
    // 그리드 bbox 안에 있지만 어느 셀에도 못 붙은 아이템(세로쓰기 헤더 등)을
    // usedItems에 남겨두면 표에도 프로즈에도 없이 무음 소멸한다.
    const assignedItems = new Set<TextItem>()
    for (const arr of cellTextMap.values()) for (const it of arr) assignedItems.add(it)

    // IRTable 구성
    const numRows = grid.rowYs.length - 1
    const numCols = grid.colXs.length - 1
    const irGrid: import("../types.js").IRCell[][] = Array.from(
      { length: numRows },
      () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })),
    )

    let nestedAttached = false
    for (const cell of cells) {
      const cellItems = cellTextMap.get(cell) || []
      // 틀 셀 — 안쪽 클립 그리드가 낸 표를 이 셀의 blocks 에 원문 순서(위→아래)로 넣는다.
      // 지정서·영치증의 "발신명의 | 직인" 표가 틀 뒤 별도 블록으로 빠지던 것을 HWP 파서 IR 과
      // 같은 모양(셀 안 문단 + 중첩표)으로 (v4.12.2)
      const nested = grid.cells ? takePendingNested(pendingNested, cell.bbox) : []
      if (nested.length > 0) {
        nestedAttached = true
        const built = buildFrameCellBlocks(cellItems, nested, pageNum, { box: cell.bbox, lex })
        irGrid[cell.row][cell.col] = { text: built.text, colSpan: cell.colSpan, rowSpan: cell.rowSpan, blocks: built.blocks }
        // 틀 칸 자기 글의 글줄 — 쪽을 넘은 틀 칸의 글 이어짐 판정(table-parts)이 본다 (과제 명세서 "□ 개념" 칸이 다음 쪽 상자 칸으로 이어짐)
        if (cellItems.length) recordCellLines(irGrid[cell.row][cell.col], cellItems)
        continue
      }
      irGrid[cell.row][cell.col] = {
        text: cleanCellText(cellTextToString(cellItems, { box: cell.bbox, lex })),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      }
      const b = cell.bbox
      // 칸을 통째로 덮는 그림은 칸 배경이다(행정업무운영 편람 예시 상자: 칸마다 배경 그림) — 내용 그림으로 보지 않는다
      const isBackdrop = (r: ImageRegion) => r.x1 <= b.x1 + 1 && r.x2 >= b.x2 - 1 && r.y1 <= b.y1 + 1 && r.y2 >= b.y2 - 1
      if (imageRegions.some(r => { const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2; return cx > b.x1 && cx < b.x2 && cy > b.y1 && cy < b.y2 && !isBackdrop(r) })) {
        markImageCell(irGrid[cell.row][cell.col])
      }
      if (cell.filler && !cellItems.length) FILLER_CELLS.add(irGrid[cell.row][cell.col])
      if (grid.cells && cellItems.length) recordCellLines(irGrid[cell.row][cell.col], cellItems)
    }

    // 과소분할 표 재구성 (ODL TableStructureNormalizer):
    // 행≤5 + 열≥3 + 셀 안에 텍스트 줄이 뭉친 표는 줄 centerY 기반 row band로 행 복원
    // (중첩표를 품은 틀·셀 클립 그리드는 셀 구조가 확정된 것이라 재구성하지 않는다 — 클립 표에 돌리면 상자 안
    // 문단이 줄마다 행·열로 찢긴다: 보도자료 "[참고] SDG 14" 2×2 상자 → 10×3)
    let finalGrid = irGrid
    let finalRows = numRows
    let rebuiltUsed = false
    let unitLine: NormItem[] = []
    let unitText = ""
    if (!grid.cells && numRows >= 3 && numRows <= 5 && numCols >= 3) {
      const nearby = items.filter(item => item.y >= grid.bbox.y2 && item.y - grid.bbox.y2 <= 18
        && item.x >= grid.bbox.x1 - 3 && item.x + item.w <= grid.bbox.x2 + 3)
      for (const y of [...new Set(nearby.map(item => Math.round(item.y)))].sort((a, b) => a - b)) {
        const line = nearby.filter(item => Math.abs(item.y - y) <= 1).sort((a, b) => a.x - b.x)
        const text = line.map(item => item.text).join("")
        if (!/^\s*\(\s*단위\s*[:：]/.test(text)) continue
        unitLine = line
        unitText = text
        break
      }
    }
    if (!grid.cells && numRows <= 5 && numCols >= 3 && !nestedAttached && (numRows <= 2 || unitLine.length > 0)) {
      const rebuilt = normalizeUndersegmentedTable(irGrid, grid.colXs, textItems, grid.rowYs)
      if (rebuilt) {
        rebuiltUsed = true
        finalGrid = rebuilt.map(row => row.map(rawText => ({ text: cleanCellText(rawText), colSpan: 1, rowSpan: 1 })))
        finalRows = finalGrid.length
      }
    }
    // 미배정 아이템을 프로즈 경로로 환원 — 과소분할 재구축(rebuiltUsed)은
    // textItems 전체(미배정 포함)를 셀에 재배치하므로 그때는 환원하지 않는다(중복 방지)
    if (!rebuiltUsed) {
      for (let ti = 0; ti < textItems.length; ti++) {
        if (!assignedItems.has(textItems[ti])) usedItems.delete(tableItems[ti])
      }
    }
    if (unitLine.length > 0 && rebuiltUsed && !/^\s*\(\s*단위\s*[:：]/.test(finalGrid[0]?.[0]?.text ?? "")) {
      finalGrid.unshift(Array.from({ length: numCols }, (_, c) => ({ text: c === 0 ? cleanCellText(unitText) : "", colSpan: c === 0 ? numCols : 1, rowSpan: 1 })))
      finalRows++
      for (const item of unitLine) usedItems.add(item)
    }

    // Alternating empty bands are visual row spacing, not empty data records.
    // Only a repeated, populated sequence is a semantic one-column table.
    let semanticOneColumn = false
    if (!grid.cells && numCols === 1 && numGridRows >= 2) {
      const populatedRows = finalGrid.filter(row => row[0]?.text.trim())
      if (populatedRows.length >= 4) {
        const fontSizes = tableItems.map(item => item.fontSize).filter(size => size > 0).sort((a, b) => a - b)
        const medianFont = fontSizes[Math.floor(fontSizes.length / 2)] ?? 0
        const meanRowHeight = (grid.bbox.y2 - grid.bbox.y1) / populatedRows.length
        semanticOneColumn = meanRowHeight <= Math.max(30, medianFont * 2.5)
      }
      if (!semanticOneColumn) {
        for (const it of tableItems) usedItems.delete(it)
        continue
      }
      finalGrid = populatedRows
      finalRows = finalGrid.length
    }

    const irTable: IRTable = {
      rows: finalRows,
      cols: numCols,
      cells: finalGrid,
      hasHeader: finalRows > 1,
      ...(semanticOneColumn ? { renderAsTable: true } : {}),
    }
    // 중첩표도 같은 쪽 넘김 규칙을 쓴다 — pendingNested 분기 전에 기하 출처를 기록한다.
    if (grid.cells) CLIP_TABLES.add(irTable)
    TABLE_COLXS.set(irTable, grid.colXs)
    if (grid.continues) CONT_PARTS.set(irTable, grid.continues)

    // 빈 테이블(모든 셀이 빈 문자열) 스킵
    const hasContent = finalGrid.some(row => row.some(cell => cell.text.trim() !== ""))
    // 글 없는 클립 표는 쪽 넘김 조각일 수 있어 잇기 단계까지 둔다 (못 이으면 mergeCrossPageTables 가 버린다)
    const emptyPart = !hasContent && !!grid.cells && !grid.clipParent && !nestedAttached
    if (!hasContent && !emptyPart) continue
    if (emptyPart) EMPTY_PARTS.add(irTable)

    // 중첩 클립 그리드 — 틀 셀이 처리될 때 그 셀의 blocks 로 들어간다 (틀은 면적이 커서 뒤에 온다)
    if (grid.clipParent) {
      const nb: BoundingBox = { page: pageNum, x: grid.bbox.x1, y: grid.bbox.y1, width: grid.bbox.x2 - grid.bbox.x1, height: grid.bbox.y2 - grid.bbox.y1 }
      pendingNested.push({ parent: grid.clipParent, block: { type: "table", table: irTable, pageNumber: pageNum, bbox: nb } })
      continue
    }

    // 프로즈 박스: 가짜 열 위로 전폭 프로즈가 흐르는 표 → 표를 버리고 아이템을
    // 프로즈 폴백으로 재추출 (셀 조인 demote는 찢긴 조각을 스크램블하므로 부적합)
    // 클립 그리드는 셀 기하가 확정된 실제 표 — 프로즈 박스·의사 표 강등을 적용하지 않는다
    if (!grid.cells && isProseBoxGrid(grid, verticals, irTable)) {
      for (const it of tableItems) usedItems.delete(it)
      continue
    }
    // 벡터로 그린 막대 차트의 눈금선·막대 격자는 표가 아니다 — 값 글자는 차트 영역 안에서
    // 위→아래 줄 순서의 글로 둔다(쪽 본문과 섞으면 열 감지가 본문을 찢는다, table-roles.ts)
    if (!grid.cells && isChartTable(irTable)) {
      blocks.push(chartBlock(tableItems, pageNum, { page: pageNum, x: grid.bbox.x1, y: grid.bbox.y1, width: gridW, height: grid.bbox.y2 - grid.bbox.y1 }))
      continue
    }

    const tableBbox: BoundingBox = {
      page: pageNum,
      x: grid.bbox.x1, y: grid.bbox.y1,
      width: grid.bbox.x2 - grid.bbox.x1, height: grid.bbox.y2 - grid.bbox.y1,
    }

    // A tall, narrow one-cell clip beside an independent prose column is a
    // layout panel. Keep its original lines as one region, not as a data table.
    if (numRows === 1 && numCols === 1 && gridW < pageWidth * 0.35) {
      const prose = finalGrid[0]?.[0]?.text ?? ""
      const besideLines = (side: NormItem[]) => new Set(side.map(it => Math.round(it.y / 3))).size
      const rightLines = items.filter(it => it.x >= grid.bbox.x2 + 3 &&
        it.y >= grid.bbox.y1 && it.y <= grid.bbox.y2)
      const leftLines = items.filter(it => it.x + it.w <= grid.bbox.x1 - 3 &&
        it.y >= grid.bbox.y1 && it.y <= grid.bbox.y2)
      // 짧은 글의 오른쪽 좁은 패널(사이드바)도 왼쪽에 본문 단이 나란하면 패널이다 — 본문 뒤에 읽는다
      if ((prose.length >= 200 && prose.split("\n").length >= 8 &&
          (besideLines(rightLines) >= 8 || besideLines(leftLines) >= 8)) ||
          (gridW < pageWidth * 0.25 && besideLines(leftLines) >= 8 && besideLines(rightLines) === 0)) {
        const sidebar: IRBlock = { type: "paragraph", text: prose, pageNumber: pageNum,
          bbox: tableBbox, style: dominantStyle(tableItems) }
        blocks.push(sidebar)
        proseSidebars.add(sidebar)
        continue
      }
    }

    // 의사 테이블 필터: 텍스트성 내용 → paragraph로 복원 (구조 보존)
    if (!grid.cells && shouldDemoteTable(irTable)) {
      const demoted = demoteTableToText(irTable)
      if (demoted) {
        // 텍스트 박스(1x1 또는 1행 그리드) demote 시 앞뒤 줄바꿈으로 본문과 분리
        const text = numGridRows === 1 ? "\n" + demoted + "\n" : demoted
        blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox: tableBbox, style: dominantStyle(tableItems) })
      }
      continue
    }

    blocks.push({ type: "table", table: irTable, pageNumber: pageNum, bbox: tableBbox })
  }
  // 틀 셀에 못 붙은 중첩표(틀이 빈 표로 걸러졌거나 셀 좌표가 어긋난 경우) — 종전대로 독립 블록
  for (const p of pendingNested) blocks.push(p.block)

  // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
  let remaining = items.filter(i => !usedItems.has(i))
  const groupSizes: number[] = []
  let finalTextBlocks: IRBlock[] = []
  let gutterX: number | null = null
  let panels: number[] | null = null
  if (remaining.length > 0) {
    remaining.sort((a, b) => b.y - a.y || a.x - b.x)

    // 클러스터 기반 테이블 감지 (XY-Cut 전에 실행 — 테이블이 쪼개지지 않도록)
    const clusterItems: ClusterItem[] = remaining.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
    }))
    // 두 단 본문은 쪽 전체 클러스터 표 감지 전에 가른다 — 아래 거터 경로가 단마다 표를 따로 찾는다
    // (fallback 경로의 earlyProseCut 과 같은 순서. 먼저 표로 묶이면 두 단 줄이 한 표 행으로 섞인다)
    const proseColumns = findTwoColumnProseCutX(clusterItems) !== null ||
      detectPersistentColumnGutter(remaining.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h > 0 ? i.h : i.fontSize }))) !== null
    const clusterResults = proseColumns ? [] : detectClusterTables(clusterItems, pageNum)
    if (clusterResults.length > 0) {
      const ciToIdx = new Map<ClusterItem, number>()
      for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci)
      const usedClusterIndices = new Set<number>()
      for (const cr of clusterResults) {
        for (const ci of cr.usedItems) {
          const idx = ciToIdx.get(ci)
          if (idx !== undefined) usedClusterIndices.add(idx)
        }
        blocks.push(clusterTableBlock(cr, remaining.filter((_, idx) => cr.usedItems.has(clusterItems[idx])), pageNum, horizontals))
      }
      remaining = remaining.filter((_, idx) => !usedClusterIndices.has(idx))
    }
  }

  // 2단 지면 감지 (#64) — 남은 텍스트 아이템과 표 블록 bbox를 합친 기하 신호.
  // 시험지처럼 텍스트가 대부분 표에 흡수된 페이지도 표 bbox만으로 판단된다.
  {
    const rects: ColRect[] = remaining.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h > 0 ? i.h : i.fontSize }))
    for (const b of blocks) {
      // 글 없는 클립 표 조각(쪽 넘김 잇기용으로만 남긴 것)은 지면 판단에 넣지 않는다
      if (b.bbox && !(b.table && EMPTY_PARTS.has(b.table))) rects.push({ x: b.bbox.x, y: b.bbox.y, w: b.bbox.width, h: b.bbox.height })
    }
    gutterX = detectColumnGutter(rects) ?? findRuledColumnDivider(
      blocks.filter(b => b.type === "table" && b.bbox && b.table && !EMPTY_PARTS.has(b.table))
        .map(b => ({ x: b.bbox!.x, y: b.bbox!.y, w: b.bbox!.width, h: b.bbox!.height })),
      horizontals, verticals, pageWidth, pageHeight,
    )
    if (gutterX === null) panels = detectPanelGutters(rects)
  }

  if (remaining.length > 0) {
    if (gutterX !== null) {
      // 2단 지면: 거터 기준 좌/우/걸침으로 가른 뒤, 각 단 안에서는 기존과 동일하게
      // XY-Cut 그룹 단위로 처리한다 — 단 전체를 한 덩어리로 넘기면 클러스터 표
      // 감지가 문항 사이를 건너뛰며 선지 행들을 거대 표로 흡수한다(granularity 보존).
      const gx = gutterX
      const allY = remaining.map(i => i.y)
      const pageH = safeMax(allY) - safeMin(allY)
      const gapThreshold = Math.max(15, pageH * 0.03)
      const sides = [
        remaining.filter(i => i.x + i.w <= gx),
        remaining.filter(i => i.x < gx && i.x + i.w > gx),
        remaining.filter(i => i.x >= gx),
      ]
      const textBlocks: IRBlock[] = []
      for (const side of sides) {
        if (side.length === 0) continue
        for (const group of xyCutOrder(side, gapThreshold)) {
          if (group.length === 0) continue
          const groupBlocks = extractPageBlocksFallback(group, pageNum, false, true, lex)
          for (const b of groupBlocks) textBlocks.push(b)
          groupSizes.push(groupBlocks.length)
        }
      }
      finalTextBlocks = detectListBlocks(textBlocks)
    } else {
      // XY-Cut으로 왼쪽 본문과 오른쪽 부서명 등을 분리 후 개별 처리
      const allY = remaining.map(i => i.y)
      const pageH = safeMax(allY) - safeMin(allY)
      const groups = xyCutOrder(remaining, Math.max(15, pageH * 0.03))
      const textBlocks: IRBlock[] = []
      for (const group of groups) {
        if (group.length === 0) continue
        const besideProsePanel = [...proseSidebars].some(sidebar => sidebar.bbox &&
          group.every(item => item.x >= sidebar.bbox!.x + sidebar.bbox!.width + 3) &&
          new Set(group.filter(item => item.y >= sidebar.bbox!.y &&
            item.y <= sidebar.bbox!.y + sidebar.bbox!.height).map(item => Math.round(item.y / 3))).size >= 8)
        const groupBlocks = extractPageBlocksFallback(group, pageNum, false, !besideProsePanel, lex)
        for (const b of groupBlocks) textBlocks.push(b)
        groupSizes.push(groupBlocks.length)
      }
      finalTextBlocks = detectListBlocks(textBlocks) // 1:1 변환 — 그룹 경계(groupSizes) 유지
    }
  }

  // 그룹 단위 Y-정렬 — 블록 단위 Y-정렬은 XY-Cut이 정한 컬럼 읽기 순서(좌단
  // 전체 → 우단 전체)를 행 단위로 재인터리브하므로, XY-Cut 그룹을 한 단위로
  // 묶어 그룹 대표 Y(최상단)로만 정렬하고 그룹 내부 순서는 보존한다.
  // 표/demote 블록은 각자 단독 단위 (기존과 동일하게 Y 위치로 끼어듦).
  const units: IRBlock[][] = blocks.map(b => [b])
  let off = 0
  for (const size of groupSizes) {
    const unit = finalTextBlocks.slice(off, off + size)
    off += size
    if (unit.length > 0) units.push(unit)
  }
  const unitTopY = (u: IRBlock[]) => {
    let top = 0
    for (const b of u) {
      if (b.bbox && b.bbox.y + b.bbox.height > top) top = b.bbox.y + b.bbox.height
    }
    return top
  }
  if (panels && units.length > 1) {
    const unitBox = (u: IRBlock[]): ColRect => {
      const bs = u.filter(b => b.bbox).map(b => b.bbox!)
      if (!bs.length) return { x: -1e6, y: 0, w: 2e6, h: 0 }
      const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
      return { x, y, w: Math.max(...bs.map(b => b.x + b.width)) - x, h: Math.max(...bs.map(b => b.y + b.height)) - y }
    }
    const ordered: IRBlock[] = []
    for (const u of orderByPanels(units, unitBox, panels)) for (const b of u) ordered.push(b)
    return mergeAdjacentTableBlocks(ordered)
  }
  if (gutterX !== null && units.length > 1) {
    // 밴드 정렬 (#64): 거터를 가로지르는 유닛(전폭 표·머리글·쪽번호)을 위→아래
    // 밴드 경계로 삼고, 밴드 안에서 좌단 전체(위→아래) → 우단 전체 순으로 배열.
    const gx = gutterX
    const unitRect = (u: IRBlock[]): ColRect => {
      let minX = Infinity, minY = Infinity, maxR = -Infinity, maxT = -Infinity
      for (const b of u) {
        if (!b.bbox) continue
        if (b.bbox.x < minX) minX = b.bbox.x
        if (b.bbox.y < minY) minY = b.bbox.y
        if (b.bbox.x + b.bbox.width > maxR) maxR = b.bbox.x + b.bbox.width
        if (b.bbox.y + b.bbox.height > maxT) maxT = b.bbox.y + b.bbox.height
      }
      // bbox 없는 유닛(방어) — 거터 걸침으로 취급해 맨 뒤 경계로 밀림
      if (!Number.isFinite(minX)) return { x: gx - 1, y: 0, w: 2, h: 0 }
      return { x: minX, y: minY, w: maxR - minX, h: maxT - minY }
    }
    const ordered: IRBlock[] = []
    for (const u of orderByGutter(units, unitRect, gx)) for (const b of u) ordered.push(b)
    return mergeAdjacentTableBlocks(ordered)
  }
  // A landscape sheet can contain two independent portrait pages. In that
  // layout, a slightly higher table on the right must not precede the left
  // page's tables and prose. Require all units to stay within one half.
  if (pageWidth > pageHeight * 1.2 && units.length > 1) {
    const mid = pageWidth / 2
    const sideOf = (unit: IRBlock[]) => {
      let left = false, right = false
      for (const block of unit) {
        if (!block.bbox) return 0
        if (block.bbox.x + block.bbox.width <= mid) left = true
        else if (block.bbox.x >= mid) right = true
        else return 0
      }
      return left && !right ? -1 : right && !left ? 1 : 0
    }
    const left = units.filter(u => sideOf(u) === -1)
    const right = units.filter(u => sideOf(u) === 1)
    if (left.length >= 2 && right.length >= 2 && left.length + right.length === units.length &&
        left.some(u => u.some(b => b.type === "table")) && right.some(u => u.some(b => b.type === "table"))) {
      const flatten = (side: IRBlock[][]) => side.sort((a, b) => unitTopY(b) - unitTopY(a)).flat()
      return [...mergeAdjacentTableBlocks(flatten(left)), ...mergeAdjacentTableBlocks(flatten(right))]
    }
  }
  units.sort((a, b) => unitTopY(b) - unitTopY(a)) // PDF는 y가 위가 큼 → 내림차순
  // A panel can start below the first line of its neighboring prose column.
  // When their vertical spans coincide, read the left column before the right one.
  for (const sidebar of proseSidebars) {
    const box = sidebar.bbox!
    const sidebarIndex = units.findIndex(unit => unit.includes(sidebar))
    const peerIndex = units.findIndex(unit => unit.some(b => b.type === "paragraph" && b.text && b.text.length >= 200 && b.bbox &&
      b.bbox.x >= box.x + box.width + 3 &&
      Math.max(0, Math.min(box.y + box.height, b.bbox.y + b.bbox.height) - Math.max(box.y, b.bbox.y)) >=
        Math.min(box.height, b.bbox.height) * 0.6))
    if (sidebarIndex > peerIndex && peerIndex >= 0) {
      const [unit] = units.splice(sidebarIndex, 1)
      units.splice(peerIndex, 0, unit)
      continue
    }
    // A panel on the right is read after the prose column beside it.
    let lastLeft = -1
    const beside = (b: IRBlock) => !!b.bbox && b.bbox.x + b.bbox.width <= box.x - 3 &&
      b.bbox.y + b.bbox.height >= box.y && b.bbox.y <= box.y + box.height
    units.forEach((unit, index) => {
      // 옆 본문 단 — 패널 왼쪽 줄들, 패널 아래로 이어진 줄은 폭이 넓어도 같은 단이다
      if (unit.some(beside) && unit.every(b => beside(b) || (!!b.bbox && b.bbox.y + b.bbox.height < box.y))) lastLeft = index
    })
    const current = units.findIndex(unit => unit.includes(sidebar))
    if (lastLeft > current) {
      const [unit] = units.splice(current, 1)
      units.splice(lastLeft, 0, unit)
    }
  }
  const ordered: IRBlock[] = []
  for (const u of units) for (const b of u) ordered.push(b)
  return mergeAdjacentTableBlocks(ordered)
}

/** 무괘선 표 후보를 역할대로 낸다 — 목차는 "항목 쪽번호" 줄, 차트는 영역 안 위→아래 줄 글, 나머지는 표 */
function clusterTableBlock(cr: ClusterTableResult, source: NormItem[], pageNum: number, horizontals: LineSegment[] = []): IRBlock {
  // 목차 역할은 괘선 증거가 없는 후보에만 — 폭 대부분을 가로지르는 괘선이 행을 가르는 목차는 원문에서도 표다(한컴 목차 표를 OCR 로 읽은 쪽).
  // 라벨 밑 짧은 밑줄은 증거가 아니다
  const b = cr.bbox
  const ruled = horizontals.filter(h => h.y1 > b.y && h.y1 < b.y + b.height &&
    Math.min(h.x2, b.x + b.width) - Math.max(h.x1, b.x) >= b.width * 0.6).length >= 3
  if (!ruled && isTableOfContents(cr.table)) return tocBlock(cr.table, pageNum, cr.bbox, dominantStyle(source))
  if (isChartTable(cr.table)) return chartBlock(source, pageNum, cr.bbox)
  return { type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox }
}

function chartBlock(source: NormItem[], pageNum: number, bbox: BoundingBox): IRBlock {
  // 값만 있는 줄이 쪽번호 줄 제거(cleanPdfText)에 지워지지 않게 한 문단 글로 잇는다 — 위→아래 줄 순서는 그대로
  const text = groupByY(source).map(line => mergeLineSimple(line).replace(/\s+/g, " ").trim()).filter(Boolean).join(" ")
  return { type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(source) }
}

/** 같은 열 수의 연속 테이블 블록을 하나로 합침 — 선 기반 그리드 파편 재조립용. 클립 표는 변을 공유하지 않는
 *  별개 표라 합치지 않는다(행정업무운영 편람 Q&A 상자 두 개가 4×1 로 뭉개지고 안쪽 6×5 표가 사라지던 것) */
/** 행마다 클립 격자를 따로 깐 표를 이어 만든 표 */
const STACKED_ROWS = new WeakSet<IRTable>()

/** 같은 쪽에서 1행 클립 표들이 셀 간격 수준의 틈으로 열 경계가 모두 같게 이어지면 한 표의 행이다.
 *  여러 행을 가진 클립 표끼리는 잇지 않는다 — 한컴 PDF 는 열 경계가 같은 별개 표를 좁은 틈으로 쌓는다(행정업무운영 편람 −40표 실측) */
function isStackedClipRow(upper: IRTable, ub: BoundingBox, lower: IRTable, lb: BoundingBox): boolean {
  if (!CLIP_TABLES.has(upper) || !CLIP_TABLES.has(lower) || upper.cols < 2 || upper.cols !== lower.cols ||
      lower.rows !== 1 || !STACKED_ROWS.has(upper) && upper.rows !== 1 ||
      CONT_PARTS.has(upper) || CONT_PARTS.has(lower) || EMPTY_PARTS.has(upper) || EMPTY_PARTS.has(lower) ||
      ub.page !== lb.page) return false
  const ux = TABLE_COLXS.get(upper), lx = TABLE_COLXS.get(lower)
  if (!ux || !lx || ux.length !== lx.length || ux.some((x, i) => Math.abs(x - lx[i]) > 1)) return false
  const gap = ub.y - (lb.y + lb.height)
  return gap >= -1 && gap <= Math.min(12, Math.min(ub.height, lb.height) * 0.5)
}

function mergeAdjacentTableBlocks(blocks: IRBlock[]): IRBlock[] {
  if (blocks.length <= 1) return blocks
  const result: IRBlock[] = [blocks[0]]
  for (let i = 1; i < blocks.length; i++) {
    const prev = result[result.length - 1]
    const curr = blocks[i]
    const clipRows = prev.type === "table" && curr.type === "table" && prev.table && curr.table &&
      prev.bbox && curr.bbox && isStackedClipRow(prev.table, prev.bbox, curr.table, curr.bbox)
    if (clipRows) {
      // 행마다 클립 격자를 따로 깐 표(셀 간격만 둔 틈·열 경계 동일)는 한 표의 행들이다
      const merged: IRTable = { rows: prev.table!.rows + curr.table!.rows, cols: prev.table!.cols,
        cells: [...prev.table!.cells, ...curr.table!.cells], hasHeader: prev.table!.hasHeader }
      CLIP_TABLES.add(merged)
      STACKED_ROWS.add(merged)
      TABLE_COLXS.set(merged, TABLE_COLXS.get(prev.table!)!)
      const pb = prev.bbox!, cb = curr.bbox!
      result[result.length - 1] = { ...prev, table: merged,
        bbox: { ...pb, y: cb.y, height: pb.y + pb.height - cb.y } }
    } else if (prev.type === "table" && curr.type === "table" && prev.table && curr.table &&
        prev.table.cols === curr.table.cols && prev.table.renderAsTable === curr.table.renderAsTable &&
        !CLIP_TABLES.has(prev.table) && !CLIP_TABLES.has(curr.table)) {
      // 합치기: prev의 cells에 curr의 cells 추가
      const merged: IRTable = {
        rows: prev.table.rows + curr.table.rows,
        cols: prev.table.cols,
        cells: [...prev.table.cells, ...curr.table.cells],
        hasHeader: prev.table.hasHeader,
        ...(prev.table.renderAsTable ? { renderAsTable: true } : {}),
      }
      result[result.length - 1] = { ...prev, table: merged }
    } else {
      result.push(curr)
    }
  }
  return result
}

/**
 * 어휘 증거용 줄 — 콘텐츠 스트림 순서(seq)대로 이어 가다 기준선이 바뀌거나 왼쪽으로 되돌아가거나 탭만큼 벌어지면 끊는다.
 * 쪽 전체를 y 로만 묶으면 같은 높이의 옆 칸 줄이 한 줄로 붙어("…공상공무 원 및 특별공로순직자의" — 왼 칸 끝 + 오른 칸 머리)
 * 가짜 띄움 증거가 생긴다. 한컴은 칸마다·줄마다 글을 차례로 내므로 스트림 순서가 칸 줄을 지킨다. seq 없는 아이템(OCR)은 y 묶음
 */
function streamLines(items: NormItem[]): NormItem[][] {
  if (items.some(i => i.seq === undefined)) return groupByY([...items].sort((a, b) => b.y - a.y || a.x - b.x))
  const lines: NormItem[][] = []
  let cur: NormItem[] = []
  for (const it of [...items].sort((a, b) => a.seq! - b.seq!)) {
    const last = cur[cur.length - 1]
    if (last && (Math.abs(it.y - last.y) > 3 || it.x < last.x - 1 || it.x - (last.x + last.w) > Math.max(2 * it.fontSize, 30))) {
      lines.push(cur)
      cur = []
    }
    cur.push(it)
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** 칸 글 조립에 넘기는 줄 꺾임 판정 재료 — 칸 상자와 문서 어휘 증거 */
type CellWrap = { box: { x1: number; x2: number }; lex?: WrapLexicon }

/** Keep aligned-column tables structural instead of escaping their generated Markdown as prose. */
export function columnTextToBlocks(text: string, pageNum: number, bbox: BoundingBox, style?: InlineStyle): IRBlock[] {
  const lines = text.split("\n")
  const blocks: IRBlock[] = []
  const prose: string[] = []
  const flushProse = () => {
    const content = prose.join("\n").trim()
    if (content) blocks.push({ type: "paragraph", text: content, pageNumber: pageNum, bbox, style })
    prose.length = 0
  }
  const cells = (line: string) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"))
  const tableLine = (line: string) => /^\|.*\|\s*$/.test(line.trim())

  for (let i = 0; i < lines.length;) {
    if (tableLine(lines[i]) && i + 2 < lines.length && tableLine(lines[i + 1]) &&
        cells(lines[i + 1]).every(c => /^:?-{3,}:?$/.test(c))) {
      let end = i + 2
      while (end < lines.length && tableLine(lines[end])) end++
      const rows = [cells(lines[i]), ...lines.slice(i + 2, end).map(cells)]
      const cols = rows[0].length
      const values = rows.slice(1).flat().filter(Boolean)
      const numeric = values.filter(value => value.length <= 24 && /\d/.test(value)).length
      if (cols >= 3 && rows.length >= 3 && rows.every(row => row.length === cols) &&
          rows[0].every(value => value.length <= 80) && numeric >= 3 && numeric / values.length >= 0.25) {
        flushProse()
        blocks.push({ type: "table", pageNumber: pageNum, bbox, table: {
          rows: rows.length, cols, hasHeader: true,
          cells: rows.map(row => row.map(value => ({ text: value, rowSpan: 1, colSpan: 1 }))),
        } })
        i = end
        continue
      }
    }
    // 표로 인정하지 않은 열 줄은 칸 글을 이어 원래 줄로 — "| a | b |" 모양을 그대로 두면 이스케이프된 파이프 문단이 된다
    if (tableLine(lines[i])) {
      const cellTexts = cells(lines[i])
      if (!cellTexts.every(c => /^:?-{3,}:?$/.test(c))) prose.push(cellTexts.filter(Boolean).join(" "))
    } else prose.push(lines[i])
    i++
  }
  flushProse()
  return blocks
}

/**
 * 기존 휴리스틱 기반 페이지 블록 추출 (선이 없는 PDF 대비 fallback).
 *
 * fullPage: 페이지 전체 아이템으로 호출됐을 때만 true — 2단 조판 본문 감지는
 * 전체 지면 기준 신호라, XY-Cut 그룹(부분 집합) 재호출에서는 오발화하므로 끈다.
 *
 * detectTables: false 면 표 감지(클러스터·다열 정렬·한국어 특수표)를 모두 끄고
 * 자연 읽기순 텍스트만 낸다 (#64 opt-out).
 */
export function extractPageBlocksFallback(items: NormItem[], pageNum: number, fullPage = false, detectTables = true, lex?: WrapLexicon, figures: ColRect[] = []): IRBlock[] {
  if (items.length === 0) return []

  if (fullPage && detectTables) {
    const bands = stackedTableBands(items)
    if (bands) {
      const blocks: IRBlock[] = []
      for (let i = 0; i < bands.tables.length; i++) {
        blocks.push(...extractPageBlocksFallback(bands.tables[i], pageNum, false, true, lex))
        if (i < bands.between.length) blocks.push(...extractPageBlocksFallback(bands.between[i], pageNum, false, false, lex))
      }
      blocks.push(...extractPageBlocksFallback(bands.caption, pageNum, false, false, lex))
      blocks.push(...extractPageBlocksFallback(bands.body, pageNum, true, true, lex))
      return blocks
    }
  }
  if (fullPage) {
    const infographic = threeColumnInfographic(items)
    if (infographic) return infographic.flatMap(group => extractPageBlocksFallback(group, pageNum, false, detectTables, lex))
    const cards = threeColumnCards(items)
    if (cards) return cards.flatMap(group => extractPageBlocksFallback(group, pageNum, false, detectTables, lex))
  }

  const blocks: IRBlock[] = []

  // 1단계: 클러스터 기반 테이블 감지 우선 (헤더 감지 시 정확도 높음)
  const clusterItems: ClusterItem[] = items.map(i => ({
    text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
    fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
  }))
  // A page with two justified prose columns must be partitioned before
  // cluster-table detection. Otherwise paired footnotes and body lines can
  // become a single false table, and their source coordinates are lost.
  const textRects = items.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h > 0 ? i.h : i.fontSize }))
  // 한 단 위쪽을 그림이 차지하면 글만으로는 거터가 끊겨 보인다 — 그림 사각형을 더해 쪽 전체 거터를 확정한다
  const earlyProseCut = fullPage && detectTables
    ? findTwoColumnProseCutX(clusterItems) ?? detectPersistentColumnGutter(textRects) ??
      (figures.length > 0 ? detectColumnGutter([...textRects, ...figures]) : null)
    : null
  if (earlyProseCut !== null) {
    const band = topTableBand(items)
    if (band) {
      const tiered = tieredHeaderTable(band.top, pageNum)
      return [
        ...(tiered ? [tiered] : extractPageBlocksFallback(band.top, pageNum, false, detectTables, lex)),
        ...extractPageBlocksFallback(band.rest, pageNum, true, detectTables, lex),
      ]
    }
    return splitTwoColumnProse(items, earlyProseCut)
      .flatMap(group => extractPageBlocksFallback(group, pageNum, false, detectTables, lex))
  }
  if (fullPage && detectTables && figures.length > 0) {
    const bands = figureColumnBands(items, figures)
    if (bands) return bands.flatMap(group => extractPageBlocksFallback(group, pageNum, false, detectTables, lex))
  }
  if (fullPage && detectTables) {
    const sidebar = splitSidebarTitleRegion(items)
    if (sidebar) return sidebar.flatMap((region, index) => extractPageBlocksFallback(region, pageNum, false, index === 2 ? false : detectTables, lex))
    const regions = splitTrailingColumnRegion(items)
    if (regions) return regions.flatMap(region => extractPageBlocksFallback(region, pageNum, false, detectTables, lex))
  }
  const rejected = { prose: 0 }
  const clusterResults = detectTables ? detectClusterTables(clusterItems, pageNum, rejected) : []

  if (clusterResults.length > 0) {
    const ciToIdx = new Map<ClusterItem, number>()
    for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci)
    const usedIndices = new Set<number>()
    for (const cr of clusterResults) {
      for (const ci of cr.usedItems) {
        const idx = ciToIdx.get(ci)
        if (idx !== undefined) usedIndices.add(idx)
      }
      blocks.push(clusterTableBlock(cr, items.filter((_, idx) => cr.usedItems.has(clusterItems[idx])), pageNum))
    }

    // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
    const remaining = items.filter((_, idx) => !usedIndices.has(idx))
    if (remaining.length > 0) pushLineParagraphs(blocks, mergeSuperscriptLines(groupByY(remaining)), pageNum, lex)

    blocks.sort((a, b) => {
      const ay = a.bbox ? (a.bbox.y + a.bbox.height) : 0
      const by = b.bbox ? (b.bbox.y + b.bbox.height) : 0
      return by - ay
    })
  } else {
    // 2단계: 레거시 컬럼 감지 (3+ 열)
    // 2단 조판 본문(속기록류)은 들여쓰기 x-피크가 3+ 열로 오인돼 페이지 전체가
    // 행 인터리브 탭 텍스트로 뭉개진다 → 단 분리 경로에 위임
    let proseCutX = fullPage ? findTwoColumnProseCutX(items) : null
    // 프로즈 전용 검출이 불발하는 2단 지면(시험지 등 — 마커 다량·짧은 선지 줄)은
    // 기하 전용 거터 검출로 보강 (#64)
    if (proseCutX === null && fullPage) {
      proseCutX = detectColumnGutter(items.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h > 0 ? i.h : i.fontSize })))
    }
    const allYLines = mergeSuperscriptLines(groupByY(items))
    // 정렬이 산문으로 판정된 쪽(rejected.prose)은 그 열이 표 열의 증거가 아니다 — 열 표로 묶지 않고 XY-Cut 으로 읽는다
    const columns = proseCutX !== null || !detectTables || rejected.prose > 0 ? null : detectColumns(allYLines)

    if (columns && columns.length >= 3) {
      const tableText = extractWithColumns(allYLines, columns)
      const bbox = computeBBox(items, pageNum)
      blocks.push(...columnTextToBlocks(tableText, pageNum, bbox, dominantStyle(items)))
    } else {
      // 3단계: XY-Cut으로 읽기 순서 결정.
      // 2단 조판 본문은 전폭 제목/목차 줄이 X 프로젝션을 막아 XY-Cut이 단을 못
      // 가르는 경우가 있어(속기록 1면) 검출된 컷으로 직접 분리한다.
      const allY = items.map(i => i.y)
      const pageHeight = safeMax(allY) - safeMin(allY)
      const gapThreshold = Math.max(15, pageHeight * 0.03)

      const orderedGroups = proseCutX !== null
        ? splitTwoColumnProse(items, proseCutX)
        : xyCutOrder(items, gapThreshold)

      for (const group of orderedGroups) {
        if (group.length === 0) continue
        const yLines = mergeSuperscriptLines(groupByY(group))

        const groupColumns = detectTables ? detectColumns(yLines) : null
        if (groupColumns && groupColumns.length >= 3) {
          const tableText = extractWithColumns(yLines, groupColumns)
          const bbox = computeBBox(group, pageNum)
          blocks.push(...columnTextToBlocks(tableText, pageNum, bbox, dominantStyle(group)))
        } else {
          pushLineParagraphs(blocks, yLines, pageNum, lex)
        }
      }
    }
  }

  // 한국어 특수 테이블 감지 (구분/항목/종류 패턴)
  return detectTables ? detectSpecialKoreanTables(blocks) : blocks
}
