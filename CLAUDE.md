# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**kordoc** — 한국 공문서(HWP 5.x, HWPX, PDF, XLSX, DOCX)를 마크다운으로 변환하는 파서 라이브러리.
npm 패키지로 배포되며, 3가지 인터페이스 제공: 라이브러리 API, CLI(`kordoc`), MCP 서버(`kordoc-mcp`).

## 빌드 & 개발

```bash
npm run build          # tsup으로 ESM+CJS 듀얼 빌드 → dist/
npm run dev            # watch 모드
```

테스트 프레임워크, ESLint, Prettier 미설정 상태.

## 아키텍처

### 파싱 파이프라인

모든 포맷은 **IRBlock[]** (Intermediate Representation)으로 변환 후 마크다운 생성:

```
Buffer → detectFormat() [매직바이트] → 포맷별 파서 → IRBlock[] → blocksToMarkdown() → Markdown
```

### 핵심 모듈 구조

| 모듈 | 역할 |
|------|------|
| `src/index.ts` | 메인 API (`parse`, `parseHwpx`, `parseHwp`, `parsePdf`, `parseXlsx`, `parseDocx`) |
| `src/types.ts` | IR 타입 (`IRBlock`, `IRTable`, `IRCell`, `ParseResult`), 공통 상수 |
| `src/utils.ts` | 공용 유틸 (`toArrayBuffer`, `sanitizeError`, `precheckZipSize`, `sanitizeHref`, `classifyError`) |
| `src/detect.ts` | 매직바이트 기반 포맷 감지, `detectZipFormat()`으로 HWPX/XLSX/DOCX 구분 |
| `src/hwpx/parser.ts` | HWPX(ZIP+XML) 파싱, 깨진 ZIP 복구 |
| `src/hwpx/generator.ts` | Markdown → HWPX 역변환 |
| `src/hwp5/parser.ts` | HWP 5.x(OLE2) 바이너리 파싱 |
| `src/hwp5/record.ts` | 레코드 리더, UTF-16LE, zlib 압축해제 |
| `src/pdf/parser.ts` | PDF 텍스트 추출, XY-Cut 읽기 순서, 헤딩 감지, 머리글/바닥글 제거 |
| `src/pdf/line-detector.ts` | PDF 그래픽 명령 기반 선 테이블 감지 |
| `src/pdf/cluster-detector.ts` | 클러스터 기반 테이블 감지 (선 없는 PDF용) |
| `src/pdf/polyfill.ts` | pdfjs-dist 호환 심 (DOMMatrix, Path2D) |
| `src/xlsx/parser.ts` | XLSX(ZIP+XML) 파싱, 공유 문자열/병합 셀 처리 |
| `src/docx/parser.ts` | DOCX(ZIP+XML) 파싱, 스타일/번호매기기/각주 처리 |
| `src/table/builder.ts` | 2-pass 그리드 테이블 빌더 + 마크다운 변환 |
| `src/diff/compare.ts` | 문서 비교 (블록 단위 diff) |
| `src/form/recognize.ts` | 양식 서식 레이블-값 쌍 추출 |
| `src/ocr/provider.ts` | 이미지 기반 PDF용 OCR 페이지 렌더링 |
| `src/page-range.ts` | 페이지 범위 문자열 파싱 (`"1-3,5"` → `Set<number>`) |
| `src/watch.ts` | 디렉토리 감시 모드 + Webhook 알림 |
| `src/cli.ts` | Commander 기반 CLI |
| `src/mcp.ts` | MCP 서버 (Claude/Cursor 연동, 7개 도구) |

### 주요 설계 결정

- **IR 패턴**: 파서가 직접 마크다운을 생성하지 않고, `IRBlock[]`로 정규화 후 `blocksToMarkdown()`에서 일괄 변환
- **2-pass 테이블**: Pass 1에서 colSpan/rowSpan 고려한 그리드 크기 계산, Pass 2에서 셀 배치
- **깨진 ZIP 복구**: HWPX Central Directory 손상 시 Local File Header(PK\x03\x04) 직접 스캔
- **pdfjs-dist 외부 의존**: `external`로 번들에서 제외, 사용자가 선택적 설치. cfb는 `noExternal`로 번들에 포함
- **HWP5 레코드 구조**: 4바이트 헤더(tagId 10bit, level 10bit, size 12bit), FLAG_COMPRESSED 시 inflateRawSync

### 빌드 설정 (tsup)

두 개의 빌드 파이프라인:
1. **라이브러리** (`src/index.ts`): ESM + CJS, dts 생성, `pdfjs-dist` external / `cfb` bundled
2. **바이너리** (`src/cli.ts`, `src/mcp.ts`): ESM only, shebang 자동 삽입

## 코드 작성 시 주의

- `IRBlock` 타입 변경 시 모든 파서(hwpx, hwp5, pdf)와 `table/builder.ts`에 영향
- HWP5 파서에서 21개 제어 문자 처리 로직 주의 (`record.ts`)
- PDF 파서의 Y좌표 그룹핑은 2px tolerance, 갭 감지는 15px(탭)/3px(공백)
- `parse()` 함수는 `detectFormat()` 결과로 자동 분기 — 새 포맷 추가 시 여기에 분기 추가
