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
npm run bench:gate     # 코퍼스 회귀 게이트 체인 (score·roundtrip·pdf-table·formats·fuzz·reflow) — prepublishOnly에 배선
npm run bench:visual   # 한컴 실렌더 시각 오라클 (macOS GUI 전용, 발행 전 수동 1회 — bench/visual/, 순수 로직은 hash-lib.mjs)
```

ESLint, Prettier 미설정 상태. 벤치 코퍼스(`bench/corpus/`)는 gitignore — 없으면 맥미니(`ssh sm`)에서 rsync.

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
| `src/hwpx/gongmun-lint.ts` | 공문서 표기법 검수 13룰(편람 — 날짜·시간·금액·붙임·쌍점 등) — generate 경고 채널 + `kordoc lint` (v4.0.1) |
| `src/hwpx/gen-docframe.ts` | 공문서 골격(v4.0.2) — 기안문 두문·결문(별지 제1호서식), 보고정보 행, 공고문 공고번호·발신명의, 보도자료 머리박스·담당 표. charPr는 variant·프로필 뒤 동적 id, 미사용 시 미방출 (spec (h)장) |
| `src/hwpx/gen-gaejosik.ts` | 개조식 XML 조립 — 표지(파랑 바)·목차(1×7 스트라이프 배너+테두리 박스)·로마숫자 장 헤더 표·본문 첫 페이지 제목 반복 박스 (기하는 sizes 비례 스케일) |
| `src/hwp5/parser.ts` | HWP 5.x(OLE2) 바이너리 파싱, 배포용 복호화, 각주/하이퍼링크 |
| `src/hwp5/record.ts` | 레코드 리더, UTF-16LE, zlib 압축해제 |
| `src/hwp5/aes.ts` | AES-128 ECB 순수 JS 구현 (배포용 복호화용) |
| `src/hwp5/crypto.ts` | HWP 배포용 문서 복호화 (MSVC LCG + AES) |
| `src/hwp5/cfb-lenient.ts` | 손상된 CFB 파일 복구 파서 (rhwp 포팅) |
| `src/hwp3/parser.ts` | HWP 3.x(1996~2002, 단일 binary stream) 텍스트 추출 — header + raw deflate + paragraph_list |
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
| `src/pdf/image-regions.ts` | 이미지 XObject 영역 추출 |
| `src/pdf/image-extract.ts` | 이미지 XObject 바이트 추출 — 비동기 디코딩 대기 + 순수 JS PNG 인코딩, 표 병합 후 페이지 말미 주입 |
| `src/pdf/line-types.ts` | 선 감지 공유 타입/상수 |
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
| `src/ocr/provider.ts` | 이미지 기반 PDF용 OCR 페이지 렌더링 |
| `src/page-range.ts` | 페이지 범위 문자열 파싱 (`"1-3,5"` → `Set<number>`) |
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
- **본문폭급 표(48180)는 outMargin 좌우 0**: 283이면 진행폭(w+566)이 컬럼폭을 넘어 1mm
  침범 — 실물(t2)도 표지 표만 0. `gen-gaejosik.ts table()`이 w 기준 자동 분기 (v4.0.2)
