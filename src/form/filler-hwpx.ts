/**
 * HWPX 원본 서식 유지 채우기 — ZIP 내 section XML 직접 수정
 *
 * IRBlock 중간 표현을 거치지 않고, 원본 HWPX ZIP의 section XML에서
 * 테이블 셀 텍스트(<hp:t>)만 교체하여 모든 스타일을 보존합니다.
 */

import JSZip from "jszip"
import { DOMParser, XMLSerializer } from "@xmldom/xmldom"
import { isLabelCell } from "../form/recognize.js"
import { KordocError, stripDtd } from "../utils.js"
import { normalizeLabel, findMatchingKey, normalizeValues, resolveUnmatched, isKeywordLabel, fillInCellPatterns } from "./match.js"
import type { FormField } from "../types.js"

/** 채우기 결과 */
export interface HwpxFillResult {
  /** 채워진 HWPX 바이너리 */
  buffer: ArrayBuffer
  /** 실제 채워진 필드 목록 */
  filled: FormField[]
  /** 매칭 실패한 라벨 */
  unmatched: string[]
}

/**
 * HWPX 원본을 직접 수정하여 서식 필드를 채움 — 스타일 100% 보존.
 *
 * @param hwpxBuffer 원본 HWPX 파일 버퍼
 * @param values 채울 값 맵 (라벨 → 값)
 * @returns HwpxFillResult
 */
export async function fillHwpx(
  hwpxBuffer: ArrayBuffer,
  values: Record<string, string>,
): Promise<HwpxFillResult> {
  const zip = await JSZip.loadAsync(hwpxBuffer)
  const filled: FormField[] = []
  const matchedLabels = new Set<string>()

  const normalizedValues = normalizeValues(values)

  // section XML 파일 찾기
  const sectionFiles = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    .sort()

  if (sectionFiles.length === 0) {
    throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")
  }

  const xmlParser = new DOMParser()
  const xmlSerializer = new XMLSerializer()

  for (const sectionPath of sectionFiles) {
    const zipEntry = zip.file(sectionPath)
    if (!zipEntry) continue  // null 방어

    const rawXml = await zipEntry.async("text")
    const doc = xmlParser.parseFromString(stripDtd(rawXml), "text/xml")
    if (!doc.documentElement) continue

    let modified = false

    // 모든 테이블 요소 탐색
    const tables = findAllElements(doc.documentElement as unknown as Node, "tbl")

    // 전략 0: 인셀 패턴 채우기 — 전략 1보다 먼저 실행
    // (체크박스 □→☑, 괄호 빈칸 (  )→(값), 어노테이션 (한자：)→(한자：값))
    // 이렇게 해야 전략 1이 셀을 덮어쓸 때 어노테이션이 보존됨
    const cellPatternApplied = new Set<Element>()
    for (const tblEl of tables) {
      const allCells = findAllElements(tblEl, "tc")
      for (const tcEl of allCells) {
        const tNodes = collectCellTextNodes(tcEl)
        const fullText = tNodes.map(n => n.text).join("")
        const result = fillInCellPatterns(fullText, normalizedValues, matchedLabels)
        if (!result) continue

        applyTextReplacements(tNodes, fullText, result.text)
        cellPatternApplied.add(tcEl)
        for (const m of result.matches) {
          filled.push({ label: m.label, value: m.value, row: -1, col: -1 })
        }
        modified = true
      }
    }

    for (const tblEl of tables) {
      const rows = findDirectChildren(tblEl, "tr")

      // 전략 1: 인접 라벨-값 셀 (label | value 패턴)
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const trEl = rows[rowIdx]
        const cells = findDirectChildren(trEl, "tc")

        for (let colIdx = 0; colIdx < cells.length - 1; colIdx++) {
          const labelText = extractCellText(cells[colIdx])
          if (!isLabelCell(labelText)) continue

          const valueCell = cells[colIdx + 1]
          const valueText = extractCellText(valueCell)
          if (isKeywordLabel(valueText)) continue

          const normalizedCellLabel = normalizeLabel(labelText)
          if (!normalizedCellLabel) continue

          const matchKey = findMatchingKey(normalizedCellLabel, normalizedValues)
          if (matchKey === undefined) continue

          const newValue = normalizedValues.get(matchKey)!

          // 전략 0이 이미 어노테이션을 채웠다면, 값을 앞에 삽입 (어노테이션 보존)
          if (cellPatternApplied.has(valueCell)) {
            prependCellText(valueCell, newValue)
          } else {
            replaceCellText(valueCell, newValue)
          }
          matchedLabels.add(matchKey)
          filled.push({
            label: labelText.trim().replace(/[:：]\s*$/, ""),
            value: newValue,
            row: rowIdx,
            col: colIdx,
          })
          modified = true
        }
      }

      // 전략 2: 헤더+데이터 행 패턴 (첫 행이 전부 라벨이면)
      if (rows.length >= 2) {
        const headerCells = findDirectChildren(rows[0], "tc")
        const allLabels = headerCells.every(cell => {
          const t = extractCellText(cell).trim()
          return t.length > 0 && t.length <= 20 && isLabelCell(t)
        })

        if (allLabels) {
          for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
            const dataCells = findDirectChildren(rows[rowIdx], "tc")
            for (let colIdx = 0; colIdx < Math.min(headerCells.length, dataCells.length); colIdx++) {
              const headerLabel = normalizeLabel(extractCellText(headerCells[colIdx]))
              const matchKey = findMatchingKey(headerLabel, normalizedValues)
              if (matchKey === undefined) continue
              if (matchedLabels.has(matchKey)) continue

              const newValue = normalizedValues.get(matchKey)!
              replaceCellText(dataCells[colIdx], newValue)
              matchedLabels.add(matchKey)
              filled.push({
                label: extractCellText(headerCells[colIdx]).trim(),
                value: newValue,
                row: rowIdx,
                col: colIdx,
              })
              modified = true
            }
          }
        }
      }
    }

    // 인라인 "라벨: 값" 패턴도 처리 (테이블 밖 paragraph)
    const allParagraphs = findAllElements(doc.documentElement as unknown as Node, "p")
    for (const pEl of allParagraphs) {
      if (isInsideTable(pEl)) continue

      // 모든 <hp:t> 텍스트를 위치 정보와 함께 수집
      const tNodes = collectTextNodes(pEl)
      const fullText = tNodes.map(n => n.text).join("")

      const pattern = /([가-힣A-Za-z]{2,10})\s*[:：]\s*([^\n,;]{0,100})/g
      let match
      while ((match = pattern.exec(fullText)) !== null) {
        const rawLabel = match[1]
        const normalized = normalizeLabel(rawLabel)
        const matchKey = findMatchingKey(normalized, normalizedValues)
        if (matchKey === undefined) continue

        const newValue = normalizedValues.get(matchKey)!
        // 값 부분의 시작/끝 오프셋 계산
        const valueStart = match.index + match[0].length - match[2].length
        const valueEnd = match.index + match[0].length

        replaceTextRange(tNodes, valueStart, valueEnd, newValue)
        matchedLabels.add(matchKey)
        filled.push({ label: rawLabel.trim(), value: newValue, row: -1, col: -1 })
        modified = true
        // 교체 후 패턴 인덱스 조정 (텍스트 길이 변경됨) — 다음 매칭 건너뜀
        break
      }
    }

    if (modified) {
      const newXml = xmlSerializer.serializeToString(doc)
      zip.file(sectionPath, newXml)
    }
  }

  const unmatched = resolveUnmatched(normalizedValues, matchedLabels, values)
  const buffer = await zip.generateAsync({ type: "arraybuffer" })
  return { buffer, filled, unmatched }
}

// ─── XML 탐색 헬퍼 ──────────────────────────────────

/** 로컬 태그명 추출 (네임스페이스 프리픽스 제거) */
function localName(el: Element): string {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
}

/** 문서 전체에서 특정 로컬 태그명의 요소를 재귀 탐색 */
function findAllElements(node: Node, tagLocalName: string): Element[] {
  const result: Element[] = []
  const walk = (n: Node) => {
    const children = n.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType !== 1) continue
      if (localName(child) === tagLocalName) result.push(child)
      walk(child)
    }
  }
  walk(node)
  return result
}

/** 직계 자식 중 특정 로컬 태그명 요소만 반환 */
function findDirectChildren(parent: Node, tagLocalName: string): Element[] {
  const result: Element[] = []
  const children = parent.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType === 1 && localName(child) === tagLocalName) {
      result.push(child)
    }
  }
  return result
}

/** 요소가 <tbl> 안에 있는지 확인 (부모 체인 탐색) */
function isInsideTable(el: Element): boolean {
  let parent = el.parentNode as Element | null
  while (parent) {
    if (parent.nodeType === 1 && localName(parent) === "tbl") return true
    parent = parent.parentNode as Element | null
  }
  return false
}

// ─── 셀 텍스트 추출/교체 ────────────────────────────

/** 셀(<hp:tc>) 내 모든 <hp:t> 텍스트를 합쳐 반환 */
function extractCellText(tcEl: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) {
        parts.push(child.textContent || "")
      } else if (child.nodeType === 1) {
        const tag = localName(child)
        // subList는 tc 아래 p를 감싸는 컨테이너 — 반드시 순회
        if (tag === "t") walk(child)
        else if (tag === "run" || tag === "r" || tag === "p" || tag === "subList") walk(child)
        else if (tag === "tab") parts.push("\t")
        else if (tag === "br") parts.push("\n")
      }
    }
  }
  walk(tcEl)
  return parts.join("")
}

/**
 * 셀(<hp:tc>)의 첫 번째 <hp:t> 앞에 텍스트를 삽입 — 어노테이션 보존.
 * 예: "(한자：金民秀)" → "김민수 (한자：金民秀)"
 */
function prependCellText(tcEl: Element, text: string): void {
  const tElements = findAllElements(tcEl, "t")
  if (tElements.length === 0) return

  const firstT = tElements[0]
  const existing = firstT.textContent || ""
  clearChildren(firstT)
  firstT.appendChild(firstT.ownerDocument!.createTextNode(text + " " + existing))
}

/**
 * 셀(<hp:tc>) 내 텍스트를 새 값으로 교체 — 스타일 보존 전략:
 *
 * 1) 첫 번째 <hp:run>의 <hp:t>에 새 텍스트 설정
 * 2) 나머지 <hp:run>의 <hp:t>는 빈 문자열로
 * 3) 두 번째 이후 <hp:p>는 내용만 비움 (요소 유지 — HWPX 뷰어 호환)
 *
 * 이렇게 하면 첫 번째 run의 charPrIDRef(글꼴, 크기, 굵기 등)가 보존됨
 */
function replaceCellText(tcEl: Element, newValue: string): void {
  const paragraphs = findAllElements(tcEl, "p")
  if (paragraphs.length === 0) return

  const firstP = paragraphs[0]
  const runs = findAllElements(firstP, "run").concat(findAllElements(firstP, "r"))

  if (runs.length > 0) {
    setRunText(runs[0], newValue)
    for (let i = 1; i < runs.length; i++) {
      setRunText(runs[i], "")
    }
  } else {
    const tElements = findAllElements(firstP, "t")
    if (tElements.length > 0) {
      clearChildren(tElements[0])
      tElements[0].appendChild(tElements[0].ownerDocument!.createTextNode(newValue))
      for (let i = 1; i < tElements.length; i++) {
        clearChildren(tElements[i])
      }
    }
  }

  // 두 번째 이후 paragraph — 내용만 비움
  for (let i = 1; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    if (p.parentNode) {
      const pRuns = findAllElements(p, "run").concat(findAllElements(p, "r"))
      for (const run of pRuns) setRunText(run, "")
      const pTs = findAllElements(p, "t")
      for (const t of pTs) clearChildren(t)
    }
  }
}

/** <hp:run> 요소의 <hp:t> 텍스트를 교체 */
function setRunText(runEl: Element, text: string): void {
  const tElements = findAllElements(runEl, "t")
  if (tElements.length > 0) {
    clearChildren(tElements[0])
    tElements[0].appendChild(tElements[0].ownerDocument!.createTextNode(text))
    for (let i = 1; i < tElements.length; i++) {
      clearChildren(tElements[i])
    }
    return
  }

  // <hp:t>가 없는 빈 run — 한컴오피스가 HWP→HWPX 변환 시 빈 셀의 run을
  // self-closing(<hp:run charPrIDRef="..."/>)으로 만들면서 <hp:t>를 생략한다.
  // 이 경우 부모 run의 prefix/namespace를 따라 새로 생성해 추가한다.
  // 빈 문자열이면 굳이 노드를 만들지 않는다(다른 호출부에서 run을 비울 때 사용).
  if (!text) return

  const doc = runEl.ownerDocument!
  const ns = runEl.namespaceURI
  const qualifiedName = runEl.prefix ? `${runEl.prefix}:t` : "t"
  const tEl = ns
    ? doc.createElementNS(ns, qualifiedName)
    : doc.createElement(qualifiedName)
  tEl.appendChild(doc.createTextNode(text))
  runEl.appendChild(tEl)
}

/** 요소의 모든 자식 노드 제거 */
function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

// ─── 인라인 텍스트 교체 (분리된 <hp:t> 대응) ─────────

/** <hp:t> 텍스트 노드와 글로벌 오프셋 정보 */
interface TextNodeInfo {
  /** <hp:t> 요소 */
  element: Element
  /** 이 요소의 텍스트 */
  text: string
  /** 전체 합산 텍스트에서의 시작 오프셋 */
  offset: number
}

/** paragraph 내 모든 <hp:t> 텍스트 노드를 오프셋과 함께 수집 */
function collectTextNodes(pEl: Element): TextNodeInfo[] {
  const tElements = findAllElements(pEl, "t")
  const result: TextNodeInfo[] = []
  let offset = 0
  for (const t of tElements) {
    const text = t.textContent || ""
    result.push({ element: t, text, offset })
    offset += text.length
  }
  return result
}

/**
 * 여러 <hp:t>에 걸친 텍스트 범위를 새 값으로 교체.
 * 첫 번째 걸리는 <hp:t>에 교체 텍스트를 넣고, 나머지는 해당 범위만큼 잘라냄.
 */
function replaceTextRange(
  tNodes: TextNodeInfo[],
  globalStart: number,
  globalEnd: number,
  newValue: string,
): void {
  let replaced = false
  for (const node of tNodes) {
    const nodeStart = node.offset
    const nodeEnd = node.offset + node.text.length

    if (nodeEnd <= globalStart || nodeStart >= globalEnd) continue

    const localStart = Math.max(0, globalStart - nodeStart)
    const localEnd = Math.min(node.text.length, globalEnd - nodeStart)

    if (!replaced) {
      const before = node.text.slice(0, localStart)
      const after = node.text.slice(localEnd)
      const newText = before + newValue + after
      clearChildren(node.element)
      node.element.appendChild(node.element.ownerDocument!.createTextNode(newText))
      replaced = true
    } else {
      const before = node.text.slice(0, localStart)
      const after = node.text.slice(localEnd)
      const newText = before + after
      clearChildren(node.element)
      node.element.appendChild(node.element.ownerDocument!.createTextNode(newText))
    }
  }
}

// ─── 인셀 패턴 교체 (체크박스/괄호 빈칸) ─────────

/** 셀(<hp:tc>) 내 모든 <hp:t> 텍스트 노드를 오프셋과 함께 수집 (subList 순회 포함) */
function collectCellTextNodes(tcEl: Element): TextNodeInfo[] {
  const tElements = findAllElements(tcEl, "t")
  const result: TextNodeInfo[] = []
  let offset = 0
  for (const t of tElements) {
    const text = t.textContent || ""
    result.push({ element: t, text, offset })
    offset += text.length
  }
  return result
}

/**
 * 셀 내 <hp:t> 노드들의 텍스트를 원본→교체 결과에 맞춰 반영.
 * 각 노드가 원본 텍스트에서 차지하는 범위를 추적하고,
 * 교체된 텍스트에서 같은 비율의 영역을 할당.
 */
function applyTextReplacements(
  tNodes: TextNodeInfo[],
  originalFull: string,
  replacedFull: string,
): void {
  if (originalFull === replacedFull) return

  // 단일 <hp:t> 노드면 간단히 전체 교체
  if (tNodes.length === 1) {
    clearChildren(tNodes[0].element)
    tNodes[0].element.appendChild(
      tNodes[0].element.ownerDocument!.createTextNode(replacedFull),
    )
    return
  }

  // 여러 노드: diff를 노드 경계에 맞춰 적용
  // 변경된 부분의 시작 오프셋을 찾아서 해당 노드만 교체
  let diffStart = 0
  while (diffStart < originalFull.length && diffStart < replacedFull.length &&
         originalFull[diffStart] === replacedFull[diffStart]) {
    diffStart++
  }
  let diffEndOrig = originalFull.length
  let diffEndRepl = replacedFull.length
  while (diffEndOrig > diffStart && diffEndRepl > diffStart &&
         originalFull[diffEndOrig - 1] === replacedFull[diffEndRepl - 1]) {
    diffEndOrig--
    diffEndRepl--
  }

  // 변경된 범위를 포함하는 노드에 교체 적용
  const newPart = replacedFull.slice(diffStart, diffEndRepl)
  replaceTextRange(tNodes, diffStart, diffEndOrig, newPart)
}
