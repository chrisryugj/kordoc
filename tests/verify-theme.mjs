#!/usr/bin/env node
/**
 * v2.7.x → v2.8.0 추가 옵션 검증:
 *  - markdownToHwpx에 theme 옵션 전달 시
 *    header.xml의 charPr textColor가 옵션 값으로 바뀌는지
 *  - 옵션 미지정 시 기본 검정 유지 (백워드 호환)
 *  - HWPX 시그니처 + round-trip 유지
 */

import fs from "node:fs";
import JSZip from "jszip";
import { markdownToHwpx, parseHwpx } from "../dist/index.js";

const sampleMd = `# 변호사 검토 요청서

이 문서는 계약 체결 전 리스크 정리본입니다.

## 1. 우선 검토 문서

| 우선 | 자료 | 검토 포인트 |
| --- | --- | --- |
| P0 | 용역계약서 | 검수/변경/대금/배상 |
| P0 | 권리귀속표 | 산출물/IP/오픈소스 |

### 세부

> 회의 발언이 계약 범위처럼 주장될 수 있음
`;

const theme = {
  headingColors: { 1: "#17365D", 2: "#1F4E79", 3: "#2E74B5" },
  bodyColor: "#222222",
  quoteColor: "#5C667A",
  tableHeaderColor: "#1F4E79",
  tableHeaderBold: true,
};

async function getHeaderXml(buf) {
  const zip = await JSZip.loadAsync(Buffer.from(buf));
  return await zip.file("Contents/header.xml").async("string");
}

async function getSectionXml(buf) {
  const zip = await JSZip.loadAsync(Buffer.from(buf));
  return await zip.file("Contents/section0.xml").async("string");
}

async function main() {
  // 1) 옵션 없음 → 모든 textColor 검정 (백워드 호환)
  const plain = await markdownToHwpx(sampleMd);
  const plainHeader = await getHeaderXml(plain);
  const plainColors = [...plainHeader.matchAll(/textColor="([^"]+)"/g)].map((m) => m[1]);
  const plainAllBlack = plainColors.every((c) => c === "#000000");
  console.log(`[baseline] textColor count=${plainColors.length}, all #000000? ${plainAllBlack}`);
  if (!plainAllBlack) {
    console.error("FAIL: baseline should be all black");
    process.exit(1);
  }

  // 1-b) 회귀 가드: 옵션 없을 때 blockquote는 CHAR_QUOTE(id=10)를 안 써야 함
  //      (CHAR_QUOTE는 italic이므로 baseline에 적용되면 시각 회귀)
  const plainSection = await getSectionXml(plain);
  const usesQuoteCharPrInBaseline = plainSection.includes('charPrIDRef="10"');
  console.log(`[baseline] blockquote avoids CHAR_QUOTE? ${!usesQuoteCharPrInBaseline}`);
  if (usesQuoteCharPrInBaseline) {
    console.error("FAIL: baseline must not use CHAR_QUOTE (would force italic)");
    process.exit(1);
  }

  // 1-c) quoteColor 옵션 명시 시엔 CHAR_QUOTE 적용되어야 함
  const withQuote = await markdownToHwpx(sampleMd, { theme: { quoteColor: "#5C667A" } });
  const withQuoteSection = await getSectionXml(withQuote);
  const usesQuoteCharPrWhenSet = withQuoteSection.includes('charPrIDRef="10"');
  console.log(`[quoteColor set] blockquote uses CHAR_QUOTE? ${usesQuoteCharPrWhenSet}`);
  if (!usesQuoteCharPrWhenSet) {
    console.error("FAIL: quoteColor option should activate CHAR_QUOTE");
    process.exit(1);
  }

  // 2) 옵션 적용 → 지정 색상 등장
  const themed = await markdownToHwpx(sampleMd, { theme });
  const themedHeader = await getHeaderXml(themed);
  const required = ["#17365D", "#1F4E79", "#222222", "#5C667A"];
  const missing = required.filter((c) => !themedHeader.includes(`textColor="${c}"`));
  console.log(`[themed] required colors present: ${required.length - missing.length}/${required.length}`);
  if (missing.length) {
    console.error("FAIL: missing colors in header.xml:", missing);
    process.exit(1);
  }

  // 3) HWPX 시그니처 (themed)
  const themedBuf = Buffer.from(themed);
  const sigOk =
    themedBuf[0] === 0x50 && themedBuf[1] === 0x4b &&
    themedBuf[2] === 0x03 && themedBuf[3] === 0x04;
  console.log(`[themed] HWPX signature ok? ${sigOk}`);
  if (!sigOk) { console.error("FAIL: bad ZIP signature"); process.exit(1); }

  // 4) round-trip
  const r = await parseHwpx(themed);
  const titleOk = r.markdown.includes("변호사 검토 요청서");
  const cellOk = r.markdown.includes("용역계약서");
  console.log(`[themed] roundtrip title ok? ${titleOk} cell ok? ${cellOk}`);
  if (!titleOk || !cellOk) { console.error("FAIL: roundtrip"); process.exit(1); }

  // 5) tableHeaderBold가 charPr 9에 적용됐는지 (bold="1")
  const charPr9 = themedHeader.match(/<hh:charPr id="9"[^>]*>/);
  const hasBold = charPr9 && /bold="1"/.test(charPr9[0]);
  console.log(`[themed] charPr id=9 bold? ${hasBold}`);
  if (!hasBold) { console.error("FAIL: tableHeaderBold not applied"); process.exit(1); }

  // 6) charPr itemCnt 변경 확인 (9 → 11)
  const itemCntMatch = themedHeader.match(/<hh:charProperties itemCnt="(\d+)">/);
  const itemCnt = itemCntMatch ? parseInt(itemCntMatch[1], 10) : 0;
  console.log(`[themed] charPr itemCnt=${itemCnt} (expected 11)`);
  if (itemCnt !== 11) { console.error("FAIL: itemCnt"); process.exit(1); }

  console.log("\nALL OK — theme option works, baseline unchanged");
}

main().catch((e) => { console.error(e); process.exit(1); });
