"""공유 wire fixture(sdk/fixtures/protocol-v2.json) 계약 — 요청 인코딩·응답 해독. 엔진 없이 돈다."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from kordoc import Image, OcrBox, OcrChar, OcrCharAlternative, OcrDewarp, OcrLine, OcrLineCandidate, OcrModelFile, OcrPageLines, PageImage, ParseResult
from kordoc._protocol import OPTION_NAMES, parse_request, wire_options

from conftest import PROTOCOL_FIXTURE

FIX = json.loads(PROTOCOL_FIXTURE.read_text("utf-8"))


def test_requests_match_fixture() -> None:
    reqs = FIX["requests"]
    assert parse_request(1, "/abs/문서.hwpx", {}) == reqs[0]
    assert parse_request(2, "/abs/문서.hwpx", {"table_format": "gfm", "ocr": False}) == reqs[1]
    assert parse_request(3, "/abs/doc.docx", {}, image_transport="files", assets_dir="/abs/assets") == reqs[2]
    assert parse_request(4, "/abs/scan.pdf", {
        "ocr": True, "ocr_lines": "all", "ocr_det": "server", "ocr_det_long_side": 1920,
        "ocr_rec": OcrModelFile("/abs/models/rec.onnx", "a" * 64)}) == reqs[3]
    # 손글씨 rec 프리셋은 문자열 그대로(경로로 바꾸지 않는다)
    assert parse_request(5, "/abs/수기 신청서.pdf", {"ocr": True, "ocr_rec": "handwriting"}) == reqs[4]
    assert parse_request(6, "/abs/사진.bmp", {"ocr": False, "page_images": True}) == reqs[5]
    assert parse_request(7, "/abs/scan.pdf", {"page_images": "webp"}, image_transport="files", assets_dir="/abs/assets") == reqs[6]
    assert parse_request(8, "/abs/scan.pdf", {"ocr": True, "ocr_lines": "all", "ocr_line_candidates": 3}) == reqs[7]
    assert parse_request(9, "/abs/scan.pdf", {"ocr": True, "ocr_lines": "all", "ocr_chars": 2}) == reqs[8]


def test_option_names_cover_worker_allowlist() -> None:
    # docs/parse-worker-protocol.md 허용 목록과 같은 31개
    assert sorted(OPTION_NAMES.values()) == sorted([
        "tableFormat", "htmlTables", "htmlCellLinks", "layoutTables", "classifyTables", "tables", "plain", "scriptTags",
        "removeHeaderFooter", "dedupeRunningHeaders", "keepTrailingEmptyCols", "keepEmptyParagraphs",
        "includeFieldPlaceholders", "pages", "images", "inlineImages", "qrCodes", "imageFormat", "imagePlacement", "dropBlankImages", "ocr", "formulaOcr", "password",
        "ocrLines", "ocrDet", "ocrDetLongSide", "ocrRec", "ocrRecDict", "pageImages", "ocrLineCandidates", "ocrChars"])


def test_ocr_model_files_become_absolute_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    sha = "b" * 64
    want = {"path": str(tmp_path / "rec.onnx"), "sha256": sha}
    assert wire_options({"ocr_rec": OcrModelFile("rec.onnx", sha)}) == {"ocrRec": want}
    assert wire_options({"ocr_rec": OcrModelFile(Path("rec.onnx"), sha)}) == {"ocrRec": want}
    assert wire_options({"ocr_det": {"path": "rec.onnx", "sha256": sha}}) == {"ocrDet": want}
    assert wire_options({"ocr_det": "mobile", "ocr_lines": True}) == {"ocrDet": "mobile", "ocrLines": True}
    # 남는 키가 있는 매핑·모르는 문자열은 그대로 보내 워커가 거부한다(검증의 정본은 워커)
    odd = {"path": "/m/d.yml", "sha256": sha, "url": "https://example.com"}
    assert wire_options({"ocr_rec_dict": odd}) == {"ocrRecDict": odd}
    with pytest.raises(TypeError):
        wire_options({"ocr_rec": Path("/m/rec.onnx")})  # SHA-256 없이 경로만


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
    assert r.ocr_lines is None  # 옵션을 안 준 결과


def test_decode_ocr_lines_typed() -> None:
    r = ParseResult(FIX["responses"][5]["result"])
    pages = r.ocr_lines
    assert pages is not None and [p.page_number for p in pages] == [1, 3]
    first, region = pages
    assert first == OcrPageLines(page_number=1, width=1260, height=390, scale=3, deskew_angle=0, regions_only=False, lines=(
        OcrLine("대한민국 정부 2026", OcrBox(118, 105, 640, 60), 0.9987),
        OcrLine("잡음", OcrBox(900, 300, 40, 20), 0.31, dropped=True)))
    assert region.regions_only and region.deskew_angle == 0.42
    assert region.lines[0].box == OcrBox(200.5, 1000, 300, 40.5)
    assert ParseResult({"success": True, "ocrLines": []}).ocr_lines == []
    # 엔진이 상자·줄·쪽에 키를 더해도 깨지지 않는다(엔진·SDK 버전은 따로 간다)
    future = {"pageNumber": 1, "width": 10, "height": 10, "scale": 3, "deskewAngle": 0, "newPageKey": 1,
              "lines": [{"text": "가", "box": {"x": 1, "y": 2, "w": 3, "h": 4, "angle": 0}, "confidence": 0.9, "newLineKey": True}]}
    assert ParseResult({"success": True, "ocrLines": [future]}).ocr_lines[0].lines[0].box == OcrBox(1, 2, 3, 4)


def test_decode_page_images() -> None:
    inline, files = FIX["responses"][6], FIX["responses"][7]
    [p] = ParseResult(inline["result"]).page_images
    assert isinstance(p, PageImage) and (p.page_number, p.width, p.height) == (1, 5, 3)
    assert (p.image.filename, p.image.mime_type, p.image.path) == ("page_001.png", "image/png", None)
    assert p.image.read() == b"\x89PNG\r\n\x1a\n\x01\x02\x03\x04"
    first, second = ParseResult(files["result"], Path(files["assetsDir"])).page_images
    assert (first.page_number, first.width, first.height, first.image.mime_type, first.image.byte_length) == (1, 1786, 2526, "image/webp", 20480)
    assert first.image.path == Path("/abs/assets/kordoc-7-XyZ789/page_001.webp")
    # WebP 로 내지 못한 페이지는 PNG 로 온다 — 포맷은 페이지마다 mime_type 으로 본다
    assert (second.page_number, second.image.mime_type, second.image.path) == (2, "image/png", Path("/abs/assets/kordoc-7-XyZ789/page_002.png"))
    # 옵션을 안 준 결과는 빈 목록
    assert ParseResult(FIX["responses"][0]["result"]).page_images == []


def test_decode_ocr_line_candidates() -> None:
    r = ParseResult(FIX["responses"][8]["result"])
    [page] = r.ocr_line_candidates
    assert page[0] == (OcrLineCandidate("대한민국 정부 2026", 0.9488), OcrLineCandidate("대한민국 정부2026", 0.0354), OcrLineCandidate("대한민국 정부  2026", 0.0069))
    # 줄과 같은 자리 — 후보가 없는 줄(이어 붙였거나 고친 줄)은 빈 튜플, 버린 줄도 후보를 싣는다
    assert len(page) == len(r.ocr_lines[0].lines) == 3 and page[1] == () and page[2] == (OcrLineCandidate("잡음", 0.2),)
    # 옵션을 안 준 결과는 줄마다 빈 튜플, ocrLines 가 없으면 빈 목록
    assert ParseResult(FIX["responses"][5]["result"]).ocr_line_candidates == [[(), ()], [()]]
    assert ParseResult(FIX["responses"][0]["result"]).ocr_line_candidates == []


def test_existing_types_unchanged_with_candidates() -> None:
    """후보가 실린 응답을 읽어도 기존 타입의 필드·repr·asdict·동등성은 그대로다 (후보는 ParseResult.ocr_line_candidates 로만)."""
    assert [f.name for f in dataclasses.fields(OcrLine)] == ["text", "box", "confidence", "dropped"]
    assert [f.name for f in dataclasses.fields(OcrPageLines)] == ["page_number", "width", "height", "scale", "deskew_angle", "regions_only", "lines"]
    assert Image.__slots__ == ("filename", "mime_type", "source", "path", "byte_length", "_b64")
    line = ParseResult(FIX["responses"][8]["result"]).ocr_lines[0].lines[0]
    assert line == OcrLine("대한민국 정부 2026", OcrBox(118, 105, 640, 60), 0.9868)
    assert repr(line) == "OcrLine(text='대한민국 정부 2026', box=OcrBox(x=118, y=105, w=640, h=60), confidence=0.9868, dropped=False)"
    assert dataclasses.asdict(line) == {"text": "대한민국 정부 2026", "box": {"x": 118, "y": 105, "w": 640, "h": 60}, "confidence": 0.9868, "dropped": False}


def test_decode_ocr_chars() -> None:
    r = ParseResult(FIX["responses"][9]["result"])
    [page] = r.ocr_chars
    assert page[0] == (OcrChar("정", OcrBox(118, 105, 58, 60), 0.99),
                       OcrChar("부", OcrBox(176, 105, 62, 60), 0.81, (OcrCharAlternative("투", 0.15), OcrCharAlternative("무", 0.02))))
    # 줄과 같은 자리 — 글자가 없는 줄(표기 후처리로 글이 바뀐 줄 등)은 빈 튜플
    assert len(page) == len(r.ocr_lines[0].lines) == 2 and page[1] == ()
    # 옵션을 안 준 결과는 줄마다 빈 튜플, ocrLines 가 없으면 빈 목록. 기존 OcrLine 은 그대로
    assert ParseResult(FIX["responses"][5]["result"]).ocr_chars == [[(), ()], [()]]
    assert ParseResult(FIX["responses"][0]["result"]).ocr_chars == []
    assert r.ocr_lines[0].lines[0] == OcrLine("정부", OcrBox(118, 105, 120, 60), 0.9)


def test_decode_ocr_dewarp() -> None:
    r = ParseResult(FIX["responses"][5]["result"])
    # 페이지와 같은 자리 — 행마다 편 페이지만 기준점이 있고, 나머지 페이지는 None
    assert r.ocr_dewarp == [OcrDewarp(629.5, ((60, 1.8), (330, -0.6))), None]
    assert len(r.ocr_dewarp) == len(r.ocr_lines)
    # ocrLines 가 없으면 빈 목록. 기존 OcrPageLines 는 그대로(펴도 deskew_angle 은 0)
    assert ParseResult(FIX["responses"][0]["result"]).ocr_dewarp == []
    assert r.ocr_lines[0].deskew_angle == 0
