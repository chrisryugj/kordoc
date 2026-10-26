# 광양시 기관 스타일 — 14종

등록 자료: [style.json](style.json) · 모델용 [작성 지침](writing-guide.md) · 다른 기관 추가용 [등록 규격](../../docs/agency-style-registration.md).

광양시 보고서·계획서 작성용 로컬 스타일 모음이다. 사용자 확인을 거친 1안 11종과 2안 3종이며, 시의 공식 표준으로 지정됐다는 뜻은 아니다. 민선9기 로고는 **대한민국 산업수도 광양**을 사용한다.

## 빠른 시작

저장소 루트에서 실행한다. 원고·옵션·HWPX·재파싱 결과와 검사 기록이 `output/gwangyang`에 생성된다.

```sh
npm run sample:gwangyang
```

다른 출력 폴더를 지정하려면 빌드 후 실행한다.

```sh
npm run build
node scripts/sample-gwangyang-library.mjs "출력폴더"
```

## 14종 목록

| ID | 에셋 | 입력 |
|---|---|---|
| gy1-title | 사선 파란 띠 대제목 | `# 제목` |
| gy1-chapter | 네이비 번호칸 소제목 | `## 소제목` |
| gy1-attachment | 붙임 머리표 | `attachment` |
| gy1-box-white | 흰 설명상자 | `box`, `variant:white` |
| gy1-box-purple | 보라 설명상자 | `box`, `variant:purple` |
| gy1-table-title | 밑줄 표 제목 | `table-title` |
| gy1-table | 열린 외곽·점선 본문표 | GFM 또는 HTML 표 |
| gy1-staff-header | 담당자 머리표 | `staff-header` |
| gy1-cover | 기관 표지 | `institution-cover` |
| gy1-rounded-plain | 일반 둥근 상자 | `rounded-box`, `variant:plain` |
| gy1-rounded-tab | 제목 탭 둥근 상자 | `rounded-box`, `variant:tab` |
| gy2-title | 네이비·터콰이즈·라임 제목 띠 | `# 제목` |
| gy2-chapter | 윤곽 번호칸 소제목 | `## 소제목` |
| gy2-table | 닫힌 외곽·실선 본문표 | GFM 또는 HTML 표 |

`gy1`은 `reportFrame: "gwangyang-1"`, `gy2`는 `"gwangyang-2"`에서 사용한다. 같은 기능의 시각적 변형도 개별 에셋으로 센다. 기본 프레임은 1안이다. 1안 전용 JSON 블록을 2안에 넣으면 오류다.

## API

```ts
import { markdownToHwpx, GWANGYANG_STYLE_ASSETS } from 'kordoc'
import { writeFile } from 'node:fs/promises'

console.log(GWANGYANG_STYLE_ASSETS) // 14종의 ID·이름·프레임·입력 방식
const bytes = await markdownToHwpx(markdown, {
  gongmun: {
    preset: 'report', // 또는 plan
    agency: '광양시',
    reportFrame: 'gwangyang-1',
    cover: false, toc: false,
    margins: { top: 15, bottom: 15, left: 20, right: 20 }
  }
})
await writeFile('보고서.hwpx', Buffer.from(bytes))
```

로컬 소스의 변경을 쓰려면 이 저장소에서 빌드된 `dist/index.js`를 사용한다. 전역 설치본은 별개다. `GwangyangStyleAssetId`, `GwangyangBlock` 타입도 내보낸다.

## CLI / MCP

```sh
node dist/cli.js generate templates/gwangyang/examples/01_1안_기본부품.md -o output/광양시.hwpx --preset report --agency 광양시 --report-frame gwangyang-1 --no-cover --no-toc
```

MCP 생성 도구에는 동일 마크다운과 `preset: "report"`, `agency: "광양시"`, `report_frame: "gwangyang-1"`, `cover: false`, `toc: false`를 전달한다.

## 블록 사용법

마크다운의 `gwangyang` 코드블록 안에 JSON을 넣는다. 전체 입력 예시는 [기본 부품](examples/01_1안_기본부품.md), [머리표·둥근 상자](examples/02_1안_머리표와둥근상자.md), [기관 표지](examples/03_1안_기관표지보고서.md), [2안 계획서](examples/04_2안_추진계획.md)에 있다.

````markdown
```gwangyang
{"type":"attachment","label":"붙임 1","title":"검토자료"}
```

```gwangyang
{"type":"box","variant":"purple","title":"검토 의견","body":["◦ **주요 사항** 설명","* 작은 주석"]}
```

```gwangyang
{"type":"staff-header","title":"담당자","date":"2026. 10. 26.","staff":[{"role":"○○과장","name":"홍길동","phone":"0000"},{"role":"○○팀장","name":"김담당","phone":"0001"}]}
```

```gwangyang
{"type":"rounded-box","variant":"tab","title":"회의 개요","body":["□ 일시: 2026. 10. 26.","□ 내용: 검토사항 협의"]}
```
````

- 담당자 머리표는 문서 제목 앞에 한 번 배치된다. 날짜·직위·성명·내선번호를 바꾼다. `title`은 식별용이며 표시하지 않는다.
- 기관 표지는 문서 첫 쪽에 배치된다. `title`, `subtitle`, `date`, `dept`, `documentNumber`, `retention`, `disclosure`, `approvers`, `body`로 채운다. 기존 `cover` 옵션과 중복하지 않는다.
- 머리표는 원본의 가운데 세로선·직위 균등배치·HY울릉도M 11pt·날짜 높이를 보존한다. 담당자 1~4명, 결재 직위 1~6개를 지원한다.
- 표 셀 병합은 HTML `rowspan`/`colspan`을 사용한다. 1안 첫 열 세로 병합의 묶음 경계는 실선, 내부 행은 점선이다.
- 흰/보라 설명상자는 본문 흐름에 배치하며, 길면 제목을 반복한 같은 모양의 상자로 나눠 여러 쪽에 배치한다. 둥근 상자는 편집 가능한 한글 도형이며, 피팅 후에도 한 쪽을 넘으면 오류로 알린다. 여러 상자로 나눠 사용한다.
- 샘플 문안·성명·내선번호는 가상 예시다. 다른 용지나 긴 입력은 실제 한글에서 지면을 확인한다.

## 근거·검증

사용자 로컬 `광양시 1안.hwpx`와 감동시대 보고서의 표·도형을 분석했다. 민선9기 로고는 기록허브에 기록된 기존 검증 보고전 자산을 사용했다. 2안의 선·색은 공개 PDF 시각 근사다. [상세 근거](../../docs/gwangyang-agency.md), [확장 부품](../../docs/gwangyang-extended.md).

`samples.json`은 4개 작성 사례의 입력·옵션·사용 에셋 목록이다. 생성기는 빌드된 API로 작성하고 제목 재파싱, 도형·쪽나눔, 경고 없음, 14종 사용 여부를 검사한다. PDF는 한글 COM으로 별도 출력·검수한다. 로컬 작성테스트와 PR·배포는 별개다.


### 이번 로컬 작성테스트 결과

2026-10-26: API 샘플 4개(5쪽) + CLI 샘플 1개(1쪽), 14종 사용 확인. 관련 테스트 261개, typecheck/build, XML 검사 통과. 한글 COM PDF 총 6쪽 시각 검수 완료.

- [14종 합본 PDF](../../output/gwangyang/광양시_14종_샘플모음.pdf)
- [검증 기록](../../output/gwangyang/검증결과.md)

`output/`은 로컬 생성물이며 Git 제외 대상이다. 위 링크는 샘플 생성 및 PDF 출력 후 유효하다. 원고와 옵션은 이 폴더에 보관된다.

Windows에서 한글과 pywin32가 준비된 경우 PDF 출력:

```sh
python scripts/render-gwangyang-samples.py
```

이 명령은 별도 한글 COM 인스턴스로 샘플을 열고 PDF를 저장한 후 종료한다.


## 기존 피팅 체계 연결

14종의 상세 연결·긴 문안 테스트는 [피팅 검증](../../docs/gwangyang-fitting.md)을 참고한다.

```ts
gongmun: { preset: 'report', agency: '광양시', autoFit: { minRatio: 90, safety: 0.95 } }
// 비교용: autoFit: false
```

기관 부품은 기존 `fitOneLine`, `fitParagraph`, `fitCharBreaks`를 사용한다. 장평·자간만 조정하고 글자 크기·가로폭·색·선을 유지한다. 담기지 않으면 줄바꿈과 높이 증가를 허용한다. 일반 본문표 2종은 기존 공통 표 생성기의 열폭·행높이 계산을 재사용한다. 표의 글자취급·바깥 여백·쪽 경계 제한은 아래 최신 규칙을 따른다.

```sh
npm run build
node scripts/test-gwangyang-fitting.mjs
python scripts/render-gwangyang-samples.py output/gwangyang-fitting
```

보고요지는 제목 다음 첫 인용문(`>`)으로 입력합니다. 머리표 블록이 사이에 있어도 제목 없는 무지 레터박스로 생성합니다. 상자 안 여백은 좌우 1100HU(약 3.9mm), 상하 700HU(약 2.5mm)입니다. 제목이 있는 설명상자는 별도 `box` 블록을 사용합니다. 광양시 본문표의 셀 여백은 좌우 600HU(약 2.1mm), 상하 425HU(약 1.5mm)이며 행높이 계산에도 반영합니다.

광양시 표는 글자처럼 취급하고 개체 바깥 여백은 상하좌우 0으로 유지한다. 셀 안쪽 여백과 구분한다. 글자취급 표의 한글 쪽 경계 동작은 기존 부유 표와 다르므로, 한 쪽보다 긴 표는 분할 입력하고 실제 출력에서 확인한다. 앞선 장문 표 자동 쪽나눔 검증은 부유 표 당시 결과다.

본문 표와 주변 글의 간격은 표 개체 여백 대신 호스트 문단 앞 4pt·뒤 8pt로 둔다. 호스트 줄간격은 표 높이를 부풀리지 않도록 100%, 셀 내부 줄간격은 기존 130%를 유지한다.
