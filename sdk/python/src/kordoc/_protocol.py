"""parse-worker protocol 2 메시지 — 요청 만들기·옵션 이름 변환. 검증의 정본은 워커다."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

PROTOCOL = 2

#: Python 키워드 인자 → wire(camelCase) 옵션 이름. 워커 허용 목록과 같다 (docs/parse-worker-protocol.md)
OPTION_NAMES: dict[str, str] = {
    "table_format": "tableFormat",
    "html_tables": "htmlTables",
    "html_cell_links": "htmlCellLinks",
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
    "qr_codes": "qrCodes",
    "image_format": "imageFormat",
    "image_placement": "imagePlacement",
    "drop_blank_images": "dropBlankImages",
    "ocr": "ocr",
    "ocr_lines": "ocrLines",
    "ocr_det": "ocrDet",
    "ocr_det_long_side": "ocrDetLongSide",
    "ocr_rec": "ocrRec",
    "ocr_rec_dict": "ocrRecDict",
    "formula_ocr": "formulaOcr",
    "password": "password",
}


@dataclass(frozen=True)
class OcrModelFile:
    """로컬 OCR 모델 파일 — ``ocr_det``·``ocr_rec``·``ocr_rec_dict`` 에 준다. 엔진이 로드 전에 SHA-256 을 대조하고 다르면 거부한다.

    path: 모델 파일 경로. 상대 경로는 이 프로세스의 현재 디렉터리 기준 절대 경로로 바꿔 보낸다(워커의 현재 디렉터리와 다를 수 있다).
    sha256: 기대 SHA-256 (16진 64자).
    """

    path: str | os.PathLike[str]
    sha256: str


#: {path, sha256} 를 받는 옵션 — ocr_det 은 "mobile"·"server", ocr_rec 은 "handwriting" 문자열도 받는다
_MODEL_FILE_OPTIONS = ("ocr_det", "ocr_rec", "ocr_rec_dict")


def _model_file(key: str, value: Any) -> Any:
    """OcrModelFile·{"path", "sha256"} 매핑 → wire {path(절대), sha256}. 문자열(ocr_det 의 "mobile"·"server", ocr_rec 의 "handwriting")과 그 밖의 값은 그대로 — 검증은 워커가 한다."""
    if isinstance(value, OcrModelFile):
        path, sha = value.path, value.sha256
    elif isinstance(value, Mapping) and set(value) == {"path", "sha256"}:
        path, sha = value["path"], value["sha256"]
    elif isinstance(value, os.PathLike):
        raise TypeError(f"{key} 는 OcrModelFile(path, sha256) 로 줍니다 — 경로만으로는 줄 수 없습니다(SHA-256 필수)")
    else:
        return value
    if not isinstance(path, (str, os.PathLike)):
        raise TypeError(f"{key} 의 path 는 경로여야 합니다")
    return {"path": os.path.abspath(os.fspath(path)), "sha256": sha}


def wire_options(options: dict[str, Any]) -> dict[str, Any]:
    """키워드 인자 → wire options. 값이 None 인 키는 빼서 엔진 기본값을 쓴다(False 는 그대로 넘긴다)."""
    out: dict[str, Any] = {}
    for key, value in options.items():
        if key not in OPTION_NAMES:
            raise TypeError(f"지원하지 않는 파싱 옵션: {key}")
        if value is None:
            continue
        if key == "pages" and not isinstance(value, str):
            value = list(value)
        elif key in _MODEL_FILE_OPTIONS:
            value = _model_file(key, value)
        out[OPTION_NAMES[key]] = value
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
