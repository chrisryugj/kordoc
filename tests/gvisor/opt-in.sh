#!/bin/bash
# KORDOC_SANDBOX=gvisor 경로가 실제로 격리되는지 단언한다 (root·runsc 필요, CI gvisor 잡에서 실행)
set -euo pipefail
cd "$(dirname "$0")/../.."
fixture="$PWD/tests/fixtures/dummy.hwpx"
probe_file="/tmp/kordoc-sandbox-probe-$$"
run() { env "PATH=$PATH" KORDOC_SANDBOX=gvisor PROBE_FILE="$probe_file" node --import ./tests/gvisor/inside-probe.mjs dist/cli.js "$@"; }
check_probe() { # $1 = stderr 파일
  grep -q '\[probe\] {"gvisor":true' "$1" || { echo "FAIL gVisor 신호 없음"; cat "$1"; exit 1; }
  grep -q '"network":"blocked:' "$1" || { echo "FAIL 네트워크가 막히지 않음"; cat "$1"; exit 1; }
  [ ! -e "$probe_file" ] || { echo "FAIL 샌드박스 안에서 쓴 파일이 호스트에 남음"; exit 1; }
}

echo "== CLI 파싱"
run "$fixture" > /tmp/out.md 2> /tmp/err.txt
check_probe /tmp/err.txt
grep -q "서면자문 의견서" /tmp/out.md || { echo "FAIL 파싱 결과 없음"; exit 1; }

echo "== parse-worker protocol 2"
printf '{"id":1,"cmd":"parse","file":"%s","options":{"ocr":false}}\n{"cmd":"quit"}\n' "$fixture" | run parse-worker --protocol 2 > /tmp/worker.ndjson 2> /tmp/err.txt
check_probe /tmp/err.txt
sed -n 2p /tmp/worker.ndjson | grep -q '"success":true' || { echo "FAIL 워커 응답"; cat /tmp/worker.ndjson; exit 1; }
! head -1 /tmp/worker.ndjson | grep -q 'transport.images.files' || { echo "FAIL files 전송을 알림"; exit 1; }

echo "== 실패는 오류로 (격리 없이 계속하지 않음)"
if env "PATH=$PATH" KORDOC_SANDBOX=gvisor KORDOC_RUNSC=/nonexistent node dist/cli.js "$fixture" > /tmp/out.md 2>/dev/null; then echo "FAIL runsc 없는데 성공"; exit 1; fi
[ ! -s /tmp/out.md ] || { echo "FAIL runsc 없는데 출력이 나옴"; exit 1; }
if env "PATH=$PATH" KORDOC_SANDBOX=gvisor node dist/cli.js "$fixture" -o /tmp/x.md 2>/dev/null; then echo "FAIL -o 허용"; exit 1; fi
echo "OK"
