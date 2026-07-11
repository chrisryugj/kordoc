/**
 * 공문서 부속 골격(docframe) — 기안문 두문·결문, 보고정보 행, 공고문 두문·결문,
 * 보도자료 머리박스·담당 표 (v4.1.0 GAP-02/03/04/08).
 *
 * 실측 근거:
 *   기안문 두문·결문 — 행안부 별지 제1호서식 (hwpx-skill gonmun.py 실측 이식:
 *     기관명 18pt bold CENTER / 발신명의 22pt bold CENTER / 결문 9pt + 구분선 / 라벨 bold)
 *   보고정보 행 — 「3_보고서 양식」 휴먼명조 12pt RIGHT "(보고일시, 보고자(과장), 연락처)"
 *   공고문 — 바이오헬스 공고문 실물: 공고번호 본문크기 bold 좌 / 날짜 RIGHT / 발신명의 bold RIGHT
 *   보도자료 — 국토부 실물(bodojaryo-reference): 머리박스 + 보도시점/배포(돋움 10pt bold)
 *     + 제목 25pt bold + 본문 □→ㅇ→*(각주 12pt) + 담당 표
 *
 * charPr id는 정적 블록·장평 variant·서식 프로필 뒤 동적 base에서 할당 — generator가 배선.
 */

import { type ResolvedGongmun } from "./gongmun.js"
import { charPr, escapeXml, CHAR_NORMAL, CHAR_BOLD, PARA_NORMAL, GONGMUN_CENTER, GONGMUN_RIGHT, GONGMUN_TBL_CENTER, GONGMUN_TBL_LEFT } from "./gen-ids.js"
import { tbl, tc, para } from "./gen-gongmun-extra.js"
import { TableBfRegistry } from "./gen-table-bf.js"

// ─── charPr 슬롯 (base + 오프셋, 고정 순서) ───────────

export const DOCFRAME_CHAR_COUNT = 9

export interface DocframeIds {
  org: number        // 기안문 기관명 — 18pt bold
  sender: number     // 발신명의 — 22pt bold
  foot: number       // 결문 — 9pt
  small: number      // 보고정보 행·보도자료 각주 — 12pt
  pressLabel: number // "보도자료" — 20pt bold
  pressHead: number  // 보도시점/배포 — 10pt bold
  pressTitle: number // 보도자료 제목 — 25pt bold
  pressSub: number   // 보도자료 부제 — 15pt bold
  pressContact: number // 담당 표 값 — 10pt
}

export function docframeIds(base: number): DocframeIds {
  return { org: base, sender: base + 1, foot: base + 2, small: base + 3, pressLabel: base + 4, pressHead: base + 5, pressTitle: base + 6, pressSub: base + 7, pressContact: base + 8 }
}

/** docframe 기능이 하나라도 켜졌는지 — 꺼져 있으면 charPr 미방출(기존 산출물 불변) */
export function docframeActive(g: ResolvedGongmun): boolean {
  return !!(g.docHead || g.docFoot || g.reportInfo || g.noticeHead || g.press)
}

/** docframe 전용 charPr 9종 — rich 폰트세트(실측 프리셋·표지·목차)는 본문=id 4, 그 외 id 0 */
export function docframeCharPrXmls(base: number, richAssets: boolean): string[] {
  const body = richAssets ? 4 : 0
  const ids = docframeIds(base)
  return [
    charPr(ids.org, 1800, true, false, body),
    charPr(ids.sender, 2200, true, false, body),
    charPr(ids.foot, 900, false, false, body),
    charPr(ids.small, 1200, false, false, body),
    charPr(ids.pressLabel, 2000, true, false, body),
    charPr(ids.pressHead, 1000, true, false, body),
    charPr(ids.pressTitle, 2500, true, false, body),
    charPr(ids.pressSub, 1500, true, false, body),
    charPr(ids.pressContact, 1000, false, false, body),
  ]
}

// ─── 문단 헬퍼 ──────────────────────────────────────

/** 라벨(bold) + 내용 두 run 문단 — "수신  ○○" 꼴 */
function labeled(label: string, value: string, paraPrId: number): string {
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">`
    + `<hp:run charPrIDRef="${CHAR_BOLD}"><hp:t>${escapeXml(label)}</hp:t></hp:run>`
    + `<hp:run charPrIDRef="${CHAR_NORMAL}"><hp:t>${escapeXml(value)}</hp:t></hp:run></hp:p>`
}

function blank(): string {
  return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}"><hp:t></hp:t></hp:run></hp:p>`
}

// ─── 기안문 두문 (별지 제1호서식) ─────────────────────

export function buildDocHead(g: ResolvedGongmun, ids: DocframeIds): string[] {
  const h = g.docHead!
  const out: string[] = []
  if (h.org) { out.push(para(h.org, GONGMUN_CENTER, ids.org), blank()) }
  if (h.to !== undefined) out.push(labeled("수신  ", h.to, PARA_NORMAL))
  out.push(para(h.via ? `(경유)  ${h.via}` : "(경유)", PARA_NORMAL, CHAR_NORMAL))
  if (h.title !== undefined) out.push(labeled("제목  ", h.title, PARA_NORMAL))
  out.push(blank())
  return out
}

// ─── 기안문 결문 ────────────────────────────────────

/** 결문 구분선 — 서식의 가로줄을 텍스트 룰로 (gonmun.py 준용) */
const FOOT_SEP = "─".repeat(46)

export function buildDocFoot(g: ResolvedGongmun, ids: DocframeIds): string[] {
  const f = g.docFoot!
  const out: string[] = [blank()]
  if (f.sender) { out.push(para(f.sender, GONGMUN_CENTER, ids.sender), blank()) }
  const foot = (text: string) => para(text, GONGMUN_TBL_LEFT, ids.foot)
  out.push(foot(FOOT_SEP))
  if (f.drafter || f.reviewer || f.approver)
    out.push(foot(`기안자 ${f.drafter ?? ""}      검토자 ${f.reviewer ?? ""}      결재권자 ${f.approver ?? ""}`))
  if (f.cooperator) out.push(foot(`협조자 ${f.cooperator}`))
  if (f.docNum || f.receive) out.push(foot(`시행  ${f.docNum ?? ""}        접수  ${f.receive ?? ""}`))
  if (f.address || f.site) out.push(foot(`${f.address ?? ""}      /  ${f.site ?? ""}`))
  if (f.phone || f.fax || f.email || f.disclosure)
    out.push(foot(`전화 ${f.phone ?? ""}      전송 ${f.fax ?? ""}      /  ${f.email ?? ""}      /  ${f.disclosure ?? ""}`))
  return out
}

// ─── 업무보고 보고정보 행 (실측 t3: 휴먼명조 12pt RIGHT) ──

export function buildReportInfo(g: ResolvedGongmun, ids: DocframeIds): string {
  return para(g.reportInfo!, GONGMUN_RIGHT, ids.small)
}

// ─── 공고문 두문·결문 (실측: 바이오헬스 공고문) ─────────

export function buildNoticeHead(g: ResolvedGongmun): string[] {
  const n = g.noticeHead!
  return n.no ? [para(n.no, PARA_NORMAL, CHAR_BOLD), blank()] : []
}

export function buildNoticeFoot(g: ResolvedGongmun): string[] {
  const n = g.noticeHead!
  const out: string[] = []
  if (n.date) out.push(blank(), para(n.date, GONGMUN_RIGHT, CHAR_NORMAL))
  if (n.sender) out.push(blank(), para(n.sender, GONGMUN_RIGHT, CHAR_BOLD))
  return out
}

// ─── 보도자료 머리박스·담당 표 ────────────────────────

const PRESS_LABEL_H = 3200
const PRESS_HEAD_H = 900

/** 머리박스 — "보도자료" 라벨 행 + 보도시점/배포 행 (외곽 0.4mm, 실물 골격 단순화) */
export function buildPressHead(g: ResolvedGongmun, ids: DocframeIds, bodyWidth: number, reg: TableBfRegistry): string[] {
  const p = g.press!
  const w = bodyWidth - 280
  const thick = { t: "thick", b: "thick", l: "thick", r: "thick" } as const
  const rows = [tc({ bf: reg.get({ ...thick, b: "thin" }), row: 0, col: 0, w, h: PRESS_LABEL_H, paras: para("보도자료", GONGMUN_TBL_CENTER, ids.pressLabel) })]
  const headLine = [
    p.release ? `보도시점 : ${p.release}` : "",
    p.distribute ? `배포 : ${p.distribute}` : "",
  ].filter(Boolean).join(" / ")
  if (headLine) rows.push(tc({ bf: reg.get({ ...thick, t: "thin" }), row: 1, col: 0, w, h: PRESS_HEAD_H, paras: para(headLine, GONGMUN_TBL_CENTER, ids.pressHead) }))
  const table = tbl(rows, w, PRESS_LABEL_H + (headLine ? PRESS_HEAD_H : 0), 1)
  return [`<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${table}</hp:run></hp:p>`, blank()]
}

/** 담당 표 — 담당 부서 | 담당자 | 연락처 1행 (실물 표3의 단순화) */
export function buildPressContact(g: ResolvedGongmun, ids: DocframeIds, bodyWidth: number, reg: TableBfRegistry): string[] {
  const c = g.press?.contact
  if (!c || (!c.dept && !c.manager && !c.phone)) return []
  const w = bodyWidth - 280
  const cells = [["담당 부서", c.dept ?? ""], ["담당자", c.manager ?? ""], ["연락처", c.phone ?? ""]]
  const labelW = Math.round(w * 0.14)
  const valueW = Math.round(w / 3) - labelW
  let col = 0
  const row = cells.flatMap(([label, value], i) => {
    const bf = (first: boolean) => reg.get({
      t: "thick", b: "thick",
      l: first && i === 0 ? "thick" : "thin",
      r: !first && i === cells.length - 1 ? "thick" : "thin",
      fill: first ? "#E6E6E6" : undefined,
    })
    return [
      tc({ bf: bf(true), row: 0, col: col++, w: labelW, h: 1100, paras: para(label, GONGMUN_TBL_CENTER, ids.pressHead) }),
      tc({ bf: bf(false), row: 0, col: col++, w: valueW, h: 1100, paras: para(value, GONGMUN_TBL_CENTER, ids.pressContact) }),
    ]
  })
  const table = tbl([row.join("")], w, 1100, cells.length * 2)
  return [blank(), `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${table}</hp:run></hp:p>`]
}
