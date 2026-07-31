/**
 * 누름틀(CLICK_HERE fieldBegin) 인식·채우기 — 정부 표준 서식(기안문) 지원
 *
 * HWPX의 누름틀은 `<hp:ctrl><hp:fieldBegin type="CLICK_HERE" name="…">…</hp:fieldBegin>
 * </hp:ctrl>` 과 `<hp:ctrl><hp:fieldEnd beginIDRef="…"/></hp:ctrl>` 쌍으로 표시되고,
 * 실제 값은 두 ctrl **사이의** run 콘텐츠다. 안내문(placeholder)은 fieldBegin의
 * Clickhere Command 파라미터에만 있고 본문 텍스트가 아니므로, 채우기는 안내문과
 * 값을 비교하지 않고 무조건 사이 영역을 값으로 치환한다 — 값이 안내문과 동일해도
 * 침묵 유실이 없다 (rhwp 코어 결함 #3380 교훈).
 *
 * 치환은 filler-hwpx와 같은 철학의 원본 XML splice — fieldBegin/fieldEnd·안내문
 * 파라미터·둘러싼 run(charPr)을 1바이트도 건드리지 않고 사이 영역만 바꾼다.
 */

import JSZip from "jszip"
import { escapeXmlText, decodeXmlEntities } from "../roundtrip/source-map.js"
import { applySplices, type SpliceEdit } from "../roundtrip/source-map.js"
import { normalizeLabel, type ValueCursor } from "./match.js"
import type { FormField } from "../types.js"
import { precheckZipSize } from "../utils.js"

/** 문서에서 발견한 누름틀 필드 */
export interface ClickHereField {
  /** 누름틀 이름 (fieldBegin name 속성) */
  name: string
  /** 안내문 — 필드가 비어 있을 때 한글이 표시하는 문구 (Clickhere Direction 파라미터) */
  placeholder?: string
  /** begin~end 사이 현재 텍스트 — 빈 서식이면 "" (안내문은 값이 아니다) */
  value: string
  /** 0-based 섹션 번호 */
  section: number
}

/** 스캔된 누름틀 영역 — start/end는 값이 들어가는 사이 영역의 원본 XML 오프셋 */
interface ClickHereRegion {
  name: string
  placeholder?: string
  /** 값 영역 시작 (fieldBegin ctrl 닫힘 직후) */
  start: number
  /** 값 영역 끝 (fieldEnd ctrl 열림 직전) */
  end: number
  /** 태그 네임스페이스 접두사 (예: "hp:") — 삽입 요소도 같은 접두사 사용 */
  prefix: string
}

const FIELD_BEGIN_RE = /<([A-Za-z0-9_]+:)?fieldBegin\b([^>]*?)(\/?)>/g

function attrOf(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

/** Clickhere Command 파라미터에서 안내문 추출 — `Direction:wstring:<N>:` 뒤 N자(UTF-16) */
function extractPlaceholder(fieldBeginXml: string): string | undefined {
  const m = fieldBeginXml.match(/Direction:wstring:(\d+):/)
  if (!m) return undefined
  const start = (m.index ?? 0) + m[0].length
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 0 || n > 1000) return undefined
  return decodeXmlEntities(fieldBeginXml.slice(start, start + n))
}

/** 사이 영역의 표시 텍스트 — 태그 제거, lineBreak/br→\n, tab→\t */
function regionText(inner: string): string {
  return decodeXmlEntities(
    inner
      .replace(/<(?:[A-Za-z0-9_]+:)?(?:lineBreak|br)\b[^>]*\/?>/g, "\n")
      .replace(/<(?:[A-Za-z0-9_]+:)?tab\b[^>]*\/?>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
}

/**
 * 섹션 XML에서 CLICK_HERE 누름틀 영역을 문서 순서로 스캔.
 * 겹치는(중첩된) 영역은 뒤엣것을 버려 splice 충돌을 막는다.
 */
export function scanClickHereRegions(xml: string): ClickHereRegion[] {
  const regions: ClickHereRegion[] = []
  FIELD_BEGIN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let lastEnd = -1
  while ((m = FIELD_BEGIN_RE.exec(xml)) !== null) {
    const prefix = m[1] ?? ""
    const attrs = m[2]
    const selfClosed = m[3] === "/"
    if ((attrOf(attrs, "type") ?? "").toUpperCase() !== "CLICK_HERE") continue
    const name = attrOf(attrs, "name")
    if (name === undefined) continue
    const id = attrOf(attrs, "id")

    // fieldBegin 요소 끝 찾기 (파라미터 자식 포함)
    let beginElemEnd: number
    if (selfClosed) {
      beginElemEnd = FIELD_BEGIN_RE.lastIndex
    } else {
      const closeTag = `</${prefix}fieldBegin>`
      const ci = xml.indexOf(closeTag, FIELD_BEGIN_RE.lastIndex)
      if (ci < 0) continue
      beginElemEnd = ci + closeTag.length
    }
    const fieldBeginXml = xml.slice(m.index, beginElemEnd)

    // fieldBegin을 감싼 ctrl 닫힘 직후가 값 영역 시작 (ctrl 없는 비표준 배치도 허용)
    const ctrlClose = `</${prefix}ctrl>`
    let start = beginElemEnd
    let wrapped = false
    if (xml.startsWith(ctrlClose, beginElemEnd)) {
      start = beginElemEnd + ctrlClose.length
      wrapped = true
    }

    // 짝 fieldEnd 찾기 — id가 있으면 beginIDRef 일치 우선, 없으면 다음 fieldEnd
    const feRe = new RegExp(`<${prefix}fieldEnd\\b[^>]*>`, "g")
    feRe.lastIndex = start
    let end = -1
    let fe: RegExpExecArray | null
    while ((fe = feRe.exec(xml)) !== null) {
      const ref = attrOf(fe[0], "beginIDRef")
      if (id !== undefined && ref !== undefined && ref !== id) continue
      end = fe.index
      break
    }
    if (end < 0) continue

    // fieldEnd를 감싼 ctrl 열림까지 영역에 포함 (fieldBegin과 대칭)
    const ctrlOpen = `<${prefix}ctrl>`
    if (wrapped && xml.slice(end - ctrlOpen.length, end) === ctrlOpen) {
      end -= ctrlOpen.length
    }

    if (start > end) continue
    if (start < lastEnd) continue // 중첩/역전 — 앞선 영역 우선
    lastEnd = end
    regions.push({
      name: decodeXmlEntities(name),
      placeholder: extractPlaceholder(fieldBeginXml),
      start,
      end,
      prefix,
    })
  }
  return regions
}

/** 채울 값의 XML 조각 — \n은 문단 내 강제 줄바꿈(lineBreak)으로 (rhwp fill-fields 동일 계약) */
function valueXml(value: string, prefix: string): string {
  if (value === "") return ""
  const lines = value.split("\n").map(escapeXmlText)
  return `<${prefix}t>${lines.join(`<${prefix}lineBreak/>`)}</${prefix}t>`
}

/** fillClickHereInXml 결과 */
export interface ClickHereFillOutcome {
  /** 치환 적용된 XML — 변경 없으면 null */
  xml: string | null
  /** 채운 필드 기록 (filler-hwpx filled와 동일 형태) */
  filled: FormField[]
  /** 매칭된 정규화 키 — 이후 라벨 매칭에서 제외할 대상 */
  matchedKeys: Set<string>
}

/**
 * 섹션 XML의 누름틀을 값으로 채움 — 누름틀 name(정규화)과 정확히 일치하는 키만.
 * 접두사 매칭은 하지 않는다: 누름틀 이름은 서식 제작자가 정한 명시적 계약이라
 * 근사 매칭이 오히려 오폭이다.
 */
export function fillClickHereInXml(
  xml: string,
  cursor: ValueCursor,
  blockedLabels?: Set<string>,
): ClickHereFillOutcome {
  const filled: FormField[] = []
  const matchedKeys = new Set<string>()
  const splices: SpliceEdit[] = []

  for (const region of scanClickHereRegions(xml)) {
    const key = normalizeLabel(region.name)
    if (!key || blockedLabels?.has(key)) continue
    if (!cursor.has(key)) continue
    const value = cursor.consume(key)
    if (value === undefined) continue // 배열 값 소진 — 이후 등장은 채우지 않음

    const replacement = valueXml(value, region.prefix)
    const current = xml.slice(region.start, region.end)
    matchedKeys.add(key)
    filled.push({ label: region.name, value, row: -1, col: -1, key, source: "clickhere" })
    if (current === replacement) continue // 이미 같은 내용 — 바이트 보존
    splices.push({ start: region.start, end: region.end, replacement })
  }

  return {
    xml: splices.length > 0 ? applySplices(xml, splices) : null,
    filled,
    matchedKeys,
  }
}

/**
 * HWPX의 CLICK_HERE 누름틀 필드 목록 — 이름·안내문·현재값을 문서 순서로 반환.
 * 표준 서식(기안문 등)이 요구하는 필드를 채우기 전에 조사하는 용도.
 */
export async function extractClickHereFields(hwpxBuffer: ArrayBuffer): Promise<ClickHereField[]> {
  precheckZipSize(hwpxBuffer) // 파싱 경로와 같은 ZIP bomb 가드
  const zip = await JSZip.loadAsync(hwpxBuffer)
  const sectionPaths = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    .sort()
  const fields: ClickHereField[] = []
  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = await zip.file(sectionPaths[si])!.async("text")
    for (const r of scanClickHereRegions(xml)) {
      fields.push({
        name: r.name,
        ...(r.placeholder !== undefined ? { placeholder: r.placeholder } : {}),
        value: regionText(xml.slice(r.start, r.end)),
        section: si,
      })
    }
  }
  return fields
}
