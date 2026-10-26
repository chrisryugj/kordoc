# 기관 스타일 등록 규격 v1

광양시를 첫 사례로 하는 로컬 등록 규격이다. 문서 종류(`preset`)와 기관의 외형(`agency`, 프레임, 부품)을 구분한다. 보고서 14개를 등록한 것이 아니라 두 변형에 걸친 서식 부품 14종을 등록한 것이다. 보고요지처럼 프레임에 포함된 기능을 모두 독립 에셋으로 세지는 않는다.

## 등록 묶음

```text
templates/<기관-id>/
  style.json          기관·변형·에셋·근거·피팅·검증·코드 참조
  README.md           사람이 사용하는 API/CLI/MCP 설명
  writing-guide.md    모델에 전달하는 작성 기준과 입력 예시
  samples.json        원고·생성 옵션·사용 에셋 대응표
  examples/*.md       짧은 문안, 긴 문안, 복합 문서 원고
```

실행 가능한 규격 정본은 [schema.mjs](../templates/agency-style/schema.mjs), 최초 등록 사례는 [광양시 style.json](../templates/gwangyang/style.json)이다. 스키마는 알려지지 않은 필드를 거부한다. 원본 문서는 이 묶음에 자동 복사하지 않는다.

| 필드 | 작성 기준 |
|---|---|
| schemaVersion / version | 규격 버전과 기관 묶음 버전을 따로 기록. 입력·외형 변경을 변경 기록에 남김 |
| id / name | 영문 소문자·하이픈 식별자와 사용자에게 표시할 기관명 |
| status / officialStandard | draft → local-tested → released. 시각 검증 전 local-tested 금지. 공식 지정 여부는 실제 근거로 판단 |
| presets / variants / defaultVariant | 적용 가능한 문서 종류, 기관 내 변형, 기본 변형. PDF 근사와 HWPX 확인을 구분 |
| sources | 사용자 원본·공개 문서·에이전트 생성물을 구분하고 용도·재배포 검토 상태 기록 |
| assets | 고유 ID, 이름, 변형, 입력 문법. 제목·표·도형 등 실제 구현 단위 |
| tokens | 본문 글꼴·크기, 가운뎃점, 요지 제목 유무, 요지·표 여백. HU는 1/7200인치, mm는 HU×25.4/7200 |
| fitting | 공통 피팅 엔진, 장평 하한·안전계수, 넘침 정책. 목표 쪽수 보장은 false |
| validation | 필수 자동·시각 검사 항목과 실제 검증 기록 경로 |
| runtime | 컴파일된 어댑터의 코드 위치. manifestLoadsRenderer는 현재 false |

`tokens`는 등록·검토용 요약이며 코드의 모든 치수를 대체하지 않는다. 색·선·병합 구조 등 상세 실측은 근거 문서와 구현 코드에 기록한다. 현재 자동 검사는 이 수치와 렌더러 수치의 전수 일치까지 보장하지 않는다.

## 다른 기관 추가 순서

1. 사용자 원본과 공개 표본을 확인한다. 제목·소제목·요지·머리표·표·상자를 분류하고, 반복 관행과 단발성 디자인을 구분한다. 표본 수와 출처를 기록한다.
2. `templates/gwangyang`의 묶음 구조를 참고해 새 폴더를 만든다. 광양시 기관명·로고·14종 ID를 그대로 두지 말고 실제 지원 범위만 등록한다. 초기는 `status:draft`다.
3. 기존 코드에서 재사용 가능한 부품을 먼저 찾는다. 글꼴·본문 위계만 다른 경우 `agency-local-styles.ts`의 기관값으로 해결한다. 새로운 표·도형 구조가 필요할 때 어댑터를 추가한다.
4. 새 프레임이면 `gongmun.ts`의 타입·해석, `gen-gongmun.ts`의 선택과 배치, CLI/MCP의 프레임 입력, 공개 타입·카탈로그까지 연결한다. 광양시 전용 `gwangyang` 코드블록을 다른 기관의 범용 문법인 것처럼 재사용하지 않는다. 신규 부품 문법은 해당 어댑터에서 검증한다.
5. `FrameCtx.fit`으로 기존 피팅 옵션을 전달한다. 글자 폭 계산과 실제 출력에 같은 문자열을 사용한다. 서식의 색·선·번호칸을 유지하고, 긴 내용은 높이 증가·안전한 분할·명시적 오류로 처리한다. 임의 삭제하지 않는다.
6. 작성 지침과 입력 원고, 샘플의 에셋 목록을 함께 작성한다. 등록 검사와 회귀 테스트 후 실제 한글 출력을 확인한다.
7. 검증 결과를 남기고 `local-tested`로 변경한다. 공개 전 원본·로고·폰트 등 포함 자산의 재배포 상태를 확인하고, PR에는 변경 범위·실제 검증·제약을 기재한다. 로컬 검증만으로 released로 바꾸지 않는다.

기관 기본값보다 사용자의 명시 옵션을 우선한다. 다만 각 프레임의 고정 구조 및 지원하지 않는 옵션은 README에 명시한다. 다른 기관·기존 프리셋의 결과가 바뀌지 않도록 수정 범위를 제한한다.

## 검증과 승인 기준

```sh
node scripts/validate-agency-style.mjs templates/gwangyang/style.json
npm run typecheck
node --import tsx --test tests/agency-style-registration.test.ts tests/gongmun-gwangyang*.test.ts
npm run sample:gwangyang
node scripts/test-gwangyang-fitting.mjs
python scripts/render-gwangyang-samples.py output/gwangyang
python scripts/render-gwangyang-samples.py output/gwangyang-fitting
```

등록 검사는 필드, 중복 ID, 변형 참조, 저장소 내 파일 참조, 샘플의 기관·프리셋·에셋 연결을 검사한다. 실제 부품 출력 여부는 카탈로그 테스트와 렌더 검사로 확인한다. JSON 검사 성공은 시각 검수 통과가 아니다.

필수 시나리오: 각 에셋의 짧은 입력과 긴 입력, 여러 부품 연속 배치, 쪽 경계, 병합표, 긴 담당자 이름, 요지 앞 머리표, 피팅 ON/OFF, 한 쪽보다 큰 도형, 잘못된 필드·중복 머리표. 출력에서 텍스트 누락·겹침·외곽선 누락·표기 규칙 위반이 없어야 한다. 원고의 특정 끝문구와 출력의 개수를 대조한다.

원고·옵션·생성 로그·HWPX·PDF·시각 검수 기록을 함께 보관한다. 사용자 원본과 에이전트 생성 샘플은 구분한다. 내용이나 폰트 환경이 바뀌면 이전의 2쪽 결과를 보장하지 않는다.

## 현재 구현 범위

광양시는 report/plan, 1안 11종·2안 3종, 코드 기반 생성과 공통 피팅 연결을 제공한다. 무지 보고요지와 `‧` 표기는 프레임 규칙이다. `ㅇ (항목명)`의 선택은 작성 지침이며 자동으로 문안을 재작성하지 않는다.

이 규격은 **등록 자료·작성 지침·검증 절차를 표준화**한다. 임의 JSON을 읽어 새 기관 렌더러를 동적으로 설치하는 기능, 범용 기관 추가 CLI, 목표 쪽수 자동 작성은 아직 제공하지 않는다.
