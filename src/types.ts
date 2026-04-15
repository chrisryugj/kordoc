/** kordoc 공통 타입 정의 */

// ─── 중간 표현 (Intermediate Representation) ─────────

export interface CellContext {
  text: string
  colSpan: number
  rowSpan: number
  /** HWP5 셀 열 주소 (0-based) — 병합 테이블 배치용 */
  colAddr?: number
  /** HWP5 셀 행 주소 (0-based) — 병합 테이블 배치용 */
  rowAddr?: number
}

/** 블록 타입 — v2.0에서 heading, list, image, separator 추가 */
export type IRBlockType = "paragraph" | "table" | "heading" | "list" | "image" | "separator"

export interface IRBlock {
  type: IRBlockType
  text?: string
  table?: IRTable
  /** 헤딩 레벨 (1-6), type="heading"일 때 사용 */
  level?: number
  /** 원본 페이지 번호 (1-based) */
  pageNumber?: number
  /** 바운딩 박스 — PDF에서만 제공 */
  bbox?: BoundingBox
  /** 텍스트 스타일 정보 (선택) */
  style?: InlineStyle
  /** 리스트 타입, type="list"일 때 사용 */
  listType?: "ordered" | "unordered"
  /** 중첩 리스트 아이템 */
  children?: IRBlock[]
  /** 하이퍼링크 URL */
  href?: string
  /** 각주/미주 텍스트 (인라인 삽입용) */
  footnoteText?: string
  /** 이미지 데이터 (type="image"일 때) */
  imageData?: ImageData
}

/** 추출된 이미지 바이너리 데이터 */
export interface ImageData {
  /** 이미지 바이너리 */
  data: Uint8Array
  /** MIME 타입 (image/png, image/jpeg, image/gif, image/bmp, image/wmf, image/emf) */
  mimeType: string
  /** 원본 파일명 (있는 경우) */
  filename?: string
}

/** 바운딩 박스 — PDF 포인트 단위 (72pt = 1인치) */
export interface BoundingBox {
  page: number
  x: number
  y: number
  width: number
  height: number
}

/** 인라인 텍스트 스타일 */
export interface InlineStyle {
  bold?: boolean
  italic?: boolean
  fontSize?: number
  fontName?: string
}

export interface IRTable {
  rows: number
  cols: number
  cells: IRCell[][]
  /** 첫 행을 헤더로 렌더링할지 여부 (현재: rows > 1이면 true — 의미적 감지가 아닌 레이아웃 힌트) */
  hasHeader: boolean
}

export interface IRCell {
  text: string
  colSpan: number
  rowSpan: number
}

// ─── 메타데이터 ─────────────────────────────────────

/** 문서 메타데이터 — 각 포맷에서 추출 가능한 필드만 채워짐 */
export interface DocumentMetadata {
  /** 문서 제목 */
  title?: string
  /** 작성자 */
  author?: string
  /** 작성 프로그램 (예: "한글 2020", "Adobe Acrobat") */
  creator?: string
  /** 생성일시 (ISO 8601) */
  createdAt?: string
  /** 수정일시 (ISO 8601) */
  modifiedAt?: string
  /** 페이지/섹션 수 */
  pageCount?: number
  /** 문서 포맷 버전 (예: HWP "5.1.0.1") */
  version?: string
  /** 설명 */
  description?: string
  /** 키워드 */
  keywords?: string[]
}

// ─── 파싱 옵션 ──────────────────────────────────────

/** 파싱 옵션 — parse() 함수에 전달 */
export interface ParseOptions {
  /**
   * 파싱할 페이지/섹션 범위 (1-based).
   * - 배열: [1, 2, 3]
   * - 문자열: "1-3", "1,3,5-7"
   *
   * PDF: 정확한 페이지 단위. HWP/HWPX: 섹션 단위 근사치.
   */
  pages?: number[] | string
  /** 이미지 기반 PDF용 OCR 프로바이더 (선택) */
  ocr?: OcrProvider
  /** 진행률 콜백 — current: 현재 페이지/섹션, total: 전체 수 */
  onProgress?: (current: number, total: number) => void
  /** PDF 머리글/바닥글 자동 제거 */
  removeHeaderFooter?: boolean
}

// ─── 파싱 경고 ──────────────────────────────────────

/** 파싱 중 스킵/실패한 요소 보고 */
export interface ParseWarning {
  /** 관련 페이지 번호 (알 수 있는 경우) */
  page?: number
  /** 경고 메시지 */
  message: string
  /** 구조화된 경고 코드 */
  code: WarningCode
}

export type WarningCode =
  | "SKIPPED_IMAGE"
  | "SKIPPED_OLE"
  | "TRUNCATED_TABLE"
  | "OCR_FALLBACK"
  | "UNSUPPORTED_ELEMENT"
  | "BROKEN_ZIP_RECOVERY"
  | "HIDDEN_TEXT_FILTERED"
  | "MALFORMED_XML"
  | "PARTIAL_PARSE"
  | "LENIENT_CFB_RECOVERY"

/** 문서 구조 (헤딩 트리) */
export interface OutlineItem {
  level: number
  text: string
  pageNumber?: number
}

// ─── 에러 코드 ──────────────────────────────────────

/** 구조화된 에러 코드 — 프로그래밍적 에러 핸들링용 */
export type ErrorCode =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "ENCRYPTED"
  | "DRM_PROTECTED"
  | "CORRUPTED"
  | "DECOMPRESSION_BOMB"
  | "ZIP_BOMB"
  | "IMAGE_BASED_PDF"
  | "NO_SECTIONS"
  | "PARSE_ERROR"
  | "MISSING_DEPENDENCY"

// ─── 파싱 결과 (discriminated union) ────────────────

export type FileType = "hwpx" | "hwp" | "hwpml" | "pdf" | "xlsx" | "docx" | "unknown"

interface ParseResultBase {
  fileType: FileType
  /** 페이지/섹션 수 — PDF: 실제 페이지 수, HWP/HWPX: 섹션 수, XLSX: 시트 수 */
  pageCount?: number
  /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
  isImageBased?: boolean
}

export interface ParseSuccess extends ParseResultBase {
  success: true
  /** 추출된 마크다운 텍스트 */
  markdown: string
  /** 중간 표현 블록 (구조화된 데이터 접근용) */
  blocks: IRBlock[]
  /** 문서 메타데이터 */
  metadata?: DocumentMetadata
  /** 문서 구조 (헤딩 트리) — v2.0 */
  outline?: OutlineItem[]
  /** 파싱 중 발생한 경고 — v2.0 */
  warnings?: ParseWarning[]
  /** 추출된 이미지 목록 — 마크다운에서 파일명으로 참조됨 */
  images?: ExtractedImage[]
}

/** 추출된 이미지 — ParseSuccess.images에 포함 */
export interface ExtractedImage {
  /** 마크다운에서 참조되는 파일명 (예: image_001.png) */
  filename: string
  /** 이미지 바이너리 */
  data: Uint8Array
  /** MIME 타입 */
  mimeType: string
}

export interface ParseFailure extends ParseResultBase {
  success: false
  /** 오류 메시지 */
  error: string
  /** 구조화된 에러 코드 */
  code?: ErrorCode
}

export type ParseResult = ParseSuccess | ParseFailure

// ─── 문서 비교 (Diff) ───────────────────────────────

export type DiffChangeType = "added" | "removed" | "modified" | "unchanged"

export interface BlockDiff {
  type: DiffChangeType
  /** 원본 블록 (added이면 undefined) */
  before?: IRBlock
  /** 변경 후 블록 (removed이면 undefined) */
  after?: IRBlock
  /** modified 테이블의 셀 단위 diff */
  cellDiffs?: CellDiff[][]
  /** 유사도 (0-1) */
  similarity?: number
}

export interface CellDiff {
  type: DiffChangeType
  before?: string
  after?: string
}

export interface DiffResult {
  stats: { added: number; removed: number; modified: number; unchanged: number }
  diffs: BlockDiff[]
}

// ─── 양식 인식 ──────────────────────────────────────

export interface FormField {
  label: string
  value: string
  /** 0-based 소스 행 */
  row: number
  /** 0-based 소스 열 */
  col: number
}

export interface FormResult {
  fields: FormField[]
  /** 양식 확신도 (0-1) */
  confidence: number
}

// ─── OCR 프로바이더 ─────────────────────────────────

/** 사용자 제공 OCR 함수 — 페이지 이미지를 받아 텍스트 반환 */
export type OcrProvider = (
  pageImage: Uint8Array,
  pageNumber: number,
  mimeType: "image/png"
) => Promise<string>

// ─── Watch 모드 ─────────────────────────────────────

export interface WatchOptions {
  dir: string
  outDir?: string
  webhook?: string
  format?: "markdown" | "json"
  pages?: string
  silent?: boolean
}

// ─── 헤딩 감지 공통 임계값 ──────────────────────────

/** 폰트 크기 비율 → heading level (전 파서 공통) */
export const HEADING_RATIO_H1 = 1.5
export const HEADING_RATIO_H2 = 1.3
export const HEADING_RATIO_H3 = 1.15

// ─── 내부 파서 반환 타입 ─────────────────────────────

/** 내부 파서가 index.ts에 반환하는 공통 타입 (HWP5/HWPX/PDF/XLSX/DOCX) */
export interface InternalParseResult {
  markdown: string
  blocks: IRBlock[]
  metadata?: DocumentMetadata
  outline?: OutlineItem[]
  warnings?: ParseWarning[]
  images?: ExtractedImage[]
  /** PDF 전용: 이미지 기반 PDF 여부 */
  isImageBased?: boolean
}
