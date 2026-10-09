# 다음 세션 인계: kordoc 읽기·쓰기 품질·성능 연쇄 개선 캠페인 (2026-10-09, 4.21.3 기준)

목표는 kordoc 을 **한국 문서 읽기·쓰기 세계 1위**로 만드는 것이다. 전 벤치 점수, 속도·메모리, 생성 문서 품질을 함께 올린다.
추석 연휴 캠페인(2026-09-25~10-05, 4.15→4.18.x)의 연장이다. 그때 인계 문서는 [NEXT-CLAUDE-BENCH99-2026-09-28.md](NEXT-CLAUDE-BENCH99-2026-09-28.md)고,
세션 기록은 `docs/odl-*-session-*.md`·`docs/quality-*-2026-09-30.md` 에 있다. 거기 남은 공격 계획(A~E)은 지금도 유효한 후보다.

## 0. 운영 규칙 (매 사이클 반복)

1. **시작할 때**: `git pull` → [AGENTS.md](../AGENTS.md) 를 다시 읽는다 → `gh issue list --state open` · `gh pr list --state open` 을 확인한다.
   들어온 이슈·PR 은 캠페인보다 먼저 처리한다(재현 테스트 → 수정 → 이슈 답변·닫기, PR 은 리뷰 → 직접 고쳐 병합 → 덧글).
2. **한 사이클** = 목표 하나 → 가설 → 가장 싼 반증 실험 → 구현 → **전 벤치 재측정(문서별 하락 0 원칙)** → 테스트 → 커밋 → **최소 범프 릴리스**
   (버그·품질 개선은 patch, 새 옵션·공개 API 는 minor) → 이슈·PR 재확인 → 다음 사이클.
3. **점수를 채점기로 사지 않는다**: 정답·평가기·제외 모수를 바꿔 점수를 올리지 않는다. 원본 구조를 더 정확히 복원하는 쪽에서 방법을 찾고,
   채점기가 원본에 없는 것을 요구하는 경우에만 근거를 대고 바꾼 뒤 CHANGELOG·README 에 "채점 기준 변경"으로 밝힌다.
   이때 기준선도 새 채점기로 다시 잰다.
4. 휴리스틱(특히 PDF)은 눈대중 말고 **HWPX 쌍 원문 대조 교차표**로 판단한다. 예: 4.18.10 크기 가드는 눈대중으로 11건 개선이라 봤는데,
   쌍 대조로 보니 24:6 손해였다.
5. 릴리스마다 `docs/benchmarks.md` 최신 표를 갱신한다. 사이클 기록은 `docs/<주제>-session-<날짜>.md` 에 수치와 기각한 실험까지 남긴다.

## 1. 시작 전 기준선 (먼저 다시 잴 것)

아래 값은 문서에 남은 마지막 측정이다. 4.21.x 에서 바뀌었을 수 있으니 **첫 사이클 전에 4.21.3 `dist` 로 전부 다시 재서 기준선을 고정**한다.

| 벤치 | 마지막 값 (출처) |
|---|---|
| HWPX 2,286문서 · 9,865표 (`bench/score.mjs`) | 표 구조 100%, 셀 글 완전 일치 99.9982% (benchmarks.md 4.18.8) |
| HWP5↔HWPX 1,120쌍 | 표 구조 100% |
| PDF 글 744쌍 (`pdf-text-gt.mjs`) | 재현율 99.83 · 정확도 99.58 · 순서 99.15 · 어절 F1 98.81 — **spaceF1 이 0.99 미달** |
| PDF 표 708쌍 · 2,331표 (`pdf-table-gt.mjs --no-ocr`) | 탐지 99.83 · 구조 일치 97.94 · 칸 F1 0.9909 — **exact 99 미달** |
| 법령 별표 272건 (`annex-gt.mjs`) | PDF 구조 335/346 · 96.82% |
| ODL 200 (`~/workspace/odl-bench-breakthrough-20260925`) | 기본 0.958~0.960, plain+htmlTables 0.972. 비교: ODL 2.5.12 로컬 0.842(10-09 실측), ODL hybrid 0.907(공개 값) |
| OCR 53문서 · 102쪽 (`ocr-accuracy.mjs`, `ocr-robust.mjs` 열화 9종) | charRecall .984 · charPrecision .986 · CER .052~.059 |
| 생성 | `bench/visual`(한컴 실렌더 지각 해시), `predict-layout.mjs`, `verify-linebreak.mjs`, `gen-repro.mjs`, `perf-writer-fit.mjs` |
| 속도 | `perf.mjs`, `perf-quality.mjs`, `perf-synth.mjs` — ODL 기본 0.52초/쪽(OCR 캐시), OCR 끔 0.04초/쪽 |

연휴 때 쓴 4벤치 러너(`four.sh`·`cmp4.py`, 글·표·ODL·OCR 병렬 + 문서별 DOWN/UP)는 스크래치라 사라졌다. 다시 만들 것.
기준선은 **git worktree 로 옛 커밋을 따로 빌드**해 같은 채점기로 돌린다.

## 2. 공격 백로그 (가설 → 첫 실험 → 성공 기준, 우선순위 순)

### 읽기 — PDF
1. **ODL 에서 kordoc 이 지는 문서는 전부 kordoc 버그다** (10-09 실측, 예측 결과는 스크래치에 있어 사라질 수 있음 — 다시 만들 것):
   - 039: 두 단 본문을 테두리 없는 표로 오감지 → NID 0.72 (ODL 0.98). 클러스터 표 판정에 "단 사이 틈 + 줄마다 이어지는 문장" 반증을 넣는다.
   - 124: 원그래프 그림을 자동 OCR 이 쓰레기 글과 가짜 표로 읽는다. 차트 영역을 판별해 OCR 을 건너뛰거나 표를 만들지 않는다.
   - 198: `![image](image_001.png)` 자리표시가 남는다.
   - 108·157: 마크다운의 `<u>` 태그가 19문서에서 점수를 깎는다. 개정문 표시용인지 정하고, 유지할 거면 근거를 남긴다(유저 결정 사항).
   - ODL 2.5.12 가 kordoc 보다 0.02 이상 높은 문서는 NID 19건·MHS 11건이다. 다 확인한다.
2. spaceF1 0.988 → 0.99: BENCH99 B항이 남아 있다. 줄 꺾임 "근거 없으면 띄움" 자리 2,300곳에 쓸 새 신호가 필요하다(문단별 글자/어절 모드 추정 등).
3. 표 exact 97.9 → 99: BENCH99 C항이 남아 있다(연락처 표 열 경계, 쪽 넘김으로 두 조각 난 표).
4. ODL 쪽에서 배울 것(낮음~중간): 꼬리말 확장을 직전 요소와 30pt 넘게 떨어지면 멈추기(PR #386), 쪽 밖 글 필터를 시작점만 보지 말고 상자 전체가 쪽과 겹치는지로,
   선이 5000개를 넘는 쪽은 표 테두리 탐색 생략(veraPDF b847ce3).

### 읽기 — OCR·수식
5. **PP-OCRv6 small det @1280** (9.9MB, Apache-2.0, ONNX 입출력은 v5 와 같음): 열화 입력 CER .0954 → .0870, 한글 재현율 +0.2pp 이고 속도는 같다.
   그런데 changwon-plan2026 (+11pp)·web051 건축허가 서식 (+49pp)이 무너졌다. v6 가 리더 점까지 한 줄로 묶어 박스 기하가 달라졌기 때문이다.
   그래서 `line-split.ts`·리더 처리·`splitBoxAtCellRules` 를 다시 맞춰야 한다. 파라미터는 thresh 0.2 / box 0.45 / unclip 1.4 다.
   ⚠ `ensureOcrModels` 는 SHA 가 다르면 det.onnx 를 v5 로 몰래 다시 받는다. 실험할 땐 SHA 를 같이 바꿔야 한다.
   korean rec 는 v6 가 한국어를 지원하지 않아서 v5 가 최신이다.
6. 쪽 방향 180° 판정 `PP-LCNet_x1_0_doc_ori` (6.8MB): 코퍼스에 뒤집힌 스캔이 얼마나 있는지 먼저 센다.
7. **MFR-1.5** (`breezedeus/pix2text-mfr-1.5`, MIT, 크기 같음): 시작 토큰이 1 이다(`recognizer.ts:64` 는 2 로 고정 — 2 로 두면 쓰레기 출력).
   tokenizer 도 같이 바꿔야 한다. **정답 있는 수식 표본부터 만들고** 1.0 과 대조한다. 최대 토큰 256 → 512, 전처리는 nearest → bicubic 도 함께 본다.

### 읽기 — HWP 계열
8. 생성물 왕복: 요약 상자(`__kordoc_summary`)를 다시 읽으면 `>` 가 아니라 일반 문단이 된다(`section-walker.ts:437`).
   그래서 md→hwpx→md→hwpx 를 거치면 상자가 사라진다(v5·개조식 공통). 장 헤더처럼 셀 이름 채널로 복원한다.
9. rhwp devel 에서 조판이 아닌 수정을 계속 따라간다(마지막 동기화: v0.8.7 + 10-06 보안 통합 중 hwp3-depth·암호 선처리 누적 예산 반영).

### 쓰기 (공문서 생성)
10. **4.21.2 개조식 요약 상자 한글 실렌더 확인이 남아 있다** — 맥북 한컴에서 AX 메뉴 파일 → 인쇄 → PDF로 저장(화면 캡처·키 입력 없이)으로
    요약이 상자 안 2~3줄로 서는지 본다. 이어서 `npm run bench:visual` 전 케이스를 돌린다.
11. hwp-auto-docfit 에서 배울 것: 보고서 1쪽 맞춤 — 넘친 줄이 4줄 이하면 1쪽으로 보고, 위 간격 → 셀 여백 → 줄간격(160% 하한) 순서로 이분 탐색한다.
    문장 중간 대괄호 부연설명을 −2pt 로 줄이는 것, 한컴 저장본 lineseg 로 줄 끝 단어·기간 분리를 검사하는 것도 후보다.
    모두 kordoc 코퍼스로 다시 확인한 뒤 넣는다.
12. claw-hwp: 병합 해제 규칙(HWP5 는 행별 칸 수 배열 TABLE body+18 을 같이 맞춰야 한글이 연다)을 표 구조 패치를 열 때 참고한다.
    MCP `fill_form` 이 값을 도구 인자로 받아 대화 맥락에 남는 문제가 있다 — `fields_file` 입력을 추가할지 유저에게 묻는다.
13. korean-report-hwpx: 이번 동기화 기준은 `8076607` 이고 변화 없음. `node scripts/build-agency-styles.mjs <체크아웃>` 로 재생성한다.

### 성능
14. `perf.mjs` 로 포맷별 쪽당 시간·RSS 를 재고 상위 병목부터 본다(PDF 클러스터·OCR 전처리·HWPX 표 빌드). 품질 하락 0, 출력 바이트 동일을 확인한다.

### 코퍼스 보강
15. 수집 스크립트는 `bench/collect-*.mjs` 에 있다(opengov·open-go-kr·korea-kr(-pairs)·licbyl·rhwp·schift). 막히면 검색엔진 `filetype:`·`site:` 연산자를 쓴다(PDF 42건 실증).
    보강할 곳: HWP3, 스캔 PDF(OCR 모수), DOCX·XLSX·PPTX(formats 모수), 수식 PDF(정답 있는 수식 표본), 생성용 실결재(`bench/corpus-gen/`).
    `bench/corpus/` 는 전부 게이트 모수(recall 1 강제)다. 파서가 못 읽는 문서는 `known-false-miss/` 기준(docs/corpus.md)으로만 격리한다.
    모수가 바뀌면 docs/corpus.md 이력과 `score.mjs` MIN_POP 을 함께 고친다.
16. "세계 1위" 근거: `compare-md-parsers.mjs` 와 ODL 벤치 다른 엔진(docling·marker·markitdown·ODL 최신)을 같은 조건으로 재 README 비교표를 갱신한다.

## 3. 릴리스 절차 (최소 범프)

```
npm version <X> --no-git-tag-version
CHANGELOG [X] 절 · README/README-EN "최신 배포" 줄과 표 첫 행 · plugins/kordoc/.claude-plugin/plugin.json 버전
git commit "release: X"
npm publish        # prepublishOnly: sync-meta·notices·typecheck·test·build·bench:gate 59개 — 백그라운드로, 로그로 판정
git push origin main && git tag vX && git push origin vX
gh release create vX -F <CHANGELOG 절>
npm view kordoc dist-tags.latest --prefer-online    # 반영까지 1~6분
gh run list (CI·GitLab 미러) 확인
```

커밋 꼬리말:

```
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: <이번 세션 URL>
```

`main` 직접 커밋·푸시. 다른 세션의 미추적 파일(`bench/_*.mts`·`.Codex/`·`bench/_*-*.mjs` 사본)은 건드리지 않는다.

## 4. 함정 (실측)

- 벤치는 `dist/` 를 쓴다. 고쳤으면 빌드부터 하고, **벤치·게이트가 도는 동안 재빌드와 무거운 작업은 금지**한다.
  `fuzz-sweep` 느림 판정은 벽시계 기준이라 다른 게이트와 겹치면 흔들린다. 의심되면 단독으로 다시 돌린다.
- 백그라운드에서 `cmd > log; echo $?` 를 쓰면 하네스에는 늘 exit 0 으로 보인다. 성패는 로그의 판정 문자열(`PASS ✅`·`+ kordoc@X`)로 본다.
- 하네스 `diff` 는 다른 파일인데도 identical 로 보일 때가 있다. 동일성은 `cmp`·`shasum` 으로 판정한다.
- CJS 빌드(sucrase)는 삼항 안의 `await` 에서 exit 1 로 멈추는데 ESM·DTS 성공 로그만 찍힌다. 빌드는 exit 코드로 판정한다.
- zsh: 따옴표 없는 글롭, `=cmd` 확장, 단어 분할 없음. 스크래치 `.mts` 는 kordoc 밖이라 `jszip` 을 절대경로로 import 한다.
- 메모리 압박이면 하네스가 백그라운드 셸을 전부 죽인다. 큰 모델 실험은 단독으로, 쪽마다 파일로 남겨 재개할 수 있게 한다.
- **기계 구분**: 맥미니(`Mongminiui-Macmini`)에는 한컴오피스가 없다. 한컴은 맥북(`chris-m5-macbookpro`, Tailscale)에 있다.
  AGENTS.md 의 `ssh sm` 은 맥북 → 맥미니 방향이다. 코퍼스는 두 기계에서 바이트 동일로 맞춘다.
- OCR det 모델 SHA 불일치 → 자동 재다운로드 함정은 위 5번 참고.
