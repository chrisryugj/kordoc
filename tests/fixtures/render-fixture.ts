/**
 * 렌더 테스트용 합성 Tier-1(조판 캐시 명시) HWPX — 2쪽: 1쪽 문단+표(셀 안 이미지), 2쪽 문단.
 * markdownToHwpx 산출물을 골격으로 쓰고 section0 본문·BinData 를 주입한다 (render.test 의 renderTacDoc 패턴).
 */

import JSZip from "jszip"
import { markdownToHwpx } from "../../src/hwpx/generator.js"

/** 1×1 투명 PNG */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

export function seg(vertpos: number, horzsize: number, textpos = 0, horzpos = 0): string {
  return `<hp:lineseg textpos="${textpos}" vertpos="${vertpos}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="${horzpos}" horzsize="${horzsize}" flags="393216"/>`
}

export function para(text: string, segs: string, paraPrId = "0"): string {
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run><hp:linesegarray>${segs}</hp:linesegarray></hp:p>`
}

export function pic(ref: string, w = 6000, h = 3000): string {
  return `<hp:pic id="9" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="9">` +
    `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
    // 실물은 hc:img 지만 생성본 section 에는 hc 네임스페이스 선언이 없다 — 렌더러는 localName 만 본다
    `<hp:imgClip left="0" top="0" right="${w}" bottom="${h}"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hp:img binaryItemIDRef="${ref}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hp:pic>`
}

/** 1행 2열 표(id=777) — 왼쪽 셀 텍스트, 오른쪽 셀 이미지(있으면). treatAsChar 인라인 */
export function table(opts: { id?: string; imgRef?: string; cellW?: number; cellH?: number; x?: number } = {}): string {
  const id = opts.id ?? "777", cw = opts.cellW ?? 12000, ch = opts.cellH ?? 4000
  const cell = (col: number, inner: string) =>
    `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>` +
    `<hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cw}" height="${ch}"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
  const right = opts.imgRef
    ? `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${pic(opts.imgRef, cw - 1000, ch - 1000)}</hp:run><hp:linesegarray>${seg(0, cw)}</hp:linesegarray></hp:p>`
    : para("오른칸", seg(0, cw))
  return `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="0" rowCnt="1" colCnt="2" cellSpacing="0" borderFillIDRef="1" noAdjust="0">` +
    `<hp:sz width="${cw * 2}" widthRelTo="ABSOLUTE" height="${ch}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:tr>${cell(0, para("왼칸", seg(0, cw)))}${cell(1, right)}</hp:tr></hp:tbl>`
}

/** 임의 격자 표(id 지정) — 셀 텍스트 2차원 배열, 빈 문자열은 빈 셀. 병합 없음 */
export function gridTable(id: string, rows: string[][], cellW = 8000, cellH = 2000): string {
  const cols = Math.max(...rows.map(r => r.length))
  const tc = (r: number, c: number, text: string) =>
    `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${text ? para(text, seg(0, cellW)) : `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"></hp:run><hp:linesegarray>${seg(0, cellW)}</hp:linesegarray></hp:p>`}</hp:subList>` +
    `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cellW}" height="${cellH}"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
  return `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="0" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">` +
    `<hp:sz width="${cellW * cols}" widthRelTo="ABSOLUTE" height="${cellH * rows.length}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    rows.map((row, r) => `<hp:tr>${Array.from({ length: cols }, (_, c) => tc(r, c, row[c] ?? "")).join("")}</hp:tr>`).join("") + `</hp:tbl>`
}

export interface FixtureOptions {
  /** 2쪽 문단 생략 → 1쪽 문서 */
  singlePage?: boolean
  /** 표 생략 */
  noTable?: boolean
  /** 표 오른칸 이미지 생략 */
  noImage?: boolean
  /** 1쪽 표 다음에 추가할 격자 표들 (extractTables 테스트) — [id, rows] */
  extraTables?: Array<[string, string[][]]>
}

/** 합성 2쪽 문서 HWPX 바이트 */
export async function buildRenderFixture(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const base = await markdownToHwpx("기준")
  const zip = await JSZip.loadAsync(base)
  const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
  let sec = await zip.file(secName)!.async("string")
  // 골격의 "기준" 문단은 조판 캐시가 없어 reflow 경로에서 합성 페이지를 만든다 — 제거해 페이지 수를 고정
  sec = sec.replace(/<hp:p\b(?:(?!<\/hp:p>)[\s\S])*?기준(?:(?!<\/hp:p>)[\s\S])*?<\/hp:p>/, "")
  const body: string[] = []
  // 1쪽: 문단(2줄) → 표 호스트 문단
  body.push(para("첫째쪽 문단입니다 첫째쪽 문단입니다", seg(0, 42520) + seg(1600, 42520, 10)))
  if (!opts.noTable) {
    body.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${table({ imgRef: opts.noImage ? undefined : "img1" })}</hp:run><hp:linesegarray>${seg(4000, 42520)}</hp:linesegarray></hp:p>`)
  }
  let v = 4000
  for (const [id, rows] of opts.extraTables ?? []) {
    v += 6000
    body.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${gridTable(id, rows)}</hp:run><hp:linesegarray>${seg(v, 42520)}</hp:linesegarray></hp:p>`)
  }
  // 2쪽: vertpos 0 으로 리셋되는 문단(첫 seg·horzpos 비전진 → 페이지 경계)
  if (!opts.singlePage) body.push(para("둘째쪽 문단", seg(0, 42520)))
  sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${body.join("")}${m}`)
  zip.file(secName, sec)
  if (!opts.noImage) zip.file("BinData/img1.png", TINY_PNG)
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }))
}
