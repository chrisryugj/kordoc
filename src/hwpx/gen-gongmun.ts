/**
 * 공문서 생성 엔진 v5 — 아웃라인(outline.ts) + 위계 스킴(gongmun-scheme.ts) → section0.xml.
 *
 * 담당 프리셋: 기안문(official)·보고서(report)·계획서(plan)·통지(notice)·회의록(minutes).
 * (개조식 gaejosik = 중앙부처 표지·목차 양식, 보도자료 press, 범용 마크다운은 gen-section.ts)
 *
 * 원칙
 *   - 입력 형태(#/##/-/□/1.)와 무관하게 아웃라인 depth 하나로 정규화하고 스킴이 부호·글꼴을 정한다.
 *   - □ 대항목·제목·장 제목은 한 줄 강제(fit-line). 실측 95%가 한 줄.
 *   - 두문·결문·제목표·요약박스는 실측 골격표(gen-frame-seoul.ts).
 *   - charPr/paraPr는 StyleRegistry 동적 발급 — 손계산 id 파티션 없음.
 */

import { type MdBlock, generateParagraph } from "./md-runs.js"
import { type ResolvedGongmun, GongmunNumberer, computeSuppression, mmToHwpunit } from "./gongmun.js"
import { type Scheme, type LevelStyle, pickScheme, levelGeometry, taHu } from "./gongmun-scheme.js"
import { buildOutline, type Outline, type OutlineNode } from "./outline.js"
import { StyleRegistry } from "./style-registry.js"
import { TableBfRegistry } from "./gen-table-bf.js"
import { fitOneLine, fitOrphanLine } from "./fit-line.js"
import { faceClassForGen } from "./text-metrics.js"
import { generateTable, generateHtmlTableXml, requiredTableWidth, DATA_TABLE_INSET, resetTableIds, type GongmunTableStyle } from "./gen-table.js"
import { type ProfileRemap } from "./gen-profile.js"
import { ImageRegistry, splitImageRefs } from "./gen-image.js"
import { type ResolvedPage } from "./gen-page.js"
import { type ChartPart, generateSecPr } from "./gen-section.js"
import { generateEquationParagraph } from "./equation-generate.js"
import { parseChartFence, buildChartSpaceXml, buildChartElementXml } from "./chart-gen.js"
import { CHART_TABLE_ID_BASE, A4_W_HU } from "./geometry.js"
import { CHAR_NORMAL, CHAR_BOLD, CHAR_ITALIC, CHAR_BOLD_ITALIC, PARA_CODE, CHAR_CODE, NS_SECTION, NS_PARA, escapeXml, newPageNumCtrl } from "./gen-ids.js"
import { hasEndMark } from "./gen-gongmun-extra.js"
import { buildNoticeHead, buildNoticeFoot, isInternalApproval } from "./gen-docframe.js"
import {
  type FrameCtx, buildDocHeadTable, buildDocFootTable, buildReportTitleTable, buildSummaryBox,
  buildApprovalSeoul, buildReportCover, splitTitleName, resetFrameTableIds, buildChapterBand, CHAPTER_BAND_DEFAULT,
} from "./gen-frame-seoul.js"
import { formatGaejosikDate } from "./gaejosik.js"

export const V5_PRESETS = new Set(["official", "report", "plan", "notice", "minutes"])
export function usesV5Engine(preset: string): boolean { return V5_PRESETS.has(preset) }

export interface GongmunEngineDeps {
  reg: StyleRegistry
  bfReg: TableBfRegistry
  remap: ProfileRemap | null
  images: ImageRegistry | null
  page: ResolvedPage | null
  chartParts: ChartPart[]
}

export interface GongmunEngineResult {
  xml: string
  warnings: string[]
  /** 실제 적용된 스킴 (헤더 본문 글꼴 결정용) */
  scheme: Scheme
}

const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ", "Ⅺ", "Ⅻ"]
export function chapterLabel(index: number, style: "roman" | "number"): string {
  return style === "roman" ? `${ROMAN[(index - 1) % 12]}.` : `${index}.`
}

/** 인라인 **굵게**·*기울임* → 레지스트리 변형 매핑 */
function inlineMapper(reg: StyleRegistry, base: { font: string; pt: number; bold: boolean; ratio?: number; spacing?: number }): (id: number) => number {
  const norm = reg.char({ font: base.font, pt: base.pt, bold: base.bold, ratio: base.ratio, spacing: base.spacing })
  return (id) => {
    if (id === CHAR_BOLD) return reg.char({ font: base.font, pt: base.pt, bold: true, ratio: base.ratio, spacing: base.spacing })
    if (id === CHAR_ITALIC) return reg.char({ font: base.font, pt: base.pt, bold: base.bold, italic: true, ratio: base.ratio, spacing: base.spacing })
    if (id === CHAR_BOLD_ITALIC) return reg.char({ font: base.font, pt: base.pt, bold: true, italic: true, ratio: base.ratio, spacing: base.spacing })
    if (id === CHAR_NORMAL) return norm
    return id
  }
}

/** 렌더 텍스트(강조 문법 제거) — 폭 계산용 */
function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
}

export function buildGongmunSectionV5(blocks: MdBlock[], gongmun: ResolvedGongmun, deps: GongmunEngineDeps, theme: import("./gen-ids.js").ResolvedTheme): GongmunEngineResult {
  resetTableIds(); resetFrameTableIds()
  const { reg, bfReg, remap, images, page } = deps
  const warnings: string[] = []
  const g = gongmun
  const preset = g.preset
  const isReport = preset === "report" || preset === "plan"
  const W = mmToHwpunit(210 - g.margins.left - g.margins.right)
  // 1차 아웃라인(스킴 미정) — 본문 □ 부호 자동감지용
  const pre = buildOutline(blocks, { gaejosik: true, consumeTitle: true, summaryFromQuote: isReport })
  const scheme = pickScheme(g, pre.hasBoxMarkers)
  const gaejosik = scheme.kind === "gaejosik"
  const outline: Outline = gaejosik ? pre : buildOutline(blocks, { gaejosik: false, consumeTitle: true, summaryFromQuote: false })
  const frame: FrameCtx = { reg, bf: bfReg, frame: scheme.frame, W }
  const lineHu = (st: LevelStyle) => Math.round(st.pt * 100 * ((st.lineSp ?? scheme.lineSp) / 100))
  const paras: string[] = []
  let pendingPageBreak = false

  // 표 스타일 (실측: 한컴돋움 12 헤더 bold·#DFE6F7·라벨열 #F2F2F2, 외곽 0.4/내부 0.12/헤더 이중선)
  const tblCharPr = reg.char({ font: scheme.table.font, pt: scheme.table.pt })
  const tableStyle: GongmunTableStyle = {
    totalWidth: W,
    charPr: tblCharPr,
    boldCharPr: reg.char({ font: scheme.table.font, pt: scheme.table.pt, bold: true }),
    charHeight: scheme.table.pt * 100,
    headerBf: bfReg.get({ t: "thin", b: "thin", l: "thin", r: "thin", fill: scheme.table.headerFill }),
    centerParaPr: reg.para({ align: "CENTER", lineSp: scheme.lineSp }),
    tblCenterParaPr: reg.para({ align: "CENTER", lineSp: 130 }),
    tblLeftParaPr: reg.para({ align: "LEFT", lineSp: 130 }),
    bfRegistry: bfReg,
    rightParaPr: reg.para({ align: "RIGHT", lineSp: scheme.lineSp }),
    headerFill: scheme.table.headerFill,
    labelFill: scheme.table.labelFill,
    faceClass: faceClassForGen(scheme.table.font),
  }

  /** 전면부가 남긴 직전 요소 — 본문 첫 □ 의 앞 간격 판정(제목표 바로 아래 첫 □ 는 반 줄) */
  let frontKind: "start" | "title" | "summary" = "start"
  // 요약박스 — 한 문장 3줄 이내, 넘치면 경고
  const pushSummary = (t: string) => {
    frontKind = "summary"
    const box = buildSummaryBox(t, frame)
    if (box.lines > 3) warnings.push(`요약박스가 ${box.lines}줄입니다 — 보고 목적을 한 문장(쉼표 허용) 3줄 이내 "…하고자 함"으로 줄이세요`)
    paras.push(box.xml)
  }
  // ─── 전면부 ───────────────────────────────────────
  const docTitle = g.docHead?.title ?? outline.title ?? ""
  if (preset === "official") {
    if (g.docHead) paras.push(buildDocHeadTable({ ...g.docHead, title: docTitle }, frame))
    else if (outline.title) paras.push(generateParagraph(outline.title, reg.para({ align: "CENTER", lineSp: scheme.lineSp, after: lineHu(scheme.body) }), reg.char({ font: scheme.body.font, pt: scheme.body.pt + 2, bold: true }), undefined, 1))
    if (g.reportInfo) paras.push(generateParagraph(g.reportInfo, reg.para({ align: "RIGHT", lineSp: scheme.lineSp }), reg.char({ font: scheme.body.font, pt: 12 })))
    if (g.approval) paras.push(buildApprovalSeoul(g.approval, null, frame))
  } else if (isReport) {
    if (g.cover) {
      paras.push(...buildReportCover({
        title: docTitle, date: g.cover.date ?? formatGaejosikDate(new Date()).replace(/\s\d+\.$/, "."), org: g.cover.org || undefined,
        dept: g.cover.dept, docInfo: g.docInfo ?? undefined, approval: g.approval ?? undefined,
      }, frame))
      pendingPageBreak = true
    } else if (g.approval) {
      paras.push(buildApprovalSeoul(g.approval, null, frame))
    }
    if (docTitle) {
      const t = buildReportTitleTable(docTitle, g.reportInfo, frame)
      if (t.overflow) warnings.push(`제목이 길어 한 줄에 담지 못했습니다(20pt·장평 85%까지 축소) — 제목을 줄이세요: "${docTitle.slice(0, 30)}…"`)
      if (pendingPageBreak) { paras.push(t.xml.replace(/^<hp:p /, `<hp:p pageBreak="1" `).replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${newPageNumCtrl(1)}`)); pendingPageBreak = false }
      else paras.push(t.xml)
      frontKind = "title"
    }
    // 제목 없는 보고서의 담당자 행 — 우상단 12pt (기안문 보고정보 행과 동일)
    if (!docTitle && g.reportInfo) paras.push(generateParagraph(g.reportInfo, reg.para({ align: "RIGHT", lineSp: scheme.lineSp }), reg.char({ font: scheme.body.font, pt: 12 })))
    if (g.summary) pushSummary(g.summary)
    else if (!outline.nodes.some((n) => n.kind === "summary")) warnings.push("보고서 요약박스가 없습니다 — 제목 직후 인용문(>)에 보고 목적을 한 문장(쉼표 허용) 3줄 이내 \"…하고자 함\"으로 넣거나 summary 옵션을 지정하세요")
  } else {
    // 통지·회의록 — 제목 가운데 굵게, 공고번호
    if (g.noticeHead) paras.push(...buildNoticeHead(g))
    if (g.approval) paras.push(buildApprovalSeoul(g.approval, null, frame))
    if (outline.title) paras.push(generateParagraph(outline.title, reg.para({ align: "CENTER", lineSp: scheme.lineSp, before: 400, after: lineHu(scheme.body) }), reg.char({ font: scheme.frame.titleFont, pt: 20, bold: true }), undefined, 1))
  }

  // ─── 본문 ─────────────────────────────────────────
  const numberer = new GongmunNumberer("standard", g.bullet2)
  const itemDepths = outline.nodes.filter((n): n is Extract<OutlineNode, { kind: "item" }> => n.kind === "item" && !n.legalMarker).map((n) => n.depth)
  const suppress = !gaejosik && g.suppressSingle ? computeSuppression(itemDepths) : null
  let itemSeq = 0
  /** □ 앞 간격(HWPUNIT). 빈 문단(15pt×180%=27pt)을 두면 ㅇ→□ 기준선 55pt 로 본문 행간(30pt)의 1.8배 구멍이 난다(실렌더 캡처).
   *  10pt 면 ㅇ→□ 37pt·잉크 간격 22pt — 실결재의 그룹 사이 흰 공간(본문 13~17pt 대비 23~25pt, 1.5배) 비율 */
  const BOX_BLANK_HU = 1000
  /** 띠 제목 아래 첫 □·요약박스 뒤 띠 간격 */
  const BOX_GAP_AFTER_BAND = 1200
  /** 본문 뒤 띠 제목 앞 간격 */
  const BAND_BEFORE_HU = 2000
  let prevKind: OutlineNode["kind"] | "start" = frontKind
  /** 직전 항목의 depth — 연속 □(하위 항목 없이 □ 다음 □) 사이엔 빈 줄을 넣지 않는다 (실측 52:48 반반, 실무자 요청) */
  let prevItemDepth = -1
  /** 다음 노드 — □ 의 keepWithNext 는 다음이 하위 항목·※ 일 때만. □→□→□→표 사슬이 이어지면 표가 안 들어갈 때 장 전체가 다음 쪽으로 밀린다(실렌더) */
  let nextNode: OutlineNode | undefined
  let tableSeq = 0
  let chapterStyle: "band" | "roman" | "number" | "box" | "none" = g.h2Marker === "box" || g.h2Marker === "number" || g.h2Marker === "none" || g.h2Marker === "band" ? g.h2Marker : "roman"
  if (!gaejosik) chapterStyle = "number" // 기안문 본문의 h2는 1. 항목이 된다 (아래 chapter 분기)

  const leadLeft = (depth: number, pt: number) => (scheme.levels[Math.min(depth, 7)]?.leadTa ?? 0) * taHu(pt)

  const renderItem = (node: Extract<OutlineNode, { kind: "item" }>, styleId = 0): string => {
    const depth = Math.min(node.depth, 7)
    const sub = gaejosik && node.legalMarker
    const st: LevelStyle = sub ? { ...scheme.sub, leadTa: (() => { const d = node.legalMarker ? legalDepthOf(node.legalMarker) : 0; return 2 * d })() } : scheme.levels[depth]
    let marker: string
    if (sub) marker = node.legalMarker!
    else if (gaejosik) marker = scheme.marker(depth, 0)
    else { const sup = suppress ? suppress[itemSeq] : false; marker = numberer.next(depth, sup); itemSeq++ }
    const text = marker ? `${marker} ${node.text}` : node.text
    const geom = levelGeometry(st, marker)
    const availFirst = W - geom.left
    const availCont = W - geom.left + geom.indent // indent 음수 = 둘째 줄부터 오른콝
    let pt = st.pt, ratio = 100, spacing = 0
    if (st.oneLine) {
      // □ 는 크기를 줄이지 않는다(형제 □ 끼리 크기·굵기가 달라 보이던 결함, 라운드 3) — 장평 90·자간 -5 까지만.
      // 그래도 넘치면 억지로 우겨넣지 않고 자연 줄바꿈(내어쓰기) + 경고: 문장을 줄이는 게 정답
      const fit = fitOneLine(plain(text), st.font, st.pt, availFirst, st.pt, 90)
      if (fit.overflow) warnings.push(`□ 항목이 한 줄에 담기지 않아 두 줄로 꺾입니다 — 문장을 줄이세요(장평 90%·자간 -5 로도 초과): "${node.text.slice(0, 30)}…"`)
      else { ratio = fit.ratio; spacing = fit.spacing }
    } else if (g.autoFitMinRatio !== null) {
      // 고아 줄(둘째 줄 ≤ 20%) → 자간 -1%씩(Shift+Alt+N 관행) → 장평 조합으로 한 줄에
      const f = fitOrphanLine(plain(text), st.font, st.pt, availFirst, availCont)
      if (f) { ratio = f.ratio; spacing = f.spacing }
    }
    const base = { font: st.font, pt, bold: st.bold, ratio, spacing }
    const geom2 = pt !== st.pt ? levelGeometry({ ...st, pt }, marker) : geom
    // □ 앞 빈 줄(실측 74%) — 장·제목·요약 직후 첫 □는 제외
    // □ 앞 빈 줄(실측 76%) — 장·제목·요약 직후 첫 □ 와 **연속 □**(직전이 하위 항목 없는 □, 실측 52%·실무자 요청) 는 제외.
    // 띠 표 장 제목 바로 아래 첫 □ 는 밑줄에 붙지 않게 반 줄
    const consecutiveBox = prevKind === "item" && prevItemDepth === 0 && depth === 0
    // 하위 항목 뒤 □ 앞 간격은 BOX_BLANK_HU(10pt) — 빈 문단 27pt 는 본문 행간의 1.8배 구멍(실렌더, 라운드 3).
    // 띠 제목·제목표 바로 아래 첫 □ 는 반 줄(12pt): 제목표 하변 괘선에 □ 가 붙어 보이는 것을 막는다(시각 픽스처 gongmun-report)
    const afterBand = depth === 0 && ((prevKind === "chapter" && chapterStyle === "band") || (prevKind === "title" && !!st.blankBefore))
    const before = afterBand ? BOX_GAP_AFTER_BAND
      : st.blankBefore && !consecutiveBox && prevKind !== "chapter" && prevKind !== "start" && prevKind !== "summary" ? BOX_BLANK_HU : 0
    // 글자 단위 줄바꿈(KEEP_WORD — 이름 역전 주의) + 양쪽정렬: 실결재 개조식 `-` 문단 76%(다줄 88%)·법정형 97%.
    // 라운드 1의 어절유지+양쪽정렬(실측 1.2%)은 긴 어절이 통째로 다음 줄로 밀려 앞 줄 어절 간격이 벌어졌다
    // (실렌더 확인, 2026-09-06). 라틴·숫자 토큰은 breakLatinWord=KEEP_WORD 로 계속 통째 유지.
    const keepNext = !!st.keepWithNext && !!nextNode && ((nextNode.kind === "item" && nextNode.depth > depth) || nextNode.kind === "ref")
    const paraId = reg.para({ align: "JUSTIFY", left: geom2.left, indent: geom2.indent, before, lineSp: st.lineSp ?? scheme.lineSp, keepWithNext: keepNext, keepWord: false })
    return generateParagraph(text, paraId, reg.char(base), inlineMapper(reg, base), styleId)
  }

  const renderRef = (node: Extract<OutlineNode, { kind: "ref" }>): string => {
    const st = scheme.ref
    const marker = "※"
    const left = leadLeft(node.depth, st.pt)
    const geom = levelGeometry({ ...st, leadTa: 0 }, marker)
    const base = { font: st.font, pt: st.pt, bold: st.bold }
    const f = fitOrphanLine(plain(`${marker} ${node.text}`), st.font, st.pt, W - left, W - left + geom.indent)
    const baseF = f ? { ...base, ratio: f.ratio, spacing: f.spacing } : base
    const paraId = reg.para({ align: "JUSTIFY", left, indent: geom.indent, lineSp: st.lineSp ?? scheme.lineSp, keepWord: false })
    return generateParagraph(`${marker} ${node.text}`, paraId, reg.char(baseF), inlineMapper(reg, baseF))
  }

  const renderPara = (node: Extract<OutlineNode, { kind: "para" }>): string => {
    const st = scheme.body
    if (images) {
      const { text: rest, urls } = splitImageRefs(node.text)
      if (urls.length > 0 && !rest.trim()) {
        const pics = urls.map((u) => { const part = images.take(u); return part ? images.inlinePicXml(part) : null })
        if (pics.every(Boolean)) return `<hp:p paraPrIDRef="${reg.para({ align: "CENTER", lineSp: scheme.lineSp })}" styleIDRef="0"><hp:run charPrIDRef="${reg.char({ font: st.font, pt: st.pt })}">${pics.join("")}</hp:run></hp:p>`
      }
    }
    let ratio = 100, spacing = 0
    if (!node.align && g.autoFitMinRatio !== null) {
      const f = fitOrphanLine(plain(node.text), st.font, st.pt, W, W)
      if (f) { ratio = f.ratio; spacing = f.spacing }
    }
    const base = { font: st.font, pt: st.pt, bold: st.bold, ratio, spacing }
    const paraId = reg.para({ align: node.align ?? "JUSTIFY", lineSp: scheme.lineSp, keepWord: false })
    return generateParagraph(node.text, paraId, reg.char(base), inlineMapper(reg, base))
  }

  const renderChapter = (node: Extract<OutlineNode, { kind: "chapter" }>): string => {
    const st = scheme.chapter
    if (chapterStyle === "band") {
      // 요약박스 직후엔 반 줄(붙지 않게), 본문 뒤엔 실측 빈 줄보다 조금 넉넉히(20pt)
      const before = prevKind === "start" || prevKind === "title" ? 0 : prevKind === "summary" ? BOX_GAP_AFTER_BAND : BAND_BEFORE_HU
      const band = buildChapterBand(chapterLabel(node.index, "roman").replace(/\.$/, ""), plain(node.text), frame, { ...CHAPTER_BAND_DEFAULT, color: g.bandColor, textColor: g.bandTextColor, titleFont: st.font, titlePt: st.pt }, before)
      if (band.overflow) warnings.push(`장 제목이 띠 표 한 줄에 담기지 않아 축소했습니다 — 제목을 줄이세요: "${node.text.slice(0, 30)}…"`)
      return band.xml
    }
    const label = chapterStyle === "none" ? "" : chapterLabel(node.index, chapterStyle === "number" ? "number" : "roman")
    const text = label ? `${label} ${node.text}` : node.text
    const fit = fitOneLine(plain(text), st.font, st.pt, W, st.pt - 2)
    const base = { font: st.font, pt: fit.pt, bold: st.bold, ratio: fit.ratio, spacing: fit.spacing }
    const before = prevKind === "start" || prevKind === "title" || prevKind === "summary" ? 0 : lineHu(scheme.body)
    const paraId = reg.para({ align: "LEFT", before, after: Math.round(lineHu(scheme.body) * 0.3), lineSp: st.lineSp ?? scheme.lineSp, keepWithNext: true, keepWord: false })
    return generateParagraph(text, paraId, reg.char(base), inlineMapper(reg, base), 2)
  }

  const renderAttach = (node: Extract<OutlineNode, { kind: "attach" }>, first: boolean): string => {
    const st = scheme.attach
    // 편람: '붙임' 뒤 쌍점 없이 2타. 둘째 줄부터의 선행 공백은 실측(99%) 그대로 보존
    let text = node.text
    if (/^\s*붙\s*임/.test(text)) text = text.replace(/^\s*붙\s*임\s*[:：]?\s*/, "붙임  ")
    else text = text.replace(/\s+$/, "")
    const paraId = reg.para({ align: "LEFT", before: first ? lineHu(scheme.body) : 0, lineSp: st.lineSp ?? scheme.lineSp, keepWord: false })
    const base = { font: st.font, pt: st.pt, bold: st.bold }
    return generateParagraph(text, paraId, reg.char(base), inlineMapper(reg, base))
  }

  const renderBlock = (node: Extract<OutlineNode, { kind: "block" }>, idx: number): string => {
    const b = node.block
    switch (b.type) {
      case "table": {
        if (!b.rows) return ""
        // 셀 글자 자동 축소 — 12pt로 한 줄에 안 들어가면 11·10pt (실측 셀 pt 분포 10:44·11:40·12:33)
        let style = tableStyle
        const face = faceClassForGen(scheme.table.font)
        const avail = W - DATA_TABLE_INSET
        for (const pt of [scheme.table.pt, scheme.table.pt - 1, scheme.table.pt - 2]) {
          if (pt < 9) break
          if (requiredTableWidth(b.rows, pt * 100, face) <= avail || pt === scheme.table.pt - 2) {
            if (pt !== scheme.table.pt) style = { ...tableStyle, charPr: reg.char({ font: scheme.table.font, pt }), boldCharPr: reg.char({ font: scheme.table.font, pt, bold: true }), charHeight: pt * 100 }
            break
          }
        }
        return generateTable(b.rows, theme, style, remap, tableSeq++, images)
      }
      case "html_table": {
        const tbl = generateHtmlTableXml(b.text || "", theme, tableStyle.totalWidth - DATA_TABLE_INSET, tableStyle, remap, tableSeq++, images)
        if (tbl) return `<hp:p paraPrIDRef="${tableStyle.rightParaPr}" styleIDRef="0"><hp:run charPrIDRef="${tblCharPr}">${tbl}</hp:run></hp:p>`
        const txt = (b.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        return txt ? renderPara({ kind: "para", depth: 0, text: txt }) : ""
      }
      case "code_block": {
        if ((b.lang || "").toLowerCase() === "chart") {
          const fence = parseChartFence(b.text || "")
          if (fence) {
            const partName = `Chart/chart${deps.chartParts.length + 1}.xml`
            deps.chartParts.push({ name: partName, xml: buildChartSpaceXml(fence) })
            const el = buildChartElementXml(partName, fence.widthHu, fence.heightHu, CHART_TABLE_ID_BASE + idx)
            return `<hp:p paraPrIDRef="${tableStyle.centerParaPr}" styleIDRef="0"><hp:run charPrIDRef="${tblCharPr}">${el}</hp:run></hp:p>`
          }
        }
        return (b.text || "").split("\n").map((line) => `<hp:p paraPrIDRef="${PARA_CODE}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(line || " ")}</hp:t></hp:run></hp:p>`).join("\n  ")
      }
      case "equation": return generateEquationParagraph(b.text || "", idx)
      case "hr": return `<hp:p paraPrIDRef="${reg.para({ lineSp: scheme.lineSp })}" styleIDRef="0"><hp:run charPrIDRef="${reg.char({ font: scheme.body.font, pt: scheme.body.pt })}"><hp:t></hp:t></hp:run></hp:p>`
      default: return ""
    }
  }

  // forEach 콜백 안에서 대입되므로 흐름 분석이 null 로 좁히지 않게 as 로 선언
  let lastTextNode = null as OutlineNode | null
  let prevAttach = false
  let lastItemFromHeading = false
  outline.nodes.forEach((node, idx) => {
    nextNode = outline.nodes[idx + 1]
    let xml = ""
    switch (node.kind) {
      case "title": break
      case "summary":
        if (isReport && !g.summary) { pushSummary(node.text); prevKind = node.kind; return }
        xml = renderRef({ kind: "ref", depth: 0, text: node.text })
        break
      case "chapter":
        lastItemFromHeading = true
        if (!gaejosik) {
          // 기안문 본문: 장 제목은 1. 항목 (법정 8단계 최상위) — 스타일 "개요 2"로 h2 왕복 보존
          xml = renderItem({ kind: "item", depth: 0, text: node.text }, 2)
        } else if (chapterStyle === "box") {
          xml = renderItem({ kind: "item", depth: 0, text: node.text })
        } else xml = renderChapter(node)
        lastTextNode = node
        break
      case "item": xml = renderItem(node); lastTextNode = node; lastItemFromHeading = !!node.fromHeading; break
      case "ref": xml = renderRef(node); lastTextNode = node; break
      // 마크다운 리스트 사이에 본문 문단이 끼면 번호 재시작(리스트 run 종료). 헤딩(##/###)에서 온
      // 항목은 그 아래 서술 문단이 내용이므로 번호를 잇는다 (기안문 "1. 개요 / 내용 / 2. 성과")
      case "para": xml = renderPara(node); if (!node.align && !lastItemFromHeading) numberer.reset(); lastTextNode = node; break
      case "attach": xml = renderAttach(node, !prevAttach); lastTextNode = node; break
      case "block": xml = renderBlock(node, idx); if (node.block.type === "table" || node.block.type === "html_table") lastTextNode = node; break
    }
    prevAttach = node.kind === "attach"
    if (!xml) return
    if (pendingPageBreak) { xml = xml.replace(/^<hp:p /, `<hp:p pageBreak="1" `); pendingPageBreak = false }
    paras.push(xml)
    prevKind = node.kind
    if (node.kind === "item") prevItemDepth = node.depth
    else if (node.kind === "chapter" && gaejosik && chapterStyle === "box") prevItemDepth = 0
  })

  // ─── 후면부 ───────────────────────────────────────
  if (g.noticeHead) paras.push(...buildNoticeFoot(g))
  if (g.endMark && paras.length > 0) {
    const lastText = lastTextNode && (lastTextNode.kind === "item" || lastTextNode.kind === "para" || lastTextNode.kind === "attach" || lastTextNode.kind === "ref") ? lastTextNode.text : ""
    if (!hasEndMark(lastText)) {
      const st = scheme.body
      paras.push(generateParagraph("  끝.", reg.para({ align: "LEFT", lineSp: scheme.lineSp }), reg.char({ font: st.font, pt: st.pt })))
    }
  }
  if (preset === "official" && g.docFoot) {
    const f = g.docFoot
    const approvers = (f.approvers ?? [f.drafter, f.reviewer, f.approver].filter((x): x is string => !!x)).map(splitTitleName)
    const cooperators = (f.cooperator ? f.cooperator.split(/[,、·]/).map((s) => s.trim()).filter(Boolean) : []).map(splitTitleName)
    paras.push(buildDocFootTable({
      sender: f.sender, approvers, cooperators, recipients: f.recipients,
      docNum: f.docNum, receive: f.receive, zip: f.zip, address: f.address, site: f.site,
      phone: f.phone, fax: f.fax, email: f.email, disclosure: f.disclosure,
    }, frame, isInternalApproval(g.docHead?.to)))
  }

  if (paras.length === 0) paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>`)
  // 섹션 첫 문단 첫 run에 페이지 설정 — 실결재도 두문표와 같은 run에 secPr·colPr을 싣는다
  paras[0] = paras[0].replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${generateSecPr(g, page)}`)

  return {
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">\n  ${paras.join("\n  ")}\n</hs:sec>`,
    warnings,
    scheme,
  }
}

function legalDepthOf(marker: string): number {
  if (/^\d{1,2}\.$/.test(marker)) return 0
  if (/^[가-힣]\.$/.test(marker)) return 1
  if (/^\d{1,2}\)$/.test(marker)) return 2
  if (/^[가-힣]\)$/.test(marker)) return 3
  if (/^\(\d{1,2}\)$/.test(marker)) return 4
  if (/^\([가-힣]\)$/.test(marker)) return 5
  return 6
}

void A4_W_HU
