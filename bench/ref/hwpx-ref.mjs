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

// 한컴이 본문에 그리는 자동번호 — 주석 머리(FOOTNOTE·ENDNOTE)·캡션(PICTURE·TABLE·EQUATION)
const RENDERED_AUTONUM = new Set(["FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION"])

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

  // 자동부호(NUMBER/BULLET/OUTLINE) paraPr id — 한컴은 이 문단 앞에 번호/부호를 렌더하지만
  // hp:t 원문에는 없다. 셀 채점의 장식 관용(줄 단위) 판정에만 사용 (값 해석은 안 함 —
  // 번호 값 자체의 정확성은 파서 유닛 테스트 소관). OUTLINE(개요) 도 같다 — 한컴 2020 PDF 가
  // "1. 3. 단계별 시스템 활용방법"(개요 1수준 번호 + 리터럴 "3.")을 그린다 (rhwp pdf/3249937)
  const headingParaIds = new Set()
  const headerFile = Object.values(zip.files).find(f => /(^|\/)header\.xml$/i.test(f.name))
  if (headerFile) {
    const headerRoot = parseXmlLite(await headerFile.async("string"))
    for (const pr of findAllDesc(headerRoot, "parapr")) {
      const h = findDesc(pr, "heading")
      const type = (h?.attrs.type ?? "NONE").toUpperCase()
      if ((type === "NUMBER" || type === "BULLET" || type === "OUTLINE") && pr.attrs.id !== undefined) {
        headingParaIds.add(pr.attrs.id)
      }
    }
  }

  const counters = newPolicyCounters()
  const units = []
  const tables = []
  // noteHosts: 각주/미주를 하나 이상 가진 문단 수 — 파서는 문단당 "(주: …)" 하나에 그 문단의
  // 주석을 모두 담는다(IRBlock.footnoteText 단일 문자열, HWP5 동일) → fnPresence 모수
  const specials = { equations: 0, footnotes: [], endnotes: [], headers: [], footers: [], noteHosts: 0 }
  // 섹션 번호 모양 — secPr footNotePr/endNotePr > autoNumFormat (섹션마다 갱신)
  let noteFormats = {}

  // 유닛 싱크 — 표 셀 처리 중엔 셀별 목록으로 바꿔 끼워, 표 완료 후 셀 좌표 순서로 부모
  // 싱크에 옮긴다. 파서는 중첩표·글상자를 부모 셀 안 제자리에 렌더하므로 유닛도 문서 순서
  // (부모 셀 글 → 셀 안 중첩표 → 셀 글 나머지)여야 짧은 유닛의 위치 창(align Pass 3)이 맞는다
  let curUnits = units
  const pushUnit = (kind, text, tableIdx, nestedCaption) => {
    const t = text.trim()
    if (!t) return
    const u = { id: -1, kind, text: t, tableIdx }
    // 중첩표 캡션 — 부모 셀 내부 렌더라 순서 모수 제외 (중첩표 셀과 같은 논리)
    if (nestedCaption) u.nestedCaption = true
    curUnits.push(u)
    return u
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
        // 대체 표현 묶음 — 한컴은 hp:case(차트) 하나만 그린다, 없으면 hp:default(OLE)
        if (t === "switch") {
          const branch = ch.children.find(c => typeof c !== "string" && c.tag === "case")
            ?? ch.children.find(c => typeof c !== "string" && c.tag === "default")
          if (branch) walkText(branch)
          continue
        }
        if (t === "tbl") {
          // 글자취급(inline) 표는 경계 마커 — 파서와 동일하게 표 전후 텍스트를
          // 문서 순서 유닛으로 분할한다 (#49/#50). float 표는 종전대로 텍스트 뒤
          const inline = ch.children.some(c => typeof c !== "string" && c.tag === "pos" && c.attrs?.treataschar === "1")
          structural.push({ type: "tbl", node: ch })
          if (inline && !leaderCut) text += "\x1E"
          continue
        }
        if (t === "drawtext") { structural.push({ type: "drawtext", node: ch }); continue }
        if (SHAPE_TAGS.has(t)) {
          structural.push({ type: "shape", node: ch })
          // 그림 호스트(pic/shape/drawingObject) 밖 개체(묶음·사각형·차트·OLE…)의 직계 캡션은
          // 한컴이 개체 아래/위에 그리는 글 — 이 문단 글에 제자리로 합류 (파서도 문단 텍스트로 방출)
          if (!IMG_HOST_TAGS.has(t)) {
            for (const cap of ch.children) {
              if (typeof cap === "string" || cap.tag !== "caption") continue
              for (const cp of findAllDesc(cap, "p")) {
                const r = collectPara(cp)
                if (r.text.trim()) addText(" " + r.text + " ")
                structural.push(...r.structural)
              }
            }
          }
          continue
        }
        // 주석 머리 번호·캡션 번호(hp:autoNum) — 한컴이 그리는 "1)"·"문1）"·"<그림 1>"
        if (t === "autonum" && RENDERED_AUTONUM.has(ch.attrs.numtype)) {
          addText(noteAutoNumText(ch))
          continue
        }
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

    const notes = [] // 이 문단의 각주/미주 — 호출자가 문단 글 유닛 뒤에 둔다 (파서: 문단 끝 "(주: …)")
    const handleCtrl = ctrl => {
      for (const ch of ctrl.children) {
        if (typeof ch === "string") continue
        switch (ch.tag) {
          // 머리말/꼬리말 — 본문과 같은 문단 모델(글 → 표 셀·글상자 글) 조각 목록. 0/1회 정책 채점
          case "header": specials.headers.push(subListParts(ch)); break
          case "footer": specials.footers.push(subListParts(ch)); break
          case "footnote": case "endnote": {
            // 개체 자리의 본문 참조 부호("1)"·"문1）") — 한컴이 그린다 (hp:t 에 없음)
            if (!leaderCut) addText(noteRefMark(ch, noteFormats[ch.tag]))
            const parts = subListParts(ch)
            ;(ch.tag === "footnote" ? specials.footnotes : specials.endnotes).push(normText(parts.join(" ")))
            notes.push({ kind: ch.tag, parts })
            break
          }
          // 주석 머리 번호·캡션 번호(hp:ctrl > hp:autoNum) — 한컴이 그리는 "1)"·"문1）"·"<그림 1>".
          // 쪽번호(PAGE)는 머리말·꼬리말 크롬이라 모수 제외 (파서도 미방출)
          case "autonum":
            if (RENDERED_AUTONUM.has(ch.attrs.numtype)) { addText(noteAutoNumText(ch)); break }
            bump(counters, ch.tag)
            break
          default:
            bump(counters, ch.tag) // autoNum(쪽번호 등), pageNum, colPr, bookmark 등 — 모수 제외
        }
      }
    }

    walkText(p)
    // 인라인 표 경계 분할본(segs) — walkBody만 소비. counters는 전체 텍스트 1회만 반영
    const segs = text.includes("\x1E")
      ? text.split("\x1E").map(s => applyAltTextPolicy(s, null))
      : null
    return { text: applyAltTextPolicy(text.replace(/\x1E/g, ""), counters), segs, structural, notes }
  }

  // 문단 주석 유닛 방출 — 조각(문단·표 셀·글상자)마다 주석 유닛. 빈 주석(번호·글 모두 없음)은
  // 한컴도 주석 영역에 아무것도 그리지 않고 파서도 "(주: …)" 를 내지 않는다. 주석 있는 문단 수가
  // fnPresence 모수 (파서는 문단의 주석을 "(주: 1) …; 2) …)" 하나로 담는다)
  function pushNotes(notes) {
    let any = false
    for (const n of notes) {
      for (const t of n.parts) pushUnit(n.kind, t)
      if (n.parts.length) any = true
    }
    if (any) specials.noteHosts++
  }

  // ── 각주·미주 번호 (XML 속성 재구성 — 한컴이 그리는 부호, hp:t 에 없음) ──
  // 본문 참조 부호: 개체 속성 prefixChar/suffixChar/userChar(코드포인트 10진) 우선, 없으면 구역
  // footNotePr/endNotePr > autoNumFormat 의 리터럴 문자, 둘 다 없으면 한컴 기본 ")"
  // 번호 서식은 DIGIT·USER_CHAR 만 모델링(코퍼스 전량) — 다른 서식이 나오면 phantom 으로 드러난다
  const cpChar = v => {
    if (v === undefined || v === "") return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? (n === 0 ? "" : String.fromCodePoint(n)) : undefined
  }
  function noteRefMark(note, fmt) {
    const type = fmt?.type || "DIGIT"
    const prefix = cpChar(note.attrs.prefixchar) ?? (fmt ? fmt.prefixchar ?? "" : "")
    const suffix = cpChar(note.attrs.suffixchar) ?? (fmt ? fmt.suffixchar ?? "" : ")")
    const core = type === "USER_CHAR" ? (cpChar(note.attrs.userchar) ?? fmt?.userchar ?? "") : (note.attrs.number ?? "1")
    return prefix + core + suffix
  }
  // 주석 본문 머리 hp:autoNum — autoNumFormat 리터럴 그대로
  function noteAutoNumText(autonum) {
    const f = autonum.children.find(c => typeof c !== "string" && c.tag === "autonumformat")?.attrs ?? {}
    const core = f.type === "USER_CHAR" ? (f.userchar ?? "") : (autonum.attrs.num ?? "1")
    return (f.prefixchar ?? "") + core + (f.suffixchar ?? "")
  }

  // ── subList 텍스트 조각 (머리말·꼬리말·주석) — 본문과 같은 문단 모델, 문서 순서 ──
  // 문단 글 → 구조 자식(표 셀 글·글상자 글·도형 캡션). 표는 tables[] 에 넣지 않는다 —
  // 파서가 머리말·주석의 표를 IR 표 없이 평탄화 텍스트로만 내기 때문
  function subListParts(node) {
    const parts = []
    const visit = n => {
      for (const ch of n.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "p" || ch.tag === "para") {
          const { text, structural } = collectPara(ch)
          if (text.trim()) parts.push(text.trim())
          for (const st of structural) {
            if (st.type === "tbl") { for (const tc of findAllDesc(st.node, "tc")) visit(tc) }
            else if (st.type === "drawtext") visit(st.node)
            else {
              for (const dt of findAllDesc(st.node, "drawtext")) visit(dt)
              for (const cap of collectShapeCaptions(st.node)) visit(cap)
            }
          }
        } else if (ch.tag !== "tbl") visit(ch)
      }
    }
    visit(node)
    return parts
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
        cellSink?.beforeTable?.() // 셀 글 조각을 표 유닛 앞에서 끊는다 (문서 순서)
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
          const { text, structural, notes } = collectPara(ch)
          if (text.trim()) hadText = true
          if (cellSink) { if (text.trim()) cellSink.push(text.trim(), headingParaIds.has(ch.attrs.parapridref)) }
          else pushUnit("drawText", text)
          // 글상자 문단의 주석 — 파서 블록 footnoteText (문단 뒤 "(주: …)")
          if (notes.length) { cellSink?.beforeTable?.(); pushNotes(notes) }
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
          rawRows.push(row) // 빈 <hp:tr/> 도 행 — 주소 없는 셀의 tr 행 번호가 어긋나지 않게 (파서 동일)
        } else if (ch.tag !== "caption" && ch.tag !== "tbl") walkRows(ch)
      }
    }
    walkRows(tblNode)
    if (rawRows.every(r => r.length === 0)) return null

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
    // 셀 유닛 (row-major) — 셀마다 [셀 글 조각 · 셀 안 중첩 구조 유닛] 목록을 좌표 순으로 옮긴다
    // (중첩표 유닛이 부모 셀 제자리에 온다 — 종전 post-order 는 부모 셀보다 앞서 짧은 유닛이 남의 자리를 가로챘다)
    for (const c of grid.cellOrder) {
      for (const u of c.unitList) {
        if (u.own) pushUnit("cell", u.text, record.idx)
        else curUnits.push(u)
      }
    }
    return record
  }

  function processCell(tc, depth) {
    const cell = { textParts: [], headingPartIdx: new Set(), colAddr: undefined, rowAddr: undefined, colSpan: 1, rowSpan: 1, hasNested: false, hasIrContent: false, unitList: [] }
    // 셀 유닛은 셀 안 중첩표 경계에서 끊어 문서 순서로 둔다 — 파서는 "셀 글 → 중첩표 → 셀 글"
    // 순으로 렌더하므로 한 덩어리로 두면 중첩표 뒤 짧은 꼬리("끝"·"귀하")가 조각(MIN_FRAG)
    // 미달로 거짓 miss+phantom 이 된다 (k-water-rfp·3249937). cell.text(표 채점용)는 종전 그대로
    const savedUnits = curUnits
    curUnits = cell.unitList
    const unitSegs = []
    const flushUnit = () => {
      const t = unitSegs.join("\n").trim()
      unitSegs.length = 0
      if (t) cell.unitList.push({ own: true, text: t })
    }
    // 글상자·도형 캡션 글은 셀 텍스트(textParts)와 유닛 조각에 함께 합류. 자동부호 문단은 새 조각 —
    // 파서(=한컴)가 문단마다 "▸"·"1." 을 끼워 그리므로 앞 문단들과 한 유닛이면 연속 일치가 끊겨
    // 부분 정렬이 문서 다른 곳의 조각을 가로챈다 (tac-img-02 "▸ 철도공단" ↔ "국가철도공단")
    const sink = {
      push: (t, decorated) => { if (decorated) flushUnit(); cell.textParts.push(t); unitSegs.push(t) },
      beforeTable: flushUnit,
    }
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
            const { text, segs, structural, notes } = collectPara(ch)
            if (text.trim()) {
              cell.textParts.push(text.trim())
              // 자동부호 문단 — 파서는 번호/부호를 렌더하지만 원문 텍스트엔 없음 (장식 관용 대상)
              if (headingParaIds.has(ch.attrs.parapridref)) cell.headingPartIdx.add(cell.textParts.length - 1)
            }
            // 중첩표/글상자 — 셀 내부에서 즉시 처리 (post-order: 부모보다 먼저 tables[]에 들어감).
            // 글상자 텍스트는 cell.textParts로 합류 (파서 mergeBlocksIntoCell 미러)
            if (structural.some(s => s.type === "tbl")) cell.hasNested = true
            // 이미지/중첩표/글상자가 IR 셀 텍스트를 채우면 trim 판정 시 비어있지 않음.
            // 글자취급 표가 낀 문단은 표 앞·뒤 글을 표 유닛 사이에 나눠 둔다 (파서 세그먼트 방출 순서)
            if (segs) {
              let si = 0
              for (const st of structural) {
                if (st.type === "tbl") unitSegs.push(segs[si++] ?? "")
                if (processStructural([st], depth + 1, sink)) cell.hasIrContent = true
              }
              while (si < segs.length) unitSegs.push(segs[si++] ?? "")
              // 파서: 세그먼트 경로의 셀 각주는 문단 조각·표 뒤 "(주: …)"
              if (notes.length) { flushUnit(); pushNotes(notes) }
            } else {
              if (text.trim()) {
                if (headingParaIds.has(ch.attrs.parapridref)) flushUnit()
                unitSegs.push(text.trim())
              }
              // 파서: 셀 문단 글 바로 뒤 "(주: …)" — 셀 유닛을 여기서 끊고 주석 유닛을 둔다
              if (notes.length) { flushUnit(); pushNotes(notes) }
              if (processStructural(structural, depth + 1, sink)) cell.hasIrContent = true
            }
            break
          }
          default:
            if (EXCLUDE_SUBTREES.has(ch.tag)) { bump(counters, ch.tag); break }
            walkTc(ch)
        }
      }
    }
    walkTc(tc)
    flushUnit()
    curUnits = savedUnits
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
        const { text, segs, structural, notes } = collectPara(ch)
        if (segs) {
          // 인라인 표 포함 문단 — 파서 walkSection 분할 방출과 동일 모델 (#49/#50/#53):
          // 표(inline·float) 직전마다 해당 텍스트 조각을 방출, 잔여 조각은 뒤에. float 표는
          // 흐름 불참이지만 앞선 텍스트를 추월하지 않는다 (#53). 도형은 DOM 위치.
          // 주석은 첫 글 조각 블록의 footnoteText (파서 flush first) — 그 조각 뒤
          let si = 0
          let noted = !notes.length
          const pushSeg = t => {
            if (!pushUnit("body", t ?? "") || noted) return
            pushNotes(notes)
            noted = true
          }
          for (const s of structural) {
            if (s.type === "tbl") pushSeg(segs[si++])
            processStructural([s], 0)
          }
          while (si < segs.length) pushSeg(segs[si++])
        } else {
          pushUnit("body", text)
          pushNotes(notes)
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
    const root = parseXmlLite(xml)
    const secPr = findDesc(root, "secpr") // 첫 문단 run 안
    const fmtOf = tag => {
      const pr = secPr ? secPr.children.find(c => typeof c !== "string" && c.tag === tag) : null
      return pr?.children.find(c => typeof c !== "string" && c.tag === "autonumformat")?.attrs
    }
    noteFormats = { footnote: fmtOf("footnotepr"), endnote: fmtOf("endnotepr") }
    walkBody(root)
  }
  units.forEach((u, i) => { u.id = i })

  return { units, tables, specials, counters }
}

/** 셀 목록 → 앵커 그리드. cellAddr 우선, 없으면 커서 시뮬레이션. 후행 빈 열 트림(policy) 적용. */
function buildRefGrid(rawRows, counters) {
  const hasAddr = rawRows.some(row => row.some(c => c.colAddr !== undefined && c.rowAddr !== undefined))
  let anchors = []
  let rows = 0, cols = 0

  if (hasAddr) {
    // 칸 주인 — 같은 칸을 두 셀이 주장하면 먼저 온 셀이 갖고 뒤 셀 글은 주인에 이어 붙인다,
    // 주소 없는 셀은 자기 tr 행의 첫 빈 칸 (builder buildTableDirect 미러 — 유효 파일엔 없는 경우)
    const owner = new Map()
    for (let ri = 0; ri < rawRows.length; ri++) {
      for (const c of rawRows[ri]) {
        const r = c.rowAddr ?? ri
        let cc = c.colAddr ?? 0
        if (c.colAddr === undefined) while (owner.has(`${r},${cc}`)) cc++
        const own = owner.get(`${r},${cc}`)
        if (own) {
          if (c.text.trim()) own.text = own.text ? `${own.text}\n${c.text}` : c.text
          if (c.hasIrContent) own.hasIrContent = true
          ;(own.extraCells ??= []).push(c) // 유닛 방출 순서엔 남긴다
          continue
        }
        let cs = c.colSpan, rs = c.rowSpan
        for (let dc = 1; dc < cs; dc++) if (owner.has(`${r},${cc + dc}`)) { cs = dc; break }
        for (let dr = 1; dr < rs; dr++) {
          let hit = false
          for (let dc = 0; dc < cs; dc++) if (owner.has(`${r + dr},${cc + dc}`)) hit = true
          if (hit) { rs = dr; break }
        }
        const a = { r, c: cc, rs, cs, text: c.text, hasNested: c.hasNested, hasIrContent: c.hasIrContent, headingLines: c.headingLines, cell: c }
        for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) owner.set(`${r + dr},${cc + dc}`, a)
        anchors.push(a)
        if (r + rs > rows) rows = r + rs
        if (cc + cs > cols) cols = cc + cs
      }
    }
    // kordoc buildTableDirect 는 행 수를 tr 수(빈 tr 포함)·앵커 행 중 큰 값으로 잡음 — 참조는 spec
    // 그대로(rowAddr+rowSpan 기반). 유효 파일에서는 두 값이 일치한다. 불일치는 구조 채점에서 드러난다.
  } else {
    // 커서 시뮬레이션 (builder pass1과 동일 의미론, 독립 구현)
    const occupied = []
    rows = rawRows.length
    for (let ri = 0; ri < rawRows.length; ri++) {
      occupied[ri] = occupied[ri] ?? []
      let ci = 0
      for (const c of rawRows[ri]) {
        while (occupied[ri][ci]) ci++
        anchors.push({ r: ri, c: ci, rs: c.rowSpan, cs: c.colSpan, text: c.text, hasNested: c.hasNested, hasIrContent: c.hasIrContent, headingLines: c.headingLines, cell: c })
        for (let dr = 0; dr < c.rowSpan && ri + dr < rows; dr++) {
          occupied[ri + dr] = occupied[ri + dr] ?? []
          for (let dc = 0; dc < c.colSpan; dc++) occupied[ri + dr][ci + dc] = true
        }
        ci += c.colSpan
        if (ci > cols) cols = ci
      }
    }
  }

  // 유닛 방출 순서 — 트림 전 전체 셀의 좌표 순 (트림된 빈 열 셀도 중첩 유닛은 옮겨야 한다)
  const cellOrder = [...anchors].sort((x, y) => x.r - y.r || x.c - y.c).flatMap(a => [a.cell, ...(a.extraCells ?? [])])

  // 후행 빈 열 트림 — builder trimAndReturn 미러 (whitelist: trailing-col-trim).
  // v3.0: 이미지/중첩표/글상자 콘텐츠가 IR 셀 텍스트를 채우므로(![image] 등) 비어있지 않음으로 판정.
  let effectiveCols = cols
  while (effectiveCols > 0) {
    const hasText = anchors.some(a => a.c === effectiveCols - 1 && (normText(a.text) || a.hasIrContent))
    if (hasText) break
    effectiveCols--
  }
  if (effectiveCols < cols && effectiveCols > 0) {
    // 잘린 열에 걸친 병합 셀은 표 폭 안으로 — builder trimAndReturn 의 span 절단 미러
    anchors = anchors.filter(a => a.c < effectiveCols).map(a => (a.c + a.cs > effectiveCols ? { ...a, cs: effectiveCols - a.c } : a))
    cols = effectiveCols
    counters.trimmedCols++
  }

  return { rows, cols, anchors, cellOrder }
}
