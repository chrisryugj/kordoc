# gVisor 샌드박스

kordoc 을 [gVisor](https://gvisor.dev/) 안에서 실행해 호스트를 지키는 방법을 정리한다.

kordoc 은 출처를 알 수 없는 문서를 읽는다. 문서를 읽는 동안 sharp(그림), onnxruntime(OCR), PDF 엔진 같은 네이티브 코드가 함께 실행된다. 이 라이브러리에 메모리 취약점이 있으면 그 취약점을 노린 문서 한 장으로 파서 프로세스를 장악할 수 있다. kordoc 의 기존 방어(압축 폭탄 상한, 경로 검사, XXE 차단)는 kordoc 이 직접 처리하는 단계를 지킨다. 라이브러리 내부의 취약점은 막지 못한다.

일반 컨테이너 안의 프로세스는 호스트 커널을 직접 호출한다. gVisor 는 이 호출을 자체 커널이 먼저 받아 처리하고 호스트 커널에는 꼭 필요한 일부만 넘긴다. 파서 프로세스가 장악되어도 공격자는 gVisor 커널까지만 닿는다. 호스트의 파일과 네트워크에는 직접 접근하지 못한다.

gVisor 는 kordoc 이 장악됐을 때 호스트를 지킨다. 한 워커가 처리하는 문서끼리의 격리는 지금과 같다.

## 실행 방법

| 방법 | 격리 범위 | 코드 변경 | 쓰는 곳 |
|------|----------|----------|--------|
| 컨테이너 런타임 (`docker --runtime=runsc`, 쿠버네티스 RuntimeClass) | kordoc 을 실행하는 컨테이너·파드 전체 | 없음 | 서버, MCP, 파일을 쓰는 명령 |
| `KORDOC_SANDBOX=gvisor` | 파싱 CLI·parse-worker 프로세스 | 환경 변수 하나 | 서버 프로세스는 밖에 두고 파싱 워커만 가둘 때 |

## 운영체제별 정리

| 운영체제 | 할 일 | 호스트를 지키는 것 |
|---------|------|------------------|
| Linux 서버 | 아래 `설치` 를 한 번 하고 위 두 방법 중 하나로 켠다 | gVisor |
| macOS·Windows | 설치할 것 없음. 보호가 필요하면 Docker Desktop 으로 컨테이너를 돌린다 | Docker Desktop 의 Linux VM(macOS 는 Apple Virtualization, Windows 는 WSL2) |

macOS·Windows 에서 `KORDOC_SANDBOX=gvisor` 를 켜면 경고 한 줄만 내고 격리 없이 실행한다. 같은 설정을 여러 운영체제에서 써도 오류가 나지 않는다. kordoc 은 runsc 를 설치하지 않는다. 설치에는 root 권한과 패키지 저장소 등록이 필요해, 서버 이미지를 만들 때 운영자가 한 번 한다.

## 설치 (Linux)

Debian·Ubuntu 는 공식 apt 저장소를 쓴다. CI `gvisor` 잡도 같은 명령을 쓴다.

```bash
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc

# Docker 에서 쓸 때만: runsc 런타임 등록 (apt 패키지만으로는 등록되지 않는다)
sudo runsc install && sudo systemctl restart docker

# 확인
runsc --version
docker run --rm --runtime=runsc node:24 dmesg | head -1   # Starting gVisor... (CI 와 같은 확인)
```

다른 배포판은 [공식 설치 안내](https://gvisor.dev/docs/user_guide/install/)의 바이너리 설치(SHA-512 확인 포함)를 따른다.

## Docker 로 실행

`설치` 의 `runsc install` 로 Docker 에 `runsc` 런타임을 등록한 뒤 쓴다([Docker 빠른 시작](https://gvisor.dev/docs/user_guide/quick_start/docker/)).

```bash
# 입력은 읽기 전용, 결과는 표준 출력. 네트워크 없음
docker run --rm --runtime=runsc --network=none --read-only \
  -v "$PWD/in":/in:ro <kordoc 이미지> kordoc /in/문서.hwpx > 문서.md
```

- 파일로 결과를 받으려면 출력 폴더만 쓰기로 연다: `-v "$PWD/out":/out` 뒤 `-o /out/문서.md`.
- 컨테이너 안이 gVisor 인지는 `dmesg` 첫 줄로 확인한다. gVisor 는 `Starting gVisor...` 를 낸다([syslog.go](https://github.com/google/gvisor/blob/master/pkg/sentry/kernel/syslog.go)). CI 도 이 줄로 확인한다(`tests/gvisor/assert-gvisor.sh`).

## 쿠버네티스

노드에 runsc 와 containerd 설정을 넣고 RuntimeClass 를 만든다([containerd 빠른 시작](https://gvisor.dev/docs/user_guide/containerd/quick_start/)).

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
---
# kordoc 을 쓰는 파드
spec:
  runtimeClassName: gvisor
```

GKE 는 GKE Sandbox 로 같은 설정을 켠다.

## KORDOC_SANDBOX=gvisor

CLI 와 parse-worker 가 스스로 `runsc do` 안에서 다시 실행된다. 꺼 두면(기본) 아무것도 하지 않고 출력도 지금과 같다.

```bash
sudo KORDOC_SANDBOX=gvisor kordoc 문서.hwpx > 문서.md
sudo KORDOC_SANDBOX=gvisor kordoc parse-worker --protocol 2   # Java·Python SDK 워커
```

| 항목 | 동작 |
|------|------|
| 네트워크 | `--network=none` 으로 끊는다. `KORDOC_OFFLINE=1` 도 함께 켠다 |
| 호스트 파일 | 읽기만 보인다. 샌드박스 안에서 쓴 파일은 메모리에만 남고 끝나면 사라진다 |
| 받는 명령 | 결과를 표준 출력으로 내는 파싱(`kordoc <파일>`)과 `parse-worker` 만. `-o`·`-d` 와 다른 하위 명령은 오류로 멈춘다. parse-worker 는 `transport.images: "files"` 를 거절한다 |
| 실패 | Linux 에서 runsc 가 없거나 띄우지 못하면 오류로 멈춘다. 격리 없이 계속하지 않는다 |
| macOS·Windows | gVisor 를 돌릴 수 없는 운영체제라 경고 한 줄을 표준 오류로 내고 격리 없이 그대로 실행한다. 같은 설정을 여러 운영체제에서 써도 오류가 나지 않는다 |
| 권한 | root 로 실행한다. rootless runsc 는 네트워크를 따로 두지 못하고 호스트 네트워크로 바뀐다([rootless 안내](https://gvisor.dev/docs/user_guide/rootless/)) |
| 다른 runsc | `KORDOC_RUNSC=<경로>` |
| 지원 값 | `gvisor` 만. 다른 값은 오류 |

SDK 는 워커를 `node dist/cli.js parse-worker --protocol 2` 로 띄우고 환경 변수를 물려준다. SDK 를 띄우는 프로세스에 `KORDOC_SANDBOX=gvisor` 를 주면 워커가 gVisor 안에서 돈다. 이미지 전송은 `inline`(기본)을 쓴다.

`runsc do` 는 gVisor 가 시험용으로 안내하는 명령이다([do.go](https://github.com/google/gvisor/blob/master/runsc/cmd/do.go)). 운영 서버는 컨테이너 런타임을 먼저 고려한다.

## 서버 운영

두 층으로 나눠 쓴다.

1. 인프라 층: kordoc 을 쓰는 파드·컨테이너 전체를 RuntimeClass `gvisor` 나 `docker --runtime=runsc` 로 띄운다. 코드는 바꾸지 않는다.
2. kordoc 층: 서버 프로세스는 밖에 두고, `KORDOC_SANDBOX=gvisor` 로 파싱 워커만 gVisor 에 넣는다.

권장 설정:

- 워커는 띄워 두고 여러 문서를 처리한다(재사용 샌드박스). 샌드박스를 띄우는 비용은 워커를 시작할 때 한 번만 든다.
- 비밀은 샌드박스에 넘기지 않는다. 클라우드 키·토큰은 파싱 워커 환경에 넣지 않는다. 업로드처럼 비밀이 필요한 일은 샌드박스 밖 프로세스가 맡는다. `KORDOC_SANDBOX=gvisor` 는 부모 환경을 그대로 물려주므로 워커를 띄우는 프로세스의 환경부터 비운다.
- 네트워크는 끊는다(`--network=none`, 쿠버네티스는 NetworkPolicy). `KORDOC_OFFLINE=1` 은 kordoc 코드가 요청을 보내기 전에 막는다. 네트워크 차단은 장악된 프로세스가 직접 연결하는 것까지 막는다. 둘 다 켠다.
- 서비스 거부는 따로 막는다. gVisor 는 침투를 가두는 장치다. CPU·메모리 고갈은 컨테이너 자원 제한과 kordoc 의 기존 상한(압축 해제·쪽 수·셀 수)으로 막는다.

## 성능

GitHub Actions `ubuntu-latest`(4코어·16GB, 가상 머신)에서 잰 값이다. runsc `release-20261102.0`, 플랫폼은 systrap(기본값, runsc 디버그 로그로 확인)이다. 같은 문서 5개를 일반 컨테이너(runc)와 gVisor(runsc)에서 번갈아 3회 재고 중앙값을 적었다. 두 컨테이너 모두 `node:24` 이미지에 `--network=none` 이다. HWP·HWPX 는 `tests/fixtures` 의 문서, PDF·DOCX·XLSX 는 측정용으로 만든 합성 문서다.

재사용 워커(parse-worker 하나를 띄워 두고 같은 문서를 거듭 처리, 2·3번째 처리의 중앙값):

| 문서 | runc | runsc | 비율 |
|------|-----:|------:|-----:|
| HWPX 240KB | 87ms | 95ms | 1.09 |
| DOCX 문단 3,000·표 200행 | 136ms | 144ms | 1.06 |
| PDF 30쪽 | 1,540ms | 1,639ms | 1.06 |
| XLSX 5,000행×6열 | 846ms | 935ms | 1.10 |
| HWP 21KB | 4ms | 5ms | 1.25 |
| 합계 | 2,613ms | 2,817ms | 1.08 |

시작 비용:

| 항목 | runc | runsc |
|------|-----:|------:|
| 컨테이너 시작부터 `node -e 0` 끝까지 | 185ms | 228ms |
| 컨테이너 안 워커 준비(ready 줄까지) | 334ms | 556ms |
| 컨테이너 안 워커 첫 요청(HWPX) | 198ms | 271ms |
| `KORDOC_SANDBOX=gvisor` 워커 준비 | 335ms(끔) | 934ms |
| `KORDOC_SANDBOX=gvisor` 워커 첫 요청(HWPX) | 189ms(끔) | 263ms |

메모리: 워커가 문서를 처리한 뒤 쉬는 컨테이너의 메모리(`docker stats`)는 runc 537.9MiB, runsc 549.0MiB 다. gVisor 커널 몫은 이 차이(약 11MiB)로 본다.

참고로 요청마다 샌드박스를 새로 띄우면(`KORDOC_SANDBOX=gvisor kordoc <파일>` 를 문서마다 실행) 문서당 614~974ms 가 더 든다. 권장 형태는 아니다.

CI 의 `npm test` 전체는 호스트(`test (24)` 잡)에서 182초, gVisor 컨테이너(`gvisor` 잡)에서 401초 걸렸다. 테스트는 프로세스를 많이 띄우므로 이 비율은 파싱 비용이 아니다.

## 남은 한계

- macOS·Windows 에서는 `KORDOC_SANDBOX=gvisor` 를 켜도 격리되지 않는다(경고만 낸다). 이 운영체제의 Docker Desktop 은 컨테이너를 Linux VM 안에서 돌리므로, 호스트 보호가 필요하면 컨테이너로 실행한다.
- gVisor 커널 자체의 취약점은 gVisor 업데이트로 대응한다.
- 파일을 쓰는 명령(`to-hwpx`, `render` 등)과 MCP 서버는 `KORDOC_SANDBOX` 를 받지 않는다. 컨테이너 런타임으로 격리한다.
