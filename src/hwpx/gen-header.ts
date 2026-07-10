/**
 * HWPX 패키지 구조 파일(container/manifest)과 head.xml 생성 (generator.ts에서 분리).
 */

import { type ResolvedGongmun, levelIndent, markerWidth, usesReportFonts } from "./gongmun.js"
import { gaejosikSizes, gaejosikSpaceBefore, gaejosikChamIndent, gaejosikTocItemIndent, GAEJOSIK_COLORS } from "./gaejosik.js"
import {
  NS_HEAD, NS_OPF, NS_HPF, NS_OCF, NS_PARA, NS_CORE,
  CHAR_TABLE_HEADER, CHAR_QUOTE,
  GONGMUN_BODY_RATIO, GONGMUN_LIST_BASE, GONGMUN_LIST_LEVELS,
  GONGMUN_CENTER, GONGMUN_RIGHT, GONGMUN_TBL_CENTER, GONGMUN_TBL_LEFT,
  GJ_PARA_CHAM, GJ_PARA_COVER, GJ_PARA_TOC_ITEM, GJ_PARA_CHAPTER, GJ_PARA_BAR,
  charPr, paraPr, borderFillEntry, type BorderSide,
  type ResolvedTheme,
} from "./gen-ids.js"

// ─── HWPX 구조 파일 생성 ─────────────────────────────

export function generateContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`
}

export function generateManifest(chartParts: Array<{ name: string }> = []): string {
  const chartItems = chartParts
    .map((p, i) => `\n    <opf:item id="chart${i + 1}" href="${p.name}" media-type="application/xml"/>`)
    .join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>${chartItems}
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="no"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`
}

// ─── charPr 생성 헬퍼 ───────────────────────────────

/** charProperties 블록 생성 — 공문서 모드면 본문/제목 height를 표준값으로 */
function buildCharProperties(theme: ResolvedTheme, gongmun: ResolvedGongmun | null, ratioVariants: number[] = [], extraCharPrXmls: string[] = []): string {
  // 실측 폰트 프리셋(개조식·보고서·계획서) — 제목 HY헤드라인M·본문 휴먼명조 (QA-1, 부처별 양식 3종 실측)
  const measured = !!gongmun && usesReportFonts(gongmun.preset)
  // 비공문서(기존 동작): 본문 10pt
  let body = 1000, code = 900, h1 = 1800, h2 = 1400, h3 = 1200, h4 = 1100
  if (gongmun) {
    body = gongmun.bodyHeight
    code = Math.max(body - 200, 900)
    h1 = gongmun.preset === "report" || gongmun.preset === "plan" ? 2000 : 1700
    h2 = 1600
    h3 = body
    h4 = Math.max(body - 100, 1300)
  }
  // 실측 프리셋 본문 = 휴먼명조(fontface id 4). 그 외 공문서·비공문서 = 기본 본문 폰트(id 0)
  const bodyFont = measured ? 4 : 0
  // 제목 계열 — 실측 프리셋은 HY헤드라인M(id 3, 자체 굵기라 bold 없음. 실측: □·제목 전부
  // bold=0), 그 외는 함초롬돋움(id 1) bold (범용 헤딩 관행)
  const hFont = measured ? 3 : 1
  const hBold = !measured
  // 공문서 본문 장평 95%(orphan 압축). 비공문서·제목은 100 유지.
  const bodyRatio = gongmun ? GONGMUN_BODY_RATIO : 100
  const rows = [
    charPr(0, body, false, false, bodyFont, theme.body, bodyRatio),
    charPr(1, body, true, false, bodyFont, theme.body, bodyRatio),
    charPr(2, body, false, true, bodyFont, theme.body, bodyRatio),
    charPr(3, body, true, true, bodyFont, theme.body, bodyRatio),
    charPr(4, code, false, false, 1),
    charPr(5, h1, hBold, false, hFont, theme.h1),
    charPr(6, h2, hBold, false, hFont, theme.h2),
    charPr(7, h3, hBold, false, hFont, theme.h3),
    charPr(8, h4, hBold, false, hFont, theme.h4),
    charPr(CHAR_TABLE_HEADER, body, theme.tableHeaderBold, false, bodyFont, theme.tableHeader),
    charPr(CHAR_QUOTE, body, false, true, bodyFont, theme.quote),
  ]
  if (measured) {
    // 부호·요소별 전용 charPr 11~25 (gen-ids GJ_CHAR_*) — 실측 스펙 (gaejosik.ts).
    // 보고서·계획서도 ※(13·14)·표 셀(22·23)·제목박스(25)를 쓰므로 블록 전체를 공유 등록
    const sz = gaejosikSizes(body, gongmun!.sizes)
    rows.push(
      charPr(11, sz.dae, false, false, 3),                              // □ HY헤드라인M
      charPr(12, sz.dae, true, false, 3),                               // □ bold
      charPr(13, sz.cham, false, false, 5),                             // ※ 한양중고딕
      charPr(14, sz.cham, true, false, 5),                              // ※ bold
      charPr(15, sz.chapter, true, false, 4, "#FFFFFF"),                // 장 로마숫자(흰)
      charPr(16, sz.chapter, false, false, 3),                          // 장 제목
      charPr(17, sz.coverTitle, false, false, 3),                       // 표지 제목
      charPr(18, sz.coverSub, false, false, 3),                         // 표지 날짜·기관명
      charPr(19, sz.tocLabel, true, false, 3),                          // 목  차
      charPr(20, sz.tocRoman, true, false, 6),                          // 목차 로마숫자(한양신명조)
      charPr(21, sz.tocItem, false, false, 3),                          // 목차 항목
      charPr(22, sz.table, false, false, 7),                            // 표 셀(맑은 고딕 12pt)
      charPr(23, sz.table, true, false, 7),                             // 표 셀 bold
      charPr(24, sz.bar, false, false, 4),                              // 표지 바 셀 빈 문단(6pt)
      charPr(25, sz.bodyTitle, false, false, 3),                        // 본문 제목박스(HY헤드라인M 22pt, 실측 GT3 표④)
    )
  }
  // 자동 장평 변형 — 본문 계열(0~3)의 장평만 바꾼 복제본
  for (const r of ratioVariants) {
    rows.push(
      charPr(rows.length, body, false, false, bodyFont, theme.body, r),
      charPr(rows.length + 1, body, true, false, bodyFont, theme.body, r),
      charPr(rows.length + 2, body, false, true, bodyFont, theme.body, r),
      charPr(rows.length + 3, body, true, true, bodyFont, theme.body, r),
    )
  }
  // 서식 프로필 charPr — variant 다음 id로 이미 부여됨(gen-profile.buildProfileRemap)
  rows.push(...extraCharPrXmls)
  return `<hh:charProperties itemCnt="${rows.length}">\n${rows.join("\n")}\n    </hh:charProperties>`
}

/** paraProperties 블록 생성 — 공문서 모드면 본문 줄간격·제목 가운데 + 항목단계 8종 추가 */
function buildParaProperties(gongmun: ResolvedGongmun | null): string {
  if (!gongmun) {
    // 일반 경로도 어절 단위 유지(keepWord) — 종전 산출물의 실제 조판(BREAK_WORD=어절,
    // gen-ids 매핑 역전 정정 전 값)과 동일한 행동 보존. 글자 단위가 필요하면 keepWord: false.
    const base = [
      paraPr(0, { keepWord: true }),
      paraPr(1, { align: "LEFT", spaceBefore: 800, spaceAfter: 200, lineSpacing: 180, outlineLevel: 0, keepWord: true }),
      paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: 170, outlineLevel: 1, keepWord: true }),
      paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: 160, outlineLevel: 2, keepWord: true }),
      paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: 160, outlineLevel: 3, keepWord: true }),
      paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400, keepWord: true }),
      paraPr(6, { align: "LEFT", lineSpacing: 150, indent: 600, keepWord: true }),
      paraPr(7, { align: "LEFT", lineSpacing: 160, indent: 600, keepWord: true }),
    ]
    return `<hh:paraProperties itemCnt="${base.length}">\n${base.join("\n")}\n    </hh:paraProperties>`
  }
  const ls = gongmun.lineSpacing
  const titleAlign = gongmun.centerTitle ? "CENTER" : "LEFT"
  // 공문서 모드 전 문단 어절 단위 줄바꿈(keepWord) — 한글이 단어 중간에서 끊기지 않음.
  // 헤딩에 outlineLevel(OUTLINE)을 주지 않는다 — 한글이 개요 번호("1.", "1.1.")를
  // 화면에 덧붙여 제목이 "1. 행정안전부"로 렌더되는 결함 (COM 실렌더 확인).
  // 실측 정합: 실제 공문서(GT6/GT7 등)는 개요 스타일을 정의만 하고 쓰지 않는다.
  // h2 말머리(□/번호) 문단 — 실측 □ 대항목: 문단 위 15pt(=body×2)·내어쓰기 부호 실폭
  // (부처별 양식 3종, QA-2). 부호폭 기준 크기 1600 = buildCharProperties h2와 동기.
  const h2Geom = gongmun.h2Marker !== "none"
    ? { spaceBefore: Math.round(gongmun.bodyHeight * 2), spaceAfter: 0, indent: -markerWidth(gongmun.h2Marker === "box" ? "□" : "1.", 1600) }
    : { spaceBefore: 600, spaceAfter: 150 }
  const base = [
    paraPr(0, { lineSpacing: ls, keepWord: true }),
    paraPr(1, { align: titleAlign, spaceBefore: 400, spaceAfter: 400, lineSpacing: ls, keepWord: true }),
    paraPr(2, { align: "LEFT", ...h2Geom, lineSpacing: ls, keepWord: true }),
    paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: ls, keepWord: true }),
    paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: ls, keepWord: true }),
    paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400, keepWord: true }),
    paraPr(6, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true }),
    paraPr(7, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true }),
  ]
  // 항목 단계별 paraPr (8 ~ 8+7): left/내어쓰기 indent
  for (let d = 0; d < GONGMUN_LIST_LEVELS; d++) {
    const { left, indent } = levelIndent(d, gongmun.bodyHeight, gongmun.numbering, gongmun.sizes)
    // 단락 위 간격 — 개조식은 실측 스펙(□15/○10/-6pt), 보고서는 1단계 □ 관행 간격
    const sectionGap = gongmun.numbering === "gaejosik"
      ? gaejosikSpaceBefore(d, gongmun.bodyHeight)
      : gongmun.numbering === "report" && d === 0 ? Math.round(gongmun.bodyHeight * 0.5) : 0
    // □ 대항목은 다음 문단과 같은 쪽에 — 쪽 하단 고아 표제 방지 (장헤더와 동일 관행)
    const keepNext = gongmun.numbering === "gaejosik" && d === 0
    base.push(paraPr(GONGMUN_LIST_BASE + d, { align: "JUSTIFY", lineSpacing: ls, left, indent, spaceBefore: sectionGap, keepWord: true, keepWithNext: keepNext }))
  }
  // 가운데정렬 본문 단락(발신명의 등)
  base.push(paraPr(GONGMUN_CENTER, { align: "CENTER", lineSpacing: ls, keepWord: true }))
  // 오른쪽정렬(데이터 표 호스트·출처행 — 실측: GT6/GT7/GT11 관행)
  base.push(paraPr(GONGMUN_RIGHT, { align: "RIGHT", lineSpacing: ls, keepWord: true }))
  // 표 셀 전용 — 실측(GT1 표⑪): CENTER 130% / 장문 열 LEFT 130%. 셀 문단은 어절유지
  base.push(paraPr(GONGMUN_TBL_CENTER, { align: "CENTER", lineSpacing: 130, keepWord: true }))
  base.push(paraPr(GONGMUN_TBL_LEFT, { align: "LEFT", lineSpacing: 130, keepWord: true }))
  if (gongmun.preset === "gaejosik") {
    // 개조식 전용 paraPr 17~21 (gen-ids GJ_PARA_*)
    const cham = gaejosikChamIndent(gongmun.bodyHeight, gongmun.sizes)
    const toc = gaejosikTocItemIndent(gongmun.bodyHeight, gongmun.sizes)
    base.push(
      paraPr(GJ_PARA_CHAM, { align: "JUSTIFY", lineSpacing: ls, left: cham.left, indent: cham.indent, spaceBefore: gaejosikSpaceBefore(3, gongmun.bodyHeight), keepWord: true }),
      paraPr(GJ_PARA_COVER, { align: "CENTER", lineSpacing: 130, keepWord: true }),
      paraPr(GJ_PARA_TOC_ITEM, { align: "LEFT", lineSpacing: 160, left: toc.left, indent: toc.indent, spaceBefore: 1800, keepWord: true }),
      // 장 헤더는 다음 문단과 같은 쪽에 — 쪽 하단 고아 헤더 방지 (실렌더 확인 이슈)
      paraPr(GJ_PARA_CHAPTER, { align: "LEFT", lineSpacing: ls, spaceBefore: 2400, spaceAfter: 600, keepWord: true, keepWithNext: true }),
      // 표지 장식 바 셀 빈 문단 — 저줄간격(실측 71%)으로 바 높이 818 안에 수납
      paraPr(GJ_PARA_BAR, { align: "CENTER", lineSpacing: 70, keepWord: true }),
    )
  } else if (usesReportFonts(gongmun.preset)) {
    // 보고서·계획서 — ※ 참고 문단(한양중고딕 13pt 실측 스타일)만 개조식과 공유 (QA-1)
    const cham = gaejosikChamIndent(gongmun.bodyHeight, gongmun.sizes)
    base.push(
      paraPr(GJ_PARA_CHAM, { align: "JUSTIFY", lineSpacing: ls, left: cham.left, indent: cham.indent, spaceBefore: gaejosikSpaceBefore(3, gongmun.bodyHeight), keepWord: true }),
    )
  }
  return `<hh:paraProperties itemCnt="${base.length}">\n${base.join("\n")}\n    </hh:paraProperties>`
}

/**
 * 개요(OUTLINE) 문단이 참조하는 numbering 정의 — 헤딩 paraPr(1~4)이 사용.
 * 실제 한컴 파일의 paraHead 속성을 미러하되 번호 서식 텍스트를 비워
 * 화면에는 번호가 붙지 않는다 (secPr outlineShapeIDRef="1"이 이 정의를 가리킴).
 */
function buildNumberings(): string {
  const heads = Array.from({ length: 7 }, (_, i) =>
    `        <hh:paraHead start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/>`
  ).join("\n")
  return `<hh:numberings itemCnt="1">
      <hh:numbering id="1" start="0">
${heads}
      </hh:numbering>
    </hh:numberings>`
}

// ─── fontfaces / borderFills ─────────────────────────

/** 한 폰트 항목 XML — typeInfo는 한컴 관례상 존재만 하면 됨(범용값) */
function fontEntry(id: number, face: string, weight = 6): string {
  return `        <hh:font id="${id}" face="${face}" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="${weight}" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>`
}

function buildFontFaces(gongmun: ResolvedGongmun | null, bodyFace: string): string {
  if (gongmun && usesReportFonts(gongmun.preset)) {
    // 실측 폰트 프리셋(개조식·보고서·계획서) — 실측 양식의 폰트 세트. 모든 언어에 동일
    // 목록(한글 폰트의 라틴 글리프 사용, 실제 정부 양식 hwpx도 전 언어 동일 id 참조).
    // fonts 옵션으로 역할별 오버라이드: id 3=heading(제목 계열) / 4=body(본문) / 5=ref(※) / 7=table(표 셀)
    const ov = gongmun.fonts
    // 본문 기본 휴먼명조(실측). 보고서·계획서는 bodyFont='gothic' 명시 시 맑은 고딕 존중
    const bodyDefault = gongmun.preset !== "gaejosik" && gongmun.bodyFont === "gothic" ? "맑은 고딕" : "휴먼명조"
    const faces = [
      "함초롬바탕", "함초롬돋움", "HY견고딕",
      ov.heading ?? "HY헤드라인M", ov.body ?? bodyDefault, ov.ref ?? "한양중고딕",
      "한양신명조", ov.table ?? "맑은 고딕",
    ]
    // weight는 위치 기준(2·3 = 견고딕·제목 계열 9) — 오버라이드 폰트명과 무관하게 유지
    const list = faces.map((f, i) => fontEntry(i, f, i === 2 || i === 3 ? 9 : 6)).join("\n")
    const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"]
    return `<hh:fontfaces itemCnt="${langs.length}">\n` +
      langs.map((l) => `      <hh:fontface lang="${l}" fontCnt="${faces.length}">\n${list}\n      </hh:fontface>`).join("\n") +
      `\n    </hh:fontfaces>`
  }
  return `<hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="3">
${fontEntry(0, bodyFace)}
${fontEntry(1, "함초롬돋움")}
${fontEntry(2, "HY견고딕", 9)}
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="3">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
        <hh:font id="1" face="Consolas" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_MODERN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
        <hh:font id="2" face="Arial Black" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
${fontEntry(0, "함초롬바탕")}
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
${fontEntry(0, "굴림")}
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
${fontEntry(0, "굴림")}
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
${fontEntry(0, "Symbol")}
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
${fontEntry(0, "굴림")}
      </hh:fontface>
    </hh:fontfaces>`
}

function buildBorderFills(gongmun: ResolvedGongmun | null, extra: string[] = []): string {
  const thin: BorderSide = ["0.12 mm", "#000000"]
  const items = [
    borderFillEntry(1, {}),
    borderFillEntry(2, { l: thin, r: thin, t: thin, b: thin }),
  ]
  if (gongmun?.preset === "gaejosik") {
    // 개조식 전용 3~9 (gen-ids GJ_BF_*) — 실측 색상 (gaejosik.ts GAEJOSIK_COLORS)
    const c = GAEJOSIK_COLORS
    const edge: BorderSide = ["0.12 mm", c.border]
    const grayLine: BorderSide = ["0.1 mm", c.titleLine]
    const tocEdge: BorderSide = ["0.4 mm", c.tocBorder]
    items.push(
      borderFillEntry(3, { l: edge, r: edge, t: edge, b: edge }, c.primary), // 장 로마숫자 셀
      borderFillEntry(4, { l: edge }),                                       // 장 간격 셀(좌선)
      borderFillEntry(5, { t: grayLine, b: grayLine }, c.titleFill),         // 장 제목 셀
      borderFillEntry(6, {}, c.primary),                                     // 표지 진한 바
      borderFillEntry(7, {}, c.accent),                                      // 표지 연한 바
      borderFillEntry(8, { l: tocEdge, r: tocEdge, t: tocEdge, b: tocEdge }), // 목차 박스
      borderFillEntry(9, {}, c.tocStripe),                                   // 목차 배너 라벤더 스트라이프
    )
  }
  if (gongmun) {
    // 표 헤더행 음영 — 실측: 정부 양식 표 헤더 #E6E6E6 (gen-ids gongmunTableHeaderBf)
    items.push(borderFillEntry(items.length + 1, { l: thin, r: thin, t: thin, b: thin }, "#E6E6E6"))
  }
  // 섹션 생성 중 등록된 표 위치별 borderFill (gen-table-bf TableBfRegistry)
  items.push(...extra)
  return `<hh:borderFills itemCnt="${items.length}">\n${items.join("\n")}\n    </hh:borderFills>`
}

/**
 * styles 블록 — 공문서 모드는 "개요 1~4" 명명 스타일 추가 (헤딩 문단이 styleIDRef로 참조).
 * OUTLINE paraPr 없이 스타일 이름만으로 헤딩 의미를 보존한다 — 한글이 OUTLINE 문단에
 * 개요 번호("1.", "1.1.")를 강제 렌더하는 결함(COM 실렌더 확인) 회피.
 */
function buildStyles(gongmun: ResolvedGongmun | null): string {
  const items = [
    `<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>`,
  ]
  if (gongmun) {
    for (let lvl = 1; lvl <= 4; lvl++) {
      items.push(`<hh:style id="${lvl}" type="PARA" name="개요 ${lvl}" engName="Outline ${lvl}" paraPrIDRef="${lvl}" charPrIDRef="${4 + lvl}" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>`)
    }
  }
  return `<hh:styles itemCnt="${items.length}">\n      ${items.join("\n      ")}\n    </hh:styles>`
}

export function generateHeaderXml(theme: ResolvedTheme, gongmun: ResolvedGongmun | null, ratioVariants: number[] = [], extraBorderFills: string[] = [], extraCharPrXmls: string[] = []): string {
  // 본문 한글 글꼴 — fonts.body 오버라이드 > bodyFont 프리셋(gothic=맑은 고딕)
  const bodyFace = gongmun?.fonts.body ?? (gongmun?.bodyFont === "gothic" ? "맑은 고딕" : "함초롬바탕")
  const charPropsXml = buildCharProperties(theme, gongmun, ratioVariants, extraCharPrXmls)
  const paraPropsXml = buildParaProperties(gongmun)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" xmlns:hc="${NS_CORE}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    ${buildFontFaces(gongmun, bodyFace)}
    ${buildBorderFills(gongmun, extraBorderFills)}
    ${charPropsXml}
    <hh:tabProperties itemCnt="0"/>
    ${buildNumberings()}
    <hh:bullets itemCnt="0"/>
    ${paraPropsXml}
    ${buildStyles(gongmun)}
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"><hh:layoutCompatibility/></hh:compatibleDocument>
</hh:head>`
}

