"""장애 주입 워커(sdk/fixtures/fault-worker.mjs) — 시작 실패·제한 시간·취소·워커 장애·큐 포화·stderr 다량."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from kordoc import (
    AsyncKordocClient, KordocClient, KordocIncompatibleEngine, KordocQueueFull, KordocStartError, KordocTimeout,
    KordocWorkerCrashed,
)

from conftest import alive, fault


def test_start_failures_are_explicit() -> None:
    with pytest.raises(KordocIncompatibleEngine):
        KordocClient(**fault("bad-protocol")).start()
    with pytest.raises(KordocIncompatibleEngine):
        KordocClient(**fault("no-capability")).start()
    t = time.monotonic()
    with pytest.raises(KordocStartError):
        KordocClient(**fault("no-ready"), start_timeout=1).start()
    assert time.monotonic() - t < 10
    with pytest.raises(KordocStartError):
        KordocClient(node="/없는/node", cli="/x.js").start()


@pytest.mark.parametrize("mode", ["exit-on-parse", "partial-json", "wrong-id"])
def test_worker_failure_raises_and_next_request_gets_new_worker(mode: str, tmp_path: Path) -> None:
    with KordocClient(**fault(mode), request_timeout=20) as client:
        first = client.worker_pids()
        t = time.monotonic()
        with pytest.raises(KordocWorkerCrashed):
            client.parse(tmp_path / "a.docx")
        assert time.monotonic() - t < 10
        assert not alive(first[0])
        with pytest.raises(KordocWorkerCrashed):  # 다음 요청은 새 워커가 받는다(자동 재시도는 없다)
            client.parse(tmp_path / "b.docx")
        assert client.worker_pids() != first or client.worker_pids() == []


def test_timeout_kills_running_worker_and_next_request_succeeds(tmp_path: Path) -> None:
    state = tmp_path / "hung"
    with KordocClient(**fault("hang-first", KORDOC_FAULT_STATE=str(state))) as client:
        first = client.worker_pids()[0]
        with pytest.raises(KordocTimeout):
            client.parse(tmp_path / "a.docx", timeout=0.5)
        assert not alive(first)
        r = client.parse(tmp_path / "b.docx", timeout=10)
        assert r.success and r.markdown.endswith("b.docx")
        assert client.worker_pids()[0] != first


def test_cancel_queued_only_removes_it_and_cancel_running_kills_worker(tmp_path: Path) -> None:
    async def main() -> None:
        async with AsyncKordocClient(**fault("hang")) as client:
            pid = client.worker_pids()[0]
            running = asyncio.create_task(client.parse(tmp_path / "a.docx"))
            await asyncio.sleep(0.3)
            queued = asyncio.create_task(client.parse(tmp_path / "b.docx"))
            await asyncio.sleep(0.1)
            queued.cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued
            assert alive(pid) and not running.done()  # 대기 취소는 진행 중 작업을 건드리지 않는다
            running.cancel()
            with pytest.raises(asyncio.CancelledError):
                await running
            assert not alive(pid)
    asyncio.run(main())


def test_pool_size_and_queue_full(tmp_path: Path) -> None:
    async def main() -> None:
        async with AsyncKordocClient(**fault("slow", KORDOC_FAULT_DELAY_MS="400"), max_workers=2, max_queue=2) as client:
            files = [tmp_path / f"d{i}.docx" for i in range(4)]
            tasks = [asyncio.create_task(client.parse(f)) for f in files]
            await asyncio.sleep(0.05)
            with pytest.raises(KordocQueueFull):
                await client.parse(tmp_path / "over.docx")
            results = await asyncio.gather(*tasks)
            assert [r.markdown for r in results] == [f"ok:{f}" for f in files]  # 응답 id 대응
            assert len({r.raw["pid"] for r in results}) == 2 and len(client.worker_pids()) == 2
    asyncio.run(main())


def test_stderr_flood_does_not_deadlock(tmp_path: Path) -> None:
    with KordocClient(**fault("stderr-flood"), request_timeout=30) as client:
        for i in range(3):
            assert client.parse(tmp_path / f"{i}.docx").success


def test_rss_policy_replaces_worker_between_jobs(tmp_path: Path) -> None:
    with KordocClient(**fault("ok"), max_worker_rss_bytes=1) as client:
        a = client.parse(tmp_path / "a.docx")
        b = client.parse(tmp_path / "b.docx")
        assert a.success and b.success
        assert a.raw["pid"] != b.raw["pid"]  # rss 상한을 넘은 워커는 다음 작업 전에 새 워커로
        assert not alive(a.raw["pid"])
    with KordocClient(**fault("ok")) as client:  # 끄면(기본) 같은 워커
        assert client.parse(tmp_path / "a.docx").raw["pid"] == client.parse(tmp_path / "b.docx").raw["pid"]


def test_close_ends_queued_and_running(tmp_path: Path) -> None:
    async def main() -> None:
        client = await AsyncKordocClient(**fault("hang"), close_timeout=0.5).start()
        pid = client.worker_pids()[0]
        running = asyncio.create_task(client.parse(tmp_path / "a.docx"))
        queued = asyncio.create_task(client.parse(tmp_path / "b.docx"))
        await asyncio.sleep(0.2)
        await client.aclose()
        for t in (running, queued):
            with pytest.raises(Exception) as e:
                await t
            assert type(e.value).__name__ == "KordocClosed"
        assert not alive(pid)
    asyncio.run(main())
