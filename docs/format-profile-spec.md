# FORMAT_PROFILE_SPEC — 서식 프로필 (generate 시각 서식 재현)

> 목적: `markdownToHwpx`(`src/hwpx/generator.ts`)가 표의 위상(병합 구조)뿐 아니라
> 음영·괘선·열 너비·셀 서식까지 재현할 수 있도록, 원본 문서 없이 서식만
> 실어 나르는 **서식 프로필**의 스키마 초안이다.
> 관련 이슈: #41 · 작성일: 2026-07-06 · 상태: 초안(draft, 논의용)

## 0. 배경 — 무엇이 빠지는가

`generate`는 현재 헤더에 `<hh:borderFills itemCnt="2">`(기본 2종)만 방출하고
모든 표·셀이 `borderFillIDRef="2"` 하나를 공유한다. 열 너비는 내용 기반
계산값, 셀 글꼴은 기본 `charPr`이다. 그 결과 **칸 구조(위상)는 라운드트립되지만
음영·괘선 위계·열 실측폭·셀 서식은 초기화**된다.

실측 예 (공약 실천계획 서식, 5×9 병합표):

| 항목 | 원본 | `generate` 재생성 |
|------|------|-------------------|
| 표 내 borderFill 종류 | 11 | 1 |
| 문서 전체 borderFill 정의 | 28 | 3 |
| 열 너비 | 실측 비례 | 균등분할 |

원인은 능력이 아니라 통로다. 파서와 render는 이미 `borderFill`·`cellSz`·
`charShape`를 읽어 SVG로 그리고, generate도 `borderFill` 정의를 직접 쓴다.
다만 마크다운에는 이 정보를 적을 문법이 없어 parse→generate 경로에서 탈락한다.
이 문서는 그 정보를 **별도 통로(프로필)** 로 실어 나르기 위한 스키마다.

## 1. 단위 규약 (generator.ts와 동일)

- 길이: **HWPUNIT** (1/7200 inch). `1mm ≈ 283.465 HWPUNIT`.
- 글자 크기: `charPr.height = pt × 100` (1100 = 11pt).
- 색상: `#RRGGBB`. 채움 없음은 필드 생략.
- 셀 좌표: `(rowAddr, colAddr)` 0-기준. 병합 셀은 좌상단 좌표 하나로 표현.

## 2. 스키마

전체 예시는 [`docs/examples/table-style-profile.example.json`](./examples/table-style-profile.example.json)
참조(실제 기관 서식에서 추출·비식별 처리). 아래는 발췌.

```jsonc
{
  "schema_version": "0.1.0-draft",
  "tables": [
    {
      "table_index": 1,          // 문서 등장 순서 (0-기준)
      "rows": 5, "cols": 9,
      "width_hwpunit": "47624",  // <hp:tbl><hp:sz width>
      "col_widths_hwpunit": ["5953", "8783", "5953", "5387", "5387", "5387", "5387"],
      "cells": [
        {
          "row": 0, "col": 5,
          "rowSpan": 1, "colSpan": 2,
          "width_hwpunit": "5387", "height_hwpunit": "2420",
          "borderFillIDRef": "13",   // → used_border_fills 키
          "charPrIDRef": "25"        // → used_char_prs 키
        }
      ],
      "used_border_fills": {
        "13": {
          "leftBorder":   { "type": "SOLID", "width": "0.12 mm", "color": "#0000FF" },
          "rightBorder":  { "type": "SOLID", "width": "0.12 mm", "color": "#0000FF" },
          "topBorder":    { "type": "SOLID", "width": "0.12 mm", "color": "#0000FF" },
          "bottomBorder": { "type": "SOLID", "width": "0.12 mm", "color": "#0000FF" }
          // "fill": { "faceColor": "#RRGGBB" }  // hh:winBrush, 셀 음영이 있을 때만 존재
        }
      },
      "used_char_prs": {
        "24": { "height_hwpunit": "1100", "textColor": "#000000",
                "bold": true, "fontRef_hangul": "2" }
      }
    }
  ]
}
```

정의를 파일 안에 함께 담아(`used_border_fills`/`used_char_prs`) 외부 참조 없이
자기완결로 해석된다.

## 3. generate가 소비하는 흐름 (제안)

```
markdownToHwpx(md, { profile })
```

1. md의 N번째 표를 `tables[N]`과 매칭 (행·열 수 일치 시 적용, 불일치 시 무시+경고)
2. `col_widths_hwpunit`을 `<hp:tbl>` 열 폭에 적용
3. 셀 좌표로 `borderFillIDRef`·`charPrIDRef`를 찾아, 동봉된 정의를
   header에 등록하고 셀에 연결
4. 프로필에 없는 셀·표는 지금처럼 기본값 생성 (하위 호환)

기존 `gongmun` preset과의 합성 규칙(프로필이 preset을 덮는지 병합하는지)은
논의 대상이다.

## 4. 가변 행에 대한 노트 — 행 패턴(반복 단위)

절대 좌표 스키마는 고정 크기 표에 맞는다. 그런데 마크다운 표는 데이터 행이
가변(사업 3건이면 3행, 7건이면 7행)이라, 좌표 대신 **머리행 패턴 / 데이터행
패턴** 으로 정의하면 행 수와 무관하게 같은 서식을 반복 적용할 수 있다.
0.2.0 확장 후보로 남긴다.

참고로, 이런 구조 조작(행 추가·열 추가·셀 병합)은 HWPX XML 층에서 서식을
보존한 채 가능하다. rekian-comwriter-library에 순수 파이썬 참조 구현이 있다
(`table_rows.py`: 기준 행 복제 시 경계 세로병합 자동 확장, `cellAddr` 재계산,
그리드 정합 검증). generate가 데이터 행을 늘릴 때의 참조로 활용할 수 있다.

## 5. 알려진 한계 (초안)

- 셀 문단 정렬(paraPr)·여백(cellMargin) 미포함
- `fontRef_hangul`은 순번이라 완전 이식엔 fontface 이름표 확장 필요(0.2.0)
- `col_widths_hwpunit`은 0행 span-1 셀 기준 근사 — 비정형 표는 셀 개별 폭 우선

## 참고 자료

예시 프로필·비식별 서식(hwpx)·추출 스크립트·전후 비교 PDF:
https://github.com/ai-localgov-officer/rekian-comwriter-library/releases/tag/kordoc-issue-41-example

두 저장소 모두 MIT이므로 스키마·표기·명칭은 kordoc 관례에 맞게 자유롭게
바꾸어도 된다.
