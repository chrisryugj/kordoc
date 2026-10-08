"""실제 엔진 — Node parse() 결과 동등성, 상주성, GFM, 이미지 전송, 바이트 입력, 워밍업, 종료."""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import pytest

from kordoc import AsyncKordocClient, KordocClient, KordocProtocolError

from conftest import alive, kwargs_of


def expected(sdk_fixtures: Path, name: str) -> dict:
    return json.loads((sdk_fixtures / "expected" / f"{name}.json").read_text("utf-8"))


def test_results_equal_node_parse(engine: dict, sdk_fixtures: Path, manifest: list[dict]) -> None:
    with KordocClient(**engine) as client:
        for case in manifest:
            r = client.parse(sdk_fixtures / case["file"], **kwargs_of(case["options"]))
            want = expected(sdk_fixtures, case["name"])
            assert r.markdown == want["markdown"], case["name"]
            assert r.blocks == want["blocks"], case["name"]
            assert r.raw == want, case["name"]  # 쪽·메타·경고·이미지까지


def test_async_results_equal_node_parse(engine: dict, sdk_fixtures: Path, manifest: list[dict]) -> None:
    async def main() -> None:
        async with AsyncKordocClient(**engine) as client:
            for case in manifest:
                r = await client.parse(sdk_fixtures / case["file"], **kwargs_of(case["options"]))
                assert r.raw == expected(sdk_fixtures, case["name"]), case["name"]
    asyncio.run(main())


def test_resident_worker_same_pid(engine: dict, sdk_fixtures: Path) -> None:
    with KordocClient(**engine) as client:
        pids = set()
        for _ in range(3):
            client.parse(sdk_fixtures / "이미지 문서.docx")
            pids.update(client.worker_pids())
        assert len(pids) == 1


def test_gfm_tree_and_rowspan(engine: dict, sdk_fixtures: Path) -> None:
    with KordocClient(**engine) as client:
        md = client.parse(sdk_fixtures / "중첩 표.hwpx", table_format="gfm").markdown
    assert "<table" not in re.sub(r"<!--.*?-->", "", md)
    assert [m for m in re.findall(r'<!-- <table id="(t\d+)"(?: parent_id="(t\d+)")? /> -->', md)] == [
        ("t1", ""), ("t2", "t1"), ("t3", "t2"), ("t4", "t3")]
    assert "| 인건비 | 선임 | 80 |" in md and "| 인건비 | 연구원 | 60 |" in md  # rowSpan 3 채움
    assert "| 운영비 | 임차·위탁 |  |" in md and "| 운영비 | 소모품 | 5 |" in md  # rowSpan 2, colSpan 비움


def test_option_false_and_rejections(engine: dict, sdk_fixtures: Path) -> None:
    with KordocClient(**engine) as client:
        r = client.parse(sdk_fixtures / "이미지 문서.docx", images=False, ocr=False)
        assert r.success and r.images == []
        with pytest.raises(KordocProtocolError) as e:
            client.parse(sdk_fixtures / "이미지 문서.docx", html_tables=True, table_format="gfm")
        assert e.value.code == "INVALID_OPTIONS"
        with pytest.raises(KordocProtocolError) as e:
            client.parse(sdk_fixtures / "이미지 문서.docx", layout_tables="nope")
        assert e.value.code == "INVALID_OPTIONS"
        assert client.parse(sdk_fixtures / "이미지 문서.docx").success  # 거부 뒤에도 같은 워커가 처리


def test_images_inline_and_files(engine: dict, sdk_fixtures: Path, tmp_path: Path) -> None:
    want = expected(sdk_fixtures, "docx-image")
    with KordocClient(**engine) as client:
        inline = client.parse(sdk_fixtures / "이미지 문서.docx")
        a = client.parse(sdk_fixtures / "이미지 문서.docx", image_transport="files", assets_dir=tmp_path)
        b = client.parse(sdk_fixtures / "이미지 문서.docx", image_transport="files", assets_dir=tmp_path)
    inline_bytes = inline.images[0].read()
    assert a.assets_dir != b.assets_dir
    for r in (a, b):
        img = r.images[0]
        assert img.filename == want["images"][0]["filename"]
        assert img.read() == inline_bytes  # client 를 닫은 뒤에도 파일이 남아 있다
        assert r.markdown == want["markdown"]


def test_parse_bytes_equals_file_and_cleans_temp(engine: dict, sdk_fixtures: Path, tmp_path: Path) -> None:
    data = (sdk_fixtures / "중첩 표.hwpx").read_bytes()
    with KordocClient(**engine, temp_dir=tmp_path) as client:
        from_bytes = client.parse_bytes(data, table_format="gfm")
        failed = client.parse_bytes(b"not a document")
        assert not failed.success
        leftovers = [p for p in tmp_path.rglob("*") if p.is_file()]
        assert leftovers == []
    assert from_bytes.markdown == expected(sdk_fixtures, "hwpx-gfm")["markdown"]
    assert list(tmp_path.iterdir()) == []


def test_warmup_runs_on_every_worker(engine: dict, sdk_fixtures: Path) -> None:
    with KordocClient(**engine, max_workers=2) as client:
        report = client.warmup(sdk_fixtures / "중첩 표.hwpx", table_format="gfm")
        assert report.ok and len(report.workers) == 2
        assert sorted(w.pid for w in report.workers) == client.worker_pids()
        bad = client.warmup(sdk_fixtures / "없는 문서.hwpx")
        assert not bad.ok and all(w.error for w in bad.workers)


def test_close_leaves_no_worker(engine: dict, sdk_fixtures: Path) -> None:
    with KordocClient(**engine, max_workers=2) as client:
        client.parse(sdk_fixtures / "이미지 문서.docx")
        pids = client.worker_pids()
    assert pids and not any(alive(p) for p in pids)

    async def main() -> list[int]:
        async with AsyncKordocClient(**engine) as client:
            await client.parse(sdk_fixtures / "이미지 문서.docx")
            return client.worker_pids()
    pids = asyncio.run(main())
    assert pids and not any(alive(p) for p in pids)


def test_no_process_until_started(engine: dict) -> None:
    client = KordocClient(**engine)
    assert client.worker_pids() == []
    client.close()  # 시작 전 close 도 안전
