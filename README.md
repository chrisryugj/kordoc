# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP 3.x/5.x, HWPX, HWPML, PDF, XLS, XLSX, DOCX — 관공서에서 쏟아지는 모든 문서를 파싱하고, 비교하고, 분석하고, 생성합니다.

[English](./README-EN.md)

![kordoc 데모](./demo.gif)

### 🎬 영상으로 보기

[<img src="https://img.youtube.com/vi/Q13GmgDcIw0/mqdefault.jpg" width="320" alt="kordoc 시연 영상" />](https://youtu.be/Q13GmgDcIw0)

---

## ⚡ 30초 설치 (AI 에이전트 연동)

**macOS / Linux / Windows 공용**. Node.js 18+ 만 있으면 됩니다.

```bash
npx -y kordoc setup
```

대화형 마법사가:
1. 사용 중인 AI 클라이언트 번호 선택 (Claude Desktop / Cursor / Claude Code / Windsurf / VS Code / Gemini CLI / Zed / Antigravity — 설치된 건 `[감지됨]` 표시)
2. 설정 파일 자동 패치 → 클라이언트 재시작

Windows 도 자동으로 `cmd /c npx` 래핑. 수동 JSON 편집 불필요. 재시작하면 11개 문서 도구 (`parse_document`, `parse_table`, `fill_form`, `patch_document`, `generate_document` 등) 활성화.

> **CLI 로만 쓸 거면** 설치 없이 `npx kordoc <파일>` 바로 사용. 아래 [CLI](#cli) 섹션 참고.

> **`MODULE_NOT_FOUND` / `Cannot find module ...\dist\cli.js` 가 뜨면**: 과거에 깨진 글로벌 설치가 남아있는 상태입니다. 아래로 해결:
> ```powershell
> npm uninstall -g kordoc
> npx -y kordoc@latest setup
> ```

> **Windows PowerShell 에서 `npx.ps1 파일을 로드할 수 없습니다 · PSSecurityException` 이 뜨면**: PowerShell 기본 보안 정책이 서명 없는 `.ps1` 을 차단하는 표준 동작입니다 (kordoc 무관). 아래 중 하나 쓰시면 됩니다.
>
> **방법 1 — 명령 프롬프트(cmd) 창에서 실행** (가장 안전)
> 윈도우 키 → `cmd` 검색 → Enter → 검은 창에서 그대로:
> ```
> npx -y kordoc setup
> ```
>
> **방법 2 — PowerShell 실행 정책 한 번만 완화**
> 관리자 권한 PowerShell:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
> 이후 PowerShell 재시작 → `npx -y kordoc setup` 그대로 됨.

### Claude Code 플러그인으로 설치

MCP 등록 대신 스킬(SKILL.md) 형태로 쓰려면:

```
/plugin marketplace add chrisryugj/kordoc
/plugin install kordoc@kordoc
```

`.hwp`/`.hwpx` 언급이나 공문서 생성·서식 채우기 요청 시 kordoc 스킬이 자동 활성화됩니다
(내부에서 `npx -y kordoc@^4` CLI 호출 — 별도 설치 불필요).

---

## 💡 kordoc으로 무엇을 할 수 있나요?

단순한 텍스트 추출을 넘어, **공문서 처리를 위한 모든 과정**을 자동화합니다.

*   **📄 어떤 문서든 마크다운으로**: `HWP3` (구버전), `HWP`(5.x), `HWPX`, `HWPML`, `PDF`, `XLS`, `XLSX`, `DOCX` 파일을 즉시 `Markdown`으로 변환합니다. AI(LLM)가 문서를 읽고 분석하기 가장 좋은 상태로 만들어줍니다.
*   **📊 복잡한 표(Table) 완벽 재현**: 선이 없는 PDF나 복잡하게 병합된 HWP 표도 구조를 분석하여 정확한 마크다운 테이블로 복원합니다. 법령 개정안 PDF의 신구조문대비표도 통째로 살립니다 (v3.16.2).
*   **🔍 신구대조표 자동 생성**: 두 문서의 차이점을 분석하여 무엇이 바뀌었는지 한눈에 보여줍니다. (HWP와 HWPX 간의 비교도 가능!)
*   **📝 마크다운을 다시 HWPX로**: AI가 작성한 내용을 다시 보고서 양식(`HWPX`)으로 되돌려줍니다. 이제 복사-붙여넣기 노가다에서 해방되세요.
*   **🏛️ 정부 표준 공문서 생성 (v4.0)**: 실제 정부 양식 16종 + 실결재 기안문 60건을 전수 디코드·대조해 만든 공문서 엔진. 개조식 보고서(표지·목차 배너·로마숫자 장헤더·쪽번호·결재란), 기안문(별지 제1호서식 두문·결문, "끝." 자동), 공고문·보도자료 프리셋, 항목부호 8단계(1. 가. 1) 가)…) 자동, 공문서 표기법 검수 13룰(`kordoc lint`)까지 — 한글 COM 실렌더로 조판까지 실측 검증했습니다.
*   **🔄 서식 보존 무손실 라운드트립 (v3.0)**: 변환된 마크다운을 편집해서 `patchHwpx`(HWPX) / `patchHwp`(HWP 5.x 바이너리)에 넘기면, **원본 서식을 1바이트도 건드리지 않고** 바뀐 문단/표 셀의 텍스트만 원본 안에서 교체합니다. v3.7부터는 **표에 행을 추가/삭제하는 편집**도 원본 서식을 승계하며 반영되고, v3.8부터는 HWP 5.x의 **빈 셀에 값 넣기**도 지원합니다.
*   **🖼️ 레이아웃 보존 렌더 (v3.10~3.15)**: 한컴이 저장한 조판 캐시 좌표로 원본 레이아웃을 SVG로 재현하고, 캐시가 없는 파일(AI가 만든 HWPX·편집본)은 **순수 TS reflow 엔진**이 직접 조판합니다. 다페이지·표·그리기 도형·검색어 형광펜까지. 서버에 한컴 없이 HWPX 미리보기를 만들 수 있습니다.
*   **📊 차트 생성 (v3.16)**: 마크다운의 ```chart 펜스(type/cat/계열 라인)가 한컴 네이티브 차트(OOXML chartSpace)로 생성됩니다 — 막대·선·원·도넛·영역·분산·방사형 등 20종, 계열/조각 색 지정 가능.
*   **🔴 도장/서명 자동 날인 (v3.16)**: "(인)"·"서명 또는 인" 같은 앵커 문구를 찾아 도장 PNG를 글 앞 부유로 배치합니다. 표/페이지를 키우지 않아 날인 후 서식이 밀리지 않습니다 (`kordoc seal`).
*   **✏️ 양식 자동 채우기**: 공문서 양식 템플릿(신청서, 보고서)에 값을 넣으면 자동으로 빈칸을 채웁니다. 원본 서식(글꼴, 크기, 정렬)을 100% 보존합니다.
*   **🤖 AI 에이전트 연동 (MCP)**: `Claude`, `Cursor`와 같은 도구에서 직접 `kordoc`을 호출해 문서를 읽고 코딩할 수 있습니다.

---

## v4.2.0 변경사항

- **👓 내장 텍스트 OCR (PP-OCRv5 korean)**: 스캔/이미지 PDF를 **API 키 없이 로컬 추론**으로 읽습니다 — `parse(buffer, { ocr: true })` / CLI `--ocr` / MCP `parse_document`의 `ocr` 옵션. 모델 ~18MB는 첫 사용 시 자동 다운로드+SHA 검증. 품질 신호가 가리키는 페이지(스캔·글꼴 매핑 깨짐)만 정밀 OCR 하고 정상 페이지는 그대로 두며, OCR 라인 좌표를 표 감지 파이프라인에 태워 **스캔본에서도 표가 복원**됩니다. 한국어 사전 11,945자(완성형 한글 전량), 1페이지 ≈1초.
- **🩹 HWP3 구버전 파서 정합 3종**: 탭/필드코드/책갈피의 스트림 소비 결함으로 이후 텍스트가 통째로 오염되던 것과, 로마숫자(Ⅰ~Ⅹ)·원문자(①~⑩)·따옴표·글머리가 증발하던 것을 원저장소(rhwp) 후속 패치 반영으로 수리.
- **🐛 수식 OCR 페이지 off-by-one 수리**: `--pages` 필터가 한 페이지 밀리고 수식이 이전 페이지에 붙던 잠복 결함. XLSX/XLS `--keep-empty-cols` 배선 누락도 수리.

## v4.1.0 변경사항

- **👁️ `render_document` MCP 도구 신설**: 생성·패치·양식 채움 결과 HWPX를 조판 그대로 **PNG 이미지로 응답에 직접 반환** — AI가 자기가 만든 문서를 눈으로 확인하고 다시 고치는 루프가 MCP 안에서 닫힙니다 (한컴 저장본은 조판 캐시, 생성본은 reflow 조판, 검색어 형광펜 지원).
- **🕶️ `kordoc redact` + `redact_document` MCP 신설**: 개인정보(주민번호·전화·이메일·카드·계좌, 여권·운전면허 opt-in)를 탐지해 **원본 서식 그대로 마스킹**(`850315-●●●●●●●`)한 HWPX/HWP를 출력합니다. 생년월일·Luhn 검증으로 오탐 축소, 리포트에 원본 개인정보 미포함. 자동 검출 보조 도구 — 최종 공개 전 사람 확인 필수.
- **📦 `--format chunks` + `parse_chunks` MCP 신설**: RAG용 구조 청크 JSON — 헤딩·개조식 위계(□○- / 1.·가.·1))를 breadcrumb 경로로 보존하고 표는 독립 청크로 분리합니다.
- **📋 표 오른쪽 끝 빈 열 보존 (#47)**: 서식 문서의 빈 입력란 열이 파싱에서 통째로 삭제되던 문제 — `keepTrailingEmptyCols` 파싱 옵션(CLI `--keep-empty-cols`)으로 보존할 수 있고, **양식 경로(parse_form·fill)는 항상 보존**해 fill이 채울 수 있는 필드가 목록에서 빠지지 않습니다. 제보 [@jumaniac](https://github.com/jumaniac).
- **📅 XLSX/XLS 날짜 변환**: 날짜 셀이 시리얼 숫자("45306")로 나오던 것을 ISO("2024-01-15")로 변환합니다 (내장·커스텀 numFmt 감지, date1904 반영).
- **🛡️ 프로덕션 전면 리뷰 ~80건 수정**: 악성 파일 대응(수식 정규식 ReDoS·HTML 표 span 폭주·HWP3 압축 폭탄·XLSX 그리드 폭주), 표-전용 PDF의 OCR 오판, HWP5 제어문자(하이픈/고정폭 공백) 매핑, DOCX 변경추적 삽입 유실, 양식 채움 라벨 오탐 4종, HWP5 패치 삭제 텍스트 잔존 제로화, MCP 쓰기 경로 검증, PDF 괘선 표 성능(62,500 교차점 3.1s→0.2s) 등 — 자세한 내역은 [CHANGELOG](CHANGELOG.md).

## v4.0.8 변경사항

- **🖼️ PDF 이미지 추출 신설**: 종전에는 이미지 영역 좌표만 계산하고 바이너리는 전량 유실되던 것을, 이미지 XObject를 디코딩 픽셀로 받아 순수 JS PNG 인코딩으로 추출합니다 (pdfjs 비동기 디코딩 대기 포함 — 코퍼스 52 PDF 중 45파일 731장 실측). 페이지 말미 위치에 `![image](...)` 참조, 로고·워터마크 페이지 간 중복 억제, 페이지 경계 표 병합 비간섭.
- **🖼️ HWPX/HWP5 미참조 BinData 스윕**: 꼬리말·머리말 안 그림(보도자료 사진 스트립), 결재문서 셀 배경 이미지(borderFill imgBrush) 등 본문 워크가 닿지 않아 유실되던 이미지를 문서 끝에 보강 추출합니다 — 코퍼스 이미지 복구율 HWPX 686/686·HWP5 92/92 (100%).
- **🖼️ DOCX `w:object` 이미지**: OLE 개체 미리보기(`v:imagedata`)가 추출에서 빠지던 것 수정 (mc:Fallback 사본은 종전대로 중복 제외).

## v4.0.7 변경사항

- **🔗 DOCX 하이퍼링크 대량 손실 수정**: 한 문단에 링크가 여러 개면 마지막 1개만 남던 구조를 제거하고 문서 순서대로 링크별 인라인 `[text](url)` 생성. 워드·구글독스가 흔히 쓰는 **필드코드 HYPERLINK**(`fldSimple`/`fldChar`)와 내부 anchor 링크도 처리 (실측 176→21 손실이던 문서 전량 복원).
- **🖼️ DOCX 이미지 본문 링크**: 이미지가 파일로는 추출되나 마크다운에 `![image](...)` 참조가 안 들어가던 것을 문단 위치 인라인 방출로 수정.
- **🔍 PDF 오매핑 mojibake 감지**: ToUnicode 오매핑으로 정상 한글 영역의 엉뚱한 글자가 무경고 통과하던 것을 종성(받침) 분포 신호로 감지 — `garbled_hangul` 사유의 페이지별 NEEDS_OCR 경고.

## v4.0.6 변경사항

- **📊 PDF 무괘선 밴드 표 파편화 수정**: 세출예산 사업명세서류의 요약행 밴드에서 수직선이 끊겨 부서명이 유실되던 것을 4중 가드 수직선 브리지로 복원 (광진구 2026 세출예산 637곳 실측).
- **📝 HWPX 캡션 안 중첩표 보존 (#46)**: 캡션 속 표 내용이 통째로 사라지던 것(304자 중 297자)을 문서 순서 평탄화로 보존. 제보 [@jumaniac](https://github.com/jumaniac), 조언 [@hiSandog](https://github.com/hiSandog).

## v4.0.5 변경사항

- **🖍️ 인라인 강조 복원 일반화**: kordoc이 만들지 않은 **일반 한컴 문서**도 볼드·이탤릭이 마크다운 `**`·`*` 마커로 복원됩니다 (charPr 실속성 기반, 한컴 편집 이력으로 쪼개진 run 자동 병합). 표 헤더행처럼 셀 전체가 볼드인 구조 서식은 마커를 만들지 않습니다.
- **🏛️ 공문서 모드 인라인 강조 왕복**: 공문서 HWPX를 재파싱해도 항목 안 `**강조**`가 보존됩니다 — 보고서 1단계 □ 전체 굵게 같은 구조 볼드와 자동 구분.
- **↔️ 리스트 depth 왕복**: 공문서 재파싱 산출물의 `1)`·`-` 항목이 재생성 시 1단계로 붕괴('1)'→'2.', '-'→□)하던 것을 들여쓰기 역산 선행 공백으로 해소 — 기안문·보고서·개조식 2차 왕복이 동일 결과로 수렴.

## v4.0.4 변경사항

- **🖋️ reflow 개체 흐름 모델**: float 표(두문 결재표)는 텍스트를 개체 아래로, 페이지 앵커·글 뒤 개체는 흐름 불참, inline 표는 실효높이+행간 전진 — 실결재 코퍼스 자기일관성 **59/59 (100%)**. 한컴 저장본을 프로그램 편집해 일부 문단만 캐시가 없는 **혼합 캐시 문서**도 reflow로 정확한 위치에 렌더됩니다.
- **🎨 서식 프로필 0.3.0**: 셀 **글꼴 이름 왕복**(`fontName_hangul` — 원본 없이 글꼴 재현), 첫 행 지문 `anchor_row`(첫 셀이 빈 크로스탭 매칭), 행0 전체 병합 표의 열폭 보존, 손편집 JSON의 괘선 값(type·mm·색상) 사전 검증.
- **🧰 CLI/MCP 옵션 표면 통일**: 공문서 옵션 조립·값 집합을 단일 SSOT로 — 두 인터페이스의 옵션 드리프트 원천 차단(MCP 프리셋 별칭 6종 회복 포함). 리팩터 전후 산출물 바이트 동일 검증.
- **↔️ 왕복 보강**: 표 셀 안 볼드·이탤릭·코드 마커 왕복, 파서 문단 들여쓰기 관찰 슬롯(`IRBlock.indent`), 원문자 15+/51+ 폴백 파서 정합, 중첩표 높이 정밀화, 결문 구분선 컬럼폭 적응.
- 게이트: 테스트 1,012 · 실렌더 시각 오라클 14종 해밍0 (default 모드 h1~h4 개요번호 미강제 실렌더 확증 포함).

## v4.0.3 변경사항

- **🛡️ 프로덕션 하드닝**: v4 전체 2중 리뷰에서 확정된 결함 수정 — 잘못된 수치 옵션(NaN·비정상 범위)의 명시적 거부, 폰트명 XML 이스케이프, 표지·목차를 전 프리셋으로 확대(보도자료 제외), 표지·목차 사용 시 본문 폰트 지정이 무시되던 결함과 13pt 이하 헤딩 위계 역전, 셀 안 개체 캡션 오귀속·거짓 손실 경고 수정.
- **📏 기안문 기본 12pt·계획서 □→ㅇ→\* 체계**: 실결재·실측 계획안 지배값을 기본값으로 (종전 값은 `--pt 15`·`numbering: 'standard'`로 복원 가능).

## v4.0.2 변경사항

- **📏 실측 벤치마킹**: 서울 정보소통광장 **실결재 기안문 60건** + 부처별 양식을 전수 디코드해 생성 결과와의 괴리 17건을 목록화, 9건 반영.
  - **조판영역 근본수정**: 단 컬럼 정의(`colPr`) 미방출로 본문이 좌우 10mm씩 좁게 잡히고 표가 우측 여백을 침범하던 결함 해소 — 전 프리셋 실렌더 조판영역 초과 0건.
  - **기안문 두문·결문** (`--doc-head`/`--doc-foot`, 별지 제1호서식) · **보도자료 프리셋 `press`** (머리박스·담당 표) · **공고문 두문** (`--notice-head`) · **보고정보 행** (`--report-info`).
  - 표 열폭 배분 재작성(열 하한 = 최장 어절 폭 — 짧은 열이 글자 단위로 세로 쪼개지지 않음), 표 셀 12pt, 기안문 여백 실결재 지배값 20/15/20/15, 2단계 부호 ㅇ/○ 프리셋 분화(`--bullet2`).
- 실무자(현직 공무원) 눈 QA 게이트 통과 후 릴리스.

## v4.0.1 변경사항

- **✍️ 실무자 QA 3건 수정**: bold 시 폰트가 HY견고딕/Arial Black으로 바뀌던 "정체모를 폰트" 제거, h2 섹션 제목 말머리 `--h2-marker`(box □ / number / none), 개조식 소분류 부호 ― → 실무 관행 하이픈 `-`.
- **📝 공문서 표기법 검수 13룰**: 날짜·시간·금액·붙임 표기 등을 검수하는 `kordoc lint <file>` + 공문서 생성 시 경고 병기.

## v4.0.0 변경사항

- **🏛️ 정부 표준 개조식 보고서 완성**: 실제 정부 공문서 16종 전수 디코드·대조 기반 — 표지(gradient 제목박스·장식 바)·목차 배너·로마숫자 장헤더·쪽번호("- 1 -", 표지·목차 제외)·결재란·"끝." 자동·본문 제목박스. 표는 실측 문법(헤더 음영+이중선, 외곽 0.4mm 위계, 내용 비례 열폭, 우측 배치) 자동 적용. `--preset 개조식`.

## v3.18.0 변경사항

- **🎨 서식 프로필**: 표의 위상뿐 아니라 **테두리·음영·열 실측폭·셀 글꼴까지** 원본 문서 없이 재현합니다. `hwpxToProfile(hwpx)`로 레퍼런스 서식만 JSON으로 추출하고, `markdownToHwpx(md, { profile })`로 다른 문서에 그 서식을 입힙니다 — 원본 유출 없이 기관 서식만 공유·재현(이슈 #41, 스키마 [`docs/format-profile-spec.md`](docs/format-profile-spec.md)). 스키마·예시 기여: [@chiclooc-rgb](https://github.com/chiclooc-rgb) (PR #42).

## v3.17.0 변경사항

- **🖼️ 레이아웃 렌더 충실도**: 글꼴이 문서 지정대로 나오는 per-run 폰트(고딕 제목이 바탕체로 나오던 것 해소), 표지+본문 다구역 문서 전체 렌더, 가로(landscape) 문서 프레임 회전(우측 잘림 해소), 연속 표 문단의 페이지 포개짐 분리.
- **✍️ 결재란 겹침 해소 (reflow)**: 조판 캐시 없는 문서에서 결재란 라벨표·스탬프표가 같은 자리에 포개 찍히던 것을 한컴과 동일하게 나란히 배치. 중첩표 셀 높이 과소측정도 함께 수정.

## v3.16 변경사항

- **📊 차트 생성**: 마크다운 ```chart 펜스(type/cat/계열 라인)가 한컴 네이티브 차트(OOXML chartSpace)로 생성됩니다 — 막대·선·원·도넛·영역·분산·방사형 등 20종, 계열/조각 색 지정, 잘못된 펜스는 코드블록 폴백.
- **🔴 도장/서명 자동 날인**: `kordoc seal` — "(인)"·"서명 또는 인" 앵커를 찾아 도장 PNG를 글 앞 부유로 배치. 표/페이지를 키우지 않아 날인 후 서식이 밀리지 않습니다 (MCP `place_seal` 포함). 중첩표·글상자·탭/줄바꿈 문단은 위치가 근사이며 결과 `warnings` 로 고지됩니다 — 한컴에서 확인 후 `--dx`/`--dy`(dx_mm/dy_mm)로 미세조정하세요.
- **🔌 Claude Code 플러그인**: `/plugin marketplace add chrisryugj/kordoc` → `.hwp`/`.hwpx`/공문서 요청에 kordoc 스킬 자동 활성화.
- **🩹 3.16.1 패치**: 통합 검증 리뷰 결함 55건 일괄 수정 — 도장 배치(rowspan·colspan·중첩표 원점), 차트 값 파서(천단위 콤마·CRLF 마크다운), 양식 채우기 가드(require_unique), CLI `fill -o` 출력 등 "성공 메시지 뒤에 조용히 틀린 산출물" 계열 소탕.
- **🩹 3.16.2 패치**: 신구조문대비표의 `<신 설>` 표기를 텍스트 상자로 오인해 표 전체를 문단으로 해체하던 PDF 파서 결함 수정 — 30p 개정안 대비표가 통째 1표로 복원.

## v3.15.0 변경사항

- **🖋️ reflow 렌더 (캐시 없는 파일도 조판)**: `markdownToHwpx` 산출물·AI 생성본·편집본처럼 조판 캐시(linesegarray)가 없어 렌더가 거부되던 HWPX를 `renderHwpxToSvg(buf, { reflow: true })` / `kordoc render --reflow`로 순수 TS 조판합니다. 검증된 줄나눔 엔진(실측 98% 일치) + 실측 세로 모델로 lineseg를 합성해 기존 렌더 파이프(정렬·표·이미지·형광펜·다페이지)를 재사용합니다. 단문단·표 셀·표 밀어내기·자동 페이지 분할. 한컴 저장본은 캐시 재생 그대로(무회귀).
- **🔺 그리기 도형 렌더**: 사각형·타원·선·다각형·호를 SVG로 그립니다(선 색·굵기·점선, 채움, 크기 스케일). 조직도·화살표 등 "원본과 다르게 보이던" 큰 원인을 해결했습니다.
- **🚀 persistent 렌더 워커**: `kordoc render-worker`가 프로세스를 유지하며 연속 렌더 요청(stdin NDJSON)을 처리해 node 콜드스타트를 없앱니다(미리보기 앱 연동용).

## v3.14.0 변경사항

- **📄 렌더 다페이지 지원**: `kordoc render`가 전 페이지를 세로 스택 SVG로 그립니다(페이지별 흰 배경·경계선·클립, `data-page` 속성, `RenderSvgResult.pageCount`). 기존엔 전 페이지가 첫 장 한 장에 겹쳐 그려졌습니다.
- **🖍️ 렌더 검색어 형광펜**: `--highlight <쉼표구분어>` / `RenderSvgOptions.highlights` — 텍스트를 매치 경계로 분할해 매치 세그먼트에만 배경을 깝니다(대소문자 무시, `textLength` 동일 계산으로 정렬 오차 없음).
- **📐 줄 경계 정합**: lineseg `textpos`를 HWP5 문자 스트림 슬롯(컨트롤 8·문자형 컨트롤 1·서로게이트 2슬롯) 기준으로 재구성해, 컨트롤·탭이 섞인 문단에서 첫 줄에 글자가 몰리고 다음 줄이 비던 어긋남을 해결했습니다(데모 1,132개 멀티라인 문단 검증).
- **🖼️ 이미지 크롭 오판 수정**: `imgClip`을 `imgDim`(내용 상자) 기준으로 해석 — 삽입 후 리사이즈된 이미지(로고 대부분)가 좌상단 코너로 잘못 잘려 깨지던 문제를 해결했습니다(데모 pic 267개 검증).

## v3.13.0 변경사항

- **📄 프로즈 박스 감지**: 상단 라벨탭(제목 칩)이 박스 테두리에 걸쳐 만든 가짜 열 위로 본문이 전폭으로 흐르는 표(검정고시 응시자격 박스 등)를 감지해, 셀 경계에서 조각나던 본문을 자연 읽기 순서의 문단으로 복원합니다. 기하(전폭 행 지배)와 텍스트(긴 프로즈 셀)의 교집합에서만 발동해 정규 표는 건드리지 않습니다.
- **📝 HML 표 캡션 보존**: 표에 딸린 도형 캡션(`※ …참조` 등)이 hwpml 파싱에서 통째로 소실되던 문제를 수정했습니다. 캡션을 표 앞/뒤 문단으로 보존합니다.

---

## v3.12.0 변경사항

- **🏷️ 라벨 헤더 표 강등 면제**: 첫 행이 라벨(채용분야|담당업무|우대조건, 성명|응시분야|비고)인 표가 본문 셀의 ○/ㅇ 항목부호나 빈 기입란 때문에 텍스트 박스로 오인돼 문단으로 강등되던 문제를 수정했습니다. 예산표·업무분장표·양식 표가 표로 살아납니다.
- **🔗 개방 변 합성 체인 뷰**: 중간 괘선을 셀 경계마다 쪼개 그은 표(문의처 연락처 표 등)도 세그먼트를 논리적으로 이어 좌우 개방 변을 닫습니다. 물리 선은 건드리지 않아 기존 표의 셀 배치에 부작용이 없습니다.
- **📊 PDF 표 구조 벤치**: 표 매칭 90.3→98.6%, 완전 일치 58.3→65.2%, cellF1 0.652→0.724. 채점기에 잡매칭 차단(bag 교집합 0)·세밀 분할 프로즈 박스 구제(접두 유사도 폴백)를 더하고, 흐름띠·빈 스캐폴딩 표는 모수에서 제외했습니다.

## v3.11.0 변경사항

- **📐 PDF 개방형 표 복원**: 한국 행정문서에 흔한 좌/우 바깥 테두리 생략 표(수평 괘선만 전폭, 수직선은 내부 구분선만)에서 가장자리 열이 통째로 사라지던 것을 가상 테두리 합성으로 복원합니다. 채용공고류에서 6열 표가 4열로 찢기고 남은 열·본문이 13x2 유령 표로 흡수되던 병리가 완치됐습니다.
- **🎨 글상자 음영의 괘선 오염 차단**: 한컴 PDF가 제목 글상자의 그라디언트 배경을 촘촘한 수평선 수십 개로 내보내, 선 병합 단계에서 실제 상하 테두리까지 삼키던 것을 음영 스택 필터로 걸러냅니다.
- **📊 PDF 표 구조 벤치**: hwpx↔pdf 쌍 GT 대조에서 표 매칭 84.7→90.3%, 완전 일치 54.2→58.3%, cellF1 0.632→0.652.

## v3.10.0 변경사항

- **🖼️ 레이아웃 보존 렌더**: `kordoc render 문서.hwpx -o 문서.svg` / `renderHwpxToSvg(buffer)` — 한컴이 저장한 조판 캐시(줄 좌표·셀 그리드·개체 앵커)를 SVG 절대배치로 그려 원본 레이아웃을 재현합니다. run별 글자 크기/굵기/색/장평/자간, 문단 정렬, 셀 배경·테두리, 병합 셀, 인라인 개체, 이미지 크롭까지. 한컴 저장본 전용(1페이지).
- **🔧 uint32 음수 좌표**: `vertOffset="4294967103"`(= −193) 같은 uint32 저장 음수를 올바르게 해석합니다.
- **🔧 셀 내부 COLUMN 기준계**: 셀 안 개체의 `horzRelTo="COLUMN"`을 셀 영역 기준으로 해석합니다 (사진이 페이지 왼쪽으로 튀던 문제).

## v3.9.0 변경사항

- **🧮 Markdown 수식 → HWPX native 수식 생성**: `$$ \frac{a}{b} $$` 같은 display math 블록이 한컴 수식 개체(`<hp:equation>`)로 생성됩니다. `\frac`·`\sqrt`·첨자·그리스 문자·적분/극한·행렬(matrix/pmatrix/bmatrix)·`\left(` 구분자·`\text` 리터럴 지원. 생성한 수식은 kordoc으로 다시 파싱해도 같은 LaTeX로 돌아옵니다 (#38, @leehuiso 기여).
- **🛡️ 수식 입력 가드**: 닫히지 않은 `$$`가 문서 전체를 삼키던 문제(일반 문단 폴백), 중괄호 폭탄 크래시(깊이/길이 상한), 닫는 `$$` 뒤 텍스트 소실을 수정했습니다.
- **📋 공문 모드 번호 연속**: 항목 사이에 수식이 끼어도 항목 번호가 이어집니다 (표와 동일).
- **⚖️ 법령 문서 왕복 무결성 게이트**: 조문 번호 뒤 분리·문장 중간 끊김이 없음을 실측(민원처리법 전문 228문단)하고 벤치 게이트로 고정했습니다.

## v3.8.4 변경사항

- **📑 DOCX 병합표·텍스트박스 복구**: 병합표에서 셀이 통째로 빠지던 버그(세로 병합 미동작 포함)와 텍스트박스 내용 전체 유실을 수정 — 신고서류·KS표준안류 회수율 0.67/0.92 → **1.0/0.998**.
- **🔒 개인정보 마스킹 별표 보호**: `******`·`홍**` 같은 마스킹 별표가 마크다운 수평선/볼드로 오독되던 것을 이스케이프로 보존합니다 (별표 각주 `* 단, …`의 리스트 오인도 해소).
- **🔁 md→HWPX 왕복 충실도 0.947→0.9996**: 재변환한 HWPX를 다시 파싱해도 헤딩 레벨·리스트 번호(2. 3. 4. 시작 보존)·마스킹 문자가 그대로 살아납니다. 생성 문서는 한컴 "문서 찾아가기"에 개요 구조로 표시됩니다.
- **#️⃣ 개요 번호 발명 수정**: 번호 서식을 비운 개요 문단(한컴 "번호 없음")에 파서가 "1." 접두를 만들어 붙이던 버그 수정.

## v3.8.3 변경사항

- **📰 2단 조판 문서(속기록류) 읽기 복원**: 2단 본문이 2열 표로 흡수돼 좌우 단의 문장이 뒤섞이던 버그 수정 — 단을 분리해 올바른 순서로 읽습니다.
- **🛡️ 손상 PDF 처리 시간 폭주 가드**: 좌표가 오염된 비정상 PDF에서 파싱이 144초까지 걸리던 것을 2초대로 차단합니다 (정상 문서 출력 무변화).
- **📗 한셀(HCell)로 저장한 XLSX 복구**: "시트가 없습니다"로 실패하던 한셀 저장 파일이 정상 파싱됩니다.
- **📋 HML 문서의 표 소실 수정**: 문단에 앵커된 표가 통째로 빠지고 중첩표 내용이 사라지던 버그 수정 — 표 텍스트 회수율 0.23 → 0.99.

## v3.8.2 변경사항

- **📐 변환(축소/플립) 깔린 PDF의 괘선 표 복구**: 성과계획서류처럼 콘텐츠에 변환 행렬이 깔린 문서에서 표 감지가 통째로 실패하던 버그 수정 — 2줄 머리글 셀도 rowspan 병합으로 정상 복원됩니다.
- **📄 스캔 PDF의 임베디드 텍스트층 복구**: CID 폰트 텍스트가 조용히 소실되던 문제 수정 — "스캔본"으로 보이던 의사록에서 전문 텍스트를 추출합니다 (일부 문서는 pdftotext보다 잘 읽습니다).

## v3.8.1 변경사항

- **🔄 PDF 회전 텍스트 복구**: 90°로 눕힌 사이드탭 목차·세로 표(계속비 총괄표 등)가 숨김 텍스트로 오인돼 통째로 빠지던 버그 수정 — 이제 보이는 회전 텍스트도 추출됩니다. (숨김텍스트 prompt-injection 방어는 그대로)
- **🧱 내부 구조 정리**: PDF 선 감지(1,247줄)·HWPX 파서(1,619줄) 대형 파일을 목적별 15개 모듈로 분리 — 공개 API·출력 100% 동일 (실파일 87건 해시 검증).

## v3.8.0 변경사항

- **✏️ HWP 5.x 빈 셀 채우기** (`patchHwp`): 원본에서 비어 있던 표 셀에 마크다운 편집으로 값을 넣으면 이제 HWP 바이너리에도 삽입됩니다. 한컴이 빈 문단을 저장하는 방식(텍스트 레코드 생략형 포함)을 실파일 실측으로 지원. *(실파일 12건 무손상 검증)*
- **🏛️ 공문 항목 사이 표**: "1. 항목 → 근거 표 → 2. 항목"처럼 리스트 사이에 표가 끼어도 항목 번호가 이어집니다 (공문서 모드).
- **🚀 이미지 대량 참조 메모리 폭발 해소**: 같은 이미지를 수천 개 도형이 참조하는 문서(HWP·HWPX)에서 참조마다 데이터를 복사하다 **피크 17GB로 죽던 것을 445MB·0.2초 완주**로 수정.
- **📢 DOCX 관측성**: 이미지/스타일/번호/각주/메타 파싱 실패를 조용히 넘기지 않고 `warnings`로 보고합니다.

## v3.7.0 변경사항

- **📋 표 행 추가/삭제** (`patchHwpx`): 마크다운에서 표에 행을 새로 넣거나 지워도 이제 원본에 반영됩니다. 새 행은 **인접 행의 서식(테두리·글꼴·높이)을 그대로 복제**해 셀 텍스트만 바꿔 넣고, `rowCnt`·셀 좌표·표 높이까지 함께 갱신합니다. 세로 병합을 가로지르거나 행에 이미지/중첩표가 있는 등 위험한 경우엔 문서를 건드리지 않고 사유와 함께 skip합니다. *(실제 결재문서 45건 검증 — 손상 0)*
- **✏️ 양식 채우기 정확도**: 라벨 칸이 병합(colspan)된 서식에서 값이 **소리 없이 사라지던 버그** 수정, 표 안의 표(중첩표) 속 라벨도 채웁니다. `fillFormFields`(IR)와 `fillHwpx`(원본 보존) 두 경로가 같은 결과를 내도록 정합.
- **🔎 라벨 인식 확장**: "연번1"·"제1항목"처럼 숫자가 낀 라벨, "제1소위원회위원장" 같은 9자 이상 라벨, "Name"·"Date of Birth" 같은 콜론 없는 영문 라벨을 인식합니다. "6개월"·"1억원"·"해당없음" 같은 값을 라벨로 오인하지 않는 거름망 포함.
- **📢 정직한 부분 적용 보고**: `PatchSkip.partial` 신설 — "적용은 됐지만 원형 그대로는 아님"(셀 내 줄 병합·빈 문단 잔존 등)을 구분해 보고합니다.

## v3.6.0 변경사항

- **📐 실측 텍스트 메트릭 엔진**: 함초롬바탕 정품 TTF에서 글자 폭을 전수 추출해 한글 프로그램 없이 줄폭·줄바꿈을 계산합니다. 실제 결재문서의 조판 결과와 대조해 **줄바꿈점 98% 일치** 검증.
- **🪗 자동 장평(`autoFit`)**: 한두 글자가 다음 줄로 넘어가는(orphan) 문단만 골라 장평을 95→90%로 줄여 한 줄에 담습니다. 공문서 작성 관행 그대로.
- **📊 HTML 표 생성**: 병합(colspan/rowspan)·중첩 표가 든 마크다운도 `markdownToHwpx`로 구조 그대로 HWPX 표가 됩니다 — parse↔generate 표 라운드트립 완성.
- **🎨 서식 프로필**: 표의 위상뿐 아니라 **테두리·음영·열 실측폭·셀 글꼴까지** 원본 없이 재현합니다. `hwpxToProfile(hwpx)`로 서식만 JSON으로 추출하고, `markdownToHwpx(md, { profile })`로 다른 문서에 그 서식을 입힙니다 — 원본 유출 없이 기관 서식만 공유·재현(이슈 #41, 스키마: [`docs/format-profile-spec.md`](docs/format-profile-spec.md)).
- **🗂️ 다중값 채우기**: `fillForm` 값에 배열(`string[]`)을 주면 같은 라벨의 등장 순서대로 하나씩 소진 — 반복 양식·명부형 표(헤더+여러 행) 채우기.
- **🛡️ 무결성 픽스**: 채우기/패치 후 한컴이 "문서가 변조되었습니다" 경고를 띄우던 문제(줄 레이아웃 캐시 잔존), 생성 표 테두리가 보이지 않던 문제(borderFill id 규약) 수정.

## v3.5.0 변경사항

- **📊 문장을 표로 — 인플레이스 변환** (`patchHwpx`): 기존 한글파일(HWPX) 안의 문단을 마크다운 표(`| … |`)로 편집해 `patch`에 넘기면, **원본 서식을 그대로 둔 채 그 문장만 표로** 바꿔줍니다. 셀 테두리는 자동 생성, 나머지 문단·표·서식은 1바이트도 건드리지 않고 무손실 검증을 통과합니다. CLI `kordoc patch`·MCP `patch_document`가 자동 지원. *(HWP 5.x 바이너리는 미지원 — `generate`로 새 문서 생성 권장)*
- **🆕 MCP `generate_document` 도구**: AI 에이전트가 마크다운(표 포함)을 바로 HWPX로 생성. `parse_document`로 읽은 내용을 표로 재구성해 다시 한글파일로 출력하는 워크플로가 완성됩니다. 공문서 프리셋(`보고서`·`기안문`…)·글꼴·글자크기 옵션 지원.
- **🐛 공문서 한글 프리셋 크래시 수정**: `markdownToHwpx(md, { gongmun: { preset: "보고서" } })`처럼 라이브러리/MCP에서 한글 프리셋명을 직접 넘기면 터지던 버그 수정(`normalizeGongmunPreset`). CLI는 영향 없었음.

## v3.2.0 변경사항

- **🏛️ 공문서 모드 `markdownToHwpx(md, { gongmun })`** — 마크다운을 한국 행정 공문서 표준 서식의 HWPX로 렌더링. 행정안전부 「행정업무운영편람」·시행규칙 근거.
  - **항목부호 8단계 자동화** — 중첩 리스트 깊이 → `1. 가. 1) 가) (1) (가) ① ㉮` (마크다운 마커 종류 무시, 깊이로 강제). 가나다 소진 시 단모음 연속(거·너·더), 상위 항목 진행 시 하위 카운터 리셋, 단일 형제 부호 생략.
  - **둘째 줄 내어쓰기 정렬** — OWPML `<hc:intent>`(음수 hanging) + `<hc:left>`(단계별 누적)로 둘째 줄이 내용 첫 글자에 정렬. *(실제 한컴 공문서 paraPr 구조와 동일하게 검증)*
  - 프리셋별 실측 여백·글자 크기 적용(기안문 본문 12pt, 보고서·계획서 15pt) + 맑은 고딕 옵션.
  - **문서종류 프리셋** `official`(기안문)·`report`(보고서, □○-ㆍ 불릿)·`plan`·`notice`·`minutes`.

  ```ts
  import { markdownToHwpx } from "kordoc"

  const md = "1. 첫째 항목\n  - 둘째 항목\n    - 셋째 항목"
  const hwpx = await markdownToHwpx(md, { gongmun: { preset: "보고서" } })
  // → 1. / 가. / 1) 항목부호 + 내어쓰기 + 공식 여백 자동 적용
  ```

  CLI: `kordoc generate doc.md -o out.hwpx --preset 보고서` (별칭 `gen`, `--font`/`--pt`/`--line-spacing`/`--plain`). 표준 레퍼런스: `docs/gongmunseo-reference.md`, 작성 스킬: `.claude/skills/gongmunseo/`.

## v3.1.0 변경사항

- **🖊️ 에디터 통합 API `HwpxSession`** — 블록 클릭-편집형 에디터를 위한 증분 패치 세션. `openHwpxDocument(bytes)`로 열고, `session.patchBlocks(edits)`로 블록 인덱스 기반 직접 편집 (문단 텍스트 / 표 셀). **n회 연속 증분 패치 ≡ 일괄 `patchHwpx`** 바이트 동일 동등성을 CI 게이트로 보장합니다.

  ```ts
  import { openHwpxDocument } from "kordoc"

  const session = await openHwpxDocument(new Uint8Array(buf))
  session.capability(3)            // "text" | "cell-text" | "locked" — 편집 전 잠금 판정
  const res = await session.patchBlocks([
    { blockIndex: 3, newText: "개최 완료" },
    { blockIndex: 5, cells: [{ row: 1, col: 2, text: "홍길동" }] },
  ])
  // session.bytes — 서식 그대로, 텍스트만 바뀐 HWPX (증분 누적)
  ```

- **📋 양식 필드 스키마 `extractFormSchema(blocks)`** — 양식 인식에 타입 추론을 더해 폼 UI 자동 생성 지원. 필드 타입 7종(`text`/`date`/`phone`/`email`/`amount`/`checkbox`/`idnum`) + `required`(필수 표시 감지) + `empty`(채움 대상 판정).
- **`fillHwpx` splice 전환** — 수정 범위 외 섹션 XML을 원본 바이트 그대로 보존하도록 전면 재작성 (동작·결과는 v3.0과 패리티).
- **CJS 빌드 수정** — `require("kordoc")` 시 `import.meta` SyntaxError 나던 버그 수정.

## v3.0.1 변경사항

- **🔄 HWP 5.x 바이너리 서식 보존 패치** — `patchHwp(원본HWP, 편집된마크다운)` 신규 API. HWPX 패치(`patchHwpx`)의 HWP 5.x(OLE2 바이너리) 대응으로, 변경된 문단/표 셀의 PARA_TEXT만 레코드 안에서 치환합니다 (PARA_HEADER 글자수·CHAR_SHAPE·LINE_SEG 연쇄 갱신).
  - **섹터 레벨 컨테이너 수술**: CFB 전체 재조립 없이 대상 스트림의 섹터/FAT 체인/디렉토리 엔트리만 갱신 — 수정 외 영역은 원본과 바이트 동일 (실측: 133섹터 중 5섹터만 변경)
  - 안전 게이트: 레코드 재직렬화 바이트 동일성 검증, 순수 텍스트 문단만 수정, 암호화/배포용/DRM 거부, 미지원 편집은 `skipped[]`로 graceful skip
  - CLI `kordoc patch`가 .hwp/.hwpx를 매직바이트로 자동 분기
- **CI**: Node 18 ESM `__dirname` 미정의로 테스트 매트릭스가 실패하던 문제 수정

## v3.0.0 변경사항

- **🔄 서식 보존 무손실 라운드트립** — `patchHwpx(원본HWPX, 편집된마크다운)` 신규 API. 변경된 문단/셀의 텍스트만 원본 XML 안에서 in-place 치환하고 나머지 ZIP 엔트리는 바이트 그대로 보존. 미지원 편집(블록 추가/삭제, 표 구조 변경)은 원본을 건드리지 않고 `skipped[]`로 정직하게 보고하며, 패치 후 자동 재파싱 검증 리포트(`verification`)를 제공합니다.

  ```ts
  import { parse, patchHwpx } from "kordoc"

  const r = await parse(buf)                       // HWPX → 마크다운
  const edited = r.markdown.replace("개최 예정", "개최 완료") // LLM이 편집했다고 가정
  const res = await patchHwpx(new Uint8Array(buf), edited)
  // res.data — 서식 그대로, 텍스트만 바뀐 HWPX 바이트
  // res.applied / res.skipped / res.verification — 적용·미지원·검증 리포트
  ```

- **🎯 "99.9% 정확도" 파서 대도약** — 실측 공문서 코퍼스 324건(정부 보도자료 + 서울시 결재문서 + 2014~2016 옛 문서) 자기참조 채점 기준:

  | 지표 | v2.9.1 | v3.0.0 |
  |------|--------|--------|
  | HWPX 텍스트 재현율 | 99.699% | **99.998%** |
  | HWPX 표 구조 정확일치 | 99.875% | **100%** (1,421표 · 중첩표 343 포함) |
  | PDF coverage | 97.013% | **99.16%** |
  | HWP5↔HWPX 쌍 유사도 | — | **99.94%** |

  중첩표 구조 보존(`IRCell.blocks`), 한컴 PUA 매핑, HWP5 이미지 추출(0→90건), 자동번호 카운터, 머리말/각주 정밀 처리 등. 채점기·코퍼스 수집기·게이트는 `bench/`에 포함 — `node bench/score.mjs`로 재현 가능.

## v2.9.0 변경사항

- **📊 PDF 텍스트 품질 신호 + OCR 필요 판정** — PDF는 텍스트층이 있어도 ToUnicode/CMap 이 깨져 한글이 깨진 글리프로 떨어지거나 NUL 등 제어문자가 섞이는 경우가 많습니다. `parsePdf` 결과에 페이지별 품질 신호(`pageQuality`)와 문서 요약(`qualitySummary`)을 추가 — `needsOcr`/`ocrReason` 으로 OCR 큐 자동 라우팅이 가능. kordoc 은 OCR 을 기본 탑재하지 않고 **신호만** 노출합니다. 전국 지자체 주요업무계획 PDF 190건(45,399쪽) 대량 처리 중 도출. (아래 [PDF 텍스트 품질 신호](#pdf-텍스트-품질-신호-v290) 참고)

## v2.8.0 변경사항

- **🎨 `markdownToHwpx` 테마 옵션** (#31) — 헤딩/본문/인용/표 헤더 셀의 텍스트 색상과 표 헤더 굵기를 옵션으로 지정 가능. 새 export 타입 `HwpxTheme`, `MarkdownToHwpxOptions`. 옵션 미지정 시 기존과 동일하게 검정으로 출력(baseline 백워드 호환).

<details>
<summary>v2.7.2 변경사항</summary>

- **🐛 HWPX 양식 채우기 빈 셀 버그픽스** (#29, #30) — 한컴오피스에서 HWP→HWPX 로 변환한 양식의 빈 값 셀(`<hp:run>` 이 `<hp:t>` 자식 없이 self-closing)에 값이 삽입되지 않으면서 결과에는 성공으로 보고되던 false-positive 수정. `setRunText` 가 `<hp:t>` 없는 run 에 새로 생성해 텍스트 삽입. 기여: @amnotyoung

</details>

<details>
<summary>v2.7.1 변경사항</summary>

- **🕰️ HWP 3.0 (구버전) 파서 추가** — 1996~2002년 한컴이 쓰던 단일 binary 포맷 (`"HWP Document File V3.00"` 시그니처) 텍스트 추출. 기존 kordoc 이 거부하던 구버전 판결문/공문서 등이 검색 인덱싱 가능. 상용조합형(johab) → 유니코드 + 5,893개 한자/기호 lookup. 표 cell / 머리말 / 각주 의 nested paragraph 재귀 추출. [@edwardkim/rhwp](https://github.com/edwardkim/rhwp) 의 Rust 구현을 TypeScript 로 포팅.

</details>

<details>
<summary>v2.5.0 변경사항</summary>

- **🏛️ macOS 한컴오피스 호환 HWPX 생성** (#4) — `markdownToHwpx()` 가 만든 HWPX 가 macOS 한컴에서 "파일이 깨졌다"며 거부되던 문제 해결. 테이블 XML 을 최소 스켈레톤에서 완전 스펙 형태로 재작성 — `<hp:tbl>` 필수 속성 10종 + `<hp:sz>`/`<hp:pos>`/`<hp:outMargin>`/`<hp:inMargin>`, `<hp:tc>` 안에 `<hp:subList>` 래퍼 + `<hp:cellAddr>`/`<hp:cellSpan>`/`<hp:cellSz>`/`<hp:cellMargin>`, paragraph 래핑. `Preview/PrvText.txt` 추가 + `borderFill` id=1(SOLID 0.12mm) 추가.
- **🔓 HWP 5.x 배포용 문서 COM fallback** (#25) — `.hwp` 바이너리에서 "이 문서는 상위 버전의 배포용 문서입니다..." 경고 플레이스홀더만 나오는 케이스에서, Windows + 한컴오피스 환경이면 자동으로 `HWPFrame.HwpObject` COM API 로 재시도. v2.4.0 의 HWPX DRM fallback 인프라를 `.hwp` 에도 확장.

</details>

<details>
<summary>v2.4.0 변경사항</summary>

- **🔓 HWPX DRM 배포용 문서 자동 추출** — 공공기관 배포용 DRM이 걸린 HWPX 파일을 한컴 오피스 COM API로 자동 텍스트 추출. `manifest.xml`에서 암호화 감지 → `HWPFrame.HwpObject`의 `GetPageText`로 페이지별 추출 → Markdown 변환. Windows + 한컴 오피스 설치 환경에서 별도 설정 없이 동작.

</details>

<details>
<summary>v2.3.0 변경사항</summary>

- **📄 HWPML 2.x 파서 추가** — XML 기반 한컴 문서(`.hwp` XML 방식) 파싱 지원. `npx kordoc <file.hwp>`에서 `지원하지 않는 파일 형식` 오류가 나던 XML 기반 공문서를 이제 Markdown으로 변환할 수 있습니다. HWP 5.x 바이너리와 자동 구분(XML 시그니처 감지).
- **🧩 중첩 테이블 마커** — HWPX/HWP5에서 셀 내부 중첩 테이블이 있던 위치에 `[중첩 테이블 #N]` 마커 삽입. 큰 중첩 테이블(≥3행 + ≥2열)은 별도 블록으로 분리, 작은 것은 셀 내 평탄화. HWP5는 기존에 내용이 완전히 손실되던 것을 마커로 복구.
- **🖼️ HWPX 이미지 추출 버그 수정** — `binaryItemIDRef`가 확장자 없이(`"image1"`) 저장된 HWPX에서 이미지 추출이 실패하던 문제 해결. ZIP 내 파일명 regex 매칭으로 복원.
- **📄 PDF 머리글/바닥글 감지 개선** — 텍스트 반복 패턴 + y좌표 클러스터링 하이브리드. 페이지마다 달라지는 동적 머리글(챕터명 등)도 위치 기반으로 감지. 감지 영역 10% → 12%로 확장.

</details>

<details>
<summary>v2.2.4 변경사항</summary>

- **📝 양식 자동 채우기 (Form Filler)** — 공문서 양식 템플릿에 값을 자동으로 채워넣습니다. 라벨-값 셀 패턴, 체크박스(`□`→`☑`), 괄호 빈칸(`일반(  )통`→`일반(3)통`), 어노테이션(`(한자：)`→`(한자：金)`) 지원.
- **🏛️ HWPX 원본 서식 보존 모드** — `fillHwpx()`로 HWPX XML을 직접 조작하여 글꼴, 크기, 정렬 등 원본 서식 100% 유지한 채 값만 교체.
- **📊 병합 셀 HTML 테이블 출력** — `colspan`/`rowspan`이 있는 복잡한 표를 GFM 대신 HTML `<table>`로 출력하여 구조 보존.
- **🔧 markdownToHwpx 서식 강화** — 역변환 시 heading/bold/italic/table 등 서식 지원 대폭 개선.
- **🤖 MCP fill_form 도구** — AI 에이전트가 양식을 직접 채울 수 있는 새 MCP 도구 추가 (총 8개).

</details>

<details>
<summary>v2.2.1 변경사항</summary>

- **🔧 마크다운 렌더링 개선** — GFM 특수문자(`~`) 이스케이프로 취소선 오해석 방지, 테이블 셀 내 `|` 문자 이스케이프, 중첩 테이블 텍스트 구분자 `|` → `/` 변경으로 GFM 파서 충돌 방지.
- **📝 문단 간격 정상화** — paragraph 블록 사이 빈 줄 삽입으로 마크다운에서 별도 문단으로 렌더링.

</details>

<details>
<summary>v2.2.0 변경사항</summary>

- **🛡️ 보안 강화 7건** — XLSX/DOCX Billion Laughs(XXE) 방지, Watch SSRF 리다이렉트·10진수IP·symlink 차단, HWP5 lenient decompression bomb 방지, CFB FAT 섹터 상한, buildTableDirect 메모리 폭주 방지.
- **💥 Crash 방지** — `Math.min/max(...spread)` 스택 오버플로 수정 (15개소), Watch 동시 처리 제한(MAX_CONCURRENT=3).
- **🐛 정확성 개선** — Levenshtein 동일 길이 유사도 1.0 버그 수정, MCP `parse_metadata` XLSX/DOCX 오분류 수정, PDF 폰트 크기 통계 메모리 최적화(40MB→~50엔트리).
- **📦 품질** — CLI JSON Uint8Array base64 변환, `isPathTraversal` 합법적 파일명 오탐 수정.

</details>

<details>
<summary>v2.1.0 변경사항</summary>

- **📄 대형 HWPX 정부문서 파싱** — `<p>><run>><tbl>` 구조의 중첩 테이블 파싱 누락 수정.
- **📰 PDF 2단 레이아웃 감지** — 다단 논문·보고서의 컬럼 구조를 감지하여 읽기 순서대로 추출.
- **🛡️ 입력 검증 강화** — 폰트 크기 NaN/음수 가드, colSpan/rowSpan NaN 가드.

</details>

<details>
<summary>v2.0 변경사항</summary>

- **🔓 배포용(열람 제한) HWP 파싱 지원** — 관공서에서 배포용으로 잠근 HWP 파일도 이제 파싱됩니다. AES-128 ECB 복호화, 순수 JS 구현. [rhwp](https://github.com/edwardkim/rhwp)(MIT) 알고리즘 포팅.
- **손상된 HWP 파일 복구** — 표준 CFB 모듈이 거부하는 파일을 직접 FAT/디렉토리 파싱으로 복구. rhwp LenientCfbReader 포팅.
- **HWP5 각주/미주/하이퍼링크 추출** — 각주 본문 텍스트 연결, 하이퍼링크 URL 추출 및 XSS 살균.
- **HWPX 표 병합 밀림 수정** — colspan/rowspan 그리드 계산 버그 수정.
- **보안 강화** — CFB 섹터 크기 검증, sanitizeHref 3중 경로 일관 적용.

</details>

<details>
<summary>v1.8.0 변경사항</summary>

- **XLSX 파서 추가** — Excel 스프레드시트 파싱. 공유 문자열, 병합 셀, 다중 시트 지원. 시트별 heading + table 블록 생성.
- **DOCX 파서 추가** — Word 문서 파싱. 스타일 기반 heading, 번호 매기기(리스트), 각주, 하이퍼링크, 이미지 추출, vMerge/gridSpan 테이블 병합.
- **파싱 품질 대폭 개선** — PDF/HWPX/HWP5/XLSX 전 포맷 품질 점수 73→93점.
- **프로덕션 리뷰 17건 수정** — CLI `--no-header-footer` 플래그 반전 버그, MCP XLSX/DOCX 확장자 허용, ZIP bomb 보호 공유 유틸화, href XSS 살균 강화, PDF timeout 타이머 정리, HWP5 BinData O(n) 최적화, cluster indexOf O(n²)→O(n), SSRF IPv6 차단 등.

</details>

<details>
<summary>v1.7.x 변경사항</summary>

- **이미지 추출 (HWP/HWPX)** — ZIP 엔트리와 HWP5 BinData 스트림에서 바이너리 이미지 추출.
- **부분 파싱 (Graceful Degradation)** — 개별 페이지 실패가 전체 파싱을 중단하지 않음.
- **진행률 콜백** — `onProgress` 콜백. CLI에서 `[3/15 pages]` 형태 표시.
- **파일 경로 직접 입력** — `parse("path/to/file.hwp")` 문자열 오버로드.
- **PDF 머리글/바닥글 필터링** — `removeHeaderFooter` 옵션.
- **보안 강화** — ZIP bomb 추적, SSRF 방지, XSS 방어, 널바이트 감지, PDF 타임아웃.
- **pdfjs-dist v5 호환** — constructPath 연산자 형식 변경 대응.

</details>

<details>
<summary>v1.6.1 수정사항</summary>

- **HWP5 테이블 셀 오프셋 수정** — LIST_HEADER 파싱 시 2바이트 오프셋 밀림으로 rowAddr를 colSpan으로 잘못 읽던 치명적 버그 수정. 3열 테이블이 6열로 뻥튀기되던 문제 해결. colAddr/rowAddr 기반 직접 배치로 병합 테이블 정확도 향상.
- **HWP5 TAB 제어문자 수정** — TAB(0x0009) 인라인 컨트롤의 14바이트 확장 데이터 스킵 누락으로 `࣐Ā` 쓰레기 문자가 출력되던 버그 수정.

</details>

<details>
<summary>v1.6.0 기능</summary>

- **클러스터 기반 테이블 감지 (PDF)** — 선 없는 PDF에서 텍스트 정렬 패턴으로 테이블 구조 추론. baseline 그룹핑 + X좌표 클러스터링으로 2열 이상 테이블 감지. 선 기반 감지가 실패한 경우의 중간 계층 fallback.
- **한국어 특수 테이블 감지** — `구분/항목/종류/기준` 등 한국 공문서 key-value 패턴을 자동으로 2열 테이블로 변환.
- **한국어 어절 끊김 복원** — PDF 셀 내 한글 문자별 렌더링으로 인한 미세 갭 처리 개선. 셀 줄바꿈 병합 임계값 8자로 확장, 1글자 조사 자동 연결.
- **빈 테이블 필터링** — 장식용 선에서 생긴 빈 테이블 자동 제거.

</details>

<details>
<summary>v1.5.0 기능</summary>

- **선 기반 테이블 감지 (PDF)** — OpenDataLoader 핵심 알고리즘 포팅. PDF 그래픽 명령에서 수평/수직 선을 추출하고, 교차점으로 그리드 구성, bbox overlap으로 텍스트→셀 매핑. colspan/rowspan 자동 감지. 선 없는 PDF는 기존 휴리스틱 fallback.
- **IRBlock v2** — 6가지 블록 타입: `heading`, `paragraph`, `table`, `list`, `image`, `separator`. 새 필드: `bbox`, `style`, `pageNumber`, `level`, `href`, `footnoteText`.
- **ParseResult v2** — `outline` (문서 구조), `warnings` (스킵된 요소, 숨김 텍스트) 필드 추가.
- **PDF 개선** — XY-Cut 읽기 순서, 폰트 크기 기반 헤딩 감지, hidden text 필터링 (프롬프트 인젝션 방어), 모든 블록에 바운딩 박스.
- **HWP5 개선** — CHAR_SHAPE 파싱, 스타일 기반 헤딩 감지, OLE/이미지 스킵 경고.
- **HWPX 개선** — header.xml 스타일 파싱, 하이퍼링크/각주 추출.
- **리스트 감지** — 테이블 뒤 번호 문단을 ordered list 블록으로 자동 변환.
- **MCP 서버** — parse_document 응답에 `outline`, `warnings` 포함.

</details>

<details>
<summary>v1.4.x 기능</summary>

- **문서 비교 (Diff)** — IR 레벨 블록 비교로 신구대조표 생성. HWP↔HWPX 크로스 포맷 지원.
- **양식 인식** — 공문서 테이블에서 label-value 쌍 자동 추출. 성명, 소속, 전화번호 등.
- **구조화 파싱** — `IRBlock[]`과 `DocumentMetadata`에 직접 접근. 마크다운 넘어선 데이터 활용.
- **페이지 범위** — `parse(buffer, { pages: "1-3" })` — 필요한 페이지만 빠르게.
- **Markdown → HWPX** — 역변환. AI가 생성한 내용을 바로 공문서로.
- **OCR** — 스캔/이미지 PDF 텍스트 추출. 내장 엔진(`ocr: true`, PP-OCRv5 korean) 또는 외부 프로바이더(Tesseract, Claude Vision 등).
- **Watch 모드** — `kordoc watch ./수신함 -d ./변환결과 --webhook https://...`
- **MCP 7개 도구** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form
- **에러 코드** — `"ENCRYPTED"`, `"ZIP_BOMB"`, `"IMAGE_BASED_PDF"` 등 구조화된 에러 핸들링

</details>

---

## 설치

```bash
npm install kordoc
```

PDF 파싱(pdfjs-dist)·수식 OCR 등 선택 의존성은 **기본 설치**됩니다 (optionalDependencies).
설치 용량을 줄이려면 `npm install kordoc --omit=optional` 로 스킵할 수 있습니다 —
이 경우 PDF 파싱·수식 OCR·인쇄 렌더 등 일부 기능이 제한됩니다.

## 빠른 시작

### 문서 파싱

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("사업계획서.hwpx")
const result = await parse(buffer)

if (result.success) {
  console.log(result.markdown)       // 마크다운 텍스트
  console.log(result.blocks)         // IRBlock[] 구조화 데이터
  console.log(result.metadata)       // { title, author, createdAt, ... }
}
```

### 문서 비교 (신구대조표)

```typescript
import { compare } from "kordoc"

const diff = await compare(구버전Buffer, 신버전Buffer)
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] (테이블은 셀 단위 diff 포함)
```

HWP vs HWPX 크로스 포맷 비교도 가능합니다.

### 양식 필드 추출

```typescript
import { parse, extractFormFields } from "kordoc"

const result = await parse(buffer)
if (result.success) {
  const form = extractFormFields(result.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...]
  // form.confidence → 0.85
}
```

### 양식 자동 채우기

```typescript
import { fillForm } from "kordoc"
import { readFileSync, writeFileSync } from "fs"

const template = readFileSync("신청서.hwpx")

// HWPX 원본 서식 보존 모드 — 글꼴, 크기, 정렬 100% 유지
const result = await fillForm(template, {
  성명: "홍길동",
  주민등록번호: "900101-1234567",
  주소: "서울특별시 광진구 능동로 120",
}, "hwpx-preserve")

writeFileSync("신청서_작성완료.hwpx", Buffer.from(result.output as ArrayBuffer))
// result.fill.filled → [{ label: "성명", value: "홍길동" }, ...]
// result.fill.unmatched → 매칭 실패한 키 목록
```

### HWPX 생성 (역변환)

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# 제목\n\n본문 텍스트\n\n| 이름 | 직급 |\n| --- | --- |\n| 홍길동 | 과장 |")
writeFileSync("출력.hwpx", Buffer.from(hwpxBuffer))

// display math block은 HWPX native 수식(<hp:equation>)으로 생성됩니다.
// 초기 지원 범위는 \frac, \sqrt, 첨자/위첨자, Greek, 적분/극한,
// 화살표, 관계 연산자, matrix 계열의 제한된 LaTeX-like subset입니다.
const withEquation = await markdownToHwpx("피타고라스\n\n$$a^2 + b^2 = c^2$$")

// 공문서 모드 — 항목부호 8단계 + 내어쓰기 + 공식 여백/명조 자동
const gongmun = await markdownToHwpx("1. 추진배경\n  - 세부 항목\n2. 추진계획", {
  gongmun: { preset: "보고서" },  // official | report | plan | notice | minutes | gaejosik | press
})

// 정부 표준 개조식 보고서 (v4.0) — 표지·목차(장식 배너)·로마숫자 장헤더·
// 본문 제목박스·쪽번호("- 1 -", 표지·목차 제외)까지 실측 정부 양식 그대로
const report = await markdownToHwpx(md, {
  gongmun: {
    preset: "개조식",
    cover: { org: "기관명", date: "2026. 7. 11." },
    toc: true,                       // h2 목록 → Ⅰ Ⅱ Ⅲ 목차 (개조식 기본 켜짐)
    approval: ["담당", "팀장", "과장"], // 결재란 (선택)
    pageNumbers: true,               // 쪽번호 (개조식·보고서·계획서 기본 켜짐)
    endMark: false,                  // 본문 끝 "끝." (기안문 기본 켜짐)
  },
})
// 표는 실측 정부 문법 자동 적용: 헤더 음영+bold+하변 이중선, 외곽 0.4mm 위계,
// 라벨열 음영, 내용 비례 열폭(수치 열 실폭 고정), 본문폭보다 좁게 + 우측 배치
```

CLI로도: `kordoc generate 보고서.md -o 보고서.hwpx --preset 개조식 --org 기관명 --approval 담당,팀장,과장`
(`--toc/--no-toc` `--cover/--no-cover` `--page-numbers` `--end-mark` `--no-body-title-box` `--fonts` `--sizes`)

### 레이아웃 보존 렌더 (HWPX → SVG)

한컴이 HWPX에 저장하는 조판 캐시(줄 좌표·셀 그리드·개체 앵커)를 그대로 SVG 절대배치로
그립니다. 조판 엔진 없이 빠르고, 서버에 한컴 설치 없이 원본 모양 미리보기를 만들 수
있습니다. 다페이지 세로 스택·검색어 형광펜·그리기 도형 지원(v3.14~15). 조판 캐시가 없는
파일(`markdownToHwpx` 산출물·AI 생성본·편집본)은 `reflow: true`를 주면 **순수 TS reflow
엔진**이 직접 조판합니다(v3.15). 수식 개체는 미지원.

```typescript
import { renderHwpxToSvg } from "kordoc"

const r = await renderHwpxToSvg(readFileSync("결재문서.hwpx"), { highlights: ["예산"] })
writeFileSync("결재문서.svg", r.svg)
// r.width/r.height (pt), r.pageCount, r.stats { texts, images, tables }, r.warnings

const g = await renderHwpxToSvg(generatedHwpx, { reflow: true }) // 조판 캐시 없는 생성본
```

CLI로도: `kordoc render 결재문서.hwpx -o 결재문서.svg` (`--reflow`·`--highlight 예산,집행`),
연속 렌더는 `kordoc render-worker`(stdin NDJSON, 미리보기 앱 연동용)

### 페이지 범위 지정

```typescript
const result = await parse(buffer, { pages: "1-3" })      // 1~3 페이지만
const result = await parse(buffer, { pages: [1, 5, 10] })  // 특정 페이지
```

### OCR (스캔/이미지 PDF) — 내장 엔진 (v4.2.0+)

```typescript
// 내장 OCR (PP-OCRv5 korean, 첫 사용 시 모델 ~18MB 자동 다운로드)
const result = await parse(buffer, { ocr: true })     // OCR 필요 페이지만 자동 판정
const result = await parse(buffer, { ocr: "force" })  // 전 페이지 강제 OCR
```

- **API 키·외부 서비스 불필요** — det(선 검출)+rec(CTC 인식) ONNX 를 로컬 CPU 로 추론합니다
  (PaddlePaddle 공식 변환본, Apache-2.0 / 한국어 사전 11,945자 — 완성형 한글 전량).
- **페이지 단위 정밀 적용** — 텍스트층이 없는 스캔 페이지, ToUnicode 가 깨진 페이지
  (`needsOcr` 신호)만 OCR 하고 정상 페이지의 파싱 결과는 그대로 유지합니다.
- **표 복원** — OCR 라인 좌표를 기존 블록 파이프라인(xy-cut 읽기 순서 + 클러스터 표
  감지)에 태우므로 스캔본에서도 표 구조가 복원됩니다.
- 외부 OCR 을 쓰고 싶으면 종전대로 프로바이더 함수를 전달하세요:

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage) // Claude Vision, Tesseract 등
  }
})
```

### PDF 텍스트 품질 신호 (v2.9.0+)

PDF는 텍스트층이 있어도 ToUnicode/CMap이 깨졌거나 NUL 등 제어문자가 섞이는 경우가 많다. `parsePdf` 결과는 페이지별 품질 신호를 함께 반환한다.

```typescript
const r = await parsePdf(buffer)
if (r.success && r.qualitySummary?.needsOcr) {
  // 내장 OCR 로 재시도 (v4.2.0+) — 또는 외부 OCR 큐로 라우팅
  const retried = await parse(buffer, { ocr: true })
}

// 페이지 단위 신호
for (const p of r.pageQuality ?? []) {
  if (p.needsOcr) console.log(`p${p.page} 검토 필요: ${p.ocrReason}`)
}
```

신호 키: `textChars`, `hangulRatio`, `controlCharRatio`, `replacementCharRatio`, `puaRatio` / `needsOcr` (페이지·문서 단위) / `ocrReason` (`low_text` | `high_pua` | `high_control` | `high_replacement`).

## CLI

```bash
npx kordoc 사업계획서.hwpx                          # 터미널 출력
npx kordoc 보고서.hwp -o 보고서.md                  # 파일 저장
npx kordoc *.pdf -d ./변환결과/                     # 일괄 변환
npx kordoc 검토서.hwpx --format json               # JSON (blocks + metadata 포함)
npx kordoc 보고서.hwpx --pages 1-3                  # 페이지 범위
npx kordoc fill 신청서.hwpx -f '성명=홍길동,주소=서울' -o 결과.hwpx  # 양식 채우기
npx kordoc fill 신청서.hwpx -j values.json -o 결과.hwpx             # JSON 파일로 채우기
npx kordoc fill 신청서.hwpx --dry-run                               # 필드 목록만 확인
npx kordoc generate 보고서.md -o 보고서.hwpx --preset 보고서         # 마크다운 → 공문서 HWPX
npx kordoc patch 원본.hwpx 편집.md -o 반영.hwpx      # 서식 보존 라운드트립 패치 (.hwp도 자동 분기)
npx kordoc seal 신청서.hwpx --image 도장.png --anchor "(인)" -o 날인.hwpx  # 도장/서명 날인
npx kordoc validate 산출물.hwpx                      # HWPX 구조 검증 (ZIP·필수 파트·XML)
npx kordoc lint 보고서.hwpx                          # 공문서 표기법 검수 13룰 (v4.0.1)
npx kordoc render 결재문서.hwpx -o 미리보기.svg      # 레이아웃 보존 SVG 렌더 (--reflow 지원)
npx kordoc watch ./수신함 -d ./변환결과              # 폴더 감시 모드
npx kordoc watch ./문서 --webhook https://api/hook  # 웹훅 알림
```

## MCP 서버 (Claude / Cursor / Windsurf)

**자동 설치 (추천)**:

```bash
npx -y kordoc setup
```

대화형으로 AI 클라이언트를 감지해 설정 파일을 자동 패치. Windows 에서 `cmd /c npx` 래핑도 자동. 상세는 위 [30초 설치](#-30초-설치-ai-에이전트-연동) 섹션.

**수동 등록 (macOS / Linux)**:

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "npx",
      "args": ["-y", "kordoc", "mcp"]
    }
  }
}
```

**수동 등록 (Windows — Claude Desktop 이 `.cmd` 를 못 찾을 때)**:

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "kordoc", "mcp"]
    }
  }
}
```

**15개 도구:**

| 도구 | 설명 |
|------|------|
| `parse_document` | HWP/HWPX/PDF/XLSX/DOCX → 마크다운 (메타데이터 포함) |
| `detect_format` | 매직 바이트로 포맷 감지 |
| `parse_metadata` | 메타데이터만 빠르게 추출 |
| `parse_pages` | 특정 페이지 범위만 파싱 |
| `parse_table` | N번째 테이블만 추출 |
| `compare_documents` | 두 문서 비교 (크로스 포맷) |
| `parse_form` | 양식 필드를 JSON으로 추출 |
| `fill_form` | 양식 템플릿에 값 채우기 (HWPX 원본 서식 보존, 서식/유일성 가드) |
| `patch_document` | 편집된 마크다운을 원본 HWPX/HWP에 서식 보존 반영 (v3.3) |
| `extract_profile` | 참조 HWPX에서 표 서식 프로필(JSON) 추출 — generate_document의 profile_path로 재현 |
| `generate_document` | 마크다운(표·수식·차트 포함) → HWPX 생성, 공문서 프리셋 (v3.5) |
| `place_seal` | 도장/서명 이미지를 앵커 문구 위에 부유 배치 (v3.16) |
| `render_document` | HWPX를 조판 그대로 PNG 이미지/SVG로 렌더 — 생성·수정 결과를 AI가 눈으로 검증 (v4.1) |
| `redact_document` | 개인정보(주민번호·전화·이메일·카드·계좌) 탐지 + 서식 보존 마스킹, 리포트 반환 (v4.1) |
| `parse_chunks` | RAG용 구조 청크 JSON — 헤딩·개조식 위계 breadcrumb + 표 독립 청크 (v4.1) |

## API

### 핵심 함수

| 함수 | 설명 |
|------|------|
| `parse(buffer, options?)` | 포맷 자동 감지 → Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX 전용 |
| `parseHwp(buffer, options?)` | HWP 5.x 전용 |
| `parseHwp3(buffer, options?)` | HWP 3.x (1996~2002 구버전) 전용 |
| `parsePdf(buffer, options?)` | PDF 전용 |
| `parseXlsx(buffer, options?)` | XLSX 전용 |
| `parseXls(buffer, options?)` | XLS (Excel 97~2003, BIFF8) 전용 |
| `parseDocx(buffer, options?)` | DOCX 전용 |
| `parseHwpml(buffer, options?)` | HWPML (XML 기반 HWP) 전용 |
| `detectFormat(buffer)` | `"hwpx" \| "hwp" \| "hwp3" \| "hwpml" \| "pdf" \| "xlsx" \| "xls" \| "docx" \| "unknown"` |

### 고급 함수

| 함수 | 설명 |
|------|------|
| `compare(bufferA, bufferB, options?)` | IR 레벨 문서 비교 |
| `extractFormFields(blocks)` | IRBlock[]에서 양식 필드 인식 |
| `extractFormSchema(blocks)` | 양식 필드 인식 + 타입/필수/빈값 추론 (v3.1) |
| `fillForm(input, values, outputFormat?)` | 양식 템플릿에 값 채우기 — outputFormat: `"markdown"`(기본)/`"hwpx"`/`"hwpx-preserve"`, 반환 `{ output, format, fill }` |
| `fillFormFields(blocks, values)` | IRBlock[] 기반 필드 값 교체 |
| `fillHwpx(buffer, values)` | HWPX XML 직접 조작 (원본 서식 보존) |
| `patchHwpx(original, editedMarkdown, options?)` | 편집 마크다운 → 원본 HWPX 서식 보존 in-place 패치 (v3.0) |
| `patchHwp(original, editedMarkdown, options?)` | 편집 마크다운 → 원본 HWP 5.x 바이너리 서식 보존 패치 (v3.0.1) |
| `openHwpxDocument(bytes, options?)` | 에디터용 블록 단위 증분 패치 세션 `HwpxSession` (v3.1) |
| `patchHwpxBlocks(bytes, edits, options?)` | 세션 없이 블록 편집 1회 패치 (v3.1) |
| `markdownToHwpx(markdown, options?)` | Markdown → HWPX 역변환 (테마 옵션 지원) |
| `markdownToPdf(markdown, options?)` | Markdown → PDF 생성 (Print Renderer) |
| `blocksToPdf(blocks, options?)` | IRBlock[] → PDF 생성 |
| `renderHtml(blocks, options?)` | IRBlock[] → 인쇄용 HTML |
| `renderHwpxToSvg(buffer, options?)` | HWPX → 레이아웃 보존 SVG — 다페이지·형광펜·도형, 캐시 없으면 `reflow` (v3.10~15) |
| `placeSealHwpx(buffer, seals)` | 도장/서명 이미지를 앵커 문구 위에 부유 배치 (v3.16) |
| `validateHwpx(buffer)` | HWPX 구조 검증 — ZIP·mimetype·필수 파트·XML 웰폼드 (v3.16) |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown 문자열 |

### 타입

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode, OutlineItem,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult, FillResult, HwpxFillResult, FillOutputFormat, FillFormOutput,
  PatchOptions, PatchResult, PatchSkip,
  HwpxTheme, MarkdownToHwpxOptions,
  PrintPreset, PrintOptions, PageMargin,
  RenderSvgOptions, RenderSvgResult,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## 지원 포맷

| 포맷 | 엔진 | 특징 |
|------|------|------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | 매니페스트, 중첩 테이블, 병합 셀, 손상 ZIP 복구 |
| **HWP 5.x** (한컴 레거시) | OLE2 + CFB | 배포용 복호화, 손상 CFB 복구, 각주/하이퍼링크, 21종 제어문자, 이미지 추출 |
| **HWP 3.x** (1996~2002) | 단일 binary | 상용조합형→유니코드, 5,893자 한자/기호 lookup, nested paragraph 추출 |
| **HWPML 2.x** (XML 기반 HWP) | XML DOM | HeadingType 기반 헤딩 감지, 병합 셀, DoS 방어 |
| **PDF** | pdfjs-dist | 선 기반 테이블, XY-Cut 읽기 순서, 헤딩 감지, OCR, 텍스트 품질 신호 |
| **XLSX** (Excel) | ZIP + XML DOM | 공유 문자열, 병합 셀, 다중 시트, 수식 표시 |
| **XLS** (Excel 97~2003) | OLE2 + BIFF8 | Workbook 스트림, SST 공유 문자열, 셀/시트 추출 |
| **DOCX** (Word) | ZIP + XML DOM | 스타일 heading, 번호 매기기, 각주, 이미지 추출 |

## 보안

프로덕션급 보안 강화: ZIP bomb 방지, XXE/Billion Laughs 방지, 압축 폭탄 방지, 경로 순회 차단, MCP 에러 정제, 파일 크기 제한(500MB). 자세한 내용은 [SECURITY.md](./SECURITY.md) 참조.

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다.
5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.

## 라이선스

[MIT](./LICENSE)

이 프로젝트는 아래 오픈소스를 포함합니다:
- **rhwp** (MIT, edwardkim) — HWP5 배포용 복호화 및 lenient CFB 파싱 알고리즘
- **OpenDataLoader PDF** (Apache 2.0, Hancom Inc.) — PDF 테이블 감지 알고리즘
- **cfb** (Apache 2.0, SheetJS) — HWP5 OLE2 컨테이너 파싱
- **pdfjs-dist** (Apache 2.0, Mozilla) — PDF 텍스트 추출
- **JSZip** (MIT, Stuart Knightley 외) — ZIP 기반 포맷 파싱

자세한 내용은 [NOTICE](./NOTICE) 파일을 참조하세요.
