# 폐쇄망(내부망) 배포 가이드

인터넷이 차단된 망에 kordoc 을 반입·설치·운영하는 절차와, 보안성 검토에서 흔히
요구되는 항목의 근거를 정리한다. 대상 버전: **4.15.0 이상**.

## 1. 요약

| 항목 | kordoc |
|------|--------|
| 상시 외부 통신 | 없음 — 문서 파싱·생성·변환은 전 과정 로컬 |
| 조건부 외부 통신 | OCR 모델 최초 1회 다운로드, `watch --webhook` (둘 다 opt-in) |
| 외부 통신 차단 | `KORDOC_OFFLINE=1` — 요청 발신 전 차단 |
| 파일 접근 제한 | `KORDOC_ROOT=<디렉토리>` — MCP 읽기·쓰기를 해당 하위로 한정 |
| 계정·API 키 | 없음 (인증 요소를 사용하지 않음) |
| 텔레메트리·사용 통계 | kordoc 자체 전송 없음; ONNX POSIX 통계 전송은 엔진 초기화 전에 차단 |
| 설치 방식 | 오프라인 tarball (npm 레지스트리 불필요) |

## 2. 반입 번들 만들기 (인터넷 되는 PC)

네이티브 모듈이 포함되므로 **반입 대상과 같은 OS/CPU** 에서 만들어야 한다.
번들 파일명에 플랫폼이 박힌다 (`kordoc-offline-4.7.2-linux-x64.tar.gz`).

```bash
git clone https://github.com/chrisryugj/kordoc.git && cd kordoc
npm ci && npm run build

# 기본 (파서만, 가벼움)
node scripts/pack-offline.mjs

# OCR 엔진 + 모델까지 포함
node scripts/pack-offline.mjs --with-ocr --with-models
```

`--with-models` 는 로컬 캐시의 모델을 SHA-256 검증 후 동봉한다. 캐시가 비어 있으면
먼저 `kordoc check-ocr-models` / `kordoc check-formula-models` 로 내려받는다.

산출물은 `dist-offline/` 에 생기고, 압축 안에 `INSTALL.md` 가 함께 들어간다.

## 3. 설치 (내부망 PC)

```bash
tar -xzf kordoc-offline-<버전>-<플랫폼>.tar.gz
cd kordoc-offline-<버전>-<플랫폼>
node node_modules/kordoc/dist/cli.js --version
```

npm 레지스트리 접근이 일어나지 않는다. 모델을 별도로 반입했다면:

```bash
node node_modules/kordoc/dist/cli.js models --import ./models   # SHA-256 검증 포함
node node_modules/kordoc/dist/cli.js models --status
```

## 4. 운영 시 제한 모드

시스템 환경변수 또는 서비스 정의에 **두 변수를 고정**하는 것을 권장한다.

```bash
export KORDOC_OFFLINE=1
export KORDOC_ROOT=/srv/kordoc/work
```

| 변수 | 효과 | 위반 시 동작 |
|------|------|--------------|
| `KORDOC_OFFLINE` | 모델 다운로드·webhook 등 모든 아웃바운드를 시도 전에 차단 | 예외 발생, 사이드로드 방법 안내 |
| `KORDOC_ROOT` | MCP 서버의 파일 읽기·쓰기를 해당 디렉토리 하위로 제한 | `KORDOC_ROOT 밖의 경로입니다` 예외 |

`KORDOC_ROOT` 판정은 심볼릭 링크를 해석한 실제 경로(realpath)로 하므로 링크로
빠져나갈 수 없고, 형제 디렉토리(`/srv/kordoc/work-old`)도 통과하지 않는다.

MCP 서버는 기동 시 적용된 제한을 stderr 에 한 줄 남긴다:

```
[kordoc-mcp] 제한 모드: offline, root=/srv/kordoc/work
```

폐쇄망 모드에서 `kordoc setup` 을 실행하면 MCP 등록 항목이 `npx` 대신 설치된
`dist/mcp.js` 절대경로로 기록되고, 위 두 변수가 설정 파일의 `env` 에 함께 박힌다.

## 5. 아웃바운드 통신 전량 목록

소스 전체에서 `fetch` 를 호출하는 지점은 두 곳뿐이다.

| # | 위치 | 목적지 | 발생 조건 | 차단 |
|---|------|--------|-----------|------|
| 1 | `src/pdf/formula/models.ts` | `huggingface.co` | OCR/수식 기능 사용 + 모델 미캐시 (최초 1회) | `KORDOC_OFFLINE=1` |
| 2 | `src/watch.ts` | 운영자가 지정한 URL | `kordoc watch --webhook <url>` 명시 시에만 | `KORDOC_OFFLINE=1` |

검증(재현 가능):

```bash
grep -rnE '\bfetch\(' src --include='*.ts'          # 소스 기준 2건
grep -rn 'await fetch(' dist/*.js dist/*.cjs        # 빌드 산출물 기준(ESM/CJS 중복 포함)
```

인쇄·렌더 PDF의 Chromium 페이지는 `launchLockedPage`에서 JavaScript를 끄고
`data:`·`about:` 외 모든 요청을 차단한다. 이 제한은 `KORDOC_OFFLINE` 설정과 무관하게
항상 적용되며, 문서가 참조하는 외부 이미지·CSS·글꼴도 가져오지 않는다.

4.18.4부터 네이티브 OCR·수식 엔진은 ONNX Runtime 및 Transformers를 동적으로 불러오기 전에
`ORT_DISABLE_TELEMETRY=1`을 설정한다. ONNX Runtime 1.29의 POSIX 구현은 이 값으로
통계 업로더·이벤트·영구 장치 식별자의 생성을 생략한다. 이는 통계 스레드가 프로세스
종료 중 이미 해제된 mutex를 사용하는 충돌도 방지한다. kordoc가 초기화하기 전에 다른
라이브러리가 이미 만든 런타임에는 소급 적용되지 않는다. Windows ETW는 이 환경변수의
제어 대상이 아니므로 운영체제 추적 정책은 별도로 확인해야 한다.
근거: [ONNX Runtime 1.29 설정 구현](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/platform/telemetry_environment.h),
[POSIX 초기화 구현](https://github.com/microsoft/onnxruntime/blob/v1.29.0/onnxruntime/core/platform/posix/telemetry.cc).

두 경로 모두 `assertNetworkAllowed()`(`src/shared/offline.ts`)를 먼저 통과한다.
새 통신 경로를 추가하려면 이 함수를 거치도록 강제되어 있으므로, 감사 지점은 하나다.

webhook 은 `KORDOC_OFFLINE` 과 무관하게 상시 SSRF 방어가 걸려 있다 — http/https 만
허용하고, 사설 대역·루프백·링크로컬·클라우드 메타데이터 주소를 문자열 검사와
DNS 해석 결과 재검증으로 이중 차단하며 리다이렉트를 금지한다. 즉 내부망 주소로는
애초에 보낼 수 없다.

## 6. 데이터 흐름

입력 문서는 프로세스 메모리 안에서만 처리되고, 결과는 표준출력 또는 사용자가 지정한
출력 경로에만 쓰인다. 원문·파싱 결과를 외부로 보내는 경로는 없다 (5장 표가 전량).

임시 파일은 모델 다운로드 시의 `.part` 파일이 유일하며, 캐시 디렉토리
(`~/.cache/kordoc/models/`, `KORDOC_MODEL_CACHE` 로 변경 가능) 안에서만 생성된다.
중단된 모델 다운로드의 임시 파일에는 호스트·프로세스 범위와 PID 가 기록된다. 모델 확인·다운로드를
다시 실행하면 같은 범위에서 소유 프로세스의 종료를 확인할 수 있는 파일만 지운다. 이미 검증된 모델을
재사용하는 경로에서도 정리한다. 실행 중인 PID, 권한 때문에 확인할 수 없는 PID, 다른 호스트·프로세스
범위의 파일은 보존하며, 파일이 오래되었다는 이유만으로 지우지 않는다. Linux 에서는 커널 부팅 ID 와
PID 네임스페이스도 범위에 포함한다. 다른 OS 에서는 호스트명과 시스템 PID 공간을 사용하므로,
호스트명이 중복되는 여러 머신 사이에서 모델 캐시를 공유하지 않아야 한다.

이전 UUID 전용 `.part` 파일과 이전 부팅·네임스페이스의 파일은 소유 관계를 검증할 수 없어 자동으로
삭제하지 않는다. 이런 파일은 캐시를 공유하는 모든 다운로드가 종료된 것을 확인한 뒤 수동으로 정리한다.
스트리밍·체크섬·게시 오류 등 정상적인 예외 경로에서는 해당 다운로드의 임시 파일을 즉시 정리한다.

Java·Python SDK(`sdk/java`, `sdk/python`)를 쓰면 SDK 쪽에서 두 가지 파일이 더 생긴다.
`parseBytes`·`parse_bytes` 는 받은 바이트를 SDK 임시 디렉터리(기본 시스템 임시 폴더 아래 `kordoc-sdk-*`, 설정 `tempDir`·`temp_dir`)에
파일로 쓴 뒤 파싱하고, 성공·실패·취소와 관계없이 그 요청이 끝나면 지운다. 클라이언트를 닫을 때 디렉터리도 지운다.
이미지 파일 전송(`parse-worker --protocol 2` 의 `transport.images: "files"`)은 호출자가 지정한 디렉터리 아래에 요청별 디렉터리를 만들어
이미지 바이트를 쓴다. 이 파일은 호출자 소유라 워커와 SDK 가 지우지 않는다. 응답을 보내지 못한 요청의 디렉터리만 지운다.
워커가 응답 전에 강제 종료되면(SDK 의 제한 시간·취소·close) 그 요청의 `kordoc-<id>-*` 디렉터리가 남을 수 있다. 호출자가 정리한다.
SDK 에서 엔진을 쓸 때는 번들 안의 `node_modules/kordoc/dist/cli.js` 를 SDK 설정 `cli` 로 지정하고 `KORDOC_OFFLINE=1` 을 워커 환경에 넣는다.


## 7. 의존성

런타임 필수 의존성은 5개(`@modelcontextprotocol/sdk`, `@xmldom/xmldom`, `jszip`,
`markdown-it`, `zod`)이다. `cfb` 도 `dependencies` 에 선언되어 있으나 빌드 시 번들에
인라인되어 배포본에는 모듈 참조가 남지 않는다. OCR·PDF·인쇄 기능은
optional dependency 로 분리되어, 쓰지 않으면 설치할 필요가 없다
(`pack-offline.mjs` 기본값이 이를 제외한다).

라이선스 고지는 [`NOTICE`](../NOTICE), [`THIRD_PARTY/`](../THIRD_PARTY) 참조.
`npm audit --omit=dev` 기준 알려진 취약점 0건이다.

## 8. 검토 체크리스트

- [ ] 반입 번들이 대상과 동일한 OS/CPU 에서 생성되었는가
- [ ] `KORDOC_OFFLINE=1` 이 시스템 환경변수로 고정되었는가
- [ ] `KORDOC_ROOT` 이 업무 디렉토리로 고정되었는가 (MCP 사용 시)
- [ ] 모델을 반입했다면 `models --status` 가 전 항목 `verified: true` 인가
- [ ] MCP 서버 기동 로그에 `제한 모드:` 줄이 찍히는가
- [ ] 문서 처리 중 외부 연결이 없음을 망 모니터링으로 확인했는가
