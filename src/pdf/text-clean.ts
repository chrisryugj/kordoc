/**
 * PDF 마크다운 최종 정리.
 *
 * 페이지 번호 제거, 균등배분 후처리, 취소선 복원, 한글 줄바꿈 병합.
 * blocksToMarkdown 이후의 문자열 수준 후처리를 담당한다.
 */

import type { IRBlock } from "../types.js"
import { stripControlChars } from "./quality.js"
import { collapseEvenSpacing } from "./text-line.js"

/** 블록 트리의 텍스트에서 비표시 제어문자를 in-place로 제거한다. */
export function sanitizeBlockControlChars(blocks: IRBlock[]): void {
  for (const b of blocks) {
    if (b.text) b.text = stripControlChars(b.text)
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.text) cell.text = stripControlChars(cell.text)
        }
      }
    }
    if (b.children) sanitizeBlockControlChars(b.children)
  }
}

export function cleanPdfText(text: string): string {
  return mergeKoreanLines(
    stripControlChars(text)
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
