#!/usr/bin/env node
/**
 * 기관별 서식 실측값 → src/hwpx/agency-styles.ts 생성.
 *
 * 원천: UpstageAI/korean-report-hwpx (MIT, THIRD_PARTY/korean-report-hwpx.LICENSE) — 정책브리핑 보도자료 HWPX 2,670건(52개
 * 중앙행정기관) 전수 파싱 결과. 원본 문서·본문은 없고 서식 수치만 있다.
 *   rules/<기관>.json         보도자료 본문 계층별 글꼴·크기, 본문 방식(문단식/□식)   (기본값 rules/_전체.json)
 *   rules_report/<기관>.json  보도자료 참고·붙임 구간(보고서형) 계층별 글꼴·크기·표 머리 (기본값 _공통.json pooled)
 *   rules_report/_참고머리.json 참고·붙임 쪽 머리 표 라벨 칸 색 (11,338건)
 * 계층값 보정은 원 저장소 렌더러(engine/compose.py Composer.level, engine/report.py)와 같게 한다 — 표본 5개 미만 계층의
 * 크기는 공통값, 하위 계층은 상위보다 크지 않게, 본문 계층에 섞인 제목 서체는 본문 서체로, 주석·참고는 13pt 넘으면 12pt.
 *
 * 사용: node scripts/build-agency-styles.mjs <korean-report-hwpx 체크아웃>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const src = process.argv[2]
if (!src) { console.error("사용: node scripts/build-agency-styles.mjs <korean-report-hwpx 체크아웃>"); process.exit(1) }
const pkg = join(src, "korean_report_hwpx")
const read = (p) => JSON.parse(readFileSync(join(pkg, p), "utf8"))
const names = (dir) => readdirSync(join(pkg, dir)).filter(f => f.endsWith(".json") && !f.startsWith("_")).map(f => f.slice(0, -5)).sort()
const commit = execFileSync("git", ["-C", src, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim()

const HEADLINE = new Set(["HY헤드라인M", "HY울릉도M", "궁서", "맑은 고딕", "돋움"])
const DISPLAY = new Set(["궁서", "HY헤드라인M", "HY울릉도M", "HY견명조"])
const DEFAULTS = { l1: "□", l2: "ㅇ", l3: "-", note: "*", ref: "※", p: "" }

/** compose.py Composer.level (+ report.py ReportComposer.level 의 □ HY헤드라인M 유지) */
function levelOf(R, base, lv, report, memo = {}) {
  if (memo[lv]) return memo[lv]
  const L = R.levels[lv] ?? base.levels[lv] ?? {}
  const out = { mark: L.mark ?? DEFAULTS[lv], font: L.font || "바탕", pt: L.pt || 14 }
  const b = base.levels[lv] ?? {}
  if ((L.n ?? 0) < 5 && b.pt) out.pt = b.pt
  if ((lv === "note" || lv === "ref") && out.pt > 13) out.pt = 12
  if (["l1", "l2", "l3", "p"].includes(lv)) {
    const body = R.levels[R.style === "para" ? "p" : "l1"] ?? {}
    if (HEADLINE.has(out.font) && body.font && body.font !== out.font) out.font = body.font
    if (DISPLAY.has(out.font)) out.font = "바탕"
  }
  if (lv === "l2" || lv === "l3") out.pt = Math.min(out.pt, levelOf(R, base, lv === "l2" ? "l1" : "l2", report, memo).pt)
  if (report && lv === "l1" && L.font === "HY헤드라인M") { out.font = "HY헤드라인M"; out.pt = L.pt || out.pt }
  return (memo[lv] = out)
}
const fp = (l) => ({ font: l.font, pt: l.pt })
const BULLET2 = new Set(["ㅇ", "○", "◦", "❍"])
const bullet2 = (R, base) => { const m = R.levels.l2?.mark ?? base.levels.l2?.mark; return BULLET2.has(m) ? m : "ㅇ" }

// ── 보고서형(참고·붙임 구간) ──
const commonR = read("rules_report/_공통.json")
const reportBase = (() => {
  const r = commonR.pooled, it = commonR.items ?? {}
  const v = (k, d) => it[k]?.value ?? d
  return { ...r, table_head: { ...r.table_head, font: v("표머리.font", "맑은 고딕"), pt: v("표머리.pt", 12), fill: v("표머리.fill", "#DFE6F7") } }
})()
function reportStyle(R) {
  R = { ...R, style: "box" } // 보고서는 개조식 (report.py load_rules)
  const memo = {}
  const lv = (k) => fp(levelOf(R, reportBase, k, true, memo))
  const th = { ...reportBase.table_head }
  for (const [k, val] of Object.entries(R.table_head ?? {})) if (val !== null && val !== "" && val !== "없음") th[k] = val
  return {
    docs: R.n_docs ?? reportBase.n_docs,
    levels: [lv("l1"), lv("l2"), lv("l3")], note: lv("note"), ref: lv("ref"), p: lv("p"),
    bullet2: bullet2(R, reportBase),
    table: { font: th.font, pt: th.pt, fill: th.fill },
  }
}

// ── 보도자료 본문 ──
const pressBase = read("rules/_전체.json")
function pressStyle(R) {
  const memo = {}
  const lv = (k) => fp(levelOf(R, pressBase, k, false, memo))
  return {
    paras: R.n_paras, style: R.style === "para" ? "para" : "box", share: R.body_share,
    levels: [lv("l1"), lv("l2"), lv("l3")], note: lv("note"), p: lv("p"),
    bullet2: bullet2(R, pressBase),
  }
}

// ── 참고·붙임 머리 표 라벨 칸 색 ──
const head = read("rules_report/_참고머리.json")
const light = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160
}
function band(org) {
  const lb = { ...head.common.label, ...(org ? head.orgs[org]?.label : {}) }
  if (!lb.fill) return { fill: null, text: "#000000" }
  // 원 저장소는 글자색 기본을 흰색으로 둔다 — 연한 바탕(교육부 #DFE6F7 등)은 검정 글자로 (여기서 정한 규칙)
  const text = (org && head.orgs[org]?.label?.color) || (light(lb.fill) ? "#000000" : (head.common.label.color ?? "#FFFFFF"))
  return { fill: lb.fill.toUpperCase(), text: text.toUpperCase() }
}

const reportOrgs = new Set(names("rules_report")), pressOrgs = new Set(names("rules"))
// 현행 52개 기관(templates) — 머리 표 집계에만 남은 옛 이름(기획재정부·저출산고령사회위원회)은 뺀다
const all = names("templates").sort((a, b) => a.localeCompare(b, "ko"))
const data = {}
for (const org of all) {
  data[org] = {
    report: reportOrgs.has(org) ? reportStyle(read(`rules_report/${org}.json`)) : null,
    press: pressOrgs.has(org) ? pressStyle(read(`rules/${org}.json`)) : null,
    band: head.orgs[org] ? band(org) : null,
  }
}
const common = { report: reportStyle(reportBase), press: pressStyle(pressBase), band: band(null) }

const out = `/**
 * 기관별 공문서 서식 실측값 — 자동 생성 파일, 고치지 말 것 (scripts/build-agency-styles.mjs).
 *
 * 원천: UpstageAI/korean-report-hwpx @${commit} (MIT, THIRD_PARTY/korean-report-hwpx.LICENSE) — 정책브리핑 보도자료 HWPX
 * ${commonR.n_docs.toLocaleString("en-US")}건(${all.length}개 중앙행정기관) 전수 파싱. report = 보도자료 참고·붙임 구간(보고서형, ${commonR.n_docs_report.toLocaleString("en-US")}건)의 계층별 글꼴·크기와
 * 표 머리, press = 보도자료 본문, band = 참고·붙임 쪽 머리 표 라벨 칸 색(${head.n_docs.toLocaleString("en-US")}건). null 은 그 기관 표본이 모자라
 * 원천에 규칙이 없는 항목(공통값을 쓴다). levels 는 □·ㅇ·- 순, 굵기는 원천에 없어 보통으로 그린다(원 저장소 렌더와 같음).
 */

export interface AgencyFont { font: string; pt: number }
export type AgencyBullet2 = "ㅇ" | "○" | "◦" | "❍"

export interface AgencyReportStyle {
  /** 규칙을 산출한 문서 수 */
  docs: number
  levels: [AgencyFont, AgencyFont, AgencyFont]
  note: AgencyFont
  ref: AgencyFont
  p: AgencyFont
  bullet2: AgencyBullet2
  table: { font: string; pt: number; fill: string }
}

export interface AgencyPressStyle {
  /** 규칙을 산출한 본문 문단 수 */
  paras: number
  /** 본문 방식 — para: 기호 없는 기사체 문단 위주, box: □ → ㅇ 개조식 */
  style: "para" | "box"
  /** 그 방식 문단의 비율 */
  share: number
  levels: [AgencyFont, AgencyFont, AgencyFont]
  note: AgencyFont
  p: AgencyFont
  bullet2: AgencyBullet2
}

export interface AgencyStyle {
  report: AgencyReportStyle | null
  press: AgencyPressStyle | null
  band: { fill: string | null; text: string } | null
}

export const AGENCY_COMMON: AgencyStyle = ${JSON.stringify(common)}

export const AGENCY_STYLES: Record<string, AgencyStyle> = {
${all.map(o => `  ${JSON.stringify(o)}: ${JSON.stringify(data[o])},`).join("\n")}
}
`
const dst = join(dirname(fileURLToPath(import.meta.url)), "..", "src/hwpx/agency-styles.ts")
writeFileSync(dst, out)
console.log(`${dst} — 기관 ${all.length}곳 (보고서 ${reportOrgs.size}·보도자료 ${pressOrgs.size}·머리 표 ${Object.keys(head.orgs).length})`)
