# 다음 세션 프롬프트 — 백로그 잔여 (2026-07-04 갱신 7차)

> "kordoc 이어서"라고만 해도 메모리가 이 파일로 안내함.
> ✅ 지난 세션(2026-07-04 연속 11차): **v3.13.0 릴리스** — 백로그 A+B 각개 격파.
> ① **ice-geomjeong 라벨탭 병리 → 프로즈 박스 감지**(page-blocks.ts): 기하(전폭
> 행 지배 60%+)×텍스트(긴 셀 3개+·40%+) 교집합으로 강등, 0.99611→0.99724 +부수
> 5파일, pairs 무변경. ② **hml bizinfo 표 캡션**(hwpml/parser.ts): SHAPEOBJECT>
> CAPTION 추출, 0.9727→0.9857. ③ **eval-perf-2024 원리적 수용** — "벡터아웃라인
> OCR"은 오진(실측 0페이지), 성과체계도 비선형 다이어그램 찢김이라 강등해도
> coverage 불변. 상세 activeContext.md.
> **pdf표GT·ice-geomjeong·hml 트랙 종결.** 남은 건 A-5 폼·hwp3 픽스처(아래 B).

---

kordoc 이어서 하자. `~/workspace/kordoc` 깃풀부터. **먼저 읽을 것**:
`.claude/memory/activeContext.md` + 이 파일.
기준선: 테스트 683/683, `npm run build` 후 작업(dist 스테일), `npx tsc --noEmit`(기존 13, 신규 0).
검증 일괄 = `npm run bench:gate`.

## 이번 세션 후보 (우선순위순)

### A. ice-geomjeong 라벨 탭 병리 — ✅ **완료 (11차, v3.13.0)**

- 프로즈 박스 감지(page-blocks.ts `isProseBoxGrid`)로 해결. **열 지지도 필터는
  폐기** — 정당 조밀 표의 병합 열(union 0.031~0.048)이 노치(0.04~0.07)보다 낮아
  원리적 분리 불가. **기하(전폭 행 지배)×텍스트(긴 셀) 교집합**만 직교적으로 분리

### B. 소액 백로그 (일부 완료)

- ✅ **hml bizinfo → 완료**(11차): SHAPEOBJECT>CAPTION 추출, 0.9727→0.9857
- ✅ **eval-perf-2024 → 원리적 수용**(11차): "벡터아웃라인 OCR"은 오진(실측 0페이지).
  성과체계도 비선형 다이어그램 찢김 — 강등해도 coverage 불변(linearize 불가).
  파서 버그/OCR 아님, 착수 금지
- ⏳ **A-5 폼 정오**: 코퍼스/테스트에 실체 미확인 — 무엇을 가리키는지 재정의부터
- ⏳ **hwp3 합성 픽스처**: 유효 HWP3 바이너리 합성 = 비자명, 테스트 커버리지용

### C. exact/F1 2차 심화 (선택 — 대부분 원리적 표현 차로 분류 완료)

- 남은 non-exact 매칭들은 GT 헤더 "잔여 미달 성격" ①②에 해당 (병합 열 미세
  오프셋 표현 차, 동의서류 평탄화). 재도전 시 pdf 쪽에서 두 표현을 구분할 새
  증거가 있는지부터 — 없으면 착수 금지

## 수행 게이트 (모든 변경 공통)

- 기존 만점 후퇴 금지: hwpx recallMicro **1.0** · 표 611/611 · order 1.0 ·
  pdf 0.99609 · hwp쌍 0.9946 · fuzz **0/0/0/0/0** ·
  formats docx 0.998/xlsxStr 0.999/hml 0.995 ·
  **roundtrip fwd 0.999/bwd 0.998/헤딩 0/수식 0/줄 0** ·
  pdf표GT **매칭 0.98/exact 0.65/cellF1 0.72/cellExact 0.69/NED 0.52** ·
  렌더 테스트 10/10
- `npm run bench:gate` 전체 PASS / 테스트 683+ / tsc 13 동수
- 파서 수정 = 10차 검증 절차(activeContext "코퍼스/도구 메모") /
  채점기 수정 = **전 쌍 before/after 표**
- 개선 확정 시 게이트 상향 재잠금 + 릴리스(관례: feat 커밋 → release 커밋 →
  태그 → npm publish → gh release) + 문서 현행화

## 재론 금지 (누적 — 10차 신규 포함)

- **라벨 헤더 가드 조건 완화** (≤12자·마커 없음·전셀 비공백 첫 행 + 본문 ≥1셀) —
  pdf 14파일 검수로 잠금
- **체인 뷰 → 물리 병합 전환** (9차 pair07 셀 변질 실측) / CHAIN_Y_TOL 1.5·GAP 3
- **접두 폴백 가드 완화** (80자/40%/0.85)
- **자가진단표(12x6)·가족채용확인서(19x14) 파서 구제** — pdf 기하 부재 (V 4개 /
  15H·10V). 컴포넌트 합성 확대 = demote 연쇄 재론 금지
- 분할병합 rowsSum 관용 / 단순 전역 체이닝(물리) / 컴포넌트 단위 합성 재도입 /
  bagExtra 셀 채점 혼입 / pdf 헤어라인 tolerance 완화 / 수식 왕복 정합 /
  렌더 pt 단위·horzsize / 모수 최상위 2×2+(흐름띠·빈 표 예외는 승인 완료) /
  pdf coverage perLine trigram / changwon 성능
- rtk 훅 우회 = 명령 끝 `#<<rtk-skip` / mods.go.kr Referer / 다운로드 샌드박스 해제
- ⚠ hash-sweep EXTS에 .hml 미포함

## 도구 (bench/out/, gitignore)

- `diag-lines.mts` — 선 추출→전처리→그리드 계측 (⚠closeOpenTableEdges 미포함)
- `diag-grid2ir.mts` — 10차 신설: 합성 포함 프로덕션 경로 + extractCells + 스킵 표시
- `diag-raw.mts` / `diag-ops.mts` — raw 선·drawOp / 영역 교차 경로 덤프
- `node bench/pdf-table-gt.mjs --verbose` → bench/out/pdf-table.json details에
  ref↔ir 매칭·셀 미스 좌표

## 완료 기준 체크 (10차에서 전부 완료)

- [x] pair07 ref#1 해부 → 강등 가드 (①)
- [x] pair06 문의처 정밀 체이닝 = 체인 뷰 (②)
- [x] pair06 결격사유 — bag 교집합 0 차단 + 접두 유사도 폴백 (③)
- [x] pair10 ref#11 해부 → 가드 일반화 (④)
- [x] pair11 ref#15 오매칭 해부 → 오매칭 아님, 수용 (⑤)
- [x] 흐름띠·빈 표 — 증거 정리 → 사용자 승인 → 모수 예외 (⑥)
- [x] 게이트 재잠금 + v3.12.0 릴리스 + 문서·메모리 현행화 (⑦)
