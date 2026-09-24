#!/usr/bin/env node
// docx / xlsx / xls / hml(HWPML) 트랙 — 스모크(파싱 성공+비어있지 않음) + 자기참조 GT recall.
// hwpx-ref 패턴 이식: 포맷의 원본 XML에서 텍스트 유닛을 독립 추출해 kordoc md와 정렬.
//
// 유닛 추출 (파서와 코드 0% 공유):
//   docx : word/document.xml 본문 w:p 문단 (w:t 연결, w:instrText 등 필드코드 제외,
//          mc:Fallback 스킵 — Choice 이중 렌더, 텍스트박스 문단은 별도 유닛) + 본문 sectPr 이 참조하는
//          header·footer 파트 문단(같은 글은 한 번, 쪽 번호 필드 표시값·쪽 번호만 남는 파트 제외 — HWPX 머리말 정책 미러)
//   xlsx : xl/worksheets/*.xml 셀 — 문자열 셀(s/inlineStr/str)은 str 유닛,
//          숫자 셀은 num 유닛으로 분리 채점 (서식 적용 숫자·날짜는 표기 차이가 정상이라
//          str만 게이트, num은 보고)
//   xls  : BIFF8 는 XML 이 없어 독립 추출기 대신 같은 파일을 LibreOffice 26.2 로 바꾼 xlsx
//          (corpus/formats/xls-gt/<같은 이름>.xlsx)를 위 xlsx 추출기로 읽은 유닛이 정답. 파서 출력은 .xls 파싱.
//   hml  : 본문 P > TEXT > CHAR 텍스트 (헤더의 스타일 정의는 비대상)
//
// 큰 시트(유닛 > UNIT_CAP): 정렬(alignUnits)은 유닛 수에 초선형이라 25만+ 셀에서 수십 분 걸린다. 그런 시트는
// 셀 단위 multiset 대조로 따로 잰다(bigStr·bigNum — 칸 글이 한 글자라도 다르면 그 칸 전부 miss, 정렬보다 엄격).
//
// 게이트: parseErrors=0 · docxRecall·hmlRecall·xlsxStrRecall ≥ 플로어 (기준선 후 확정)
// 사용법: node bench/formats-sweep.mjs [--gate] [--doc=부분문자열] [--verbose]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { parse } from "../dist/index.js"
import { parseXmlLite } from "./ref/hwpx-ref.mjs"
import { mdToPlain, normKey, unescapeMd } from "./lib/normalize.mjs"
import { alignUnits } from "./lib/align.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

// 게이트 = 무후퇴 플로어 (2026-07-03 2차 상향, 2회 연속 측정 동일 확인:
// docx 0.998903 / xlsxStr 1.0 / hml 0.995974).
// 상향 근거 픽스: ①docx 병합표 그리드 배치 — 밀집 배열을 그리드로 오독해 gridSpan 뒤
// 셀 유실 (niied 0.675→1.0) ②docx 텍스트박스(txbxContent) 수집 + Fallback 스킵
// (kats 0.917→0.9985, arko 0.880→0.9998) ③추출기 시트 순서 사전순→워크북 순서 미러
// (goe str 0.984→1.0 — 파서 무죄, 추출기 순서 비대칭이었음)
// 이전 세대 픽스: 한셀(HCell) xlsx 접두 네임스페이스 인식 · HML P 앵커 표 소실 해소.
// 잔여 미달 (수용): kats "형용사또는명사" 소량 · hml bizinfo 0.973 (글상자/도형 텍스트)
// 2026-07-17 만점 잠금: HML 병합 헤더 셀 소실 수리(parseTable 이중 그리딩 제거) +
// docx OMML whitelist 대칭 + 중첩 링크 언랩 + xlsx num 토큰 multiset·toPrecision(15)
// 정규화로 4지표 전부 1.0 — 새 플로어가 기준. numRecall도 게이트 승격.
// 2026-09-24 모수 확장(docx 36·xlsx 28·xls 15 신설) + xls 트랙·큰 시트 트랙 신설, 전부 1.0 잠금. 종전 파서는 큰 시트
// 8건 중 1만 행 넘는 5건을 1만 행에서 무경고로 잘라 bigStr 0.626·bigNum 0.867 이었다(칸 예산 sheet-blocks 로 수리).
// 추출기 대칭 3건: 날짜 서식 숫자 셀 ISO 미러(xls num 0.958 → 1), 병합이 덮은 숨은 칸 제외(xls str 0.99996·xlsx str
// 0.99996 → 1), DOCX 머리글·바닥글 유닛(파서 1회 방출과 함께 — 구 파서로 재면 docx 0.99848)
const GATES = {
  parseErrors: 0, docxRecall: 1, xlsxStrRecall: 1, hmlRecall: 1, xlsxNumRecall: 1,
  xlsStrRecall: 1, xlsNumRecall: 1, bigStrRecall: 1, bigNumRecall: 1,
}

// 유닛 정렬 상한 — 초대형 스프레드시트(개표결과 25만+ 셀)는 align이 수십 분 걸린다. 시트는 이 상한을 넘으면
// 셀 multiset 대조(bigStr·bigNum)로 따로 재고, docx·hml 은 스모크만(unitCapped 보고).
const UNIT_CAP = 50_000

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

// ─── 유닛 추출기 ────────────────────────────────────

function textOf(node, out = []) {
  for (const ch of node.children) {
    if (typeof ch === "string") out.push(ch)
    else textOf(ch, out)
  }
  return out
}

// 쪽 번호 필드 — 표시값은 마지막으로 그린 쪽의 캐시라 파서가 내지 않는다(HWPX 쪽 번호 컨트롤과 같은 정책, whitelist: page-field)
const PAGE_FIELD_RE = /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b/i

/** docx: 본문 w:p → 유닛. 필드 코드(instrText)·삭제 추적(delText)은 제외.
 *  파서 경계 미러: mc:Fallback은 Choice와 같은 텍스트박스의 이중 렌더라 스킵,
 *  텍스트박스(txbxContent) 문단은 앵커 문단과 별도 유닛 (파서가 별도 블록 출력).
 *  머리글·바닥글: 본문 sectPr 이 참조하는 header·footer 파트의 문단 유닛 — 파서 1회 정책 미러(같은 글은 종류별 한 번) */
async function docxUnits(buf) {
  const zip = await JSZip.loadAsync(buf)
  const doc = zip.file("word/document.xml")
  if (!doc) throw new Error("word/document.xml 없음")
  const rootNode = parseXmlLite(await doc.async("string"))
  let units = []
  const paraText = p => {
    const parts = []
    let fld = null // 필드 상태 — begin 에서 새로(중첩은 파서처럼 바깥을 버린다), separate 뒤가 표시값
    const walkRun = n => {
      for (const c of n.children) {
        if (typeof c === "string") continue
        if (c.tag === "t") { if (!(fld?.display && PAGE_FIELD_RE.test(fld.instr))) parts.push(textOf(c).join("")) }
        else if (c.tag === "tab") parts.push(" ")
        else if (c.tag === "br" || c.tag === "cr") parts.push("\n")
        else if (c.tag === "fldchar") {
          const ty = c.attrs.fldchartype
          if (ty === "begin") fld = { instr: "", display: false }
          else if (ty === "separate" && fld) fld.display = true
          else if (ty === "end") fld = null
        }
        else if (c.tag === "instrtext") { if (fld && !fld.display) fld.instr += textOf(c).join("") }
        else if (c.tag === "deltext") continue
        else if (c.tag === "fldsimple" && PAGE_FIELD_RE.test(c.attrs.instr ?? "")) continue
        // OMML 수식 — 파서는 $LaTeX$로 방출·mdToPlain이 수식 span 제거 (HWPX 수식
        // whitelist와 동일 정책) → GT도 수식 서브트리를 recall 모수에서 제외
        else if (c.tag === "omath" || c.tag === "omathpara") continue
        else if (c.tag === "fallback" || c.tag === "txbxcontent") continue
        else walkRun(c)
      }
    }
    walkRun(p)
    return parts.join("").trim()
  }
  // 텍스트박스 문단 — 파서 collectTextboxParagraphs 미러 (txbxContent 하위 p만, Fallback 스킵)
  const walkTxbx = (node, inTx) => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "fallback") continue
      const now = inTx || ch.tag === "txbxcontent"
      if (now && ch.tag === "p") {
        const t = paraText(ch)
        if (t) units.push(t)
      }
      walkTxbx(ch, now)
    }
  }
  const walkP = node => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "fallback") continue
      if (ch.tag === "p") {
        const t = paraText(ch)
        if (t) units.push(t)
        walkTxbx(ch, false) // 문단 안 텍스트박스 문단 — 별도 유닛
      } else walkP(ch)
    }
  }
  walkP(rootNode)

  // 머리글·바닥글
  const bodyUnits = units
  const relsFile = zip.file("word/_rels/document.xml.rels")
  const rels = new Map()
  if (relsFile) for (const r of findAll(parseXmlLite(await relsFile.async("string")), "relationship")) rels.set(r.attrs.id, r.attrs.target)
  for (const kind of ["headerreference", "footerreference"]) {
    const seenParts = new Set(), seen = new Set()
    for (const ref of findAll(rootNode, kind)) {
      const target = rels.get(ref.attrs.id)
      if (!target) continue
      const path = target.startsWith("/") ? target.slice(1) : `word/${target}`
      if (seenParts.has(path) || !zip.file(path)) continue
      seenParts.add(path)
      units = []
      const xml = await zip.file(path).async("string")
      walkP(parseXmlLite(xml))
      // 쪽 번호 크롬 — 쪽 번호 필드가 있고 남은 글에 문자가 없는 파트는 파서가 통째로 뺀다(HWPX hasPageAutoNum 미러)
      if (/(?:w:instr="|<w:instrText[^>]*>)\s*(?:PAGE|NUMPAGES|SECTIONPAGES)\b/i.test(xml) && !units.some(u => /\p{L}/u.test(u))) continue
      for (const u of units) {
        if (seen.has(normKey(u))) continue
        seen.add(normKey(u))
        bodyUnits.push(u)
      }
    }
  }
  return { units: bodyUnits }
}

/** 시트 파일 순서 — 파서 미러 (workbook.xml 시트 순서 + rels 매핑, 실패 시 숫자 정렬).
 *  Object.keys().sort()는 사전순이라 sheet10이 sheet2 앞에 와 유닛 순서가 md와 어긋난다
 *  (align은 순서 민감 — goe 22시트에서 거짓 miss) */
async function orderedSheetPaths(zip) {
  const numeric = Object.keys(zip.files)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1])
  try {
    const relMap = new Map()
    const walkRel = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "relationship") relMap.set(ch.attrs.id, ch.attrs.target)
        else walkRel(ch)
      }
    }
    walkRel(parseXmlLite(await zip.file("xl/_rels/workbook.xml.rels").async("string")))
    const sheets = []
    const walkSheet = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "sheet") sheets.push(ch)
        else walkSheet(ch)
      }
    }
    walkSheet(parseXmlLite(await zip.file("xl/workbook.xml").async("string")))
    const paths = sheets
      .map((el, i) => {
        let t = relMap.get(el.attrs.id)
        if (!t) return `xl/worksheets/sheet${i + 1}.xml`
        if (t.startsWith("/")) t = t.slice(1)
        else if (!t.startsWith("xl/")) t = `xl/${t}`
        return t
      })
      .filter(p => zip.file(p))
    return paths.length ? paths : numeric
  } catch {
    return numeric
  }
}

/** 요소 이름(소문자, 접두어 없음)으로 하위 노드 전부 */
function findAll(node, tag, out = []) {
  for (const ch of node.children) {
    if (typeof ch === "string") continue
    if (ch.tag === tag) out.push(ch)
    else findAll(ch, tag, out)
  }
  return out
}

/** "AB12" → [행, 열] (0부터) */
function cellRefRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref ?? "")
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return [+m[2] - 1, col - 1]
}

// 날짜 서식 숫자 셀 — kordoc 출력 계약(CHANGELOG "XLSX/XLS 날짜 셀 변환": 날짜 시리얼 → ISO 8601, 시각 토큰이
// 있으면 초까지)의 미러 (whitelist: xlsx-date-iso). 없으면 날짜 셀마다 정답 "39083" ↔ 출력 "2007-01-01" 거짓 miss
// (xls web025·web040 실측). 판정은 ECMA-376 §18.8.30 내장 번호 14~22·45~47 과 formatCode 의 y·m·d·h·s 토큰
// (따옴표 리터럴·[]·역슬래시 이스케이프 제외). 1900 체계는 없는 날 1900-02-29(시리얼 60) 앞을 하루 당긴다.
// 27~36·50~58 은 동아시아 판 내장 서식(한국어판: 32·33 시각, 나머지 날짜 — 파서와 같은 표)
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58])
const BUILTIN_TIME_FMT = new Set([18, 19, 20, 21, 22, 45, 46, 47, 32, 33])
function dateKindOf(fmtId, customFmt) {
  if (BUILTIN_DATE_FMT.has(fmtId)) return BUILTIN_TIME_FMT.has(fmtId) ? "datetime" : "date"
  const code = customFmt.get(fmtId)
  if (code === undefined) return null
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "")
  if (!/[ymdh]/i.test(bare)) return null
  return /[hs]/i.test(bare) ? "datetime" : "date"
}
function serialToIso(serial, date1904, kind) {
  if (!Number.isFinite(serial) || serial < 0) return null
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial
  const d = new Date(Math.round((days - 25569) * 86400000)) // 25569 = 1970-01-01 의 시리얼 (기준일 1899-12-30)
  if (isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return null
  return d.toISOString().slice(0, kind === "datetime" ? 19 : 10)
}

/** xl/styles.xml → cellXfs 순번별 날짜 종류 (날짜 아닌 xf 는 없음) */
async function styleDateKinds(zip) {
  const kinds = new Map()
  const f = zip.file("xl/styles.xml")
  if (!f) return kinds
  const root = parseXmlLite(await f.async("string"))
  const customFmt = new Map(findAll(root, "numfmt").map(el => [+el.attrs.numfmtid, el.attrs.formatcode ?? ""]))
  const cellXfs = findAll(root, "cellxfs")[0]
  if (!cellXfs) return kinds
  findAll(cellXfs, "xf").forEach((xf, i) => {
    const kind = dateKindOf(+xf.attrs.numfmtid, customFmt)
    if (kind) kinds.set(i, kind)
  })
  return kinds
}

/** xlsx: 셀 값 유닛 — 문자열/숫자 분리.
 *  병합 범위가 덮은 셀(왼쪽 위 칸이 아닌 칸)은 뺀다: 엑셀·LibreOffice 는 병합 범위의 왼쪽 위 칸 값만 그리고 덮인 칸 값은
 *  화면·인쇄 어디에도 안 나온다(병합 시 "왼쪽 위 값만 남긴다"). 파서도 덮인 칸을 내지 않는다 — 정답도 보이는 칸만
 *  (xls web023 C46 "지원번호: 14293" 이 제목 병합 B45:AL47 아래에 숨어 있던 것 실측, whitelist: merge-hidden-cell) */
async function xlsxUnits(buf) {
  const zip = await JSZip.loadAsync(buf)
  const sstFile = zip.file("xl/sharedStrings.xml")
  const sst = []
  if (sstFile) {
    const sstRoot = parseXmlLite(await sstFile.async("string"))
    const walkSi = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "si") sst.push(textOf(ch).join(""))
        else walkSi(ch)
      }
    }
    walkSi(sstRoot)
  }
  const dateKinds = await styleDateKinds(zip)
  const wbFile = zip.file("xl/workbook.xml")
  const wbPr = wbFile ? findAll(parseXmlLite(await wbFile.async("string")), "workbookpr")[0] : null
  const date1904 = wbPr?.attrs.date1904 === "1" || wbPr?.attrs.date1904 === "true"
  const strUnits = [], numUnits = []
  const sheetNames = await orderedSheetPaths(zip)
  for (const name of sheetNames) {
    const sheetRoot = parseXmlLite(await zip.file(name).async("string"))
    // 병합이 덮은 칸 (행 → 열 집합)
    const covered = new Map()
    for (const mc of findAll(sheetRoot, "mergecell")) {
      const [a, b] = (mc.attrs.ref ?? "").split(":").map(cellRefRC)
      if (!a || !b) continue
      for (let r = a[0]; r <= b[0]; r++) {
        for (let c = a[1]; c <= b[1]; c++) {
          if (r === a[0] && c === a[1]) continue
          let s = covered.get(r)
          if (!s) covered.set(r, (s = new Set()))
          s.add(c)
        }
      }
    }
    const walkC = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "c") {
          const rc = cellRefRC(ch.attrs.r)
          if (rc && covered.get(rc[0])?.has(rc[1])) continue
          const t = ch.attrs.t ?? "n"
          let v = null
          for (const c of ch.children) {
            if (typeof c === "string") continue
            if (c.tag === "v") v = textOf(c).join("")
            else if (c.tag === "is") v = textOf(c).join("")
          }
          if (v === null || v === "") continue
          if (t === "s") { const s = sst[parseInt(v, 10)]; if (s?.trim()) strUnits.push(s.trim()) }
          else if (t === "inlineStr" || t === "str") { if (v.trim()) strUnits.push(v.trim()) }
          else {
            const kind = t === "n" && ch.attrs.s !== undefined ? dateKinds.get(+ch.attrs.s) : undefined
            numUnits.push((kind && serialToIso(parseFloat(v), date1904, kind)) || v.trim())
          }
        } else walkC(ch)
      }
    }
    walkC(sheetRoot)
  }
  return { strUnits, numUnits }
}

/** hml: BODY 하위 P > TEXT > CHAR 텍스트 유닛 (HEAD의 스타일 정의 제외).
 *  파서 경계 미러: P 유닛 = 자기 CHAR 텍스트만 (TABLE/내부 P 진입 금지 — 셀 P는
 *  walkBody 재귀가 각자 유닛으로), FOOTNOTE류는 CHAR textOf에 이미 포함되므로
 *  별도 유닛 금지 (이중 계상 방지). */
function hmlUnits(xmlText) {
  const rootNode = parseXmlLite(xmlText)
  const units = []
  const walkBody = (node, inBody) => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "footnote" || ch.tag === "endnote" || ch.tag === "header" || ch.tag === "footer") continue
      const isBody = inBody || ch.tag === "body"
      if (ch.tag === "p" && isBody) {
        const parts = []
        const walkChar = n => {
          for (const c of n.children) {
            if (typeof c === "string") continue
            if (c.tag === "char") parts.push(textOf(c).join(""))
            else if (c.tag === "tab") parts.push(" ")
            else if (c.tag === "table" || c.tag === "p") continue // 구조 자식은 walkBody 소관
            else walkChar(c)
          }
        }
        walkChar(ch)
        const t = parts.join("").trim()
        if (t) units.push(t)
        // P 안의 표/개체는 자식 P를 각자 유닛으로 (재귀)
        walkBody(ch, isBody)
      } else walkBody(ch, isBody)
    }
  }
  walkBody(rootNode, false)
  return { units }
}

// ─── recall 계산 (alignUnits 재사용) ─────────────────
function recallOf(unitTexts, md) {
  const mdKey = normKey(mdToPlain(md).text)
  const units = unitTexts.map((t, i) => ({ id: i, kind: "body", text: normKey(t) })).filter(u => u.text)
  if (units.length === 0) return { recall: 1, refChars: 0, matched: 0, misses: [] }
  const { perUnit } = alignUnits(units, mdKey)
  let total = 0, matched = 0
  const misses = []
  for (let i = 0; i < units.length; i++) {
    total += perUnit[i].total
    matched += perUnit[i].matched
    if (perUnit[i].matched < perUnit[i].total) misses.push({ text: units[i].text.slice(0, 50), miss: perUnit[i].total - perUnit[i].matched })
  }
  misses.sort((a, b) => b.miss - a.miss)
  return { recall: total ? matched / total : 1, refChars: total, matched, misses: misses.slice(0, 5) }
}

/** 숫자 셀 recall — 셀 토큰 multiset 대조. normKey가 인접 숫자 셀을 한 자리수-run으로
 * 이어붙여 substring 정렬이 유닛을 쪼개는 거짓 miss(goe 0.984, IR 대조 무손실 실측)를
 * 차단한다. 숫자 셀은 파서가 v 원문을 셀 토큰으로 방출하므로 정확 토큰 대조가 진실. */
function numRecallOf(unitTexts, md) {
  if (unitTexts.length === 0) return { recall: 1, refChars: 0, matched: 0, misses: [] }
  // 파서는 숫자 셀을 parseFloat(x.toPrecision(15)).toString()로 방출(IEEE 754 오차 제거,
  // src/xlsx/parser.ts) — GT의 float 꼬리("3046.9300999999996")도 같은 왕복으로 정규화
  const canon = s => {
    const x = Number(s)
    return Number.isFinite(x) ? parseFloat(x.toPrecision(15)).toString() : s
  }
  const freq = new Map()
  for (const tok of md.split(/[|\n]|<\/?(?:t[dhr]|table|thead|tbody)\b[^>]*>|<br\s*\/?>/i)) {
    const t = tok.trim()
    if (t) { const k = canon(t); freq.set(k, (freq.get(k) ?? 0) + 1) }
  }
  let total = 0, matched = 0
  const missFreq = new Map()
  for (const raw of unitTexts) {
    const t = canon(raw.trim())
    if (!t) continue
    total += t.length
    const n = freq.get(t) ?? 0
    if (n > 0) { matched += t.length; freq.set(t, n - 1) }
    else missFreq.set(t, (missFreq.get(t) ?? 0) + 1)
  }
  const misses = [...missFreq].map(([text, cnt]) => ({ text: text.slice(0, 50), miss: text.length * cnt }))
  misses.sort((a, b) => b.miss - a.miss)
  return { recall: total ? matched / total : 1, refChars: total, matched, misses: misses.slice(0, 5) }
}

const HTML_ENTITY = { lt: "<", gt: ">", quot: "\"", "#39": "'", amp: "&" }
const decodeEntities = s => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => HTML_ENTITY[e])

/** 큰 시트 문자열 셀 recall — 셀 토큰 multiset 대조 (numRecallOf 의 문자열판). md 를 표 칸으로 가른다:
 *  이스케이프 안 된 | (GFM 칸)·줄·표 태그. 칸 안 <br> 은 칸 글의 줄바꿈이라 가르지 않고 줄로 되돌린다
 *  (이스케이프된 \<br> 은 리터럴 글). 양쪽 normKey — 공백 차(균등배분 결합·줄바꿈)는 흡수, 글자 차는 칸 전부 miss. */
function strCellRecallOf(unitTexts, md) {
  const freq = new Map()
  const add = tok => { const k = normKey(unescapeMd(tok)); if (k) freq.set(k, (freq.get(k) ?? 0) + 1) }
  for (const line of md.split("\n")) {
    if (/(?<!\\)<\/?(?:table|thead|tbody|tr|td|th)\b/i.test(line)) {
      // HTML 표 줄(병합 칸 표) — v4.15.0 부터 칸 글은 HTML 엔티티로 나간다(builder escapeHtmlCellText). 태그로 가르고 칸 줄바꿈 <br> 을
      // 줄로 되돌린 뒤 엔티티를 푼다(원문 글자 "<br>" 은 &lt;br&gt; 라 태그와 갈린다) — mdToPlain 의 HTML 표 줄 규칙과 같다
      for (const tok of line.split(/<\/?(?:t[dhr]|table|thead|tbody)\b[^>]*>/i)) add(decodeEntities(tok.replace(/<br\s*\/?>/gi, "\n")))
    } else {
      for (const tok of line.split(/(?<!\\)\|/)) add(tok.replace(/(?<!\\)<br\s*\/?>/gi, "\n"))
    }
  }
  let total = 0, matched = 0
  const missFreq = new Map()
  for (const raw of unitTexts) {
    const t = normKey(raw)
    if (!t) continue
    total += t.length
    const n = freq.get(t) ?? 0
    if (n > 0) { matched += t.length; freq.set(t, n - 1) }
    else missFreq.set(t, (missFreq.get(t) ?? 0) + 1)
  }
  const misses = [...missFreq].map(([text, cnt]) => ({ text: text.slice(0, 50), miss: text.length * cnt }))
  misses.sort((a, b) => b.miss - a.miss)
  return { recall: total ? matched / total : 1, refChars: total, matched, misses: misses.slice(0, 5) }
}

// ─── 메인 ──────────────────────────────────────────
const t0 = performance.now()
const base = join(root, "corpus", "formats")
const rows = []
let parseErrors = 0
let gtMissing = 0
const agg = {
  docx: { m: 0, t: 0 }, xlsxStr: { m: 0, t: 0 }, xlsxNum: { m: 0, t: 0 }, xlsStr: { m: 0, t: 0 }, xlsNum: { m: 0, t: 0 },
  bigStr: { m: 0, t: 0 }, bigNum: { m: 0, t: 0 }, hml: { m: 0, t: 0 },
}

/** xlsx·xls 공통 채점 — 정답 xlsx 유닛(str/num) vs 파서 md. 유닛 > UNIT_CAP 이면 큰 시트 multiset 트랙 */
async function scoreSheet(row, gtBuf, md, key) {
  const { strUnits, numUnits } = await xlsxUnits(gtBuf)
  const n = strUnits.length + numUnits.length
  const big = n > UNIT_CAP
  const rs = big ? strCellRecallOf(strUnits, md) : recallOf(strUnits, md)
  const rn = numRecallOf(numUnits, md)
  row.strRecall = round(rs.recall); row.numRecall = round(rn.recall)
  row.refChars = rs.refChars + rn.refChars; row.topMisses = rs.misses
  if (rn.recall < 1) row.topNumMisses = rn.misses
  if (big) row.bigUnits = n
  const ks = big ? "bigStr" : `${key}Str`, kn = big ? "bigNum" : `${key}Num`
  agg[ks].m += rs.matched; agg[ks].t += rs.refChars
  agg[kn].m += rn.matched; agg[kn].t += rn.refChars
}

for (const kind of ["docx", "xlsx", "xls", "hml"]) {
  let files = []
  try {
    files = (await readdir(join(base, kind))).filter(n => !n.startsWith(".")).sort()
  } catch { continue }
  for (const name of files) {
    const rel = `${kind}/${name}`
    if (docFilter && !rel.includes(docFilter)) continue
    const buf = await readFile(join(base, kind, name))
    const t = performance.now()
    let row = { file: rel, kind }
    try {
      const res = await parse(Buffer.from(buf), { filename: name })
      if (!res.success) {
        parseErrors++
        row = { ...row, ok: false, error: `${res.code}: ${String(res.error).slice(0, 120)}` }
      } else if (!res.markdown?.trim()) {
        parseErrors++
        row = { ...row, ok: false, error: "빈 마크다운" }
      } else {
        row.ok = true
        row.mdChars = res.markdown.length
        if (kind === "docx") {
          const { units } = await docxUnits(buf)
          if (units.length > UNIT_CAP) { row.unitCapped = units.length }
          else {
            const r = recallOf(units, res.markdown)
            row.recall = round(r.recall); row.refChars = r.refChars; row.topMisses = r.misses
            agg.docx.m += r.matched; agg.docx.t += r.refChars
          }
        } else if (kind === "xlsx") {
          await scoreSheet(row, buf, res.markdown, "xlsx")
        } else if (kind === "xls") {
          // 정답지 = LibreOffice 로 바꾼 같은 이름의 xlsx (없으면 모수 결함 — population 게이트에서 막는다)
          let gtBuf = null
          try { gtBuf = await readFile(join(base, "xls-gt", name.replace(/\.xls$/i, ".xlsx"))) } catch { /* 아래 */ }
          if (gtBuf) await scoreSheet(row, gtBuf, res.markdown, "xls")
          else { row.gtMissing = true; gtMissing++ }
        } else {
          const { units } = hmlUnits(buf.toString("utf8"))
          if (units.length > UNIT_CAP) { row.unitCapped = units.length }
          else {
            const r = recallOf(units, res.markdown)
            row.recall = round(r.recall); row.refChars = r.refChars; row.topMisses = r.misses
            agg.hml.m += r.matched; agg.hml.t += r.refChars
          }
        }
      }
    } catch (err) {
      parseErrors++
      row = { ...row, ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
    row.ms = Math.round(performance.now() - t)
    rows.push(row)
    if (verbose) {
      const score = row.strRecall !== undefined ? `${row.strRecall}/${row.numRecall}${row.bigUnits ? " (큰 시트)" : ""}` : (row.recall ?? "-")
      console.error(`${kind} ${row.ok ? score : "ERR"} ${rel}${row.error ? " — " + row.error : ""}${row.gtMissing ? " — 정답지 없음" : ""}`)
    }
  }
}

const rate = a => (a.t ? a.m / a.t : 1)
// 모수 하한 (2026-07-05 실측 docx 7/xlsx 11/hml 9의 ~절반) — 폴더 누락·미동기 시
// catch{continue}+rate(0/0)=1 로 조용한 만점 PASS가 나는 것 방지 (리뷰 #14).
// xls 는 2026-09-24 신설 모수 15건의 절반, 큰 시트는 유닛 > UNIT_CAP 시트 8건의 절반
const MIN_POP = { docx: 4, xlsx: 6, xls: 7, hml: 5, big: 4 }
const kindCount = k => rows.filter(r => r.kind === k).length
const bigCount = rows.filter(r => r.bigUnits).length
const gate = (a, k) => ({ value: round(rate(a)), threshold: GATES[k], pass: rate(a) >= GATES[k] })
const gates = {
  parseErrors: { value: parseErrors, threshold: GATES.parseErrors, pass: parseErrors === 0 },
  docxRecall: gate(agg.docx, "docxRecall"),
  xlsxStrRecall: gate(agg.xlsxStr, "xlsxStrRecall"),
  hmlRecall: gate(agg.hml, "hmlRecall"),
  xlsxNumRecall: gate(agg.xlsxNum, "xlsxNumRecall"),
  xlsStrRecall: gate(agg.xlsStr, "xlsStrRecall"),
  xlsNumRecall: gate(agg.xlsNum, "xlsNumRecall"),
  bigStrRecall: gate(agg.bigStr, "bigStrRecall"),
  bigNumRecall: gate(agg.bigNum, "bigNumRecall"),
  population: {
    value: `docx ${kindCount("docx")}/xlsx ${kindCount("xlsx")}/xls ${kindCount("xls")}/hml ${kindCount("hml")}/큰 시트 ${bigCount}` +
      (gtMissing ? ` · xls 정답지 없음 ${gtMissing}` : ""),
    threshold: `≥ ${MIN_POP.docx}/${MIN_POP.xlsx}/${MIN_POP.xls}/${MIN_POP.hml}/${MIN_POP.big} · 정답지 없음 0`,
    pass: gtMissing === 0 && (docFilter != null ||
      (kindCount("docx") >= MIN_POP.docx && kindCount("xlsx") >= MIN_POP.xlsx && kindCount("xls") >= MIN_POP.xls &&
        kindCount("hml") >= MIN_POP.hml && bigCount >= MIN_POP.big)),
  },
}
const pass = Object.values(gates).every(g => g.pass)

const report = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - t0),
  files: rows.length, pass, gates,
  xlsxNumRecall: round(rate(agg.xlsxNum)), // 보고 전용 (서식 숫자·날짜 표기 차이)
  rows,
}
await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "formats.json"), JSON.stringify(report, null, 1))

console.log(`\n══ formats 트랙 — ${rows.length}건 (docx ${kindCount("docx")} / xlsx ${kindCount("xlsx")} / xls ${kindCount("xls")} / hml ${kindCount("hml")}, 큰 시트 ${bigCount}) (${Math.round(report.elapsedMs / 1000)}s) ══`)
for (const [k, g] of Object.entries(gates)) console.log(`  ${g.pass ? "✅" : "❌"} ${k.padEnd(14)} ${g.value} (기준 ${g.threshold})`)
for (const r of rows.filter(r => r.unitCapped)) console.log(`  ⚠ recall 제외(유닛 ${r.unitCapped} > ${UNIT_CAP}): ${r.file} — 스모크만`)
const score = r => Math.min(r.recall ?? 1, r.strRecall ?? 1, r.numRecall ?? 1)
const worst = rows.filter(r => r.ok && score(r) < 1).sort((a, b) => score(a) - score(b)).slice(0, 10)
for (const w of worst) {
  const s = w.strRecall !== undefined ? `str ${w.strRecall} num ${w.numRecall}` : `${w.recall}`
  console.log(`  ${s} ${w.file} ${JSON.stringify(w.topMisses?.[0] ?? w.topNumMisses?.[0] ?? "")}`)
}
for (const r of rows.filter(r => !r.ok)) console.log(`  ERR ${r.file} — ${r.error}`)
console.log(`report → bench/out/formats.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
