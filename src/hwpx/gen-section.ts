/**
 * HWPX 섹션 XML 조립 (generator.ts에서 분리).
 * 섹션 속성(공문서 표준 여백)과 블록 목록 → section0.xml 본문.
 *
 * v4.0.5 P0-2: 갓함수 분리 — "첫 run이 secPr/colPr/쪽번호를 나른다"는 계약을
 * SectionOpener 한 지점으로 응집(종전 6회 복붙), 프리앰블 적층은 buildPreamble,
 * 블록 변환은 타입별 render* 핸들러로 분해. 방출 바이트는 종전과 동일(해시 대조 검증).
 */

import { type ResolvedGongmun, levelIndent, mmToHwpunit, needsGaejosikAssets, usesReportFonts } from "./gongmun.js"
import { stripChapterNumber, gaejosikSizes, GAEJOSIK_BASE_WIDTH } from "./gaejosik.js"
import { buildGaejosikCover, buildGaejosikToc, buildGaejosikChapter, buildGaejosikBodyTitle, resetGjTableIds } from "./gen-gaejosik.js"
import {
  NS_SECTION, NS_PARA,
  CHAR_NORMAL, CHAR_BOLD, CHAR_QUOTE, CHAR_H1, PARA_NORMAL, PARA_QUOTE, PARA_CODE, PARA_LIST,
  GONGMUN_CENTER, GONGMUN_RIGHT, GONGMUN_SRC_LEFT, GONGMUN_TBL_CENTER, GONGMUN_TBL_LEFT, GONGMUN_LIST_BASE, GONGMUN_LIST_PLAIN_BASE, GONGMUN_LIST_VARIANT_BASE,
  GJ_CHAR_DAE, GJ_CHAR_DAE_BOLD, GJ_CHAR_CHAM, GJ_CHAR_CHAM_BOLD, GJ_PARA_CHAM,
  GJ_CHAR_TABLE, GJ_CHAR_TABLE_BOLD, GJ_CHAR_BODY_TITLE, gongmunTableHeaderBf,
  GJ_CHAR_APPROVAL, GJ_CHAR_TITLE_BAR, GONGMUN_APPROVAL_CHAR,
  GONGMUN_TBL_CHAR, GONGMUN_TBL_CHAR_BOLD, GONGMUN_TBL_PT, GONGMUN_TITLE_BAR_CHAR, GONGMUN_BODY_RATIO,
  GONGMUN_SRC_CHAR, GONGMUN_SRC_CHAR_BOLD, GJ_CHAR_SRC, GJ_CHAR_SRC_BOLD, srcCaptionPt,
  charVariantBase, pageNumCtrl, newPageNumCtrl, pageHidingCtrl,
  escapeXml, headingParaPrId, headingCharPrId,
  type ResolvedTheme,
} from "./gen-ids.js"
import { type MdBlock, generateParagraph, generateRuns } from "./md-runs.js"
import { measureTextWidth } from "./text-metrics.js"
import { type GongmunFitPlan, type GongmunListPlan, variantMapper, precomputeGongmunList } from "./gen-gongmun-fit.js"
import { generateTable, generateHtmlTableXml, DATA_TABLE_INSET, resetTableIds, type GongmunTableStyle } from "./gen-table.js"
import { TableBfRegistry } from "./gen-table-bf.js"
import { type ProfileRemap } from "./gen-profile.js"
import { buildApprovalTable, buildEndMark, hasEndMark, buildTitleBox, resetExtraTableIds } from "./gen-gongmun-extra.js"
import { type LevelCharIds } from "./gen-levels.js"
import { type DocframeIds, buildDocHead, buildDocFoot, buildReportInfo, buildNoticeHead, buildNoticeFoot, buildPressHead, buildPressContact } from "./gen-docframe.js"
import { generateEquationParagraph } from "./equation-generate.js"
import { parseChartFence, buildChartSpaceXml, buildChartElementXml } from "./chart-gen.js"
import { A4_W_HU, A4_H_HU, CHART_TABLE_ID_BASE } from "./geometry.js"
import { ImageRegistry, splitImageRefs } from "./gen-image.js"
import { type ResolvedPage, columnColPrXml, headerFooterCtrl } from "./gen-page.js"

/** 생성 중 수집된 차트 파트 — 호출부(generator)가 ZIP·manifest에 등재 */
export interface ChartPart {
  /** ZIP 파트 경로 (Chart/chartN.xml) */
  name: string
  /** chartSpace XML 전문 */
  xml: string
}

// ─── 섹션 속성 (공문서 표준 여백) ────────────────────

function generateSecPr(gongmun: ResolvedGongmun | null, page: ResolvedPage | null = null): string {
  // A4: 210mm × 297mm → 59528 × 84188 HWPUNIT (1mm ≈ 283.46 HWPUNIT)
  // 비공문서(기존): 위 30 / 아래 15 / 좌 20 / 우 15mm, 머리말·꼬리말 10mm.
  // 공문서 표준(편람 서식 작성방법 해설·시행규칙 별표4): 위 20 / 아래 10 / 좌 20 / 우 20mm,
  //   머리말·꼬리말·제본 0mm. (기존 위30 등은 권위 출처 없는 값이라 공문서 모드에서만 교체)
  const m = gongmun
    ? {
        top: mmToHwpunit(gongmun.margins.top),
        bottom: mmToHwpunit(gongmun.margins.bottom),
        left: mmToHwpunit(gongmun.margins.left),
        right: mmToHwpunit(gongmun.margins.right),
        header: 0,
        footer: 0,
      }
    : { top: 8504, bottom: 4252, left: 5670, right: 4252, header: 2835, footer: 2835 }
  // 개조식 실측(GT3): 머리말·꼬리말 영역 15mm — 쪽번호가 이 영역에 렌더
  if (gongmun) { m.header = gongmun.headerFooter; m.footer = gongmun.headerFooter }
  // outlineShapeIDRef="1" — 헤딩 paraPr(OUTLINE)이 쓰는 빈 서식 numbering (gen-header buildNumberings)
  const secPr = `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:pagePr landscape="${page?.landscape ?? "WIDELY"}" width="${page?.widthHU ?? A4_W_HU}" height="${page?.heightHU ?? A4_H_HU}" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${m.header}" footer="${m.footer}" gutter="0" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
  // 단 컬럼 정의(colPr) — 반드시 secPr 뒤 같은 run에 방출한다. 없으면 한글이 컬럼
  // 영역을 좌우 10mm(2835HU)씩 좁게 잡아 본문이 우측 여백에 못 미치고, 컬럼보다
  // 넓은 treatAsChar 표(제목박스·데이터표·목차박스)는 우측 여백을 침범한다
  // (v4.1.0 GAP-01 — COM 실렌더 실측: colPr 주입만으로 본문 190mm 정합·초과 0 확인).
  // columns=1이면 columnColPrXml이 종전 하드코딩과 동일 바이트를 방출한다.
  const colPr = columnColPrXml(page?.columns ?? 1)
  // 머리말/꼬리말 (v4.5.0) — 첫 문단 첫 run에 ctrl로 방출 (rhwp 형상)
  const hf = (page?.header ? headerFooterCtrl("header", page.header, 1) : "") +
    (page?.footer ? headerFooterCtrl("footer", page.footer, 2) : "")
  // 쪽번호 — 실측(GT3·GT6·GT7·GT9·GT11): 하단 중앙 "- 1 -". secPr·colPr과 같은 run에 배치
  return secPr + colPr + hf + (gongmun?.pageNumbers ? pageNumCtrl() : "")
}

// ─── SectionOpener — "첫 run이 secPr/colPr/쪽번호를 나른다" 계약의 단일 지점 ──
//
// HWPX는 섹션 첫 문단의 첫 run에 페이지 설정(secPr)이 실려야 한다. 종전에는 이
// 주입이 프리앰블·차트·수식·표·HTML표·일반 문단 여섯 곳에 복붙돼 있었다 (P0-2).
class SectionOpener {
  private pending = true
  constructor(private readonly gongmun: ResolvedGongmun | null, private readonly page: ResolvedPage | null = null) {}

  /** 아직 secPr를 나를 첫 문단이 안 나왔는가 */
  get isFirst(): boolean { return this.pending }

  /** 일반 문단 XML의 첫 run에 secPr 주입 (소비) */
  inject(xml: string): string {
    this.pending = false
    return xml.replace(
      /<hp:run charPrIDRef="(\d+)">/,
      `<hp:run charPrIDRef="$1">${generateSecPr(this.gongmun, this.page)}`,
    )
  }

  /**
   * 표·차트·수식처럼 첫 run에 직접 못 싣는 블록 앞에 secPr 전용 빈 문단을 방출 (소비).
   * 이미 소비됐으면 아무것도 안 한다.
   */
  emitCarrier(paraXmls: string[]): void {
    if (!this.pending) return
    this.pending = false
    const secRun = `<hp:run charPrIDRef="0">${generateSecPr(this.gongmun, this.page)}<hp:t></hp:t></hp:run>`
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
  }

  /** 빈 문서 폴백 — secPr를 실은 빈 단락 XML */
  emptyDoc(): string {
    this.pending = false
    return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr(this.gongmun, this.page)}<hp:t></hp:t></hp:run></hp:p>`
  }
}

// ─── 섹션 조립 컨텍스트 — 핸들러 간 공유 상태 ─────────

interface SectionCtx {
  theme: ResolvedTheme
  gongmun: ResolvedGongmun | null
  gongmunList: GongmunListPlan | null
  fit: GongmunFitPlan | null
  chartParts: ChartPart[] | null
  bfReg: TableBfRegistry | null
  remap: ProfileRemap | null
  dfIds: DocframeIds | null
  /** 단계별 위계 타이포 charPr (levels 옵션, v4.12.3) — null이면 없음 */
  levelIds: LevelCharIds | null
  /** 이미지 placeholder 레지스트리 (v4.0.5) — null이면 종전 alt 텍스트 폴백 */
  images: ImageRegistry | null
  /** 파생 플래그·스타일 */
  gaejosik: boolean
  measured: boolean
  richAssets: boolean
  vBase: number
  tableStyle: GongmunTableStyle | null
  gjBodyW: number
  chamMap: (id: number) => number
  /** secPr 계약 */
  opener: SectionOpener
  paraXmls: string[]
  /** 가변 카운터·인덱스 */
  tableSeq: number
  chapterNo: number
  h2Seq: number
  coverH1Idx: number
  titleBoxH1Idx: number
  pressH1Idx: number
  /** 개조식 장 목록 SSOT — 목차·본문 로마 장헤더가 공유하는 heading blockIdx 배열 (P1-3) */
  gjChapterIdxs: number[]
  pendingPageBreak: boolean
  pendingNewNum: boolean
  orderedCounters: Record<number, number>
  prevWasOrdered: boolean
}

// ─── 프리앰블 (보고정보·결재란·두문·표지·목차·제목박스) ─

/**
 * 공문서 전면부를 조립해 ctx.paraXmls에 적재하고, 본문 렌더가 참조할 인덱스
 * (표지 소비 h1, 제목박스/보도자료 h1)와 쪽나눔·쪽번호 재시작 플래그를 ctx에 설정.
 */
function buildPreamble(blocks: MdBlock[], ctx: SectionCtx): void {
  const { gongmun, dfIds, bfReg, tableStyle, richAssets, gjBodyW } = ctx
  const preamble: string[] = []
  let hasFrontPages = false // 표지·목차 등 본문과 페이지가 분리되는 전면부 존재 여부
  // 보고정보 행 — 최상단 우측 (실측 t1: 보고일시·보고자·연락처가 문서 첫 줄)
  if (gongmun?.reportInfo && dfIds) {
    preamble.push(buildReportInfo(gongmun, dfIds))
  }
  // 결재란 — 문서 최상단 우측 (실측 GT12: 결재선이 표지 최상단)
  if (gongmun?.approval && bfReg) {
    preamble.push(buildApprovalTable(gongmun.approval, bfReg, richAssets ? GJ_CHAR_APPROVAL : GONGMUN_APPROVAL_CHAR))
  }
  // 기안문 두문 (별지 제1호서식 — 기관명·수신·경유·제목)
  if (gongmun?.docHead && dfIds) {
    preamble.push(...buildDocHead(gongmun, dfIds))
  }
  // 공고문 공고번호 (실측: 바이오헬스 공고문 최상단 좌측 bold)
  if (gongmun?.noticeHead && dfIds) {
    preamble.push(...buildNoticeHead(gongmun))
  }
  // 보도자료 머리박스 — "보도자료" 라벨 + 보도시점/배포
  if (gongmun?.press && dfIds && bfReg && tableStyle) {
    preamble.push(...buildPressHead(gongmun, dfIds, tableStyle.totalWidth, bfReg))
  }
  if (gongmun && (gongmun.cover || gongmun.toc)) {
    const h1Idx = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
    let coverTitle = ""
    // 표지·목차 페이지 쪽번호 숨김 (실측 GT3: pageHiding hidePageNum=1 ×2) — 페이지 첫 문단 run에 주입
    const hide = (xml: string, hideHeader: boolean) =>
      gongmun!.pageNumbers ? xml.replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${pageHidingCtrl(hideHeader)}`) : xml
    if (gongmun.cover && h1Idx >= 0) {
      coverTitle = (blocks[h1Idx].text || "").trim()
      const coverPart = buildGaejosikCover(coverTitle, gongmun, gjBodyW)
      coverPart[0] = hide(coverPart[0], true)
      preamble.push(...coverPart)
      ctx.coverH1Idx = h1Idx
      hasFrontPages = true
    }
    // 장 목록 SSOT (v4.0.5 P1-3) — 목차와 본문 로마 장헤더가 같은 배열·같은 번호를
    // 공유한다. 종전엔 목차=h2만, 본문=표지 제외 h1+h2로 서로 다른 규칙이라 표지가
    // 못 삼킨 둘째 h1이 있으면 본문 번호가 목차보다 +1씩 밀렸다.
    ctx.gjChapterIdxs = blocks
      .map((b, i) => (b.type === "heading" && (b.level ?? 1) <= 2 && i !== ctx.coverH1Idx ? i : -1))
      .filter((i) => i >= 0)
    if (gongmun.toc && ctx.gjChapterIdxs.length > 0) {
      const chapters = ctx.gjChapterIdxs.map((i) => stripChapterNumber(blocks[i].text || ""))
      const tocPart = buildGaejosikToc(chapters, gongmun, gjBodyW)
      tocPart[0] = hide(tocPart[0], false)
      preamble.push(...tocPart)
      hasFrontPages = true
    }
    // 본문 첫 페이지 제목 반복 박스 (실측 GT3 표④·GT12) — 표지/목차 뒤 새 페이지 선두
    if (gongmun.bodyTitleBox && coverTitle && hasFrontPages) {
      preamble.push(buildGaejosikBodyTitle(coverTitle, gongmun, gjBodyW).replace(/^<hp:p /, `<hp:p pageBreak="1" `))
    }
  }
  if (gongmun && !ctx.gaejosik && ctx.coverH1Idx < 0 && bfReg && (gongmun.preset === "report" || gongmun.preset === "plan" || gongmun.preset === "notice")) {
    // 1페이지형 제목박스 (실측 GT2/GT6/GT7: 색상바+제목+gradient바) — 첫 h1을 박스로
    ctx.titleBoxH1Idx = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
  } else if (gongmun?.press && ctx.coverH1Idx < 0 && dfIds) {
    // 보도자료 — 첫 h1을 제목 25pt bold CENTER + 부제(- … -)로 (실측: 국토부 실물 표2)
    ctx.pressH1Idx = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
  }
  if (preamble.length > 0) {
    // 섹션 첫 문단이 페이지 설정(secPr)을 지니므로 여기서 주입, 선두 쪽나눔은 제거
    preamble[0] = ctx.opener.inject(preamble[0].replace(` pageBreak="1"`, ""))
    // 본문 첫 블록 쪽나눔 — 전면부가 있고, 제목박스가 그 쪽나눔을 이미 소화하지 않았을 때만
    ctx.pendingPageBreak = hasFrontPages && !preamble[preamble.length - 1].includes(`pageBreak="1"`)
    // 표지·목차가 있으면 본문에서 쪽번호 1 재시작 (실측 GT3 newNum)
    ctx.pendingNewNum = !!gongmun!.pageNumbers && hasFrontPages
    ctx.paraXmls.push(...preamble)
  }
}

// ─── 블록 타입별 렌더 핸들러 ─────────────────────────

function renderHeading(block: MdBlock, blockIdx: number, ctx: SectionCtx): string {
  const { gongmun, dfIds, tableStyle, bfReg, measured, richAssets, gjBodyW } = ctx
  if (gongmun && blockIdx === ctx.coverH1Idx) return "" // 표지가 소비한 h1
  if (gongmun && blockIdx === ctx.pressH1Idx && dfIds) {
    // 보도자료 제목 + 부제 "- … -" (실측: 국토부 실물 25pt bold / 부제 15pt bold)
    const parts = [generateParagraph((block.text || "").trim(), GONGMUN_CENTER, dfIds.pressTitle)]
    for (const s of gongmun.press?.sub ?? []) {
      parts.push(generateParagraph(`- ${s} -`, GONGMUN_CENTER, dfIds.pressSub))
    }
    return parts.join("\n  ")
  }
  if (gongmun && blockIdx === ctx.titleBoxH1Idx && tableStyle && bfReg) {
    // 1페이지형 제목박스 (실측 GT2/GT6/GT7) — report/plan/notice 첫 h1.
    // 실측 프리셋은 제목박스 전용 HY헤드라인M 22pt(GJ_CHAR_BODY_TITLE, 실측 GT2 표④)
    return buildTitleBox(
      (block.text || "").trim(), measured ? GJ_CHAR_BODY_TITLE : CHAR_H1,
      richAssets ? GJ_CHAR_TITLE_BAR : GONGMUN_TITLE_BAR_CHAR,
      tableStyle.totalWidth, bfReg,
    )
  }
  if (ctx.gaejosik) {
    const lvl = block.level || 1
    if (lvl <= 2) {
      // h1(표지 아님)·h2 → 로마숫자 장 헤더 표 (선행 번호는 로마숫자로 대체).
      // 번호는 장 목록 SSOT(gjChapterIdxs — 목차와 공유)에서 조회 (P1-3)
      const no = ctx.gjChapterIdxs.indexOf(blockIdx)
      ctx.chapterNo = no >= 0 ? no + 1 : ctx.chapterNo + 1
      return buildGaejosikChapter(ctx.chapterNo, stripChapterNumber(block.text || ""), gongmun!, gjBodyW, lvl)
    } else if (lvl === 3) {
      // h3 → □ 대항목 (HY헤드라인M 16pt)
      return generateParagraph(`□ ${block.text || ""}`, GONGMUN_LIST_BASE, GJ_CHAR_DAE,
        (id) => (id === CHAR_BOLD ? GJ_CHAR_DAE_BOLD : id))
    }
    // h4~h6 → ○/ㅇ 중항목 (bullet2)
    return generateParagraph(`${gongmun!.bullet2} ${block.text || ""}`, GONGMUN_LIST_BASE + 1, CHAR_NORMAL)
  }
  const pId = headingParaPrId(block.level || 1)
  const cId = headingCharPrId(block.level || 1)
  // 공문서 모드: OUTLINE 대신 명명 스타일("개요 N")로 헤딩 의미 보존 —
  // 한글이 개요 번호("1.")를 강제 렌더하는 결함 회피 + 재파싱 헤딩 감지 유지
  const styleId = gongmun ? Math.min(block.level || 1, 4) : 0
  let hText = block.text || ""
  if (gongmun && (block.level || 1) === 2 && gongmun.h2Marker !== "none") {
    // h2 섹션 제목 말머리 (QA-2) — OUTLINE 번호 제거의 대체. 실측: □ 대항목(보고서
    // 양식 3종) 기본 / 아라비아 번호(공고문 관행) 옵션. 선행 번호는 제거 후 재부여
    const title = stripChapterNumber(hText)
    hText = gongmun.h2Marker === "box" ? `□ ${title}` : `${++ctx.h2Seq}. ${title}`
  }
  return generateParagraph(hText, pId, cId, undefined, styleId)
}

function renderParagraph(block: MdBlock, blockIdx: number, ctx: SectionCtx): string {
  const { gongmun, measured, fit, vBase } = ctx
  // 이미지 참조 문단 (v4.0.5) — `![alt](url)`만으로 구성된 문단은 placeholder
  // <hp:pic>로 방출해 참조·순서를 왕복 보존. 텍스트 혼재·수용 불가 url은 종전 폴백
  if (ctx.images) {
    const { text: rest, urls } = splitImageRefs(block.text || "")
    if (urls.length > 0 && !rest.trim()) {
      const pics = urls.map((u) => {
        const part = ctx.images!.take(u)
        return part ? ctx.images!.inlinePicXml(part) : null
      })
      if (pics.every(Boolean)) {
        return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${pics.join("")}</hp:run></hp:p>`
      }
    }
  }
  // 실측 프리셋(개조식·보고서·계획서): ※/'* '로 시작하는 문단 → 참고 스타일
  // (한양중고딕 13pt — 실측 t1·t3·실결재 다수가 참고를 *로 표기, v4.1.0 GAP-15)
  const pTrim = (block.text || "").trimStart()
  if (measured && (pTrim.startsWith("※") || /^\*\s/.test(pTrim))) {
    return generateParagraph((block.text || "").trim(), GJ_PARA_CHAM, GJ_CHAR_CHAM, ctx.chamMap)
  }
  // 공문서 모드: <center>…</center> → 가운데 정렬 (행정기관명·발신명의)
  const ctr = gongmun && /^<center>([\s\S]*)<\/center>$/i.exec((block.text || "").trim())
  // <right>…</right> → 우측 정렬 (출처행·발신일자 — 실측 GT2/GT6/GT7/GT9 관행)
  const rgt = gongmun && /^<right>([\s\S]*)<\/right>$/i.exec((block.text || "").trim())
  if (ctr) return generateParagraph(ctr[1].trim(), GONGMUN_CENTER)
  if (rgt) {
    const t = rgt[1].trim()
    // '출처:'·'자료:' 캡션은 본문-3pt 전용체(실측 한양중고딕/비실측 본문 폰트)로 —
    // 표 아래 출처를 본문과 구분하는 실무 관행. 그 외 <right>(발신일자 등)는 본문 크기 유지.
    const isSrc = /^(출처|자료)\s*[::]/.test(t)
    const srcChar = ctx.richAssets ? GJ_CHAR_SRC : GONGMUN_SRC_CHAR
    const srcBold = ctx.richAssets ? GJ_CHAR_SRC_BOLD : GONGMUN_SRC_CHAR_BOLD
    const h = isSrc ? srcCaptionPt(gongmun!.bodyHeight) : gongmun!.bodyHeight
    // 본문폭을 넘겨 줄바꿈되는 <right>는 왼쪽 끝이 들쭉날쭉해 들여쓰기가 깨진 듯
    // 보인다(한글 실렌더 QA — 다줄 출처행). 우측 배치 관행은 한 줄일 때만 유지.
    const fits = measureTextWidth(t, h, isSrc ? 100 : GONGMUN_BODY_RATIO) <= ctx.gjBodyW + 0.5
    const paraId = fits ? GONGMUN_RIGHT : GONGMUN_SRC_LEFT
    if (!isSrc) return generateParagraph(t, paraId)
    return generateParagraph(t, paraId, srcChar, (id) => (id === CHAR_BOLD ? srcBold : id))
  }
  return generateParagraph(block.text || "", PARA_NORMAL, CHAR_NORMAL, fit ? variantMapper(fit, blockIdx, vBase) : undefined)
}

function renderCodeBlock(block: MdBlock, blockIdx: number, ctx: SectionCtx): string {
  // ```chart 펜스 → 차트 파트 + <hp:chart> (파싱 실패 시 일반 코드블록 폴백)
  if (ctx.chartParts !== null && (block.lang || "").toLowerCase() === "chart") {
    const fence = parseChartFence(block.text || "")
    if (fence) {
      const partName = `Chart/chart${ctx.chartParts.length + 1}.xml`
      ctx.chartParts.push({ name: partName, xml: buildChartSpaceXml(fence) })
      const chartEl = buildChartElementXml(partName, fence.widthHu, fence.heightHu, CHART_TABLE_ID_BASE + blockIdx)
      ctx.opener.emitCarrier(ctx.paraXmls)
      return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${chartEl}</hp:run></hp:p>`
    }
  }
  const codeLines = (block.text || "").split("\n")
  return codeLines.map(line => generateParagraph(line || " ", PARA_CODE)).join("\n  ")
}

function renderEquation(block: MdBlock, blockIdx: number, ctx: SectionCtx): string {
  ctx.opener.emitCarrier(ctx.paraXmls)
  return generateEquationParagraph(block.text || "", blockIdx)
}

function renderBlockquote(block: MdBlock, ctx: SectionCtx): string {
  // 블록 텍스트는 개행 결합(md-runs — 줄 경계 보존). 실측 프리셋은 블록당 ※ 1문단
  // (공백 결합 — 줄마다 ※가 붙는 쪼개짐 방지), 기본 경로는 줄별 문단(종전 시각 유지)
  if (ctx.measured) {
    const t = (block.text || "").replace(/\n+/g, " ").trim()
    return t ? generateParagraph(t.startsWith("※") ? t : `※ ${t}`, GJ_PARA_CHAM, GJ_CHAR_CHAM, ctx.chamMap) : ""
  }
  // baseline 호환: quoteColor 옵션 없으면 기존처럼 CHAR_NORMAL (이탤릭 아님)
  const quoteChar = ctx.theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL
  return (block.text || "").split("\n")
    .map((line) => generateParagraph(line, PARA_QUOTE, quoteChar))
    .join("\n  ")
}

function renderListItem(block: MdBlock, blockIdx: number, ctx: SectionCtx): string {
  const { gongmun, gongmunList, measured, fit, vBase, dfIds } = ctx
  // 공문서 모드: 항목부호 8단계 + paraPr 단계별 들여쓰기/내어쓰기
  if (gongmun && gongmunList) {
    const info = gongmunList.items.get(blockIdx)
    const depth = info?.depth ?? 0
    const marker = info?.marker ?? ""
    const content = block.text || ""
    // 실측 프리셋: ※ 시작 항목·'*' 마커 항목은 참고 스타일 (v4.1.0 GAP-15 —
    // 실결재·부처별 양식(t1·t3)에서 참고를 '*'로 표기하는 관행이 ※보다 많음.
    // 공문서 모드에서 '* 항목'은 □ 리스트가 아니라 참고 문단으로 해석)
    if (measured && content.trimStart().startsWith("※")) {
      return generateParagraph(content.trim(), GJ_PARA_CHAM, GJ_CHAR_CHAM, ctx.chamMap)
    }
    if (measured && block.marker === "*") {
      return generateParagraph(`* ${content.trim()}`, GJ_PARA_CHAM, GJ_CHAR_CHAM, ctx.chamMap)
    }
    // 부호 + 1타(공백 1개) + 내용 (부호 없으면 내용만).
    // 부호 생략 항목은 내어쓰기 없는 전용 paraPr — depth 공용을 쓰면 유령
    // 내어쓰기로 둘째 줄이 첫 줄보다 더 들어간다 (v4.0.2 실렌더 QA)
    const text = marker ? `${marker} ${content}` : content
    // 두 자리 부호('10.')는 자기 부호폭 내어쓰기 전용 paraPr (v4.0.5 P1-1)
    const listParaPr = marker
      ? (info?.indentVariant !== undefined ? GONGMUN_LIST_VARIANT_BASE + info.indentVariant : GONGMUN_LIST_BASE + depth)
      : GONGMUN_LIST_PLAIN_BASE + depth
    // 비실측 보고서(□○-) 모드의 1단계 □ 대제목은 굵게 — 정부 보고서 관행.
    // 실측 프리셋의 □(개조식·보고서 numbering) 1단계는 전용 HY헤드라인M 16pt
    // (실측: 부처별 양식 3종 전부 □=HY헤드라인M. fit 변형 제외 대상이라 매퍼 불필요)
    let listCharPr = gongmun.numbering === "report" && depth === 0 ? CHAR_BOLD : CHAR_NORMAL
    let mapId = fit ? variantMapper(fit, blockIdx, vBase) : undefined
    if (measured && depth === 0 && gongmun.numbering !== "standard") {
      listCharPr = GJ_CHAR_DAE
      mapId = (id) => (id === CHAR_BOLD ? GJ_CHAR_DAE_BOLD : id)
    }
    if (gongmun.preset === "press") {
      // 보도자료 실측: □ 문단은 본문과 동일(plain), 3단계 *는 각주 12pt
      if (depth === 0) listCharPr = CHAR_NORMAL
      if (depth >= 2 && dfIds) { listCharPr = dfIds.small; mapId = undefined }
    }
    // 단계별 위계 타이포(levels, v4.12.3) — 명시 옵션이라 프리셋 실측값보다 우선.
    // fit 변형은 이 depth 를 제외하므로(gen-gongmun-fit) 본문·굵게만 전용 쌍으로 치환
    const lv = ctx.levelIds?.[depth]
    if (lv) {
      listCharPr = lv.normal
      mapId = (id) => (id === CHAR_BOLD ? lv.bold : id === CHAR_NORMAL ? lv.normal : id)
    }
    return generateParagraph(text, listParaPr, listCharPr, mapId)
  }
  const indent = block.indent || 0
  let marker: string
  if (block.marker) {
    // 원본 마커 보존 — "2." 번호 재시작·"-"→"·" 기호 변형 방지 (왕복 충실도)
    marker = `${block.marker} `
    ctx.prevWasOrdered = !!block.ordered
  } else if (block.ordered) {
    // 러닝 카운터: indent 레벨별로 증가. 하위 레벨(더 깊은 indent)은 별도 세퀀스.
    ctx.orderedCounters[indent] = (ctx.orderedCounters[indent] || 0) + 1
    // 상위 레벨 번호가 바뀌면 하위는 자동 리셋되어야 함 — 한 레벨 위로 올라갈 때 하위 카운터 초기화
    for (const k of Object.keys(ctx.orderedCounters)) {
      if (+k > indent) delete ctx.orderedCounters[+k]
    }
    marker = `${ctx.orderedCounters[indent]}. `
    ctx.prevWasOrdered = true
  } else {
    marker = "· "
    if (ctx.prevWasOrdered) {
      for (const k of Object.keys(ctx.orderedCounters)) delete ctx.orderedCounters[+k]
    }
    ctx.prevWasOrdered = false
  }
  const indentPrefix = "  ".repeat(indent)
  return generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST)
}

function renderHr(ctx: SectionCtx): string {
  // 수평선 — 공문서 모드는 간격 문단 (실측: 정부 문서에 문자 구분선 0건 — G17),
  // 비공문서(기존)는 긴 대시 유지
  return ctx.gongmun
    ? `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}"><hp:t></hp:t></hp:run></hp:p>`
    : `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
}

function renderTable(block: MdBlock, ctx: SectionCtx): string {
  if (!block.rows) return ""
  // 테이블이 첫 블록이면 빈 단락에 secPr
  ctx.opener.emitCarrier(ctx.paraXmls)
  // 프로필 대응은 takeProfile(행·열+앵커 매칭, 순번은 앵커 없을 때 폴백) —
  // parse 가 방출하지 않는 표(1×1 제목박스 등)가 있어도 서식이 밀리지 않는다.
  return generateTable(block.rows, ctx.theme, ctx.tableStyle, ctx.remap, ctx.tableSeq++, ctx.images)
}

function renderHtmlTable(block: MdBlock, ctx: SectionCtx): string {
  const { tableStyle, bfReg } = ctx
  // 실측 모드(bfReg): 데이터 표 축폭 + 호스트 우측정렬 (TBL-09) — 중첩표는 재귀에서 자체 폭 계산
  const htmlW = tableStyle ? (bfReg ? tableStyle.totalWidth - DATA_TABLE_INSET : tableStyle.totalWidth) : 44000
  const tbl = generateHtmlTableXml(block.text || "", ctx.theme, htmlW, tableStyle, ctx.remap, ctx.tableSeq++, ctx.images)
  if (tbl) {
    ctx.opener.emitCarrier(ctx.paraXmls)
    return `<hp:p paraPrIDRef="${tableStyle && bfReg ? GONGMUN_RIGHT : 0}" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
  }
  // 파싱 불가 — 태그 제거한 텍스트 문단 폴백 (원문 HTML을 그대로 싣지 않음)
  const plain = (block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  return plain ? generateParagraph(plain) : ""
}

// ─── 본문 뒤 후면부 (공고 결문·끝표시·기안 결문·보도 담당) ─

function appendPostamble(blocks: MdBlock[], ctx: SectionCtx): void {
  const { gongmun, dfIds, bfReg, tableStyle, paraXmls } = ctx
  // 공고문 결문 — 날짜·발신명의 우측 (실측: 바이오헬스 공고문)
  if (gongmun?.noticeHead && dfIds) {
    paraXmls.push(...buildNoticeFoot(gongmun))
  }
  // 본문 끝 "끝." 표시 (행정업무규정 — 기안문 기본, 그 외 opt-in). 이미 있으면 중복 방지.
  // 판정 대상은 '마지막 렌더 블록' — 말미가 표면 표 뒤에 "끝."이 와야 하므로,
  // 표 앞 문단의 "끝." 우연 매칭으로 방출이 억제되면 안 된다 (v4.0.5 영역5)
  if (gongmun?.endMark && paraXmls.length > 0) {
    const lastBlock = [...blocks].reverse().find((b) =>
      (b.text || "").trim() || (b.type === "table" && b.rows?.length))
    const lastText = lastBlock && (lastBlock.type === "paragraph" || lastBlock.type === "list_item")
      ? lastBlock.text || ""
      : ""
    if (!hasEndMark(lastText)) paraXmls.push(buildEndMark())
  }
  // 기안문 결문 (별지 제1호서식 — "끝." 뒤 발신명의·기안/검토/결재·시행/접수·연락처)
  if (gongmun?.docFoot && dfIds) {
    paraXmls.push(...buildDocFoot(gongmun, dfIds))
  }
  // 보도자료 담당 표 — 문서 말미
  if (gongmun?.press && dfIds && bfReg && tableStyle) {
    paraXmls.push(...buildPressContact(gongmun, dfIds, tableStyle.totalWidth, bfReg))
  }
}

// ─── 메인 조립 ───────────────────────────────────────

export function blocksToSectionXml(
  blocks: MdBlock[],
  theme: ResolvedTheme,
  gongmun: ResolvedGongmun | null,
  gongmunList: GongmunListPlan | null = gongmun ? precomputeGongmunList(blocks, gongmun) : null,
  fit: GongmunFitPlan | null = null,
  chartParts: ChartPart[] | null = null,
  bfReg: TableBfRegistry | null = null,
  remap: ProfileRemap | null = null,
  dfIds: DocframeIds | null = null,
  images: ImageRegistry | null = null,
  page: ResolvedPage | null = null,
  levelIds: LevelCharIds | null = null,
): string {
  // 문서 생성마다 전역 표 id 카운터 리셋 — 같은 프로세스 연속 생성에도 결정적 출력
  resetTableIds(); resetGjTableIds(); resetExtraTableIds()
  // 실측 폰트 프리셋(개조식·보고서·계획서) — 표 셀 맑은 고딕 12pt·※ 한양중고딕 공유 (QA-1)
  const measured = !!gongmun && usesReportFonts(gongmun.preset)
  const richAssets = !!gongmun && needsGaejosikAssets(gongmun)
  const ctx: SectionCtx = {
    theme, gongmun, gongmunList, fit, chartParts, bfReg, remap, dfIds, images, levelIds,
    gaejosik: gongmun?.preset === "gaejosik",
    measured, richAssets,
    vBase: charVariantBase(richAssets, !!gongmun),
    // 공문서 표 스타일 — 본문 폭 맞춤 + 실측 정부 양식(헤더 음영·실측 프리셋 맑은 고딕 12pt)
    // bfReg가 있으면 실측 테두리 위계(외곽 0.4/내부 0.12/헤더 이중선)·셀 문단·우측 배치 적용
    tableStyle: gongmun
      ? {
          totalWidth: mmToHwpunit(210 - gongmun.margins.left - gongmun.margins.right),
          // 표 셀 크기 — 실측: 실측 프리셋 맑은 고딕 12pt(22·23), 비실측도 12pt(11·12,
          // 실결재 지배값 — 본문 크기 셀은 열폭 부족으로 서술 열 세로 신장, v4.0.2 QA)
          charPr: richAssets ? GJ_CHAR_TABLE : GONGMUN_TBL_CHAR,
          boldCharPr: richAssets ? GJ_CHAR_TABLE_BOLD : GONGMUN_TBL_CHAR_BOLD,
          charHeight: richAssets ? gaejosikSizes(gongmun.bodyHeight, gongmun.sizes).table : GONGMUN_TBL_PT,
          headerBf: gongmunTableHeaderBf(richAssets),
          centerParaPr: GONGMUN_CENTER,
          tblCenterParaPr: GONGMUN_TBL_CENTER,
          tblLeftParaPr: GONGMUN_TBL_LEFT,
          bfRegistry: bfReg ?? undefined,
          rightParaPr: GONGMUN_RIGHT,
        }
      : null,
    // 개조식 장식표(표지·목차·장헤더·제목박스) 폭 스케일용 본문폭 — margins 오버라이드 대응
    gjBodyW: gongmun ? mmToHwpunit(210 - gongmun.margins.left - gongmun.margins.right) : GAEJOSIK_BASE_WIDTH,
    chamMap: (id: number) => (id === CHAR_BOLD ? GJ_CHAR_CHAM_BOLD : id),
    opener: new SectionOpener(gongmun, page),
    paraXmls: [],
    // 표 방출 순번 — 생성 성공 여부와 무관하게 '시도' 기준으로 센다. 실패한 표가 이후
    // 표들의 순번을 밀면 앵커 없는 프로필(손편집·구버전)의 table_index 매칭이 어긋난다.
    tableSeq: 0,
    chapterNo: 0,
    h2Seq: 0, // h2 말머리 'number' 모드 아라비아 순번 (QA-2)
    coverH1Idx: -1,
    titleBoxH1Idx: -1,
    pressH1Idx: -1,
    gjChapterIdxs: [],
    pendingPageBreak: false,
    pendingNewNum: false,
    // 순서 있는 목록 카운터 — indent 레벨별 별도 유지. 다른 블록 만나면 해당 레벨 리셋.
    orderedCounters: {},
    prevWasOrdered: false,
  }

  buildPreamble(blocks, ctx)

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx]

    // 순서 있는 list_item이 아니면 카운터 전부 리셋 (연속되지 않은 목록은 다시 1부터)
    if (block.type !== "list_item" || !block.ordered) {
      if (ctx.prevWasOrdered) {
        for (const k of Object.keys(ctx.orderedCounters)) delete ctx.orderedCounters[+k]
      }
      ctx.prevWasOrdered = false
    }

    let xml = ""
    switch (block.type) {
      case "heading": xml = renderHeading(block, blockIdx, ctx); break
      case "paragraph": xml = renderParagraph(block, blockIdx, ctx); break
      case "code_block": xml = renderCodeBlock(block, blockIdx, ctx); break
      case "equation": xml = renderEquation(block, blockIdx, ctx); break
      case "blockquote": xml = renderBlockquote(block, ctx); break
      case "list_item": xml = renderListItem(block, blockIdx, ctx); break
      case "hr": xml = renderHr(ctx); break
      case "table": xml = renderTable(block, ctx); break
      case "html_table": xml = renderHtmlTable(block, ctx); break
    }

    if (!xml) continue

    // 첫 번째 단락에 secPr 주입 — 표는 전용 캐리어 문단(renderTable)이 담당
    if (ctx.opener.isFirst && block.type !== "table") {
      xml = ctx.opener.inject(xml)
    }

    // 개조식 전면부(표지·목차) 뒤 본문 첫 블록은 새 페이지에서
    if (ctx.pendingPageBreak) {
      xml = xml.replace(/^<hp:p /, `<hp:p pageBreak="1" `)
      ctx.pendingPageBreak = false
    }

    // 본문 첫 블록에서 쪽번호 1 재시작 — 표지·목차를 카운트에서 제외 (실측 GT3 newNum)
    if (ctx.pendingNewNum) {
      xml = xml.replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${newPageNumCtrl(1)}`)
      ctx.pendingNewNum = false
    }

    ctx.paraXmls.push(xml)
  }

  appendPostamble(blocks, ctx)

  // 블록이 없으면 빈 단락
  if (ctx.paraXmls.length === 0) {
    ctx.paraXmls.push(ctx.opener.emptyDoc())
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${ctx.paraXmls.join("\n  ")}
</hs:sec>`
}
