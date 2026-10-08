"""parse-worker protocol 2 메시지 — 요청 만들기·옵션 이름 변환. 검증의 정본은 워커다."""

from __future__ import annotations

import os
from typing import Any

PROTOCOL = 2

#: Python 키워드 인자 → wire(camelCase) 옵션 이름. 워커 허용 목록과 같다 (docs/parse-worker-protocol.md)
OPTION_NAMES: dict[str, str] = {
    "table_format": "tableFormat",
    "html_tables": "htmlTables",
    "layout_tables": "layoutTables",
    "classify_tables": "classifyTables",
    "tables": "tables",
    "plain": "plain",
    "script_tags": "scriptTags",
    "remove_header_footer": "removeHeaderFooter",
    "dedupe_running_headers": "dedupeRunningHeaders",
    "keep_trailing_empty_cols": "keepTrailingEmptyCols",
    "keep_empty_paragraphs": "keepEmptyParagraphs",
    "include_field_placeholders": "includeFieldPlaceholders",
    "pages": "pages",
    "images": "images",
    "inline_images": "inlineImages",
    "ocr": "ocr",
    "formula_ocr": "formulaOcr",
    "password": "password",
}


def wire_options(options: dict[str, Any]) -> dict[str, Any]:
    """키워드 인자 → wire options. 값이 None 인 키는 빼서 엔진 기본값을 쓴다(False 는 그대로 넘긴다)."""
    out: dict[str, Any] = {}
    for key, value in options.items():
        if key not in OPTION_NAMES:
            raise TypeError(f"지원하지 않는 파싱 옵션: {key}")
        if value is None:
            continue
        out[OPTION_NAMES[key]] = list(value) if key == "pages" and not isinstance(value, str) else value
    return out


def parse_request(request_id: int, file: str | os.PathLike[str], options: dict[str, Any],
                  image_transport: str = "inline", assets_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    if image_transport not in ("inline", "files"):
        raise ValueError('image_transport 는 "inline" 또는 "files" 입니다')
    msg: dict[str, Any] = {"id": request_id, "cmd": "parse", "file": os.path.abspath(os.fspath(file))}
    wire = wire_options(options)
    if wire:
        msg["options"] = wire
    if image_transport == "files":
        if assets_dir is None:
            raise ValueError('image_transport="files" 는 assets_dir 가 필요합니다')
        msg["transport"] = {"images": "files", "assetsDir": os.path.abspath(os.fspath(assets_dir))}
    return msg
