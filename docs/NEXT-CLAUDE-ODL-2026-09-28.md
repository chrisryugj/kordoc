# 다음 Claude 세션 프롬프트: kordoc PDF 구조 3차 (맥미니 이어가기)

아래 전체를 다음 세션에 그대로 전달한다. 사용자 goal: **ODL 기본 종합 0.95 이상**. 확인 질문 없이 개선을 반복하고, 검증된 묶음마다 main 커밋·푸시한다.

## 0. 시작 절차 (맥미니)

1. `~/workspace/kordoc` 에서 `git status --short --branch`, `git remote -v`. GitHub 원격이 없으면 `git remote add origin git@github.com:chrisryugj/kordoc.git` 후 `git fetch origin && git merge --ff-only origin/main`. SSH 22가 막히면 `git -c url."ssh://git@ssh.github.com:443/".insteadOf="git@github.com:" fetch`.
2. `npm ci`(또는 `npm install`) → `npm run build`.
3. ODL 코퍼스는 `~/workspace/odl-bench-breakthrough-20260925` 에 복사돼 있다(PDF 200·GT·평가기, `uv sync` 로 `.venv` 생성 완료). 수정 금지.
4. `AGENTS.md`, `CLAUDE.md`, `docs/odl-table-bands-session-2026-09-27.md`, 이 문서 순서로 읽는다.
5. 기준선 재현: 기본 채점이 **0.9159497** 이어야 한다(명령은 3절). 다르면 원인부터.

## 1. 현재 상태 (2026-09-28)

| 항목 | 값 |
| --- | --- |
| npm 배포 | **v4.15.5** (ODL 0.905513, GitHub 릴리스·태그 완료, #88 병합·#89 종료) |
| main HEAD | 4.15.5 이후 미배포 개선 커밋 포함, ODL **0.9159497** (NID 0.925090·TEDS 0.879106·MHS 0.895026) |
| 기존 ODL 하이브리드 재채점값 | 0.906572 (이미 넘음) |
| 한국 표 | exact 2,536/2,692, cellF1 0.965620, 중첩 exact 89.77% (인계 목표 2,545 미달) |
| 한국 글 | recall 0.99492·precision 0.96985·순서 0.98263·spaceF1 0.97858 |
| OCR 게이트 | 표 플로어 0.76/0.535 (v4.15.5 에서 사용자 승인 재산정), 최신 값은 커밋 메시지 참조 |

4.15.5 이후 들어간 것(각각 200건 재채점·하락 없음 확인): 표로 인정 못 한 열 줄 복원(043), 세 단 이상 패널 순서(183), 짧은 오른쪽 사이드바(118), 글리프 이름 복원(005·006·007, `fontExtraProperties`), 글자마다 띄운 대문자(163), 괘선 둘뿐인 평평한 머리 표(166), 칸 안 밑줄을 격자선에서 제외(180), 행 건너뛴 세로선 잇기(078·051~053), 머리행 앵커 칸 배정(117, 머리 서체가 다를 때만), booktabs 한 칸 제목 띠·머리 병합 조건(132·189), 캡션 상자 → 캡션 문단(070~073), 괄호 짝 안 맞는 제목 조각 강등(156), 슬라이드 키커 강등(182~184·199·200·103), 각주 띠 본문 크기 판정(008·011·014), 그림 엇갈린 띠 두 단 분리(140·177).

## 2. 기각·보류한 것 (다시 시도하지 말 것, 또는 조건부)

- 틈 열(폭 1pt 미만) 제거: 한국 한컴 표는 HWPX 정답에도 좁은 열이 실재 → exact −8.
- 격자 바로 위 무괘선 머리행 흡수(052 +0.046·182 +0.087): 텍스트층은 좋지만 OCR 경로(래스터 괘선)에서 goesan-budget-2022 cellF1 0.946→0.444. OCR 아이템(`seq` 없음) 또는 래스터 선 경로를 제외하는 가드를 넣으면 재시도 가치 있음.
- 변 합성 범위 축소(가계동향 요약 상자): OCR web050 CER 폭증.
- 마침표로 끝나는 제목 강등: GT 에 마침표 제목 다수(165·173~176).
- 표 칸 괘선 묶음을 취소선에서 제외: 이득 미미, 신구조문 위험.
- 저자 줄 위첨자를 경계 줄에 붙이기(185): 오히려 줄이 더 쪼개짐.

## 3. 측정 명령

```bash
# ODL 200건 (기본 경로)
OUT=/tmp/k4-x; ODL=~/workspace/odl-bench-breakthrough-20260925
rm -rf $OUT && mkdir -p $OUT && ln -s $ODL/pdfs $OUT/pdfs
node bench/odl-bench.mjs $OUT
$ODL/.venv/bin/python $ODL/src/evaluator.py --prediction-root $OUT/prediction --engine kordoc --output-filename evaluation.json --log-level ERROR
# 문서별 증감은 evaluation.json 의 documents[].scores 를 두 디렉터리끼리 비교

# 한국 게이트 (게이트 중 재빌드 금지 — 별도 worktree 에서)
node bench/pdf-table-gt.mjs --no-ocr   # bench/out/pdf-table.json
node bench/pdf-text-gt.mjs             # bench/out/pdf-text.json
node bench/ocr-accuracy.mjs --gate     # OCR 게이트 (표 floor 0.76/0.535)
node bench/pdf-table-gt.mjs --no-ocr --doc=<부분이름> --verbose   # 표별 cellMisses
```

실험은 별도 worktree(`git worktree add /tmp/kordoc-exp HEAD`, `node_modules`·`bench/corpus` 심링크)에서 하고, 기능마다 임시 환경변수 토글로 A/B 한 뒤 채택 후 토글을 지운다(`grep -rn "process.env" src/pdf` 로 확인). 한국 표·글·OCR 게이트는 기능 묶음마다 돌린다 — 이번 세션 회귀 3건(틈 열·머리행 흡수·앵커 배정)은 전부 한국/OCR 게이트로만 드러났다. fuzz 단계와 다른 무거운 작업을 동시에 돌리지 말 것.

## 4. 0.95까지 남은 것 (0.9159 → +0.034)

손실 대부분은 파서 구조보다 **그림 속 글**이다. NID 진단(세션 기록) 기준:

1. **그림 속 글(OCR 전용, 55문서 추정, 이상적 +0.012 안팎)**: 141(스캔), 110·122(그림 표), 148·027·107·059·106·134·136·098·131·060·085·126(차트·로고). 명시적 OCR(`ocr:true`) 200건은 중간 빌드 0.9104(+0.008, 112초·RSS 1.26GB)였고 대상이 스캔 쪽·큰 그림 쪽뿐이다. **기본 경로 자동 OCR 도입은 사용자 결정 사항**(시간·RSS·모델 준비·미설치 동작 수치로 제시). 먼저 명시적 OCR 에서 차트 그림 영역도 OCR 하도록 넓혀 `ocr:true` 점수를 올리는 것은 허용.
2. **출력 정책(사용자 결정)**: `![image](…)` 자리표시(91문서, NID +0.0059), 링크 `[텍스트](url)`·`<u>`(24문서, +0.0039). GT 에 없지만 제품 기능이라 임의로 끄지 말 것.
3. **파서 구조(여기가 작업 대상)**:
   - 표: 146·150(워드 음영 칸 표, 흰 틈으로 칸이 갈리고 행마다 클립 표가 따로), 200(슬라이드 표, 5pt 글자가 칸 윗선에 걸림), 170(여러 줄 머리 booktabs, GT 는 걸친 머리를 칸마다 반복), 197(1열 booktabs), 052·182(격자 위 머리행 — 2절 OCR 가드 후 재시도).
   - 제목(MHS 잔여 약 0.021): 199 두 줄 제목(둘째 줄 소문자 시작·같은 서체·줄 간격 넓음 → 이어진 줄 병합), 086 저자 줄, 031 분수 수식 줄(`<u>` 섞임), 069 굵은 도입 문장, 118 사이드바 라벨(근거 없이 규칙 금지), 184 큰 숫자 제목("1.8X ↑1").
   - 읽기 순서: 185 저자 줄 위첨자, 199·200 슬라이드 차트 글.
4. **한국 표 exact +9**: 보도자료 "담당 부서" 표(15곳 안팎)는 HWPX 숨은 칸이 PDF 에 기하 증거 없이 사라진 경우라 문구 규칙 없이는 불가로 판단했다. 가계동향(156775700)은 숨은 행·열·단위 행. 새 기하 증거를 찾지 못하면 목표 재조정을 사용자에게 보고.

## 5. 마무리 규칙

검증된 묶음만 명시 경로로 커밋, main 직접 푸시. 배포는 사용자가 요청할 때 `npm publish`(prepublishOnly 가 전체 게이트 강제, `--ignore-scripts` 금지) → 태그 → `gh release`. 릴리스마다 CHANGELOG·README 변경사항·CLAUDE.md 모듈표 현행화, 버전은 patch. 세션 끝에 `docs/odl-*-session-*.md` 기록과 문서별 CSV 를 남긴다.
