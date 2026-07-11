---
name: kordoc
description: Use this skill whenever the user wants to read, create, fill, edit, compare, validate, or preview Korean Hangul/official documents — .hwp (HWP 3.x/5.x), .hwpx, .hml (HWPML) — or convert Korean-office PDF/DOCX/XLS/XLSX to Markdown. Triggers include any mention of 'hwp', 'hwpx', 'hml', '한글 문서', '아래한글', '한컴', '공문서', '기안문', '보고서를 hwpx로', '서식 채우기', '양식 자동 작성', '신청서 채워줘', '신구대조표', '문서 비교', or uploading/attaching .hwp/.hwpx/.hml files. Also use when generating official Korean documents from Markdown (기안문·보고서·계획서·통지·회의록 presets) or when a HWPX layout preview/verification is needed. Do NOT use for authoring plain Word .docx files (kordoc reads DOCX but generates only HWPX) or for general Korean text with no document file involved.
license: MIT
---

# kordoc — 한국 공문서 툴킷

kordoc(npm)은 관공서 문서 파이프라인 도구다. HWP 3.x/5.x·HWPX·HWPML·PDF·DOCX·XLS/XLSX → Markdown
파싱, Markdown → 공문서 HWPX 생성, 서식 빈칸 채우기(원본 스타일 보존), 서식 보존 라운드트립 패치,
문서 비교, HWPX 구조 검증, 조판 SVG 렌더를 제공한다. 한컴오피스·Windows COM 불필요, Node.js 18+만
있으면 된다.

## 실행 방법

설치 없이 npx 로 실행한다 (메이저 버전 고정):

```bash
npx -y kordoc@^4 <command> ...
```

첫 호출만 패키지 다운로드로 느리고 이후는 캐시. 상시 사용 환경이면 MCP 서버로 붙일 수도 있다
(`npx -y kordoc@^4 setup` — 대화형 마법사가 Claude Code/Desktop·Cursor 등에 자동 등록).
MCP 도구 11종: `parse_document`, `parse_table`, `parse_pages`, `parse_metadata`, `parse_form`,
`fill_form`, `place_seal`, `patch_document`, `generate_document`, `compare_documents`, `detect_format`.

## 명령 요약

| 작업 | 명령 |
|---|---|
| 문서 → Markdown | `npx -y kordoc@^4 문서.hwpx -o 문서.md` |
| 일괄 변환 | `npx -y kordoc@^4 *.pdf -d ./변환결과/` |
| 페이지/섹션 범위 | `-p 1-3` 또는 `-p 1,3,5` |
| 구조화 JSON (blocks+metadata) | `--format json` |
| 서식 필드 목록만 보기 | `npx -y kordoc@^4 fill 서식.hwpx --dry-run` |
| 서식 채우기 | `npx -y kordoc@^4 fill 서식.hwpx -j 값.json -o 결과.hwpx` |
| 공문서 생성 | `npx -y kordoc@^4 generate 초안.md -o 결과.hwpx --preset 보고서` |
| 편집 왕복 패치 | `npx -y kordoc@^4 patch 원본.hwpx 편집.md -o 결과.hwpx` |
| HWPX 구조 검증 | `npx -y kordoc@^4 validate 결과.hwpx` |
| 조판 SVG 렌더 | `npx -y kordoc@^4 render 문서.hwpx -o 미리보기.svg` |
| 도장/서명 배치 | `npx -y kordoc@^4 seal 문서.hwpx --image 도장.png --anchor "(인)" -o 결과.hwpx` |

> **도장 위치 한계**: 중첩표·글상자·탭/줄바꿈 문단·복잡 rowSpan 그리드는 근사 배치이며 결과 `warnings` 에 고지된다 — 한컴에서 확인 후 `--dx`/`--dy`(MCP `dx_mm`/`dy_mm`)로 보정한다.

## 워크플로

### 1) 읽기 — 어떤 문서든 Markdown 으로

```bash
npx -y kordoc@^4 사업계획서.hwp -o 사업계획서.md
```

- 병합·중첩 표는 GFM 으로 표현이 안 되므로 HTML `<table>`(colspan/rowspan)로 나온다 — 그대로 다루면 된다.
- 수식은 `$...$` / `$$...$$` LaTeX 로 나온다.
- PDF 는 텍스트층 품질 신호를 같이 계산한다 — 추출 텍스트가 깨져 보이면(`needsOcr`) OCR 이 필요한
  스캔/손상 PDF 라는 뜻이니 사용자에게 알린다 (kordoc 은 OCR 을 내장하지 않는다).
- 대용량·다수 파일은 `-d 디렉토리` 모드로 한 번에.

### 2) 공문서 생성 — Markdown 규약

```bash
npx -y kordoc@^4 generate 보고서.md -o 보고서.hwpx --preset 보고서
```

- 프리셋: `기안문`(official) · `보고서`(report) · `계획서`(plan) · `통지`(notice) · `회의록`(minutes) ·
  `개조식`(gaejosik, 표지·목차·장 헤더) · `보도자료`(press).
- 번호 목록(`1.` / 들여쓴 `-`)은 공문서 항목부호 8단계(1. → 가. → 1) → 가) → …)와 내어쓰기로 자동
  변환되고, 함초롬바탕·공식 여백 등 공문서 표준 서식이 적용된다.
- 표는 GFM 파이프표로 쓰면 된다. display 수식 `$$...$$` 은 HWPX 네이티브 수식(`<hp:equation>`)으로
  생성된다 (`\frac`·`\sqrt`·첨자·그리스 문자·적분/극한·행렬 등 제한된 LaTeX 부분셋).
- 본문 옵션: `--font gothic`(맑은 고딕) · `--pt <크기>` · `--line-spacing <퍼센트>` ·
  `--plain`(공문서 모드 끄고 범용 변환).
- stdin 입력은 파일 인자에 `-`.
- **차트**: ` ```chart ` 펜스가 한컴 네이티브 차트로 생성된다 (막대·선·원·도넛·영역·분산·방사형 20종):

  ~~~
  ```chart
  type: column
  cat: 1분기, 2분기, 3분기
  size: 120x70
  colors: #304D68, accent2
  예산: 100, 120, 110
  집행: 80, 95, 105
  ```
  ~~~

  - `type`: `column|bar|line|area|pie|doughnut|scatter|radar` (+`_stacked`) — 미지정 시 column.
  - `cat`: 카테고리(x축) 라벨 · `size: 너비x높이`(mm, 선택) · `colors`: 계열 색(파이는 조각 색, 선택).
  - `이름: 숫자들` 형식의 각 라인이 데이터 계열. 위 펜스는 그대로 복사해도 되는 유효 입력이다(주석 금지 — 주석 텍스트가 값으로 들어가 계열이 탈락한다).
  - 차트 제목은 펜스가 아니라 본문 문단으로 쓴다. 계열이 없으면 일반 코드블록으로 폴백된다.
- 생성 후 `validate` 로 구조를 확인하고 나서 사용자에게 전달한다.

### 3) 서식 채우기 (fill)

1. **먼저 필드를 파악한다**: `fill 서식.hwpx --dry-run` → 라벨 목록.
2. 값은 `-j 값.json`(JSON 파일)으로 넘기는 것을 권장 — `-f 'k=v,...'` 는 셸 히스토리·프로세스
   목록에 값이 노출된다.
3. 다중줄 값은 JSON 문자열 안의 `\n` — 표 셀/문단 안에서 실제 강제 줄바꿈으로 채워진다.
4. 같은 라벨이 문서에 2곳 이상이면 기본 동작은 **모든 칸에 채운다**(반복 양식 지원). 남의 칸 오염이
   우려되면 MCP `fill_form` 에 `require_unique: true` 를 줘라 — 2곳+ 매칭되는 스칼라 라벨은 채우지
   않고 `rejected` 로 보고한다(배열 값은 예외). CLI `fill` 엔 이 가드가 없으니 반복 라벨 서식은
   값을 배열로 주거나 어느 칸인지 확인 후 채운다.
5. 날짜·전화·주민등록번호 등 칸 모양 변환(`yyyy.mm.dd`, `###-####-####` 숫자 마스크 등)은 MCP
   `fill_form` 의 `formats` 파라미터가 지원한다.
6. 기본 출력 포맷은 `hwpx-preserve`(원본 글꼴·크기·정렬 100% 유지). 원본 파일은 덮어쓰지 말고
   항상 `-o` 로 새 파일에 쓴다.

**개인정보 주의**: 주민등록번호·계좌·연락처 같은 값은 응답에 그대로 되풀이하지 않는다. 채움 결과
확인이 필요하면 MCP `fill_form` 의 `mask_values` 마스킹 verify 를 쓰고, 사용자가 원문 확인을 명시
요청할 때만 보여준다. 채운 결과 파일 자체가 개인정보 문서임을 고지한다.

### 4) 기존 문서 편집 (patch)

```bash
npx -y kordoc@^4 원본.hwpx -o 편집.md     # ① 파싱
# ② 편집.md 를 수정 (내용만 — 구조 이동/삭제 최소화)
npx -y kordoc@^4 patch 원본.hwpx 편집.md -o 수정본.hwpx   # ③ 서식 보존 반영
```

- 원본의 글꼴·표·개체·조판을 보존한 채 텍스트 변경만 in-place 반영한다.
- 본문 문단에 줄을 나누고 싶으면 편집 md 에 **명시적 `<br>`** 을 쓴다 — 에디터의 soft-wrap 접힘은
  수정으로 취급되지 않는다.
- 원본은 절대 덮어쓰지 않는다 (`-o` 필수 습관).

### 5) 도장/서명 배치 (seal)

```bash
npx -y kordoc@^4 seal 신청서.hwpx --image 도장.png --anchor "(인)" -o 신청서_날인.hwpx
```

- 앵커 문구("(인)"·"서명 또는 인" 등) 위/옆에 이미지를 **글 앞 부유**로 얹는다 — 표·페이지가
  절대 커지지 않는다 (날인 후 서식이 밀리는 사고 방지).
- 같은 앵커가 여럿이면 `-n <0-based>` 로 선택. 못 찾으면 등장 횟수를 에러로 안내한다.
- `--mode`: `auto`(기본 — 오른쪽 공간 있으면 옆에, 없으면 문구 위에 겹침) · `overlap` · `right`.
- 크기 기본값은 줄높이×1.6 (7~18mm 클램프), `--size-mm` 로 고정 가능. 위치 미세조정은
  `--dx`/`--dy` (mm).
- 이미지는 **투명 배경 PNG** 권장 (macOS 미리보기 > 마크업 > 서명 내보내기, 또는 도장 스캔).
- HWPX 전용. 배치 후 `render --reflow` 로 위치를 확인하고 사용자에게 전달한다.

### 6) 비교·검증·미리보기

- **비교(신구대조표)**: MCP `compare_documents` — 두 문서의 조문/문단 단위 diff.
- **검증**: `validate 파일.hwpx` — ZIP 구조·mimetype·필수 파트·XML 웰폼드·secCnt·manifest 참조를
  검사한다 (한컴독스 업로드 거부 요인 사전 차단). 생성·패치 산출물은 전달 전에 반드시 통과 확인.
- **미리보기**: `render 문서.hwpx -o 문서.svg`
  - 한컴에서 저장한 파일: 조판 캐시를 그대로 그려 원본 충실 미리보기.
  - kordoc 이 생성/패치한 파일(조판 캐시 없음): `--reflow` 를 붙여 순수 TS 조판으로 렌더.
  - `--highlight 검색어` 로 형광펜 표시 가능.

## 함정

- 암호로 보호된 HWP/HWPX·DRM 배포본은 파싱할 수 없다 — 에러 메시지를 그대로 사용자에게 전달한다.
- `.hwp`(바이너리 HWP 5.x)와 `.hwpx`(ZIP/XML)는 다른 포맷이다. fill/patch/generate 산출물은 HWPX 다.
- 생성 HWPX 를 한컴에서 열면 편집 후 저장 시 조판 캐시가 생겨 render 기본 모드도 동작하게 된다.
- 표가 깨져 보이는 PDF 는 원본이 스캔본이거나 텍스트층이 손상된 경우가 대부분이다 — 품질 신호를
  근거로 설명한다.
