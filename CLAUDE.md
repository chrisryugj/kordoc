# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**kordoc** — 한국 공문서(HWP 5.x, HWPX, PDF, XLSX, DOCX)를 마크다운으로 변환하는 파서 라이브러리.
npm 패키지로 배포되며, 3가지 인터페이스 제공: 라이브러리 API, CLI(`kordoc`), MCP 서버(`kordoc-mcp`).

## 빌드 & 개발

```bash
npm run build          # tsup으로 ESM+CJS 듀얼 빌드 → dist/
npm run dev            # watch 모드
npm test               # node --test + tsx 로더 (tests/*.test.ts)
npm run bench:gate     # 코퍼스 회귀 게이트 체인 (score·roundtrip·pdf-table·formats·fuzz·reflow·pages) — prepublishOnly에 배선
npm run bench:visual   # 한컴 실렌더 시각 오라클 (macOS GUI 전용, 발행 전 수동 1회 — bench/visual/, 순수 로직은 hash-lib.mjs)
```

ESLint, Prettier 미설정 상태. 벤치 코퍼스(`bench/corpus/`)는 gitignore — 없으면 맥미니(`ssh sm`)에서 rsync.

### 코퍼스 동기화 (2026-09-05 기준선)

맥북·맥미니 양쪽 `bench/corpus/` 는 바이트 동일로 맞춰 둔다. 2026-09-05 에 법령 별지서식
`licbyl/`(법제처 licbyl API 표본 300건 — HWP5 원본 + PDF + rhwp v0.8.6 `export-hwpx` 변환 HWPX,
`bench/collect-licbyl.mjs` seed 20260905 로 재현) 900파일, 같은 날 v4.12.2 에서 `licbyl2/`(서식 2차,
seed 20260906 `--exclude=licbyl`, 279쌍 — 표본 풀 소진으로 300 미달) 837파일과 `licbyl-byl/`(별표
`--knd=1`, 90쌍) 271파일, v4.12.3 에서 `licbyl-byl2/`(별표 3차, seed 20260907 `--knd=1
--exclude=licbyl,licbyl2,licbyl-byl`, 183쌍 — 풀 소진으로 200 미달) 549파일이 들어와 게이트 모수는 hwpx ~1,390·pdf
~950·hwp쌍 ~860 이다. rhwp 변환본 가운데 자기참조 GT 정렬이 깨지는 것(licbyl 5 + licbyl2 11 + licbyl-byl2 1)은
`known-false-miss/` 에 격리했다(README
참조 — 판정 기준은 **HWP5 쌍 유사도 1 + 미스 문자열이 파서 출력에 있음**, 둘 다 확인하고 옮길 것).
rhwp 바이너리는 GH release v0.8.6 macos-aarch64(스크래치에 두고 `rhwp export-hwpx in.hwp out.hwpx`).
종전(2026-08-22) 모수는 hwpx 350·pdf 92·hwp쌍 23 — `score.mjs` 의 `MIN_POP` 하한(170/25/12)에 여유가 있다.
HWP5↔PDF 셀 대조 보고 지표는 `node bench/cmp-hwp-pdf.mjs licbyl [--linebreaks]`(licbyl 0.965·licbyl2
0.966·별표 0.746·별표 3차 0.787 — 별표가 낮은 원인은 v4.12.3 실측으로 A 1×1 틀 PDF 미감지 8 / B HWP5
`flattenLayoutTables` 해체 vs PDF 1열 유지 15 / C 구조 차 7(수식 셀·쪽 경계 분할, 파서 결함 아님) — 게이트 아님).

hwp쌍 23은 `corpus/pairs`(10) + `corpus/hwp5`(13)이 아니라 **`korea-kr`·`misc` 의 hwp+hwpx
동명 짝까지 합산한 값**이다. 이 폴더들이 한쪽에만 있으면 쌍이 10으로 떨어져
`❌ 모수 하한 미달` 로 게이트가 죽는다 — 지표는 전부 만점인데 모수만 미달하는 형태라
품질 회귀로 오진하기 쉽다.

```bash
# 기기 간 코퍼스 동기화 — rtk 훅이 rsync 를 리라이트해 출력을 삼키므로 절대경로로 호출
cd bench/corpus && /usr/bin/rsync -a --exclude '.DS_Store' <디렉토리…> sm:~/workspace/kordoc/bench/corpus/
```

`fuzz-sweep` 의 `slow` 판정은 30s 벽시계 임계라 **다른 게이트와 동시 실행하면 플레이크**다.
실측(2026-08-22): 단독 최장 17.2s → 두 기기 게이트 병주 중 30.6s 로 FAIL. 코드 결함과
구분하려면 `node bench/fuzz-sweep.mjs --gate` 를 부하 없이 단독 재실행해 볼 것.

## 아키텍처

### 파싱 파이프라인

모든 포맷은 **IRBlock[]** (Intermediate Representation)으로 변환 후 마크다운 생성:

```
Buffer → detectFormat() [매직바이트] → 포맷별 파서 → IRBlock[] → blocksToMarkdown() → Markdown
```

### 핵심 모듈 구조

| 모듈 | 역할 |
|------|------|
| `src/index.ts` | 메인 API (`parse`, `parseHwpx`, `parseHwp`, `parseHwp3`, `parsePdf`, `parseXlsx`, `parseDocx`) |
| `src/types.ts` | IR 타입 (`IRBlock`, `IRTable`, `IRCell`, `ParseResult`), 공통 상수 |
| `src/utils.ts` | 공용 유틸 (`toArrayBuffer`, `sanitizeError`, `precheckZipSize`, `sanitizeHref`, `classifyError`, `stripDtd`, `safeMin/Max`) |
| `src/detect.ts` | 매직바이트 기반 포맷 감지, `detectZipFormat()`으로 HWPX/XLSX/DOCX 구분 |
| `src/hwpx/parser.ts` | HWPX 파싱 엔트리 (구현은 8모듈로 분리 — 재수출 허브) |
| `src/hwpx/section-walker.ts` | 섹션 XML 워커 (문단/표/도형 상호재귀 클러스터) |
| `src/hwpx/styles.ts` | head.xml 스타일/번호매기기 파싱 + 스타일 기반 헤딩 감지 |
| `src/hwpx/para-heading.ts` | 항목부호 자동번호 포맷 해석 |
| `src/hwpx/table-build.ts` | TableState → IRTable 구성 |
| `src/hwpx/images.ts` | 이미지 ref → ZIP 바이너리 해제 (dedupe·ZIP bomb 가드) |
| `src/hwpx/metadata.ts` | Dublin Core 메타데이터 추출 |
| `src/hwpx/zip-sections.ts` | 손상 ZIP 복구 + Manifest 섹션 경로 해석 |
| `src/hwpx/parser-shared.ts` | 공유 상수(ZIP 한도)·타입(WalkCtx)·XML 유틸 |
| `src/hwpx/generator.ts` | Markdown → HWPX 역변환 엔트리 (구현은 7모듈로 분리 — 재수출 허브) |
| `src/hwpx/gen-section.ts` | secPr + 본문 section0.xml 조립 |
| `src/hwpx/gen-header.ts` | container/manifest/head.xml 생성 |
| `src/hwpx/gen-table.ts` | GFM/HTML(병합) 표 XML 생성 — 내용 비례 열폭(짧은 열 실폭 고정) + 실측 정부 표 문법(헤더 음영·bold·하변 이중선, 외곽 0.4mm 위계, 라벨열, 셀 CENTER 130%/LEFT, 축폭+우측 배치) |
| `src/hwpx/gen-table-bf.ts` | 표 셀 위치별 borderFill 동적 레지스트리 — 외곽 0.4/내부 0.12/헤더 DOUBLE_SLIM 조합 dedupe 발급, header.xml에 일괄 방출 |
| `src/hwpx/gen-gongmun-extra.ts` | 공문서 부속 요소 — 결재란(2×N 서명 표)·"끝." 표시·1페이지형 제목박스(색상바+gradient) |
| `src/hwpx/font-catalog.ts` | 폰트 카탈로그 — fonts 오버라이드 오타·미설치 경고(`unknownFontWarnings`), 생성은 진행 |
| `src/hwpx/gen-gongmun-fit.ts` | 공문 자동장평 계획 + 리스트 항목부호 선계산 |
| `src/hwpx/md-runs.ts` | 마크다운 블록/인라인 파싱 + run/문단 XML |
| `src/hwpx/gen-ids.ts` | 생성용 NS/charPr/paraPr id 상수·테마·XML 원자 |
| `src/hwpx/gen-profile.ts` | 서식 프로필(#41) — 타입·표별 id 리맵(전역 재할당)·borderFill/charPr XML 빌더 + 표 매칭(`takeProfile` — 행·열 필수, anchor_text 우선, 앵커 없으면 table_index=방출순번) |
| `src/hwpx/extract-profile.ts` | hwpx → FormatProfile 추출 (`hwpxToProfile`) — header/section 원문 파싱, top-level 표만, 첫 셀 anchor_text 포함(스키마 0.2.0) |
| `src/hwpx/equation.ts` | HWPX 수식 script(HULK) → LaTeX 변환 (hml-equation-parser 포팅) |
| `src/hwpx/equation-generate.ts` | Markdown display math → EqEdit script + `<hp:equation>` XML (equation.ts 토큰맵과 왕복 정합) |
| `src/hwpx/gongmun.ts` | 공문서 모드 순수 로직 — 항목부호 8단계 시퀀스(가나다·단모음연속·원숫자), 단계별 들여쓰기(`levelIndent`), 단일형제 부호생략, 프리셋 해석(7종 — 기안문·보고서·계획서·통지·회의록·개조식·보도자료), bullet2 ㅇ/○ (v4.0.2) |
| `src/hwpx/gaejosik.ts` | 개조식(정부 표준 보고서) 순수 로직 — □○-※ 부호·크기 체계·실측 색/기하 상수 (docs/gongmunseo-engine-spec.md (f)장) |
| `src/hwpx/gongmun-lint.ts` | 공문서 표기법 검수 19룰(편람 — 날짜·시간·금액·붙임·쌍점 등 13 + v4.12.1 금액 한글병기·물결표·두음법칙·외래어·차별표현·"끝." 누락 6) + AI 슬롭 2룰(v4.9.0) — generate 경고 채널 + `kordoc lint` (v4.0.1). `END_MARK_MISSING` 은 `{ document: true }`(lint CLI) 에서만. `COLON_SPACE` 는 표 줄 건너뜀(`skipTable` — 법정 서식 라벨 셀 "성 명 :" 은 규칙 대상 아님), `DATE_NO_SPACE` 는 법제처 연혁 표기(`<개정 2012.2.14>`·`[시행일:…]`) 제외 (v4.12.3). 룰을 손대면 `gate-fill*`(실결재 기안문 206) + `licbyl`(서식 595) 파싱 텍스트에 돌려 오탐을 실측할 것(v4.12.2 TILDE·DUEUM 좁힘 근거) |
| `src/hwpx/munche-lint.ts` | 개조식 **문체** 검수 12룰(서술형 종결·당위·수사·대구·항목/결론 길이·리드문) — 보고서·계획서·개조식 프리셋 generate 경고 + `kordoc lint --munche`. 표기법(gongmun-lint)과 축이 다름, 실측 근거는 docs/gaejosik-munche.md (v4.9.1) |
| `src/hwpx/gen-docframe.ts` | 공문서 골격(v4.0.2) — 기안문 두문·결문(별지 제1호서식), 보고정보 행, 공고문 공고번호·발신명의, 보도자료 머리박스·담당 표. charPr는 variant·프로필 뒤 동적 id, 미사용 시 미방출 (spec (h)장) |
| `src/hwpx/gen-levels.ts` | 항목부호 단계별 위계 타이포 `levels`(v4.12.3) — 지정 depth 마다 charPr 쌍(보통·굵게)을 docframe 뒤 id 에, 글꼴은 정적 fontface 뒤 append(한글·라틴만 참조). 실측 근거 docs/gongmunseo-reference.md 2.7(법정 8단계는 본문 동일 90% → 기본값 무변경, □/ㅇ/- 계열은 □ HY견고딕 +2~3pt bold·ㅇ 한컴돋움 bold). 내어쓰기는 `levelIndent` `markerHeight` |
| `src/hwpx/gen-gaejosik.ts` | 개조식 XML 조립 — 표지(파랑 바)·목차(1×7 스트라이프 배너+테두리 박스)·로마숫자 장 헤더 표·본문 첫 페이지 제목 반복 박스 (기하는 sizes 비례 스케일) |
| `src/hwp5/parser.ts` | HWP 5.x(OLE2) 바이너리 파싱, 배포용 복호화, 각주/하이퍼링크 |
| `src/hwp5/record.ts` | 레코드 리더, UTF-16LE, zlib 압축해제. 하이픈 제어문자(0x18)는 한컴이 그리지 않아 미방출(v4.12.3, "60g/㎡"). 한컴 PUA-A 접힘 해제(v4.12.2; F00E1 네모 안 "인" 도 "(인)" — 한컴 PDF 실렌더 확인, v4.12.3) — WCHAR U+A000~A48C 는 U+F0000대 기호(결재란 "(인)"=F012B↔A12B), 펴서 `pua.ts` 표로 |
| `src/hwp5/aes.ts` | AES-128 ECB 순수 JS 구현 (배포용 복호화용) |
| `src/hwp5/crypto.ts` | HWP 배포용 문서 복호화 (MSVC LCG + AES) |
| `src/hwp5/cfb-lenient.ts` | 손상된 CFB 파일 복구 파서 (rhwp 포팅) |
| `src/hwp3/parser.ts` | HWP 3.x(1996~2002, 단일 binary stream) 텍스트 추출 — header + raw deflate + paragraph_list |
| `src/hwp3/drawing.ts` | 그리기 개체 트리 워커 — ch=11 확장 블록(pic_type 3)의 도형 트리를 훑어 글상자 문단 리스트 회수 (#73). 확장 블록 슬라이스 안에서만 동작해 실패해도 본문 스트림 동기가 안 깨진다 |
| `src/hwp3/records.ts` | DocInfo 128B / DocSummary 1008B / 헤더 구조 정의 |
| `src/hwp3/johab.ts` + `johab-symbols.ts` | 상용조합형 cho/jung/jong → 0xAC00 한글 음절 + 5,893개 한자/기호 lookup (rhwp 포팅) |
| `src/hwp3/reader.ts` | LE binary cursor (Buffer 기반) |
| `src/hwpml/parser.ts` | HWPML 2.x(XML 기반 HWP) 파싱, ParaShape HeadingType 기반 헤딩 감지 |
| `src/pdf/parser.ts` | PDF 텍스트 추출, XY-Cut 읽기 순서, 헤딩 감지, 머리글/바닥글 제거 (텍스트+y클러스터링) |
| `src/pdf/line-detector.ts` | 선 기반 테이블 감지 엔트리 (구현은 7모듈로 분리 — 재수출 허브) |
| `src/pdf/line-extract.ts` | 그래픽 ops → 수평/수직 선 추출 + 전처리 (음영 스택 필터, 개방 변 가상 테두리 합성) |
| `src/pdf/table-grid.ts` | 선 교차점(Vertex) 기반 테이블 그리드 구성 |
| `src/pdf/cell-extract.ts` | 그리드 → 병합 셀 구조 (createMatrix) |
| `src/pdf/cell-text.ts` | 텍스트→셀 매핑 + 셀 텍스트 조립 |
| `src/pdf/undersegmented.ts` | 과소분할 표 재구성 (row band 재유도) |
| `src/pdf/underline.ts` | 밑줄 감지 — baseline 밀착 수평선↔텍스트 상관, `<u>` 보존 (표 괘선·배지 오탐 방어 5겹) |
| `src/pdf/links.ts` | 링크 어노테이션(/Annots /URI) → [text](url) 래핑 (sanitizeHref 살균, 줄 단위) |
| `src/pdf/image-regions.ts` | 이미지 XObject 영역 추출 |
| `src/pdf/image-extract.ts` | 이미지 XObject 바이트 추출 — 비동기 디코딩 대기 + 순수 JS PNG 인코딩, 표 병합 후 페이지 말미 주입 |
| `src/pdf/line-types.ts` | 선 감지 공유 타입/상수 |
| `src/pdf/clip-cells.ts` | 셀 클립 사각형 → 표 그리드 (v4.12.1) — 한컴 PDF 의 셀별 `W n` 클립을 셀 기하로 확정(`TableGrid.cells`). 포함 관계로 층을 나눠 같은 부모끼리만 이웃 묶음(중첩표는 별도 그리드 + `clipParent`, 틀은 자기 층의 셀), 클립 그리드·틀과 면적 절반 이상 겹치는 line 그리드 제거(`dropGridsInside`). 소비측(`page-blocks.ts`)은 클립 그리드를 면적 오름차순으로 먼저 처리하고 `clipParent` 가 있는 표는 틀 셀의 `IRCell.blocks` 에 원문 순서로 넣는다(v4.12.2). 1칸 틀은 **네 변 획**이 있을 때만 1×1 그리드 — 획 없는 큰 컨테이너는 한컴 본문 영역 클립 |
| `src/pdf/text-clean.ts` | PDF 마크다운 최종 정리 — 쪽번호 제거·균등배분·`mergeKoreanLines`(한글 줄 병합). v4.12.3: `normalizeAraea`(한컴 PDF 의 ㆍ→U+119E 되돌림, 셀 blocks 포함)·`splitSingleCellTables`(중첩 없는 1×1 표는 줄마다 문단 — 1×1 줄 결합의 원인은 builder 가 아니라 mergeKoreanLines) |
| `src/pdf/symbol-fonts.ts` | Wingdings 글리프 코드 → 유니코드 복원 (v4.12.1) — pdfjs 가 심볼 폰트 코드를 Latin-1 로 돌려주는 것(`è`=0xE8 ➔)을 `page.commonObjs` 폰트 실명으로 판별해 되돌림 |
| `src/pdf/cluster-detector.ts` | 클러스터 기반 테이블 감지 (선 없는 PDF용) |
| `src/pdf/polyfill.ts` | pdfjs-dist 호환 심 (DOMMatrix, Path2D) |
| `src/pdf/quality.ts` | PDF 페이지별 텍스트 품질 신호 계산 (한글/제어문자/PUA 비율, needsOcr 판정) |
| `src/xlsx/parser.ts` | XLSX(ZIP+XML) 파싱, 공유 문자열/병합 셀 처리 |
| `src/docx/parser.ts` | DOCX(ZIP+XML) 파싱, 스타일/번호매기기/각주 처리 |
| `src/table/builder.ts` | 2-pass 그리드 테이블 빌더 + 마크다운 변환 |
| `src/render/svg-render.ts` | 레이아웃 보존 렌더 — HWPX 조판 캐시(lineseg·cellAddr·pos)를 SVG 절대배치로 (한컴 저장본 전용, 1페이지) |
| `src/render/layout.ts` | 렌더 순수 계산 — uint32 음수(toInt32), 표 열 경계 전파 솔버, 행 높이(max+콘텐츠 성장) |
| `src/render/head-styles.ts` | 렌더용 header.xml 스타일 — charPr(크기·굵기·색·장평·자간)/paraPr 정렬/borderFill |
| `src/diff/compare.ts` | 문서 비교 (블록 단위 diff) |
| `src/form/recognize.ts` | 양식 서식 레이블-값 쌍 추출, 라벨 셀 판별 |
| `src/form/match.ts` | 양식 필드 매칭 공용 유틸 (정규화, 접두사 매칭, 인셀 패턴 채우기) |
| `src/form/filler.ts` | IRBlock[] 기반 양식 필드 값 채우기 |
| `src/form/filler-hwpx.ts` | HWPX XML 직접 조작으로 양식 채우기 (원본 서식 100% 보존) |
| `src/ocr/engine.ts` | 내장 텍스트 OCR 엔진 — PP-OCRv5 korean det(DBNet)+rec(CTC) ONNX 추론, 세션 싱글턴 |
| `src/ocr/models.ts` | OCR 모델 스펙(HF 공식 변환본, SHA 핀) + inference.yml 사전 파서 |
| `src/ocr/pdf-ocr.ts` | PDF OCR 브릿지 — pdfium 래스터 → 내장 엔진/사용자 프로바이더 → 블록 파이프라인 (좌표는 PDF pt 환산, **pdfium page.number 는 0-based — +1 환산 필수**) |
| `src/ocr/ruling-lines.ts` | 래스터 괘선 감지 — 페이지 픽셀 이진화+런렝스로 표 수평/수직 선 추출 → 선 기반 표 파이프라인 공급 (오탐 방어 3겹: 최소길이 20pt·두께 상한 2.5pt·양측 잉크 포위 제외) |
| `src/ocr/image-ocr.ts` | 이미지(PNG/JPG/WebP) 직접 입력 OCR — sharp 디코딩 → 내장 엔진 상시 적용 + 괘선 감지 (216dpi 가정 좌표 환산) |
| `src/shared/offline.ts` | 폐쇄망 게이트 — `KORDOC_OFFLINE` 아웃바운드 킬스위치(`assertNetworkAllowed`), `KORDOC_ROOT` 파일 접근 루트 제한(`assertWithinRoot`, realpath 기준). **새 네트워크 호출은 반드시 여기를 경유** |
| `src/shared/model-bundle.ts` | OCR·수식 모델 오프라인 사이드로드 (`kordoc models --export/--import`) — SHA 스펙이 SSOT, manifest 없음 |
| `src/page-range.ts` | 페이지 범위 문자열 파싱 (`"1-3,5"` → `Set<number>`) |
| `src/page-markdown.ts` | 페이지별 마크다운 사영 (#68) — `IRBlock.pageNumber` 로 갈라 페이지마다 `blocksToMarkdown()`. `parse()` 가 `ParseSuccess.pages` 로 붙인다 |
| `src/watch.ts` | 디렉토리 감시 모드 + Webhook 알림 |
| `src/cli.ts` | Commander 기반 CLI |
| `src/mcp.ts` | MCP 서버 (Claude/Cursor 연동, 15개 도구) |
| `src/render/rasterize.ts` | SVG → PNG 래스터 (sharp optional, render_document MCP용) |
| `src/redact.ts` | PII 탐지·서식 보존 마스킹 순수 로직 (주민번호·전화·이메일·카드·계좌, 룰 우선순위 겹침 처리) |
| `src/chunks.ts` | RAG용 구조 청킹 — IR 위계(헤딩·listDepth·표) → breadcrumb 청크 JSON |

### 주요 설계 결정

- **IR 패턴**: 파서가 직접 마크다운을 생성하지 않고, `IRBlock[]`로 정규화 후 `blocksToMarkdown()`에서 일괄 변환
- **2-pass 테이블**: Pass 1에서 colSpan/rowSpan 고려한 그리드 크기 계산, Pass 2에서 셀 배치
- **깨진 ZIP 복구**: HWPX Central Directory 손상 시 Local File Header(PK\x03\x04) 직접 스캔
- **pdfjs-dist 외부 의존**: `external`로 번들에서 제외, 사용자가 선택적 설치. cfb는 `noExternal`로 번들에 포함
- **HWP5 레코드 구조**: 4바이트 헤더(tagId 10bit, level 10bit, size 12bit), FLAG_COMPRESSED 시 inflateRawSync
- **공문서 모드 paraPr margin**: HWPX `<hh:margin>`은 **반드시 자식요소형**(`<hc:intent>`/`<hc:left>`/`<hc:right>`/`<hc:prev>`/`<hc:next>`, `xmlns:hc` 선언 필수). 속성형(`indent="…"`)은 한컴이 무시함. 내어쓰기 = `<hc:intent>` **음수**(둘째 줄을 오른쪽으로), 깊이 들여쓰기 = `<hc:left>` 누적. (실제 한컴 공문서 파일로 검증한 모델)

### 빌드 설정 (tsup)

두 개의 빌드 파이프라인:
1. **라이브러리** (`src/index.ts`): ESM + CJS, dts 생성, `pdfjs-dist` external / `cfb` bundled
2. **바이너리** (`src/cli.ts`, `src/mcp.ts`): ESM only, shebang 자동 삽입

## 코드 작성 시 주의

- `IRBlock` 타입 변경 시 모든 파서(hwpx, hwp5, pdf)와 `table/builder.ts`에 영향
- HWP5 파서에서 21개 제어 문자 처리 로직 주의 (`record.ts`)
- PDF 파서의 Y좌표 그룹핑은 2px tolerance, 갭 감지는 15px(탭)/3px(공백)
- `parse()` 함수는 `detectFormat()` 결과로 자동 분기 — 새 포맷 추가 시 여기에 분기 추가
- **`breakNonLatinWord`는 이름 역전**: `BREAK_WORD`=어절 유지, `KEEP_WORD`=글자 단위
  (한글 COM 실렌더 실측 — `docs/gongmunseo-engine-spec.md` (f)장 줄나눔 절 참조).
  어절 줄바꿈 의도로 `KEEP_WORD`를 쓰면 정확히 반대로 나온다. `breakLatinWord`는 이름대로.
- 한글 실조판 검증은 COM 자동화(HWPFrame.HwpObject `Open`→`SaveAs PDF`)로 사람 없이 가능 —
  `bench/hangul-com-pdf.ps1` → `bench/extract-pdf-lines.mjs` → `bench/verify-junctions.mjs` 체인
- **OUTLINE 헤딩 금지 (공문서 모드)**: `<hh:heading type="OUTLINE">` 문단은 한글이 개요
  번호("1.", "1.1.")를 강제로 그린다 — `outlineShapeIDRef=0`·`numFormat=NONE`으로도 못 끔
  (COM 실렌더 실측). 공문서 모드는 명명 스타일("개요 N") + 파서의 스타일명 헤딩 감지로 왕복 보존
- **treatAsChar 표의 줄간격**: 표를 담는 호스트 문단의 lineSpacing %가 표 줄높이에 곱해진다 —
  페이지급 대형 표(목차 박스 등)는 저줄간격 호스트(GJ_PARA_BAR류) 필수, 아니면 페이지 분리됨
- **HWPX 스타일 요소 전수 분석**은 `scripts/style-digest.mjs`로 압축 JSON 덤프 후 대조
  (골라 읽기 금지 — 실측 원본 16종 전수 대조로 v4.0.0 스펙 확정한 방법론)
- **colPr 필수 (생성 경로)**: 섹션 첫 run에 secPr 뒤 `<hp:colPr colCount="1">`이 없으면
  한글이 컬럼 영역을 좌우 10mm씩 좁게 잡는다 — 본문 우측 미달 + 광폭 treatAsChar 표의
  우측 여백 침범 (v4.0.2 GAP-01, COM 실렌더 실측). 새 섹션 생성 경로 추가 시 누락 금지
- **아웃바운드는 2곳뿐** (`src/pdf/formula/models.ts` 모델 다운로드, `src/watch.ts` webhook).
  둘 다 `assertNetworkAllowed()` 뒤에 있다 — 세 번째를 만들지 말 것. 폐쇄망 배포의 근거
  문서(`docs/offline-deployment.md`)가 "fetch 는 2건"을 재현 가능한 grep 으로 주장한다
- **한컴 PDF 표는 클립이 진실**: 한컴 PDF 1.3 은 표 셀마다 `W n` 클립 사각형을 깐다(획 괘선과
  무관). 별지서식처럼 테두리 "없음" 셀이 많은 표는 획으로는 복원이 안 되고, 실선 표도 line
  경로(교차점 클러스터·MIN_COL_WIDTH 병합)보다 클립 셀이 정확하다 — pdf-table-gt cellExact
  0.73 → 0.96 (v4.12.1). 클립 셀 판정을 손댈 때는 `bench/pdf-table-gt.mjs` 와
  `licbyl/` HWP↔PDF 셀 대조를 함께 볼 것. `mergeParallelLines` 는 입력 선 객체를 **제자리 수정**하므로
  전처리 뒤의 선을 클립 판정(획 유무)에 넘기면 결과가 달라진다
- **HWP5 `flattenLayoutTables` 는 서식 틀을 남긴다**: 중첩표를 품고 글이 `FORM_FRAME_MAX_TEXT`(600자)
  이하인 표는 레이아웃 표가 아니라 별지서식 틀(3×1 제목행+틀+꼬리행) — HWPX·PDF 파서와 같은 모양으로
  유지(v4.12.2). 페이지 사슬 레이아웃 표(글 많음)는 종전대로 해체. 임계를 바꾸면 `pairs/`·`misc/` 의
  동의서·카테고리 표가 움직인다
- **PDF 1칸 틀은 획 4변이 조건**: 한컴 PDF 는 본문 영역(여백 안쪽)에도 클립을 깔고 그 안에 페이지의
  모든 표·칩이 들어간다. 획 없는 컨테이너를 틀로 삼으면 페이지가 통째로 1×1 표가 되어 pair 게이트가
  0.985 → 0.87 로 무너진다(v4.12.2 실측). 테두리 없는 1칸 틀(별표 1×1 프레임·선서문 바깥)은 v4.12.3 부터
  **제목 아래 틀** 기하로만 삼는다(`titledFrame`: 윗변 ≥ 페이지 20%·폭 ≥ 60%·머리말 띠 아래 위쪽에 글 존재·안에 글 존재).
  "문서 전 페이지 반복 클립 = 본문 영역" 가설은 반증됨(본문 영역 클립은 쪽마다 y1 이 다르고 별표는 1쪽). 폭 조건을
  빼면 2단 채용공고 단 상자(폭 38%)가 틀이 되어 pdf-table-gt cellF1 0.945 → 0.933 회귀(pair06 실측)
- **본문폭급 표(48180)는 outMargin 좌우 0**: 283이면 진행폭(w+566)이 컬럼폭을 넘어 1mm
  침범 — 실물(t2)도 표지 표만 0. `gen-gaejosik.ts table()`이 w 기준 자동 분기 (v4.0.2)
