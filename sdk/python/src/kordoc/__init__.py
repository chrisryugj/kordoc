"""kordoc Python SDK — 상주 kordoc 엔진 워커(parse-worker protocol 2)로 한국 문서를 파싱한다.

    from kordoc import KordocClient

    with KordocClient() as client:
        result = client.parse("문서.hwpx", table_format="gfm")
        print(result.markdown)

실행 환경에 Node.js 와 kordoc 엔진(npm `kordoc`)이 따로 있어야 한다. 이 패키지는 엔진을 설치하지 않는다.
"""

from ._client import AsyncKordocClient, KordocClient
from ._config import KordocConfig
from ._errors import (
    KordocClosed,
    KordocError,
    KordocIncompatibleEngine,
    KordocParseFailed,
    KordocProtocolError,
    KordocQueueFull,
    KordocStartError,
    KordocTimeout,
    KordocWorkerCrashed,
)
from ._result import Image, ParseResult, WarmupReport, WorkerWarmup

__version__ = "0.1.0"

__all__ = [
    "AsyncKordocClient", "KordocClient", "KordocConfig",
    "ParseResult", "Image", "WarmupReport", "WorkerWarmup",
    "KordocError", "KordocStartError", "KordocIncompatibleEngine", "KordocProtocolError", "KordocWorkerCrashed",
    "KordocTimeout", "KordocQueueFull", "KordocClosed", "KordocParseFailed",
]
