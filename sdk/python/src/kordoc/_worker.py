"""상주 워커 프로세스 하나 — asyncio subprocess 로 띄우고 한 번에 요청 하나만 보낸다."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ._config import REQUIRED_CAPABILITIES, KordocConfig
from ._errors import KordocIncompatibleEngine, KordocProtocolError, KordocStartError, KordocWorkerCrashed
from ._protocol import PROTOCOL
from ._result import WorkerWarmup


class Worker:
    def __init__(self, config: KordocConfig) -> None:
        self._config = config
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_tail = bytearray()
        self.version: str | None = None
        self.capabilities: tuple[str, ...] = ()
        self.last_rss: int | None = None
        self.warmup: WorkerWarmup | None = None

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc else None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def stderr_tail(self) -> str:
        return self._stderr_tail.decode("utf-8", "replace")

    async def start(self) -> None:
        cmd = self._config.command()
        try:
            # 응답 한 줄이 크다(이미지 base64 포함) — readline 상한을 워커 응답 상한에 맞춘다
            self._proc = await asyncio.create_subprocess_exec(
                *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=self._config.environment(), limit=self._config.max_response_bytes + 64 * 1024)
        except OSError as e:
            raise KordocStartError(f"워커를 띄우지 못했습니다: {cmd[0]} {cmd[1]} — {e}") from e
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        try:
            await self._handshake()
        except BaseException:
            # 취소돼도 띄운 프로세스를 남기지 않는다
            await asyncio.shield(self.kill())
            raise

    async def _handshake(self) -> None:
        assert self._proc is not None
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), self._config.start_timeout)  # type: ignore[union-attr]
        except TimeoutError:
            await self.kill()
            raise KordocStartError(f"워커가 {self._config.start_timeout}초 안에 ready 를 보내지 않았습니다\n{self.stderr_tail()}") from None
        except (ValueError, asyncio.LimitOverrunError) as e:
            await self.kill()
            raise KordocStartError(f"워커 ready 줄을 읽지 못했습니다: {e}") from e
        if not line:
            await self.kill()
            raise KordocStartError(f"워커가 ready 전에 끝났습니다 (code {self._proc.returncode})\n{self.stderr_tail()}")
        try:
            ready = json.loads(line)
        except json.JSONDecodeError:
            await self.kill()
            raise KordocIncompatibleEngine(f"ready 줄이 JSON 이 아닙니다: {line[:200]!r}") from None
        if not isinstance(ready, dict) or ready.get("ready") is not True or ready.get("protocol") != PROTOCOL:
            await self.kill()
            raise KordocIncompatibleEngine(f"parse-worker protocol {PROTOCOL} 를 지원하지 않는 엔진입니다: {ready!r}")
        caps = tuple(ready.get("capabilities") or ())
        missing = [c for c in REQUIRED_CAPABILITIES if c not in caps]
        if missing:
            await self.kill()
            raise KordocIncompatibleEngine(f"엔진에 필요한 기능이 없습니다: {missing} (version {ready.get('version')})")
        self.version = ready.get("version")
        self.capabilities = caps

    async def _drain_stderr(self) -> None:
        """stderr 를 계속 비운다(안 비우면 워커가 쓰다 막힌다). 끝부분만 진단용으로 남긴다."""
        assert self._proc and self._proc.stderr
        limit = self._config.stderr_tail_bytes
        while True:
            chunk = await self._proc.stderr.read(64 * 1024)
            if not chunk:
                return
            self._stderr_tail += chunk
            if len(self._stderr_tail) > limit:
                del self._stderr_tail[: len(self._stderr_tail) - limit]

    async def request(self, msg: dict[str, Any], line: bytes) -> dict[str, Any]:
        """요청 하나(line — protocol.encode_request 로 미리 만든 줄)를 보내고 같은 id 의 응답을 돌려준다.
        워커가 거부하면 KordocProtocolError(워커는 멀쩡하다). 워커가 끝났거나 응답이 깨졌으면 KordocWorkerCrashed — 이 워커는 더 쓰지 않는다."""
        proc = self._proc
        if proc is None or proc.returncode is not None:
            raise KordocWorkerCrashed("워커가 실행 중이 아닙니다", self.stderr_tail())
        assert proc.stdin and proc.stdout
        try:
            proc.stdin.write(line)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as e:
            raise KordocWorkerCrashed(f"워커에 요청을 쓰지 못했습니다: {e}", self.stderr_tail()) from e
        try:
            line = await proc.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError) as e:
            raise KordocWorkerCrashed(f"응답이 SDK 상한({self._config.max_response_bytes}바이트)을 넘습니다", self.stderr_tail()) from e
        if not line.endswith(b"\n"):
            await self._reap()
            what = "응답이 중간에 끊겼습니다" if line else "응답 전에 워커가 끝났습니다"
            raise KordocWorkerCrashed(f"{what} (code {proc.returncode})", self.stderr_tail())
        try:
            resp = json.loads(line)
        except json.JSONDecodeError:
            raise KordocWorkerCrashed(f"응답이 JSON 이 아닙니다: {line[:200]!r}", self.stderr_tail()) from None
        if not isinstance(resp, dict):
            raise KordocWorkerCrashed(f"응답이 객체가 아닙니다: {line[:200]!r}", self.stderr_tail())
        if resp.get("id") != msg["id"]:
            raise KordocWorkerCrashed(f"응답 id 가 요청과 다릅니다 (요청 {msg['id']}, 응답 {resp.get('id')})", self.stderr_tail())
        if isinstance(resp.get("rss"), int):
            self.last_rss = resp["rss"]
        err = resp.get("error")
        if err is not None:
            raise KordocProtocolError(str(err.get("code", "UNKNOWN")), str(err.get("message", "")))
        if not isinstance(resp.get("result"), dict):
            raise KordocWorkerCrashed("응답에 result 가 없습니다", self.stderr_tail())
        return resp

    async def _reap(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                await asyncio.wait_for(self._proc.wait(), 1.0)
            except TimeoutError:
                pass

    async def kill(self) -> None:
        """즉시 종료하고 회수한다."""
        proc = self._proc
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
        await self._finish_stderr()

    async def quit(self, timeout: float) -> None:
        """quit 를 보내고 끝나기를 기다린다. 제한 시간을 넘기면 강제 종료."""
        proc = self._proc
        if proc is not None and proc.returncode is None and proc.stdin:
            try:
                proc.stdin.write(b'{"cmd":"quit"}\n')
                await proc.stdin.drain()
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout)
            except TimeoutError:
                pass
        await self.kill()

    async def _finish_stderr(self) -> None:
        if self._stderr_task is not None:
            try:
                await asyncio.wait_for(self._stderr_task, 1.0)
            except (TimeoutError, asyncio.CancelledError):
                self._stderr_task.cancel()
            self._stderr_task = None
