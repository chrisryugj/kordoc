"""공유 wire fixture(sdk/fixtures/protocol-v2.json) 계약 — 요청 인코딩·응답 해독. 엔진 없이 돈다."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kordoc import ParseResult
from kordoc._protocol import OPTION_NAMES, parse_request, wire_options

from conftest import PROTOCOL_FIXTURE

FIX = json.loads(PROTOCOL_FIXTURE.read_text("utf-8"))


def test_requests_match_fixture() -> None:
    reqs = FIX["requests"]
    assert parse_request(1, "/abs/문서.hwpx", {}) == reqs[0]
    assert parse_request(2, "/abs/문서.hwpx", {"table_format": "gfm", "ocr": False}) == reqs[1]
    assert parse_request(3, "/abs/doc.docx", {}, image_transport="files", assets_dir="/abs/assets") == reqs[2]


def test_option_names_cover_worker_allowlist() -> None:
    # docs/parse-worker-protocol.md 허용 목록과 같은 18개
    assert sorted(OPTION_NAMES.values()) == sorted([
        "tableFormat", "htmlTables", "layoutTables", "classifyTables", "tables", "plain", "scriptTags",
        "removeHeaderFooter", "dedupeRunningHeaders", "keepTrailingEmptyCols", "keepEmptyParagraphs",
        "includeFieldPlaceholders", "pages", "images", "inlineImages", "ocr", "formulaOcr", "password"])


def test_false_is_sent_none_is_default() -> None:
    assert wire_options({"ocr": False, "images": None}) == {"ocr": False}
    assert wire_options({"pages": (1, 3)}) == {"pages": [1, 3]}
    with pytest.raises(TypeError):
        wire_options({"file_path": "/etc/passwd"})
    with pytest.raises(TypeError):
        wire_options({"on_progress": print})


def test_decode_responses_keeps_unknown_fields() -> None:
    ok, failed, files = FIX["responses"][0], FIX["responses"][1], FIX["responses"][2]
    r = ParseResult(ok["result"])
    assert r.success and r.markdown == "# 제목" and r.raw["futureField"] == {"kept": True}
    f = ParseResult(failed["result"])
    assert not f.success and f.code == "FILE_NOT_FOUND"
    with pytest.raises(Exception) as e:
        f.raise_for_error()
    assert "FILE_NOT_FOUND" in str(e.value)
    img = ParseResult(files["result"], Path(files["assetsDir"])).images[0]
    assert img.filename == "image_001.png" and img.byte_length == 14
    assert img.path == Path("/abs/assets/kordoc-3-AbC123/image_001.png")
