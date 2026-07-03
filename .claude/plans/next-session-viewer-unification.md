# 다음 세션 프롬프트 — 뷰어 통합·승화 (2026-07-04 신설, 1차)

> **트리거**: "kordoc 뷰어" 또는 "뷰어 통합"이라고 하면 이 파일로 시작.
> (일반 "kordoc 이어서"는 여전히 `next-session-pdf-gt-leftovers.md` = 소액 백로그)
>
> **목표**: kordoc의 레이아웃 보존 렌더(`src/render/`)를 **순수 TypeScript·벡터(SVG)·
> reflow 가능·전(全) 한글포맷** 뷰어로 통합·승화 — "유일무이한 원탑 뷰어".
> **이번 세션 1순위 = 통합계획 확정(Phase 0) 후 착수.** 계획 없이 코드부터 금지.

---

## 0. 왜 "원탑"인가 (포지셔닝 = 해자)

비교 대상 = `github.com/DoHyun468/claw-hwp` (Claude Code 플러그인, rhwp WASM +
Canvas 브라우저 뷰어). **뿌리는 같다** — claw-hwp의 엔진 rhwp는 kordoc이 일부
포팅해온 그 rhwp(cfb-lenient·johab·hwp3). 둘 다 "브라우저 리플로우"가 아니라
**HWP 조판 좌표(lineseg)를 재현**하는 철학.

우리만의 차별점 4가지 (= 원탑 근거):
1. **순수 TS, WASM/네이티브 의존 0** — Node·브라우저·엣지·서버리스·MCP·CI 어디서든.
   claw-hwp는 rhwp WASM(Rust) 필수. **이게 가장 큰 해자** — 임베드 자유도.
2. **SVG(벡터) 출력** — 진짜 텍스트(선택·검색·복사 가능), 무한 확대에도 선명,
   파일 작음, DOM 접근성(a11y), git/시각 회귀 diff 가능, 인쇄 완벽. claw-hwp의
   Canvas 비트맵(래스터·선택 불가·확대 흐림)보다 **문서 뷰어로선 구조적 우위**.
3. **듀얼 모드 레이아웃** = (a)캐시 재생(한컴본 픽셀 충실) + (b)**reflow 엔진**
   (캐시 없는/깨진 파일도 렌더: markdownToHwpx 산출물·에이전트 생성본·편집본).
   순수 TS로 둘 다 가진 도구 = 없음. **claw-hwp의 유일한 강점(reflow)까지 흡수**.
4. **전 한글포맷 → 단일 뷰어** — HWPX·HWP5·HWP3·HWPML, 나아가 IR 경유 PDF/DOCX/XLSX.
   kordoc은 이미 이 전부를 `IRBlock[]`로 파싱하므로 reflow 엔진이 IR을 그리면 만능.

부수 효과: **왕복 폐루프** — markdownToHwpx로 생성 + 그 출력을 충실 렌더하는
유일한 도구(현재는 캐시 없어서 렌더 거부 → reflow가 이걸 연다).

---

## 1. 현재 상태 (Tier-1 = 캐시 재생, 이미 견고)

`src/render/svg-render.ts`(28KB) + `layout.ts`(솔버) + `head-styles.ts`(스타일) +
POC 기록 `.claude/plans/render-poc/findings.md`(좌표 산식 실측). **먼저 읽을 것.**

- **되는 것**: 한컴 저장 HWPX의 `<hp:linesegarray>` 재생 → SVG 절대배치. 좌표
  산식 실측 검증(HWPUNIT/pt, lineseg vertpos 본문영역 로컬, 셀 로컬, 개체 anchor
  hp:pos, uint32 음수 toInt32), 표 경계 솔버+행 성장, run별 charPr(크기·굵기·색·
  장평·자간), borderFill(셀 배경·테두리), 이미지 data URI. 결재문서·사진대지
  헤드리스 Chrome 대조, hwpx 85건 크래시/NaN 0, 렌더 테스트 10/10.
- **안 되는 것(= 통합 대상)**:
  - ❌ **reflow 없음** — 캐시 없으면 `KordocError`. 한컴 저장본만. (최대 한계 = Tier-2 목표)
  - ✅ **다페이지 — v3.14.0에서 구현됨**(세로 스택 SVG, `data-page`, `pageCount`).
    최상위 lineseg vertpos가 페이지 로컬(페이지마다 0 리셋)인 성질로 경계 감지,
    다단은 horzpos 복귀 조건 병행. **Phase 1의 다페이지는 완료** — 남은 건 머리말/꼬리말/쪽번호
  - ❌ 수식·도형(rect/line/타원 등 그리기개체) 미지원(경고만)
  - ❌ HWPX 전용 — HWP5/HWP3/HWPML/기타 포맷 렌더 없음
  - △ 폰트 매핑(맑은고딕 등) — 함초롬바탕 serif 폴백, 폭은 textLength가 흡수
  - **v3.14.0 추가/픽스(다른 PC 작업, Tier-1)**: 검색어 형광펜(`--highlight`, 매치
    세그먼트에만 배경 rect) / 줄경계 슬롯 정합(lineseg `textpos`는 순수 코드포인트가
    아니라 **HWP5 문자스트림 슬롯** 기준 — 컨트롤 8슬롯·문자형 컨트롤 1슬롯·서로게이트
    2슬롯. **reflow도 이 슬롯 규칙을 따라야 함**) / 이미지 크롭 `imgClip`=`imgDim` 기준 정정

## 1.5. claw-hwp에서 배울 것 (구현은 안 베낌, 교훈만)

- **`reflowLinesegs()` (autoFix 기본 ON)** — rhwp가 생성한 HWPX의 linesegarray는
  stale(vertpos/vertsize가 이미지·표 높이 무시). rhwp-api.md 원문: *"Strict viewers
  trust the cache and place subsequent paragraphs at the wrong vertical position…
  Hancom strips every `<hp:linesegarray>` on save; mirror that."* + 바이너리
  `PARA_LINESEG`(tag 69)도 동일. → **우리 reflow는 이미지·표 높이를 반영해 vertpos를
  재계산**해야 한다 (findings.md #1 "행 성장/개체 밀어내기"와 정확히 같은 문제).
- **다페이지 루프**(getPageInfo 전수 → 렌더) — 페이지 나눔은 reflow가 오버플로를
  알아야 가능. 캐시 재생 다페이지(Phase 1)와 reflow 페이지나눔(Phase 3)은 별개.
- **measureTextWidth via 숨김 canvas 2d** — 우리는 이미 `hwpx/text-metrics.ts`
  (함초롬바탕 hmtx 실측)로 동일 목적 달성. 브라우저 canvas 불요(순수 TS 유지).

---

## 2. 통합 전략 = 2-Tier 렌더러

**Tier-1 (있음): 캐시 재생** — 한컴본 → linesegarray 재생 → SVG. 픽셀 충실.
유지·확장(다페이지·도형·수식). 캐시가 유효할 때 **항상 우선**.

**Tier-2 (신규·핵심): reflow 엔진** — 순수 TS 한글 줄배치 엔진. 캐시 부재/stale
시, `paraPr`(들여쓰기·정렬·줄간격·여백) + `charPr`(폰트·크기·굵기·장평·자간) +
페이지 기하(여백·단폭) + `text-metrics`(글리프 폭)로 **줄나눔·줄위치를 계산**해
linesegarray를 생성 → 그 뒤는 Tier-1 렌더 파이프 재사용. IR(`IRBlock[]`)도 입력
가능케 하면 전 포맷 만능 렌더.

핵심: reflow 엔진 = **한컴이 저장 시 하는 조판을 온디맨드로 재현**. 이게 해자이자
가장 어려운 신규 작업. 기존 자산 최대 재사용:
- `hwpx/text-metrics.ts` — 글리프 폭 → 줄나눔
- `render/head-styles.ts` — charPr/paraPr 해석
- `render/layout.ts` — 표 경계·행높이 솔버(그대로)
- `IRBlock[]` — 비-HWPX 포맷의 reflow 입력
- `hwpx/gen-gongmun-fit.ts` — 공문 자동장평·항목부호 선계산(줄배치 로직 참고)

---

## 3. 검증 전략 (자동 게이트 — 이게 성패를 가른다)

**자기일관성 테스트(Self-Consistency)** = reflow의 ground truth를 Windows+한컴
없이 얻는 방법:
1. 한컴 저장본(캐시 유효) 선택 → **Tier-1로 렌더**(신뢰 기준 = truth).
2. **같은 파일의 linesegarray를 strip → Tier-2 reflow로 렌더**.
3. 두 SVG를 **기하 diff**(줄 y·글자 x·표 경계 허용오차 내 일치율).
→ reflow가 캐시 재생과 일치하면, 한컴 없이도 reflow를 진리값 대비 검증. 코퍼스
85 hwpx 전수로 **reflow 정확도 게이트**를 만든다. (기존 헤드리스 Chrome 스샷
대조 + 차기 한컴 인쇄 PDF 픽셀 대조를 보완.)

부가 게이트: 렌더 테스트 10/10 무후퇴, 캐시 재생 결과 바이트 불변(Tier-1 회귀 0),
bench:gate·683 무후퇴.

---

## 4. 단계별 계획 (Phase 0에서 확정·조정)

**Phase 0 — 통합계획 확정 + reflow POC 판정** (이번 세션 필수 선행)
- 성공 지표 정의(자기일관성 diff 임계·대상 문서군), reflow 엔진 아키텍처 확정
  (모듈 경계: `render/reflow.ts` 신설? IR-우선 vs HWPX-우선?), 스코프 잠금.
- **reflow POC**: markdownToHwpx 산출물 1건(현재 렌더 거부됨) → 순수 TS 줄배치 →
  SVG. + 한컴본 1건 strip-cache 자기일관성 1건. `render-poc/`에 python/ts로.
  findings.md처럼 **"방식 성립" 판정** 후에만 본구현. (원래 렌더 POC의 성공 패턴.)

**Phase 1 — 캐시 재생 확장: ~~다페이지~~ + 머리말/꼬리말/쪽번호** (저위험·고가치)
- ✅ **다페이지 = v3.14.0 완료**(세로 스택). 남은 건 머리말/꼬리말/쪽번호. Tier-2가
  본체이므로 Phase 1 잔여는 소품 — 우선순위는 Phase 0 판정 후 Tier-2 착수에 둔다.

**Phase 2 — reflow 엔진 v1: 단단 텍스트** (핵심 착수)
- 캐시 없는 단일 단 텍스트 문서 줄배치 → SVG. 자기일관성 게이트로 검증.

**Phase 3 — reflow: 표 + 개체 밀어내기 + 자동 페이지 나눔**
- 표 배치(layout.ts 솔버 재사용), 개체 push-down(findings.md #1), 오버플로 페이지 분할.

**Phase 4 — 도형 + 수식** (충실도 최난)
- rect/line/타원 그리기개체 → SVG shape. 수식은 `hwpx/equation.ts`(HULK→LaTeX)
  보유 → 순수 TS 수식 조판 or SVG path. (SVG+MathML foreignObject는 브라우저 한정 주의.)

**Phase 5 — 만능 IR 렌더 + (선택) 브라우저 뷰어**
- `IRBlock[]` → reflow → SVG로 HWP5/3/HWPML/PDF/DOCX/XLSX 통일 렌더.
- 선택: SVG 기반 인터랙티브 뷰어(팬·줌·페이지 이동, **텍스트 선택 유지**) —
  MCP 리소스 or 단일 HTML. claw-hwp 프리뷰 페인의 UX를 벡터로 재현.

---

## 5. 가드레일 (재론 금지 / 절대 원칙)

- **순수 TS·의존 0 유지** — rhwp WASM/canvas/네이티브 도입 금지. 이게 차별점.
- **SVG(벡터) 출력 유지** — canvas는 선택적 래스터 익스포트로만.
- **Tier-1(캐시 재생) 무회귀** — reflow는 순수 추가 경로(캐시 부재 시만). 한컴본은
  계속 캐시 충실 재생. 결재문서·사진대지 충실도·85건·10테스트 불변.
- **reflow는 "한컴 저장본 캐시를 못 믿는다"가 아님** — 한컴본 캐시는 진리(신뢰).
  reflow는 캐시가 **없거나 stale(에이전트/rhwp 생성)**일 때만. 오해 금지.
- 게이트: bench:gate 5체인 + 683 테스트 + 렌더 자기일관성/스샷 무후퇴 후에만 확정.
- 계획 우선: Phase 0(통합계획+POC 판정) 없이 대규모 코드 금지 — 원래 렌더 POC의
  "성립 판정 후 구현" 절차를 그대로.

## 6. 첫 액션 (다음 세션)
1. `git pull` → `.claude/plans/render-poc/findings.md` + `src/render/svg-render.ts`
   헤더 + 이 파일 정독.
2. **Phase 0**: 통합계획 문서화(스코프·지표·모듈 경계) → reflow POC 2건(markdownToHwpx
   1 + strip-cache 자기일관성 1) → "방식 성립" 판정.
3. 판정 통과 시 Phase 1(다페이지, 저위험) 착수. 실패 시 원인 분석·재계획.

**핵심 자산 위치**: 렌더 `src/render/{svg-render,layout,head-styles}.ts` · 폭
`src/hwpx/text-metrics.ts` · 생성 `src/hwpx/generator.ts`+`gen-gongmun-fit.ts` ·
수식 `src/hwpx/equation.ts` · IR `src/types.ts` · POC `.claude/plans/render-poc/`
