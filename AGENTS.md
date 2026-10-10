# kordoc 작업 지침

kordoc — 한국 공문서(HWP 3.x·5.x, HWPX, HWPML, PDF, XLS·XLSX, DOCX, PPTX, 이미지)를 Markdown·IR 로 바꾸고 비교·생성하는 파서 라이브러리.
npm 패키지로 배포하고 라이브러리 API·CLI(`kordoc`)·MCP 서버(`kordoc-mcp`, 도구 17개)를 낸다.

이 파일이 에이전트 공통 지침의 정본이다. Codex 는 이 파일을 바로 읽고, Claude Code 는 `CLAUDE.md` 의 `@AGENTS.md` 로 읽는다.
상세 참고: [docs/architecture.md](docs/architecture.md)(모듈 구조·설계 결정·구현 주의 상세), [docs/corpus.md](docs/corpus.md)(벤치 코퍼스 이력),
[docs/benchmarks.md](docs/benchmarks.md)(채점 기준·옵션별 수치), [docs/gongmunseo-engine-spec.md](docs/gongmunseo-engine-spec.md)(공문서 생성 엔진).

## 작업 규칙

- 사용자가 개선 완료와 반영을 요청한 작업은 검증 후 `main`에 반영하고 원격에 푸시한다. 이 저장소에서는 별도 PR이 필수 경로가 아니다. 병렬 작업과 충돌할 수 있으면 독립 worktree에서 준비한 뒤 최신 `main`을 확인하고 반영한다.
- 배포까지 요청되었거나 사용자가 이 작업에 적용한 배포 관례를 명시했다면, 검증된 `main`에서 버전·메타·변경 내역을 맞춘 뒤 npm 게시와 GitHub 릴리스를 완료한다. 게이트 실패나 불명확한 게시 상태가 있으면 원인을 해결하고 이중 게시를 피한다.
- 다른 작업 공간의 미커밋 파일과 코퍼스 심링크는 건드리거나 커밋하지 않는다. 관련 없는 PR의 변경은 섞지 않는다.
- PDF 품질 작업에서는 정답·평가기·제외 모수를 바꾸어 점수를 높이지 않는다. 외부 ODL 200문서, 한국 공문서 PDF 표·글, HWPX/HWP5 및 자원 사용을 따로 검증한다.
- 상위 공통 지침의 Git 정책과 다른 부분은 사용자가 이 저장소에 대해 2026-09-25에 명시한 `main` 반영·푸시·배포 관례를 따른다. 이후 사용자가 작업별로 범위를 제한하면 그 지시를 우선한다.
- 채점기·정규화를 바꿔야 하면(새 출력 표지를 걷는 등) CHANGELOG 에 "채점 기준 변경"으로 적는다.

## 명령

```bash
npm run build          # tsup — ESM+CJS 라이브러리 + CLI·MCP 바이너리 → dist/
npm run dev            # watch 모드
npm test               # node --import tsx --test tests/*.test.ts
npm run typecheck      # tsc --noEmit
npm run bench:gate     # 코퍼스 회귀 게이트 체인(pages·score·roundtrip·pdf-table·pdf-text·formats·fuzz·reflow·redact·ocr)
npm run bench:visual   # 한컴 실렌더 시각 오라클 (macOS GUI 전용, 발행 전 수동 1회 — bench/visual/, 순수 로직은 hash-lib.mjs)
npm run sync-meta      # 공문서 엔진 스펙 정본(docs/) → 스킬 사본(.claude/skills/gongmunseo/references/) 동기화
node bench/predict-layout.mjs 문서.hwpx --loose   # 생성 공문서의 한글 조판 예측(실글꼴 폭표, 한글 2024 PDF 154줄 재현) — 한컴 없이 벌어진 줄·고아 줄·압축 확인
```

- 벤치는 `dist/` 를 쓴다 — 소스를 고쳤으면 빌드부터. 벤치가 도는 동안 재빌드하지 않는다.
- `fuzz-sweep` 의 느림 판정은 벽시계 기준이라 다른 게이트와 동시에 돌리면 플레이크 — 의심되면 `node bench/fuzz-sweep.mjs --gate` 단독 재실행.
- ESLint·Prettier 는 없다. 주변 코드의 스타일·주석 밀도를 따른다.
- 배포: `npm publish`(prepublishOnly 가 sync-meta 드리프트·notices·typecheck·test·build·게이트를 강제, `--ignore-scripts` 금지) → 태그 → `gh release` → `mcp-publisher publish`(MCP 레지스트리, `server.json` 버전은 sync-meta 가 맞춘다).
  Python SDK(`sdk/python`)는 별도: pyproject·`__version__` 을 올리고 태그 `python-vX.Y.Z` push → `publish-python.yml` 이 PyPI 신뢰 게시(환경 `pypi`).
  `docs/gongmunseo-engine-spec.md` 를 고치면 `npm run sync-meta` 로 스킬 사본을 맞춘다(드리프트면 게시가 멈춘다).

## 코퍼스

- `bench/corpus/`(gitignore, 없으면 맥미니에서 rsync)는 전부 파서 게이트 모수(recall 1 강제)다. 생성 엔진 학습용 원본은 `bench/corpus-gen/` 에 두고 섞지 않는다 —
  파서가 못 읽는 문서 1건에 게이트가 죽는다.
- 맥북·맥미니의 `bench/corpus/` 는 바이트 동일로 맞춘다(맥북에서 `ssh sm` = 맥미니). rsync 는 rtk 훅 리라이트를 피해 절대경로로:
  `cd bench/corpus && /usr/bin/rsync -a --exclude '.DS_Store' <디렉토리…> sm:~/workspace/kordoc/bench/corpus/`
- 지표는 만점인데 `❌ 모수 하한 미달` 이면 품질 회귀가 아니라 폴더 누락이다(hwp쌍은 `pairs`·`hwp5`·`korea-kr`·`misc` 동명 짝 합산).
- 모수 구성·수집 스크립트·known-false-miss 격리 기준·날짜별 이력은 [docs/corpus.md](docs/corpus.md).

## 아키텍처 요약

```
Buffer → detectFormat() [매직바이트] → 포맷별 파서 → IRBlock[] → blocksToMarkdown() → Markdown
```

- 파서는 마크다운을 직접 만들지 않고 `IRBlock[]` 로 정규화한다. 표는 2-pass(병합 고려 격자 크기 → 칸 배치).
- 진입점 `src/index.ts`(`parse` 가 `detectFormat` 으로 분기 — 새 포맷은 여기), IR 타입 `src/types.ts`, 표 → 마크다운 `src/table/builder.ts`.
- 포맷별: `src/hwpx/`(파서·생성기), `src/hwp5/`, `src/hwp3/`, `src/pdf/`(텍스트층·표·읽기 순서), `src/ocr/`, `src/docx/`, `src/pptx/`, `src/xlsx/`, 렌더 `src/render/`, CLI `src/cli*`, MCP `src/mcp*`.
- 모듈별 역할 표와 설계 결정은 [docs/architecture.md](docs/architecture.md).

## 구현 주의

자주 틀리는 것만 한 줄씩 — 실측 근거와 사례는 [docs/architecture.md](docs/architecture.md#구현-주의-상세).

- `IRBlock` 타입을 바꾸면 모든 파서(hwpx·hwp5·pdf 등)와 `table/builder.ts` 가 영향을 받는다.
- HWP5 제어 문자(21종) 처리는 `hwp5/record.ts` — 확장·인라인 컨트롤은 16바이트, 하이픈(0x18)은 방출하지 않는다.
- PDF 줄 묶음은 `groupByY` 3px, 줄 안 틈은 글자 크기 비례(탭 max(2em, 30)·공백 `spaceGapThreshold`).
- 한컴 PDF 표는 칸 클립(`W n`)이 진실이다. 클립 판정을 바꾸면 `bench/pdf-table-gt.mjs` 와 licbyl HWP↔PDF 셀 대조를 함께 본다.
  `mergeParallelLines` 는 입력 선을 제자리 수정한다.
- PDF 1칸 틀은 획 4변이 있어야 한다(본문 영역 클립이 쪽 전체 1×1 표가 되는 것 방지). 테두리 없는 틀은 제목 아래 틀 기하로만.
- PDF 본문은 문단 블록이다(line-wrap 이 줄을 잇는다). 헤딩 판정의 글자 크기 중앙값은 아이템 수 기준이라 아이템을 쪼개는 변경은 중앙값을 흔든다.
- HWP5 `flattenLayoutTables` 는 A4 보다 높은 여러 쪽 본문 상자만 푼다.
- 보이지 않는 틀 표 풀기(`table/layout-frames.ts`, `layoutTables` 기본 visual)는 파서가 마크다운을 만들기 직전에 건다. 원본 표 서수가 필요한 경로(패치·세션·양식·`extractTables`)는 `layoutTables: "keep"`. PDF 는 한컴 PDF 칸 클립 격자 표에만 칸 변을 단다(워드 PDF 도 칸마다 클립을 깐다, ODL 064).
- 첨자는 파서가 IR 글에 `<sup>`·`<sub>` 를 넣는다(밑줄 `<u>` 와 같은 방식). `scriptTags` 기본은 HWPX·HWP·DOCX 켬, PDF 끔(`stripScriptTags`),
  OCR 글은 늘 평문. PDF 는 판정을 다 한 뒤 `tagScripts` 로 넣는다 — 판정 로직에 태그가 섞이면 안 된다. 채점 정규화는 태그를 걷는다.
  원문 글자 "<sub>"·"</sup>"·"<u>" 는 IR 에 `\<sub>` 로 담는다(`escapeLiteralTags`, 리터럴 `$` → `\$` 와 같은 규약). 새 파서 진입점에도 건다.
- 아웃바운드는 2곳뿐(`src/pdf/formula/models.ts` 모델 다운로드, `src/watch.ts` webhook), 둘 다 `assertNetworkAllowed()` 뒤. 세 번째를 만들지 않는다
  (`docs/offline-deployment.md` 가 grep 으로 주장한다).
- 공문서 생성(v5 official·report·plan·notice·minutes·ministry·bangchim)은 `hwpx/gen-gongmun.ts` 경로, 위계·글꼴 값은 `hwpx/gongmun-scheme.ts` 한 곳에서만
  (실측 인용 필수). 항목부호 뒤는 공백이 아니라 탭(`autoTab`).
- HWPX `breakNonLatinWord` 는 이름이 역전돼 있다: `BREAK_WORD` = 어절 유지, `KEEP_WORD` = 글자 단위.
- 공문서 모드에서 `<hh:heading type="OUTLINE">` 금지(한글이 개요 번호를 강제로 그린다) — 명명 스타일 "개요 N" 을 쓴다.
- HWPX `<hh:margin>` 은 자식요소형(`<hc:intent>`·`<hc:left>` …, `xmlns:hc` 필수)만 한컴이 읽는다. 내어쓰기는 `<hc:intent>` 음수.
- 생성 섹션 첫 run 에 `<hp:colPr colCount="1">` 필수(없으면 컬럼 영역이 좌우 10mm 좁아진다). 본문폭급 표는 outMargin 좌우 0.
- treatAsChar 표를 담는 호스트 문단의 줄간격 %가 표 줄높이에 곱해진다 — 쪽급 대형 표는 저줄간격 호스트.
- HWPX 스타일 전수 비교는 `scripts/style-digest.mjs` 덤프로(골라 읽기 금지). 한글 실조판 검증은 COM 체인
  `bench/hangul-com-pdf.ps1` → `bench/extract-pdf-lines.mjs` → `bench/verify-junctions.mjs`(Windows) 또는 `npm run bench:visual`(macOS).
