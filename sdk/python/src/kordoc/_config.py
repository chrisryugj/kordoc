"""런타임 설정 — Node·kordoc 엔진 위치, 풀 크기, 제한 시간, 입출력 상한."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from ._errors import KordocStartError

#: SDK 가 요구하는 워커 기능
REQUIRED_CAPABILITIES = ("parse", "options")


@dataclass(frozen=True)
class KordocConfig:
    """``KordocClient``·``AsyncKordocClient`` 설정.

    node: Node 실행 파일. 없으면 ``KORDOC_NODE`` → PATH 의 ``node``.
    cli: kordoc 엔진 진입점(``dist/cli.js`` 또는 npm 이 깐 ``kordoc`` 링크). 없으면 ``KORDOC_CLI`` → PATH 의 ``kordoc``.
    max_workers: 상주 워커 수(기본 1). 코어 수로 자동으로 늘리지 않는다.
    max_queue: 워커를 기다리는 요청 수 상한. 넘으면 ``KordocQueueFull``.
    request_timeout: 요청 기본 제한 시간(초, 대기 포함). None 이면 무제한.
    start_timeout / warmup_timeout / close_timeout: 시작(ready)·워밍업 한 건·종료 대기 제한(초).
    max_worker_rss_bytes: 응답의 rss 가 이 값을 넘으면 그 워커를 작업 사이에 새 워커로 바꾼다. None 이면 끔.
    max_request_bytes / max_response_bytes: 워커에 넘기는 입출력 한 줄 상한.
    stderr_tail_bytes: 예외에 붙일 워커 stderr 끝부분 크기.
    env: 워커 환경에 덧붙일 변수(``KORDOC_OFFLINE``, ``KORDOC_MODEL_CACHE`` 등). 나머지는 현재 환경을 물려받는다.
    temp_dir: ``parse_bytes`` 임시 파일을 둘 위치(기본: 시스템 임시 폴더).
    """

    node: str | os.PathLike[str] | None = None
    cli: str | os.PathLike[str] | None = None
    max_workers: int = 1
    max_queue: int = 64
    request_timeout: float | None = None
    start_timeout: float = 30.0
    warmup_timeout: float = 300.0
    close_timeout: float = 10.0
    max_worker_rss_bytes: int | None = None
    max_request_bytes: int = 1024 * 1024
    max_response_bytes: int = 256 * 1024 * 1024
    stderr_tail_bytes: int = 64 * 1024
    env: Mapping[str, str] = field(default_factory=dict)
    temp_dir: str | os.PathLike[str] | None = None

    def __post_init__(self) -> None:
        if self.max_workers < 1:
            raise ValueError("max_workers 는 1 이상이어야 합니다")
        if self.max_queue < 0:
            raise ValueError("max_queue 는 0 이상이어야 합니다")

    def command(self) -> list[str]:
        """워커 실행 인자 배열 — shell 을 거치지 않는다."""
        node = str(self.node) if self.node else os.environ.get("KORDOC_NODE") or shutil.which("node")
        cli = str(self.cli) if self.cli else os.environ.get("KORDOC_CLI") or shutil.which("kordoc")
        if not node:
            raise KordocStartError("Node 실행 파일을 찾지 못했습니다 — KordocConfig(node=...) 또는 KORDOC_NODE 를 지정하세요")
        if not cli:
            raise KordocStartError("kordoc 엔진을 찾지 못했습니다 — `npm i -g kordoc` 후 KordocConfig(cli=...) 또는 KORDOC_CLI 를 지정하세요")
        # npm 전역 설치의 kordoc 은 dist/cli.js 를 가리키는 링크다. node 로 직접 실행해 shell 래퍼를 피한다
        cli_path = Path(cli).resolve()
        return [
            node, str(cli_path), "parse-worker", "--protocol", "2",
            "--max-request-bytes", str(self.max_request_bytes),
            "--max-response-bytes", str(self.max_response_bytes),
        ]

    def environment(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(self.env)
        return env
