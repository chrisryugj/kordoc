// HWPX 표의 기하 격자 — PDF 표 채점(pdf-table-gt)의 정답지를 "보이는 격자"로 옮기기 위한 변환.
//
// HWPX 표 격자(cellAddr colAddr)는 논리 열이다. 한컴은 논리 경계마다 x 를 하나 두고, 그 값은 그 경계에서 끝나는
// 칸들의 (시작 경계 x + 칸 폭) 가운데 최댓값이다(최장 경로 — 채용공고 8×13 표 13경계가 PDF 클립과 0.1pt 안에서
// 일치: 같은 논리 열인데 행마다 58.08/58.52pt 로 저장된 칸은 58.5pt 로 맞춰 그려진다). 칸 폭이 크게 모순되는 표
// (규제영향분석서 24×14)는 그 결과 폭 0 인 논리 열이 여럿 생기고, 화면(PDF)에서는 그 열이 사라진다 — PDF 는 폭 0 열을
// 되살릴 수 없으므로 PDF 표 채점은 폭 0(0.3pt 미만) 논리 열을 접은 격자를 정답지로 쓴다. 폭 0 열이 없는 표는 그대로다.
//
// 반환: 표 id(hp:tbl id = IRTable.sourceId) → { colMap: "rowAddr,colAddr" → [기하 시작열, 끝열) , geoCols }
import JSZip from "jszip"

/** 경계 묶음 오차 (HWPUNIT) — PDF 클립 격자 좌표 묶음(0.3pt)과 같은 폭 */
const GEO_TOL = 30

function tableSegments(xml) {
  const out = []
  for (const m of xml.matchAll(/<hp:tbl\s[^>]*>/g)) {
    const id = /\sid="([^"]*)"/.exec(m[0])?.[1]
    const seg = xml.slice(m.index)
    let depth = 0, end = 0
    for (const t of seg.matchAll(/<hp:tbl\s|<\/hp:tbl>/g)) {
      depth += t[0].startsWith("<hp:tbl") ? 1 : -1
      if (depth === 0) { end = t.index + t[0].length; break }
    }
    out.push({ id, body: seg.slice(m[0].length, end) })
  }
  return out
}

/** 표 본문에서 자기 칸만(중첩표 안 칸 제외) */
function ownCells(body) {
  let flat = "", depth = 0, from = 0
  for (const t of body.matchAll(/<hp:tbl\s|<\/hp:tbl>/g)) {
    if (t[0].startsWith("<hp:tbl")) { if (depth === 0) flat += body.slice(from, t.index); depth++ }
    else { depth--; if (depth === 0) from = t.index + t[0].length }
  }
  flat += body.slice(from)
  const cells = []
  for (const tc of flat.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)) {
    const a = /<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/.exec(tc[0])
    const sp = /<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/.exec(tc[0])
    const sz = /<hp:cellSz\s+width="(\d+)"/.exec(tc[0])
    if (!a || !sp || !sz) return null
    cells.push({ c: +a[1], r: +a[2], cs: +sp[1], rs: +sp[2], w: +sz[1] })
  }
  return cells
}

/** 논리 경계 x — 경계 k = max(그 경계에서 끝나는 칸의 시작 경계 x + 폭), 끝나는 칸이 없으면 앞 경계와 같음 */
function boundaryXs(cells) {
  const count = Math.max(...cells.map(c => c.c + c.cs))
  const endingAt = Array.from({ length: count + 1 }, () => [])
  for (const c of cells) endingAt[c.c + c.cs].push(c)
  const x = new Array(count + 1).fill(0)
  for (let k = 1; k <= count; k++) {
    x[k] = x[k - 1]
    for (const c of endingAt[k]) x[k] = Math.max(x[k], x[c.c] + c.w)
  }
  return x
}

export async function hwpxGeoGrids(buffer) {
  const out = new Map()
  let zip
  // 중앙 디렉터리가 깨진 HWPX 는 파서가 로컬 헤더로 복구해 읽지만 여기선 논리 격자로 채점한다 (정답지 변환 생략)
  try { zip = await JSZip.loadAsync(buffer) } catch { return out }
  const sections = Object.keys(zip.files).filter(n => /^Contents\/section\d+\.xml$/i.test(n))
  for (const name of sections) {
    const xml = await zip.file(name).async("string")
    for (const { id, body } of tableSegments(xml)) {
      if (!id) continue
      const cells = ownCells(body)
      if (!cells?.length) continue
      const x = boundaryXs(cells)
      // 폭 0(GEO_TOL 미만) 논리 열을 접는다 — 경계 k 의 기하 번호 = 앞 경계와 GEO_TOL 넘게 떨어질 때만 +1
      const geoIdx = [0]
      for (let k = 1; k < x.length; k++) geoIdx.push(geoIdx[k - 1] + (x[k] - x[k - 1] > GEO_TOL ? 1 : 0))
      if (geoIdx[geoIdx.length - 1] === x.length - 1) continue // 접힌 열 없음 — 논리 격자 그대로
      const colMap = new Map()
      for (const c of cells) colMap.set(`${c.r},${c.c}`, [geoIdx[c.c], geoIdx[c.c + c.cs]])
      out.set(id, { colMap, geoCols: geoIdx[geoIdx.length - 1] })
    }
  }
  return out
}

/**
 * IR 앵커(논리 격자) → 기하 격자 앵커. 표 id 의 기하 정보가 없거나 칸 대응이 안 되면 null(논리 그대로 채점).
 * 후행 빈 열은 PDF 파서(table-trim)와 같은 규칙으로 자른다 — 칸 단위로 전부 빈 마지막 열, 걸친 칸은 폭 안으로.
 * 빈 칸 판정도 같다: 글도 그림도 블록도 없는 칸 (표시는 IR 셀 text — 그림 참조 포함 — 로 본다. 앵커 text 는
 * 채점용으로 그림을 뺀 글이라 로고만 든 머리표 끝 칸을 빈 칸으로 잘못 본다)
 */
export function toGeoAnchors(grid, geo, table) {
  if (!geo) return null
  const anchors = []
  for (const a of grid.anchors) {
    const m = geo.colMap.get(`${a.r},${a.c}`)
    if (!m || m[1] <= m[0]) return null
    const cell = table?.cells?.[a.r]?.[a.c]
    const filled = cell ? !!(cell.text?.trim() || cell.blocks?.length) : !!a.text.trim()
    anchors.push({ ...a, c: m[0], cs: m[1] - m[0], filled })
  }
  let cols = Math.max(0, ...anchors.map(a => a.c + a.cs))
  // 칸 단위 빈 판정: 그 열에서 시작하는 앵커가 모두 빈 칸 (그 열을 덮는 앞 열 칸은 덮개라 빈 자리로 본다 — PDF 격자와 같음)
  const colEmpty = c => anchors.every(a => a.c !== c || !a.filled)
  while (cols > 1 && colEmpty(cols - 1)) cols--
  const trimmed = anchors.filter(a => a.c < cols).map(({ filled, ...a }) => (a.c + a.cs > cols ? { ...a, cs: cols - a.c } : a))
  return { rows: grid.rows, cols, anchors: trimmed }
}
