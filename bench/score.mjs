#!/usr/bin/env node
// 문서 파싱 정확도 채점기 — "정보손실 0%" 객관 측정.
//
// 사용법: node bench/score.mjs [corpus하위경로] [--only=hwpx|pdf|hwp] [--doc=부분문자열] [--verbose]
//
// 트랙:
//   HWPX : 자기참조 XML GT — text_recall / phantom / table_structure / cell_content / order / specials
//   PDF  : pdftotext+pdfjs consensus 교차검증 — pdf_cross_coverage (needsOcr 페이지 격리)
//   HWP5 : 같은 newsId의 .hwpx 쌍이 있으면 상호 정렬 기반 2차 트랙 (게이트 없음, 보고만)
//
// 출력: bench/out/score.json + 콘솔 요약. 게이트 실패 시 exit code 1.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, extname, basename, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, flattenLayoutTables, blocksToMarkdown } from "../dist/index.js"
import { extractRef } from "./ref/hwpx-ref.mjs"
import { pdfCrossCoverage } from "./ref/pdf-consensus.mjs"
import { GATES, BLACKLIST, WHITELIST } from "./ref/policy.mjs"
import { normKey, normText, mdToPlain } from "./lib/normalize.mjs"
import { alignUnits, lisLength, levArr } from "./lib/align.mjs"
import { collectIrGrids, scoreTables } from "./lib/table-score.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const subPath = args.find(a => !a.startsWith("--")) ?? ""
const only = (args.find(a => a.startsWith("--only=")) ?? "").split("=")[1] ?? null
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null
const verbose = args.includes("--verbose")
const corpusDir = join(root, "corpus", subPath)
const outDir = join(root, "out")

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(hwpx|hwp|pdf)$/i.test(e.name)) yield p
  }
}

const round = (x, d = 4) => (x === null || x === undefined ? null : +x.toFixed(d))

// 암호 문서 — 샘플 파일명에 열기 암호를 적어 두는 관례(rhwp "…-password-123456.hwp")가 있으면 그 암호로
// 연다. 복호화 경로의 스모크가 되고, 자기참조 GT(평문 XML)는 만들 수 없으므로 HWPX 는 파싱 성공만 본다
const passwordOf = file => /password-(\w+)/.exec(basename(file))?.[1]
const parseOpts = file => ({ filename: basename(file), ...(passwordOf(file) ? { password: passwordOf(file) } : {}) })

// ─── HWPX 채점 ──────────────────────────────────────

async function scoreHwpx(file, buf) {
  const res = await parse(buf, parseOpts(file))
  // 암호를 모르는 실문서 암호 HWPX(정책브리핑 첨부 등 — 같은 보도자료의 HWP·PDF 판은 평문) 는 ENCRYPTED 로 거절하는 것이 올바른
  // 동작이다. 그 코드인지만 확인하고 채점에서 뺀다(다른 실패 코드는 그대로 실패)
  if (!res.success && res.code === "ENCRYPTED" && !passwordOf(file)) return { ok: true, encrypted: true, locked: true }
  if (!res.success) return { ok: false, stage: "parse", error: res.error }
  if (passwordOf(file)) return { ok: true, encrypted: true }

  let ref
  try {
    ref = await extractRef(buf)
  } catch (err) {
    return { ok: false, stage: "ref", error: String(err?.message ?? err) }
  }

  const { text: plain, eqCount: mdEqCount, footnoteCount: mdFnCount } = mdToPlain(res.markdown)
  const mdKey = normKey(plain)

  // ── text_recall + order + phantom ──
  const unitsForAlign = ref.units.map(u => ({ id: u.id, kind: u.kind, text: normKey(u.text), tableIdx: u.tableIdx }))
  const { perUnit, buf: cbuf } = alignUnits(unitsForAlign, mdKey)

  // 머리말/꼬리말 — 0/1회 허용 소비 (recall 모수 제외, phantom 제외; 2회+ = 정책 위반)
  // 참조는 조각 목록(문단 글·표 셀 글·글상자 글, 문서 순서) — 파서는 머리말 표를 " / "·줄바꿈으로
  // 평탄화하므로 조각 사이엔 본문 문자 없는 구분자만 허용해 이어 찾는다. 2단계: 전 머리말을 먼저
  // 1회씩 소비한 뒤 잔여 재등장만 위반으로 센다(한 머리말이 다른 머리말 글의 앞부분이면 1단계
  // 동시 검사가 거짓 위반을 냈다 — exam_social 홀/짝 머리말). 본문 문자 6자 미만 짧은 머리말은
  // 우연 일치 위험이 커서 종전엔 채점에서 뺐는데, 그러면 1회 방출이 phantom 으로 남는다("대외주의"
  // "상공신문") — 파서가 머리말을 문서 첫머리, 꼬리말을 끝에 두므로 그 구간에서만 소비한다
  let headerViolations = 0
  const isContent = ch => /[\p{L}\p{N}]/u.test(ch)
  const findParts = (parts, from = 0) => {
    for (let p0 = cbuf.find(parts[0], from); p0 !== -1; p0 = cbuf.find(parts[0], p0 + 1)) {
      let end = p0 + parts[0].length
      let ok = true
      for (let i = 1; i < parts.length && ok; i++) {
        // 다음 조각은 본문 문자 없는 구분자 뒤 어디서든 (조각 자신이 "(" 같은 구두점으로 시작할 수 있다)
        let j = end
        for (;;) {
          if (mdKey.startsWith(parts[i], j) && cbuf.isFree(j, j + parts[i].length)) { end = j + parts[i].length; break }
          if (j >= mdKey.length || isContent(mdKey[j])) { ok = false; break }
          j++
        }
      }
      if (ok) return [p0, end]
    }
    return null
  }
  const pageTexts = [
    ...ref.specials.headers.map(h => ({ parts: h, header: true })),
    ...ref.specials.footers.map(h => ({ parts: h, header: false })),
  ].map(x => ({ ...x, parts: x.parts.map(normKey).filter(Boolean) })).filter(x => x.parts.length)
  const bodyStart = cbuf.intervals.length ? cbuf.intervals[0][0] : mdKey.length
  const bodyEnd = cbuf.intervals.length ? cbuf.intervals[cbuf.intervals.length - 1][1] : 0
  const consumedPT = []
  for (const pt of pageTexts) {
    const short = pt.parts.join("").replace(/[^\p{L}\p{N}]/gu, "").length < 6
    const hit = findParts(pt.parts, short && !pt.header ? bodyEnd : 0)
    if (!hit) continue
    if (short && (pt.header ? hit[1] > bodyStart : hit[0] < bodyEnd)) continue
    cbuf.consume(hit[0], hit[1])
    consumedPT.push(pt)
  }
  for (const pt of consumedPT) if (findParts(pt.parts)) headerViolations++

  // per-kind recall
  const byKind = {}
  let matchedTotal = 0, refTotal = 0, maxMissRun = 0
  const misses = []
  for (let i = 0; i < perUnit.length; i++) {
    const r = perUnit[i]
    // 본문 문자(문자/숫자) 없는 유닛(별표/구두점-only 마스킹)은 recall 모수 제외 —
    // phantom("본문 문자만 카운트")·순서 채점(마스킹 제외)과 대칭. normKey 공백 제거로
    // 인접 마스킹이 GT/MD에서 다르게 합쳐져 multiset 단편화 거짓-미스가 나는 함정 차단.
    // (align 소비는 이미 끝났으므로 phantom 오염 없음)
    if (!/[\p{L}\p{N}]/u.test(unitsForAlign[i].text)) continue
    const k = r.kind
    byKind[k] = byKind[k] ?? { matched: 0, total: 0, units: 0 }
    byKind[k].matched += r.matched
    byKind[k].total += r.total
    byKind[k].units++
    matchedTotal += r.matched
    refTotal += r.total
    if (r.runMiss > maxMissRun) maxMissRun = r.runMiss
    if (r.matched < r.total) {
      misses.push({
        kind: k,
        lost: r.total - r.matched,
        runMiss: r.runMiss,
        unitHead: normText(ref.units[i].text).slice(0, 70),
        missSnippet: r.missSnippet ?? (r.pos === -1 ? normText(ref.units[i].text).slice(0, 80) : ""),
      })
    }
  }
  misses.sort((a, b) => b.lost - a.lost)
  const recall = refTotal ? matchedTotal / refTotal : 1

  // phantom — 미소비 구간의 "본문 문자"(문자/숫자)만 카운트.
  // 구두점·구분기호(평탄화 ' / ' 등 의도적 아티팩트)는 제외 (whitelist: nested-flatten)
  // 자동번호 관용: 파서가 의도적으로 실체화한 자동부호("1." "가." "①" 등)는 ref hp:t
  // 원문에 없어 미소비로 남는다 — ref가 NUMBER/BULLET heading 문단을 실제로 쓴 문서에
  // 한해, 매칭 소비 구간 직전에 붙은(세그먼트 끝 b가 소비 구간과 인접) 세그먼트 전체가
  // 자동번호 패턴과 정확 일치하는 ≤3자만 관용. 오염 문자가 섞이면 패턴 불일치로 계상.
  // 한컴 번호 서식 전 계열 — 숫자·가나다·자모(HANGUL_JAMO "ㄱ.")·원문자·로마자(ROMAN "I."·"ⅰ")·
  // 라틴 1자, 그리고 괄호형 "(1)"·"(가)"(paraHead "(^5)"). 종전엔 괄호형·로마자가 빠져 SO-SUEOP
  // 개요 번호 "(1) 주제"·"I. 소설의 이해"(한컴 PDF 실렌더 동일)가 phantom 으로 셌다
  const AUTONUM_TOKEN = "(?:\\d{1,2}|[가-힣]|[ㄱ-ㅎ]|[①-⑳㉑-㉟㊱-㊿]|[ⅰ-ⅻⅠ-Ⅻ]|[IVXivx]{1,4}|[A-Za-z])"
  const AUTONUM_RE = new RegExp(`^(?:\\(${AUTONUM_TOKEN}\\)|${AUTONUM_TOKEN}[.)]?)$`)
  const hasAutoNumParas = (ref.counters.autoNumHeadingParas ?? 0) > 0
  const unconsumed = cbuf.unconsumed()
  let phantomChars = 0
  const phantomSnips = []
  for (const [a, b] of unconsumed) {
    const seg = mdKey.slice(a, b)
    if (hasAutoNumParas && b < mdKey.length && AUTONUM_RE.test(seg)) continue
    const content = (seg.match(/[\p{L}\p{N}]/gu) ?? []).length
    phantomChars += content
    if (content >= 4) phantomSnips.push(seg.slice(0, 80))
  }
  phantomSnips.sort((a, b) => b.length - a.length)
  const phantomRate = mdKey.length ? phantomChars / mdKey.length : 0

  // 블랙리스트 (원본 마크다운 정확 매칭)
  const blacklistHits = BLACKLIST.filter(b => b.re.test(res.markdown)).map(b => b.id)

  // ── order (표는 1유닛, 미매칭 모수 제외) ──
  const orderSeq = []
  // 비고유(중복) 텍스트는 multiset 정렬에서 귀속이 임의라 순서가 정의되지 않으므로
  // (예: 마스킹된 '******' 폼 필드, 반복 서식) 순서 모수에서 제외 — 고유 유닛만 채점.
  // 셀-본문 간 충돌도 귀속 모호성을 만들므로 전체 유닛 기준으로 빈도를 센다.
  const textFreq = new Map()
  for (let i = 0; i < perUnit.length; i++) {
    const k = unitsForAlign[i].text
    if (k) textFreq.set(k, (textFreq.get(k) ?? 0) + 1)
  }
  // 내용이 동일한 표(반복 서식 템플릿)는 multiset 정렬에서 셀 귀속이 임의라 순서가
  // 정의되지 않음 — 본문 중복 제외와 같은 논리로 순서 모수에서 제외.
  const tableSig = ref.tables.map(t => t.cells.map(c => normKey(c.text)).sort().join(""))
  const sigFreq = new Map()
  for (let ti = 0; ti < ref.tables.length; ti++) {
    if (!ref.tables[ti].nested) sigFreq.set(tableSig[ti], (sigFreq.get(tableSig[ti]) ?? 0) + 1)
  }
  const tableFirstPos = new Map()
  for (let i = 0; i < perUnit.length; i++) {
    const r = perUnit[i]
    const u = ref.units[i]
    if (u.kind === "cell") {
      if (u.tableIdx === undefined || r.pos < 0 || r.matched === 0) continue
      // 중첩표 셀은 부모 셀 내부에 렌더링(v3.0, whitelist: nested-in-cell) — 부모 표가
      // 이미 순서 모수에 있으므로 이중 채점하지 않는다. 최상위 표만 순서 채점.
      if (ref.tables[u.tableIdx]?.nested) continue
      if (sigFreq.get(tableSig[u.tableIdx]) !== 1) continue
      // 표 위치 앵커 = 가장 긴 "완전 매칭 + 문서 내 고유" 셀 — 짧거나 중복된 토큰
      // ("연번", 반복 업체명)이 다른 표 영역에 귀속되어 표 위치를 끌어가는 것을 방지.
      // 고유 앵커가 하나도 없는 표는 귀속 불능 — 순서 모수 제외 (아래 w>0 필터).
      const txt = unitsForAlign[i].text
      const contentLen = (txt.match(/[\p{L}\p{N}]/gu) ?? []).length
      const reliable = r.matched === r.total && contentLen >= 4 && textFreq.get(txt) === 1
      const w = reliable ? txt.length : 0
      const cur = tableFirstPos.get(u.tableIdx)
      if (cur === undefined) {
        tableFirstPos.set(u.tableIdx, { pos: r.pos, w })
        orderSeq.push({ table: u.tableIdx, pos: r.pos })
      } else if (w > cur.w) { cur.pos = r.pos; cur.w = w }
    } else if (u.kind === "body" || u.kind === "drawText" || u.kind === "caption") {
      // 중첩표 캡션 — 부모 셀 내부 렌더링이라 평탄화 순서와 push 순서가 어긋남 (중첩표
      // 셀 제외와 같은 논리, recall은 그대로 채점)
      if (u.nestedCaption) continue
      // 고유 식별 가능 + 실질 본문(문자/숫자 ≥4)을 가진 유닛만 — 마스킹('******')·중복 제외
      const txt = unitsForAlign[i].text
      const contentLen = (txt.match(/[\p{L}\p{N}]/gu) ?? []).length
      if (r.pos >= 0 && r.matched === r.total && contentLen >= 4 && textFreq.get(txt) === 1) {
        orderSeq.push({ pos: r.pos })
      }
    }
  }
  const orderSeqFiltered = orderSeq.filter(item => {
    if (item.table === undefined) return true
    const cur = tableFirstPos.get(item.table)
    if (cur.w === 0) return false // 고유 앵커 셀 없는 표 — 귀속 불능
    item.pos = cur.pos
    return true
  })
  const positions = orderSeqFiltered.map(o => o.pos)
  const orderLis = positions.length ? lisLength(positions) / positions.length : 1
  let orderNed = 1
  if (positions.length > 1) {
    const refIds = positions.map((_, i) => i)
    const mdIds = refIds.slice().sort((a, b) => positions[a] - positions[b] || a - b)
    orderNed = 1 - levArr(refIds, mdIds) / positions.length
  }

  // ── 표 채점 (IR 단계) — 중첩표는 IRCell.blocks 재귀 수집, ref와 같은 post-order 경계 (v3.0) ──
  const irGrids = collectIrGrids(res.blocks)
  const tbl = scoreTables(ref.tables, irGrids)

  // ── specials presence ──
  const eqRef = ref.specials.equations
  // 주석 presence 모수 = 주석을 가진 문단 수 — 파서는 문단의 주석을 "(주: 1) …; 2) …)" 하나로
  // 담는다(IRBlock.footnoteText 단일 문자열, HWP5 파서 동일). 주석 글 자체는 recall 이 채점
  const fnRef = ref.specials.noteHosts
  const eqPresence = eqRef > 0 ? Math.min(1, mdEqCount / eqRef) : 1
  const fnPresence = fnRef > 0 ? Math.min(1, mdFnCount / fnRef) : 1

  const g = GATES.hwpx
  const docPass =
    recall >= g.recallDoc && maxMissRun < g.missRun && phantomRate <= g.phantom &&
    blacklistHits.length === 0 && orderLis >= g.orderDoc && headerViolations === 0

  return {
    ok: true,
    docPass,
    recall: round(recall, 6),
    refChars: refTotal,
    matchedChars: matchedTotal,
    maxMissRun,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { recall: round(v.total ? v.matched / v.total : 1), units: v.units, chars: v.total }])),
    phantomRate: round(phantomRate, 6),
    phantomChars,
    mdChars: mdKey.length,
    phantomSnips: phantomSnips.slice(0, 5),
    blacklistHits,
    order: { lis: round(orderLis), ned: round(orderNed), units: positions.length },
    tables: {
      ref: tbl.tableCount, ir: tbl.irTableCount, exact: tbl.exactCount,
      exactRate: round(tbl.exactRate), cellF1: round(tbl.cellF1, 6),
      cellExactRate: round(tbl.cellExactRate, 6), contentNED: round(tbl.contentNED, 6),
      cellTotal: tbl.cellTotal, cellExact: tbl.cellExact,
      contentNum: tbl.contentNum, contentDen: tbl.contentDen,
      splitTables: tbl.splitTables, decorForgiven: tbl.decorForgiven,
      unmatchedRef: tbl.unmatchedRef, unmatchedIr: tbl.unmatchedIr,
      nested: ref.counters.nestedTables,
      mismatches: tbl.details.filter(d => !d.exact).slice(0, 5),
    },
    specials: {
      eqRef, eqOut: mdEqCount, eqPresence: round(eqPresence),
      fnRef, fnOut: mdFnCount, fnPresence: round(fnPresence),
      headers: ref.specials.headers.length, footers: ref.specials.footers.length,
      headerViolations,
    },
    policy: ref.counters,
    warnings: (res.warnings ?? []).length,
    topMisses: misses.slice(0, 8),
  }
}

// ─── PDF 채점 ───────────────────────────────────────

async function scorePdf(file, buf) {
  // kordoc parse()는 입력 ArrayBuffer를 detach하므로, 교차검증용 바이트를 먼저 복사한다.
  const pdfBytes = Uint8Array.from(buf)
  const res = await parse(buf, { filename: basename(file) })
  if (!res.success) {
    if (res.code === "IMAGE_BASED_PDF") {
      return { ok: true, status: "ocr-only", coverage: null, totalPages: res.pageCount ?? 0, needsOcrPages: res.pageCount ?? 0 }
    }
    return { ok: false, stage: "parse", error: res.error }
  }

  // 모수 격리는 추출 글자가 깨진 페이지만(PUA·제어문자·대체문자·깨진 한글) — "low_text"(글이 적을 뿐인
  // 표·차트·수식 페이지)는 텍스트 층이 온전해 두 추출기와 그대로 대조한다 (v4.14.3, rhwp 코퍼스 117건 격리 재검토)
  const needsOcrPages = new Set((res.pageQuality ?? []).filter(q => q.needsOcr && q.ocrReason !== "low_text").map(q => q.page))
  const totalPages = res.pageCount ?? (res.pageQuality ?? []).length

  if (res.isImageBased || (totalPages > 0 && needsOcrPages.size >= totalPages)) {
    return { ok: true, status: "ocr-only", coverage: null, needsOcrPages: needsOcrPages.size, totalPages }
  }

  const { text: plain } = mdToPlain(res.markdown)
  const cov = await pdfCrossCoverage(file, pdfBytes, plain, needsOcrPages)
  return {
    ok: true,
    status: cov.status,
    weak: cov.weak ?? false,
    coverage: cov.coverage === null ? null : round(cov.coverage, 5),
    consensusSize: cov.consensusSize,
    coveredSize: cov.coveredSize,
    needsOcrPages: needsOcrPages.size,
    totalPages,
    topMissing: cov.topMissing,
  }
}

// ─── HWP5 2차 트랙 (hwpx 쌍 상호 정렬) ───────────────

function chunkUnits(plainText) {
  return plainText
    .split(/\n+/)
    .map(s => normKey(s))
    .filter(s => s.length >= 4)
    .map((text, i) => ({ id: i, kind: "x", text }))
}

function crossCoverage(unitsText, targetKey) {
  const units = chunkUnits(unitsText)
  const { perUnit } = alignUnits(units, targetKey)
  let m = 0, t = 0
  for (const r of perUnit) { m += r.matched; t += r.total }
  return { matched: m, total: t, coverage: t ? m / t : 1 }
}

async function scoreHwpPair(hwpFile, hwpxFile) {
  const [hwpBuf, hwpxBuf] = await Promise.all([readFile(hwpFile), readFile(hwpxFile)])
  const [hwpRes, hwpxRes] = [await parse(hwpBuf, parseOpts(hwpFile)), await parse(hwpxBuf, parseOpts(hwpxFile))]
  if (!hwpRes.success || !hwpxRes.success) {
    return { ok: false, error: !hwpRes.success ? `hwp: ${hwpRes.error}` : `hwpx: ${hwpxRes.error}` }
  }
  // HWP 계열 파서(HWP5·HWP3)만 레이아웃 표를 문단으로 해체한다(flattenLayoutTables — HWPX 는 왕복 소스맵 때문에
  // 안 함). 텍스트 대조도 표 대조와 같은 대칭으로 — 같은 함수로 해체한 HWPX IR 을 같은 builder 로 그린다.
  // 해체할 표가 없으면 hwpxRes.markdown 과 바이트 동일(1,047쌍 실측), 있으면(71쌍) 레이아웃 표 셀 안 중첩표가
  // HWPX 쪽에서만 " / " 평탄화 줄(GFM·1열 경로)로 그려져 생기던 거짓 차이를 없앤다
  const hwpxFlat = flattenLayoutTables(hwpxRes.blocks)
  const hwpPlain = mdToPlain(hwpRes.markdown).text
  const hwpxPlain = mdToPlain(blocksToMarkdown(hwpxFlat)).text
  const aToB = crossCoverage(hwpxPlain, normKey(hwpPlain)) // hwpx 내용이 hwp 출력에 있는가
  const bToA = crossCoverage(hwpPlain, normKey(hwpxPlain))
  // 양쪽 다 채점 유닛(≥4자 줄)이 없으면 같은 출력이다 — 종전 식은 0/0 을 NED 1(완전 불일치)로 셌다(차트 샘플 49쌍)
  const ned = aToB.total + bToA.total === 0 ? 0 : 1 - (aToB.matched + bToA.matched) / (aToB.total + bToA.total)
  // 표 구조 — 같은 문서의 HWPX IR 표(XML 자기참조 트랙이 tableExact 1 로 검증)를 GT 로 HWP5 IR 표를
  // 셀 좌표·병합까지 대조한다. HWP5 파서만 레이아웃 표를 문단으로 해체하므로(flattenLayoutTables) GT 에도
  // 같은 함수를 적용해 양측 대칭(위 hwpxFlat). 중첩표는 collectIrGrids 가 셀 blocks 를 재귀 수집(post-order)
  // 칸 각주는 HWPX 가 문단 블록 footnoteText, HWP5 가 칸 text 인라인으로 담는다(칸 text·마크다운은 같다) — 양쪽 다 각주 포함으로 맞댄다
  const refGrids = collectIrGrids(hwpxFlat, true).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors }))
  const tbl = scoreTables(refGrids, collectIrGrids(hwpRes.blocks, true))
  return {
    ok: true,
    hwpxToHwp: round(aToB.coverage),
    hwpToHwpx: round(bToA.coverage),
    crossNED: round(ned),
    hwpChars: aToB.total ? normKey(hwpPlain).length : 0,
    hwpxChars: normKey(hwpxPlain).length,
    tables: {
      ref: tbl.tableCount, ir: tbl.irTableCount, exact: tbl.exactCount, cellF1: round(tbl.cellF1, 6),
      cellTotal: tbl.cellTotal, cellExact: tbl.cellExact, contentNum: tbl.contentNum, contentDen: tbl.contentDen,
      unmatchedRef: tbl.unmatchedRef, unmatchedIr: tbl.unmatchedIr,
      mismatches: tbl.details.filter(d => !d.exact).slice(0, 3),
    },
  }
}

// ─── 메인 ───────────────────────────────────────────

const t0 = performance.now()
const hwpxDocs = [], pdfDocs = [], hwpFiles = [], failures = [], encryptedDocs = []
const misnamedOle2 = new Set() // 확장자 .hwpx + OLE2 매직 (실제 HWP5) — 쌍 탐색 제외
const lockedHwpx = new Set() // 암호를 모르는 HWPX — HWP5 쌍 탐색 제외(HWP 는 단독 파싱 트랙으로)
const allFiles = []
for await (const f of walk(corpusDir)) allFiles.push(f)
allFiles.sort()

for (const file of allFiles) {
  const rel = relative(join(root, "corpus"), file)
  // 채점 정렬의 알려진 거짓 미스 픽스처 — 파서는 무손실인데 유닛 경계가 어긋난다
  // (corpus/known-false-miss/README.md). 정렬 개선 시 회귀 확인용으로 보관만.
  if (rel.startsWith("known-false-miss")) continue
  if (docFilter && !rel.includes(docFilter)) continue
  const ext = extname(file).slice(1).toLowerCase()
  if (only && ext !== only) continue

  if (ext === "hwp") { hwpFiles.push(file); continue }

  const buf = await readFile(file)
  const td = performance.now()
  try {
    if (ext === "hwpx" && buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      // 확장자만 .hwpx인 OLE2(실제 HWP5) 업로드 실수 — 자기참조 XML GT가 없으므로
      // HWP5 unpaired 트랙으로 라우팅 (파서 detectFormat과 동일하게 매직바이트 우선).
      // 같은 nid의 hwpx는 별개 첨부(본문 vs 별첨)라 쌍 비교 대상이 아니다.
      hwpFiles.push(file)
      misnamedOle2.add(file)
      continue
    }
    if (ext === "hwpx") {
      const row = await scoreHwpx(file, buf)
      row.file = rel
      row.ms = Math.round(performance.now() - td)
      if (row.locked) lockedHwpx.add(file)
      if (row.encrypted) encryptedDocs.push(rel)
      else if (row.ok) hwpxDocs.push(row)
      else failures.push({ file: rel, ...row })
      if (verbose) console.error(`hwpx ${row.ok ? (row.docPass ? "PASS" : "FAIL") : "ERR "} r=${row.recall ?? "-"} ph=${row.phantomRate ?? "-"} ${rel}`)
    } else if (ext === "pdf") {
      const row = await scorePdf(file, buf)
      row.file = rel
      row.ms = Math.round(performance.now() - td)
      if (row.ok) pdfDocs.push(row)
      else failures.push({ file: rel, ...row })
      if (verbose) console.error(`pdf  ${row.coverage ?? row.status} ${rel}`)
    }
  } catch (err) {
    failures.push({ file: rel, stage: "score", error: String(err?.stack ?? err).slice(0, 400) })
    if (verbose) console.error(`ERR ${rel}: ${err?.message}`)
  }
}

// HWP5 쌍 트랙
const hwpPairs = []
const hwpUnpaired = []
for (const hwpFile of hwpFiles) {
  const base = basename(hwpFile)
  const m = base.match(/^(\d+)_/)
  const dir = hwpFile.slice(0, hwpFile.length - base.length)
  let pair = null
  if (misnamedOle2.has(hwpFile)) {
    // 쌍 비교 비대상 — unpaired 경로로
  } else if (m) {
    const sibling = allFiles.find(f => f !== hwpFile && f.startsWith(dir) && basename(f).startsWith(m[1] + "_") && /\.hwpx$/i.test(f) && !misnamedOle2.has(f) && !lockedHwpx.has(f))
    if (sibling) pair = sibling
  } else {
    // 같은 이름 .hwpx, 없으면 한컴 변환본 명명(rhwp 샘플 "<원본>-hwpx.hwpx"·"<원본>-hwp5.hwpx" — HWP3 원본을 한글이
    // HWPX/HWP5→HWPX 로 저장한 것, rhwp mydocs task_m100_554 가 변환 경위 기록). HWP3 표·개요번호·각주의 유일한 GT
    const stem = hwpFile.replace(/\.hwp$/i, "")
    pair = [".hwpx", "-hwpx.hwpx", "-hwp5.hwpx"].map(s => stem + s).find(c => allFiles.includes(c)) ?? null
  }
  if (!only || only === "hwp") {
    if (pair) {
      try {
        const r = await scoreHwpPair(hwpFile, pair)
        hwpPairs.push({ file: relative(join(root, "corpus"), hwpFile), pair: basename(pair), ...r })
      } catch (err) {
        hwpPairs.push({ file: relative(join(root, "corpus"), hwpFile), pair: basename(pair), ok: false, error: String(err?.message ?? err) })
      }
    } else {
      // 쌍 없는 hwp — 파싱 성공 여부만
      try {
        const res = await parse(await readFile(hwpFile), parseOpts(hwpFile))
        hwpUnpaired.push({ file: relative(join(root, "corpus"), hwpFile), parsed: res.success, mdLen: res.success ? res.markdown.length : 0, error: res.success ? undefined : res.error })
      } catch (err) {
        hwpUnpaired.push({ file: relative(join(root, "corpus"), hwpFile), parsed: false, error: String(err?.message ?? err) })
      }
    }
  }
}

// ─── 집계 + 게이트 ──────────────────────────────────

const g = GATES.hwpx
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0)

const hwpxAgg = (() => {
  if (hwpxDocs.length === 0) return null
  const refChars = sum(hwpxDocs, d => d.refChars)
  const matched = sum(hwpxDocs, d => d.matchedChars)
  const recallMicro = refChars ? matched / refChars : 1
  const docsBelowRecall = hwpxDocs.filter(d => d.recall < g.recallDoc)
  const docsMissRun = hwpxDocs.filter(d => d.maxMissRun >= g.missRun)
  const phantomMicro = sum(hwpxDocs, d => d.phantomChars) / Math.max(1, sum(hwpxDocs, d => d.mdChars))
  const blacklistDocs = hwpxDocs.filter(d => d.blacklistHits.length > 0)
  const tableCount = sum(hwpxDocs, d => d.tables.ref)
  const exactCount = sum(hwpxDocs, d => d.tables.exact)
  const cellF1 = tableCount ? sum(hwpxDocs, d => d.tables.cellF1 * d.tables.ref) / tableCount : 1
  const cellTotal = sum(hwpxDocs, d => d.tables.cellTotal)
  const cellExactMicro = cellTotal ? sum(hwpxDocs, d => d.tables.cellExact) / cellTotal : 1
  const contentDen = sum(hwpxDocs, d => d.tables.contentDen)
  const contentNED = contentDen ? sum(hwpxDocs, d => d.tables.contentNum) / contentDen : 1
  const orderAvg = sum(hwpxDocs, d => d.order.lis) / hwpxDocs.length
  const docsBelowOrder = hwpxDocs.filter(d => d.order.lis < g.orderDoc)
  const eqRef = sum(hwpxDocs, d => d.specials.eqRef)
  const eqHit = sum(hwpxDocs, d => Math.min(d.specials.eqOut, d.specials.eqRef))
  const fnRef = sum(hwpxDocs, d => d.specials.fnRef)
  const fnHit = sum(hwpxDocs, d => Math.min(d.specials.fnOut, d.specials.fnRef))
  const headerViolations = sum(hwpxDocs, d => d.specials.headerViolations)

  const gates = {
    recallMicro: { value: round(recallMicro, 6), threshold: g.recallMicro, pass: recallMicro >= g.recallMicro },
    recallDoc: { value: round(Math.min(...hwpxDocs.map(d => d.recall)), 6), threshold: g.recallDoc, failDocs: docsBelowRecall.length, pass: docsBelowRecall.length === 0 },
    missRun: { failDocs: docsMissRun.length, threshold: `<${g.missRun}자`, pass: docsMissRun.length === 0 },
    phantom: { value: round(phantomMicro, 6), threshold: g.phantom, pass: phantomMicro <= g.phantom },
    blacklist: { failDocs: blacklistDocs.length, pass: blacklistDocs.length === 0 },
    tableExact: { value: round(tableCount ? exactCount / tableCount : 1, 6), threshold: g.tableExact, pass: (tableCount ? exactCount / tableCount : 1) >= g.tableExact },
    cellF1: { value: round(cellF1, 6), threshold: g.cellF1, pass: cellF1 >= g.cellF1 },
    contentNED: { value: round(contentNED, 6), threshold: g.contentNED, pass: contentNED >= g.contentNED },
    cellExact: { value: round(cellExactMicro, 6), threshold: g.cellExact, pass: cellExactMicro >= g.cellExact },
    orderAvg: { value: round(orderAvg, 6), threshold: g.orderAvg, pass: orderAvg >= g.orderAvg },
    orderDoc: { failDocs: docsBelowOrder.length, threshold: g.orderDoc, pass: docsBelowOrder.length === 0 },
    eqPresence: { value: round(eqRef ? eqHit / eqRef : 1, 6), threshold: g.eqPresence, pass: (eqRef ? eqHit / eqRef : 1) >= g.eqPresence },
    fnPresence: { value: round(fnRef ? fnHit / fnRef : 1, 6), threshold: g.footnotePresence, pass: (fnRef ? fnHit / fnRef : 1) >= g.footnotePresence },
    headerPolicy: { violations: headerViolations, pass: headerViolations === 0 },
  }
  return {
    docs: hwpxDocs.length, refChars, matched, gates,
    tableCount, exactCount,
    nestedTables: sum(hwpxDocs, d => d.tables.nested),
    splitTables: sum(hwpxDocs, d => d.tables.splitTables),
    pass: Object.values(gates).every(x => x.pass),
  }
})()

const pdfAgg = (() => {
  const scored = pdfDocs.filter(d => d.status === "ok" && !d.weak)
  if (pdfDocs.length === 0) return null
  const consensus = sum(scored, d => d.consensusSize ?? 0)
  const covered = sum(scored, d => d.coveredSize ?? 0)
  const coverageMicro = consensus ? covered / consensus : null
  const docsBelow = scored.filter(d => d.coverage < GATES.pdf.coverage)
  const gates = {
    coverage: {
      value: round(coverageMicro, 5), threshold: GATES.pdf.coverage,
      failDocs: docsBelow.length,
      pass: coverageMicro === null ? false : coverageMicro >= GATES.pdf.coverage,
    },
  }
  return {
    docs: pdfDocs.length, scored: scored.length,
    ocrOnly: pdfDocs.filter(d => d.status === "ocr-only").length,
    weak: pdfDocs.filter(d => d.weak).length,
    tinyConsensus: pdfDocs.filter(d => d.status === "tiny-consensus").length,
    gates, docsBelow: docsBelow.map(d => ({ file: d.file, coverage: d.coverage })),
    pass: gates.coverage.pass,
  }
})()

const hwp5Agg = (() => {
  if (!hwpPairs.length) return null
  const okPairs = hwpPairs.filter(p => p.ok)
  const avgCrossNED = round(sum(okPairs, p => p.crossNED) / Math.max(1, okPairs.length))
  const avgHwpxToHwp = round(sum(okPairs, p => p.hwpxToHwp) / Math.max(1, okPairs.length))
  // v3.0 정식 게이트: 쌍 유사도(1-crossNED)·hwpx→hwp 커버 ≥ 기준, 파싱 실패 쌍 0
  // 표 구조 (HWPX IR = GT) — 마이크로 집계
  const tRef = sum(okPairs, p => p.tables.ref)
  const tExact = sum(okPairs, p => p.tables.exact)
  const tF1 = tRef ? sum(okPairs, p => p.tables.cellF1 * p.tables.ref) / tRef : 1
  const tCells = sum(okPairs, p => p.tables.cellTotal)
  const tCellExact = tCells ? sum(okPairs, p => p.tables.cellExact) / tCells : 1
  const tDen = sum(okPairs, p => p.tables.contentDen)
  const tNED = tDen ? sum(okPairs, p => p.tables.contentNum) / tDen : 1
  const gates = {
    pairSimilarity: {
      value: round(1 - avgCrossNED, 5), threshold: GATES.hwp.pairSimilarity,
      pass: okPairs.length > 0 && 1 - avgCrossNED >= GATES.hwp.pairSimilarity,
    },
    pairTableExact: {
      value: round(tRef ? tExact / tRef : 1, 6), threshold: GATES.hwp.pairTableExact,
      pass: (tRef ? tExact / tRef : 1) >= GATES.hwp.pairTableExact,
    },
    pairCellF1: { value: round(tF1, 6), threshold: GATES.hwp.pairCellF1, pass: tF1 >= GATES.hwp.pairCellF1 },
    pairCellExact: { value: round(tCellExact, 6), threshold: GATES.hwp.pairCellExact, pass: tCellExact >= GATES.hwp.pairCellExact },
    pairContentNED: { value: round(tNED, 6), threshold: GATES.hwp.pairContentNED, pass: tNED >= GATES.hwp.pairContentNED },
    pairCoverage: {
      value: avgHwpxToHwp, threshold: GATES.hwp.pairCoverage,
      pass: okPairs.length > 0 && avgHwpxToHwp >= GATES.hwp.pairCoverage,
    },
    pairErrors: { value: hwpPairs.length - okPairs.length, threshold: 0, pass: hwpPairs.length === okPairs.length },
  }
  return {
    pairs: hwpPairs.length,
    ok: okPairs.length,
    avgCrossNED,
    avgHwpxToHwp,
    tables: { ref: tRef, exact: tExact },
    gates,
    pass: Object.values(gates).every(g => g.pass),
  }
})()

// 모수 하한 (2026-07-05 실측 hwpx 347/pdf 50/hwp쌍 23의 ~절반) — 트랙 폴더 소실 시
// agg가 null이 되고 ?? true 로 조용한 만점 PASS가 나는 것 방지 (리뷰 #14).
// 부분 실행(subPath)은 의도된 축소라 스킵.
// v4.15.0 보강 코퍼스 전체 실행 실측 모수로 상향 — 새 세트가 빠진 실행도 통과하지 않도록 한다.
const MIN_POP = { hwpx: 2286, pdf: 1911, hwpPairs: 1120 }
const population = {
  value: `hwpx ${hwpxDocs.length}/pdf ${pdfDocs.length}/hwp쌍 ${hwpPairs.length}`,
  threshold: `≥ ${MIN_POP.hwpx}/${MIN_POP.pdf}/${MIN_POP.hwpPairs}`,
  // 부분 실행(subPath·--doc·--only)은 의도된 축소라 모수 하한 면제 — 단건 재채점 워크플로 복원 (gate-3)
  pass: subPath !== "" || docFilter != null || only != null ||
    (hwpxDocs.length >= MIN_POP.hwpx && pdfDocs.length >= MIN_POP.pdf && hwpPairs.length >= MIN_POP.hwpPairs),
}
// 쌍 없는 HWP 도 파싱은 성공해야 한다 (종전엔 보고만 — 암호 샘플은 파일명 암호로 연다)
const hwpUnpairedFail = hwpUnpaired.filter(u => !u.parsed).length
const overallPass = (hwpxAgg?.pass ?? true) && (pdfAgg?.pass ?? true) && (hwp5Agg?.pass ?? true) && failures.length === 0 && hwpUnpairedFail === 0 && population.pass

const report = {
  generatedAt: new Date().toISOString(),
  corpus: subPath || "(all)",
  elapsedMs: Math.round(performance.now() - t0),
  overallPass,
  population,
  failures,
  hwpx: hwpxAgg ? { ...hwpxAgg, docsDetail: hwpxDocs } : null,
  pdf: pdfAgg ? { ...pdfAgg, docsDetail: pdfDocs } : null,
  hwp5: { pairs: hwpPairs, unpaired: hwpUnpaired, agg: hwp5Agg },
  encryptedHwpx: encryptedDocs,
  policyWhitelist: WHITELIST.map(w => w.id), // 화이트리스트 항목 수 노출 (비대해지면 적신호)
}

await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, "score.json"), JSON.stringify(report, null, 2))

// ─── 콘솔 요약 ──────────────────────────────────────

const fmt = x => (x === null || x === undefined ? "-" : typeof x === "number" ? String(x) : x)
console.log(`\n══ kordoc 정확도 채점 — ${hwpxDocs.length} hwpx / ${pdfDocs.length} pdf / ${hwpPairs.length} hwp쌍 (${Math.round(report.elapsedMs / 1000)}s) ══`)

if (hwpxAgg) {
  console.log(`\n[HWPX 게이트] ${hwpxAgg.pass ? "PASS ✅" : "FAIL ❌"}`)
  for (const [k, v] of Object.entries(hwpxAgg.gates)) {
    const detail = v.value !== undefined ? `${fmt(v.value)} (기준 ${fmt(v.threshold)})` : ""
    const extra = v.failDocs !== undefined ? ` 미달문서=${v.failDocs}` : v.violations !== undefined ? ` 위반=${v.violations}` : ""
    console.log(`  ${v.pass ? "✅" : "❌"} ${k.padEnd(12)} ${detail}${extra}`)
  }
  console.log(`  표: ref=${hwpxAgg.tableCount} exact=${hwpxAgg.exactCount} | 중첩표(셀 내 보존, 비교 포함)=${hwpxAgg.nestedTables} | 분할보정=${hwpxAgg.splitTables}`)

  const worst = [...hwpxDocs].sort((a, b) => a.recall - b.recall).slice(0, 10)
  console.log(`\n[HWPX recall 하위 10]`)
  for (const d of worst) {
    console.log(`  ${String(d.recall).padEnd(8)} miss≤${d.maxMissRun} ph=${d.phantomRate} ${d.file.slice(0, 80)}`)
    for (const m of d.topMisses.slice(0, 2)) {
      console.log(`      └ [${m.kind}] -${m.lost}자: "${m.missSnippet.slice(0, 60)}"`)
    }
  }

  const tblBad = hwpxDocs.filter(d => d.tables.ref > 0 && d.tables.exactRate < 1).sort((a, b) => a.tables.exactRate - b.tables.exactRate).slice(0, 8)
  if (tblBad.length) {
    console.log(`\n[표 구조 불일치 상위]`)
    for (const d of tblBad) {
      const mm = d.tables.mismatches[0]
      console.log(`  exact=${d.tables.exactRate} f1=${d.tables.cellF1} (${d.tables.ref}표) ${d.file.slice(0, 70)}${mm ? ` — ref ${mm.refDims} vs ir ${mm.irDims ?? "없음"}` : ""}`)
    }
  }

  const phBad = hwpxDocs.filter(d => d.phantomRate > GATES.hwpx.phantom).sort((a, b) => b.phantomRate - a.phantomRate).slice(0, 8)
  if (phBad.length) {
    console.log(`\n[phantom 초과 문서]`)
    for (const d of phBad) console.log(`  ${d.phantomRate} "${(d.phantomSnips[0] ?? "").slice(0, 50)}" ${d.file.slice(0, 70)}`)
  }
}

if (pdfAgg) {
  console.log(`\n[PDF 게이트] ${pdfAgg.pass ? "PASS ✅" : "FAIL ❌"}  coverage(micro)=${fmt(pdfAgg.gates.coverage.value)} (기준 ${GATES.pdf.coverage}) | 채점=${pdfAgg.scored} ocr격리=${pdfAgg.ocrOnly} weak=${pdfAgg.weak + pdfAgg.tinyConsensus}`)
  for (const d of pdfAgg.docsBelow.slice(0, 10)) console.log(`  ❌ ${d.coverage} ${d.file.slice(0, 85)}`)
}

if (hwp5Agg) {
  console.log(`\n[HWP5 쌍 게이트] ${hwp5Agg.pass ? "PASS ✅" : "FAIL ❌"}  쌍=${hwp5Agg.pairs} 유사도=${fmt(hwp5Agg.gates.pairSimilarity.value)} (기준 ${GATES.hwp.pairSimilarity}) | hwpx→hwp 커버=${fmt(hwp5Agg.avgHwpxToHwp)} (기준 ${GATES.hwp.pairCoverage}) | 실패쌍=${hwp5Agg.gates.pairErrors.value}`)
  const hg = hwp5Agg.gates
  console.log(`  표 구조: ref=${hwp5Agg.tables.ref} exact=${hwp5Agg.tables.exact} (${fmt(hg.pairTableExact.value)}) cellF1=${fmt(hg.pairCellF1.value)} cellExact=${fmt(hg.pairCellExact.value)} NED=${fmt(hg.pairContentNED.value)}`)
  // 완전 일치(텍스트 NED 0 + 표 전부 exact) 쌍은 생략 — 문제 쌍만
  for (const p of hwpPairs) {
    if (p.ok && p.crossNED === 0 && p.tables.exact === p.tables.ref && p.tables.unmatchedIr === 0) continue
    const t = p.ok ? ` 표 ${p.tables.exact}/${p.tables.ref} f1=${p.tables.cellF1}${p.tables.unmatchedIr ? ` 잉여=${p.tables.unmatchedIr}` : ""}` : ""
    console.log(`  ${p.ok ? `NED=${p.crossNED} hwpx→hwp=${p.hwpxToHwp} hwp→hwpx=${p.hwpToHwpx}${t}` : `ERR ${p.error}`} ${p.file.slice(0, 70)}`)
  }
}

if (encryptedDocs.length) console.log(`\n[암호 HWPX] ${encryptedDocs.length}건 채점 제외 — 파일명 암호로 열기 성공 ${encryptedDocs.length - lockedHwpx.size} · 암호 모름(ENCRYPTED 거절 확인) ${lockedHwpx.size} (자기참조 GT 불가)`)
const unpairedFail = hwpUnpaired.filter(u => !u.parsed)
if (unpairedFail.length) { // 게이트 (overallPass)
  console.log(`\n[HWP 단독 파싱 실패 ${unpairedFail.length}건]`)
  for (const u of unpairedFail) console.log(`  ${u.file.slice(0, 70)}: ${String(u.error).slice(0, 100)}`)
}
if (failures.length) {
  console.log(`\n[채점 실패 ${failures.length}건]`)
  for (const f of failures) console.log(`  [${f.stage}] ${f.file.slice(0, 70)}: ${String(f.error).slice(0, 120)}`)
}

if (!population.pass) console.log(`\n❌ 모수 하한 미달: ${population.value} (기준 ${population.threshold}) — 코퍼스 소실/미동기 의심`)
console.log(`\nreport → bench/out/score.json | 전체 ${overallPass ? "PASS ✅" : "FAIL ❌"}`)
process.exitCode = overallPass ? 0 : 1
