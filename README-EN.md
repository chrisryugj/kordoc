# kordoc

**모두 파싱해버리겠다** — Parse them all.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)

> *Korea's document hell is second to none. Built by a civil servant who survived seven years in it.*

Convert HWP 3.x/5.x, HWPX, HWPML, PDF, XLS/XLSX, DOCX, PPTX and PNG/JPG/WebP to Markdown and structured data. Use it as a library, CLI or MCP server.

[한국어](README.md) · [Usage guide](docs/usage-en.md) · [Benchmarks](docs/benchmarks-en.md) · [Changelog](CHANGELOG.md)

- 📊 **0.963 overall on the public PDF benchmark** — opendataloader-bench, 200 documents. Ranked first against 12 published parsers in the 2026-09-29 comparison. [Measurement details](docs/benchmarks-en.md)
- 🇰🇷 **100% Korean document table structure match** — all **10,342 visible tables** from 2,424 original HWPX documents. [4.21.21 verification](docs/benchmarks-en.md)

If this saves you time, a GitHub ⭐ helps others find it.

[![kordoc — watch the demo](./docs/video-demo.jpg)](https://youtu.be/Q13GmgDcIw0)

<sub>▶ Click to play on YouTube. Narration is in Korean.</sub>

**New video:** [kordoc 공개벤치 1위 마크 — public benchmark](https://youtu.be/9kRbwiTRQLs) · 2026-09-27 · 1 min 31 sec · Korean

## Install

Node.js **20+** · macOS / Linux / Windows

```bash
npm install kordoc
```

Run the CLI without installing it globally: `npx kordoc`. PDF/OCR dependencies are installed by default; omitting them with `--omit=optional` limits those features.

**Connect an AI agent**

```bash
npx -y kordoc setup
```

Registers MCP with installed clients such as Claude Desktop, Claude Code, Cursor and Codex. Restart the client to use **17 tools** for parsing, comparison, generation, rendering and more.

Claude Code plugin:

```text
/plugin marketplace add chrisryugj/kordoc
/plugin install kordoc@kordoc
```

[Manual MCP setup and installation troubleshooting](docs/usage-en.md)

## Quick start

### CLI

```bash
npx kordoc document.hwpx -o document.md
npx kordoc *.pdf --jobs 4 -d ./output
npx kordoc document.pdf --format json --pages 1-3
npx kordoc scan.pdf --ocr -o scan.md
npx kordoc generate report.md --preset report -o report.hwpx
npx kordoc fill --template gian -j values.json -o draft.hwpx
```

`--jobs` converts files in parallel and increases memory use. [Batch conversion details](docs/parallel-batch.md)

For the report, plan, gaejosik and bangchim presets, a blockquote right after the `#` title (`> …하고자 함`) becomes the summary box (gaejosik puts it under the title box on the first body page when the cover is on, the default; with `cover: false` the first `#` is a chapter header and the quote stays a ※ note). Keep it to one sentence (commas allowed) within three lines; longer or multi-sentence summaries produce a warning. For ministry, `> ▪ …` blockquotes become performance summary boxes wherever they appear.

### JavaScript / TypeScript

```typescript
import { parse, markdownToHwpx } from "kordoc"
import { writeFile } from "node:fs/promises"

const result = await parse("document.hwpx")
if (result.success) {
  console.log(result.markdown)
  // result.blocks: structured data; result.metadata: document metadata
}

const hwpx = await markdownToHwpx("# Plan\n\nBody text", {
  gongmun: { preset: "report" },
})
await writeFile("report.hwpx", Buffer.from(hwpx))
```

[Parse options, APIs, forms and rendering examples](docs/usage-en.md#-quick-start)

## Features

| Task | Capabilities |
| --- | --- |
| Read | Markdown, IR, page text, RAG chunks and local OCR |
| Compare and edit | Block/cell diffs, format-preserving HWPX/HWP patches |
| Create | Markdown → HWPX, government-document presets, tables, equations and charts |
| Fill forms | Fields, click-here controls, two draft templates and seal placement |
| Review | HWPX/HWP previews and region crops, validation, style checks and PII masking |

Extract Markdown for format-preserving patches with `--keep-layout-tables`. Unsupported edits are skipped with a reason. [Full CLI and API reference](docs/usage-en.md#-cli)

## Validation

**4.21.21 release verification · 2026-10-11**. Results use fixed corpora and reference criteria.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,424 documents · 10,342 tables | Table structure match **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130 pairs · 4,315 tables | Paired-document table structure match **100%** |
| PDF text | 744 pairs | Character recall **99.85%** · precision **99.67%** · reading order **99.23%** · word-boundary F1 **99.02%** |
| PDF tables | 708 pairs · 2,331 tables | Detection **99.83%** · structure match **97.98%** · cell F1 **0.991** |
| All PDFs | 1,729 scored out of 1,911 documents | Text coverage **99.80%** |
| OCR | 53 documents · 102 pages | CER **0.0412** · character recall **99.02%** |

Table structure, cell content and visual fidelity are separate metrics. See [benchmark details](docs/benchmarks-en.md) for scope, exclusions and the per-document comparison of every bench.

The external **opendataloader-bench, 200 documents** was measured with the 4.21.21 release: overall **0.963** with defaults, **0.939** with OCR off. [Options and reproduction](docs/benchmarks-en.md#pdf--markdown--opendataloader-bench)

## Recent updates

Latest release: **[4.21.21](https://github.com/chrisryugj/kordoc/releases/tag/v4.21.21)** · 2026-10-11

| Version | Highlights |
| --- | --- |
| 4.21.21 | PDF: footers absorbed inside a page border box are stripped, and form labels ("<붙임2>", "<별지 서식 제3호>") and lecture numbers are no longer taken for running headers (PDF text precision 99.64 → 99.67%, word-boundary F1 99.00 → 99.02%) |
| 4.21.20 | PDF: a borderless table cell line wrapped mid-word is joined ("남⏎편이") · form fill and patch keep formatting (layout cache cleared only for changed paragraphs, emphasis markers, spread spacing, label cell direction) (PDF word-boundary F1 98.987 → 98.998%) |
| 4.21.19 | PDF: a ruled grid bundling stacked clip tables with the text between them is dropped — region headers and footnotes stay with their tables (PDF reading order 99.16 → 99.23%) |
| 4.21.18 | PDF: the page-break paragraph join also keeps a word boundary at a trailing space glyph — "지원⏎활동이", "계정⏎정보를" (PDF word-boundary F1 98.986 → 98.987%, 5 documents up) |
| 4.21.17 | PDF: a full line ending without a space glyph before a Latin gloss is joined — "공적개발원조⏎(ODA)", "하네스⏎(safety …)" (PDF word-boundary F1 98.98 → 98.99%) |
| 4.21.16 | PDF tables: a page-split row whose cell continues a quantity — header cell "30%" / next page "미만" is one cell; gongmun autoFit.safety (one-line fit margin for other renderers) (statute annex PDF tables 97.40 → 97.69%) |
| 4.21.15 | PDF line-end space glyphs mark word-boundary wraps — wraps the source had spaced ("이루어⏎진다면") are no longer glued (PDF word-boundary F1 98.89 → 98.98%) |
| 4.21.14 | Unmapped Hancom PDF symbols restored — auto bullets and brackets written as U+F000 come back from their font outlines as "▸", "□", "《》", "↓" and more; text-layer coverage scoring change (PDF word-boundary F1 98.87 → 98.89%, text recall 99.83 → 99.84%) |
| 4.21.13 | PDF statute-annex rows across pages — a serial number moving on starts a new row, "가)" items count as item heads, a long cell flowing across a page spans both rows; parse-worker ends quietly on a closed stdout (#142) (annex PDF table structure match 96.82 → 97.40%, no document down) |
| 4.21.12 | PDF cell digits, crossing text boxes, spread labels and script overlap — digit lines joined only when they fill the cell, overlapping text boxes read as prose, spread two-syllable row labels joined, attached scripts may overlap their host by a quarter em (PDF word-boundary F1 98.86 → 98.87%, ODL table TEDS 0.9799 → 0.9802, no document down) |
| 4.21.11 | PDF contents pages, title-tab boxes and cell scripts — TOC leaders dropped, a box with a title chip read as prose, TOC titles paired with their page numbers, attached scripts in form cells (PDF text precision 99.58 → 99.64%, OCR CER 0.0421 → 0.0412, no document down; degraded OCR sampled three other pages) |
| 4.21.10 | PDF flow-chart tables and parenthetical glosses — a borderless candidate spanning a ruled table is dropped, a break before a short gloss is joined (word-boundary F1 98.84 → 98.85%, OCR CER 0.0443 → 0.0421, no document down) |
| 4.21.9 | PDF line-break joining — breaks inside words, stacked particles, copulas, suffixes, noun+하다; superscript rows absorbed into their line (word-boundary F1 98.81 → 98.84%, text coverage 99.79 → 99.80%, no document down) |
| 4.21.8 | PDF table batch — tables printed sideways, data tables taken for charts, narrow digit columns, one text run across cells, stacked amounts in a cell (OCR CER 0.0445 → 0.0443, degraded-scan OCR 0.0821 → 0.0805, no document down) |
| 4.21.7 | PDF pieced column rules, text-run clips and contact tables — budget detail cells (OCR CER 0.0512 → 0.0445), fake tables from ezPDF and MS Print text-run clips, six-column contact tables (degraded-scan OCR 0.0954 → 0.0821, text coverage 99.78 → 99.79%, no document down) |
| 4.21.6 | Press-release contact tables split per department and per person (PDF table structure match 97.94→97.98%), XLSX/XLS cells past column 200 kept, HWP3 embedded pictures extracted, formula OCR keeps LaTeX commands whole, PPTX formats track and a larger corpus (HWP3 75, formats 58, rhwp 230) |
| 4.21.5 | PDF quality batch — the #141 OCR side effect that boxed two-column text into tables, figure OCR label grouping and single-digit ticks, bare links, vector chart value axes, column tails and footnotes (ODL default 0.958 → 0.963, no document down); gaejosik/report summary boxes survive md→hwpx→md→hwpx |
| 4.21.4 | MCP `fill_form` takes values from a JSON `fields_file` (values stay out of the conversation; the reply shows only their lengths); `bench/suite.mjs` runs every bench and compares two runs per document |
| 4.21.3 | PDF formula OCR drops unpaired `\left`/`\right` |
| 4.21.2 | Gaejosik: the summary quote after the title becomes a 1×1 summary box (was a ※ note), with three-line and one-sentence checks; HWP3 nesting limit and a cumulative decompression cap for encrypted HWPX |
| 4.21.1 | Image OCR: fragments of one visual line no longer split and reorder, and item rows in borderless receipt tables no longer merge (#141) |
| 4.21.0 | Central-ministry house styles `--agency` (level fonts and sizes, ◦/❍ level-2 bullets, table header and agency colour measured on 2,670 press releases from 52 agencies), per-person rows in the press contact table (`--press-people`), wider generation metrics for fonts without width tables |
| 4.20.0 | 7 new notation lint rules plus linting documents directly, body↔table number checks and per-level style deviations; learn level styles from a sample HWPX (`levels`, `--levels-from`); `compare` and `patch --json`; patch integrity checks; chat-paste cleanup |
| 4.19.2 | Ports rhwp v0.8.7 parser fixes — HWP3 checkbox □, HWP5 unpaired surrogates as □, lenient CFB recovery reading the right body stream, HWPX decompression cap enforced while inflating each entry |
| 4.19.1 | PDF per-page Markdown (`pages`) splits cross-page tables back into their pages, so later-page rows and boxes no longer land on the previous page or drop a page entry (#136) |
| 4.19.0 | `tableFormat: "gfm"` for RAG indexing — merged and nested tables as GFM pipe tables, no HTML; nested tables move out with parent/child markers (#138) |
| 4.18.12–13 | Retune PDF cross-page paragraph joins against HWPX/DOCX originals — sentence ends, first-line indent, inline bullets, tab rows (HWPX-pair errors 50 → 5) |
| 4.18.11 | Fix runaway memory (7GB+ heap crash) on PDFs where thousands of font dictionaries share a few font programs (#137) |
| 4.18.9–10 | PDF cross-page paragraph joins: restore page boundaries in per-page Markdown (`pages`, #136) and stop joining headings, TOC lines and new items |
| 4.18.8 | Edit text with the same line count inside an HWPX cell paragraph while preserving CRLF/CR/LF |
| 4.18.7 | Fix CRLF/CR splitting GFM cells into new table rows and roundtrip cell coordinates |
| 4.18.5–6 | CLI input protection and `generate --plain` forwarding; PDF paragraphs, lists, parenthetical sentences and side tabs |
| 4.18.3–4 | PDF merged/nested tables and reading order; BOM/Electron support; output collisions, tracked deletions and rendering fixes |
| 4.18.0–2 | Parallel CLI conversion with `--jobs`, PPTX parsing, empty HWPX fields and faster document generation |

The 4.18.8 cell-edit path requires the same number of nonempty lines. Blank lines, added/deleted lines, literal `<br>` and ambiguous mappings remain unsupported. [Full changelog](CHANGELOG.md)

## FAQ

**How do I convert an HWP or HWPX file to Markdown?**
`npx kordoc document.hwp -o document.md`. It reads the file directly, without Hancom Office. Convert many files at once with `npx kordoc *.hwpx -d ./output`.

**How do I let Claude, Cursor or another AI agent read Korean documents?**
Run `npx -y kordoc setup` to register the MCP server. The agent can then read, compare and fill HWP, PDF and Excel files from a file path.

**Does it work on an air-gapped network?**
Yes. `KORDOC_OFFLINE=1` blocks all outbound traffic, and OCR runs on the local CPU with no API key. [Offline deployment](docs/offline-deployment.md)

**Can I use it for RAG indexing?**
`--format chunks` emits structure chunks with heading breadcrumbs plus standalone table chunks. Use `--table-format gfm` (API: `tableFormat: "gfm"`) for tables without HTML. From Python or Java, use the [Python SDK](sdk/python/README.md) or [Java SDK](sdk/java/README.md).

## Documentation and security

- [Usage guide](docs/usage-en.md): complete CLI, MCP tools, APIs and format support
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): parse from Java and Python systems through a resident engine worker ([worker protocol](docs/parse-worker-protocol.md), Korean)
- [Government-document generation](docs/gongmunseo-engine-spec.md) · [Architecture](docs/architecture.md)
- [Offline deployment](docs/offline-deployment.md): `KORDOC_OFFLINE=1`; MCP file scope with `KORDOC_ROOT`
- [Security policy](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](NOTICE)

## About the Author

A local civil servant in Korea. Built this after seven years of wrestling HWP files at the Gwangjin-gu District Office in Seoul. Validated on thousands of real government documents across five public-sector projects.
