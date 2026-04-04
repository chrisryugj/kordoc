# kordoc

**모두 파싱해버리겠다** — The Korean Document Platform.

[![npm version](https://img.shields.io/badge/npm-v1.8.0-cb3837.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/kordoc.svg)](https://nodejs.org)

> *Parse, compare, extract, and generate Korean documents. HWP, HWPX, PDF, XLSX, DOCX — all of them.*

[한국어](./README.md)

![kordoc demo](./demo.gif)

---

## 💡 What can you do with kordoc?

Beyond simple text extraction, kordoc automates the **entire lifecycle of Korean government documents**.

*   **📄 Any Document to Markdown**: Convert `HWP`, `HWPX`, `PDF`, `XLSX`, and `DOCX` into clean `Markdown` instantly. It produces the optimal input for LLMs to analyze and reason.
*   **📊 Perfect Table Reconstruction**: Whether it's a borderless PDF table or a complex merged HWP table, kordoc analyzes the structure to restore accurate markdown tables.
*   **🔍 Automatic Redline (Diff)**: Compare two documents and see exactly what changed at a glance. Supports cross-format comparison (e.g., Old HWP vs New HWPX).
*   **📝 Markdown back to HWPX**: Convert AI-generated content back into official `HWPX` reports. No more tedious manual copy-pasting.
*   **🤖 AI Agent Integration (MCP)**: Native support for `Model Context Protocol`. Let `Claude`, `Cursor`, or `Windsurf` read and process Korean documents directly.

---

## What's New in v1.8.0

- **XLSX Parser** — Excel spreadsheet parsing. Shared strings, merged cells, multi-sheet support. Each sheet becomes heading + table blocks.
- **DOCX Parser** — Word document parsing. Style-based headings, numbering (lists), footnotes, hyperlinks, image extraction, vMerge/gridSpan table merging.
- **Major Quality Improvement** — Parsing quality score improved 73→93 across all formats (PDF/HWPX/HWP5/XLSX).
- **Production Review: 17 Fixes** — CLI `--no-header-footer` flag inversion, MCP XLSX/DOCX extension support, shared ZIP bomb protection, href XSS sanitization at extraction time, PDF timeout cleanup, HWP5 BinData O(n) optimization, cluster indexOf O(n²)→O(n), SSRF IPv6 blocking, and more.

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
- **7 MCP Tools** — parse_document, detect_format, parse_metadata, parse_pages, parse_table, compare_documents, parse_form.
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
npx kordoc watch ./incoming -d ./output            # watch mode
npx kordoc watch ./docs --webhook https://api/hook # webhook notification
```

## MCP Server (Claude / Cursor / Windsurf)

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "npx",
      "args": ["-y", "kordoc-mcp"]
    }
  }
}
```

**7 Tools:**

| Tool | Description |
|------|-------------|
| `parse_document` | Parse HWP/HWPX/PDF/XLSX/DOCX → Markdown with metadata |
| `detect_format` | Detect file format via magic bytes |
| `parse_metadata` | Extract metadata only (fast, no full parse) |
| `parse_pages` | Parse specific page range |
| `parse_table` | Extract Nth table from document |
| `compare_documents` | Diff two documents (cross-format) |
| `parse_form` | Extract form fields as structured JSON |

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
| `detectFormat(buffer)` | Returns `"hwpx" \| "hwp" \| "pdf" \| "xlsx" \| "docx" \| "unknown"` |

### Advanced

| Function | Description |
|----------|-------------|
| `compare(bufferA, bufferB, options?)` | Document diff at IR level |
| `extractFormFields(blocks)` | Form field recognition from IRBlock[] |
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
  FormField, FormResult,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## Supported Formats

| Format | Engine | Features |
|--------|--------|----------|
| **HWPX** (한컴 2020+) | ZIP + XML DOM | Manifest, nested tables, merged cells, broken ZIP recovery |
| **HWP 5.x** (한컴 Legacy) | OLE2 + CFB | 21 control chars, zlib decompression, DRM detection, colAddr-based table cell placement |
| **PDF** | pdfjs-dist | Line-based table detection, XY-Cut reading order, heading detection, hidden text filter, OCR |
| **XLSX** (Excel) | ZIP + XML DOM | Shared strings, merged cells, multi-sheet, formula display |
| **DOCX** (Word) | ZIP + XML DOM | Style headings, numbering, footnotes, image extraction |

## Security

Production-grade hardening: ZIP bomb protection, XXE/Billion Laughs prevention, decompression bomb guard, path traversal guard, MCP error sanitization, file size limits (500MB). See [SECURITY.md](./SECURITY.md) for details.

## Credits

Production-tested across 5 Korean government projects: school curriculum plans, facility inspection reports, legal document annexes, municipal newsletters, and public data extraction tools. Thousands of real government documents parsed.

## License

[MIT](./LICENSE)
