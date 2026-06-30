# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
