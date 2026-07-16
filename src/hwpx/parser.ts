/**
 * HWPX 파서 — manifest 멀티섹션, colSpan/rowSpan, 중첩테이블
 *
 * lexdiff 기반 + edu-facility-ai 손상ZIP 복구
 *
 * 엔트리(parseHwpxDocument)와 재수출만 남김 — 구현은 목적별 모듈로 분리:
 *   parser-shared.ts  — 공유 상수(ZIP 한도)·타입(SectionShared/WalkCtx)·XML 유틸
 *   styles.ts         — head.xml 스타일/번호매기기 파싱 + 스타일 기반 헤딩 감지
 *   para-heading.ts   — 항목부호 자동번호 포맷 해석
 *   section-walker.ts — 섹션 XML 워커 (상호재귀 클러스터)
 *   table-build.ts    — TableState → IRTable 구성
 *   images.ts         — 이미지 ref → ZIP 바이너리 해제
 *   metadata.ts       — Dublin Core 메타데이터
 *   zip-sections.ts   — 손상 ZIP 복구 + Manifest 섹션 경로 해석
 */

import JSZip from "jszip"
import { blocksToMarkdown } from "../table/builder.js"
import type { DocumentMetadata, InternalParseResult, IRBlock, OutlineItem, ParseOptions, ParseWarning } from "../types.js"
import { KordocError, precheckZipSize } from "../utils.js"
// 테스트 호환성 re-export
export { precheckZipSize } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { isComFallbackAvailable, isEncryptedHwpx, extractTextViaCom, comResultToParseResult } from "./com-fallback.js"
import { applyPageText, createSectionShared, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES, ZipBombError } from "./parser-shared.js"
import { extractHwpxStyles, detectHwpxHeadings } from "./styles.js"
import { parseSectionXml } from "./section-walker.js"
import { extractImagesFromZip } from "./images.js"
import { extractHwpxMetadata } from "./metadata.js"
import { extractFromBrokenZip, resolveSectionPaths, readKordocLayout } from "./zip-sections.js"

export { extractHwpxMetadataOnly } from "./metadata.js"

// stripDtd는 utils.js에서 import

export async function parseHwpxDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<InternalParseResult> {
  // Best-effort 사전 검증 — CD 선언 크기 기반 (위조 가능, 실제 방어는 per-file 누적 체크)
  precheckZipSize(buffer, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES)

  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return extractFromBrokenZip(buffer)
  }

  // loadAsync 후 실제 엔트리 수 검증 — CD 위조와 무관한 진짜 방어선
  const actualEntryCount = Object.keys(zip.files).length
  if (actualEntryCount > MAX_ZIP_ENTRIES) {
    throw new KordocError("ZIP 엔트리 수 초과 (ZIP bomb 의심)")
  }

  // ── DRM 감지: manifest.xml에 encryption-data가 있으면 COM fallback ──
  const manifestFile = zip.file("META-INF/manifest.xml")
  if (manifestFile) {
    const manifestXml = await manifestFile.async("text")
    if (isEncryptedHwpx(manifestXml)) {
      // 파일 경로가 options에 있으면 COM fallback 시도
      if (isComFallbackAvailable() && options?.filePath) {
        const { pages, pageCount, warnings } = extractTextViaCom(options.filePath)
        if (pages.some(p => p && p.trim().length > 0)) {
          return comResultToParseResult(pages, pageCount, warnings)
        }
      }
      throw new KordocError("DRM 암호화된 HWPX 파일입니다. Windows + 한컴 오피스 설치 시 자동 추출됩니다.")
    }
  }

  // ZIP 전체 파일 누적 압축해제 크기 추적 (비섹션 파일 포함)
  const decompressed = { total: 0 }

  // 메타데이터 추출 (best-effort)
  const metadata: DocumentMetadata = {}
  await extractHwpxMetadata(zip, metadata, decompressed)

  // 스타일 정보 추출 (best-effort)
  const styleMap = await extractHwpxStyles(zip, decompressed)
  const warnings: ParseWarning[] = []

  const sectionPaths = await resolveSectionPaths(zip)
  if (sectionPaths.length === 0) throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")

  metadata.pageCount = sectionPaths.length

  // 페이지 범위 필터링 (섹션 단위 근사치)
  const pageFilter = options?.pages ? parsePageRange(options.pages, sectionPaths.length) : null
  const totalTarget = pageFilter ? pageFilter.size : sectionPaths.length
  const blocks: IRBlock[] = []
  const shared = createSectionShared()
  // 자사 생성 파일 왕복 채널 게이트 — 인라인 강조 span·인용 복원은 default 레이아웃 한정
  shared.kordocLayout = await readKordocLayout(zip)
  let parsedSections = 0
  for (let si = 0; si < sectionPaths.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue
    const file = zip.file(sectionPaths[si])
    if (!file) continue
    try {
      const xml = await file.async("text")
      decompressed.total += xml.length * 2
      if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new ZipBombError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      blocks.push(...parseSectionXml(xml, styleMap, warnings, si + 1, shared))
      parsedSections++
      options?.onProgress?.(parsedSections, totalTarget)
    } catch (secErr) {
      // bomb 가드만 전체 실패로 승격 — 한 섹션의 XML fatalError(KordocError)는
      // PARTIAL_PARSE로 강등해 나머지 섹션 파싱을 계속한다
      if (secErr instanceof ZipBombError) throw secErr
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    }
  }

  // 머리말/꼬리말 — 문서당 1회, 본문 앞/뒤에 자연스럽게 배치
  applyPageText(blocks, shared)

  // 이미지 블록에서 ZIP 바이너리 추출 — 전체 파싱 시 본문 미참조 BinData(꼬리말 그림·imgBrush 배경)도 스윕
  const images = await extractImagesFromZip(zip, blocks, decompressed, warnings, !pageFilter)

  // 스타일 기반 헤딩 감지
  detectHwpxHeadings(blocks, styleMap)

  // outline 구축
  const outline: OutlineItem[] = blocks
    .filter(b => b.type === "heading" && b.level && b.text)
    .map(b => ({ level: b.level!, text: b.text!, pageNumber: b.pageNumber }))

  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, metadata, outline: outline.length > 0 ? outline : undefined, warnings: warnings.length > 0 ? warnings : undefined, images: images.length > 0 ? images : undefined }
}

