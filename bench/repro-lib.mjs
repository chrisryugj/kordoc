/**
 * 공문서 생성 재현율 채점 — 정답지 HWPX 와 생성 HWPX 를 문단 글 순서로 짝지어(부호·공백을 뺀 글 LCS) 역할(□·ㅇ·-·※·*·장·제목·담당·
 * 요약·목차·표 칸)마다 글꼴·크기·굵기·색·정렬·줄간격·문단 위/아래 간격을 대조한다. gen-repro(프리셋 재현)·pack-repro(기관팩 재현)가
 * 같은 채점기를 쓴다.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))

/** style-digest JSON → 문단 목록(표 칸 안까지 문서 순서) */
function flatten(d) {
  const out = []
  const walkP = (p, ctx) => {
    const runs = (p.runs ?? []).filter(r => Array.isArray(r) && r.length > 1).map(([id, t]) => ({ c: d.charPrs[String(id)] ?? {}, t: typeof t === "string" ? t : "" }))
    const text = runs.map(r => r.t).join("")
    out.push({ text, runs, pr: d.paraPrs[String(p.pr)] ?? {}, ctx })
    for (const o of p.objs ?? []) if (o.tbl) walkT(o.tbl, ctx)
  }
  let seq = 0
  const cellText = c => (c?.paras ?? []).map(q => (q.p?.runs ?? []).map(r => (typeof r[1] === "string" ? r[1] : "")).join("")).join("").trim()
  const walkT = (t, ctx) => {
    const id = seq++, head = cellText(t.cells?.[0])
    for (const c of t.cells ?? []) for (const q of c.paras ?? []) if (q.p) walkP(q.p, [...ctx, { rows: +t.rows, cols: +t.cols, rc: c.rc, bf: c.bf, id, head }])
  }
  for (const s of d.sections) for (const b of s.body) if (b.p) walkP(b.p, [])
  return out
}

const MARK = /^[\s ]*(?:[□■ㅇ○◦●\-‐–·ㆍ※*▪▸➊-➓❶-❿①-⑳➀-➉\u{F0000}-\u{FFFFF}]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\.?)[\s ]*/u
// 따옴표·가운뎃점 변형은 문자 다듬기(’ ‘ “ ”)가 바꾸는 표기라 짝짓기에서 접는다 — 서식 비교가 목적
const key = t => t.replace(MARK, "").replace(/[\s \t]+/g, "").replace(/[‘’']/g, "'").replace(/[“”"]/g, '"').replace(/[․‧·ㆍ]/g, "·")

/** 골격 표 역할 — 칸 문단은 가장 안쪽 표 모양으로: 1×3 장 상자(번호|간격|제목), 제목표(2×1 제목/담당, 1×1 제목 상자), 1×1 요약박스 */
function frameRole(x) {
  const t = x.ctx[x.ctx.length - 1]
  if (!t || x.ctx.length !== 1) return null
  if (t.rows === 1 && t.cols === 3) {
    const roman = /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]+\.?$/.test(t.head)
    return (roman ? "장" : "절") + (t.rc === "0,0" ? "번호" : "제목")
  }
  if (t.id === frame.title) return t.rows === 2 && t.cols === 1 && t.rc !== "0,0" ? "담당" : "제목"
  if (t.rows === 1 && t.cols === 1 && t.id === frame.summary) return "요약"
  return null
}
/** 본문 제목 자리 — 일반 문단 또는 제목표 모양(2×1 제목/담당·1×1 제목 상자). 표지의 3×1 띠 제목 표·겹표 속 제목은 아니다 */
const titleShaped = x => x.ctx.length === 0 || (x.ctx.length === 1 && x.ctx[0].cols === 1 && x.ctx[0].rows <= 2)
/** 제목표 — 본문 시작 글(from)이 든 첫 제목표, 요약박스 — 그 다음 첫 1×1 표. 그 밖의 2×1·1×1 상자는 표칸 */
let frame = { title: -1, summary: -1 }
function findFrame(arr, from) {
  const ti = arr.findIndex(x => x.ctx.length === 1 && titleShaped(x) && (!from || key(x.text).includes(key(from))))
  const title = ti >= 0 ? arr[ti].ctx[0].id : -1
  const s = arr.slice(Math.max(ti, 0)).find(x => x.ctx.length === 1 && x.ctx[0].id !== title && x.ctx[0].rows === 1 && x.ctx[0].cols === 1)
  return { title, summary: s ? s.ctx[0].id : -1 }
}

function role(x) {
  const t = x.text.trim()
  const f = frameRole(x)
  if (f) return f
  if (x.ctx.length) return "표칸"
  // 한컴 PUA 글머리 U+F03DA 는 □(둥근 모서리 빈 네모). 숫자 위계 방침서(1. → 1) → ①)는 부호 갈래가 역할
  const m = t.match(/^([□■ㅇ○◦●‐–\-·ㆍ※*▪▸\u{F03DA}])/u)
  if (m) return { "○": "ㅇ", "◦": "ㅇ", "‐": "-", "–": "-", "ㆍ": "·", "■": "□", "\u{F03DA}": "□" }[m[1]] ?? m[1]
  const n = t.match(/^(?:\d{1,2}([.)])|[①-⑳])/u)
  if (n) return n[1] ? `1${n[1]}` : "①"
  return "글"
}

/** 문단의 대표 글자 모양 — 부호 뒤 첫 글자가 든 런 */
function bodyRun(x) {
  const lead = x.text.match(MARK)?.[0].length ?? 0
  let pos = 0
  for (const r of x.runs) {
    if (pos + r.t.length > lead && r.t.slice(Math.max(0, lead - pos)).trim()) return r.c
    pos += r.t.length
  }
  return x.runs.find(r => r.t.trim())?.c ?? {}
}

const fontName = f => typeof f === "object" && f ? (f.h ?? "") : (f ?? "")
const PROPS = {
  글꼴: x => fontName(bodyRun(x).font),
  크기: x => bodyRun(x).pt ?? null,
  굵기: x => bodyRun(x).bold ? 1 : 0,
  색: x => (bodyRun(x).color ?? "#000000").toUpperCase(),
  정렬: x => x.pr.align ?? "JUSTIFY",
  줄간격: x => String(x.pr.lineSp ?? ""),
  위간격: x => Number(x.pr.prev ?? 0),
  아래간격: x => Number(x.pr.next ?? 0),
}

/** 두 key 목록의 LCS 짝 */
function align(a, b) {
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs = []
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++
  }
  return pairs
}

export function digest(buf) {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-repro-"))
  writeFileSync(join(dir, "a.hwpx"), buf)
  execFileSync(process.execPath, ["--import", "tsx", join(root, "..", "scripts", "style-digest.mjs"), join(dir, "a.hwpx"), join(dir, "a.json")], { stdio: "ignore" })
  return JSON.parse(readFileSync(join(dir, "a.json"), "utf8"))
}


/** 정답지·생성본 HWPX 바이트 → 채점 행. from = 본문 시작 글(앞은 표지·점검표) */
export function scoreRepro(gtBuf, genBuf, from) {
const gt = flatten(digest(gtBuf)), gen = flatten(digest(genBuf))
  // 본문 시작 — from 글이 처음 나오는 본문·제목표 문단(표지 안 겹표의 같은 제목은 건너뛴다: 거기서 자르면 LCS 가 표지 제목과 짝을 맺어 제목표가 누락된다)
  const start = arr => { const i = from ? arr.findIndex(x => titleShaped(x) && key(x.text).includes(key(from))) : 0; return Math.max(i, 0) }
  // 마스킹 줄(부분공개 "*****")은 정답 글이 아니다
  const live = x => key(x.text) && !/^\*{5,}$/.test(key(x.text))
  const G = gt.slice(start(gt)).filter(live), H = gen.slice(start(gen)).filter(live)
  // 앞장(표지·사전 검토 점검표·목차) — 본문 시작 앞 문단을 같은 방식으로 짝지어 전 속성 대조. 전자결재가 채우는 칸(결재자 이름·협조란)과
  // 목차 쪽번호는 생성하지 않아 누락으로 남는다
  const FG = gt.slice(0, start(gt)).filter(live), FH = gen.slice(0, start(gen)).filter(live)
  const front = { gt: FG.length, gen: FH.length, matched: 0, ok: 0, n: 0, det: { ok: 0, n: 0 }, bad: [] }
  for (const [i, j] of align(FG.map(x => key(x.text)), FH.map(x => key(x.text)))) {
    front.matched++
    for (const [p, fn] of Object.entries(PROPS)) {
      const hit = fn(FG[i]) === fn(FH[j])
      front.n++; front.ok += hit
      if (!hit) front.bad.push(`${p}: 정답 ${JSON.stringify(fn(FG[i]))} ≠ 생성 ${JSON.stringify(fn(FH[j]))} — ${FG[i].text.trim().slice(0, 24)}`)
      if (["글꼴", "크기", "굵기"].includes(p)) { front.det.n++; front.det.ok += hit }
    }
  }
  const fg = findFrame(G, from), fh = findFrame(H, from)
  const roleOf = (x, side) => { frame = side === "g" ? fg : fh; return role(x) }
  const pairs = align(G.map(x => key(x.text)), H.map(x => key(x.text)))
  const stat = {}
  const bad = []
  for (const [i, j] of pairs) {
    const r = roleOf(G[i], "g")
    if (r === "표칸") continue
    for (const [p, fn] of Object.entries(PROPS)) {
      const s = (stat[`${r}/${p}`] ??= { ok: 0, n: 0 })
      s.n++
      const a = fn(G[i]), b = fn(H[j])
      if (a === b) s.ok++
      else bad.push(`${r}/${p}: 정답 ${JSON.stringify(a)} ≠ 생성 ${JSON.stringify(b)} — ${G[i].text.trim().slice(0, 30)}`)
    }
  }
  const tot = Object.values(stat).reduce((a, s) => ({ ok: a.ok + s.ok, n: a.n + s.n }), { ok: 0, n: 0 })
  // 속성 묶음 — 결정적(스킴이 정함)·손 조정(작성자가 쪽 맞춤으로 문단마다 바꿈)·강조색(원고 표기)
  const GROUPS = { 결정적: ["글꼴", "크기", "굵기"], 손조정: ["정렬", "줄간격", "위간격", "아래간격"], 강조색: ["색"] }
  const group = {}
  for (const [k, st] of Object.entries(stat)) { const p = k.split("/")[1]; const gname = Object.keys(GROUPS).find(g => GROUPS[g].includes(p)); (group[gname] ??= { ok: 0, n: 0 }); group[gname].ok += st.ok; group[gname].n += st.n }
  // 손 조정 상한 — 정답지 문단이 제 역할 최빈값과 같은 비율(한 역할에 한 값만 내는 프리셋이 얻을 수 있는 최대)
  const matchedG = pairs.map(([i]) => G[i]).filter(x => roleOf(x, "g") !== "표칸")
  let ceilOk = 0, ceilN = 0
  for (const p of GROUPS.손조정) {
    const byRole = {}
    for (const x of matchedG) { const r = roleOf(x, "g"); const v = JSON.stringify(PROPS[p](x)); ((byRole[r] ??= new Map()).set(v, (byRole[r].get(v) ?? 0) + 1)) }
    for (const m of Object.values(byRole)) { ceilOk += Math.max(...m.values()); ceilN += [...m.values()].reduce((a, b) => a + b, 0) }
  }
  const pct = g => g && g.n ? (100 * g.ok / g.n).toFixed(1) + "%" : "-"
  const mg = new Set(pairs.map(([i]) => i)), mh = new Set(pairs.map(([, j]) => j))
  const missingFlow = G.filter((x, k) => roleOf(x, "g") !== "표칸" && !mg.has(k))
  const extraFlow = H.filter((x, k) => roleOf(x, "h") !== "표칸" && !mh.has(k))
  const row = { gtParas: G.filter(x => roleOf(x, "g") !== "표칸").length, genParas: H.filter(x => roleOf(x, "h") !== "표칸").length, matched: pairs.filter(([i]) => roleOf(G[i], "g") !== "표칸").length, missing: missingFlow.length, extra: extraFlow.length, props: tot.n ? tot.ok / tot.n : 0, stat, bad,
    missingText: missingFlow.map(x => x.text.trim().slice(0, 40)), extraText: extraFlow.map(x => x.text.trim().slice(0, 40)) }
  row.groups = group; row.handCeiling = ceilN ? ceilOk / ceilN : 1
  row.front = front
  return row
}

/** 채점 행 출력 (gen-repro 와 같은 꼴) */
export function printRow(row, verbose = false) {
  const { stat, bad, front } = row, group = row.groups
  const tot = Object.values(stat).reduce((a, s) => ({ ok: a.ok + s.ok, n: a.n + s.n }), { ok: 0, n: 0 })
  const pct = g => g && g.n ? (100 * g.ok / g.n).toFixed(1) + "%" : "-"
  console.log(`${row.name}: 본문 문단 정답 ${row.gtParas} · 생성 ${row.genParas} · 짝 ${row.matched} (누락 ${row.missing}·잉여 ${row.extra}) | 서식 일치 ${(row.props * 100).toFixed(2)}% (${tot.ok}/${tot.n})`)
  console.log(`  결정적 ${pct(group.결정적)} · 손조정 ${pct(group.손조정)} (정답지 자체 상한 ${(100 * row.handCeiling).toFixed(1)}%) · 강조색 ${pct(group.강조색)}`)
  const byRole = {}
  for (const [k, s] of Object.entries(stat)) { const [r] = k.split("/"); (byRole[r] ??= { ok: 0, n: 0 }); byRole[r].ok += s.ok; byRole[r].n += s.n }
  if (front.gt) console.log(`  앞장(표지·점검표·목차) 정답 ${front.gt} · 생성 ${front.gen} · 짝 ${front.matched} | 서식 일치 ${pct(front)} · 결정적 ${pct(front.det)}`)
  console.log("  역할별 " + Object.entries(byRole).map(([r, s]) => `${r} ${(100 * s.ok / s.n).toFixed(0)}%`).join(" · "))
  const worst = Object.entries(stat).filter(([, s]) => s.ok < s.n).sort((a, b) => (b[1].n - b[1].ok) - (a[1].n - a[1].ok)).slice(0, 12)
  console.log("  불일치 상위 " + worst.map(([k, s]) => `${k} ${s.n - s.ok}`).join(" · "))
  if (verbose) {
    for (const b of front.bad.slice(0, 40)) console.log("    앞장 " + b)
    for (const b of bad.slice(0, 80)) console.log("    " + b)
    console.log("  누락: " + row.missingText.slice(0, 20).join(" / "))
    console.log("  잉여: " + row.extraText.slice(0, 20).join(" / "))
  }
}
