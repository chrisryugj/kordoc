/**
 * PDF 그래픽 명령에서 수평/수직 선을 추출하고,
 * 선 교차점(Vertex) 기반으로 테이블 그리드를 구성하는 모듈 — 분리 후 재수출 허브.
 *
 * 구현은 목적별 모듈로 분리됨 (외부 소비자는 이 파일 경유로 무변경):
 *   line-types.ts     — 공유 타입(LineSegment/TableGrid/ExtractedCell/TextItem)·상수
 *   line-extract.ts   — 그래픽 ops → 선 추출 + 전처리 + 페이지 경계 필터
 *   vertical-bridge.ts — 무괘선 밴드로 끊긴 동일 열 수직선 브리지
 *   image-regions.ts  — 이미지 XObject 영역 추출 (정보손실 가시화)
 *   table-grid.ts     — Vertex 생성/병합 + 테이블 그리드 구성
 *   cell-extract.ts   — 그리드 → 병합 셀 구조 (createMatrix)
 *   cell-text.ts      — 텍스트→셀 매핑 + 셀 텍스트 조립
 *   undersegmented.ts — 과소분할 표 재구성 (row band 재유도)
 *
 * 이 테이블 감지 알고리즘은 OpenDataLoader PDF의
 * TableBorderBuilder / LinesPreprocessingConsumer를 참고하여
 * TypeScript로 clean-room 재구현한 것입니다.
 *
 * v2: Vertex 기반 동적 tolerance, 선 전처리 파이프라인,
 *     정밀 병합 셀 감지 (ODL 알고리즘 충실 포팅)
 *
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 * Core algorithm concepts from veraPDF-wcag-algs (GPLv3+/MPLv2+)
 * This is an independent clean-room reimplementation in TypeScript.
 */

export type { LineSegment, TableGrid, ExtractedCell, TextItem } from "./line-types.js"
export { extractLines, preprocessLines, filterPageBorderLines, closeOpenTableEdges, type ClipRect } from "./line-extract.js"
export { bridgeSplitColumnVerticals } from "./vertical-bridge.js"
export { extractImageRegions, type ImageRegion } from "./image-regions.js"
export { buildTableGrids } from "./table-grid.js"
export { buildClipCellGrids, dropGridsInside } from "./clip-cells.js"
export { extractCells } from "./cell-extract.js"
export {
  SPACE_GAP_RATIO,
  spaceGapThreshold,
  mapTextToCells,
  cellTextToString,
  detectEvenSpacedItems,
} from "./cell-text.js"
export { normalizeUndersegmentedTable } from "./undersegmented.js"
