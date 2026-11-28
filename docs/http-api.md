# kordoc HTTP API

Node.js 24.15 이상에서 `kordoc serve`를 실행하세요. 서버는 기본으로 `127.0.0.1:8787`에서 요청을 받습니다. 작업과 파일은 기본으로 현재 디렉터리 아래 `.kordoc-serve`에 저장합니다. `--data-dir`로 위치를 바꿀 수 있습니다. 같은 데이터 디렉터리는 한 번에 서버 하나가 사용합니다.

```bash
kordoc serve --data-dir ./kordoc-data
```

파일 한 건을 보내고 파싱 결과를 받으려면 `POST /v1/parse`를 호출하세요.

```bash
curl --fail-with-body \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @document.hwpx \
  'http://127.0.0.1:8787/v1/parse'
```

성공하면 HTTP 200과 JSON을 받습니다. JSON에는 `fileType`, `markdown`, `warnings`가 들어갑니다. 동기 요청의 대기 시간이 초과되면 HTTP 504 응답의 `Location`으로 이미 접수된 작업을 조회할 수 있습니다.

## 여러 문서 처리

파일마다 `POST /v1/jobs`를 호출하세요. 서버는 원본과 작업 기록을 저장한 뒤 HTTP 202와 작업 ID를 반환합니다. `Location` 헤더의 주소로 작업을 조회하세요.

```bash
curl --fail-with-body -i \
  -H 'Content-Type: application/octet-stream' \
  -H 'Idempotency-Key: document-42' \
  --data-binary @document.hwpx \
  'http://127.0.0.1:8787/v1/jobs'

curl --fail-with-body 'http://127.0.0.1:8787/v1/jobs/<jobId>'
```

상태는 `queued`, `running`, `succeeded`, `failed` 중 하나입니다. 완료된 작업에는 `result`가, 실패한 작업에는 `error`가 들어갑니다. 호출이 끊긴 뒤에도 접수된 작업은 계속 처리됩니다. 작업이 보관 중이면 같은 파일과 옵션을 같은 `Idempotency-Key`로 다시 보내 기존 작업 ID를 받을 수 있습니다. 같은 키로 다른 내용을 보내면 HTTP 409를 받습니다.

서버에는 기본으로 파싱 워커 두 개와 업로드 자리 네 개가 있습니다. 처리 중인 작업을 포함해 최대 1,024건을 대기시킬 수 있습니다. 파일 하나는 50 MiB, 대기 원본 합계는 512 MiB까지 받습니다. 작업 수와 원본 용량 중 먼저 도달한 상한이 적용됩니다.

큐나 동기 응답 보관 용량이 가득 차거나 재전송 중 기존 작업의 보관 기간이 끝나면 서버는 HTTP 503과 `Retry-After`로 답합니다. 여러 파일을 보낼 때는 업로드 동시 수를 제한하고, 접수되지 않은 요청은 안내된 시간 이후에 다시 보내세요. 완료 기록과 멱등성 키는 기본 24시간 동안 보관합니다. 보관 중인 작업을 포함해 기록은 최대 2,048건, 결과 파일은 512 MiB까지 저장합니다.

## 파싱 옵션

두 POST 경로 모두 쿼리 문자열로 옵션을 받습니다. 각 요청은 파일 한 개를 `application/octet-stream` 본문으로 보냅니다.

| 옵션 | 값 | 기본값 |
| --- | --- | --- |
| `ocr` | `false`, `true`, `force` | `false` |
| `blocks` | `true`면 구조화된 블록을 결과에 포함 | `false` |
| `pages` | `1-3,5` 형식의 쪽 범위 | 전체 문서 |

OCR을 사용하려면 같은 운영 계정에서 지원 모델을 미리 설치하세요. 서버 워커는 오프라인 모드에서 실행됩니다. [모델 설치](offline-deployment.md)

## 운영 설정

`kordoc serve --help`에서 업로드 크기, 대기 파일 총용량, 작업 수, 제한 시간, 결과 보관 기간, OCR 워커 수를 설정할 수 있습니다. 워커 하나가 한 번에 문서 한 건을 처리합니다. 워커가 처리 중 비정상 종료되거나 제한 시간을 넘기면 해당 작업을 한 번 재시도합니다. 서버를 정상 종료하면 진행 중인 작업을 대기열에 돌려놓습니다. 정상 종료로 중단된 작업은 재시도 횟수를 차감하지 않습니다. 컨테이너로 실행할 때는 `--data-dir` 경로를 영속 볼륨에 마운트하세요.

루프백 외의 주소로 열 때는 환경 변수 `KORDOC_SERVE_TOKEN`을 설정해야 합니다. 호출자는 `Authorization: Bearer <token>` 헤더를 보냅니다. 외부 네트워크에서 접속한다면 토큰을 설정하고 HTTPS 프록시 뒤에 서버를 두세요. 프록시가 루프백 서버로 전달할 때는 업스트림 `Host`를 `127.0.0.1`로 설정하세요.
