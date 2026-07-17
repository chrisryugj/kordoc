// 표 채점 — XML 참조 그리드 vs kordoc IR 그리드 (markdown이 아닌 IR 단계, pitfall #10)
//
// 참조 그리드: bench/ref/hwpx-ref.mjs 가 만든 {rows, cols, cells:[{r,c,rs,cs,text,hasNested}]}
// IR 그리드 : ParseSuccess.blocks 의 IRTable → 앵커 튜플 재계산 (renderer와 동일한 skip-walk)
// 중첩표(v3.0): IRCell.blocks 의 IRBlock(type:'table')을 재귀 수집 — ref XML 중첩 tbl과
// 같은 경계(post-order, 자식 먼저)로 비교하고 부모 셀 텍스트에서는 제외 (이중 카운트 금지)

import { levBand } from "./align.mjs"
import { normText, normKey } from "./normalize.mjs"

/**
 * IR 셀의 "자기 텍스트" — blocks가 있으면 문단 블록만 join (중첩표 평탄화 텍스트·
 * ![image] 참조가 섞인 하위 호환 cell.text 대신). 중첩표 텍스트는 자식 그리드에서 채점.
 * 수식 $…$/$$…$$은 제거 — ref 추출기가 셀 텍스트에서 수식을 제외하므로(존재는
 * eqPresence로 별도 채점, whitelist) mdToPlain 본문 경로와 대칭.
 */
function cellOwnText(cell) {
  const raw = cell.blocks?.length
    ? cell.blocks
        .filter(b => b.type !== "table" && b.type !== "image")
        .map(b => b.text ?? "")
        .filter(Boolean)
        .join("\n")
    : cell.text ?? ""
  return raw
    .replace(/\$\$[^$]+\$\$/g, " ")
    .replace(/(^|[^\\$])\$(?!\s)((?:\\.|[^$\n])+?)\$/g, "$1 ")
    // 인라인 링크 [anchor](url) → anchor — ref 셀은 가시 텍스트만 모델링 (mdToPlain 대칭)
    .replace(/\[([^\[\]]*)\]\((?:https?:|mailto:|tel:|#)[^)\s]*\)/gi, "$1")
}

/** IRTable.cells[][] → 앵커 셀 목록 (tableToHtml과 동일한 skip-set 워크) */
export function irAnchors(irTable) {
  const { rows, cols, cells } = irTable
  const anchors = []
  const skip = new Set()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (skip.has(r * 100000 + c)) continue
      const cell = cells[r]?.[c]
      if (!cell) continue
      anchors.push({ r, c, rs: cell.rowSpan, cs: cell.colSpan, text: cellOwnText(cell) })
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < rows && c + dc < cols) skip.add((r + dr) * 100000 + (c + dc))
        }
      }
    }
  }
  return { rows, cols, anchors }
}

/**
 * IRBlock[] → IR 그리드 목록 (post-order: 셀 내부 중첩표 먼저, 부모 나중).
 * ref 추출기의 tables[] 적재 순서(processCell 즉시 처리 = 자식 먼저)와 동일한 경계.
 */
export function collectIrGrids(blocks) {
  const grids = []
  const visitTable = (table, depth = 0) => {
    if (depth > 12) return
    // 앵커 워크와 동일한 row-major 순서로 셀 내부 중첩표 재귀
    const { rows, cols, cells } = table
    const skip = new Set()
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (skip.has(r * 100000 + c)) continue
        const cell = cells[r]?.[c]
        if (!cell) continue
        for (const b of cell.blocks ?? []) {
          if (b.type === "table" && b.table) visitTable(b.table, depth + 1)
        }
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            if (dr === 0 && dc === 0) continue
            if (r + dr < rows && c + dc < cols) skip.add((r + dr) * 100000 + (c + dc))
          }
        }
      }
    }
    grids.push(irAnchors(table))
  }
  for (const b of blocks ?? []) {
    if (b.type === "table" && b.table) visitTable(b.table)
  }
  return grids
}

function cellTextBag(grid) {
  const bag = new Map()
  for (const a of grid.anchors ?? grid.cells) {
    const k = normKey(a.text)
    if (k) bag.set(k, (bag.get(k) ?? 0) + 1)
  }
  // 매칭 전용 bag 보강 — 다중 셀 부모의 중첩표 텍스트 (pdf-table-gt가 ref 쪽에 적재).
  // pdf는 중첩표를 부모 그리드로 평탄화하므로, bag에 합쳐야 동의서류 박스가 같은
  // 표로 매칭된다. 셀 좌표 채점(exact/F1/NED)에는 관여하지 않는다.
  for (const t of grid.bagExtra ?? []) {
    const k = normKey(t)
    if (k) bag.set(k, (bag.get(k) ?? 0) + 1)
  }
  return bag
}

function bagSim(a, b) {
  let inter = 0, total = 0
  for (const [k, n] of a) { total += n; inter += Math.min(n, b.get(k) ?? 0) }
  for (const [, n] of b) total += n
  if (total === 0) return 0.5 // 둘 다 빈 표 — 중립
  return (2 * inter) / total
}

function dimSim(a, b) {
  const ra = a.rows, ca = a.cols, rb = b.rows, cb = b.cols
  return 1 - (Math.abs(ra - rb) + Math.abs(ca - cb)) / Math.max(1, ra + ca + rb + cb)
}

/**
 * 표 1:1 대응 — 문서 순서 보존 DP 정렬 + 유사도(셀 텍스트 bag + 치수).
 * 분할표 보정: 미매칭 ref에 대해 연속 미매칭 IR 병합 후보 시도 (pitfall #18).
 */
export function matchTables(refTables, irGrids) {
  const n = refTables.length, m = irGrids.length
  const sim = []
  const refBags = refTables.map(t => cellTextBag(t))
  const irBags = irGrids.map(g => cellTextBag(g))
  for (let i = 0; i < n; i++) {
    sim.push(new Float64Array(m))
    for (let j = 0; j < m; j++) {
      const bs = bagSim(refBags[i], irBags[j])
      // 양쪽 다 텍스트가 있는데 교집합 0 = 내용이 모순되는 표 — dims-only 매칭 차단
      // (dimSim 0.25 누수가 진짜 짝을 선점해 순서구제까지 봉쇄하는 것 방지, 10차)
      if (bs === 0 && refBags[i].size > 0 && irBags[j].size > 0) { sim[i][j] = 0; continue }
      sim[i][j] = 0.75 * bs + 0.25 * dimSim(refTables[i], irGrids[j])
    }
  }
  const MIN_SIM = 0.2
  // DP: 순서 보존 최대 가중 매칭
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = Math.max(dp[i - 1][j], dp[i][j - 1])
      if (sim[i - 1][j - 1] >= MIN_SIM) best = Math.max(best, dp[i - 1][j - 1] + sim[i - 1][j - 1])
      dp[i][j] = best
    }
  }
  const pairs = new Array(n).fill(-1)
  const usedIr = new Set()
  {
    let i = n, j = m
    while (i > 0 && j > 0) {
      if (sim[i - 1][j - 1] >= MIN_SIM && Math.abs(dp[i][j] - (dp[i - 1][j - 1] + sim[i - 1][j - 1])) < 1e-12) {
        pairs[i - 1] = j - 1
        usedIr.add(j - 1)
        i--; j--
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i--
      else j--
    }
  }
  // 분할표 병합 보정: 미매칭 ref ↔ 연속 미매칭 IR 2~3개 행방향 병합
  const merged = new Map() // refIdx → [irIdx...]
  for (let i = 0; i < n; i++) {
    if (pairs[i] !== -1) continue
    const ref = refTables[i]
    for (let j = 0; j + 1 < m; j++) {
      if (usedIr.has(j) || usedIr.has(j + 1)) continue
      for (let k = 2; k <= 3 && j + k <= m; k++) {
        const grp = []
        let ok = true, rowsSum = 0
        for (let q = j; q < j + k; q++) {
          if (usedIr.has(q)) { ok = false; break }
          grp.push(irGrids[q]); rowsSum += irGrids[q].rows
        }
        if (!ok) continue
        if (rowsSum === ref.rows && grp.every(g => g.cols === ref.cols)) {
          const mergedGrid = mergeGrids(grp)
          if (bagSim(refBags[i], cellTextBag(mergedGrid)) >= MIN_SIM) {
            merged.set(i, { irIdxs: grp.map((_, q) => j + q), grid: mergedGrid })
            for (let q = j; q < j + k; q++) usedIr.add(q)
            break
          }
        }
      }
      if (merged.has(i)) break
    }
  }
  // 순서 예외 구제 (2026-07-03): 2단 조판 페이지에서 표의 물리 방출 순서가 문서
  // 흐름과 어긋나면 (pair06 p1 — pdf가 우단 표를 먼저 방출) 순서보존 DP가 그리드
  // 동일한 표를 버린다. 잔여 미매칭 ref ↔ 미사용 IR을 전역 그리디(고유사도 우선)로
  // 구제하되, 문턱을 DP(0.2)보다 훨씬 높여 진짜 구조 붕괴가 회복으로 위장하는 것을
  // 막는다. 이 트랙의 감시 대상은 그리드 무결성이고 순서는 coverage/order 트랙 소관.
  const REORDER_MIN_SIM = 0.55
  let reordered = 0
  const cand = []
  for (let i = 0; i < n; i++) {
    if (pairs[i] !== -1 || merged.has(i)) continue
    for (let j = 0; j < m; j++) {
      if (usedIr.has(j)) continue
      if (sim[i][j] >= REORDER_MIN_SIM) cand.push([sim[i][j], i, j])
    }
  }
  cand.sort((a, b) => b[0] - a[0])
  for (const [, i, j] of cand) {
    if (pairs[i] !== -1 || usedIr.has(j)) continue
    pairs[i] = j
    usedIr.add(j)
    reordered++
  }
  // 전체 텍스트 접두 유사도 폴백 (10차): 프로즈 박스를 pdf가 세밀 분할하면
  // (pair06 결격사유 3x2 → 18x3) 셀 단위 bag 키 교집합이 붕괴해 위 단계가
  // 전부 무효. 셀 텍스트를 row-major로 이어 붙인 문자열이 접두로 들어맞으면
  // 같은 박스의 발견으로 인정한다 — 분할 이탈 표는 박스 상단부터 담기므로
  // 접두 비교가 맞고, 하단 잔여가 1열 표 등으로 모수 밖에 떨어져도 (부분 포착)
  // 커버 가드 40%로 수용. 셀 좌표 채점(exact/F1/NED)은 그대로 실좌표 대조 —
  // 매칭 발견만 구제하며 충실도는 정직하게 감점된다.
  const TEXT_MIN_LEN = 80      // 프로즈 박스 한정 (짧은 표의 우연 접두 배제)
  const TEXT_MIN_COVER = 0.4   // 짧은 쪽이 긴 쪽의 40% 이상
  const TEXT_MIN_SIM = 0.85    // 접두 구간 NED 유사도
  let textMatched = 0
  const joinKey = g => {
    let s = ""
    for (const a of g.anchors ?? g.cells) s += normKey(a.text)
    return s
  }
  const tcand = []
  let refJoin = null, irJoin = null
  for (let i = 0; i < n; i++) {
    if (pairs[i] !== -1 || merged.has(i)) continue
    refJoin ??= refTables.map(joinKey)
    if (refJoin[i].length < TEXT_MIN_LEN) continue
    for (let j = 0; j < m; j++) {
      if (usedIr.has(j)) continue
      irJoin ??= irGrids.map(joinKey)
      const R = refJoin[i], I = irJoin[j]
      if (I.length < TEXT_MIN_LEN) continue
      const L = Math.min(R.length, I.length)
      if (L / Math.max(R.length, I.length) < TEXT_MIN_COVER) continue
      const maxD = Math.ceil(L * (1 - TEXT_MIN_SIM))
      const d = levBand(R.slice(0, L), I.slice(0, L), maxD)
      if (d > maxD) continue
      tcand.push([1 - d / L, i, j])
    }
  }
  tcand.sort((a, b) => b[0] - a[0])
  for (const [, i, j] of tcand) {
    if (pairs[i] !== -1 || usedIr.has(j)) continue
    pairs[i] = j
    usedIr.add(j)
    textMatched++
  }
  return { pairs, merged, usedIr, reordered, textMatched }
}

function mergeGrids(grids) {
  const cols = grids[0].cols
  let rows = 0
  const anchors = []
  for (const g of grids) {
    for (const a of g.anchors) anchors.push({ ...a, r: a.r + rows })
    rows += g.rows
  }
  return { rows, cols, anchors }
}

const tupleKey = a => `${a.r},${a.c},${a.rs},${a.cs}`

// 자동부호 장식 토큰 1개 — 번호형(1. 1) (1) 가. (가) a. Ⅰ ① ㉮)과 단일 부호문자
// (문자/숫자가 아닌 1글자: - ※ • □ ◆ 등). 문자/숫자 단독은 불허 — 중복문자 버그 마스킹 방지.
const HEAD_DECOR_RE = /^[ \t]*(?:\d{1,3}[.)]|\(\d{1,3}\)|[가-힣][.)]|\([가-힣]\)|[A-Za-z][.)]|\([A-Za-z]\)|[①-㊿⑴-⒇⒈-⒛㉠-㉿ⓐ-ⓩⅰ-ⅻⅠ-Ⅻ]|[^\p{L}\p{N}\s])[ \t]*/u

/**
 * 자동부호(NUMBER/BULLET) 문단 장식 관용 — ref XML(hp:t)은 무장식이므로, ref가 header.xml
 * paraPr로 특정한 줄(headingLines)에 한해 IR 선두 장식 토큰 1개를 제거해 본다.
 * 줄 수가 어긋나면 관용 포기(null) — 리터럴 부호 줄은 엄격 비교 유지 (드롭 회귀 검출 보존).
 */
function stripHeadingDecor(refText, irText, headingLines) {
  const refLines = refText.split("\n")
  const irLines = irText.split("\n")
  if (refLines.length !== irLines.length) return null
  const set = new Set(headingLines)
  return irLines.map((ln, i) => (set.has(i) ? ln.replace(HEAD_DECOR_RE, "") : ln)).join("\n")
}

/**
 * 표 채점 본체.
 * refTables: ref 추출기의 전체 표 목록 — 중첩표 포함 (post-order = collectIrGrids 순서)
 * 반환: 표 단위 exact, 셀 단위 F1(GriTS-Top 등가), 셀 내용 exact/NED + 상세
 */
export function scoreTables(refTables, irGrids) {
  const { pairs, merged, usedIr, reordered, textMatched } = matchTables(refTables, irGrids)
  const details = []
  let exactCount = 0
  const f1s = []
  let cellTotal = 0, cellExact = 0
  let contentNum = 0, contentDen = 0
  let splitTables = 0
  let decorForgiven = 0

  for (let i = 0; i < refTables.length; i++) {
    const ref = refTables[i]
    let ir = pairs[i] !== -1 ? irGrids[pairs[i]] : null
    let wasMerged = false
    if (!ir && merged.has(i)) {
      ir = merged.get(i).grid
      wasMerged = true
      splitTables++
    }

    const refSet = new Map(ref.cells.map(a => [tupleKey(a), a]))
    const irSet = ir ? new Map(ir.anchors.map(a => [tupleKey(a), a])) : new Map()
    let inter = 0
    for (const k of refSet.keys()) if (irSet.has(k)) inter++
    const f1 = (2 * inter) / Math.max(1, refSet.size + irSet.size)
    f1s.push(f1)
    const exact = !!ir && !wasMerged && ref.rows === ir.rows && ref.cols === ir.cols
      && inter === refSet.size && refSet.size === irSet.size
    if (exact) exactCount++

    // 셀 내용 — 좌표(r,c) 대응
    const irByPos = new Map()
    if (ir) for (const a of ir.anchors) irByPos.set(`${a.r},${a.c}`, a)
    const cellMisses = []
    for (const rc of ref.cells) {
      const ic = irByPos.get(`${rc.r},${rc.c}`)
      // 공백은 신뢰 불가(파서 균등배분 결합·셀 내 개행 등) → spaceless 비교 (pitfall #9)
      const a = normKey(rc.text)
      let bRaw = ic?.text ?? ""
      if (ic && rc.headingLines?.length && normKey(bRaw) !== a) {
        const stripped = stripHeadingDecor(rc.text, bRaw, rc.headingLines)
        if (stripped !== null && normKey(stripped) === a) { bRaw = stripped; decorForgiven++ }
      }
      const b = normKey(bRaw)
      cellTotal++
      const maxLen = Math.max(a.length, b.length, 1)
      // 중첩표 보유 셀도 일반 비교 — irAnchors가 부모 셀 "자기 텍스트"만 추출하므로(v3.0)
      // 양쪽 모두 중첩표 텍스트가 제외된 동일 경계다 (자식 그리드에서 별도 채점).
      let dist
      if (a === b) { cellExact++; dist = 0 }
      else dist = levBand(a, b, Math.min(maxLen, 4000))
      contentNum += maxLen - Math.min(dist, maxLen)
      contentDen += maxLen
      if (dist > 0) cellMisses.push({ r: rc.r, c: rc.c, ref: a.slice(0, 60), ir: ic ? b.slice(0, 60) : "(셀 없음)" })
    }

    details.push({
      refIdx: i,
      irIdx: pairs[i],
      merged: wasMerged,
      matched: !!ir,
      nested: !!ref.nested,
      refDims: `${ref.rows}x${ref.cols}`,
      irDims: ir ? `${ir.rows}x${ir.cols}` : null,
      exact, f1: +f1.toFixed(4),
      cellMisses: cellMisses.slice(0, 5),
      cellMissCount: cellMisses.length,
    })
  }

  return {
    tableCount: refTables.length,
    irTableCount: irGrids.length,
    exactCount,
    exactRate: refTables.length ? exactCount / refTables.length : 1,
    cellF1: f1s.length ? f1s.reduce((s, x) => s + x, 0) / f1s.length : 1,
    cellTotal, cellExact,
    cellExactRate: cellTotal ? cellExact / cellTotal : 1,
    contentNum, contentDen,
    contentNED: contentDen ? contentNum / contentDen : 1,
    splitTables,
    decorForgiven,
    reordered: reordered ?? 0,
    textMatched: textMatched ?? 0,
    unmatchedRef: details.filter(d => !d.matched).length,
    unmatchedIr: irGrids.length - usedIr.size,
    details,
  }
}
