/**
 * 항목부호 + 탭 — v5 공문서의 "첫 줄 내용 = 둘째 줄" 정렬 원자 (gen-gongmun 항목·참고 문단, 업무보고 요약박스).
 * paraPr 는 autoTab(내어쓰기용 자동 탭, tabPr 1)·indent = -hang 과 짝으로 써야 한다.
 */

import { measureTextWidth, faceClassForGen } from "./text-metrics.js"
import { taHu } from "./gongmun-scheme.js"
import { escapeTextXml } from "./gen-ids.js"

/**
 * 항목부호 문단 기하 — left = 부호 시작, hang = 내어쓰기 = 부호 실폭 + 1타(편람 "부호 뒤 1타").
 * 부호 뒤는 공백이 아니라 탭(내어쓰기용 자동 탭)이라 첫 줄 내용도 둘째 줄과 같은 left+hang 에서 시작한다
 * — 양쪽 정렬이 부호 뒤 공백을 늘리던 어긋남, 압축(장평·자간)이 부호 폭을 줄이던 어긋남이 구조적으로 없다.
 */
export function markerLayout(font: string, pt: number, leadTa: number, marker: string): { left: number; hang: number; markerW: number } {
  const left = leadTa * taHu(pt)
  if (!marker) return { left, hang: 0, markerW: 0 }
  const markerW = Math.round(measureTextWidth(marker, pt * 100, 100, { faceClass: faceClassForGen(font) }))
  return { left, hang: markerW + taHu(pt), markerW }
}

/** 부호 run — 부호 + 탭. 탭 폭은 한컴이 조판 때 다시 계산한다(값은 1타 근사) */
export function markerRunXml(marker: string, charPr: number, lay: { hang: number; markerW: number }): string {
  return `<hp:run charPrIDRef="${charPr}"><hp:t>${escapeTextXml(marker)}<hp:tab width="${lay.hang - lay.markerW}" leader="0" type="1"/></hp:t></hp:run>`
}
