"""파싱 결과 — 엔진의 ParseResult JSON 을 그대로 보존하고 자주 쓰는 필드만 타입으로 꺼낸다."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ._errors import KordocParseFailed


class Image:
    """결과 이미지. 바이트는 ``read()`` 를 부를 때만 해독(inline)하거나 파일에서 읽는다(files)."""

    __slots__ = ("filename", "mime_type", "source", "path", "byte_length", "_b64")

    def __init__(self, raw: Mapping[str, Any], assets_dir: Path | None) -> None:
        self.filename: str | None = raw.get("filename")
        self.mime_type: str | None = raw.get("mimeType")
        self.source: str | None = raw.get("source")
        ref = raw.get("dataRef")
        self._b64: str | None = raw.get("data") if isinstance(raw.get("data"), str) else None
        if ref is not None and assets_dir is not None:
            self.path: Path | None = assets_dir / ref["path"]
            self.byte_length: int | None = int(ref["byteLength"])
        else:
            self.path = None
            self.byte_length = None

    def read(self) -> bytes:
        """이미지 바이트. files 전송이면 파일을 읽는다."""
        if self.path is not None:
            return self.path.read_bytes()
        if self._b64 is not None:
            return base64.b64decode(self._b64)
        raise ValueError("이미지 바이트가 결과에 없습니다 (options images=False)")

    def __repr__(self) -> str:
        where = f"path={str(self.path)!r}" if self.path else "inline"
        return f"Image(filename={self.filename!r}, mime_type={self.mime_type!r}, {where})"


@dataclass(frozen=True)
class ParseResult:
    """엔진 ``parse()`` 결과. ``raw`` 는 워커가 보낸 JSON 원본(알 수 없는 필드 포함)이다."""

    raw: dict[str, Any]
    assets_dir: Path | None = None

    @property
    def success(self) -> bool:
        return bool(self.raw.get("success"))

    @property
    def file_type(self) -> str:
        return str(self.raw.get("fileType", "unknown"))

    @property
    def markdown(self) -> str:
        return self.raw.get("markdown", "")

    @property
    def blocks(self) -> list[dict[str, Any]]:
        return self.raw.get("blocks", [])

    @property
    def pages(self) -> list[dict[str, Any]] | None:
        return self.raw.get("pages")

    @property
    def metadata(self) -> dict[str, Any] | None:
        return self.raw.get("metadata")

    @property
    def warnings(self) -> list[dict[str, Any]]:
        return self.raw.get("warnings") or []

    @property
    def error(self) -> str | None:
        return self.raw.get("error")

    @property
    def code(self) -> str | None:
        return self.raw.get("code")

    @property
    def images(self) -> list[Image]:
        return [Image(i, self.assets_dir) for i in self.raw.get("images") or []]

    def raise_for_error(self) -> "ParseResult":
        """파싱 실패면 ``KordocParseFailed`` — 성공이면 자기 자신."""
        if not self.success:
            raise KordocParseFailed(self.code, self.error or "파싱 실패")
        return self


@dataclass(frozen=True)
class WorkerWarmup:
    """워커 하나의 워밍업 결과. ``warnings`` 는 엔진 경고 그대로(예: OCR 을 건너뛴 경고는 OCR 준비 완료가 아니다)."""

    pid: int
    success: bool
    warnings: list[dict[str, Any]]
    error: str | None = None


@dataclass(frozen=True)
class WarmupReport:
    workers: list[WorkerWarmup]

    @property
    def ok(self) -> bool:
        """모든 워커에서 워밍업 문서를 파싱했는가 (경고 유무와 별개)."""
        return all(w.success for w in self.workers)
