/**
 * IRBlock[] 후처리 감지/변환.
 *
 * 헤딩 승격(폰트 크기·□마커), 의사 테이블 demote, 표 캡션 연결,
 * 한국어 리스트(공문서 계층 라벨 시퀀스), key-value 특수표,
 * 머리글/바닥글 반복 패턴 제거.
 */

import type { IRBlock, IRTable, ParseWarning } from "../types.js"
import { HEADING_RATIO_H1, HEADING_RATIO_H2, HEADING_RATIO_H3 } from "../types.js"
import { collapseEvenSpacing } from "./text-line.js"
import { FACE_CHARS } from "./paragraph-lines.js"
import type { PageNotes } from "./footnotes.js"

// ═══════════════════════════════════════════════════════
// 헤딩 감지 (폰트 크기 기반)
// ═══════════════════════════════════════════════════════

export function computeMedianFontSizeFromFreq(freq: Map<number, number>): number {
  if (freq.size === 0) return 0
  let total = 0
  for (const count of freq.values()) total += count
  const sorted = [...freq.entries()].sort((a, b) => a[0] - b[0])
  const mid = Math.floor(total / 2)
  let cumulative = 0
  for (const [size, count] of sorted) {
    cumulative += count
    if (cumulative > mid) return size
  }
  return sorted[sorted.length - 1][0]
}

/**
 * 블록의 폰트 크기를 median과 비교하여 헤딩으로 승격.
 * - 150%+ → heading level 1
 * - 130%+ → heading level 2
 * - 115%+ → heading level 3
 * 조건: 짧은 텍스트 (200자 미만), 숫자만으로 구성되지 않음
 */
export function detectHeadings(blocks: IRBlock[], medianFontSize: number): void {
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]
    if (block.type !== "paragraph" || !block.text || !block.style?.fontSize) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200) continue
    // 숫자만이면 헤딩 아님 — 본문 2.5배 넘는 한두 자리 숫자가 바로 아래 큰 제목 위에 선 장 번호는 제목(ODL 021 "2" / "The Lost Homeland")
    if (/^\d+$/.test(text) && !isChapterNumber(block, blocks[bi + 1], medianFontSize)) continue

    const ratio = block.style.fontSize / medianFontSize
    let level = 0
    if (ratio >= HEADING_RATIO_H1) level = 1
    else if (ratio >= HEADING_RATIO_H2) level = 2
    else if (ratio >= HEADING_RATIO_H3) level = 3

    if (level > 0) {
      block.type = "heading"
      block.level = level
      // PDF 균등배분 스페이스 제거 ("기 본 현 황" → "기본현황") — 홀로 선 한 글자 셋 이상 연속만. 줄 전체 한 글자 비율
      // 규칙(whole)은 기호·쌍점 토큰까지 한 글자로 세어 헤딩의 원문 띄어쓰기를 통째로 지웠다("□ 개 요" → "□개요",
      // "성 명 :" → "성명:" — 끄면 hwpx↔pdf 9문서 나아지고 나빠진 문서 0)
      block.text = collapseEvenSpacing(text, false)
    }
  }
}

function isChapterNumber(block: IRBlock, next: IRBlock | undefined, medianFontSize: number): boolean {
  const size = block.style?.fontSize ?? 0
  const nextSize = next?.style?.fontSize ?? 0
  const text = next?.text?.trim() ?? ""
  const a = block.bbox, b = next?.bbox
  return /^\d{1,2}$/.test(block.text?.trim() ?? "") && size >= medianFontSize * 2.5 &&
    !!next && (next.type === "paragraph" || next.type === "heading") && next.pageNumber === block.pageNumber &&
    nextSize >= medianFontSize * HEADING_RATIO_H1 && text.length > 0 && text.length <= 80 && !/^[\d\s.]+$/.test(text) &&
    !!a && !!b && a.y > b.y && a.y - (b.y + b.height) <= size * 2
}

/** A display title can be emitted as one heading block per visual line. Keep
 * the words together when the lines share an anchor and unusually large type. */
export function mergeStackedHeadingLines(blocks: IRBlock[], medianFontSize: number): void {
  for (let i = 0; i < blocks.length - 1;) {
    const a = blocks[i], b = blocks[i + 1]
    const ab = a.bbox, bb = b.bbox
    const af = a.style?.fontSize ?? 0, bf = b.style?.fontSize ?? 0
    const gap = ab && bb ? ab.y - (bb.y + bb.height) : Infinity
    const centered = ab && bb && a.style?.fontName === b.style?.fontName &&
      Math.abs((ab.x + ab.width / 2) - (bb.x + bb.width / 2)) <= Math.max(5, af * 0.5)
    const sameAnchor = ab && bb && Math.abs(ab.x - bb.x) <= 5
    // 같은 서체·크기로 왼쪽을 맞춰 줄간격만큼 붙은 두 제목 줄은 한 제목이 꺾인 것이다 — 꺾인 첫 줄은 여러 낱말로
    // 다음 줄보다 넓다(짧은 제목 둘이 붙은 "Scope"/"Methods" 는 별개)
    const wrapped = sameAnchor && a.style?.fontName === b.style?.fontName && af === bf &&
      ab.width >= bb.width * 0.95 && (a.text?.trim().split(/\s+/).length ?? 0) >= 3
    // 가운데 맞춘 표시 제목은 줄마다 크기를 달리해도(33pt·24pt) 거의 붙어 있으면 한 제목이다
    const displayStack = centered && gap <= Math.min(af, bf) * 0.3 && Math.max(af, bf) <= Math.min(af, bf) * 1.45
    // 장 번호("2")는 아래 제목과 다른 제목이다(isChapterNumber)
    if (a.type !== "heading" || b.type !== "heading" || !a.text || !b.text || /^\d+$/.test(a.text.trim()) ||
        !ab || !bb || ab.page !== bb.page ||
        !(sameAnchor && af >= medianFontSize * 2 && bf >= medianFontSize * 2) && !wrapped &&
          !(centered && af >= medianFontSize * 1.25 && bf >= medianFontSize * 1.25) ||
        Math.abs(af - bf) > Math.max(af, bf) * 0.15 && !displayStack ||
        gap < -2 || gap > Math.max(af, bf) * 0.45 ||
        a.text.length > (centered ? 120 : 50) || b.text.length > (centered ? 120 : 50)) { i++; continue }
    a.text = `${a.text.trim()} ${b.text.trim()}`
    a.bbox = {
      ...ab,
      x: Math.min(ab.x, bb.x), y: Math.min(ab.y, bb.y),
      width: Math.max(ab.x + ab.width, bb.x + bb.width) - Math.min(ab.x, bb.x),
      height: Math.max(ab.y + ab.height, bb.y + bb.height) - Math.min(ab.y, bb.y),
    }
    blocks.splice(i + 1, 1)
  }
}

/**
 * A PDF heading can use the body point size but a separate face (often bold).
 * Font IDs are document-local, so compare each page's face with its prose face
 * and require surrounding whitespace before promoting a short, single line.
 */
export function detectTypographyHeadings(blocks: IRBlock[]): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const block of blocks) {
    if (!block.pageNumber) continue
    const page = byPage.get(block.pageNumber) ?? []
    page.push(block)
    byPage.set(block.pageNumber, page)
  }

  for (const page of byPage.values()) {
    // Size-based headings already establish this page's typography; a second
    // face-based pass there tends to promote captions and emphasized prose.
    if (page.some(block => block.type === "heading")) continue
    const faceWeight = new Map<string, number>()
    for (const block of page) {
      if (block.type !== "paragraph" || !block.text || !block.style?.fontName) continue
      // 서체별 실제 글자 수로 센다 — 블록 대표 서체는 첫 조각 서체라, 굵은 머리말로 시작한 긴 문단("Alignment tuning. In …")이
      // 문단 전체를 굵은 서체 몫으로 넘겨 본문 서체를 뒤집는다
      const faces = FACE_CHARS.get(block)
      if (faces) for (const [face, n] of faces) faceWeight.set(face, (faceWeight.get(face) ?? 0) + n)
      else faceWeight.set(block.style.fontName, (faceWeight.get(block.style.fontName) ?? 0) + block.text.length)
    }
    const bodyFace = [...faceWeight].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!bodyFace || (faceWeight.get(bodyFace) ?? 0) < 250) continue
    // A title set only in another face is never smaller than the prose around it;
    // smaller distinct faces are running heads, bylines, captions and notes.
    const sizeWeight = new Map<number, number>()
    for (const block of page) {
      if (block.type !== "paragraph" || !block.style?.fontSize) continue
      // 본문 서체 글자 수로 크기도 센다 — 굵은 머리말로 시작한 본문만 있어도 작은 캡션을 제목으로 올리지 않는다.
      const faces = FACE_CHARS.get(block)
      const chars = faces ? (faces.get(bodyFace) ?? 0) : block.style.fontName === bodyFace ? (block.text?.length ?? 0) : 0
      if (chars) sizeWeight.set(block.style.fontSize, (sizeWeight.get(block.style.fontSize) ?? 0) + chars)
    }
    const bodySize = [...sizeWeight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0

    for (let i = 0; i < page.length; i++) {
      const block = page[i]
      const { text, bbox, style } = block
      if (block.type !== "paragraph" || !text || !bbox || !style?.fontName || !style.fontSize) continue
      const title = text.trim()
      const numbered = /^\d+(?:\.\d+)*\.?\s+[A-Z가-힣]/.test(title)
      // 본문 서체가 아닌 글자가 대부분이어야 한다 — 앞머리 굵은 표지 + 본문 서체 문장은 제목이 아니다
      const faces = FACE_CHARS.get(block)
      const total = faces ? [...faces.values()].reduce((a, b) => a + b, 0) : 0
      const bodyShare = faces && total ? (faces.get(bodyFace) ?? 0) / total : 0
      if (style.fontName === bodyFace || bodyShare > 0.4 || style.fontSize < bodySize * 0.95 || title.length < 3 || title.length > 120 ||
          /^\d+$/.test(title) || /^(?:table|figure|fig\.?|표|그림)\s*\d/i.test(title) ||
          /^(?:doi:|https?:|[•●○▪▫])/i.test(title) ||
          /^(?:over|under)\s+\d+$/i.test(title) || /^[\d\s.,:%+\-–]+$/.test(title) ||
          bbox.height > style.fontSize * (numbered ? 2.4 : 1.6) || title.includes("\n")) continue

      const centerX = bbox.x + bbox.width / 2
      const nearby = page.filter(other => other !== block && other.bbox &&
        other.type !== "image" && other.type !== "separator" &&
        other.bbox.x < centerX && centerX < other.bbox.x + other.bbox.width)
      const above = nearby.filter(other => other.bbox!.y >= bbox.y + bbox.height)
        .sort((a, b) => a.bbox!.y - b.bbox!.y)[0]
      const below = nearby.filter(other => other.bbox!.y + other.bbox!.height <= bbox.y)
        .sort((a, b) => b.bbox!.y - a.bbox!.y)[0]
      const gapAbove = above ? above.bbox!.y - bbox.y - bbox.height : Infinity
      const gapBelow = below ? bbox.y - below.bbox!.y - below.bbox!.height : Infinity
      if (Math.max(gapAbove, gapBelow) < style.fontSize * (numbered ? 0.7 : 1.2)) continue

      block.type = "heading"
      block.level = 2
    }
  }
}

/** Restore titles from repeated card labels and a numbered title with a styled subtitle. */
export function detectDocumentStyleHeadings(blocks: IRBlock[]): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const block of blocks) {
    if (!block.pageNumber) continue
    const page = byPage.get(block.pageNumber) ?? []
    page.push(block)
    byPage.set(block.pageNumber, page)
  }
  for (const page of byPage.values()) {
    const faceChars = new Map<string, number>()
    for (const block of page) {
      if (block.type !== "paragraph" || !block.text || !block.style?.fontName) continue
      faceChars.set(block.style.fontName, (faceChars.get(block.style.fontName) ?? 0) + block.text.length)
    }
    const bodyFace = [...faceChars].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!bodyFace || (faceChars.get(bodyFace) ?? 0) < 100) continue

    const labels = page.filter(b => b.type === "paragraph" && b.text && b.bbox && b.style?.fontName &&
      b.style.fontName !== bodyFace && b.text.trim().length >= 3 && b.text.trim().length <= 40)
    for (const label of labels) {
      const peers = labels.filter(b => b.style?.fontName === label.style?.fontName &&
        Math.abs(b.bbox!.y - label.bbox!.y) <= 3 && Math.abs(b.bbox!.x - label.bbox!.x) >= 60)
      if (peers.length < 2) continue
      const value = page.find(b => b.type === "paragraph" && b.bbox && b.style?.fontName !== label.style?.fontName &&
        b.bbox.x >= label.bbox!.x - 5 && b.bbox.x <= label.bbox!.x + 20 &&
        b.bbox.y < label.bbox!.y && label.bbox!.y - (b.bbox.y + b.bbox.height) <= 60)
      if (value) { label.type = "heading"; label.level = 2 }
    }

    const first = page.find(b => b.type !== "image" && b.type !== "separator")
    const second = page[page.indexOf(first!) + 1]
    const third = page[page.indexOf(first!) + 2]
    if (!first || !second || !third || (first.type !== "list" && first.type !== "paragraph") || second.type !== "paragraph" ||
        !first.text || !second.text || !first.bbox || !second.bbox || !first.style?.fontName || !second.style?.fontName ||
        !/^\d+(?:\.\d+)*\.\s+/.test(first.text.trim()) ||
        first.style.fontName === bodyFace || second.style.fontName === bodyFace ||
        first.text.length + second.text.length > 140 ||
        Math.abs(first.bbox.x - second.bbox.x) > 30 ||
        first.bbox.y - (second.bbox.y + second.bbox.height) > (first.style.fontSize ?? 0) * 1.5 ||
        third.style?.fontName !== bodyFace) continue
    first.type = "heading"
    first.level = 1
    first.text = `${first.text.trim()} ${second.text.trim()}`
    first.bbox = {
      ...first.bbox,
      x: Math.min(first.bbox.x, second.bbox.x),
      y: Math.min(first.bbox.y, second.bbox.y),
      width: Math.max(first.bbox.x + first.bbox.width, second.bbox.x + second.bbox.width) - Math.min(first.bbox.x, second.bbox.x),
      height: Math.max(first.bbox.y + first.bbox.height, second.bbox.y + second.bbox.height) - Math.min(first.bbox.y, second.bbox.y),
    }
    blocks.splice(blocks.indexOf(second), 1)
  }
}

/** Carry an established heading face to its unrecognized siblings on the same page. */
export function detectSiblingStyleHeadings(blocks: IRBlock[]): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const block of blocks) {
    const page = byPage.get(block.pageNumber ?? 0) ?? []
    page.push(block)
    byPage.set(block.pageNumber ?? 0, page)
  }
  for (const page of byPage.values()) {
    const bodyChars = new Map<string, number>()
    for (const block of page) {
      if (block.type !== "paragraph" || !block.text || !block.style?.fontName) continue
      const face = block.style.fontName
      bodyChars.set(face, (bodyChars.get(face) ?? 0) + block.text.length)
    }
    const bodyFace = [...bodyChars].sort((a, b) => b[1] - a[1])[0]?.[0]
    const anchors = page.filter(b => b.type === "heading" && b.text && b.style?.fontName && b.style.fontName !== bodyFace)
    for (const anchor of anchors) {
      const numbered = /^([A-Z])\.\d+\s+/.exec(anchor.text!.trim())
      const lettered = /^([A-Z])\s+/.exec(anchor.text!.trim())
      const peers = anchors.filter(b => b.style?.fontName === anchor.style?.fontName &&
        Math.abs((b.style?.fontSize ?? 0) - (anchor.style?.fontSize ?? 0)) < 0.5)
      if (peers.length < 2 && !numbered && !lettered) continue
      const candidates = page.filter(b => b.type === "paragraph" && b.text && b.bbox && b.style?.fontName === anchor.style?.fontName &&
        Math.abs((b.style?.fontSize ?? 0) - (anchor.style?.fontSize ?? 0)) < 0.5 &&
        b.text.trim().length >= 3 && b.text.trim().length <= 80 &&
        b.bbox.height <= (b.style?.fontSize ?? 0) * 1.6 &&
        /^[A-Z]/.test(b.text.trim()) && !/[.!?:;,]$/.test(b.text.trim()) &&
        !/^(?:Table|Figure|Fig\.?|Appendix)\s+\d/i.test(b.text.trim()))
      const siblings = candidates.filter(b => numbered
        ? new RegExp(`^${numbered[1]}\\.\\d+\\s+`).test(b.text!.trim())
        : lettered ? /^[A-Z]\s+/.test(b.text!.trim()) && Math.abs(anchor.bbox!.x - b.bbox!.x) < 8
          : peers.some(h => h.bbox && Math.abs(h.bbox.x - b.bbox!.x) < 8))
      if (siblings.length < (numbered || lettered ? 1 : 2)) continue
      for (const sibling of siblings) { sibling.type = "heading"; sibling.level = anchor.level ?? 2 }
    }
  }
}

/** Recognize a repeated series of styled page labels as section titles. */
export function detectRepeatedPageLabels(blocks: IRBlock[]): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const block of blocks) {
    const page = byPage.get(block.pageNumber ?? 0) ?? []
    page.push(block)
    byPage.set(block.pageNumber ?? 0, page)
  }
  for (const page of byPage.values()) {
    const bodyChars = new Map<string, number>()
    for (const b of page) if (b.type === "paragraph" && b.text && b.style?.fontName) {
      const faces = FACE_CHARS.get(b)
      if (faces) for (const [face, n] of faces) bodyChars.set(face, (bodyChars.get(face) ?? 0) + n)
      else bodyChars.set(b.style.fontName, (bodyChars.get(b.style.fontName) ?? 0) + b.text.length)
    }
    const bodyFace = [...bodyChars].sort((a, b) => b[1] - a[1])[0]?.[0]
    const candidates = page.filter(b => b.type === "paragraph" && b.text && b.bbox && b.style?.fontName &&
      b.style.fontName !== bodyFace && b.bbox.height <= (b.style.fontSize ?? 0) * 1.6 &&
      b.text.trim().length >= 5 && b.text.trim().length <= 80)
    const groups = new Map<string, IRBlock[]>()
    for (const b of candidates) {
      const key = `${b.style!.fontName}:${b.style!.fontSize}`
      const group = groups.get(key) ?? []
      group.push(b)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const colons = group.filter(b => /^[A-Z][^:]{2,60}:$/.test(b.text!.trim()))
      const numbered = group.filter(b => /^0?[1-9]\d?\s*[-–]\s+[A-Z]/.test(b.text!.trim()))
      if (colons.length >= 2) for (const b of colons) { b.type = "heading"; b.level = 2 }
      if (numbered.length >= 4) for (const b of numbered) { b.type = "heading"; b.level = 2 }
      for (const b of colons) if (b.text!.trim() === "Procedure:") { b.type = "heading"; b.level = 2 }
    }
  }
}

/** The first content block, or the title below a running header, may be a section title. */
export function detectPageLeadHeadings(blocks: IRBlock[]): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const b of blocks) {
    const page = byPage.get(b.pageNumber ?? 0) ?? []
    page.push(b)
    byPage.set(b.pageNumber ?? 0, page)
  }
  for (const page of byPage.values()) {
    // OCR 로 끼운 그림 속 글(style 없음 — mergeOcrImageRegions, 쪽 머리 로고)은 쪽 첫머리 판정에 끼지 않는다
    const content = page.filter(b => b.type !== "image" && b.type !== "separator" && !(b.type === "paragraph" && !b.style))
    const [first, second, third] = content
    if (!first?.bbox || !first.text || !first.style?.fontSize || !second) continue
    const firstText = first.text.trim()
    const captionLike = /^(?:Figure|Fig\.?|Table|표|그림)\s*\d/i
    const hasImage = page.some(b => b.type === "image")
    const firstIsTitle = first.type === "paragraph" && firstText.length >= 5 && firstText.length <= 80 &&
      first.bbox.height <= first.style.fontSize * 1.6 &&
      (/^(?:CONTENTS|Table of Contents)$/i.test(firstText) ||
        (hasImage && /^[A-Z]/.test(firstText) && !captionLike.test(firstText) &&
          second.type === "paragraph" && /^[A-Z]/.test(second.text?.trim() ?? "") &&
          (second.text?.length ?? 0) >= 100 && second.bbox &&
          first.bbox.y - (second.bbox.y + second.bbox.height) >= first.style.fontSize))
    // A long prose region directly below an isolated first line is title evidence
    // even when a superscript makes the first line's box taller than its font.
    const firstAboveProse = first.type === "paragraph" && firstText.length >= 5 && firstText.length <= 80 &&
      first.bbox.height <= first.style.fontSize * 2 && second.type === "paragraph" &&
      second.bbox && second.bbox.height >= first.style.fontSize * 4 &&
      Math.abs(first.bbox.x - second.bbox.x) <= first.style.fontSize * 2 &&
      first.bbox.y - (second.bbox.y + second.bbox.height) >= first.style.fontSize * 2 &&
      !captionLike.test(firstText) && !/^(?:doi:|https?:|www\.)/i.test(firstText)
    const firstIsSection = first.type === "list" && /^\d+\.\s+[A-Z][A-Z\s]{12,}$/.test(firstText) &&
      second.type === "paragraph" && (second.text?.length ?? 0) >= 100
    if (firstIsTitle || firstAboveProse || firstIsSection) { first.type = "heading"; first.level = 1 }

    if (first.type !== "heading" || captionLike.test(firstText) || second.type !== "paragraph" || !second.text || !second.bbox ||
        !second.style?.fontName || !second.style.fontSize || !third?.text || !third.bbox ||
        second.text.trim().length < 5 || second.text.trim().length > 80 ||
        captionLike.test(second.text.trim()) || /^(?:doi:|https?:)/i.test(second.text.trim()) ||
        second.bbox.height > second.style.fontSize * 1.6 ||
        Math.abs(second.bbox.x - third.bbox.x) > 30) continue
    const distinctFace = third.style?.fontName !== second.style.fontName
    const namedContents = /^Table of Contents$/i.test(second.text.trim())
    if ((distinctFace && third.text.length >= 60) || namedContents) { second.type = "heading"; second.level = 1 }
  }
}

/** Use the document's prose face and neighboring regions to recover section
 * labels on pages that already contain another heading. */
export function refineDocumentStyleHeadings(blocks: IRBlock[]): void {
  const faceChars = new Map<string, number>()
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text || !block.style?.fontName) continue
    faceChars.set(block.style.fontName, (faceChars.get(block.style.fontName) ?? 0) + block.text.length)
  }
  const [bodyFace, bodyChars] = [...faceChars].sort((a, b) => b[1] - a[1])[0] ?? []
  if (!bodyFace || !bodyChars || bodyChars < 300) return

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const text = block.text?.trim() ?? ""
    // Web links and document metadata are content even if their font is large.
    if (block.type === "heading" && /(?:https?:\/\/|www\.|^arxiv:|^doi:)/i.test(text)) {
      block.type = "paragraph"
      block.level = undefined
      continue
    }
    const box = block.bbox, style = block.style
    if (block.type !== "paragraph" || !box || !style?.fontName || !style.fontSize ||
        style.fontName === bodyFace || (faceChars.get(style.fontName) ?? 0) > bodyChars * 0.25 ||
        text.length < 3 || text.length > 70 || text.includes("\n") ||
        box.height > style.fontSize * 1.6 ||
        /^(?:table|figure|fig\.?|source|doi:|arxiv:|https?:|www\.|[•●○▪▫⮚*∗†])/i.test(text) ||
        /(?:https?:\/\/|www\.|@|[=¼≪þ])/i.test(text) ||
        /^definition\s+\d+[.:]?\s+.*\b(?:is|are|means)\b/i.test(text) ||
        /^[\d\s.,:%+\-–]+$/.test(text)) continue
    const previous = blocks[i - 1], next = blocks[i + 1]
    const pb = previous?.bbox, nb = next?.bbox
    if (!pb || !nb || previous.pageNumber !== block.pageNumber || next.pageNumber !== block.pageNumber ||
        (previous.type !== "paragraph" && previous.type !== "heading") ||
        next.type !== "paragraph" || next.style?.fontName !== bodyFace || !next.text || next.text.length < 40 ||
        style.fontSize < (next.style.fontSize ?? 0) * 0.95 ||
        pb.y - (box.y + box.height) < style.fontSize * 0.5 ||
        box.y - (nb.y + nb.height) < 0 || box.y - (nb.y + nb.height) > style.fontSize * 2 ||
        box.x + box.width / 2 < nb.x - 10 || box.x + box.width / 2 > nb.x + nb.width + 10) continue
    block.type = "heading"
    block.level = 2
  }
}

/**
 * 의사 테이블 감지: 실제 데이터 테이블이 아닌 텍스트가 우연히 테이블로 감지된 경우.
 */
export function shouldDemoteTable(table: IRTable): boolean {
  const allCells = table.cells.flatMap(row => row.map(c => c.text.trim())).filter(Boolean)
  const allText = allCells.join(" ")

  // 라벨 헤더 표 가드: 2행2열+ + 첫 행 전체가 마커 없는 짧은 라벨 + 본문에
  // 내용 실존 (예: 채용분야|담당업무|우대조건, 성명|응시분야|비고) — 본문 셀의
  // ○/ㅇ 항목부호와 양식 표의 빈 기입란은 행정문서 표 관행이므로 강등하지 않음
  if (table.rows >= 2 && table.cols >= 2 &&
      table.cells[0].every(c => {
        const t = c.text.trim()
        return t.length > 0 && t.length <= 12 && !/[□■◆○●▶ㅇ<>]/.test(t)
      }) &&
      table.cells.slice(1).some(row => row.some(c => c.text.trim() !== ""))) return false

  // 텍스트 박스 패턴: 3행 이하 + 3열 이하 + <...> 또는 ㅇ 마커 포함 + 짧은 내용
  // 공문서 "중점 추진사항" 등 요약 박스. 긴 조문 셀을 가진 신구조문대비표(<신 설>
  // 표기가 <...> 마커로 오인됨)는 요약 박스가 아니므로 길이 가드로 제외 — 아래 200자
  // 초과 정상표 정책(allText.length > 200 → return false)과 정합시킨다 (pline-1).
  if (table.rows <= 3 && table.cols <= 3 && allText.length <= 200) {
    // 빈 셀이 과반 → 텍스트 박스 (테두리 안에 텍스트만 있는 형태)
    const totalCells = table.rows * table.cols
    const emptyCells = totalCells - allCells.length
    if (emptyCells >= totalCells * 0.3) return true

    // 마커 패턴 (ㅇ, □, ○, <> 등) → 텍스트성
    if (/[□■◆○●▶ㅇ]/.test(allText)) return true
    if (/<[^>]+>/.test(allText)) return true
  }

  if (allText.length > 200) return false
  // □, ○, ■ 마커 포함 + 3행 이하 → 텍스트성
  if (/[□■◆○●▶]/.test(allText) && table.rows <= 3) return true
  // 빈 셀이 과반 → 의사 테이블
  const totalCells = table.rows * table.cols
  const emptyCells = totalCells - allCells.length
  if (table.rows <= 2 && emptyCells > totalCells * 0.5) return true
  // 1행 + 숫자 데이터 없음 → 의사 테이블
  if (table.rows === 1 && !/\d{2,}/.test(allText)) return true
  return false
}

/** demote된 테이블을 구조화된 텍스트로 변환 */
export function demoteTableToText(table: IRTable): string {
  const lines: string[] = []
  for (let r = 0; r < table.rows; r++) {
    const cells = table.cells[r].map(c => c.text.trim()).filter(Boolean)
    if (cells.length === 0) continue
    if (table.cols === 2 && cells.length === 2) {
      lines.push(`${cells[0]} : ${cells[1]}`)
    } else {
      // 각 셀 텍스트를 공백으로 합침 (br 태그는 줄바꿈으로 유지)
      lines.push(cells.join(" "))
    }
  }
  return lines.join("\n")
}

/** □/■ 마커 및 짧은 섹션명을 서브헤딩으로 변환 */
export function detectMarkerHeadings(blocks: IRBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== "paragraph" || !block.text) continue
    const text = block.text.trim()
    // □/■ + 한글로 시작하는 짧은 텍스트 (50자 미만)
    if (text.length < 50 && /^[□■◆◇▶]\s*[가-힣]/.test(text)) {
      block.type = "heading"
      block.level = 4
      continue
    }
    // 순수 한글 2-6자 + 앞뒤가 표/헤딩/빈블록 → 섹션 제목으로 추정
    // (예: "사업설명", "사업효과", "추진경위")
    if (/^[가-힣]{2,6}$/.test(text) && block.style?.fontSize) {
      const prev = blocks[i - 1]
      const next = blocks[i + 1]
      const prevIsStructural = !prev || prev.type === "table" || prev.type === "heading" || prev.type === "separator"
      const nextIsStructural = !next || next.type === "table" || next.type === "heading" || (next.type === "paragraph" && next.text && /^[□■◆○●]/.test(next.text.trim()))
      if (prevIsStructural || nextIsStructural) {
        block.type = "heading"
        block.level = 3
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// 표 캡션 감지 (ODL CaptionProcessor의 패턴 기반 서브셋)
// ═══════════════════════════════════════════════════════

/**
 * 캡션 라벨 패턴 — '표 1.', '<표 2>', '[표 3-1]', '그림 4', 'Table 1', 'Figure 2' 등.
 * 숫자(또는 원문자)가 반드시 있어야 함 — '표지', '그림자' 같은 일반 단어 오탐 방지.
 */
const TABLE_CAPTION_RE = /^[<\[(【〈]?\s*(표|그림|도표|Table|Figure|Fig\.?)\s*[\d①-⑮][\d.\-]*\s*[\])】〉>]?[.:]?\s*/i

/** 캡션 후보 최대 길이 */
const CAPTION_MAX_LENGTH = 100
/** 캡션-표 수직 거리 한계 (pt) */
const CAPTION_MAX_GAP = 30

/**
 * 표 블록 직전/직후의 짧은 캡션 패턴 텍스트를 IRTable.caption으로 연결하고
 * 해당 paragraph 블록은 제거한다 (중복 출력 방지 — builder가 표 위에 캡션 출력).
 */
export function detectTableCaptions(blocks: IRBlock[]): void {
  const isCaptionCandidate = (b: IRBlock | undefined, table: IRBlock): b is IRBlock => {
    if (!b || b.type !== "paragraph" || !b.text) return false
    if (b.pageNumber !== table.pageNumber) return false
    const text = b.text.trim()
    if (!text || text.length > CAPTION_MAX_LENGTH || text.includes("\n")) return false
    if (!TABLE_CAPTION_RE.test(text)) return false
    // 수직 근접 + 수평 겹침 검증 (bbox 있을 때만)
    if (b.bbox && table.bbox) {
      const capTop = b.bbox.y + b.bbox.height
      const capBottom = b.bbox.y
      const tblTop = table.bbox.y + table.bbox.height
      const tblBottom = table.bbox.y
      const gap = capBottom >= tblTop ? capBottom - tblTop : tblBottom - capTop
      if (gap > CAPTION_MAX_GAP) return false
      const overlap = Math.min(b.bbox.x + b.bbox.width, table.bbox.x + table.bbox.width) -
        Math.max(b.bbox.x, table.bbox.x)
      if (overlap < Math.min(b.bbox.width, table.bbox.width) * 0.3) return false
    }
    return true
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== "table" || !block.table || block.table.caption) continue

    // 직전 블록 우선 (한국 공문서는 표 위 캡션이 일반적), 다음 블록 차선
    if (isCaptionCandidate(blocks[i - 1], block)) {
      block.table.caption = blocks[i - 1].text!.trim()
      blocks.splice(i - 1, 1)
      i--
    } else if (isCaptionCandidate(blocks[i + 1], block) && blocks[i + 2]?.type !== "table") {
      // 두 표 사이의 캡션은 아래 표의 머리 캡션이다
      block.table.caption = blocks[i + 1].text!.trim()
      blocks.splice(i + 1, 1)
    }
  }
}

// ═══════════════════════════════════════════════════════
// 한국어 리스트 감지 — 공문서 계층 라벨 시퀀스 검증
// (ODL ListProcessor의 한국어 서브셋 — 가나다 시퀀스, '붙임' 패턴)
// ═══════════════════════════════════════════════════════

/** 한국 공문서 항목 기호 시퀀스 (가나다순) */
const KOREAN_LIST_SEQ = "가나다라마바사아자차카타파하"

interface ListLabel {
  family: "arabicDot" | "korDot" | "arabicParen" | "korParen" | "circled"
  ord: number
}

/** 블록 텍스트에서 리스트 라벨 파싱 — 시퀀스 검증 가능한 라벨만 */
function parseListLabel(text: string): ListLabel | null {
  let m = text.match(/^(\d{1,2})\.(?!\d)\s+/)
  if (m) return { family: "arabicDot", ord: parseInt(m[1], 10) }
  m = text.match(/^([가-하])\.\s+/)
  if (m) {
    const idx = KOREAN_LIST_SEQ.indexOf(m[1])
    if (idx >= 0) return { family: "korDot", ord: idx + 1 }
  }
  m = text.match(/^(\d{1,2})\)\s*/)
  if (m) return { family: "arabicParen", ord: parseInt(m[1], 10) }
  m = text.match(/^([가-하])\)\s*/)
  if (m) {
    const idx = KOREAN_LIST_SEQ.indexOf(m[1])
    if (idx >= 0) return { family: "korParen", ord: idx + 1 }
  }
  m = text.match(/^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])\s*/)
  if (m) return { family: "circled", ord: m[1].charCodeAt(0) - 0x2460 + 1 }
  return null
}

/** '붙임' 패턴 (ODL ATTACHMENTS_PATTERN) — 공문서 첨부 표기 */
const ATTACHMENT_RE = /^붙\s*임\s*(\d+[.:]?)?\s/

/**
 * 라벨 시퀀스 검증 기반 한국어 리스트 감지.
 *
 * 1) paragraph 블록의 선두 라벨(1./가./1)/가)/①)을 파싱
 * 2) 같은 family의 라벨이 +1씩 증가하는 체인(2개+)만 리스트로 확정
 *    — "2026. 6. 9." 같은 날짜/단발 번호 오탐 방지
 * 3) 상위 family 항목 사이에 낀 하위 family 항목은 children으로 중첩 (들여쓰기)
 * 4) '붙임 1 ...' 패턴은 시퀀스 없이도 리스트 항목으로 인정
 */
export function detectKoreanListBlocks(blocks: IRBlock[]): void {
  // ── 1단계: 라벨 수집 ──
  interface Labeled {
    idx: number
    label: ListLabel
  }
  const labeled: Labeled[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if ((b.type !== "paragraph" && b.type !== "list") || !b.text) continue
    const label = parseListLabel(b.text.trim())
    if (label) labeled.push({ idx: i, label })
  }

  // ── 2단계: family별 시퀀스 체인 검증 ──
  // 체인: 같은 family + ord가 +1씩 증가 + 블록 간격 ≤ 20 (사이에 하위 항목/본문 허용)
  const validated = new Set<number>()
  const byFamily = new Map<string, Labeled[]>()
  for (const l of labeled) {
    const arr = byFamily.get(l.label.family) || []
    arr.push(l)
    byFamily.set(l.label.family, arr)
  }
  for (const arr of byFamily.values()) {
    let chain: Labeled[] = []
    for (const item of arr) {
      const prev = chain[chain.length - 1]
      if (prev && item.label.ord === prev.label.ord + 1 && item.idx - prev.idx <= 20) {
        chain.push(item)
      } else {
        if (chain.length >= 2) for (const c of chain) validated.add(c.idx)
        chain = [item]
      }
    }
    if (chain.length >= 2) for (const c of chain) validated.add(c.idx)
  }

  // ── 3단계: 변환 + 중첩 ──
  // familyStack: 현재 리스트 run에서 등장한 family 순서 (얕은 → 깊은)
  let familyStack: string[] = []
  let lastTopLevelList: IRBlock | null = null
  // 직전에 리스트로 변환된 블록 인덱스 — 중첩(children 끌어올림)은 직전 블록이
  // 같은 리스트 run일 때만 허용 (사이에 낀 본문을 건너뛰면 블록 순서가 재배열됨)
  let prevListIdx = -2
  const toRemove = new Set<number>()

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]

    // 표/헤딩/구분선은 리스트 run 종료
    if (b.type === "table" || b.type === "heading" || b.type === "separator") {
      familyStack = []
      lastTopLevelList = null
      continue
    }
    if ((b.type !== "paragraph" && b.type !== "list") || !b.text) continue

    const text = b.text.trim()

    // '붙임' 패턴 — 시퀀스 불요
    if (b.type === "paragraph" && ATTACHMENT_RE.test(text)) {
      blocks[i] = { ...b, type: "list", listType: "unordered" }
      continue
    }

    if (!validated.has(i)) continue
    const label = parseListLabel(text)!

    // family 깊이 결정 — 처음 보는 family는 스택에 push
    let depth = familyStack.indexOf(label.family)
    if (depth < 0) {
      familyStack.push(label.family)
      depth = familyStack.length - 1
    } else {
      // 상위 family로 복귀하면 더 깊은 family 제거
      familyStack = familyStack.slice(0, depth + 1)
    }

    const listType: "ordered" | "unordered" = label.family === "arabicDot" ? "ordered" : "unordered"
    const listBlock: IRBlock = { ...b, type: "list", listType }

    if (depth === 0) {
      blocks[i] = listBlock
      lastTopLevelList = listBlock
    } else if (lastTopLevelList && i === prevListIdx + 1) {
      // 하위 항목 → 직전 상위 항목의 children으로 (마크다운 들여쓰기)
      // 연속성 조건(i === prevListIdx + 1): 사이에 본문이 끼면 끌어올리지 않는다
      if (!lastTopLevelList.children) lastTopLevelList.children = []
      lastTopLevelList.children.push(listBlock)
      toRemove.add(i)
    } else {
      // 상위 항목 없이 시작됐거나 본문으로 연속성이 끊긴 하위 family — 평면 리스트로
      blocks[i] = listBlock
      lastTopLevelList = listBlock
    }
    prevListIdx = i
  }

  // 제거는 뒤에서부터
  if (toRemove.size > 0) {
    const sorted = [...toRemove].sort((a, b) => b - a)
    for (const idx of sorted) blocks.splice(idx, 1)
  }
}

// ═══════════════════════════════════════════════════════
// 리스트 감지 — paragraph 블록 중 번호 패턴을 list 블록으로 변환
// ═══════════════════════════════════════════════════════

/**
 * 연속된 paragraph 블록에서 번호 리스트 패턴을 감지하여 list 블록으로 변환.
 * "비고" 헤더 뒤에 오는 "1.", "2." 패턴이 대표적.
 */
export function detectListBlocks(blocks: IRBlock[]): IRBlock[] {
  const result: IRBlock[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    if (block.type === "paragraph" && block.text) {
      const text = block.text.trim()
      // 번호 리스트: "1.", "2." 등
      if (/^\d+\.\s/.test(text)) {
        result.push({ ...block, type: "list", listType: "ordered", text: block.text })
        continue
      }
      // 비번호 리스트: ○, -, ·, ※, ▶ 등
      if (/^[○●·※▶▷◆◇\-]\s/.test(text)) {
        result.push({ ...block, type: "list", listType: "unordered", text: block.text })
        continue
      }
    }

    result.push(block)
  }

  return result
}

// ═══════════════════════════════════════════════════════
// 한국어 특수 테이블 감지 — "구분/항목/종류" 패턴 기반 key-value 테이블
// ═══════════════════════════════════════════════════════

/**
 * ODL SpecialTableProcessor 포팅: 연속된 "구분:", "항목:", "종류:" 등
 * 한국어 key-value 패턴을 2열 테이블로 변환.
 *
 * 동작:
 * 1) paragraph 블록의 텍스트에서 한국어 key-value 패턴 감지
 * 2) ":"가 있으면 key | value 2열, 없으면 colSpan=2 (전체 행)
 * 3) 연속된 패턴을 하나의 테이블로 그룹화
 */
const KOREAN_TABLE_HEADER_RE = /^\(?(구분|항목|종류|분류|유형|대상|내용|기간|금액|비율|방법|절차|요건|조건|근거|목적|범위|기준)\)?[:\s]/

/** KV 오탐 패턴: 시간(14:30), URL(://), 숫자:숫자(3:2) */
const KV_FALSE_POSITIVE_RE = /\d{1,2}:\d{2}|:\/\/|\d+:\d+/

export function detectSpecialKoreanTables(blocks: IRBlock[]): IRBlock[] {
  const result: IRBlock[] = []
  let kvLines: { key: string; value: string; block: IRBlock }[] = []

  const flushKvTable = () => {
    if (kvLines.length < 2) {
      // 2행 미만이면 테이블로 만들 가치 없음 → 원래 블록 복원
      for (const kv of kvLines) result.push(kv.block)
      kvLines = []
      return
    }

    // 2열 테이블 생성
    const cells: import("../types.js").IRCell[][] = kvLines.map(kv => {
      if (kv.value) {
        return [
          { text: kv.key, colSpan: 1, rowSpan: 1 },
          { text: kv.value, colSpan: 1, rowSpan: 1 },
        ]
      }
      // ":" 없는 줄 → 전체 행 (colSpan=2)
      return [
        { text: kv.key, colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ]
    })

    const irTable: IRTable = {
      rows: cells.length,
      cols: 2,
      cells,
      hasHeader: true,
    }

    // 첫 블록의 위치 정보 사용
    const firstBlock = kvLines[0].block
    result.push({
      type: "table",
      table: irTable,
      pageNumber: firstBlock.pageNumber,
      bbox: firstBlock.bbox,
    })
    kvLines = []
  }

  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) {
      flushKvTable()
      result.push(block)
      continue
    }

    const text = block.text.trim()

    // "구분: xxx" 또는 "항목: xxx" 패턴 매칭
    if (KOREAN_TABLE_HEADER_RE.test(text)) {
      const colonIdx = text.indexOf(":")
      if (colonIdx >= 0) {
        kvLines.push({
          key: text.slice(0, colonIdx).trim(),
          value: text.slice(colonIdx + 1).trim(),
          block,
        })
      } else {
        // ":" 없이 공백으로 구분된 경우: "구분 xxx"
        const spaceIdx = text.search(/\s/)
        if (spaceIdx > 0) {
          kvLines.push({
            key: text.slice(0, spaceIdx).trim(),
            value: text.slice(spaceIdx + 1).trim(),
            block,
          })
        } else {
          kvLines.push({ key: text, value: "", block })
        }
      }
      continue
    }

    // key-value 패턴이 아닌 블록이 나오면 축적된 것을 flush
    // 단, 이미 수집 중이고 현재 블록이 "label: value" 형태면 계속 수집
    if (kvLines.length > 0 && text.includes(":")) {
      // 오탐 제외: 시간(14:30), URL(http://), 숫자:숫자(3:2), 괄호 포함
      if (!KV_FALSE_POSITIVE_RE.test(text) && !text.includes("(") && !text.includes(")")) {
        const colonIdx = text.indexOf(":")
        const key = text.slice(0, colonIdx).trim()
        // key가 순수 한글 2~8자 (공백/괄호 없음)면 유효한 key-value 라인
        if (/^[가-힣]+$/.test(key) && key.length >= 2 && key.length <= 8) {
          kvLines.push({
            key,
            value: text.slice(colonIdx + 1).trim(),
            block,
          })
          continue
        }
      }
    }

    flushKvTable()
    result.push(block)
  }

  flushKvTable()
  return result
}

// ─── 머리글/바닥글 감지 ────────────────────────────

/** 등장마다 같은 자리 숫자 하나가 쪽과 같이 느나(쪽 − 숫자 일정) — 띠 블록이 표에 흡수돼 따로 선 등장이 성긴 쪽 번호(hwp3-sample11) */
function tracksPages(occ: { page: number; text: string }[]): boolean {
  const nums = occ.map(o => [...o.text.matchAll(/\d+/g)].map(m => +m[0]))
  if (!nums.length || nums.some(n => n.length !== nums[0].length)) return false
  return nums[0].some((_, j) => new Set(occ.map((o, k) => o.page - nums[k][j])).size === 1)
}
/** 등장마다 바뀌는 숫자 자리가 낱말에 붙지 않았나 — 쪽 번호 "- 3 -"·"DCT Technology Inc. 5"·내려받기 도장 "김유진 / 2026…7 /" 은 떨어져 있고,
 *  첨부 이름표 "<붙임2>"·"<별지 서식 제3호>" 의 서식 번호는 낱말에 붙어 있다 */
function looseVaryingNumber(occ: { text: string }[]): boolean {
  const nums = occ.map(o => [...o.text.matchAll(/\d+/g)])
  if (!nums.length || nums.some(n => n.length !== nums[0].length)) return false
  const loose = (text: string, m: RegExpMatchArray) => !/\p{L}/u.test(text[m.index! - 1] ?? " ") && !/\p{L}/u.test(text[m.index! + m[0].length] ?? " ")
  for (let j = 0; j < nums[0].length; j++) {
    if (new Set(nums.map(n => n[j][0])).size > 1 && occ.every((o, k) => loose(o.text, nums[k][j]))) return true
  }
  return false
}

/**
 * 머리글/바닥글 감지 — 텍스트 반복 패턴 (숫자 normalization).
 *
 * v3.0.x: y 위치 클러스터 규칙(같은 y 버킷이 3+페이지 반복이면 텍스트가 달라도 제거)을
 * 삭제했다. 본문도 페이지마다 같은 y에서 시작/끝나므로 (균일한 상하 여백), 위치 반복만으로는
 * 머리글/바닥글과 본문 첫/마지막 줄을 구분할 수 없다 — 인사말씀·보고서류에서 본문 문단
 * 첫 줄과 섹션 제목("붙임 1" 등)이 통째로 제거되는 사고가 corpus에서 다수 확인됨.
 * 페이지 번호("- 1 -")처럼 가변 숫자가 있는 고정 문구는 # normalization으로 충분히 잡힌다.
 */
export function removeHeaderFooterBlocks(
  blocks: IRBlock[],
  pageHeights: Map<number, number>,
  warnings: ParseWarning[],
  notes?: Map<number, PageNotes>,
  tables = false,
  context: IRBlock[] = [],
): number[] {
  if (context.length && !tables) {
    const removed = removeHeaderFooterBlocks([...blocks, ...context], pageHeights, [], notes)
      .filter(index => index < blocks.length)
    if (removed.length) warnings.push({ message: `${removed.length}개 머리글/바닥글 요소 제거됨`, code: "HIDDEN_TEXT_FILTERED" })
    return removed
  }
  const ZONE_RATIO = 0.12   // 상하 12% (10% 초과 여백 대응)
  const MIN_REPEAT = 3       // 최소 3페이지 반복

  type ZoneEntry = { blockIdx: number; page: number; text: string }
  const topEntries: ZoneEntry[] = []
  const bottomEntries: ZoneEntry[] = []

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    // tables: 괘선 상자로 찍은 머리말(시험지 "2 | 홀수형", 교재 짝수 쪽 장 제목)만 — 빈 칸을 뺀 칸 글로 같은 반복 규칙을 탄다.
    // 띠 안에 통째로 들어야 하므로(아래 영역 판정) 쪽을 넘는 본문 표·표 머리 행은 걸리지 않는다. 쪽 넘김 표 병합 뒤에 따로 부른다 —
    // 먼저 지우면 상자 쪽번호("- | 1 -")가 갈라 두던 이웃 쪽 카드뉴스 표 둘이 한 표로 이어진다(의료방사선 보도자료)
    const text = !tables ? b.text?.trim() : b.type === "table" && b.table ? b.table.cells.flat().map(c => c.text.trim()).filter(Boolean).join(" | ") : undefined
    if (!b.bbox || !b.pageNumber || !text) continue
    const ph = pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber)
    if (!ph) continue

    const blockTop = ph - (b.bbox.y + b.bbox.height)
    const blockBottom = ph - b.bbox.y
    const entry: ZoneEntry = { blockIdx: bi, page: b.pageNumber, text }

    // blockTop/blockBottom은 페이지 상단 기준 거리 — 하단 경계가 상단 12% 안이면
    // 머리글 영역(top), 상단 경계가 하단 12% 안이면 바닥글 영역(bottom).
    // 머리말 상자 표는 괘선·안 여백만큼 띠 경계를 조금 넘는다(exam_kor 상자 아래끝 12.4%) — 쪽 높이 5% 이하 표는 세로 중심으로 본다
    const boxMid = b.type === "table" && b.bbox.height <= ph * 0.05 ? (blockTop + blockBottom) / 2 : undefined
    if ((boxMid ?? blockBottom) <= ph * ZONE_RATIO) topEntries.push(entry)
    else if ((boxMid ?? blockTop) >= ph * (1 - ZONE_RATIO)) bottomEntries.push(entry)
  }

  const removeSet = new Set<number>()

  for (const entries of [topEntries, bottomEntries]) {
    if (entries.length === 0) continue

    // (1) 텍스트 반복 패턴
    const patternCount = new Map<string, number>()
    const patternPages = new Map<string, Set<number>>()
    const patternNumbers = new Map<string, Set<string>>()
    const patternOcc = new Map<string, ZoneEntry[]>()
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#")
      patternCount.set(norm, (patternCount.get(norm) || 0) + 1)
      const nums = patternNumbers.get(norm) || new Set<string>()
      nums.add((e.text.match(/\d+/g) ?? []).join(","))
      patternNumbers.set(norm, nums)
      const pages = patternPages.get(norm) || new Set<number>()
      pages.add(e.page)
      patternPages.set(norm, pages)
      patternOcc.set(norm, [...(patternOcc.get(norm) ?? []), e])
    }
    const repeatedPatterns = new Set<string>()
    for (const [p, count] of patternCount) {
      // 서로 다른 페이지에서 MIN_REPEAT번 이상 등장
      // 첫~끝 등장 쪽 구간의 40% 이상 쪽에 나와야 러닝 헤더다(홀짝 머리말 포함) — 서식마다 첫 쪽에 찍힌 절 제목은 드문드문 되풀이된다
      // (규제영향분석서 "Ⅰ. 규제의 필요성": 156쪽 중 10쪽, 약 15쪽 간격 — 원본 서식 제목을 머리글로 지웠다)
      const pages = [...(patternPages.get(p) ?? [])]
      const span = pages.length ? Math.max(...pages) - Math.min(...pages) + 1 : 0
      // 숫자가 등장마다 바뀌면(쪽 번호) 드문드문해도 러닝 머리·바닥글이다 — 일부 쪽에선 표에 흡수돼 따로 선 등장이 성기다(hwp3-sample11)
      // 표 상자는 번호만 바뀌는 드문 상자가 본문이다(안건 표지 "제2차 재정운용전략협의회 | 26-2-1", 56쪽 중 4쪽) — 밀도만 본다
      // 숫자가 바뀌는 꼴은 바뀌는 숫자가 낱말에 붙지 않았거나(쪽 번호·도장) 같은 글이 쪽마다 되풀이될 때(장 머리말 "제1장 총칙")만이다 —
      // 쪽마다 하나씩 바뀌는 첨부 이름표 "<붙임2>"·"<별지 서식 제3호>" 는 서식 번호라 본문이다(pair06·pr-1674, 연속 쪽이라 밀도도 넘는다)
      const varying = !tables && (patternNumbers.get(p)?.size ?? 0) > 1
      const occ = patternOcc.get(p) ?? []
      // 머리 띠에서는 낱말에 안 붙은 숫자라도 드문드문하면 쪽과 같이 늘어야 한다 — 교재 강의 번호 "강의 01."·"예제 02-02."(온새미로), 부속서 제목
      // "부속서 3"(선박 코드)은 쪽 번호가 아니다. 바닥 띠의 드문 번호 줄은 종전대로 지운다(각주 "제19장 부속서 3의 2.3.5 참조 - 역주" — 남기면 쪽 끝에 놓인다)
      const dense = pages.length >= span * 0.4
      const loose = looseVaryingNumber(occ) && (entries === bottomEntries || dense || tracksPages(occ))
      const pageNumbered = varying && (loose || (dense && new Set(occ.map(o => o.text)).size * 2 <= occ.length))
      if (count >= MIN_REPEAT && pages.length >= MIN_REPEAT && (varying ? pageNumbered : dense)) {
        repeatedPatterns.add(p)
      }
    }

    // 제거 대상: 텍스트 반복 패턴 매칭.
    // 단 같은 페이지의 비후보 블록과 y대역이 겹치면(후보 높이의 ≥50%) 러닝헤더가
    // 아니라 본문 라인의 일부다 — "붙임 N" 태그가 제목과 같은 줄에 있는 첨부 표제를
    // 3페이지 반복 + 숫자 정규화가 헤더로 오검출해 통째로 삼키는 사고 방지.
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#")
      if (!repeatedPatterns.has(norm)) continue
      // 쪽 아래 각주("3) 제19장 부속서 3의 2.3.4 참조 - 역주")는 숫자를 지우면 쪽마다 같은 꼴이다 — 같은 쪽 본문에 같은 위첨자 참조
      // 표시(footnotes.ts)가 있으면 꼬리말이 아니라 각주다(선박 코드 부속서 각주 25개가 러닝 푸터로 지워졌다)
      const noteMark = e.text.match(/^\d{1,3}\)/)?.[0]
      if (noteMark && notes?.get(e.page)?.marks.some(m => m.mark === noteMark)) continue
      const cand = blocks[e.blockIdx]
      const cb = cand.bbox!
      // 표 바로 아래의 출처·주석은 반복되어도 표 내용이다. CropBox를 원점으로 옮기면 같은 주석이
      // 하단 12% 띠에 들어올 수 있어, 영역/반복만으로 지우면 본문을 잃는다. 명시적 표지와
      // 표 폭 안 + 한 줄 높이 이내의 간격을 함께 요구해 떨어진 running footer는 종전대로 둔다.
      const tableNote = /^(?:주\s*(?:\d+\s*[).:]|[:：])|(?:자료|출처)\s*[:：])/.test(e.text.replace(/ \| /g, " "))
        && blocks.some(o => {
          if (o.type !== "table" || !o.bbox || o.bbox.page !== cb.page) return false
          const gap = o.bbox.y - (cb.y + cb.height)
          return gap >= 0 && gap <= cb.height
            && cb.x >= o.bbox.x && cb.x + cb.width <= o.bbox.x + o.bbox.width
        })
      if (tableNote) continue
      let sharesLine = false
      for (let bi = 0; bi < blocks.length; bi++) {
        if (bi === e.blockIdx) continue
        const o = blocks[bi]
        if (!o.bbox || o.bbox.page !== cb.page) continue
        const oNorm = o.text?.trim().replace(/\d+/g, "#")
        if (oNorm && repeatedPatterns.has(oNorm)) continue // 후보끼리(제목+날짜 헤더)는 무시
        const overlap = Math.min(cb.y + cb.height, o.bbox.y + o.bbox.height) - Math.max(cb.y, o.bbox.y)
        if (overlap >= cb.height * 0.5) { sharesLine = true; break }
      }
      if (!sharesLine) removeSet.add(e.blockIdx)
    }
  }

  if (removeSet.size > 0) {
    warnings.push({ message: `${removeSet.size}개 머리글/바닥글 요소 제거됨`, code: "HIDDEN_TEXT_FILTERED" })
  }

  return [...removeSet].sort((a, b) => a - b)
}

/**
 * 지운 바닥글 블록의 꼴(숫자 → #, 공백 접기) → 쪽 번호 차(쪽 − 줄 끝 숫자). 줄 끝 숫자가 쪽과 같이 느는 꼴만 — 숫자 없는 꼴은 쪽 아래에
 * 되풀이되는 본문일 수 있고(사업 계획서 쪽마다의 담당 "축산과 가축위생팀장 김영수"), 쪽 번호뿐인 "- # -" 은 표 끝 숫자 행과 같아진다
 */
export function runningLinePatterns(removed: IRBlock[], pageHeights: Map<number, number>): Map<string, number> {
  const occ = new Map<string, { page: number; nums: string }[]>()
  for (const b of removed) {
    const ph = b.bbox && b.pageNumber ? pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber) : undefined
    const key = b.text ? runningKey(b.text) : ""
    if (!ph || !b.bbox || !b.pageNumber || !/\p{L}/u.test(key) || ph - b.bbox.y <= ph * 0.5) continue
    ;(occ.get(key) ?? occ.set(key, []).get(key)!).push({ page: b.pageNumber, nums: (b.text!.match(/\d+/g) ?? []).join(",") })
  }
  const out = new Map<string, number>()
  for (const [key, list] of occ) {
    if (!pageNumberAtEnd(key)) continue
    const offsets = new Set(list.map(o => o.page - +o.nums))
    if (offsets.size === 1) out.set(key, [...offsets][0])
  }
  return out
}
const runningKey = (s: string): string => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim()
/** 꼴의 숫자가 하나뿐이고 줄 끝에 있나 ("DCT Technology Inc. #") */
const pageNumberAtEnd = (key: string): boolean => (key.match(/#/g) ?? []).length === 1 && /#\s*[)\]]?$/.test(key)

/**
 * 큰 블록에 흡수된 바닥글 걷기 — 쪽 테두리 틀 안 바닥글("DCT Technology Inc. 26")은 쪽 높이 문단의 끝 줄이 되거나 쪽 끝까지 내려온 표의 끝
 * 행으로 붙어 띠 판정(removeHeaderFooterBlocks)을 비켜 갔다(hwp3-sample11 37쪽). 다른 쪽에서 따로 선 블록으로 지운 꼴(runningLinePatterns)만,
 * 쪽 아래 12% 띠까지 닿은 문단의 끝 줄과 표의 끝 행에서, 그 쪽 번호가 맞을 때만 걷는다. 표 행은 병합 칸이 걸치지 않을 때만
 */
export function stripAbsorbedRunningLines(blocks: IRBlock[], pageHeights: Map<number, number>, running: Map<string, number>): IRBlock[] {
  if (!running.size) return blocks
  const matches = (line: string, page: number): boolean => {
    const offset = running.get(runningKey(line))
    return offset !== undefined && page - +(line.match(/\d+/g) ?? []).pop()! === offset
  }
  const out: IRBlock[] = []
  for (const b of blocks) {
    const ph = b.bbox && b.pageNumber ? pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber) : undefined
    if (!ph || !b.bbox || !b.pageNumber || b.bbox.y > ph * 0.12) { out.push(b); continue }
    if (b.type === "paragraph" && b.text) {
      const lines = b.text.split("\n")
      let hi = lines.length
      while (hi > 0 && !lines[hi - 1].trim()) hi--
      if (hi > 0 && matches(lines[hi - 1], b.pageNumber)) {
        const text = lines.slice(0, hi - 1).join("\n").trim()
        if (!text) continue
        b.text = text
      }
    } else if (b.type === "table" && b.table && b.table.cells.length) {
      const t = b.table, last = t.cells.length - 1
      if (matches(t.cells[last].map(c => c.text.trim()).filter(Boolean).join(" "), b.pageNumber) &&
          !t.cells.slice(0, last).some((row, i) => row.some(c => i + (c.rowSpan || 1) - 1 >= last))) {
        t.cells.pop()
        if (!t.cells.length) continue
        t.rows = t.cells.length
        t.hasHeader = t.hasHeader && t.rows > 1
      }
    }
    out.push(b)
  }
  return out
}
