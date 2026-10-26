/**
 * 레이아웃 보존 렌더 — HWPX 조판 캐시(lineseg·cellAddr·hp:pos)를 SVG 절대배치로 그린다.
 *
 * 조판 엔진 없음: 한컴이 저장 시 기록한 좌표를 그대로 사용한다. 따라서
 * 한컴(또는 조판 캐시를 기록하는 편집기)에서 저장한 파일만 렌더 가능 —
 * markdownToHwpx 산출물엔 linesegarray가 없어 KordocError를 던진다.
 *
 * 좌표 산식(실측 검증 — .claude/plans/render-poc/findings.md):
 * - 단위 HWPUNIT(1/7200in), pt = /100. 최상위 문단 lineseg = 본문영역 로컬,
 *   셀 문단 = 셀 로컬. PARA 밀어내기 개체 anchor = 호스트vp − (omTop+h+omBottom) 역산.
 * - horzsize는 줄 "영역" 폭(텍스트 폭 아님) — 마지막 줄이 아닌 줄은 원본 줄바꿈에
 *   맞춰 textLength로 고정하고, 마지막 줄만 paraPr 정렬(LEFT 자연폭/CENTER/RIGHT/배분)을 적용.
 * - 좌표 속성엔 uint32로 저장된 음수가 섞여 있다(toInt32 필수).
 * - 표 열은 span 제약 경계 전파로, 행은 rs=1 max + 콘텐츠 초과 성장으로 푼다.
 *
 * 페이지: 최상위 lineseg vertpos는 페이지 로컬(페이지마다 0부터 리셋)이므로 역행
 *   지점을 페이지 경계로 감지, 전 페이지를 세로 스택으로 그린다(페이지별 흰 배경 +
 *   클립). 페이지에 걸친 표는 시작 페이지에서 잘린다(조판 캐시에 분할점이 없음).
 *
 * 범위: section0 한정(다중 구역은 첫 구역만), 수식·그리기개체 도형은 미지원(경고 수집).
 */

import JSZip from "jszip"
import { KordocError, compareSectionPaths, precheckZipSize } from "../utils.js"
import { createXmlParser, findChildByLocalName, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES } from "../hwpx/parser-shared.js"
import { toInt32, tableColumnBoundaries, type SpanConstraint } from "./layout.js"
import { measureTextWidth, faceClassOf, type WrapMode } from "../hwpx/text-metrics.js"
import { parseRenderStyles, hwpxAppMajor, hwpxAppBuild, DEFAULT_CHAR, type RenderStyles, type RenderBorderEdge, type RenderParaGeom } from "./head-styles.js"
import { reflowSection, glyphWidth } from "./reflow.js"
import { hasKoPubSubst, kopubSubstituted } from "./font-env.js"
import { mapPuaText } from "../shared/pua.js"
import { latexToPlain } from "./equation-text.js"
import { hwpEquationToLatex } from "../hwp5/equation.js"
import { RegionCollector, type PageBBox, type RenderRegion, type RenderScene } from "./scene.js"
import { formatHeadNumber, nextParaNumber, type NumberCounters } from "./para-number.js"
import { ln, elements, num, findFirst, type Seg, type ParaChar, OBJ_TAGS, FORM_TAGS, type ParaObj, type ParaModel, buildPara, prepareDeletedRanges, tabAdvance, type ExtentMemo, cellContentExtent, collectCells, measureTableHeight, measureTableRowHeights, captionOf, captionExtra, cellColumns } from "./para-model.js"
import { endNoteLayout, footNoteStories, pageStories } from "./page-stories.js"
import { cellLineBoxes, planTableRows, type CellFloatSpan, type RowPiece } from "./table-pages.js"
import { subFloatBottoms } from "./reflow-tables.js"
import { mulAffine, objectGeometry, renderingMatrix, shapeGeometry, rotatedBounds, SHAPE_TAGS, type Affine, type RegionRotation } from "./shape-geometry.js"
import { anchorObject, linePushedBy } from "./object-anchor.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { escapeXml, pt, ptNum, pageNo, bboxOf, regionOpenTag, parentId, emit, warnOnce, drawPara, cellParaTop, type PageGeom, type Ctx, type PaintJob } from "./svg-content.js"
export { escapeXml } from "./svg-content.js"
export { buildPara, measureTableHeight, tabAdvance, type Seg, type ParaChar, type ParaModel, type ExtentMemo } from "./para-model.js"

export interface RenderSvgOptions {
  /** 이미지 1장당 허용 최대 바이트 (기본 40MB) */
  maxImageBytes?: number
  /** 검색어 형광펜 — 텍스트 조각 내 매치 구간에 배경 rect (대소문자 무시).
   *  charPr(스타일) 경계에 걸친 매치는 칠하지 못한다. */
  highlights?: string[]
  /** Tier-2 reflow — 조판 캐시(linesegarray) 없는 파일도 순수 TS 조판으로 렌더.
   *  캐시가 있으면 무시(한컴본은 캐시 재생). 기본 false(캐시 없으면 KordocError). */
  reflow?: boolean
  /** reflow 줄바꿈 폴백 모드 — 'keep'(어절) / 'charAll'(글자). 문단 paraPr에
   *  breakSetting 선언이 있으면 그 값이 우선하며(BREAK_WORD=어절, KEEP_WORD=글자 —
   *  이름 역전 주의), 이 옵션은 선언 없는 문단에만 적용된다. */
  reflowMode?: WrapMode
}

export interface RenderSvgResult {
  svg: string
  /** 페이지 폭 (pt) */
  width: number
  /** 전체 캔버스 높이 (pt) — 페이지 세로 스택 + 간격 */
  height: number
  /** 렌더된 페이지 수 */
  pageCount: number
  warnings: string[]
  stats: { texts: number; images: number; tables: number; shapes: number }
  /** 개체 region(페이지 로컬 pt bbox·결정적 id) — #75 */
  regions: RenderRegion[]
}

// ─── XML 헬퍼 ─────────────────────────────────────

// ─── 표 ───────────────────────────────────────────

function edgeLine(x1: number, y1: number, x2: number, y2: number, e: RenderBorderEdge): string {
  const dash = /DASH|DOT/.test(e.type) ? ` stroke-dasharray="${e.type.includes("DOT") ? "1,1.5" : "3,1.5"}"` : ""
  return `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml(e.color)}" stroke-width="${e.widthPt.toFixed(2)}"${dash}/>`
}

/**
 * 본문 표가 이어지는 쪽 수 — drawTable 과 같은 행 조각 계획(planTableRows: 행 단위 넘김, CELL 표는 칸 줄 경계에서 가름).
 * 프리패스가 표 뒤 문단의 쪽을 표가 끝나는 쪽으로 보내는 데 쓴다(한컴 저장본: 쪽을 넘는 표 뒤 문단 vertpos 는 표 끝 쪽 기준)
 */
function tableContPages(tbl: Element, ty: number, MT: number, BODY_H: number, memo: ExtentMemo, slack = 0, floatSpan?: CellFloatSpan, nested = false, contMT = MT): { pages: number; endY: number } {
  const pcs = planTableRows(tbl, collectCells(tbl), measureTableRowHeights(tbl, memo), ty, MT, BODY_H, slack, floatSpan, nested, contMT).flat()
  const last = pcs.reduce((a, b) => (b.page > a.page || (b.page === a.page && b.y + b.h > a.y + a.h) ? b : a), pcs[0] ?? { page: 0, y: ty, h: 0 })
  return { pages: last.page, endY: last.y + last.h }
}

/**
 * 갈린 칸 줄에 앵커한 떠 있는 표가 쪽을 넘는 만큼(planTableRows 의 CellFloatSpan) — 표 위 = 앵커 줄 위 + 바깥 위 여백 + 세로 오프셋.
 * 칸 안 개체는 글을 밀지 않으므로 줄 위 기준이다(한컴 저장본: 칸 안 70행 표의 앵커 줄 horzsize 0, 표는 그 줄 자리부터 세 쪽)
 */
function cellFloatSpan(MT: number, BODY_H: number, memo: ExtentMemo, slack: number): CellFloatSpan {
  return (seg, top, contMT) => {
    const lsa = seg.parentNode as Element | null, p = lsa?.parentNode as Element | null
    if (!p || ln(p) !== "p") return undefined
    const segs = elements(lsa!).filter(e => ln(e) === "lineseg"), k = segs.indexOf(seg)
    const m = buildPara(p)
    let best: { pages: number; endY: number; el?: Element } | undefined
    for (const o of m.objs) {
      if (o.tag !== "tbl" || o.inline) continue
      const pos = findChildByLocalName(o.el, "pos")
      if ((pos?.getAttribute("vertRelTo") ?? "PARA") !== "PARA") continue
      const segK = Math.max(0, m.segs.findIndex((sg, i) => sg.textpos <= o.index && (i === m.segs.length - 1 || m.segs[i + 1].textpos > o.index)))
      if (segK !== k) continue
      // 앵커 줄이 이 표에 밀려 저장됐으면(줄 = 앞 문단 끝 + 표) 표는 줄 위가 아니라 문단 위에서 시작한다 — 그릴 때와 같다
      const segV = num(seg, "vertpos"), pTop = cellParaTop(p, memo.paraGeom ?? new Map())
      const start = linePushedBy(o, segV, pTop) ? top - (segV - (pTop ?? segV)) : top
      const ty = start + num(findChildByLocalName(o.el, "outMargin"), "top") + Math.max(0, toInt32(pos?.getAttribute("vertOffset") ?? undefined, 0))
      const span = tableContPages(o.el, ty, MT, BODY_H, memo, slack, cellFloatSpan(MT, BODY_H, memo, slack), true, contMT)
      if (span.pages > 0 && (!best || span.pages > best.pages)) best = { ...span, el: o.el }
    }
    return best
  }
}

function drawTable(tbl: Element, tx: number, ty: number, ctx: Ctx, depth: number): void {
  if (depth > 16) { warnOnce(ctx, "depth", "중첩 깊이 16 초과 — 이하 생략"); return }
  ctx.stats.tables++
  const tblSz = findChildByLocalName(tbl, "sz")
  const cells = collectCells(tbl)
  if (cells.length === 0 || cells.length > 4096) return

  const nCols = Math.max(...cells.map(c => c.ca + c.cs))
  const nRows = Math.max(...cells.map(c => c.ra + c.rs))
  const colCons: SpanConstraint[] = cells.map(c => ({ a: c.ca, b: c.ca + c.cs, size: c.w }))
  // 행마다 칸 너비 합이 다르게 저장된 표는 칸을 이은 가장 긴 길이 표 너비에 닿으면 그 경계(tableColumnBoundaries) —
  // 모든 열을 덮는 행 중 칸 너비 합이 표 너비와 같은 행이 있는지도 넘긴다
  const tblW = num(tblSz, "width")
  const rowSum = new Map<number, { cover: number; w: number }>()
  for (const c of cells) { const r = rowSum.get(c.ra) ?? { cover: 0, w: 0 }; r.cover += c.cs; r.w += c.w; rowSum.set(c.ra, r) }
  const noExactRow = ![...rowSum.values()].some(r => r.cover === nCols && Math.abs(r.w - tblW) <= 2)
  const colX = tableColumnBoundaries(colCons, nCols, tblW || undefined, noExactRow)
  // 행 높이는 쪽 프리패스(tableContPages)·재배치와 같은 모델 — 칸 간격(cellSpacing)도 행에 든다
  const rowH = measureTableRowHeights(tbl, ctx.extentMemo)
  const rowY: number[] = [0]
  for (let r = 0; r < nRows; r++) rowY.push(rowY[r] + rowH[r])

  // 표 region — 페이지에 걸친 표는 시작 페이지에서 잘려 그려지므로(조판 캐시에 분할점 없음) 시작 페이지
  // 조각만 기록하고 경고한다. sourceId = hp:tbl id (IR 표와의 조인 키, #76)
  const tblH = rowY[nRows]
  if (ty + tblH > ctx.pageH + 100) warnOnce(ctx, "table-split", "페이지에 걸친 표 — 분할 지오메트리가 없어 시작 페이지 영역만 region 으로 기록")
  const tblId = ctx.regions.add("table", bboxOf(ctx, tx, ty, colX[nCols], tblH), { sourceId: tbl.getAttribute("id") ?? undefined, parentId: parentId(ctx) })
  emit(ctx, regionOpenTag(tblId, "table", pageNo(ctx)))
  ctx.parentStack.push(tblId)

  // 본문 쪽을 넘는 표는 행 단위로 다음 쪽에 이어 그린다 — 행 바닥이 본문 바닥을 넘으면 그 행부터 다음 쪽 맨 위(쪽이 모자라면 늘린다).
  // repeatHeader 면 머리 행(칸 header="1")을 이어진 쪽마다 다시 그린다. 쪽마다 적어도 한 행은 놓는다(행보다 낮은 쪽은 잘린다)
  const startPage = ctx.page
  let hdrRows = 0
  if (tbl.getAttribute("repeatHeader") === "1") while (hdrRows < nRows && cells.some(c => c.ra === hdrRows) && cells.filter(c => c.ra === hdrRows).every(c => c.el.getAttribute("header") === "1")) hdrRows++
  // 행 조각 계획 — 칸 안 나눔(CELL) 표는 행을 칸 줄 경계에서 갈라 다음 쪽에 잇는다(table-pages.ts, 쪽 프리패스와 같은 계획)
  const slack = ctx.geom.PH - ctx.geom.MT - ctx.geom.BODY_H
  // 갈린 칸 안의 떠 있는 표도 쪽에서 가른다(칸 안 중첩 표 — 그 칸 계획이 이 표가 끝나는 쪽을 셌다)
  const splitHere = depth === 1 || (!!ctx.splitCell && findChildByLocalName(tbl, "pos")?.getAttribute("treatAsChar") !== "1")
  const plan = splitHere ? planTableRows(tbl, cells, rowH, ty, ctx.geom.MT, ctx.geom.BODY_H, slack, cellFloatSpan(ctx.geom.MT, ctx.geom.BODY_H, ctx.extentMemo, slack), depth !== 1, depth !== 1 && ctx.splitContMT !== undefined ? ctx.splitContMT : ctx.geom.MT) : rowH.map((h, r) => [{ page: 0, y: ty + rowY[r], h }] as RowPiece[])
  const splitSaved = ctx.splitCell
  ctx.splitCell = false
  for (const pc of plan.flat()) for (const [el, py] of pc.place ?? []) (ctx.objPlace ??= new Map()).set(el, { page: startPage + pc.page, y: py })
  const contPages = [...new Set(plan.flat().map(pc => pc.page).filter(pg => pg > 0))].map(pg => startPage + pg)
  while (ctx.pages.length <= Math.max(startPage, ...contPages)) ctx.pages.push([])
  // 1패스: 배경 → 2패스: 콘텐츠 → 3패스: 테두리 (테두리가 배경/콘텐츠 위)
  type CellGeom = { c: typeof cells[number]; page: number; x: number; y: number; w: number; h: number; pieces?: RowPiece[] }
  const xw = (c: typeof cells[number]) => ({ x: tx + colX[c.ca], w: colX[Math.min(c.ca + c.cs, nCols)] - colX[c.ca] })
  const geom: CellGeom[] = []
  for (const c of cells) {
    const pcs = plan[c.ra]
    if (c.rs === 1 && pcs.length > 1) {
      // 갈린 행 — 조각마다 칸 틀, 내용은 첫 조각에서 조각별로 나눠 그린다
      pcs.forEach((pc, k) => geom.push({ c, page: startPage + pc.page, ...xw(c), y: pc.y, h: pc.h, pieces: k === 0 ? pcs : [] }))
      continue
    }
    // 쪽을 넘는 여러 행 칸 — 쪽마다 그 쪽에 놓인 행만큼 칸 틀, 저장 부분(칸 줄 vertpos 되돌아감)을 쪽 순서대로 나눠 그린다.
    // 부분이 없으면 내용은 첫 쪽 틀 안에서 맞춘다(같은 판 PDF: 네 행 칸 "2.4 광커플러" 가 앞 쪽 몫 가운데, 다음 쪽은 빈 틀)
    if (c.rs > 1) {
      const span = plan.slice(c.ra, Math.min(c.ra + c.rs, nRows)).flat()
      const pages = [...new Set(span.map(pc => pc.page))]
      if (pages.length > 1) {
        const bs = cellLineBoxes(c)
        const partTop = (k: number) => bs.find(b => b.part === k)
        const groups: RowPiece[] = pages.map((pg, k) => {
          const on = span.filter(pc => pc.page === pg)
          const y0 = Math.min(...on.map(pc => pc.y)), y1 = Math.max(...on.map(pc => pc.y + pc.h))
          const from = k === 0 ? 0 : partTop(k)?.origin ?? Number.POSITIVE_INFINITY
          const to = k === pages.length - 1 ? Number.POSITIVE_INFINITY : partTop(k + 1)?.top ?? Number.POSITIVE_INFINITY
          return { page: pg, y: y0, h: y1 - y0, range: new Map([[c.el, [from, to] as [number, number]]]) }
        })
        groups.forEach((pc, k) => geom.push({ c, page: startPage + pc.page, ...xw(c), y: pc.y, h: pc.h, pieces: k === 0 ? groups : [] }))
        continue
      }
    }
    const h = c.rs === 1 ? pcs[0].h : rowY[Math.min(c.ra + c.rs, nRows)] - rowY[c.ra]
    geom.push({ c, page: startPage + pcs[0].page, ...xw(c), y: pcs[0].y, h })
  }
  // 반복 머리 행은 이어진 쪽 표 위에 — 갈린 칸 안 표면 그 칸 내용 위(splitContMT)에서
  const contBase = depth !== 1 && ctx.splitContMT !== undefined ? ctx.splitContMT : ctx.geom.MT
  for (const page of contPages) for (const c of cells) if (c.ra < hdrRows) geom.push({ c, page, ...xw(c), y: contBase + num(findChildByLocalName(tbl, "outMargin"), "top") + rowY[c.ra], h: rowY[Math.min(c.ra + c.rs, nRows)] - rowY[c.ra] })
  for (const g of geom) {
    ctx.page = g.page
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : undefined
    if (bf?.fill) emit(ctx, `<rect x="${pt(g.x)}" y="${pt(g.y)}" width="${pt(g.w)}" height="${pt(g.h)}" fill="${escapeXml(bf.fill)}"/>`)
  }
  for (const g of geom) {
    const { c } = g
    if (!c.sub || (g.pieces && g.pieces.length === 0)) continue
    ctx.page = g.page
    if (g.pieces) {
      // 갈린 칸 — 줄마다 그 줄이 든 조각의 쪽·위치로(첫 조각 위 기준 vertpos 로 잠시 바꿔 그린 뒤 되돌린다)
      const base = g.pieces[0].y + c.marginT
      const boxes = cellLineBoxes(c)
      const contV = new Map(boxes.map(b => [b.seg, b.top]))
      const pieceOf = (v: number): number => Math.max(0, g.pieces!.findIndex(pc => { const r = pc.range?.get(c.el); return !!r && v >= r[0] && v < r[1] }))
      // 세로 가운데·아래 칸은 첫 쪽 조각이 그 조각 내용([조각 원점, 마지막 줄 바닥])을 조각 안에서 맞춘다(한컴 PDF: 두 쪽에 갈린 가운데 칸의 첫 쪽이 8pt 내려옴).
      // 가운데 조각은 저장 vertpos 자리 그대로다(같은 판이 저장·인쇄한 PDF: 가운데 칸 둘째 쪽부터 글이 저장 자리 — 서식 3개·쪽 40개 넘는 칸 하나)
      const va = c.sub.getAttribute("vertAlign") ?? "TOP"
      // 마지막 조각은 칸 저장 몫으로 내용보다 클 수 있다(두 쪽 나눔) — 그 남는 높이 안에서 맞춘다(같은 판 PDF: 마지막 조각 글이 남는 몫의 절반 아래)
      const lastK = g.pieces.length - 1
      const pieceOff = g.pieces.map((pc, k) => {
        if (va === "TOP" || (k > 0 && k < lastK) || pc.fill) return 0
        const from = pc.range?.get(c.el)?.[0] ?? 0
        const bottoms = boxes.filter(b => pieceOf(b.top) === k).map(b => b.bottom - from)
        if (k > 0) for (const f of subFloatBottoms(c.sub!)) { const b = boxes.find(x => x.seg === f.seg); if (b && pieceOf(b.top) === k) bottoms.push(b.top + f.bottom - f.v0 - from) }
        if (!bottoms.length) return 0
        const free = pc.h - c.marginT - c.marginB - Math.max(...bottoms)
        return Math.max(0, va === "CENTER" ? free / 2 : free)
      })
      for (const p of elements(c.sub)) {
        if (ln(p) !== "p") continue
        const lsa = findChildByLocalName(p, "linesegarray"), segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
        const saved = segs.map(sg => sg.getAttribute("vertpos"))
        const pages = segs.map(sg => {
          const v = contV.get(sg) ?? num(sg, "vertpos")
          const k = pieceOf(v)
          const pc = g.pieces![k], from = pc.range?.get(c.el)?.[0] ?? 0
          sg.setAttribute("vertpos", String(v - from + pc.y + c.marginT + pieceOff[k] - base))
          return startPage + pc.page
        })
        ctx.splitCell = splitHere
        // 이 칸 안 표가 이어지는 쪽의 시작 — 바깥 표의 이어진 쪽 위(머리 행 아래) + 칸 위 여백
        const contMTSaved = ctx.splitContMT
        // 겹친 중첩이면 바깥 겹이 이어진 쪽에서 시작하는 자리부터 쌓는다(이 표가 갈린 칸 안 표면 그 칸 내용 위)
        ctx.splitContMT = (depth > 1 && contMTSaved !== undefined ? contMTSaved : ctx.geom.MT) + num(findChildByLocalName(tbl, "outMargin"), "top") + rowY[hdrRows] + c.marginT
        drawPara(p, g.x + c.marginL, base, g.w - c.marginL - c.marginR, ctx, depth + 1, pages)
        ctx.splitContMT = contMTSaved
        ctx.splitCell = false
        segs.forEach((sg, i) => sg.setAttribute("vertpos", saved[i] ?? "0"))
      }
      continue
    }
    // 칸보다 넓은 인라인 개체는 칸 경계에서 잘린다(한컴 PDF: 칸 폭 157pt 칸의 167pt 사진이 칸 안쪽까지만 보인다)
    const innerW = g.w - c.marginL - c.marginR
    const overWide = elements(c.sub).some(q => ln(q) === "p" && buildPara(q).objs.some(o => o.inline && o.tag === "pic" && o.width > innerW + 50))
    if (overWide) {
      const cid = `cclip${ctx.defs.length}`
      ctx.defs.push(`<clipPath id="${cid}"><rect x="${pt(g.x)}" y="${pt(g.y)}" width="${pt(g.w)}" height="${pt(g.h)}"/></clipPath>`)
      emit(ctx, `<g clip-path="url(#${cid})">`)
    }
    const innerH = g.h - c.marginT - c.marginB
    const extent = cellContentExtent(c, ctx.extentMemo)
    const va = c.sub.getAttribute("vertAlign") ?? "TOP"
    let yoff = 0
    if (va === "CENTER") yoff = Math.max(0, (innerH - extent) / 2)
    else if (va === "BOTTOM") yoff = Math.max(0, innerH - extent)
    // 칸 안 다단 — 줄 vertpos 가 되돌아갈 때마다 다음 단: 그 줄들을 단 폭 + 간격만큼 오른쪽에 그린다(줄 horzpos 를 잠시 옮긴다)
    // (한컴 PDF: 2단 칸의 17~31번 항목이 오른쪽 단)
    const cols = cellColumns(c.sub)
    const moved: Array<[Element, string | null]> = []
    if (cols) {
      const colW = (innerW - cols.gap * (cols.n - 1)) / cols.n
      let col = 0, prevV = Number.NEGATIVE_INFINITY
      for (const p of elements(c.sub)) if (ln(p) === "p") {
        const lsa = findChildByLocalName(p, "linesegarray")
        for (const sg of lsa ? elements(lsa) : []) if (ln(sg) === "lineseg") {
          const v = num(sg, "vertpos")
          if (v < prevV) col = Math.min(cols.n - 1, col + 1)
          prevV = v
          if (col > 0) { moved.push([sg, sg.getAttribute("horzpos")]); sg.setAttribute("horzpos", String(num(sg, "horzpos") + Math.round(col * (colW + cols.gap)))) }
        }
      }
    }
    for (const p of elements(c.sub)) {
      if (ln(p) !== "p") continue
      drawPara(p, g.x + c.marginL, g.y + c.marginT + yoff, g.w - c.marginL - c.marginR, ctx, depth + 1)
    }
    for (const [sg, hp] of moved) sg.setAttribute("horzpos", hp ?? "0")
    if (overWide) { ctx.page = g.page; emit(ctx, "</g>") }
  }
  for (const g of geom) {
    ctx.page = g.page
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : undefined
    if (!bf) continue
    if (bf.top) emit(ctx, edgeLine(g.x, g.y, g.x + g.w, g.y, bf.top))
    if (bf.bottom) emit(ctx, edgeLine(g.x, g.y + g.h, g.x + g.w, g.y + g.h, bf.bottom))
    if (bf.left) emit(ctx, edgeLine(g.x, g.y, g.x, g.y + g.h, bf.left))
    if (bf.right) emit(ctx, edgeLine(g.x + g.w, g.y, g.x + g.w, g.y + g.h, bf.right))
  }
  ctx.page = startPage
  ctx.splitCell = splitSaved
  ctx.parentStack.pop()
  emit(ctx, "</g>")
}

// ─── 이미지 ───────────────────────────────────────

/**
 * 이미지 심볼 등록(바이너리당 1회) — dataURI를 defs에 한 번만 넣고 <use>로 참조한다.
 * occurrence마다 dataURI를 재emit하면 반복 참조 문서에서 SVG 문자열이 기하급수로
 * 커져 RangeError/OOM (소형 입력 DoS). viewBox 100×100 + preserveAspectRatio none
 * 이라 <use width/height>가 기존 <image width/height> stretch와 동일하게 스케일된다.
 */
function imageSymbol(loaded: { dataUri: string; symId?: string }, ctx: Ctx): string {
  if (!loaded.symId) {
    loaded.symId = `bin${ctx.defs.length}`
    ctx.defs.push(
      `<symbol id="${loaded.symId}" viewBox="0 0 100 100" preserveAspectRatio="none">` +
      `<image width="100" height="100" preserveAspectRatio="none" href="${loaded.dataUri}"/></symbol>`,
    )
  }
  return loaded.symId
}

function drawPic(pic: Element, x: number, y: number, ctx: Ctx): void {
  const sz = findChildByLocalName(pic, "sz")
  let w = num(sz, "width", 5669), h = num(sz, "height", 5669)
  // 돌린 사진 — sz 는 돌린 외접 상자, 그림은 curSz 틀로 그 상자 중심에 놓고 돌린다 (objectGeometry, #116)
  const cur = findChildByLocalName(pic, "curSz")
  const rotated = objectGeometry(pic, x, y, num(cur, "width") || w, num(cur, "height") || h, w, h)
  if (rotated.rotation) { x = rotated.x; y = rotated.y; w = rotated.w; h = rotated.h; ctx.regionRotations.push(rotated.rotation) }
  drawPicFrame(pic, x, y, w, h, rotated.transform, ctx)
  if (rotated.rotation) ctx.regionRotations.pop()
}

function drawPicFrame(pic: Element, x: number, y: number, w: number, h: number, transform: string, ctx: Ctx): void {
  const img = findFirst(pic, "img")
  const ref = img?.getAttribute("binaryItemIDRef")
  const loaded = ref != null ? ctx.images.get(ref) : undefined
  const imgId = ctx.regions.add("image", bboxOf(ctx, x, y, w, h), { sourceId: ref ?? undefined, parentId: parentId(ctx) })
  emit(ctx, regionOpenTag(imgId, "image", pageNo(ctx)))
  const close = transform ? "</g></g>" : "</g>"
  if (transform) emit(ctx, `<g transform="${transform}">`)
  if (!loaded) {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" fill="#eee" stroke="#c00" stroke-width="0.5"/>`)
    warnOnce(ctx, `img:${ref}`, `이미지 바이너리 누락: ${ref ?? "(ref 없음)"}`)
    emit(ctx, close)
    return
  }
  ctx.stats.images++
  // imgClip 좌표계는 imgDim(이미지 내용 상자) 기준이다 — orgSz(최초 삽입 크기)가 아니다.
  // 실측(데모 코퍼스 pic 267개): clip==dim 254개(크롭 없음)·실제 크롭 8개 모두 dim 기준.
  // orgSz 로 비교하면 리사이즈된 로고(dim<org)가 좌상단 코너로 잘못 잘려 로고가 깨진다.
  const clip = findChildByLocalName(pic, "imgClip")
  const imgDim = findChildByLocalName(pic, "imgDim")
  const orgSz = findChildByLocalName(pic, "orgSz")
  const dimW = num(imgDim, "dimwidth"), dimH = num(imgDim, "dimheight")
  // 참조(전체 내용) 공간: imgDim 우선, 없으면 orgSz 폴백
  const refW = dimW > 0 ? dimW : num(orgSz, "width")
  const refH = dimH > 0 ? dimH : num(orgSz, "height")
  const cl = num(clip, "left"), ct = num(clip, "top")
  const cr = num(clip, "right", refW), cb = num(clip, "bottom", refH)
  const cropped =
    refW > 0 && refH > 0 && clip != null && (cl > 0 || ct > 0 || cr < refW || cb < refH) && cr > cl && cb > ct
  const symId = imageSymbol(loaded, ctx)
  if (cropped) {
    // 참조 좌표계 viewBox로 크롭 창을 내고, 이미지는 전체 내용 크기로 깐다
    emit(ctx,
      `<svg x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" viewBox="${pt(cl)} ${pt(ct)} ${pt(cr - cl)} ${pt(cb - ct)}" preserveAspectRatio="none">` +
      `<use href="#${symId}" x="0" y="0" width="${pt(refW)}" height="${pt(refH)}"/></svg>`,
    )
  } else {
    emit(ctx, `<use href="#${symId}" x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"/>`)
  }
  emit(ctx, close)
}

function sniffMime(name: string, bytes: Uint8Array): string {
  const lower = name.toLowerCase()
  if (lower.endsWith(".png") || (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50)) return "image/png"
  if (lower.endsWith(".bmp") || (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)) return "image/bmp"
  if (lower.endsWith(".gif") || (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) return "image/gif"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  return "image/jpeg"
}

// ─── 엔트리 ───────────────────────────────────────

/** 구역 하나의 페이지 지오메트리 (HWPUNIT) */
function readSectionGeom(root: Element): PageGeom {
  const pagePr = findFirst(root, "pagePr")
  const margin = pagePr ? findChildByLocalName(pagePr, "margin") : null
  let PW = num(pagePr, "width", 59528), PH = num(pagePr, "height", 84188)
  // 용지 방향 — width/height는 용지 원방향(세로) 치수로 저장되고 landscape="NARROWLY"가
  // 가로(90° 회전)를 뜻한다(WIDELY=세로). 무시하면 가로 문서의 오른쪽이 잘린다
  // (실측: 가로 A4 문서 lineseg 줄폭 78520 = 84188 − 좌우마진, 세로폭 59528 초과).
  if (pagePr?.getAttribute("landscape") === "NARROWLY" && PW < PH) {
    const t = PW; PW = PH; PH = t
  }
  // 제본 여백(gutter) — 왼쪽(LEFT_ONLY·맞쪽 홀수 쪽) 또는 위(TOP_BOTTOM)에 더해 본문을 줄인다
  // (한컴 PDF: 왼쪽 5669 + 제본 500 문서의 본문 그림 x 61.7pt, 저장 줄 폭 47688 = 59528 − 5669×2 − 500 을 4 단위로)
  const gutterType = pagePr?.getAttribute("gutterType") ?? "LEFT_ONLY", gutter = num(margin, "gutter", 0)
  const gL = gutterType === "TOP_BOTTOM" ? 0 : gutter, gT = gutterType === "TOP_BOTTOM" ? gutter : 0
  const ML = num(margin, "left", 8504) + gL
  const MT = num(margin, "top", 5668) + num(margin, "header", 0) + gT
  const BODY_H = PH - MT - num(margin, "bottom", 4252) - num(margin, "footer", 0)
  const BODY_W = PW - ML - num(margin, "right", 8504)
  // 맞쪽 — 짝수 쪽은 좌우 여백이 바뀐다(제본 여백은 안쪽 = 짝수 쪽 오른쪽). 한컴 PDF: 왼쪽 7086·오른쪽 14173 교재의 짝수 쪽 그림이 70.9pt 오른쪽
  const mirrorDx = gutterType === "LEFT_RIGHT" ? num(margin, "right", 8504) - ML : 0
  return { PW, PH, ML, MT, BODY_W, BODY_H, ...(mirrorDx ? { mirrorDx } : {}) }
}

/** 렌더된 구역 — 페이지 버퍼 + 페이지 크기(구역별 pagePr 상이 가능) */
interface RenderedSection { pages: string[][]; PW: number; pageH: number; clipId: string }

/**
 * 구역 하나를 렌더 → 페이지 버퍼. 공유 자원(styles/images/defs/warnings/stats)은 ctx로 넘겨
 * 이미지 심볼·통계·경고가 전 구역에 누적되게 한다(dataURI 중복·페이지 카운트 정합).
 */
/** 최상위 문단 캐시가 쓸 수 없는지 — 쪽 나누기 없이 vertpos 0 인 문단이 셋 이상 잇달고, 그 앞 문단들 높이 합이 본문 높이 절반 이하 */
function staleTopCache(root: Element, BODY_H: number): boolean {
  if (BODY_H <= 0) return false
  let run = 0, sum = 0
  for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    const lsa = findChildByLocalName(p, "linesegarray")
    const segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
    if (!segs.length) continue
    const v = num(segs[0], "vertpos")
    if (v !== 0 || p.getAttribute("pageBreak") === "1" || p.getAttribute("columnBreak") === "1") { run = 0; sum = 0; continue }
    if (run >= 2 && sum <= BODY_H / 2) return true
    const last = segs[segs.length - 1]
    sum += num(last, "vertpos") + num(last, "vertsize") + num(last, "spacing")
    run++
  }
  return false
}

/**
 * 조판 캐시가 쪽 절대 좌표로 적혔는지 — 왼 여백 자리 이후에서 시작해 본문 폭을 넘는 최상위 줄이 셋 이상이고 줄의 1/5 이상.
 * 본문 기준 캐시의 줄은 본문 폭 안이다(쪽 기준으로 적은 문서: 줄 시작 7090·9185 = 왼 여백 6750 + 들여쓰기, 줄 끝 54110 > 본문 폭 47800)
 */
function absoluteTopCache(root: Element, ML: number, BODY_W: number): boolean {
  let tot = 0, over = 0
  for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    const lsa = findChildByLocalName(p, "linesegarray")
    for (const sg of lsa ? elements(lsa) : []) {
      if (ln(sg) !== "lineseg" || num(sg, "horzsize") <= 0) continue
      tot++
      const hp = num(sg, "horzpos")
      if (hp >= ML - 500 && hp + num(sg, "horzsize") > BODY_W + 500) over++
    }
  }
  return over >= 3 && over * 5 >= tot
}

function renderSectionToPages(
  root: Element,
  geom: PageGeom,
  ctxBase: Omit<Ctx, "pages" | "page" | "geom" | "pageH" | "paintJobs" | "regionRotations">,
  doReflow: boolean,
  reflowMode: WrapMode,
  masters: Element[] = [],
  hasDeletionMarkers = true,
  lastSection = true,
): { pages: string[][]; pageH: number } {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = geom
  // Tier-2 reflow — 캐시 없는 문단에 linesegarray 합성 주입. 혼합 캐시 문서(한컴
  // 저장본을 프로그램 편집해 일부 문단만 캐시 없음)도 reflow 옵션이면 진입한다 —
  // 전량 캐시 문서는 전 문단 skip(Tier-1 무회귀)이라 no-op.
  if (hasDeletionMarkers) prepareDeletedRanges(root)
  // 망가진 조판 캐시 — 쪽 나누기 없는 최상위 문단이 셋 이상 잇달아 vertpos 0 인데 앞 문단들 높이 합이 쪽 절반도 안 되면 한컴 캐시일 수 없다
  // (rhwp 시험 문서: 전 문단 vertpos 0 → 문단마다 새 쪽 33쪽, 한컴 PDF 2쪽). 최상위 문단 캐시를 버리고 다시 조판한다
  const degenerate = staleTopCache(root, BODY_H)
  if (degenerate) {
    for (const p of elements(root)) if (ln(p) === "p") { const lsa = findChildByLocalName(p, "linesegarray"); if (lsa) p.removeChild(lsa) }
    ctxBase.warnings.push("조판 캐시가 맞지 않아(최상위 문단이 모두 같은 자리) 다시 조판해 렌더")
  }
  // 쪽 절대 좌표로 적힌 캐시 — 본문·칸·글상자 줄이 모두 쪽 기준이라(칸 줄 시작 24610, 글상자 줄 = 상자 쪽 위치) 전부 버리고 다시 조판한다.
  // 그대로 쓰면 본문이 왼 여백만큼 오른쪽으로 밀려 잘리고 글상자 글은 상자 좌표의 두 배 자리(쪽 밖)에 그려졌다
  const absolute = !degenerate && absoluteTopCache(root, ML, BODY_W)
  if (absolute) {
    for (const lsa of Array.from(root.getElementsByTagName("*") as unknown as Element[]).filter(e => ln(e) === "linesegarray")) lsa.parentNode?.removeChild(lsa)
    ctxBase.warnings.push("조판 캐시가 쪽 기준 좌표로 적혀 있어 다시 조판해 렌더")
  }
  // 캐시 없는 최상위 문단이 섞인 문서(한컴 저장본에 개체만 든 문단 하나가 캐시 없이 남은 경우 등) — reflow 는 캐시 있는 문단은 그대로 두고
  // 없는 문단만 흐름 위치에 채운다. 종전엔 그 문단 개체를 쪽 맨 위(문단 원점)에 그렸다(보도자료 끝 로고 표가 1쪽 위에)
  // 칸·글상자·머리말 안 문단도 본다(한컴 저장본 꼬리말 글상자 문단이 캐시 없이 남아 그 안 표가 바깥 여백 없이 그려지던 것)
  const mixed = !doReflow && !degenerate && !absolute && Array.from(root.getElementsByTagName("*") as unknown as Element[]).some(p => ln(p) === "p" && !findChildByLocalName(p, "linesegarray"))
  if (doReflow || degenerate || absolute || mixed) reflowSection(root, ctxBase.styles, { BODY_W, BODY_H }, reflowMode)

  // 페이지 분할 프리패스 — 최상위 lineseg vertpos는 페이지 로컬(페이지마다 0부터)이라
  // 역행 지점이 곧 페이지 경계다. 다단(colCount>1)은 단 이동도 vertpos가 리셋되지만
  // horzpos가 오른쪽으로 점프하므로, horzpos가 왼쪽으로 돌아올 때만 새 페이지로 본다.
  // vertpos "동일"도 문단 첫 seg + horzpos 비전진이면 경계다 — 페이지 전체가 표 하나인
  // 문단이 연속되면 vertpos가 매 페이지 0으로 같아서 strict 역행만으론 못 가른다
  // (의사일정표류: v0 문단 연속 → 뒤 페이지들이 전부 한 페이지에 겹침).
  // 문단 내부의 vertpos 동일 seg는 개체 좌우로 갈라진 같은 줄(h 우측 점프)이라 제외.
  const colPr = findFirst(root, "colPr")
  const multiCol = num(colPr, "colCount", 1) > 1
  // 다단 lineseg 의 horzpos 는 단 기준 지역 좌표일 수 있다(한컴 저장 2단 시험지: 오른쪽 단도 horzpos 0) — 그러면 vertpos 리셋마다 단을 세고
  // 단 오프셋을 더해 그린다. 단 오프셋이 이미 든 문서(오른쪽 단 horzpos ≥ 단 폭)는 종전대로 horzpos 가 왼쪽으로 돌아올 때 새 쪽
  const nCol = multiCol ? num(colPr, "colCount", 1) : 1, colGap = multiCol ? num(colPr, "sameGap", 0) : 0
  const colW = (BODY_W - colGap * (nCol - 1)) / nCol
  let localCols = multiCol
  if (multiCol) for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    const lsa = findChildByLocalName(p, "linesegarray")
    for (const s of lsa ? elements(lsa) : []) if (ln(s) === "lineseg" && num(s, "horzpos") >= colW) { localCols = false; break }
    if (!localCols) break
  }
  const paraSegPages = new Map<Element, number[]>()
  const paraTops = new Map<Element, number>()
  /** 앞 쪽 끝에서 시작해 이 쪽으로 넘어온 떠 있는 표 — 쪽·위(그리기가 그 자리에 그린다) */
  const backPlace = new Map<Element, { page: number; y: number }>()
  const geom0 = ctxBase.styles.paraGeom
  /** 본문 표가 이어지는 마지막 쪽 */
  let tableEndPage = -1
  let nPages = 1
  let maxTopV = 0
  {
    let prevV = Number.NEGATIVE_INFINITY
    let prevH = Number.NEGATIVE_INFINITY
    // 앞 줄의 끝(vertpos + vertsize + spacing) — 같은 vertpos 가 다시 와도 앞 줄이 그 자리에서 끝났으면(줄간격 음수로 겹친 줄) 새 쪽이 아니다.
    // 쪽 아래쪽의 같은 vertpos 도 새 쪽이 아니다 — 첫 빈 줄 감추기로 쪽 바닥 아래에 남긴 빈 문단들은 한 자리에 겹쳐 저장된다
    let prevEnd = Number.NEGATIVE_INFINITY
    let cur = 0, col = 0
    /** 쪽을 넘는 표가 끝나는 쪽 — 그 뒤 첫 쪽 리셋은 여기로 */
    let pendingEnd = 0, pendingEndY = 0
    let lastEnd = 0, lastPage = -1
    /** 앞 문단 아래 간격 — 문단 영역 위는 앞 문단 끝 + 이 간격(한컴 저장본: 아래 간격 600 뒤 문단의 떠 있는 표가 그 자리 + vertOffset) */
    let lastSA = 0
    /** 바로 앞 줄 — 쪽 바닥을 넘친 줄을 새 쪽으로 옮길 때 */
    let prevSeg: { s: Element; p: Element; pages: number[]; idx: number; vs: number; sp: number } | undefined
    for (const p of elements(root)) {
      if (ln(p) !== "p") continue
      const lsa = findChildByLocalName(p, "linesegarray")
      const segEls = lsa ? elements(lsa).filter(s => ln(s) === "lineseg") : []
      const pagesOf: number[] = []
      let paraFirst = true
      for (const s of segEls) {
        const v = num(s, "vertpos")
        const h = num(s, "horzpos")
        if (localCols) {
          // 지역 좌표 다단 — 리셋마다 다음 단, 마지막 단 다음은 새 쪽
          if (v < prevV || (paraFirst && v === prevV && h <= prevH && v === 0 && prevEnd > v)) {
            // 쪽 나누기 문단은 남은 단을 건너 새 쪽
            if (paraFirst && p.getAttribute("pageBreak") === "1") { col = 0; cur++ } else if (++col >= nCol) { col = 0; cur++ }
          }
          if (col > 0) s.setAttribute("horzpos", String(h + Math.round(col * (colW + colGap))))
        } else {
          if (paraFirst && pendingEnd > cur) {
            // 앞 문단의 표가 쪽을 넘어 pendingEnd 쪽에서 끝났다 — 이 문단은 그 쪽(표 끝 아래), 표 끝보다 위에 저장돼 있으면 다음 쪽
            cur = v < pendingEndY - 100 ? pendingEnd + 1 : pendingEnd
            pendingEnd = 0
          } else {
            const brk = v < prevV
              ? (!multiCol || h <= prevH)
              : (v === prevV && h <= prevH && prevEnd > v && v < BODY_H / 2)
            // 쪽 나누기 문단은 저장 vertpos 가 되돌아가지 않았어도 새 쪽 — 한컴 PDF: 쪽 나누기 목차 문단이 vertpos 1500 으로 저장돼도 다음 쪽 맨 위
            // 본문 아래쪽에 저장된 쪽 나누기 문단도 첫 줄이 제 위아래 개체에 밀린 자리(= 바깥 위 + 높이 + 바깥 아래, 새 쪽 맨 위 기준)면 새 쪽 —
            // 한컴 PDF: 줄 64320·66927 이 표 64038·66645(+바깥 여백)에 밀린 서식 표가 둘 다 다음 쪽 맨 위
            const pbrk = !brk && paraFirst && prevV !== Number.NEGATIVE_INFINITY && p.getAttribute("pageBreak") === "1" &&
              (v < BODY_H / 2 || buildPara(p).objs.some(o => !o.inline && (o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM" &&
                (findChildByLocalName(o.el, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA" && linePushedBy(o, v, 0)))
            // 쪽 위쪽에서 앞 줄 끝보다 위에 시작하는 첫 줄은, 둘을 합치면 본문 높이를 넘으면 새 쪽이다 — 한컴은 쪽마다 쪽을 채우는
            // 인라인 표를 vertpos 0·700 으로 저장한다(한컴 PDF 2쪽, 0 으로 되돌아가지 않아 1쪽에 겹쳐 그리던 것)
            const obrk = !brk && !pbrk && !multiCol && paraFirst && v > prevV && v < prevEnd - 100 && prevEnd + num(s, "vertsize") > BODY_H && v < BODY_H / 2
            if (brk || pbrk || obrk) cur++
            // 쪽 바닥을 넘친 줄 다음에서 쪽이 바뀌고 그다음 줄이 그 줄을 새 쪽 맨 위에 둔 자리면(vertpos = 앞 줄 높이 + 간격), 넘친 줄도 새 쪽 맨 위다
            // — 한컴은 그 줄 vertpos 를 앞 쪽 값(73135, 본문 높이 72852)으로 저장하고 PDF 에선 다음 쪽 맨 위에 찍는다
            if (brk && prevSeg && prevV + prevSeg.vs > BODY_H && v === prevSeg.vs + prevSeg.sp && prevSeg.pages[prevSeg.idx] === cur - 1) {
              prevSeg.pages[prevSeg.idx] = cur
              prevSeg.s.setAttribute("vertpos", "0")
              if (prevSeg.idx === 0) paraTops.set(prevSeg.p, 0)
              if (prevSeg.p !== p) { lastPage = cur; lastEnd = v; lastSA = 0 }
            }
          }
        }
        paraFirst = false
        pagesOf.push(cur)
        prevSeg = { s, p, pages: pagesOf, idx: pagesOf.length - 1, vs: num(s, "vertsize"), sp: num(s, "spacing") }
        maxTopV = Math.max(maxTopV, v + num(s, "textheight", 1000))
        prevV = v
        prevH = h
        prevEnd = v + num(s, "vertsize") + num(s, "spacing")
      }
      paraSegPages.set(p, pagesOf)
      const prevEnd0 = lastEnd, prevPage0 = lastPage
      if (segEls.length) paraTops.set(p, pagesOf[0] === lastPage ? lastEnd + lastSA : 0)
      if (segEls.length) { const ls = segEls[segEls.length - 1]; lastEnd = num(ls, "vertpos") + num(ls, "vertsize") + num(ls, "spacing"); lastPage = pagesOf[pagesOf.length - 1]; lastSA = geom0.get(p.getAttribute("paraPrIDRef") ?? "")?.spaceAfter ?? 0 }
      // 이 문단의 본문 표가 쪽을 넘어 이어지면, 다음 쪽 리셋은 표가 끝나는 쪽으로
      if (!localCols && segEls.length) {
        const m0 = buildPara(p)
        for (const o of m0.objs) {
          if (o.tag !== "tbl") continue
          const pos = findChildByLocalName(o.el, "pos"), om = findChildByLocalName(o.el, "outMargin")
          if (!o.inline && (pos?.getAttribute("vertRelTo") ?? "PARA") !== "PARA") continue
          // 앵커 글자가 든 줄(떠 있는 개체도 — anchorObject 와 같다)
          const segK = Math.max(0, m0.segs.findIndex((sg, k) => sg.textpos <= o.index && (k === m0.segs.length - 1 || m0.segs[k + 1].textpos > o.index)))
          const segV = num(segEls[segK], "vertpos")
          // 떠 있는 표 위치는 anchorObject 와 같은 규칙 — 글을 밀어낸 표(줄이 표 아래에 있음)는 줄 위쪽
          const h = Math.max(o.height, measureTableHeight(o.el, ctxBase.extentMemo)), omT = num(om, "top"), omB = num(om, "bottom")
          const pushed = segV - (omT + h + omB)
          // 새 쪽 첫 줄에 앵커한 위아래 표가 앵커 줄보다 높고, 앞 쪽 끝(앞 문단 끝)에서 시작해 가르면 그 끝이 앵커 줄 바로 위면 — 한컴은 표를 앞 쪽 끝에서
          // 시작해 이 쪽으로 넘기고 앵커 줄을 표 끝 아래에 저장한다(한컴 PDF: 21행 연락처 표가 앞 쪽 13행·이 쪽 8행, 앵커 줄 13086 = 8행 + 바깥 여백)
          if (!o.inline && segK === 0 && pushed < -100 && prevPage0 >= 0 && pagesOf[0] === prevPage0 + 1 && (o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM") {
            const back = tableContPages(o.el, MT + prevEnd0 + omT, MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H, cellFloatSpan(MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H))
            if (back.pages === 1 && Math.abs(back.endY - MT + omB - segV) <= 300) { backPlace.set(o.el, { page: prevPage0, y: MT + prevEnd0 + omT }); continue }
          }
          const nTb = m0.objs.filter(q => !q.inline && (q.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM").length
          // 글을 밀지 않는 개체(어울림·글 앞뒤)는 그리기와 같이 문단 시작 기준(첫 줄이 개체 아래로 밀려 저장됐으면 문단 영역 위 + 위 간격)
          const wrapP = o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM"
          const pTop = paraTops.get(p), sbP = m0.paraPrId != null ? geom0.get(m0.paraPrId)?.spaceBefore ?? 0 : 0
          // 글 없는 문단의 줄 제자리 — 그리기(svg-content)와 같이 개체만큼 밀려 저장된 줄은 빼고
          const stay = nTb < 2 && !m0.objs.some(q => q.inline) && !m0.chars.some(c => c.ch !== "" && !c.nb && c.ch.trim() !== "") &&
            !(!o.inline && wrapP === "TOP_AND_BOTTOM" && linePushedBy(o, segV, pTop))
          const nonPush = wrapP !== "TOP_AND_BOTTOM" && pTop !== undefined && segV > pTop + sbP + 100 ? pTop + sbP : undefined
          const voP = Math.max(0, toInt32(pos?.getAttribute("vertOffset") ?? undefined, 0))
          const paraStart = segK === 0 && pTop !== undefined && pTop < segV ? pTop : segV
          // 오프셋이 앵커 줄 높이 이상인 개체는 줄 아래 — 그리기(anchorObject)와 같다
          const below = !o.inline && wrapP === "TOP_AND_BOTTOM" && voP + omT >= num(segEls[segK], "textheight") && !linePushedBy(o, segV, pTop)
          const ty = o.inline ? MT + segV + omT : nonPush !== undefined ? MT + nonPush + omT + voP : MT + (below ? segV - (segK === 0 ? sbP : 0) : stay ? segV - sbP : pushed - voP >= -100 ? pushed - voP : paraStart) + omT + voP
          const span = tableContPages(o.el, ty, MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H, cellFloatSpan(MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H))
          // 쪽을 넘는 표 아래 앵커 문단의 쪽 리셋 뒤 줄은 표가 끝나는 쪽 다음부터 — 한컴은 앵커 줄을 저장 높이(sz) 기준 표 바닥 아래에 두고,
          // 리셋 뒤 줄은 표가 다 끝난 뒤의 쪽 기준으로 저장한다(한컴 PDF: 칸 글로 세 쪽에 걸친 틀 표(sz 67886) 아래 68223 앵커 줄 뒤
          // 리셋 줄의 인라인 틀 표가 4쪽 맨 위). 리셋이 없는 문단은 다음 문단을 표 끝 쪽으로 보내는 종전 규칙. 표 위 = 앵커 줄 − sz − 바깥 아래 여백
          const anchorPage = pagesOf[segK]
          const sp = !o.inline && !stay && nonPush === undefined && segV - (omT + o.height + omB) >= -100 && pagesOf.some((pg, j) => j > segK && pg > anchorPage)
            ? tableContPages(o.el, MT + segV - o.height - omB, MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H, cellFloatSpan(MT, BODY_H, ctxBase.extentMemo, PH - MT - BODY_H))
            : undefined
          if (sp && sp.pages > 0) {
            for (let j = segK + 1; j < pagesOf.length; j++) if (pagesOf[j] > anchorPage) pagesOf[j] += sp.pages
            cur += sp.pages
            lastPage = pagesOf[pagesOf.length - 1]
            continue
          }
          if (span.pages > 0 && (pagesOf[0] ?? cur) + span.pages > pendingEnd) { pendingEnd = (pagesOf[0] ?? cur) + span.pages; pendingEndY = span.endY - MT }
        }
      }
      nPages = Math.max(nPages, cur + 1, pendingEnd + 1)
      tableEndPage = Math.max(tableEndPage, pendingEnd)
    }
  }

  // 문서 끝의 빈 문단만 든 쪽은 찍지 않는다(한컴 PDF: 쪽 나누기 걸린 빈 끝 문단이 있는 서식 14개가 그 쪽 없이 끝난다 — 구역 사이의 빈 쪽은
  // 찍는다, 편람 양면 간지). 글·개체가 있는 마지막 쪽(이어지는 표 포함)까지만 두고, 그 뒤 빈 문단은 그 쪽에 남긴다
  if (lastSection) {
    let lastContent = -1
    for (const p of elements(root)) {
      if (ln(p) !== "p") continue
      const pg = paraSegPages.get(p)
      if (!pg?.length) continue
      const pm = buildPara(p)
      if (pm.objs.length || pm.chars.some(c => c.ch.trim() !== "" || !!c.ctrlText)) lastContent = Math.max(lastContent, ...pg)
    }
    const contentOnly = lastContent
    lastContent = Math.max(lastContent, tableEndPage)
    // 쪽 나누기 없이 넘어간 빈 끝 문단은, 앞 쪽 내용(개체 포함)이 본문 안에 다 들고 쪽을 넘는 떠 있는 표 때문이 아니면 그 쪽을 찍는다
    // (한컴 PDF: 본문 67918 에 든 인라인 표 66698 뒤 빈 문단 → 2쪽. 본문보다 큰 인라인 표 76123 뒤 빈 문단 → 1쪽)
    let keepTrail = false
    if (lastContent >= 0 && nPages - 1 > lastContent && tableEndPage <= contentOnly) {
      let firstTrail: Element | undefined
      for (const p of elements(root)) if (ln(p) === "p" && (paraSegPages.get(p) ?? []).some(x => x > lastContent)) { firstTrail = p; break }
      let fits = true
      for (const p of elements(root)) {
        if (ln(p) !== "p") continue
        const pg = paraSegPages.get(p)
        if (!pg?.includes(lastContent)) continue
        const pm = buildPara(p)
        pm.segs.forEach((sg, k) => {
          if (pg[k] !== lastContent) return
          let h = sg.textheight
          for (const o of pm.objs) if (o.inline) h = Math.max(h, o.height)
          if (sg.vertpos + h > BODY_H) fits = false
        })
      }
      keepTrail = !!firstTrail && firstTrail.getAttribute("pageBreak") !== "1" && fits
    }
    if (lastContent >= 0 && nPages - 1 > lastContent && !keepTrail) {
      for (const [p, pg] of paraSegPages) if (pg.some(x => x > lastContent)) paraSegPages.set(p, pg.map(x => Math.min(x, lastContent)))
      nPages = lastContent + 1
    }
  }
  // 리셋이 없는데 본문이 페이지를 넘는 파일(누적 vertpos 기록본) 방어 —
  // 한 페이지로 두되 캔버스만 내용 끝까지 늘려 잘림을 막는다. (region 클램프에 쓰므로 그리기 전에 확정)
  const pageH = nPages === 1 ? Math.max(PH, MT + maxTopV + 2000) : PH
  // 미주 배치를 먼저 — 미주로 늘어난 쪽에도 머리말·꼬리말·바탕쪽이 붙는다
  const ens = endNoteLayout(root, paraSegPages, geom)
  const ctx: Ctx = {
    ...ctxBase,
    pages: Array.from({ length: Math.max(nPages, ens?.pageCount ?? 0) }, () => []),
    page: 0,
    geom,
    pageH,
    paintJobs: [],
    regionRotations: [],
  }
  // 맞쪽 짝수 쪽 — 본문·각주·미주는 이동 묶음으로, 바탕쪽·머리말·꼬리말은 영역 원점을 옮긴다(용지 기준 개체는 제자리)
  const mirrorDx = (page: number): number => (geom.mirrorDx && (ctx.pageBase + page + 1) % 2 === 0 ? geom.mirrorDx : 0)
  for (const story of pageStories(root, masters, paraSegPages, ctx.pages.length, ctx.pageBase, geom)) {
    prepareDeletedRanges(story.sub)
    if (doReflow) reflowSection(story.sub, ctx.styles, { BODY_W: story.width, BODY_H: 0 }, reflowMode)
    const draw = (): void => {
      ctx.page = story.page
      for (const p of elements(story.sub)) if (ln(p) === "p") drawPara(p, story.x + mirrorDx(story.page), story.y, story.width, ctx, 0)
    }
    if (story.layer !== undefined) ctx.paintJobs!.push({ page: story.page, layer: story.layer, z: 0, draw })
    else draw()
  }
  ctx.page = 0
  const bodyStart = ctx.pages.map(b => b.length)
  if (geom.mirrorDx) ctx.bodyDx = mirrorDx
  ctx.cols = multiCol ? { w: colW, gap: colGap } : undefined
  ctx.paraTops = paraTops
  if (backPlace.size) ctx.objPlace = new Map([...(ctx.objPlace ?? []), ...backPlace])
  for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    drawPara(p, ML, MT, BODY_W, ctx, 0, paraSegPages.get(p))
  }
  ctx.cols = undefined
  ctx.paraTops = undefined
  // 쪽 아래 각주 — 구분선과 각주 내용(본문 바닥에서 각주 영역만큼 위)
  const notes = footNoteStories(root, paraSegPages, geom)
  for (const r of notes.rules) {
    ctx.page = r.page
    emit(ctx, `<line x1="${pt(r.x)}" y1="${pt(r.y)}" x2="${pt(r.x + r.length)}" y2="${pt(r.y)}" stroke="${escapeXml(r.color)}" stroke-width="${(r.widthMm * 2.834645).toFixed(2)}"/>`)
  }
  for (const story of notes.stories) {
    ctx.page = story.page
    for (const p of elements(story.sub)) if (ln(p) === "p") drawPara(p, story.x, story.y, story.width, ctx, 0)
  }
  // 미주 — 본문 끝 뒤에 단·쪽을 넘기며 흘린다(쪽이 모자라면 늘린다 — 쪽 수는 머리말·바탕쪽 전에 정했다)
  if (ens) {
    for (const r of ens.rules) {
      ctx.page = r.page
      emit(ctx, `<line x1="${pt(r.x)}" y1="${pt(r.y)}" x2="${pt(r.x + r.length)}" y2="${pt(r.y)}" stroke="${escapeXml(r.color)}" stroke-width="${(r.widthMm * 2.834645).toFixed(2)}"/>`)
    }
    // 미주 문단의 떠 있는 개체도 앵커 줄이 든 단 기준(미주 줄 horzpos 에 단 오프셋을 넣었다)
    ctx.cols = multiCol ? { w: colW, gap: colGap } : undefined
    for (const e of ens.paras) drawPara(e.p, ML, MT, BODY_W, ctx, 0, e.pages)
    ctx.cols = undefined
  }
  const wrapMirror = (bufs: string[][], from: (page: number) => number): void => {
    for (let page = 0; page < bufs.length; page++) {
      const dx = mirrorDx(page), at = from(page)
      if (!dx || !bufs[page] || bufs[page].length <= at) continue
      bufs[page].splice(at, 0, `<g transform="translate(${pt(dx)} 0)">`)
      bufs[page].push("</g>")
    }
  }
  ctx.bodyDx = undefined
  wrapMirror(ctx.pages, page => bodyStart[page] ?? 0)
  // 쪽 테두리·단 구분선(미주 쪽 포함), 쪽 번호 — 그 컨트롤이 나온 쪽부터 쪽 아래(또는 위) 여백에 "기호 N 기호". 글자 크기는 10pt 고정,
  // 기준선은 아래 여백 위(한컴 PDF 실측: 글자 모양 크기와 무관하게 9.95pt, 가로 쪽 가운데, 기준선 = 쪽 높이 − 아래 여백 − 약 225). pageHiding hidePageNum 쪽은 뺀다
  const allPages = new Map(paraSegPages)
  for (const e of ens?.paras ?? []) allPages.set(e.p, e.pages)
  drawPageDecor(root, allPages, ctx, localCols ? nCol : 1, colW, colGap)
  drawPageNumbers(root, paraSegPages, ctx)
  ctx.page = 0
  const normal = ctx.pages
  const jobs = ctx.paintJobs!
  ctx.paintJobs = null
  const behind = Array.from({ length: ctx.pages.length }, () => [] as string[])
  const front = Array.from({ length: ctx.pages.length }, () => [] as string[])
  for (const job of jobs.sort((a, b) => a.layer - b.layer || a.z - b.z)) {
    ctx.pages = job.layer < 0 ? behind : front
    const before = ctx.pages.map(b => b.length)
    ctx.bodyDx = job.body ? mirrorDx : undefined
    job.draw()
    ctx.bodyDx = undefined
    if (job.body && geom.mirrorDx) wrapMirror(ctx.pages, page => before[page] ?? 0)
  }
  // 떠 있는 표가 쪽을 넘겨 이어지면 behind/front 쪽 버퍼가 늘어난다 — 세 버퍼 중 가장 긴 쪽 수로 맞춘다
  const total = Math.max(normal.length, behind.length, front.length)
  ctx.pages = Array.from({ length: total }, (_, page) => [...(behind[page] ?? []), ...(normal[page] ?? []), ...(front[page] ?? [])])
  return { pages: ctx.pages, pageH }
}

/**
 * 쪽 테두리(secPr pageBorderFill)와 단 구분선(colPr colLine).
 * 테두리는 용지 가장자리에서 오프셋만큼 안쪽 사각형(한컴 PDF 실측: 오프셋 왼쪽 1984 → x 19.84pt, 위 5669 → y 56.69pt), 쪽 짝·홀은 type 으로 고른다.
 * 단 구분선은 단 사이 가운데에 본문 위부터 그 쪽 마지막 줄 바닥까지(PDF: 두 단 시험지 297.6pt, 68.0 → 쪽마다 내용 끝)
 */
function drawPageDecor(root: Element, paraPages: Map<Element, number[]>, ctx: Ctx, nCol: number, colW: number, colGap: number): void {
  const { PW, PH, ML, MT } = ctx.geom
  const secPr = findFirst(root, "secPr")
  const fills = secPr ? elements(secPr).filter(e => ln(e) === "pageBorderFill") : []
  const pageBottoms = new Map<number, number>()
  if (nCol > 1) for (const p of elements(root)) if (ln(p) === "p") {
    const lsa = findChildByLocalName(p, "linesegarray"), pages = paraPages.get(p) ?? []
    elements(lsa ?? p).filter(e => ln(e) === "lineseg").forEach((seg, k) => {
      const pg = pages[k] ?? pages[0] ?? 0
      pageBottoms.set(pg, Math.max(pageBottoms.get(pg) ?? 0, num(seg, "vertpos") + num(seg, "vertsize")))
    })
  }
  const colPr = findFirst(root, "colPr"), colLine = colPr ? findChildByLocalName(colPr, "colLine") : null
  for (let page = 0; page < ctx.pages.length; page++) {
    const n = ctx.pageBase + page + 1
    // 양쪽(BOTH) 항목이 선·배경을 가지면 그것, 아니면 그 쪽 짝·홀 항목(한컴 저장본은 세 항목을 늘 쓰고, PDF 는 BOTH 테두리를 홀·짝 쪽 모두에 그린다)
    const visible = (f: Element | undefined) => { const b = f ? ctx.styles.borderFill.get(f.getAttribute("borderFillIDRef") ?? "") : undefined; return b && (b.top || b.bottom || b.left || b.right || b.fill) ? b : undefined }
    const both = fills.find(f => (f.getAttribute("type") ?? "BOTH") === "BOTH"), parity = fills.find(f => f.getAttribute("type") === (n % 2 ? "ODD" : "EVEN"))
    const pf = visible(both) ? both : parity
    const bf = visible(pf)
    ctx.page = page
    if (pf && bf && (bf.top || bf.bottom || bf.left || bf.right || bf.fill)) {
      const off = findChildByLocalName(pf, "offset")
      const x0 = num(off, "left"), y0 = num(off, "top"), x1 = PW - num(off, "right"), y1 = PH - num(off, "bottom")
      if (bf.fill && pf.getAttribute("fillArea") !== "NONE") ctx.pages[page].unshift(`<rect x="${pt(x0)}" y="${pt(y0)}" width="${pt(x1 - x0)}" height="${pt(y1 - y0)}" fill="${escapeXml(bf.fill)}"/>`)
      if (bf.top) emit(ctx, edgeLine(x0, y0, x1, y0, bf.top))
      if (bf.bottom) emit(ctx, edgeLine(x0, y1, x1, y1, bf.bottom))
      if (bf.left) emit(ctx, edgeLine(x0, y0, x0, y1, bf.left))
      if (bf.right) emit(ctx, edgeLine(x1, y0, x1, y1, bf.right))
    }
    const bottom = pageBottoms.get(page)
    if (colLine && (colLine.getAttribute("type") ?? "NONE") !== "NONE" && bottom) {
      const edge: RenderBorderEdge = { type: colLine.getAttribute("type") ?? "SOLID", widthPt: (Number.parseFloat(colLine.getAttribute("width") ?? "0.12") || 0.12) * 2.834645, color: colLine.getAttribute("color") ?? "#000000" }
      for (let c = 1; c < nCol; c++) { const x = ML + c * (colW + colGap) - colGap / 2; emit(ctx, edgeLine(x, MT, x, MT + bottom, edge)) }
    }
  }
}

function drawPageNumbers(root: Element, paraPages: Map<Element, number[]>, ctx: Ctx): void {
  let decl: { el: Element; page: number; prId: string | null } | undefined
  const hidden = new Set<number>()
  // 새 번호로 시작(hp:newNum numType="PAGE") — 그 컨트롤이 든 쪽부터 번호를 num 으로 다시 센다(표지·목차 뒤 본문 "- 1 -")
  const restarts: Array<{ page: number; num: number }> = []
  for (const p of elements(root)) if (ln(p) === "p") {
    const page = paraPages.get(p)?.[0] ?? 0
    for (const run of elements(p)) if (ln(run) === "run") for (const ctrl of elements(run)) if (ln(ctrl) === "ctrl") {
      const pn = findChildByLocalName(ctrl, "pageNum"), ph = findChildByLocalName(ctrl, "pageHiding"), nn = findChildByLocalName(ctrl, "newNum")
      if (pn && !decl) decl = { el: pn, page, prId: run.getAttribute("charPrIDRef") }
      if (ph && num(ph, "hidePageNum")) hidden.add(page)
      if (nn && (nn.getAttribute("numType") ?? "PAGE") === "PAGE") restarts.push({ page, num: num(nn, "num", 1) })
    }
  }
  if (!decl) return
  const pos = decl.el.getAttribute("pos") ?? "BOTTOM_CENTER"
  if (pos === "NONE") return
  const side = decl.el.getAttribute("sideChar") ?? ""
  // 글꼴·크기는 "쪽 번호" 스타일의 글자 모양(한컴 PDF: 그 스타일이 굴림이면 굴림, 함초롬돋움이면 함초롬돋움 — 컨트롤이 든 글자 모양과 무관).
  // 크기도 그 스타일 것이다(같은 판 짝: 12pt 스타일 두 문서 모두 PDF 12pt, 10pt 스타일 291문서 10pt). 스타일이 없으면 10pt
  const pnId = ctx.styles.pageNumCharPr ?? decl.prId
  const st = (pnId != null ? ctx.styles.charPr.get(pnId) : undefined) ?? DEFAULT_CHAR
  const { PH, ML, BODY_W } = ctx.geom
  const pagePr = findFirst(root, "pagePr"), margin = pagePr ? findChildByLocalName(pagePr, "margin") : null
  const h = ctx.styles.pageNumCharPr != null ? st.height : 1000
  for (let page = decl.page; page < ctx.pages.length; page++) {
    if (hidden.has(page)) continue
    const restart = restarts.filter(r => r.page <= page).pop()
    const n = restart ? restart.num + page - restart.page : ctx.pageBase + page + 1
    const text = side ? `${side} ${formatHeadNumber(n, decl.el.getAttribute("formatType") ?? "DIGIT")} ${side}` : formatHeadNumber(n, decl.el.getAttribute("formatType") ?? "DIGIT")
    const w = measureTextWidth(text, h, 100, { faceClass: faceClassOf(st.face) })
    // 가운데는 본문 영역 가운데(같은 판 한컴 PDF: 왼 5669·오른 6028 여백 쪽의 "- 1 -" 이 용지 가운데보다 1.8pt 왼쪽)
    const x = /LEFT/.test(pos) ? ML : /RIGHT/.test(pos) ? ML + BODY_W - w : ML + (BODY_W - w) / 2
    // 아래쪽 번호는 꼬리말 영역 바닥(아래 여백 위)에 놓인다 — 꼬리말 영역이 0 이면 아래 여백 가운데 위(한컴 PDF: 아래 2834·꼬리말 0 쪽 번호 기준선 쪽 위에서 825.3pt)
    const y = /^TOP/.test(pos) ? num(margin, "top", 5668) - 225 : num(margin, "footer", 0) > 0 ? PH - num(margin, "bottom", 4252) - 225 : PH - Math.round(num(margin, "bottom", 4252) / 2) - 243
    const attrs = [`x="${pt(x)}"`, `y="${pt(y)}"`, `font-size="${pt(h)}"`]
    if (st.fontFamily) attrs.push(`font-family="${escapeXml(st.fontFamily)}"`)
    ctx.page = page
    emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(text)}</text>`)
  }
}

/** 내부 렌더 산출 — 구역별 페이지 버퍼 + 공유 defs·region. 세로 스택/페이지별 SVG 조립의 공통 입력 */
export interface InternalRender {
  sections: RenderedSection[]
  defs: string[]
  warnings: string[]
  stats: Ctx["stats"]
  regions: RenderRegion[]
}

/** 이미지 참조(binaryItemIDRef) → dataURI (심볼 id 는 렌더 중 발급) */
export type RenderImages = Ctx["images"]

/** 렌더할 구역 DOM — HWPX section*.xml 또는 HWP5 어댑터가 합성한 동형 DOM (hwp5-scene) */
export interface SectionRoot {
  root: Element
  index: number
  masterPages?: Element[]
  /** False only when the source XML proved no deletion markers; custom DOMs default to scanning. */
  hasDeletionMarkers?: boolean
}

export interface SectionRenderInput {
  styles: RenderStyles
  images: RenderImages
  /** 로딩 단계 경고를 이어받아 렌더 경고를 누적한다 */
  warnings: string[]
  reflow: boolean
  reflowMode: WrapMode
  highlights?: string[]
}

/**
 * 구역 DOM 들 → 페이지 버퍼 (포맷 무관 공용 단계). 공유 자원(styles/images/defs/warnings/stats/region)은
 * 전 구역에 누적된다 — 이미지 심볼 dataURI 중복 방지·전역 페이지 번호·결정적 region id.
 */
export function renderSectionRoots(sections: SectionRoot[], input: SectionRenderInput): InternalRender {
  const ctxBase: Omit<Ctx, "pages" | "page" | "geom" | "pageH" | "paintJobs" | "regionRotations"> = {
    draw: { table: drawTable, pic: drawPic, picFrame: drawPicFrame },
    styles: input.styles, images: input.images, defs: [],
    highlights: (input.highlights ?? []).map(s => s.trim().toLowerCase()).filter(s => s.length > 0),
    warnings: input.warnings, warned: new Set(), stats: { texts: 0, images: 0, tables: 0, shapes: 0 },
    extentMemo: { cell: new WeakMap(), table: new WeakMap(), paraGeom: input.styles.paraGeom },
    regions: new RegionCollector(), parentStack: [], pageBase: 0, nums: new Map(),
  }
  const rendered: RenderedSection[] = []
  // 문서 끝의 빈 구역(글·개체 없는 문단만)은 찍지 않는다 — 한컴 PDF: 서식 뒤 빈 구역 둘이 붙은 문서가 서식 2쪽만으로 끝난다.
  // 내용 있는 마지막 구역이 문서의 마지막 구역 역할(끝 빈 쪽 버림)을 한다
  const hasContent = (root: Element): boolean => elements(root).some(p => {
    if (ln(p) !== "p") return false
    const pm = buildPara(p)
    return pm.objs.length > 0 || pm.chars.some(c => c.ch.trim() !== "" || !!c.ctrlText)
  })
  let lastIdx = sections.length - 1
  while (lastIdx > 0 && !hasContent(sections[lastIdx].root)) lastIdx--
  for (const [k, { root, index, masterPages, hasDeletionMarkers }] of sections.entries()) {
    if (k > lastIdx) break
    const geom = readSectionGeom(root)
    const { pages, pageH } = renderSectionToPages(root, geom, ctxBase, input.reflow, input.reflowMode, masterPages, hasDeletionMarkers, k === lastIdx)
    rendered.push({ pages, PW: geom.PW, pageH, clipId: `pgclip${index}` })
    ctxBase.pageBase += pages.length
  }
  if (rendered.length === 0) throw new KordocError("렌더할 구역이 없습니다")
  return { sections: rendered, defs: ctxBase.defs, warnings: input.warnings, stats: ctxBase.stats, regions: ctxBase.regions.regions }
}

const SVG_FONT_FAMILY = `'HCR Batang','함초롬바탕','Hancom Batang',AppleMyungjo,'Noto Serif CJK KR',serif`

/**
 * HWPX(한컴 저장본) → 구역별 페이지 버퍼. 조판 캐시(linesegarray)가 없는 구역은 reflow 옵션으로
 * 합성 조판(없으면 그 구역 생략); 렌더 가능한 구역이 하나도 없으면 KordocError.
 */
async function renderHwpxInternal(input: ArrayBuffer | Uint8Array, options?: RenderSvgOptions): Promise<InternalRender> {
  const maxImg = options?.maxImageBytes ?? 40 * 1024 * 1024
  // 압축폭탄 가드 — 파서 진입점과 동일하게 압축해제 전 central directory 선언 크기를 검사한다.
  // 렌더 이미지 캡은 f.async 로 엔트리를 전량 압축해제한 뒤에야 크기를 보므로, 단일 BinData
  // 압축폭탄(수 GB 선언)이 캡을 우회해 OOM 을 유발하던 것을 원천 차단한다 (reflow-1).
  const ab = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
    : input
  precheckZipSize(ab, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(input)
  } catch {
    throw new KordocError("HWPX(ZIP) 형식이 아닙니다 — 렌더는 HWPX만 지원")
  }
  // 모든 구역 파일 (section0, section1, … — 파서와 같은 번호 순. 이름 정렬이면 section10 이 section2 앞에 온다)
  const secFiles = zip.file(/Contents\/section\d+\.xml$/i).sort((a, b) => compareSectionPaths(a.name, b.name))
  if (secFiles.length === 0) throw new KordocError("Contents/section0.xml 없음 — HWPX가 아니거나 손상됨")

  const warnings: string[] = []
  const headFile = zip.file("Contents/header.xml") ?? zip.file("Contents/head.xml")
  const verFile = zip.file("version.xml")
  const verXml = verFile ? await readZipEntry(verFile, "text") : undefined
  const appMajor = hwpxAppMajor(verXml), appBuild = hwpxAppBuild(verXml)
  const headXml = headFile ? await readZipEntry(headFile, "text") : undefined
  let styles: RenderStyles = headXml
    ? parseRenderStyles(headXml, { appMajor, appBuild })
    : { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map() }
  if (!headFile) warnings.push("header.xml 없음 — 기본 스타일로 렌더")

  // 구역 XML 선로딩 + 크기 가드
  const secXmls: string[] = []
  for (const f of secFiles) {
    const xml = await readZipEntry(f, "text")
    if (xml.length > MAX_DECOMPRESS_SIZE) throw new KordocError("섹션 XML이 허용 크기를 초과")
    secXmls.push(xml)
  }

  // KoPub 이 없는 PC 에서 대체 글꼴로 조판된 문서 — 저장 줄 나눔이 대체 글꼴 폭에 맞으면 그 폭으로 그린다(font-env)
  if (headXml && hasKoPubSubst(headXml)) {
    const alt = parseRenderStyles(headXml, { appMajor, appBuild, substKoPub: true })
    if (kopubSubstituted(secXmls, styles, alt)) styles = alt
  }

  const masterPages = new Map<string, Element>()
  const masterXmls: string[] = []
  for (const file of zip.file(/Contents\/masterpage[^/]*\.xml$/i)) {
    const xml = await readZipEntry(file, "text")
    if (xml.length > MAX_DECOMPRESS_SIZE) throw new KordocError("바탕쪽 XML이 허용 크기를 초과")
    const root = createXmlParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
    if (root && ln(root) === "masterPage") {
      masterPages.set(root.getAttribute("id") || file.name.replace(/^.*\/|\.xml$/g, ""), root)
      masterXmls.push(xml)
    }
  }

  // BinData 매니페스트 (id → href) — content.hpf 우선, 파일명 휴리스틱 폴백
  const binmap = new Map<string, string>()
  const hpf = zip.file(/content\.hpf$/i)[0]
  if (hpf) {
    const man = await readZipEntry(hpf, "text")
    for (const m of man.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhref="(BinData\/[^"]+)"[^>]*>/g)) binmap.set(m[1], m[2])
    for (const m of man.matchAll(/<[^>]*\bhref="(BinData\/[^"]+)"[^>]*\bid="([^"]+)"[^>]*>/g)) binmap.set(m[2], m[1])
  }
  // 참조된 이미지만 선로딩 — 전 구역 ref 합집합 (DOM 워크 전에 async 구간 종료).
  // 장당 캡(maxImg) 외에 개수·누적 바이트 캡 — distinct 다수/대형 반복 참조로
  // 렌더 경로에서만 OOM 가능하던 구멍(파서 경로의 ZIP bomb 가드에 상응)
  const MAX_IMAGE_REFS = 256
  const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024
  const images: Ctx["images"] = new Map()
  const refs = new Set<string>()
  for (const xml of [...secXmls, ...masterXmls]) for (const m of xml.matchAll(/binaryItemIDRef="([^"]+)"/g)) refs.add(m[1])
  let totalImgBytes = 0
  for (const ref of refs) {
    if (images.size >= MAX_IMAGE_REFS) {
      warnings.push(`이미지 ${refs.size}종 중 ${MAX_IMAGE_REFS}종만 로딩 — 개수 한도 초과분 생략`)
      break
    }
    let href = binmap.get(ref)
    if (!href) {
      const cand = zip.file(new RegExp(`BinData/.*${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))[0]
      href = cand?.name
    }
    if (!href) continue
    const f = zip.file(href) ?? zip.file("Contents/" + href)
    if (!f) continue
    const bytes = await readZipEntry(f, "uint8array")
    if (bytes.length > maxImg) {
      warnings.push(`이미지 ${href} ${(bytes.length / 1048576).toFixed(1)}MB — 한도 초과로 생략`)
      continue
    }
    if (totalImgBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
      warnings.push(`이미지 누적 ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1048576)}MB 한도 초과 — 이후 생략`)
      break
    }
    totalImgBytes += bytes.length
    images.set(ref, { dataUri: `data:${sniffMime(href, bytes)};base64,${Buffer.from(bytes).toString("base64")}` })
  }

  // 구역 XML → DOM. 조판 캐시 없는 구역은 reflow 옵션이 없으면 생략
  const roots: SectionRoot[] = []
  let noCacheSkipped = false
  /** 앞 구역까지 정의된 짝수·홀수 쪽 바탕쪽 — 한쪽만 정의한 구역은 나머지 한쪽을 이어받는다 */
  const lastParity = new Map<string, Element>()
  for (let si = 0; si < secXmls.length; si++) {
    const secXml = secXmls[si]
    // 태그 마크업만 매치 — 본문 텍스트에 "linesegarray"가 있어도 캐시로 오판하지 않는다
    // (본문의 <는 XML에서 &lt;로 이스케이프되므로 리터럴 <…linesegarray는 태그뿐)
    const hasCache = /<(?:[A-Za-z][\w.-]*:)?linesegarray[\s/>]/.test(secXml)
    if (!hasCache && !options?.reflow) {
      noCacheSkipped = true
      warnings.push(`구역 ${si}: 조판 캐시 없음 — reflow 옵션 필요, 생략`)
      continue
    }
    const doc = createXmlParser().parseFromString(secXml, "text/xml")
    const root = doc.documentElement as unknown as Element
    if (!root) { warnings.push(`구역 ${si} XML 파싱 실패 — 생략`); continue }
    const secPr = findFirst(root, "secPr")
    const referenced = secPr ? elements(secPr).filter(el => ln(el) === "masterPage").map(el => masterPages.get(el.getAttribute("idRef") || "")).filter((el): el is Element => !!el) : []
    // 짝·홀 쪽 바탕쪽 중 한쪽만 정의한 구역은 다른 쪽을 앞 구역에서 이어받는다(한컴 PDF: 짝수·홀수를 정의한 1구역 뒤 홀수만 정의한
    // 2~10구역의 짝수 쪽마다 1구역 짝수 바탕쪽 머리말 — 짝수를 새로 정의한 11구역부터 바뀜). 양쪽(BOTH)을 정의하면 이어받지 않는다
    const typeOf = (m: Element): string => m.getAttribute("type") || "BOTH"
    const has = (t: string): boolean => referenced.some(m => typeOf(m) === t)
    if (!has("BOTH")) for (const [t, other] of [["EVEN", "ODD"], ["ODD", "EVEN"]] as const) {
      const prev = lastParity.get(t)
      if (prev && !has(t) && has(other)) referenced.unshift(prev)
    }
    for (const m of referenced) if (typeOf(m) === "EVEN" || typeOf(m) === "ODD") lastParity.set(typeOf(m), m)
    if (has("BOTH")) lastParity.clear()
    roots.push({ root, index: si, masterPages: referenced, hasDeletionMarkers: secXml.includes("deleteBegin") || secXml.includes("deleteEnd") })
  }

  if (roots.length === 0) {
    if (noCacheSkipped) {
      throw new KordocError("조판 캐시(linesegarray) 없음 — 한컴에서 저장한 HWPX만 렌더 가능 (reflow 옵션으로 합성 렌더 가능)")
    }
    throw new KordocError("렌더할 구역이 없습니다 — HWPX가 손상되었을 수 있습니다")
  }
  return renderSectionRoots(roots, { styles, images, warnings, reflow: !!options?.reflow, reflowMode: options?.reflowMode ?? "keep", highlights: options?.highlights })
}

/**
 * HWPX(한컴 저장본) → 레이아웃 보존 SVG. **전 구역(section*)을 세로 스택으로** 렌더한다.
 * 조판 캐시(linesegarray)가 없는 구역은 reflow 옵션으로 합성 조판(없으면 그 구역 생략);
 * 렌더 가능한 구역이 하나도 없으면 KordocError.
 */
export async function renderHwpxToSvg(input: ArrayBuffer | Uint8Array, options?: RenderSvgOptions): Promise<RenderSvgResult> {
  const r = await renderHwpxInternal(input, options)
  // 전 구역 페이지를 세로 스택으로 조립 (구역마다 page 크기 상이 가능 → 구역별 clip)
  const GAP = 2400 // 페이지 사이 시각 간격 (24pt)
  const clipDefs: string[] = []
  const groups: string[] = []
  let y = 0
  let maxPW = 0
  let pageNo = 0
  for (const rs of r.sections) {
    maxPW = Math.max(maxPW, rs.PW)
    clipDefs.push(`<clipPath id="${rs.clipId}"><rect x="0" y="0" width="${pt(rs.PW)}" height="${pt(rs.pageH)}"/></clipPath>`)
    for (const buf of rs.pages) {
      pageNo++
      groups.push(
        `<g data-page="${pageNo}" transform="translate(0 ${pt(y)})">` +
        `<rect width="${pt(rs.PW)}" height="${pt(rs.pageH)}" fill="white" stroke="#c9c7c4" stroke-width="0.75"/>` +
        `<g clip-path="url(#${rs.clipId})">\n${buf.join("\n")}\n</g></g>`,
      )
      y += rs.pageH + GAP
    }
  }
  const totalH = Math.max(0, y - GAP)

  // width/height는 pt 단위 명시 — 단위 없는 px로 두면 A4 실물(96dpi 기준)보다 25% 작게 보인다 (v3.10.1)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pt(maxPW)} ${pt(totalH)}" width="${pt(maxPW)}pt" height="${pt(totalH)}pt" font-family="${SVG_FONT_FAMILY}" xml:space="preserve">\n` +
    `<defs>${clipDefs.join("")}${r.defs.join("")}</defs>\n` +
    `${groups.join("\n")}\n</svg>`
  return { svg, width: Math.round(maxPW) / 100, height: Math.round(totalH) / 100, pageCount: pageNo, warnings: r.warnings, stats: r.stats, regions: r.regions }
}

/** 페이지별 독립 SVG 산출 — RenderScene 과 선택 페이지의 standalone SVG (#75 Task 3) */
export interface HwpxPagesResult {
  scene: RenderScene
  /** 페이지 번호(1-based) → standalone SVG. 선택된 페이지만 조립 */
  pageSvgs: Map<number, string>
}

/**
 * 페이지 버퍼 → 페이지별 독립 SVG + RenderScene (포맷 무관 조립 단계). `select` 가 있으면 그 페이지만 조립한다
 * (그리기 자체는 전 페이지 — 조립·래스터가 비싼 단계). 페이지 SVG 는 페이지 로컬 좌표(세로 스택 오프셋 없음),
 * 사용된 이미지 심볼만 defs 에 싣는다.
 */
export function assemblePageSvgs(
  r: InternalRender,
  format: RenderScene["format"],
  select?: Set<number> | ((pageCount: number) => Set<number>),
): HwpxPagesResult {
  const pages: RenderScene["pages"] = []
  const pageSvgs = new Map<number, string>()
  const pageCount = r.sections.reduce((n, rs) => n + rs.pages.length, 0)
  const chosen = typeof select === "function" ? select(pageCount) : select
  let pageNo = 0
  for (const rs of r.sections) {
    for (const buf of rs.pages) {
      pageNo++
      pages.push({ page: pageNo, width: ptNum(rs.PW), height: ptNum(rs.pageH) })
      if (chosen && !chosen.has(pageNo)) continue
      const body = buf.join("\n")
      const used = new Set<string>()
      for (const m of body.matchAll(/href="#(bin\d+)"/g)) used.add(m[1])
      const defs = r.defs.filter(d => { const m = /<symbol id="(bin\d+)"/.exec(d); return m ? used.has(m[1]) : true })
      const clipId = `pgclip${pageNo}`
      pageSvgs.set(pageNo,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pt(rs.PW)} ${pt(rs.pageH)}" width="${pt(rs.PW)}pt" height="${pt(rs.pageH)}pt" font-family="${SVG_FONT_FAMILY}" xml:space="preserve" data-page="${pageNo}">\n` +
        `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${pt(rs.PW)}" height="${pt(rs.pageH)}"/></clipPath>${defs.join("")}</defs>\n` +
        `<rect width="${pt(rs.PW)}" height="${pt(rs.pageH)}" fill="white"/>\n` +
        `<g clip-path="url(#${clipId})">\n${body}\n</g>\n</svg>`)
    }
  }
  const scene: RenderScene = { format, pages, regions: r.regions, warnings: r.warnings, stats: { texts: r.stats.texts, tables: r.stats.tables, images: r.stats.images, shapes: r.stats.shapes } }
  return { scene, pageSvgs }
}

/** HWPX → 페이지별 독립 SVG (#75 Task 3). HWP5 는 hwp5-scene 의 renderHwp5Pages 가 같은 조립 단계를 쓴다 */
export async function renderHwpxPages(
  input: ArrayBuffer | Uint8Array,
  options?: RenderSvgOptions,
  select?: Set<number> | ((pageCount: number) => Set<number>),
): Promise<HwpxPagesResult> {
  const r = await renderHwpxInternal(input, options)
  return assemblePageSvgs(r, "hwpx", select)
}
