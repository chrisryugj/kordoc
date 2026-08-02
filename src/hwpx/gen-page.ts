/**
 * 페이지 옵션 (v4.5.0) — 용지 크기·방향, 다단, 머리말/꼬리말 생성.
 *
 * XML 형상 근거:
 * - landscape 속성: 코퍼스 실측 — 세로 문서 전수 WIDELY, 가로 문서(소방용수시설
 *   조사일정 2종)만 NARROWLY. 용지 width/height는 방향과 무관하게 용지 실치수 유지.
 * - 머리말/꼬리말·subList: rhwp serializer(한컴 저장본 필드 단위 전수 대조로 검증된
 *   HWP5→HWPX 변환기)의 render_header_footer 형상 미러.
 * - colPr 다단: rhwp render_col_pr_ctrl — type NEWSPAPER, sameSz=1, sameGap(HWPUNIT).
 *
 * 옵션 미지정 시 이 모듈은 아무것도 방출하지 않는다 (기존 산출물 바이트 불변).
 */

import { A4_W_HU, A4_H_HU } from "./geometry.js"
import { generateRuns } from "./md-runs.js"

/** markdownToHwpx `page` 옵션 */
export interface PageOptions {
  /** 용지 프리셋 또는 mm 실치수. 기본 A4 (210×297) */
  size?: "A4" | "A3" | "B4" | "B5" | "Letter" | { widthMm: number; heightMm: number }
  /** 용지 방향. 기본 portrait(세로) */
  orientation?: "portrait" | "landscape"
  /** 다단 개수 (1~8). 기본 1 */
  columns?: number
  /** 머리말 텍스트 — 모든 쪽, 인라인 마크다운(굵게 등) 허용 */
  header?: string
  /** 꼬리말 텍스트 */
  footer?: string
}

export interface ResolvedPage {
  widthHU: number
  heightHU: number
  landscape: "WIDELY" | "NARROWLY"
  columns: number
  header: string | null
  footer: string | null
}

/** 용지 프리셋 (mm) — B계열은 한컴 용지 규격(JIS) */
const PAPER_MM: Record<string, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  B4: [257, 364],
  B5: [182, 257],
  Letter: [215.9, 279.4],
}

/**
 * 옵션 해석 — 전부 기본값이면 null (기존 방출 경로 유지, 바이트 불변 보장).
 * 잘못된 값은 조용히 접지 않고 throw — 생성 결과가 의도와 다르게 나가는 것 방지.
 */
export function resolvePage(opts?: PageOptions): ResolvedPage | null {
  if (!opts) return null
  const { size, orientation, columns, header, footer } = opts
  if (size === undefined && orientation === undefined && columns === undefined
    && header === undefined && footer === undefined) return null

  let wMm = 210, hMm = 297
  if (size !== undefined) {
    if (typeof size === "string") {
      const preset = PAPER_MM[size]
      if (!preset) throw new Error(`지원하지 않는 용지 프리셋: ${size} (A4·A3·B4·B5·Letter)`)
      ;[wMm, hMm] = preset
    } else {
      if (!(size.widthMm > 0) || !(size.heightMm > 0) || size.widthMm > 1000 || size.heightMm > 1000) {
        throw new Error(`용지 치수는 0~1000mm 범위여야 합니다: ${size.widthMm}×${size.heightMm}`)
      }
      wMm = size.widthMm
      hMm = size.heightMm
    }
  }
  const cols = columns ?? 1
  if (!Number.isInteger(cols) || cols < 1 || cols > 8) {
    throw new Error(`다단 개수는 1~8 정수여야 합니다: ${columns}`)
  }
  // 용지 치수는 내림 — 한컴 정준값과 일치 (A4 210→59528·297→84188, 반올림이면 84189로 어긋남)
  const paperHU = (mm: number) => Math.floor((mm * 7200) / 25.4)
  return {
    widthHU: size === undefined ? A4_W_HU : paperHU(wMm),
    heightHU: size === undefined ? A4_H_HU : paperHU(hMm),
    // 실측: 용지 치수는 방향과 무관하게 유지, 방향은 landscape 속성만 바뀐다
    landscape: orientation === "landscape" ? "NARROWLY" : "WIDELY",
    columns: cols,
    header: header?.trim() ? header.trim() : null,
    footer: footer?.trim() ? footer.trim() : null,
  }
}

/** 다단 colPr ctrl — rhwp render_col_pr_ctrl 형상 (간격 8mm = 한컴 기본) */
export function columnColPrXml(columns: number): string {
  const gap = columns > 1 ? 2268 : 0
  return `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="${columns}" sameSz="1" sameGap="${gap}"/></hp:ctrl>`
}

/**
 * 머리말/꼬리말 ctrl — rhwp render_header_footer 형상 미러.
 * 첫 문단 첫 run(secPr 옆)에 방출한다. 텍스트는 인라인 마크다운 지원.
 */
export function headerFooterCtrl(
  tag: "header" | "footer",
  text: string,
  id: number,
  mapCharId?: (id: number) => number,
): string {
  const runs = generateRuns(text, undefined, mapCharId)
  return `<hp:ctrl><hp:${tag} id="${id}" applyPageType="BOTH">` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
    `<hp:p paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>` +
    `</hp:subList></hp:${tag}></hp:ctrl>`
}
