/**
 * PDF 마크다운 최종 정리.
 *
 * 페이지 번호 제거, 균등배분 후처리, 취소선 복원, 한글 줄바꿈 병합.
 * blocksToMarkdown 이후의 문자열 수준 후처리를 담당한다.
 */

import type { IRBlock } from "../types.js"
import { stripControlChars } from "./quality.js"
import { collapseEvenSpacing } from "./text-line.js"

/**
 * 한컴 PDF 가 가운뎃점(ㆍ U+318D)을 조합형 중성 아래아(ᆞ U+119E)로 내는 것을 되돌린다.
 * 실측(v4.12.3, 별지서식·별표 573쌍): PDF 출력의 가운뎃점 3,238자 중 340자(41문서)가 U+119E,
 * HWP5 원본은 전부 U+318D. 옛한글 자모 결합(앞이 초성 U+1100~115F)만 남긴다.
 */
export function normalizeAraea(text: string): string {
  return text.replace(/(?<![\u1100-\u115F])\u119E/g, "\u318D")
}

const cleanChars = (text: string): string => normalizeAraea(stripControlChars(text))

/** 블록 트리의 텍스트에서 비표시 제어문자 제거 + 조합형 가운뎃점 정규화 (in-place, 셀 blocks 포함) */
export function sanitizeBlockControlChars(blocks: IRBlock[]): void {
  for (const b of blocks) {
    if (b.text) b.text = cleanChars(b.text)
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.text) cell.text = cleanChars(cell.text)
          if (cell.blocks) sanitizeBlockControlChars(cell.blocks)
        }
      }
    }
    if (b.children) sanitizeBlockControlChars(b.children)
  }
}

/**
 * 최상위 1×1 표(중첩표 없음)를 줄마다 문단 블록으로 편다 (PDF 전용, v4.12.3).
 * 1×1 셀 줄바꿈은 표 셀 줄바꿈 보존 정책(v4.12.1 1열 다행)과 같이 지켜야 하는데, 1×1 은
 * tableToMarkdown 이 "줄\n줄" 로 내고 cleanPdfText 의 mergeKoreanLines 가 한글 줄을 이어 붙여
 * "선 서 나는 헌법을 …"(선서문 안쪽 상자, 제목 줄+본문 줄 결합)이 됐다. 문단 블록 사이는 빈 줄이라
 * 병합 대상이 아니다. 실측 파급: 별지서식·별표·보고서 897 PDF 중 10문서 12표.
 */
export function splitSingleCellTables(blocks: IRBlock[]): IRBlock[] {
  const out: IRBlock[] = []
  for (const b of blocks) {
    const t = b.type === "table" ? b.table : undefined
    const cell = t && t.rows === 1 && t.cols === 1 ? t.cells[0]?.[0] : undefined
    if (!cell || cell.blocks?.some((x) => x.type === "table")) { out.push(b); continue }
    const lines = (cell.text ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    for (const text of lines) out.push({ type: "paragraph", text, pageNumber: b.pageNumber, bbox: b.bbox })
  }
  return out
}

export function cleanPdfText(text: string): string {
  return mergeKoreanLines(
    normalizeAraea(stripControlChars(text))
      // 문서 시작 단독 페이지 번호
      .replace(/^\d{1,4}\n/, "")
      // "- 2 -" 스타일 페이지 번호 (독립 라인 및 목록 항목 형태 포함)
      .replace(/^[\s]*[-–—]\s*[-–—]?\d+[-–—]?[\s]*[-–—]?[\s]*$/gm, "")
      // "1 / 5" 스타일 페이지 번호
      .replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, "")
      // 단독 페이지 번호 (줄 끝에 혼자 있는 숫자)
      .replace(/\n\d{1,4}\n/g, "\n")
      // 문서 마지막 단독 페이지 번호
      .replace(/\n\d{1,4}$/, "")
      // 단독 숫자 헤딩 제거 ("# 6\n재무과" → "\n재무과")
      .replace(/^#{1,6}\s*\d{1,4}\s*$/gm, "")
  )
    // 균등배분 문자열 후처리 (pdfjs가 합친 TextItem + buildGridTable 셀 텍스트)
    // LaTeX 수식 라인 ($...$ / $$...$$) 은 공백이 토큰 구분자라 collapse 시 `\cdot d` → `\cdotd` 로 망가짐 — skip
    .replace(/^(?!\| ---).*$/gm, line => {
      if (/^\s*\${1,2}.+\${1,2}\s*$/.test(line)) return line
      return collapseEvenSpacing(line)
    })
    // 마커 뒤 2글자 균등배분 합침 ("□ 일 시" → "□ 일시", "□ 장 소" → "□ 장소")
    .replace(/([□■◆○●▶ㅇ])\s+([가-힣])\s+([가-힣])/g, "$1 $2$3")
    // 취소선 복원: builder escapeGfm이 ~를 \~로 이스케이프 — 쌍(~~)만 되살림
    .replace(/\\~\\~/g, "~~")
    // 인접 취소선 run이 붙어 생긴 빈 마크(~~~~) 정리
    .replace(/~~~~/g, "")
    // 내용이 사라져 빈 밑줄 쌍(<u></u>) 정리 (escapeGfm은 <>를 건드리지 않아 복원 불필요)
    .replace(/<u>\s*<\/u>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function startsWithMarker(line: string): boolean {
  const t = line.trimStart()
  return /^[가-힣ㄱ-ㅎ][.)]/.test(t) || /^\d+[.)]/.test(t) || /^\([가-힣ㄱ-ㅎ\d]+\)/.test(t) ||
    /^[○●※▶▷◆◇■□★☆\-·]\s/.test(t) || /^제\d+[조항호장절]/.test(t)
}

function isStandaloneHeader(line: string): boolean {
  return /^제\d+[조항호장절](\([^)]*\))?(\s+\S+){0,7}$/.test(line.trim())
}

function mergeKoreanLines(text: string): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= 1) return text
  const result: string[] = [lines[0]]

  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1]
    const curr = lines[i]
    const currTrimmed = curr.trim()
    // 마크다운 헤딩/테이블/구분선은 병합하지 않음
    if (/^#{1,6}\s/.test(prev) || /^#{1,6}\s/.test(curr) || /^\|/.test(currTrimmed) || /^---/.test(currTrimmed)) {
      result.push(curr)
      continue
    }
    // 쉼표로 끝나는 줄 + 다음 줄 = 연속 문장
    if (/,$/.test(prev.trim()) && currTrimmed.length > 0) {
      result[result.length - 1] = prev + "\n" + curr
      continue
    }
    // (※ 로 시작하는 줄 = 이전 줄의 부연설명
    if (/^\(※/.test(currTrimmed)) {
      result[result.length - 1] = prev + " " + currTrimmed
      continue
    }
    // 한글 줄바꿈 병합 — 마커(○, □ 등)로 시작하는 이전 줄은 합치지 않음
    if (/[가-힣·,\-]$/.test(prev) && /^[가-힣(]/.test(curr) &&
        !startsWithMarker(curr) && !isStandaloneHeader(prev) &&
        !startsWithMarker(prev)) {
      result[result.length - 1] = prev + " " + curr
    } else {
      result.push(curr)
    }
  }
  return result.join("\n")
}
