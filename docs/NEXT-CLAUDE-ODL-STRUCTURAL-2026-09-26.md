# Claude 다음 세션 프롬프트 — kordoc PDF 구조 돌파

아래 전체를 다음 Claude 세션에 전달한다. **이 문서는 완료 선언이 아니라 목표 미달 상태의 인계문이다.**

`/Users/chris_gomdori/workspace/kordoc`에서 작업하라. `AGENTS.md`와 `.claude/CLAUDE.md`가 있으면 읽고, `docs/odl-structural-session-2026-09-26.md`, `.Codex/plans/NEXT-SESSION-STRUCTURAL-BREAKTHROUGH-2026-09-26.md`, `.Codex/plans/odl-breakthrough-2026-09-25.md`, `docs/odl-breakthrough-study-2026-09-25.md`를 읽어라. 첫 명령으로 `git status --short --branch`, `git rev-parse HEAD origin/main`을 확인하라. 현재 인계 시점의 정확한 커밋/원격 상태는 이 문서 끝의 **최종 상태**를 기준으로 하고, 로컬의 다른 세션 미추적 파일은 건드리지 마라.

## 목표와 현재 격차

원래 사용자 목표는 **실제 옵션 없는 ODL 200건 기본 경로 종합 0.93 이상 + 모든 한국 PDF/HWPX/HWP5 회귀 게이트 통과**다. 1406ab7 출발점 기본 0.8433590088에서 이번 구조 후보는 **0.8487298276 (+0.0053708189)**까지 올랐다. NID 0.8906807025, TEDS 0.7492452657, MHS 0.7587729258, 누락 0이며 0.93까지 **0.0812701724** 부족하다. 개선 6문서, 악화 0, 불변 194. 명시적 `ocr:true`는 별도로 **0.8570042073**(출발 0.8516333884에서 +0.0053708189), 누락 0이다. 원래 한국 목표도 낮추지 마라: 시작점 대비 표 exact **2,553/2,692 이상**, cellF1 **0.966988 이상**, 글 order **0.98126 이상**, spaceF1 **0.97939 이상**이며 나머지 한국 지표·모수와 HWPX/HWP5는 비악화여야 한다. 이번 후보는 기본 ODL만 +0.00537이며 한국 목표를 아직 달성하지 못했다.

현재 남은 종합 손실의 기여는 **NID 0.06890046 / MHS 0.06059575 / TEDS 0.02177396**이다. +0.01을 첫 선별선으로 삼되 최종 0.93을 대체하지 마라. 작은 임계값 수정으로 한두 문서만 고치는 실험을 반복하지 마라. 출력이 실제 기본 경로에서 바뀌어 200건 평가 점수가 올라야 성과다.

## 이번 코드와 확인한 가설

`src/pdf/local-regions.ts`, `src/pdf/paragraph-lines.ts`, `src/pdf/page-blocks.ts`, `tests/pdf-local-regions.test.ts`를 읽어라. 사진·캡션 아래 짧은 두 단(013/015), 왼쪽 표시 제목+오른쪽 양쪽 정렬 본문(079/080), 클립 패널 옆 독립 본문(156), 큰 첫 글자 drop cap(007/079/080)을 원본 좌표 기준의 국소 영역으로 다룬다. 실제 기본 전체 채점은 `docs/odl-structural-deltas-2026-09-26.csv`, 중간 후보의 성공과 079 임시 회귀는 `docs/odl-structural-session-2026-09-26.md`에 있다. 185는 여전히 저자/각주·두 단 관계가 남는다. 이 코드가 원본 아이템 ID와 이미지·선·클립 출처를 통일한 영역 그래프 전체를 구현한 것은 아니다.

이번 실험이 보여준 건 **병합 전에 출처를 유지하며 영역 역할을 결정하면 여러 문서가 함께 나아질 수 있다**는 부분 증거다. 0.93을 위한 충분조건은 아니다. 다음에 메타데이터만 쌓고 출력이 바뀌지 않는 설계를 성과로 보고하지 마라. 015의 각주 순서, 079/080 본문의 남은 어절 오류, 156 라이선스 각주 제목 오탐, 185의 각주/저자 결합을 원본 렌더와 함께 확인하라.

## 다음 실험을 이 순서로 수행

1. **구조 손실 진단을 잠가라.** 200건 현재 출력과 GT의 NID/MHS/TEDS 손실 상위 문서를 분류하고, 원본 PDF를 렌더해 글자 bbox·baseline·font·`seq`, 이미지·벡터·클립·괘선 근거를 같은 좌표계에 놓아라. 먼저 개발군 015/079/080/156/185와 한국 exam_social/hwpx-02, 그 뒤 잔여 상위 171/172/069/028/086/031/183/199/110/122/141/116/130/197을 확인하라. ID는 진단용이지 제품 규칙이 아니다.
2. **내부 영역 소유권 모델의 작은 수직 구현을 만들라.** 진입점은 `extractPageBlocksWithLines` → `extractBlocksWithGrids` 또는 `extractPageBlocksFallback`이고, 줄 결합은 새 `paragraph-lines.ts`의 `pushLineParagraphs`다. 결합 전 원본 아이템별 ID·bbox·baseline·글꼴 분포·원본 순서·그래픽 출처를 보존하고, 전폭 요소가 나눈 각 밴드에서 본문/표/그림/각주/목차/제목 역할을 경쟁시켜라. 모든 아이템이 정확히 한 최종 영역에 소속되는 진단을 넣고, 애매하면 기존 출력을 유지하라. 공개 IR 변경은 필요성이 입증될 때만 한다. 단순 자료와 함수로 구현한다.
3. **문서 전체 제목 승격+강등을 구조 역할 뒤에 적용하라.** `block-detect.ts`의 dominantStyle/페이지 제목 존재 시 건너뛰는 정책(현재 face 기반 패스에서 `page.some(block => block.type === "heading")`이면 skip)을 검토하고, 줄별 스타일 순도와 문서 전체 본문 분포를 이용한다. 171/172 목차, 069 목록, 028 수식, 086 저자 소개, 031 캡션, 183/199 패널 제목, 156 각주에서 제목 후보와 본문 후보를 함께 평가한다. 이미 제목인 잘못된 블록도 강등한다. 문자열 정답 예외는 금지한다.
4. **표 경계를 영역 그래프에 연결하라.** 한국 156775700의 짧은 점선·작은 머리 행, 156775701/pii_bunseok/tac-img-02/scattered_header, ODL 116/130의 쪽 연결 표, 197의 남은 2행 1열 표를 검증한다. 원본 선·클립·셀 글의 소속을 보존하고, PDF에 없는 정답 여백 열을 생성하지 않는다. TEDS와 한국 exact/cellF1을 동시 추적한다.
5. **OCR은 기본 경로와 구분하라.** 명시적 OCR에서 110의 26×4는 이미 해결됐다. 110 기본 이미지 표, 122 텍스트+이미지 공존, 141 벡터 글은 여전히 남았다. 원본 글자를 유지하고 누락 영역에만 시각 인식을 붙여라. 기본 자동 복구를 넣으면 모델 준비·미설치 동작·시간/RSS·API 의미까지 정해 실제 옵션 없는 파서에서 재채점하라.

각 단계는 **영역만 적용 → 읽기 순서 → 제목 결합 → 표/OCR**로 분리해 200건 점수와 문서별 악화를 기록하라. 앞 단계의 실패를 뒤 단계의 점수로 숨기지 마라. 같은 접근 3회 실패 시 가설을 재수립하라. GT 문구/문서 ID 규칙, PDF/GT/평가기/제외 모수 변경 금지. 한국 문서별 회귀를 평균으로 숨기지 마라.

## 외부 파서 조사와 직접 실험

`docs/odl-structural-session-2026-09-26.md`의 **파서·엔진 조사 이력** 표를 먼저 읽어라. MarkItDown 0.1.8만 ODL 200건에서 별도 직접 실행했다. OpenDataLoader는 알고리즘 소스 참조와 기존 예측 재채점, PDF Inspector는 밑줄 코드 참조다. Docling/Marker/MinerU/Nutrient/Unstructured/PyMuPDF4LLM 등의 ODL 점수는 코퍼스에 포함된 **기존 예측 파일**이며 이번 세션에서 해당 엔진을 새로 돌린 실측이 아니다.

별도 가상환경에서 **Docling 표준+JSON**, **OpenDataLoader Hybrid 로컬 백엔드**, **Marker 기본/fast**, 필요시 **MinerU**, **PyMuPDF4LLM JSON**을 버전·설치 크기·라이선스·모델·언어·시간/RSS와 함께 순차 직접 실행하라. 200건 같은 평가기에서 Markdown 점수와 JSON의 영역 역할/bbox를 함께 보라. 엔진 통교체보다 kordoc가 재현할 수 있는 구조 신호를 찾는 데 집중하라. 기존 예측에 대한 현재 kordoc↔하이브리드 GT 문서 단위 oracle도 **0.925087**로 0.93 미달이다. MarkItDown, ODL 기본/Hybrid, Docling, Marker, MinerU, Nutrient, Unstructured 기본/hi_res, PyMuPDF4LLM, EdgeParse, LiteParse의 12종과 현재 kordoc를 GT로 문서별 선택한 oracle **0.958248**은 분석 상한이고 제품 라우터가 아니다. ODL Hybrid Helium/Hydrogen 변형과 저장소의 수동·oracle 연구 출력은 이 상한에서 제외했다. 엔진별 최신 버전은 직접 측정 전까지 가정하지 마라.

## 검증·Git·보고

ODL 고정 저장소 `/Users/chris_gomdori/workspace/odl-bench-breakthrough-20260925`를 변경하지 마라. 후보마다 새 예측 디렉터리를 쓰고 `--prediction-root`는 **절대 경로**로 넘겨라. 제품 빌드와 점수 실행을 겹치지 말고, 마지막 빌드를 고정한 뒤 순차 검증한다.

```sh
npm run typecheck
npm run build
node bench/odl-bench.mjs <새_벤치_디렉터리>
/Users/chris_gomdori/workspace/odl-bench-breakthrough-20260925/.venv/bin/python \
  /Users/chris_gomdori/workspace/odl-bench-breakthrough-20260925/src/evaluator.py \
  --prediction-root <새_벤치_디렉터리의_prediction_절대경로> \
  --engine kordoc --output-filename evaluation.json --log-level ERROR
node bench/pdf-table-gt.mjs --gate --no-ocr --verbose
node bench/pdf-text-gt.mjs --gate
npm test
npm run bench:gate
```

한국 표/글 `bench/out`은 다음 실행이 덮어쓰므로 후보별 복사본을 남겨라. 최종 후보는 기본/OCR ODL 각각 200건, 한국 표 716쌍·글 751쌍, HWPX/HWP5/PDF 점수와 퍼즈·OCR·자원 게이트를 순차 검증한다. 실험 중 전체 코퍼스 점수·시간/RSS를 같은 결과물과 대조한다. 다른 세션의 `.Codex/memory/`, `NEXT-SESSION-*`, `bench/odl-correction-sample.py`, `bench/odl-heading-oracle.py`, `bench/odl-loss-analysis.py`, `bench/odl-region-prototype.mts`, `docs/odl-document-deltas-2026-09-25.csv`, `:memory:.ses`를 수정/커밋하지 마라. 검증된 이번 변경만 명시적으로 커밋하고, 저장소의 사용자 지시에 따라 main에 푸시하라. **0.93과 모든 게이트 전에는 배포·완료 선언 금지.**

최종 보고에는 기본 0.93 격차, 명시적 OCR 점수, 한국 네 목표의 출발점·이번 증분·원래 목표 달성 여부, 악화 문서·원인, 모든 게이트, 시간/RSS, 커밋/원격 해시를 넣어라. 이번 단독 200건 측정은 기본 **7.76초 / 최대 RSS 842,022,912바이트**, OCR **58.67초 / 1,800,175,616바이트**였다. OCR 시간은 환경 차이가 있을 수 있으므로 다음 실험과 단순 비교하지 마라.

## 최종 상태

이번 세션의 최종 검증과 원격 체크포인트는 이 절에 기록한다. 다음 Claude 세션은 시작 시 `git rev-parse HEAD origin/main`으로 이 문서를 포함한 현재 해시와 원격 일치를 다시 확인하라.

- 최종 기본 평가 JSON: `/private/tmp/kordoc-structural-refactor-20260926/prediction/kordoc/evaluation.json`. 명시적 OCR: `/private/tmp/kordoc-structural-ocr-20260926/prediction/kordoc/evaluation.json`. 임시 경로가 사라졌다면 커밋된 CSV와 고정 코퍼스로 다시 생성하라.
- 전체 200건 기본 Markdown은 함수 이동 전후 바이트 단위 동일했다. 새 빌드의 `npm run typecheck`, `npm run build`, `npm test`는 통과했다. 테스트는 **2,385 통과 / 3 skip / 0 실패**였다.
- 한국 표/글은 1406ab7과 문서별 지표까지 동일하다. 보호 ODL 187 / 181 / 062도 각각 **0.9751461408 / 0.9884046772 / 0.9935654457**로 유지됐다.
- 최종 빌드의 `npm run bench:gate` 전체 통과. HWPX 표 **13,041/13,041**, HWP5 표 **4,237/4,237**, PDF coverage **0.99778**, 페이지 10/10, 한국 표 716쌍·글 751쌍, 왕복·형식·reflow·비식별화·OCR 정확도 통과. 퍼즈 **23,700회 사고 0**. 점수기 545.396초, 퍼즈 819.828초. 로그 `/private/tmp/kordoc-structural-final-gate.log`는 임시 파일이므로 없으면 다시 실행하라.
