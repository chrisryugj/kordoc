"""SDK 테스트 공통 — 실제 엔진(빌드한 dist/cli.js)과 합성 문서·Node parse() 기대 결과.

KORDOC_CLI: 엔진 진입점 (기본: 저장소 dist/cli.js — `npm run build` 필요)
KORDOC_NODE: Node 실행 파일 (기본: PATH 의 node)
KORDOC_SDK_FIXTURES: tests/fixtures/sdk-docs.ts 가 만든 디렉터리 (없으면 그 스크립트로 임시 생성 — 저장소 node_modules 필요)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FAULT_WORKER = REPO / "sdk" / "fixtures" / "fault-worker.mjs"
PROTOCOL_FIXTURE = REPO / "sdk" / "fixtures" / "protocol-v2.json"


def node_path() -> str:
    node = os.environ.get("KORDOC_NODE") or shutil.which("node")
    if not node:
        pytest.skip("node 가 없습니다")
    return node


@pytest.fixture(scope="session")
def engine_cli() -> str:
    cli = os.environ.get("KORDOC_CLI") or str(REPO / "dist" / "cli.js")
    if not Path(cli).exists():
        pytest.fail(f"엔진이 없습니다: {cli} — 저장소에서 `npm run build` 하거나 KORDOC_CLI 를 지정하세요")
    return cli


@pytest.fixture(scope="session")
def sdk_fixtures(tmp_path_factory: pytest.TempPathFactory) -> Path:
    given = os.environ.get("KORDOC_SDK_FIXTURES")
    if given:
        return Path(given)
    out = tmp_path_factory.mktemp("sdk-fixtures")
    subprocess.run([node_path(), "--import", "tsx", str(REPO / "tests" / "fixtures" / "sdk-docs.ts"), str(out)],
                   cwd=REPO, check=True)
    return out


@pytest.fixture(scope="session")
def manifest(sdk_fixtures: Path) -> list[dict]:
    return json.loads((sdk_fixtures / "manifest.json").read_text("utf-8"))


@pytest.fixture
def engine(engine_cli: str) -> dict:
    """KordocClient(**engine) 로 실제 엔진에 붙는다."""
    return {"node": node_path(), "cli": engine_cli}


def fault(mode: str, **env: str) -> dict:
    """KordocClient(**fault("hang")) — 장애 주입 워커."""
    return {"node": node_path(), "cli": str(FAULT_WORKER), "env": {"KORDOC_FAULT": mode, **env}}


SNAKE = {
    "tableFormat": "table_format", "htmlTables": "html_tables", "layoutTables": "layout_tables",
    "classifyTables": "classify_tables", "scriptTags": "script_tags", "removeHeaderFooter": "remove_header_footer",
    "dedupeRunningHeaders": "dedupe_running_headers", "keepTrailingEmptyCols": "keep_trailing_empty_cols",
    "keepEmptyParagraphs": "keep_empty_paragraphs", "includeFieldPlaceholders": "include_field_placeholders",
    "inlineImages": "inline_images", "formulaOcr": "formula_ocr",
}


def kwargs_of(options: dict) -> dict:
    return {SNAKE.get(k, k): v for k, v in options.items()}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # 좀비(회수 전)도 kill 0 은 성공한다 — SDK 가 wait 로 회수했는지는 ps 로 본다
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")
