/**
 * HWPX 섹션 XML 조립 (generator.ts에서 분리).
 * 섹션 속성(공문서 표준 여백)과 블록 목록 → section0.xml 본문.
 */

import { type ResolvedGongmun, levelIndent, mmToHwpunit, usesReportFonts } from "./gongmun.js"
import { stripChapterNumber, gaejosikSizes } from "./gaejosik.js"
import { buildGaejosikCover, buildGaejosikToc, buildGaejosikChapter, buildGaejosikBodyTitle } from "./gen-gaejosik.js"
import {
  NS_SECTION, NS_PARA,
  CHAR_NORMAL, CHAR_BOLD, CHAR_QUOTE, CHAR_H1, PARA_NORMAL, PARA_QUOTE, PARA_CODE, PARA_LIST,
  GONGMUN_CENTER, GONGMUN_RIGHT, GONGMUN_TBL_CENTER, GONGMUN_TBL_LEFT, GONGMUN_LIST_BASE,
  GJ_CHAR_DAE, GJ_CHAR_DAE_BOLD, GJ_CHAR_CHAM, GJ_CHAR_CHAM_BOLD, GJ_PARA_CHAM,
  GJ_CHAR_TABLE, GJ_CHAR_TABLE_BOLD, GJ_CHAR_BODY_TITLE, gongmunTableHeaderBf,
  charVariantBase, pageNumCtrl, newPageNumCtrl, pageHidingCtrl,
  escapeXml, headingParaPrId, headingCharPrId,
  type ResolvedTheme,
} from "./gen-ids.js"
import { type MdBlock, generateParagraph, generateRuns } from "./md-runs.js"
import { type GongmunFitPlan, variantMapper, precomputeGongmunList } from "./gen-gongmun-fit.js"
import { generateTable, generateHtmlTableXml, DATA_TABLE_INSET, type GongmunTableStyle } from "./gen-table.js"
import { TableBfRegistry } from "./gen-table-bf.js"
import { type ProfileRemap } from "./gen-profile.js"
import { buildApprovalTable, buildEndMark, hasEndMark, buildTitleBox } from "./gen-gongmun-extra.js"
import { generateEquationParagraph } from "./equation-generate.js"
import { parseChartFence, buildChartSpaceXml, buildChartElementXml } from "./chart-gen.js"

/** 생성 중 수집된 차트 파트 — 호출부(generator)가 ZIP·manifest에 등재 */
export interface ChartPart {
  /** ZIP 파트 경로 (Chart/chartN.xml) */
  name: string
  /** chartSpace XML 전문 */
  xml: string
}

// ─── 섹션 속성 (공문서 표준 여백) ────────────────────

function generateSecPr(gongmun: ResolvedGongmun | null): string {
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
    `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${m.header}" footer="${m.footer}" gutter="0" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
  // 쪽번호 — 실측(GT3·GT6·GT7·GT9·GT11): 하단 중앙 "- 1 -". secPr과 같은 run에 배치
  return gongmun?.pageNumbers ? secPr + pageNumCtrl() : secPr
}

// ─── 테이블 생성 ─────────────────────────────────────
//
// HWPX 스펙 완전 준수 버전 — 한글 프로그램(Windows/macOS)이 문서를 거부하지 않으려면
// <hp:tbl> 필수 속성 + <hp:sz>/<hp:pos>/<hp:outMargin>/<hp:inMargin> + 각 cell의
// <hp:subList> 래퍼, <hp:cellAddr>, <hp:cellSz>, <hp:cellMargin>이 전부 있어야 함.
// 또한 테이블은 paragraph 안의 <hp:run><hp:ctrl>... 로 감싸야 한다.
//
// 이슈 #4 참고: v2.4.1 이전엔 최소 스켈레톤만 내서 macOS 한글이 "파일이 깨졌다"며 거부.


export function blocksToSectionXml(
  blocks: MdBlock[],
  theme: ResolvedTheme,
  gongmun: ResolvedGongmun | null,
  gongmunList: Map<number, { marker: string; depth: number }> | null = gongmun ? precomputeGongmunList(blocks, gongmun) : null,
  fit: GongmunFitPlan | null = null,
  chartParts: ChartPart[] | null = null,
  bfReg: TableBfRegistry | null = null,
  remap: ProfileRemap | null = null,
): string {
  const paraXmls: string[] = []
  let isFirst = true
  // 표 방출 순번 — 생성 성공 여부와 무관하게 '시도' 기준으로 센다. 실패한 표가 이후
  // 표들의 순번을 밀면 앵커 없는 프로필(손편집·구버전)의 table_index 매칭이 어긋난다.
  let tableSeq = 0
  // 순서 있는 목록 카운터 — indent 레벨별 별도 유지. 다른 블록 만나면 해당 레벨 리셋.
  const orderedCounters: Record<number, number> = {}
  let prevWasOrdered = false

  // ─── 개조식 전면부(표지·목차) + 장 카운터 ───────────
  const gaejosik = gongmun?.preset === "gaejosik"
  // 실측 폰트 프리셋(개조식·보고서·계획서) — 표 셀 맑은 고딕 12pt·※ 한양중고딕 공유 (QA-1)
  const measured = !!gongmun && usesReportFonts(gongmun.preset)
  const vBase = charVariantBase(measured)
  // 공문서 표 스타일 — 본문 폭 맞춤 + 실측 정부 양식(헤더 음영·실측 프리셋 맑은 고딕 12pt)
  // bfReg가 있으면 실측 테두리 위계(외곽 0.4/내부 0.12/헤더 이중선)·셀 문단·우측 배치 적용
  const tableStyle: GongmunTableStyle | null = gongmun
    ? {
        totalWidth: mmToHwpunit(210 - gongmun.margins.left - gongmun.margins.right),
        charPr: measured ? GJ_CHAR_TABLE : CHAR_NORMAL,
        boldCharPr: measured ? GJ_CHAR_TABLE_BOLD : CHAR_BOLD,
        charHeight: measured ? gaejosikSizes(gongmun.bodyHeight, gongmun.sizes).table : gongmun.bodyHeight,
        headerBf: gongmunTableHeaderBf(gaejosik),
        centerParaPr: GONGMUN_CENTER,
        tblCenterParaPr: GONGMUN_TBL_CENTER,
        tblLeftParaPr: GONGMUN_TBL_LEFT,
        bfRegistry: bfReg ?? undefined,
        rightParaPr: GONGMUN_RIGHT,
      }
    : null
  const chamMap = (id: number) => (id === CHAR_BOLD ? GJ_CHAR_CHAM_BOLD : id)
  let chapterNo = 0
  let h2Seq = 0 // h2 말머리 'number' 모드 아라비아 순번 (QA-2)
  let coverH1Idx = -1
  let pendingPageBreak = false
  let pendingNewNum = false
  let titleBoxH1Idx = -1
  let hasFrontPages = false // 표지·목차 등 본문과 페이지가 분리되는 전면부 존재 여부
  const preamble: string[] = []
  // 결재란 — 문서 최상단 우측 (실측 GT12: 결재선이 표지 최상단)
  if (gongmun?.approval && bfReg) {
    preamble.push(buildApprovalTable(gongmun.approval, gongmun, bfReg))
  }
  if (gaejosik && gongmun) {
    const h1Idx = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
    const chapters = blocks
      .filter((b) => b.type === "heading" && b.level === 2)
      .map((b) => stripChapterNumber(b.text || ""))
    let coverTitle = ""
    // 표지·목차 페이지 쪽번호 숨김 (실측 GT3: pageHiding hidePageNum=1 ×2) — 페이지 첫 문단 run에 주입
    const hide = (xml: string, hideHeader: boolean) =>
      gongmun!.pageNumbers ? xml.replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${pageHidingCtrl(hideHeader)}`) : xml
    if (gongmun.cover && h1Idx >= 0) {
      coverTitle = (blocks[h1Idx].text || "").trim()
      const coverPart = buildGaejosikCover(coverTitle, gongmun)
      coverPart[0] = hide(coverPart[0], true)
      preamble.push(...coverPart)
      coverH1Idx = h1Idx
      hasFrontPages = true
    }
    if (gongmun.toc && chapters.length > 0) {
      const tocPart = buildGaejosikToc(chapters, gongmun)
      tocPart[0] = hide(tocPart[0], false)
      preamble.push(...tocPart)
      hasFrontPages = true
    }
    // 본문 첫 페이지 제목 반복 박스 (실측 GT3 표④·GT12) — 표지/목차 뒤 새 페이지 선두
    if (gongmun.bodyTitleBox && coverTitle && hasFrontPages) {
      preamble.push(buildGaejosikBodyTitle(coverTitle, gongmun).replace(/^<hp:p /, `<hp:p pageBreak="1" `))
    }
  } else if (gongmun && !gaejosik && bfReg && (gongmun.preset === "report" || gongmun.preset === "plan" || gongmun.preset === "notice")) {
    // 1페이지형 제목박스 (실측 GT2/GT6/GT7: 색상바+제목+gradient바) — 첫 h1을 박스로
    titleBoxH1Idx = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
  }
  if (preamble.length > 0) {
    // 섹션 첫 문단이 페이지 설정(secPr)을 지니므로 여기서 주입, 선두 쪽나눔은 제거
    preamble[0] = preamble[0]
      .replace(` pageBreak="1"`, "")
      .replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${generateSecPr(gongmun)}`)
    isFirst = false
    // 본문 첫 블록 쪽나눔 — 전면부가 있고, 제목박스가 그 쪽나눔을 이미 소화하지 않았을 때만
    pendingPageBreak = hasFrontPages && !preamble[preamble.length - 1].includes(`pageBreak="1"`)
    // 표지·목차가 있으면 본문에서 쪽번호 1 재시작 (실측 GT3 newNum)
    pendingNewNum = !!gongmun!.pageNumbers && hasFrontPages
    paraXmls.push(...preamble)
  }

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx]
    let xml = ""

    // 순서 있는 list_item이 아니면 카운터 전부 리셋 (연속되지 않은 목록은 다시 1부터)
    if (block.type !== "list_item" || !block.ordered) {
      if (prevWasOrdered) {
        for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
      }
      prevWasOrdered = false
    }

    switch (block.type) {
      case "heading": {
        if (gongmun && blockIdx === titleBoxH1Idx && tableStyle && bfReg) {
          // 1페이지형 제목박스 (실측 GT2/GT6/GT7) — report/plan/notice 첫 h1.
          // 실측 프리셋은 제목박스 전용 HY헤드라인M 22pt(GJ_CHAR_BODY_TITLE, 실측 GT2 표④)
          xml = buildTitleBox((block.text || "").trim(), measured ? GJ_CHAR_BODY_TITLE : CHAR_H1, tableStyle.totalWidth, bfReg)
          break
        }
        if (gaejosik) {
          const lvl = block.level || 1
          if (blockIdx === coverH1Idx) break // 표지가 소비한 h1
          if (lvl <= 2) {
            // h1(표지 아님)·h2 → 로마숫자 장 헤더 표 (선행 번호는 로마숫자로 대체)
            chapterNo++
            xml = buildGaejosikChapter(chapterNo, stripChapterNumber(block.text || ""), gongmun!)
          } else if (lvl === 3) {
            // h3 → □ 대항목 (HY헤드라인M 16pt)
            xml = generateParagraph(`□ ${block.text || ""}`, GONGMUN_LIST_BASE, GJ_CHAR_DAE,
              (id) => (id === CHAR_BOLD ? GJ_CHAR_DAE_BOLD : id))
          } else {
            // h4~h6 → ○ 중항목
            xml = generateParagraph(`○ ${block.text || ""}`, GONGMUN_LIST_BASE + 1, CHAR_NORMAL)
          }
          break
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
          hText = gongmun.h2Marker === "box" ? `□ ${title}` : `${++h2Seq}. ${title}`
        }
        xml = generateParagraph(hText, pId, cId, undefined, styleId)
        break
      }
      case "paragraph": {
        // 실측 프리셋(개조식·보고서·계획서): ※로 시작하는 문단 → 참고 스타일 (한양중고딕 13pt)
        if (measured && (block.text || "").trimStart().startsWith("※")) {
          xml = generateParagraph((block.text || "").trim(), GJ_PARA_CHAM, GJ_CHAR_CHAM, chamMap)
          break
        }
        // 공문서 모드: <center>…</center> → 가운데 정렬 (행정기관명·발신명의)
        const ctr = gongmun && /^<center>([\s\S]*)<\/center>$/i.exec((block.text || "").trim())
        // <right>…</right> → 우측 정렬 (출처행·발신일자 — 실측 GT2/GT6/GT7/GT9 관행)
        const rgt = gongmun && /^<right>([\s\S]*)<\/right>$/i.exec((block.text || "").trim())
        if (ctr) {
          xml = generateParagraph(ctr[1].trim(), GONGMUN_CENTER)
        } else if (rgt) {
          xml = generateParagraph(rgt[1].trim(), GONGMUN_RIGHT)
        } else {
          xml = generateParagraph(block.text || "", PARA_NORMAL, CHAR_NORMAL, fit ? variantMapper(fit, blockIdx, vBase) : undefined)
        }
        break
      }
      case "code_block": {
        // ```chart 펜스 → 차트 파트 + <hp:chart> (파싱 실패 시 일반 코드블록 폴백)
        if (chartParts !== null && (block.lang || "").toLowerCase() === "chart") {
          const fence = parseChartFence(block.text || "")
          if (fence) {
            const partName = `Chart/chart${chartParts.length + 1}.xml`
            chartParts.push({ name: partName, xml: buildChartSpaceXml(fence) })
            const chartEl = buildChartElementXml(partName, fence.widthHu, fence.heightHu, 9_100_000 + blockIdx)
            if (isFirst) {
              const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
              paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
              isFirst = false
            }
            xml = `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${chartEl}</hp:run></hp:p>`
            break
          }
        }
        const codeLines = (block.text || "").split("\n")
        xml = codeLines.map(line => generateParagraph(line || " ", PARA_CODE)).join("\n  ")
        break
      }
      case "equation": {
        if (isFirst) {
          const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
          paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
          isFirst = false
        }
        xml = generateEquationParagraph(block.text || "", blockIdx)
        break
      }
      case "blockquote": {
        // 실측 프리셋(개조식·보고서·계획서): 인용문 → ※ 참고 (한양중고딕 13pt)
        if (measured) {
          const t = (block.text || "").trim()
          if (t) xml = generateParagraph(t.startsWith("※") ? t : `※ ${t}`, GJ_PARA_CHAM, GJ_CHAR_CHAM, chamMap)
          break
        }
        // baseline 호환: quoteColor 옵션 없으면 기존처럼 CHAR_NORMAL (이탤릭 아님)
        xml = generateParagraph(
          block.text || "",
          PARA_QUOTE,
          theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL,
        )
        break
      }
      case "list_item": {
        // 공문서 모드: 항목부호 8단계 + paraPr 단계별 들여쓰기/내어쓰기
        if (gongmun && gongmunList) {
          const info = gongmunList.get(blockIdx)
          const depth = info?.depth ?? 0
          const marker = info?.marker ?? ""
          const content = block.text || ""
          // 실측 프리셋: ※로 시작하는 항목은 부호 없이 참고 스타일
          if (measured && content.trimStart().startsWith("※")) {
            xml = generateParagraph(content.trim(), GJ_PARA_CHAM, GJ_CHAR_CHAM, chamMap)
            break
          }
          // 부호 + 1타(공백 1개) + 내용 (부호 없으면 내용만)
          const text = marker ? `${marker} ${content}` : content
          // 비실측 보고서(□○-) 모드의 1단계 □ 대제목은 굵게 — 정부 보고서 관행.
          // 실측 프리셋의 □(개조식·보고서 numbering) 1단계는 전용 HY헤드라인M 16pt
          // (실측: 부처별 양식 3종 전부 □=HY헤드라인M. fit 변형 제외 대상이라 매퍼 불필요)
          let listCharPr = gongmun.numbering === "report" && depth === 0 ? CHAR_BOLD : CHAR_NORMAL
          let mapId = fit ? variantMapper(fit, blockIdx, vBase) : undefined
          if (measured && depth === 0 && gongmun.numbering !== "standard") {
            listCharPr = GJ_CHAR_DAE
            mapId = (id) => (id === CHAR_BOLD ? GJ_CHAR_DAE_BOLD : id)
          }
          xml = generateParagraph(text, GONGMUN_LIST_BASE + depth, listCharPr, mapId)
          break
        }
        const indent = block.indent || 0
        let marker: string
        if (block.marker) {
          // 원본 마커 보존 — "2." 번호 재시작·"-"→"·" 기호 변형 방지 (왕복 충실도)
          marker = `${block.marker} `
          prevWasOrdered = !!block.ordered
        } else if (block.ordered) {
          // 러닝 카운터: indent 레벨별로 증가. 하위 레벨(더 깊은 indent)은 별도 세퀀스.
          orderedCounters[indent] = (orderedCounters[indent] || 0) + 1
          // 상위 레벨 번호가 바뀌면 하위는 자동 리셋되어야 함 — 한 레벨 위로 올라갈 때 하위 카운터 초기화
          for (const k of Object.keys(orderedCounters)) {
            if (+k > indent) delete orderedCounters[+k]
          }
          marker = `${orderedCounters[indent]}. `
          prevWasOrdered = true
        } else {
          marker = "· "
          if (prevWasOrdered) {
            for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
          }
          prevWasOrdered = false
        }
        const indentPrefix = "  ".repeat(indent)
        xml = generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST)
        break
      }
      case "hr":
        // 수평선 — 공문서 모드는 간격 문단 (실측: 정부 문서에 문자 구분선 0건 — G17),
        // 비공문서(기존)는 긴 대시 유지
        xml = gongmun
          ? `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}"><hp:t></hp:t></hp:run></hp:p>`
          : `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
        break
      case "table":
        if (block.rows) {
          if (isFirst) {
            // 테이블이 첫 블록이면 빈 단락에 secPr
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          // 프로필 대응은 takeProfile(행·열+앵커 매칭, 순번은 앵커 없을 때 폴백) —
          // parse 가 방출하지 않는 표(1×1 제목박스 등)가 있어도 서식이 밀리지 않는다.
          xml = generateTable(block.rows, theme, tableStyle, remap, tableSeq++)
        }
        break
      case "html_table": {
        // 실측 모드(bfReg): 데이터 표 축폭 + 호스트 우측정렬 (TBL-09) — 중첩표는 재귀에서 자체 폭 계산
        const htmlW = tableStyle ? (bfReg ? tableStyle.totalWidth - DATA_TABLE_INSET : tableStyle.totalWidth) : 44000
        const tbl = generateHtmlTableXml(block.text || "", theme, htmlW, tableStyle, remap, tableSeq++)
        if (tbl) {
          if (isFirst) {
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = `<hp:p paraPrIDRef="${tableStyle && bfReg ? GONGMUN_RIGHT : 0}" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
        } else {
          // 파싱 불가 — 태그 제거한 텍스트 문단 폴백 (원문 HTML을 그대로 싣지 않음)
          const plain = (block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          xml = plain ? generateParagraph(plain) : ""
        }
        break
      }
    }

    if (!xml) continue

    // 첫 번째 단락에 secPr 주입
    if (isFirst && block.type !== "table") {
      xml = xml.replace(
        /<hp:run charPrIDRef="(\d+)">/,
        `<hp:run charPrIDRef="$1">${generateSecPr(gongmun)}`
      )
      isFirst = false
    }

    // 개조식 전면부(표지·목차) 뒤 본문 첫 블록은 새 페이지에서
    if (pendingPageBreak) {
      xml = xml.replace(/^<hp:p /, `<hp:p pageBreak="1" `)
      pendingPageBreak = false
    }

    // 본문 첫 블록에서 쪽번호 1 재시작 — 표지·목차를 카운트에서 제외 (실측 GT3 newNum)
    if (pendingNewNum) {
      xml = xml.replace(/<hp:run charPrIDRef="(\d+)">/, `<hp:run charPrIDRef="$1">${newPageNumCtrl(1)}`)
      pendingNewNum = false
    }

    paraXmls.push(xml)
  }

  // 본문 끝 "끝." 표시 (행정업무규정 — 기안문 기본, 그 외 opt-in). 이미 있으면 중복 방지
  if (gongmun?.endMark && paraXmls.length > 0) {
    const lastText = [...blocks].reverse().find((b) => (b.type === "paragraph" || b.type === "list_item") && (b.text || "").trim())?.text ?? ""
    if (!hasEndMark(lastText)) paraXmls.push(buildEndMark())
  }

  // 블록이 없으면 빈 단락
  if (paraXmls.length === 0) {
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run></hp:p>`)
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${paraXmls.join("\n  ")}
</hs:sec>`
}
