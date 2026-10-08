"""KordocClient(동기)·AsyncKordocClient(비동기) — 상주 워커 풀, 대기 큐, 워밍업, 제한 시간·취소, 종료."""

from __future__ import annotations

import asyncio
import itertools
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Coroutine, TypeVar

from ._config import KordocConfig
from ._errors import KordocClosed, KordocError, KordocProtocolError, KordocQueueFull, KordocTimeout
from ._protocol import parse_request
from ._result import ParseResult, WarmupReport, WorkerWarmup
from ._worker import Worker

T = TypeVar("T")
_DEFAULT: Any = object()


class _Slot:
    """풀의 자리 하나. worker 가 None 이면 다음에 이 자리를 받는 요청이 새 워커를 띄운다(교체·시작 실패 뒤)."""

    __slots__ = ("worker",)

    def __init__(self, worker: Worker | None) -> None:
        self.worker = worker


class AsyncKordocClient:
    """asyncio 클라이언트. ``async with AsyncKordocClient() as client: await client.parse(path)``.

    워커는 ``start()``(또는 ``async with`` 진입)에서 띄우고 ``aclose()`` 까지 재사용한다. 요청마다 프로세스를 만들지 않는다.
    """

    def __init__(self, config: KordocConfig | None = None, **kwargs: Any) -> None:
        if config is not None and kwargs:
            raise TypeError("config 와 키워드 설정을 함께 줄 수 없습니다")
        self.config = config or KordocConfig(**kwargs)
        self._ids = itertools.count(1)
        self._slots: asyncio.Queue[_Slot | None] | None = None
        self._workers: set[Worker] = set()
        self._busy: set[Worker] = set()
        self._retiring: set[asyncio.Task[None]] = set()
        self._waiting = 0
        self._closed = False
        self._started = False
        self._warmup: tuple[str, dict[str, Any]] | None = None
        self._temp_root: str | None = None

    # ─── 수명 ───────────────────────────────────────────

    async def start(self) -> "AsyncKordocClient":
        if self._started:
            return self
        if self._closed:
            raise KordocClosed("닫힌 클라이언트입니다")
        self._slots = asyncio.Queue()
        workers = [Worker(self.config) for _ in range(self.config.max_workers)]
        results = await asyncio.gather(*(w.start() for w in workers), return_exceptions=True)
        failed = next((r for r in results if isinstance(r, BaseException)), None)
        if failed is not None:
            await asyncio.gather(*(w.kill() for w in workers), return_exceptions=True)
            raise failed
        for w in workers:
            self._workers.add(w)
            self._slots.put_nowait(_Slot(w))
        self._started = True
        return self

    async def __aenter__(self) -> "AsyncKordocClient":
        return await self.start()

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """새 요청을 막고, 대기 요청은 KordocClosed 로 끝내고, 진행 요청은 close_timeout 까지 기다린 뒤 워커를 종료·회수한다."""
        if self._closed:
            return
        self._closed = True
        if self._slots is not None:
            for _ in range(self._waiting):
                self._slots.put_nowait(None)  # 대기자 깨우기
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.close_timeout
        while any(w.alive for w in self._busy) and loop.time() < deadline:
            await asyncio.sleep(0.05)
        await asyncio.gather(*(w.quit(max(0.1, deadline - loop.time())) for w in list(self._workers)), return_exceptions=True)
        await asyncio.gather(*self._retiring, return_exceptions=True)
        self._workers.clear()
        if self._temp_root:
            await asyncio.to_thread(shutil.rmtree, self._temp_root, True)
            self._temp_root = None

    # ─── 정보 ───────────────────────────────────────────

    def worker_pids(self) -> list[int]:
        """살아 있는 소유 워커의 PID."""
        return sorted(w.pid for w in self._workers if w.alive and w.pid is not None)

    def worker_info(self) -> list[dict[str, Any]]:
        """워커별 pid·엔진 버전·마지막 rss·워밍업 결과. 풀 메모리는 rss 합으로 본다."""
        return [{"pid": w.pid, "version": w.version, "rss": w.last_rss, "warmup": w.warmup}
                for w in self._workers if w.alive]

    # ─── 파싱 ───────────────────────────────────────────

    async def parse(self, file: str | os.PathLike[str], *, timeout: float | None = _DEFAULT,
                    image_transport: str = "inline", assets_dir: str | os.PathLike[str] | None = None,
                    **options: Any) -> ParseResult:
        """문서 하나를 파싱한다. 옵션은 키워드 인자(``table_format="gfm"``, ``ocr=False`` …).

        image_transport: "inline"(기본, 결과 JSON 에 base64) 또는 "files"(assets_dir 아래 요청별 디렉터리에 파일로 — 큰 이미지 문서).
        엔진 옵션 ``images=False`` 는 이미지 바이트 추출 자체를 생략하며 전송 방식과 별개다.

        timeout 은 대기 큐 입장부터 결과 수신까지(초). 넘기면 KordocTimeout, 실행 중이었다면 담당 워커를 종료한다.
        Task 를 취소해도 같다 — 대기 중이면 그 요청만 빠지고, 실행 중이면 워커를 종료하고 다음 요청은 새 워커가 받는다.
        """
        msg = parse_request(next(self._ids), file, options, image_transport, assets_dir)
        limit = self.config.request_timeout if timeout is _DEFAULT else timeout
        try:
            async with asyncio.timeout(limit):
                resp = await self._run(msg)
        except TimeoutError:
            raise KordocTimeout(f"요청 제한 시간({limit}초)을 넘었습니다") from None
        assets = resp.get("assetsDir")
        return ParseResult(resp["result"], Path(assets) if assets else None)

    async def parse_bytes(self, data: bytes, *, suffix: str = "", **kwargs: Any) -> ParseResult:
        """바이트를 SDK 소유 임시 파일에 써서 파싱한다(NDJSON 에 다시 싣지 않는다). 끝나면 성공·실패·취소와 관계없이 지운다.
        원본 경로가 필요한 DRM 대체 경로는 파일 입력과 같게 동작하지 않을 수 있다."""
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError("data 는 bytes 여야 합니다")
        tmp = await asyncio.to_thread(self._write_temp, bytes(data), suffix)
        try:
            return await self.parse(tmp, **kwargs)
        finally:
            await asyncio.to_thread(shutil.rmtree, os.path.dirname(tmp), True)

    def _write_temp(self, data: bytes, suffix: str) -> str:
        if self._temp_root is None:
            self._temp_root = tempfile.mkdtemp(prefix="kordoc-sdk-", dir=self.config.temp_dir)
        d = tempfile.mkdtemp(dir=self._temp_root)
        path = os.path.join(d, "input" + suffix)
        with open(path, "xb") as f:
            f.write(data)
        return path

    async def warmup(self, file: str | os.PathLike[str], **options: Any) -> WarmupReport:
        """대표 문서를 모든 워커에서 실제로 파싱한다. 교체 워커도 요청을 받기 전에 같은 문서로 워밍업한다.
        워밍업은 처리 경로를 한 번 지나게 할 뿐 JIT 최적화 완료를 보장하지 않는다. 실패도 예외 대신 결과로 돌려준다."""
        path = os.path.abspath(os.fspath(file))
        parse_request(0, path, options)  # 옵션 검증만
        self._warmup = (path, dict(options))
        slots = [await self._acquire() for _ in range(self.config.max_workers)]
        try:
            for s in slots:
                await self._warm(s.worker)  # type: ignore[arg-type]
        finally:
            for s in slots:
                self._release(s)
        return WarmupReport([w.warmup for w in (s.worker for s in slots) if w is not None and w.warmup is not None])

    async def _warm(self, worker: Worker) -> None:
        assert self._warmup is not None
        path, options = self._warmup
        msg = parse_request(next(self._ids), path, options)
        try:
            resp = await asyncio.wait_for(worker.request(msg), self.config.warmup_timeout)
            r = resp["result"]
            worker.warmup = WorkerWarmup(worker.pid or 0, bool(r.get("success")), list(r.get("warnings") or []), r.get("error"))
        except KordocProtocolError as e:
            worker.warmup = WorkerWarmup(worker.pid or 0, False, [], str(e))
        except TimeoutError:
            worker.warmup = WorkerWarmup(worker.pid or 0, False, [], f"워밍업 제한 시간({self.config.warmup_timeout}초) 초과")
            await worker.kill()

    # ─── 풀 ─────────────────────────────────────────────

    async def _acquire(self) -> _Slot:
        if self._closed:
            raise KordocClosed("닫힌 클라이언트입니다")
        if not self._started:
            await self.start()
        assert self._slots is not None
        if self._slots.empty() and self._waiting >= self.config.max_queue:
            raise KordocQueueFull(f"대기 큐가 가득 찼습니다 (max_queue={self.config.max_queue})")
        self._waiting += 1
        try:
            slot = await self._slots.get()
        finally:
            self._waiting -= 1
        if slot is None or self._closed:
            if slot is not None:
                self._slots.put_nowait(slot)
            raise KordocClosed("클라이언트가 닫혔습니다")
        if slot.worker is None or not slot.worker.alive:
            try:
                slot.worker = await self._spawn()
            except BaseException:
                slot.worker = None
                self._slots.put_nowait(slot)  # 자리는 남겨 다음 요청이 다시 띄운다
                raise
        self._busy.add(slot.worker)
        return slot

    async def _spawn(self) -> Worker:
        w = Worker(self.config)
        await w.start()
        self._workers.add(w)
        if self._warmup is not None:
            await self._warm(w)
            if not w.alive:
                self._workers.discard(w)
                raise KordocError(f"교체 워커 워밍업 실패: {w.warmup.error if w.warmup else ''}")
        return w

    def _release(self, slot: _Slot) -> None:
        assert self._slots is not None
        w = slot.worker
        if w is not None:
            self._busy.discard(w)
        limit = self.config.max_worker_rss_bytes
        if w is not None and (self._closed or (limit is not None and (w.last_rss or 0) > limit)):
            # 작업 사이에서만 교체 — 다음 요청이 이 자리에서 새 워커를 띄운다
            self._workers.discard(w)
            slot.worker = None
            task = asyncio.ensure_future(w.quit(self.config.close_timeout))
            self._retiring.add(task)
            task.add_done_callback(self._retiring.discard)
        self._slots.put_nowait(slot)

    async def _discard(self, slot: _Slot) -> None:
        w = slot.worker
        slot.worker = None
        if w is not None:
            self._workers.discard(w)
            self._busy.discard(w)
            await asyncio.shield(w.kill())

    async def _run(self, msg: dict[str, Any]) -> dict[str, Any]:
        slot = await self._acquire()
        try:
            resp = await slot.worker.request(msg)  # type: ignore[union-attr]
        except KordocProtocolError:
            self._release(slot)  # 요청 거부 — 워커는 멀쩡하다
            raise
        except BaseException as e:
            # 취소·제한 시간·워커 장애: 늦게 올 응답이 다음 요청에 섞이지 않게 이 워커를 버린다. 자동 재시도하지 않는다
            await self._discard(slot)
            self._release(slot)
            if self._closed and not isinstance(e, asyncio.CancelledError):
                raise KordocClosed("클라이언트가 닫히며 진행 중 요청을 끝냈습니다") from e
            raise
        self._release(slot)
        return resp


class KordocClient:
    """동기 클라이언트. ``with KordocClient() as client: client.parse(path)``.

    내부에 전용 이벤트 루프 스레드 하나를 두고 AsyncKordocClient 를 돌린다(호출 스레드를 막지 않는 I/O).
    """

    def __init__(self, config: KordocConfig | None = None, **kwargs: Any) -> None:
        self._client = AsyncKordocClient(config, **kwargs)
        self.config = self._client.config
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "KordocClient":
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(target=self._loop.run_forever, name="kordoc-sdk", daemon=True)
            self._thread.start()
        try:
            self._call(self._client.start())
        except BaseException:
            self._stop_loop()
            raise
        return self

    def __enter__(self) -> "KordocClient":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _call(self, coro: Coroutine[Any, Any, T]) -> T:
        if self._loop is None:
            coro.close()
            raise KordocClosed("시작하지 않았거나 닫힌 클라이언트입니다")
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result()
        except BaseException:
            fut.cancel()  # Ctrl-C 등 — 실행 중이면 담당 워커를 종료한다
            raise

    def parse(self, file: str | os.PathLike[str], **kwargs: Any) -> ParseResult:
        return self._call(self._client.parse(file, **kwargs))

    def parse_bytes(self, data: bytes, **kwargs: Any) -> ParseResult:
        return self._call(self._client.parse_bytes(data, **kwargs))

    def warmup(self, file: str | os.PathLike[str], **options: Any) -> WarmupReport:
        return self._call(self._client.warmup(file, **options))

    def worker_pids(self) -> list[int]:
        return self._client.worker_pids()

    def worker_info(self) -> list[dict[str, Any]]:
        return self._client.worker_info()

    def close(self) -> None:
        if self._loop is None:
            return
        try:
            self._call(self._client.aclose())
        finally:
            self._stop_loop()

    def _stop_loop(self) -> None:
        loop, thread = self._loop, self._thread
        self._loop = self._thread = None
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
            if thread is not None:
                thread.join()
            loop.close()
