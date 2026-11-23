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


def test_ocr_lines_typed_match_raw(engine: dict, sdk_fixtures: Path, manifest: list[dict]) -> None:
    """OCR 대조 문서(모델이 캐시에 있을 때만 manifest 에 있다) — 타입으로 꺼낸 줄이 결과 JSON 과 같다."""
    cases = [c for c in manifest if "ocrLines" in c["options"]]
    if not cases:
        pytest.skip("OCR 모델이 없어 OCR 대조 문서가 없습니다")
    with KordocClient(**engine) as client:
        for case in cases:
            r = client.parse(sdk_fixtures / case["file"], **kwargs_of(case["options"]))
            pages = r.ocr_lines
            assert pages is not None and len(pages) == len(r.raw["ocrLines"]), case["name"]
            for page, raw in zip(pages, r.raw["ocrLines"]):
                assert page.page_number == raw["pageNumber"] and page.scale == raw["scale"]
                assert [ln.text for ln in page.lines] == [ln["text"] for ln in raw["lines"]]
                assert [ln.confidence for ln in page.lines] == [ln["confidence"] for ln in raw["lines"]]
                assert [(ln.box.x, ln.box.y, ln.box.w, ln.box.h) for ln in page.lines] == [
                    (ln["box"]["x"], ln["box"]["y"], ln["box"]["w"], ln["box"]["h"]) for ln in raw["lines"]]
            assert any("대한민국" in ln.text for ln in pages[0].lines), case["name"]


def test_page_images_inline_and_files(engine: dict, sdk_fixtures: Path, manifest: list[dict], tmp_path: Path) -> None:
    """페이지 이미지 대조 문서(sharp·pdfium 이 있을 때만 manifest 에 있다) — inline·files 전송 모두 포맷에 맞는 바이트를 읽는다."""
    cases = [c for c in manifest if "pageImages" in c["options"]]
    if not cases:
        pytest.skip("sharp·pdfium 이 없어 페이지 이미지 대조 문서가 없습니다")
    magic = {"image/png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n", "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP"}
    with KordocClient(**engine) as client:
        for case in cases:
            want = "image/webp" if case["options"]["pageImages"] == "webp" else "image/png"
            inline = client.parse(sdk_fixtures / case["file"], **kwargs_of(case["options"]))
            files = client.parse(sdk_fixtures / case["file"], image_transport="files", assets_dir=tmp_path, **kwargs_of(case["options"]))
            assert inline.page_images and len(inline.page_images) == len(inline.raw["pageImages"]) == len(files.page_images), case["name"]
            for a, b, raw in zip(inline.page_images, files.page_images, inline.raw["pageImages"]):
                assert (a.page_number, a.width, a.height) == (raw["pageNumber"], raw["width"], raw["height"])
                assert a.image.mime_type == b.image.mime_type == want and a.image.filename == f"page_{a.page_number:03d}.{want[6:]}"
                # files 의 파일 이름은 dataRef 가 정한다 — 원본 페이지 이미지(images)와 바이트가 같으면 그 파일을 함께 가리킨다
                assert a.image.path is None and b.image.path.parent == files.assets_dir and b.image.path.stat().st_size == b.image.byte_length
                assert a.image.read() == b.image.read() and magic[want](a.image.read()), case["name"]
        # 모르는 포맷은 워커가 거부한다(PNG 로 바꿔 내지 않는다)
        with pytest.raises(KordocProtocolError) as e:
            client.parse(sdk_fixtures / cases[0]["file"], page_images="gif")
        assert e.value.code == "INVALID_OPTIONS"


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


def test_lint_blocks_maps_to_block_and_offset(engine: dict) -> None:
    # 열린 문서 편집 도구(kordoc-auto 등)가 문단·칸 블록으로 넘겨 블록 id·블록 안 위치로 받는다
    with KordocClient(**engine) as client:
        r = client.lint_blocks(
            [
                {"id": "p1", "text": "회의 2026.1.6 개최"},
                {"id": "c1", "text": "합계", "table": {"id": "t", "row": 0, "col": 0}},
                {"id": "c2", "text": "컨텐츠", "table": {"id": "t", "row": 0, "col": 1}},
            ],
            budget=True,
        )
    found = {(f["block"], f["offset"], f["rule"]) for f in r["findings"]}
    assert ("p1", 3, "DATE_NO_SPACE") in found
    assert ("c2", 0, "LOANWORD_ERROR") in found
    assert r["summary"]["ok"] is False
