/**
 * HWPX 섹션 XML 조립 (generator.ts에서 분리).
 * 섹션 속성(공문서 표준 여백)과 블록 목록 → section0.xml 본문.
 */

import { type ResolvedGongmun, levelIndent, mmToHwpunit } from "./gongmun.js"
import {
  NS_SECTION, NS_PARA,
  CHAR_NORMAL, CHAR_BOLD, CHAR_QUOTE, PARA_NORMAL, PARA_QUOTE, PARA_CODE, PARA_LIST,
  GONGMUN_CENTER, GONGMUN_LIST_BASE,
  escapeXml, headingParaPrId, headingCharPrId,
  type ResolvedTheme,
} from "./gen-ids.js"
import { type MdBlock, generateParagraph, generateRuns } from "./md-runs.js"
import { type GongmunFitPlan, variantMapper, precomputeGongmunList } from "./gen-gongmun-fit.js"
import { generateTable, generateHtmlTableXml } from "./gen-table.js"
import { type ProfileRemap } from "./gen-profile.js"
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
  // outlineShapeIDRef="1" — 헤딩 paraPr(OUTLINE)이 쓰는 빈 서식 numbering (gen-header buildNumberings)
  return `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
      `<hp:margin header="${m.header}" footer="${m.footer}" gutter="0" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
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
        const pId = headingParaPrId(block.level || 1)
        const cId = headingCharPrId(block.level || 1)
        xml = generateParagraph(block.text || "", pId, cId)
        break
      }
      case "paragraph": {
        // 공문서 모드: <center>…</center> → 가운데 정렬 (행정기관명·발신명의)
        const ctr = gongmun && /^<center>([\s\S]*)<\/center>$/i.exec((block.text || "").trim())
        if (ctr) {
          xml = generateParagraph(ctr[1].trim(), GONGMUN_CENTER)
        } else {
          xml = generateParagraph(block.text || "", PARA_NORMAL, CHAR_NORMAL, fit ? variantMapper(fit, blockIdx) : undefined)
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
      case "blockquote":
        // baseline 호환: quoteColor 옵션 없으면 기존처럼 CHAR_NORMAL (이탤릭 아님)
        xml = generateParagraph(
          block.text || "",
          PARA_QUOTE,
          theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL,
        )
        break
      case "list_item": {
        // 공문서 모드: 항목부호 8단계 + paraPr 단계별 들여쓰기/내어쓰기
        if (gongmun && gongmunList) {
          const info = gongmunList.get(blockIdx)
          const depth = info?.depth ?? 0
          const marker = info?.marker ?? ""
          const content = block.text || ""
          // 부호 + 1타(공백 1개) + 내용 (부호 없으면 내용만)
          const text = marker ? `${marker} ${content}` : content
          // 보고서(□○-) 모드의 1단계 □ 대제목은 굵게 — 정부 보고서 관행
          const listCharPr = gongmun.numbering === "report" && depth === 0 ? CHAR_BOLD : CHAR_NORMAL
          xml = generateParagraph(text, GONGMUN_LIST_BASE + depth, listCharPr, fit ? variantMapper(fit, blockIdx) : undefined)
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
        // 수평선 — 긴 대시로 대체
        xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
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
          xml = generateTable(block.rows, theme, remap, tableSeq++)
        }
        break
      case "html_table": {
        const tbl = generateHtmlTableXml(block.text || "", theme, 44000, remap, tableSeq++)
        if (tbl) {
          if (isFirst) {
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
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

    paraXmls.push(xml)
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
