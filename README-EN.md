# kordoc

**모두 파싱해버리겠다** — The Korean Document Platform.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/kordoc.svg)](https://nodejs.org)

> *Parse, compare, extract, and generate Korean documents. HWP, HWPX, HWPML, PDF, XLSX, DOCX — all of them.*

[한국어](./README.md)

![kordoc demo](./demo.gif)

---

## 💡 What can you do with kordoc?

Beyond simple text extraction, kordoc automates the **entire lifecycle of Korean government documents**.

*   **📄 Any Document to Markdown**: Convert `HWP`, `HWPX`, `HWPML`, `PDF`, `XLSX`, and `DOCX` into clean `Markdown` instantly. It produces the optimal input for LLMs to analyze and reason.
*   **📊 Perfect Table Reconstruction**: Whether it's a borderless PDF table or a complex merged HWP table, kordoc analyzes the structure to restore accurate markdown tables.
*   **🔍 Automatic Redline (Diff)**: Compare two documents and see exactly what changed at a glance. Supports cross-format comparison (e.g., Old HWP vs New HWPX).
*   **📝 Markdown back to HWPX**: Convert AI-generated content back into official `HWPX` reports. No more tedious manual copy-pasting.
*   **✏️ Auto-Fill Forms**: Feed values into government form templates (applications, reports) and auto-fill every blank. Preserves 100% of the original formatting (fonts, sizes, alignment).
*   **🤖 AI Agent Integration (MCP)**: Native support for `Model Context Protocol`. Let `Claude`, `Cursor`, or `Windsurf` read and process Korean documents directly.

---

## What's New in v2.3.0

- **📄 HWPML 2.x Parser** — Added support for XML-based HWP files (`.hwp` in XML format). Government documents that previously returned "unsupported format" are now fully parsed to Markdown. Auto-detected by XML signature (`<?xml` + `<HWPML`), separate from HWP 5.x binary files.

<details>
<summary>v2.2.4 changes</summary>

## What's New in v2.2.4

- **📝 Form Auto-Fill** — Automatically fill in government form templates with values. Supports label-value cell patterns, checkboxes (`□`→`☑`), parenthesized blanks (`일반(  )통`→`일반(3)통`), and annotations (`(한자：)`→`(한자：金)`).
- **🏛️ HWPX Style-Preserving Mode** — `fillHwpx()` directly manipulates HWPX XML to replace only values while keeping 100% of original formatting (fonts, sizes, alignment).
- **📊 HTML Table Output for Merged Cells** — Complex tables with `colspan`/`rowspan` now output as HTML `<table>` instead of GFM for accurate structure preservation.
- **🔧 markdownToHwpx Formatting** — Greatly improved heading/bold/italic/table formatting support in reverse conversion.
- **🤖 MCP fill_form Tool** — New MCP tool allowing AI agents to fill forms directly (8 tools total).

</details>

<details>
<summary>v2.2.1 changes</summary>

- **🔧 Markdown Rendering Fix** — Escape GFM special characters (`~`) to prevent false strikethrough, escape `|` inside table cells, change nested table text delimiter from `|` to `/` to avoid GFM parser conflicts.
- **📝 Paragraph Spacing** — Insert blank lines between paragraph blocks for proper markdown rendering as separate paragraphs.

</details>

<details>
<summary>v2.2.0 changes</summary>

- **🛡️ Security Hardening (7 fixes)** — XLSX/DOCX Billion Laughs (XXE) prevention, Watch SSRF redirect/decimal-IP/symlink blocking, HWP5 lenient decompression bomb prevention, CFB FAT sector cap, buildTableDirect memory explosion prevention.
- **💥 Crash Prevention** — Fixed `Math.min/max(...spread)` stack overflow (15 locations), Watch concurrency limit (MAX_CONCURRENT=3).
- **🐛 Correctness** — Levenshtein same-length similarity=1.0 bug fix, MCP `parse_metadata` XLSX/DOCX misclassification fix, PDF font-size stats memory optimization (40MB → ~50 entries).
- **📦 Quality** — CLI JSON Uint8Array base64 conversion, `isPathTraversal` false positive on legitimate filenames fixed.

</details>

<details>
<summary>v2.1.0 changes</summary>

- **📄 Large HWPX Government Document Parsing** — Fixed missing nested table parsing for `<p>><run>><tbl>` structure.
- **📰 PDF Two-Column Layout Detection** — Detects multi-column structure in academic papers and reports.
- **🛡️ Input Validation Hardening** — NaN/negative guards for font size, colSpan/rowSpan.

</details>

<details>
<summary>v2.0 changes</summary>

- **🔓 Distribution (View-Restricted) HWP Parsing** — HWP files locked for distribution-only viewing can now be parsed. AES-128 ECB decryption, pure JS implementation. Algorithm ported from [rhwp](https://github.com/edwardkim/rhwp) (MIT).
- **Corrupted HWP File Recovery** — Recover files rejected by standard CFB modules via direct FAT/directory parsing. Ported from rhwp's LenientCfbReader.
- **HWP5 Footnote/Endnote/Hyperlink Extraction** — Footnote text linking, hyperlink URL extraction with XSS sanitization.
- **HWPX Table Merge Fix** — Fixed colspan/rowspan grid calculation bug causing cell misalignment.
- **Security Hardening** — CFB sector size validation, consistent sanitizeHref across all 3 code paths.

</details>

<details>
<summary>v1.8.0 changes</summary>

- **XLSX Parser** — Excel spreadsheet parsing. Shared strings, merged cells, multi-sheet support. Each sheet becomes heading + table blocks.
- **DOCX Parser** — Word document parsing. Style-based headings, numbering (lists), footnotes, hyperlinks, image extraction, vMerge/gridSpan table merging.
- **Major Quality Improvement** — Parsing quality score improved 73→93 across all formats (PDF/HWPX/HWP5/XLSX).
- **Production Review: 17 Fixes** — CLI `--no-header-footer` flag inversion, MCP XLSX/DOCX extension support, shared ZIP bomb protection, href XSS sanitization at extraction time, PDF timeout cleanup, HWP5 BinData O(n) optimization, cluster indexOf O(n²)→O(n), SSRF IPv6 blocking, and more.

</details>

<details>
<summary>v1.7.x changes</summary>

- **Image Extraction (HWP/HWPX)** — Binary image extraction from ZIP entries and HWP5 BinData streams.
- **Partial Parsing (Graceful Degradation)** — Single page failures no longer abort the whole document.
- **Progress Callbacks** — `onProgress` callback. CLI shows `[3/15 pages]` progress.
- **File Path Input** — `parse("path/to/file.hwp")` string overload.
- **PDF Header/Footer Filtering** — `removeHeaderFooter` option.
- **Security Hardening** — ZIP bomb tracking, SSRF prevention, XSS defense, null-byte detection, PDF timeout.
- **pdfjs-dist v5 Compatibility** — constructPath operator format change support.

</details>

<details>
<summary>v1.6.1 fixes</summary>

- **HWP5 Table Cell Offset Fix** — Fixed critical 2-byte offset misalignment in LIST_HEADER parsing. Row address was incorrectly read as colSpan, causing 3-column tables to explode into 6+ columns with misaligned content. Tables now use colAddr/rowAddr-based direct placement for accurate cell positioning.
- **HWP5 TAB Control Character Fix** — TAB (0x0009) inline control's 14-byte extension data was not skipped, producing garbage characters (`࣐Ā`) after every tab in the output. Fixed by adding the required 14-byte skip.

</details>

<details>
<summary>v1.6.0 features</summary>

- **Cluster-Based Table Detection (PDF)** — Detects borderless tables by analyzing text alignment patterns. Baseline grouping + X-coordinate clustering identifies 2+ column tables that line-based detection misses. Sort-and-split clustering for order-independent results.
- **Korean Special Table Detection** — Automatically detects `구분/항목/종류`-style key-value patterns common in Korean government documents and converts them to structured 2-column tables.
- **Korean Word-Break Recovery** — Improved merging of broken Korean words in PDF table cells. Handles character-level PDF rendering (micro-gaps between Hangul characters) and cell line-break artifacts up to 8 characters.
- **Empty Table Filtering** — Tables with all-empty cells (from line detection of decorative borders) are now automatically removed.

</details>

<details>
<summary>v1.5.0 features</summary>

- **Line-Based Table Detection (PDF)** — Ported from OpenDataLoader. Extracts horizontal/vertical lines from PDF graphics commands, builds grid via intersection vertices, maps text to cells by bbox overlap. Proper colspan/rowspan detection. Falls back to heuristic for line-free PDFs.
- **IRBlock v2** — 6 block types: `heading`, `paragraph`, `table`, `list`, `image`, `separator`. New fields: `bbox`, `style`, `pageNumber`, `level`, `href`, `footnoteText`.
- **ParseResult v2** — `outline` (document structure) and `warnings` (skipped elements, hidden text) fields.
- **PDF Enhancements** — XY-Cut reading order, heading detection (font-size ratio), hidden text filtering (prompt injection defense), bounding box on every block.
- **HWP5 Enhancements** — CHAR_SHAPE parsing, style-based heading detection, warnings for skipped OLE/images.
- **HWPX Enhancements** — Style parsing from header.xml, hyperlink/footnote extraction.
- **List Detection** — Numbered paragraphs after tables auto-converted to ordered list blocks.
- **MCP Server** — Now returns `outline` and `warnings` in parse_document responses.

</details>

<details>
<summary>v1.4.x features</summary>

- **Document Compare** — Diff two documents at IR level. Cross-format (HWP vs HWPX) supported.
- **Form Field Recognition** — Extract label-value pairs from government forms automatically.
- **Structured Parsing** — Access `IRBlock[]` and `DocumentMetadata` directly, not just markdown.
- **Page Range Parsing** — Parse only pages 1-3: `parse(buffer, { pages: "1-3" })`.
- **Markdown to HWPX** — Reverse conversion. Generate valid HWPX files from markdown.
- **OCR Integration** — Pluggable OCR for image-based PDFs (bring your own provider).
- **Watch Mode** — `kordoc watch ./incoming --webhook https://...` for auto-conversion.
- **8 MCP Tools** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form, fill_form.
- **Error Codes** — Structured `code` field: `"ENCRYPTED"`, `"ZIP_BOMB"`, `"IMAGE_BASED_PDF"`, etc.

</details>

---

## Why kordoc?

South Korea's government runs on **HWP** — a proprietary word processor the rest of the world has never heard of. Every day, 243 local governments and thousands of public institutions produce mountains of `.hwp` files. Extracting text from them has always been a nightmare.

**kordoc** was born from that document hell. Built by a Korean civil servant who spent **7 years** buried under HWP files. Battle-tested across 5 real government projects. If a Korean public servant wrote it, kordoc can parse it.

---

## Installation

```bash
npm install kordoc

# PDF support (optional)
npm install pdfjs-dist
```

## Quick Start

### Parse Any Document

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("document.hwpx")
const result = await parse(buffer.buffer)

if (result.success) {
  console.log(result.markdown)       // Markdown text
  console.log(result.blocks)         // IRBlock[] structured data
  console.log(result.metadata)       // { title, author, createdAt, ... }
}
```

### Compare Two Documents

```typescript
import { compare } from "kordoc"

const diff = await compare(bufferA, bufferB)
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] with cell-level table diffs
```

Cross-format supported: compare HWP against HWPX of the same document.

### Extract Form Fields

```typescript
import { parse, extractFormFields } from "kordoc"

const result = await parse(buffer)
if (result.success) {
  const form = extractFormFields(result.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...]
  // form.confidence → 0.85
}
```

### Auto-Fill Forms

```typescript
import { fillForm } from "kordoc"
import { readFileSync, writeFileSync } from "fs"

const template = readFileSync("application.hwpx")

// HWPX style-preserving mode — keeps 100% of original formatting
const result = await fillForm(template.buffer, {
  성명: "홍길동",
  주민등록번호: "900101-1234567",
  주소: "서울특별시 광진구 능동로 120",
}, { format: "hwpx-preserve" })

writeFileSync("filled.hwpx", Buffer.from(result.buffer!))
// result.filled → [{ label: "성명", value: "홍길동" }, ...]
// result.unmatched → keys that didn't match any field
```

### Generate HWPX from Markdown

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# Title\n\nParagraph text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |")
writeFileSync("output.hwpx", Buffer.from(hwpxBuffer))
```

### Parse Specific Pages

```typescript
const result = await parse(buffer, { pages: "1-3" })     // pages 1-3 only
const result = await parse(buffer, { pages: [1, 5, 10] }) // specific pages
```

### OCR for Image-Based PDFs

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage) // Tesseract, Claude Vision, etc.
  }
})
```

## CLI

```bash
npx kordoc document.hwpx                          # stdout
npx kordoc document.hwp -o output.md              # save to file
npx kordoc *.pdf -d ./converted/                  # batch convert
npx kordoc report.hwpx --format json              # JSON with blocks + metadata
npx kordoc report.hwpx --pages 1-3                # page range
npx kordoc fill form.hwpx -f 'name=John,addr=Seoul' -o filled.hwpx  # auto-fill form
npx kordoc fill form.hwpx -j values.json -o filled.hwpx            # fill from JSON
npx kordoc fill form.hwpx --dry-run                                # list fields only
npx kordoc watch ./incoming -d ./output            # watch mode
npx kordoc watch ./docs --webhook https://api/hook # webhook notification
```

## MCP Server (Claude / Cursor / Windsurf)

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "npx",
      "args": ["-y", "kordoc", "mcp"]
    }
  }
}
```

**8 Tools:**

| Tool | Description |
|------|-------------|
| `parse_document` | Parse HWP/HWPX/PDF/XLSX/DOCX → Markdown with metadata |
| `detect_format` | Detect file format via magic bytes |
| `parse_metadata` | Extract metadata only (fast, no full parse) |
| `parse_pages` | Parse specific page range |
| `parse_table` | Extract Nth table from document |
| `compare_documents` | Diff two documents (cross-format) |
| `parse_form` | Extract form fields as structured JSON |
| `fill_form` | Fill form template with values (preserves HWPX formatting) |

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `parse(buffer, options?)` | Auto-detect format, parse to Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX only |
| `parseHwp(buffer, options?)` | HWP 5.x only |
| `parsePdf(buffer, options?)` | PDF only |
| `parseXlsx(buffer, options?)` | XLSX only |
| `parseDocx(buffer, options?)` | DOCX only |
| `parseHwpml(buffer, options?)` | HWPML (XML-based HWP) only |
| `detectFormat(buffer)` | Returns `"hwpx" \| "hwp" \| "hwpml" \| "pdf" \| "xlsx" \| "docx" \| "unknown"` |

### Advanced

| Function | Description |
|----------|-------------|
| `compare(bufferA, bufferB, options?)` | Document diff at IR level |
| `extractFormFields(blocks)` | Form field recognition from IRBlock[] |
| `fillForm(buffer, values, options?)` | Fill form template (markdown/hwpx/hwpx-preserve) |
| `fillFormFields(blocks, values)` | IRBlock[]-based field value replacement |
| `fillHwpx(buffer, values)` | Direct HWPX XML manipulation (style-preserving) |
| `markdownToHwpx(markdown)` | Markdown → HWPX reverse conversion |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown string |

### Types

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  BoundingBox, InlineStyle, OutlineItem, ParseWarning, WarningCode,
  DocumentMetadata, ParseOptions, ErrorCode,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult, FillResult, HwpxFillResult, FillOutputFormat,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## Supported Formats

| Format | Engine | Features |
|--------|--------|----------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | Manifest, nested tables, merged cells, broken ZIP recovery |
| **HWP 5.x** (한컴 Legacy) | OLE2 + CFB | Distribution decryption, corrupted CFB recovery, footnotes/hyperlinks, 21 control chars, image extraction |
| **HWPML 2.x** (XML-based HWP) | XML DOM | HeadingType-based heading detection, merged cells, DoS protection |
| **PDF** | pdfjs-dist | Line-based table detection, XY-Cut reading order, heading detection, hidden text filter, OCR |
| **XLSX** (Excel) | ZIP + XML DOM | Shared strings, merged cells, multi-sheet, formula display |
| **DOCX** (Word) | ZIP + XML DOM | Style headings, numbering, footnotes, image extraction |

## Security

Production-grade hardening: ZIP bomb protection, XXE/Billion Laughs prevention, decompression bomb guard, path traversal guard, MCP error sanitization, file size limits (500MB). See [SECURITY.md](./SECURITY.md) for details.

## Credits

Production-tested across 5 Korean government projects: school curriculum plans, facility inspection reports, legal document annexes, municipal newsletters, and public data extraction tools. Thousands of real government documents parsed.

## License

[MIT](./LICENSE)

This project includes the following open-source components:
- **rhwp** (MIT, edwardkim) — HWP5 distribution decryption and lenient CFB parsing algorithms
- **OpenDataLoader PDF** (Apache 2.0, Hancom Inc.) — PDF table detection algorithms
- **cfb** (Apache 2.0, SheetJS) — HWP5 OLE2 container parsing
- **pdfjs-dist** (Apache 2.0, Mozilla) — PDF text extraction
- **JSZip** (MIT, Stuart Knightley et al.) — ZIP-based format parsing

See [NOTICE](./NOTICE) for details.
