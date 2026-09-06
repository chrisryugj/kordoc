/**
 * 표 셀 위치별 borderFill 동적 레지스트리 — 정부 실무 표 테두리 위계 재현.
 *
 * 실측 문법 (GT6/7/8/10/11/15 공통, gap_tables.md TBL-01·02):
 *   외곽 0.4mm 굵은선 / 내부 0.12mm 가는선 / 헤더행 하변 DOUBLE_SLIM 0.5mm 이중선.
 * 셀 위치(첫행·끝행·첫열·끝열)와 채움색 조합마다 borderFill이 달라지므로
 * 섹션 생성 중 필요한 조합을 등록하고, header.xml 생성 시 일괄 방출한다.
 * (blocksToSectionXml이 header보다 먼저 실행되는 조립 순서를 이용)
 */

import { borderFillEntry, type BorderSide } from "./gen-ids.js"

const THIN: BorderSide = ["0.12 mm", "#000000"]
const THICK: BorderSide = ["0.4 mm", "#000000"]
const DOUBLE: BorderSide = ["0.5 mm", "#000000", "DOUBLE_SLIM"]
/** 0.15mm 중간선 — 서울 보고서 제목표 제목/담당자 행 경계 실측 */
const MID: BorderSide = ["0.15 mm", "#000000"]

/** 셀 한 변의 선 종류 */
export type EdgeKind = "thin" | "thick" | "double" | "mid" | "none"

/** 셀 테두리+채움 스펙 — 위치별 조합 키로 dedupe */
export interface CellBfSpec {
  t: EdgeKind
  b: EdgeKind
  l: EdgeKind
  r: EdgeKind
  /** 단색 채움(#RRGGBB) 또는 gradient 2색 */
  fill?: string | { gradient: [string, string] }
}

const EDGE: Record<Exclude<EdgeKind, "none">, BorderSide> = { thin: THIN, thick: THICK, double: DOUBLE, mid: MID }

function sideOf(kind: EdgeKind): BorderSide | undefined {
  return kind === "none" ? undefined : EDGE[kind]
}

/**
 * borderFill 동적 레지스트리. startId부터 발급, 동일 스펙은 같은 id 재사용.
 * emit()은 header.xml refList의 borderFills 블록에 이어붙일 XML 목록을 반환.
 */
export class TableBfRegistry {
  private map = new Map<string, number>()
  private xmls: string[] = []
  constructor(private nextId: number) {}

  get(spec: CellBfSpec): number {
    const key = `${spec.t}|${spec.b}|${spec.l}|${spec.r}|${typeof spec.fill === "string" ? spec.fill : spec.fill ? spec.fill.gradient.join("-") : ""}`
    const hit = this.map.get(key)
    if (hit !== undefined) return hit
    const id = this.nextId++
    this.map.set(key, id)
    this.xmls.push(
      borderFillEntry(id, { t: sideOf(spec.t), b: sideOf(spec.b), l: sideOf(spec.l), r: sideOf(spec.r) }, spec.fill),
    )
    return id
  }

  /** 등록된 borderFill XML 목록 (등록 순서 = id 순서) */
  emit(): string[] {
    return this.xmls
  }

  get count(): number {
    return this.xmls.length
  }
}

/**
 * 데이터 표 셀의 위치별 테두리 스펙 — 실측 위계.
 *  - 표 최상단 변 thick(0.4), 최하단 변 thick, 좌우 끝열 바깥 변 thick
 *  - 헤더행 하변 double(0.5 이중선) — 헤더가 있을 때만
 *  - 그 외 내부 변 thin(0.12)
 */
export function dataCellSpec(opts: {
  row: number
  rowEnd: number // row + rowSpan - 1
  col: number
  colEnd: number // col + colSpan - 1
  rowCnt: number
  colCnt: number
  headerRows: number // 헤더 행 수 (0이면 이중선 없음)
  fill?: string
}): CellBfSpec {
  const { row, rowEnd, col, colEnd, rowCnt, colCnt, headerRows, fill } = opts
  const isTop = row === 0
  const isBottom = rowEnd === rowCnt - 1
  const isHeaderBottom = headerRows > 0 && rowEnd === headerRows - 1
  const isBelowHeader = headerRows > 0 && row === headerRows
  return {
    t: isTop ? "thick" : isBelowHeader ? "double" : "thin",
    b: isBottom ? "thick" : isHeaderBottom ? "double" : "thin",
    l: col === 0 ? "thick" : "thin",
    r: colEnd === colCnt - 1 ? "thick" : "thin",
    fill,
  }
}
