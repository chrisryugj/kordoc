> 피팅 통합 이후 동작과 검증: [gwangyang-fitting.md](gwangyang-fitting.md). 아래 이전 단계 기록의 상자 쪽나눔은 최신 피팅 문서를 우선한다.

> 통합 사용법·14종 목록·작성 샘플: [광양시 기관 스타일](../templates/gwangyang/README.md).

# 광양시 보고서·계획서 스타일

2026-10-26 사용자 선택: **1안은 제공 HWPX**, **2안은 네이비–터콰이즈–라임 3색 띠**.


| 요소 | 광양시 1안 (기본) | 광양시 2안 |
|---|---|---|
| 기준 | 사용자 제공 광양시 1안.hwpx | 공개 문서의 3색 띠 |
| 제목표 | 상하 장식용 빈 자리, 검정 제목 | 3색 띠, 회색 상하선 |
| 소제목표 | 네이비 채움 번호칸, 긴 밑줄 | 흰 번호칸의 우·하단 강조, 긴 밑줄 |
| 요약 | 제목 없는 무지 레터박스 | 상자 없는 본문 |
| 본문표 | 연파랑 머리행, 열린 좌우, 점선 내부 가로선 | 흰 머리행, 닫힌 외곽, 실선 내부선 |

```ts
await markdownToHwpx(markdown, { gongmun: {
  preset: "report", agency: "광양시", reportFrame: "gwangyang-1"
}})
```

CLI `--agency 광양시 --report-frame gwangyang-2`. MCP `agency: "광양시", report_frame: "gwangyang-2"`.
`reportFrame`은 report/plan에서만 적용한다. 광양시는 미지정 시 1안, 다른 기관은 기존 골격을 유지한다.

## 1안의 실제 HWPX 근거

원본: 사용자 로컬 작업 `광양시 1안.hwpx`.
사용자가 함께 지정한 「2026년 제3차 시 투자심사 의뢰」 PDF와 모양이 일부 달라 재확인했고, 사용자가 HWPX 기준을 확정했다.
- 제목 3행: 높이 537 / 3116 / 565 HWPUNIT. 장식 이미지는 제외하고 상하 셀 높이만 유지한다.
- 소제목: 원본 칸 너비 2919 / 737 / 44390, 표 높이 2719. 생성 시 본문 폭에 비례. 번호 채움 #003366, 밑줄 #263056, 0.4mm.
- 본문표: 헤더 #DFE6F7, 0.12mm 선, 좌우 외곽 없음. 내부 가로선 DASH. 명시적 profile 셀 서식은 우선한다.
- 제목 20pt, 번호·소제목 16pt. 생성기 문안은 가변 길이에 맞춰 조판한다. 원본의 문구·빈 행·병합 그룹 전체를 복사하지 않는다.
- 요지는 제목 없는 무지 레터박스다. 캡션 설명상자는 별도 명시적 블록으로 사용한다.
- 붙임 전용 머리표, 흰·보라 캡션 상자, 밑줄 표 제목, 병합 그룹별 실선 경계를 구현했다. 아래 전체 부품 사용법 참조.

2안 원문: open.go.kr DCTFC5C4EB4BF0D28445CF1244547A5CD31, 주민등록증 재발급 비용지원 명시이월 추진계획 PDF 2쪽. 2안 선/색은 PDF 시각 근사다.
기관 공식 표준 지정이라는 의미가 아니라 사용자가 이 라이브러리에서 쓸 번호와 기준을 지정한 것이다.

## 재현과 검증

`npm run sample:gwangyang`.
한글 COM에서 원본 HWPX·1안·2안을 모두 열어 PDF로 출력, 각각1쪽. 원본과 1안의 제목·소제목·표를 대조.
typecheck/build 및 agency/gongmun/gen-table 관련 테스트253개 통과. 제목 배경 참조/패키지, 편집 가능한 표, 단계별 테두리, 기본값과 선택값 검증.
원본 장식은 현재 로컬 작업에 사용했으며 별도 공개 PR은 생성하지 않았다. generated agency-styles.ts는 수정하지 않았다.


# 광양시 1안 전체 부품 사용법

`agency: "광양시"`, `preset: "report"` 또는 `"plan"`에서 사용합니다. 기본 `reportFrame`은 `gwangyang-1`입니다.
1안 원본의 6개 표 구성(제목표, 번호 소제목표, 붙임 머리표, 흰 설명상자, 보라 설명상자, 병합 본문표)을 모두 사용할 수 있습니다.

| 원본 요소 | 입력 방법 |
|---|---|
| 장식 자리 보존 제목표 | Markdown `# 제목` |
| 네이비 번호칸 소제목표 | Markdown `## 소제목` |
| 붙임 머리표 | `gwangyang` 블록 `type: attachment`, `label`, `title` |
| 흰 캡션 설명상자 | `type: box`, `variant: white`, `title`, `body` |
| 보라 캡션 설명상자 | `type: box`, `variant: purple`, `title`, `body` |
| 밑줄 표 제목 | `type: table-title`, `title` |
| 일반 표 | GFM 표 |
| 병합 그룹 표 | HTML table의 rowspan/colspan. 첫 열의 세로 병합 경계는 실선, 그룹 내부는 점선 |

## 입력 예시

````markdown
# 보고서 제목

## 추진 배경

```gwangyang
{"type":"attachment","label":"붙임 2","title":"사업비 산출내역"}
```

```gwangyang
{"type":"box","variant":"white","title":"관련 현황","body":["※ 참고사항","◦ 세부내용","* 작은 주석"]}
```

```gwangyang
{"type":"box","variant":"purple","title":"검토 의견","body":["▣ 설명할 내용","◦ **중요한 부분** 강조"]}
```

```gwangyang
{"type":"table-title","title":"사업비 내역"}
```

<table>
<tr><th>구분</th><th>항목</th><th>내용</th></tr>
<tr><td rowspan="2">1그룹</td><td>첫째</td><td>내용 1</td></tr>
<tr><td>둘째</td><td>내용 2</td></tr>
<tr><td rowspan="2">2그룹</td><td>첫째</td><td>내용 3</td></tr>
<tr><td>둘째</td><td>내용 4</td></tr>
</table>
````

공개 TypeScript 입력 타입은 `GwangyangBlock`입니다. 같은 마크다운을 API·CLI·MCP에 넣을 수 있습니다. 문서 위치마다 여러 번 사용할 수 있으며 붙임 번호·상자 제목·내용을 직접 지정합니다.
상자 본문은 맑은 고딕 13pt, `* `로 시작하는 주석은 11pt, 보라 캡션은 12pt입니다. 긴 캡션은 폭 맞춤 후 높이를 늘립니다. 긴 상자는 문단별 표 행으로 구성하여 쪽을 나눕니다.
잘못된 JSON, 알 수 없는 필드·부품명·상자 종류는 오류로 알려줍니다. 2안이나 다른 프리셋에 몰래 적용하지 않습니다.

## 검증

- `1안_전체부품.hwpx`: 6개 표 구성과 밑줄 표 제목, 2개 병합 그룹을 담은 1쪽 견본.
- `1안_긴문안_쪽넘김.hwpx`: 긴 캡션, 16개 장문 항목, 붙임12, 40행 병합표. 한글 PDF 3쪽, 전체 페이지 확인.
- 긴 상자가 통째로 다음 쪽으로 밀리던 현상을 수정: 문단별 행 + 자리차지 표로 분할.
- typecheck/build, 관련 테스트256개, HWPX 구조검사 통과.
- 원본 다운로드 파일은 변경하지 않았으며 생성 문안은 에이전트가 작성한 가상 견본입니다.
