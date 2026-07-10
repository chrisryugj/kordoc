# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.1] - 2026-07-11

v4.0.0 실무자(현직 공무원) 눈 QA 3건 수정 — 근거는 부처별 실측 양식 3종(업무보고·보고서×2)
전수 디코드 + 실무자 확인. 전 프리셋 한글 COM 실렌더 PDF 육안 게이트 통과.

### Fixed — QA 결함 3건

- **"정체모를 폰트" 제거 (QA-1)**: ① bold 시 HY견고딕/Arial Black 강제 치환(charPr 헬퍼)
  삭제 — 굵기는 `<hh:bold/>` 정본 요소만, 폰트는 항상 원 폰트 유지. ② 실측 폰트 세트를
  보고서·계획서 프리셋으로 확장(`usesReportFonts`) — 본문 휴먼명조, 제목·□ HY헤드라인M,
  ※ 한양중고딕 13pt, 표 셀 맑은 고딕 12pt, 제목박스 HY헤드라인M 22pt. `fonts` 4역할
  오버라이드도 보고서·계획서에 적용. 기안문·통지·회의록은 함초롬 유지(전자결재 관행)
- **h2 섹션 제목 말머리 (QA-2)**: OUTLINE 번호 제거(v4.0.0)의 대체 부재 수정 —
  `h2Marker` 옵션 신설: `box`(□ + 문단 위 2×본문 + 부호폭 내어쓰기, 실측 □ 대항목과 동일 —
  보고서·계획서 기본) / `number`(1. 2. 순번 재부여, 공고문 관행) / `none`. 선행 번호 자동
  제거 후 재부여. CLI `--h2-marker`, MCP `h2_marker`
- **개조식 소분류 부호 ― → 하이픈 `-` (QA-3)**: GT3 양식 저장값(U+2015)을 실무 관행으로
  교정 — 실무자 확인 + 부처별 양식 3종 중 2종이 하이픈. 내어쓰기 폭은 부호 실폭 연동이라 자동

### Added

- **공문서 표기법 검수 13룰** (`gongmun-lint.ts`, jkf87/hwpx-skill gonmun_lint 이식·보강):
  날짜(온점 뒤 공백·0패딩·2자리 연도·끝 마침표)·시간(24시각제·쌍점)·금액(천원·금 붙여쓰기)·
  붙임 쌍점·물결표+까지 중복·외국어 우선·쌍점 띄어쓰기. URL(`://`)·코드펜스 오탐 가드.
  공문서 모드 generate 시 경고 병기(생성은 진행) + `kordoc lint <file>`(error 시 exit 1) +
  `lintGongmunText`/`gongmunLintWarnings` 공개 API
- 보고서·계획서에서 ※ 문단/항목·blockquote → ※ 참고 스타일, 리스트 1단계 □ →
  HY헤드라인M 16pt (개조식과 동일 실측 위계)

## [4.0.0] - 2026-07-11

"완벽한 공문서 생산로직" 릴리스 — 실제 정부 공문서 16종(내부 실무문서 포함)을 요소 전수
디코드해 대조하고, 괴리 전수 목록(골격 20건·표 16건·방법론 9건)을 실측 근거로 메꿨다.
미발행 3.17.0(어절 줄나눔 역전 정정)을 포함한다. 전 산출물은 한글 COM 실렌더
무인 검증 체인(`bench/hangul-com-pdf.ps1`→`extract-pdf-lines.mjs`→`verify-junctions.mjs`) 통과.

### Added — 공문서 구조 요소 (전부 실측 근거)

- **쪽번호**: 하단 중앙 `- 1 -`(`pageNum BOTTOM_CENTER sideChar="-"`) + 표지·목차
  `pageHiding hidePageNum` 숨김 + 본문 첫 페이지 `newNum` 1 리셋 — 「2_보고서 양식」 원문
  그대로. 개조식·보고서·계획서 기본 켜짐, `pageNumbers` 옵션 (B9·G01·G14)
- **본문 첫 페이지 제목 반복 박스**: 표지 축소판 3×3 투톤 바 표(행높이 600/3566/600,
  HY헤드라인M 22pt) — 목차 뒤 새 페이지 선두. `bodyTitleBox` 옵션, 표지 켜진 개조식 기본 (B6·G02)
- **목차 장식 배너**: "목  차" 라벨이 1×7 스트라이프 표(#193AAA·#E0E5FA, 열폭
  [565,565,1414,13191,1414,565,565]) — 평문단 라벨 대체 (B7·G05)
- **결재란**: `approval: ["담당","팀장","과장"]` — 직위 라벨+서명 공란 2×N 표,
  문서 최상단 우측(외곽 0.4mm·내부 0.12mm) (B5·G03 간이형)
- **"끝." 표시**: 본문 끝 2타+"끝." 자동 (기안문 기본, `endMark` 옵션, 중복 방지) (B11·G18)
- **1페이지형 제목박스**: 보고서·계획서·통지 첫 h1 → 색상바(#0080C0)+제목+gradient
  (#0080C0→#3CBFFF RADIAL) 3단 표 (G04, GT2/GT6/GT7 실측)
- **`<right>` 태그**: 우측정렬 출처행(`<right>2026. 7. 11. 홍보담당관</right>`) (G19)
- **폰트 경고 (A2)**: `fonts` 오버라이드가 한컴 번들·통상 설치 목록에 없으면 경고
  (생성은 진행) — `unknownFontWarnings()` 공개 API, CLI stderr·MCP 결과 병기
- **CLI/MCP 옵션**: `--toc/--no-toc`·`--cover/--no-cover`(CLI toc 미전달 함정 수정),
  `--approval`, `--page-numbers`, `--end-mark`, `--no-body-title-box` + MCP 동등 파라미터
- **styleDigest 스크립트**: `scripts/style-digest.mjs` — HWPX 전수 요소 다이제스트
  (스타일 해석 완료 압축 JSON). 이번 전수 대조의 기반 도구 (B12 실용형)

### Changed — 표 완벽 재현 (실측 문법)

- **테두리 위계**: 외곽 0.4mm / 내부 0.12mm / 헤더행 하변 DOUBLE_SLIM 0.5mm 이중선 —
  셀 위치별 동적 borderFill 레지스트리(`gen-table-bf.ts`) (TBL-01·02)
- **헤더행 bold** + **라벨열**(2열 표 짧은 1열) #E7E7E7 음영·bold·CENTER (TBL-05·06)
- **셀 문단**: 헤더·짧은 열 CENTER 130%, 장문 열 LEFT 130% (기존 JUSTIFY 160% 대체) (TBL-11)
- **배치**: 데이터 표 본문폭 −1800 축폭 + 호스트 문단 우측정렬 (GT6/GT7/GT11 관행) (TBL-09)
- **열폭**: 짧은 열(수치·라벨) 실폭+12% 고정 — 긴 서술 열에 밀려 "4,673"이 꺾이는 협착 해소
- HTML 병합표 경로에도 동일 문법 적용 (병합 셀 스팬 기준 외곽/이중선 판정)

### Changed — 조판·기타

- **개조식 여백**: 상하 15mm + 머리말·꼬리말 영역 15mm (실측 GT1/GT3/GT9 공통.
  기존 20/10·0/0은 기안문 편람 값 — 기안문은 유지)
- **A3 기하 크기연동**: 장헤더 행높이·표지 제목칸·본문 제목박스·목차 배너가
  `sizes` 오버라이드에 비례 스케일 (기존 고정값)
- **□ 대항목 keepWithNext**: 쪽 하단 고아 표제 방지 (장헤더와 동일 관행)
- **hr**: 공문서 모드에서 간격 문단 (실측: 정부 문서에 문자 구분선 0건 — G17)
- **목차 페이지 조판**: 배너·박스 호스트 저줄간격 — 줄간격 160%가 표 줄높이에
  곱해져 배너와 박스가 페이지 분리되던 문제 해소 (실렌더 확인)

### Fixed

- **헤딩 개요 번호 노출 (선재 결함)**: 공문서 모드 헤딩(OUTLINE)이 한글에서
  "1. 제목"·"1.1. 제목"으로 렌더 — COM 실렌더로 최초 확인. OUTLINE 대신
  **명명 스타일("개요 1~4")**로 헤딩 의미 보존(파서에 스타일명 기반 헤딩 감지 추가,
  왕복 유지). `outlineShapeIDRef=0`·`numFormat=NONE` 실험 모두 무효 확인
- MCP `generate_document`에 자연어 프리셋 매핑·생성 전 확인 안내 명시 (오생성 방지)

### 내부

- charPr id 25(본문 제목박스) 추가 — 개조식 전용 15종(11~25), 장평 변형 26부터
- paraPr 재배치: RIGHT(17)·표 셀 CENTER/LEFT(18·19) 신설, 개조식 전용 20~24로 시프트
- borderFill: 개조식 3~9(+배너 스트라이프), 헤더 음영 10, 동적 레지스트리 11+
- 신규 모듈: `gen-table-bf.ts`(테두리 위계 레지스트리), `gen-gongmun-extra.ts`(결재란·
  끝표시·제목박스), `font-catalog.ts`(폰트 경고)
- 테스트 831 (신규 9: 쪽번호·제목박스·배너·결재란·끝표시·`<right>`·gradient·표 문법·기하연동)

## [3.18.1] - 2026-07-10

v3.17.0→v3.18.0 릴리스 범위 프로덕션 리뷰(적대 검증 에이전트 2기 + 실증 재현)에서 확인된
결함 수정. P1 3건은 전부 스크립트로 재현 후 수정했다.

### Fixed
- **서식 프로필 표 정합 붕괴 — 남의 서식이 엉뚱한 표에 무경고 적용 (P1)**: 추출기는 원본의
  모든 top-level `<hp:tbl>`을 세지만 parse 마크다운은 일부 표(1×1 제목박스, 머리말/꼬리말 표
  등)를 표로 방출하지 않아 순번(`table_index`) 매칭이 어긋났다 — 재현: `[1×1, 2×2 RED, 2×2
  GREEN]` 원본에서 재생성 시 두 번째 표에 RED 음영이 무경고 적용. 프로필에 첫 셀 정규화 앵커
  `anchor_text`(스키마 0.2.0)를 싣고, 소비는 **행·열 필수 + 앵커 일치 우선, 앵커 없으면
  순번 정확일치**로 전환 — 매칭 실패는 무서식(잘못된 서식보다 안전). 앵커 없는 손편집 sparse
  프로필(`table_index`로 특정 표 지정)의 기존 의미는 보존된다.
- **html_table 생성 실패 시 이후 표 프로필이 한 칸씩 시프트 (P1 연쇄)**: 표 순번을 생성
  성공이 아니라 **시도 기준**으로 세도록 변경 — 깨진 HTML 표가 문단 폴백돼도 뒤 표들의
  순번 매칭이 밀리지 않는다.
- **MCP `parse_document` 이미지 인라인 회귀 (P1)**: v3.18.0이 기본 인라인(base64, 4MB 상한)으로
  바꿨으나 MCP 텍스트 응답의 data URI는 모델이 이미지로 해석하지 못하고, 사진 1장(≈100KB →
  base64 133KB ≈ 34k 토큰)만으로 클라이언트 도구 응답 한도(Claude Code 기본 25k 토큰)를 넘겨
  호출이 깨졌다 — v3.17.0의 파일 참조(`image_NNN`) 방식으로 복원. 자체 완결형 마크다운이
  필요하면 CLI `--inline-images`를 사용.
- **병합/중첩 표 셀 이미지 유실 (P1)**: HWP5 표 셀 이미지는 `<img src="image_NNN.bmp">`(HTML
  표 경로)로 방출되는데 인라이너가 `![image](...)` 문법만 치환해, CLI `--inline-images`가
  이미지 저장을 생략하면서 표 셀 이미지만 dangling 참조로 유실 — `<img src>` 참조도 인라인.
  `--out-dir`의 `images/` 경로 접두사도 `<img src>`에 함께 적용(비인라인 모드 참조 깨짐 수정).
- **프로필 `fontRef_hangul` dangling IDREF (P2)**: 원본 fontfaces 순번(3 이상 흔함)을
  생성 header(HANGUL 3종, id 0~2)에 없는 id로 그대로 방출하던 것 — 범위 밖은 기본 글꼴(0)로.
- **BMP 픽셀 상한 64MP→36MP (P2)**: A4 전면 600dpi(≈35MP)는 허용하되, 헤더가 주장하는
  초대형 BMP가 rgba+raw 300MB+와 수 초의 `deflateSync` 동기 블로킹(MCP 서버 정지)을
  유발하지 않도록 축소. 초과분은 원본 바이트 폴백(기존 동작).

### Docs
- **v3.18.0 미기재 변경 소급 기재**: CLI `--inline-images`(HWP5 전용 base64 인라인,
  BMP→PNG 압축) / `--dedupe-headers`(HWP5 러닝 헤더 중복 제거 opt-in, 기본 off) 옵션 신설,
  레이아웃 표 해체 시 중첩 구조(`cell.blocks`) 보존으로 중첩표 유실 수정, 비-HWP5 포맷에서
  `--inline-images` 지정 시에도 이미지 저장 유지(유실 방지). `--inline-images` help 문구의
  "별도 파일 미저장"을 실동작(인라인된 경우만 미저장)으로 정정.
- format-profile-spec.md 0.2.0 현행화(`anchor_text`·매칭 규칙·fontRef 클램프).

### Notes
- 검증: npm test 842/842 (신규: 방출 누락 표 앵커 정합, 동형 쌍둥이 표 순서, html 실패
  무시프트, fontRef 클램프, `<img src>` 인라인).

## [3.18.0] - 2026-07-09

### Added
- **서식 프로필(format profile)**: 표의 위상(병합)뿐 아니라 **borderFill(테두리·음영)·열 실측폭·셀 글꼴**까지 원본 문서 없이 재현. `markdownToHwpx(md, { profile })`로 서식을 입히고, `hwpxToProfile(hwpx)`로 레퍼런스 hwpx에서 서식만 JSON으로 추출 — 원본 유출 없이 기관 서식만 공유·재현(이슈 #41, 스키마 `docs/format-profile-spec.md`). 표별 로컬 id를 문서 전역 id로 리맵해 `gongmun` preset과 병용해도 charPr id 충돌 없음. profile 미지정 시 출력 바이트 불변(하위호환). 스키마·문서 초안·비식별 예시 기여: @chiclooc-rgb (PR #42).

## [3.17.0] - 2026-07-06

### Added
- **렌더 per-run 폰트**: charPr fontRef(hangul) → head.xml fontfaces 글꼴명 → CSS font-family 스택을 `<text>`에 방출. 전 텍스트가 root 함초롬바탕(serif)으로 렌더돼 고딕 공문 제목이 바탕체로 나오던 것 해소.
- **다구역(multi-section) 렌더**: `renderHwpxToSvg`가 section0만 렌더하던 것을 전 구역 세로 스택으로 확장 — 표지+본문 다구역 문서가 첫 구역만 보이던 것이 전체 페이지로.
- **겹침 감지 도구**: `bench/reflow-overlap-check.mjs` — SVG 텍스트 bbox 쌍별 교차 검사로 결재란 등 중첩표 조판 회귀를 수치화.

### Fixed
- **결재란(전자결재 스탬프) 표 겹침(reflow)**: 실텍스트 0(인라인 개체만) 문단의 합성 lineseg textpos가 `chars.length`로 폴백돼 planLines의 plan.start가 개체 index를 넘고, advanceTo 가로 전진에서 개체가 전부 배제 — 라벨표·스탬프표가 같은 x에 포개 찍히던 것을 textpos 0으로 수정해 한컴과 동일하게 나란히 배치. 재현 fixture overlap-check 2쌍→0쌍, 코퍼스 75건 스윕 악화 0.
- **중첩표 셀 높이 과소측정**: `cellContentExtent`가 인라인 개체(중첩표·treatAsChar 이미지)를 건너뛰어 표지 중첩표 텍스트가 겹치고 페이지 밖으로 넘치던 것 — 인라인 개체 높이(중첩표는 measureTableHeight) 반영.
- **가로(landscape) 문서 잘림**: pagePr `landscape="NARROWLY"`(90° 회전)를 무시해 가로 표가 세로 프레임 우측에서 잘리던 것 — 용지 W/H 스왑 (HWPX는 가로 문서도 용지 치수를 세로값으로 저장).
- **연속 표 문단 페이지 포개짐**: 페이지 전체가 표 하나인 문단이 연속이면 분할 프리패스(vertpos strict 역행 기준)가 경계를 못 잡아 뒤 페이지들이 한 페이지에 겹쳐 그려지던 것 — 문단 첫 seg + v 동일 + h 비전진일 때 경계 추가 인정 (같은 줄이 개체 좌우로 갈라진 seg는 오탐 제외).
## [3.17.0] - 미발행 (4.0.0에 포함)

### Fixed

- **한글 어절 줄나눔 — `breakNonLatinWord` 의미 역전 정정** (v3.5.3 회귀 아님·최초 정정):
  한컴 실구현에서 이 속성은 이름과 반대로 동작한다 — **`BREAK_WORD`=어절 유지,
  `KEEP_WORD`=글자 단위**. 한글 COM 실렌더 A/B 매트릭스(동일 문서·속성 1개씩 토글,
  정렬 JUSTIFY/LEFT·condense·snapToGrid 교차)로 실측 확정:
  - `KEEP_WORD` 문단은 정렬 무관 "실증되었/고," 같은 어절 중간 분리, `BREAK_WORD`
    문단은 줄바꿈 전부 어절 경계 + 영어 단어(`Kubernetes` 등) 통째 유지.
  - `breakLatinWord`는 이름대로(`KEEP_WORD`=단어 유지). 정본 양식(2_보고서)의
    `KEEP_WORD/KEEP_WORD`가 한글 기본값 '글자/단어'와 일치하는 것과도 정합.
  - `snapToGrid`는 줄나눔과 무관함이 같은 실측에서 확인(3.5.3의 "격자가 어절을
    깬다" 서술과 3.5.3 하단 "macOS 뷰어가 KEEP_WORD를 무시한다"는 해석은 오독 —
    뷰어·전자결재 변환기 모두 KEEP_WORD(=글자)를 정확히 따르고 있었다).
  - 반영: 공문서(어절 의도) 문단이 실제로 어절로 저장되고, 일반 경로는 종전
    실조판(BREAK_WORD=어절)을 명시적 `keepWord: true`로 행동 보존.
- **렌더 reflow가 문단 `breakSetting` 선언을 따름** — 종전에는 전역
  `reflowMode` 옵션만 봐서 미리보기와 한글 실조판의 줄바꿈이 달랐다. 이제
  paraPr 선언(BREAK_WORD=어절/KEEP_WORD=글자)이 우선, 옵션은 선언 없는 문단의
  폴백. (`RenderParaGeom.wrapMode` 신설)

### Added

- **개조식(gaejosik) 정부 표준 보고서 프리셋** — 표지(파랑 바·제목 자동 축소)·목차·
  장헤더 표·□○― 계층·공문서 표 스타일(내용비례 열폭·헤더 음영·repeatHeader)·
  fonts/sizes 커스터마이징. 상세 실측 근거는 `docs/gongmunseo-engine-spec.md` (f)장.

## [3.16.2] - 2026-07-05

### Fixed
- **PDF 표(pline-1)**: `shouldDemoteTable`의 텍스트박스 패턴(`/<[^>]+>/`)이 길이 가드 없이 실행돼 신구조문대비표의 `<신 설>`·`<단서 신설>` 표기를 요약 박스 마커로 오인, 표 전체를 문단으로 강등하던 것 — 텍스트 200자 이하일 때만 텍스트박스로 판정(같은 함수의 "200자 초과=정상 표" 기존 정책과 정합). KAIST 30p 개정안 대비표가 3조각+본문 누출 2건 → 통째 1표로 복원, pdf-table 게이트 지표 동일(회귀 0).

### Changed
- **bench:visual 오라클 개편(gate-2)**: 도장 유무가 40mm에서도 aHash 0/1024비트로 무감지되던 원인 확정 — 창 crop에 한컴 작업영역 배경(테마 따라 검정/회색)이 37% 포함돼 전역 평균이 254→169로 눌리고, 도장(얇은 붉은 테두리+흰 속)은 32×32 셀 평균이 209~220까지만 희석돼 임계를 못 넘던 것. 순백(≥248) 픽셀 비율로 페이지 경계를 검출해 **페이지만 해시**(신규 `bench/visual/hash-lib.mjs`, 한컴 없이 오프라인 검증 가능)하고, 도장 케이스는 **붉은 픽셀 질량·중심좌표**를 baseline과 대조(소실 50%↓·과다 2배↑·중심 5%p 이동 시 실패). 테마 교차 동일 문서 해밍 26→0(환경 독립), 도장 소실 red 0↔753px 완전 분리, `--seal-sens` 감도 실측 모드 상설화. baseline 2행 포맷 전환·전 케이스 재박제.

### Notes
- 검증: npm test 799 / bench:gate 56/59(reflow 95%) / bench:visual 재박제 + 신 오라클 게이트(한컴 실렌더).
- gate-2 감도 실측(재박제 캡처): 도장 15/25/40mm aHash 9/29/53비트 + red-mass 3,228~21,367px — 소형 도장 검출 정본은 red-mass, aHash는 레이아웃 붕괴·백지·대형 소실 담당.

## [3.16.1] - 2026-07-05

통합 검증 프로덕션 리뷰(v3.15/3.16 발행분 적대 리뷰)의 신규 결함 + 전 클러스터 프레시 스켑틱 재검증에서 발견된 잔여 결함을 수정한다. 대부분 "성공 메시지 + 조용히 틀린 산출물" 계열 — 공문서 자동화에서 무신호 오출력을 차단한다.

### Fixed

- **도장(place_seal)**: rowSpan 결재란에서 도장이 한 열 왼쪽에 찍히던 것(그리드 열폭 테이블로 면역, seal-1) · 가로 병합(colspan) 제목행 아래 데이터행에서 병합폭 이중계상으로 도장이 표 밖에 찍히던 것(colSpan>1 셀 제외, seal-1 colspan) · 중첩표 셀 앵커에서 바깥 셀 오프셋 미가산으로 도장이 옆 셀로 밀리던 것(조상 셀 체인 가산 — 한컴 실측으로 '항상 페이지 단' 원점 모델 확정, seal-2) · CLI --size-mm NaN·음수 검증, 이미지 매직바이트 검증, 섹션 숫자 정렬, 앵커 run charPr 폴백, 탭/다중줄 근사 경고(seal-4~8).
- **차트(chart)**: 천단위 콤마 `1,000`이 [1,0,2,0]으로 오염되던 값 파서(자릿수 패턴 결합, chart-1) · 기안문 표준번호 모드에서 항목 사이 차트가 항목번호 run을 끊던 것(passThrough에 chart 배선, chart-2) · CRLF 마크다운에서 펜스 감지 전멸+헤딩·리스트 파괴(md 입구 개행 정규화, chart-3) · 계열이 라벨보다 길 때 꼬리 값 무음 절단(라벨 확장 보존, chart-5) · 비숫자 토큰·개수 불일치·들여쓴 펜스·PrvText·size 클램프(chart-4·6·7·8).
- **secure-fill**: require_unique 가드가 기본 경로(hwpx-preserve)와 전략0(인셀 패턴)에서 무력하던 것 — 전 전략 key 배선 + 접두사 폴백 오염 차단(sfill-1·2) · 날짜/전화/마스크 서식 엣지(미패딩·대소문자·02 지역번호·자릿수 불일치)·mask_values verify 정규화·출력 PII 마스킹(sfill-3~8).
- **CLI/플러그인**: `fill`·`watch`의 `-o`/`-d`/`--format` 루트 옵션 가로채기로 파일 미생성·출력 무시되던 것(루트 폴백 배선, plugin-1·5) · pdfjs-dist optionalDependencies 승격, SKILL/README 문구·차트 예시 정정(plugin-2·3·4).
- **수식·왕복**: escapeGfm이 `$…$` 수식 스팬 내부 `~`/`*`를 이스케이프하던 것, replaceFrac 분자 비인접 삭제, findKeywordToken·분자 역탐색 공백류(개행·탭) 정합, `[별표 N]`·이탤릭 escapeGfm, render-worker null 라인 크래시·quit 종료(eqrt-1~6).
- **PDF 표**: 개방변 표 y-간격 상한이 병합 큰 행을 두 표로 절단하던 회귀 — 밴드 관통 수직선을 표 x-범위로 국소화 인지(pline-1·2) · fill 유래 선분 스테일 폭으로 폭 판별자가 무력화되던 것(fromFill 태깅, pline-3).
- **HWP5 왕복(§4b)**: 표기 무변경(`\n`↔`<br>`) 오판, 다중줄 verification 자기잔차, `<br><br>` 빈 줄, 음수 gridBefore 클램프(hwp5-1·2·4·5).
- **게이트·렌더**: 시각 게이트 baseline 부재=실패(박제는 --update 분리), 해밍 임계 48→16(재캡처 노이즈 0 실측), score 모수하한 면제, `--case` 무매치 실패(gate-1~4) · 렌더 진입점 압축폭탄 가드(압축해제 전 검사, reflow-1).

### Added
- **bench:visual 케이스 2종**: seal-colspan(가로 병합 제목행)·seal-nested(중첩표) — seal-1·seal-2 도장 배치를 한컴 실렌더 aHash 게이트로 잠금.

### Notes
- deferred(문서화 한계): seal-3(글상자 원점 — 합성 트리거 확보 곤란), eqrt-1(`$…$` 통화 오보호 — LOW·3중 조건부), pline-1(무구분 전폭 병합행 — 관통선 없어 미보호), hwp5-3(리터럴 `<br>` 보존 — builder 방출 규약 신설 필요).
- 검증: npm test 799 / bench:gate 56/59(reflow 95%) / bench:visual 8케이스(한컴 실렌더).

## [3.16.0] - 2026-07-05

### Added
- **차트 생성 (P5)**: 마크다운 \`\`\`chart 펜스 → 한컴 네이티브 차트. HWPX 차트는 OLE가 아니라 Chart/chartN.xml(OOXML DrawingML chartSpace) 파트 + manifest 등재 + `<hp:chart chartIDRef>` 참조 구조 — claw-hwp(MIT)의 한컴독스 GT 검증 구현을 TS 이식. 막대·선·원·도넛·영역·분산·방사형 + 누적·3D 변형 20종(한국어 별칭 지원), `type:/cat:/size:/colors:` + "이름: 숫자들" 계열 라인 규약, 파싱 실패 시 일반 코드블록 폴백. 차트는 글자처럼 취급(treatAsChar=1)이라 삽입 위치에 고정된다.
- **도장/서명 배치 (P6)**: `kordoc seal 문서.hwpx --image 도장.png --anchor "(인)"` / `placeSealHwpx()` / MCP `place_seal`(11번째 도구). 앵커 문구("(인)"·"서명 또는 인" 등)를 폰트 메트릭(전각 1em·반각 0.5em)으로 찾아 도장 PNG를 글 앞 부유로 배치 — treatAsChar=0 + flowWithText=0 + allowOverlap=1 (claw-hwp GT 규칙)이라 **표/페이지가 커지지 않는다**. 가운데/오른쪽 정렬 문단의 블록 이동 보정, occurrence 선택, auto/overlap/right 모드, 7~18mm 자동 크기, dx/dy 미세조정.
- **Claude Code 플러그인 (P7)**: `/plugin marketplace add chrisryugj/kordoc` → kordoc 스킬(SKILL.md — 파싱·생성·채움·패치·날인·검증·렌더 워크플로와 함정 문서화). `.claude-plugin/marketplace.json` + `plugins/kordoc/`, `claude plugin validate` 통과.
- **bench:visual 케이스 2종 추가**: seal(도장 부유·표 불확장)·chart(차트 실렌더) — 한컴 실렌더 aHash 게이트에 신기능 편입.

### Fixed
- `patchZipEntries`에 additions 파라미터 — 신규 ZIP 엔트리(BinData 도장 파트)를 기존 로컬 레코드 뒤·CD 앞에 추가 (UTF-8 이름·고정 타임스탬프·기압축 STORE 폴백). 비변경 엔트리 바이트 보존 불변.

### Notes
- 리뷰 #13(PDF 신구조문 대비표 오강등, PLAUSIBLE)은 실파일 2종(권익위 4p·KAIST 30p)에서 **미재현** — 실존 대비표 PDF는 괘선이 있어 표로 정상 복원(행 대응 유지). 트리거 실파일(무괘선 대비표) 확보 시 재개, 미재현 상태로는 속기록 정발화 회귀 위험 때문에 수정하지 않음.

## [3.15.0] - 2026-07-05

### Added

- **Tier-2 reflow 렌더** — 조판 캐시(`linesegarray`)가 없는 HWPX(`markdownToHwpx`
  산출물·에이전트 생성본·편집본)도 순수 TS 조판으로 렌더한다.
  `renderHwpxToSvg(buf, { reflow: true })` / CLI `kordoc render --reflow`.
  `simulateWrap`(수평 줄나눔, 실측 `linesegarray` 98% 일치) + 세로 모델
  (`baseline = round(0.85 × textheight)`·줄 pitch = `round(textheight × lineSpacing%/100)`,
  한컴 저장본 실측 역설계)로 lineseg를 합성 주입 → 기존 렌더 파이프(정렬·표·이미지·
  형광펜·다페이지)를 그대로 재사용한다. 단문단 텍스트 + 표 셀(셀 로컬 좌표) + 표
  밀어내기 + 자동 페이지 분할. 자기일관성 게이트(`bench/verify-reflow.mjs` —
  한컴본 strip→reflow→기하 diff) 9/10(내용 매치 91~100%·세로 오차 0.1~1pt).
  **캐시가 있으면 캐시 재생(Tier-1 무회귀)** — reflow는 캐시 부재 문단만 채운다.
- **그리기 도형 렌더** — `rect`/`ellipse`/`line`/`polygon`/`curv`/`arc`를 SVG shape로
  그린다(`lineShape` 선 색·굵기·점선, `fillBrush` 채움, `curSz`/`orgSz` 스케일,
  개체 로컬 좌표). 기존에는 경고 후 생략해 "원본과 다름"의 큰 원인이었다.
- **persistent 렌더 워커** — `kordoc render-worker`가 stdin NDJSON 요청
  (`{id,file,out,reflow,highlight}`)을 받아 조판 SVG를 파일로 출력한다(프로세스 유지 →
  node 콜드스타트 제거). 임베더(docufinder 등)의 연속 미리보기 렌더에 유리.

### Changed

- `RenderStyles`에 `paraGeom`(줄간격·여백) 추가 — reflow 세로 조판용. 기존 파싱 무영향.
- **HWP5 다중줄 채움/수정** — 표 셀·본문 문단·빈 문단에 `<br>` 표기로 강제 줄바꿈
  (0x000a) 값을 채운다. LINE_SEG를 줄 수만큼 합성해 한컴이 실제 여러 줄로 렌더
  (1세그면 flat 렌더되는 실측 반영). 본문 문단의 다중줄 수정은 `<br>` 명시 시에만.
- **양식 채움 서식엔진** — `fill_form`에 `formats`(date:yy.mm.dd·phone:hyphen·
  rrn:masked·`#` 숫자마스크·자유 패턴), `require_unique`(모호 라벨 거부),
  `mask_values`(응답 값 마스킹 + 재파싱 FILLED 검증) 추가.
- `prepublishOnly`에 `bench:gate` 편입 — 발행 전 정확도 게이트 강제. 게이트에
  트랙별 모수 하한·표 순서구제(reordered) 무증가 플로어 추가.
- `bench:visual` 신설 — 로컬 한컴 실렌더 캡처를 aHash로 대조하는 시각 게이트
  (macOS GUI 전용, 발행 전 수동 1회).

### Fixed

- **HWP5 파서: 강제 줄바꿈(0x000a) 뒤 7글자 증발** — 코드 10을 확장 컨트롤로
  오분류해 14바이트를 소비하던 자료손상. 패치 경로(`splitParaText`)도 대칭 수정.
- **DOCX 병합표 `gridBefore` 미처리** — 행 앞 건너뛴 그리드 열을 읽지 않아 셀이
  왼쪽 열로 무음 오배치되던 자료손상.
- **PDF 개방변 표 합성의 상하 표 용접** — y-간격 무제한 그룹핑이 스택된 두 표를
  하나로 합치고 사이 본문을 흡수하던 자료손상.
- reflow: 셀 콘텐츠로 자란 표의 실효 높이를 반영 — 표 뒤 문단이 표 위에 겹치던
  문제 해소 (`measureTableHeight`, 한컴 실렌더 대조 검증).
- reflow: 캐시 감지를 태그 마크업 매치로 — 본문에 "linesegarray" 단어가 있으면
  전면 백지가 되던 오판 해소. 렌더 이미지 개수·누적 캡 + dataURI defs 1회 참조로
  반복 참조 문서 OOM 차단. 탭을 8슬롯 인라인 컨트롤로 정정(줄 경계 밀림).
- 수식: `over`/`root`/`of` 부분문자열 오파싱으로 왕복이 붕괴하던 문제 —
  리터럴/`\text{}` 마스킹 + 토큰 경계 스캔. LaTeX 공백 매크로(`\,` 등)가
  리터럴 구두점으로 렌더되던 주입 제거.
- 마스킹 별표가 heading/list 왕복에서 볼드로 소비·삭제되던 escapeGfm 누락.
- DOCX: restart 없는 vMerge continue 셀 내용 보존, 텍스트박스 수식 이중 방출 방지.
- PDF: 음영 스택 필터가 패딩 0 글상자의 실제 테두리를 삼키던 문제(말단 이질줄 트리밍).
- render-worker: 비JSON 라인에 `{ok:false}` 응답 (무응답 행 방지).

## [3.14.0] - 2026-07-04

### Added

- **렌더 다페이지 지원** — `kordoc render`가 전 페이지를 세로 스택 SVG로 그린다
  (페이지별 흰 배경·경계선·클립, `data-page` 속성, `RenderSvgResult.pageCount`).
  최상위 lineseg `vertpos`가 페이지 로컬(페이지마다 0부터 리셋)인 성질로 경계를
  감지하며, 다단(colCount>1)은 horzpos 복귀 조건을 함께 본다. 기존에는 전 페이지가
  첫 페이지 한 장에 겹쳐 그려졌다.
- **렌더 검색어 형광펜** — `--highlight <쉼표구분어>` / `RenderSvgOptions.highlights`.
  텍스트 조각을 매치 경계로 분할해 매치 세그먼트에만 배경 rect 를 깐다(대소문자 무시).
  세그먼트와 rect 가 동일한 `textLength` 폭·위치로 계산돼 정렬 오차가 없다.
  charPr 경계에 걸친 매치는 칠하지 못하는 한계.

### Fixed

- **렌더 줄 경계 어긋남** — lineseg `textpos`는 HWP5 문자 스트림 슬롯 기준(표·구역
  정의 등 컨트롤 8슬롯, 탭·lineBreak 등 문자형 컨트롤 1슬롯, 서로게이트 쌍 2슬롯)
  인데 순수 텍스트 코드포인트로만 세어, 컨트롤·탭이 섞인 문단에서 첫 줄에 글자가
  몰리고 다음 줄이 비는 현상. 슬롯 스트림 재구성으로 정합 (데모 코퍼스 1,132개
  멀티라인 문단에서 경계가 8슬롯 블록 중간에 걸린 사례 0건으로 검증).
- **렌더 이미지 크롭 오판(로고 깨짐)** — `imgClip` 좌표계를 `orgSz`(최초 삽입 크기)
  기준으로 해석해, 삽입 후 리사이즈된 이미지(dim<org, 로고 대부분)를 좌상단 코너로
  잘못 잘라 로고가 흐린 조각이나 빈칸으로 깨졌다. `imgClip`은 `imgDim`(내용 상자)
  기준임을 반영 (데모 코퍼스 pic 267개 중 254개가 clip==dim=크롭 없음, 실제 크롭
  8개도 모두 dim 기준으로 정상 렌더).

## [3.13.0] - 2026-07-04

### Added

- **PDF 프로즈 박스 감지** — 상단 라벨탭(제목 칩)이 박스 테두리에 걸쳐 만든 가짜
  열 위로 본문이 전폭 프로즈로 흐르는 표(검정고시 응시자격 박스 등)를 감지해
  표를 버리고 아이템을 프로즈 폴백(자연 읽기순)으로 재추출. 판정은 두 신호의
  교집합 — 기하(내부 수직 구분선 없는 전폭 행이 표 높이의 60%+) × 텍스트(80자+
  긴 셀 3개+ 이고 채운 셀의 40%+). 기하 단독은 다줄셀 정규표, 텍스트 단독은
  서술형 2열표와 구분되지 않아 둘 다 충족할 때만 발동. 셀 조인(demote)이 찢긴
  조각을 스크램블하던 문제 해소 — pdf 코퍼스 7파일 개선/중립, pairs 무변경

### Fixed

- **HML 표 캡션 소실** — hwpml 파서가 `TABLE > SHAPEOBJECT > CAPTION` 텍스트를
  통째로 버리던 것을 별도 문단으로 보존(`Side=Top/Left`면 표 앞, 그 외는 뒤).
  `collectCharText`가 SHAPEOBJECT를 스킵해 표 주석("※ …참조" 등 도형 캡션)이
  소실되던 문제 (bizinfo hmlRecall 0.9727→0.9857)

## [3.12.0] - 2026-07-03

### Added

- **PDF 개방 변 합성 체인 뷰** — `closeOpenTableEdges`의 끝점 정렬 판정을 콜리니어
  세그먼트(셀 단위로 쪼개 그은 괘선)를 논리 괘선으로 이은 체인 뷰 기준으로 전환.
  물리 수평선은 수정하지 않아 셀 배치 부작용 없이, 중간 괘선이 셀 경계마다 분절된
  표(문의처 2x4 등)의 좌우 개방 변이 닫힘

### Fixed

- **라벨 헤더 표 오강등** — 첫 행 전체가 마커 없는 짧은 라벨이고 본문에 내용이
  있는 표는 텍스트 박스 강등(`shouldDemoteTable`)에서 면제. 본문 셀의 ○/ㅇ
  항목부호(채용분야|담당업무|우대조건)와 양식 표의 빈 기입란(성명|응시분야|비고)이
  텍스트 박스 패턴으로 오인돼 문단으로 강등되던 문제 — pdf 코퍼스 14파일에서
  예산표·라벨 열·대비표 등이 표로 복구 (coverage 무후퇴)

### Benchmark

- pdf표GT 트랙 3픽스 + 모수 예외: ⓐbag 교집합 0 매칭 차단 (dims-only 누수가
  진짜 짝을 선점하던 것 해소) ⓑ전체 텍스트 접두 유사도 폴백 (세밀 분할 프로즈
  박스 구제) ⓒ흐름띠·거의 빈 표 모수 제외 (hwpx가 표를 레이아웃 도구로 쓴 표현
  차, 양측 대칭). 게이트 재잠금: 매칭 0.90→0.98 / exact 0.58→0.65 /
  cellF1 0.65→0.72 / cellExact 0.67→0.69 / NED 0.49→0.52

## [3.11.0] - 2026-07-03

### Added

- **PDF 개방 변 표 테두리 합성** (`closeOpenTableEdges`) — 좌/우 바깥 테두리를 생략하는
  행정문서 표 스타일(수평 괘선 전폭 + 내부 수직선만)에서 교차점 기반 그리드가 가장자리
  열을 통째로 잃던 것을, 끝점 정렬 괘선 묶음(≥3줄)에 내부 수직선이 실존할 때 끝점 x에
  가상 수직 테두리를 합성해 복원

### Fixed

- **글상자 그라디언트 음영의 괘선 오염** — 한컴 PDF가 배경 그라디언트를 같은 범위의
  가는 수평선 수십 개(0.5pt 간격)로 그려, 근접 평행선 병합이 스택과 함께 주변의 실제
  상하 테두리까지 연쇄 흡수하던 것을 음영 스택 필터(≥6줄·<2pt 간격 run 제거)로 차단
- 위 두 수정으로 채용공고류 1페이지 병리 완치 — 2x6 표가 가운데 4열만 감지되고 지역·비고
  열과 아래 본문·섹션 제목·담당업무 표까지 13x2 유령 표로 흡수되던 사례 (pair05 실측)

### Benchmark

- pdf표GT(6쌍): 매칭 0.8472→**0.9028** / exact 0.5417→**0.5833** / cellF1 0.6324→**0.6518**
  (채점기 bagExtra 매칭 보강 포함 — pdf가 평탄화하는 동의서류 중첩표 박스 4건 매칭 회복.
  contentNED 플로어는 0.5→0.49 재잠금: 종전 미매칭 표의 빈 셀이 받던 공짜 exact가
  정직한 좌표 대조로 바뀐 의미 변화, 상세는 bench/pdf-table-gt.mjs 헤더)
- 그 외 전 트랙 무후퇴: hwpx recallMicro 1.0 · 표 611/611 · pdf coverage 0.99608 ·
  roundtrip/formats/fuzz 게이트 전부 PASS · 테스트 683/683

## [3.10.1] - 2026-07-03

### Fixed

- **렌더 SVG 크기 단위** — `width`/`height`를 pt 단위로 명시. 단위 없는 px로는
  브라우저 단독 열람 시 A4 실물(96dpi)보다 25% 작게 보였음 (viewBox 스케일링은 기존과 동일)

## [3.10.0] - 2026-07-03

### Added

- **레이아웃 보존 렌더 (`renderHwpxToSvg` / `kordoc render`)** — 조판 엔진 없이
  한컴이 HWPX에 저장한 조판 캐시(`linesegarray`·`cellAddr`·`hp:pos`)를 SVG
  절대배치로 그려 원본 1페이지 레이아웃(결재문서 헤더·표·본문·결재란·사진)을
  재현. 지원: run별 charPr(크기·굵기·색·밑줄·자간·장평), paraPr 정렬
  (JUSTIFY/CENTER/RIGHT/배분 — 줄바꿈은 원본 lineseg로 고정), 셀
  배경색·테두리(borderFill), 셀 수직 정렬, 병합 셀 그리드(스팬 제약 경계 전파
  솔버), 콘텐츠 초과 행 성장, 인라인(`treatAsChar`) 개체, 이미지 크롭(imgClip),
  `PAGE`/`PAPER`/`PARA` 개체 앵커(밀어내기 역산). 한컴 저장본 전용 —
  `markdownToHwpx` 산출물엔 조판 캐시가 없어 명확한 에러를 반환.
  코퍼스 hwpx 85건 크래시 0 실측

### Fixed

- **uint32 음수 좌표 해석** — `vertOffset="4294967103"`(= −193)처럼 uint32로
  저장된 음수 오프셋을 부호 있는 값으로 해석 (사진대지 사진 1장이 페이지 밖으로
  사라지던 원인)
- **셀 내부 `COLUMN` 기준계** — 셀 안 개체의 `horzRelTo="COLUMN"`을 페이지
  단이 아닌 현재 셀 영역 기준으로 해석 (우측 셀 사진이 페이지 왼쪽에 겹치던 원인)

### Added

- **Markdown display math → HWPX native 수식 생성** — `$$ … $$` 블록을
  `<hp:equation>`(EqEdit script)으로 생성. 지원: `\frac`·`\sqrt[n]`·첨자/위첨자·
  그리스 문자·적분/극한·화살표·관계 연산자·`matrix`/`pmatrix`/`bmatrix`·
  `\left(`/`\left\{` 구분자·`\text`/`\mathrm` 리터럴. 생성 어휘는 읽기
  (`hmlToLatex`) 토큰맵과 왕복 정합 — 전 토큰 고정점 테스트로 잠금.
  (#38, #39 — @leehuiso 기여 + 리뷰 확정 8건 수술)

### Fixed

- **`$$` 스캐너** — 닫히지 않은 `$$`가 문서 나머지를 통삼킴하던 것을 일반 문단
  폴백으로, 닫는 `$$` 뒤 잔여 텍스트 무음 소실을 문단 보존으로 수정. 빈 줄/
  코드펜스 경계에서 멀티라인 수집 중단, 이스케이프 `\$$` 여닫이 제외
- **수식 변환기 가드** — 중괄호 폭탄·`\frac` 체인의 스택 오버플로를 깊이 64
  리터럴 폴백으로, 초장문 입력을 소스 10K 상한으로 차단 (MCP/CLI 비신뢰 입력)
- **왕복 비대칭** — `\pm`/`\cdot`/`\ast`/`\leftarrow`가 재파싱 불가 토큰으로
  나가던 것 수정(읽기 맵에 `+-`·`cdot` 추가 포함), `RIGHT )` 공백 접합 제거,
  `\left\{` 백슬래시 잔재 수정, 첨자 예약어를 토큰맵에서 도출해 따옴표 누수
  해소(읽기 쪽 `"…"` → `\text{…}` 언쿼트 동반)
- **공문 모드** — 항목 사이에 낀 수식이 번호 run을 끊어 번호가 리셋/소멸하던
  것 수정 (표와 동일한 run 연속 예외)

### Bench

- roundtrip: equation·law(법령 줄 무결성) fixture + `equationErrors`/`lineErrors`
  게이트 — 코퍼스에 `$$`가 없어 무감이던 수식 클래스·조문 줄바꿈 클래스 고정
- fuzz: `markdownToHwpx` mdgen 60런(crash/hang/slow/genInvalid) 편입

## [3.8.4] - 2026-07-03

### Fixed

- **DOCX 병합표 셀 통유실** — 앵커 셀 밀집 배열을 그리드 인덱스 규약(IRTable.cells)으로
  그대로 넘겨 렌더러의 skip-walk가 gridSpan 뒤 셀을 통째 버리던 버그. 공용
  buildTable(colAddr/rowAddr 직접 배치)로 교체. val 없는 `<w:vMerge/>`(계속 셀)를
  일반 셀로 오독해 세로 병합이 아예 동작하지 않던 것도 수정 — 신고서류 병합표 회수율
  0.675 → **1.0**.
- **DOCX 텍스트박스 전체 유실** — `w:txbxContent`를 읽지 않아 KS표준안류 문서의
  텍스트박스 수백 개가 통째로 빠지던 버그. 앵커 문단 뒤 별도 블록으로 수집
  (mc:Fallback 서브트리는 Choice 이중 렌더라 스킵) — 회수율 0.917 → **0.9985**.
- **개인정보 마스킹 별표가 마크다운 문법으로 오독** — `******`(마스킹 런)이 수평선으로,
  `홍**`·`010-****-1234`가 볼드/강조로 소비되던 문제. 모든 포맷의 마크다운 출력에서
  `*`를 `\*`로 이스케이프 (본문·표 셀 공통). 별표 각주 마커(`* 단, …`)가 리스트로
  오인되던 것도 함께 해소.
- **md→HWPX 재변환(라운드트립) 충실도** — 3종 수술로 왕복 텍스트 보존율 0.947 → **0.9996**:
  - 헤딩(`#`~`######`)이 재파싱에서 일반 문단으로 죽던 것 → 생성 paraPr에 개요(OUTLINE)
    정보를 심어 보존 (한컴 문서 찾아가기에도 개요로 표시, 번호 서식은 비워 화면 무변화)
  - 순서 리스트가 `2. 3. 4.`로 시작해도 `1.`부터 재부여되던 것 → 원본 번호·구분자 보존
    (`-`→`·` 기호 변형도 폐지)
  - 이스케이프된 마크다운(`\*` 등)의 백슬래시가 문서 본문에 박히거나 별표가 강조로
    소비되던 것 → 센티널 마스킹 후 리터럴 복원
- **HWPX 개요 번호 발명** — 번호 서식이 명시적으로 빈 개요/자동번호 문단(한컴 "번호
  없음")에 파서가 `1.` 접두를 만들어 붙이던 버그. 정의 자체가 없는 레벨의 폴백은 유지.

### Changed

- 검증 인프라(내부): 라운드트립 헤딩 무결성 게이트 신설 + 텍스트 플로어 0.945→0.999
  상향, PDF 표 구조 GT 트랙에 2단 조판 순서 예외 구제(매칭 81.9→84.7%·exact 51.4→54.2%)
  + 무후퇴 플로어를 걸어 bench:gate 체인 편입.

## [3.8.3] - 2026-07-03

### Fixed

- **2단 조판 본문(속기록류)을 표·컬럼으로 오인** — 문단 끝 짧은 줄 쌍이 표 머리글로
  오인돼 2단 본문 전체가 2열 표로 흡수되고 좌우 단이 뒤섞이던 버그. 줄-투표 기반
  중앙 빈 띠 판별(`findTwoColumnProseCutX`)로 표를 강등하고 단 분리 읽기 순서를
  복원. 전폭 목차 줄이 XY-Cut을 막는 페이지는 컷 x로 좌/우/전폭 직접 분리.
  (코퍼스 8,411페이지 전수에서 발화는 속기록 1건 — 타 문서 출력 바이트 동일)
- **손상 PDF 파싱 시간 폭주(DoS) 가드** — 오염된 좌표(±Infinity·1e9)가 2단 판별
  격자 스캔을 페이지당 수십억 회로 폭주시켜 파싱이 144.8초 걸리던 것을 2.3초로.
  비유한 좌표 즉시 반환 + 스캔 후보 상한 400. (퍼즈 스윕으로 발굴, 정상 코퍼스
  hash-sweep 바이트 동일)
- **한셀(HCell) 저장 XLSX 파싱 실패** — 한셀은 spreadsheetml 요소를 `x:` 접두사로
  선언(`<x:sheet>`)하는데 요소 조회가 정규화 이름만 매칭해 "시트가 없습니다"로
  실패하던 것 수정 (네임스페이스 폴백 추가).
- **HML(HWPML) 문단 앵커 표 통째 소실** — 표가 `<P>` 안에 앵커된 문서에서 표
  전체가 빠지고, 셀 안 중첩표는 "[중첩 테이블]" 마커로 내용이 사라지던 버그.
  해수부 공고 실코퍼스 9건 recall 0.231 → 0.996.

### Changed

- 검증 인프라 4종 신설(내부) — 생성 라운드트립(md→hwpx→재파싱 커버리지), 퍼즈
  스윕(절단·비트플립 183파일×4변형 732런 전부 통과), HWP↔HWPX 동일문서 쌍
  게이트(유사도 0.9946), 포맷 트랙(DOCX/XLSX/HML 자기참조 recall).
  `npm run bench:gate`로 일괄 실행.
- HWPX 표 채점 cellExact·contentNED **1.0 도달** — 셀 자동부호(한컴 화면 렌더
  동일) 채점 비대칭 해소 후 게이트 상향 잠금.

## [3.8.2] - 2026-07-03

### Fixed

- **PDF 선 추출 CTM 추적** — 콘텐츠 스트림이 축소/플립 변환을 깔면([0.75,0,0,-0.75,0,H],
  성과계획서류) 괘선 좌표가 텍스트와 다른 좌표계에 놓여 그리드-텍스트 매핑이 전멸,
  괘선 표가 선 없는 표 경로로 떨어져 2줄 셀("측정산식/또는 측정방법")이 행으로
  쪼개지던 버그. 이제 rowspan 병합 셀로 정상 복원. (항등 CTM 문서는 출력 무변화)
- **pdfjs CID 폰트 자산(cmaps/standard_fonts) 경로 지정** — 미지정이면 CMap 필요
  폰트의 텍스트가 통째로 소실됐다. 스캔본으로 오판정되던 66페이지 의사록에서
  임베디드 텍스트층 129KB 전문 추출 복구 (pdftotext도 못 읽는 문서).

### Changed

- **hwpx/generator.ts 1,068줄 → 7모듈 분리 (내부, 공개 API 무변경)** — 생성물
  ZIP 내부 엔트리 sha256 전/후 동일 검증(`bench/gen-sweep.mjs` 신설).
- PDF 정확도 벤치: 실코퍼스 42건 coverage 0.99591, 전건 정식 채점(OCR 격리 0).

## [3.8.1] - 2026-07-03

### Fixed

- **PDF 회전 텍스트(90°/270°) hidden 오분류** — 사이드탭 챕터 인덱스·세로로 눕힌 표
  (계속비 총괄표 등)가 숨김텍스트 필터(prompt injection 방어)에 걸려 통째로 빠지던
  버그. 회전 행렬 `[0,s,-s,0]`에서 대각 성분만 보던 fontSize 계산을 변환행렬
  열벡터 노름으로 교체. 진짜 0 스케일 숨김텍스트 방어는 그대로 유지.
  (실코퍼스 기준 문서당 최대 3,000개 텍스트 아이템 복구)

### Changed

- **대형 파일 모듈 분리 (내부, 공개 API 무변경)** — `pdf/line-detector.ts`(1,247줄)
  → 7모듈, `hwpx/parser.ts`(1,619줄) → 8모듈. 기존 import 경로는 재수출 허브로
  전부 유지. 실파일 87건 markdown+blocks sha256 전/후 동일 검증(`bench/hash-sweep.mjs`).
- **PDF 정확도 벤치 참조 채점 대칭화** (`bench/`) — 목차 리더 점선 런 붕괴,
  페이지 가장자리 반복 러닝헤더 제거(파서 규칙과 대칭), 참조 trigram 줄 단위 계산
  (줄 경계 gram은 추출기 순회 순서라 배제). 실코퍼스 42건 coverage 게이트
  0.985 PASS (0.99471).

## [3.8.0] - 2026-07-02

### Added

- **HWP 5.x 빈 셀/빈 문단 채우기** (`patchHwp`) — 원본에서 비어 있던 표 셀에
  편집 마크다운으로 값을 넣으면 이제 HWP 바이너리에 삽입된다.
  - `splitParaText`: 일반 텍스트가 없는 문단(빈/개체만)도 전 토큰이 비가시면
    빈 코어로 분해 — 새 텍스트가 [선두 개체 뒤, 문단끝 앞]에 들어간다. 탭 등
    가시 control이 있는 문단은 기존대로 건드리지 않음.
  - PARA_TEXT 생략형(텍스트 레코드 자체가 없는 빈 문단)은 레코드를 신규 삽입
    (`SectionScan5.inserts` + `serializeRecords` 확장, nChars 하위비트로 문단끝
    정합). 실측 기준 한컴 빈 문단의 지배형(hwplib 실파일 57/66)이 이 형태.
  - GFM/HTML/1x1 전 경로 지원. 실파일 검증: no-op 12/12 바이트동일,
    비우기→재채움 왕복 무결, rhwp 렌더 육안 확인.
- **공문서 모드: 항목 사이 표가 번호 흐름을 끊지 않음** (`markdownToHwpx`
  gongmun) — "1. 항목 → 근거 표 → 2. 항목"처럼 리스트 사이에 표(GFM/HTML)가
  끼어도 항목부호가 이어진다(공문 관행). 문단이 끼면 기존대로 리셋.
- **성능 벤치 신설** (`bench/perf.mjs`) — 실파일 코퍼스 속도(median/p95·MB/s)·
  no-op 라운드트립 바이트동일·폼 인식 집계. 기준선: hwpx median 7.8ms·11.8MB/s,
  no-op 88/88, 실파일 실패 0.

### Fixed

- **DOCX 무경고 실패 5종 경고화** — 이미지/스타일/번호매기기/각주/메타데이터
  파싱 실패를 조용히 무시하던 것을 `warnings`로 보고 (이미지=`SKIPPED_IMAGE`,
  나머지=`PARTIAL_PARSE`). 파싱은 기존대로 계속되므로 결과는 동일, 실패가
  보이게만 바뀜.

### Performance

- **이미지 대량 참조 메모리 폭발 해소 (HWP5·HWPX 공통)** — 같은 이미지를
  참조하는 개체마다 데이터를 복사·중복 추출하던 것을 참조(BinData storageId /
  HWPX ref)당 1회 변환·버퍼 공유로 전환. 3.7MB 이미지를 도형 12,822개가
  참조하는 실파일(hwplib big_file.hwp)이 **피크 17GB OOM 완주 불가 → 197ms·
  피크 445MB**로 완주. 실패도 캐시해 `SKIPPED_IMAGE` 경고는 참조당 1회만.

## [3.7.0] - 2026-07-02

### Added

- **표 행 추가/삭제** (`patchHwpx`, `src/roundtrip/table-rows.ts`) — 편집 마크다운의
  GFM/HTML 표 행 수가 원본과 달라도 이제 반영된다. 행 정렬(LCS)로 삽입/삭제/수정을
  구분하고, 행 추가는 인접 행 `<hp:tr>`을 복제해 셀 텍스트만 교체(서식·테두리·높이
  승계), 행 삭제는 `<hp:tr>` 제거. `rowCnt`·이후 행 `cellAddr rowAddr`·표 `hp:sz`
  높이를 함께 갱신하고 복제 조각의 `linesegarray`는 제거한다.
  - **보수적 게이트** (전부 통과해야 수행, 실패 시 표 전체 graceful skip): 세로
    병합(rowSpan)이 변경 지점을 가로지르면 미지원, 삭제/서식기준 행에 개체(중첩표·
    이미지·수식·필드) 포함 시 미지원, 셀 주소 표기 혼재 미지원, 편집 결과가 builder
    렌더에서 변형되면(빈 행 드롭·첫 열 전파) 미지원.
  - 실문서 검증: 결재문서 코퍼스 45건 행 추가 스윕 — GFM 6/9·HTML 34/45 클린 적용
    (재파싱 잔차 0), 나머지는 사유와 함께 skip, 손상·예외 0. rhwp 렌더 육안 확인.
- **채우기 두 경로 정합** (`fillFormFields` ↔ `fillHwpx`) — IR 경로의 병합 라벨셀
  값 유실(silent) 수정: 라벨이 colSpan≥2면 값이 병합 플레이스홀더에 쓰여 렌더에서
  사라지던 것을 hwpx 경로처럼 "라벨 span 뒤 같은 행의 실제 다음 셀"에 쓰도록 교정.
  셀 안 중첩표 라벨도 재귀 채우기(depth 16, hwpx 경로와 동일). 전략2(명부형)의
  병합 커버 칸 값 소진 차단. 두 경로 filled/unmatched 동등성 테스트 신설.
- **라벨 인식 확장** (`isLabelCell`) — 숫자 낀 라벨("연번1"·"제1항목"·"1차소속"),
  9~12자 한글 라벨("제1소위원회위원장"), 콜론 없는 영문 라벨("Name"·"Date of
  Birth", 관행 단어 목록 한정) 인식. 가드: 수량/단위 값("6개월"·"1억원"·"5백만원")·
  서술형 어미("해당없음")·법인명("(주)…")·9자 이상 구간의 3어절 이상 제목성 문구는
  거부. 코퍼스 45건 정량: 380→386 필드(+8 전부 실제 라벨, −2 순수 오탐 제거).
- **`PatchSkip.partial`** — "적용은 됐지만 편집 원형 그대로는 아님"(셀 내 줄 병합,
  이미지 혼재 텍스트만 적용, 줄 삭제 시 빈 문단 잔존)을 완전 미적용 skip과 구분해
  보고. HWPX·HWP5 공통. 셀 줄 삭제 시 빈 문단 잔존 보고 신설(기존 무보고).

### Fixed

- **중첩표 blocks 유실 방지** (`buildTableWithCellMeta`) — cellAddr·텍스트 매칭이
  모두 실패한 셀(동일 텍스트 중복·스팬 불일치)의 중첩표/이미지 blocks가 조용히
  사라지던 것에 서수(tc 순서) 3차 폴백 추가. 소스 tc 수와 격자 앵커 수가 1:1일
  때만 발동(오부착 방지). 코퍼스 45건 markdown 해시 전/후 동일(무회귀).

### Changed

- `alignUnits`(정확 일치 LCS + 갭 유사도 페어링)를 `patcher.ts` →
  `markdown-units.ts`로 이동 (표 행 정렬과 공용, patcher는 re-export 유지).
- 수식+병합 표의 GFM 강등(builder)은 실측 결과 유지 — 코퍼스 표 217개 중 수식
  포함 0건으로 완화 근거 없음. `flattenLayoutTables`의 hwp5-only 호출 정책과
  파서 깊이 상수(hwpx 200=XML 요소 / hwp5 8=표 중첩 / filler 16=표 중첩)의
  좌표계 차이를 주석으로 명문화.

## [3.6.0] - 2026-07-02

### Added

- **함초롬바탕 실측 텍스트 메트릭 + 줄바꿈 시뮬레이션 엔진** (`src/hwpx/text-metrics.ts`) —
  한컴 공개 배포 함초롬바탕 정품 TTF의 advance를 전수 추출(한글 음절 11,172자
  균일 0.97em, 숫자 0.55em, 온점·괄호 0.32em, Bold=Regular 폭 동일 확인)해
  HWP 프로그램 없이 줄폭·줄바꿈을 계산한다. 어절(KEEP_WORD)/글자 단위 두 모델 +
  한컴 금칙 처리(줄머리 금지 문자 밀어내기, 여는 괄호 줄끝 금지) 구현.
  - **실측 검증**: `bench/verify-linebreak.mjs` 신설 — 서울 정보소통광장 실제
    결재문서 45건의 `linesegarray`(한컴 계열 조판기가 계산한 줄 시작 오프셋)를
    정답지로 대조, 정밀 폭 버킷(고정폭 글꼴)에서 **줄바꿈점 98% 일치**(56/57).
    이 과정에서 확정: 공백=0.5em 고정(useFontSpace=0), 장평·자간은 공백에도
    적용, 자간=글자폭×(1+sp/100), 시작금칙은 직전 1글자 동반 밀어내기.
  - API: `measureTextWidth`, `simulateWrap`, `fitRatioForFewerLines`, `charWidthEm1000`
- **공문서 문단별 자동 장평(`GongmunOptions.autoFit`, 기본 켜짐)** — 한두 글자
  (짧은 꼬리)만 다음 줄로 넘어가는 문단을 찾아 그 문단만 장평 95→90% 범위에서
  자동 축소해 한 줄에 담는다(공무원 실무 관행의 자동화). 전역 95%로는 못 잡던
  orphan을 문단 단위로 해결 — 필요한 문단에만 변형 charPr을 발급하고 나머지는
  그대로. `autoFit: false`로 끄거나 `{ minRatio }`로 하한 조정.
- **HTML 표(병합·중첩) → HWPX 생성** — `markdownToHwpx`가 kordoc parse 출력
  형식의 `<table>`(colspan/rowspan/중첩 `<table>`)을 구조 보존으로 생성한다.
  그리드 배치(병합 점유 반영 cellAddr/cellSpan) + 셀 안 중첩표 재귀 생성.
  parse → 편집 → markdownToHwpx 라운드트립에서 병합·중첩표가 살아남는다
  (이전엔 HTML 태그가 문단 텍스트로 박혔음).
- **다중값(배열) 채우기 — 2~30장 반복 양식·명부** — `fillHwpx`/`fillFormFields`/
  `fillForm`의 values 값에 `string[]` 허용. 배열이면 같은 라벨의 등장 순서대로
  하나씩 소진(반복 양식), 명부형 표(헤더+데이터 행)는 행마다 다음 값을 채운다.
  소진 후 등장은 채우지 않음. 문자열(스칼라)은 기존과 동일(모든 등장 동일값,
  명부는 첫 행만). CLI `fill`의 JSON values는 배열이 자연 투과.

### Fixed

- **fillHwpx·HwpxSession이 linesegarray를 제거하지 않던 문제** — 텍스트를 바꾸고
  줄 레이아웃 캐시를 그대로 둬, 채운 문서를 한컴에서 열면 변조 경고가 뜨거나
  옛 줄배치로 렌더될 수 있었다(줄바꿈 틀어짐). patchHwpx(v3.2.1)와 동일하게
  수정된 섹션의 linesegarray를 전부 비운다 — 뷰어가 열 때 재계산. 무변경 문서는
  기존대로 바이트 동일.
- **생성 표 테두리가 뷰어에서 안 보이던 문제** — `borderFill` id를 0부터 매겨
  1-based로 해석하는 뷰어(rhwp 등 한컴 규약 구현체)에서 셀의 테두리 참조가
  무테두리 fill로 풀렸다. 실제 한컴 산출 파일 규약대로 1-based(1=무테두리,
  2=SOLID)로 재번호하고 `centerLine` 속성을 불리언("0")에서 enum("NONE")으로
  수정. `<hh:fillInfo/>`(비표준)·불필요한 diagonal 요소 제거.
- **공문서 항목 내어쓰기 폭 실측화** — `markerWidth`를 문자 부류 근사(괄호
  0.45em, 숫자 0.5em, 온점 0.25em)에서 함초롬바탕 실제 advance(0.32/0.55/0.32em)
  기반으로 교체. `(1)` 마커 기준 내어쓰기 오차 약 0.2글자 제거 — 둘째 줄이
  첫 줄 내용 첫 글자에 정확히 정렬된다.

### Changed

- `bench/collect-opengov.mjs` — 2026-07 정보소통광장 개편 대응(다운로드 링크에서
  `dname=` 제거, 파일명이 `title-down` 요소로 이동). 첨부 `<li>` 블록 단위
  (파일명, 원문 링크) 추출로 재작성 + 제목 포함/제외 정규식 필터 인자 추가.
- `tests/roundtrip-e2e.test.ts` 코퍼스 디렉토리에 `review` 추가.

## [3.5.4] - 2026-06-30

### Fixed

- **공문서 항목 둘째 줄 내어쓰기 정렬** — 여러 줄 항목에서 둘째 줄이 첫 줄 내용
  첫 글자보다 더 들여써지던 문제 수정. 내어쓰기(`intent`)를 고정값(3타=2250)이
  아니라 **단계 대표 부호의 실제 렌더폭**으로 산출한다. 부호마다 폭이 달라
  (`1.`은 좁고 `가.`는 한글이라 넓음) 고정값으로는 양쪽을 동시에 맞출 수 없었다.
  실제 한컴 공문서(서울 정보소통광장 결재문서)를 디코드해 `|intent|`가 부호의
  실제 폭과 같을 때 둘째 줄이 첫 줄 내용에 정렬됨을 확인.
  - `markerWidth(marker, bodyHeight)` 추가 — 전각(한글·원문자·도형부호)=bodyHeight,
    반각(숫자·영문)=절반, 온점/쉼표·괄호는 더 좁게 + 부호·내용 1타 간격.
  - `levelIndent`의 `intent`를 `-markerWidth(대표 부호)`로. 단계별 실측 폭:
    `1.`=−1875, `가.`=−2625, `1)`=−2175, `(1)`=−2850, `①`=−2250 (15pt 기준).
  - `standard`·`report` 두 numbering 모두 적용. `left`(누적 깊이)는 변경 없음.

## [3.5.3] - 2026-06-30

### Improved

- **공문서 모드 한글 줄나눔·자간 정밀화** — 실제 공문서 XML과 동일하게 맞춤:
  - **어절 단위 줄나눔** — 공문서 paraPr의 `breakNonLatinWord`를 `KEEP_WORD`로,
    `snapToGrid`를 `0`으로(`keepWord` 옵션 추가). 한글이 단어(어절) 중간에서
    끊기지 않는다. 격자 정렬(`snapToGrid=1`)이 켜져 있으면 한컴이 어절을 깨므로
    반드시 함께 꺼야 한다.
  - **본문 장평 95%** — `charPr`에 `ratioPct` 옵션 추가, 공문서 본문(`charPr` 0~3)
    한글·라틴 장평을 95%로. 한두 글자만 다음 줄로 넘어가는 orphan을 줄인다.
  - **레이아웃 호환성** — `<hh:compatibleDocument>`에 `<hh:layoutCompatibility/>`
    추가(실제 공문서와 동일 구조).
- 비공문서(일반 md→hwpx) 경로는 기존 baseline 그대로(장평 100·`BREAK_WORD`·
  `snapToGrid=1`) 유지 — `gongmun`/`keepWord` 가드.

> 참고: `KEEP_WORD`는 표준 OWPML 속성이나 **한컴 macOS 뷰어는 이를 무시**하고
> 글자 단위로 렌더하는 한계가 있다(한컴 Windows·최신 한글에선 어절 단위로 표시).
> PDF 출력은 영향 없이 어절 단위로 정상.

## [3.5.2] - 2026-06-29

### Improved

- **공문서 보고서 모드(`□ ○ -`) 서식 정밀화** — 정부 보도자료 붙임 등 실제
  표준 보고서 양식에 맞춰 두 가지 보강(`report` numbering 한정, `standard`
  `1. 가.` 모드는 영향 없음):
  - **1단계 `□` 대제목 자동 굵게** — `list_item` 렌더에서 `depth===0`이면
    `CHAR_BOLD` 적용. 정부 보고서의 □ 대제목 관행.
  - **`□` 섹션 위 단락 간격** — `GONGMUN_LIST_BASE+0` paraPr에
    `spaceBefore = bodyHeight × 0.5` 추가로 섹션 구분.
- 괄호 라벨 굵게(`**(일시)**` → `(일시)`만 bold)는 기존 인라인 span 처리로 이미
  동작(별도 변경 없음). 한컴 실오픈으로 정답지 양식 일치 확인.

## [3.5.0] - 2026-06-23

### Added

- **문단 → 표 인플레이스 변환** (`patchHwpx`) — 기존 한글파일(HWPX) 안의 한 문단을
  편집 마크다운에서 GFM 표(`| … |`)로 바꾸면, 원본 `<hp:p>`를 그 자리에서 표로
  치환한다. 셀 테두리용 `borderFill`을 `header.xml`에 1회 append(기존 리소스는
  무손실)하고 표 `instId`는 문서 전역 max+1로 발급해 충돌을 피한다. 나머지 문단·표·
  서식은 1바이트도 건드리지 않으며, 패치 후 재파싱 무손실 검증을 통과한다.
  CLI `kordoc patch`·MCP `patch_document`가 자동 상속. (HWP5 바이너리는 표 레코드
  트리+DocInfo 삽입이 무손실 게이트와 충돌하여 미지원 — 대안 안내 후 graceful skip)
- **MCP `generate_document` 도구** — 마크다운(표 포함)을 HWPX로 생성. 라이브러리
  `markdownToHwpx`를 MCP에 노출해, AI 에이전트가 평문을 표로 구조화하거나 parse한
  내용을 편집해 다시 한글파일로 출력할 수 있다. 공문서 프리셋(`보고서`·`기안문` 등)·
  글꼴·글자크기 옵션 지원.

### Fixed

- **공문서 모드 한글 프리셋 크래시** — `markdownToHwpx(md, { gongmun: { preset: "보고서" } })`
  처럼 라이브러리/MCP에서 한글 프리셋명을 직접 넘기면 `PRESET_DEFAULTS[preset]`가
  `undefined`라 `Cannot read properties of undefined (reading 'bodyPt')`로 터졌다
  (README 예시가 그대로 크래시). `resolveGongmun`에 `normalizeGongmunPreset`을 추가해
  한글 별칭→영문 키 정규화 + 미상 시 `official` fallback. CLI의 중복 별칭맵은 공용
  `PRESET_ALIAS`로 통합.

## [3.4.1] - 2026-06-22

### Fixed

- **DOCX `w:sdt`(콘텐츠 컨트롤) 안의 텍스트 미추출** — Google Docs 익스포트는 본문을
  거의 전부 `<w:sdt><w:sdtContent>`로 감싸는데(`goog_rdk` 태그), 파서가 직속 자식만
  훑어 sdt 한 겹에 가린 문단·런·표 셀 텍스트를 모두 놓쳤다. `effectiveChildElements`로
  sdt를 투명하게 평탄화 — 블록/인라인/중첩 sdt 모두 처리. (실측: 추출 1,442자→5,451자)
- **병합셀 표에서 폼 필드 인식 크래시** — `extractFormFields`가 표를 직사각형으로 가정해
  `cells[r][c]`를 무가드 인덱싱, colSpan/vMerge로 ragged해진 행에서 `undefined.text`로
  터졌다(`문서 처리 중 오류`로 마스킹됨). `recognize.ts`·`filler.ts` 양쪽에 셀 가드 추가.

## [3.4.0] - 2026-06-21

### Added

- **HWP5 라운드트립 표 패치 — HTML 병합셀 표 지원** (`patchHwp`). rowspan/colspan으로
  병합된 셀과 `<br>` 다중문단 셀의 텍스트 수정. builder의 `tableToHtml` 렌더를 좌표 추적
  버전으로 재현(`replicateTableToHtml` 자기검증 + 셀 경계 되읽기 대칭검증)해 앵커 좌표로
  셀 문단을 치환한다 — 오매핑 시 graceful skip. 중첩표 셀은 미지원(skip).
- **개체 앵커 본문 문단 텍스트 수정** — 도형/이미지가 문단 선두에 `0x0b`로 앵커된 본문
  (정부 보도자료 다수)을 지원. `PARA_TEXT`를 [선두 비가시 control][순수 텍스트 코어]
  [말미 control/문단끝]로 분해해 control 바이트를 보존하고 코어만 교체.
- **복수 문단 셀 부분 수정** — GFM `<br>` 분할로 셀 내 각 문단을 1:1 매핑, 변경된 문단만 치환.

### Fixed

- **표 개수 불일치로 표 셀 수정이 전부 막히던 문제** — `flattenLayoutTables`가 레이아웃
  표를 문단으로 해체하면 IR 표 서수와 바이너리 표 서수가 어긋나 단순 서수 인덱싱이 밀려
  엉뚱한 표가 수정될 위험이 있었다(게이트가 해당 문서의 모든 표 수정을 차단). 문서 순서를
  보존한 rows×cols 시그니처 매칭 + 셀내용 디스앰비규에이션으로 교체해 정확한 표에 매핑한다.
- **`nChars`/`CHAR_SHAPE`/`LINE_SEG` 정합** — 개체·필드 등 inline control의 확장 WCHAR를
  `nChars`(=PARA_TEXT WCHAR 총수)에 반영하고, `LINE_SEG`(줄 레이아웃 캐시)는 원본 유지
  (단일화 시 여러 줄이 한 줄에 겹쳐 박힘). 한컴오피스 변조감지 경고 없이 정상 렌더.

## [3.3.0] - 2026-06-20

### Added

- **MCP 도구 `patch_document`** — 원본 HWPX/HWP의 서식(글꼴·표·도장칸·이미지)을
  보존한 채 편집된 마크다운의 바뀐 텍스트만 제자리 치환해 새 문서로 출력.
  `parse_document` → (마크다운 편집) → `patch_document`의 라운드트립을 Claude/Cursor
  등 MCP 클라이언트에서 바로 사용 가능. 포맷 자동 감지로 HWPX는 `patchHwpx`,
  HWP 5.x는 `patchHwp` 경로를 탄다. 무손실 검증 결과와 미적용 항목을 함께 보고.
  (`src/mcp.ts`)

## [3.2.1] - 2026-06-20

### Fixed

- **patchHwpx 변조 경고 제거** — 패치한 HWPX를 한컴 한글로 열면 "문서가
  손상되었거나 변조되었을 가능성이 있습니다 / [문서 보안 설정]을 [낮음]으로"
  경고가 뜨던 문제. 원인은 텍스트(`hp:t`)만 치환하고 문단 줄 레이아웃 캐시인
  `<hp:linesegarray>`를 그대로 둬 텍스트와 어긋난 것. 텍스트가 바뀐 섹션의
  `linesegarray`를 전부 제거해(선택 요소 — 뷰어가 열 때 재계산) 한글이 변조로
  감지하지 않도록 수정. 일부만 제거하면 한글의 문서 전체 정합성 검사에서
  여전히 경고가 발생하므로 섹션 단위로 비운다.
  (`src/roundtrip/source-map.ts` `allLinesegRemovalSplices`, `patcher.ts`)

## [3.2.0] - 2026-06-19

### Added

- **공문서 모드(`markdownToHwpx(md, { gongmun })`)** — 마크다운을 한국 행정
  공문서 표준 서식의 HWPX로 렌더링. 행정안전부 「행정업무운영편람」·시행규칙 근거.
  - **항목부호 8단계 자동화**: 중첩 리스트 깊이 → `1. 가. 1) 가) (1) (가) ① ㉮`
    (마크다운 마커 종류 무시, 깊이로 강제). 가나다 소진 시 단모음 연속(거·너·더),
    5·6단계 괄호 3글자, 7·8단계 단일 유니코드. 상위 항목 진행 시 하위 카운터 리셋.
  - **둘째 줄 내어쓰기 정렬(hanging indent)**: 단계별 `paraPr left`+음수 `indent`로
    부호는 좌측, 둘째 줄부터 내용 첫 글자에 정렬. 1타 = bodyHeight/2 HWPUNIT 동적 환산.
  - **단일 형제 부호 생략**(2-pass): 같은 단계 항목이 하나뿐이면 부호 미부여(법정).
    불릿(report)에는 미적용.
  - **공식 여백**: 위 20 / 아래 10 / 좌 20 / 우 20mm, 머리말·꼬리말 0(편람 서식기준).
    (기존 비표준 위30 등은 공문서 모드에서만 교체, 기본 동작은 보존.)
  - **본문 15pt 명조(함초롬바탕)** 기본 + 맑은 고딕(`bodyFont: 'gothic'`) 옵션,
    줄간격·글자크기 프리셋/옵션화.
  - **문서종류 프리셋**: `official`(기안문)·`report`(보고서, □○-ㆍ 불릿)·`plan`·
    `notice`·`minutes`.
  - **가운데 정렬**: `<center>…</center>` → 행정기관명·발신명의용 가운데 단락.
- **CLI `kordoc generate <md>`** (별칭 `gen`) — 마크다운 파일/stdin → 공문서 HWPX.
  `--preset 기안문|보고서|계획서|통지|회의록`(한글·영문 별칭), `--font`, `--pt`,
  `--line-spacing`, `--plain`(범용 변환) 지원.
- **공문서 작성 스킬** `.claude/skills/gongmunseo/` — 내용→공문서 HWPX 오케스트레이터
  (SKILL.md + 표준 레퍼런스 + 종류별 템플릿 5종).
- **표준 레퍼런스 문서** `docs/gongmunseo-reference.md`(공문서 서식 SSOT),
  `docs/gongmunseo-engine-spec.md`(구현 매핑 스펙).

## [3.1.1] - 2026-06-13

### Fixed

- **문단 통째 교체 시 원본 들여쓰기(선행/후행 공백) 소실** — IR 텍스트는
  sanitize로 양끝 공백이 제거된 상태라 `buildParagraphSplices`가 통째 교체할
  때 원본 `<hp:t>`의 선행 공백(들여쓰기)이 사라졌다. 클릭-편집 후 해당 줄만
  왼쪽으로 튀어나오는 정렬 회귀. 원본 t-도메인 텍스트에서 양끝 공백을 복원해
  새 텍스트에 입힌다 — `HwpxSession.patchBlocks` / `patchHwpx` / `fillHwpx` /
  표 셀 공통 경로 적용, n회 증분 ≡ 일괄 패치 동등성 유지. (#35)

## [3.1.0] - 2026-06-12 — 에디터 통합 API (KorDoc Studio Phase A)

> 에디터(KorDoc Studio)가 블록 클릭-편집으로 HWPX를 증분 수정할 수 있도록
> 세션 기반 패치 API를 신설. "n회 연속 `patchBlocks` ≡ 일괄 `patchHwpx`"
> 바이트 동일 동등성을 CI 게이트로 보장한다. 적대적 리뷰(26 에이전트) 확정
> 22건 전부 수정 완료. 테스트 458 → **491**.

### Added

- **🖊️ `HwpxSession` — 블록 단위 증분 패치 세션** (`openHwpxDocument(bytes)`)
  - `session.patchBlocks(edits)` — 블록 인덱스로 직접 편집 지정 (`BlockEdit`:
    문단 `newText` / 표 `cells[{row,col,text}]`). 매핑은 patchHwpx와 동일
    알고리즘(정규화 텍스트 버킷 + 표 서수) 재사용 — **n회 증분 ≡ 일괄 패치
    바이트 동일** 동등성이 성립하며 CI 게이트로 검증. 패치 후 상태는 새
    바이트에서 전체 재구축(블록 인덱스는 매 호출 후 갱신 필요).
  - `session.capability(blockIndex)` — patchHwpx의 graceful-skip 게이트를
    **사전 판정**으로 노출 (`text` / `cell-text` / `locked` + 셀별 가능 여부
    + 한국어 사유). 에디터가 편집 전에 잠금 UI를 띄우는 단일 진실 소스.
  - `session.sourceRef(blockIndex)` — 블록 → 원본 섹션 XML 오프셋 참조
    (에디터 하이라이트/점프용).
  - 단발성 헬퍼 `patchHwpxBlocks(bytes, edits)` — 세션 없이 1회 패치.
- **📋 `extractFormSchema(blocks)` — 양식 필드 타입 추론** (폼 UI 자동 생성용)
  - 필드 타입 7종: `text` / `date` / `phone` / `email` / `amount` /
    `checkbox` / `idnum`. 기존 값 패턴 우선, 라벨 키워드 폴백
    (`inferFieldType`도 단독 export).
  - `required`(라벨의 ※·\*·★·"(필수)" 표시) / `empty`(빈 값·밑줄·괄호
    플레이스홀더 = 채움 대상) 판정.
  - 값이 빈 인라인 라벨("작성일자:")도 채움 대상 필드로 노출 —
    `extractFormFields`는 기존 계약(값 있는 필드만) 유지.
- **소스맵 저수준 API export** — `scanSectionXml` / `buildParagraphSplices` /
  `buildRangeSplices` / `applySplices`. 블록↔원본 바인딩을 직접 다루는 고급
  사용자용. `buildRangeSplices`는 **t-도메인 좌표계**(`hp:t` 연결 텍스트) —
  탭/줄바꿈 요소가 끼어도 해당 요소를 건드리지 않고 텍스트만 정밀 치환.
- **`PatchResult.changes`** — `session.patchBlocks` 전용 패치 전→후 diff
  (적용 편집 수만큼 modified가 나오는 게 정상). 무손실 검증용
  `verification`(잔차 0이어야 정상)과 의미가 정반대라 필드 분리.

### Changed

- **`fillHwpx` splice 전환** — 기존 run 단위 XML 문자열 치환에서 소스맵
  splice 기반으로 전면 재작성. 수정된 텍스트 범위 외 섹션 XML은 **원본
  바이트 그대로 보존**(서식·구조 무손상 보장 강화). 매칭 전략·결과 의미는
  v3.0과 패리티 유지.

### Fixed

- **인라인 다중 라벨 오인식/데이터 소실** — "자문위원 성명: 작성일자:" 같이 한
  줄에 라벨이 여러 개인 양식에서 첫 라벨의 값이 다음 라벨까지 삼키던 문제
  (인식: 성명="작성일자:" 오페어링, 채우기: "작성일자:" 라벨이 값으로
  덮여 소실). 신설 `scanInlineSegments`가 값을 다음 라벨 직전에서 끊으며,
  한 문단의 라벨 여러 개를 모두 채운다 (기존 "문단당 첫 매칭만" 제한 해제).
  URL 스킴(`http://`) 콜론은 라벨로 보지 않음. `extractFormFields` /
  `fillHwpx` / `fillFormFields` 3개 경로 일관 적용.
- **CJS 빌드 `import.meta` 잔존** — ESM 전용 `import.meta.url`이 CJS 출력에
  그대로 남아 `require("kordoc")` 시 SyntaxError 나던 버그 (tsup `shims` 활성화).
- **적대적 리뷰 22건 수정** (26-에이전트 멀티에이전트 리뷰, 근본원인 14개):
  - major: 전각공백 silent drop으로 증분≡일괄 동등성 위반, 머리말 영역 양식
    채우기 회귀, 탭 포함 문단 전체 재작성 시 탭 중복/순서 오염, 글상자 라벨
    오염, 셀 이미지 토큰이 리터럴 텍스트로 기록, 빈 문자열 비우기 시 블록
    핸들 소실(→ 비우기 자체를 미지원으로 확정), verification 의미 충돌(→
    `changes` 필드 분리).
  - minor: patchBlocks 재진입 직렬화, ArrayBuffer 뷰 입력 시 원본 오염,
    매핑 dedup 슬롯 충돌, `matchedLabels` 회수 누락, amount 타입 오탐
    (우편번호/연도) 등.

### 의도된 제약 (설계 결정)

- 빈 문자열로 블록 비우기 미지원 — 재파싱 시 블록 핸들이 사라져 세션 복구
  불가, patchHwpx의 "블록 삭제 미지원"과 정합.
- 인셀 패턴 채우기(전략 0)는 문단 단위 매칭 — 문단 경계에 걸친 패턴 미지원.

## [3.0.1] - 2026-06-11 — HWP 5.x 바이너리 서식 보존 패치 `patchHwp`

### Added

- **🔧 `patchHwp(original, editedMarkdown)`** — `patchHwpx`의 HWP 5.x 대응.
  OLE2 바이너리를 직접 수술해 변경된 문단/표 셀의 PARA_TEXT만 치환한다.
  - `src/roundtrip/hwp5-patch.ts` — 레코드 스캔(재직렬화 동일성 게이트) +
    문단/GFM 셀(좌표 기반)/1x1·1열 텍스트청크 표 패치 + PARA_HEADER nChars·
    CHAR_SHAPE·LINE_SEG 연쇄 갱신. `ctrlMask=0` 순수 텍스트 문단만 수정,
    위험 케이스는 전부 graceful skip. 암호화/배포용/DRM 문서는 거부.
  - `src/roundtrip/ole-surgeon.ts` — CFB 섹터 레벨 스트림 교체. 전체 재조립
    없이 대상 스트림의 데이터 섹터/FAT·miniFAT 체인/디렉토리 start·size만
    갱신 (전체 재조립은 한/글 OLE 파서가 거부). mini↔regular 도메인 전환,
    FAT/DIFAT 확장 지원. 수정 외 영역은 원본과 바이트 동일.
  - CLI `patch` 커맨드가 매직바이트로 hwp/hwpx 자동 분기.
  - 실파일 검증: 한/글 오픈 확인, no-op 패치 = 바이트 동일, 비수정 스트림
    바이트 보존, 이모지/특수문자/극단 길이/19KB 확장 통과.

### Changed

- npm 배포를 로컬 publish로 일원화 (`.github/workflows/publish.yml` 제거).

## [3.0.0] - 2026-06-11 — "99.9% 정확도" 파서 대도약 + 서식 보존 무손실 라운드트립

> 실측 코퍼스(한국 공문서 324건 — 정부 보도자료·서울시 결재문서·2014~2016 옛 문서) 기반
> 자기참조 채점 인프라를 구축하고, 정확도 게이트 전체 PASS 상태로 릴리스.
> Breaking은 `IRCell.blocks` 추가뿐이며 기존 `IRCell.text`는 그대로 유지된다(하위호환).
> 실질적으론 minor에 가깝지만 정확도 대도약과 라운드트립 신기능을 기념해 major로 올린다.

### 정확도 (v2.9.1 → v3.0.0, bench/score.mjs 게이트)

| 지표 | v2.9.1 | v3.0.0 |
|------|--------|--------|
| HWPX 텍스트 재현율 (micro) | 99.699% | **99.998%** |
| HWPX 표 구조 정확일치 | 99.875% | **100%** (1,421표, 중첩표 343 포함) |
| 환각률 (phantom) | 0.019% | **0.006%** |
| PDF consensus coverage | 97.013% | **99.16%** |
| HWP5↔HWPX 쌍 유사도 | (비공식) | **99.94%** (정식 게이트 승격) |
| 테스트 | 329 | **458** |

### Added

- **🔄 서식 보존 무손실 라운드트립 `patchHwpx(original, editedMarkdown)`** — `parse()`로 얻은
  마크다운을 편집해 넘기면 원본 HWPX의 ZIP/XML 구조를 그대로 두고 변경된 문단/셀의
  `hp:t` 텍스트만 in-place 치환한다. 스타일·이미지·표 구조·설정은 1바이트도 변경 없음
  (section XML 외 ZIP 엔트리는 원본 바이트 그대로, 변경 문단도 run 구조·charPr 보존).
  지원: 문단/헤딩 텍스트 수정, 표 셀 텍스트 수정(GFM·HTML·1x1·1열 표, 중첩표 셀 재귀).
  미지원 편집(블록 추가/삭제, 표 구조 변경, 줄바꿈 분절 문단 등)은 데이터를 건드리지
  않고 `skipped[]`에 사유와 함께 정직하게 보고. 패치 후 자동 재파싱 검증(`verification`).
  실코퍼스 e2e: 무변경 패치 = 바이트 동일(전수), 문단 수정 128건 무손상.
- **🧪 정확도 채점 인프라 `bench/`** — 자기참조 XML GT 채점기(score.mjs) + 14종 게이트
  (recall/phantom/표 구조/셀 내용/순서/수식·각주 presence/머리말 정책) + PDF consensus
  coverage + HWP5↔HWPX 쌍 트랙. 코퍼스 수집기 2종(korea.kr RSS / 서울 정보소통광장,
  출력 디렉토리·날짜 필터 파라미터화). 베이스라인 박제: `bench/out/score-baseline-v3.0.0.json`.
- **🖼️ HWP5 BinData 이미지 추출** — BIN 16진 스토리지 + PICTURE ctrl offset 해석 (0건 → 90건).
- **📑 중첩표 구조 보존** — `IRCell.blocks`로 셀 안 표/문단을 IRBlock 트리로 표현,
  HTML 표 렌더에서 재귀 출력 (3중 중첩 포함 343표 정확일치).
- **🔤 한컴 PUA 매핑** (`src/shared/pua.ts`) — 사용자 영역 글머리표·기호를 표준 유니코드로
  (rhwp 검증 테이블).
- **HWPX 파서**: 머리말/꼬리말/각주/미주 ctrl 선별 순회, 하이퍼링크 URL(fieldBegin),
  표 캡션, 자동번호 7수준 카운터, 글상자+이미지 병행, outline 헤딩, 변경추적/메모 차단,
  글상자 안 표 재귀, `<hp:lineBreak/>` 줄바꿈 인식.
- **HWP5 파서**: ctrl_id u32 LE 정규화(각주/하이퍼링크 dead-code 해소), 캡션/셀 구분,
  중첩표 level 재귀, NUMBERING/BULLET 카운터, 머리말/꼬리말, FIELD_BEGIN/END 스택(%hlk),
  STYLE off-by-one 수정.
- **PDF 파서**: XY-Cut++ 읽기 순서 3종, 페이지 걸친 표 병합, 과소분할 표 재구성, 캡션,
  한국어 리스트, 취소선, fontSize 비례 공백 복원, NEEDS_OCR 경고 정식화.

### Fixed

- **GFM 표 마지막 라벨 행 소실** — "첫 열만 값인 행 → 다음 행 전파" 휴리스틱이 표 끝이나
  전파 불가 상황에서 행을 통째로 버리던 문제. 보류 행을 그대로 출력하도록 수정.
- **PDF 첨자(각주 마커 ①·\*) 표 오탐** — 별도 행으로 분리된 첨자가 표로 재구성되던 문제
  (mergeOverlappingRows/mergeSuperscriptLines).
- **라운드트립 적대적 리뷰 24건 수정** (31-에이전트 멀티에이전트 리뷰, 전건 실행 repro 검증):
  - critical: 각주 문단의 body 오분류로 본문 편집이 각주를 덮어쓰는 문제, 대형 문서(4M+
    유닛 곱) 정렬 폴백의 전체 시프트 오적용, HTML 셀 안 리터럴 `</td>`로 인한 셀 경계
    오인, ZIP Buffer 입력 시 호출자 원본 버퍼 in-place 오염(Node `Buffer.slice`는 view).
  - major: 셀 안 글상자 문단의 본문 오염, 유사 문단 그리디 오페어링, 자동번호 접두
    오발동, 문단 분절(강제 줄바꿈/[별표] 병합/문단 내 표) silent 손상 → graceful skip,
    sanitize 도메인 불일치로 미편집 문단 재작성(run 서식 파괴), 1x1 표 `**` 무조건
    벗김, 싱글쿼트 manifest 미해석, applySplices 예외의 계약 위반 전파.
  - minor: EOCD comment 가짜 시그니처/trailing 정크, 펼친 `<hp:cellAddr>`, 리터럴
    `<br>` 모호성, `| - | - |` 데이터 행 구분행 오인, 섹션 경로 대소문자 비대칭,
    리터럴 `# ` 접두 소실, hp:lineBreak 파서/스캐너 불일치 등.

### Changed (Breaking)

- **`IRCell.blocks?: IRBlock[]` 추가** — 중첩표/셀 내 구조 보존용. 기존 `IRCell.text`는
  평탄화 텍스트로 그대로 유지되므로 대부분의 사용처는 영향 없음. `IRTable.caption`,
  `NEEDS_OCR` 경고 코드 추가.

## [2.9.1] - 2026-06-05 — PageQuality 타입 export 수정 + 문서 현행화

### Fixed

- **`PageQuality` / `DocumentQualitySummary` 타입 export 누락** — v2.9.0에서 추가된 PDF 품질 신호 타입이 `index.ts`의 public re-export 목록에서 빠져 `import type { PageQuality } from "kordoc"`가 동작하지 않던 문제 수정. (타입이 `ParseSuccess` 필드로만 인라인돼 named import 불가였음.)

### Docs

- **README / README-EN 현행화** — v2.8.0/v2.9.0 변경사항 추가, `parseHwp3`·`parseXls`·Print Renderer(`markdownToPdf`/`blocksToPdf`/`renderHtml`) API, HWP 3.x/XLS 지원 포맷, `detectFormat` 반환 타입(`hwp3`/`xls`) 정정.

## [2.9.0] - 2026-05-24 — PDF 텍스트 품질 신호 + OCR 필요 판정

### Added

- **PDF 페이지별 품질 신호** — `ParseSuccess`에 `pageQuality?: PageQuality[]`, `qualitySummary?: DocumentQualitySummary` 신규 필드. PDF 파서가 페이지마다 다음 메트릭을 산출한다.
  - `textChars`, `hangulRatio`, `controlCharRatio`, `replacementCharRatio`, `puaRatio`
  - `needsOcr: boolean`, `ocrReason?: "low_text" | "high_pua" | "high_control" | "high_replacement"`
- **문서 단위 OCR 권장 판정** — `DocumentQualitySummary.needsOcr` / `ocrCandidatePages`. 페이지 중 30% 이상이 OCR 후보면 문서 전체에 OCR 권장.
- **신규 모듈 `src/pdf/quality.ts`** — 메트릭 계산/요약 순수 함수. 임계치 상수 (`LOW_TEXT_THRESHOLD=20`, `HIGH_PUA_THRESHOLD=0.2`, `HIGH_CONTROL_THRESHOLD=0.05`, `HIGH_REPLACEMENT_THRESHOLD=0.05`) 명시.

### Changed

- **PDF 블록/마크다운에서 비표시 제어문자 제거** — C0(NUL 등, tab/lf/cr 제외) + DEL + C1 strip. PUA는 신호 보존을 위해 그대로 둔다 (사용자가 글꼴 매핑 실패를 시각적으로 확인 가능). 품질 메트릭은 strip 전 raw text에서 계산되어 신호가 보존된다.

### 동기

전국 지자체 주요업무계획 PDF 대량 처리(190건, 45,399쪽) 중 발견된 패턴:
1. 텍스트층은 있는데 ToUnicode/CMap이 불완전해 한글이 깨진 글리프로 떨어지는 PDF
2. NUL/제어문자가 본문에 섞이는 PDF
3. 페이지마다 품질이 다른 혼합형 PDF

기존 `isImageBased` 만으로는 위 케이스를 분류할 수 없어, OCR 큐로 자동 라우팅하기 어려웠다. 본 릴리스는 OCR을 기본 탑재하지 않고, 호출자가 후속 OCR 라우팅을 결정할 수 있도록 **품질 신호만 노출**한다.

```ts
const r = await parsePdf(buf)
if (r.success && r.qualitySummary?.needsOcr) {
  // 사용자 측에서 OCR 파이프라인 호출
  await routeToOcr(buf, r.qualitySummary.ocrCandidatePages)
}
```

## [2.8.0] - 2026-05-17 — `markdownToHwpx` 테마 옵션

### Added

- **`markdownToHwpx` 테마 옵션** (#31) — 헤딩/본문/인용/표 헤더 셀의 텍스트 색상과 표 헤더 굵기를 옵션으로 지정 가능. 새 export 타입 `HwpxTheme`, `MarkdownToHwpxOptions`. 옵션 미지정 시 기존과 동일하게 검정으로 출력 (baseline 백워드 호환).
  - 동기: 외부 사용자가 `markdownToHwpx`로 계약서·검토 보고서 등 시각 차별화가 필요한 문서를 생성할 때, 현재 모든 텍스트가 검정이라 헤딩 위계가 흐려지는 한계. (scopeguard-kr 백엔드 치환 PoC에서 도출된 필요.)
  - charProperties `itemCnt` 9 → 11 (표 헤더 셀용 charPr id=9, 인용문용 charPr id=10 신설). HWPX 1.4 호환 유지.
  - `HwpxTheme.headingColors` 키는 1..4만 받음 — 현재 charPr 매핑이 h1/h2/h3/h4 4단계 (h5, h6은 h4와 charPr 공유). 향후 h5/h6 분리 시 확장 예정.
  - `theme.quoteColor` 명시 시에만 인용문이 CHAR_QUOTE(이탤릭) 사용. 미지정 시엔 기존처럼 본문 charPr 사용 (시각 회귀 없음).

```ts
import { markdownToHwpx } from "kordoc"

const buf = await markdownToHwpx(md, {
  theme: {
    headingColors: { 1: "#17365D", 2: "#1F4E79", 3: "#2E74B5" },
    bodyColor: "#222222",
    quoteColor: "#5C667A",
    tableHeaderColor: "#1F4E79",
    tableHeaderBold: true,
  }
})
```

## [2.7.2] - 2026-05-16 — HWPX 양식 채우기 빈 셀 버그픽스

### Fixed

- **`fillHwpx`(`hwpx-preserve` 모드) 빈 셀 미삽입 버그** (#29, #30) — 한컴오피스에서 HWP→HWPX로 변환한 양식의 빈 값 셀(`<hp:run>`이 `<hp:t>` 자식 없이 self-closing 형태)에 값이 삽입되지 않으면서 `filled`/`matched` 결과에는 성공으로 보고되던 false-positive 수정. `setRunText`가 `<hp:t>` 없는 run을 만나면 부모 run의 prefix/namespace를 따라 새로 `<hp:t>`를 생성해 텍스트 삽입. 빈 문자열 호출(run 비우기) 케이스와의 호환성 유지를 위한 가드 포함.
- 회귀 테스트 추가 — self-closing `<hp:run/>`을 가진 minimal HWPX로 실제 XML 삽입까지 검증 (`tests/filler-hwpx.test.ts`).

기여: @amnotyoung — 정확한 진단과 임시 우회법(빈 셀에 placeholder 텍스트 입력 후 저장)까지 정리해주셔서 큰 도움이 되었습니다.

## [2.7.1] - 2026-05-09 — HWP 3.0 (구버전) 파서

### Added — HWP 3.0 (한글 워드프로세서 3.x) 텍스트 추출 파서

1996~2002년 한컴이 사용한 binary 포맷. CFB(OLE2) 컨테이너가 아닌 단일 binary stream 으로,
기존 kordoc(HWP5+) 가 거부하던 구버전 문서를 텍스트 인덱싱 용도로 추출 가능하게 한다.

- `parse()` 자동 라우팅: 매직 `"HWP Document File V3.00"` 30 byte 시그니처 → HWP3
- `parseHwp3(buffer)` 공개 API (`fileType: 'hwp3'`)
- `isHwp3File(buffer)` — 매직 바이트 detector
- 신규 모듈: `src/hwp3/{johab,reader,records,parser,johab-symbols}.ts`

알고리즘 흐름:
- 30 byte 시그니처 + 128 byte DocInfo + 1008 byte DocSummary → 메타데이터 추출
- `compressed` 플래그가 set 이면 InfoBlock 이후 raw deflate(RFC 1951) 압축 해제
- 7개 언어별 font face + style 메타데이터 skip → paragraph_list 진입
- 각 paragraph: 헤더 (43 byte ± 187 ParaShape) + LineInfos + InlineCharShapes + char stream
- char stream: u16 LE hchar 단위, ASCII(< 0x80) 직접 처리, 상용조합형(>= 0x8000) → 0xAC00 한글 음절 매핑 + 5,893개 한자/기호 lookup table
- 표(ch=10) cell 본문, 머리말/꼬리말(ch=16), 각주(ch=17), 숨은설명(ch=15) 의 nested paragraph 재귀 추출

검증: rhwp 레포의 HWP3 sample 3건 — sample4(임베디드 시스템 개요) 444 byte 본문 + 작자 "유미경" 메타데이터, sample5(리눅스 시스템 관리자 가이드) 7,204 byte 본문 + 작자 "김태형" 메타데이터를 경고 없이 깨끗하게 추출. sample(Creating Linux Virtual Servers) 161 byte 본문 추출 + 메타 컨트롤이 가득한 첫 paragraph 영역에서만 PARTIAL_PARSE 경고.

Robustness:
- paragraph 단위 try/catch — 한 paragraph stream 손상이 전체 추출을 막지 않음
- 헤더 sanity 가드 — char_count > 60K 또는 line_count > 4K 면 즉시 list 종료
- 표 cell_count > 256 가드 — 비정상 표 메타로 인한 무한 read 방지
- johab 매핑 실패 hchar 는 silent skip (기존 `?` fallback 으로 인한 검색 인덱스 noise 제거)

알고리즘은 [rhwp](https://github.com/edwardkim/rhwp) (Apache-2.0) 의 `src/parser/hwp3/` 를 TypeScript 로 minimal port. 5,893 entry 의 johab→유니코드 lookup table 은 `scripts/convert-johab-map.mjs` 로 자동 추출.

알려진 한계 (v0.1):
- DocSummary 외 description/link_print_file 등 metadata 영역은 byte stream 디코더 사용 (별도 fix 필요)
- HWP3 표 변종 일부에서 cell layout 어긋남 — 본문 텍스트 추출엔 영향 없음
- ch=5/6/27 등 메타 컨트롤의 추가 byte size 미상 (rhwp 자체도 미해결 영역)

---

## [2.7.0] - 2026-04-29 — XLS 파서 + Print Renderer (KorDoc Suite Phase 1)

### Added — XLS (Excel 97-2003 / BIFF8) 파서

OLE2 컨테이너에 담긴 `.xls` 파일을 순수 JavaScript로 파싱. 한컴오피스나 LibreOffice 같은 외부 도구 없이 동작.

- `parse()` 자동 라우팅: OLE2 매직 + Workbook 스트림 존재 → XLS, 그 외 → HWP 5.x
- `parseXls(buffer)` 공개 API (`fileType: 'xls'`)
- `detectOle2Format(buffer)` — OLE2 컨테이너 내부 스트림 기반 구분 (XLS/HWP/unknown)
- 신규 모듈: `src/xls/{record,encoding,sst,cell,parser,index}.ts`

지원 BIFF 레코드: BOF/EOF/CONTINUE/BoundSheet8/SST/CodePage/FilePass/Number/RK/MulRk/LabelSst/Label/Formula(+String)/BoolErr/Blank/MulBlank/MergeCells.
인코딩: UTF-16LE, Compressed Unicode, CP949(EUC-KR).
처리: 다중 시트, 병합 셀, 큰 SST의 CONTINUE 분할 경계 flags 재해석, 부동소수점 아티팩트 정리.
제한: 차트/매크로/그림/암호화 파일은 미지원 (암호화 파일은 경고와 함께 빈 결과 반환). 날짜 셀은 raw number로 출력 (XF 레코드 처리는 v2.8.0+).

기존 `src/hwp5/cfb-lenient.ts`의 OLE2 파서를 재사용하여 새 컨테이너 파서 작성 없이 구현.

### Added — Print Renderer (Markdown / IRBlock[] → PDF)

공공기관 인쇄용 PDF 렌더링 파이프라인. markdown-it로 HTML 변환 후 puppeteer-core로 PDF 출력.

- `renderHtml(markdown, options)` — HTML 문자열 반환 (외부 PDF 엔진 결합 가능)
- `markdownToPdf(markdown, options)` / `blocksToPdf(blocks, options)` — Buffer 반환
- 프리셋 3종:
  - `default` — A4, 여백 20mm, Pretendard 11pt
  - `gov-formal` — 휴먼명조 시뮬, 머리글/바닥글 옵션, 본문 들여쓰기 (시행문 스타일)
  - `compact` — 여백 10mm, 9pt (참고자료용)
- 옵션: 페이지 크기/방향, 여백, 머리글/바닥글, 워터마크(대각선), 추가 CSS
- Chromium 자동 감지 (Windows/Mac/Linux 표준 경로) 또는 `PUPPETEER_EXECUTABLE_PATH` 환경변수
- 신규 의존성: `markdown-it` (small)
- 새 optional peer dep: `puppeteer-core` (PDF 출력 시에만 필요)

### Technical notes
- 318 tests pass (신규 22: `tests/xls.test.ts` 12개 + `tests/print.test.ts` 10개)
- XLS 합성 픽스처 5건 (`tests/fixtures/xls/{population,budget,facilities,roster,minutes}.xls`) — 단순 텍스트, 병합+음수+큰 정수, 다중 시트, 빈 행/열, 200행 SST CONTINUE 분할 검증
- 명세 문서: `docs/biff8-spec.md`

---

## [2.6.2] - 2026-04-23

### Fixed — PDF 수식 OCR noise 필터 대폭 강화

MFR tokenizer 가 뱉는 garbage 수식을 제거하기 위한 12개 trivial 필터 규칙 추가. arxiv Attention 논문 기준 순수 noise 1개만 남아 **96% 정확도** 달성. ResNet (Figure 많음) 기준 **90%**. 핵심 수식 100% 유지.

새로 추가된 `isTrivialFormula` 규칙:
- substring 반복 (5~15자, 3회+, 커버리지 60%+) — `\alpha_{1}=\alpha_{2}=...` 같은 OCR 반복 오류
- `\square` placeholder 포함 — MFR 이 인식 실패 영역에 출력하는 마커
- 단독 숫자/실수 (`$1.0$`, `$42$`)
- 동일 괄호 그룹 연속 중복 (`(T_{2})(T_{2})`, `{X}{X}`)
- 함수 인자 반복 (`C(\tau_{2},\mu^{\prime},\mu^{\prime})`)
- `\frac{X}{X}` 분자=분모 (의미 없는 = 1)
- matrix placeholder (`\begin{matrix}` + `\cdots` 2회+)
- 비정상 2~3자 변수 prefix (`cl_{\mathrm{model}}`)
- `\mathrm{word}` + 이항연산자 + single (`\mathrm{to}-\infty` 다이어그램 레이블)
- `\mathsf`/`\mathtt`/`\texttt` 포함 (다이어그램 타이포그래피 전용)
- `\begin{aligned}` + 등호 없음 (aligned 는 항상 등호 필요)
- `\begin{matrix}` + `\downarrow` 반복 (architecture diagram)

### Technical notes
- 312 tests pass (신규 11)
- e2e 검증: arxiv Attention/ResNet/kosimcse

---

## [2.6.1] - 2026-04-23

### Fixed — PDF 수식 OCR 품질 기초 개선

v2.6.0 의 PDF 수식 OCR 이 다이어그램 내 단일 글자/기호/반복 패턴을 수식으로 오탐하고, MFR tokenizer 의 과공백/공백 누락 버그, 수식 블록이 페이지 끝에 몰리는 문제를 해결.

- **trivial 필터** (`postProcessLatex` 내부) — 단일 글자 (`$O$`, `$a$`), 단일 `\cmd` (`$\imath$`, `$\pi$`, `$\sigma$`), 장식 `\mathrm{...}` 단독 (`$\mathrm{fcloc}$`), 반복 토큰 (`$\pm \pm \pm \pm$`), 심볼만 조합 (`$\cap \exists \exists \rceil$`) 제거.
- **MFR tokenizer 과공백 정규화** — `\mathrm { m o d d }` → `\mathrm{modd}`, `6 4` → `64`, `( Q, K, V )` → `(Q,K,V)`. `\cmd` 뒤 변수 공백은 의미 보존 위해 유지 (`\cdot d` 유지).
- **`\cmd` 뒤 공백 누락 복원** — `\cdotd` → `\cdot d`, `\timesd_{k}` → `\times d_{k}` (알려진 LaTeX 명령어 사전 기반 최장 prefix 분할).
- **수식 bbox y 좌표 매핑** (`parser.ts`) — 기존엔 검출된 수식이 페이지 끝에 몰려 배치되었으나, pdfium 픽셀 → PDF 포인트 변환 후 같은 페이지 pdfjs 블록들의 y center 와 비교해 **올바른 위치에 삽입**. MultiHead/FFN/PE 수식이 논문 흐름에 맞게 배치.
- **pdfjs 중복 블록 제거** — 수식 bbox 와 60%+ 겹치는 pdfjs 텍스트 블록을 자동 삭제. OCR 수식과 pdfjs 추출 텍스트의 중복 해결.
- **`cleanPdfText` 수식 라인 보호** — `collapseEvenSpacing` 이 수식 내부 LaTeX 공백을 "균등배분" 으로 오인식해 `\cdot d` → `\cdotd` 로 합쳐지던 숨은 버그 수정.

### Technical notes
- 298 tests pass (신규 13)

---

## [2.6.0] - 2026-04-23

### Added — PDF 이미지 기반 수식 OCR (Pix2Text MFD + MFR)

PDF 스캔/이미지 영역의 수식을 LaTeX 로 자동 변환. [breezedeus/pix2text](https://github.com/breezedeus/pix2text) 의 ONNX 모델 활용.

- **MFD (Mathematical Formula Detection)** — YOLOv8 기반 수식 영역 검출. inline (`$...$`) 과 display (`$$...$$`) 분류.
- **MFR (Mathematical Formula Recognition)** — DeiT encoder + TrOCR decoder greedy 디코딩. vocab 1200, max 256 tokens.
- **모델 자동 다운로드** — 첫 실행 시 `~/.cache/kordoc/models/pix2text/` 에 저장. SHA-256 검증 포함.
- **의존성** (optional): `onnxruntime-node`, `sharp`, `@huggingface/transformers`, `@hyzyla/pdfium`.

### Tuned
- MFD threshold: display 0.25 → 0.40, inline 0.25 → 0.30 (다이어그램 오탐 감소)
- 최소 bbox 면적 80 px² (이보다 작으면 OCR noise 가능성 높음)

### Note
- 이 버전의 OCR 결과에는 단일 글자/반복 noise 가 다수 포함되어 있음. v2.6.1 / v2.6.2 에서 점진적으로 개선.

---

## [2.5.2] - 2026-04-22

macOS 한컴 재테스트 피드백 3건 반영 (#4 후속).

### Fixed
- **테이블 테두리 미렌더링** — `width="0.12mm"`/`"0.1mm"` 값에 숫자-단위 사이 **공백 추가** (`"0.12 mm"`, `"0.1 mm"`). 한컴 공식 HWPX 샘플이 공백 포함 형식을 쓰는데 비공백 형식을 파서가 NONE으로 fallback하던 현상 추정. borderFill/footNotePr/endNotePr 전구간 일관되게 적용.
- **볼드·이탤릭 시각 구분 없음** — 기존 `bold="1"` 속성만으로는 macOS 한컴이 합성 굵기를 적용 안 하는 문제. **별도 bold 전용 fontface 추가**:
  - HANGUL: `id=2` face="HY견고딕" `weight="9"` 추가
  - LATIN: `id=2` face="Arial Black" `weight="9"` 추가
  - `charPr` 헬퍼가 bold 플래그 true일 때 `fontRef`를 id=2로 자동 라우팅 → 속성 + 실제 굵은 폰트 참조 병행
- **순서 있는 목록 자동 번호 미작동** — 기존 `(indent+1). ` 고정값으로 모든 항목이 `1. `로 찍히던 버그. **indent 레벨별 러닝 카운터** 도입. 블록이 list_item 아니면 카운터 리셋 → 분리된 목록은 각각 1부터. 상위 레벨 번호가 바뀌면 하위 자동 리셋.

### Technical notes
- 테스트 226/226 통과 (regression 없음)
- 자체 파서 roundtrip OK

## [2.5.1] - 2026-04-22

README 현행화 (한/영). 기능 변경 없음.

## [2.5.0] - 2026-04-22

HWPX 생성기 스펙 완전 준수 + HWP 배포용 문서 COM fallback 확장.

### Fixed
- **`markdownToHwpx` HWPX 스펙 준수** (#4) — 생성된 HWPX가 macOS 한컴오피스에서 "파일이 깨졌다" 거부되던 이슈 해결. 테이블 XML을 최소 스켈레톤에서 완전 스펙 형태로 재작성:
  - `<hp:tbl>` 필수 속성 전부 추가 (`id`, `zOrder`, `numberingType`, `pageBreak`, `repeatHeader`, `rowCnt`, `colCnt`, `cellSpacing`, `borderFillIDRef`, `noShading`)
  - `<hp:sz>` / `<hp:pos>` / `<hp:outMargin>` / `<hp:inMargin>` 블록 추가
  - 각 `<hp:tc>`에 `<hp:subList>` 래퍼 + `<hp:cellAddr>` / `<hp:cellSpan>` / `<hp:cellSz>` / `<hp:cellMargin>` 추가
  - `<hp:tbl>`을 `<hp:p><hp:run>...` 로 감싸 paragraph-anchored 방식으로 배치
- **header.xml borderFill id=1 추가** — 테이블 실제 테두리 렌더링용 (SOLID 0.12mm)
- **`Preview/PrvText.txt` 생성** — macOS 한컴이 확인하는 경로. 문서 앞부분 텍스트 스냅샷 1KB 이내

### Added
- **HWP 5.x 배포용 문서 COM fallback 확장** (#25) — `.hwp` 바이너리에서 "이 문서는 상위 버전의 배포용 문서입니다..." 경고 플레이스홀더만 나오는 케이스에서, Windows + 한컴오피스 환경이면 자동으로 `HWPFrame.HwpObject` COM API로 재시도. 기존 HWPX DRM fallback 인프라 재활용.
  - 새 모듈 `src/hwp5/sentinel.ts` — 경고 문자열 패턴 감지 (3개 정규식)
  - `parseHwp()`가 `options.filePath` 있으면 자동 트리거
  - 정상 본문이 섞인 문서는 sentinel=false → fallback 건너뜀

### Technical notes
- Windows + 한컴오피스가 없는 환경에서는 기존 경고 문자열이 그대로 노출됨 (behavior unchanged)
- 테스트 4건 추가 (`tests/sentinel.test.ts`) — 226/226 pass

## [2.4.1] - 2026-04-19

MCP 설치 경험 개선. 한 줄 마법사로 AI 에이전트 연동 자동화.

### Added
- **`npx kordoc setup`** — 대화형 설치 마법사. 8개 AI 클라이언트 자동 감지 (Claude Desktop / Claude Code / Cursor / VS Code / Windsurf / Gemini CLI / Zed / Antigravity) → 설정 파일 자동 패치. `[감지됨]` 배지로 실제 설치된 클라이언트 구분.
- **Windows `cmd /c npx` 자동 래핑** — Windows 에선 `command: "cmd"`, `args: ["/c", "npx", ...]` 로 자동 생성. Claude Desktop 이 `.cmd` 확장자를 해석하지 못해 `npx not found` 나던 이슈 원천 차단.
- **README 상단 "30초 설치" 섹션** — 수동 JSON 편집 없이 설치하도록 가장 눈에 띄는 위치에 마법사 소개.

## [2.4.0] - 2026-04-17

### Added
- **HWPX DRM 배포용 문서 자동 추출** — `manifest.xml`에 `encryption-data`가 감지되면 한컴 오피스 COM API(`HWPFrame.HwpObject`)의 `GetPageText`로 페이지별 텍스트를 자동 추출. Windows + 한컴 오피스 설치 환경에서 DRM 암호화된 공공문서(서울시 등)를 별도 설정 없이 파싱 가능.
- **`ParseOptions.filePath`** — DRM COM fallback에 필요한 원본 파일 경로. `parse(filePath)` 호출 시 자동 설정.

### Fixed
- **CLI `filePath` 미전달** — CLI에서 `parse(buffer, options)` 호출 시 `filePath`가 누락되어 DRM fallback이 동작하지 않던 문제 수정.

## [2.2.0] - 2026-04-08

### Security
- **XLSX/DOCX Billion Laughs 방지** — `stripDtd()`를 utils.ts로 추출, XLSX/DOCX `parseXml()`에 적용. 기존 HWPX만 보호하던 DOCTYPE 제거를 전 포맷으로 확대.
- **`isPathTraversal()` 오탐 수정** — `includes("..")` 부분 문자열 매칭 → 경로 컴포넌트 단위(`segments.some(s => s === "..")`) 검사로 변경. `file..v2.xml` 같은 합법적 파일명 차단 해소.
- **Watch SSRF 강화** — fetch에 `redirect: "error"` 추가(리다이렉트 기반 SSRF 차단), 10진수 정수 IP(`http://2130706433`) 차단 추가.
- **Watch symlink 경로 순회 차단** — `resolve()` → `realpathSync()`로 교체. 심볼릭 링크가 감시 디렉토리 외부를 가리키는 경우 차단.
- **HWP5 lenient decompression bomb 방지** — `findSectionsLenient`/`findViewTextSectionsLenient`에서 누적 압축해제 크기 추적. 100개 섹션 × 100MB = 10GB 공격 차단.
- **CFB lenient FAT 섹터 상한** — `fatSectorCount > 10,000` 시 거부. 악성 파일의 거대 FAT 테이블 할당 방지.
- **`buildTableDirect` MAX_COLS 적용** — colAddr 기반 직접 배치에서 `MAX_COLS(200)` 상한 누락 수정. 악성 HWP의 메모리 폭주 방지.

### Fixed
- **`Math.min/max(...spread)` 스택 오버플로** — PDF/HWPX 15개소의 `Math.min(...array)` 패턴을 for 루프 기반 `safeMin`/`safeMax` 유틸로 교체. 20,000+ 텍스트 아이템 페이지에서 `RangeError` 방지.
- **Levenshtein fallback 유사도 오류** — 길이 합 10,000자 초과 시 `Math.abs(a.length - b.length)` 반환하던 것을 앞 500자 샘플 기반 근사 거리 추정으로 개선. 동일 길이 다른 문자열에서 거리=0(유사도 1.0) 반환하던 버그 수정.
- **MCP `parse_metadata` XLSX/DOCX 오분류** — `detectFormat`이 모든 ZIP을 "hwpx"로 반환하여 XLSX/DOCX가 HWPX 메타데이터 추출 경로를 타던 버그. `detectZipFormat`으로 세분화 후 전체 파싱 fallback.
- **CLI JSON Uint8Array 직렬화** — `--format json` 출력에서 `Uint8Array`가 `{"0":255,"1":128,...}` 형태로 나오던 것을 base64 문자열로 변환.
- **CLI `sanitizeError` 동적 import 제거** — catch 블록의 불필요한 `await import("./utils.js")`를 정적 import으로 변경.

### Changed
- **Watch 동시 처리 제한** — `MAX_CONCURRENT=3` + `inProgress` Set으로 동일 파일 동시 처리 방지 및 전체 동시 처리 수 제한. 대량 파일 유입 시 OOM 방지.
- **PDF `allFontSizes` 메모리 최적화** — 5000페이지 PDF에서 500만 엔트리 배열(~40MB) → 빈도 Map(~50 엔트리)으로 교체. `computeMedianFontSizeFromFreq()` 도입.
- **`stripDtd()` 공용화** — HWPX 로컬 함수에서 utils.ts export로 이동. HWPX/XLSX/DOCX 전 파서 공유.

## [2.0.3] - 2026-04-06

### Added
- **HWP5 개요 수준(outline level) 기반 헤딩 감지** — `TAG_PARA_SHAPE` 레코드에서 개요 수준(bits 25-27)을 추출하여 정확한 heading 계층 생성. 기존 폰트 크기 휴리스틱의 폴백으로 병행 동작.
- **HWP5 "제X장/조" 패턴 헤딩 감지 강화** — 스타일 정보가 없는 배포용 문서에서도 "제N장/절/편" → H2, "제N조" → H3으로 자동 변환.
- **레이아웃 테이블 자동 해체** — 1~3행 테이블 중 셀 내 줄바꿈 과다(>5) 또는 텍스트 과다(>300자)인 레이아웃용 표를 IRBlock 레벨에서 paragraph 블록들로 분해. heading 감지 전에 수행하여 해체된 텍스트에도 heading 감지 적용.

### Fixed
- **DocInfo 태그 ID 상수 수정** — `TAG_DOC_CHAR_SHAPE`, `TAG_DOC_PARA_SHAPE`, `TAG_DOC_STYLE` 등 DocInfo 태그 ID가 HWPTAG_BEGIN(0x0010) 기준이 아닌 잘못된 값(0x003x)으로 정의되어 charShapes/styles가 항상 빈 배열이던 버그 수정. 이로 인해 폰트 크기 기반 헤딩 감지가 전혀 작동하지 않던 문제 해결.

## [2.0.2] - 2026-04-05

### Added
- **글상자(TextBox) 텍스트 추출** — HWPX `drawText` 요소와 HWP5 `gso` 제어문자에서 글상자 텍스트 추출. `rect`/`ellipse` 등 도형 안의 중첩 글상자도 재귀 탐색.
- **HWPX 중첩 표 별도 블록 분리** — 3행+2열 이상의 중첩 표를 텍스트 변환 대신 독립 마크다운 테이블로 출력. 결재란 등 복잡한 서식 구조 보존.

### Fixed
- **HWPX 목차 리더 페이지번호 제거** — `<hp:tab leader>` 뒤의 페이지번호가 헤딩 텍스트에 붙던 문제. `<hp:t>` 내 자식 노드 순회로 전환.
- **HWPX 헤딩 균등배분 패턴 매칭** — "제 1 장" 같은 공백 포함 패턴도 `제N장/조` 헤딩으로 감지.
- **표 rowSpan 빈 행 병합 개선** — "첫 열만 값, 나머지 빈" 행을 다음 데이터 행에 전파. colSpan 스킵 셀 구분 추가.
- **빈 1x1 표 필터링** — 마크다운 출력에서 빈 테이블 제거.

## [2.0.0] - 2026-04-05

### Added
- **HWP5 배포용 문서 복호화** — 배포용(열람 제한) HWP 파일의 ViewText 스트림을 AES-128 ECB로 복호화. 순수 JS 구현으로 네이티브 의존성 없음. rhwp(MIT)의 알고리즘 포팅.
- **Lenient CFB 파서** — 표준 cfb 모듈이 거부하는 손상된 HWP 파일을 직접 헤더/FAT/디렉토리 파싱으로 복구. 순환 감지, 체인 길이 제한 포함. rhwp(MIT)의 LenientCfbReader 알고리즘 포팅.
- **HWP5 각주/미주 추출** — CTRL_HEADER 내 각주/미주 본문 텍스트를 추출하여 `footnoteText` 필드에 연결.
- **HWP5 하이퍼링크 추출** — `%tok`/`klnk` 제어문자에서 URL 추출, `sanitizeHref` 적용.
- **HWP5 이미지 추출 강화** — Lenient CFB 경로에서도 BinData 이미지 추출 지원.
- **`LENIENT_CFB_RECOVERY` 경고 코드** — 손상 CFB 복구 시 warnings에 구조화된 코드 추가.

### Fixed
- **HWPX 표 colspan/rowspan 병합 밀림** — 병합 셀 계산 시 colSpan/rowSpan이 그리드 크기에 반영되지 않아 셀이 밀리던 버그 수정.
- **HWP5 코드 10(구역/단 정의) 처리** — char 타입으로 잘못 분류되어 14바이트 확장 데이터를 스킵하지 않던 버그 수정. extended 타입으로 재분류.
- **HWP5 하이퍼링크 XSS 방어** — `extractHyperlinkUrl` 결과에 `sanitizeHref` 미적용 수정. HWPX 파서와 일관성 확보.
- **`sanitizeHref` 중복 정의 제거** — `table/builder.ts`의 로컬 복사본 제거, `utils.ts`에서 import로 통일.

### Security
- CFB lenient 파서에 `sectorSizeShift` 범위 검증 추가 (7-16 범위만 허용, 악의적 파일의 메모리 폭주 방지)
- 하이퍼링크 URL 살균이 HWP5/HWPX/blocksToMarkdown 3개 경로 모두에서 일관 적용

### Credits
- **rhwp** (MIT, edwardkim) — HWP5 배포용 복호화 및 lenient CFB 파싱 알고리즘의 참조 구현

## [1.8.0] - 2026-04-04

### Added
- **XLSX 파서** — Excel 스프레드시트 파싱. 공유 문자열, 병합 셀(gridSpan/mergeCell), 다중 시트 지원. 시트별 heading + table 블록 생성. 부동소수점 아티팩트 정리.
- **DOCX 파서** — Word 문서 파싱. 스타일 기반 heading(outlineLevel), 번호 매기기(리스트), 각주, 하이퍼링크, 이미지 추출(a:blip), vMerge/gridSpan 테이블 병합.
- **ZIP bomb 공유 보호** — `precheckZipSize`를 utils.ts로 추출. HWPX/XLSX/DOCX 모든 ZIP 파서에 일괄 적용.
- **SSRF 보호 강화** — IPv6 사설 대역(fc/fd/fe80), 클라우드 메타데이터 엔드포인트, 16진수/8진수 IP 인코딩 차단.
- **heading 임계값 공유 상수** — `HEADING_RATIO_H1/H2/H3`을 types.ts에서 공유. PDF/HWP5/HWPX 전 파서 통일.

### Changed
- **PDF 파서 InternalParseResult 통일** — 기존 ParseResult 직접 반환 → InternalParseResult로 변경. index.ts에서 일괄 래핑. 에러 핸들링 경로 통일.
- **HWP5 BinData 최적화** — 최대 20,000회 CFB.find 순차 검색 → FileIndex 1회 순회 O(n).
- **cluster indexOf 최적화** — O(n²) indexOf → Map 기반 O(n).
- **MCP 확장자 허용** — ALLOWED_EXTENSIONS에 `.xlsx`, `.docx` 추가. 도구 설명 갱신.
- **Watch 모드** — xlsx/docx 확장자 감시 추가, 경로 순회 검증 추가.

### Fixed
- **CLI `--no-header-footer` 로직 반전** — Commander의 `--no-*` 패턴이 `removeHeaderFooter = true`(기본 동작)를 설정해 플래그가 무의미했던 버그 수정.
- **PDF timeout 타이머 누수** — Promise.race 성공 시 clearTimeout 미호출 수정.
- **HWPX href XSS** — 하이퍼링크 URL을 마크다운 렌더링이 아닌 추출 시점에서 살균.
- **깨진 ZIP 복구 경고 누락** — extractFromBrokenZip에서 warnings/sectionNum 전달.

### Security
- ZIP bomb 보호가 XLSX/DOCX에도 적용됨 (기존 HWPX만 보호)
- CLI 에러 메시지에 sanitizeError 적용 (파일시스템 경로 노출 방지)
- href 살균을 파서 추출 시점으로 이동 (block.href 직접 사용 시에도 안전)

## [1.7.2] - 2026-04-02

### Fixed
- **pdfjs-dist v5 호환** — `constructPath` 연산자의 args 형식 변경에 대응. v5에서 `subOps`가 배열 대신 단일 숫자로 전달되고, 좌표가 `DrawOPS` 상수(moveTo=0, lineTo=1, closePath=4) 기반 flat object로 변경된 것을 처리. v4/v5 모두 정상 동작.

## [1.7.1] - 2026-04-01

### Added
- **README-KR.md API 섹션 추가** — ParseResult 인터페이스, 타입 export, internal 안내 추가.
- 영문 README와 동기화 및 전반적인 가독성 개선.

## [1.7.0] - 2026-03-31

### Added
- **HWPX 파서 테이블 복합 타입 단순화** — 내부 구조 개선 및 성능 최적화.
- **public API 축소** — 보안 및 안정성을 위해 내부 함수들을 비공개로 전환.

## [1.1.2] - 2026-03-28


### Breaking Changes
- **IR 타입 export 제거** — `IRBlock`, `IRTable`, `IRCell`, `CellContext`를 public API에서 제거. `buildTable` 등 IR 조작 함수가 이미 제거되었으므로 일관성 확보.

### Fixed
- **`assert.rejects` await 누락 수정** — precheckZipSize 간접 테스트에서 엔트리 수 초과 검증이 실제로 실행되지 않던 버그
- **isStandaloneHeader 단어 제한 완화** — 4단어 → 7단어. "제1장 국민의 기본적 권리와 의무" 등 실제 법령 장 제목 커버
- **README-KR.md API 섹션 추가** — 영문 README와 동기화 (ParseResult 인터페이스, 타입 export, internal 안내)

## [1.1.1] - 2026-03-28

### Fixed
- **CI Node 18 호환** — `import.meta.dirname` → `dirname(fileURLToPath(import.meta.url))`
- **loadAsync 후 실제 엔트리 수 검증** — CD 위조와 무관한 진짜 방어선 추가
- **isStandaloneHeader 매직넘버 40 제거** — 패턴 기반 regex로 교체
- **mergeKoreanLines 빈 입력 방어** — `!text` 및 단일 줄 조기 반환

### Changed
- **`buildTable`, `blocksToMarkdown`, `convertTableToText` public API 제거** — 내부 전용
- **교차 검증 테스트 강화** — 3글자 이상 단어 기준 10% 이상 공통 비율

### Added
- **CI용 dummy.hwpx fixture** — 프로그래밍 생성, 커밋됨

## [1.1.0] - 2026-03-28

### Breaking Changes
- **`KordocError`, `sanitizeError`, `isPathTraversal`을 public API에서 제거**

### Changed
- **cleanPdfText 한국어 줄 병합 리팩토링** — 150자 regex를 3개 함수로 분리. 한글 번호, 숫자, 괄호, 기호, 법령 조항(제N조/항/호) 패턴 보호
- **precheckZipSize 안전성 강화** — try/catch, 22바이트 미만 버퍼 조기 반환, `@internal` 태그

### Added
- **실제 문서 통합 테스트** — .hwp, .hwpx, .pdf 파일 전체 파이프라인 검증 + 포맷 간 교차 검증
- **합성 HWPX 통합 테스트** — 마크다운 테이블 구조 정밀 검증, 멀티 섹션 순서 등
- **precheckZipSize 단위 테스트** 10개 — EOCD/CD 파싱, 경계 조건, 악성 입력
- README 보안 섹션에 **ZIP bomb 한계 명시**

## [1.0.2] - 2026-03-28

### Changed
- **KordocError 클래스 도입** — 모든 파서 에러 통합, MCP `sanitizeError` instanceof 판별
- **JSZip ZIP bomb 사전 검증** — loadAsync 전 Central Directory 직접 파싱
- **toArrayBuffer 최적화** — zero-copy 경로 추가

### Fixed
- cfb 버전 핀 (`1.2.2`), `@types/node` 다운그레이드 (`^18`), SECURITY.md 현실화

## [1.0.1] - 2026-03-28

### Fixed
- JSZip undocumented internal API 의존 제거
- MCP 에러 정제를 allowlist 기반으로 교체

### Added
- 보안 로직 회귀 테스트 9개, CHANGELOG.md, SECURITY.md

## [1.0.0] - 2026-03-28

### Security
프로덕션급 보안 강화: ZIP bomb 방지, XXE/Billion Laughs 방지, 압축 폭탄 방지, PDF 리소스 제한, HWP5 레코드/섹션 제한, 테이블 차원 클램핑, 경로 순회 차단, MCP 에러 정제/경로 제한, 파일 크기 제한.

### Fixed
- HWP5 제어문자 코드 10(각주/미주) 정상 처리

## [0.2.0] - 2026-03-27

### Changed
- IR 패턴 도입, 2-pass 테이블 빌더, colSpan/rowSpan 클램핑
- pdfjs-dist를 선택적 peerDependency로 변경

## [0.1.0] - 2026-03-27

### Added
- 최초 릴리스: HWP 5.x, HWPX, PDF 파싱, CLI, MCP 서버
