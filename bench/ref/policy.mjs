// 채점 정책 — 모수 포함/제외 규칙 + 화이트리스트(의도적 드롭) + 블랙리스트(오염 검출).
// 모든 "의도적 드롭"은 이 파일 한 곳에 선언하고 리포트에 항목 수를 노출한다 (pitfall #6).

// ─── 모수 제외: 요소 단위 (서브트리 전체 제외) ───────────
// XML에 존재하지만 출력에 없는 것이 정답인 요소들 (pitfall #2, #4)
export const EXCLUDE_SUBTREES = new Set([
  "hiddencomment",     // 숨은설명
  "shapecomment",      // 도형 대체텍스트 컨테이너
  "parameters", "stringparam", "integerparam", "boolparam", "floatparam", "listparam", // 필드 파라미터
  "fieldbegin", "fieldend",  // 필드 마커 (가시 텍스트는 일반 run에 있음)
  "autonum", "newnum", "pagenum", "pagenumctrl", "pagehiding", // 리터럴 없는 자동 필드
  "bookmark", "indexmark",   // 비가시 마커
  "secpr", "colpr",          // 섹션/다단 속성
  "linesegarray", "lineseg", // 레이아웃 정보
  "deletebegin", "deleteend", // 변경추적 삭제분 (출력에 있으면 phantom으로 검출)
  "dummy", "metatag",
])

// 별도 카테고리로 라우팅되는 ctrl 내부 요소 (recall 모수에서 분리, pitfall #3)
export const CATEGORY_ELEMENTS = {
  header: "header",     // 머리말 — 0/1회 출력 정책 채점
  footer: "footer",     // 꼬리말
  footnote: "footnote", // 각주 — recall 모수 포함 + presence 채점 병기
  endnote: "endnote",   // 미주
}

// ─── 화이트리스트: 파서의 의도적 드롭/변형 (모수 제외 또는 참조에 동일 적용) ───
// 항목 수가 비대해지면 그 자체가 품질 적신호 — 리포트에 노출
export const WHITELIST = [
  { id: "leader-tab-cut", desc: "목차 리더탭(leader≠0) 이후 페이지번호 절단 — 파서 \\x1F 정책과 동일 적용" },
  { id: "shape-alt-strip", desc: "도형/OLE 대체텍스트 패턴 제거 ('사각형입니다.', '그림입니다. 원본 그림의 이름…') — 참조에 동일 적용" },
  { id: "equation-presence", desc: "수식 hp:script ↔ LaTeX 문자 비교 불가 — presence 채점 분리" },
  { id: "trailing-col-trim", desc: "후행 빈 열 제거(builder trimAndReturn) — 참조 그리드에 동일 적용" },
  { id: "nested-in-cell", desc: "중첩표는 부모 IRCell.blocks에 IRBlock(table)로 구조 보존(파서 v3.0) — IR 그리드를 셀 재귀로 수집해 ref XML 중첩 tbl과 같은 경계로 비교 (이중 카운트 금지)" },
  { id: "img-inline", desc: "셀 내 이미지 인라인 — HTML 표 <img src=… alt=…> / GFM ![image](…) 는 의도적 아티팩트, mdToPlain에서 제거 (phantom 제외). 이미지 보유 셀은 trim 판정 시 비어있지 않음(builder trimAndReturn 미러)" },
  { id: "image-placeholder", desc: "'[이미지: ref]' 플레이스홀더 — phantom 제외" },
  { id: "header-policy", desc: "머리말/꼬리말은 0회 또는 1회 출력 허용 — recall 모수 제외, 정책 위반(2회+)만 검사" },
  { id: "pua-map", desc: "한컴 PUA 글머리표 → 표준 유니코드 매핑(rhwp 검증 테이블) — 정규화 대칭을 위해 참조에도 동일 적용 (lib/normalize.mjs mapPua)" },
]

// ─── 블랙리스트: 출력 마크다운에 있으면 안 되는 문자열 (phantom 보조, pitfall #7) ───
export const BLACKLIST = [
  { id: "shape-alt", re: /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|타원|글상자|그리기 개체|묶음 개체|OLE 개체)\s?입니다/ },
  { id: "ole-alt", re: /그림입니다\.?\s*원본\s*그림의\s*(?:이름|크기)/ },
  { id: "multiline-leak", re: /MULTILINE/ },
  { id: "clickhere-leak", re: /이곳을 마우스로 누르고/ }, // 누름틀 안내문구
]

// ─── 게이트 (명세 §6) ───────────────────────────────
// 2026-07-17 전 지표 만점 잠금: 꼬리 결함 전량 수리(페이지번호 꼬리말·수식 whitelist
// 대칭·중첩표 캡션 순서·하이퍼링크 extent·href 괄호 인코딩)로 HWPX 347건 전 지표 1.0,
// HWP5쌍 유사도/커버 1.0 도달 — 새 플로어가 기준 (회귀 절대 불가).
export const GATES = {
  hwpx: {
    recallMicro: 1, recallDoc: 1, missRun: 20,
    phantom: 0, blacklistHits: 0,
    tableExact: 1, cellF1: 1, contentNED: 1, cellExact: 1,
    orderDoc: 1, orderAvg: 1,
    eqPresence: 1, footnotePresence: 1, headerViolations: 0,
  },
  // PDF 커버리지 0.99914 실측(0.99857→, 첨자·중복글리프·헤더오검출 수리) — 잔여는
  // 구조 해석 충돌 영역(과소분할 일정표·서식 rowspan 그리드)이라 0.999로 잠금
  pdf: { coverage: 0.999 },
  // HWP5 2차 트랙 (같은 newsId의 hwp↔hwpx 쌍 상호 정렬) — v3.0에서 정식 게이트 승격
  hwp: { pairSimilarity: 1, pairCoverage: 1 },
}

/** 정책 드롭 카운터 생성 — 문서별 리포트용 */
export function newPolicyCounters() {
  return {
    leaderTabChars: 0,    // 리더탭 이후 절단된 문자수
    shapeAltChars: 0,     // 대체텍스트 패턴으로 제거된 문자수
    excludedElements: {}, // 제외 요소 태그별 카운트
    nestedTables: 0,      // 중첩표 수 (v3.0: 부모 IRCell.blocks에 보존 — 전부 비교 대상)
    trimmedCols: 0,       // 후행 빈 열 트림된 표 수
    autoNumHeadingParas: 0, // NUMBER/BULLET heading paraPr 사용 문단 수 — phantom 자동번호 관용 게이트

  }
}

// 파서(builder.ts / hwpx parser.ts)의 대체텍스트 제거와 동일한 패턴 — 참조에 대칭 적용
export const SHAPE_ALT_RE = /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?/g
export const OLE_ALT_HEAD_RE = /^그림입니다\.?\s*원본\s*그림의\s*(이름|크기)/
export const OLE_ALT_INLINE_RE = /그림입니다\.?\s*원본\s*그림의\s*(이름|크기)[^\n]*(\n[^\n]*원본\s*그림의\s*(이름|크기)[^\n]*)*/g

/** 파서와 동일한 대체텍스트 정리 — 참조 텍스트에 적용, 제거 문자수 반환 */
export function applyAltTextPolicy(text, counters) {
  let t = text
  if (OLE_ALT_HEAD_RE.test(t.trim())) t = ""
  else t = t.replace(OLE_ALT_INLINE_RE, "")
  t = t.replace(SHAPE_ALT_RE, "")
  if (counters) counters.shapeAltChars += Math.max(0, text.length - t.length)
  return t
}
