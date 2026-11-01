/**
 * 래스터 괘선 감지 — 스캔/이미지 페이지의 픽셀에서 표 괘선(수평/수직 선)을
 * 찾아 선 기반 표 파이프라인(line-detector → table-grid)에 공급한다.
 *
 * PDF 그래픽 ops 가 없는 OCR 경로는 종전에 클러스터 감지기만 탔는데,
 * 병합 라벨 셀 + 다중줄 서술형 서식(정부 제출 서식류)은 라인 클러스터로
 * 행 경계를 잡을 수 없다. 괘선은 이미지에 실존하므로 이진화 + 런렝스로
 * 직접 감지한다 — ML 없음, 축 정렬 전제(스캔 스큐 보정은 스코프 밖).
 *
 * 오탐 방어 3겹 (실측: 우수사례 제출 서식 스캔 — 진짜 괘선은 길고 얇음):
 * - 최소 길이 20pt: 글리프 획(가로 ≤한 글자폭·세로 ≤글자높이)은 걸러짐
 * - 두께 상한 2.5pt: 굵은 제목 획(6~13px)·텍스트 줄 밴드·채운 색상바 탈락
 * - 양측 잉크 포위 제외: 색상바(붙임 박스 등) 안 흰 글자 틈새 슬리버 탈락
 *
 * 텍스트층 경로가 선으로 받는 것 중 잉크 런렝스로 안 보이는 두 가지도 선으로 낸다 — 점선 괘선(DOT_*),
 * 채움 사각형의 변(FILL_*). 둘 다 표 괘선에 맞물린 것만.
 */

import type { LineSegment } from "../pdf/line-types.js"

/**
 * 잉크 판정 휘도 상한 — 셀 배경 음영(회색 ~220)은 통과, 실선(진회~검정·남색)만 잉크. 0.12mm 가는 괘선이 픽셀 경계에
 * 걸려 두 픽셀로 번지면 픽셀마다 192~207 이라 190 에선 놓쳤다(ice-geomjeong 시험일정표 "구분│일자" 세로선, ktdb 목록표)
 */
const INK_LUMA_MAX = 205
/** 최소 선 길이 (pt) — 최소 셀 변(≈7mm)과 대형 글리프 획(≤1em) 사이 */
const MIN_LINE_LENGTH_PT = 20
/** 두 가로 괘선을 잇는 짧은 세로선의 최소 길이 (pt) — 조직도 상자 사이 연결선(16pt) */
const BRIDGE_MIN_LENGTH_PT = 6
/** 연결선이 잇는 상자의 최소 폭 (pt) */
const BRIDGE_BOX_MIN_PT = 30
/** 선 두께 상한 (pt) — 진짜 괘선(0.12~0.7mm ≈ 0.3~2pt)과 굵은 글리프 획(2pt+) 분리 */
const MAX_LINE_WIDTH_PT = 2.5
/** 런 내 허용 끊김 (px) — 스캔 노이즈/JPEG 아티팩트 */
const GAP_TOL_PX = 2
/** 밴드 병합 시 요구하는 x(또는 y) 범위 겹침 비율 (짧은 쪽 기준) */
const BAND_OVERLAP_RATIO = 0.5
/** 밴드 양측(±2px)이 이 비율 이상 잉크면 채운 영역 내부 슬리버로 판정 */
const SURROUND_INK_RATIO = 0.35
/**
 * 점선·파선 괘선. 텍스트층 경로(line-extract.ts)는 대시 패턴을 보지 않고 경로 기하만 읽어 점선 괘선도
 * 실선으로 받는데, 래스터에선 점 사이 간격(216dpi 에서 2~4px)이 GAP_TOL_PX 를 넘어 선이 조각난다 —
 * 점선으로 행을 가른 표가 OCR 경로에서만 한 행으로 뭉쳤다(changwon-plan2026 p5 정원표 22행 → 2행,
 * ice-geomjeong-plan p3 세로 점선 표 → 열 없는 한 칸). 점 사이 간격 상한 1.3pt 안에서 짧은 점(대시 4pt 이하)이
 * 8개+ 이어지면 점선 후보. 목차 리더 점("······")도 같은 모양이라 주기로 가른다 — 코퍼스 실측 괘선 점선 주기
 * 0.8~2.0pt(점 ≈ 간격), 리더 2.5~3.3pt(간격 ≈ 점 × 2). 대시가 간격보다 확연히 긴(1.5배+) 파선은 주기 무관.
 * 마지막으로 수직 방향 괘선(실선·점선)과 닿는 것만 남긴다 — 리더는 글자 사이에 떠 있고 괘선은 표·상자 테두리에 물린다.
 */
const DOT_MAX_GAP_PT = 1.3
const DOT_MAX_DASH_PT = 4
const DOT_MAX_PERIOD_PT = 2.2
const DOT_MIN_COUNT = 8
/** 점선 후보가 수직 괘선에 닿았다고 보는 거리 (pt) */
const DOT_TOUCH_PT = 1.5
/**
 * 채움 경계. 텍스트층 경로는 순수 채움 경로(머리 행 음영·색 칸의 사각형)의 변도 선으로 받는다(line-extract.ts
 * flushPath → classifyAndAdd). 잉크 감지(휘도 ≤ 190)는 연한 채움과 흰 바탕의 경계를 못 봐, 머리 행에만 좌우 변이
 * 있는 개방 변 표 두 개를 가상 테두리가 한 격자로 용접했고(ice-election-cases p5 8×3·10×3 → 19×5, seoul-archives p3,
 * ice-geomjeong p3), 흰 틈으로 칸을 가른 색 머리 행이 한 칸으로 뭉쳤다(cbe-record-guide). 쪽 바탕(휘도 최빈값)보다
 * FILL_DELTA 이상 어두운 곳이 안쪽으로 FILL_MIN_DEPTH_PT 이상 이어지는 바깥 경계 픽셀 런을 선으로 낸다 — 괘선(≤ 2.5pt)과
 * 글자 획은 그보다 얇다. 바탕을 흰색으로 못박으면 크림색 바탕 쪽 전체가 채움이 되어 본문이 통째로 표가 됐다
 * (pen-cyberbridge p2 바탕 휘도 242). 경계 안쪽 휘도가 고르지 않은 것(사진·그림·배경 도안)은 채움이 아니다.
 */
const FILL_DELTA = 10
/** 채움 경계 최소 길이 (pt) — 색 머리 행 높이(15~18pt)의 칸 틈도 잡게 괘선(20pt)보다 짧게. 글자 획은 두께 조건이 막는다 */
const FILL_MIN_LENGTH_PT = 10
const FILL_MIN_DEPTH_PT = 4
const FILL_FLAT_TOL = 12
const FILL_FLAT_RATIO = 0.8
/**
 * 채움 띠 안 밝은 칸 구분선 — 색 머리 행을 0.25pt 흰 선으로 가른 표는 216dpi 에서 선이 1px 도 안 돼 띠보다 조금 밝은 줄(띠 179 →
 * 223)로만 남아 쪽 바탕 기준 채움 판정에 묻혔다(cbe-record-guide "페이지 | 주요 내용" 이 한 칸). 양옆 FILL_DIV_SIDE 블록이 채움이고
 * 그 둘보다 FILL_DIV_DELTA 이상 밝은 블록 세로 런을 구분선 후보로 낸다 — 쓰임은 본문 세로 괘선과 같은 x 일 때만(detectRulingLines)
 */
const FILL_DIV_DELTA = 20
/** 조각 난 채움 변을 이은 범위가 괘선 끝에서 떨어져도 되는 거리 (pt) — 칸 모서리 둥글림·첫 칸 글자 */
const FILL_CHAIN_END_PT = 8
const FILL_DIV_SIDE = 2

/** 픽셀 공간(top-left origin) 선분 — 두께는 밴드 픽셀 수 */
export interface PxSegment {
  x1: number; y1: number
  x2: number; y2: number
  thicknessPx: number
}

export interface RulingLines {
  /** Newly recovered faint column rules, used to split OCR boxes before recognition. */
  cellDividers?: PxSegment[]
  horizontals: PxSegment[]
  verticals: PxSegment[]
}

/**
 * RGBA 래스터에서 수평/수직 괘선 감지.
 * @param scale 렌더 스케일 (px/pt) — 길이·두께 임계를 pt 기준으로 환산
 */
export function detectRulingLines(
  rgba: Uint8Array,
  width: number,
  height: number,
  scale: number,
): RulingLines {
  const minLenPx = Math.round(MIN_LINE_LENGTH_PT * scale)
  const maxThickPx = Math.max(1, Math.floor(MAX_LINE_WIDTH_PT * scale))

  // 잉크 마스크 1회 구축 — 수평/수직 두 패스가 공유
  const ink = new Uint8Array(width * height)
  // 휘도는 채움 경계(fillEdges)도 쓴다 — 한 번만 계산
  const luma = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    // ITU-R BT.601 휘도 근사 (정수 시프트)
    const l = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
    luma[p] = l
    if (l <= INK_LUMA_MAX && rgba[i + 3] >= 128) ink[p] = 1
  }

  const solid: RunReader = (m, base, step, span) => solidRuns(m, base, step, span, minLenPx)
  const dot = {
    maxGap: Math.max(2, Math.round(DOT_MAX_GAP_PT * scale)),
    maxDash: Math.max(2, Math.round(DOT_MAX_DASH_PT * scale)),
    maxPeriod: DOT_MAX_PERIOD_PT * scale,
  }
  const dotted: RunReader = (m, base, step, span) => dottedRuns(m, base, step, span, minLenPx, dot.maxGap, dot.maxDash, dot.maxPeriod)
  const horizontals = detectBands(ink, width, height, maxThickPx, false, solid)
  const verticals = detectBands(ink, width, height, maxThickPx, true, solid)
  const dotH = detectBands(ink, width, height, maxThickPx, false, dotted)
  const dotV = detectBands(ink, width, height, maxThickPx, true, dotted)
  const tol = Math.max(2, Math.round(DOT_TOUCH_PT * scale))
  // 같은 폭 두 가로 괘선을 잇는 짧은 세로선 — 최소 길이(20pt)에 못 미쳐 빠지던 조직도 연결선(과 상자 밑변 ↔ 팀 상자 윗변, 16pt)을 살린다.
  // 텍스트층 경로는 벡터 연결선으로 두 상자를 한 열 격자로 묶어 과 → 팀 순으로 읽는다(여수 업무계획 조직도) — 위아래 끝이 모두
  // 가로 괘선에 닿는 것만이라 칸 안 글자 획은 걸리지 않는다
  const bridgeMin = Math.max(2, Math.round(BRIDGE_MIN_LENGTH_PT * scale))
  const endsOn = (x: number, y: number) => horizontals.filter(h => Math.abs(h.y1 - y) <= tol + h.thicknessPx && h.x1 - tol <= x && h.x2 + tol >= x)
  // 같은 폭 상자끼리(위 가로선과 아래 가로선의 양끝이 같다) — 조직도 가로 막대에서 상자로 내린 선까지 살리면 조직도 전체가 한 표로 뭉친다.
  // 두 상자 사이 빈 틈이어야 한다 — 표 행은 양옆 세로 테두리가 그 사이를 지나가고, 행 높이에 꽉 찬 글자 획도 위아래 행 선에 닿는다
  // (미래전략포럼 개요 표 3열이 16열로 갈렸다)
  const sides = (x: number, y1: number, y2: number) => verticals.some(p => Math.abs(p.x1 - x) <= tol && p.y1 <= y1 + tol && p.y2 >= y2 - tol)
  // 연결선은 상자 가로 가운데에 내린다(폭의 25% 안) — 겹친 네모 장식 그림 안 선은 가장자리에 붙는다(학교 업무 매뉴얼 표지 그림).
  // 상자는 글 한 줄을 담을 폭(30pt) 이상
  const boxMin = BRIDGE_BOX_MIN_PT * scale
  // 위 가로선은 닫힌 상자의 밑변(양끝 세로 테두리가 위에서 내려와 거기서 끝남), 아래 가로선은 닫힌 상자의 윗변(양끝 테두리가 거기서
  // 시작해 내려감)이어야 한다 — 테두리 없는 글 영역의 글자 획(가로로 긴 획)이 짧은 가로선으로 잡혀 그 사이를 이었다(web068 소속기관 줄)
  const endsAt = (x: number, y: number) => verticals.some(p => Math.abs(p.x1 - x) <= tol && Math.abs(p.y2 - y) <= tol * 2 && p.y1 < y - tol)
  const startsAt = (x: number, y: number) => verticals.some(p => Math.abs(p.x1 - x) <= tol && Math.abs(p.y1 - y) <= tol * 2 && p.y2 > y + tol)
  const sameSpan = (a: PxSegment[], b: PxSegment[], x: number) => a.some(p => b.some(q => Math.abs(p.x1 - q.x1) <= tol && Math.abs(p.x2 - q.x2) <= tol
    && p.x2 - p.x1 >= boxMin && Math.abs(x - (p.x1 + p.x2) / 2) <= (p.x2 - p.x1) * 0.25
    && !sides(p.x1, p.y1, q.y1) && !sides(p.x2, p.y1, q.y1)
    && endsAt(p.x1, p.y1) && endsAt(p.x2, p.y1) && startsAt(q.x1, q.y1) && startsAt(q.x2, q.y1)))
  const shortV = detectBands(ink, width, height, maxThickPx, true, (m, base, step, span) => solidRuns(m, base, step, span, bridgeMin)).filter(v => v.y2 - v.y1 + 1 < minLenPx)
  for (const v of shortV) {
    if (!sameSpan(endsOn(v.x1, v.y1), endsOn(v.x1, v.y2), v.x1)) continue
    if (!verticals.some(p => Math.abs(p.x1 - v.x1) <= tol && p.y1 <= v.y1 + tol && p.y2 >= v.y2 - tol)) verticals.push(v)
  }
  const allH = [...horizontals, ...dotH], allV = [...verticals, ...dotV]
  // 가로 a 가 세로 선(p.x1 = p.x2)과 만나거나 끝이 닿는지 (세로 a 는 축을 바꿔 같은 판정)
  const touchesV = (a: PxSegment) => allV.some(p => p.x1 >= a.x1 - tol && p.x1 <= a.x2 + tol && a.y1 >= p.y1 - tol && a.y1 <= p.y2 + tol)
  const touchesH = (a: PxSegment) => allH.some(p => p.y1 >= a.y1 - tol && p.y1 <= a.y2 + tol && a.x1 >= p.x1 - tol && a.x1 <= p.x2 + tol)
  horizontals.push(...dotH.filter(touchesV))
  verticals.push(...dotV.filter(touchesH))
  // 채움 경계는 표 괘선에 맞물린 것만 쓴다 — 머리 행 음영의 윗변·아랫변은 표 가로 괘선(세로 괘선과 만나는 것)과 폭(양 끝)이
  // 같고, 좌우 변은 그 가로선 끝점에, 칸 사이 흰 틈은 바로 위아래 본문 세로 괘선과 같은 x 에 선다. 칸 안에 놓인 단색
  // 로고·그림의 변은 어느 쪽도 아니다(kmcc-press 참여 기업 표: 로고 칸이 행·열을 쪼갰다 — 로고 밑줄은 잉크 선으로 잡히지만
  // 세로 괘선과 만나지 않는다)
  const inkV = [...verticals]
  const ruleH = horizontals.filter(p => inkV.some(v => v.x1 >= p.x1 - tol && v.x1 <= p.x2 + tol && p.y1 >= v.y1 - tol && p.y1 <= v.y2 + tol))
  const fill = fillEdges(luma, width, height, scale)
  const fillH = fill.horizontals.filter(a => ruleH.some(p => Math.abs(p.x1 - a.x1) <= tol && Math.abs(p.x2 - a.x2) <= tol))
  // 흰 틈으로 칸마다 가른 색 머리 띠는 윗변이 칸 조각으로 끊긴다(띠 위에 걸친 그림·흰 글자도 끊는다) — 같은 y 조각을 이은 범위가
  // 표 가로 괘선 폭 안에서 양 끝 FILL_CHAIN_END 안에 닿고 그 폭의 절반 이상을 덮으면 그 괘선 폭의 변 하나로 받는다
  // (pen-cyberbridge p3 주황 머리 "구분 | 일정 | 내용 | 비고" 윗변 4조각 — 받지 않아 머리 행이 표 밖 문단이 됐다)
  const rows = new Map<number, PxSegment[]>()
  for (const a of fill.horizontals) if (!fillH.includes(a)) (rows.get(Math.round(a.y1)) ?? rows.set(Math.round(a.y1), []).get(Math.round(a.y1))!).push(a)
  const chainEnd = Math.round(FILL_CHAIN_END_PT * scale)
  for (const [y, segs] of rows) {
    for (const p of ruleH) {
      const inside = segs.filter(a => a.x1 >= p.x1 - tol && a.x2 <= p.x2 + tol)
      if (inside.length < 2 || fillH.some(f => Math.abs(f.y1 - y) <= tol && f.x1 <= p.x1 + tol && f.x2 >= p.x2 - tol)) continue
      const lo = Math.min(...inside.map(a => a.x1)), hi = Math.max(...inside.map(a => a.x2))
      const cover = inside.reduce((n, a) => n + a.x2 - a.x1, 0)
      if (lo - p.x1 <= chainEnd && p.x2 - hi <= chainEnd && cover >= (p.x2 - p.x1) * 0.5) fillH.push({ ...inside[0], x1: p.x1, x2: p.x2 })
    }
  }
  // 머리 띠 아랫변이 왼쪽 회색 열(색이 다른 칠)에서 끊겨 한쪽 끝만 표 괘선 끝에 닿는 것도 그 괘선 폭의 변이다 — 한 끝이 맞고
  // 폭의 70% 이상을 덮고, 안 맞는 끝이 칠한 열의 세로변(그 끝에서 아래로 내려가는 채움 세로변)에 닿을 때(비법인 지목별 토지 표: 진한 머리 띠
  // 아래 262–1498, 회색 첫 열 변 x=259 — 안 받아 머리 행과 첫 행이 한 칸이 됐다). 서식 칸 음영 변을 이어 칸을 쪼개지 않게 끝을 따진다
  for (const a of fill.horizontals) {
    if (fillH.some(f => f === a || Math.abs(f.y1 - a.y1) <= tol && f.x1 <= a.x1 + tol && f.x2 >= a.x2 - tol)) continue
    const p = ruleH.find(p => (Math.abs(p.x1 - a.x1) <= tol || Math.abs(p.x2 - a.x2) <= tol) && a.x1 >= p.x1 - tol && a.x2 <= p.x2 + tol && a.x2 - a.x1 >= (p.x2 - p.x1) * 0.7)
    if (!p || ruleH.some(q => Math.abs(q.y1 - a.y1) <= tol)) continue
    const loose = Math.abs(p.x1 - a.x1) <= tol ? a.x2 : a.x1
    const depthPx = Math.round(FILL_MIN_DEPTH_PT * scale)
    if (fill.verticals.some(v => Math.abs(v.x1 - loose) <= tol * 2 && Math.abs(v.y1 - a.y1) <= tol * 2 && v.y2 - v.y1 >= depthPx * 4)) fillH.push({ ...a, x1: p.x1, x2: p.x2 })
  }
  horizontals.push(...fillH)
  const edgeH = [...ruleH, ...fillH]
  const depth = Math.round(FILL_MIN_DEPTH_PT * scale)
  for (const a of fill.verticals) {
    // 머리 띠와 본문 사이 굵은 괘선(1pt)만큼은 떨어져도 같은 열 경계다 (pen-cyberbridge p3 띠 아래끝 → 세로 괘선 위끝 7px).
    // 그런 띠 안 구분선은 띠 높이를 다 긋는다 — 띠 가장자리 블록에서 짧아진 위끝을 띠 윗변에 잇는다(안 이으면 머리 행이 한 칸).
    // 아래끝을 세로 괘선 위끝까지 늘이지는 않는다 — 3° 기울인 cbe 2쪽에서 위아래 두 표가 한 격자로 용접됐다
    const col = inkV.find(p => Math.abs(p.x1 - a.x1) <= tol && p.y1 <= a.y2 + tol * 2 && p.y2 >= a.y1 - tol * 2)
    if (col) {
      const top = edgeH.filter(h => h.x1 <= a.x1 + tol && h.x2 >= a.x1 - tol && h.y1 < a.y1 && h.y1 >= a.y1 - depth)
      verticals.push({ ...a, y1: top.length ? Math.min(...top.map(h => h.y1)) : a.y1 })
    } else if (edgeH.some(p => (Math.abs(p.x1 - a.x1) <= tol || Math.abs(p.x2 - a.x1) <= tol) && p.y1 >= a.y1 - tol && p.y1 <= a.y2 + tol)) verticals.push(a)
    // 칠한 열(회색 첫 열)의 오른쪽 변 — 위끝·아래끝이 둘 다 받은 표 가로선 안에 닿고, 그 사이 표 괘선을 하나 넘게 가로질러
    // 여러 행에 걸치면 열 경계다. 머리 띠 한 행 안의 밝은 줄(본문 세로 괘선과 x 가 안 맞는)은 아니다
    else if ([a.y1, a.y2].every(y => edgeH.some(p => Math.abs(p.y1 - y) <= tol * 2 && p.x1 < a.x1 - tol && p.x2 > a.x1 + tol)) &&
      ruleH.some(p => p.y1 > a.y1 + tol * 2 && p.y1 < a.y2 - tol * 2 && p.x1 < a.x1 - tol && p.x2 > a.x1 + tol)) verticals.push(a)
  }
  // 머리 띠 안의 짧은 칸 구분선 — 띠 아래 겹줄 틈에서 아래 세로 괘선과 끊겨 최소 길이에 못 미쳤다. 위끝·아래끝이 가로 괘선에 닿고 바로 아래에서
  // 같은 x 의 세로 괘선이 시작하면 그 열 경계다(검정고시 계획 과목 표: 노란 머리 행의 회색 구분선 15pt — 안 받으면 머리 글이 한 칸에 몰렸다)
  for (const v of shortV) {
    if (!endsOn(v.x1, v.y1).length || !endsOn(v.x1, v.y2).length) continue
    if (!verticals.some(p => Math.abs(p.x1 - v.x1) <= tol && p.y1 >= v.y2 - tol && p.y1 <= v.y2 + tol * 3 && p.y2 - p.y1 + 1 >= minLenPx)) continue
    if (!verticals.some(p => Math.abs(p.x1 - v.x1) <= tol && p.y1 <= v.y1 + tol && p.y2 >= v.y2 - tol)) verticals.push(v)
  }
  // Faint internal rules are evidence only when enclosed by an existing dark
  // frame and repeated across both axes. Do not brighten the whole page's grid.
  const cellDividers: PxSegment[] = []
  const frames: Array<{ x1: number; x2: number; y1: number; y2: number }> = []
  for (let i = 0; i < horizontals.length && frames.length < 32; i++) {
    const a = horizontals[i]
    for (let j = i + 1; j < horizontals.length && frames.length < 32; j++) {
      const b = horizontals[j]
      if (Math.abs(a.x1 - b.x1) > tol || Math.abs(a.x2 - b.x2) > tol) continue
      const y1 = Math.min(a.y1, b.y1), y2 = Math.max(a.y1, b.y1)
      if (a.x2 - a.x1 < minLenPx * 3 || y2 - y1 < minLenPx * 2) continue
      if (![a.x1, a.x2].every(x => verticals.some(v => Math.abs(v.x1 - x) <= tol && v.y1 <= y1 + tol && v.y2 >= y2 - tol))) continue
      frames.push({ x1: a.x1, x2: a.x2, y1, y2 })
    }
  }
  if (frames.length) {
    const faint = new Uint8Array(ink.length)
    for (let p = 0; p < faint.length; p++) if (luma[p] <= 240 && rgba[p * 4 + 3] >= 128) faint[p] = 1
    const hs = detectBands(faint, width, height, maxThickPx, false, solid)
    const vs = detectBands(faint, width, height, maxThickPx, true, solid)
    for (const f of frames) {
      const innerH = hs.filter(h => h.y1 > f.y1 + tol && h.y1 < f.y2 - tol && Math.abs(h.x1 - f.x1) <= tol && Math.abs(h.x2 - f.x2) <= tol)
      const innerV = vs.filter(v => v.x1 > f.x1 + tol && v.x1 < f.x2 - tol && Math.abs(v.y1 - f.y1) <= tol && Math.abs(v.y2 - f.y2) <= tol)
      if (innerH.length < 3 || innerV.length < 1) continue
      for (const h of innerH) if (!horizontals.some(p => Math.abs(p.y1 - h.y1) <= tol && p.x1 <= h.x1 + tol && p.x2 >= h.x2 - tol)) horizontals.push(h)
      for (const v of innerV) if (!verticals.some(p => Math.abs(p.x1 - v.x1) <= tol && p.y1 <= v.y1 + tol && p.y2 >= v.y2 - tol)) { verticals.push(v); cellDividers.push(v) }
    }
  }
  return { horizontals, verticals, ...(cellDividers.length ? { cellDividers } : {}) }
}

/**
 * 채움 영역의 바깥 경계 선 (FILL_* 주석). 채움 경계는 칸 크기 단위라 해상도가 필요 없어 k×k(≈1pt) 블록으로 줄여 본다 —
 * 블록 휘도는 가장 밝은 픽셀(칸 사이 1~3px 흰 틈이 채움에 묻히지 않게). 방향마다 안쪽 연속 채움 길이를 한 번 누적해
 * 경계 마스크를 만들고, 찾은 선은 원래 픽셀 좌표로 되돌린다
 */
function fillEdges(pageLuma: Uint8Array, width: number, height: number, scale: number): RulingLines {
  const k = Math.max(1, Math.round(scale))
  const w = Math.floor(width / k), h = Math.floor(height / k), n = w * h
  const luma = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0
      for (let by = 0; by < k; by++) {
        let i = (y * k + by) * width + x * k
        for (let bx = 0; bx < k; bx++, i++) if (pageLuma[i] > mx) mx = pageLuma[i]
      }
      luma[y * w + x] = mx
      hist[mx]++
    }
  }
  let bg = 255
  for (let v = 0; v < 256; v++) if (hist[v] > hist[bg]) bg = v
  const tint = new Uint8Array(n)
  for (let p = 0; p < n; p++) if (luma[p] < bg - FILL_DELTA) tint[p] = 1
  const depth = Math.max(2, Math.round(FILL_MIN_DEPTH_PT * scale / k))
  const minLen = Math.round(FILL_MIN_LENGTH_PT * scale / k)
  const solid: RunReader = (m, base, step, span) => solidRuns(m, base, step, span, minLen)
  const run = new Uint16Array(n)
  const mask = new Uint8Array(n)
  const out: RulingLines = { horizontals: [], verticals: [] }
  // dx,dy = 채움 안쪽 방향. 위 변(0,1)·아래 변(0,-1)·왼 변(1,0)·오른 변(-1,0)
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    // run[p] = p 에서 안쪽 방향으로 이어지는 채움 길이 (안쪽 끝부터 거꾸로 누적)
    const step = dy * w + dx
    const ys = dy > 0 ? [h - 1, -1, -1] : [0, h, 1]
    const xs = dx > 0 ? [w - 1, -1, -1] : [0, w, 1]
    for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
      for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
        const p = y * w + x
        const nx = x + dx, ny = y + dy
        run[p] = tint[p] ? (nx >= 0 && nx < w && ny >= 0 && ny < h ? Math.min(65535, run[p + step] + 1) : 1) : 0
      }
    }
    mask.fill(0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (run[p] < depth) continue
        const ox = x - dx, oy = y - dy // 바깥 이웃
        if (ox < 0 || oy < 0 || ox >= w || oy >= h || !tint[p - step]) mask[p] = 1
      }
    }
    const vertical = dx !== 0
    const flat = (s: PxSegment) => {
      // 경계 안쪽 depth/2 지점의 휘도가 고른지 — 사진·도안 탈락
      const d = depth >> 1
      const vals: number[] = []
      if (vertical) {
        const x = Math.round(s.x1) + dx * d
        for (let y = Math.round(s.y1); y <= s.y2; y++) if (x >= 0 && x < w) vals.push(luma[y * w + x])
      } else {
        const y = Math.round(s.y1) + dy * d
        for (let x = Math.round(s.x1); x <= s.x2; x++) if (y >= 0 && y < h) vals.push(luma[y * w + x])
      }
      if (!vals.length) return false
      const med = [...vals].sort((a, b) => a - b)[vals.length >> 1]
      return vals.filter(v => Math.abs(v - med) <= FILL_FLAT_TOL).length >= vals.length * FILL_FLAT_RATIO
    }
    for (const s of detectBands(mask, w, h, 1, vertical, solid)) {
      if (!flat(s)) continue
      const c = (v: number) => v * k + (k - 1) / 2
      ;(vertical ? out.verticals : out.horizontals).push({ x1: c(s.x1), y1: c(s.y1), x2: c(s.x2), y2: c(s.y2), thicknessPx: 1 })
    }
  }
  const div = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = FILL_DIV_SIDE; x < w - FILL_DIV_SIDE; x++) {
      const p = y * w + x, l = p - FILL_DIV_SIDE, r = p + FILL_DIV_SIDE
      if (tint[l] && tint[r] && luma[p] >= Math.max(luma[l], luma[r]) + FILL_DIV_DELTA) div[p] = 1
    }
  }
  const c = (v: number) => v * k + (k - 1) / 2
  for (const s of detectBands(div, w, h, 1, true, solid)) out.verticals.push({ x1: c(s.x1), y1: c(s.y1), x2: c(s.x2), y2: c(s.y2), thicknessPx: 1 })
  return out
}

/**
 * 스캔라인 하나의 런 판독 — 마스크의 base + pos·step 픽셀(pos = 0..span-1). 가로 스캔은 step 1, 세로 스캔은 step = 쪽 폭.
 * 픽셀마다 접근 함수를 부르던 종전 모양은 괘선 감지 시간의 40% 가 그 호출이었다(쪽당 4패스 × 450만 픽셀)
 */
type RunReader = (mask: Uint8Array, base: number, step: number, span: number) => Array<{ lo: number; hi: number }>

/** 스캔라인 하나의 실선 런 (GAP_TOL_PX 이하 끊김 허용, 최소 길이 이상) */
function solidRuns(mask: Uint8Array, base: number, step: number, span: number, minLenPx: number): Array<{ lo: number; hi: number }> {
  const runs: Array<{ lo: number; hi: number }> = []
  let runStart = -1
  let gap = 0
  for (let pos = 0; pos <= span; pos++) {
    const on = pos < span && mask[base + pos * step] === 1
    if (on) {
      if (runStart < 0) runStart = pos
      gap = 0
    } else if (runStart >= 0) {
      if (++gap > GAP_TOL_PX || pos >= span) {
        const hi = pos - gap
        if (hi - runStart + 1 >= minLenPx) runs.push({ lo: runStart, hi })
        runStart = -1
        gap = 0
      }
    }
  }
  return runs
}

/** 스캔라인 하나의 점선 런 — 짧은 잉크 조각(≤ maxDash)이 간격 ≤ maxGap 으로 DOT_MIN_COUNT 개+ 이어진 사슬 (DOT_* 주석) */
function dottedRuns(
  mask: Uint8Array,
  base: number,
  step: number,
  span: number,
  minLenPx: number,
  maxGap: number,
  maxDash: number,
  maxPeriod: number,
): Array<{ lo: number; hi: number }> {
  const runs: Array<{ lo: number; hi: number }> = []
  // 사슬 조각의 [lo, hi] — 사슬이 끊길 때만 통계를 본다 (대부분 스캔라인은 사슬이 없다)
  const chain: number[] = []
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
  const flush = () => {
    const cnt = chain.length >> 1
    if (cnt >= DOT_MIN_COUNT && chain[chain.length - 1] - chain[0] + 1 >= minLenPx) {
      const periods: number[] = [], dashes: number[] = [], gaps: number[] = []
      for (let k = 0; k < cnt; k++) {
        dashes.push(chain[2 * k + 1] - chain[2 * k] + 1)
        if (k) { periods.push(chain[2 * k] - chain[2 * k - 2]); gaps.push(chain[2 * k] - chain[2 * k - 1] - 1) }
      }
      if (median(periods) <= maxPeriod || median(dashes) >= 1.5 * median(gaps)) runs.push({ lo: chain[0], hi: chain[chain.length - 1] })
    }
    chain.length = 0
  }
  let s = -1
  for (let pos = 0; pos <= span; pos++) {
    const on = pos < span && mask[base + pos * step] === 1
    if (on) { if (s < 0) s = pos; continue }
    if (s < 0) continue
    const lo = s, hi = pos - 1
    s = -1
    if (hi - lo + 1 > maxDash) { flush(); continue }
    if (chain.length && lo - chain[chain.length - 1] - 1 > maxGap) flush()
    chain.push(lo, hi)
  }
  flush()
  return runs
}

/** 열린 밴드 — 인접 스캔라인의 런을 누적 */
interface Band {
  lo: number // 런 진행축 시작 (h: x1, v: y1)
  hi: number // 런 진행축 끝
  first: number // 직교축 시작 스캔라인 (h: yTop, v: xLeft)
  last: number // 직교축 마지막 스캔라인
}

/**
 * 스캔라인 런렝스 → 인접 라인 밴드 병합 → 두께 필터 → 선분 방출.
 * transpose=false 면 수평선(행 스캔), true 면 수직선(열 스캔).
 */
function detectBands(
  ink: Uint8Array,
  width: number,
  height: number,
  maxThickPx: number,
  transpose: boolean,
  readRuns: RunReader,
): PxSegment[] {
  const lines = transpose ? width : height // 스캔라인 개수 (직교축)
  const span = transpose ? height : width // 런 진행축 길이
  const step = transpose ? width : 1
  const baseOf = (line: number) => (transpose ? line : line * width)

  const out: PxSegment[] = []
  let open: Band[] = []

  /** 밴드 양측(±2px 스캔라인)의 잉크 비율 — 채운 색상바 안 흰 글자 틈새 슬리버 판별 */
  const surroundInkRatio = (b: Band, side: number): number => {
    if (side < 0 || side >= lines) return 0
    let dark = 0, total = 0
    const base = baseOf(side)
    for (let pos = b.lo; pos <= b.hi; pos += 3) {
      total++
      if (ink[base + pos * step] === 1) dark++
    }
    return total > 0 ? dark / total : 0
  }

  const emit = (b: Band) => {
    const thick = b.last - b.first + 1
    if (thick > maxThickPx) return // 색상바·텍스트 밴드
    if (
      surroundInkRatio(b, b.first - 2) >= SURROUND_INK_RATIO &&
      surroundInkRatio(b, b.last + 2) >= SURROUND_INK_RATIO
    ) return // 채운 영역 내부 슬리버
    const center = (b.first + b.last) / 2
    out.push(
      transpose
        ? { x1: center, y1: b.lo, x2: center, y2: b.hi, thicknessPx: thick }
        : { x1: b.lo, y1: center, x2: b.hi, y2: center, thicknessPx: thick },
    )
  }

  for (let line = 0; line < lines; line++) {
    // 1) 이 스캔라인의 런 (실선 또는 점선 사슬)
    const runs = readRuns(ink, baseOf(line), step, span)

    // 2) 열린 밴드와 병합 — 직전 스캔라인까지 이어졌고 범위가 겹치면 확장
    const next: Band[] = []
    const used = new Set<number>()
    for (const band of open) {
      if (band.last !== line - 1) { emit(band); continue } // 연속 끊김 → 확정
      let merged = false
      for (let r = 0; r < runs.length; r++) {
        if (used.has(r)) continue
        const run = runs[r]
        const overlap = Math.min(band.hi, run.hi) - Math.max(band.lo, run.lo) + 1
        const shorter = Math.min(band.hi - band.lo, run.hi - run.lo) + 1
        if (overlap >= shorter * BAND_OVERLAP_RATIO) {
          band.lo = Math.min(band.lo, run.lo)
          band.hi = Math.max(band.hi, run.hi)
          band.last = line
          next.push(band)
          used.add(r)
          merged = true
          break
        }
      }
      if (!merged) emit(band)
    }
    for (let r = 0; r < runs.length; r++) {
      if (!used.has(r)) next.push({ lo: runs[r].lo, hi: runs[r].hi, first: line, last: line })
    }
    open = next
  }
  for (const band of open) emit(band)
  return out
}

/**
 * 픽셀 선분 → PDF pt LineSegment (bottom-up, classifyAndAdd 규약:
 * 수평선 y1==y2·x1<x2, 수직선 x1==x2·y1<y2).
 */
export function rulingToPdfLines(
  ruling: RulingLines,
  scale: number,
  pdfHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = ruling.horizontals.map(s => {
    const y = pdfHeight - (s.y1 + s.y2) / 2 / scale
    return {
      x1: Math.min(s.x1, s.x2) / scale,
      y1: y,
      x2: Math.max(s.x1, s.x2) / scale,
      y2: y,
      lineWidth: s.thicknessPx / scale,
    }
  })
  const verticals: LineSegment[] = ruling.verticals.map(s => {
    const x = (s.x1 + s.x2) / 2 / scale
    const yA = pdfHeight - Math.max(s.y1, s.y2) / scale
    const yB = pdfHeight - Math.min(s.y1, s.y2) / scale
    return { x1: x, y1: yA, x2: x, y2: yB, lineWidth: s.thicknessPx / scale }
  })
  return { horizontals, verticals }
}
