# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP, HWPX, PDF, XLSX, DOCX — 관공서에서 쏟아지는 모든 문서를 파싱하고, 비교하고, 분석하고, 생성합니다.

[English](./README-EN.md)

![kordoc 데모](./demo.gif)

---

## 💡 kordoc으로 무엇을 할 수 있나요?

단순한 텍스트 추출을 넘어, **공문서 처리를 위한 모든 과정**을 자동화합니다.

*   **📄 어떤 문서든 마크다운으로**: `HWP`, `HWPX`, `PDF`, `XLSX`, `DOCX` 파일을 즉시 `Markdown`으로 변환합니다. AI(LLM)가 문서를 읽고 분석하기 가장 좋은 상태로 만들어줍니다.
*   **📊 복잡한 표(Table) 완벽 재현**: 선이 없는 PDF나 복잡하게 병합된 HWP 표도 구조를 분석하여 정확한 마크다운 테이블로 복원합니다.
*   **🔍 신구대조표 자동 생성**: 두 문서의 차이점을 분석하여 무엇이 바뀌었는지 한눈에 보여줍니다. (HWP와 HWPX 간의 비교도 가능!)
*   **📝 마크다운을 다시 HWPX로**: AI가 작성한 내용을 다시 보고서 양식(`HWPX`)으로 되돌려줍니다. 이제 복사-붙여넣기 노가다에서 해방되세요.
*   **🤖 AI 에이전트 연동 (MCP)**: `Claude`, `Cursor`와 같은 도구에서 직접 `kordoc`을 호출해 문서를 읽고 코딩할 수 있습니다.

---

## v2.1.0 변경사항

- **📄 대형 HWPX 정부문서 파싱** — `<p>><run>><tbl>` 구조의 중첩 테이블 파싱 누락 수정. 산업통상자원부 품목개요서(RFP, 2.8MB+) 등 대형 공문서 정상 파싱.
- **📰 PDF 2단 레이아웃 감지** — 다단 논문·보고서의 컬럼 구조를 감지하여 읽기 순서대로 추출.
- **📊 병합 셀 정보 보존** — colSpan 병합 셀 텍스트를 병합 위치에 복제하여 마크다운 변환 시 정보 손실 방지.
- **🔊 에러 가시성 개선** — watch 모드 파일 처리 실패·webhook 오류를 stderr로 출력. OCR 실패 페이지에 `[OCR 실패: 페이지 N]` placeholder 추가.
- **🛡️ 입력 검증 강화** — 폰트 크기 NaN/음수 가드, colSpan/rowSpan NaN 가드, 이미지 확장자 비안전 단언 제거.

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
- **OCR 연동** — 이미지 기반 PDF도 텍스트 추출 (Tesseract, Claude Vision 등 프로바이더 직접 제공).
- **Watch 모드** — `kordoc watch ./수신함 -d ./변환결과 --webhook https://...`
- **MCP 7개 도구** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form
- **에러 코드** — `"ENCRYPTED"`, `"ZIP_BOMB"`, `"IMAGE_BASED_PDF"` 등 구조화된 에러 핸들링

</details>

---

## 설치

```bash
npm install kordoc

# PDF 파싱이 필요하면 (선택)
npm install pdfjs-dist
```

## 빠른 시작

### 문서 파싱

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("사업계획서.hwpx")
const result = await parse(buffer.buffer)

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

### HWPX 생성 (역변환)

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# 제목\n\n본문 텍스트\n\n| 이름 | 직급 |\n| --- | --- |\n| 홍길동 | 과장 |")
writeFileSync("출력.hwpx", Buffer.from(hwpxBuffer))
```

### 페이지 범위 지정

```typescript
const result = await parse(buffer, { pages: "1-3" })      // 1~3 페이지만
const result = await parse(buffer, { pages: [1, 5, 10] })  // 특정 페이지
```

### OCR (이미지 PDF)

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage)
  }
})
```

## CLI

```bash
npx kordoc 사업계획서.hwpx                          # 터미널 출력
npx kordoc 보고서.hwp -o 보고서.md                  # 파일 저장
npx kordoc *.pdf -d ./변환결과/                     # 일괄 변환
npx kordoc 검토서.hwpx --format json               # JSON (blocks + metadata 포함)
npx kordoc 보고서.hwpx --pages 1-3                  # 페이지 범위
npx kordoc watch ./수신함 -d ./변환결과              # 폴더 감시 모드
npx kordoc watch ./문서 --webhook https://api/hook  # 웹훅 알림
```

## MCP 서버 (Claude / Cursor / Windsurf)

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "npx",
      "args": ["-y", "kordoc-mcp"]
    }
  }
}
```

**7개 도구:**

| 도구 | 설명 |
|------|------|
| `parse_document` | HWP/HWPX/PDF/XLSX/DOCX → 마크다운 (메타데이터 포함) |
| `detect_format` | 매직 바이트로 포맷 감지 |
| `parse_metadata` | 메타데이터만 빠르게 추출 |
| `parse_pages` | 특정 페이지 범위만 파싱 |
| `parse_table` | N번째 테이블만 추출 |
| `compare_documents` | 두 문서 비교 (크로스 포맷) |
| `parse_form` | 양식 필드를 JSON으로 추출 |

## API

### 핵심 함수

| 함수 | 설명 |
|------|------|
| `parse(buffer, options?)` | 포맷 자동 감지 → Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX 전용 |
| `parseHwp(buffer, options?)` | HWP 5.x 전용 |
| `parsePdf(buffer, options?)` | PDF 전용 |
| `parseXlsx(buffer, options?)` | XLSX 전용 |
| `parseDocx(buffer, options?)` | DOCX 전용 |
| `detectFormat(buffer)` | `"hwpx" \| "hwp" \| "pdf" \| "xlsx" \| "docx" \| "unknown"` |

### 고급 함수

| 함수 | 설명 |
|------|------|
| `compare(bufferA, bufferB, options?)` | IR 레벨 문서 비교 |
| `extractFormFields(blocks)` | IRBlock[]에서 양식 필드 인식 |
| `markdownToHwpx(markdown)` | Markdown → HWPX 역변환 |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown 문자열 |

### 타입

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## 지원 포맷

| 포맷 | 엔진 | 특징 |
|------|------|------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | 매니페스트, 중첩 테이블, 병합 셀, 손상 ZIP 복구 |
| **HWP 5.x** (한컴 레거시) | OLE2 + CFB | 배포용 복호화, 손상 CFB 복구, 각주/하이퍼링크, 21종 제어문자, 이미지 추출 |
| **PDF** | pdfjs-dist | 선 기반 테이블, XY-Cut 읽기 순서, 헤딩 감지, OCR |
| **XLSX** (Excel) | ZIP + XML DOM | 공유 문자열, 병합 셀, 다중 시트, 수식 표시 |
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
