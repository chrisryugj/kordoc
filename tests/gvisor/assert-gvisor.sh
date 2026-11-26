#!/bin/sh
# runsc 가 Docker 의 OCI seccomp 설정을 적용하면 dmesg 를 읽을 수 없다.
release=$(uname -r)
case "$release" in
  *-gvisor) printf 'gVisor 확인: %s\n' "$release" ;;
  *) printf 'gVisor 커널 릴리스가 아닙니다: %s\n' "$release" >&2; exit 1 ;;
esac
