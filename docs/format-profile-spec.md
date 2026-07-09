# FORMAT_PROFILE_SPEC — 서식 프로필 (generate 시각 서식 재현)

> 목적: `markdownToHwpx`(`src/hwpx/generator.ts`)가 표의 위상(병합 구조)뿐 아니라
> 음영·괘선·열 너비·셀 서식까지 재현할 수 있도록, 원본 문서 없이 서식만
> 실어 나르는 **서식 프로필**의 스키마와 소비/추출 흐름을 정의한다.
> 관련 이슈: #41 · PR: #42 · 상태: **구현됨** (`gen-profile.ts` / `extract-profile.ts`)

## 0. 배경 — 무엇이 빠졌었나

기존 `generate`는 헤더에 `<hh:borderFills itemCnt="2">`(기본 2종)만 방출하고
모든 표·셀이 `borderFillIDRef="2"` 하나를 공유했다. 열 너비는 `44000/열수` 균등
분할, 셀 글꼴은 기본 `charPr`이었다. 그 결과 **칸 구조(위상)는 라운드트립되지만
음영·괘선 위계·열 실측폭·셀 서식은 초기화**됐다.

원인은 능력이 아니라 통로다. 파서 IR(`IRCell`/`IRTable`, `src/types.ts`)에는
서식 필드가 없고, 마크다운에도 이 정보를 적을 문법이 없어 parse→generate 경로에서
탈락한다. 이 문서의 **서식 프로필**은 그 정보를 IR과 독립된 통로로 실어 나른다.

## 1. 단위 규약 (generator.ts와 동일)

- 길이: **HWPUNIT** (1/7200 inch). `1mm ≈ 283.465 HWPUNIT`.
- 글자 크기: `height_hwpunit = pt × 100` (1100 = 11pt).
- 색상: `#RRGGBB`. 채움 없음은 `fill` 필드 생략.
- 셀 좌표: `(row, col)` 0-기준. 병합 셀은 좌상단 좌표 하나로 표현.
- **borderFill/charPr id는 표별 로컬 네임스페이스** — 표0의 `"10"`과 표1의 `"10"`은
  서로 다른 정의일 수 있다. generate가 문서 전역 id로 재할당(remap)한다.

## 2. 스키마

전체 예시는 [`docs/examples/table-style-profile.example.json`](./examples/table-style-profile.example.json)
참조(실제 기관 서식에서 추출·비식별 처리). 아래는 발췌.

```jsonc
{
  "schema_version": "0.2.0",
  "tables": [
    {
      "table_index": 0,          // 문서 내 표 등장 순서 (0-기준, top-level 표만)
      "anchor_text": "구분",      // 첫 셀(0,0) 텍스트 정규화 앵커 (0.2.0, §3 매칭 1순위 키)
      "rows": 3, "cols": 3,
      "width_hwpunit": "49042",  // <hp:tbl><hp:sz width>
      "col_widths_hwpunit": ["16819", "15970", "16253"],  // 길이가 cols와 일치해야 적용(§6)
      "cells": [
        {
          "row": 0, "col": 1,
          "rowSpan": 2, "colSpan": 1,
          "width_hwpunit": "15970", "height_hwpunit": "1764",
          "borderFillIDRef": "7",    // → used_border_fills 키 (표별 로컬 id)
          "charPrIDRef": "22"        // → used_char_prs 키
        }
      ],
      "used_border_fills": {
        "5": {
          "rightBorder":  { "type": "SOLID", "width": "0.12 mm", "color": "#502962" },
          "bottomBorder": { "type": "SOLID", "width": "0.12 mm", "color": "#000000" }
          // "fill": { "faceColor": "#RRGGBB" }  // hh:winBrush, 셀 음영이 있을 때만 존재
        }
      },
      "used_char_prs": {
        "22": { "height_hwpunit": "1200", "textColor": "#000000",
                "bold": false, "italic": false, "underline": false, "fontRef_hangul": "2" }
      }
    }
  ]
}
```

정의를 파일 안에 함께 담아(`used_border_fills`/`used_char_prs`) 외부 참조 없이
자기완결로 해석된다.

## 3. generate가 소비하는 흐름

```ts
import { markdownToHwpx } from "kordoc"
const buf = await markdownToHwpx(md, { profile })
```

1. 표 매칭(0.2.0) — **행·열 수 일치는 항상 필수**이고, 그 위에서:
   - 프로필과 방출 표 **양쪽에 앵커가 있으면 앵커 일치**가 근거다(미사용 첫 일치 항목 소비).
     앵커가 다르면 순번이 같아도 적용하지 않는다 — 동형 쌍둥이 표 오적용 방지.
   - 앵커가 한쪽이라도 없으면 `table_index === 방출 순번`일 때만 적용(손편집 sparse
     프로필·0.1.0 프로필 하위호환). 순번은 생성 실패한 표도 '시도' 기준으로 센다.
   - 매칭 실패 시 해당 표는 무서식(기본값) — parse가 마크다운으로 방출하지 않는 표
     (1×1 제목박스, 머리말/꼬리말 표 등)가 원본에 있어도 서식이 밀리지 않는다.
     프로필이 전부 미매칭이면 `console.warn` 1회.
   - 앵커 정규화: 소문자화 + 문자·숫자만 남김 + 24자 절단 (`normalizeAnchor`).
2. `col_widths_hwpunit`(길이 == cols) → `<hp:cellSz width>`에 적용. 없으면 `width_hwpunit/cols`,
   그도 없으면 기본 균등분할. 병합 셀 폭 = 점유 열 폭의 합.
3. 셀 좌표로 `borderFillIDRef`·`charPrIDRef`를 찾아, 동봉된 정의를 header에
   **전역 id로 재할당(remap)** 하여 등록하고 셀에 연결. charPr 전역 id는 기본 charPr
   0~10과 공문서 장평 variant 다음부터 할당돼 `gongmun` 병용 시에도 충돌하지 않는다.
4. 프로필에 없는 셀·표는 기본값 생성 (하위 호환 — profile 미지정 시 출력 바이트 불변).

`gongmun` preset과 병용 가능(문단 서식은 preset, 표 시각 서식은 profile).

## 4. 추출 흐름 (hwpx → 프로필)

```ts
import { hwpxToProfile } from "kordoc"
const profile = await hwpxToProfile(hwpxBuffer)   // FormatProfile
```

`header.xml`의 `borderFill`/`charPr`을 원문 그대로, 각 section의 top-level `<hp:tbl>`을
등장 순서로 읽어 프로필을 만든다(`src/hwpx/extract-profile.ts`). 중첩표는 세지 않고,
각 표의 첫 셀(0,0) 직속 텍스트를 정규화해 `anchor_text`로 담는다(0.2.0) — parse가
방출하지 않는 표 때문에 순번이 어긋나도 §3의 앵커 매칭으로 정합한다.
추출→소비 라운드트립으로 원본 없이 같은 서식을 재현한다.

## 5. 가변 행에 대한 노트 — 행 패턴(반복 단위)

절대 좌표 스키마는 고정 크기 표에 맞는다. 마크다운 표의 데이터 행이 가변이면
좌표 대신 **머리행 패턴 / 데이터행 패턴** 으로 정의하는 확장(0.2.0 후보)이 필요하다.

## 6. 알려진 한계

- 셀 문단 정렬(`paraPr`)·여백(`cellMargin`) 미포함 — 기본값 사용.
- `fontRef_hangul`은 원본 fontfaces 순번이라 생성 header(HANGUL 3종, id 0~2) 밖 순번은
  기본 글꼴(0)로 접는다(dangling IDREF 방지). 완전 이식엔 fontface 이름표 확장 필요.
- `col_widths_hwpunit`은 **길이가 cols와 정확히 일치할 때만** 적용된다. 추출기는 0행
  span-1 셀 폭으로 근사하므로, 0행에 병합 셀이 섞이면 길이가 모자라 적용되지 않고
  borderFill·charPr만 반영된다(위 example.json의 `table_index: 1`이 이 경우 — 5×9인데
  0행 병합으로 7개). 열너비까지 재현하려면 프로필의 `col_widths_hwpunit`을 cols 길이로 보완.
- `used_char_prs`는 셀 첫 run의 charPr 기준(셀 내 혼합 서식은 대표값).

## 참고 자료

비식별 원본 서식(hwpx)·추출 스크립트·전후 비교 PDF (기여자 ai-localgov-officer, MIT):
https://github.com/ai-localgov-officer/rekian-comwriter-library/releases/tag/kordoc-issue-41-example
