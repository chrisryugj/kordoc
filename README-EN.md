# kordoc

**모두 파싱해버리겠다.** Parse them all.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dio.github.chrisryugj%2Fkordoc%26version%3Dlatest&query=%24.servers%5B0%5D.server.version&label=MCP%20Registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc)

> *Korea's document hell is second to none. Built by a civil servant who survived seven years in it.*

Convert HWP 3.x/5.x, HWPX, HWPML, PDF, XLS/XLSX, DOCX, PPTX and PNG/JPG/WebP to Markdown and structured data. Use it as a library, CLI or MCP server.

[한국어](README.md) · [Usage guide](docs/usage-en.md) · [Benchmarks](docs/benchmarks-en.md) · [Changelog](CHANGELOG.md)

![kordoc output for the same statute annex given as HWP, HWPX, PDF and a scanned image](docs/readme-hero.gif)

<sub>Actual output for one statute annex given as HWP, HWPX, PDF and a scanned image. All four read the merged cells (`rowspan`, `colspan`) into the same table structure. OCR turns on automatically for images.</sub>

- 📊 **0.965 overall on the public PDF benchmark**: opendataloader-bench, 200 documents, higher than the 12 parsers on the public leaderboard (as recorded on 2026-09-29; measured on 4.24.50). [Measurement details](docs/benchmarks-en.md#pdf--markdown--opendataloader-bench)
- 🇰🇷 **100% Korean document table structure match**: all **10,342 visible tables** from 2,424 original HWPX documents. [Validation](#validation)

If this saves you time, a GitHub ⭐ helps others find it.

Videos (Korean): [public benchmark run](https://youtu.be/9kRbwiTRQLs) (2026-09-27 cut, 1 min 31 sec) · [batch form filling demo](https://youtu.be/Q13GmgDcIw0)

## Install

Node.js **20+** · macOS / Linux / Windows

```bash
npm install kordoc
```

Run the CLI without installing it globally: `npx kordoc`. PDF, OCR, image-format conversion and QR-reading dependencies are installed by default; omitting them with `--omit=optional` limits those features.

**Connect an AI agent**

```bash
npx -y kordoc setup
```

Registers MCP with installed clients such as Claude Desktop, Claude Code, Cursor and Codex. Restart the client to use **22 tools** for parsing, comparison, generation, review, rendering and more. kordoc is also listed on the official MCP Registry as [`io.github.chrisryugj/kordoc`](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc).

One-click install for VS Code and Cursor:

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_kordoc-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=kordoc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22kordoc%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install_kordoc-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=kordoc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImtvcmRvYyIsIm1jcCJdfQ%3D%3D)

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
npx kordoc to-hwpx document.hwp -o document.hwpx
npx kordoc to-hwpx ./old-docs   # whole folder (subfolders too) — .hwpx next to each file, existing ones skipped
npx kordoc document.pdf -o document.hwpx   # PDF, DOCX and others become HWPX from what was read (images included)
npx kordoc pack build report1.hwpx report2.hwpx report3.hwpx --name Gwangyang -o gwangyang.kpack   # agency pack (docs/agency-pack-en.md)
npx kordoc generate new-report.md --pack gwangyang.kpack -o new-report.hwpx
npx kordoc fill --template gian -j values.json -o draft.hwpx
npx kordoc lint report.hwpx --gate --preset report
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
| Read | Markdown, IR, page text, RAG chunks, local OCR (handwriting included), QR code values in images (`--qr-codes`), one image format for all images (`--image-format png\|webp`) |
| Compare and edit | Block/cell diffs, format-preserving HWPX/HWP patches, new content in a sample's format |
| Create | Markdown → HWPX, government-document presets and department templates (`--template`), tables, equations and charts |
| Convert | HWP → HWPX — HWP 5.x keeps its formatting (fonts, paragraph shapes, tables, pictures, shapes, equations, headers, footnotes, charts; distribution-protected and track-changes documents included). PDF, DOCX and others become HWPX from what was read with `-o document.hwpx` |
| Agency packs | Build a house-style pack (`.kpack`) from a few of your own agency documents and write new documents in that style — [agency packs](docs/agency-pack-en.md) |
| Fill forms | Fields, click-here controls, two draft templates and seal placement |
| Review | Notation and public-language rules, structure and AI-writing gate, budget calculation checks, block-level lint for open documents (`lint-blocks`) |
| View and protect | HWPX/HWP previews and region crops, PII masking |

Extract Markdown for format-preserving patches with `--keep-layout-tables`. Unsupported edits are skipped with a reason. [Format-preserving editing](docs/usage-en.md#format-preserving-editing) · [Full CLI reference](docs/usage-en.md#-cli)

## Validation

**4.22.14 verification · 2026-10-19** (render layout and statute annexes: 4.24.24 · 2026-10-30; PDF tables: 4.24.35 · 2026-11-01; OCR: 4.24.32 · 2026-11-01; HWP → HWPX conversion: 4.24.29 · 2026-10-31; PDF text, KoOCR-Bench and opendataloader-bench defaults and OCR on: 4.24.50 · 2026-11-07). Results use fixed corpora and reference criteria.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,424 documents · 10,342 tables | Table structure match **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130 pairs · 4,315 tables | Paired-document table structure match **100%** |
| HWP 5.x → HWPX conversion | 264 pairs saved by Hangul (232 compared attribute by attribute) | Attribute match **99.21%** · exact **69/232** · text **264/264** · 80 documents checked side by side in Hangul |
| PDF text | 744 pairs | Character recall **99.885%** · precision **99.682%** · reading order **99.363%** · word-boundary F1 **99.103%** |
| PDF tables | 708 pairs · 2,331 tables | Detection **99.83%** · structure match **98.24%** · cell F1 **0.9919** |
| HWPX reflow | 25,187 multiline paragraphs (12 folders) | All line starts match **24,941/25,187 · 99.02%** |
| Nested PDF tables (text layer) | 29 documents · 101 tables | Structure and cell content **101/101 · 100%** |
| Statute annexes | 272 documents · 346 tables | HWP **346/346**, PDF **343/346 · 99.13%** |
| All PDFs | 1,729 scored out of 1,911 documents | Text coverage **99.80%** |
| OCR | 53 documents · 102 pages · 65 tables | CER **0.0237** · character recall **99.33%** · table structure **33/65** |
| KoOCR-Bench v2.0c (external) | public 877 pages (tables, text, handwriting, order) | total **0.905** by default · tables **0.915** · handwriting **0.921** · order **0.914** · heading recall 0.930 (4.24.62) |
| opendataloader-bench | 200 PDF documents | Overall **0.965** with defaults · **0.967** with `ocr: true` · 0.939 with OCR off (4.22.14) |
| HWPX render layout | 1,565 Hancom PDF pairs (1,508 with matching page counts) · 111,480 text runs · 4,300 images | Text position (±1.5pt) **106,904 · 95.9%** · image position (±2pt) **4,213 · 98.0%** |

Table structure, cell content and visual fidelity are separate metrics. The nested-table 100% applies only to these 101 tables, not all PDF parsing or page layout. See [benchmark details](docs/benchmarks-en.md) for scope, exclusions, per-option scores and reproduction.

## Recent updates

Latest release: **[4.24.63](https://github.com/chrisryugj/kordoc/releases/tag/v4.24.63)** · 2026-11-11

| Version | Highlights | Measured change |
| --- | --- | --- |
| 4.24.63 | Body URLs and QR URLs open the original address in Markdown viewers; `htmlCellLinks` option (off by default) emits `<a href>` in HTML table cells (#204) · OCR: row boundaries of dark-filled header columns | no per-document drops on in-house benchmarks · KoOCR-Bench 0.90517 unchanged |
| 4.24.62 | HWPX generated without a template was missing `version.xml` (#207) · PDF/OCR: a page title and a lone bottom line were grouped and read before the tables between them · OCR: glyph boxes that bit into fragments of neighbouring lines | KoOCR-Bench 0.90509 → **0.90517** (order 0.913 → **0.914**) · OCR robust skew-2 CER 0.0475 → **0.0463** · no per-document drops on in-house benchmarks |
| 4.24.61 | OCR: fake vertical rules formed by glyph strokes split table columns · OCR: line boxes covering two lines were misread · MiniCPM-OCR OcrProvider example (#205) | KoOCR-Bench 0.90439 → **0.90509** (tables 0.913 → **0.915**) · in-house OCR table structure 32 → **33**/65 |
| 4.24.60 | XML parser replaced with quick-xml (wasm) (#202 — one dependency fewer, broken XML recovered) · PDF formula OCR: middle lines of multi-line equations were missed · OCR: vertical rules smeared by deskew · OCR: low-confidence ○ marks in table cells were dropped · Gongmun: body words "○○ MCP" were deleted (#203) | formula OCR recall 0.9758 → **0.9775**, precision 0.9699 → **0.9725** (report only) · OCR robust skew+3 CER 0.0481 → **0.0444**, scan 0.0550 → **0.0542** · one per-document drop on in-house benchmarks (org-chart vertical text order) |
| 4.24.59 | OCR: the tail of a neighbouring row beyond a dotted cell rule stuck to number boxes and pulled the next row's value into the same cell · OCR: the smudged band beside box borders in scans let org-chart text leak out of its box | KoOCR-Bench 0.90378 → **0.90439** (tables 0.912 → **0.913**) · OCR robust scan CER 0.0591 → **0.0557** |

See the [changelog](CHANGELOG.md) for earlier releases and details.

## FAQ

**How do I convert an HWP or HWPX file to Markdown?**
`npx kordoc document.hwp -o document.md`. It reads the file directly, without Hancom Office. Convert many files at once with `npx kordoc *.hwpx -d ./output`.

**How do I let Claude, Cursor or another AI agent read Korean documents?**
Run `npx -y kordoc setup` to register the MCP server. The agent can then read, compare and fill HWP, PDF and Excel files from a file path.

**Does it work on an air-gapped network?**
Yes. `KORDOC_OFFLINE=1` blocks all outbound traffic, and OCR runs on the local CPU with no API key. [Offline deployment](docs/offline-deployment.md)

**Can I use it for RAG indexing?**
`--format chunks` emits structure chunks with heading breadcrumbs plus standalone table chunks. Use `--table-format gfm` (API: `tableFormat: "gfm"`) for tables without HTML. From Python or Java, use the [Python SDK](sdk/python/README.md) or [Java SDK](sdk/java/README.md).

**Can I get OCR line boxes or use another model?**
`--ocr --ocr-lines --format json` exports line boxes and confidence; `--ocr-det` and `--ocr-det-long-side` select the detector and resolution, and `--ocr-rec handwriting|auto` selects the handwriting recognizer. [OCR lines and models](docs/usage-en.md#ocr-lines-and-models)

## Documentation and security

- [Usage guide](docs/usage-en.md): complete CLI, MCP tools, APIs and format support
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): parse from Java and Python systems through a resident engine worker ([worker protocol](docs/parse-worker-protocol.md), Korean)
- [Government-document generation](docs/gongmunseo-engine-spec.md) · [Architecture](docs/architecture.md)
- [Offline deployment](docs/offline-deployment.md): `KORDOC_OFFLINE=1`; MCP file scope with `KORDOC_ROOT`
- [gVisor sandbox](docs/sandbox.md): run the parser inside gVisor to protect the host (Linux; `KORDOC_SANDBOX=gvisor` or `docker --runtime=runsc`, Korean)
- [Security policy](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](NOTICE)

## About the Author

A local civil servant in Korea. Built this after seven years of wrestling HWP files at the Gwangjin-gu District Office in Seoul. Validated on thousands of real government documents across five public-sector projects.
