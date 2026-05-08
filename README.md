# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP 3.x/5.x, HWPX, PDF, XLS, XLSX, DOCX — 관공서에서 쏟아지는 모든 문서를 파싱하고, 비교하고, 분석하고, 생성합니다.

[English](./README-EN.md)

![kordoc 데모](./demo.gif)

---

## ⚡ 30초 설치 (AI 에이전트 연동)

**macOS / Linux / Windows 공용**. Node.js 18+ 만 있으면 됩니다.

```bash
npx -y kordoc setup
```

대화형 마법사가:
1. 사용 중인 AI 클라이언트 번호 선택 (Claude Desktop / Cursor / Claude Code / Windsurf / VS Code / Gemini CLI / Zed / Antigravity — 설치된 건 `[감지됨]` 표시)
2. 설정 파일 자동 패치 → 클라이언트 재시작

Windows 도 자동으로 `cmd /c npx` 래핑. 수동 JSON 편집 불필요. 재시작하면 8개 문서 파싱 도구 (`parse_document`, `parse_table`, `fill_form` 등) 활성화.

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

---

## 💡 kordoc으로 무엇을 할 수 있나요?

단순한 텍스트 추출을 넘어, **공문서 처리를 위한 모든 과정**을 자동화합니다.

*   **📄 어떤 문서든 마크다운으로**: `HWP3` (구버전), `HWP`(5.x), `HWPX`, `HWPML`, `PDF`, `XLS`, `XLSX`, `DOCX` 파일을 즉시 `Markdown`으로 변환합니다. AI(LLM)가 문서를 읽고 분석하기 가장 좋은 상태로 만들어줍니다.
*   **📊 복잡한 표(Table) 완벽 재현**: 선이 없는 PDF나 복잡하게 병합된 HWP 표도 구조를 분석하여 정확한 마크다운 테이블로 복원합니다.
*   **🔍 신구대조표 자동 생성**: 두 문서의 차이점을 분석하여 무엇이 바뀌었는지 한눈에 보여줍니다. (HWP와 HWPX 간의 비교도 가능!)
*   **📝 마크다운을 다시 HWPX로**: AI가 작성한 내용을 다시 보고서 양식(`HWPX`)으로 되돌려줍니다. 이제 복사-붙여넣기 노가다에서 해방되세요.
*   **✏️ 양식 자동 채우기**: 공문서 양식 템플릿(신청서, 보고서)에 값을 넣으면 자동으로 빈칸을 채웁니다. 원본 서식(글꼴, 크기, 정렬)을 100% 보존합니다.
*   **🤖 AI 에이전트 연동 (MCP)**: `Claude`, `Cursor`와 같은 도구에서 직접 `kordoc`을 호출해 문서를 읽고 코딩할 수 있습니다.

---

## v2.7.1 변경사항

- **🕰️ HWP 3.0 (구버전) 파서 추가** — 1996~2002년 한컴이 쓰던 단일 binary 포맷 (`"HWP Document File V3.00"` 시그니처) 텍스트 추출. 기존 kordoc 이 거부하던 구버전 판결문/공문서 등이 검색 인덱싱 가능. 상용조합형(johab) → 유니코드 + 5,893개 한자/기호 lookup. 표 cell / 머리말 / 각주 의 nested paragraph 재귀 추출. [@edwardkim/rhwp](https://github.com/edwardkim/rhwp) 의 Rust 구현을 TypeScript 로 포팅.

## v2.5.0 변경사항

- **🏛️ macOS 한컴오피스 호환 HWPX 생성** (#4) — `markdownToHwpx()` 가 만든 HWPX 가 macOS 한컴에서 "파일이 깨졌다"며 거부되던 문제 해결. 테이블 XML 을 최소 스켈레톤에서 완전 스펙 형태로 재작성 — `<hp:tbl>` 필수 속성 10종 + `<hp:sz>`/`<hp:pos>`/`<hp:outMargin>`/`<hp:inMargin>`, `<hp:tc>` 안에 `<hp:subList>` 래퍼 + `<hp:cellAddr>`/`<hp:cellSpan>`/`<hp:cellSz>`/`<hp:cellMargin>`, paragraph 래핑. `Preview/PrvText.txt` 추가 + `borderFill` id=1(SOLID 0.12mm) 추가.
- **🔓 HWP 5.x 배포용 문서 COM fallback** (#25) — `.hwp` 바이너리에서 "이 문서는 상위 버전의 배포용 문서입니다..." 경고 플레이스홀더만 나오는 케이스에서, Windows + 한컴오피스 환경이면 자동으로 `HWPFrame.HwpObject` COM API 로 재시도. v2.4.0 의 HWPX DRM fallback 인프라를 `.hwp` 에도 확장.

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

### 양식 자동 채우기

```typescript
import { fillForm } from "kordoc"
import { readFileSync, writeFileSync } from "fs"

const template = readFileSync("신청서.hwpx")

// HWPX 원본 서식 보존 모드 — 글꼴, 크기, 정렬 100% 유지
const result = await fillForm(template.buffer, {
  성명: "홍길동",
  주민등록번호: "900101-1234567",
  주소: "서울특별시 광진구 능동로 120",
}, { format: "hwpx-preserve" })

writeFileSync("신청서_작성완료.hwpx", Buffer.from(result.buffer!))
// result.filled → [{ label: "성명", value: "홍길동" }, ...]
// result.unmatched → 매칭 실패한 키 목록
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
npx kordoc fill 신청서.hwpx -f '성명=홍길동,주소=서울' -o 결과.hwpx  # 양식 채우기
npx kordoc fill 신청서.hwpx -j values.json -o 결과.hwpx             # JSON 파일로 채우기
npx kordoc fill 신청서.hwpx --dry-run                               # 필드 목록만 확인
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

**8개 도구:**

| 도구 | 설명 |
|------|------|
| `parse_document` | HWP/HWPX/PDF/XLSX/DOCX → 마크다운 (메타데이터 포함) |
| `detect_format` | 매직 바이트로 포맷 감지 |
| `parse_metadata` | 메타데이터만 빠르게 추출 |
| `parse_pages` | 특정 페이지 범위만 파싱 |
| `parse_table` | N번째 테이블만 추출 |
| `compare_documents` | 두 문서 비교 (크로스 포맷) |
| `parse_form` | 양식 필드를 JSON으로 추출 |
| `fill_form` | 양식 템플릿에 값 채우기 (HWPX 원본 서식 보존) |

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
| `parseHwpml(buffer, options?)` | HWPML (XML 기반 HWP) 전용 |
| `detectFormat(buffer)` | `"hwpx" \| "hwp" \| "hwpml" \| "pdf" \| "xlsx" \| "docx" \| "unknown"` |

### 고급 함수

| 함수 | 설명 |
|------|------|
| `compare(bufferA, bufferB, options?)` | IR 레벨 문서 비교 |
| `extractFormFields(blocks)` | IRBlock[]에서 양식 필드 인식 |
| `fillForm(buffer, values, options?)` | 양식 템플릿에 값 채우기 (markdown/hwpx/hwpx-preserve) |
| `fillFormFields(blocks, values)` | IRBlock[] 기반 필드 값 교체 |
| `fillHwpx(buffer, values)` | HWPX XML 직접 조작 (원본 서식 보존) |
| `markdownToHwpx(markdown)` | Markdown → HWPX 역변환 |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown 문자열 |

### 타입

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult, FillResult, HwpxFillResult, FillOutputFormat,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## 지원 포맷

| 포맷 | 엔진 | 특징 |
|------|------|------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | 매니페스트, 중첩 테이블, 병합 셀, 손상 ZIP 복구 |
| **HWP 5.x** (한컴 레거시) | OLE2 + CFB | 배포용 복호화, 손상 CFB 복구, 각주/하이퍼링크, 21종 제어문자, 이미지 추출 |
| **HWPML 2.x** (XML 기반 HWP) | XML DOM | HeadingType 기반 헤딩 감지, 병합 셀, DoS 방어 |
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
