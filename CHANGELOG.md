# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.12.3] - 2026-09-05

공문서 작성 라운드. 실결재 기안문 206건 + 보고서·보도자료 337건 HWPX 의 항목부호 단계별 글꼴을 실측해
`levels`(위계 타이포) 옵션을 넣고, 표기법 검수 `COLON_SPACE`·`DATE_NO_SPACE` 오탐을 법정 서식·법제처 표기
근거로 좁혔다. 별표 코퍼스 3차(`licbyl-byl2/` 183쌍) 편입, PDF 텍스트·틀 결함 3건, HWP5 기호 2건.

### Added

- **`levels` — 항목부호 단계별 위계 타이포 (`src/hwpx/gen-levels.ts`, gongmun.ts·gen-section.ts·gen-header.ts·
  gen-gongmun-fit.ts·gongmun-surface.ts·cli.ts·mcp.ts)** — `{ [depth 0~7]: { font?, pt?, bold? } }`. CLI
  `--levels "0=HY견고딕/17/bold,1=한컴돋움/15/bold,2=휴먼명조/14"`, MCP `levels`. 지정 단계마다 charPr 쌍(보통·굵게)을
  docframe charPr 뒤 id 에, 글꼴은 정적 fontface 뒤에 append(한글·라틴만 참조, 그 외 언어는 본문 글꼴 — 비실측
  프리셋 1종 언어 테이블 안전). 내어쓰기 폭은 그 단계 글자 크기(`levelIndent` `markerHeight`), 장평 변형은 지정
  단계 제외, 인라인 `**강조**` 는 같은 단계 bold 짝. 실측 프리셋 □(HY헤드라인M)·보도자료 각주보다 우선.
  미지정이면 산출물 불변. 실측 근거는 `docs/gongmunseo-reference.md` 2.7, 구현 매핑은 engine-spec (c-4):
  법정 8단계는 본문 동일 90%(기본값 무변경), □/ㅇ/- 계열은 □ HY견고딕 +2~3pt bold · ㅇ 한컴돋움 bold · - 휴먼명조.
- **PDF 제목 아래 틀 (`clip-cells.ts` `titledFrame`)** — 테두리 없는 1칸 틀(별표 1×1 프레임·선서문 바깥 틀)을
  "문서 전 페이지 반복 클립 = 본문 영역" 가설로 가르려 했으나 반증(채용공고 pair05 본문 영역 클립은 쪽마다 y1 73~91 로
  달라 같은 사각형이 아니고, 별표는 1쪽). 대신 윗변 ≥ 페이지 20%·폭 ≥ 60%·머리말 띠(8%) 아래 위쪽에 글이 있고
  안에도 글이 있는 컨테이너를 틀로 본다(`buildClipCellGrids` 6번째 인자 text 좌표, page-blocks 가 넘김). 2단 채용공고의
  단 상자(폭 38%, pair06)는 폭 조건으로 제외 — pdf-table-gt cellF1 0.933 회귀를 잡은 뒤 0.945 유지.
- **PUA-A U+F00E1 → "(인)" (`shared/pua.ts`)** — 한컴 PDF 200dpi 실렌더로 네모 테두리 안 "인" 글리프 확인
  (licbyl2 17754757 수련치과병원장·17975885 청원주/경찰서장 결재 위치).
- **별표 코퍼스 3차** — `licbyl-byl2/` 183쌍(seed 20260907, `--knd=1 --exclude=licbyl,licbyl2,licbyl-byl`, 풀 소진으로
  200 미달) + rhwp v0.8.6 HWPX 183. 격리 1건(known-false-miss README: HWP5 쌍 유사도 1 + "훈격구분" 출력 존재).
  하위 30건(Jaccard<0.5) 분해: A 1×1 틀 PDF 미감지 8 · B HWP `flattenLayoutTables` 해체 vs PDF 1열 유지 13(+다열 2)
  · C 구조 차 7 — C 는 수식 셀(HWP=HWPX, cmp 지표 한계)·쪽 경계 셀 분할·셀 줄바꿈·U+119E 로 파서 결함 없음.
- **벤치 정규화 미러 (`bench/lib/normalize.mjs`)** — PUA_SUPP 에 F00E1 "(인)" 추가(없으면 HWPX phantom 4문서),
  U+119E → ㆍ 접기(pdftotext·pdfjs 컨센서스가 ᆞ 를 내므로 파서 정규화와 대칭 — 없으면 별표 PDF 5문서 coverage 0.97~0.99).

### Changed

- **`COLON_SPACE` (`gongmun-lint.ts`)** — 표 줄(GFM `|`·HTML tr/td/th) 건너뜀(`skipTable`): 법정 별지서식 자체가
  "성 명 :"·"주 소 :" 라벨 셀을 쓰므로 규칙 대상이 아니다(서식 595건 표 셀 801건 전부 라벨 — 서식 801 → 7).
  뒤 글자 `<`·`*`·`_` 제외("성명:</td>" 578건·"과정:** 붙임"). 기안문 본문 "일 시 : 값"(206건 중 100건, 414건)은
  편람(쌍점 앞 붙이고 뒤 1타) 위반이라 유지(492 → 425).
- **`DATE_NO_SPACE`** — 법제처 연혁 표기 `<개정 2012.2.14>`·`<신설 …>`·`삭제 <…>`·`[시행일:2017.9.8.]` 제외(서식 156 → 10,
  남은 10은 "예) 2016.07.01"·"0000.00.00." 기입 예시). 기안문 139건은 무변경 — 문서번호 인용 "○○과-123(2026.7.1.)호"
  103건(74%)이 편람 날짜 표기 위반이라 유지.
- **PDF 가운뎃점 정규화 (`text-clean.ts` `normalizeAraea`)** — 한컴 PDF 가 ㆍ(U+318D)를 조합형 중성 아래아 ᆞ(U+119E)로
  내는 것(별지서식 573쌍: PDF 3,238자 중 340자·41문서, HWP 0)을 되돌린다. 앞이 초성(U+1100~115F)인 옛한글 결합은 보존.
  셀 `blocks` 도 순회.
- **PDF 1×1 표 줄 보존 (`text-clean.ts` `splitSingleCellTables`)** — 중첩표 없는 최상위 1×1 표를 줄마다 문단 블록으로.
  결합 지점은 builder 1×1 분기가 아니라 `cleanPdfText` 의 `mergeKoreanLines`(한글 줄 병합)였다 — 문단 블록 사이 빈 줄은
  병합 대상이 아니다. 선서문 "선 서 나는 헌법을 …" 해소. 파급 897 PDF 중 10문서 12표.
- **HWP5 하이픈 제어문자(0x18) 미방출 (`hwp5/record.ts`)** — 한컴 PDF·rhwp export-hwpx 모두 그리지 않는다
  ("60g/㎡", licbyl2 17855137 — 전 코퍼스 유일 출현). 실렌더 정합. 테스트 2건 갱신.

### 판정 기록 (변경 없음)

- **1열 다행 표 52건 행 경계** — HWP5 는 줄 렌더(행 경계 소실), PDF 는 클립 셀로 1열 표 유지(B 클래스 15건의 실체).
  바꾸려면 HWPX 게이트·formats 베이스라인 파급 측정이 먼저라 이번 라운드 유지.
- **후행 빈 열(17336891)** — HWP5 파서 8×5 = 한컴 PDF 8×5, rhwp HWPX 만 8×4. rhwp 변환 아티팩트, kordoc #47 트림
  로직 차이 아님.
- **PDF coverage weak 18409013(0.81)** — 체크박스 서식의 "예/아니오" 라벨 줄이 박스 줄과 분리 배치돼 어순만 다름
  (텍스트 손실 0). 레이아웃 순서 차, 미수정.
- **cmp 하위 3건** — 16826677 좌표전환계산부: HWP=HWPX 35×6 = PDF 35×6, 셀 안 수식(EQEDIT)이 IR cell.text 에 없어
  Jaccard 만 낮음. 18191495 양도소득 통보: 21×52 초세밀 격자를 PDF 가 20×51 로 병합(두문 영역 클립 부재). 6427951
  근로감독관증: HWP 단일 24×19 틀을 PDF 가 6×4+1×1+4×3 으로 분할(테두리 없는 외곽 틀 미감지 — A 클래스).


## [4.12.2] - 2026-09-05

별지서식 라운드 2. 코퍼스를 2차로 늘리고(서식 279쌍 + 별표 90쌍, 총 1,995파일) 세 파서가 **같은 IR
모양**을 내도록 맞췄다 — 1칸 틀 안 중첩표를 PDF 는 틀 셀의 `IRCell.blocks` 로, HWP5 는 서식 틀을
해체하지 않고 표로. HWP5↔PDF 셀 텍스트 Jaccard(`bench/cmp-hwp-pdf.mjs`, 정식 편입) 는 licbyl
0.927 → 0.965, PDF 표 GT 게이트는 cellF1 0.873 → 0.945, cellExact 0.945 → 0.980, contentNED
0.842 → 0.948. 플로어를 실측치로 상향 잠금(cellExact 0.72 → 0.97).

### Added

- **PDF 틀 셀 중첩표 (`clip-cells.ts`·`page-blocks.ts`)** — 클립 그리드가 다른 클립 안에 들면
  `TableGrid.clipParent` 로 부모 사각형을 넘기고, 소비측이 틀 셀을 만들 때 그 셀의 `blocks` 에
  셀 문단과 안쪽 표를 위→아래 원문 순서로 넣는다(`text` 는 평탄화). 지정서·영치증의 "발신명의 |
  직인" 표가 틀 뒤(꼬리행 뒤) 별도 블록으로 빠지던 결함 제거 — HWPX 파서와 같은 3×1·5×3 HTML 표.
  - **1칸 틀**: 다른 클립을 품고 **네 변에 획**이 있는 홀로 선 클립은 1×1 그리드(선서문·각서류의
    바깥 틀), 그런 틀 안에 홀로 든 획 있는 클립은 그 중첩표. 획 없는 바깥 틀 안에 획 있는 상자
    하나만 있으면(선서문) 그 상자만 1×1 표로 낸다. **획 조건이 핵심** — 한컴은 본문 영역(여백
    안쪽 전체)에도 클립을 깔고 그 안에 페이지의 모든 표·칩이 들어가므로, 획 없는 컨테이너를 틀로
    보면 페이지가 통째로 1×1 표가 된다(채용공고 PDF 실측 회귀, pair 게이트 0.985 → 0.87). 테두리
    없는 1칸 틀은 본문 영역과 구분할 수 없어 표로 삼지 않는다(문서화된 한계).
  - 같은 사각형이 문단마다 반복 클립되는 것(틀 3회·1칸 표 2회 실측)은 좌표로 중복 제거 — 중복을
    남기면 1칸 표가 이웃도 포함도 아닌 단독 클립 여러 개로 흩어져 묶이지 않는다.
- **HWP5 한컴 PUA-A 접힘 해제 (`record.ts`)** — HWP5 문자는 2바이트 WCHAR 라 한컴 Supplementary
  PUA-A(U+F0000대) 기호를 담을 수 없고, 한컴은 U+A000 + (code − 0xF0000) 으로 접어 저장한다(이 글자
  음절 블록). 결재란 "(인)"(U+F012B) 이 U+A12B 로 들어 있어 `ꄫ` 로 새던 것을 펴서 `mapPuaText`
  표에 넘긴다(→ "(인)", rhwp export-hwpx 와 동일). 접힘 영역은 관찰된 U+A000~U+A48C 만. 매핑 없는
  코드(U+A0E1 → F00E1)는 종전 PUA-A 정책대로 제거 — 한컴 PDF 도 그 자리에 텍스트를 찍지 않는다.
- **`bench/cmp-hwp-pdf.mjs`** — 같은 서식의 HWP5 원본과 PDF 를 양쪽 파싱해 표 셀 텍스트 집합의
  Jaccard 를 내는 보고용 지표(중첩표는 `collectIrGrids` 로 재귀, HWP5 flatten 비대칭은 헤더에 명시).
  `--linebreaks` 는 PDF 셀 안 줄바꿈 자리가 HWP 원문에서 공백(어절 경계)인지 아닌지 센다.
- **`bench/collect-licbyl.mjs`** `--knd=1`(별표) 와 `--exclude=dir,…`(형제 코퍼스 일련번호 중복
  제외). 2차 코퍼스 `licbyl2/`(seed 20260906, 서식 279쌍 — 표본 풀 소진으로 300 미달) 와
  `licbyl-byl/`(별표 90쌍) 수집 → rhwp v0.8.6 `export-hwpx` 변환 → 게이트 편입.

### Changed

- **HWP5 `flattenLayoutTables` 가 서식 틀은 해체하지 않는다** — 중첩표를 품고 글이 600자 이하인
  표(별지서식 3×1 틀: 제목행 + 틀(발신명의|직인 중첩) + 꼬리행)는 레이아웃 표가 아니라 서식 그
  자체다. HWPX 파서·PDF 와 같은 모양으로 남긴다. licbyl HWPX IR 295문서 605표 전수: 해체 후보
  45(3×1 29·2×1 11·3×2 5), 그중 중첩표 동반 33 — 페이지 사슬 레이아웃 표는 글이 많아 종전대로
  해체된다(비-licbyl 코퍼스에서 걸리는 표는 채용공고 채용분야 3×2·소식지 카테고리 2×2 등 서식류만,
  600자 초과 동의서 3×1 은 종전대로). 1열 다행 표 52건(다행 셀 51)은 줄 단위 렌더 유지 — 잃는 것은
  행 경계뿐이라 렌더 정책은 두었다. HWPX 게이트 1.0·roundtrip 게이트 무변화.
- **표기법 검수 2룰 좁힘** (실결재 기안문 206건 + 별지서식 595건 실측) — `TILDE_SPACE` 는 숫자·
  날짜·시각 범위(앞 숫자·온점·괄호·년월일시분, 뒤 숫자·연도 생략부호)에만: 기입란 "기간( 부터 ~
  까지)"·"공사기간: ~"·"3인 ~ 최대 4인" 제외(기안문 32 → 27, 서식 47 → 30). `DUEUM_ERROR` 는 서식
  기입란("    년도", "( 년간)", "2026 년도")과 셀 하나가 "년도" 뿐인 표 머리글 제외(서식 28 → 2,
  기안문 0 유지). `MONEY_NO_HANGUL`·`LOANWORD_ERROR`·`DISCRIMINATORY_TERM` 은 기안문 206건에서
  0건 — 오탐 근거 없어 그대로. `END_MARK_MISSING` 4건은 실제 "끝." 없음(진양성).
- **양식 인식기(`form/recognize.ts`)가 셀 `blocks` 의 중첩표를 훑는다** — 1칸 틀 안 신청인 정보
  표의 라벨-값이 최상위만 볼 때 통째로 빠졌다. `fillHwpx` 의 중첩표 DFS 와 같은 경계.
- `bench/pdf-table-gt.mjs` 플로어 상향 잠금: exact 0.65 → 0.85, cellF1 0.72 → 0.94, cellExact
  0.72 → 0.97, contentNED 0.525 → 0.94 (v4.12.1 실측치가 코드에 반영되지 않은 채 11차 플로어가
  남아 있었다).
- `bench/corpus/` +1,095파일: `licbyl2/` 837(HWP5 279 + PDF 279 + HWPX 268 + manifest),
  `licbyl-byl/` 271, `known-false-miss/` +11(licbyl2 rhwp 변환본 — HWP5 쌍 유사도 1·미스 문자열
  전부 파서 출력에 있음 → GT 정렬 아티팩트, README 기록). 별표 90쌍은 격리 0건.

### 검토만 (변경 없음)

- **PDF 셀 안 원문 줄바꿈 결합** — licbyl 300쌍 4,436 줄바꿈 자리를 HWP 원문과 대조하면 어절
  경계(공백) 85%·글자 단위 줄나눔(공백 없음) 13%·미발견 2%. 한글 기본 줄나눔은 글자 단위라 PDF
  에는 공백 유무 신호가 없다 — 공백으로 잇든 붙여 잇든 한쪽 13~85% 가 틀리므로 원문 줄바꿈을
  그대로 둔다(`cmp-hwp-pdf.mjs --linebreaks` 로 재현).
- **테두리 없는 1칸 틀**(선서문 바깥 틀) 은 본문 영역 클립과 구분 불가 — 위 Added 항 참조.

## [4.12.1] - 2026-09-05

법령 별지서식(법제처 별표·서식) 파싱을 세 포맷에서 맞췄다. 법제처 OpenAPI(`licbyl`)로 서식
300건의 HWP5 원본과 PDF를 쌍으로 모으고(`bench/collect-licbyl.mjs`), rhwp v0.8.6 CLI
(`export-hwpx`)로 HWPX 변환본을 붙여 900파일 코퍼스 `bench/corpus/licbyl/` 을 게이트에 편입했다.
HWP↔PDF 셀 텍스트 일치(Jaccard)는 0.79 → 0.92, PDF 표 GT 게이트는 cellF1 0.727 → 0.896,
cellExact 0.728 → 0.962, contentNED 0.531 → 0.831 로 올랐다.

### Added

- **PDF 셀 클립 그리드 (`src/pdf/clip-cells.ts`)** — 한컴 PDF 는 표 셀마다 `W n`(clip + endPath)
  사각형을 깔고 그 안에 글을 찍는다. 별지서식 외곽 표는 테두리 "없음" 셀이라 획 괘선이 없어
  line 파이프라인이 표를 못 잡고 제목·기입란이 헤딩과 문단으로 흩어졌다. `extractLines` 가
  클립 사각형(`clipRects`)을 함께 수집하고, 서로 변을 맞대는 클립 묶음을 **셀 기하가 확정된
  그리드**(`TableGrid.cells`)로 만들어 선→교차점→클러스터 경로를 건너뛴다. 전 페이지를 한
  그리드로 합칠 때 행마다 다른 열 경계가 `MIN_COL_WIDTH` 병합으로 뭉개지던 것(도선사면허
  신청서 23열 → 13열)도 사라져 HWP 파서와 같은 23열·같은 병합 구조가 나온다.
  - 포함 관계로 층을 나눈다 — 각 클립의 부모(자기를 품는 가장 작은 클립)가 같은 것끼리만
    이웃으로 묶는다. 지정서·영치증의 1칸 테두리 틀은 위 제목행·아래 꼬리행과 한 표의 셀이 되고
    (HWP 파서의 1열 표와 같은 모양), 안쪽 "발신명의 | 직인" 표는 별도 그리드가 된다. 틀 안 자유
    문단이 바깥 격자로 찢기거나(4열) 클러스터 표 감지에 걸려 가짜 6열 표가 되던 결함 제거.
  - 틀과 면적 절반 이상 겹치는 line 그리드는 버린다 — 틀 괘선이 위 행 외곽선과 이어져 line
    경로가 틀보다 크게 잡던 경우(영치증)까지 포함. 겹친 바깥 부분은 클립 그리드가 이미 셀로 담고 있다.
  - 클립 그리드는 셀이 확정된 실제 표라 1행·1열 스킵, 프로즈 박스·의사 표 강등을 적용하지
    않는다. 처리 순서는 클립 그리드(면적 오름차순 — 중첩표가 바깥 셀보다 먼저) → line 그리드
    (블록 순서는 마지막에 Y 로 재정렬).
- **PDF 심볼 폰트 글리프 복원 (`src/pdf/symbol-fonts.ts`)** — 처리절차 화살표·체크박스를
  Wingdings 로 찍은 PDF 에서 pdfjs 가 코드를 Latin-1 문자로 돌려줘 `è` 가 남았다.
  operatorList 로드 뒤 `page.commonObjs` 의 폰트 실명이 Wingdings 이면 0x21~0xFF 코드를
  유니코드로 되돌린다(➔ □ ✔ ☑ …). Wingdings 2·3, Webdings 는 코드표가 달라 매핑하지 않는다.
- **공문서 표기법 검수 6룰** (`gongmun-lint.ts`, pyhwpxlib Gongmun 검사·hwpx-skill 대조) —
  `MONEY_NO_HANGUL`(금액 괄호 한글 병기, 규정 시행규칙 제2조), `TILDE_SPACE`(물결표 앞뒤
  붙여쓰기), `DUEUM_ERROR`(어두 '년도·년간' → '연도·연간'), `LOANWORD_ERROR`(외래어 오기 40종,
  표준 표기를 suggest 로), `DISCRIMINATORY_TERM`(차별·비하 표현 25종 → 순화어),
  `END_MARK_MISSING`(붙임 있는데 "끝." 없음 — `kordoc lint` 문서 검사 전용, generate 경고에서는
  official 프리셋이 "끝."을 자동 방출하므로 끔). `lintGongmunText(text, { document })` 옵션 추가.
- **내부결재 문서의 발신명의 생략** — `docHead.to` 가 "내부결재"면 결문에 발신명의를 적지 않는다
  (행정업무규정 시행규칙). `isInternalApproval()` 수출.
- **`bench/collect-licbyl.mjs`** — 법제처 별표서식 목록 API 균등 보폭·결정적 표본 수집기
  (같은 seed 면 같은 표본, '삭제'·'…으로 이동' 자리표시 서식 제외, 법령당 2건 상한).

### Fixed

- **기입 빈칸 "년   월   일" 이 "년월일" 로 붙던 것** — 균등배분 정리("현 장 대 응 단 장")가 한
  글자 토큰 3개 이상을 무조건 이었다. 한 글자 토큰이 전부 날짜·시각 단위(년월일시분초)면
  기입란으로 보고 붙이지 않는다. HWP/HWPX(`sanitizeText`)·PDF(`collapseEvenSpacing`) 공통.
- **1열 다행 표의 셀 안 줄바꿈** — 청구서류의 1열 틀 표는 셀 하나에 기입 항목이 줄마다 들어
  있는데 공백으로 이어 "1. 소속 2. 성명 3. …" 한 줄로 뭉개졌다. 줄을 줄로 남긴다.

### Changed

- `bench/corpus/licbyl/` 900파일(HWP5 300 + PDF 300 + rhwp HWPX 297) 게이트 편입. rhwp 변환본
  가운데 부동 표를 section 첫머리에 쓰는 등 문서 순서가 시각 순서와 어긋나 자기참조 GT 정렬이
  깨지는 3건은 `known-false-miss/` 로 격리(파서 출력은 HWP5 원본과 동일).
- rhwp `tools/forms/일반기안문_서식.hwpx` 최신본은 header.xml 에 제어문자(0x01)가 섞여 있어
  들여오지 않았다(번들 서식은 종전 그대로).

## [4.12.0] - 2026-08-30

v4.11.0 이 걷어낸 HWP3 유실의 **잔여 전량**을 처리했다. rhwp `samples/` 의 HWP3 원본 9종을
한컴 변환본과 문자 멀티셋으로 대조했을 때, 이제 변환본에만 있는 문자는 그림 대체텍스트를
빼면 **0** 이다.

### Added

- **HWP3 그리기 개체 안 글상자 텍스트 회수 (#73)** — ch=11(그림) 제어 문자의 확장 블록은
  `pic_type`(info[74])이 3 이면 그림이 아니라 **그리기 개체 트리**다. 표지 제목·순서도 라벨
  처럼 눈에 잘 띄는 본문이 그 안 글상자에 들어가는데, 종전에는 블록을 통째로 건너뛰어
  통째로 사라졌다(hwp3-sample16 618자, sample19 86자, hwp3-curve 221자).
  새 `src/hwp3/drawing.ts` 가 프레임 헤더 → 도형 레코드 트리(`connection_info` bit0=형제·
  bit1=자식)를 훑어 글상자 문단 리스트를 모으고, 본문과 같은 문단 파서로 읽는다.
  - 비-글상자 도형도 '글상자로 만들기' 면 공통 헤더 뒤에 같은 블록(스펙 11.3 표 78)을
    싣고 전체 길이를 `header_length` 로 선언한다 — 잉여 길이가 표 78 과 **정확히**
    맞아떨어질 때만 회수하고, 아니면 종전대로 건너뛴다 (rhwp #5141·#5558 규칙).
  - 트리 해석은 **확장 블록 슬라이스 안에서만** 이뤄진다. 본 스트림은 이미 그 길이만큼
    전진했으므로 어떤 실패도 본문 문단 스트림의 동기를 깨지 않는다 — 실패하면 경고 한 줄과
    함께 종전 동작(통째로 건너뛰기)으로 되돌아간다.
  - 재귀 상한 256단계·도형 4,096개 상한. `has_child` 는 파일에서 온 값이라 상한이 없으면
    중첩 컨테이너 하나로 스택을 고갈시킬 수 있다 (rhwp #4285).

### Fixed

- **비가시 마커가 대체 문자로 새던 것** — 새 번호(19)·쪽 번호 위치(20)·쪽 감추기(21) 제어
  문자 자리에 U+FFFC(￼)를 본문으로 심어 마크다운에 그대로 남았다. 한글도 그 자리에 아무
  글자를 내지 않는다(rhwp #4957). 차례 표식(25) 과 같은 계약으로 맞춘다 — samples 33개 중
  6문서 11건.

### 검증

| 문서 | v4.11.0 | v4.12.0 |
|------|---------|---------|
| hwp3-sample16 | 618 | **0** |
| hwp3-sample19 | 0 | 0 (+86자 회수) |
| hwp3-sample10 | 11 | 11 (전부 그림 대체텍스트·U+FFFD) |
| 나머지 6종 | 0 | 0 |

samples 33개 전수에서 그리기 개체 워커가 예외를 던진 문서는 없다. 테스트 1,570 pass(신규 10),
코퍼스 게이트 59/59 PASS.

## [4.11.0] - 2026-08-29

HWP3 텍스트 추출에서 **글자가 조용히 사라지던 경로**를 걷어냈다. rhwp 최신 devel
(v0.8.3~0.8.4) 대조에서 나온 결함들로, 매핑을 못 찾은 문자를 파서가 경고 없이
건너뛰기 때문에 "성공했는데 본문이 비는" 형태로만 드러난다.

### Fixed

- **HWP3 기호·한자가 통째로 사라지던 결함** — kordoc 의 johab 디코더는 rhwp 에서
  포팅할 때 하드코딩 표만 가져오고 **완성형 좌표 규칙 두 개를 빠뜨렸다.** HWP3 은
  KS X 1001 기호행(0xA1~0xAC)을 행 간격 96, 한자행(0xCA~0xFD)을 행 간격 94 로 편
  코드로 문자를 담는데, 이 규칙이 없으니 표에 없는 코드는 전부 미매핑 → 삭제였다
  (`채권(債權)조서` → `채권()조서`). rhwp `decode_hwp3_ksc_symbol`·
  `decode_hwp3_ksc_hanja` 를 이식하고, 표준 매핑과 한컴 표기가 갈리는 두 자리
  (∼→～, ⊙→◉)를 보정한다.
- **HWP3 사적 코드 실측 표 확장** — 라틴 확장(0x00A0~0x00FF, ü·ö·ä·ß 가 지워져
  "für"→"fr" 이 되던 것, rhwp #5555)과 rhwp #5860 의 실측 28코드를 이식하고,
  rhwp 표에도 없던 코드를 kordoc 이 직접 실측해 더했다 — 괘선 조각 6종
  (0x3013·0x3014·0x3015·0x3019·0x301B·0x301D), 겹줄 0x37ED, 원문자·괄호문자 계열
  (0x2E00·0x2E01~0x2E07·0x2E0A~0x2E12·0x2C21~0x2C26·0x2C40~0x2C42), 글머리표
  0x2022·0x2F17, 장식 0x2F06. 근거는 rhwp `samples/` 의 HWP3 원본 ↔ 한컴 변환본
  문맥 정렬이며, 코드별 출현 횟수가 변환본의 해당 문자 개수와 정확히 맞는 것만 실었다.
- **초성이 '채움'인 아래아 음절 유실** — 초성 없이 아래아만 있는 음절(0x87C1 등)을
  무효 초성으로 보고 통째로 버렸다. 한컴 변환본과 같이 자모 하나(U+119E)로 남긴다.
- **서식 run(span)이 PUA 정리를 건너뛰던 결함** — 굵게·밑줄 등 서식이 걸린 문단은
  `spansToMarkdown` 경로를 타는데 여기서만 PUA 치환·제거를 하지 않아, 한컴 전용
  글머리표·괘선 조각이 원시 PUA(두부 문자) 그대로 마크다운에 실렸다. HWP5·HWPX·
  HWP3 전 포맷 공통 경로다 (hwp3-sample10 변환본 1개 문서에서 116자).
- **한컴 PUA 검증표 동기화** — rhwp `VERIFIED_HANCOM_PUA_DISPLAY`(한컴 PDF 대조 확정)
  에서 kordoc 에만 빠져 있던 22종 추가: 괘선 조각 ┌┬┐└┘│·┈·═·━, 별도 글리프
  원숫자 ⓪①②④~⑨, 글머리표 ✺·◇·▸·□, ⊞·⊟. 매핑이 없으면 `sanitizeText` 가
  지우므로 누락은 곧 글자 증발이다.

### 검증

rhwp `samples/` 의 HWP3 원본 9종을 같은 문서의 한컴 변환본(HWP5/HWPX)과 문자
멀티셋으로 대조했다. 변환본에만 있는 문자(=kordoc 이 HWP3 에서 잃은 문자) 기준:

| 문서 | 이전 | 이후 |
|------|------|------|
| hwp3-sample | 7 | 0 |
| hwp3-sample5 | 4 | 0 |
| hwp3-sample10 | 172 | 11 (이미지 대체텍스트·U+FFFD) |
| hwp3-sample11 | 189 | 0 |
| hwp3-sample14 | 7 | 0 |
| hwp3-sample16 | 1,139 | 618 (그리기 개체 안 글상자 — 아래 참조) |

남은 618자는 HWP3 **그리기 개체 안 글상자**(표지 제목·순서도 라벨)로, kordoc 은
그리기 개체를 통째로 건너뛴다. rhwp 는 #5558 에서 이 경로를 복구했고, kordoc 이식은
별도 작업으로 둔다.

## [4.10.0] - 2026-08-28

### Added

- **실패 계약 전 포맷 확장 (#69)** — 실패 JSON(`success:false` + `code`)을
  `--format json` 전용에서 markdown·chunks 포함 전 포맷의 stdout 계약으로 확장.
  헤드리스 호출자가 stderr 한국어 문구 대신 원인 코드로 분기한다. code 집합·종료
  코드·안정성 보증을 README 표로 문서화.
- **`images/manifest.json` (#70)** — 이미지 저장 시 name/mimeType/bytes/source 를
  방출한다. mimeType 은 매직바이트 실측 우선, `ExtractedImage.source`(원본 컨테이너
  항목명) 추가. DOCX 미지 확장자의 `image/png` 오폴백을 실측 스니프로 교체.

### Fixed

- **patchHwp soft-wrap 무결성 (#71)** — soft-wrap(2세그 이상) 문단을 단일 행으로
  줄일 때 잔존 `LINE_SEG` textpos 가 새 nChars 밖을 가리켜 한컴이 "손상/변조"로
  열기를 거부했다. 범위 밖 꼬리 세그먼트만 잘라내고 `lineSegCount` 를 정합화한다.
  재작성 압축 스트림에 한컴 8바이트 꼬리(CRC32+비압축 크기)도 복원(코퍼스 7/7).

## [4.9.2] - 2026-08-24

### Fixed

- 다줄 `<right>` 출처행이 본문폭을 넘으면 왼쪽 끝이 들쭉날쭉해지던 것 — 조판 폭을
  미리 계산해 한 줄이면 우측 배치, 넘치면 LEFT 로 방출한다.
- 출처:/자료: 캡션 전용 charPr 신설 — 본문 −3pt(하한 10pt). 발신일자 등은 본문 크기 유지.

## [4.9.1] - 2026-08-22

실제 자치구 검토보고서를 HWPX 로 뽑아 한컴으로 열어 확인한 결함 3건. 셋 다 양식
파일 하나의 저장값을 실무 관행보다 앞세운 것이 원인이다.

### Fixed

- 리스트 문단 위 간격(□15/○10/-6pt)을 코퍼스 실측 최빈값(0)으로 되돌림 — 줄간격
  160% 에 더해져 항목 사이가 1.4줄로 벌어졌다. □ 만 절 구분용으로 실측 2위 300 유지.
- h3·h4 소제목이 대항목보다 왼쪽에 놓여 계층이 사라지던 것 — h2 부호폭만큼 들여쓴다.
- '붙임 1.' 다음 들여쓴 '2.' 가 마크다운 리스트로 잡혀 번호가 항목부호로 치환되던 유실.

### Added

- **`munche-lint.ts`** — 개조식 문체 검수 12룰(서술형 종결·당위·수사·대구·항목/결론
  길이·리드문). 보고서·계획서·개조식 프리셋의 generate 경고 + `kordoc lint --munche`.
  기안문(경어)·통지·회의록·보도자료는 문체 관행이 달라 제외.

## [4.9.0] - 2026-08-17

### Added

- **공문서 AI 슬롭 lint 2룰** — 줄표 사용(`AI_EM_DASH`), 한 줄 볼드 3회 이상
  (`AI_BOLD_OVERUSE`). 편람 13룰 원전과 구분되는 kordoc 자체 조언 룰.

### Fixed

- reflow 렌더가 `<hp:p pageBreak="1">`(한컴 '쪽 나누기')을 무시하고 이어 그리던 것 —
  해당 문단부터 새 페이지로 조판한다.

## [4.8.1] - 2026-08-17

`kordoc lint` 가 문서 파일을 텍스트로 읽어 검수하던 것을 차단하고, 문서에서 빠져 있던 CLI 기능을 채웠다.

### Fixed

- **`kordoc lint <문서파일>` 이 압축 바이트를 본문으로 검수** — lint 는 입력을 UTF-8 텍스트로 읽는다. hwpx(ZIP)를 그대로 넘기면 압축 바이트가 본문으로 둔갑해 위반이 수백~수천 건 나왔다(README 가 예제로 싣고 있던 `kordoc lint 보고서.hwpx` 실측 1,193건). "검사 못 함"보다 "검수 결과처럼 보이는 쓰레기"가 나쁘므로, `detectFormat` 으로 판정해 텍스트가 아닌 입력은 읽기 전에 거절하고 파이프 사용법을 안내한다. stdin(`-`)은 종전대로 동작한다

### Docs

- README(한/영)에 문서화되지 않았던 CLI 기능 반영 — `fill --formats`·`--require-unique`·`--mask`, `redact --mask-char`, `render --reflow-mode`, `check-ocr-models`·`check-formula-models`. 두 `check-*` 커맨드는 이름과 달리 **없으면 내려받는다**(수식 모델 ~155MB)는 주의 병기
- 영문 README 에 통째로 빠져 있던 `redact`·`profile`·`models` 커맨드 추가 — 한글판과 동기화
- 라이선스 절에 Pix2Text(YOLOv8 AGPL-3.0 주의) 추가 — NOTICE·THIRD_PARTY 에는 있으나 README 에만 누락돼 있던 고지
- 지원 포맷에 이미지(PNG/JPG/WebP) 행 신설, `parseImage`·고급 함수 8종·타입 18종 표 보강
- v3.6.0 항목에 잘못 복제돼 있던 "서식 프로필"(실제 도입은 v3.18.0) 삭제
- 서식 프로필 기여자 표기를 실제 GitHub 핸들로 정정 — `@chiclooc-rgb` → [@ai-localgov-officer](https://github.com/ai-localgov-officer) (PR #42·이슈 #41 의 author)

## [4.8.0] - 2026-08-16

`--format json` 결과에 페이지별 마크다운을 기본 포함 (#68, @sorbetsharkroundhand 제안).

### Added

- **`ParseSuccess.pages`**: `[{ pageNumber, markdown }]` 배열. `parse()` 가 이미 만든
  `IRBlock.pageNumber` 로 블록을 갈라 페이지마다 `blocksToMarkdown()` 을 돌린 사영이라,
  문서를 다시 파싱하지 않는다. 실측 비용은 파싱 시간의 1% 미만
  (24쪽 PDF 기준 parse 399ms / pages 2.5ms). 페이지 경계의 신뢰도는 v4.7.3 의
  `metadata.pageMode` 를 그대로 따른다 — `"layout"` 이면 실제 쪽, `"section"` 이면 섹션 근사.
- **`blocksToPages(blocks)`** 공개 API: 포맷별 파서(`parsePdf` 등)를 직접 부르는 호출자가
  같은 값을 직접 얻을 수 있다.

### 동작 세부

- `--pages 3-5` 로 범위를 줄이면 `pages` 에도 3~5쪽만 담긴다.
- 페이지 번호를 매기지 않는 포맷(DOCX 등)에서는 `pages` 자체가 없다 — 전부 1쪽이라는
  없는 사실을 만들지 않는다. XLSX 는 종전 `pageCount` 와 같은 의미로 **시트**가 한 쪽이다.
- 여러 페이지에 걸친 표는 현 IR 구조상 시작 페이지의 한 블록이라, 표가 이어지는 중간
  페이지의 `markdown` 은 빈 문자열이다. 이때도 항목 자체는 남긴다 — 빼 버리면 소비자가
  배열 길이로 쪽수를 셀 수 없다. 페이지별 표 분할은 별도 기능으로 둔다.
- 페이지 번호가 없는 블록은 **직전 블록의 페이지에 이어붙인다.** 어느 쪽에도 안 실려
  조용히 사라지는 블록이 없도록. 실코퍼스(hwpx·hwp·pdf·xlsx) 대조에서 페이지 마크다운
  합집합의 문자 보존율 100%.
- `--format json` 페이로드의 **텍스트 분량은 대략 2배**가 된다(전체 마크다운 + 페이지별
  사본). 이미지 바이트와 달리 본문 텍스트라 #65 의 직렬화 한계와는 자릿수가 다르지만,
  JSON 을 그대로 저장·전송하는 파이프라인이면 감안할 것.

## [4.7.3] - 2026-08-13

### Added

- **HWP/HWPX 실제 페이지 경계 복원 (#66)**: 한컴 저장본의 조판 캐시(HWPX `linesegarray` /
  HWP5 `PARA_LINE_SEG`)로 실제 페이지를 복원한다. `pageCount`·블록별 `pageNumber` 가 섹션
  근사가 아닌 실제 쪽 번호가 되고, `parse(buffer, { pages: "3-5" })` 가 실제 3~5쪽을 낸다.
  신호 4종(vertpos 역행·명시 쪽나눔·분할 표의 셀 흐름 리셋·분할 직후 이중 카운트 억제) 결합.
- **`metadata.pageMode`** (`"layout" | "section"`): 페이지 경계의 신뢰도. 조판 캐시가 없는
  생성 파일은 종전대로 섹션 근사로 동작하며, 근사 상태에서 `pages` 필터를 쓰면
  `PAGE_BOUNDARY_APPROXIMATE` 경고가 붙는다.

## [4.7.2] - 2026-08-07

폐쇄망(내부망) 배포 대응 — 아웃바운드 통신 킬스위치, 파일 접근 루트 제한,
모델 오프라인 사이드로드, 오프라인 설치 번들.

### Added

- **`KORDOC_OFFLINE=1`**: 모든 아웃바운드 통신(OCR 모델 다운로드, watch webhook)을
  요청 발신 전에 차단한다. 감사 지점을 `src/shared/offline.ts` 한 곳으로 모아, 새
  통신 경로가 생겨도 이 관문을 통과하도록 강제한다.
- **`KORDOC_ROOT=<디렉토리>`**: MCP 서버의 파일 읽기·쓰기를 해당 디렉토리 하위로
  제한한다(opt-in — 미설정 시 기존 동작 유지). 판정은 realpath 기준이라 심볼릭
  링크로 벗어날 수 없고, 형제 prefix 디렉토리도 통과하지 않는다.
- **`kordoc models --export/--import/--status`**: OCR·수식 모델을 SHA-256 검증과 함께
  디렉토리로 내보내고 반입한다. 오염된 반입 매체의 모델은 캐시에 설치되지 않는다.
- **`scripts/pack-offline.mjs`**: 런타임 의존성이 설치된 상태의 오프라인 tarball을
  생성한다(`--with-ocr`, `--with-models`). 내부망에서 압축만 풀면 실행되며 npm
  레지스트리가 필요 없다. 설치 안내 `INSTALL.md` 동봉.
- **`docs/offline-deployment.md`**: 폐쇄망 배포 절차 + 보안성 검토용 근거(아웃바운드
  통신 전량 목록과 재현 가능한 검증 명령, 데이터 흐름, 체크리스트).

### Changed

- 폐쇄망 모드에서 `kordoc setup` 은 MCP 를 `npx -y kordoc mcp` 대신 설치된
  `dist/mcp.js` 절대경로로 등록하고, `KORDOC_OFFLINE`·`KORDOC_ROOT` 를 설정 파일의
  `env` 에 함께 기록한다.
- MCP 서버가 기동 시 적용된 제한을 stderr 에 1회 표기한다.
- SECURITY.md 를 현행 코드 기준으로 재작성(지원 버전, 리소스 한도 실측값, 아웃바운드
  통신 목록, 모델 무결성). 번들에 인라인된 `cfb` 관련 옛 제약 서술은 폐기.

### Security

- 의존성 취약점 정리 — `npm audit --omit=dev` 0건. `sharp` ^0.35.0 상향(libvips CVE
  4건), `adm-zip` ^0.6.0 override(onnxruntime-node 경유 4GB 할당 이슈), MCP SDK 체인의
  `ip-address`·`fast-uri`·`hono` 권고 해소. 남은 `esbuild` low 는 빌드 전용 의존성.

## [4.7.1] - 2026-08-05

밑줄 보존을 전 포맷으로 확장 + PDF 링크 어노테이션 추출.

### Added

- **HWPX·HWP5 밑줄 md 방출**: v4.7.0 이 PDF 에서 복원한 밑줄을 HWPX(charPr
  span 단위)·HWP5(대표 스타일 문단 단위)도 `<u>…</u>` 로 방출한다 — IRSpan/
  InlineStyle 에 `underline` 추가, 강조 조합은 `<u>**…**</u>`/`<u>~~…~~</u>` 로
  중첩. 판별자는 밑줄 **종류**(HWPX `type="BOTTOM"` / HWP5 attr bit 2-3 == 1) —
  한컴은 밑줄 없는 charPr 에도 `type="NONE"` 요소를 넣으므로(코퍼스 352파일
  실측: NONE 15,603 / BOTTOM 156) 존재 여부만 믿으면 오탐, 윗줄(TOP)·미지 값은
  fail-closed. 생성 경로(md→hwpx)는 취소선과 동일하게 `<u>` 마커를 평문화.
- **PDF 링크 어노테이션 추출** (`src/pdf/links.ts`): `/Annots` 의 Link(`/URI`)
  rect 를 텍스트와 상관해 `[text](url)` 로 방출. sanitizeHref 스킴 화이트리스트
  (https/mailto/tel)·괄호 percent-encoding·겹침 어노테이션 이중 래핑 방지.
  여러 줄에 걸친 링크는 줄마다 같은 url 로 래핑.
- **외부 벤치 스크립트** (`bench/odl-bench.mjs`): opendataloader-bench(200
  PDF, TEDS/NID/MHS) 예측 생성기 — 측정용, 게이트 아님. 실측(2026-08-05):
  overall 0.669 · NID 0.822 · TEDS 0.553 · MHS 0.300 (국제 영문 위주 코퍼스 —
  한국 공문서 특화 튜닝 그대로의 결과, 상세는 스크립트 헤더).

### Fixed

- `package-lock.json` 버전 동기화 (v4.7.0 릴리스에서 package.json 만 범프되어
  release-metadata 테스트가 잡던 드리프트).

## [4.7.0] - 2026-08-05

PDF 밑줄 보존 — 개정문·심사보고서·계획서의 밑줄 강조 복원.

### Added

- **PDF 밑줄 감지** (`src/pdf/underline.ts`): baseline 바로 아래 밀착한 얇은
  수평선을 텍스트와 상관해 `<u>…</u>` 인라인 HTML로 보존한다. PDF에는 밑줄
  폰트 플래그가 없어 밑줄이 별도 그래픽(선/얇은 사각형)으로 그려지는데, 기존
  파서는 이를 전부 버렸다 (취소선 `~~`는 v3.0부터 보존 — 그 짝). CJK 밑줄이
  전각 박스 하단(~0.67em)까지 내려가는 조판 특성 반영
  (firecrawl/pdf-inspector underline 휴리스틱 참조, MIT). 표 괘선·장식 오탐
  방어 5겹 — ① 수직선 접촉(표 그리드/폼 박스), ② 동일 스팬 반복(수평 괘선만
  쓰는 서식), ③ 매칭 런 union 밀착(containment+coverage — 셀 패딩·빈 열까지
  걸치는 행 괘선 배제), ④ 런 사이 컬럼급 구멍(표 행), ⑤ 상하변 마주봄(라운드
  배지/칩의 하변 — 곡선 모서리라 수직선 접촉 방어를 비껴가는 케이스). 코퍼스
  실측: 48문서 중 32문서에서 부서명·각주 강조·절 제목·본문 부분 강조 밑줄 복원
  (원문 렌더 대조 검증), PDF 커버리지 게이트 베이스라인 동등(0.99581)·표 GT
  게이트 동등. 벤치 정규화(`bench/lib/normalize.mjs`)는 `<u>` 태그를 `<img>`·표
  태그와 동일하게 채점 전 제거(서식 마커는 콘텐츠가 아님 — 양쪽 동일 적용 대칭).

## [4.6.1] - 2026-08-04

2단 지면(시험지·잡지형) 읽기 순서 수리 — #64 후속.

### Fixed

- **2단 지면 읽기 순서** (#64, @choa712 블록 덤프 제보로 원인 확정): 좌·우 단이
  행 단위로 인터리브되던 문제. 원인은 두 겹 — ① 그리드 경로의 최종 정렬이 XY-Cut
  그룹·표 블록을 전역 Y로만 재정렬해 단 순서를 도로 섞었고, ② 기존 2단 검출
  (`findTwoColumnProseCutX`)이 속기록류 프로즈 전용 가드(justify·마커 희박·긴 줄)라
  선지 마커(①~⑤)가 많은 시험지에서 불발해 XY-Cut 의 수평 우선 축 선택으로 흘렀다.
  텍스트 특성 없이 기하 신호만 보는 거터 검출(`two-column.ts` — 중앙 빈 띠 +
  좌우 요소수·높이합·수직범위·폭 대칭)을 신설하고, 검출 시 전폭 요소(머리글 표·
  쪽번호 박스)를 밴드 경계로 삼아 밴드 안에서 좌단 전체 → 우단 전체로 배열한다.
  그리드 경로(기본 모드)·폴백 경로(`--no-tables` 포함)·OCR 경로 모두 적용.
  거터 오검출로 일반 문서의 행이 찢기지 않도록 행 구조 가드 3종(크로스 연속 행·
  행 짝 비율·최소 행수)을 코퍼스 실측으로 캘리브레이션 — PDF 커버리지 게이트
  베이스라인 동등(0.99581 vs 0.99583) 확인. 2026학년도 수능 실측(제보와 동일
  파일): `--no-tables` 물리학Ⅰ·생활과윤리 20/20 문항 역전 0(종전 13/3), 국어
  44/45 역전 0(종전 13/3). 기본 모드도 역전 3→1·2→0 — 잔여 누락은 전폭 박스
  오탐 표의 본문 흡수(별건, #64 계속 추적)가 지배 원인.

## [4.6.0] - 2026-08-04

외부 제보 4건 수리 — 중첩 강조, BOM 선행 XML, 이미지 다량 문서의 JSON 출력,
PDF 표 감지 opt-out.

### Added

- **PDF 표 감지 opt-out** (#64, @choa712 제보): `parse(buf, { tables: false })` ·
  CLI `--no-tables` · MCP `parse_document`의 `tables`. 시각적 테두리 박스(2단 시험지의
  안내문·보기 상자)가 선 기반 표로 잡히면 주변 본문이 셀 매핑으로 끌려 들어가 문항
  순서가 뒤집히는데, 표 감지를 끌 방법 자체가 없었다. 끈 경로는 선 그리드·클러스터 표·
  다열 정렬·한국어 특수표를 모두 건너뛰고 자연 읽기순 문단만 낸다 (OCR 경로 포함).
  기본값은 종전 그대로 `true`.
- **`--image-refs`** (#65): `--format json` 에서 이미지 바이트를 base64 로 인라인하지 않고
  저장 경로(`images/<파일명>`)만 남긴다. `-o`/`-d` 로 이미지가 실제로 저장되는 실행에서만
  유효하다.
- **`OUTPUT_TOO_LARGE` 에러 코드**: 결과 직렬화가 런타임 문자열 한계를 넘은 경우.

### Fixed

- **중첩 인라인 강조** (#61 · PR #62, @LeeYudok 제보·수정): `**굵게 *기울임* 다시**` 처럼
  강조 안에 강조가 들어간 마크다운이 `markdownToHwpx` 에서 별 리터럴 노출·굵게 소실·
  서식 역전으로 깨지던 문제. 강조 정규식이 안쪽의 더 짧은 별 run 을 허용하도록 확장하고,
  매칭 내부를 재귀(상한 3)로 분해해 겉 강조 플래그를 OR 한다. 단독 강조·이스케이프·
  snake_case 비활성·미닫힘 폴백은 종전 출력 그대로.
- **선두 BOM 이 붙은 XML 파트** (#63, @soyesenna 제보): 일부 OpenXML 라이터가
  `[Content_Types].xml`·`.rels` 앞에 EF BB BF 를 붙이는데(XML 스펙상 적법 — 엑셀·
  리브레오피스는 정상적으로 연다), xmldom 이 "선언이 문서 시작이 아님" fatalError 로
  파일 전체를 `PARSE_ERROR` 거부했다. XML 프롤로그 정리 지점에서 BOM 을 함께 걷어낸다 —
  xlsx·docx·hwpx·hwpml 파싱 진입점이 모두 이 경로를 지난다.
- **이미지 다량 문서의 `--format json`** (#65, @choa712 제보): 이미지가 수백 장인
  HWP(27~53MB)에서 base64 총량이 V8 문자열 한계를 넘어 `JSON.stringify` 가 RangeError 로
  터졌고, 예외가 파싱 "OK" 로그 뒤 바깥 catch 로 빠져 stdout 이 비었다 — 파이프라인의
  JSON.parse 가 원인 코드 없이 깨졌다. 이제 ① 저장 경로가 있으면 참조 모드로 자동 강등,
  ② 파싱 이후 단계 예외도 `--format json` 이면 실패 JSON(success·fileType·code)을 낸다.

### Notes

- #64 의 "박스 오탐 자체를 줄이는 휴리스틱 확장"은 이번 릴리스에 포함하지 않았다.
  공개 수능 문제지(국어 20p) 실측으로는 표 감지를 꺼도 문항 순서 지표가 거의 그대로였고
  (역전 21→19), 재현에 쓰인 4p 문제지가 없어 원인 분리를 못 했다. 표 감지 오탐과
  2단 읽기순 중 무엇이 지배적인지 가려낸 뒤 손대는 편이 안전하다.

## [4.5.0] - 2026-08-02

마크다운 → HWPX 생성 미지원 6종 도입 — 용지 크기·가로 방향, 다단, 머리말/꼬리말,
하이퍼링크, 각주 개체, 이미지 실데이터 임베드.

### Added

- **페이지 옵션** (`markdownToHwpx` `page`, CLI `--paper/--landscape/--columns/--header/--footer`,
  MCP `generate_document` 동명 파라미터):
  - **용지 크기** — A4·A3·B4·B5·Letter 프리셋 + `{widthMm, heightMm}` 커스텀. 치수는
    한컴 정준값과 같은 내림 환산 (A4 59528×84188, A3 84188×119055).
  - **가로 방향** — `landscape="NARROWLY"` + 용지 치수 유지 (코퍼스 실측 계약: 세로
    문서 전수 WIDELY, 가로 실물 2종만 NARROWLY).
  - **다단** — `colPr colCount=1~8`, 단 간격 8mm(2268HU).
  - **머리말/꼬리말** — `<hp:header>`/`<hp:footer>` ctrl + subList (rhwp 직렬화기와
    동일 형상, 인라인 마크다운 허용). 재파싱 시 본문 앞/뒤 문단으로 왕복.
- **하이퍼링크 필드**: `[text](url)`이 anchor 텍스트로 뭉개지지 않고 실측 6-param
  `HYPERLINK` 필드(fieldBegin Command/Path/Category…+fieldEnd)로 방출 — 한글에서
  실제 클릭 가능, 재파싱 시 `[text](url)` 복원. 표 셀 안 링크 포함, `javascript:` 등
  위험 스킴은 살균 후 텍스트만.
- **각주 개체**: `[^id]` 마커 + `[^id]: 본문` 정의가 `<hp:footNote>`(rhwp 계약 —
  suffixChar 상시 방출)로 방출 — 한글이 페이지 하단에 각주 번호·본문을 실제로 조판.
  정의 없는 마커는 리터럴 보존.
- **이미지 실데이터 임베드**: `images` 옵션(url→바이트)·`data:image/...;base64` URI·
  CLI/MCP `--image-dir`로 PNG/JPEG/GIF/BMP를 BinData에 실제 임베드 — 픽셀 치수
  프로브(96dpi 환산) + 본문폭(170mm) 초과 시 비례 축소. 바이트가 없는 참조는 종전
  1×1 placeholder 왕복 보존 그대로.
- **OCR 관측 채널**: 내장 OCR이 신뢰도<0.5로 무음 폐기하던 라인 수를 `OCR_LOW_CONF`
  경고로 노출 (PDF `ocr:"force"` 경로·이미지 직접 입력 공통) — 인식 결손을 이제
  warnings에서 볼 수 있다.

### Changed

- **OCR 표 채점 모수 교정** (`bench/ocr-accuracy.mjs`): 비어있지 않은 셀이 3개 미만인
  ref 표는 채점 모수에서 제외 — 클립아트 창문 격자(5×6에 2셀)·목차 배경 경계 같은
  장식 벡터 그리드와 1×1 텍스트박스는 "표 구조"가 아니고, 그 텍스트는 recall/CER
  트랙이 이미 채점한다. 제외 수는 `skippedRefTables`로 노출(9건). 교정 후 실측:
  스캔 표 매칭 63.1%→**71.4%**, cellF1 0.50→**0.595**, exact 18.5%→21.4%
  (recall·CER은 불변 — 채점 로직만 교정, 워스트 문서 픽셀 진단으로 근거 확보.
  검토했던 "IR 1개↔ref N개 역방향 병합"은 실데이터에서 발화 조건이 성립하지 않아
  기각 — 억지 허용오차는 채점 완화라 도입하지 않음).
- **PDF coverage 게이트 재기준 0.999→0.9955** (`bench/ref/policy.mjs`): OCR 정확도
  벤치용 신규 pdf 41문서(예산서·성과계획서 등 밀집 표 문서) 편입으로 모수가 바뀌어
  micro 0.99593 실측 — 파서 무변경 상태에서 확인한 모수 변화이며, 새 실측치 바로
  아래로 다시 잠가 래칫을 유지한다.

### Notes

- 페이지 옵션 미지정 시 산출물은 종전과 바이트 동일 (colPr 1단 방출 포함).
- 가로 방향·A4 외 용지에서 표 열폭은 아직 A4 세로 본문폭 기준으로 계산된다 (문서화된
  한계 — 표가 페이지를 넘치지는 않는다).
- OCR 정확도 개선 계획(4.4.1 실측 후속)은 워스트 문서 진단 결과 "가짜 GT(장식 그리드)·
  GT 표 파편화 vs 래스터 통합의 채점 비대칭"이 주 손실원으로 확인되어 임계 튜닝 없이
  관측 채널만 반영 — 진단 기록은 `.claude/plans/next-session-ocr-accuracy-uplift.md`.

## [4.4.1] - 2026-08-02

문서 현행화 + MCP 이미지 입력 수리 + OCR 정확도 첫 실측.

### Fixed

- **MCP 파싱 도구의 이미지 입력 차단 해제**: `parse_document` 설명은 이미지(PNG/JPG/WebP)
  지원을 안내하는데 확장자 allowlist가 이미지를 거부해 **MCP 경로에서만** 막혀 있었다
  (CLI·라이브러리는 정상). 파싱 계열 6종(`parse_document`·`parse_pages`·`parse_table`·
  `parse_chunks`·`parse_metadata`·`detect_format`)에 `PARSE_EXTENSIONS`(문서 + png/jpg/
  jpeg/webp) 적용 — 쓰기·패치 계열은 종전 allowlist 유지. MCP 실호출 재현·수리 확인.

### Added

- **`bench/ocr-accuracy.mjs` — 내장 OCR 정확도 실측 신설**: 코퍼스 PDF의 클린 텍스트층을
  정답 삼아 같은 페이지의 216dpi 렌더를 강제 OCR(`ocr:"force"`)로 대조. 41문서 82페이지
  실측(M-series CPU) —
  | 지표 | 값 |
  |---|---|
  | 문자 recall (micro) | **90.0%** (래스터에 글꼴이 안 그려진 1건 제외 시 94.0%) |
  | 문자 precision (micro) | **95.1%** |
  | 한글 음절 recall | median **99.9%**, 37/41 문서 ≥95% |
  | CER | micro 25.5% · median 17.5% (읽기 순서 차이에 민감) |
  | 표 구조 (텍스트층 표 65개 대비) | 매칭 63.1% · cellF1 0.50 |
  | 속도 | **0.96s/페이지** |
  주의: 정답이 클린 렌더라 실스캔 노이즈·스큐는 미반영(상한치). 측정 함정 2종을 함께
  발견해 채점에 반영 — ① 목차 점선 리더(`·····`)는 텍스트층에만 있는 장식이라 대조 제외
  ② 비내장 글꼴(HY견명조 등)은 pdfium 래스터에 한글이 아예 안 그려져 OCR 아닌 렌더
  충실도를 재게 됨(한글 recall 0% 1건은 이 경우). det 입력 1920 보존 실험은 recall Δ
  median +0.04pp·속도 -25%로 기각 — 현행 960 유지.

### Docs

- 플러그인 스킬의 "OCR을 내장하지 않는다" 문구 현행화(v4.2.0 내장 이후 미갱신) —
  `--ocr`/`ocr:true` 재시도 안내로 교체. README v2.9.0 절에 내장 OCR 이후 상황 주석,
  표 복원 소개 문구를 실측치(HWPX 1,673표 무손실·PDF 대조 완전일치 65.2%) 기반으로 교체,
  서식 프로필 스펙 예시를 0.3.0(`anchor_row`·`fontName_hangul`)으로 갱신.

## [4.4.0] - 2026-08-01

비밀번호 문서 열기(#59) 신설 + "성공했는데 글자가 없다"류 무증상 텍스트 유실 일괄 수리
(HWP3 캡션 desync·CDATA·PUA/johab 미매핑·아래아) + npm 배포본 라이선스 고지 복원.

### Added

- **🔑 비밀번호 문서 열기 (#59)**: 열기 암호가 걸린 **HWPX·HWP3·HWP5**를
  CLI `--password` / API·MCP `password`로 엽니다. 세 포맷의 암호화가 전부 다름 —
  HWPX는 ODF 표준(AES-256-CBC + PBKDF2, 단 한컴은 PKCS#7 패딩을 안 붙이는 변형),
  HWP3는 단일 DES-ECB(Node/OpenSSL3에 단일 DES가 없어 `des-ede3-ecb` 동일키 우회,
  rhwp known-answer로 키 유도 고정), HWP5는 EncryptVersion 4의 비트 단위 CFB.
  틀린 비밀번호는 성공으로 위장하지 않고 `ENCRYPTED`로 실패. HWPX 복호 결과는 평문
  대조본과 바이트 동일 실측. (한컴 DRM 문서보안은 별개, @jangster77 제보)
- **CLI `--format json`이 실패도 JSON으로**: stdout에 원인 코드(`ENCRYPTED` 등)를
  담아 프로그램 소비자가 분기 가능 — 암호 문서에서 비밀번호 입력을 띄우는 류의 연동용.
  사람이 읽는 포맷은 종전대로 stderr 안내.

### Fixed

- **HWP3 그림 캡션 리스트 미소비 — 본문 무증상 대량 유실**: 그림(ch=11) 뒤 캡션 문단
  리스트(캡션이 없어도 43B sentinel이 항상 존재, 스펙 §10.7)를 읽지 않아 그림당
  스트림이 어긋났고, 어긋난 자리가 `char_count=0`으로 읽히면 "정상 종료"로 판정돼
  **경고 0건**으로 나머지를 통째 버렸습니다 — 945KB 문서가 0자. rhwp 정답지 대조
  6종 복구(최대 1,003,199자, 94.8~99.7%). 표 cell_count 고정 상한 256도 실존 문서
  (367셀 표)를 죽여 잔여 스트림 기준 판정으로 교체.
- **CDATA 텍스트 소실**: `<hp:t><![CDATA[본문]]></hp:t>`를 경고 없이 버림 — 텍스트
  수집이 TEXT_NODE만 보고 CDATA_SECTION_NODE를 흘렸고, 공용 XML 헬퍼라
  **HWPX·HWPML·DOCX 세 포맷**에 걸침. 본문 walk·스타일 span·SVG 렌더까지 5개소 수리.
- **매핑 누락 = 글자 증발 — 한컴 검증 PUA 11종 + HWP3 johab 2종**: 결재란
  `(인)`(U+F012B), 2025 행정업무운영 편람 글머리표 ►·■, 사각 안 숫자 ①~⑳,
  머리말 "한글과컴퓨터" 6자, 표 셀 글머리표 ▸ — rhwp가 한컴 PDF 대조로 확정한
  표만 반영(인접 코드 범위 추정 금지: PUA는 대조 없이 채우면 없는 뜻을 지어냄).
- **HWP3 아래아(옛한글) 음절 소실**: 완성형에 대응 음절이 없는 hchar('ᄒᆞᆫ글 97'의
  첫 음절 등)를 조용히 건너뛰던 것을 한컴 HWP5/HWPX 변환본과 같은 자모열
  (초성 + ᆞ U+119E + 종성)로 보존 — 같은 문서의 HWPX 경로 출력과 일치.
- **빈 셀 채우기가 엔티티 원문을 지우던 것 (#54 잔존분)**: IR상 빈 셀에
  엔티티(`&#32;`)·태그가 있으면 통째 교체 분기로 떨어져 IR에 안 잡힌 원문이 소실 —
  조용한 성공 대신 skip하는 fail-closed 계약으로 통일.
- **누름틀 동명 다중등장 + `require_unique`**: 머리말·본문에 같은 이름의 누름틀이
  있으면 한 곳도 채우지 않고 전부 rejected되던 것.
- **수식 토큰 프로토타입 체인 오염**: 토큰이 `constructor`·`toString`이면 출력이
  오염되던 결함.
- **fill 계열 ZIP 폭탄 가드**: `fillHwpx`·`extractClickHereFields`·`placeSealHwpx`가
  `precheckZipSize` 없이 JSZip에 직행 — parse를 안 거치는 MCP `fill_form`·라이브러리
  직접 호출에서 무제한 팽창이 가능했던 것을 차단.

### License

- **npm 배포본 라이선스 고지 포함**: 배포 tarball `files`가 dist·templates뿐이라
  NOTICE·THIRD_PARTY가 npm 수령자에게 전달되지 않던 것을 수리 — Apache-2.0·
  claw-hwp(MIT) 전문 동봉, claw-hwp 저작권자를 upstream 원문과 일치시키고,
  `scripts/check-notices.mjs`를 prepublishOnly에 배선해 재발 시 발행이 멈춥니다.

### 검증

테스트 1,387 pass / 0 fail, HWPX 게이트 PASS. 벤치 코퍼스 확충(hwpx 85→291),
채점 미러(`bench/lib/normalize.mjs`) PUA 정합 복원(phantom 0.000031→0.000007),
반복 문자 정렬 거짓 미스 3건은 `corpus/known-false-miss/`로 분리 보존.

## [4.3.1] - 2026-07-30

### Fixed

- **일반기안문 서식이 한글 2024에서 "파일이 손상되었습니다"로 열리지 않던 문제**:
  v4.3.0에 번들된 `templates/일반기안문_서식.hwpx`의 `header.xml`에 XML 1.0 금지
  제어문자(0x01) 2바이트가 섞여 있어(rhwp 서식 자산 유래) 한글이 열기를 거부 —
  `fill --template gian` 산출물 전부가 영향. 제어문자 제거로 실기기(한글 2024)
  열림 확인. 간이기안문은 영향 없음.
- 재발 방지: 번들 서식과 fill 산출물의 전체 XML 엔트리에 금지 제어문자
  (C0, tab/LF/CR 제외)가 없는지 검사하는 회귀 테스트 추가 — rhwp 자산 재복사
  시에도 게이트에서 잡는다.

### Verified

- v5.1 HWPX 스킬의 "linesegarray 전체 삭제 시 음수 spacing 캐시 소실로 양식 파괴"
  주장에 대한 실기기 대조 실험(한글 2024, 음수 spacing 셀 포함 보고서 양식):
  전체 삭제·targeted 삭제·미삭제 세 변형 모두 경고 없이 열리고 렌더가 픽셀
  단위로 동일 — 현행 섹션 단위 전체 삭제(`allLinesegRemovalSplices`) 유지.

## [4.3.0] - 2026-07-29

프로덕션 전면 리뷰 기반 대규모 정비 — 정부 표준 기안문 서식 내장(누름틀 채우기), 빈 문단
보존 옵션(#57), 기능 버그 7건, rhwp 렌더 정합 포팅, 성능 2건(최대 637배), 중복 통합
(수식·번호·XML 헬퍼), MCP 전면 비동기화, 발행 게이트 복원.

### Added

- **🏛️ 정부 표준 기안문 서식 내장 + 누름틀 채우기**: 「행정 효율과 협업 촉진에 관한 규정
  시행규칙」 별지 제1호(일반기안문, 누름틀 23곳)·제2호(간이기안문, 13곳) 서식을
  `templates/`로 번들 — `kordoc fill --template gian|gian-simple`, `--list-templates`,
  MCP `fill_form`의 `template` 파라미터로 파일 경로 없이 사용. 신설 누름틀 경로
  (`fieldBegin type="CLICK_HERE"` name 정확 일치 → splice 치환, 서식/charPr 보존,
  `\n`→`<hp:lineBreak/>`)는 안내문을 비교조차 하지 않아 안내문=실값 충돌 침묵 유실이
  구조적으로 불가능. 누름틀 우선 매칭 후 남은 키는 기존 라벨 매칭과 공존.
  서식 자산은 rhwp(MIT) 결정적 생성본 — `THIRD_PARTY/rhwp-forms.txt` 어트리뷰션.
- **빈 문단 보존 옵션 (#57)**: `keepEmptyParagraphs` / CLI `--keep-empty-paragraphs` /
  MCP `keep_empty_paragraphs` — 본문은 `text:""` paragraph 블록, 표 셀은 빈 줄로 순서
  보존해 "원문 문단 수 = 줄 수" 대응 유지 (행 줄맞춤 서식 문서용). 기본 off(현행 유지,
  #47 전례). 개체만 있는 문단은 대상 아님. (@jumaniac 제보)
- **MCP `parse_document` 파싱 옵션 5종 노출** (CLI 파리티): `ocr:"force"`,
  `remove_header_footer`, `formula_ocr`, `dedupe_running_headers`,
  `keep_trailing_empty_cols`.
- **hwpml 중첩표 구조 보존**: HWPML 셀 안 중첩표를 평탄화 텍스트가 아닌
  `IRCell.blocks`(hwpx table-build 계약)로 보존.
- **합성 성능 벤치 `bench/perf-synth.mjs`** — 대형 입력(조각 2만·적층 표 50)에서
  클러스터/괘선 표 경로 실측.

### Fixed

- **에러 계약 7건 (전면 리뷰)**: ① HWPX DRM이 메시지 순서 탓에 `ENCRYPTED`로
  오분류되던 것 → `DRM_PROTECTED` ② 암호화 XLS가 `success:true`+빈 markdown으로
  실패를 숨기던 것 → `ENCRYPTED` 실패 ③ HWP3 암호화·압축 해제·HWPML 크기 초과·sharp
  미설치 진단 메시지가 plain Error라 "문서 처리 중 오류"로 뭉개지던 것 → KordocError
  보존 (+`optional dependency`→`MISSING_DEPENDENCY` 분류) ④ MCP `parse_pages`만
  `filePath` 누락 — 배포용 HWP COM 폴백 불발 ⑤ MCP `detect_format`/`parse_metadata`의
  OLE2 세분화 누락 — `.xls`를 `hwp`로 오판·시그니처 에러 ⑥ `parse_metadata`에
  xls/image case 부재 — 무음 `undefined` ⑦ 최상위 `pageCount`가 image 외 전 포맷에서
  미전파 — MCP "페이지: N" 표시 사문화.
- **TAC 인라인 표 outMargin 가로 배선 (rhwp #3396 포팅)**: 글자취급 인라인 표의 가로
  전진폭에 outMargin 좌/우가 빠져 우정렬 host 문단 등이 시프트되던 결함 — 전진·배치·
  줄폭 4개소 배선. 코퍼스 60건 스윕: 결재란 보유 20건 정당 시프트(델타=om값 정확 일치),
  나머지 40건 바이트 동일.
- **OcrProvider mime 계약**: 이미지 직접 입력이 jpeg/webp를 넘기는데 타입은
  `"image/png"` 리터럴만 선언 — union으로 확장.

### Changed

- **CLI `render` reflow 기본 켬** (`--no-reflow`로 끔) — MCP `render_document`와 정합.
  조판 캐시 있는 문서는 종전과 동일(reflow 무시), 캐시 없는 생성본이 이제 CLI에서도
  기본 렌더됨.
- **수식 변환기 통합 (274→91줄)**: hwp5 독자 엔진을 hwpx 정본(`hmlToLatex`)에 위임 —
  같은 수식이 포맷에 따라 다른 LaTeX가 나오던 갈림 해소. `matrix{A # B # C}`의 `#`를
  열 구분으로 오역하던 것을 EqEdit 스펙대로 행 구분(`\\`)으로 수정.
- **번호 서식 엔진 통합**: `src/shared/numbering.ts` 신설 — hwp5 원숫자 20자 컷을
  gongmun 기준(㉑~㊿ 50한도)으로 통일. XML DOM 헬퍼도 `src/shared/xml.ts`로 승격해
  hwpml·docx 복제 3벌 제거.
- **MCP 핸들러 전면 비동기 I/O**: readFileSync/writeFileSync 등 ~35개소를
  `fs/promises`로 — 장수 stdio 프로세스가 수십 MB 문서 I/O 중 멈추던 블로킹 제거.
- **발행 게이트 복원**: `prepublishOnly` = sync-meta 드리프트 검사 + typecheck + test +
  build + `bench/gate-if-corpus.mjs`(코퍼스 부재 기기는 bench만 SKIP) — 코퍼스 없는
  기기에서 상시 FAIL → `--ignore-scripts` 우회 관행을 제거. 코퍼스 의존 e2e 테스트도
  모수 하한(170) 미달 시 suite 단위 skip. CI에 `tsc --noEmit` 타입체크 추가 (종전엔
  cli.ts·mcp.ts 본문이 어디서도 타입체크되지 않았다). `scripts/sync-meta.mjs`로
  plugin.json 버전·engine-spec SSOT 자동 동기화.

### Performance

- **ole-surgeon 섹터 할당 O(n²) 제거**: 512B마다 `Buffer.concat` 전체 복사 → 기하급수
  capacity — +4MB 스트림 삽입 1,967ms→3.1ms (**637배**), 출력 바이트 동일.
- **PDF 괘선 표 `buildVertices` 버킷화**: 수평×수직 전수 이중루프 → y-대역 버킷 —
  대형 적층 표 99→73ms, 스냅샷 해시 동일.

### 검증

테스트 1,349 pass / 0 fail (신규: 누름틀 11·빈 문단 5·TAC outMargin 3·LIKE 등),
typecheck 클린, build 성공. TAC 배선 코퍼스 60건 스윕 무회귀. 이번 릴리스부터
`npm publish`가 우회 플래그 없이 게이트 전 구간을 통과한다.

## [4.2.9] - 2026-07-26

HWP3 파서 rhwp 최신판(v0.8.0) 정합 4종 — 날짜 필드 desync·차례 표식 오염·유령 음절·예약 코드.

### Fixed

- **날짜 형식(ch=7)·날짜 코드(ch=8) 스트림 소비 (rhwp #2844)**: 두 코드를 6바이트짜리 simple
  control로 처리해, 실제 구조(spec §10.3 표 37 = 84바이트, §10.4 표 38 = 96바이트) 대비
  76/88바이트를 덜 소비하던 문제 — 날짜 필드 뒤 문단 전체가 desync로 오염됐다. 8바이트 헤더
  경로로 옮기고 나머지를 소비한다. 공문서는 날짜가 거의 항상 들어가 실피해가 컸다.
- **제목/표/그림 차례 표식(ch=25) 잉여 하이픈 (rhwp #2765)**: 하이픈(ch=24)과 같은 항목이라
  차례 표식마다 본문에 `-`가 삽입되던 문제. spec §10.19 표 60의 비가시 표식이므로 글리프를
  방출하지 않는다(바이트·hchar 소비량은 동일 유지). 하이픈(24)은 종전대로 `-`.
- **조합형 무효 종성 인덱스 (rhwp #2924)**: 예약/무효 종성 인덱스(0·18·30·31)를 '받침 없음'
  으로 치환해 원문에 없던 완성형 음절을 조용히 합성하던 문제. 무효면 한자/기호 lookup →
  `JOHAB_UNMAPPED` 경로로 넘긴다. 받침 없음(인덱스 1)·정상 받침은 무회귀.
- **ch=12는 '선'이 아니라 예약 코드 (spec 표 31)**: 선(ch=14)의 info 84바이트를 12에도 적용해
  84바이트를 과소비하던 문제. 표 31상 12는 예약이고 선은 14다. 8바이트 헤더만 소비한다.
- **SVG 렌더의 XML 1.0 비허용 제어문자 (rhwp #3382 동종)**: `render/svg-render.ts`의
  `escapeXml`이 `& < > "`만 처리해 C0 제어문자(0x00-0x08·0x0B·0x0C·0x0E-0x1F)를 그대로
  방출하던 문제 — 산출 SVG가 불법 XML이 되어 브라우저·뷰어가 그 페이지 렌더를 통째로
  중단한다("PCDATA invalid Char value"). 생성기(`gen-ids.escapeXml`)·왕복
  (`source-map.escapeXmlText`)이 이미 쓰던 필터 계약을 렌더 경로에도 맞췄다. 탭·개행·복귀는
  XML 1.0 허용 문자라 유지. 테스트를 위해 `escapeXml`을 export한다.

### 검증

테스트 1,333(신규 12 — 5종 전부 수정 전 실패 확인, 대조군 ch=24·ch=14·정상 받침·탭/개행
보존·마크업 이스케이프 무회귀), 게이트 roundtrip·formats·fuzz(crash 0·hang 0)·pdf-table
PASS. score는 코퍼스 구본(85/347) 모수 하한으로 baseline과 동일 FAIL, verify-reflow는
`bench/corpus/seoul` 부재로 미실행.

## [4.2.8] - 2026-07-25

캡션 안 표를 셀(`IRCell.blocks`)과 같은 구조 계약으로 제공 (#55).

### Added

- **캡션 구조 보존 `IRTable.captionBlocks` (#55)**: v4.0.6(#46)에서 캡션 안 중첩표를
  `caption` 문자열 평탄화로 살렸지만, 같은 문서에서 셀 안 표는 구조(`IRCell.blocks`)로
  그려지는데 캡션 안 표만 문자열로 남는 IR 비대칭이 있었다 — 구조 대조 검증에서 캡션
  쪽만 제외해야 했다. 이제 캡션에 표가 있으면 `captionBlocks`에 문단·표 블록을 원문
  순서대로 함께 싣는다. `IRCell.blocks`와 같은 계약(구조는 blocks, `text`/`caption`은
  하위 호환용 평탄화)이라 breaking 없음 — 표가 없는 평문 캡션은 종전대로 문자열만
  제공하고(무게 억제), 마크다운 출력·왕복 경로는 무변경. (@jumaniac 제안)

## [4.2.7] - 2026-07-22

빈 표 셀 채우기 시 공백만 있던 원문 문자가 조용히 사라지던 문제 수정 (#54).

### Fixed

- **빈 셀 공백 보존 (#54)**: `applyCellEdit`로 IR상 빈 표 셀에 값을 채울 때, 그 셀
  문단의 원문 텍스트 노드가 XML 공백만 포함하면 `buildParagraphSplices`가 그 공백
  `hp:t`를 통째 교체 대상으로 삼아 제거하던 문제 — 요청한 삽입 경계 밖의 원문(공백
  문자)이 patch 성공 보고와 함께 소실됐다. 이제 raw t-도메인이 공백만일 때는 t 맨 앞에
  zero-length 삽입(`buildRangeSplices`)으로 값을 넣어 기존 공백을 뒤에 보존하고, 삽입
  경계를 유일하게 정할 수 없으면(엔티티/내부 태그로 t-좌표 불일치) 성공 대신 skip한다
  (fail-closed). 비-공백 셀 교체·빈 t·자기닫힘 t/run 삽입 경로는 무회귀. (@Raphael-KR 제보)

## [4.2.6] - 2026-07-22

개조식·보고서 공문서 본문의 양쪽정렬을 왼쪽정렬로 — 항목 줄 어절 간격 벌어짐 수정.

### Fixed

- **개조식·보고서 본문 왼쪽정렬 (□/○/-)**: 개조식(gaejosik)·보고서(report) numbering의
  본문 리스트 문단을 양쪽정렬(JUSTIFY)에서 왼쪽정렬(LEFT)로 변경. 어절유지(BREAK_WORD)와
  양쪽정렬이 겹치면 짧게 끊긴 항목 줄(예: 다음 어절이 길어 조기 개행된 25자 줄을 34자
  폭으로 확장)의 어절 간격이 정상 대비 ~2.8배로 벌어져 "깨진 듯" 보이던 문제. 행정업무
  운영편람 개조식 예시가 왼쪽정렬인 근거와도 일치. 기안문(standard numbering, official
  등)의 서술형 본문은 종전 양쪽정렬 유지. 코퍼스 게이트(recall 1.0·실렌더 59/59·reflow
  100%) 무회귀.

## [4.2.5] - 2026-07-22

4.2.4 인라인 표 순서 수정의 후속(#52, @jumaniac 제보) — 평탄화 구분자 시각 충실도.

### Fixed

- **글자취급 표 경계 평탄화 구분자 (#52 후속)**: 4.2.4가 `IRCell.text` 평탄화 순서를
  바로잡으면서 글자취급(`treatAsChar="1"`) 표 경계까지 `\n`으로 분리해, 원문에서 앞뒤
  텍스트와 같은 줄에 놓이는 인라인 표가 두 줄로 평탄화되던 것 수정(`"▦∼▦ 연락처 :"`가
  4.2.4에서 `"▦∼\n▦ 연락처 :"`로 갈라지던 회귀). 글자취급 표·인라인 텍스트 경계는
  공백으로 잇고, 블록·float 표와 문단 경계는 종전대로 `\n`. 순서·블록 구조는 불변
  (#49/#50/#53 회귀 없음, 인라인 흐름 상태를 `lineOpen`으로 추적).

## [4.2.4] - 2026-07-21

4.2.3 인라인 표 순서 회차의 후속 결함 2건(#52·#53, @jumaniac 제보) 수정 —
같은 회차에서 놓친 셀 텍스트 평탄화 순서와 인라인 표 공존 시 float 표 추월 퇴행.

### Fixed

- **`IRCell.text` 평탄화 문서 순서 (#52)**: 셀 한 run에 표·텍스트가 혼재할 때 문단
  텍스트를 통째로 `cell.text`에 선(先)append해 중첩표 평탄화 텍스트가 그 뒤에 붙어
  순서가 역전되던 것 수정 — `cell.blocks`는 정상이나 `text`만 `types.ts`의 "text =
  blocks의 평탄화" 계약을 위반했다. 선append를 제거하고 각 세그먼트를 표와 교대로
  나온 자리에 이어붙인다.
- **인라인 표 공존 시 float 표의 텍스트 추월 (#53, 퇴행)**: 같은 문단에 인라인 표가
  있으면 float 표가 앞선 텍스트를 추월하던 4.2.0→4.2.3 퇴행 수정. `walkParagraphChildren`가
  텍스트 조각 방출을 인라인 표에만 하던 것을 모든 표 직전으로 확장한다(잔여 세그먼트
  없으면 no-op이라 float 다수여도 안전). 자기참조 벤치 GT(`hwpx-ref`)도 동일 모델로 동기화.

## [4.2.3] - 2026-07-19

인라인 표 순서 보존 회차 — 한 문단·한 셀 안에서 글자취급(treatAsChar) 표와 텍스트가
번갈아 놓일 때 순서가 역전되던 결함 2건(#49·#50, @jumaniac 제보) 수정.

### Fixed

- **최상위 `blocks` 문서 순서 (#50)**: 한 문단 안에서 인라인 표 뒤에 오는 텍스트가
  표보다 앞 블록으로 나오던 역전 수정. `walkSection`이 문단 텍스트를 통째로 먼저
  push하던 것을, 표 경계 마커(`\x1E`)로 분할해 표 직전마다 해당 조각을 방출하도록
  변경. float·페이지 앵커 표는 텍스트 흐름 불참(reflow 개체 흐름 모델과 동일 구분) —
  종전대로 텍스트 뒤에 방출한다. `ParseSuccess.blocks`의 문서 순서 보존을 타입
  계약으로 명문화.
- **`IRCell.blocks` 셀 안 교대 배치 (#49)**: 셀 안에서 `[표] 텍스트 [표] 텍스트`가
  하나의 문단으로 병합되어 맨 앞으로 이동하던 것 수정 — 서식 기간 입력란
  (`[날짜] 부터 [날짜] 까지`)의 시작/끝 구분이 살아난다. 생성기(`generateHtmlTableXml`)도
  셀 텍스트 전량 선방출을 원문 배치 순서 방출로 바꿔 라운드트립 대칭 확보. 평탄화
  `IRCell.text`도 문서 순서를 따른다.
- **벤치 순서 GT 정합**: 자기참조 XML GT(`hwpx-ref`)의 순서 모델을 파서와 동일한
  인라인 분할 방출로 갱신 — 코퍼스 347문서 orderAvg 1.0 (구 모델 대비 결재문서류
  5건의 실제 읽기 순서 오류가 드러나 함께 해소).

## [4.2.2] - 2026-07-19

rhwp 최신판 정합 회차 — 원저장소(edwardkim/rhwp)의 1만 건 실문서 서베이·실측 패치에서
파서 스코프에 해당하는 2건을 이식.

### Added

- **취소선 추출 (HWP5·HWPX)**: 법령 개정문 등의 삭제 표시를 `~~취소선~~` 마크다운으로
  방출. 판정은 취소선 **모양** whitelist — 한컴은 취소선 없는 문자에도 취소선 비트를
  기본값 1로 저장하므로 비트만 믿으면 본문 전체가 취소선이 된다 (rhwp 0a967e0d/#154
  실측). HWP5 는 shape id(bit 26-29) ≤12, HWPX 는 `<hh:strikeout shape>` 의 OWPML
  LineSym2 13종만 인정, 미지 값은 fail-closed. HWPX 는 run-span 채널로 부분 취소선까지,
  HWP5 는 대표(최빈) 스타일 기준 문단 단위. (PDF 경로의 취소선 감지는 종전부터 지원)

### Changed

- **ZIP 해제 한도 100→256MB**: rhwp 서베이에서 `section1.xml` 단독 75.2MB(압축비
  35:1)인 정상 문서가 실재 확인됨 (rhwp #1917) — 종전 100MB 총합 컷이 대형 실문서를
  ZIP bomb 으로 오인 거부하던 것을 상향.

## [4.2.1] - 2026-07-19

이미지 직접 입력 회차 — PNG/JPG/WebP 를 PDF 래핑 없이 바로 변환하고,
스캔/이미지의 표 괘선을 픽셀에서 직접 감지해 병합셀 표를 복원한다.

### Added

- **이미지(PNG/JPG/WebP) 직접 입력**: `kordoc 서식.png` / `parse(buffer)` /
  MCP `parse_document` — 매직바이트 감지(`fileType: "image"`) 후 내장 OCR 을
  자동 적용 (텍스트층이 없으므로 플래그 불필요). 디코딩은 optional dependency
  `sharp`, 사용자 OcrProvider 도 종전 계약대로 위임. `src/ocr/image-ocr.ts` 신규.
- **래스터 괘선 감지 (`src/ocr/ruling-lines.ts`)**: OCR 경로가 그래픽 ops 없이
  클러스터 감지만 타서 병합 라벨 셀 + 다중줄 서술형 서식(정부 제출 서식류)의
  표가 무너지던 것을, 페이지 픽셀 이진화+런렝스로 수평/수직 괘선을 직접 찾아
  선 기반 표 파이프라인(table-grid)에 공급하는 방식으로 해결 — rowspan/colspan
  이 살아있는 표로 복원. 오탐 방어 3겹: 최소 길이 20pt·두께 상한 2.5pt(굵은
  글리프 획 차단)·양측 잉크 포위 제외(색상바 내 흰 글자 틈새).
  `extractPageBlocksWithLines` 에 `extraLines` 옵션 파라미터 추가 (기존 PDF
  경로 무변경).

## [4.2.0] - 2026-07-17

내장 텍스트 OCR 회차 — 스캔/이미지 PDF를 API 키 없이 로컬 추론으로 읽는다.
+ rhwp 업스트림 정합 3종 + 수식 OCR off-by-one 등 리뷰 확정 결함 수리.

### Added

- **내장 텍스트 OCR (PP-OCRv5 korean)**: `parse(buffer, { ocr: true })` /
  CLI `--ocr`·`--ocr-force` / MCP `parse_document.ocr` — det(DBNet)+rec(SVTR/CTC)
  ONNX 를 onnxruntime-node 로 로컬 추론. 모델 ~18MB(det 4.6+rec 12.8+사전)는
  첫 사용 시 PaddlePaddle 공식 HF 리포에서 자동 다운로드+SHA-256 검증
  (`~/.cache/kordoc/models/ppocr/`, Apache-2.0). 한국어 사전 11,945자(완성형
  한글 11,172 음절 전량). `src/ocr/engine.ts`·`models.ts`·`pdf-ocr.ts` 신규,
  `kordoc check-ocr-models` 커맨드 추가. 실측: 보도자료 스캔 1페이지 0.9s(M-series
  CPU), 본문 conf 0.95+.
  - **페이지 단위 정밀 적용**: 품질 신호(`needsOcr` — low_text·high_pua·
    garbled_hangul 등)가 가리키는 페이지만 OCR 하고 정상 페이지 파싱 결과는
    유지. 문서 전체가 이미지 기반이면 전 페이지. `"force"` 는 무조건 전 페이지.
  - **스캔본 표 복원**: OCR 라인 박스를 PDF 포인트 좌표로 환산해 기존 블록
    파이프라인(xy-cut 읽기 순서 + 클러스터 표 감지)에 태움 — 담당부서 표 등이
    HTML 표로 복원된다.
  - 기존 `OcrProvider` 콜백 계약은 유지 (외부 OCR 연동).

### Fixed

- **OCR 실행 판정과 품질 신호 분리 (리뷰 F1~F3)**: 종전에는 문서 평균 10자/페이지
  미만일 때만 OCR 이 걸려 — ToUnicode 가 깨진(PUA·garbled_hangul) PDF 는 프로바이더가
  있어도 호출되지 않았고, 혼합 문서(텍스트+스캔)의 스캔 페이지는 무음 손실,
  진입 시 정상 페이지까지 통째로 OCR 결과로 대체됐다. 페이지 단위 선정·병합으로 전면 재설계.
- **OCR 페이지 실패의 본문 오염 (F6/F7)**: 실패 마커("[OCR 실패: 페이지 N]")가
  성공 마크다운으로 반환돼 RAG 청킹·redact·diff 에 유입되던 것 — 실패는
  `OCR_FAILED` 경고 채널로, 환경 오류(의존성·모델 미설치)는 원인 메시지를 보존해
  NEEDS_OCR 폴백. 텍스트 OCR 렌더를 pdfjs+node-canvas(미등재 의존성, F5)에서
  **pdfium+sharp**(기존 optional 의존성)로 교체 — `src/ocr/provider.ts` 제거.
- **수식 OCR 페이지 off-by-one**: `@hyzyla/pdfium` 의 `page.number` 는 **0-based
  pageIndex** 인데 1-based pdfjs 블록·pageFilter 와 그대로 대조 — `--pages` 필터가
  한 페이지 밀리고 수식이 이전 페이지 블록에 붙던 잠복 결함. 텍스트 OCR 계약
  테스트로 함께 잠금.
- **`qualitySummary` OCR 후 자기모순 (F14)**: OCR 적용 페이지가 여전히
  `needsOcr`/`ocrCandidatePages` 로 보고되던 것 — `PageQuality.ocrApplied` 신설,
  적용 페이지는 후보에서 제외.
- **XLSX/XLS `keepTrailingEmptyCols` 배선 누락 (#47 후속)**: 옵션이 두 포맷에만
  전달되지 않아 XLSX/XLS 양식의 빈 입력란 열 보존이 무음 무시되던 것.
- **HWP3 rhwp 업스트림 정합 3종** (원저장소 후속 패치 반영):
  - 탭(ch=9)은 8 byte 구조(hchar+탭폭+점끌기+닫기) — 2 byte 만 소비해 탭마다
    6 byte 씩 어긋나 이후 텍스트가 오염되던 것 (rhwp d89b689 #929).
  - ch=5(필드코드)·ch=6(책갈피) 스트림 소비 — 미소비 시 desync 로 이후 문단 전체
    오염 (rhwp dcf64b4 #877, 업스트림 실측 77→1058 문단 복구).
  - 사적 graphic char(0x0080~0x7FFF) 매핑 — 로마숫자 Ⅰ~Ⅹ("Ⅰ. 사업개요"),
    원문자 ①~⑩, 좌우 큰따옴표, 화살표, □ 글머리 등이 통째로 증발하던 것.
    kordoc 은 한컴 표시값을 직접 방출 (PUA 는 builder 가 제거하므로).
    U+F03C5→□ 는 HWP5 공용 PUA 맵에도 추가.

## [4.1.0] - 2026-07-17

프로덕션 전면 리뷰 회차 — 5축 병렬 감사(HWPX·PDF·바이너리·인터페이스·주변 모듈)로
확정 결함 ~80건 수정 + 신기능 3종(render_document·redact·chunks) + #47.

### Added

- **`render_document` MCP 도구**: HWPX를 조판 그대로 PNG 이미지(MCP image
  content)/SVG로 렌더 — 생성·패치·양식 채움 결과를 AI가 눈으로 검증하고 다시
  고치는 루프가 MCP 안에서 닫힌다. 한컴본은 조판 캐시, 생성본은 reflow.
  `src/render/rasterize.ts` 신규 (sharp optional, 1400px/8000px/4MB 자동 스케일).
- **`kordoc redact` CLI + `redact_document` MCP 도구**: 개인정보(주민번호·전화·
  이메일·카드·계좌 기본, 여권·운전면허 opt-in) 탐지 + 서식 보존 마스킹.
  HWPX/HWP는 patch로 원본 서식 1바이트 보존, 리포트에 원본 PII 미포함(`masked`만).
  생년월일·Luhn 검증으로 오탐 축소, base64 이미지 라인 제외. `src/redact.ts` 신규.
- **`--format chunks` CLI + `parse_chunks` MCP 도구**: RAG용 구조 청크 JSON —
  헤딩·개조식 위계(□○- / 1.·가.·1))를 breadcrumb 경로로, 표는 독립 청크로.
  자르기 정책(토큰 상한·오버랩)은 소비자 몫. `src/chunks.ts` 신규.
- **XLSX/XLS 날짜 셀 변환**: numFmt(내장 14-22·45-47 + 커스텀 y/m/d/h) 감지로
  날짜 시리얼("45306")을 ISO("2024-01-15")로. date1904·1900 윤년 버그 보정.
- CLI `fill`에 `--formats`·`--require-unique`·`--mask` (MCP fill_form 파리티).

### Fixed

- **#47 표 오른쪽 끝 빈 열 삭제 — 서식 입력란 소실**: `ParseOptions.
  keepTrailingEmptyCols` 신설(CLI `--keep-empty-cols`) — 켜면 실제 셀 앵커가 있는
  빈 입력란 열을 보존하고 앵커 없는 유령 열(span 인플레이션)만 트림한다. **양식
  경로(parse_form·fill_form·CLI fill)는 내부 상시 ON**이라 fill이 인식하는 입력란이
  --dry-run 필드 목록에도 그대로 나타난다. 기본 파싱은 종전 트림 유지(마크다운
  가독성 — 실코퍼스에서 앵커 있는 빈 후행 열이 흔해 기본 보존은 표 구조 대량 변경).
- **P0**: 인라인 수식 정규식 ReDoS(악성 `$\\\\…` 로 파서 행) · HTML 표
  colspan/rowspan 무클램프(생성기 OOM) · HWP3 압축 해제 폭탄 무가드 ·
  XLSX 셀 ref 행/병합 범위 무클램프(그리드 폭주).
- **P1 파서 정합성**: 표-전용 PDF의 이미지 기반 오판(OCR 켜면 정상 표 폐기) ·
  PDF 셀 미매핑 텍스트 무음 소멸 · HWP5 제어문자 0x18/0x1e/0x1f 매핑 스왑 ·
  DOCX 변경추적 삽입(w:ins) 전량 소실 · XLS SST CONTINUE 경계 인덱스 밀림 ·
  XLSX r 속성 부재 행 무음 드롭 · 도형 대체텍스트 정규식의 본문 오삭제 ·
  `| - | - |` 데이터 행 소실 · GFM 셀 `\|` 왕복 붕괴 · 미종결 `<table>`이 문서
  잔여 흡수 · OMML frac 다중그룹 오판.
- **P1 form**: 헤더행 표 라벨 셀 덮어쓰기 · 인라인 복합 라벨("신청인 성명"/
  "대리인 성명") 붕괴 · splice 실패 시 배열 값 무음 소실 · 역방향 접두사 임계
  상향(0.6→0.75).
- **보안·안정성**: MCP 쓰기 경로(output_path 7곳·image_path·profile_path) 검증
  신설 · HWP5 patch 삭제 텍스트 섹터 잔존(remanence) 제로화 · watch 동시 폭주
  무음 유실(대기 큐) · fs.watch error 핸들러 · webhook DNS 재검증 · XML 불법
  제어문자 스트립 · lenient CFB 할당 증폭 캡.
- **성능**: PDF vertex 병합 O(V²)→버킷(62,500 vertex 3.1s→0.2s) · XLS SST 선형
  스캔 제거 · diff 길이비 프리필터 · SVG 중첩표 측정 메모이즈 · 이미지 인라인
  단일 패스.
- README fillForm 예제 API 불일치(따라 하면 크래시) · `parse(buffer.buffer)`
  풀 오염 패턴 · MCP 응답 200k 상한 · MCP·watch `.xls`/`.hml` 지원 · MCP DRM
  COM fallback filePath 전달 · parse_metadata 헤더 스니핑 512B(HWP3/HWPML 감지).

## [4.0.8] - 2026-07-16

4포맷 이미지 무음 유실 근본수정 — 코퍼스 447파일 전수 실측으로 PDF(추출 자체
미구현)·HWPX(11장)·HWP5(1장)·DOCX(1장) 유실을 각각 해소. HWPX/HWP5 스윕 후
코퍼스 이미지 복구율 686/686·92/92 (100%).

### Added

- **PDF 이미지 바이트 추출** (`src/pdf/image-extract.ts` 신규): 종전에는 이미지
  *영역 좌표*만 계산하고(정보손실 경고용) 바이너리는 전량 유실. 이미지 XObject를
  pdfjs 디코딩 픽셀(RGB/RGBA/1bpp)로 받아 순수 JS PNG 인코딩(`transcode.ts`
  `encodePng` 재사용) 후 페이지 말미 위치에 `![image](...)` 참조로 방출한다.
  코퍼스 52 PDF 중 이미지 보유 45파일에서 731장 추출 확인.
  - **비동기 디코딩 대기**: pdfjs는 `getOperatorList()` resolve 후에도 워커에서
    이미지 디코딩이 진행되므로(`buildPaintImageXObject`는 await 안 함) 동기
    `objs.has()`로는 다수를 놓친다(실측 551→731장). 콜백형 `objs.get()`으로
    완료를 기다린다(5초 안전망, 디코딩 실패는 pdfjs가 null resolve).
  - 페이지 경계 표 병합(`mergeCrossPageTables`) 인접성을 깨지 않도록 image
    블록은 병합 후 주입(`injectPageImageBlocks`). 장식 조각(<8px)·페이지 간
    동일 내용(로고·워터마크) dedupe, 문서당 200장/128MB 상한.

### Fixed

- **HWPX 본문 미도달 BinData 이미지 유실** (`src/hwpx/images.ts`): 꼬리말/머리말
  안 `hp:pic`(보도자료 로고·사진 스트립), header.xml `borderFill`의 `hc:imgBrush`
  (결재문서 셀 배경 이미지) 등 본문 워크가 닿지 않는 BinData가 전량 유실되던 것.
  전체 파싱 시 미참조 BinData 이미지를 문서 끝 image 블록으로 스윕 보강한다
  (확장자/매직바이트로 이미지만, OLE 등 비이미지 제외, `pages` 부분 파싱 시 제외).
- **HWP5 미참조 BinData 이미지 유실** (`src/hwp5/images.ts`): pic 컨트롤이
  참조하지 않는 BinData 이미지(image 블록 0개인 문서 포함)를 같은 방식으로 스윕.
- **DOCX w:object v:imagedata 유실** (`src/docx/parser.ts`): OLE 개체 미리보기
  등 `w:object` 안 `<v:imagedata r:id>` 이미지가 blip 전용 수집에서 빠지던 것.
  mc:Fallback 밖 imagedata를 이미지 맵·본문 인라인 방출에 포함한다 (Fallback 안
  사본은 Choice blip과 중복이므로 종전대로 제외).
- **PDF images 결과 누락** (`src/index.ts`): `parsePdf`가 내부 결과의 `images`를
  구조분해에서 빠뜨려 API 결과에 이미지가 실리지 않던 것.
- **`PageQuality.ocrReason` 타입 정합** (`src/types.ts`): v4.0.7이 추가한
  `garbled_hangul`이 공개 타입 union에 빠져 `tsc --noEmit`이 실패하던 것.

## [4.0.7] - 2026-07-15

DOCX 하이퍼링크·이미지 무음 유실 근본수정 + PDF 오매핑 mojibake 감지. 외부
품질 평가에서 지적된 3건(PDF 깨진 한글 무경고 통과, DOCX 하이퍼링크 176→21
손실, 이미지 추출되나 본문 링크 누락)을 각각 해소.

### Fixed

- **DOCX 하이퍼링크 대량 손실** (`src/docx/parser.ts`): 문단당 `href` 단일
  스칼라가 루프에서 덮어써져 한 문단에 링크가 여러 개여도 마지막 1개만(그것도
  문단 전체를 감싸) 남던 구조를 제거. `collectInline`이 문단 자식을 문서 순서로
  순회해 링크마다 인라인 `[text](url)`를 생성한다. 또 `w:fldSimple` / `w:fldChar`
  begin·separate·end + `w:instrText` **필드코드 HYPERLINK**(워드·구글독스·한글
  익스포트가 흔히 쓰는 방식 — 종전 전량 유실)와 `w:anchor` 내부 링크(`[text](#anchor)`)
  처리를 추가. HWP5/HWPX 파서와 동작 정합.
- **DOCX 이미지 본문 링크 누락** (`src/docx/parser.ts`): 이미지 바이너리는
  추출·저장되나 `extractImages`가 만든 image 블록이 본문 배열에 병합되지 않고
  폐기돼 markdown에 `![image](...)` 참조가 하나도 안 들어가던 것. `buildImageMap`
  (embed 단위 파일 dedup) + `emitParagraphImages`로 본문 워크 중 문단 위치에
  image 블록을 인라인 방출(문서 순서 보존). 표 셀 등 놓친 이미지는 문서 끝에
  참조를 보강.
- **PDF 오매핑 mojibake 무경고 통과** (`src/pdf/quality.ts`): ToUnicode가 잘못
  매핑돼 글리프가 PUA/FFFD가 아니라 정상 한글 음절 영역의 엉뚱한 글자로 떨어지는
  케이스("GPU쭒컫 많핂슪")를 종전 품질 게이트(PUA/제어/대체문자)가 못 잡던 것.
  종성(받침) 분포를 신호로 추가 — 자연 한국어(받침없음 다수·겹받침 희소) vs CID
  스크램블(받침 균등)을 받침없음<0.15 AND 희귀받침≥0.25 두 조건으로 판정(사전
  불필요·오탐 방지), `garbled_hangul` 사유로 페이지별 `NEEDS_OCR` 경고 방출.
- **bench 경로 이식성** (`bench/*.mjs`): `new URL('.', import.meta.url).pathname`이
  Windows에서 `/D:/...`를 반환해 `join` 시 `D:\D:\...`로 크래시하던 것을
  `fileURLToPath`로 교정(score·roundtrip·pdf-table-gt·formats-sweep·fuzz-sweep).
- **배포 메타 버전 동기화**: `plugins/kordoc/.claude-plugin/plugin.json`이 4.0.5로
  뒤처져 release-metadata 테스트가 실패하던 것 정합.

## [4.0.6] - 2026-07-12

무음 유실 2건 근본수정 — PDF 무괘선 밴드 표 파편화(예산서 부서명 유실) +
HWPX 캡션 안 중첩표 텍스트 유실(#46 실파일 재현 확정분).

### Fixed

- **PDF 무괘선 요약행 밴드 표 파편화** (`src/pdf/vertical-bridge.ts` 신규):
  세출예산 사업명세서류 표는 재원구분(시/구) 요약행 밴드에 수직 괘선을 긋지
  않아 동일 열 수직선이 위/아래로 끊기고, Union-Find 그룹 파편화로 헤더행·
  부서/정책 요약행이 그리드에서 탈락 → 부서명이 열 순서 뒤바뀐 추측성 클러스터
  표로 유실되던 것(광진구 2026 세출예산 전량 실측: 637곳). 끊긴 수직선 쌍을
  4중 가드(간격 5~120pt·간격 내 수평선 실존·같은 밴드 3열+ 동시 단절·수평선
  끝점-내부 열 경계 정합)로 브리지해 한 그리드로 복원 — 별개 적층 표·표 사이
  전폭 구분선은 가드에서 탈락. 합성 세그먼트는 이웃 세그먼트 전체를 덮어
  cell-extract 단일 세그먼트 75% 커버 판정을 통과(로직 무변경). GT 6쌍 지표
  기준선과 소수점 동일(오발동 0), 부수 개선: ice-arc-2026 +1,135자·캡션
  오흡수 102→85·표 내 페이지번호 행 92→82.
- **HWPX 캡션 안 중첩표 텍스트 통유실 (#46)**: `hp:caption > subList > p >
  run > hp:tbl` 구조(별지 제9호 서식 실측 — 위치 TOP/BOTTOM 무관)에서 캡션의
  표 앞 텍스트만 남고 표 내용이 통째로 사라지던 것(304자 중 297자 유실).
  `collectSubListText`가 문단 내 최상위 tbl을 수집해 표 평탄화 규칙(셀 `" / "`
  구분·행별 줄바꿈)으로 문서 순서 그대로 이어붙임 — 머리말/꼬리말 내 표도
  동일하게 유실 대신 보존. 회귀: 캡션 중첩표 TOP/BOTTOM·앞뒤 문단 순서 3건 +
  PDF 브리지 5건 추가 (테스트 1,034). 제보·최소 재현파일 제공 [@jumaniac](https://github.com/jumaniac),
  회귀 테스트 설계 조언 [@hiSandog](https://github.com/hiSandog) — 감사합니다.

## [4.0.5] - 2026-07-12

v4.0.4 플랜 이월 🟡 3건 마감 — 인라인 강조 채널의 외래·gongmun 일반화 +
gongmun 리스트 depth 왕복. 생성 경로 무변경(npm 4.0.4 대비 대표 10케이스
ZIP 실파일 60개 바이트 동일 확증 — 시각 오라클 렌더 등가). 게이트: 테스트
1,019 / bench:gate 전 체인 / HWPX 코퍼스 전 지표 baseline 동일(recall 1.0).

### Added

- **외래 한컴 문서 볼드/이탤릭 일반화**: kordoc 메타 없는 HWPX도 charPr
  실속성(`<hh:bold/>`·`<hh:italic/>`)으로 인라인 강조를 복원해 `**`·`*` 마커
  재방출. 한컴이 편집 이력 경계에서 같은 서식 run을 임의 분할하는 것에 대비해
  인접 동일 서식 span을 병합(`**안****녕**` 오염 방지). 자사 id 규약(코드 id4·
  인용 paraPr6)은 외래에 미적용. 셀은 혼합 가드(무서식+서식 span 공존 시만) —
  헤더행·라벨열의 전체 볼드는 구조 서식이라 마커 억제.
  채점기 선행 검증: mdToPlain이 bare 별표(=마커, escapeGfm이 리터럴을 전부
  이스케이프)를 제거하되 HTML 병합표 라인(이스케이프 없는 경로, 중첩표 후행
  포함)은 제외 — 결재문서 리터럴 별표 마스킹 훼손 없이 recall 조각화 차단.
- **gongmun 레이아웃 인라인 강조 왕복**: run-span 채널을 kordoc-layout
  "gongmun"까지 확장 (기본 charPr 0~10 블록은 default와 동일 — id4 code·
  paraPr6 인용 유효). 혼합 가드로 구조 볼드(비실측 report 1단계 □ 전체
  CHAR_BOLD, 표 헤더행)와 인라인 강조를 구분 — 부호 run이 무서식이라 진짜
  인라인 강조는 항상 혼합이 된다.
- **IRBlock.indent 소비 — gongmun 리스트 depth 왕복** (`IRBlock.listDepth`):
  md 리스트 문법과 충돌하는 부호('`- `'·'`1) `')는 재생성 시 md 파서가
  list_item으로 선점해 리터럴 부호 재분류가 못 받고 depth0으로 붕괴('1)'→'2.',
  '-'→□ 승격 + 후속 형제 순번 오염). paraPr 들여쓰기를 run 글자크기(=levelIndent
  단위, 개조식 반계단 역산 포함)로 역산해 blocksToMarkdown이 2칸/단계 선행
  공백을 방출 — 기안문·보고서·개조식 2차 왕복 고정점 검증. 알려진 한계:
  'ㆍ'(depth3~7 공용 부호)·부호생략 문단의 4단계+ 구분은 글리프 재분류 상한
  (depth3)에 수렴, '`* `' 부호(press)는 escapeGfm 얽힘으로 이월.

## [4.0.4] - 2026-07-12

v4.0.3 이후 미발행 작업 3회분을 단일 릴리스로 통합(npm 연속 버전 유지) —
① 프로덕션 하드닝(44개 부채 인벤토리), ② 잔여 부채 마감(T1~T5),
③ 잔여 타겟 최대목표 소진(R1~R4). 게이트: 테스트 1,012 / bench:gate 전 체인 /
시각 오라클 14종 해밍0.

### ③ 잔여 타겟 소진 — R1~R4 (2026-07-12)

#### Added

- **reflow Phase 3 — 개체 세로 흐름 모델** (R2): float(treatAsChar=0,
  TOP_AND_BOTTOM, PARA 앵커) 개체는 텍스트를 `vertOffset+outTop+개체높이+outBottom`
  아래로 밀고(두문 결재표 실측 140+16653+852=17645 정확 일치), PAGE/PAPER 앵커·
  BEHIND/IN_FRONT_OF_TEXT는 본문 흐름 불참(페이지 하단 직인이 커서를 밀던 것 제거),
  inline(treatAsChar=1) 표는 실효높이+줄 leading 전진. 빈 문단(개체 전용 포함)은
  run charPrIDRef로 pitch 산출(종전 DEFAULT_CHAR 1000 → 본문 1300 실측 정합).
  **혼합 캐시 문서 지원**: 한컴 저장본을 프로그램 편집해 일부 문단만 캐시가 없는
  파일도 reflow 옵션이면 진입 — 캐시 문단의 한컴 좌표(vertpos+textheight+spacing)로
  커서를 이어받아 캐시 없는 문단이 흐름 위치에 붙는다(종전 페이지 상단 0에 겹침).
  reflow 자기일관성 **58/59 → 59/59**(36264961 전 문단 d=0), 게이트 플로어 95→**100%**.
- **서식 프로필 스키마 0.3.0** (R1): ①`fontName_hangul` 폰트명 왕복 — 추출이
  fontfaces에서 이름을 함께 담고, 생성이 header fontface에 append+리맵(HANGUL·LATIN
  id 3+/실측 프리셋 8+)해 원본 글꼴 목록 없이 글꼴 재현. 순번 폴딩(PROFILE_FONT_MAX)은
  이름 없는 구버전 프로필의 dangling 방지로만 잔존. ②`anchor_row` 첫 행 전체
  지문(셀 경계 '|' 보존, 셀별 24자 정규화) — (0,0) 빈 셀 크로스탭의 동형 쌍둥이 표를
  순번 폴백 대신 지문으로 매칭. ③행0이 전부 병합인 표의 col_widths 소실 수정 —
  어느 행이든 span-1 셀로 확정 + 잔여 열은 병합 폭 균등 분배. ④profile-io zod 강화 —
  border type(HWPX LineType2 열거)·width("N.NN mm")·color(#RRGGBB|none) 손편집 오타를
  한컴 로드 전 거부.
- **공문서 옵션 표면 SSOT** (R3, 인벤토리 영역1-1): `gongmun-surface.ts` —
  CLI(cli.ts)·MCP(mcp.ts)가 각자 복붙하던 GongmunOptions 조립을 buildGongmunOptions
  하나로, 값 집합(열거·중첩 키 목록·수치 범위)을 상수로 통일해 zod shape를 파생.
  리팩터 전후 CLI 산출물 **10케이스 바이트 동일**(ZIP 엔트리 해시) 검증. MCP preset
  enum을 PRESET_ALIAS 파생으로 바꿔 누락 별칭 6종(시행문·공문·공문서·계획·알림·안내)
  회복.
- **IRBlock.indent 관찰 슬롯** (R4): 파서가 paraPr `<hh:margin>` 자식요소형
  hc:left(+양수 hc:intent)를 읽어 문단 들여쓰기(HWPUNIT)를 IR에 노출 — gongmun
  리스트 depth 재유도·양식 분석 원료. 마크다운 방출은 불변(점수 무영향).
- **셀 인라인 강조 왕복** (R4): run-span 채널(v4.0.6 최상위 한정)을 GFM 셀 문단으로
  확장 — 파서가 셀 블록에 span을 달고(table-build가 span 문단 blocks 운반),
  GFM 방출이 `**`·`*`·`` ` `` 마커를 재방출, generateRuns가 되읽는다.
- **시각 오라클 14종**: `heading-levels` 신규 — default(비공문서) 모드 h1~h4
  OUTLINE 방출의 한컴 실렌더 확증. 개요번호("1.", "1.1.") 미강제 실측(미정의
  numbering idRef=0 참조) — gongmun과 달리 명명 스타일 이전 불필요 판정.
- computeColWidths 불변식 property test — 결정적 LCG 500케이스에서
  합=totalWidth·전 열 양의 정수 잠금.

#### Fixed

- **원문자 폴백 파서 정합** (R4): 생성기 circledNumber 51+·circledHangul 15+가
  순환(mod)하던 것을 파서 자동번호 폴백(para-heading)과 같은 규칙(괄호수·가나다
  서수)으로 — 왕복 시 형제 순번 재유도 모호성 제거.
- **docFoot 구분선 컬럼폭 적응** (R4): '─'×46 고정이 좁은 커스텀 여백에서 두 줄로
  꺾이던 것을 컬럼폭 비례로(기본 여백 175mm에서 46자 불변 — 기존 산출물 무변경).
- **HTML 중첩표 높이 재사용** (R4): 호스트 셀 높이 추정이 행수×cellH 근사라 중첩
  셀이 접히면(긴 텍스트 wrap) 과소하던 것을 재귀가 확정한 hp:sz 실높이로.

#### 정책 결정

- **joinSoftBreaks 보류**: md-runs의 "라인=문단"이 계약 — 공문서는 짧은 개조식
  라인이 지배적이라 소프트랩 조인이 오히려 위험, 3표면 옵션 신설 비용 대비 수요
  없음. 필요 시 재론.

### ② 잔여 부채 마감 — T1~T5 (PDF 표 구조·reflow 폰트·인라인 강조 왕복·표면 파리티·수식)

#### Added

- **인라인 강조 run-span 왕복 채널** (T3): 생성 content.hpf에 `generator`/`kordoc-layout`
  opf 메타를 심고, 파서가 자사 생성 default 레이아웃 파일에서 볼드·이탤릭·인라인 코드
  run과 인용 문단(paraPr 6)을 마크다운 마커(`**` `*` `` ` `` `> `)로 복원 — IR에
  optional `spans`(IRSpan[])·`quote` 추가, blocksToMarkdown이 재방출. 외래 문서는 메타
  부재로 채널이 꺼져 오검출 없음(회귀테스트). fixture basic fwd 0.525→**1.0** ·
  law 0.943→1.0 · corpus fwd/bwd micro 0.9998→**1.0**. 시각 13종 해밍0(메타 무해 실측).
- **서식 프로필 표면 노출** (#41, T4): `kordoc profile <ref.hwpx> -o prof.json` 서브커맨드
  + `generate --profile` 플래그 + MCP `extract_profile` 도구·`generate_document`
  `profile_path` 파라미터 — 라이브러리 전용이던 간판 기능을 3경로 파리티로. FormatProfile
  zod 경계 검증 1벌 공유(profile-io.ts) — 손편집 오타 JSON을 위치·사유와 함께 거부.
- **프리셋 비호환 옵션 경고** (T4): `incompatibleGongmunWarnings` — docHead/docFoot(비
  기안문)·noticeHead(비통지)·press(비보도자료)·표지목차(보도자료)·sizes(비실측 프리셋)·
  suppressSingle(비standard 번호 체계)의 조용한 폐기를 CLI stderr·MCP 응답 경고로 노출.
- **reflow 고정폭 글꼴 폭 테이블** (T2): `faceClass`('hcr'|'fixedPitch') — 굴림체·돋움체·
  바탕체·궁서체 문단을 한글 1.0em/ASCII 0.5em으로 측정(종전 함초롬 0.97em 근사가 줄당
  1~2자 과대적재로 wrap 어긋남). head-styles가 charPr fontRef→글꼴명 해석, reflow가 지배
  charPr 힌트 전달 — 힌트 없으면 현행 테이블(생성 경로 불변). 자기일관성 55/59→**58/59**
  (게이트 플로어 90→95% 상향). 잔여 1건 = 대형 표 페이지 분할(Phase 3) known limitation.
- **PDF 적층 표 분리** (T1): 경계 수평선 하나를 공유한 별개 표 두 개(채용공고 머리
  스트립+응시원서 본표)를 Union-Find가 프랑켄 그리드로 묶던 것을 컷 라인 판정(전폭
  수평선 + 관통 논리 수직선 0 + 양쪽 독립 수직선 + 내부 x-집합 비겹침)으로 절단.
  관통 판정은 체인 뷰(맞닿은 세그먼트=논리 수직선) — 외곽선을 섹션별 세그먼트로 그린
  단일 표(nrich 지원서)는 절단하지 않음. 분리 밴드는 vertex를 자기 선으로 재계산(공유
  경계선 위 교차점이 반대편 표의 수직선 x를 나르던 열 오염 제거). cellExact
  0.6977→**0.7279** · NED 0.5237→0.5308. 잔여 비-exact는 GT 표현 차(투명 테두리 행·
  중첩 평탄화·유령 좁은 열)로 재확인 — bench/pdf-table-gt.mjs 11차 헤더 기록.
- **수식 COMMAND_MAP 역인덱스 충전** (T5): 읽기맵(CONVERT_MAP) 단일 명령 ~60개(\div
  \approx \therefore \because \oplus \uparrow \propto \cong \equiv \sim \angle \mapsto
  \ll \gg \dagger \models 등)를 자동 역매핑 — '맨 알파벳' 누출 0(전수 회귀 잠금). 미지원
  명령은 리터럴 따옴표 보호(가시화·\text 되읽기 안정), EqEdit 함수 키워드(sin·cos·log 등
  27개)는 identity 통과. `cases`/`vmatrix` 환경 EqEdit 네이티브 토큰 고정점 +
  `Bmatrix`/`align` 계열 렌더·내용 보존.

#### Fixed

- **CLI parseKv**: 값의 '=' 보존(첫 '='만 분리), '=' 없는 조각(쉼표로 잘린 값 꼬리)
  무증상 드랍 → stderr 경고 — `--doc-head "title=상반기 계획, 주요사업"`의 값 유실이
  조용히 지나가던 것 봉합.
- **MCP generate_document 드리프트**: `line_spacing` 파라미터·`sizes.bodyTitle` 키가
  CLI에만 있고 MCP에 없던 것 봉합.
- **MCP detect_format**: 16바이트 헤더 판정이 XLSX/DOCX를 'hwpx'로 오보 — 내부 구조
  세분화로 parse_metadata와 판정 일치.
- **CLI seal 숫자 플래그**: `--occurrence -1` 통과·`--dx/--dy` 비숫자 NaN→0 무증상
  강제를 엄격 검증으로 (MCP zod 동등).
- **hwpx styles bold/italic**: charPr 자식 요소(`<hh:bold/>`)도 감지 — 실측 한컴 HWPX는
  요소만 쓰는데 속성형(bold="1")만 읽던 것 (구버전 HWPML 잔재는 계속 인정).

#### 벤치 (전 게이트 PASS + 시각 13/13 해밍0, 테스트 978→994)

| 지표 | 전 | 후 |
|---|---|---|
| roundtrip fwd / bwd (corpus micro) | 0.999816 / 0.999908 | **1 / 1** |
| roundtrip fixture basic fwd | 0.525 | **1** |
| pdf-table cellExact / contentNED | 0.697712 / 0.523722 | **0.727941** / 0.530784 |
| reflow 자기일관성 | 55/59 (93%) | **58/59 (98%)** |

무후퇴 플로어 상향: roundtrip fwd 0.999→0.9995 · bwd 0.998→0.9995 · tableExact
0.72→0.85, pdf-table cellExact 0.69→0.72 · NED 0.52→0.525, reflow 90%→95%.

### ① 프로덕션 하드닝 (구조부채·correctness·왕복 충실도·파서 정밀도)

44개 잔여 기술부채 인벤토리(6영역 병렬 발굴) 기반 하드닝. P0 구조부채 3건은
리팩터 전후 산출물 SHA-256 대조(14조합 매트릭스)로 바이트 무변경 검증.

#### Added

- **id 파티션 불변식** (P0-1): charPr/paraPr/borderFill 방출 직전 "중복·구멍 없는
  연속 id" 런타임 검증 — 카운트 상수 드리프트가 무음 폰트오염 대신 즉시 에러.
  `GJ_CHAR_COUNT`·`charVariantBase`·`staticBfEnd` 수기 산술을 명명 상수·실방출
  목록 파생으로 교체. 회귀: 12조합 id 연속·itemCnt·dangling 0 테스트.
- **geometry.ts SSOT** (P0-3): A4 크기·mm→HWPUNIT·본문폭(계산 48189 vs 실측
  48180 구분 보존)·표 id 네임스페이스(1000/9.1M/9.2M/9.3M/9.4M) 중앙화.
- **두 자리 부호 내어쓰기 변형 paraPr** (P1-1): '10.'·'10)'·'(10)' 항목에
  (depth, 부호폭) 전용 paraPr(id 34~)를 문서별 발급 — 둘째 줄이 내용 첫 글자에
  정렬 (종전 ~0.55타 왼쪽 어긋남). 두 자리 항목 없으면 미발급(기존 산출물 불변).
- **왕복 채널** (P2): 장식표 제목 셀 `name="__kordoc_h1~6"` 마커 — 개조식
  표지·장헤더·1페이지형 제목박스가 재파싱 시 heading으로 복원, 목차·제목반복
  파생물은 스킵(중복 제거). 리터럴 부호 문단('가.'·'1)'·'□')의 list_item 재분류로
  2차 생성 시 8단계 자동 재번호. hr('─' 구분선) → separator 역매핑.
- **이미지 placeholder 방출** (gen-image.ts): `![alt](url)`·`<img>`를 1×1
  placeholder 바이너리(BinData) + 실측 미러 `<hp:pic>`로 방출 — 이미지 참조·표
  구조가 왕복 보존 (종전 alt 텍스트 각인은 이미지 열 붕괴 원인). GFM 셀·HTML
  병합 셀·단독 문단 3경로.

#### Fixed

- **ragged HTML 행 격자구멍** (P1-2): colCnt보다 짧은 `<tr>`(rowspan 미커버)의
  미점유 좌표를 빈 tc로 충전 — malformed 표(행 폭합 ≠ tblW) 방지.
- **중첩표 containment**: 4000 하한이 좁은 부모 셀폭을 넘으면 상한(셀폭−마진)에
  양보 — 셀 경계 침범 제거. 시각 baseline seal-nested 재박제(의도 기하 변경).
- **개조식 장식표 outMargin 절대임계(48000) 제거**: 컬럼폭(bodyWidth) 기준 판정 —
  커스텀 여백(예: 좌우 35mm)에서 본문폭급 표의 우측 여백 침범(GAP-01 재현) 수정.
- **목차·장헤더 번호 SSOT**: 표지 제외 h1+h2 단일 배열을 목차와 본문 로마
  장헤더가 공유 — 2×h1 문서에서 번호 +1 밀림 수정.
- **computeColWidths 합 불변식**: 음수 잔여(반올림 상향) 회수 루프 추가, 잔여
  분배 시 80% 캡 존중 — `sum == totalWidth` 상시 보장.
- **'끝.' 표시 단어경계**: 마침표 동반 독립 토큰만 기존 끝표시로 인정("…성황리에
  끝" 오인 제거) + 중복 판정을 마지막 렌더 블록 기준으로(말미 표 뒤 누락 수정).
- **h2 box '□' idempotency**: stripChapterNumber가 말머리 문자(□·○·ㅇ·-·ㆍ)도
  제거 — 반복 재생성 시 '□ □ 제목' 단조 누적 수정.
- **빈 번호 문단 카운터 드리프트**: 파서가 텍스트 없는 번호 문단도 카운터를
  진행(한글 실동작 일치) — 이후 항목 번호 1씩 낮게 재현되던 결함 수정.
- **서수 시퀀스 단일화**: 파서 자동번호(가나다·원문자)가 생성기 gongmun.ts
  시퀀스를 재사용 — 15번째+ 형제 mod-14 순환 어긋남 수정.
- **마크다운 파싱 정밀화** (md-runs): 리스트 중첩 depth를 들여쓰기 스택으로
  산출(탭·4칸 입력이 8단계 위계를 깨뜨리던 결함), GFM 전부-빈 행을 데이터 행으로
  보존, 연속 `>` 인용 개행 조인(개조식 ※ 쪼개짐 방지·줄 경계 보존), `_`/`__`
  강조 단어내부 비활성(snake_case·던더 오염 방지).
- **벤치 채점기 귀속 오류 3건** (bench/): Pass 3 앵커를 콘텐츠 보유 유닛으로
  한정, 중복 등장 텍스트 문서순 배정(Pass 1.5), 자동번호 phantom 관용 —
  recallMicro 0.999985→1, recallDoc 워스트 0.99359→1, phantom 0.000056→0.000003
  (347건 재채점 악화 0).

#### Changed

- `blocksToSectionXml` 갓함수(~420줄) 분리 (P0-2): SectionOpener("첫 run이
  secPr/colPr를 나른다" 계약 단일점, 종전 6회 복붙)·buildPreamble·블록타입별
  render* 핸들러로 분해 — 산출물 바이트 동일(해시 대조).
- `precomputeGongmunList` 반환이 `GongmunListPlan`(items + indentVariants)으로.

#### 시각 오라클 확대 (P6 — 8종 → 13종, 전부 해밍0)

- 신규 실렌더 baseline 5종: **gaejosik-cover**(표지 투톤 바·제목·날짜·기관명),
  **gaejosik-body**(장헤더 Ⅰ~Ⅲ + □○-ㆍ 4단계 + ※ + 데이터 표 밀집),
  **gaejosik-margins35**(커스텀 여백 35mm — outMargin 수정 실렌더 검증),
  **official-docframe**(결재란+두문+결문 조합), **press-full**(머리박스+부제+담당 표).
  종전에는 gongmun 프리셋 중 report 1종만 실렌더 커버.

#### 벤치 (전 게이트 PASS + 시각 13/13 해밍0)

| 지표 | 전 | 후 |
|---|---|---|
| recallMicro / recallDoc 워스트 | 0.999985 / 0.99359 | **1 / 1** |
| phantom | 0.000056 | 0.000003 |
| roundtrip fwd / bwd | 0.999632 / 0.99915 | 0.999816 / 0.999908 |
| roundtrip tableExact | 0.727848 | **0.879747** |
| roundtrip cellExact | 0.994702 | 0.995344 |

## [4.0.3] - 2026-07-11

프로덕션 하드닝 릴리스 — v4.0.0~4.0.2 변경분 전체에 대한 2중 프로덕션 리뷰
(6페이즈 하드닝 + 8앵글 리뷰·검증 패스)에서 확정된 결함을 수정. v4 계열 첫 npm 발행.

### Changed (프리셋 기본값 — 기존 산출물 기하 변경)

- **기안문(official) 본문 기본 15pt → 12pt**: 서울 정보소통광장 실결재 104건 중 64건
  지배값. 종전 크기가 필요하면 `--pt 15`(`body_pt: 15`).
- **계획서(plan) 항목부호 기본 `1. 가. 1)` → `□ → ㅇ → *`**: 실측 추진계획안 계층.
  법정 번호가 필요하면 `numbering: 'standard'` 명시 (suppressSingle도 standard 전용).
- 계획서 2단계 부호 기본 `○` → `ㅇ`.

### Added

- **입력 검증 방어선**: `bodyPt`·`lineSpacing`·`margins`·`sizes`·`autoFit.minRatio`의
  NaN/무한대/비정상 범위와 7개 이상 `approval` 라벨을 라이브러리·CLI·MCP 공통으로
  명시적 오류 처리 — 잘못된 입력이 XML `NaN` 기하로 번지지 않음.
- **비개조식 표지·목차**: `cover`/`toc`를 기안문·통지·회의록 등 전 프리셋에서 지원
  (보도자료 제외 — 머리박스 서식과 양립 불가라 명시적으로 무시).
- 폰트명 XML 특수문자(`&` `"` `<`) 이스케이프 — 임의 폰트명으로 XML이 깨지지 않음.
- 배포 메타데이터 회귀 가드 테스트(package/lock/plugin 버전 정합).

### Fixed

- **본문 폰트 유실**: 비실측 프리셋에 표지·목차를 켜면 `--font gothic`·`fonts.body`
  지정이 무시되고 함초롬바탕으로 렌더되던 결함 (본문 charPr·docframe 두 경로 모두).
- **헤딩 위계 역전**: 본문 13pt 이하에서 `####`(h4)가 `###`(h3)보다 크게 렌더되던
  결함 — h4를 h3 이하로 캡.
- **표 캡션**: 표 셀 안 도형·개체의 캡션이 바깥 표 캡션으로 오귀속되던 결함 + 캡션이
  보존되는데도 "미지원 제어 요소의 텍스트 손실" 거짓 경고가 쌓이던 결함. ctrl 래핑
  표 캡션은 보존(#46 후속).
- **결재란 라벨 줄간격**: 1pt 바 스페이서용 paraPr(70%)를 재사용해 긴 라벨 줄바꿈 시
  줄이 겹치던 것을 실측 결재선과 같은 전용 100% paraPr(33)로 분리.
- 여러 줄 셀·중첩표를 담은 HTML 표의 `hp:sz` 높이가 확장된 행 높이 합과 일치(타 뷰어
  잘림 방지), 382HU 제목박스 바의 1pt 전용 스페이서, `bodyTitleBox` 단독 지정 시
  표 폰트가 바뀌던 부작용 제거, 보도자료에서 표지·제목·부제가 충돌해 부제가 유실되던
  조합 차단.
- xmldom 0.9.10·markdown-it 14.3.0 범프 — 프로덕션 의존성 감사 취약점 0건.

## [4.0.2] - 2026-07-11

실측 벤치마킹 릴리스 — 부처별 양식 3종 + 실물 8종 + 서울 정보소통광장 실결재 기안문
60건(계획·보고·공고) 전수 디코드 분포를 근거로 괴리 17건 전수 목록화(GAP-01~17), 9건 반영.
전 프리셋 한글 COM 실렌더 → PDF 벡터 좌표 실측으로 조판영역 초과 0건 게이트 통과.

### Fixed

- **조판영역 우측 침범 근본수정 (GAP-01)**: 생성 문서에 단 컬럼 정의(`<hp:colPr>`)가 없어
  한글이 컬럼 영역을 좌우 10mm(2835HU)씩 좁게 잡던 결함 — 본문 텍스트는 우측 여백에
  10mm 미달하고, 컬럼보다 넓은 treatAsChar 표(제목박스 +10mm·데이터표 +3.6mm·목차박스
  +5mm)는 우측 여백을 침범했다(실무자 보고 재현). secPr 뒤 같은 run에 colPr 방출로 수정 —
  COM 실렌더 실측: 본문 190.0mm 정합, 전 프리셋 초과 0. 표지·본문 제목박스(48180)는
  outMargin 좌우 0(실물 t2와 동일 — 283이면 진행폭이 컬럼을 넘어 1mm 침범)
- **report/plan 리스트 문단 위 간격 실측값 (GAP-05)**: 1단계 □만 body×0.5(750)이던 것을
  실측 저장값 □3000/○2000/-1200/ㆍ600(t2 「2_보고서 양식」 paraPr)으로 — 개조식과 동일
  스케일. □ 항목 `keepWithNext`도 report로 확장
- **기안문 여백 실결재 지배값 (GAP-10)**: 편람 공식 20/10/20/20 → 실결재 지배값
  **20/15/20/15**(정보소통광장 60건 중 41건). 보고서·계획서·통지·보도자료는 실측 상하
  15mm(GAEJOSIK_MARGINS), 통지·보도자료 머리말·꼬리말 10mm. `margins`로 공식값 지정 가능

### Fixed — 실무자 눈 QA 반려 4건

- **단일 형제 부호 생략 기본 off**: 편람 규정(형제 없는 단독 항목은 부호 생략)을 기본
  적용하던 것을 `suppressSingle` 옵트인으로 — "말머리 빠지면 열 위치가 맛간 것처럼
  보인다"(실무자, 실무 관행 > 규정). 부호 생략 항목이 depth 공용 paraPr의 음수 내어쓰기를
  물려받아 둘째 줄이 있지도 않은 부호 폭만큼 더 들어가던 유령 내어쓰기도 전용 plain
  paraPr(25~32, 내어쓰기 0)로 수정
- **비실측 프리셋 표 셀 12pt**: 기안문·통지·회의록 표 셀이 본문 15pt를 그대로 써 서술
  열이 세로로 길어지던 것 → 실결재 지배값 12pt(굴림체 12·맑은고딕 11 실측)의 전용
  charPr 11·12 신설, 자동 장평 variant 기점 11→13 (실측 프리셋은 종전 GJ 22·23 유지)
- **표 열폭 배분 재작성**: 짧은 열이 글자 단위로 세로 쪼개지던 결함 — 열 하한 = 최장
  어절 폭(글자 단위 세로 분해 금지), 셀 실패딩 1200HU(tbl inMargin 510×2 — hasMargin=0이라
  cellMargin 무시) 기준으로 짧은 열부터 실폭 고정, 최장 서술 열만 유연
- **h2 `number` 시 리스트 위계 시프트**: 공고문에서 h2가 "1. 2." 부호를 차지하는데
  리스트도 1.부터 시작해 제목·본문에 동일 부호가 중복되던 규정 위반 — 리스트를 법정
  8단계 위계의 가.부터 시작 + 1자 들여쓰기(precomputeGongmunList depthOffset)

### Added

- **기안문 두문·결문 (GAP-02)**: 행안부 별지 제1호서식 — `docHead`(기관명 18pt bold
  중앙·수신·경유·제목 라벨 bold) / `docFoot`(발신명의 22pt 중앙·구분선·기안자/검토자/
  결재권자·협조자·시행/접수·주소·전화/전송/이메일/공개구분 9pt). CLI `--doc-head`/`--doc-foot`
- **보도자료 프리셋 `press`/`보도자료` (GAP-03)**: 국토부 실물(bodojaryo-reference) 실측 —
  머리박스("보도자료" 20pt bold + 보도시점/배포 10pt bold) + 제목 25pt bold 중앙 + 부제
  `- … -` + 본문 바탕 14pt □→ㅇ→\*(각주 12pt) + 담당 부서/담당자/연락처 표.
  `press` 옵션·CLI `--press-head`/`--press-sub`
- **업무보고 보고정보 행 (GAP-04)**: `reportInfo` — 최상단 우측 12pt "(보고일시, 보고자,
  연락처)" (실측 t3: 휴먼명조 12pt RIGHT). CLI `--report-info`
- **2단계 부호 ㅇ/○ 프리셋 분화 (GAP-06)**: 실결재 기안문 ㅇ 134 : ○ 5 실측 분포 —
  `bullet2` 옵션 신설, 기본값 통지·보도자료 `ㅇ`, 보고서 양식 계열 `○`. CLI `--bullet2`
- **공고문 두문·결문 (GAP-08)**: `noticeHead` — 공고번호(본문 위 bold 좌)·날짜(우측)·
  발신명의(우측 bold), h2 말머리 기본 `number`("1. 사업개요" — 바이오헬스 공고문 실측).
  CLI `--notice-head`
- **`*` 참고 항목 (GAP-15)**: 실측 프리셋에서 `*` 마커 리스트 항목 → ※ 참고 스타일
  (실결재·부처별 양식에서 참고를 `*`로 표기하는 관행이 ※보다 많음 — 부호 `*` 유지)
- MCP `generate_document`: `bullet2`/`doc_head`/`doc_foot`/`report_info`/`notice_head`/`press` 노출
- 측정 도구: `scripts/style-digest.mjs`가 `hp:switch` 안의 margin·lineSpacing도 읽음
  (전자결재 기안문 필수), `bench/collect-opengov.mjs` Windows 경로 수정

### 보류 (실측 근거 부족·갈림 — .claude/plans/gap-table-v4.1.md 기록)

- 내어쓰기 실측 광분산(GAP-07 — 현행 부호실폭 유지), 회의록 실측 부재(GAP-09),
  □ 부호 별도 run(GAP-12 — 표본 3:2), 기안문 개조식형 HY견고딕 17pt 스타일(GAP-14)

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
- **서식 프로필(format profile)**: 표의 위상(병합)뿐 아니라 **borderFill(테두리·음영)·열 실측폭·셀 글꼴**까지 원본 문서 없이 재현. `markdownToHwpx(md, { profile })`로 서식을 입히고, `hwpxToProfile(hwpx)`로 레퍼런스 hwpx에서 서식만 JSON으로 추출 — 원본 유출 없이 기관 서식만 공유·재현(이슈 #41, 스키마 `docs/format-profile-spec.md`). 표별 로컬 id를 문서 전역 id로 리맵해 `gongmun` preset과 병용해도 charPr id 충돌 없음. profile 미지정 시 출력 바이트 불변(하위호환). 스키마·문서 초안·비식별 예시 기여: @ai-localgov-officer (PR #42).

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
