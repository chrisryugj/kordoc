"""수명 관리 회귀 — 워밍업·교체 중 취소, 슬롯 반납, 요청 직렬화·크기 검사, 닫힌 뒤 parse_bytes, 엔진 경로 탐색,
교체 중 닫기·이중 닫기·Ctrl-C, 겹친 시작·워밍업, 짧은 제한 시간과 교체, 임시 파일 경합."""

from __future__ import annotations

import asyncio
import gc
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import kordoc._worker as worker_mod
from kordoc import (
    AsyncKordocClient, KordocClient, KordocClosed, KordocConfig, KordocProtocolError, KordocQueueFull, KordocStartError, KordocTimeout,
    KordocWorkerCrashed, WarmupReport,
)

from conftest import alive, fault


@pytest.fixture
def spawned(monkeypatch: pytest.MonkeyPatch) -> list[worker_mod.Worker]:
    """띄운 워커를 전부 기록 — 닫은 뒤 살아 남은 워커(누수)를 본다."""
    seen: list[worker_mod.Worker] = []
    original = worker_mod.Worker.start

    async def start(self: worker_mod.Worker) -> None:
        seen.append(self)
        await original(self)

    monkeypatch.setattr(worker_mod.Worker, "start", start)
    return seen


def test_cancel_during_replacement_warmup_does_not_leak_workers(tmp_path: Path, spawned: list) -> None:
    doc = tmp_path / "a.docx"

    async def main() -> None:
        client = AsyncKordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="1000"))
        await client.start()
        await client.warmup(doc)
        for _ in range(4):  # 실행 중 제한 시간 → 교체 워커 워밍업 중 제한 시간을 되풀이
            with pytest.raises(KordocTimeout):
                await client.parse(doc, timeout=0.5)
        # 닫기 전에도 살아 있는 워커는 max_workers 를 넘지 않는다 (종전: 취소된 교체 워커가 슬롯 없이 남아 0→1→2→3→4)
        assert len([w for w in spawned if w.alive]) <= 1
        await client.aclose()

    asyncio.run(main())
    assert len(spawned) >= 2  # 처음 워커와 교체 워커 — 교체 워커 워밍업은 요청 제한 시간에 끊기지 않고 이어 간다
    assert [w.pid for w in spawned if w.alive] == []


def test_cancelled_warmup_returns_every_slot(tmp_path: Path) -> None:
    doc = tmp_path / "a.docx"

    async def main() -> None:
        client = AsyncKordocClient(max_workers=2, max_queue=0, **fault("slow", KORDOC_FAULT_DELAY_MS="500"))
        await client.start()
        busy = asyncio.create_task(client.parse(doc))
        await asyncio.sleep(0.05)
        # 두 번째 자리는 진행 중 요청이 쥐고 있다 — max_queue=0 이라 곧바로 QueueFull (또는 제한 시간). 어느 쪽이든 받은 자리는 돌려준다
        with pytest.raises((TimeoutError, KordocQueueFull)):
            await asyncio.wait_for(client.warmup(doc), 0.1)
        await busy
        assert free_slots(client) == 2
        r = await asyncio.gather(client.parse(doc), client.parse(doc))
        assert all(x.success for x in r)
        await client.aclose()

    asyncio.run(main())


def test_cancelled_warmup_late_response_does_not_reach_next_request(tmp_path: Path) -> None:
    doc = tmp_path / "a.docx"

    async def main() -> None:
        client = AsyncKordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="500"))
        await client.start()
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.warmup(doc), 0.1)
        assert (await client.parse(doc)).success
        await client.aclose()

    asyncio.run(main())


def test_warmup_worker_crash_is_reported_as_result(tmp_path: Path) -> None:
    with KordocClient(**fault("exit-on-parse")) as client:
        report = client.warmup(tmp_path / "a.docx")
    assert report.workers and not report.workers[0].success


def test_oversized_request_is_rejected_before_reaching_a_worker(tmp_path: Path) -> None:
    with KordocClient(**fault("ok"), max_request_bytes=4096) as client:
        pid = client.worker_pids()
        with pytest.raises(KordocProtocolError) as e:
            client.parse(tmp_path / "a.docx", password="x" * 10000)
        assert e.value.code == "REQUEST_TOO_LARGE"
        assert client.worker_pids() == pid
        assert client.parse(tmp_path / "a.docx").success


def test_unserializable_option_is_rejected_before_reaching_a_worker(tmp_path: Path) -> None:
    with KordocClient(**fault("ok")) as client:
        pid = client.worker_pids()
        with pytest.raises(TypeError):
            client.parse(tmp_path / "a.docx", pages=[object()])
        assert client.worker_pids() == pid


def test_parse_bytes_after_close_raises_closed_without_temp_files(tmp_path: Path) -> None:
    temp = tmp_path / "tmp"
    temp.mkdir()

    async def main() -> None:
        client = AsyncKordocClient(**fault("ok"), temp_dir=str(temp))
        await client.start()
        await asyncio.gather(client.parse_bytes(b"a", suffix=".docx"), client.parse_bytes(b"b", suffix=".docx"))
        await client.aclose()
        with pytest.raises(KordocClosed):
            await client.parse_bytes(b"c", suffix=".docx")

    asyncio.run(main())
    assert list(temp.iterdir()) == []


def test_shell_shim_cli_resolves_to_dist_cli_js(tmp_path: Path) -> None:
    """Windows kordoc.cmd·pnpm 셸 shim 은 node 로 실행할 수 없다 — 옆의 node_modules/kordoc/dist/cli.js 로, 없으면 분명한 오류."""
    shim = tmp_path / "kordoc.cmd"
    shim.write_text("@ECHO off\r\nnode %~dp0\\node_modules\\kordoc\\dist\\cli.js %*\r\n")
    cli = tmp_path / "node_modules" / "kordoc" / "dist" / "cli.js"
    cli.parent.mkdir(parents=True)
    cli.write_text("#!/usr/bin/env node\n")
    assert KordocConfig(node="node", cli=str(shim)).command()[1] == str(cli.resolve())
    bare = tmp_path / "other" / "kordoc"
    bare.parent.mkdir()
    bare.write_text('#!/bin/sh\nexec node "$basedir/../kordoc/dist/cli.js" "$@"\n')
    with pytest.raises(KordocStartError, match="dist/cli.js"):
        KordocConfig(node="node", cli=str(bare)).command()


def live(workers: list) -> list[int]:
    return [w.pid for w in workers if w.pid is not None and alive(w.pid)]


def free_slots(client: AsyncKordocClient) -> int:
    assert client._slots is not None
    return client._slots.qsize()


def ready_later(tmp_path: Path, mode: str = "hang", delay_ms: str = "2000", **env: str) -> dict:
    """처음 워커는 바로, 교체 워커만 delay_ms 늦게 ready 를 쓰는 장애 워커."""
    return fault(mode, KORDOC_FAULT_READY_STATE=str(tmp_path / "ready"), KORDOC_FAULT_READY_DELAY_MS=delay_ms, **env)


def test_sync_close_during_replacement_start_ends_other_threads(tmp_path: Path, spawned: list) -> None:
    """교체 워커가 ready 를 기다리는 동안 close 하면 그 자리를 기다리던 다른 스레드의 parse 도 KordocClosed 로 끝난다."""
    client = KordocClient(max_workers=1, **ready_later(tmp_path)).start()
    with pytest.raises(KordocTimeout):
        client.parse(tmp_path / "a.docx", timeout=0.2)  # 자리가 비었다 — 다음 요청이 교체 워커를 띄운다
    res: dict = {}

    def other() -> None:
        try:
            res["r"] = client.parse(tmp_path / "b.docx", timeout=20)
        except BaseException as e:
            res["r"] = e

    th = threading.Thread(target=other, daemon=True)
    th.start()
    time.sleep(0.3)  # 교체 워커 시작(ready 2초) 중
    client.close()
    th.join(3)
    assert not th.is_alive(), "close 뒤에도 parse 스레드가 멈춰 있다"
    assert isinstance(res["r"], KordocClosed)
    assert live(spawned) == []


def test_sync_close_during_replacement_warmup_ends_other_threads(tmp_path: Path, spawned: list) -> None:
    """교체 워커 워밍업 중에 close 해도 같다."""
    client = KordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_DELAY_MS="1500")).start()
    assert client.warmup(tmp_path / "w-slow.docx").ok
    with pytest.raises(KordocTimeout):
        client.parse(tmp_path / "hang.docx", timeout=0.3)
    res: dict = {}

    def other() -> None:
        try:
            res["r"] = client.parse(tmp_path / "b.docx", timeout=20)
        except BaseException as e:
            res["r"] = e

    th = threading.Thread(target=other, daemon=True)
    th.start()
    time.sleep(0.5)  # 교체 워커가 워밍업 문서(1.5초)를 파싱하는 중
    client.close()
    th.join(3)
    assert not th.is_alive(), "close 뒤에도 parse 스레드가 멈춰 있다"
    assert isinstance(res["r"], KordocClosed)
    assert live(spawned) == []


def test_aclose_during_replacement_start_ends_request_with_closed(tmp_path: Path, spawned: list) -> None:
    """비동기: aclose 는 띄우는 중인 교체 워커까지 정리하고, 그 자리를 기다리던 요청은 닫힌 뒤 처리되지 않는다."""
    async def main() -> None:
        client = await AsyncKordocClient(max_workers=1, **ready_later(tmp_path, mode="hang-first",
                                                                      KORDOC_FAULT_STATE=str(tmp_path / "hung"))).start()
        with pytest.raises(KordocTimeout):
            await client.parse(tmp_path / "a.docx", timeout=0.3)
        t = asyncio.create_task(client.parse(tmp_path / "b.docx"))
        await asyncio.sleep(0.3)
        await client.aclose()
        assert live(spawned) == []  # aclose 가 돌아온 시점에 이미 정리돼 있다
        with pytest.raises(KordocClosed):
            await asyncio.wait_for(t, 3)
        assert live(spawned) == []

    asyncio.run(main())


def test_aclose_during_replacement_warmup_ends_request_with_closed(tmp_path: Path, spawned: list) -> None:
    """요청 제한 시간은 교체 워커 워밍업을 끊지 않고, aclose 는 끊는다 — 그 자리를 기다리던 요청은 KordocClosed 로 끝나고 워커가 남지 않는다."""
    doc = tmp_path / "a.docx"

    async def main() -> None:
        client = await AsyncKordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="1000")).start()
        await client.warmup(doc)
        with pytest.raises(KordocTimeout):
            await client.parse(doc, timeout=0.3)  # 실행 중 제한 시간 — 자리가 빈다
        with pytest.raises(KordocTimeout):
            await client.parse(doc, timeout=0.3)  # 교체 워커 워밍업(1초) 중 제한 시간 — 워밍업은 이어 간다
        assert (await client.parse(doc, timeout=5)).success
        with pytest.raises(KordocTimeout):
            await client.parse(doc, timeout=0.3)
        t = asyncio.create_task(client.parse(doc))
        await asyncio.sleep(0.4)  # 교체 워커가 워밍업 문서를 파싱하는 중
        await client.aclose()
        with pytest.raises(KordocClosed):
            await t

    asyncio.run(main())
    assert live(spawned) == []


def test_poison_warmup_document_does_not_break_later_requests(tmp_path: Path, sent: list) -> None:
    """워밍업 문서가 워커를 죽이면 결과로 보고하고, 그 문서를 교체 워커에 되풀이해 이후 요청을 모두 실패시키지 않는다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, **fault("by-file")) as client:
            assert (await client.parse(tmp_path / "good.docx")).success
            report = await client.warmup(tmp_path / "crash.docx")
            assert not report.ok and report.workers[0].error
            sent.clear()
            for _ in range(3):
                assert (await client.parse(tmp_path / "good.docx")).success
            # 어느 워커에서도 성공하지 못한 문서는 등록하지 않는다 — 교체 워커가 그 문서로 워밍업하다 죽지 않는다
            assert [f for _, f in sent] == ["good.docx"] * 3

    asyncio.run(main())


def test_replacement_warmup_failure_does_not_fail_the_request(tmp_path: Path) -> None:
    """교체 워커 워밍업이 워커를 죽여도 요청은 예외 없이 워밍업 없는 새 워커가 받는다."""
    state = tmp_path / "crash-now"

    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_STATE=str(state))) as client:
            assert (await client.warmup(tmp_path / "crash.docx")).ok  # 처음에는 성공 — 교체 워커 워밍업으로 등록된다
            state.write_text("1")  # 이제부터 그 문서는 워커를 죽인다
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx", timeout=0.3)
            r = await client.parse(tmp_path / "good.docx")
            assert r.success and r.markdown.endswith("good.docx")
            assert len(client.worker_pids()) == 1

    asyncio.run(main())


def test_warmup_on_empty_slot_warms_each_worker_once_and_reports_failures(tmp_path: Path, sent: list) -> None:
    """빈 자리(교체 대기)에서 warmup() 은 새 워커를 한 번만 워밍업하고, 실패해도 예외 대신 결과로 돌려준다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_DELAY_MS="300")) as client:
            assert (await client.warmup(tmp_path / "w-slow.docx")).ok
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx", timeout=0.3)
            sent.clear()
            report = await client.warmup(tmp_path / "w-slow.docx")
            assert report.ok and len(report.workers) == 1
            assert sent == [(report.workers[0].pid, "w-slow.docx")]
        async with AsyncKordocClient(max_workers=1, **fault("exit-on-parse")) as client:
            for _ in range(2):  # 두 번째는 첫 번째가 죽인 워커 자리 — 교체 워커 워밍업 실패를 예외로 던지지 않는다
                report = await client.warmup(tmp_path / "a.docx")
                assert len(report.workers) == 1 and not report.workers[0].success

    asyncio.run(main())


@pytest.mark.parametrize("slow", ["warmup", "ready"])
def test_short_request_timeout_recovers_after_replacement(tmp_path: Path, slow: str) -> None:
    """request_timeout 이 교체 워커 시작·워밍업보다 짧아도 시작·워밍업은 끊기지 않고 이어져, 뒤 요청이 그 워커를 받는다."""
    env = (fault("by-file", KORDOC_FAULT_DELAY_MS="1000") if slow == "warmup"
           else ready_later(tmp_path, mode="by-file", delay_ms="1000"))

    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, request_timeout=0.5, **env) as client:
            if slow == "warmup":
                assert (await client.warmup(tmp_path / "w-slow.docx")).ok
            assert (await client.parse(tmp_path / "a.docx")).success
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx")
            outcomes = []
            for _ in range(6):
                try:
                    outcomes.append((await client.parse(tmp_path / "a.docx")).success)
                except KordocTimeout:
                    outcomes.append("timeout")
            assert True in outcomes, outcomes
            assert outcomes[-1] is True, outcomes

    asyncio.run(main())


def test_cancel_again_while_discarding_keeps_the_slot(tmp_path: Path) -> None:
    """워커를 버리는 동안 다시 취소돼도 자리를 돌려준다 — 다음 요청이 KordocQueueFull 을 받지 않는다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, max_queue=0, **fault("hang")) as client:
            t = asyncio.create_task(client.parse(tmp_path / "a.docx"))
            await asyncio.sleep(0.3)
            t.cancel()
            await asyncio.sleep(0)
            t.cancel()
            with pytest.raises(asyncio.CancelledError):
                await t
            assert free_slots(client) == 1
            with pytest.raises(KordocTimeout):  # 자리가 있다 — 새 워커가 받아 멈춘다(hang)
                await client.parse(tmp_path / "b.docx", timeout=0.5)

    asyncio.run(main())


def test_second_sync_close_waits_for_the_first(tmp_path: Path, spawned: list) -> None:
    """다른 스레드의 close 가 진행 중일 때 부른 close 는 정리가 끝날 때까지 기다린다."""
    client = KordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="1500")).start()
    res: dict = {}

    def parse() -> None:
        try:
            res["p"] = client.parse(tmp_path / "a.docx")
        except BaseException as e:
            res["p"] = e

    tp = threading.Thread(target=parse, daemon=True)
    tp.start()
    time.sleep(0.2)
    t1 = threading.Thread(target=client.close, daemon=True)
    t1.start()
    time.sleep(0.2)
    client.close()
    assert live(spawned) == []
    tp.join(1)
    t1.join(1)
    assert not tp.is_alive() and not t1.is_alive()
    assert res["p"].success  # 진행 중이던 요청은 close_timeout 안에 끝났다


def test_cancelled_or_concurrent_aclose_still_closes(tmp_path: Path, spawned: list) -> None:
    """aclose 를 취소해도 닫기는 이어지고, 다시(또는 동시에) 부른 aclose 는 정리가 끝날 때까지 기다린다."""
    async def cancelled() -> None:
        client = await AsyncKordocClient(max_workers=2, **fault("slow", KORDOC_FAULT_DELAY_MS="1500")).start()
        t = asyncio.create_task(client.parse(tmp_path / "a.docx"))
        await asyncio.sleep(0.1)
        closing = asyncio.create_task(client.aclose())
        await asyncio.sleep(0.2)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        await client.aclose()
        assert live(spawned) == []
        assert (await t).success

    async def concurrent() -> None:
        client = await AsyncKordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="1000")).start()
        t = asyncio.create_task(client.parse(tmp_path / "a.docx"))
        await asyncio.sleep(0.1)
        first = asyncio.create_task(client.aclose())
        await asyncio.sleep(0)
        await client.aclose()
        assert live(spawned) == []
        await first
        assert (await t).success

    asyncio.run(cancelled())
    asyncio.run(concurrent())
    assert live(spawned) == []


CTRL_C = r"""
import json, os, signal, subprocess, sys, threading, time
import kordoc._worker as worker_mod
from kordoc import KordocClient

case, cfg = sys.argv[1], json.loads(sys.argv[2])
seen = []
original = worker_mod.Worker.start
async def start(self):
    seen.append(self)
    await original(self)
worker_mod.Worker.start = start

def alive(pid):
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")

def interrupt_soon():
    threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGINT)).start()

def _try(fn, *a):
    try:
        return fn(*a)
    except BaseException as e:
        return e

signal.signal(signal.SIGINT, signal.default_int_handler)  # 백그라운드로 띄운 셸은 SIGINT 를 무시하게 물려준다
out = {}
if case == "start":
    client = KordocClient(max_workers=2, **cfg)
    interrupt_soon()
    try:
        client.start()
    except KeyboardInterrupt:
        out["interrupted"] = True
elif case == "close-early":
    client = KordocClient(max_workers=2, **cfg).start()
    client._loop.call_soon_threadsafe(time.sleep, 0.6)  # 루프가 aclose 를 꺼내기 전에 Ctrl-C 가 오게 붙잡아 둔다
    interrupt_soon()
    try:
        client.close()
    except KeyboardInterrupt:
        out["interrupted"] = True
else:
    client = KordocClient(max_workers=1, **cfg).start()
    interrupt_soon()
    th = threading.Thread(target=lambda: out.__setitem__("parse", repr(_try(client.parse, "/tmp/a.docx"))), daemon=True)
    th.start()
    time.sleep(0.1)
    try:
        client.close()
    except KeyboardInterrupt:
        out["interrupted"] = True
    th.join(3)
    out["parse_thread_alive"] = th.is_alive()
time.sleep(0.5)
out["alive"] = [w.pid for w in seen if w.pid and alive(w.pid)]
for pid in out["alive"]:
    os.kill(pid, signal.SIGKILL)  # 남은 워커는 기록만 하고 치운다 (no-quit 워커는 스스로 끝나지 않는다)
out["spawned"] = len(seen)
out["loop_threads"] = sum(t.name == "kordoc-sdk" for t in threading.enumerate())
print(json.dumps(out))
"""


@pytest.mark.parametrize("case", ["start", "close", "close-early", "retire"])
def test_ctrl_c_during_sync_start_close_or_retire_leaves_no_worker(case: str) -> None:
    """동기 start·close 중 Ctrl-C: 띄운 워커를 남기지 않고, 다른 스레드의 parse 를 멈춘 채 두지 않는다 (별도 프로세스에서).
    close-early 는 루프가 닫기를 꺼내기도 전에 끊긴 close.
    retire 는 rss 상한으로 내보내며 quit 를 기다리던 워커 — 풀에서 이미 빠져 있어 끊긴 quit 가 직접 끝내야 한다."""
    cfg = {"start": fault("ok", KORDOC_FAULT_READY_DELAY_MS="1500"),
           "close": fault("slow", KORDOC_FAULT_DELAY_MS="3000"),
           "close-early": fault("no-quit"),
           "retire": {**fault("no-quit"), "max_worker_rss_bytes": 1}}[case]
    p = subprocess.run([sys.executable, "-c", CTRL_C, case, json.dumps(cfg)], capture_output=True, text=True, timeout=30)
    out = json.loads(p.stdout.strip().splitlines()[-1])
    assert out.get("interrupted"), p.stderr
    assert out["spawned"] >= 1 and out["alive"] == [], out
    assert out["loop_threads"] == 0, out
    if case == "close":
        assert out["parse_thread_alive"] is False and "KordocClosed" in out["parse"], out
    if case == "retire":
        assert "'success': True" in out["parse"], out  # 요청이 끝나 워커가 풀에서 빠진 뒤 quit 를 기다리던 중이었다
    assert "was destroyed but it is pending" not in p.stderr and "never awaited" not in p.stderr, p.stderr


CTRL_C_SPAWN = r"""
import asyncio, json, os, signal, subprocess, sys, threading, time
from kordoc import KordocClient

case = sys.argv[2]
client = KordocClient(max_workers=1, **json.loads(sys.argv[1]))
spawns, hooked = [], []
new_loop = asyncio.new_event_loop

def make_loop():
    loop = new_loop()
    create_task = loop.create_task
    def hook(coro, **kw):
        task = create_task(coro, **kw)
        if getattr(coro, "__qualname__", "").endswith("_connect_pipes"):
            spawns.append(True)
            if len(spawns) == (1 if case == "start" else 2):
                # 워커 프로세스를 막 만들고 파이프를 잇는 asyncio 내부 작업이 아직 돌기 전 — 이 순간 Ctrl-C 로 start()·close() 가 루프를 멈추게 한다
                hooked.append(True)
                time.sleep(0.2)  # 루프를 붙잡은 채 — close() 가 넘긴 닫기는 루프가 꺼내기 전에 끊긴다
                os.kill(os.getpid(), signal.SIGINT)
                for _ in range(500):
                    if client._loop is None:
                        break
                    time.sleep(0.01)
                time.sleep(0.2)  # 루프를 멈추며 남은 작업을 끝내는 정리가 루프에 올라오기까지
        return task
    loop.create_task = hook
    return loop

def parse():
    try:
        client.parse("/tmp/a.docx")
    except Exception as e:
        out["parse"] = type(e).__name__

asyncio.new_event_loop = make_loop
signal.signal(signal.SIGINT, signal.default_int_handler)
out = {}
try:
    client.start()
    if case == "replace":
        # 워커가 죽어 다음 요청이 교체 워커를 띄우는 동안 close() 가 끊긴다 — 띄우던 작업을 처음 끊는 것이 루프를 멈추는 정리다
        os.kill(client.worker_pids()[0], signal.SIGKILL)
        for _ in range(500):
            if not client.worker_pids():
                break
            time.sleep(0.01)
        th = threading.Thread(target=parse, daemon=True)
        th.start()
        for _ in range(500):
            if hooked:
                break
            time.sleep(0.01)
        client.close()
except KeyboardInterrupt:
    out["interrupted"] = True
time.sleep(0.5)
ps = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,stat=,comm="], capture_output=True, text=True).stdout.split("\n")
out["children"] = [int(p[0]) for p in (l.split(None, 3) for l in ps)  # ps 자신은 뺀다
                   if len(p) == 4 and int(p[1]) == os.getpid() and not p[2].startswith("Z") and "ps" != os.path.basename(p[3])]
out["hooked"] = bool(hooked)
out["loop_threads"] = sum(t.name == "kordoc-sdk" for t in threading.enumerate())
print(json.dumps(out))
"""


@pytest.mark.parametrize("case", ["start", "replace"])
def test_ctrl_c_while_worker_process_is_being_created_does_not_hang(case: str) -> None:
    """루프를 멈추며 남은 작업을 끝낼 때 asyncio 내부 작업(프로세스 파이프 잇기)까지 취소하지 않는다. Python 3.12 까지는 그 작업이
    취소되면 transport 가 끝나지 않아 start() 가 영원히 멈추고, 다른 스레드의 start()·close() 도 수명 잠금에서 막힌다 (별도 프로세스에서).
    replace 는 교체 워커를 띄우는 중 루프가 꺼내기도 전에 끊긴 close() — 띄우던 작업을 정리가 한 번만 끊어, 거듭된 취소가 멈춘 기다림을 풀어 주지 않는다."""
    try:
        p = subprocess.run([sys.executable, "-c", CTRL_C_SPAWN, json.dumps(fault("ok")), case],
                           capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired as e:
        pytest.fail(f"start()·close() 가 돌아오지 않았다\n{e.stderr}")
    out = json.loads(p.stdout.strip().splitlines()[-1])
    assert out["hooked"] and out.get("interrupted"), (out, p.stderr)
    assert out["children"] == [] and out["loop_threads"] == 0, out
    if case == "replace":
        assert out.get("parse") == "KordocClosed", out
    assert "was destroyed but it is pending" not in p.stderr and "never awaited" not in p.stderr, p.stderr


def test_concurrent_warmups_do_not_deadlock(tmp_path: Path) -> None:
    """자리가 바쁠 때 warmup() 둘이 겹쳐도 서로 자리를 나눠 쥐고 멈추지 않는다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=2, **fault("slow", KORDOC_FAULT_DELAY_MS="300")) as client:
            busy = [asyncio.create_task(client.parse(tmp_path / "a.docx")) for _ in range(2)]
            await asyncio.sleep(0.05)
            reports = await asyncio.wait_for(asyncio.gather(client.warmup(tmp_path / "w.docx"),
                                                            client.warmup(tmp_path / "w.docx")), 5)
            assert all(r.ok and len(r.workers) == 2 for r in reports)
            await asyncio.gather(*busy)
            assert free_slots(client) == 2

    asyncio.run(main())


def test_concurrent_warmups_after_restart(tmp_path: Path) -> None:
    """실패한 시작과 겹쳐 warmup() 둘이 경합한 뒤 새 루프에서 다시 시작해도 겹친 warmup() 은 둘 다 돈다."""
    ready = tmp_path / "ready"
    env = fault("by-file", KORDOC_FAULT_DELAY_MS="800", KORDOC_FAULT_READY_STATE=str(ready), KORDOC_FAULT_READY_DELAY_MS="3000")
    doc = tmp_path / "w-slow.docx"

    def together(*calls) -> list:
        res: list = [None] * len(calls)

        def run(i: int) -> None:
            try:
                res[i] = calls[i]()
            except BaseException as e:
                res[i] = e

        threads = [threading.Thread(target=run, args=(i,), daemon=True) for i in range(len(calls))]
        for t in threads:
            t.start()
            time.sleep(0.2)
        for t in threads:
            t.join(10)
        assert not any(t.is_alive() for t in threads), res
        return res

    def warmed(*results: object) -> bool:
        return all(isinstance(r, WarmupReport) and r.ok for r in results)

    ready.touch()  # 이 파일이 있는 동안 ready 가 늦다 — 첫 시작은 start_timeout 을 넘긴다
    client = KordocClient(max_workers=1, start_timeout=1, **env)

    def warm() -> WarmupReport:
        return client.warmup(doc)

    started, *first = together(client.start, warm, warm)  # 실패할 시작을 기다리며 warmup() 둘이 겹친다
    assert isinstance(started, KordocStartError) and not any(isinstance(r, WarmupReport) for r in first), (started, first)
    ready.unlink()
    try:
        started, *reports = together(client.start, warm, warm)
        assert started is client and warmed(*reports), (started, reports)
        assert warmed(*together(warm, warm))
    finally:
        client.close()

    ready.touch()
    aclient = AsyncKordocClient(max_workers=1, start_timeout=1, **env)

    async def overlapped() -> list:
        return list(await asyncio.wait_for(asyncio.gather(aclient.start(), aclient.warmup(doc), aclient.warmup(doc),
                                                          return_exceptions=True), 10))

    async def restart() -> None:
        try:
            started, *reports = await overlapped()
            assert started is aclient and warmed(*reports), (started, reports)
            assert warmed(*await asyncio.wait_for(asyncio.gather(aclient.warmup(doc), aclient.warmup(doc)), 10))
        finally:
            await aclient.aclose()

    first = asyncio.run(overlapped())
    assert all(isinstance(r, KordocStartError) for r in first), first
    ready.unlink()
    asyncio.run(restart())


def test_aclose_during_start_leaves_no_worker(tmp_path: Path, spawned: list) -> None:
    """start(명시·지연 시작) 진행 중에 aclose 하면 start 는 KordocClosed 로 끝나고 띄운 워커를 남기지 않는다."""
    async def explicit() -> None:
        client = AsyncKordocClient(max_workers=2, **fault("ok", KORDOC_FAULT_READY_DELAY_MS="500"))
        st = asyncio.create_task(client.start())
        await asyncio.sleep(0.1)
        await client.aclose()
        with pytest.raises(KordocClosed):
            await st
        assert client.worker_pids() == [] and live(spawned) == []

    async def lazy() -> None:
        client = AsyncKordocClient(max_workers=1, **fault("ok", KORDOC_FAULT_READY_DELAY_MS="500"))
        t = asyncio.create_task(client.parse(tmp_path / "a.docx"))
        await asyncio.sleep(0.1)
        await client.aclose()
        with pytest.raises(KordocClosed):
            await t
        assert client.worker_pids() == [] and live(spawned) == []

    asyncio.run(explicit())
    asyncio.run(lazy())
    assert len(spawned) == 3 and live(spawned) == []


def test_concurrent_start_respects_max_workers(tmp_path: Path, spawned: list) -> None:
    """겹친 start·지연 시작은 한 번만 워커를 띄운다. 동기 클라이언트는 루프 스레드를 하나만 둔다."""
    async def lazy() -> None:
        async with AsyncKordocClient(max_workers=1, **fault("slow", KORDOC_FAULT_DELAY_MS="300")) as client:
            await asyncio.gather(*(client.parse(tmp_path / f"{i}.docx") for i in range(4)))
            assert len(client.worker_pids()) == 1

    async def explicit() -> None:
        client = AsyncKordocClient(max_workers=2, **fault("ok"))
        await asyncio.gather(client.start(), client.start())
        assert len(client.worker_pids()) == 2 and free_slots(client) == 2
        await client.aclose()

    asyncio.run(lazy())
    assert len(spawned) == 1
    asyncio.run(explicit())
    assert len(spawned) == 3
    for _ in range(5):
        before = sum(t.name == "kordoc-sdk" for t in threading.enumerate())
        client = KordocClient(max_workers=1, **fault("ok"))
        barrier = threading.Barrier(2)
        threads = [threading.Thread(target=lambda: (barrier.wait(), client.start()), daemon=True) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        assert not any(t.is_alive() for t in threads)
        assert sum(t.name == "kordoc-sdk" for t in threading.enumerate()) - before == 1
        assert len(client.worker_pids()) == 1
        client.close()
        assert sum(t.name == "kordoc-sdk" for t in threading.enumerate()) == before
    assert live(spawned) == []


def test_nan_and_infinity_options_are_rejected_before_reaching_a_worker(tmp_path: Path) -> None:
    """JSON 이 아닌 NaN·Infinity 토큰을 보내 멀쩡한 워커를 버리지 않는다."""
    with KordocClient(**fault("ok")) as client:
        pid = client.worker_pids()
        for options in ({"pages": [float("nan")]}, {"pages": [float("inf")]}, {"ocr": float("nan")}):
            with pytest.raises(ValueError):
                client.parse(tmp_path / "a.docx", **options)
            with pytest.raises(ValueError):
                client.warmup(tmp_path / "a.docx", **options)
        assert client.worker_pids() == pid
        assert client.parse(tmp_path / "a.docx").success


def test_parse_bytes_racing_aclose_leaves_no_temp_root(tmp_path: Path) -> None:
    """임시 파일 쓰기가 executor 에서 기다리는 사이 aclose 가 끝나도 빈 kordoc-sdk-* 루트를 남기지 않는다."""
    async def once(temp: Path) -> None:
        client = await AsyncKordocClient(**fault("ok"), temp_dir=str(temp)).start()
        blockers = [asyncio.create_task(asyncio.to_thread(time.sleep, 0.3)) for _ in range(64)]  # executor 를 채운다
        t = asyncio.create_task(client.parse_bytes(b"x", suffix=".docx"))
        await asyncio.sleep(0)
        await client.aclose()
        with pytest.raises(KordocClosed):
            await t
        await asyncio.gather(*blockers)

    for i in range(3):
        temp = tmp_path / str(i)
        temp.mkdir()
        asyncio.run(once(temp))
        assert list(temp.iterdir()) == []


def test_cancel_during_temp_write_removes_the_copy(tmp_path: Path) -> None:
    """임시 파일을 쓰는 중에 취소돼도 쓰기가 끝나면 그 사본을 지운다 (aclose 까지 기다리지 않는다)."""
    async def main() -> None:
        async with AsyncKordocClient(**fault("ok"), temp_dir=str(tmp_path)) as client:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(client.parse_bytes(b"\0" * (128 * 1024 * 1024), suffix=".docx"), 0.01)
            for _ in range(60):
                if not [p for p in tmp_path.rglob("*") if p.is_file()]:
                    break
                await asyncio.sleep(0.05)
            assert [p for p in tmp_path.rglob("*") if p.is_file()] == []
            assert (await client.parse_bytes(b"x", suffix=".docx")).success

    asyncio.run(main())
    assert list(tmp_path.iterdir()) == []


def test_missing_cli_path_is_reported_as_missing(tmp_path: Path) -> None:
    """없는 cli 경로는 셸 래퍼가 아니라 파일이 없다고 알린다."""
    with pytest.raises(KordocStartError, match="없습니다") as e:
        KordocConfig(node="node", cli=str(tmp_path / "nope" / "kordoc")).command()
    assert "셸 래퍼" not in str(e.value)


def test_cancelled_warmup_with_queue_returns_every_slot(tmp_path: Path) -> None:
    """max_queue>0 에서 두 번째 자리를 기다리다 취소된 warmup 도 받은 자리를 돌려준다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=2, max_queue=64, **fault("slow", KORDOC_FAULT_DELAY_MS="500")) as client:
            busy = asyncio.create_task(client.parse(tmp_path / "a.docx"))
            await asyncio.sleep(0.05)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(client.warmup(tmp_path / "w.docx"), 0.1)
            await busy
            assert free_slots(client) == 2
            assert all(r.success for r in await asyncio.gather(client.parse(tmp_path / "b.docx"),
                                                               client.parse(tmp_path / "c.docx")))

    asyncio.run(main())


def test_worker_exit_with_stderr_held_by_grandchild_keeps_slot_and_closes_pipes(tmp_path: Path) -> None:
    """워커가 끝나도 손자 프로세스가 stderr 를 쥐고 있으면 정리가 늦는다. 그 사이 제한 시간이 와도 자리를 잃지 않고,
    stderr 를 끝까지 기다리지 못하면 파이프를 닫아 닫힌 루프에서 transport 가 정리되며 나는 경고를 남기지 않는다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, max_queue=0, request_timeout=1.5, **fault("exit-hold-stderr")) as client:
            with pytest.raises((KordocWorkerCrashed, KordocTimeout)):
                await client.parse(tmp_path / "a.docx")
            await asyncio.sleep(1)  # 버리던 워커 정리가 끝나도록
            assert free_slots(client) == 1
            with pytest.raises((KordocWorkerCrashed, KordocTimeout)):  # 자리가 있다 — QueueFull 이 아니다
                await client.parse(tmp_path / "b.docx")

    asyncio.run(main())
    gc.collect()


def test_concurrent_kills_of_one_worker(tmp_path: Path) -> None:
    """같은 워커를 두 곳에서 동시에 끝내도(aclose 와 실패 요청 정리가 겹칠 때) 서로의 stderr 정리를 깨지 않는다."""
    async def main() -> None:
        w = worker_mod.Worker(KordocConfig(**fault("exit-hold-stderr")))
        await w.start()
        msg = {"id": 1, "cmd": "parse", "file": str(tmp_path / "a.docx")}
        with pytest.raises(KordocWorkerCrashed):
            await w.request(msg, (json.dumps(msg) + "\n").encode())
        await asyncio.gather(w.kill(), w.kill())
        assert not w.alive

    asyncio.run(main())
    gc.collect()


def test_start_right_after_a_cancelled_start_is_not_cancelled(tmp_path: Path, spawned: list) -> None:
    """명시 start() 가 제한 시간으로 취소된 직후(시작 작업이 워커를 끝내는 몇 ms 동안) 부른 parse·start 는
    그 취소를 넘겨받지 않고 새로 시작한다 (아무도 취소하지 않은 호출이 CancelledError 를 받으면 TaskGroup·asyncio.run 이 취소로 본다)."""
    env = fault("ok", KORDOC_FAULT_READY_DELAY_MS="500")

    async def then_parse() -> None:
        client = AsyncKordocClient(max_workers=1, **env)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.start(), 0.1)
        assert (await client.parse(tmp_path / "a.docx")).success
        assert len(client.worker_pids()) == 1
        await client.aclose()

    async def retry_start() -> None:
        client = AsyncKordocClient(max_workers=2, **env)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.start(), 0.1)
        await asyncio.wait_for(client.start(), 5)
        assert len(client.worker_pids()) == 2 and free_slots(client) == 2
        await client.aclose()

    async def lazy_waiting() -> None:
        # 같은 시작을 지연 시작 요청이 기다리고 있으면 끊긴 start() 는 시작을 멈추지 않는다 — 그 요청이 워커를 받는다
        client = AsyncKordocClient(max_workers=1, **env)
        t = asyncio.create_task(client.parse(tmp_path / "a.docx"))
        await asyncio.sleep(0)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.start(), 0.1)
        assert (await t).success
        assert len(client.worker_pids()) == 1 and len(spawned) == before + 1
        await client.aclose()

    for _ in range(3):
        asyncio.run(then_parse())
        asyncio.run(retry_start())
        before = len(spawned)
        asyncio.run(lazy_waiting())
    assert live(spawned) == []


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int | None, str]]:
    """워커에 보낸 요청 (pid, 파일 이름)."""
    seen: list[tuple[int | None, str]] = []
    original = worker_mod.Worker.request

    async def request(self: worker_mod.Worker, msg: dict, line: bytes) -> dict:
        seen.append((self.pid, Path(msg["file"]).name))
        return await original(self, msg, line)

    monkeypatch.setattr(worker_mod.Worker, "request", request)
    return seen


def test_replacement_started_by_cancelled_warmup_is_warmed_before_parse(tmp_path: Path, sent: list) -> None:
    """warmup() 이 빈 자리에서 띄우던 교체 워커를 warmup() 취소 뒤 parse 가 이어받아도, 그 워커는 요청을 받기 전에
    등록된 워밍업 문서로 워밍업한다 (교체 작업을 처음 만든 호출이 아니라 받는 쪽이 바라는 문서를 따른다)."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, **ready_later(tmp_path, mode="by-file", delay_ms="1000")) as client:
            assert (await client.warmup(tmp_path / "w.docx")).ok
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx", timeout=0.3)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(client.warmup(tmp_path / "w.docx"), 0.3)  # 교체 워커 ready(1초) 를 기다리다 취소
            sent.clear()
            assert (await client.parse(tmp_path / "good.docx")).success
            pid = client.worker_pids()[0]
            assert sent == [(pid, "w.docx"), (pid, "good.docx")]

    async def mid_warmup() -> None:
        # 취소된 warmup() 이 아직 등록되지 않은 다른 문서로 교체 워커를 워밍업하던 중이면, 이어받은 parse 는 등록된 문서로 마저 워밍업한다
        async with AsyncKordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_DELAY_MS="800")) as client:
            assert (await client.warmup(tmp_path / "w.docx")).ok
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx", timeout=0.3)
            sent.clear()
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(client.warmup(tmp_path / "x-slow.docx"), 0.3)  # 교체 워커가 x-slow(0.8초) 를 파싱하는 중
            assert (await client.parse(tmp_path / "good.docx")).success
            pid = client.worker_pids()[0]
            assert sent == [(pid, "x-slow.docx"), (pid, "w.docx"), (pid, "good.docx")]

    async def other_doc_during_ready() -> None:
        # 취소된 warmup() 이 다른 문서로 띄우던 교체 워커가 아직 ready 전이면, 띄운 뒤에 바라는 문서를 읽어 이어받은 parse 의 문서로만 워밍업한다
        async with AsyncKordocClient(max_workers=1, **ready_later(tmp_path, mode="by-file", delay_ms="1000")) as client:
            assert (await client.warmup(tmp_path / "w.docx")).ok
            with pytest.raises(KordocTimeout):
                await client.parse(tmp_path / "hang.docx", timeout=0.3)
            sent.clear()
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(client.warmup(tmp_path / "x.docx"), 0.3)  # 교체 워커 ready(1초) 를 기다리다 취소
            assert (await client.parse(tmp_path / "good.docx")).success
            pid = client.worker_pids()[0]
            assert sent == [(pid, "w.docx"), (pid, "good.docx")]

    asyncio.run(main())
    asyncio.run(mid_warmup())
    (tmp_path / "ready").unlink()
    asyncio.run(other_doc_during_ready())


def test_aclose_right_as_replacement_finishes_starts_no_new_work(tmp_path: Path, spawned: list,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """교체 작업이 끝나는 순간 aclose 가 시작돼 닫기가 그 작업을 못 봐도, 깨어난 요청은 워밍업·교체를 새로 띄우지 않는다."""
    original = AsyncKordocClient._spawn
    closing: list = []

    async def spawn(self: AsyncKordocClient, slot, w=None):
        w = await original(self, slot, w)
        if not closing and slot.warmed is not None and Path(slot.warmed[0][0]).name == "x-slow.docx":
            closing.append(asyncio.ensure_future(self.aclose()))
        return w

    monkeypatch.setattr(AsyncKordocClient, "_spawn", spawn)

    async def main() -> None:
        client = await AsyncKordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_DELAY_MS="800")).start()
        assert (await client.warmup(tmp_path / "w.docx")).ok
        with pytest.raises(KordocTimeout):
            await client.parse(tmp_path / "hang.docx", timeout=0.3)  # 자리가 빈다
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.warmup(tmp_path / "x-slow.docx"), 0.3)  # 교체 워커가 x-slow 로 워밍업하는 중
        # 이어받은 parse 는 등록된 문서(w.docx)로 마저 워밍업하려 한다 — 그 순간 닫기가 시작된다
        with pytest.raises(KordocClosed):
            await client.parse(tmp_path / "good.docx")
        await closing[0]
        assert live(spawned) == []

    asyncio.run(main())
    assert live(spawned) == []


def test_warmup_taking_over_a_replacement_mid_warmup_warms_it_once(tmp_path: Path, sent: list) -> None:
    """parse 가 띄운 교체 워커가 워밍업하는 중에 parse 가 시간 초과되고 warmup() 이 그 자리를 받아도 같은 문서로 두 번
    워밍업하지 않는다. 다른 문서로 부른 warmup() 은 그 문서로 한 번 더 파싱한다."""
    async def main() -> None:
        async with AsyncKordocClient(max_workers=1, **fault("by-file", KORDOC_FAULT_DELAY_MS="800")) as client:
            assert (await client.warmup(tmp_path / "w-slow.docx")).ok
            for doc, expected in (("w-slow.docx", ["w-slow.docx"]), ("other-slow.docx", ["w-slow.docx", "other-slow.docx"])):
                with pytest.raises(KordocTimeout):
                    await client.parse(tmp_path / "hang.docx", timeout=0.3)
                sent.clear()
                with pytest.raises(KordocTimeout):
                    await client.parse(tmp_path / "good.docx", timeout=0.3)  # 교체 워커 워밍업(0.8초) 중 시간 초과
                report = await client.warmup(tmp_path / doc)
                assert report.ok and len(report.workers) == 1
                pid = report.workers[0].pid
                assert sent == [(pid, f) for f in expected], (doc, sent)

    asyncio.run(main())


def test_circular_option_error_is_not_reported_as_nan(tmp_path: Path) -> None:
    """순환 참조 같은 다른 직렬화 오류를 NaN·Infinity 로 안내하지 않는다 (워커를 버리지 않는 것은 그대로)."""
    pages: list = []
    pages.append(pages)
    with KordocClient(**fault("ok")) as client:
        pid = client.worker_pids()
        with pytest.raises(ValueError, match="Circular reference") as e:
            client.parse(tmp_path / "a.docx", pages=pages)
        assert "NaN" not in str(e.value)
        with pytest.raises(ValueError, match="NaN"):
            client.parse(tmp_path / "a.docx", pages=[float("nan")])
        assert client.worker_pids() == pid
