#!/bin/sh
# 지금 셸이 gVisor 안인지 단언한다. 아니면 실패한다 — 런타임 설정이 틀려 일반 컨테이너에서 돌면 통과로 보이지 않게.
# gVisor 는 지어낸 커널 로그 첫 줄로 "Starting gVisor..." 를 낸다 (google/gvisor pkg/sentry/kernel/syslog.go)
if dmesg 2>/dev/null | grep -q "Starting gVisor"; then echo "gVisor 확인: $(dmesg | head -1)"; exit 0; fi
echo "gVisor 안이 아닙니다 (dmesg 에 'Starting gVisor' 없음)" >&2
exit 1
