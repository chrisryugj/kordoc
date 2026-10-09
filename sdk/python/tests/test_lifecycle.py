"""수명 관리 회귀 — 워밍업·교체 중 취소, 슬롯 반납, 요청 직렬화·크기 검사, 닫힌 뒤 parse_bytes, 엔진 경로 탐색."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

import kordoc._worker as worker_mod
from kordoc import (
    AsyncKordocClient, KordocClient, KordocClosed, KordocConfig, KordocProtocolError, KordocQueueFull, KordocStartError, KordocTimeout,
)

from conftest import fault


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
    assert len(spawned) >= 3
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
        assert client._slots.qsize() == 2
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


def test_missing_cli_path_is_reported_as_missing(tmp_path: Path) -> None:
    """없는 cli 경로는 셸 래퍼가 아니라 파일이 없다고 알린다."""
    with pytest.raises(KordocStartError, match="없습니다") as e:
        KordocConfig(node="node", cli=str(tmp_path / "nope" / "kordoc")).command()
    assert "셸 래퍼" not in str(e.value)


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
