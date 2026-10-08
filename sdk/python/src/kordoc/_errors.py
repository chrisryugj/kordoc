"""SDK 예외 — 문서 파싱 실패(``ParseResult.success is False``)와 전송·런타임 오류를 구분한다."""

from __future__ import annotations


class KordocError(Exception):
    """kordoc SDK 예외의 기반 클래스."""


class KordocStartError(KordocError):
    """Node·kordoc 엔진을 찾지 못했거나 워커가 시작 제한 시간 안에 ready 를 보내지 않음."""


class KordocIncompatibleEngine(KordocStartError):
    """엔진이 parse-worker protocol 2 나 필요한 capability 를 지원하지 않음."""


class KordocProtocolError(KordocError):
    """워커가 요청을 거부했거나(``code``) 잘못된 응답을 보냄."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class KordocWorkerCrashed(KordocError):
    """요청 처리 중 워커가 끝났거나 응답 줄이 끊김. ``stderr_tail`` 은 마지막 진단 출력."""

    def __init__(self, message: str, stderr_tail: str = "") -> None:
        super().__init__(message + (f"\n--- worker stderr (tail) ---\n{stderr_tail}" if stderr_tail else ""))
        self.stderr_tail = stderr_tail


class KordocTimeout(KordocError, TimeoutError):
    """요청 제한 시간 초과 — 대기 큐 입장부터 결과 수신까지. 실행 중이었다면 담당 워커를 종료했다."""


class KordocQueueFull(KordocError):
    """대기 큐가 가득 참 (``KordocConfig.max_queue``)."""


class KordocClosed(KordocError):
    """닫힌(또는 닫히는 중인) 클라이언트에 요청함."""


class KordocParseFailed(KordocError):
    """``ParseResult.raise_for_error()`` — 문서를 파싱하지 못함."""

    def __init__(self, code: str | None, message: str) -> None:
        super().__init__(f"{code}: {message}" if code else message)
        self.code = code
        self.message = message
