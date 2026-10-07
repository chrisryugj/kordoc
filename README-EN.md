# kordoc

**모두 파싱해버리겠다** — Parse them all.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)

> *Korea's document hell is second to none. Built by a civil servant who survived seven years in it.*

Convert HWP 3.x/5.x, HWPX, HWPML, PDF, XLS/XLSX, DOCX, PPTX and PNG/JPG/WebP to Markdown and structured data. Use it as a library, CLI or MCP server.

[한국어](README.md) · [Usage guide](docs/usage-en.md) · [Benchmarks](docs/benchmarks-en.md) · [Changelog](CHANGELOG.md)

- 📊 **0.960 overall on the public PDF benchmark** — opendataloader-bench, 200 documents. Ranked first against 12 published parsers in the 2026-09-29 comparison. [Measurement details](docs/benchmarks-en.md)
- 🇰🇷 **100% Korean document table structure match** — all **9,865 visible tables** from 2,286 original HWPX documents. [4.18.8 verification](docs/release-4.18.8.json)

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

**4.18.8 release verification · 2026-10-02**. Results use fixed corpora and reference criteria.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,286 documents · 9,865 tables | Table structure match **9,865/9,865 · 100%** |
| HWP 5.x ↔ HWPX | 1,120 pairs · 4,258 tables | Paired-document table structure match **100%** |
| PDF text | 744 pairs | Character recall **99.83%** · reading order **99.15%** |
| PDF tables | 708 pairs · 2,331 tables | Detection **99.83%** · structure match **97.94%** |

Table structure, cell content and visual fidelity are separate metrics. See [benchmark details](docs/benchmarks-en.md) for scope, exclusions and OCR results, and the [4.18.8 publication record](docs/release-4.18.8.json) for verification of the published package.

The external **opendataloader-bench, 200 documents** was measured separately for 4.18.6: overall **0.960** with defaults, **0.937** with OCR off. [Options and reproduction](docs/benchmarks-en.md#pdf--markdown--opendataloader-bench)

## Recent updates

Latest release: **[4.19.1](https://github.com/chrisryugj/kordoc/releases/tag/v4.19.1)** · 2026-10-07

| Version | Highlights |
| --- | --- |
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

## Documentation and security

- [Usage guide](docs/usage-en.md): complete CLI, MCP tools, APIs and format support
- [Government-document generation](docs/gongmunseo-engine-spec.md) · [Architecture](docs/architecture.md)
- [Offline deployment](docs/offline-deployment.md): `KORDOC_OFFLINE=1`; MCP file scope with `KORDOC_ROOT`
- [Security policy](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](NOTICE)

## About the Author

A local civil servant in Korea. Built this after seven years of wrestling HWP files at the Gwangjin-gu District Office in Seoul. Validated on thousands of real government documents across five public-sector projects.
