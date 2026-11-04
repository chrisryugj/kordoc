# 글상자 안 결재표 중첩표 픽스처

`tests/hwp5-textbox-nested-table.test.ts` 가 쓴다. 글은 모두 합성이다.

| 파일 | 내용 |
|---|---|
| `make-source.mjs` | 원본 HWPX 를 만든다 — 글상자(사각형 `drawText`) 안 4×6 결재표, 칸 속 작은 표 12개(빈 1×1·2×1 칸, 병합 칸 있는 2×2). 마지막 열 네 칸은 빈 작은 표만 품는다 |
| `textbox-nested.hwp` | 원본 HWPX 를 한/글이 연 뒤 HWP 로 저장한 것 |
| `textbox-nested.hwpx` | 위 HWP 를 한/글이 다시 HWPX 로 저장한 것(정답) |

다시 만들려면 `npm run build` 뒤 `node tests/fixtures/textbox-nested/make-source.mjs source.hwpx` 로 원본을 만들고,
한/글 COM(`HWPFrame.HwpObject`, 창 숨김·`FilePathCheckerModule` 등록)으로 `Open(source,'HWPX')` → `SaveAs(…hwp,'HWP')`,
그 HWP 를 `Open(…,'HWP')` → `SaveAs(…hwpx,'HWPX')` 한다. 저장한 사람 이름(`lastsaveby`·요약 정보)은 `tests` 로 바꿔 두었다.
