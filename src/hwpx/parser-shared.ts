/**
 * HWPX 파서 공유 상수/타입/유틸 (parser.ts에서 분리).
 * ZIP 한도, 섹션 공유 상태(SectionShared), walk 컨텍스트(WalkCtx), XML 유틸.
 */

import { DOMParser } from "@xmldom/xmldom"
import type JSZip from "jszip"
import { KordocError, unzipLimitBytes } from "../utils.js"
import type { CellContext, IRBlock, ParseWarning } from "../types.js"
// WalkCtx.styleMap 타입 참조 — 타입 전용이라 styles.ts와의 순환은 컴파일 시 소거됨
import type { HwpxStyleMap } from "./styles.js"
import type { NoteNumberFormat } from "./notes.js"
import type { Edges } from "../table/layout-frames.js"

// 256MB — rhwp 1만 건 실문서 서베이에서 section1.xml 단독 75.2MB(압축비 35:1) 정상
// 문서가 확인됨 (rhwp #1917). 종전 100MB 총합 컷은 대형 실문서를 ZIP bomb 으로 오인 거부.
export const MAX_DECOMPRESS_SIZE = unzipLimitBytes(256 * 1024 * 1024)
/** 손상 ZIP 복구 시 최대 엔트리 수 */
export const MAX_ZIP_ENTRIES = 500

/** ZIP bomb 가드 전용 에러 — per-section catch가 XML fatalError(PARTIAL_PARSE로 강등)와
 *  구분해 이것만 재던진다. KordocError 서브클래스라 sanitizeError allowlist는 그대로 통과 */
export class ZipBombError extends KordocError {
  constructor(message: string) {
    super(message)
    this.name = "ZipBombError"
  }
}

/**
 * ZIP 엔트리를 압축 해제 상한까지만 푼다 — 중앙 디렉터리의 크기 필드는 위조할 수 있어 사전 검사(precheckZipSize)를 지나고,
 * 다 푼 뒤 재는 누적 검사로는 엔트리 하나가 상한의 몇 배를 메모리에 올리는 것을 못 막았다(크기 필드 100B·실제 800MB manifest →
 * RSS +1GB, rhwp #7602 의 엔트리별 읽기 상한과 같은 방어). used 는 이미 푼 누적량 — 누적 집계는 호출부가 종전대로 한다.
 * 글은 JSZip async("text") 와 같은 Buffer UTF-8 디코딩(BOM 보존)
 */
export function readZipEntry(file: JSZip.JSZipObject, type: "text", used?: number): Promise<string>
export function readZipEntry(file: JSZip.JSZipObject, type: "uint8array", used?: number): Promise<Uint8Array>
export function readZipEntry(file: JSZip.JSZipObject, type: "text" | "uint8array", used = 0): Promise<string | Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stream = file.nodeStream("nodebuffer")
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (used + size > MAX_DECOMPRESS_SIZE) {
        stream.pause()
        reject(new ZipBombError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)"))
        return
      }
      chunks.push(chunk)
    })
    stream.on("error", reject)
    stream.on("end", () => {
      if (type === "text") return resolve(Buffer.concat(chunks, size).toString("utf-8"))
      // 바이트는 단독 버퍼로 — Buffer.concat 은 작은 크기를 공유 풀에서 잘라 줘 data.buffer 가 남의 64KB 가 된다
      const out = new Uint8Array(size)
      let at = 0
      for (const c of chunks) { out.set(c, at); at += c.length }
      resolve(out)
    })
  })
}

/** colSpan/rowSpan을 안전한 범위로 클램핑 */
export function clampSpan(val: number, max: number): number {
  return Math.max(1, Math.min(val, max))
}

// XML DOM 헬퍼 정본은 src/shared/xml.ts — 하위호환 재수출 (section-walker, render/* 등이
// 이 모듈에서 import). MAX_XML_DEPTH 의미(요소 깊이 ≠ 표 중첩 단계)는 정본 주석 참조.
export { MAX_XML_DEPTH, findChildByLocalName, extractTextFromNode } from "../shared/xml.js"

/** 셀 컨텍스트 확장 — 중첩표/이미지/다중문단 블록과 제목셀 여부를 IRCell로 전달 (v3.0) */
export interface CellCtxEx extends CellContext {
  blocks?: IRBlock[]
  /** 중첩표/이미지 등 구조 콘텐츠 존재 — true일 때만 IRCell.blocks로 attach */
  hasStructure?: boolean
  isHeader?: boolean
  /** 칸의 보이는 변 (borderFillIDRef → header borderFill) — IR 칸의 CELL_EDGES 로 옮긴다 (v4.17.0) */
  edges?: Edges
  /**
   * cell.text 평탄화 조립용 임시 상태 (#52 후속) — 인라인 흐름(글자취급 표·같은 문단
   * 텍스트)이 "열려" 있어 다음 인라인 항목을 `\n`이 아니라 공백으로 이어야 하는지.
   * 문단 경계·블록/float 표에서 닫힌다(false). 최종 IRCell로는 나가지 않는 워크 전용 필드.
   */
  lineOpen?: boolean
  /**
   * keepEmptyParagraphs 조립용 임시 상태 (#57) — 이 셀에서 문단(빈 문단 포함)을 하나라도
   * 봤는지. 선두 빈 문단은 cell.text가 계속 ""라 truthiness로 구분할 수 없어 별도 추적한다.
   * 옵션 off일 땐 미사용. 최종 IRCell로는 나가지 않는 워크 전용 필드.
   */
  paraSeen?: boolean
}

export interface TableState {
  rows: CellContext[][]
  currentRow: CellContext[]
  cell: CellCtxEx | null
  /** hp:caption 텍스트 — IRTable.caption으로 전달 (v3.0) */
  caption?: string
  /** hp:caption 내부 블록(중첩표 포함) — IRTable.captionBlocks로 전달 (#55) */
  captionBlocks?: IRBlock[]
  /**
   * 글자취급(treatAsChar="1") 표 여부 — 부모 셀 텍스트 평탄화 시 앞뒤 텍스트와 같은 줄로
   * 공백 연결할지 판단 (#52 후속). 블록/float 표(기본 undefined)는 종전대로 `\n`.
   */
  inline?: boolean
  /** hp:tbl id — IRTable.sourceId (렌더 region 조인 키, #76) */
  sourceId?: string
}

/** 섹션 간 공유 상태 — 자동번호 카운터, 머리말/꼬리말, 변경추적 */
export interface SectionShared {
  /** numbering id → 레벨별(1..10) 카운터. -1 = 미사용(start값으로 초기화 — 0은 start="0"의 유효값) */
  numState: Map<string, number[]>
  pageText: { headers: string[]; footers: string[] }
  track: { deleteDepth: number; warned: boolean; deletedObjects: WeakSet<Element>; deletedImageRefs: Set<string> }
  /** content.hpf kordoc-layout 메타 ("default"|"gongmun") — 자사 생성 파일 왕복 채널
   *  게이트. null/미설정 = 외래 파일 (id 기반 인라인 강조·인용 복원 꺼짐) */
  kordocLayout?: string | null
  /** 표 후행 빈 열(앵커 있는 입력란) 보존 — ParseOptions.keepTrailingEmptyCols (#47) */
  keepTrailingEmptyCols?: boolean
  /** 빈 문단 보존 — ParseOptions.keepEmptyParagraphs (#57) */
  keepEmptyParagraphs?: boolean
  /** 미기입 누름틀 안내문도 마크다운에 — ParseOptions.includeFieldPlaceholders (#92) */
  includeFieldPlaceholders?: boolean
  /** 실제 페이지 경계 상태 (#66) — base: 이전 섹션까지 누적 페이지 수,
   *  allUsable: 지금까지 파싱한 전 섹션이 조판 캐시(linesegarray)를 신뢰 가능 */
  pageState: { base: number; allUsable: boolean }
  /** 목차 항목(채움 탭 + 쪽 번호 줄) 글 — 표 칸 안 목차는 틀 표 풀기가 문단을 새로 만들어 블록 표시가 사라지므로 글로도 기억한다 (#121) */
  tocTexts: Set<string>
}

export function createSectionShared(): SectionShared {
  return {
    numState: new Map(),
    pageText: { headers: [], footers: [] },
    track: { deleteDepth: 0, warned: false, deletedObjects: new WeakSet(), deletedImageRefs: new Set() },
    pageState: { base: 0, allUsable: true },
    tocTexts: new Set(),
  }
}

/** walk 함수들이 공유하는 파싱 컨텍스트 — 개별 optional 파라미터를 하나로 묶어 시그니처 안정화 */
export interface WalkCtx {
  styleMap?: HwpxStyleMap
  warnings?: ParseWarning[]
  sectionNum?: number
  shared: SectionShared
  /** secPr outlineShapeIDRef — 개요(OUTLINE) 문단이 사용하는 numbering id */
  outlineNumId?: string
  /** secPr footNotePr/endNotePr 번호 모양 — 각주·미주 본문 참조 부호 재구성 (notes.ts) */
  noteFormats?: { footnote?: NoteNumberFormat; endnote?: NoteNumberFormat }
  /** 현재 페이지 (#66) — top-level 문단 진입 시 paraPage로 갱신, 셀/중첩은 호스트 상속 */
  page?: number
  /** 섹션 프리패스 결과: top-level <hp:p> → 섹션 내 0-based 페이지 */
  paraPage?: Map<Element, number>
  /** 이전 섹션까지 누적 페이지 수 (전역 페이지 = pageBase + 섹션 내 페이지 + 1) */
  pageBase?: number
}

/** xmldom DOMParser 생성 — onError 콜백으로 malformed XML 경고 수집 */
export function createXmlParser(warnings?: ParseWarning[]): DOMParser {
  return new DOMParser({
    onError(level: "warning" | "error" | "fatalError", msg: string) {
      if (level === "fatalError") throw new KordocError(`XML 파싱 실패: ${msg}`)
      warnings?.push({ code: "MALFORMED_XML", message: `XML ${level === "warning" ? "경고" : "오류"}: ${msg}` })
    },
  })
}

/** 수집된 머리말/꼬리말을 본문 앞/뒤 문단으로 배치 */
export function applyPageText(blocks: IRBlock[], shared: SectionShared): void {
  const { headers, footers } = shared.pageText
  if (headers.length > 0) {
    blocks.unshift(...headers.map(t => ({ type: "paragraph" as const, text: t, pageNumber: 1 })))
  }
  if (footers.length > 0) {
    blocks.push(...footers.map(t => ({ type: "paragraph" as const, text: t })))
  }
}

