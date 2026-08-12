/**
 * HWP 5.x 실제 페이지 경계 복원 (#66) — PARA_LINE_SEG(0x45) 조판 캐시로
 * 섹션 내 top-level 문단별 실제 페이지 배정을 계산한다.
 *
 * 알고리즘은 hwpx/page-boundary.ts와 동일한 신호 4종 (그쪽 헤더 주석 참조).
 * HWP5 매핑 (bench/corpus/pairs hwp↔hwpx 10쌍 전수 일치로 검증):
 *  - lineseg      → PARA_LINE_SEG 36바이트 엔트리 (v=+4 i32, h=+24 i32; 태그 +32의
 *                   bit0 "페이지 첫 줄"은 저장본에서 항상 0 — 못 씀)
 *  - pageBreak    → PARA_HEADER 데이터 offset 11(문단 나눔 종류)의 bit2(쪽 나누기)
 *  - top 문단     → PARA_HEADER level 0, 그 lineseg는 level 1
 *  - 표 셀        → CTRL_HEADER('tbl ') level 1 → LIST_HEADER level 2(셀 주소
 *                   col u16@8·row u16@10) → 셀 직접 문단은 같은 level 2, lineseg level 3
 *                   (중첩 표는 level 4/5라 자연 배제)
 */

import type { HwpRecord } from "./record.js"
import { TAG_PARA_HEADER, TAG_PARA_LINE_SEG, TAG_CTRL_HEADER, TAG_LIST_HEADER } from "./record.js"

/** 이 값 이상에서 시작하는 역행은 페이지 상단 리셋이 아니다 (신호 4 판별, HWPUNIT) */
const MIDPAGE_V = 2000

/** "tbl " 컨트롤 ID — LE 저장(" lbt")을 readUInt32LE로 읽은 BE 상수 (parser.ts CTRL_TBL과 동일) */
const CTRL_ID_TBL = 0x74626c20

/** 섹션 페이지 감지 결과 */
export interface Hwp5SectionPageDetect {
  /** top-level 문단 순번(등장 순서) → 섹션 내 0-based 페이지 (문단 시작 위치 기준) */
  pageAtPara: number[]
  /** 섹션이 차지하는 페이지 수 (≥1) */
  pages: number
  /** 조판 캐시 신뢰 가능 여부 — top-level 문단 전부가 LINE_SEG를 가질 때만 true */
  usable: boolean
}

/** 표 컨트롤 범위의 내부 페이지 나눔 수 — 행별 max(셀 직접 문단 흐름 리셋) 합산 */
function tableIntraBreaks(records: HwpRecord[], start: number, end: number): number {
  const rowMax = new Map<number, number>()
  let curRow = -1
  let prevV = Number.NEGATIVE_INFINITY
  let resets = 0
  const flush = () => {
    if (curRow >= 0) rowMax.set(curRow, Math.max(rowMax.get(curRow) ?? 0, resets))
    resets = 0
    prevV = Number.NEGATIVE_INFINITY
  }
  for (let i = start; i < end; i++) {
    const rec = records[i]
    if (rec.tagId === TAG_LIST_HEADER && rec.level === 2 && rec.data.length >= 12) {
      flush()
      curRow = rec.data.readUInt16LE(10)
    } else if (rec.tagId === TAG_PARA_LINE_SEG && rec.level === 3 && curRow >= 0) {
      for (let off = 0; off + 36 <= rec.data.length; off += 36) {
        const v = rec.data.readInt32LE(off + 4)
        if (v < prevV) resets++
        prevV = v
      }
    }
  }
  flush()
  let sum = 0
  for (const v of rowMax.values()) sum += v
  return sum
}

/**
 * 섹션 레코드에서 top-level 문단별 페이지 배정을 계산한다.
 * 반환 pageAtPara의 인덱스는 parseParagraphList가 만나는 top-level 문단 순서와 같다.
 */
export function detectHwp5SectionPages(records: HwpRecord[]): Hwp5SectionPageDetect {
  const pageAtPara: number[] = []
  let cur = 0
  let prevV = Number.NEGATIVE_INFINITY
  let prevH = Number.NEGATIVE_INFINITY
  let first = true
  let suppressMidReset = false
  let parasWithSegs = 0

  let i = 0
  while (i < records.length) {
    const rec = records[i]
    if (rec.tagId !== TAG_PARA_HEADER || rec.level !== 0) {
      i++
      continue
    }
    let j = i + 1
    while (j < records.length && records[j].level > 0) j++

    // 문단 나눔 종류(offset 11): bit0 구역, bit1 다단, bit2 쪽, bit3 단
    const divideSort = rec.data.length >= 12 ? rec.data.readUInt8(11) : 0
    const explicit = (divideSort & 0x04) !== 0
    let brokeByExplicit = false
    if (explicit && !first) {
      cur++
      brokeByExplicit = true
      suppressMidReset = false
    }

    let paraFirst = true
    let startPage = cur
    let hadSegs = false
    let intraAdd = 0
    for (let k = i + 1; k < j; k++) {
      const r = records[k]
      if (r.tagId === TAG_PARA_LINE_SEG && r.level === 1) {
        hadSegs = true
        for (let off = 0; off + 36 <= r.data.length; off += 36) {
          const v = r.data.readInt32LE(off + 4)
          const h = r.data.readInt32LE(off + 24)
          // HWPX 쪽 다단 예외(colCount>1일 때 h 우측 점프 배제)는 여기선 미적용 —
          // pairs 10쌍에서 HWPX와 결과 동일 검증. 다단 HWP5에서 어긋나면 그쪽 규칙 이식
          const brk = v < prevV || (paraFirst && v === prevV && h <= prevH)
          if (brk && !(paraFirst && brokeByExplicit)) {
            if (paraFirst && suppressMidReset && v >= MIDPAGE_V) {
              // 신호 4: 분할 표 꼬리 아래 재개 — 같은 경계
            } else {
              cur++
            }
          }
          if (paraFirst) {
            suppressMidReset = false
            startPage = cur
          }
          paraFirst = false
          prevV = v
          prevH = h
        }
      }
      // 신호 3: top-level 표(CTRL_HEADER 'tbl ', level 1)의 내부 분할
      if (r.tagId === TAG_CTRL_HEADER && r.level === 1 && r.data.length >= 4
        && r.data.readUInt32LE(0) === CTRL_ID_TBL) {
        let ce = k + 1
        while (ce < j && records[ce].level > 1) ce++
        intraAdd += tableIntraBreaks(records, k + 1, ce)
        k = ce - 1
      }
    }
    if (hadSegs) parasWithSegs++
    pageAtPara.push(startPage)
    first = false
    if (intraAdd > 0) {
      cur += intraAdd
      suppressMidReset = true
    }
    i = j
  }

  return {
    pageAtPara,
    pages: cur + 1,
    usable: pageAtPara.length > 0 && parasWithSegs === pageAtPara.length,
  }
}
