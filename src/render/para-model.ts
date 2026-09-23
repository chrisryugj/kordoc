/**
 * 렌더 문단 모델·표 높이 측정 — HWPX 문단을 슬롯 스트림(글자·필러·탭)과 개체 목록으로 만들고, 표 실효 높이를 잰다.
 * 그리기(svg-render)와 조판 합성(reflow)이 공유하는 순수 계층 — 그리기 코드에 의존하지 않는다.
 */

import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { toInt32, solveRowHeights } from "./layout.js"
import { type RenderParaGeom } from "./head-styles.js"

export function ln(el: Element): string {
  return (el.tagName || "").replace(/^[^:]+:/, "")
}

export function elements(el: Element): Element[] {
  const out: Element[] = []
  const children = el.childNodes
  if (!children) return out
  for (let i = 0; i < children.length; i++) {
    if (children[i].nodeType === 1) out.push(children[i] as Element)
  }
  return out
}

export function num(el: Element | null, attr: string, fallback = 0): number {
  return el ? toInt32(el.getAttribute(attr) ?? undefined, fallback) : fallback
}

export function findFirst(el: Element, name: string, depth = 0): Element | null {
  if (depth > 64) return null
  for (const ch of elements(el)) {
    if (ln(ch) === name) return ch
    const found = findFirst(ch, name, depth + 1)
    if (found) return found
  }
  return null
}

export interface Seg { textpos: number; vertpos: number; horzpos: number; horzsize: number; textheight: number; baseline: number }

/** tab: 탭 컨트롤 첫 슬롯(나머지 7슬롯은 필러) — 폭은 줄 조판 때 탭 정지점으로 정한다. tabW: 저장된 hp:tab width.
 * nb: 묶음 빈칸(hp:nbSpace) — 그리기는 공백, 줄바꿈은 끊지 않는 빈칸(U+00A0) */
export interface ParaChar { ch: string; prId: string | null; tab?: boolean; tabW?: number; nb?: boolean }

/** 렌더 대상 개체 태그 — 이 외(도형류)는 경고 후 생략 */
export const OBJ_TAGS = new Set(["tbl", "pic", "container", "equation", "rect", "ellipse", "polygon", "curv", "line", "arc", "ole", "textart"])

/** omL/omR: TAC 인라인 표의 outMargin 좌/우(HWPUNIT) — 한글은 TAC 표를 "outMargin 포함
 * 폭의 문자"로 배치한다: 가로 전진폭 = om좌 + 표폭 + om우, 괘선(표 자체)은 pen + om좌
 * (rhwp #3396 동종 — 오라클 실측이 표뿐이라 표 외 개체는 0). */
export interface ParaObj { el: Element; tag: string; index: number; inline: boolean; width: number; height: number; omL: number; omR: number }

export interface ParaModel { chars: ParaChar[]; segs: Seg[]; objs: ParaObj[]; paraPrId: string | null }

/** hp:t 안에서 1슬롯을 차지하는 문자형 컨트롤 (HWP5 문자 스트림 모델) —
 * 탭(0x09)은 char가 아니라 inline 컨트롤 = 8슬롯(16바이트)이라 여기 넣으면 안 된다
 * (record.ts 0x09 처리의 i+=14와 같은 모델. 1슬롯로 세면 탭당 7슬롯씩 줄 경계가 밀린다) */
export const CHAR_CTRL_1SLOT = new Set(["lineBreak", "hyphen", "nbSpace", "fwSpace"])

/** lineseg textpos 정합용 0폭 필러 슬롯 — 컨트롤이 차지하는 문자 위치를 채운다 */
export function pushFillers(chars: ParaChar[], n: number, prId: string | null): void {
  for (let i = 0; i < n; i++) chars.push({ ch: "", prId })
}

/**
 * hp:t 내용을 슬롯 스트림으로 변환 — lineseg textpos 는 HWP5 문자 스트림 기준이라
 * 텍스트 1문자=1슬롯(서로게이트 쌍은 2), tab 등 문자형 컨트롤도 1슬롯을 차지한다.
 * markpen 등 래퍼 요소는 슬롯 없이 내용만 재귀한다.
 * (탭 폭은 planLines 가 탭 정지점 — 내어쓰기용 자동 탭·기본 40pt 간격 — 으로 정한다)
 */
export function pushTextSlots(t: Element, chars: ParaChar[], prId: string | null, depth: number): void {
  if (depth > 32) return
  const kids = t.childNodes
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.nodeType === 3 || c.nodeType === 4) {  // CDATA(4) 포함 — 누락 시 해당 런이 렌더에서 사라진다
      for (const cp of c.textContent ?? "") {
        chars.push({ ch: cp, prId })
        if (cp.length === 2) chars.push({ ch: "", prId }) // UTF-16 두 번째 유닛 슬롯
      }
    } else if (c.nodeType === 1) {
      const el = c as Element
      const tag = ln(el)
      if (tag === "tab") {
        // inline 컨트롤 8슬롯 — 첫 슬롯에 탭 표지(폭은 planLines 가 탭 정지점으로), 나머지는 필러
        chars.push({ ch: "", prId, tab: true, tabW: num(el, "width") })
        pushFillers(chars, 7, prId)
      } else if (CHAR_CTRL_1SLOT.has(tag)) {
        chars.push(tag === "nbSpace" ? { ch: " ", prId, nb: true } : { ch: tag === "fwSpace" ? " " : "", prId })
      } else {
        pushTextSlots(el, chars, prId, depth + 1)
      }
    }
  }
}

export function buildPara(p: Element): ParaModel {
  const chars: ParaChar[] = []
  const objs: ParaObj[] = []
  let segs: Seg[] = []
  for (const runEl of elements(p)) {
    const tag = ln(runEl)
    if (tag === "run") {
      const prId = runEl.getAttribute("charPrIDRef")
      for (const ch of elements(runEl)) {
        const cn = ln(ch)
        if (cn === "t") {
          pushTextSlots(ch, chars, prId, 0)
        } else if (OBJ_TAGS.has(cn)) {
          const sz = findChildByLocalName(ch, "sz")
          const pos = findChildByLocalName(ch, "pos")
          // 그리기 도형은 hp:sz가 없다 — curSz(>0) → orgSz 폴백
          const w = num(sz, "width") || num(findChildByLocalName(ch, "curSz"), "width") || num(findChildByLocalName(ch, "orgSz"), "width")
          const h = num(sz, "height") || num(findChildByLocalName(ch, "curSz"), "height") || num(findChildByLocalName(ch, "orgSz"), "height")
          const inline = pos?.getAttribute("treatAsChar") === "1"
          // TAC 표만 outMargin 좌/우를 가로 배선 (ParaObj.omL 주석 — rhwp #3396 동종)
          const om = inline && cn === "tbl" ? findChildByLocalName(ch, "outMargin") : null
          objs.push({
            el: ch, tag: cn, index: chars.length,
            inline,
            width: w, height: h,
            omL: num(om, "left"), omR: num(om, "right"),
          })
          // 확장 컨트롤(GSO 등)은 문자 스트림에서 8슬롯 — 실측: 데모 코퍼스 1,132개
          // 멀티라인 문단에서 textpos 가 8슬롯 블록 중간에 걸린 경계 0건
          pushFillers(chars, 8, prId)
        } else {
          // secPr·ctrl(구역/단 정의)·필드 등 나머지 run 자식도 확장/인라인 컨트롤 8슬롯
          pushFillers(chars, 8, prId)
        }
      }
    } else if (tag === "linesegarray") {
      segs = elements(runEl).filter(s => ln(s) === "lineseg").map(s => ({
        textpos: num(s, "textpos"), vertpos: num(s, "vertpos"), horzpos: num(s, "horzpos"),
        horzsize: num(s, "horzsize"), textheight: num(s, "textheight", 1000), baseline: num(s, "baseline", 850),
      }))
    }
  }
  return { chars, segs, objs, paraPrId: p.getAttribute("paraPrIDRef") }
}

/** 한컴 기본 탭 간격 40pt (실결재 secPr tabStopVal 4000) */
export const DEFAULT_TAB_HU = 4000

/**
 * 탭 전진폭 — x 는 문단 왼쪽 여백 기준. 첫 줄은 내어쓰기용 자동 탭(autoTabLeft)이면 내어쓰기 위치가
 * 정지점(법제처 서식 "(a)⇥" 실측: 부호폭 + 탭폭 = 내어쓰기). 그 밖엔 저장된 폭(한컴이 조판 때 잰 값 —
 * 문서 고유 탭 정의를 대신한다), 없으면 기본 간격 배수.
 */
export function tabAdvance(x: number, firstLine: boolean, geom: RenderParaGeom | undefined, saved = 0): number {
  const hang = geom && geom.marginIntent < 0 ? -geom.marginIntent : 0
  if (firstLine && geom?.autoTabLeft && hang > 0 && x < hang - 0.5) return hang - x
  if (saved > 0) return saved
  return (Math.floor(x / DEFAULT_TAB_HU) + 1) * DEFAULT_TAB_HU - x
}

export interface CellModel {
  el: Element
  ca: number; ra: number; cs: number; rs: number
  w: number; h: number
  bfId: string | null
  sub: Element | null
  marginL: number; marginR: number; marginT: number; marginB: number
}

/**
 * 셀/표 측정 메모 — drawTable(rowH·yoff)과 cellContentExtent↔measureTableHeight 상호재귀가
 * 중첩 단계마다 하위 표를 재측정해 지수적으로 불어나는 것을 캡. 렌더 1회 안에서만 공유
 * (reflow의 DOM 변형은 드로잉 시작 전에 끝나므로 캐시가 stale해지지 않는다).
 */
export interface ExtentMemo { cell: WeakMap<Element, number>; table: WeakMap<Element, number> }

/** 셀 콘텐츠 세로 범위 — 줄(vp+th) + 인라인 개체(중첩표·treatAsChar) + PARA 앵커 개체(anchor+h) 최대값 */
export function cellContentExtent(cell: CellModel, memo?: ExtentMemo): number {
  if (!cell.sub) return 0
  const hit = memo?.cell.get(cell.el)
  if (hit !== undefined) return hit
  let ext = 0
  for (const p of elements(cell.sub)) {
    if (ln(p) !== "p") continue
    const m = buildPara(p)
    for (const s of m.segs) ext = Math.max(ext, s.vertpos + s.textheight)
    const baseV = m.segs[0]?.vertpos ?? 0
    for (const o of m.objs) {
      if (o.inline) {
        // 인라인 개체(중첩 표·treatAsChar 이미지)는 줄 위치에서 개체 높이만큼 아래로 뻗는다.
        // 이를 빼먹으면 중첩 표를 담은 셀 높이가 과소측정돼 표지 중첩표가 겹친다(리뷰: 셀 성장 누락).
        const h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, memo)) : o.height
        ext = Math.max(ext, baseV + h)
        continue
      }
      const pos = findChildByLocalName(o.el, "pos")
      if ((pos?.getAttribute("vertRelTo") ?? "PARA") !== "PARA") continue
      const om = findChildByLocalName(o.el, "outMargin")
      const pushed = baseV - (num(om, "top") + o.height + num(om, "bottom"))
      const anchor = pushed >= -100 ? pushed : baseV
      ext = Math.max(ext, anchor + num(om, "top") + num(pos, "vertOffset") + o.height)
    }
  }
  memo?.cell.set(cell.el, ext)
  return ext
}

/** tbl의 셀 모델 수집 — drawTable과 measureTableHeight가 같은 셀 해석을 공유 */
export function collectCells(tbl: Element): CellModel[] {
  const inMargin = findChildByLocalName(tbl, "inMargin")
  const defL = num(inMargin, "left", 141), defR = num(inMargin, "right", 141)
  const defT = num(inMargin, "top", 141), defB = num(inMargin, "bottom", 141)

  const cells: CellModel[] = []
  for (const tr of elements(tbl)) {
    if (ln(tr) !== "tr") continue
    for (const tc of elements(tr)) {
      if (ln(tc) !== "tc") continue
      const addr = findChildByLocalName(tc, "cellAddr")
      const span = findChildByLocalName(tc, "cellSpan")
      const csz = findChildByLocalName(tc, "cellSz")
      const cm = findChildByLocalName(tc, "cellMargin")
      if (!addr || !csz) continue
      cells.push({
        el: tc,
        // 음수 주소(uint32 역변환·손상 입력) 방어 — colX/rowY 인덱스 이탈로 NaN 좌표 방지
        ca: Math.max(0, num(addr, "colAddr")), ra: Math.max(0, num(addr, "rowAddr")),
        cs: Math.max(1, num(span, "colSpan", 1)), rs: Math.max(1, num(span, "rowSpan", 1)),
        w: num(csz, "width"), h: num(csz, "height"),
        bfId: tc.getAttribute("borderFillIDRef"),
        sub: findChildByLocalName(tc, "subList"),
        marginL: cm ? num(cm, "left", defL) : defL, marginR: cm ? num(cm, "right", defR) : defR,
        marginT: cm ? num(cm, "top", defT) : defT, marginB: cm ? num(cm, "bottom", defB) : defB,
      })
    }
  }
  return cells
}

/**
 * 표 실효 높이(HWPUNIT) — drawTable의 rowH 모델(solveRowHeights + 셀 콘텐츠 성장) 그대로.
 * 선언 hp:sz는 셀 콘텐츠로 자란 높이를 모르므로, reflow가 표 뒤 문단을 실제 그려질
 * 표 바닥 아래로 배치할 때 이 값을 쓴다. 셀 lineseg가 있어야 성장분이 측정된다.
 */
export function measureTableHeight(tbl: Element, memo?: ExtentMemo): number {
  const hit = memo?.table.get(tbl)
  if (hit !== undefined) return hit
  const cells = collectCells(tbl)
  if (cells.length === 0 || cells.length > 4096) return 0
  const nRows = Math.max(...cells.map(c => c.ra + c.rs))
  const rowH = solveRowHeights(
    cells.map(c => ({ rowAddr: c.ra, rowSpan: c.rs, height: c.h, contentH: c.rs === 1 ? cellContentExtent(c, memo) : undefined })),
    nRows,
  )
  let sum = 0
  for (const h of rowH) sum += h
  memo?.table.set(tbl, sum)
  return sum
}
