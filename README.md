# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dio.github.chrisryugj%2Fkordoc%26version%3Dlatest&query=%24.servers%5B0%5D.server.version&label=MCP%20Registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP 3.x·5.x, HWPX, HWPML, PDF, XLS·XLSX, DOCX, PPTX, PNG·JPG·WebP를 Markdown과 구조화 데이터로 변환합니다. 라이브러리·CLI·MCP 서버로 사용할 수 있습니다.

[English](README-EN.md) · [상세 사용법](docs/usage.md) · [벤치마크](docs/benchmarks.md) · [변경 이력](CHANGELOG.md)

![같은 법령 별표를 HWP·HWPX·PDF·스캔 이미지로 넣은 kordoc 실제 출력](docs/readme-hero.gif)

<sub>같은 법령 별표 한 건을 HWP·HWPX·PDF·스캔 이미지로 넣은 실제 출력입니다. 네 경우 모두 병합 칸(`rowspan`·`colspan`)을 같은 짜임의 표로 읽습니다. 스캔 이미지는 OCR이 자동으로 켜집니다.</sub>

- 📊 **PDF 공개 벤치 종합 0.964**: opendataloader-bench 200문서, 공개 리더보드 12개 파서보다 높은 점수(4.22.14 측정). [측정 조건](docs/benchmarks.md#pdf--markdown--opendataloader-bench)
- 🇰🇷 **한국 공문서 표 구조 100%**: 원본 HWPX 2,424문서의 보이는 표 **10,342개 전부 구조 일치**. [검증 결과](#검증-결과)

쓸모 있었다면 GitHub ⭐ 하나 눌러주세요. 다른 사람이 이 도구를 찾는 데 도움이 됩니다.

영상: [공개 벤치 측정 과정](https://youtu.be/9kRbwiTRQLs)(2026-09-27 판, 1분 31초) · [양식 일괄 채우기 시연](https://youtu.be/Q13GmgDcIw0)

## 설치

Node.js **20 이상** · macOS / Linux / Windows

```bash
npm install kordoc
```

CLI는 설치 없이 `npx kordoc`으로 실행할 수 있습니다. PDF·OCR 의존성은 기본 설치되며, `--omit=optional`로 제외하면 해당 기능이 제한됩니다.

**AI 에이전트에 연결**

```bash
npx -y kordoc setup
```

Claude Desktop·Claude Code·Cursor·Codex 등 설치된 클라이언트에 MCP를 등록합니다. 공식 MCP 레지스트리에도 [`io.github.chrisryugj/kordoc`](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc)으로 등재돼 있습니다. 클라이언트를 재시작하면 파싱·비교·생성·검수·렌더 등 **22개 도구**를 사용할 수 있습니다.

VS Code·Cursor는 버튼 한 번으로 등록됩니다.

[![VS Code에 설치](https://img.shields.io/badge/VS_Code-kordoc_설치-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=kordoc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22kordoc%22%2C%22mcp%22%5D%7D) [![Cursor에 설치](https://img.shields.io/badge/Cursor-kordoc_설치-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=kordoc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImtvcmRvYyIsIm1jcCJdfQ%3D%3D)

Claude Code 플러그인:

```text
/plugin marketplace add chrisryugj/kordoc
/plugin install kordoc@kordoc
```

[수동 MCP 등록과 설치 문제 해결](docs/usage.md)

## 빠른 시작

### CLI

```bash
npx kordoc 문서.hwpx -o 문서.md
npx kordoc *.pdf --jobs 4 -d ./결과
npx kordoc 문서.pdf --format json --pages 1-3
npx kordoc 스캔본.pdf --ocr -o 스캔본.md
npx kordoc generate 보고서.md --preset 보고서 -o 보고서.hwpx
npx kordoc to-hwpx 문서.hwp -o 문서.hwpx
npx kordoc pack build 보고서1.hwpx 보고서2.hwpx 보고서3.hwpx --name 광양시 -o 광양시.kpack   # 기관팩 (docs/agency-pack.md)
npx kordoc generate 새보고서.md --pack 광양시.kpack -o 새보고서.hwpx
npx kordoc fill --template gian -j 값.json -o 기안문.hwpx
npx kordoc lint 보고서.hwpx --gate --preset 보고서
```

`--jobs`는 파일 단위 병렬 변환이며 메모리 사용도 늘어납니다. [병렬 변환 안내](docs/parallel-batch.md)

### JavaScript / TypeScript

```typescript
import { parse, markdownToHwpx } from "kordoc"
import { writeFile } from "node:fs/promises"

const result = await parse("문서.hwpx")
if (result.success) {
  console.log(result.markdown)
  // result.blocks: 구조화 데이터, result.metadata: 문서 정보
}

const hwpx = await markdownToHwpx("# 추진계획\n\n본문", {
  gongmun: { preset: "보고서" },
})
await writeFile("보고서.hwpx", Buffer.from(hwpx))
```

[파싱 옵션·API·양식·렌더 예제](docs/usage.md#-빠른-시작)

## 주요 기능

| 작업 | 기능 |
| --- | --- |
| 읽기 | 문서 → Markdown·IR·쪽별 본문·RAG 청크, 로컬 OCR |
| 비교·편집 | 블록·셀 단위 비교, HWPX·HWP 서식 보존 패치, 견본 서식 그대로 새 내용 쓰기 |
| 작성 | Markdown → HWPX, 공문서 프리셋·부서 서식 견본(`--template`), 표·수식·차트 |
| 변환 | HWP → HWPX — HWP 5.x 는 서식 그대로(글꼴·문단 모양·표·그림·도형·수식·머리말·각주·차트) |
| 기관팩 | 우리 기관 문서 몇 건으로 서식 묶음(`.kpack`)을 만들어 그 서식대로 새 문서 — [기관팩](docs/agency-pack.md) |
| 양식 | 필드·누름틀 채우기, 표준 기안문 2종, 도장 날인 |
| 검수 | 표기법·공공언어, 구성·AI 문체 게이트, 예산 산출근거 검산, 열린 문서 블록 단위 검수(`lint-blocks`) |
| 보기·보안 | HWPX·HWP 미리보기·영역 추출, 개인정보 마스킹 |

서식 보존 패치용 Markdown은 `--keep-layout-tables`로 추출합니다. 적용하지 못한 편집은 건너뛴 사유로 보고합니다. [서식 보존 편집](docs/usage.md#서식-보존-편집) · [CLI 전체](docs/usage.md#-cli)

## 검증 결과

**4.22.14 · 2026-10-19 검증**(렌더 배치·PDF 글·표·별표·OCR 은 4.24.24 · 2026-10-30, HWP → HWPX 변환은 4.24.26 · 2026-10-31). 고정 코퍼스와 참조 기준으로 측정한 결과입니다.

| 대상 | 규모 | 결과 |
| --- | --- | --- |
| HWPX | 2,424문서 · 10,342표 | 표 구조 일치 **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130쌍 · 4,315표 | 짝 문서의 표 구조 일치 **100%** |
| HWP 5.x → HWPX 변환 | 한글 저장 짝 264쌍 (속성 대조 232쌍) | 속성 일치 **99.19%** · 글 **264/264** · 한글 화면 대조 80문서 |
| PDF 글 | 744쌍 | 글자 재현율 **99.883%** · 정확도 **99.678%** · 읽기 순서 **99.312%** · 어절 F1 **99.067%** |
| PDF 표 | 708쌍 · 2,331표 | 표 탐지 **99.83%** · 구조 일치 **98.24%** · 칸 F1 **0.9919** |
| HWPX 재조판 | 다중줄 25,187문단 (12개 폴더) | 모든 줄 시작 일치 **24,941/25,187 · 99.02%** |
| PDF 중첩표 (텍스트층) | 29문서 · 101표 | 구조·칸 내용 **101/101 · 100%** |
| 법령 별표 | 272건 · 346표 | HWP **346/346**, PDF **343/346 · 99.13%** |
| PDF 전체 | 1,911문서 중 1,729건 채점 | 글 커버리지 **99.80%** |
| OCR | 53문서 · 102쪽 · 67표 | CER **0.0244** · 글자 재현율 **99.32%** · 표 구조 일치 **34/67** |
| opendataloader-bench | PDF 200문서 | 종합 기본값 **0.964** · OCR 끔 **0.939** |
| HWPX 렌더 배치 | 한컴 PDF 짝 1,565문서(쪽 수 일치 1,508) · 글 조각 111,480 · 그림 4,300 | 글 위치(±1.5pt) **106,904 · 95.9%** · 그림 위치(±2pt) **4,213 · 98.0%** |

표 구조 점수와 셀 내용·화면 재현은 별도 지표입니다. 중첩표 100%는 위 101표에 한정하며 전체 PDF·조판의 완전 일치를 뜻하지 않습니다. 채점 범위·제외 기준·옵션별 수치·재현 방법은 [벤치마크 상세](docs/benchmarks.md)에 있습니다.

## 최근 업데이트

최신 배포: **[4.24.28](https://github.com/chrisryugj/kordoc/releases/tag/v4.24.28)** · 2026-10-31

| 버전 | 주요 변경 | 수치 변화 |
| --- | --- | --- |
| 4.24.28 | 메모 읽기·달기(`memos`·`kordoc memo`·MCP `add_memo`, #180) · patch: 굵은 글·위첨자 끝에 붙인 글이 서식을 물려받던 것(HWP·HWPX), 글머리표 문단(#179), HWPX 탭·엔티티·PUA 문단과 HWP 표 칸은 바뀐 자리만 · to-hwpx: 원·네모 겹치기 번호(#178) · HWP 파서: 굵게·기울임·취소선·밑줄 표지 | patch 검증 잔차 HWPX 45 → **3**/540 · HWP 24 → **5**/140(파서 강조 반영 뒤 기준) · HWP 대체본 원본 서식 90 → **94**/98 · HWP·HWPX parse 대조 다른 단위 390 → **118** · 벤치 지표 그대로 |
| 4.24.27 | 서식 채우기·도장(`fill_form`·`place_seal`): HWP 5.x 서식도 원본 서식 그대로 · patch: HWP 대체본을 원본 서식으로(서식 그대로 바꾼 HWPX 에 반영), 누름틀 자리에 쓴 값은 누름틀에 채움(HWP·HWPX), 굵은 칸 GFM 표·여러 줄 1열 표·같은 글 문단 짝짓기 | patch 편집 반영 HWPX 539 → **540**/540 · 표 칸 465 → **467**/467 · HWP 132 → **140**/140 · HWP 대체본 원본 서식 0 → **90**/98 · 벤치 지표 그대로 |
| 4.24.26 | HWP → HWPX 변환(`kordoc to-hwpx`·MCP `convert_to_hwpx`): HWP 5.x 를 서식 그대로 — 바탕쪽·표·그림·도형·연결 글상자·수식·필드·메모·양식 개체·차트까지 · patch(HWP): 탭·필드가 든 문단도 바뀐 글자만 · 마크다운: 목록 항목 첫머리 표지 이스케이프 | 변환 속성 일치 **0.992** · 글 **264/264**(한글 저장 짝) · 한글 화면 대조 80문서 · patch HWP 123 → **132**/140 · 벤치 지표 그대로 |
| 4.24.25 | patch: 강제 줄바꿈 문단 수정, 좌표가 어긋난 자리(틀 표·제목 상자·첨자 문단)를 원문 글로 찾아 고침, 남은 편집은 원본 서식 대체본(`.rewrite.hwpx`) · 암호 HWPX 렌더 | patch 편집 반영(코퍼스 실험) HWPX 487 → **539**/540 · 표 칸 455 → **465**/467 · HWP 111 → **123**/140 · 벤치 지표 그대로 |
| 4.24.24 | OCR 표: 머리 띠 안 짧은 칸 구분선 · 렌더: 칸을 벗어나는 개체, 칸 안 줄 정보 없는 문단 뒤 캐시 문단, 한 문단의 겹침 금지 어울림 표 쌓기·쪽 넘김 · COM 폴백 임시 폴더 정리(#177) | OCR 표 구조 일치 33 → **34**/67 · 렌더 쪽 수 일치 1,507 → **1,508** · 글 위치 106,818 → **106,904** · 그림 4,169 → **4,213**(문서별 하락 0) · 측정 예외 1건(변경 이력) · 나머지 지표 그대로 |

이전 버전과 상세 내용은 [변경 이력](CHANGELOG.md)에 있습니다.

## 자주 묻는 질문

**Q. HWP·HWPX 파일을 Markdown으로 바꾸려면?**
`npx kordoc 문서.hwp -o 문서.md` 한 줄입니다. 한컴오피스 없이 파일을 직접 읽으며, 여러 파일은 `npx kordoc *.hwpx -d ./output`으로 한 번에 바꿉니다.

**Q. Claude·Cursor 같은 AI가 한글 문서를 읽게 하려면?**
`npx -y kordoc setup`으로 MCP를 등록하면 AI가 파일 경로만 받아 HWP·PDF·엑셀을 읽고, 비교하고, 양식을 채웁니다.

**Q. 인터넷이 막힌 폐쇄망에서도 되나요?**
됩니다. `KORDOC_OFFLINE=1`이 외부 통신을 모두 막고, OCR도 API 키 없이 로컬 CPU에서 돕니다. [폐쇄망 설치](docs/offline-deployment.md)

**Q. RAG 색인용으로 쓸 수 있나요?**
`--format chunks`가 제목 경로를 붙인 구조 청크와 독립 표 청크를 냅니다. 표를 HTML 없이 받으려면 `--table-format gfm`(API는 `tableFormat: "gfm"`)을 씁니다. Python·Java에서는 [Python SDK](sdk/python/README.md)·[Java SDK](sdk/java/README.md)로 부릅니다.

**Q. OCR 줄 좌표나 다른 모델이 필요하면?**
`--ocr --ocr-lines --format json`이 줄별 상자·신뢰도를 내고, `--ocr-det`·`--ocr-det-long-side`로 검출 모델과 해상도를 고릅니다. [OCR 줄·모델 선택](docs/usage.md#ocr-줄모델-선택)

## 문서·보안

- [상세 사용법](docs/usage.md): 전체 CLI·MCP 도구·API·지원 포맷
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): 상주 엔진 워커로 Java·Python 시스템에서 파싱 ([워커 프로토콜](docs/parse-worker-protocol.md))
- [공문서 생성 가이드](docs/gongmunseo-engine-spec.md) · [아키텍처](docs/architecture.md)
- [폐쇄망 설치](docs/offline-deployment.md): `KORDOC_OFFLINE=1`, MCP 접근 범위 `KORDOC_ROOT`
- [보안 정책](SECURITY.md) · [라이선스 MIT](LICENSE) · [오픈소스 고지](NOTICE)

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다. 5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.
