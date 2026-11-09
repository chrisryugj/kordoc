## Summary

<!-- 핵심을 두괄식으로 써주세요: 굵은 한 줄 결론, Target·AS-IS·TO-BE 표, Review Focus 2~3개 순서입니다. 문장을 이어 쓰지 말고 바뀐 것마다 표에 한 줄씩 적어주세요. 계기가 필요하면 표 아래 한 줄로 쓰고, 세부는 아래 Changes로 미뤄주세요. -->
<!-- 예시:
**HWPX 표의 병합 셀이 markdown에서 한 칸씩 밀리지 않게 합니다.**

| Target | AS-IS | TO-BE |
|---|---|---|
| 병합 셀이 있는 HWPX 표 | 병합 아래 칸이 오른쪽으로 밀림 | 원본 위치 그대로 |
| 병합 없는 표 | — | 출력 그대로 |

**Review Focus**
- rowSpan 계산이 바뀐 셀 위치 계산
-->

**<한 줄 결론>**

| Target    | AS-IS  | TO-BE      |
| --------- | ------ | ---------- |
| <바뀐 것> | <지금> | <이 PR 뒤> |

**Review Focus**

- <꼭 봐야 할 점>

## Changes

<!-- 영역별 소제목 아래에 무엇이 어떻게 바뀌었고 왜 그렇게 했는지 문장으로 써주세요. 목록은 파일·옵션처럼 나열이 필요한 곳에만 써주세요. -->
<!-- 예시:
### HWPX 표
`parser-shared.ts`의 셀 위치 계산이 rowSpan을 열 기준으로 세던 것을 행 기준으로 바꿨습니다.

### 시험
병합 셀 표 견본을 `tests/hwpx-table.test.ts`에 더했습니다.
-->

## Test Plan

<!-- 실제로 실행한 검사만 [x]로 바꾸고 <명령·결과>를 실행한 명령과 결과 한 문장으로 바꿔주세요. 실행하지 않은 항목은 [ ]로 두고 이유를 써주세요. 목록에 없는 검사(실제 문서 출력 비교 등)를 했다면 같은 형식으로 더해주세요. -->

- [ ] `npm audit --audit-level=low`: <명령·결과>
- [ ] `npm run typecheck`: <명령·결과>
- [ ] `npm test`: <명령·결과>
- [ ] `npm run build`: <명령·결과>
- [ ] (말뭉치가 있을 때) `npm run bench:gate`: <명령·결과>
- [ ] (Python SDK를 바꿨을 때) `cd sdk/python && python -m pytest`: <명령·결과>
- [ ] (Java SDK를 바꿨을 때) `mvn -B -f sdk/java/kordoc-pom.xml install`: <명령·결과>

## Breaking Changes

<!-- 기본 출력(markdown·블록·경고)이나 공개 API·옵션에 영향이 있으면 누구에게 어떤 영향이 있고 어떻게 대응하면 되는지 문장으로 써주세요. 없으면 "없음"이라고 써주세요. -->

## Related Issues

<!-- 예시: closes #123, fixes #456 -->

-
