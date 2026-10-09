"""KordocClient(동기)·AsyncKordocClient(비동기) — 상주 워커 풀, 대기 큐, 워밍업, 제한 시간·취소, 종료."""

from __future__ import annotations

import asyncio
import concurrent.futures
import itertools
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Coroutine, TypeVar

from ._config import KordocConfig
from ._errors import KordocClosed, KordocError, KordocProtocolError, KordocQueueFull, KordocTimeout
from ._protocol import encode_request, parse_request
from ._result import ParseResult, WarmupReport, WorkerWarmup
from ._worker import Worker

T = TypeVar("T")
_DEFAULT: Any = object()


class _Slot:
    """풀의 자리 하나. worker 가 None 이면 다음에 이 자리를 받는 요청이 새 워커를 띄운다(교체·시작 실패 뒤).
    starting 은 띄우는 중인 교체 워커, want 는 지금 받는 요청이 바라는 워밍업 문서(None 이면 등록된 문서),
    warmed 는 교체 워커가 요청을 받기 전에 치른 워밍업 (문서, 결과)."""

    __slots__ = ("worker", "starting", "want", "warmed")

    def __init__(self, worker: Worker | None) -> None:
        self.worker = worker
        self.starting: asyncio.Task[Worker] | None = None
        self.want: tuple[str, dict[str, Any]] | None = None
        self.warmed: tuple[tuple[str, dict[str, Any]], WorkerWarmup | None] | None = None


def _consume(task: asyncio.Future[Any]) -> None:
    # 아무도 기다리지 않은 채 끝난 작업의 예외를 "never retrieved" 경고로 남기지 않는다 (기다린 쪽은 그대로 받는다)
    if not task.cancelled():
        task.exception()


def _task(coro: Coroutine[Any, Any, T], into: set[asyncio.Task[Any]] | None = None) -> asyncio.Task[T]:
    task = asyncio.ensure_future(coro)
    task.add_done_callback(_consume)
    if into is not None:
        into.add(task)
        task.add_done_callback(into.discard)
    return task


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
        self._retiring: set[asyncio.Task[None]] = set()  # 워커를 끝내는 작업(quit·kill) — aclose 가 모두 기다린다
        self._spawning: set[asyncio.Task[Worker]] = set()  # 자리마다 띄우는 중인 교체 워커
        self._temp_jobs: set[asyncio.Task[Any]] = set()  # parse_bytes 임시 파일 쓰기·지우기(스레드)
        self._waiting = 0
        self._closed = False
        self._started = False
        self._start_task: asyncio.Task[None] | None = None
        self._start_waiters = 0
        self._close_task: asyncio.Task[None] | None = None
        self._warmup: tuple[str, dict[str, Any]] | None = None
        self._warmup_lock = asyncio.Lock()
        self._temp_root: str | None = None
        self._temp_lock = threading.Lock()

    # ─── 수명 ───────────────────────────────────────────

    async def start(self) -> "AsyncKordocClient":
        await self._ensure_started(owner=True)
        return self

    async def _ensure_started(self, owner: bool) -> None:
        """시작은 한 번만 — 겹친 start()·지연 시작(첫 요청)은 같은 시작 작업을 기다린다 (max_workers 를 넘겨 띄우지 않게)."""
        while True:
            if self._closed:
                raise KordocClosed("닫힌 클라이언트입니다")
            if self._started:
                return
            task = self._start_task
            if task is None or task.done():
                task = self._start_task = _task(self._start())
            self._start_waiters += 1
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                # 명시 start() 를 기다리던 마지막 호출자가 취소되면 시작도 멈춘다 — 띄우던 워커를 남기지 않는다.
                # 지연 시작(요청의 제한 시간·취소)은 시작을 이어 가 다음 요청이 받는다
                if owner and self._start_waiters == 1:
                    task.cancel()
                me = asyncio.current_task()
                if task.cancelled() and me is not None and not me.cancelling():
                    # 이 호출은 취소되지 않았다 — 앞서 취소된 시작이 워커를 끝내고 멈췄을 뿐이니 넘겨받지 않고 새로 시작한다
                    # (그 작업이 띄운 워커를 다 끝낸 뒤라 max_workers 를 넘겨 띄우지 않는다)
                    continue
                raise
            finally:
                self._start_waiters -= 1
                if task.done() and self._start_task is task and not self._started:
                    self._start_task = None  # 실패 — 다음 호출이 다시 시도한다

    async def _start(self) -> None:
        workers = [Worker(self.config) for _ in range(self.config.max_workers)]
        try:
            results = await asyncio.gather(*(w.start() for w in workers), return_exceptions=True)
            failed = next((r for r in results if isinstance(r, BaseException)), None)
            if failed is not None:
                raise failed
            if self._closed:
                raise KordocClosed("시작하는 동안 클라이언트가 닫혔습니다")
        except BaseException as e:
            await asyncio.shield(asyncio.gather(*(w.kill() for w in workers), return_exceptions=True))
            if isinstance(e, asyncio.CancelledError) and self._closed:
                raise KordocClosed("시작하는 동안 클라이언트가 닫혔습니다") from None
            raise
        self._slots = asyncio.Queue()
        for w in workers:
            self._workers.add(w)
            self._slots.put_nowait(_Slot(w))
        self._started = True

    async def __aenter__(self) -> "AsyncKordocClient":
        return await self.start()

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """새 요청을 막고, 대기 요청은 KordocClosed 로 끝내고, 띄우는 중인 워커는 끊고, 진행 요청은 close_timeout 까지 기다린 뒤
        워커를 종료·회수한다. 닫기는 한 번만 돈다 — 겹쳐 부르거나 취소된 뒤 다시 부르면 그 닫기가 끝날 때까지 기다린다."""
        if self._close_task is None:
            self._closed = True
            self._close_task = _task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        try:
            if self._slots is not None:
                for _ in range(self._waiting):
                    self._slots.put_nowait(None)  # 대기자 깨우기
            # 시작·교체 워커 띄우기는 끊는다 — 그것을 기다리던 요청은 KordocClosed 로 끝나고 띄우던 워커는 남지 않는다
            pending: list[asyncio.Task[Any]] = [t for t in (self._start_task, *self._spawning)
                                                if t is not None and not t.done()]
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.config.close_timeout
            while any(w.alive for w in self._busy) and loop.time() < deadline:
                await asyncio.sleep(0.05)
            await asyncio.gather(*(w.quit(max(0.1, deadline - loop.time())) for w in list(self._workers)),
                                 return_exceptions=True)
            for jobs in (self._retiring, self._temp_jobs):
                while jobs:
                    await asyncio.gather(*list(jobs), return_exceptions=True)
            self._workers.clear()
            await asyncio.to_thread(self._remove_temp_root)
        except BaseException:
            # 닫기 자체가 끊겼다(루프 종료·Ctrl-C) — 진행 요청을 더 기다리지 않고 워커를 바로 끝낸다
            await asyncio.shield(asyncio.gather(*(w.kill() for w in list(self._workers)), return_exceptions=True))
            raise

    def _remove_temp_root(self) -> None:
        # 루트를 만드는 잠금 아래에서 — 닫힌 뒤에는 _write_temp 가 새 루트를 만들지 않는다
        with self._temp_lock:
            root, self._temp_root = self._temp_root, None
            if root:
                shutil.rmtree(root, True)

    # ─── 정보 ───────────────────────────────────────────

    def worker_pids(self) -> list[int]:
        """살아 있는 소유 워커의 PID."""
        return sorted(w.pid for w in list(self._workers) if w.alive and w.pid is not None)

    def worker_info(self) -> list[dict[str, Any]]:
        """워커별 pid·엔진 버전·마지막 rss·워밍업 결과. 풀 메모리는 rss 합으로 본다."""
        return [{"pid": w.pid, "version": w.version, "rss": w.last_rss, "warmup": w.warmup}
                for w in list(self._workers) if w.alive]

    # ─── 파싱 ───────────────────────────────────────────

    async def parse(self, file: str | os.PathLike[str], *, timeout: float | None = _DEFAULT,
                    image_transport: str = "inline", assets_dir: str | os.PathLike[str] | None = None,
                    **options: Any) -> ParseResult:
        """문서 하나를 파싱한다. 옵션은 키워드 인자(``table_format="gfm"``, ``ocr=False`` …).

        image_transport: "inline"(기본, 결과 JSON 에 base64) 또는 "files"(assets_dir 아래 요청별 디렉터리에 파일로 — 큰 이미지 문서).
        엔진 옵션 ``images=False`` 는 이미지 바이트 추출 자체를 생략하며 전송 방식과 별개다.

        timeout 은 대기 큐 입장부터 결과 수신까지(초) — 빈 자리에서 교체 워커를 띄우고 워밍업하는 시간도 들어간다. 넘기면 KordocTimeout,
        실행 중이었다면 담당 워커를 종료한다. 교체 워커 시작·워밍업 중이었다면 그것은 끊지 않고 이어 가 다음 요청이 그 워커를 받는다.
        Task 를 취소해도 같다 — 대기 중이면 그 요청만 빠지고, 실행 중이면 워커를 종료하고 다음 요청은 새 워커가 받는다.
        """
        msg = parse_request(next(self._ids), file, options, image_transport, assets_dir)
        line = encode_request(msg, self.config.max_request_bytes)
        limit = self.config.request_timeout if timeout is _DEFAULT else timeout
        try:
            async with asyncio.timeout(limit):
                resp = await self._run(msg, line)
        except TimeoutError:
            raise KordocTimeout(f"요청 제한 시간({limit}초)을 넘었습니다") from None
        assets = resp.get("assetsDir")
        return ParseResult(resp["result"], Path(assets) if assets else None)

    async def parse_bytes(self, data: bytes, *, suffix: str = "", **kwargs: Any) -> ParseResult:
        """바이트를 SDK 소유 임시 파일에 써서 파싱한다(NDJSON 에 다시 싣지 않는다). 끝나면 성공·실패·취소와 관계없이 지운다.
        원본 경로가 필요한 DRM 대체 경로는 파일 입력과 같게 동작하지 않을 수 있다."""
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError("data 는 bytes 여야 합니다")
        if self._closed:
            raise KordocClosed("닫힌 클라이언트입니다")  # 닫힌 뒤 새 임시 루트를 만들어 남기지 않게
        write = _task(asyncio.to_thread(self._write_temp, bytes(data), suffix), self._temp_jobs)
        try:
            tmp = await asyncio.shield(write)
        except BaseException:
            # 쓰는 중에 취소 — 스레드는 멈출 수 없으니 쓰기가 끝나면 그 사본을 지운다 (aclose 는 이 작업까지 기다린다)
            write.add_done_callback(self._drop_late)
            raise
        try:
            return await self.parse(tmp, **kwargs)
        finally:
            await asyncio.to_thread(shutil.rmtree, os.path.dirname(tmp), True)

    def _drop_late(self, write: asyncio.Task[str]) -> None:
        if not write.cancelled() and write.exception() is None:
            _task(asyncio.to_thread(shutil.rmtree, os.path.dirname(write.result()), True), self._temp_jobs)

    def _write_temp(self, data: bytes, suffix: str) -> str:
        # 스레드에서 돈다. 루트는 잠금 안에서 한 번만 만들고(처음 parse_bytes 둘이 동시에 만들면 하나가 샌다), 닫힌 뒤에는
        # 만들지 않는다(aclose 가 루트를 지운 뒤 executor 에서 기다리던 쓰기가 새 루트를 남기지 않게)
        with self._temp_lock:
            if self._closed:
                raise KordocClosed("닫힌 클라이언트입니다")
            if self._temp_root is None:
                self._temp_root = tempfile.mkdtemp(prefix="kordoc-sdk-", dir=self.config.temp_dir)
            d = tempfile.mkdtemp(dir=self._temp_root)
        path = os.path.join(d, "input" + suffix)
        try:
            with open(path, "xb") as f:
                f.write(data)
        except BaseException:
            shutil.rmtree(d, True)
            raise
        return path

    async def warmup(self, file: str | os.PathLike[str], **options: Any) -> WarmupReport:
        """대표 문서를 모든 워커에서 실제로 파싱한다. 한 워커에서라도 성공하면 교체 워커도 요청을 받기 전에 같은 문서로 워밍업한다.
        워밍업은 처리 경로를 한 번 지나게 할 뿐 JIT 최적화 완료를 보장하지 않는다. 실패도 예외 대신 결과로 돌려준다."""
        path = os.path.abspath(os.fspath(file))
        spec = (path, dict(options))
        encode_request(parse_request(0, path, options), self.config.max_request_bytes)  # 옵션·크기 검증만
        # 시작한 뒤에 잠근다 — 실패한 시작을 기다리며 경합한 잠금은 그 루프에 묶여, 새 루프에서 다시 시작하면 쓸 수 없다
        await self._ensure_started(owner=False)
        # warmup 끼리는 차례로 — 둘이 자리를 나눠 쥐고 서로 나머지를 기다리며 멈추지 않게
        async with self._warmup_lock:
            # 자리를 하나씩 받으며 try 안에서 — 두 번째 자리를 기다리다 취소·QueueFull 이 나도 받은 자리를 돌려준다
            slots: list[_Slot] = []
            try:
                for _ in range(self.config.max_workers):
                    slots.append(await self._acquire(spec))  # 빈 자리는 이 문서로 워밍업하며 띄운다
                reports: list[WorkerWarmup | None] = []
                for s in slots:
                    if s.warmed is not None and s.warmed[0] == spec:
                        reports.append(s.warmed[1])  # 교체 워커가 요청을 받기 전에 이미 이 문서로 워밍업했다 — 한 번만
                    else:
                        await self._warm(s.worker, spec)  # type: ignore[arg-type]
                        reports.append(s.worker.warmup)  # type: ignore[union-attr]
                warms = [r for r in reports if r is not None]
                # 교체 워커는 한 곳이라도 성공한 문서만 되풀이한다 — 워커를 죽이는 문서로 이후 요청을 모두 막지 않게
                self._warmup = spec if any(w.success for w in warms) else None
            finally:
                for s in slots:
                    self._release(s)
        return WarmupReport(warms)

    async def _warm(self, worker: Worker, spec: tuple[str, dict[str, Any]]) -> None:
        path, options = spec
        msg = parse_request(next(self._ids), path, options)
        line = encode_request(msg, self.config.max_request_bytes)
        try:
            resp = await asyncio.wait_for(worker.request(msg, line), self.config.warmup_timeout)
            r = resp["result"]
            worker.warmup = WorkerWarmup(worker.pid or 0, bool(r.get("success")), list(r.get("warnings") or []), r.get("error"))
        except KordocProtocolError as e:
            worker.warmup = WorkerWarmup(worker.pid or 0, False, [], str(e))
        except TimeoutError:
            worker.warmup = WorkerWarmup(worker.pid or 0, False, [], f"워밍업 제한 시간({self.config.warmup_timeout}초) 초과")
            await worker.kill()
        except KordocError as e:
            # 워커 장애도 결과로 (문서·Java 와 같은 계약) — 이 워커는 더 쓰지 않는다
            worker.warmup = WorkerWarmup(worker.pid or 0, False, [], str(e))
            await asyncio.shield(worker.kill())
        except BaseException:
            # 취소 — 워밍업 요청이 걸린 워커를 반납하면 늦게 온 응답을 다음 요청이 읽는다
            await asyncio.shield(worker.kill())
            raise

    # ─── 풀 ─────────────────────────────────────────────

    async def _acquire(self, spec: tuple[str, dict[str, Any]] | None = None) -> _Slot:
        """자리 하나를 받는다. 빈 자리면 교체 워커를 붙이고, 그 워커는 spec(None 이면 등록된 워밍업 문서)으로 워밍업한 뒤 넘긴다."""
        if self._closed:
            raise KordocClosed("닫힌 클라이언트입니다")
        await self._ensure_started(owner=False)
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
                await self._replace(slot, spec)
            except BaseException:
                self._slots.put_nowait(slot)  # 자리는 남겨 다음 요청이 이어 받는다(띄우는 중이면 그 워커를, 실패했으면 다시 띄운다)
                raise
        self._busy.add(slot.worker)  # type: ignore[arg-type]
        return slot

    async def _replace(self, slot: _Slot, spec: tuple[str, dict[str, Any]] | None) -> None:
        """빈 자리에 교체 워커를 붙인다. 띄우기는 자리에 붙은 별도 작업이라, 기다리던 요청이 제한 시간·취소로 빠져도 끊기지 않는다
        (끊으면 시작·워밍업보다 짧은 제한 시간에서 교체가 영원히 끝나지 않는다). 끊는 것은 aclose 뿐이다."""
        if slot.worker is not None:
            self._workers.discard(slot.worker)  # 죽은 워커 객체를 쌓아 두지 않는다
            slot.worker = None
        slot.want = spec  # 띄우는 중인 작업도 워커를 띄운 뒤 이 문서를 읽는다
        while True:
            if self._closed:
                # 닫기는 시작할 때 띄우는 중인 작업만 끊는다 — 그 뒤에 깨어난 이 요청이 새 작업을 만들면 닫기가 모르는 워커가 남는다
                raise KordocClosed("클라이언트가 닫혔습니다")
            task = slot.starting
            if task is not None and task.done() and (task.cancelled() or task.exception() is not None or not task.result().alive):
                # 아무도 기다리지 않는 동안 실패했거나, 띄운 뒤 쉬는 사이 끝난 교체 — 다시 띄운다
                if not task.cancelled() and task.exception() is None:
                    self._workers.discard(task.result())
                task = None
            if task is None:
                slot.warmed = None
                task = slot.starting = _task(self._spawn(slot), self._spawning)
            elif task.done():
                want = self._want(slot)
                if want is None or (slot.warmed is not None and slot.warmed[0] == want):
                    break
                # 다른 요청이 바라는 문서로 띄운(워밍업한) 워커가 지금 받는 요청이 바라는 문서로 워밍업하지 않았다 — 마저 워밍업한다
                task = slot.starting = _task(self._spawn(slot, task.result()), self._spawning)
            # 이 요청이 제한 시간·취소로 빠져도 작업은 이어 가고, 끝난 작업은 자리에 남아 다음 요청이 그 워커를 받는다
            await asyncio.shield(task)
        slot.starting = None
        slot.worker = task.result()

    def _want(self, slot: _Slot) -> tuple[str, dict[str, Any]] | None:
        return slot.want if slot.want is not None else self._warmup

    async def _spawn(self, slot: _Slot, w: Worker | None = None) -> Worker:
        try:
            if w is None:
                w = await self._start_worker()
            spec = self._want(slot)  # 띄운 뒤에 읽는다 — 그사이 자리를 이어 받은 요청이 바라는 문서를 따른다
            if spec is not None:
                await self._warm(w, spec)
                report = w.warmup
                if not w.alive:
                    # 워밍업이 워커를 끝냈다(장애·제한 시간) — 요청은 막지 않고 워밍업 없는 새 워커가 받는다
                    self._workers.discard(w)
                    w = await self._start_worker()
                slot.warmed = (spec, report)  # 실패했어도 같은 문서로 되풀이하지 않는다
            return w
        except BaseException as e:
            # 워밍업 중 취소·실패 — 어느 자리에도 붙지 않은 워커를 남기지 않는다 (종전: max_workers=1 에서 0→1→2→3→4)
            if w is not None:
                self._workers.discard(w)
                await asyncio.shield(w.kill())
            if isinstance(e, asyncio.CancelledError) and self._closed:
                raise KordocClosed("클라이언트가 닫혔습니다") from None
            raise

    async def _start_worker(self) -> Worker:
        w = Worker(self.config)
        await w.start()  # 실패·취소되면 Worker.start 가 띄운 프로세스를 정리한다
        self._workers.add(w)
        return w

    def _release(self, slot: _Slot) -> None:
        assert self._slots is not None
        w = slot.worker
        slot.warmed = None  # 요청을 받았다 — 다음 warmup() 은 이 워커를 다시 워밍업한다
        if w is not None:
            self._busy.discard(w)
        limit = self.config.max_worker_rss_bytes
        if w is not None and (self._closed or (limit is not None and (w.last_rss or 0) > limit)):
            # 작업 사이에서만 교체 — 다음 요청이 이 자리에서 새 워커를 띄운다
            self._workers.discard(w)
            slot.worker = None
            _task(w.quit(self.config.close_timeout), self._retiring)
        self._slots.put_nowait(slot)

    async def _discard(self, slot: _Slot) -> None:
        w = slot.worker
        slot.worker = None
        if w is not None:
            self._workers.discard(w)
            self._busy.discard(w)
            await asyncio.shield(_task(w.kill(), self._retiring))

    async def _run(self, msg: dict[str, Any], line: bytes) -> dict[str, Any]:
        slot = await self._acquire()
        try:
            resp = await slot.worker.request(msg, line)  # type: ignore[union-attr]
        except KordocProtocolError:
            self._release(slot)  # 요청 거부 — 워커는 멀쩡하다
            raise
        except BaseException as e:
            # 취소·제한 시간·워커 장애: 늦게 올 응답이 다음 요청에 섞이지 않게 이 워커를 버린다. 자동 재시도하지 않는다
            try:
                await self._discard(slot)
            finally:
                self._release(slot)  # 버리는 동안 다시 취소돼도 자리는 돌려준다
            if self._closed and not isinstance(e, asyncio.CancelledError):
                raise KordocClosed("클라이언트가 닫히며 진행 중 요청을 끝냈습니다") from e
            raise
        self._release(slot)
        return resp


async def _on_loop(fn: Any) -> Any:
    return fn()


def _ours(task: asyncio.Task[Any]) -> bool:
    # 이 패키지의 코루틴으로 만든 작업인가. asyncio 의 작업은 직접 끊지 않는다 — Python 3.12 까지는 프로세스 파이프를 잇던 작업이
    # 취소되면 transport 가 끝나지 않아 워커 시작이 영원히 멈추고, to_thread 로 쓰던 임시 파일은 스레드가 끝나야 지울 수 있다
    frame = getattr(task.get_coro(), "cr_frame", None)
    return frame is not None and frame.f_globals.get("__package__") == __package__


class KordocClient:
    """동기 클라이언트. ``with KordocClient() as client: client.parse(path)``.

    내부에 전용 이벤트 루프 스레드 하나를 두고 AsyncKordocClient 를 돌린다(호출 스레드를 막지 않는 I/O).
    여러 스레드에서 함께 불러도 된다.
    """

    def __init__(self, config: KordocConfig | None = None, **kwargs: Any) -> None:
        self._client = AsyncKordocClient(config, **kwargs)
        self.config = self._client.config
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()  # 루프 참조 — 만들기·넘겨주기·떼어 내기
        self._lifecycle = threading.RLock()  # 닫기·루프 멈추기는 한 번에 하나 — 겹친 close 는 앞선 정리가 끝날 때까지 기다린다

    def start(self) -> "KordocClient":
        with self._lock:  # 두 스레드가 동시에 start 해도 루프 스레드는 하나
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
        with self._lock:  # 루프를 떼어 낸 뒤에는 넘기지 않는다 — 멈춘 루프에 남아 영원히 끝나지 않는 요청이 없게
            loop = self._loop
            if loop is None:
                coro.close()
                raise KordocClosed("시작하지 않았거나 닫힌 클라이언트입니다")
            fut = asyncio.run_coroutine_threadsafe(coro, loop)
        try:
            return fut.result()
        except concurrent.futures.CancelledError:
            # 닫으며 루프를 멈출 때 남은 작업을 끝냈다(close 가 끊긴 경우 등) — 호출자에게는 닫힌 클라이언트다
            raise KordocClosed("클라이언트가 닫혔습니다") from None
        except BaseException:
            fut.cancel()  # Ctrl-C 등 — 실행 중이면 담당 워커를 종료한다
            raise

    def parse(self, file: str | os.PathLike[str], **kwargs: Any) -> ParseResult:
        return self._call(self._client.parse(file, **kwargs))

    def parse_bytes(self, data: bytes, **kwargs: Any) -> ParseResult:
        return self._call(self._client.parse_bytes(data, **kwargs))

    def warmup(self, file: str | os.PathLike[str], **options: Any) -> WarmupReport:
        return self._call(self._client.warmup(file, **options))

    # 워커 집합은 루프 스레드가 바꾼다 — 그 스레드에서 읽는다
    def worker_pids(self) -> list[int]:
        return self._read(self._client.worker_pids)

    def worker_info(self) -> list[dict[str, Any]]:
        return self._read(self._client.worker_info)

    def _read(self, fn: Any) -> Any:
        try:
            return self._call(_on_loop(fn))
        except KordocClosed:
            return []

    def close(self) -> None:
        with self._lifecycle:
            if self._loop is None:
                return
            try:
                self._call(self._client.aclose())
            finally:
                self._stop_loop()

    def _stop_loop(self) -> None:
        with self._lifecycle:
            with self._lock:
                loop, thread = self._loop, self._thread
                self._loop = self._thread = None
            if loop is None:
                return
            try:
                asyncio.run_coroutine_threadsafe(self._shutdown(), loop).result()
            finally:
                loop.call_soon_threadsafe(loop.stop)
                if thread is not None:
                    thread.join()
                loop.close()

    async def _shutdown(self) -> None:
        """루프를 멈추기 전에 남은 작업을 모두 끝낸다 — 멈춘 루프에 걸린 작업은 영원히 끝나지 않아, 그 결과를 기다리던 다른 스레드가
        멈추고 워커가 남는다. 끊긴 close·start 는 취소돼 워커를 끝내고, 그 작업을 기다리던 호출자는 KordocClosed 를 받는다."""
        me = asyncio.current_task()
        # 한 번 양보한다 — 막 만들어져 한 번도 돌지 않은 작업(루프가 꺼내기 전에 끊긴 close 의 닫기 등)은 취소되면 정리 없이 끝난다
        await asyncio.sleep(0)
        for t in asyncio.all_tasks():
            if t is not me and _ours(t):
                t.cancel()
        while tasks := [t for t in asyncio.all_tasks() if t is not me]:
            await asyncio.wait(tasks)
        if self._client._closed:
            self._client._remove_temp_root()
