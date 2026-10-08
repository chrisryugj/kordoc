# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP 3.x·5.x, HWPX, HWPML, PDF, XLS·XLSX, DOCX, PPTX, PNG·JPG·WebP를 Markdown과 구조화 데이터로 변환합니다. 라이브러리·CLI·MCP 서버로 사용할 수 있습니다.

[English](README-EN.md) · [상세 사용법](docs/usage.md) · [벤치마크](docs/benchmarks.md) · [변경 이력](CHANGELOG.md)

- 📊 **PDF 공개 벤치 종합 0.960** — opendataloader-bench 200문서. 공개 12개 파서 비교 1위(2026-09-29 기록). [측정 조건](docs/benchmarks.md)
- 🇰🇷 **한국 공문서 표 구조 100%** — 원본 HWPX 2,286문서의 보이는 표 **9,865개 전부 구조 일치**. [4.18.8 검증](docs/release-4.18.8.json)

[![Kordoc 활용하기 — 영상 보기](./docs/video-demo.jpg)](https://youtu.be/Q13GmgDcIw0)

<sub>▶ 클릭하면 유튜브에서 재생됩니다.</sub>

**새 영상:** [kordoc 공개벤치 1위 마크](https://youtu.be/9kRbwiTRQLs) · 2026-09-27 · 1분 31초

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

Claude Desktop·Claude Code·Cursor·Codex 등 설치된 클라이언트에 MCP를 등록합니다. 클라이언트를 재시작하면 파싱·비교·생성·렌더 등 **17개 도구**를 사용할 수 있습니다.

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
npx kordoc fill --template gian -j 값.json -o 기안문.hwpx
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
| 비교·편집 | 블록·셀 단위 비교, HWPX·HWP 서식 보존 패치 |
| 작성 | Markdown → HWPX, 공문서 프리셋, 표·수식·차트 |
| 양식 | 필드·누름틀 채우기, 표준 기안문 2종, 도장 날인 |
| 검토 | HWPX·HWP 미리보기·영역 추출, 구조·표기법 검사, 개인정보 마스킹 |

서식 보존 패치용 Markdown은 `--keep-layout-tables`로 추출합니다. 적용하지 못한 편집은 건너뛴 사유로 보고합니다. [CLI·API 상세](docs/usage.md#-cli)

## 검증 결과

**4.18.8 · 2026-10-02 배포 검증**. 고정 코퍼스와 참조 기준으로 측정한 결과입니다.

| 대상 | 규모 | 결과 |
| --- | --- | --- |
| HWPX | 2,286문서 · 9,865표 | 표 구조 일치 **9,865/9,865 · 100%** |
| HWP 5.x ↔ HWPX | 1,120쌍 · 4,258표 | 짝 문서의 표 구조 일치 **100%** |
| PDF 글 | 744쌍 | 글자 재현율 **99.83%** · 읽기 순서 **99.15%** |
| PDF 표 | 708쌍 · 2,331표 | 표 탐지 **99.83%** · 구조 일치 **97.94%** |

표 구조 점수와 셀 내용·화면 재현은 별도 지표입니다. 채점 범위·제외 기준·OCR 결과는 [벤치마크 상세](docs/benchmarks.md), 실제 게시 검증은 [4.18.8 기록](docs/release-4.18.8.json)에 있습니다.

외부 PDF 벤치 **opendataloader-bench 200문서**는 4.18.6 별도 측정에서 기본값 종합 **0.960**, OCR 끔 **0.937**입니다. [옵션별 결과와 재현 방법](docs/benchmarks.md#pdf--markdown--opendataloader-bench)

## 최근 업데이트

최신 배포: **[4.20.0](https://github.com/chrisryugj/kordoc/releases/tag/v4.20.0)** · 2026-10-08

| 버전 | 주요 변경 |
| --- | --- |
| 4.20.0 | 표기법 검수 7룰(기간 대시·요일·금액 한글·공공언어·맞춤법·2타)과 문서 직접 검수·수치 대조·단계별 서식 편차, 견본 HWPX 단계별 서식 학습(`levels`·`--levels-from`), `compare`·`patch --json`, 패치 무결성 검사, 붙여넣기 흔적 정리 |
| 4.19.2 | rhwp v0.8.7 파서 수정 반영 — HWP3 체크박스 □, HWP5 짝 없는 서로게이트 □, 손상 CFB 복구의 본문 경로 오인 수정, HWPX 압축 해제 상한을 엔트리 읽는 도중에 적용 |
| 4.19.1 | PDF 쪽별 마크다운(`pages`)에서 쪽 넘김 표를 쪽마다 다시 갈라 뒤 쪽 행·상자가 앞 쪽에 붙거나 쪽 항목이 빠지지 않게 (#136) |
| 4.19.0 | RAG 색인용 `tableFormat: "gfm"` — 병합·중첩 표도 HTML 없이 GFM 파이프 표로, 셀 안 표는 부모·자식 관계 표지와 함께 독립 표로 (#138) |
| 4.18.12–13 | PDF 쪽 넘김 문단 잇기 판정을 HWPX·DOCX 원문 대조로 재조정 — 문장 끝·들여쓰기·나열 기호·탭 행 근거 (HWPX 쌍 오판 50 → 5) |
| 4.18.11 | 글꼴 사전 수천 개가 글꼴 파일을 나눠 쓰는 PDF의 메모리 폭주(힙 7GB+ 종료) 수정 (#137) |
| 4.18.9–10 | PDF 쪽 넘김 문단 잇기: 쪽별 마크다운(`pages`) 쪽 경계 복구(#136), 쪽 첫머리 제목·목차·항목 오결합 방지 |
| 4.18.8 | HWPX 셀 문단의 CRLF·CR·LF 줄바꿈을 보존하며 같은 줄 수의 텍스트 편집 지원 |
| 4.18.7 | 셀의 CRLF·CR이 GFM 표의 새 행으로 분리되던 문제와 왕복 패치 좌표 수정 |
| 4.18.5–6 | CLI 입력 보호·`generate --plain` 전달, PDF 문단·목록·괄호 문장·측면 탭 처리 개선 |
| 4.18.3–4 | PDF 병합·중첩 표와 읽기 순서, BOM·Electron 호환, 출력 충돌·추적 삭제·렌더 오류 수정 |
| 4.18.0–2 | `--jobs` 병렬 변환, PPTX 파싱, 빈 HWPX 입력란 보존, 공문서 생성 성능 개선 |

4.18.8 셀 편집은 같은 수의 비어 있지 않은 줄에 한정됩니다. 빈 줄·줄 추가/삭제·리터럴 `<br>`·모호한 매핑은 계속 건너뜁니다. [전체 변경 이력](CHANGELOG.md)

## 문서·보안

- [상세 사용법](docs/usage.md): 전체 CLI·MCP 도구·API·지원 포맷
- [공문서 생성 가이드](docs/gongmunseo-engine-spec.md) · [아키텍처](docs/architecture.md)
- [폐쇄망 설치](docs/offline-deployment.md): `KORDOC_OFFLINE=1`, MCP 접근 범위 `KORDOC_ROOT`
- [보안 정책](SECURITY.md) · [라이선스 MIT](LICENSE) · [오픈소스 고지](NOTICE)

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다. 5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.
