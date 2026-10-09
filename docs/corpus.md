# 벤치 코퍼스

`bench/corpus/`(gitignore)와 `bench/corpus-gen/` 의 구성·동기화·모수 이력. 작업 규칙 요약은 [AGENTS.md](../AGENTS.md#코퍼스).

## 동기화와 모수 이력 (2026-09-05 기준선부터)

`bench/corpus/` 아래는 전부 **파서 게이트 모수**다(recall 1 강제). 생성 엔진 학습용으로 긁은 실결재 원본은
`bench/corpus-gen/`(gitignore, 2026-09-06 `opengov-2609/` 280건)에 두고 corpus 에 섞지 말 것 — 섞으면 파서가 못 읽는
문서 1건에 게이트가 죽는다(36900720 recall 미달로 실측). corpus-gen 도 맥미니와 rsync 로 맞춘다.

맥북·맥미니 양쪽 `bench/corpus/` 는 바이트 동일로 맞춰 둔다. 2026-09-05 에 법령 별지서식
`licbyl/`(법제처 licbyl API 표본 300건 — HWP5 원본 + PDF + rhwp v0.8.6 `export-hwpx` 변환 HWPX,
`bench/collect-licbyl.mjs` seed 20260905 로 재현) 900파일, 같은 날 v4.12.2 에서 `licbyl2/`(서식 2차,
seed 20260906 `--exclude=licbyl`, 279쌍 — 표본 풀 소진으로 300 미달) 837파일과 `licbyl-byl/`(별표
`--knd=1`, 90쌍) 271파일, v4.12.3 에서 `licbyl-byl2/`(별표 3차, seed 20260907 `--knd=1
--exclude=licbyl,licbyl2,licbyl-byl`, 183쌍 — 풀 소진으로 200 미달) 549파일이 들어와 게이트 모수는 hwpx ~1,390·pdf
~950·hwp쌍 ~860 이다. rhwp 변환본 가운데 자기참조 GT 정렬이 깨지는 것(licbyl 5 + licbyl2 11 + licbyl-byl2 1)은
`known-false-miss/` 에 격리했다(README
참조 — 판정 기준은 **HWP5 쌍 유사도 1 + 미스 문자열이 파서 출력에 있음**, 둘 다 확인하고 옮길 것).
rhwp 바이너리는 GH release v0.8.6 macos-aarch64(스크래치에 두고 `rhwp export-hwpx in.hwp out.hwpx`).
종전(2026-08-22) 모수는 hwpx 350·pdf 92·hwp쌍 23 — `score.mjs` 의 `MIN_POP` 하한(170/25/12)에 여유가 있다.
HWP5↔PDF 셀 대조 보고 지표는 `node bench/cmp-hwp-pdf.mjs licbyl [--linebreaks]`(licbyl 0.965·licbyl2
0.966·별표 0.746·별표 3차 0.787 — 별표가 낮은 원인은 v4.12.3 실측으로 A 1×1 틀 PDF 미감지 8 / B HWP5
`flattenLayoutTables` 해체 vs PDF 1열 유지 15 / C 구조 차 7(수식 셀·쪽 경계 분할, 파서 결함 아님) — 게이트 아님).

2026-09-23 에 `rhwp/`(rhwp 저장소 samples 1,351파일: hwp 523·hwpx 416·pdf 412, 스템마다 한컴 PDF 한 벌, `bench/collect-rhwp.mjs`)과
`korea-kr-pairs/`(정책브리핑 보도자료 hwpx+pdf(+hwp) 짝 200쌍, `bench/collect-korea-kr-pairs.mjs --pages=20-120 --exclude=korea-kr,korea-kr2`)이
들어와 게이트 모수는 hwpx 1,994·pdf 1,561(채점 1,384)·hwp쌍 1,058, PDF 표 GT(`pdf-table-gt.mjs`)는 430쌍 1,784표(중첩표 트랙 157표)다.
2026-09-24 부터 PDF 텍스트층 한글이 HWPX 한글의 1% 미만인 쌍(rhwp cairo 렌더가 한글을 채운 곡선으로 그린 13쌍 표 46·중첩표 27)은 텍스트층 트랙
모수에서 빼고 `[텍스트층 없음·OCR]` 보고 트랙(`ocr:true`, 게이트 아님, `--no-ocr` 로 끔)에서 채점한다. 텍스트층 트랙은 417쌍 1,738표(중첩표 130).
같은 쌍으로 PDF 글을 HWPX 정답과 대조하는 `pdf-text-gt.mjs`(recall·precision·순서·어절 F1)도 게이트다. 개인정보 외부 정답은 `bench/corpus/schift/`
(`node bench/collect-schift.mjs`: Schift License 데이터라 커밋 금지, 없으면 redact-bench 외부 트랙 SKIP).
rhwp 의 HWP3 변환본 4건(`hwp3-sample5·10·11·14`)은 hp:t 안 셸 텍스트의 리터럴 `$`(`$HOME`·`$1`)가 인라인 수식 `$…$` 와
구별되지 않아 HWPX recall·phantom·순서 게이트에 걸렸다. v4.14.3 에서 IR 리터럴 `$` 규약(원문 `$` → `\$`, `escapeLiteralDollar`)으로 풀었다.
미기입 누름틀 안내문(rhwp form-01·form-02·issue1893)은 IR 글에 `placeholder` span 으로 남기고 마크다운·참조 모두에서 뺀다
(`bench/ref/policy.mjs` clickhere-placeholder).

hwp쌍 23은 `corpus/pairs`(10) + `corpus/hwp5`(13)이 아니라 **`korea-kr`·`misc` 의 hwp+hwpx
동명 짝까지 합산한 값**이다. 이 폴더들이 한쪽에만 있으면 쌍이 10으로 떨어져
`❌ 모수 하한 미달` 로 게이트가 죽는다 — 지표는 전부 만점인데 모수만 미달하는 형태라
품질 회귀로 오진하기 쉽다.

2026-10-09 (4.21.6) 에 세 묶음이 들어왔다. `hwp3/`(HWP 3.x 원본 75건 — 2000년 전후 정부·공공기관 사이트 문서를 웹 아카이브에서 받은 것, 출처 URL·sha256 은
`hwp3/manifest.json`)은 정답 짝이 없어 `score.mjs` 의 HWP 단독 파싱 트랙(파싱 성공 게이트)과 `fuzz-sweep` 에만 든다 — 4.21.6 에서 본문 뒤 추가 정보
블록의 포함 그림을 읽게 되어 그림이 나온다(종전 0, 그림만 붙인 스캔 보고서는 빈 출력이었다). `formats/` 는 공공기관 사이트 자료로 보강했다(출처·sha256 은
`formats/manifest.json`): pptx 27(트랙 신설, 발표 자료)·docx 16·xlsx 15. xlsx 하나(KOSIS 지역별고용조사 통계표, 426·365열)는 넓은 시트 수리와 함께
들어갔다 — 종전 파서는 200열 밖 칸 12,488개를 경고 없이 버렸다(4.21.5 코드로 큰 시트 게이트 문자 0.997·숫자 0.934). 뺀 것: 비압축 153.6MB xlsx(ZIP 폭탄
상한 100MB — 의도한 거부), vMerge 연속 칸에 머리 칸 글이 되풀이된 HWP→DOCX 변환 신청서 1건(파서는 칸 글을 머리 칸에 모아 유실이 없지만 정답 행 순서와
어긋나 정렬이 2자를 miss 로 센다 — Word 가 연속 칸 글을 그리는지 확인 전까지 모수 밖). `rhwp/` 는 rhwp main(1a76570e83)을 다시 모아(`collect-rhwp.mjs`)
09-23 수집(680111ec) 뒤 새 hwpx 139·hwp 91 을 보탰다(새 pdf 64 는 글·표 게이트를 깎아 보류, 같은 경로인데 내용이 바뀐 33개는 기존 모수를 흔들지 않게
옛 것을 둔다). 게이트 모수는 hwpx 2,424·pdf 1,911·hwp쌍 1,130 — `score.mjs` 의 `MIN_POP` 을 이 값으로 올렸다. 맥북 쪽은 동기화 전까지 모수 하한 미달이 뜬다.

```bash
# 기기 간 코퍼스 동기화 — rtk 훅이 rsync 를 리라이트해 출력을 삼키므로 절대경로로 호출
cd bench/corpus && /usr/bin/rsync -a --exclude '.DS_Store' <디렉토리…> sm:~/workspace/kordoc/bench/corpus/
```

`fuzz-sweep` 의 `slow` 판정은 30s 벽시계 임계라 **다른 게이트와 동시 실행하면 플레이크**다.
실측(2026-08-22): 단독 최장 17.2s → 두 기기 게이트 병주 중 30.6s 로 FAIL. 코드 결함과
구분하려면 `node bench/fuzz-sweep.mjs --gate` 를 부하 없이 단독 재실행해 볼 것.
2026-09-23 부터 멈춤·느림 한도는 문서마다 max(30s, 원본 파싱 시간 × 3, 상한 180s)다. 변형이 30초를 넘을 때만 원본을 한 번
재서 같은 파싱을 그 한도까지 더 기다린다(행정업무운영 편람 PDF 367쪽은 깨끗한 원본도 35초, 머리 오염 변형은 xref 재구성으로 80초).
