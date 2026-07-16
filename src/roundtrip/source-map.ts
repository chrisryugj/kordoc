/**
 * HWPX 라운드트립 소스맵 — section XML 문자열에서 문단/표 셀의 문자 범위를 추적.
 *
 * DOM 재직렬화를 거치지 않고(속성 순서·공백·자기닫힘 표기까지 보존하기 위해)
 * 정규식 토크나이저로 태그를 순회하며, 각 <hp:p>가 소유한 <hp:t> 콘텐츠 범위를
 * 기록한다. 패치는 이 범위에 대한 문자열 splice로만 수행되어
 * 변경 문단 외 XML 바이트가 그대로 보존된다 (filler-hwpx.ts 패턴의 오프셋 버전).
 */

// ─── 타입 ───────────────────────────────────────────

/** <hp:t> 콘텐츠 범위 — [contentStart, contentEnd) 가 여는/닫는 태그 사이 */
export interface TRange {
  contentStart: number
  contentEnd: number
  /** 자기닫힘 <hp:t/> — 범위가 태그 전체이며, 치환 시 태그째 교체 */
  selfClosing?: boolean
  /** 자기닫힘 치환용 네임스페이스 프리픽스 (예: "hp") */
  prefix?: string
}

export type ScanParaKind = "body" | "cell" | "draw" | "excluded"

/** 스캔된 문단 — 소유한 hp:t 범위와 합산 텍스트 */
export interface ScanParagraph {
  sectionIndex: number
  kind: ScanParaKind
  /** <hp:p ...> 여는 태그 시작 위치 (문서 순서 정렬용) */
  start: number
  /** 소유 hp:t 콘텐츠 범위 (문서 순서) */
  tRanges: TRange[]
  /** hp:t 텍스트 합산 (엔티티 디코딩, 내부 태그는 공백화) */
  text: string
  /** hp:t가 하나도 없을 때 텍스트 삽입 가능한 위치 (첫 run 닫는 태그 앞) */
  runInsertPos?: number
  /** runInsertPos에 삽입할 때 쓸 t 태그 prefix (예: "hp") */
  runPrefix?: string
  /** 자기닫힘 <hp:run/> 태그 범위 — t 삽입 시 펼쳐서 사용 (한컴 빈 문단 패턴) */
  selfCloseRun?: { start: number; end: number }
  /** 글상자(drawText) 경유 문단 — 셀 라벨 판정 등에서 본문과 구분 (v3.1) */
  inTextbox?: boolean
}

/** 스캔된 표 셀 — 앵커 좌표와 셀 내부 문단 */
export interface ScanCell {
  rowAddr?: number
  colAddr?: number
  colSpan: number
  rowSpan: number
  paragraphs: ScanParagraph[]
  /** 셀 내부 중첩표 (문서 순서) */
  tables: ScanTable[]
  /** <hp:cellAddr> 태그 범위 (자기닫힘=태그 전체, 펼친형=여는 태그) — rowAddr 재작성용 */
  addrTagRange?: { start: number; end: number }
}

/** 스캔된 표 */
export interface ScanTable {
  sectionIndex: number
  start: number
  /** 최상위 표 여부 (다른 표/ctrl/캡션 내부가 아님) */
  topLevel: boolean
  /** 비어있지 않은 행들 (tr 순서) */
  rows: ScanCell[][]
  /** rows[i]의 <hp:tr>...</hp:tr> XML 범위 (행 추가/삭제 splice용, rows와 정렬) */
  rowRanges: { start: number; end: number }[]
  /** 앵커 좌표 → 셀 ("r,c") */
  cellByAnchor: Map<string, ScanCell>
}

/** 섹션 하나의 스캔 결과 */
export interface SectionScan {
  sectionIndex: number
  xml: string
  /** body + draw 문단 (문서 순서) — 본문 텍스트 매핑 대상 */
  bodyParagraphs: ScanParagraph[]
  /** 최상위 표 (문서 순서) */
  tables: ScanTable[]
  /** 머리말/꼬리말 문단 텍스트 (OB 앞/뒤 배치 블록 식별용) */
  headerTexts: string[]
  footerTexts: string[]
  /**
   * 파서 비가시 영역(머리말/꼬리말/각주/캡션/메모 등 ctrl 내부) 문단 — v3.1.
   * patcher 매핑 대상이 아니며, filler가 이 영역의 인라인 패턴을 채울 때 사용.
   */
  excludedParagraphs: ScanParagraph[]
  /**
   * 어느 셀에도 속하지 않는 비최상위 표(머리말/꼬리말 등 ctrl 내부) — v3.1.
   * filler 전용. patcher의 표 서수 매핑(tables)에는 포함되지 않는다.
   */
  orphanTables: ScanTable[]
}

/** 문자열 splice 편집 — [start, end) 를 replacement로 치환 */
export interface SpliceEdit {
  start: number
  end: number
  replacement: string
}

// ─── XML 텍스트 유틸 ─────────────────────────────────

/** XML 텍스트 노드 이스케이프 (속성 아님 — & < > 만).
 *  XML 1.0 불법 C0 제어문자는 제거한다(\t \n \r 보존) — 문서를 못 여는 손상 방지 */
export function escapeXmlText(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** XML 엔티티 디코딩 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g, (m, ent: string) => {
    switch (ent) {
      case "lt": return "<"
      case "gt": return ">"
      case "amp": return "&"
      case "quot": return '"'
      case "apos": return "'"
    }
    try {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10)
      if (!isNaN(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code)
    } catch { /* 잘못된 참조는 원본 유지 */ }
    return m
  })
}

/** hp:t 콘텐츠에서 텍스트 추출 — 파서가 공백류로 취급하는 태그(tab/fwSpace/hwSpace/
 *  br/lineBreak)만 공백, 나머지 태그(markpen 등 파서가 무시)는 제거 (파서 모델 정합) */
function tContentToText(raw: string): string {
  return decodeXmlEntities(
    raw
      .replace(/<\/?(?:[A-Za-z0-9_]+:)?(?:tab|fwSpace|hwSpace|br|lineBreak)(?:\s[^>]*)?\/?>/g, " ")
      .replace(/<[^>]*>/g, ""),
  )
}

// ─── 토크나이저 ──────────────────────────────────────

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?:"[^"]*"|'[^']*'|[^>"'])*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

/** hp:t 소유권을 끊는 컨테이너 — 이 안의 t는 호스트 문단 텍스트가 아님 */
const T_BARRIER = new Set([
  "tbl", "ctrl", "caption", "pic", "shape", "drawingObject", "drawText",
  "shapeComment", "memogroup", "memo", "hiddenComment", "equation",
  "parameters", "subList", "p",
])

/** 문단 분류용 컨테이너 (가장 가까운 것 기준) */
const PARA_CONTAINER = new Set([
  "tc", "ctrl", "caption", "drawText", "pic", "shape", "drawingObject",
  "memogroup", "memo", "hiddenComment",
  "footNote", "endNote", "fn", "en", // 각주/미주 — 파서는 호스트 블록 footnoteText로만 흡수
])

/** 표 분류 시 "최상위"가 아니게 만드는 조상 */
const TABLE_BARRIER = new Set([
  "tbl", "ctrl", "caption", "memogroup", "memo", "hiddenComment",
])

function localOf(qname: string): string {
  const i = qname.indexOf(":")
  return i >= 0 ? qname.slice(i + 1) : qname
}

function prefixOf(qname: string): string {
  const i = qname.indexOf(":")
  return i >= 0 ? qname.slice(0, i) : ""
}

interface StackFrame {
  local: string
  qname: string
  /** 여는 태그가 끝나는 위치 (콘텐츠 시작) */
  contentStart: number
}

interface OpenCtrlSub { kind: "header" | "footer"; texts: string[] }

/**
 * section XML 한 개를 스캔하여 소스맵을 만든다.
 * 토크나이저는 xmldom과 무관하게 동작하며, 위치(오프셋) 정보가 핵심이다.
 */
export function scanSectionXml(xml: string, sectionIndex: number): SectionScan {
  const stack: StackFrame[] = []
  const bodyParagraphs: ScanParagraph[] = []
  const tables: ScanTable[] = []
  const headerTexts: string[] = []
  const footerTexts: string[] = []
  const excludedParagraphs: ScanParagraph[] = []
  const orphanTables: ScanTable[] = []

  // 진행 상태
  const paraStack: ScanParagraph[] = []
  const tableStack: ScanTable[] = []
  const rowStack: ScanCell[][] = []     // 테이블별 currentRow
  const trStartStack: number[] = []     // 테이블별 진행 중 <hp:tr> 시작 위치 (-1 = 없음)
  const cellStack: ScanCell[] = []
  let pendingT: { para: ScanParagraph; contentStart: number } | null = null
  const ctrlSubStack: OpenCtrlSub[] = []

  /** 스택 위에서 아래로 보며 가장 가까운 PARA_CONTAINER/장벽 판별.
   *  drawText는 투과 — 바깥에 tc가 있으면(셀 안 글상자) 파서의 mergeBlocksIntoCell과
   *  동일하게 cell로 귀속, 아니면 draw(본문 글상자). */
  const classifyPara = (): { kind: ScanParaKind; inTextbox: boolean } => {
    let sawDrawText = false
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i].local
      if (l === "tc") return { kind: "cell", inTextbox: sawDrawText }
      if (l === "drawText") { sawDrawText = true; continue }
      if (PARA_CONTAINER.has(l)) return { kind: "excluded", inTextbox: sawDrawText }
    }
    return sawDrawText ? { kind: "draw", inTextbox: true } : { kind: "body", inTextbox: false }
  }

  /** 현재 위치의 t/tab 등이 최상위 열린 문단 소유인지 (사이에 장벽 없음) */
  const owningPara = (): ScanParagraph | null => {
    if (paraStack.length === 0) return null
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i].local
      if (l === "p") return paraStack[paraStack.length - 1]
      if (T_BARRIER.has(l)) return null
    }
    return null
  }

  const isTableTopLevel = (): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (TABLE_BARRIER.has(stack[i].local)) return false
    }
    return true
  }

  /** ctrl 내부 header/footer 수집 컨텍스트 */
  const currentCtrlSub = (): OpenCtrlSub | null =>
    ctrlSubStack.length > 0 ? ctrlSubStack[ctrlSubStack.length - 1] : null

  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [full, closeName, openName, , selfClose] = m

    // 주석/CDATA/PI/DOCTYPE
    if (closeName === undefined && openName === undefined) continue

    if (closeName !== undefined) {
      // ── 닫는 태그 ──
      const local = localOf(closeName)

      // 진행 중인 hp:t 닫힘
      if (local === "t" && pendingT) {
        const { para, contentStart } = pendingT
        para.tRanges.push({ contentStart, contentEnd: m.index })
        para.text += tContentToText(xml.slice(contentStart, m.index))
        pendingT = null
      }

      // 스택 pop (불일치 태그 관용 처리 — 일치하는 프레임까지 pop)
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].local === local) {
          stack.length = i
          break
        }
      }

      if (local === "p") {
        const para = paraStack.pop()
        if (para && para.kind === "excluded") {
          const sub = currentCtrlSub()
          if (sub && para.text.trim()) sub.texts.push(para.text)
        }
      } else if (local === "tc") {
        const cell = cellStack.pop()
        const row = rowStack[rowStack.length - 1]
        if (cell && row) row.push(cell)
      } else if (local === "tr") {
        const row = rowStack[rowStack.length - 1]
        const table = tableStack[tableStack.length - 1]
        if (row && table && row.length > 0) {
          table.rows.push(row)
          const trStart = trStartStack[trStartStack.length - 1]
          if (trStart >= 0) table.rowRanges.push({ start: trStart, end: m.index + full.length })
        }
        if (rowStack.length > 0) rowStack[rowStack.length - 1] = []
        if (trStartStack.length > 0) trStartStack[trStartStack.length - 1] = -1
      } else if (local === "tbl") {
        const table = tableStack.pop()
        rowStack.pop()
        trStartStack.pop()
        if (table) {
          finalizeTable(table)
          // 중첩표는 둘러싼 셀에 부착 (재귀 패치용), 셀이 없으면(머리말 등
          // ctrl 내부) orphanTables로 — filler가 채우기 대상에 포함 (v3.1)
          if (!table.topLevel) {
            const cell = cellStack[cellStack.length - 1]
            if (cell) cell.tables.push(table)
            else orphanTables.push(table)
          }
        }
      } else if (local === "header" || local === "footer") {
        const sub = ctrlSubStack[ctrlSubStack.length - 1]
        if (sub) {
          ctrlSubStack.pop()
          // 파서(collectSubListText)는 문단들을 "\n"으로 합쳐 한 블록으로 만든다
          const joined = sub.texts.join("\n").trim()
          if (joined) (sub.kind === "header" ? headerTexts : footerTexts).push(joined)
        }
      }
      continue
    }

    // ── 여는 태그 ──
    const qname = openName!
    const local = localOf(qname)
    const attrsRaw = m[3] || ""
    const isSelfClose = selfClose === "/"
    const contentStart = m.index + full.length

    if (isSelfClose) {
      // 자기닫힘 요소 처리
      if (local === "t") {
        const para = owningPara()
        if (para) para.tRanges.push({ contentStart: m.index, contentEnd: m.index + full.length, selfClosing: true, prefix: prefixOf(qname) })
      } else if (local === "tab" || local === "fwSpace" || local === "hwSpace" || local === "br" || local === "lineBreak") {
        // pendingT 내부면 t 콘텐츠 추출이 공백 처리하므로 중복 방지
        if (!pendingT) {
          const para = owningPara()
          if (para) para.text += " "
        }
      } else if (local === "run" || local === "r") {
        // 한컴 빈 문단 패턴: <hp:run charPrIDRef="..."/> — t 삽입 시 펼칠 수 있도록 기록
        const para = owningPara()
        if (para && !para.selfCloseRun) para.selfCloseRun = { start: m.index, end: m.index + full.length }
      } else if (local === "cellAddr") {
        const cell = cellStack[cellStack.length - 1]
        if (cell && insideCurrentTable(stack, tableStack)) {
          const ca = parseInt(getAttr(attrsRaw, "colAddr") || "", 10)
          const ra = parseInt(getAttr(attrsRaw, "rowAddr") || "", 10)
          if (!isNaN(ca)) cell.colAddr = ca
          if (!isNaN(ra)) cell.rowAddr = ra
          cell.addrTagRange = { start: m.index, end: m.index + full.length }
        }
      } else if (local === "cellSpan") {
        const cell = cellStack[cellStack.length - 1]
        if (cell && insideCurrentTable(stack, tableStack)) {
          const cs = parseInt(getAttr(attrsRaw, "colSpan") || "1", 10)
          const rs = parseInt(getAttr(attrsRaw, "rowSpan") || "1", 10)
          cell.colSpan = isNaN(cs) || cs < 1 ? 1 : cs
          cell.rowSpan = isNaN(rs) || rs < 1 ? 1 : rs
        }
      }
      continue
    }

    // 일반 여는 태그 — 스택 push 전 처리
    if (local === "t") {
      const para = owningPara()
      if (para) pendingT = { para, contentStart }
      stack.push({ local, qname, contentStart })
      continue
    }

    stack.push({ local, qname, contentStart })

    if (local === "p") {
      const para: ScanParagraph = {
        sectionIndex,
        kind: "excluded", // 분류는 push 직후 스택 기준 (자기 자신 제외)
        start: m.index,
        tRanges: [],
        text: "",
      }
      // 자기 자신(p)을 제외하고 분류
      stack.pop()
      const cls = classifyPara()
      para.kind = cls.kind
      if (cls.inTextbox) para.inTextbox = true
      stack.push({ local, qname, contentStart })
      paraStack.push(para)
      if (para.kind === "body" || para.kind === "draw") bodyParagraphs.push(para)
      else if (para.kind === "cell") {
        const cell = cellStack[cellStack.length - 1]
        if (cell) cell.paragraphs.push(para)
      } else if (para.kind === "excluded") {
        excludedParagraphs.push(para)
      }
    } else if (local === "run" || local === "r") {
      // hp:t가 없는 문단의 삽입 지점 후보 — 첫 run의 닫는 태그 위치는 닫힐 때 알 수 있으므로
      // 여기서는 prefix만 기억해두고, 닫는 태그에서 채움 (아래 참조)
      const para = owningPara()
      if (para && para.runPrefix === undefined) para.runPrefix = prefixOf(qname)
    } else if (local === "tbl") {
      const table: ScanTable = {
        sectionIndex,
        start: m.index,
        topLevel: false,
        rows: [],
        rowRanges: [],
        cellByAnchor: new Map(),
      }
      // 자기 자신 제외하고 판별
      stack.pop()
      table.topLevel = isTableTopLevel()
      stack.push({ local, qname, contentStart })
      tableStack.push(table)
      rowStack.push([])
      trStartStack.push(-1)
      if (table.topLevel) tables.push(table)
    } else if (local === "tr") {
      if (rowStack.length > 0) rowStack[rowStack.length - 1] = []
      if (trStartStack.length > 0) trStartStack[trStartStack.length - 1] = m.index
    } else if (local === "tc") {
      cellStack.push({ colSpan: 1, rowSpan: 1, paragraphs: [], tables: [] })
    } else if (local === "cellAddr" || local === "cellSpan") {
      // 자기닫힘이 일반적이지만 펼친 형태(<hp:cellAddr ...></hp:cellAddr>)도 동일 처리
      const cell = cellStack[cellStack.length - 1]
      if (cell && insideCurrentTable(stack, tableStack)) {
        if (local === "cellAddr") {
          const ca = parseInt(getAttr(attrsRaw, "colAddr") || "", 10)
          const ra = parseInt(getAttr(attrsRaw, "rowAddr") || "", 10)
          if (!isNaN(ca)) cell.colAddr = ca
          if (!isNaN(ra)) cell.rowAddr = ra
          cell.addrTagRange = { start: m.index, end: contentStart }
        } else {
          const cs = parseInt(getAttr(attrsRaw, "colSpan") || "1", 10)
          const rs = parseInt(getAttr(attrsRaw, "rowSpan") || "1", 10)
          cell.colSpan = isNaN(cs) || cs < 1 ? 1 : cs
          cell.rowSpan = isNaN(rs) || rs < 1 ? 1 : rs
        }
      }
    } else if (local === "header" || local === "footer") {
      // ctrl 내부의 머리말/꼬리말만 수집
      if (stack.some(f => f.local === "ctrl")) {
        ctrlSubStack.push({ kind: local, texts: [] })
      }
    } else if (local === "tab" || local === "fwSpace" || local === "hwSpace" || local === "br" || local === "lineBreak") {
      const para = owningPara()
      if (para) para.text += " "
    }
  }

  // run 삽입 지점 보강: t가 없는 body/cell 문단에 대해 첫 run의 닫는 태그 위치 탐색
  for (const para of bodyParagraphs) fillRunInsertPos(para, xml)
  for (const para of excludedParagraphs) fillRunInsertPos(para, xml)
  const fillTableInsertPos = (table: ScanTable, depth = 0): void => {
    if (depth > 16) return
    for (const row of table.rows) {
      for (const cell of row) {
        for (const para of cell.paragraphs) fillRunInsertPos(para, xml)
        for (const nested of cell.tables) fillTableInsertPos(nested, depth + 1)
      }
    }
  }
  for (const table of tables) fillTableInsertPos(table)
  for (const table of orphanTables) fillTableInsertPos(table)

  return { sectionIndex, xml, bodyParagraphs, tables, headerTexts, footerTexts, excludedParagraphs, orphanTables }
}

/** 속성 문자열에서 값 추출 */
function getAttr(attrsRaw: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  const m = attrsRaw.match(re)
  return m ? (m[1] ?? m[2]) : undefined
}

/** 문단 스택 컨텍스트가 현재 테이블 셀 직속인지 — cellAddr/cellSpan 소유 확인 */
function insideCurrentTable(stack: StackFrame[], tableStack: ScanTable[]): boolean {
  if (tableStack.length === 0) return false
  for (let i = stack.length - 1; i >= 0; i--) {
    const l = stack[i].local
    if (l === "tc") return true
    if (l === "tbl") return false
  }
  return false
}

/** hp:t 없는 문단의 삽입 위치 — 첫 <hp:run ...>...</hp:run>의 닫는 태그 직전 */
function fillRunInsertPos(para: ScanParagraph, xml: string): void {
  if (para.tRanges.length > 0) return
  // 문단 범위 내 첫 run 탐색 (문단 닫는 태그까지 — 간단히 다음 </hp:p>까지로 한정)
  const pEnd = findElementEnd(xml, para.start)
  if (pEnd < 0) return
  const slice = xml.slice(para.start, pEnd)
  const runOpen = slice.match(/<((?:[A-Za-z0-9_]+:)?run)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*?)?(\/?)>/)
  if (!runOpen || runOpen.index === undefined) return
  if (runOpen[2] === "/") return // 자기닫힘 run — v1 미지원
  const qname = runOpen[1]
  const closeIdx = slice.indexOf(`</${qname}>`, runOpen.index)
  if (closeIdx < 0) return
  para.runInsertPos = para.start + closeIdx
  para.runPrefix = prefixOf(qname)
}

/** start 위치의 여는 태그에 대응하는 닫는 태그 뒤 위치 (동일 로컬명 중첩 추적) */
export function findElementEnd(xml: string, start: number): number {
  const open = xml.slice(start).match(/^<([^\s/>!?]+)/)
  if (!open) return -1
  const qname = open[1]
  const re = new RegExp(`<${qname}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*?(/?)>|</${qname}\\s*>`, "g")
  re.lastIndex = start
  let depth = 0
  let mm: RegExpExecArray | null
  while ((mm = re.exec(xml)) !== null) {
    if (mm[0].startsWith("</")) {
      depth--
      if (depth === 0) return mm.index + mm[0].length
    } else if (mm[1] !== "/") {
      depth++
    }
  }
  return -1
}

/** 표 마무리 — 앵커 좌표 맵 구축 (cellAddr 없으면 first-fit, builder.ts buildTable과 동일 규칙) */
function finalizeTable(table: ScanTable): void {
  const hasAddr = table.rows.some(row => row.some(c => c.colAddr !== undefined && c.rowAddr !== undefined))
  if (hasAddr) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (cell.rowAddr !== undefined && cell.colAddr !== undefined) {
          table.cellByAnchor.set(`${cell.rowAddr},${cell.colAddr}`, cell)
        }
      }
    }
    return
  }
  // first-fit 배치 (builder.ts buildTable Pass1/2와 동일한 점유 규칙)
  const numRows = table.rows.length
  const occupied: boolean[][] = Array.from({ length: numRows }, () => [])
  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    for (const cell of table.rows[rowIdx]) {
      while (occupied[rowIdx][colIdx]) colIdx++
      cell.rowAddr = rowIdx
      cell.colAddr = colIdx
      table.cellByAnchor.set(`${rowIdx},${colIdx}`, cell)
      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < colIdx + cell.colSpan; c++) {
          occupied[r][c] = true
        }
      }
      colIdx += cell.colSpan
    }
  }
}

// ─── 치환 ────────────────────────────────────────────

/**
 * 문단 텍스트 치환용 splice 생성 — filler-hwpx.ts replaceCellText와 동일 전략:
 * 첫 hp:t에 새 텍스트(이스케이프), 나머지 hp:t는 비움. run 구조/charPr 보존.
 * t가 없으면 첫 run 끝에 <hp:t> 삽입. 실패 시 null.
 *
 * IR 텍스트는 sanitize로 양끝 공백이 제거된 상태라, 통째 교체 시 원본의
 * 선행 공백(들여쓰기)/후행 공백이 소실된다 — 원본 t-도메인 텍스트에서
 * 양끝 공백을 복원해 새 텍스트에 입힌다 (재파싱 IR은 동일하게 유지됨).
 */
export function buildParagraphSplices(para: ScanParagraph, newText: string, xml?: string): SpliceEdit[] | null {
  if (newText && xml) {
    const orig = paraTText(para, xml)
    if (orig && orig.trim() !== "") {
      const lead = orig.match(/^\s*/)![0]
      const trail = orig.match(/\s*$/)![0]
      if ((lead || trail) && newText.trim() !== "") {
        newText = lead + newText.replace(/^\s+|\s+$/g, "") + trail
      }
    }
  }
  const escaped = escapeXmlText(newText)
  if (para.tRanges.length > 0) {
    const splices: SpliceEdit[] = []
    const first = para.tRanges[0]
    if (first.selfClosing) {
      // 자기닫힘 <hp:t/> — 태그째 <hp:t>텍스트</hp:t>로 교체
      const prefix = first.prefix ? first.prefix + ":" : ""
      splices.push({ start: first.contentStart, end: first.contentEnd, replacement: `<${prefix}t>${escaped}</${prefix}t>` })
    } else {
      splices.push({ start: first.contentStart, end: first.contentEnd, replacement: escaped })
    }
    // 나머지 hp:t 비우기 (자기닫힘은 이미 빈 상태)
    for (let i = 1; i < para.tRanges.length; i++) {
      const r = para.tRanges[i]
      if (!r.selfClosing && r.contentStart < r.contentEnd) {
        splices.push({ start: r.contentStart, end: r.contentEnd, replacement: "" })
      }
    }
    return splices
  }
  // hp:t 없음 — 첫 run 끝에 삽입
  if (para.runInsertPos !== undefined) {
    if (!newText) return [] // 비우기인데 t도 없음 — 이미 빈 문단
    const prefix = para.runPrefix ? para.runPrefix + ":" : ""
    return [{ start: para.runInsertPos, end: para.runInsertPos, replacement: `<${prefix}t>${escaped}</${prefix}t>` }]
  }
  // 자기닫힘 <hp:run/> — 태그를 펼쳐서 t 삽입 (한컴 빈 문단 패턴, xml 필요)
  if (para.selfCloseRun && xml) {
    if (!newText) return []
    const { start, end } = para.selfCloseRun
    const tag = xml.slice(start, end)
    const qm = tag.match(/^<([^\s/>]+)/)
    if (!qm || !tag.endsWith("/>")) return null
    const qname = qm[1]
    const colon = qname.indexOf(":")
    const prefix = colon >= 0 ? qname.slice(0, colon) + ":" : ""
    const opened = tag.slice(0, tag.length - 2).trimEnd() + ">"
    return [{ start, end, replacement: `${opened}<${prefix}t>${escaped}</${prefix}t></${qname}>` }]
  }
  return newText ? null : []
}

/**
 * 문단의 t-도메인 텍스트 — hp:t 콘텐츠만 이어붙인 문자열 (v3.1).
 *
 * para.text와 달리 tab/br 등 비-t 요소의 공백 기여가 없어, 그 사이에 끼인
 * 요소를 건드리지 않는 정밀 치환(buildRangeSplices)의 좌표계로 쓴다.
 * hp:t 콘텐츠에 엔티티/내부 태그([<&])가 있으면 좌표가 어긋나므로 null.
 */
export function paraTText(para: ScanParagraph, xml: string): string | null {
  let text = ""
  for (const t of para.tRanges) {
    if (t.selfClosing) continue
    const raw = xml.slice(t.contentStart, t.contentEnd)
    if (/[<&]/.test(raw)) return null
    text += raw
  }
  return text
}

/** 문단 텍스트가 전부 hp:t에서 왔는지 — tab/br 등 비-t 기여가 있으면 false.
 *  false면 문단 전체 재작성 시 비-t 요소와 텍스트가 중복/순서 역전되므로 금지. */
export function paraTextPureT(para: ScanParagraph, xml: string): boolean {
  let len = 0
  for (const t of para.tRanges) {
    if (t.selfClosing) continue
    len += tContentToText(xml.slice(t.contentStart, t.contentEnd)).length
  }
  return len === para.text.length
}

/**
 * t-도메인 텍스트(paraTText 좌표계)의 [start, end) 범위만 치환하는 정밀 splice
 * — run/탭 구조 보존 (v3.1).
 *
 * 좌표계가 t-도메인이므로 tab/br이 사이에 끼어 있어도 동작한다 (해당 요소는
 * 건드리지 않고 t 콘텐츠만 수술). hp:t 콘텐츠에 엔티티/내부 태그가 있으면
 * 오프셋 정합이 깨지므로 null을 반환한다 (호출자가 폴백 결정).
 */
export function buildRangeSplices(
  para: ScanParagraph, xml: string, start: number, end: number, replacement: string,
): SpliceEdit[] | null {
  if (start < 0 || end < start) return null

  // t 세그먼트 ↔ t-도메인 오프셋 정렬 — 디코딩 불변 검증
  interface Seg { contentStart: number; from: number; to: number }
  const segs: Seg[] = []
  let offset = 0
  for (const t of para.tRanges) {
    if (t.selfClosing) continue // 텍스트 기여 없음
    const raw = xml.slice(t.contentStart, t.contentEnd)
    if (/[<&]/.test(raw)) return null // 엔티티/내부 태그 — 오프셋 불일치 가능
    segs.push({ contentStart: t.contentStart, from: offset, to: offset + raw.length })
    offset += raw.length
  }
  if (segs.length === 0 || end > offset) return null

  const escaped = escapeXmlText(replacement)

  // 삽입 (start === end) — 위치를 포함하는 첫 세그먼트에 삽입
  if (start === end) {
    for (const seg of segs) {
      if (start >= seg.from && start <= seg.to) {
        const at = seg.contentStart + (start - seg.from)
        return [{ start: at, end: at, replacement: escaped }]
      }
    }
    return null
  }

  // 치환 — 첫 겹침 세그먼트에 새 텍스트, 나머지 겹침 구간은 제거
  const splices: SpliceEdit[] = []
  let placed = false
  for (const seg of segs) {
    if (seg.to <= start || seg.from >= end) continue
    const localStart = Math.max(seg.from, start) - seg.from
    const localEnd = Math.min(seg.to, end) - seg.from
    splices.push({
      start: seg.contentStart + localStart,
      end: seg.contentStart + localEnd,
      replacement: placed ? "" : escaped,
    })
    placed = true
  }
  return placed ? splices : null
}

/** splice 일괄 적용 — 겹침 검증 후 뒤에서부터 치환 */
/**
 * 섹션 내 모든 <hp:linesegarray> 제거 splice 목록.
 *
 * hp:linesegarray는 문단 각 줄의 레이아웃(위치·크기) 정보를 담는데, hp:t 텍스트만
 * 바꾸면 이 정보가 새 텍스트와 어긋난다. 한컴 한글은 이를 "변조"로 감지해 보안
 * 경고를 띄운다(한컴 개발자포럼 권고). 선택적(optional)인 요소라 제거해도 뷰어가
 * 레이아웃을 다시 계산하므로, 텍스트가 바뀐 섹션은 전체 linesegarray를 비운다
 * (일부만 비우면 한컴이 문서 전체 정합성 검사에서 여전히 경고를 띄움).
 */
export function allLinesegRemovalSplices(xml: string): SpliceEdit[] {
  const segRe = /<(\w+:)?linesegarray\b[^>]*?(?:\/>|>[\s\S]*?<\/\1linesegarray>)/g
  const splices: SpliceEdit[] = []
  let m: RegExpExecArray | null
  while ((m = segRe.exec(xml)) !== null) {
    splices.push({ start: m.index, end: m.index + m[0].length, replacement: "" })
  }
  return splices
}

export function applySplices(xml: string, splices: SpliceEdit[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error("소스맵 splice 범위 겹침 — 내부 오류")
    }
  }
  let result = xml
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    result = result.slice(0, s.start) + s.replacement + result.slice(s.end)
  }
  return result
}
