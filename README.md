# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

HWP 3.x·5.x, HWPX, HWPML, PDF, XLS·XLSX, DOCX, PPTX, PNG·JPG·WebP를 Markdown과 구조화 데이터로 변환합니다. 라이브러리·CLI·MCP 서버로 사용할 수 있습니다.

[English](README-EN.md) · [상세 사용법](docs/usage.md) · [벤치마크](docs/benchmarks.md) · [변경 이력](CHANGELOG.md)

- 📊 **PDF 공개 벤치 종합 0.963** — opendataloader-bench 200문서. 공개 12개 파서 비교 1위(2026-09-29 기록). [측정 조건](docs/benchmarks.md)
- 🇰🇷 **한국 공문서 표 구조 100%** — 원본 HWPX 2,424문서의 보이는 표 **10,342개 전부 구조 일치**. [4.21.14 검증](docs/benchmarks.md)

쓸모 있었다면 GitHub ⭐ 하나 눌러주세요. 다른 사람이 이 도구를 찾는 데 도움이 됩니다.

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

보고서·계획서·개조식·서울방침은 `#` 제목 바로 뒤 인용문(`> …하고자 함`)이 요약 상자가 됩니다(개조식은 표지가 있을 때(기본) 본문 첫 쪽 제목 상자 아래 — `cover:false` 면 첫 `#` 이 장 머리라 인용문은 ※ 참고). 보고 목적 한 문장(쉼표 허용) 3줄 이내로 쓰고, 넘거나 두 문장 이상이면 경고합니다. 업무보고는 `> ▪ …` 인용문이 자리와 관계없이 성과 요약 상자가 됩니다.

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

**4.21.14 · 2026-10-10 배포 검증**. 고정 코퍼스와 참조 기준으로 측정한 결과입니다.

| 대상 | 규모 | 결과 |
| --- | --- | --- |
| HWPX | 2,424문서 · 10,342표 | 표 구조 일치 **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130쌍 · 4,315표 | 짝 문서의 표 구조 일치 **100%** |
| PDF 글 | 744쌍 | 글자 재현율 **99.84%** · 정확도 **99.64%** · 읽기 순서 **99.16%** · 어절 F1 **98.89%** |
| PDF 표 | 708쌍 · 2,331표 | 표 탐지 **99.83%** · 구조 일치 **97.98%** · 칸 F1 **0.991** |
| PDF 전체 | 1,911문서 중 1,729건 채점 | 글 커버리지 **99.80%** |
| OCR | 53문서 · 102쪽 | CER **0.0412** · 글자 재현율 **99.02%** |

표 구조 점수와 셀 내용·화면 재현은 별도 지표입니다. 채점 범위·제외 기준·전 벤치 문서별 비교는 [벤치마크 상세](docs/benchmarks.md)에 있습니다.

외부 PDF 벤치 **opendataloader-bench 200문서**는 4.21.14 배포 측정에서 기본값 종합 **0.963**, OCR 끔 **0.939**입니다. [옵션별 결과와 재현 방법](docs/benchmarks.md#pdf--markdown--opendataloader-bench)

## 최근 업데이트

최신 배포: **[4.21.14](https://github.com/chrisryugj/kordoc/releases/tag/v4.21.14)** · 2026-10-10

| 버전 | 주요 변경 |
| --- | --- |
| 4.21.14 | 한컴 PDF 유니코드 없는 기호 되살리기 — 자동 글머리표·괄호(U+F000)를 글꼴 윤곽 모양으로 "▸"·"□"·"《》"·"↓" 등으로; 텍스트층 커버리지 채점 기준 변경 (PDF 어절 F1 98.87 → 98.89%·글 재현율 99.83 → 99.84%) |
| 4.21.13 | PDF 법령 별표 쪽 넘김 행 — 번호 열이 다음 차례면 새 행, "가)" 항목도 다음 항목 머리로, 쪽을 넘는 긴 칸은 두 행을 덮는 한 칸으로; parse-worker 가 닫힌 stdout 에서 조용히 끝남(#142) (법령 별표 PDF 표 구조 일치 96.82 → 97.40%, 문서별 하락 0) |
| 4.21.12 | PDF 칸 숫자 줄·걸친 글상자·배분 이름표·첨자 겹침 — 칸을 채운 숫자 줄만 잇기, 서로 걸친 글상자는 글로, 숫자 행 배분 두 음절 붙이기, 붙은 첨자 겹침 허용 0.25em (PDF 어절 F1 98.86 → 98.87%·ODL 표 TEDS 0.9799 → 0.9802, 문서별 하락 0) |
| 4.21.11 | PDF 목차·라벨탭 상자·칸 첨자 — 목차 리더 걷기, 제목 칩 상자를 글로, 목차 칸 제목·쪽 번호 짝짓기, 서식 칸 붙은 첨자 흡수 (PDF 글 정확도 99.58 → 99.64%·OCR CER 0.0421 → 0.0412, 문서별 하락 0 — 열화 OCR 은 표본 쪽 셋 이동) |
| 4.21.10 | PDF 흐름도 표·괄호 풀이 — 선 격자 표를 품은 클러스터 후보 거름, 짧은 괄호 풀이 앞 줄 꺾임 이음 (PDF 어절 F1 98.84 → 98.85%·OCR CER 0.0443 → 0.0421, 문서별 하락 0) |
| 4.21.9 | PDF 줄 꺾임 이음 — 낱말 가운데 꺾임·겹조사·계사·접미사·명사+하다, 본문 위 첨자 행 흡수 (PDF 어절 F1 98.81 → 98.84%·글 커버리지 99.79 → 99.80%, 문서별 하락 0) |
| 4.21.8 | PDF 표 묶음 — 돌려 찍은 가로 표 세우기·데이터 표의 차트 오판·좁은 숫자 열·칸 걸친 한 조각·칸 안 쌓인 금액 (OCR CER 0.0445 → 0.0443·열화 OCR scan 0.0821 → 0.0805, 문서별 하락 0) |
| 4.21.7 | PDF 토막 괘선 칸·글 조각 클립·연락처 표 — 예산서 상세 칸(OCR CER 0.0512 → 0.0445), ezPDF·MS Print 글 조각 클립이 만든 가짜 표, 연락처 6열 (열화 OCR scan 0.0954 → 0.0821·글 커버리지 99.78 → 99.79%, 문서별 하락 0) |
| 4.21.6 | 연락처 표 부서별 병합·여러 사람 칸 분할(PDF 표 구조 일치 97.94→97.98%), XLSX·XLS 200열 밖 칸 유실 수리, HWP3 포함 그림 추출, 수식 OCR LaTeX 명령 쪼개기·영역 상한 수리, PPTX 서식 트랙·코퍼스 보강(HWP3 75·서식 58·rhwp 230) |
| 4.21.5 | PDF 품질 묶음 — OCR 두 단 가짜 표(#141 부작용)·그림 OCR 라벨 묶음·한 자리 눈금, 주소 링크·벡터 차트 값 축·단 끝줄·각주 순서 (ODL 기본 0.958 → 0.963, 문서별 하락 0) · 개조식·보고서 요약 상자가 md→hwpx→md→hwpx 왕복에서 유지 |
| 4.21.4 | MCP `fill_form` 값 파일 입력 `fields_file`(값이 대화에 안 남고 응답은 글자 수만), 전 벤치 묶음 러너·문서별 비교기 `bench/suite.mjs` |
| 4.21.3 | PDF 수식 OCR 의 짝 없는 `\left`·`\right` 정리 |
| 4.21.2 | 개조식 제목 뒤 요약이 1×1 요약 상자로(종전 ※ 참고)·요약 3줄·한 문장 검사, HWP3 중첩 한도·암호 HWPX 누적 압축 해제 상한 |
| 4.21.1 | 이미지 OCR 에서 같은 줄 조각이 갈려 순서가 뒤집히던 것과 테두리 없는 영수증 표의 품목 행이 섞이던 것 (#141) |
| 4.21.0 | 중앙부처 기관 서식 `--agency`(보도자료 2,670건·52개 기관 실측 단계 글꼴·크기·2단계 부호 ◦·❍·표 머리·기관 색), 보도자료 담당 표 사람별 행(`--press-people`), 폭표 없는 글꼴의 생성 폭 계산 보정 |
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

## 자주 묻는 질문

**Q. HWP·HWPX 파일을 Markdown으로 바꾸려면?**
`npx kordoc 문서.hwp -o 문서.md` 한 줄입니다. 한컴오피스 없이 파일을 직접 읽으며, 여러 파일은 `npx kordoc *.hwpx -d ./output`으로 한 번에 바꿉니다.

**Q. Claude·Cursor 같은 AI가 한글 문서를 읽게 하려면?**
`npx -y kordoc setup`으로 MCP를 등록하면 AI가 파일 경로만 받아 HWP·PDF·엑셀을 읽고, 비교하고, 양식을 채웁니다.

**Q. 인터넷이 막힌 폐쇄망에서도 되나요?**
됩니다. `KORDOC_OFFLINE=1`이 외부 통신을 모두 막고, OCR도 API 키 없이 로컬 CPU에서 돕니다. [폐쇄망 설치](docs/offline-deployment.md)

**Q. RAG 색인용으로 쓸 수 있나요?**
`--format chunks`가 제목 경로를 붙인 구조 청크와 독립 표 청크를 냅니다. 표를 HTML 없이 받으려면 `--table-format gfm`(API는 `tableFormat: "gfm"`)을 씁니다. Python·Java에서는 [Python SDK](sdk/python/README.md)·[Java SDK](sdk/java/README.md)로 부릅니다.

## 문서·보안

- [상세 사용법](docs/usage.md): 전체 CLI·MCP 도구·API·지원 포맷
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): 상주 엔진 워커로 Java·Python 시스템에서 파싱 ([워커 프로토콜](docs/parse-worker-protocol.md))
- [공문서 생성 가이드](docs/gongmunseo-engine-spec.md) · [아키텍처](docs/architecture.md)
- [폐쇄망 설치](docs/offline-deployment.md): `KORDOC_OFFLINE=1`, MCP 접근 범위 `KORDOC_ROOT`
- [보안 정책](SECURITY.md) · [라이선스 MIT](LICENSE) · [오픈소스 고지](NOTICE)

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다. 5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.
