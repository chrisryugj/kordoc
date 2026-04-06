# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.3] - 2026-04-06

### Added
- **HWP5 개요 수준(outline level) 기반 헤딩 감지** — `TAG_PARA_SHAPE` 레코드에서 개요 수준(bits 25-27)을 추출하여 정확한 heading 계층 생성. 기존 폰트 크기 휴리스틱의 폴백으로 병행 동작.
- **HWP5 "제X장/조" 패턴 헤딩 감지 강화** — 스타일 정보가 없는 배포용 문서에서도 "제N장/절/편" → H2, "제N조" → H3으로 자동 변환.
- **레이아웃 테이블 자동 해체** — 1~3행 테이블 중 셀 내 줄바꿈 과다(>5) 또는 텍스트 과다(>300자)인 레이아웃용 표를 IRBlock 레벨에서 paragraph 블록들로 분해. heading 감지 전에 수행하여 해체된 텍스트에도 heading 감지 적용.

### Fixed
- **DocInfo 태그 ID 상수 수정** — `TAG_DOC_CHAR_SHAPE`, `TAG_DOC_PARA_SHAPE`, `TAG_DOC_STYLE` 등 DocInfo 태그 ID가 HWPTAG_BEGIN(0x0010) 기준이 아닌 잘못된 값(0x003x)으로 정의되어 charShapes/styles가 항상 빈 배열이던 버그 수정. 이로 인해 폰트 크기 기반 헤딩 감지가 전혀 작동하지 않던 문제 해결.

## [2.0.2] - 2026-04-05

### Added
- **글상자(TextBox) 텍스트 추출** — HWPX `drawText` 요소와 HWP5 `gso` 제어문자에서 글상자 텍스트 추출. `rect`/`ellipse` 등 도형 안의 중첩 글상자도 재귀 탐색.
- **HWPX 중첩 표 별도 블록 분리** — 3행+2열 이상의 중첩 표를 텍스트 변환 대신 독립 마크다운 테이블로 출력. 결재란 등 복잡한 서식 구조 보존.

### Fixed
- **HWPX 목차 리더 페이지번호 제거** — `<hp:tab leader>` 뒤의 페이지번호가 헤딩 텍스트에 붙던 문제. `<hp:t>` 내 자식 노드 순회로 전환.
- **HWPX 헤딩 균등배분 패턴 매칭** — "제 1 장" 같은 공백 포함 패턴도 `제N장/조` 헤딩으로 감지.
- **표 rowSpan 빈 행 병합 개선** — "첫 열만 값, 나머지 빈" 행을 다음 데이터 행에 전파. colSpan 스킵 셀 구분 추가.
- **빈 1x1 표 필터링** — 마크다운 출력에서 빈 테이블 제거.

## [2.0.0] - 2026-04-05

### Added
- **HWP5 배포용 문서 복호화** — 배포용(열람 제한) HWP 파일의 ViewText 스트림을 AES-128 ECB로 복호화. 순수 JS 구현으로 네이티브 의존성 없음. rhwp(MIT)의 알고리즘 포팅.
- **Lenient CFB 파서** — 표준 cfb 모듈이 거부하는 손상된 HWP 파일을 직접 헤더/FAT/디렉토리 파싱으로 복구. 순환 감지, 체인 길이 제한 포함. rhwp(MIT)의 LenientCfbReader 알고리즘 포팅.
- **HWP5 각주/미주 추출** — CTRL_HEADER 내 각주/미주 본문 텍스트를 추출하여 `footnoteText` 필드에 연결.
- **HWP5 하이퍼링크 추출** — `%tok`/`klnk` 제어문자에서 URL 추출, `sanitizeHref` 적용.
- **HWP5 이미지 추출 강화** — Lenient CFB 경로에서도 BinData 이미지 추출 지원.
- **`LENIENT_CFB_RECOVERY` 경고 코드** — 손상 CFB 복구 시 warnings에 구조화된 코드 추가.

### Fixed
- **HWPX 표 colspan/rowspan 병합 밀림** — 병합 셀 계산 시 colSpan/rowSpan이 그리드 크기에 반영되지 않아 셀이 밀리던 버그 수정.
- **HWP5 코드 10(구역/단 정의) 처리** — char 타입으로 잘못 분류되어 14바이트 확장 데이터를 스킵하지 않던 버그 수정. extended 타입으로 재분류.
- **HWP5 하이퍼링크 XSS 방어** — `extractHyperlinkUrl` 결과에 `sanitizeHref` 미적용 수정. HWPX 파서와 일관성 확보.
- **`sanitizeHref` 중복 정의 제거** — `table/builder.ts`의 로컬 복사본 제거, `utils.ts`에서 import로 통일.

### Security
- CFB lenient 파서에 `sectorSizeShift` 범위 검증 추가 (7-16 범위만 허용, 악의적 파일의 메모리 폭주 방지)
- 하이퍼링크 URL 살균이 HWP5/HWPX/blocksToMarkdown 3개 경로 모두에서 일관 적용

### Credits
- **rhwp** (MIT, edwardkim) — HWP5 배포용 복호화 및 lenient CFB 파싱 알고리즘의 참조 구현

## [1.8.0] - 2026-04-04

### Added
- **XLSX 파서** — Excel 스프레드시트 파싱. 공유 문자열, 병합 셀(gridSpan/mergeCell), 다중 시트 지원. 시트별 heading + table 블록 생성. 부동소수점 아티팩트 정리.
- **DOCX 파서** — Word 문서 파싱. 스타일 기반 heading(outlineLevel), 번호 매기기(리스트), 각주, 하이퍼링크, 이미지 추출(a:blip), vMerge/gridSpan 테이블 병합.
- **ZIP bomb 공유 보호** — `precheckZipSize`를 utils.ts로 추출. HWPX/XLSX/DOCX 모든 ZIP 파서에 일괄 적용.
- **SSRF 보호 강화** — IPv6 사설 대역(fc/fd/fe80), 클라우드 메타데이터 엔드포인트, 16진수/8진수 IP 인코딩 차단.
- **heading 임계값 공유 상수** — `HEADING_RATIO_H1/H2/H3`을 types.ts에서 공유. PDF/HWP5/HWPX 전 파서 통일.

### Changed
- **PDF 파서 InternalParseResult 통일** — 기존 ParseResult 직접 반환 → InternalParseResult로 변경. index.ts에서 일괄 래핑. 에러 핸들링 경로 통일.
- **HWP5 BinData 최적화** — 최대 20,000회 CFB.find 순차 검색 → FileIndex 1회 순회 O(n).
- **cluster indexOf 최적화** — O(n²) indexOf → Map 기반 O(n).
- **MCP 확장자 허용** — ALLOWED_EXTENSIONS에 `.xlsx`, `.docx` 추가. 도구 설명 갱신.
- **Watch 모드** — xlsx/docx 확장자 감시 추가, 경로 순회 검증 추가.

### Fixed
- **CLI `--no-header-footer` 로직 반전** — Commander의 `--no-*` 패턴이 `removeHeaderFooter = true`(기본 동작)를 설정해 플래그가 무의미했던 버그 수정.
- **PDF timeout 타이머 누수** — Promise.race 성공 시 clearTimeout 미호출 수정.
- **HWPX href XSS** — 하이퍼링크 URL을 마크다운 렌더링이 아닌 추출 시점에서 살균.
- **깨진 ZIP 복구 경고 누락** — extractFromBrokenZip에서 warnings/sectionNum 전달.

### Security
- ZIP bomb 보호가 XLSX/DOCX에도 적용됨 (기존 HWPX만 보호)
- CLI 에러 메시지에 sanitizeError 적용 (파일시스템 경로 노출 방지)
- href 살균을 파서 추출 시점으로 이동 (block.href 직접 사용 시에도 안전)

## [1.7.2] - 2026-04-02

### Fixed
- **pdfjs-dist v5 호환** — `constructPath` 연산자의 args 형식 변경에 대응. v5에서 `subOps`가 배열 대신 단일 숫자로 전달되고, 좌표가 `DrawOPS` 상수(moveTo=0, lineTo=1, closePath=4) 기반 flat object로 변경된 것을 처리. v4/v5 모두 정상 동작.

## [1.7.1] - 2026-04-01

### Added
- **README-KR.md API 섹션 추가** — ParseResult 인터페이스, 타입 export, internal 안내 추가.
- 영문 README와 동기화 및 전반적인 가독성 개선.

## [1.7.0] - 2026-03-31

### Added
- **HWPX 파서 테이블 복합 타입 단순화** — 내부 구조 개선 및 성능 최적화.
- **public API 축소** — 보안 및 안정성을 위해 내부 함수들을 비공개로 전환.

## [1.1.2] - 2026-03-28


### Breaking Changes
- **IR 타입 export 제거** — `IRBlock`, `IRTable`, `IRCell`, `CellContext`를 public API에서 제거. `buildTable` 등 IR 조작 함수가 이미 제거되었으므로 일관성 확보.

### Fixed
- **`assert.rejects` await 누락 수정** — precheckZipSize 간접 테스트에서 엔트리 수 초과 검증이 실제로 실행되지 않던 버그
- **isStandaloneHeader 단어 제한 완화** — 4단어 → 7단어. "제1장 국민의 기본적 권리와 의무" 등 실제 법령 장 제목 커버
- **README-KR.md API 섹션 추가** — 영문 README와 동기화 (ParseResult 인터페이스, 타입 export, internal 안내)

## [1.1.1] - 2026-03-28

### Fixed
- **CI Node 18 호환** — `import.meta.dirname` → `dirname(fileURLToPath(import.meta.url))`
- **loadAsync 후 실제 엔트리 수 검증** — CD 위조와 무관한 진짜 방어선 추가
- **isStandaloneHeader 매직넘버 40 제거** — 패턴 기반 regex로 교체
- **mergeKoreanLines 빈 입력 방어** — `!text` 및 단일 줄 조기 반환

### Changed
- **`buildTable`, `blocksToMarkdown`, `convertTableToText` public API 제거** — 내부 전용
- **교차 검증 테스트 강화** — 3글자 이상 단어 기준 10% 이상 공통 비율

### Added
- **CI용 dummy.hwpx fixture** — 프로그래밍 생성, 커밋됨

## [1.1.0] - 2026-03-28

### Breaking Changes
- **`KordocError`, `sanitizeError`, `isPathTraversal`을 public API에서 제거**

### Changed
- **cleanPdfText 한국어 줄 병합 리팩토링** — 150자 regex를 3개 함수로 분리. 한글 번호, 숫자, 괄호, 기호, 법령 조항(제N조/항/호) 패턴 보호
- **precheckZipSize 안전성 강화** — try/catch, 22바이트 미만 버퍼 조기 반환, `@internal` 태그

### Added
- **실제 문서 통합 테스트** — .hwp, .hwpx, .pdf 파일 전체 파이프라인 검증 + 포맷 간 교차 검증
- **합성 HWPX 통합 테스트** — 마크다운 테이블 구조 정밀 검증, 멀티 섹션 순서 등
- **precheckZipSize 단위 테스트** 10개 — EOCD/CD 파싱, 경계 조건, 악성 입력
- README 보안 섹션에 **ZIP bomb 한계 명시**

## [1.0.2] - 2026-03-28

### Changed
- **KordocError 클래스 도입** — 모든 파서 에러 통합, MCP `sanitizeError` instanceof 판별
- **JSZip ZIP bomb 사전 검증** — loadAsync 전 Central Directory 직접 파싱
- **toArrayBuffer 최적화** — zero-copy 경로 추가

### Fixed
- cfb 버전 핀 (`1.2.2`), `@types/node` 다운그레이드 (`^18`), SECURITY.md 현실화

## [1.0.1] - 2026-03-28

### Fixed
- JSZip undocumented internal API 의존 제거
- MCP 에러 정제를 allowlist 기반으로 교체

### Added
- 보안 로직 회귀 테스트 9개, CHANGELOG.md, SECURITY.md

## [1.0.0] - 2026-03-28

### Security
프로덕션급 보안 강화: ZIP bomb 방지, XXE/Billion Laughs 방지, 압축 폭탄 방지, PDF 리소스 제한, HWP5 레코드/섹션 제한, 테이블 차원 클램핑, 경로 순회 차단, MCP 에러 정제/경로 제한, 파일 크기 제한.

### Fixed
- HWP5 제어문자 코드 10(각주/미주) 정상 처리

## [0.2.0] - 2026-03-27

### Changed
- IR 패턴 도입, 2-pass 테이블 빌더, colSpan/rowSpan 클램핑
- pdfjs-dist를 선택적 peerDependency로 변경

## [0.1.0] - 2026-03-27

### Added
- 최초 릴리스: HWP 5.x, HWPX, PDF 파싱, CLI, MCP 서버
