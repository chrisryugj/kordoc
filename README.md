# kordoc

**모두 파싱해버리겠다.**

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![npm downloads](https://img.shields.io/npm/dm/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![GitHub stars](https://img.shields.io/github/stars/chrisryugj/kordoc?style=flat)](https://github.com/chrisryugj/kordoc/stargazers)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dio.github.chrisryugj%2Fkordoc%26version%3Dlatest&query=%24.servers%5B0%5D.server.version&label=MCP%20Registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc)

> *대한민국에서 둘째가라면 서러울 문서지옥. 거기서 7년 버틴 공무원이 만들었습니다.*

한국 공문서를 AI가 읽고 쓸 수 있게 합니다. HWP 3.x·5.x, HWPX, HWPML, PDF, XLS·XLSX, DOCX, PPTX, 이미지(PNG·JPG·WebP·TIFF·GIF·BMP·AVIF·HEIC·PCX)를 Markdown과 구조화 데이터로 바꾸고, Markdown에서 HWPX·HWP 공문서를 만듭니다. 라이브러리·CLI·MCP 서버로 씁니다.

[English](README-EN.md) · [상세 사용법](docs/usage.md) · [벤치마크](docs/benchmarks.md) · [변경 이력](CHANGELOG.md)

![같은 법령 별표를 HWP·HWPX·PDF·스캔 이미지로 넣은 kordoc 실제 출력](docs/readme-hero.gif)

<sub>같은 법령 별표 한 건을 HWP·HWPX·PDF·스캔 이미지로 넣은 실제 출력입니다. 네 경우 모두 병합 칸(`rowspan`·`colspan`)을 같은 짜임의 표로 읽습니다. 스캔 이미지는 OCR이 자동으로 켜집니다.</sub>

- 📊 **PDF 공개 벤치 종합 0.965**: opendataloader-bench 200문서, 공개 리더보드(2026-09-29 기록) 12개 파서보다 높은 점수(4.24.50 측정). [측정 조건](docs/benchmarks.md#pdf--markdown--opendataloader-bench)
- 🇰🇷 **한국 공문서 표 구조 100%**: 원본 HWPX 2,424문서의 보이는 표 **10,342개 전부 구조 일치**. [검증 결과](#검증-결과)
- 🧩 **Claude 플러그인 디렉터리 게시**: 설치 **1,700건 이상**(2026. 11. 14. 집계). 공식 MCP 레지스트리에도 등록돼 있습니다.

쓸모 있었다면 GitHub ⭐ 하나 눌러주세요. 다른 사람이 이 도구를 찾는 데 도움이 됩니다.

영상: [공개 벤치 측정 과정](https://youtu.be/9kRbwiTRQLs)(2026-09-27 판, 1분 31초) · [양식 일괄 채우기 시연](https://youtu.be/Q13GmgDcIw0)

**목차**: [설치](#설치) · [빠른 시작](#빠른-시작) · [주요 기능](#주요-기능) · [검증 결과](#검증-결과) · [최근 업데이트](#최근-업데이트) · [자주 묻는 질문](#자주-묻는-질문) · [문서·보안](#문서보안)

## 설치

Node.js **20 이상** · macOS / Linux / Windows

```bash
npm install kordoc
```

CLI는 설치 없이 `npx kordoc`으로 실행합니다. PDF 글은 패키지에 든 wasm 엔진으로 읽습니다. OCR·그림 형식 변환·QR 읽기 의존성은 기본으로 설치되며, `--omit=optional`로 빼면 해당 기능이 제한됩니다.

### AI 에이전트에 연결

| 쓰는 곳 | 방법 |
| --- | --- |
| Claude Desktop·Claude Code·Cursor·Codex 등 | `npx -y kordoc setup`: 설치된 클라이언트를 찾아 MCP를 등록합니다 |
| VS Code·Cursor | 아래 단추로 등록합니다 |
| Claude Code 플러그인 | `/plugin marketplace add chrisryugj/kordoc` 뒤 `/plugin install kordoc@kordoc` |
| Claude 앱 | 플러그인 디렉터리에서 kordoc을 찾아 설치합니다 |
| 그 밖의 MCP 클라이언트 | 공식 MCP 레지스트리 [`io.github.chrisryugj/kordoc`](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc) 또는 [수동 등록](docs/usage.md) |

[![VS Code에 설치](https://img.shields.io/badge/VS_Code-kordoc_설치-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=kordoc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22kordoc%22%2C%22mcp%22%5D%7D) [![Cursor에 설치](https://img.shields.io/badge/Cursor-kordoc_설치-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=kordoc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImtvcmRvYyIsIm1jcCJdfQ%3D%3D)

클라이언트를 다시 시작하면 파싱·비교·생성·검수·렌더 등 **22개 도구**를 씁니다. 등록이 안 되면 [수동 MCP 등록과 설치 문제 해결](docs/usage.md)을 보세요.

## 빠른 시작

### CLI

```bash
npx kordoc 문서.hwpx -o 문서.md
npx kordoc *.pdf --jobs 4 -d ./결과
npx kordoc 문서.pdf --format json --pages 1-3
npx kordoc 스캔본.pdf --ocr -o 스캔본.md
npx kordoc generate 보고서.md --preset 보고서 -o 보고서.hwpx
npx kordoc to-hwpx 문서.hwp -o 문서.hwpx
npx kordoc to-hwpx ./옛문서   # 폴더째(하위 폴더까지): 각 파일 옆에 .hwpx, 이미 있으면 건너뜀
npx kordoc 문서.pdf -o 문서.hwpx   # PDF·DOCX 등도 읽은 내용으로 HWPX (그림 포함)
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

[파싱 옵션·API·양식·렌더 예제](docs/usage.md#-빠른-시작) · Python·Java에서는 [Python SDK](sdk/python/README.md)·[Java SDK](sdk/java/README.md)

## 주요 기능

- **읽기**: 문서 → Markdown·IR·쪽별 본문·RAG 청크, 로컬 OCR(손글씨 인식 포함), 그림 속 QR 값(`--qr-codes`), 그림 형식 통일(`--image-format png|webp`)
- **비교·편집**: 블록·셀 단위 비교, HWPX·HWP 서식 보존 패치, 견본 서식 그대로 새 내용 쓰기
- **작성**: Markdown → HWPX·HWP(HWP는 `npm install @rhwp/core` 뒤 `-o 문서.hwp`), 공문서 프리셋·부서 서식 견본(`--template`)·보고서 PDF 모양 따르기(`--layout`), 목차 쪽 번호, 표·수식·차트
- **변환**: HWP 5.x → HWPX 서식 그대로(글꼴·문단 모양·표·그림·도형·수식·머리말·각주·차트, 배포용·변경 추적 문서 포함). PDF·DOCX 등은 `-o 문서.hwpx`로 읽은 내용을 HWPX로
- **[기관팩](docs/agency-pack.md)**: 우리 기관 문서 몇 건으로 서식 묶음(`.kpack`)을 만들어 그 서식대로 새 문서 작성
- **양식**: 필드·누름틀 채우기, 표준 기안문 2종, 도장 날인
- **검수**: 표기법·공공언어, 구성·AI 문체 게이트, 예산 산출근거 검산, 열린 문서 블록 단위 검수(`lint-blocks`)
- **보기·보안**: HWPX·HWP 미리보기·영역 추출, 개인정보 마스킹(인명·주소는 학습 모델 opt-in `--model`)

서식 보존 패치용 Markdown은 `--keep-layout-tables`로 추출합니다. 적용하지 못한 편집은 건너뛴 사유로 보고합니다. [서식 보존 편집](docs/usage.md#서식-보존-편집) · [CLI 전체](docs/usage.md#-cli)

## 검증 결과

고정 코퍼스와 참조 기준으로 측정한 결과입니다. 측정판: 기본 4.22.14(2026-10-19) · 렌더 배치·별표 4.24.24(2026-10-30) · HWP → HWPX 변환 4.24.29(2026-10-31) · OCR 4.24.32(2026-11-01) · PDF 표 4.24.35(2026-11-01) · PDF 글·opendataloader-bench 기본값과 OCR 켬 4.24.50(2026-11-07) · KoOCR-Bench 4.24.68.

| 대상 | 규모 | 결과 |
| --- | --- | --- |
| HWPX | 2,424문서 · 10,342표 | 표 구조 일치 **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130쌍 · 4,315표 | 짝 문서의 표 구조 일치 **100%** |
| HWP 5.x → HWPX<br>변환 | 한글 저장 짝 264쌍 (속성 대조 232쌍) | 속성 일치 **99.21%** · 완전 일치 **69/232** · 글 **264/264** · 한글 화면 대조 80문서 |
| PDF 글 | 744쌍 | 글자 재현율 **99.887%** · 정확도 **99.685%** · 읽기 순서 **99.398%** · 어절 F1 **99.131%** |
| PDF 표 | 708쌍 · 2,331표 | 표 탐지 **99.83%** · 구조 일치 **98.24%** · 칸 F1 **0.9919** |
| HWPX 재조판 | 다중줄 25,187문단 (12개 폴더) | 모든 줄 시작 일치 **24,941/25,187 · 99.02%** |
| PDF 중첩표 (텍스트층) | 29문서 · 101표 | 구조·칸 내용 **101/101 · 100%** |
| 법령 별표 | 272건 · 346표 | HWP **346/346**, PDF **343/346 · 99.13%** |
| PDF 전체 | 1,911문서 중 1,729건 채점 | 글 커버리지 **99.80%** |
| OCR | 53문서 · 102쪽 · 65표 | CER **0.0237** · 글자 재현율 **99.33%** · 표 구조 일치 **33/65** |
| KoOCR-Bench v2.0c (외부) | 공개 877쪽 (표·글·손글씨·순서) | 종합 기본값 **0.906** · 표 **0.916** · 손글씨 **0.921** · 순서 **0.914** · 제목 재현율 0.930 |
| opendataloader-bench | PDF 200문서 | 종합 기본값 **0.965** · `ocr: true` **0.967** · OCR 끔 0.939 (4.22.14) |
| HWPX 렌더 배치 | 한컴 PDF 짝 1,565문서(쪽 수 일치 1,508) · 글 조각 111,480 · 그림 4,300 | 글 위치(±1.5pt) **106,904 · 95.9%** · 그림 위치(±2pt) **4,213 · 98.0%** |

표 구조 점수와 셀 내용·화면 재현은 별도 지표입니다. 중첩표 100%는 위 101표에 한정하며 전체 PDF·조판의 완전 일치를 뜻하지 않습니다. 채점 범위·제외 기준·옵션별 수치·재현 방법은 [벤치마크 상세](docs/benchmarks.md)에 있습니다.

## 최근 업데이트

최신 배포: **[4.25.8](https://github.com/chrisryugj/kordoc/releases/tag/v4.25.8)** · 2026-11-24

| 버전 | 바뀐 점 | 실측 변화 |
| --- | --- | --- |
| 4.25.8 | PDF·OCR 표에서 괘선·칸 클립으로 찾은 칸마다 좌표(`cells[r][c].bbox`)를 돌려줍니다(#232, @VerifiedIdiot). PDF 줄 끝에서 꺾인 명사+명사(「행정⏎처분을」)를 현행 법률 1,720개에서 모은 붙여 쓴 낱말 사전으로 판정하고, 150dpi 스캔에서 글자 세로 획이 가는 행 괘선을 건너 세로선으로 잡히던 것을 고쳤습니다 | PDF 글 744쌍 띄어쓰기 F1 0.99163 → **0.99198**(137문서 오름, 8문서 내림) · 견고성 dpi150 CER 0.0411 → 0.0406(web044 0.0522 → 0.0274, web051 1문서 내림) · 마크다운 출력은 칸 좌표와 무관 · 점수·표·별표·ODL 4종·OCR·KoOCR 877쪽 하락 0 · 시험 5,301개 실패 0 |
| 4.25.7 | HWPX에서 글자 크기로 정하는 제목이 나오지 않던 것(한글 저장본 문단의 글자 모양을 읽지 않았음), OCR에서 DPI 없는 4·6배판 쪽 배율을 잘못 잡던 것, 옆 테두리 없는 표의 흐린 괘선을 버려 열이 합쳐지던 것을 고쳤습니다 | 한컴 HWP·HWPX 짝 1,120개 제목 줄 일치 966 → **1,099**짝 · 견고성 dpi150 cbe-record-guide CER 0.176 → **0.009**, 스캔 ice-geomjeong 0.063 → 0.024, 흐림 web044 0.083 → 0.014 · ODL 200(4종)·글 744·표 730·점수 5,465·OCR 56·견고성 54·KoOCR 877쪽 하락 0 · 시험 5,296개 실패 0 |
| 4.25.6 | PDF에서 쪽을 넘긴 중첩 표의 되풀이 머리 행이 따로 남던 것, 작은 원으로 그린 글머리 점이 빠져 항목이 한 줄로 붙던 것, 값이 빈 입력란 두 칸을 두 단으로 읽던 것을 고쳤습니다 | 별표 PDF 유령 글 0.00028 → **0.00006** · ODL 163 MHS 0.9145 → 0.9201 · PDF 글 web070 재현율 0.99616 → 0.99904 · ODL 200·글 744·표 730·OCR 56·견고성 54·KoOCR 877쪽 하락 0 · 시험 5,288개 실패 0 |
| 4.25.5 | 개인정보 가리기(`redact`)에서 인명·주소를 학습 모델로도 찾는 선택 옵션을 더했습니다(`--model`, MCP `use_model`, @ubermensch1218). 문맥 없는 이름, 「홍○동」처럼 가린 이름, 띄어 쓴 이름, 동·지번만 있는 주소를 잡습니다. 모델은 켤 때만 받고(151MB) Schift License v2.0입니다 | 합성 벤치 인명 재현율 0.962 → **1.000**(오탐 1), 전체 micro F1 0.995 → 0.998 · 게이트 모델 끔·켬 모두 통과 · 모델을 끄면 출력 그대로 · 시험 5,262개 실패 0 |
| 4.25.4 | OCR 줄마다 상위 읽기 후보와 확률을 받는 `ocrLineCandidates`, OCR이 읽은 페이지를 이미지로 받는 `pageImages` 옵션을 더했습니다(@VerifiedIdiot). `fill 서식.hwp -o 결과.hwp`가 HWPX를 `.hwp` 이름으로 쓰던 문제를 고쳐 HWP 5.x로 저장합니다(#229, @seojaehong) | 두 옵션을 끄면 스캔 PNG 2장·스캔 PDF 1개의 출력이 4.25.3과 바이트까지 같음 · 기울인 스캔 1쪽 151줄 중 150줄에 후보, 페이지 이미지 크기 = 줄 좌표 기준 크기 · 시험 5,233개 실패 0 |

이전 버전과 상세 내용은 [변경 이력](CHANGELOG.md)에 있습니다.

## 자주 묻는 질문

**Q. HWP·HWPX 파일을 Markdown으로 바꾸려면?**
`npx kordoc 문서.hwp -o 문서.md`를 실행합니다. 한컴오피스 없이 파일을 직접 읽으며, 여러 파일은 `npx kordoc *.hwpx -d ./output`으로 함께 바꿉니다.

**Q. Claude·Cursor 같은 AI가 한글 문서를 읽게 하려면?**
`npx -y kordoc setup`으로 MCP를 등록하면 AI가 파일 경로만 받아 HWP·PDF·엑셀을 읽고, 비교하고, 양식을 채웁니다.

**Q. 인터넷이 막힌 폐쇄망에서도 되나요?**
됩니다. `KORDOC_OFFLINE=1`이 외부 통신을 모두 막고, OCR도 API 키 없이 로컬 CPU에서 돕니다. [폐쇄망 설치](docs/offline-deployment.md)

**Q. RAG 색인용으로 쓸 수 있나요?**
`--format chunks`가 제목 경로를 붙인 구조 청크와 독립 표 청크를 냅니다. 표를 HTML 없이 받으려면 `--table-format gfm`(API는 `tableFormat: "gfm"`)을 씁니다. Python·Java에서는 [Python SDK](sdk/python/README.md)·[Java SDK](sdk/java/README.md)로 부릅니다.

**Q. OCR 줄 좌표나 다른 모델이 필요하면?**
`--ocr --ocr-lines --format json`이 줄별 상자·신뢰도를 내고(`--ocr-line-candidates 3`이면 줄마다 상위 읽기 후보와 확률도), `--ocr-det`·`--ocr-det-long-side`로 검출 모델과 해상도를, `--ocr-rec handwriting|auto`로 손글씨 인식 모델을 고릅니다. `--page-images png`는 OCR 경로가 읽은 페이지를 이미지로 함께 냅니다. [OCR 줄·모델 선택](docs/usage.md#ocr-줄모델-선택)

## 문서·보안

- [상세 사용법](docs/usage.md): 전체 CLI·MCP 도구·API·지원 포맷
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): 상주 엔진 워커로 Java·Python 시스템에서 파싱 ([워커 프로토콜](docs/parse-worker-protocol.md))
- [공문서 생성 가이드](docs/gongmunseo-engine-spec.md) · [아키텍처](docs/architecture.md)
- [폐쇄망 설치](docs/offline-deployment.md): `KORDOC_OFFLINE=1`, MCP 접근 범위 `KORDOC_ROOT`
- [gVisor 샌드박스](docs/sandbox.md): 파서를 gVisor 안에서 실행해 호스트 보호(Linux, `KORDOC_SANDBOX=gvisor`·`docker --runtime=runsc`)
- [보안 정책](SECURITY.md) · [라이선스 MIT](LICENSE) · [오픈소스 고지](NOTICE)

## Star History

<a href="https://star-history.dera.page/#chrisryugj/kordoc&type=timeline&legend=bottom-right">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=chrisryugj/kordoc&type=timeline&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=chrisryugj/kordoc&type=timeline&legend=top-left" />
    <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=chrisryugj/kordoc&type=timeline&legend=top-left" />
  </picture>
</a>

## 만든 사람

대한민국 지방공무원. 광진구청에서 7년간 HWP 파일과 싸우다가 이걸 만들었습니다. 5개 공공 프로젝트에서 수천 건의 실제 관공서 문서를 파싱하며 검증했습니다.

라이선스: [MIT](LICENSE)
