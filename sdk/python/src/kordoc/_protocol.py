"""parse-worker protocol 2 메시지 — 요청 만들기·옵션 이름 변환. 검증의 정본은 워커다."""

from __future__ import annotations

import json
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


def encode_request(msg: dict[str, Any], max_bytes: int) -> bytes:
    """요청 한 줄(UTF-8, 끝 줄바꿈 포함). 워커 자리를 받기 전에 만든다 — 직렬화할 수 없는 값·NaN·Infinity·인코딩할 수 없는 경로
    (TypeError·ValueError)와 상한 초과(KordocProtocolError REQUEST_TOO_LARGE)를 멀쩡한 워커를 버리지 않고 여기서 돌려준다.
    워커는 상한을 넘은 줄과 JSON 이 아닌 줄을 해석하기 전에 거부해 응답에 id 를 붙일 수 없어, 보내고 나면 워커 장애와 구분되지 않는다."""
    from ._errors import KordocProtocolError

    try:
        text = json.dumps(msg, ensure_ascii=False, allow_nan=False)  # NaN·Infinity 는 JSON 이 아니다 — 워커가 줄째 거부한다
    except ValueError as e:
        try:
            json.dumps(msg, ensure_ascii=False)
        except ValueError:
            raise  # NaN·Infinity 가 아닌 오류(순환 참조 등) — 원래 메시지 그대로
        raise ValueError(f"요청에 JSON 으로 나타낼 수 없는 값이 있습니다(NaN·Infinity): {e}") from None
    try:
        line = (text + "\n").encode("utf-8")
    except UnicodeEncodeError as e:
        raise ValueError(f"요청을 UTF-8 로 인코딩할 수 없습니다(짝 없는 서로게이트 등): {e}") from None
    if len(line) > max_bytes:
        raise KordocProtocolError("REQUEST_TOO_LARGE", f"요청이 상한({max_bytes}바이트)을 넘습니다")
    return line
