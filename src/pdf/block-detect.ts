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
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text || !block.style?.fontSize) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200) continue
    // 숫자만이면 헤딩 아님
    if (/^\d+$/.test(text)) continue

    const ratio = block.style.fontSize / medianFontSize
    let level = 0
    if (ratio >= HEADING_RATIO_H1) level = 1
    else if (ratio >= HEADING_RATIO_H2) level = 2
    else if (ratio >= HEADING_RATIO_H3) level = 3

    if (level > 0) {
      block.type = "heading"
      block.level = level
      // PDF 균등배분 스페이스 제거 ("기 본 현 황" → "기본현황")
      // 한글 글자 사이에 단독 공백이 반복되면 균등배분으로 판단
      block.text = collapseEvenSpacing(text)
    }
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

  // 텍스트 박스 패턴: 3행 이하 + 3열 이하 + <...> 또는 ㅇ 마커 포함
  // 공문서 "중점 추진사항" 등 요약 박스
  if (table.rows <= 3 && table.cols <= 3) {
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
    } else if (isCaptionCandidate(blocks[i + 1], block)) {
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
    } else if (lastTopLevelList) {
      // 하위 항목 → 직전 상위 항목의 children으로 (마크다운 들여쓰기)
      if (!lastTopLevelList.children) lastTopLevelList.children = []
      lastTopLevelList.children.push(listBlock)
      toRemove.add(i)
    } else {
      // 상위 항목 없이 시작된 하위 family — 평면 리스트로
      blocks[i] = listBlock
      lastTopLevelList = listBlock
    }
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
): number[] {
  const ZONE_RATIO = 0.12   // 상하 12% (10% 초과 여백 대응)
  const MIN_REPEAT = 3       // 최소 3페이지 반복

  type ZoneEntry = { blockIdx: number; page: number; text: string }
  const topEntries: ZoneEntry[] = []
  const bottomEntries: ZoneEntry[] = []

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    if (!b.bbox || !b.pageNumber || !b.text?.trim()) continue
    const ph = pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber)
    if (!ph) continue

    const blockTop = ph - (b.bbox.y + b.bbox.height)
    const blockBottom = ph - b.bbox.y
    const entry: ZoneEntry = { blockIdx: bi, page: b.pageNumber, text: b.text.trim() }

    if (blockBottom <= ph * ZONE_RATIO) bottomEntries.push(entry)
    else if (blockTop >= ph * (1 - ZONE_RATIO)) topEntries.push(entry)
  }

  const removeSet = new Set<number>()

  for (const entries of [topEntries, bottomEntries]) {
    if (entries.length === 0) continue

    // (1) 텍스트 반복 패턴
    const patternCount = new Map<string, number>()
    const patternPages = new Map<string, Set<number>>()
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#")
      patternCount.set(norm, (patternCount.get(norm) || 0) + 1)
      const pages = patternPages.get(norm) || new Set<number>()
      pages.add(e.page)
      patternPages.set(norm, pages)
    }
    const repeatedPatterns = new Set<string>()
    for (const [p, count] of patternCount) {
      // 서로 다른 페이지에서 MIN_REPEAT번 이상 등장
      if (count >= MIN_REPEAT && (patternPages.get(p)?.size ?? 0) >= MIN_REPEAT) {
        repeatedPatterns.add(p)
      }
    }

    // 제거 대상: 텍스트 반복 패턴 매칭
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#")
      if (repeatedPatterns.has(norm)) {
        removeSet.add(e.blockIdx)
      }
    }
  }

  if (removeSet.size > 0) {
    warnings.push({ message: `${removeSet.size}개 머리글/바닥글 요소 제거됨`, code: "HIDDEN_TEXT_FILTERED" })
  }

  return [...removeSet].sort((a, b) => a - b)
}
