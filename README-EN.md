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

- 📊 **0.964 overall on the public PDF benchmark**: opendataloader-bench, 200 documents, higher than the 12 parsers on the public leaderboard (measured on 4.22.14). [Measurement details](docs/benchmarks-en.md#pdf--markdown--opendataloader-bench)
- 🇰🇷 **100% Korean document table structure match**: all **10,342 visible tables** from 2,424 original HWPX documents. [Validation](#validation)

If this saves you time, a GitHub ⭐ helps others find it.

Videos (Korean): [public benchmark run](https://youtu.be/9kRbwiTRQLs) (2026-09-27 cut, 1 min 31 sec) · [batch form filling demo](https://youtu.be/Q13GmgDcIw0)

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

Registers MCP with installed clients such as Claude Desktop, Claude Code, Cursor and Codex. Restart the client to use **18 tools** for parsing, comparison, generation, review, rendering and more. kordoc is also listed on the official MCP Registry as [`io.github.chrisryugj/kordoc`](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.chrisryugj/kordoc).

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
| Read | Markdown, IR, page text, RAG chunks and local OCR |
| Compare and edit | Block/cell diffs, format-preserving HWPX/HWP patches, new content in a sample's format |
| Create | Markdown → HWPX, government-document presets and department templates (`--template`), tables, equations and charts |
| Fill forms | Fields, click-here controls, two draft templates and seal placement |
| Review | Notation and public-language rules, structure and AI-writing gate, budget calculation checks, block-level lint for open documents (`lint-blocks`) |
| View and protect | HWPX/HWP previews and region crops, PII masking |

Extract Markdown for format-preserving patches with `--keep-layout-tables`. Unsupported edits are skipped with a reason. [Format-preserving editing](docs/usage-en.md#format-preserving-editing) · [Full CLI reference](docs/usage-en.md#-cli)

## Validation

**4.22.14 verification · 2026-10-19** (render layout, PDF text, PDF tables and OCR: 4.24.11 · 2026-10-27). Results use fixed corpora and reference criteria.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,424 documents · 10,342 tables | Table structure match **10,342/10,342 · 100%** |
| HWP 5.x ↔ HWPX | 1,130 pairs · 4,315 tables | Paired-document table structure match **100%** |
| PDF text | 744 pairs | Character recall **99.881%** · precision **99.677%** · reading order **99.309%** · word-boundary F1 **99.066%** |
| PDF tables | 708 pairs · 2,331 tables | Detection **99.83%** · structure match **98.24%** · cell F1 **0.9919** |
| HWPX reflow | 25,187 multiline paragraphs (12 folders) | All line starts match **24,941/25,187 · 99.02%** |
| Nested PDF tables (text layer) | 29 documents · 101 tables | Structure and cell content **101/101 · 100%** |
| Statute annexes | 272 documents · 346 tables | HWP **346/346**, PDF **342/346 · 98.84%** |
| All PDFs | 1,729 scored out of 1,911 documents | Text coverage **99.80%** |
| OCR | 53 documents · 102 pages · 67 tables | CER **0.0306** · character recall **99.12%** · table structure **25/67** |
| opendataloader-bench | 200 PDF documents | Overall **0.964** with defaults · **0.939** with OCR off |
| HWPX render layout (4.24.11) | Hancom PDF pairs · 90,840 text runs · 4,107 images | Text position (±1.5pt) **87,577 · 96.4%** · image position (±2pt) **4,019 · 97.9%** |

Table structure, cell content and visual fidelity are separate metrics. The nested-table 100% applies only to these 101 tables, not all PDF parsing or page layout. See [benchmark details](docs/benchmarks-en.md) for scope, exclusions, per-option scores and reproduction.

## Recent updates

Latest release: **[4.24.11](https://github.com/chrisryugj/kordoc/releases/tag/v4.24.11)** · 2026-10-27

| Version | Highlights | Measured change |
| --- | --- | --- |
| 4.24.11 | OCR: detection boxes split at table cell and row boundaries, date commas, 前/現 before titles · Rendering: page-number font size · Generation: Seoul policy-plan title spacing and summary alignment | OCR CER 0.0310 → **0.0306** · character recall 99.10% → **99.12%** · rendered text position 87,546 → **87,577** · generation fidelity 0.806 → **0.807** |
| 4.24.10 | Security: zod and fast-uri in the demo lockfile, government GitLab mirror restored (Java SDK `kordoc-pom.xml`) · OCR: leading ▣, ❐ and ‣ bullets, Roman numerals read as `\|`, date-final periods · PDF: vertical-writing 、。, gradient backgrounds taken as rules, CJK–Latin autospacing | OCR CER 0.0313 → **0.0310** · character recall 99.06% → **99.10%** · all 9 degraded-input variants improved (scan 0.0734 → **0.0730**) · PDF word-boundary F1 99.064% → **99.066%** |
| 4.24.9 | Double rules on every row of tables built from a template or grown by patch · OCR: leading ○ bullets the recognizer dropped · PDF: tables split across pages no longer swallow the next page's first row | OCR CER 0.0314 → **0.0313** · blurred-input OCR CER 0.0638 → **0.0635** · PDF table structure 98.20% → **98.24%** |
| 4.24.8 | Security: known dependency vulnerabilities 6 → 0 (zod 4, MCP SDK transitive dependencies), `npm audit` gate in release and CI · OCR: leading ring bullets read as digits, 「 touching the next character · PDF: statistics tables clipped only in header cells | `npm audit` 6 → **0** · OCR CER 0.0327 → **0.0314** · blurred-input OCR CER 0.0663 → **0.0638** · PDF reading order 99.307% → **99.309%** |
| 4.24.7 | Template generation: the table-of-contents box is no longer taken as the summary box, indented lists under marker paragraphs keep their level · HWPML: non-breaking and fixed-width spaces, line breaks · OCR: background pattern at line ends, numeric columns merged into the header row, hyphen and dash length | OCR CER 0.0332 → **0.0327** · character recall 99.02% → **99.04%** |

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
`--ocr --ocr-lines --format json` exports line boxes and confidence; `--ocr-det` and `--ocr-det-long-side` select the detector and resolution. [OCR lines and models](docs/usage-en.md#ocr-lines-and-models)

## Documentation and security

- [Usage guide](docs/usage-en.md): complete CLI, MCP tools, APIs and format support
- [Java SDK](sdk/java/README.md) · [Python SDK](sdk/python/README.md): parse from Java and Python systems through a resident engine worker ([worker protocol](docs/parse-worker-protocol.md), Korean)
- [Government-document generation](docs/gongmunseo-engine-spec.md) · [Architecture](docs/architecture.md)
- [Offline deployment](docs/offline-deployment.md): `KORDOC_OFFLINE=1`; MCP file scope with `KORDOC_ROOT`
- [Security policy](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](NOTICE)

## About the Author

A local civil servant in Korea. Built this after seven years of wrestling HWP files at the Gwangjin-gu District Office in Seoul. Validated on thousands of real government documents across five public-sector projects.
