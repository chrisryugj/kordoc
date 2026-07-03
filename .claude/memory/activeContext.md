# Active Context — kordoc 본체

**마지막 업데이트**: 2026-07-03 (연속 세션 4: 검증 전면 확장 — 신규 검증 4종 + 쌍/포맷 코퍼스 + 파서 픽스 3건)
**상태**: 테스트 635/635. `npm run bench:gate` 4체인(score·roundtrip·formats·fuzz) 전부 PASS. tsc 13(동수)

## 이번 세션 완료 (2026-07-03 연속 4차 — 검증 전면 확장)

- **① cellExact·contentNED 만점 도달** — 미달 6셀(3문서) 전수 특정: 셀 문단의 자동부호
  (`hh:heading type="NUMBER|BULLET"`)를 파서는 렌더(한컴 화면과 동일), ref는 hp:t 원문만
  수집해 생긴 **채점 비대칭** (파서 실손실 아님). ref가 header.xml에서 heading paraPr id만
  읽어 해당 줄을 마킹, 채점기는 마킹된 줄에 한해 IR 선두 장식 토큰 1개 관용
  (`stripHeadingDecor` — 리터럴 부호 줄은 엄격 유지, 문자/숫자 단독 토큰 불허로 중복문자
  버그 마스킹 방지). 발동 = 정확히 그 6셀뿐. **cellExact 0.999037→1.0, contentNED
  0.999655→1.0** → 게이트 0.999/0.9995 상향 잠금
- **② 생성 라운드트립 검증 신설** (`bench/roundtrip.mjs`) — md→hwpx→재파싱→md의 3-gram
  양방향 커버리지 + 표 채점(scoreTables 재사용). 기준선(2회 동일): fwd 0.947273 /
  bwd 0.946838 / tableExact 230/316. **개선 백로그 4종 발굴**: ⑴헤딩 왕복 소실(#→일반
  문단) ⑵리스트 마커 변형(-→·)·중첩 평탄화·번호 재시작 ⑶마스킹 별표 런(`******`)이 md
  HR로 소비(파서 출력 미이스케이프) ⑷셀 <img> 드롭(수용)
- **③ fuzz 스윕 신설 + DoS 버그 발굴·수정** (`bench/fuzz-sweep.mjs`) — 절단 50/90%·헤더/
  본문 비트플립 4변형, 경로 시드 재현. **발굴**: bflip PDF에서 `findTwoColumnProseCutX`
  스캔 루프가 오염 좌표(±Infinity·1e9)로 144.8s 폭주(프로파일 91.4%) → finite 가드 +
  후보 상한 400 (cluster-detector.ts). **144.8s→2.3s**, 정상 코퍼스 hash-sweep 바이트
  동일. 최종 183파일×4=732런 crash/hang/noCode/slow **전부 0** 잠금
- **④ hwp5 쌍 게이트 승격** — 0쌍 원인 = 동일문서 쌍 부재. 공공기관 hwp→hwpx 전환기
  병행게시 관행 활용, 에이전트 발굴로 **10쌍 수집** (bench/corpus/pairs/, 재수집용
  `bench/pairs-manifest.json` — mods.go.kr는 Referer 필수). 쌍 게이트 활성: 유사도
  0.9946·커버 0.9929 (기준 0.99) PASS. 6쌍은 pdf 3종 세트 (**A-1 PDF 표 GT 재료**)
- **⑤ formats 트랙 신설** (`bench/formats-sweep.mjs`) — docx 7·xlsx 11·hml 9 수집(직링크
  수집 에이전트), 스모크 + 자기참조 GT recall(자체 유닛 추출기, 초대형 시트는 UNIT_CAP
  5만으로 스모크만). **파서 픽스 2건 동반**: ⑴**한셀(HCell) xlsx** 접두 네임스페이스
  (`<x:sheet>`) 미인식 → getElements NS 폴백 (파싱 실패 2건→0) ⑵**HML P 앵커 표 통소실 +
  셀 중첩표 "[중첩 테이블]" 마커 소실** → walkTablesInP + 평탄화 (hml recall **0.231→0.996**)
- **⑥ changwon 22.4ms/p 프로파일 종결** — kordoc 코드는 8.8s 중 426ms(4.8%)뿐. 95%는
  pdfjs 이미지 디코드(1.3s)+fake worker structuredClone(1.8s)+GC. 픽셀 미소비인데 공식
  API 우회 없음(maxImageSize는 op 드롭이라 이미지영역 감지 깨짐). **pdfjs 플로어로 수용**
- **⑦ 게이트 체인** — `npm run bench:gate` = score → roundtrip → formats → fuzz (전부 exit code)

## 지표 대시보드 (2026-07-03 연속 4차 종료 — 포맷×지표 매트릭스)

| 트랙 | 지표 | 값 | 게이트 | 비고 |
|---|---|---|---|---|
| hwpx(85) | recallMicro / phantom | **1.0** ✨ / 0.000054 | 0.999 / 0.005 | 쌍 hwpx 10건 포함 확장 |
| hwpx | 표 exact / cellF1 | **611/611** ✨ / 1.0 | 0.99 / 0.999 | |
| hwpx | cellExact / contentNED | **1.0** / **1.0** ✨ | **0.999 / 0.9995** ↑ | 자동부호 장식 관용 |
| hwpx | orderAvg / eq / fn | 1.0 / 1 / 1 | 0.995/0.99/0.999 | |
| pdf(48) | coverage(micro) | **0.99609** | 0.985 | 미달 1건 = eval-perf-2024 0.9785(벡터 아웃라인, OCR 영역) |
| hwp쌍(10) | 유사도 / 커버 | **0.9946 / 0.9929** ✨신설 | 0.99 / 0.99 | nrich 2쌍 하위(0.977~0.982) |
| docx(7) | recall | 0.9293 ✨신설 | 0.92 플로어 | niied 표 드롭·kats AlternateContent·arko 미상 |
| xlsx(11) | strRecall / numRecall | 0.9894 / 0.9719 ✨신설 | 0.985(str) | goe-배분예정액 다중시트 누락 의심 |
| hml(9) | recall | **0.9960** ✨신설 | 0.995 플로어 | bizinfo 0.973(글상자 추정) |
| roundtrip | fwd / bwd / tblExact | 0.9473 / 0.9468 / 0.728 ✨신설 | 무후퇴 플로어 | 개선 백로그 4종 ↑ |
| fuzz(732런) | crash/hang/noCode/slow | **0/0/0/0** ✨신설 | 전부 0 | 신규 포맷 포함 |
| perf | hwpx ~7.8ms · pdf 8.2ms/p | — | — | changwon 22.4ms/p = pdfjs 플로어(종결) |
| 테스트/tsc | **635/635** / 13(동수) | — | — | +DoS 회귀 +formats 회귀 2건 |

## 다음 세션 후보 (플랜: .claude/plans/next-session-full-score.md 진행 체크 참조)

- **formats 미달 3건 수술** (파서 실손실 확인·재료 준비됨): ⑴docx niied 2번째 표(귀국신고서)
  통째 드롭(recall 0.675, md 1961자뿐) ⑵docx kats mc:AlternateContent Choice/Fallback 이중
  텍스트(0.917) ⑶xlsx goe-배분예정액 다중시트 셀 누락(str 0.984 — 시트 열거 검증)
- **A-1 PDF 표 구조 채점**: pairs 6쌍(hwpx+pdf 3종 세트)이 GT — hwpx 표를 참조로 pdf 표
  exact/cellF1 대조
- **A-5 폼 정오**: review 소수정예 수동 GT(라벨→값 json) → precision/recall
- **B-2 eval-perf-2024 OCR**: ocr/provider를 벡터 아웃라인 영역에 — pdf coverage 마지막 관문
- **roundtrip 개선 4종**: 헤딩 왕복(generator outline 스타일 미설정 추정)·리스트 마커·
  별표 런 이스케이프(파서 출력 md 문법 충돌 — 소비자 영향 검토)·번호 재시작
- hwp3 트랙: 실파일 희귀 — 합성 픽스처 검토
- 릴리스 v3.8.3 판단(2단 조판 픽스 + DoS 가드 + 한셀/HML 픽스 + 만점 잠금 묶음) — 사용자와

## 재론 금지 (기존 결정 유지 + 신규)

- LINE_SEG 원본 유지 / 공문서 장평 95%·굴림체 1.0em·함초롬 0.97em / 한컴 빈 문단 생략형
- PDF 머리글/바닥글 y-클러스터 규칙 재도입 금지 (본문 오삭제 사고)
- PDF coverage 참조 trigram **줄 단위(perLine)** — 줄 경계 gram 재도입 금지
- hidden text 필터 회전 예외 유지 / **extractLines CTM 추적 제거 금지** / **pdfjs cMap 자산 지정 유지**
- **findTwoColumnProseCutX는 fullPage 호출에만** + **finite 가드·후보 상한 400 제거 금지** (fuzz DoS)
- align Pass 1 "본문문자 유닛 우선" 유지 — 마스킹-only 유닛이 본문 구간을 가로채는 함정
- **셀 장식 관용은 heading paraPr 마킹 줄에만** — 무조건 접두 제거로 완화 금지 (리터럴 ※/- 드롭 회귀 은폐)
- changwon 성능 재론 금지 — pdfjs 이미지 파이프라인 플로어 실측 완료 (kordoc 4.8%)
- formats 유닛 추출기는 파서 경계 미러 필수 — P 유닛에 중첩표 CHAR 쓸어담으면 이중 계상
  거짓 miss (hml 0.57 사건)

## 코퍼스/도구 메모

- 실파일 코퍼스(gitignore): review/ 45 · hwp5/ 13+30 · pdf/ 42 · **pairs/ 26** · **formats/ 27** (신규)
- pairs 재수집: bench/pairs-manifest.json (mods.go.kr Referer 필수, 커밋됨). formats 출처는
  수집 에이전트 로그 — 필요시 검색엔진 filetype 연산자로 재수집
- PDF 수집법: 검색엔진 `filetype:pdf site:go.kr` 직링크 (korea.kr RSS 폐지)
- score pdf 트랙 pdftotext(poppler) 필수 (/opt/homebrew/bin/pdftotext)
- 게이트 일괄: `npm run bench:gate` / perf: `node bench/perf.mjs`
- npm publish: `~/.npmrc` bypass 2FA granular 토큰 유효
