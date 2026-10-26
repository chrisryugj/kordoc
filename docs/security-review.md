# kordoc 보안 점검 자료 (공공기관 도입용)

공공기관이 kordoc을 도입할 때 보안성 검토·SW 보안약점 진단·오픈소스 점검 서류에 옮겨 쓸 수 있도록 개발 쪽 사실을 모은 문서다.
정책·연락처·영문 상세는 [SECURITY.md](../SECURITY.md), 폐쇄망 설치는 [offline-deployment.md](offline-deployment.md)가 정본이다.
기준일: 2026-10-13 (4.21.30 이후 main).

## 1. 제품 성격

- kordoc은 문서(HWP·HWPX·PDF·DOCX·XLSX·PPTX·이미지)를 Markdown·SVG·HTML로 바꾸는 **라이브러리·CLI·MCP 서버**다.
- 웹 서비스가 아니다. 계정·세션·DB·로그인 기능이 없고 자체적으로 포트를 열지 않는다(MCP 서버는 stdio 통신).
- 신뢰할 수 없는 문서를 입력받는다는 전제로 방어한다.

## 2. 네트워크 (방화벽 아웃바운드 신청 근거)

| 경로 | 목적지 | 발생 조건 |
|------|--------|-----------|
| OCR·수식 모델 최초 다운로드 | `huggingface.co` (443) | OCR 기능을 쓰고 모델이 아직 없을 때만 |
| `kordoc watch --webhook <URL>` | 운영자가 지정한 URL | 운영자가 옵션을 줬을 때만 |

- 이 두 경로 밖에서는 어떤 기능도 네트워크에 나가지 않는다(소스 전체에서 외부 요청 코드는 이 두 곳뿐, 둘 다 `assertNetworkAllowed()` 뒤).
- `KORDOC_OFFLINE=1`을 설정하면 두 경로도 요청 전에 막힌다. 모델은 인터넷 PC에서 `kordoc models --export`로 내보낸 뒤 반입해 `--import`하면 된다(SHA-256 검증).
- 따라서 **OCR을 쓰지 않거나 모델을 반입하면 아웃바운드 허용이 필요 없다.** OCR 모델을 직접 받게 하려면 `huggingface.co:443`만 허용하면 된다.
- 웹훅 대상이 사설·루프백·링크로컬·CGNAT·멀티캐스트·예약 대역으로 풀리면 거부한다(SSRF 방지, DNS 재해석 후 검사, 리다이렉트 안 따라감).

## 3. SW 보안약점 자체 점검 (행안부 고시 별표3 분류 기준)

2026-10-13 정적 분석 감사로 찾은 항목은 모두 고쳤고, 회귀 테스트는 `tests/security.test.ts`에 있다.

| 분류 | 점검 내용 | 조치 |
|------|-----------|------|
| 입력데이터 검증 및 표현 | 운영체제 명령 삽입 | 명령 실행은 셸 없는 배열 인자만 쓴다. 이번에 Windows COM 폴백이 파일 이름을 PowerShell 스크립트 문자열에 넣던 것을 환경 변수 전달로 바꿨다(둥근 따옴표 `’`로 문자열을 닫아 명령을 심을 수 있었다) |
| 〃 | 크로스사이트 스크립트(XSS) | SVG·HTML 출력의 문서 글은 전부 이스케이프한다. 이번에 `htmlTables` 칸의 `<img onerror>` 통과, Markdown의 `javascript:` 링크·참조 정의·코드 스팬 탈출·각주 미이스케이프를 막았다. 레이아웃 HTML에 CSP를 넣었다 |
| 〃 | 경로 조작 | 압축 파일 항목의 `..`·절대 경로·드라이브 문자를 거부하고, MCP 입출력은 realpath·심볼릭 링크 차단·`KORDOC_ROOT` 범위 검사를 한다. 이번에 MCP 쓰기 도구가 숨김 경로(`.claude` 등)와 에이전트 지침 파일(`CLAUDE.md`·`AGENTS.md` 등)에 쓰지 못하게 했다 |
| 〃 | 서버사이드 요청 위조(SSRF) | 웹훅 사설 대역 거부(2절). 이번에 198.18/15·192.0.0/24·멀티캐스트·예약·IPv6 멀티캐스트 대역을 더했다 |
| 〃 | XML 외부 개체(XXE) | DOCTYPE을 지우고 파싱하며 xmldom은 외부 개체를 가져오지 않는다 |
| 〃 | 위험한 형식 파일 처리 | 추출 그림은 그림 확장자로만 저장한다(그 밖은 `.bin`). 스크립트가 든 SVG는 `.svg`로 저장하지 않는다 |
| 보안기능 | 하드코드된 중요정보 | 소스·워크플로에 비밀번호·토큰이 없다(CI 토큰은 GitHub Secrets) |
| 〃 | 무결성 검사 없는 코드 다운로드 | 모델 파일 SHA-256을 코드에 고정해 다운로드·반입 때 검증한다. `kordoc setup`은 MCP 서버를 설치한 버전으로 고정해 등록한다(`kordoc@버전`). GitHub Actions는 커밋 SHA로 고정했다 |
| 시간 및 상태 | 자원 고갈(압축 폭탄 등) | 모든 압축 항목을 스트리밍으로 풀며, 선언 크기를 넘으면 그 자리에서 멈춘다. 누적 상한은 형식별 100~256MB, 항목 500개, HWP5 스트림 100MB, PDF 5,000쪽 |
| 에러처리 | 오류 메시지 정보 노출 | MCP 오류는 kordoc 오류만 그대로 내고, 나머지는 파일 경로·스택 없이 분류 문구로 바꾼다 |
| 코드오류 | 무한 재귀·중첩 | XML 깊이 200, 렌더 중첩 16 상한 |
| 캡슐화 | 샌드박스 | 인쇄·PDF용 Chromium은 JS를 끄고 외부 요청을 모두 막는다. 이번에 샌드박스를 기본으로 켰다(root Linux 컨테이너와 `KORDOC_CHROMIUM_NO_SANDBOX=1`만 예외) |
| API 오용 | `eval`·동적 코드 | `eval`·`new Function`을 쓰지 않는다. PDF.js 스크립트 실행을 끈다 |

## 4. 오픈소스 라이선스·취약점

- **라이선스**: kordoc은 Apache-2.0이다. 배포 의존성(운영·선택) 118개는 전부 MIT·ISC·Apache-2.0·BSD 계열이다(GPL·AGPL 0건). jszip은 MIT/GPL 이중 라이선스라 MIT를 고른다. 출시 게이트가 `scripts/check-licenses.mjs`로 매번 검사하고, 허용 목록 밖이면 출시를 멈춘다. 포함한 제3자 저작물 고지는 `NOTICE`·`THIRD_PARTY/`에 있다.
- **알려진 취약점**: `npm audit` 0건(운영·개발 의존성 모두, 2026-10-26). 출시 게이트(`prepublishOnly`)와 CI가 매번 `npm audit --audit-level=low`를 돌려 1건이라도 나오면 멈춘다. 저장소의 `package-lock.json`도 같은 기준이라, 클론해 `npm ci` 한 환경과 npm으로 새로 설치한 환경 모두 0건이다.
- **SBOM**: `npm run sbom` → `sbom.cdx.json` (CycloneDX 1.5). 제출본은 도입하는 버전에서 새로 만든다.

## 5. 도입 기관 권장 설정

| 설정 | 효과 |
|------|------|
| `KORDOC_OFFLINE=1` | 모든 아웃바운드 요청 차단 |
| `KORDOC_ROOT=<작업 폴더>` | MCP 서버의 읽기·쓰기를 그 폴더 안으로 한정(다중 사용자·AI 에이전트 연동 시 필수 권장) |
| 버전 고정 설치 | `npm install kordoc@<버전>` 또는 `kordoc setup`(자동 고정). `npx -y kordoc`처럼 버전 없이 등록하지 않는다 |
| Chromium 샌드박스 유지 | `KORDOC_CHROMIUM_NO_SANDBOX`를 설정하지 않는다. 컨테이너는 root가 아닌 사용자로 실행한다 |

## 6. 남은 한계

- 의존성(cfb·jszip·xmldom·pdfjs-dist·onnxruntime-node·sharp·pdfium) 내부 취약점은 업데이트로 대응한다.
- `KORDOC_ROOT`를 정하지 않으면 MCP 서버는 허용 확장자 파일을 어디서든 읽을 수 있다(5절 설정 권장).
- 선택 의존성 onnxruntime-node·protobufjs에 설치 스크립트가 있다. 폐쇄망 설치는 [offline-deployment.md](offline-deployment.md) 절차를 따른다.
