# Benchmark details

Scoring rules, reproduction steps and per-option results behind the README [Validation](../README-EN.md#validation) section. Internal corpora are checked by `npm run bench:gate` and mandatory release gates. The external opendataloader-bench is measured separately.

## Latest release results: 4.21.12 · 2026-10-10

All benches measured on the 4.21.12 dist on 2026-10-10 (`node bench/suite.mjs run`). Compared document by document with the previous release 4.21.11, no document is lower in PDF text, tables, statute annexes, score, OCR, degraded OCR, other formats, roundtrip, generation or the four ODL modes.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,424 documents · 10,342 tables | Structure match 10,342/10,342 · 100%; exact cell text 99.9983%; content NED similarity 99.9955% |
| HWP 5.x ↔ HWPX | 1,130 pairs · 4,315 tables | Paired-document structure match 4,315/4,315 · 100% |
| PDF text | 744 pairs | Recall 99.83%, precision 99.64%, order 99.16%, word-boundary F1 98.87% |
| PDF tables | 708 pairs · 2,331 tables | Detection 99.83%, structure match 97.98%, cell F1 0.991228 |
| Statute annexes | 272 documents · 346 tables | HWP structure match 346/346; PDF 335/346 · 96.82% |
| All PDFs | 1,729 scored out of 1,911 documents | Text coverage 99.80% |
| OCR | 53 documents · 102 pages | CER 0.0412, character recall 99.03%, precision 99.33%, Hangul recall 99.40% |
| Other formats / roundtrip / fuzz | 146 documents (27 PPTX) / 75 roundtrips / 25,152 fuzz cases | Release gates passed |

Structure scores do not imply perfect visual fidelity or exact text in every cell. The 75 roundtrip cases and 8 generation fixtures are counted separately.

## PDF → Markdown — opendataloader-bench

[opendataloader-bench](https://github.com/opendataloader-project/opendataloader-bench) scores 200 PDFs (papers, reports, slides, posters, scans) against human-made ground truth for **reading order (NID), table structure (TEDS) and heading hierarchy (MHS)** (1.0 = identical to the ground truth).

### Latest separate verification: 4.21.5 · 2026-10-09

| Setting | Overall | Reading order | Tables | Headings |
| --- | ---: | ---: | ---: | ---: |
| Default | 0.963 | 0.963 | 0.980 | 0.948 |
| Default + `plain: true, htmlTables: true` | 0.974 | 0.979 | 0.983 | 0.958 |
| `ocr: true` | 0.964 | 0.964 | 0.980 | 0.954 |
| `ocr: false` | 0.939 | 0.939 | 0.937 | 0.934 |

Each mode covers 200 documents, with zero failures or missing outputs (`node bench/suite.mjs run <tag> --only=odl,odlbest,odlocr,odlfast`). No document is lower than 4.21.3 (default 0.958) in any mode. Against 4.18.6 (2026-10-02: default 0.960, `plain+htmlTables` 0.972, `ocr: false` 0.937) the default is +0.002 and `ocr: false` +0.001; three documents (100, 134, 115, −0.004 combined) stay slightly below 4.18.6 because OCR'd figure labels group into lines a little differently ([session record](quality-campaign-session-2026-10-09.md)).

### Full option sweep: historical results, 2026-09-29

| Setting | Overall | Reading order | Tables | Headings | Time / page |
| --- | ---: | ---: | ---: | ---: | ---: |
| default (OCR model cached) | 0.960 | 0.961 | 0.979 | 0.945 | 0.52 s |
| default + `plain: true` | 0.968 | 0.969 | 0.981 | 0.952 | 0.52 s |
| default + `plain: true, htmlTables: true` | 0.972 | 0.976 | 0.983 | 0.955 | 0.52 s |
| `ocr: false` (= default without the OCR model) | 0.937 | 0.938 | 0.936 | 0.933 | 0.04 s |
| `ocr: false, plain: true` | 0.946 | 0.948 | 0.937 | 0.940 | 0.04 s |
| `ocr: false, plain: true, htmlTables: true` | 0.949 | 0.954 | 0.940 | 0.943 | 0.04 s |
| `ocr: true` | 0.960 | 0.960 | 0.979 | 0.949 | 0.57 s |
| `ocr: true, plain: true` | 0.967 | 0.968 | 0.981 | 0.956 | 0.57 s |
| `ocr: true, plain: true, htmlTables: true` | 0.973 | 0.977 | 0.983 | 0.959 | 0.58 s |

Time per page: 200 documents parsed sequentially in one process on an Apple M4 24GB, 2026-09-29 (scoring excluded).

### What the options do

- **Default OCR** — when the OCR model is already cached (`kordoc models`, or an earlier `ocr: true`), **pages without a text layer (scans, glyphs drawn as curves)** and **text inside large images (over 5% of the page) that have no text layer** are read automatically (72 of 200 documents). Without a cached model nothing is downloaded; `NEEDS_OCR` / `SKIPPED_IMAGE` warnings are raised.
- **`ocr: true`** — also reads small images (over 2% of the page) and page-header logos. **`ocr: false`** turns the automatic OCR off too (fastest).
- **`plain: true`** — drops image placeholders, link URLs and underline/bold marks for indexing and RAG. The ground truth has none of these, so the score rises too.
- **`htmlTables: true`** — emits every table as indented HTML.

### Reproduction

- Other engines' scores are the benchmark repository's published results (Apple M4 32GB).
- kordoc used the same PDFs, ground truth and the **unmodified evaluator** (Apple M4 24GB, 200 documents sequentially in one process).
- Re-scoring the repository's opendataloader-hybrid predictions with the same evaluator gives 0.9066, matching its published score.
- Run: `node bench/odl-bench.mjs <bench clone>`, then the benchmark's `src/evaluator.py`.

### Published engine comparison: historical results, 2026-09-29

Preserved from the earlier README. These are historical results, not current rankings or a same-hardware performance comparison. See the 4.18.6 table above for the latest verified kordoc scores.

| Rank | Engine | Overall | Reading order | Tables | Headings | Time / page |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| **1** | **kordoc default** | **0.960** | **0.961** | **0.979** | **0.945** | **0.52 s** |
| ref. | kordoc `ocr: false` (fastest) | 0.937 | 0.938 | 0.936 | 0.933 | 0.04 s |
| ref. | kordoc `ocr: true, plain: true, htmlTables: true` | 0.973 | 0.977 | 0.983 | 0.959 | 0.58 s |
| 2 | opendataloader-hybrid | 0.907 | 0.934 | 0.928 | 0.821 | 0.46 s |
| 3 | nutrient (commercial) | 0.885 | 0.925 | 0.708 | 0.819 | 0.01 s |
| 4 | docling | 0.882 | 0.898 | 0.887 | 0.824 | 0.76 s |
| 5 | marker | 0.861 | 0.890 | 0.808 | 0.796 | 53.9 s |
| 6 | unstructured-hires | 0.841 | 0.904 | 0.588 | 0.749 | 3.01 s |
| 7 | edgeparse | 0.837 | 0.894 | 0.717 | 0.706 | 0.04 s |
| 8 | mineru | 0.831 | 0.857 | 0.873 | 0.743 | 5.96 s |
| 9 | opendataloader | 0.831 | 0.902 | 0.489 | 0.739 | 0.02 s |
| 10 | pymupdf4llm | 0.732 | 0.885 | 0.401 | 0.412 | 0.09 s |
| 11 | unstructured | 0.686 | 0.882 | 0.000 | 0.388 | 0.08 s |
| 12 | markitdown | 0.589 | 0.844 | 0.273 | 0.000 | 0.11 s |
| 13 | liteparse | 0.576 | 0.866 | 0.000 | 0.000 | 1.06 s |

### LM-Kit One historical comparison (2026-09-29, then-unmerged PR #34)

LM-Kit One (commercial; results-only PR) reports 0.948 without OCR and 0.963 with OCR. Most of the gap is table markup — it writes cells in the ground truth's HTML shape (`<td> text </td>`, header rows as `<td>`). Normalised to the same markup, kordoc `plain` scores 0.951 vs LM-Kit 0.948; with `htmlTables` kordoc leads both rows: 0.949 without OCR, 0.973 with OCR.

## Korean government documents — scored against the original HWPX

Real government documents (press releases, approval documents, statutory forms, budgets) for which both the HWPX original and its PDF export exist; text and tables extracted from the PDF are scored with the original as ground truth.

### Scoring rules

Revised 2026-09-29; visible-table criteria introduced 2026-09-30; reference extractor corrected in 4.18.1. See the [CHANGELOG](../CHANGELOG.md). Reference corrections and actual input-field preservation fixes are distinguished in the [original audit](release-4.18.1.json).

**Table ground truth = the tables you see in the original** (v4.17.0)
- Tables are split the way their cell borders draw them (header.xml borderFill; line type NONE and white lines are invisible). `bench/ref/visible-tables.mjs`, no code shared with the parser.
- A row with a visible vertical edge, or with two or more cells between full-width horizontal rules, is a table row; each run of table rows is one visible table. Other rows are text (still counted in text recall).
- Gridlines no cell edge uses, empty indent cells outside the ruled extent, blank spacer rows without lines, and trailing empty columns are folded.
- A fraction built from two cells and a rule is an equation (removed from the text population, counted once in equation presence). Two full-width cells count as a fraction only in a 2×1 table.
- Image check against Hancom PDFs of statute annexes (66 original pages, 50 visible tables): 42/50 matched, 48/50 after the spacer-row (A1) and fraction false-positive (P1) fixes. The remaining two are a continued row and a formula inside a bordered box, one case each, so no rule was added.

**Statute annexes** (`bench/annex-gt.mjs`)
- The HWP original and the Hancom PDF of 272 statute annexes from the Ministry of Government Legislation (licbyl-byl, licbyl-byl2), scored against the same ground truth. PDFs are parsed with `ocr: false` (same as the Korean Law MCP and lexdiff servers).

**PDF text**
- Reading order: a line that appears several times counts at its in-order occurrence.
- Floating text boxes and lines without letters or digits (masking "*****") are excluded from order scoring only.
- List markers "- " and the footnote wrapper "(주: …)" are stripped from both plain texts.

**PDF text/table population**
- Pairs whose PDF is a different edition (PDF text over 3×) are excluded.
- Pairs whose PDF text layer (pdftotext) holds less than 93% of the ground-truth characters (render-defect repros etc.) are excluded.
- PDF coverage removes leader-dot runs.

**OCR**
- Sample pages are fixed (`bench/ocr-pages.json`).
- OCR text inside image regions with no text-layer text is left out of the character comparison (for logos mixed into a body block, only the surplus explained by reading the image alone).
- Text-layer text that is never drawn (white or covered text) is left out of the character comparison.
- Pages that draw in-line characters as images are dropped from the sample.
- Characters pixels cannot tell apart are folded — middle dots · • ∙, unit ㎡ vs m², corner brackets ｢｣ 「」.
- Table rows whose value cells stack several lines side by side are unfolded by line index.

## HWP · HWPX → Markdown — against HwpForge

The same corpus converted by [HwpForge](https://github.com/ai-screams/HwpForge) 0.16.6 (`to_md`, lossy) and by kordoc, both scored against the **original HWPX XML** with the same scorer. Tables from both outputs go through the same Markdown table parser; single-column tables are excluded.

- **Table gap** — HwpForge focuses on generation and editing; its Markdown uses pipe tables only, so merged cells cannot be expressed.
- **Why single-column tables are excluded** — the 1,288 single-column tables are decorative frames (43% title/body boxes, 28% blank spacer frames, 3% lists), so table vs. lines is a presentation choice and their text is scored by text recall. Including them: HWPX 10,392 tables, kordoc 90.6% vs HwpForge 36.0%; HWP 3,500 tables, 92.8% vs 32.1%.
- **HWP document count** — excludes one pair whose HWPX is distribution-encrypted (no ground truth).
- **Reproduce** — `bench/hwpforge-bench.py`, then `node bench/compare-md-parsers.mjs <output dir>` (`--include-single-col` to include single-column tables).

### v4.16 comparison record (earlier HWPX XML structure criteria, separate from current visible-table scoring)

| | kordoc | HwpForge 0.16.6 |
| --- | ---: | ---: |
| HWPX, 2,305 docs — conversion failures | **0** | 123 |
| HWPX — text recall (converted docs only) | **100.00%** (100.00%) | 59.23% (98.64%) |
| HWPX — exact tables (9,123) | **100.0%** (9,122) | 32.2% |
| HWPX — cell F1 | **1.000** | 0.428 |
| HWP 5.x, 1,108 docs — conversion failures | **0** | 19 |
| HWP — text recall | **100.00%** | 86.41% |
| HWP — exact tables (3,111) | **100%** | 27.0% |
| HWP — cell F1 | **1.000** | 0.349 |
