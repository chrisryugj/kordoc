/**
 * 선 기반 테이블 감지 공유 타입/상수.
 * line-detector.ts에서 분리 — 알고리즘 출처는 line-detector.ts 헤더 참조.
 */

// ─── 타입 ─────────────────────────────────────────────

export interface LineSegment {
  x1: number; y1: number
  x2: number; y2: number
  lineWidth: number
  /** fill 연산(그라디언트 밴드 스택)에서 나온 선분 — PDF w 연산자는 stroke 전용이라
   *  fill 선분의 lineWidth 는 마지막 stroke 상태를 상속한 스테일 값이다. 음영 스택 폭
   *  판별(dropShadingStacks)이 스테일 폭에 속지 않게 표기한다 (pline-3). */
  fromFill?: boolean
}

export interface TableGrid {
  /** 행 Y 좌표 경계 (위→아래 내림차순) */
  rowYs: number[]
  /** 열 X 좌표 경계 (좌→우 오름차순) */
  colXs: number[]
  /** 테이블 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
  /** 그리드 내 교차점 반경 (동적 tolerance용) */
  vertexRadius: number
}

export interface ExtractedCell {
  row: number; col: number
  rowSpan: number; colSpan: number
  /** 셀 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

export interface TextItem {
  text: string
  x: number; y: number; w: number; h: number
  fontSize: number; fontName: string
  /** pdfjs 공백 아이템이 이 아이템 직전에 있었음 — 단어 경계 힌트 (parser.ts NormItem에서 전파) */
  hasSpaceBefore?: boolean
}

/** Vertex 기반 좌표 병합 시 radius 배수 — ODL: VERTEX_TABLE_FACTOR */
export const VERTEX_MERGE_FACTOR = 4
