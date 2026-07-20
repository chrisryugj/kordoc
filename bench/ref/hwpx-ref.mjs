// 독립 HWPX 참조 추출기 — 파서(src/)와 코드 0% 공유 (pitfall #1).
// 의도적으로 멍청하게: section*.xml의 모든 hp:t를 그대로 수집하고 policy.mjs 규칙만 적용한다.
// XML 워커도 자체 구현 (xmldom 공유 버그 차단 + 속도).

import JSZip from "jszip"
import {
  EXCLUDE_SUBTREES, applyAltTextPolicy, newPolicyCounters,
} from "./policy.mjs"
import { normText } from "../lib/normalize.mjs"

// ─── 경량 XML 트리 파서 ─────────────────────────────

const ENTITY_RE = /&(?:lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g
function decodeEntities(s) {
  if (s.indexOf("&") === -1) return s
  return s.replace(ENTITY_RE, m => {
    switch (m) {
      case "&lt;": return "<"
      case "&gt;": return ">"
      case "&amp;": return "&"
      case "&quot;": return '"'
      case "&apos;": return "'"
      default: {
        const code = m[2] === "x" || m[2] === "X"
          ? parseInt(m.slice(3, -1), 16)
          : parseInt(m.slice(2, -1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
    }
  })
}

const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
function parseAttrs(s) {
  const attrs = {}
  let m
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(s)) !== null) {
    attrs[m[1].replace(/^[^:]+:/, "").toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "")
  }
  return attrs
}

const localName = name => name.replace(/^[^:]+:/, "").toLowerCase()

/** XML → {tag, attrs, children:[node|string]} 트리. 잘 구성된 기계 생성 XML 전제. */
export function parseXmlLite(xml) {
  const root = { tag: "#root", attrs: {}, children: [] }
  const stack = [root]
  const len = xml.length
  let i = 0
  while (i < len) {
    const lt = xml.indexOf("<", i)
    if (lt === -1) break
    if (lt > i) {
      const txt = xml.slice(i, lt)
      if (txt.trim()) stack[stack.length - 1].children.push(decodeEntities(txt))
      else if (stack[stack.length - 1].tag === "t") stack[stack.length - 1].children.push(txt)
    }
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4)
      i = e === -1 ? len : e + 3
      continue
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9)
      stack[stack.length - 1].children.push(xml.slice(lt + 9, e === -1 ? len : e))
      i = e === -1 ? len : e + 3
      continue
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const e = xml.indexOf(">", lt)
      i = e === -1 ? len : e + 1
      continue
    }
    // 태그 끝 탐색 (따옴표 내 '>' 무시)
    let j = lt + 1, q = null
    while (j < len) {
      const ch = xml[j]
      if (q) { if (ch === q) q = null }
      else if (ch === '"' || ch === "'") q = ch
      else if (ch === ">") break
      j++
    }
    const raw = xml.slice(lt + 1, j)
    i = j + 1
    if (raw[0] === "/") {
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClose = raw.endsWith("/")
    const body = selfClose ? raw.slice(0, -1) : raw
    const sp = body.search(/\s/)
    const name = sp === -1 ? body : body.slice(0, sp)
    const node = {
      tag: localName(name),
      attrs: sp === -1 ? {} : parseAttrs(body.slice(sp + 1)),
      children: [],
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root
}

// ─── 참조 추출 ──────────────────────────────────────

const SHAPE_TAGS = new Set([
  "pic", "shape", "drawingobject", "rect", "ellipse", "polygon", "line", "arc",
  "curve", "connectline", "container", "textart", "ole", "unknownobject", "video", "chart",
])

function textOfAll(node, counters) {
  // 모든 텍스트 재귀 수집 (EXCLUDE 서브트리 제외) — 각주/머리말 내용 수집용
  let out = ""
  if (!node) return out
  for (const ch of node.children) {
    if (typeof ch === "string") { out += ch; continue }
    if (EXCLUDE_SUBTREES.has(ch.tag)) { bump(counters, ch.tag); continue }
    if (ch.tag === "tab" || ch.tag === "fwspace" || ch.tag === "hwspace") { out += " "; continue }
    if (ch.tag === "br" || ch.tag === "linebreak") { out += "\n"; continue }
    out += textOfAll(ch, counters)
  }
  return out
}

function findDesc(node, tag, depth = 0) {
  if (!node || depth > 12) return null
  for (const ch of node.children) {
    if (typeof ch === "string") continue
    if (ch.tag === tag) return ch
    const f = findDesc(ch, tag, depth + 1)
    if (f) return f
  }
  return null
}

function findAllDesc(node, tag, out = [], depth = 0) {
  if (!node || depth > 12) return out
  for (const ch of node.children) {
    if (typeof ch === "string") continue
    if (ch.tag === tag) { out.push(ch); continue } // drawText 안의 drawText는 재귀 단계에서 처리
    findAllDesc(ch, tag, out, depth + 1)
  }
  return out
}

function bump(counters, tag) {
  counters.excludedElements[tag] = (counters.excludedElements[tag] ?? 0) + 1
}

// 파서 handleShape가 이미지를 추출하는 호스트 태그 (extractImageRef 미러)
const IMG_HOST_TAGS = new Set(["pic", "shape", "drawingobject"])
const IMG_REF_TAGS = new Set(["imgrect", "img", "imgclip"])

/** 도형 서브트리에 파서가 추출할 이미지 참조가 있는가 — 셀 trim 판정용(독립 구현) */
function hasImageRef(node, hostSeen = false, depth = 0) {
  if (depth > 12) return false
  const isHost = hostSeen || IMG_HOST_TAGS.has(node.tag)
  if (isHost) {
    if (IMG_REF_TAGS.has(node.tag) && (node.attrs.binaryitemidref || node.attrs.href)) return true
    if (node.attrs.binaryitemidref) return true
  }
  for (const ch of node.children) {
    if (typeof ch === "string") continue
    if (hasImageRef(ch, isHost, depth + 1)) return true
  }
  return false
}

/**
 * 도형(pic/shape/drawingObject) 직계 caption 노드 수집 — 파서 handleShape의
 * findChildByLocalName(el, "caption") 미러. tbl/drawText 하위는 각자 소관이라 제외.
 */
function collectShapeCaptions(node, out = [], depth = 0) {
  if (!node || depth > 12) return out
  for (const ch of node.children) {
    if (typeof ch === "string") continue
    if (ch.tag === "tbl" || ch.tag === "drawtext") continue
    if (IMG_HOST_TAGS.has(node.tag) && ch.tag === "caption") { out.push(ch); continue }
    collectShapeCaptions(ch, out, depth + 1)
  }
  return out
}

/**
 * HWPX 버퍼 → 참조 데이터.
 * units  : 문서 순서 RefUnit[] {id, kind: body|cell|drawText|caption|footnote|endnote, text, tableIdx?}
 * tables : post-order(완료 순 = kordoc IR 블록 순) 참조 그리드
 * specials: { equations, footnotes[], endnotes[], headers[], footers[] }
 */
export async function extractRef(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const sectionFiles = Object.values(zip.files)
    .filter(f => /section\d+\.xml$/i.test(f.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/section(\d+)\.xml$/i)[1], 10)
      const nb = parseInt(b.name.match(/section(\d+)\.xml$/i)[1], 10)
      return na - nb
    })

  // 자동부호(NUMBER/BULLET) paraPr id — 한컴은 이 문단 앞에 번호/부호를 렌더하지만
  // hp:t 원문에는 없다. 셀 채점의 장식 관용(줄 단위) 판정에만 사용 (값 해석은 안 함 —
  // 번호 값 자체의 정확성은 파서 유닛 테스트 소관).
  const headingParaIds = new Set()
  const headerFile = Object.values(zip.files).find(f => /(^|\/)header\.xml$/i.test(f.name))
  if (headerFile) {
    const headerRoot = parseXmlLite(await headerFile.async("string"))
    for (const pr of findAllDesc(headerRoot, "parapr")) {
      const h = findDesc(pr, "heading")
      const type = (h?.attrs.type ?? "NONE").toUpperCase()
      if ((type === "NUMBER" || type === "BULLET") && pr.attrs.id !== undefined) {
        headingParaIds.add(pr.attrs.id)
      }
    }
  }

  const counters = newPolicyCounters()
  const units = []
  const tables = []
  const specials = { equations: 0, footnotes: [], endnotes: [], headers: [], footers: [] }
  let nextUnitId = 0

  const pushUnit = (kind, text, tableIdx, nestedCaption) => {
    const t = text.trim()
    if (!t) return
    const u = { id: nextUnitId++, kind, text: t, tableIdx }
    // 중첩표 캡션 — 파서가 부모 셀 내부에 렌더링하므로 문서 평탄화 순서와 유닛 push
    // 순서(post-order 즉시 처리)가 어긋난다. 중첩표 셀과 같은 논리로 순서 모수 제외.
    if (nestedCaption) u.nestedCaption = true
    units.push(u)
  }

  // ── 문단 텍스트 수집 (인라인 요소 + ctrl 카테고리 라우팅 + 구조 자식 분리) ──
  function collectPara(p) {
    // 자동부호 문단 사용 수 — phantom의 자동번호 관용(score.mjs) 문서 단위 게이트용
    if (headingParaIds.has(p.attrs?.parapridref)) counters.autoNumHeadingParas++
    let text = ""
    let leaderCut = false
    const structural = [] // {type:'tbl'|'shape'|'drawtext', node}
    const addText = s => { if (leaderCut) counters.leaderTabChars += s.length; else text += s }

    const walkText = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") { addText(ch); continue }
        const t = ch.tag
        if (t === "tbl") {
          // 글자취급(inline) 표는 경계 마커 — 파서와 동일하게 표 전후 텍스트를
          // 문서 순서 유닛으로 분할한다 (#49/#50). float 표는 종전대로 텍스트 뒤
          const inline = ch.children.some(c => typeof c !== "string" && c.tag === "pos" && c.attrs?.treataschar === "1")
          structural.push({ type: "tbl", node: ch })
          if (inline && !leaderCut) text += "\x1E"
          continue
        }
        if (t === "drawtext") { structural.push({ type: "drawtext", node: ch }); continue }
        if (SHAPE_TAGS.has(t)) { structural.push({ type: "shape", node: ch }); continue }
        if (t === "tab") {
          const leader = ch.attrs.leader
          if (leader && leader !== "0") leaderCut = true // 리더탭 이후 절단 (whitelist: leader-tab-cut)
          else addText(" ")
          continue
        }
        if (t === "br" || t === "linebreak") { addText("\n"); continue }
        if (t === "fwspace" || t === "hwspace") { addText(" "); continue }
        if (t === "equation") {
          const script = findDesc(ch, "script")
          if (script && textOfAll(script, counters).trim()) specials.equations++ // presence 분리 (whitelist)
          continue
        }
        if (t === "ctrl") { handleCtrl(ch); continue }
        if (EXCLUDE_SUBTREES.has(t)) { bump(counters, t); continue }
        walkText(ch)
      }
    }

    const handleCtrl = ctrl => {
      for (const ch of ctrl.children) {
        if (typeof ch === "string") continue
        switch (ch.tag) {
          case "header": specials.headers.push(normText(textOfAll(ch, counters))); break
          case "footer": specials.footers.push(normText(textOfAll(ch, counters))); break
          case "footnote": {
            const t = textOfAll(ch, counters)
            specials.footnotes.push(normText(t))
            pushUnit("footnote", t)
            break
          }
          case "endnote": {
            const t = textOfAll(ch, counters)
            specials.endnotes.push(normText(t))
            pushUnit("endnote", t)
            break
          }
          default:
            bump(counters, ch.tag) // autoNum, pageNum, colPr, bookmark 등 — 모수 제외
        }
      }
    }

    walkText(p)
    // 인라인 표 경계 분할본(segs) — walkBody만 소비. counters는 전체 텍스트 1회만 반영
    const segs = text.includes("\x1E")
      ? text.split("\x1E").map(s => applyAltTextPolicy(s, null))
      : null
    return { text: applyAltTextPolicy(text.replace(/\x1E/g, ""), counters), segs, structural }
  }

  // ── 구조 자식 처리 (DOM 순서 = 파서 블록 순서) ──
  // cellSink: 표 셀 내부일 때 글상자 텍스트를 셀 텍스트로 합류시키는 배열 —
  //   파서 v3.0이 셀 내 글상자 문단을 IRCell(text/blocks)에 병합하므로 동일 경계로 모델링
  //   (별도 drawText 유닛으로 빼면 셀 내용 비교가 어긋나고 recall이 이중 계상됨).
  // 반환: 파서가 이 구조물에서 IRCell.text에 남길 콘텐츠가 있는가
  // (중첩표 텍스트·글상자 텍스트·이미지 ![image] 참조) — 셀 trim 판정용 (builder trimAndReturn 미러)
  function processStructural(structural, depth, cellSink) {
    let irContent = false
    for (const s of structural) {
      if (s.type === "tbl") {
        const rec = processTable(s.node, depth) // 중첩표 텍스트는 자식 그리드 소관 — cellSink 비전파
        // 파서는 중첩표를 부모 cell.text에 평탄화 텍스트로도 남김(하위 호환) —
        // 셀 텍스트·이미지 참조·캡션 중 하나라도 있으면 부모 IR 셀 텍스트가 비어있지 않다
        if (rec && (rec.hasCaption || rec.cells.some(a => normText(a.text) || a.hasIrContent))) irContent = true
      } else if (s.type === "drawtext") {
        if (processDrawText(s.node, depth, cellSink)) irContent = true
      } else { // shape: 모든 drawText 자손 (파서는 첫 번째만 추출 — 차이는 recall이 검출)
        if (hasImageRef(s.node)) irContent = true
        for (const dt of findAllDesc(s.node, "drawtext")) {
          if (processDrawText(dt, depth, cellSink)) irContent = true
        }
        // 도형 캡션(그림 캡션) — 파서 handleShape가 문단으로 보존 (drawText 텍스트 뒤 순서)
        for (const cap of collectShapeCaptions(s.node)) {
          const capWalk = n => {
            for (const c of n.children) {
              if (typeof c === "string") continue
              if (c.tag === "p" || c.tag === "para") {
                const { text } = collectPara(c) // 캡션 내 표/도형은 파서 미지원 — 텍스트만
                if (!text.trim()) continue
                if (cellSink) cellSink.push(text.trim())
                else pushUnit("caption", text)
                irContent = true
              } else if (c.tag !== "tbl") capWalk(c)
            }
          }
          capWalk(cap)
        }
      }
    }
    return irContent
  }

  function processDrawText(dtNode, depth, cellSink) {
    // drawText > (subList >)? p — 반환: 비어있지 않은 텍스트가 있었는가
    let hadText = false
    const walkDt = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "sublist") walkDt(ch)
        else if (ch.tag === "p" || ch.tag === "para") {
          const { text, structural } = collectPara(ch)
          if (text.trim()) hadText = true
          if (cellSink) { if (text.trim()) cellSink.push(text.trim()) }
          else pushUnit("drawText", text)
          if (processStructural(structural, depth, cellSink)) hadText = true
        }
      }
    }
    walkDt(dtNode)
    return hadText
  }

  function processTable(tblNode, depth) {
    // caption — 가시 텍스트 (파서가 드롭하는지 recall로 검증)
    let hasCaption = false
    for (const ch of tblNode.children) {
      if (typeof ch === "string" || ch.tag !== "caption") continue
      const capWalk = n => {
        for (const c of n.children) {
          if (typeof c === "string") continue
          if (c.tag === "p" || c.tag === "para") {
            const { text, structural } = collectPara(c)
            if (text.trim()) hasCaption = true
            pushUnit("caption", text, undefined, depth > 0)
            processStructural(structural, depth)
          } else capWalk(c)
        }
      }
      capWalk(ch)
    }

    const rawRows = []
    const walkRows = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "tr") {
          const row = []
          for (const tc of ch.children) {
            if (typeof tc === "string" || tc.tag !== "tc") continue
            row.push(processCell(tc, depth))
          }
          if (row.length > 0) rawRows.push(row)
        } else if (ch.tag !== "caption" && ch.tag !== "tbl") walkRows(ch)
      }
    }
    walkRows(tblNode)
    if (rawRows.length === 0) return null

    // v3.0: 중첩표는 크기와 무관하게 부모 IRCell.blocks에 구조 보존 — 전부 비교 대상.
    // tables[]는 post-order(자식 먼저)로 쌓이며 IR 수집(collectIrGrids)도 같은 순서를 쓴다.
    const isNested = depth > 0
    if (isNested) counters.nestedTables++

    const grid = buildRefGrid(rawRows, counters)
    const record = {
      idx: tables.length,
      rows: grid.rows, cols: grid.cols, cells: grid.anchors,
      nested: isNested, hasCaption,
    }
    tables.push(record)
    // 셀 유닛 (row-major) — 평탄화/호이스팅 어느 쪽이든 텍스트는 md에 존재해야 함
    const sorted = [...grid.anchors].sort((a, b) => a.r - b.r || a.c - b.c)
    for (const a of sorted) pushUnit("cell", a.text, record.idx)
    return record
  }

  function processCell(tc, depth) {
    const cell = { textParts: [], headingPartIdx: new Set(), colAddr: undefined, rowAddr: undefined, colSpan: 1, rowSpan: 1, hasNested: false, hasIrContent: false }
    const walkTc = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        switch (ch.tag) {
          case "celladdr": {
            const ca = parseInt(ch.attrs.coladdr ?? "", 10)
            const ra = parseInt(ch.attrs.rowaddr ?? "", 10)
            if (!Number.isNaN(ca)) cell.colAddr = ca
            if (!Number.isNaN(ra)) cell.rowAddr = ra
            break
          }
          case "cellspan": {
            const cs = parseInt(ch.attrs.colspan ?? "1", 10)
            const rs = parseInt(ch.attrs.rowspan ?? "1", 10)
            cell.colSpan = Number.isNaN(cs) ? 1 : Math.max(1, cs)
            cell.rowSpan = Number.isNaN(rs) ? 1 : Math.max(1, rs)
            break
          }
          case "p": case "para": {
            const { text, structural } = collectPara(ch)
            if (text.trim()) {
              cell.textParts.push(text.trim())
              // 자동부호 문단 — 파서는 번호/부호를 렌더하지만 원문 텍스트엔 없음 (장식 관용 대상)
              if (headingParaIds.has(ch.attrs.parapridref)) cell.headingPartIdx.add(cell.textParts.length - 1)
            }
            // 중첩표/글상자 — 셀 내부에서 즉시 처리 (post-order: 부모보다 먼저 tables[]에 들어감).
            // 글상자 텍스트는 cell.textParts로 합류 (파서 mergeBlocksIntoCell 미러)
            if (structural.some(s => s.type === "tbl")) cell.hasNested = true
            // 이미지/중첩표/글상자가 IR 셀 텍스트를 채우면 trim 판정 시 비어있지 않음
            if (processStructural(structural, depth + 1, cell.textParts)) cell.hasIrContent = true
            break
          }
          default:
            if (EXCLUDE_SUBTREES.has(ch.tag)) { bump(counters, ch.tag); break }
            walkTc(ch)
        }
      }
    }
    walkTc(tc)
    cell.text = cell.textParts.join("\n")
    // 장식 관용 줄 인덱스 — cell.text 기준 (part 내부 개행 반영, 부호는 문단 첫 줄에만 렌더)
    if (cell.headingPartIdx.size) {
      cell.headingLines = []
      let line = 0
      for (let i = 0; i < cell.textParts.length; i++) {
        if (cell.headingPartIdx.has(i)) cell.headingLines.push(line)
        line += cell.textParts[i].split("\n").length
      }
    }
    return cell
  }

  // ── 본문 워크 ──
  function walkBody(node) {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "p" || ch.tag === "para") {
        const { text, segs, structural } = collectPara(ch)
        if (segs) {
          // 인라인 표 포함 문단 — 파서 walkSection 분할 방출과 동일 모델 (#49/#50/#53):
          // 표(inline·float) 직전마다 해당 텍스트 조각을 방출, 잔여 조각은 뒤에. float 표는
          // 흐름 불참이지만 앞선 텍스트를 추월하지 않는다 (#53). 도형은 DOM 위치.
          let si = 0
          for (const s of structural) {
            if (s.type === "tbl") pushUnit("body", segs[si++] ?? "")
            processStructural([s], 0)
          }
          while (si < segs.length) pushUnit("body", segs[si++] ?? "")
        } else {
          pushUnit("body", text)
          processStructural(structural, 0)
        }
      } else if (ch.tag === "tbl") {
        processTable(ch, 0)
      } else if (EXCLUDE_SUBTREES.has(ch.tag)) {
        bump(counters, ch.tag)
      } else {
        walkBody(ch)
      }
    }
  }

  for (const f of sectionFiles) {
    const xml = await f.async("string")
    walkBody(parseXmlLite(xml))
  }

  return { units, tables, specials, counters }
}

/** 셀 목록 → 앵커 그리드. cellAddr 우선, 없으면 커서 시뮬레이션. 후행 빈 열 트림(policy) 적용. */
function buildRefGrid(rawRows, counters) {
  const hasAddr = rawRows.some(row => row.some(c => c.colAddr !== undefined && c.rowAddr !== undefined))
  let anchors = []
  let rows = 0, cols = 0

  if (hasAddr) {
    for (const row of rawRows) {
      for (const c of row) {
        const r = c.rowAddr ?? 0, cc = c.colAddr ?? 0
        anchors.push({ r, c: cc, rs: c.rowSpan, cs: c.colSpan, text: c.text, hasNested: c.hasNested, hasIrContent: c.hasIrContent, headingLines: c.headingLines })
        if (r + c.rowSpan > rows) rows = r + c.rowSpan
        if (cc + c.colSpan > cols) cols = cc + c.colSpan
      }
    }
    // kordoc buildTableDirect는 numRows를 tr 수로 잡음 — 참조는 spec 그대로(rowAddr 기반).
    // 단 일반적인 파일에서는 두 값이 일치한다. 불일치는 구조 채점에서 드러난다.
  } else {
    // 커서 시뮬레이션 (builder pass1과 동일 의미론, 독립 구현)
    const occupied = []
    rows = rawRows.length
    for (let ri = 0; ri < rawRows.length; ri++) {
      occupied[ri] = occupied[ri] ?? []
      let ci = 0
      for (const c of rawRows[ri]) {
        while (occupied[ri][ci]) ci++
        anchors.push({ r: ri, c: ci, rs: c.rowSpan, cs: c.colSpan, text: c.text, hasNested: c.hasNested, hasIrContent: c.hasIrContent, headingLines: c.headingLines })
        for (let dr = 0; dr < c.rowSpan && ri + dr < rows; dr++) {
          occupied[ri + dr] = occupied[ri + dr] ?? []
          for (let dc = 0; dc < c.colSpan; dc++) occupied[ri + dr][ci + dc] = true
        }
        ci += c.colSpan
        if (ci > cols) cols = ci
      }
    }
  }

  // 후행 빈 열 트림 — builder trimAndReturn 미러 (whitelist: trailing-col-trim).
  // v3.0: 이미지/중첩표/글상자 콘텐츠가 IR 셀 텍스트를 채우므로(![image] 등) 비어있지 않음으로 판정.
  let effectiveCols = cols
  while (effectiveCols > 0) {
    const hasText = anchors.some(a => a.c === effectiveCols - 1 && (normText(a.text) || a.hasIrContent))
    if (hasText) break
    effectiveCols--
  }
  if (effectiveCols < cols && effectiveCols > 0) {
    anchors = anchors.filter(a => a.c < effectiveCols)
    cols = effectiveCols
    counters.trimmedCols++
  }

  return { rows, cols, anchors }
}
