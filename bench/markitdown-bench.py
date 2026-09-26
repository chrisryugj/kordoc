#!/usr/bin/env python3
"""Local MarkItDown comparison; leaves PDFs, GT and evaluator untouched.

Install in a separate venv: uv pip install 'markitdown[pdf]==0.1.8'
Usage: python bench/markitdown-bench.py PDF_DIR PREDICTION_ENGINE_DIR
Then run the original ODL evaluator against that engine directory.
"""
import argparse
import importlib.metadata
import json
import logging
from pathlib import Path
import resource
import sys
import time

from markitdown import MarkItDown

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pdf_dir", type=Path)
parser.add_argument("output_dir", type=Path)
args = parser.parse_args()
logging.getLogger("pdfminer").setLevel(logging.ERROR)
output = args.output_dir / "markdown"
output.mkdir(parents=True, exist_ok=True)
converter = MarkItDown(enable_plugins=False)
rows = []
start = time.perf_counter()
for pdf in sorted(args.pdf_dir.glob("*.pdf")):
    began = time.perf_counter()
    try:
        result = converter.convert(str(pdf))
        (output / (pdf.stem + ".md")).write_text(result.text_content, encoding="utf-8")
        row = {"document_id": pdf.stem, "ok": True}
    except Exception as error:
        row = {"document_id": pdf.stem, "ok": False, "error": str(error)}
    row["seconds"] = time.perf_counter() - began
    rows.append(row)
report = {
    "versions": {name: importlib.metadata.version(name) for name in ("markitdown", "pdfminer.six", "pdfplumber")},
    "options": {"enable_plugins": False, "llm_client": None, "docintel_endpoint": None},
    "seconds": time.perf_counter() - start,
    "maxRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
    "rows": rows,
}
(args.output_dir / "performance.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in report.items() if key != "rows"}))
if not rows or any(not row["ok"] for row in rows):
    sys.exit(1)
