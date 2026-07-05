# kordoc

**모두 파싱해버리겠다** — Parse them all.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *Korea's document hell is second to none. Built by a civil servant who survived seven years in it.*

HWP 3.x/5.x, HWPX, HWPML, PDF, XLS, XLSX, DOCX — parse, compare, analyze, and generate every document format Korean government offices throw at you.

[한국어](./README.md)

![kordoc demo](./demo.gif)

---

## ⚡ 30-Second Setup (AI Agent Integration)

**macOS / Linux / Windows.** All you need is Node.js 18+.

```bash
npx -y kordoc setup
```

An interactive wizard:
1. Pick your AI client (Claude Desktop / Cursor / Claude Code / Windsurf / VS Code / Gemini CLI / Zed / Antigravity — installed ones show `[detected]`)
2. Patches the config file automatically → restart the client

Windows gets automatic `cmd /c npx` wrapping. No manual JSON editing. After restart, 11 document tools (`parse_document`, `parse_table`, `fill_form`, `patch_document`, `generate_document`, `place_seal`, …) are live.

> **CLI-only usage** needs no install at all: `npx kordoc <file>`. See [CLI](#cli) below.

> **If you hit `MODULE_NOT_FOUND` / `Cannot find module ...\dist\cli.js`**: a broken global install is lingering. Fix with:
> ```powershell
> npm uninstall -g kordoc
> npx -y kordoc@latest setup
> ```

> **If Windows PowerShell blocks `npx.ps1` (`PSSecurityException`)**: that's PowerShell's default policy blocking unsigned `.ps1` scripts (not kordoc). Either run the same command in **cmd** instead, or relax the policy once from an admin PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Install as a Claude Code plugin

Prefer a skill (SKILL.md) over MCP registration:

```
/plugin marketplace add chrisryugj/kordoc
/plugin install kordoc@kordoc
```

The kordoc skill auto-activates on `.hwp`/`.hwpx` mentions and Korean official-document generation/form-filling requests (it calls the `npx -y kordoc@^3` CLI internally — no separate install).

---

## 💡 What can you do with kordoc?

Beyond plain text extraction, kordoc automates the **entire lifecycle of Korean official documents**.

*   **📄 Any document to Markdown**: Convert `HWP3` (legacy), `HWP` (5.x), `HWPX`, `HWPML`, `PDF`, `XLS`, `XLSX`, and `DOCX` to `Markdown` instantly — the ideal shape for LLMs to read and reason about.
*   **📊 Faithful table reconstruction**: Borderless PDF tables and heavily merged HWP tables are analyzed structurally and restored as accurate markdown tables. Old-vs-new clause comparison tables in legislative amendment PDFs survive intact (v3.16.2).
*   **🔍 Automatic redline (diff)**: Compare two documents and see exactly what changed — including cross-format comparison (HWP vs HWPX).
*   **📝 Markdown back to HWPX**: Turn AI-written content back into report-form `HWPX`. No more copy-paste drudgery.
*   **🔄 Lossless format-preserving roundtrip (v3.0)**: Edit the converted markdown and hand it to `patchHwpx` (HWPX) / `patchHwp` (HWP 5.x binary) — only the changed paragraph/cell text is swapped in place, **without touching a single byte of the original formatting**. Row insertion/deletion inherits neighboring-row formatting (v3.7); filling originally-empty HWP 5.x cells works too (v3.8).
*   **🖼️ Layout-preserving render (v3.10–3.15)**: Reproduce the original layout as SVG from Hancom's saved typesetting cache; files without a cache (AI-generated HWPX, edited output) are typeset directly by a **pure-TS reflow engine**. Multi-page, tables, drawing shapes, search-term highlighting — HWPX previews on a server with no Hancom installed.
*   **📊 Chart generation (v3.16)**: A markdown ```chart fence (type/cat/series lines) becomes a native Hancom chart (OOXML chartSpace) — 20 types including bar/line/pie/donut/area/scatter/radar, with per-series colors.
*   **🔴 Stamp/signature placement (v3.16)**: Finds anchor phrases like "(인)" ("seal here") and places a stamp PNG as a floating object in front of text. Tables and pages never grow, so stamping doesn't shift the layout (`kordoc seal`).
*   **✏️ Form auto-fill**: Feed values into official form templates (applications, reports) and every blank is filled — preserving 100% of the original formatting (font, size, alignment).
*   **🤖 AI agent integration (MCP)**: Let `Claude`, `Cursor`, and friends call `kordoc` directly to read and produce documents.

---

## What's New in v3.16

- **📊 Chart generation**: Markdown ```chart fences (type/cat/series lines) become native Hancom charts (OOXML chartSpace) — 20 types, per-series/slice colors; malformed fences fall back to a code block.
- **🔴 Stamp/signature placement**: `kordoc seal` — finds anchors like "(인)"/"서명 또는 인" and places the stamp PNG as a float in front of text without growing tables/pages (MCP `place_seal` included). Nested tables, text boxes, and tab/multi-line paragraphs are approximate and reported via `warnings` — verify in Hancom and fine-tune with `--dx`/`--dy` (dx_mm/dy_mm).
- **🔌 Claude Code plugin**: `/plugin marketplace add chrisryugj/kordoc` → the kordoc skill auto-activates for `.hwp`/`.hwpx`/official-document requests.
- **🩹 3.16.1 patch**: 55 defects from an adversarial production review fixed in one sweep — stamp placement (rowspan/colspan/nested-table origins), chart value parser (thousands separators, CRLF markdown), form-fill guards (`require_unique`), CLI `fill -o` output, and other "success message, silently wrong output" bugs.
- **🩹 3.16.2 patch**: PDF parser no longer mistakes the `<신 설>` ("newly inserted") notation inside old-vs-new clause comparison tables for a text box — a 30-page amendment comparison table is restored as one intact table instead of being shredded into paragraphs.

<details>
<summary><b>Version highlights v3.0 – v3.15</b> (click — full details in <a href="./CHANGELOG.md">CHANGELOG</a> and the <a href="./README.md">Korean README</a>)</summary>

- **v3.15** — Reflow render for cache-less HWPX (`renderHwpxToSvg(buf, { reflow: true })`, line-break engine measured 98% match), drawing-shape SVG render, persistent `render-worker` (stdin NDJSON).
- **v3.14** — Multi-page render (vertical stack, `pageCount`), search-term highlighting (`--highlight`), line-boundary alignment for control-heavy paragraphs, image-crop misread fix.
- **v3.13** — Prose-box detection (full-width flowing text over fake columns), HML table caption preservation.
- **v3.12** — Label-header tables no longer demoted to paragraphs; open-edge synthesis for chained borders; PDF table bench 90.3→98.6% match.
- **v3.11** — Open-sided table restoration (Korean documents love omitting outer borders), text-box shading no longer poisons border detection.
- **v3.10** — Layout-preserving SVG render from Hancom's typesetting cache (per-run size/weight/color, alignment, cell borders, merged cells, image crop).
- **v3.9** — Markdown display math → native HWPX equations (`\frac`, `\sqrt`, scripts, Greek, integrals/limits, matrices), equation input guards, statute roundtrip integrity gate.
- **v3.8.x** — HWP 5.x empty-cell fill, DOCX merged-table/text-box recovery, masking-asterisk protection, 17GB→445MB memory fix for image-heavy docs, rotated-PDF text recovery, two-column transcript de-interleaving, Hancom-Cell XLSX recovery.
- **v3.7** — Table row add/delete in `patchHwpx` (formatting inherited from adjacent rows), form-fill accuracy on colspan labels and nested tables, honest partial-application reporting.
- **v3.6** — Measured text metrics from the real Hamchorom TTF (98% line-break match), auto letter-spacing (`autoFit`), HTML table generation (colspan/rowspan/nested), multi-value fill, tamper-warning fix.
- **v3.5** — In-place "sentence → table" conversion inside existing HWPX, MCP `generate_document`.
- **v3.2** — Official-document mode `markdownToHwpx(md, { gongmun })`: 8-level Korean item numbering (`1. 가. 1) 가) (1) (가) ① ㉮`), hanging indents, official margins, presets (`official`/`report`/`plan`/`notice`/`minutes`).
- **v3.1** — `HwpxSession` incremental block-patch API for editors, `extractFormSchema` (field types/required/empty), CJS build fix.
- **v3.0.1** — `patchHwp`: format-preserving patch for HWP 5.x binaries (sector-level container surgery — byte-identical outside the edit).
- **v3.0** — `patchHwpx` lossless roundtrip + parser leap on a 324-document government corpus: HWPX text 99.998%, table structure 100%, PDF coverage 99.16%.

</details>

---

## Install

```bash
npm install kordoc

# Optional — only if you parse PDFs
npm install pdfjs-dist
```

## Quick Start

### Parse a document

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("business-plan.hwpx")
const result = await parse(buffer.buffer)

if (result.success) {
  console.log(result.markdown)       // markdown text
  console.log(result.blocks)         // IRBlock[] structured data
  console.log(result.metadata)       // { title, author, createdAt, ... }
}
```

### Compare documents (redline)

```typescript
import { compare } from "kordoc"

const diff = await compare(oldBuffer, newBuffer)
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] (tables include cell-level diffs)
```

Cross-format comparison (HWP vs HWPX) works too.

### Extract form fields

```typescript
import { parse, extractFormFields } from "kordoc"

const result = await parse(buffer)
if (result.success) {
  const form = extractFormFields(result.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...]
  // form.confidence → 0.85
}
```

### Auto-fill a form

```typescript
import { fillForm } from "kordoc"
import { readFileSync, writeFileSync } from "fs"

const template = readFileSync("application.hwpx")

// HWPX format-preserving mode — fonts, sizes, alignment 100% intact
const result = await fillForm(template.buffer, {
  성명: "홍길동",
  주민등록번호: "900101-1234567",
  주소: "서울특별시 광진구 능동로 120",
}, { format: "hwpx-preserve" })

writeFileSync("application_filled.hwpx", Buffer.from(result.buffer!))
// result.filled → [{ label: "성명", value: "홍길동" }, ...]
// result.unmatched → keys that failed to match
```

### Generate HWPX (reverse conversion)

```typescript
import { markdownToHwpx } from "kordoc"

const hwpxBuffer = await markdownToHwpx("# Title\n\nBody text\n\n| Name | Rank |\n| --- | --- |\n| 홍길동 | 과장 |")
writeFileSync("out.hwpx", Buffer.from(hwpxBuffer))

// Display math blocks become native HWPX equations (<hp:equation>).
// Supported: a limited LaTeX-like subset — \frac, \sqrt, sub/superscripts,
// Greek, integrals/limits, arrows, relations, matrix family.
const withEquation = await markdownToHwpx("Pythagoras\n\n$$a^2 + b^2 = c^2$$")

// Official-document mode — 8-level Korean item numbering + hanging indent
// + official margins/serif defaults
const gongmun = await markdownToHwpx("1. 추진배경\n  - 세부 항목\n2. 추진계획", {
  gongmun: { preset: "보고서" },  // official | report | plan | notice | minutes
})
```

From the CLI: `kordoc generate report.md -o report.hwpx --preset 보고서`

### Layout-preserving render (HWPX → SVG)

Draws the typesetting cache Hancom stores in HWPX (line coordinates, cell grids, object anchors) as absolutely-positioned SVG. Fast (no typesetting engine needed) and works on servers without Hancom. Multi-page vertical stack, search-term highlighting, and drawing shapes are supported (v3.14–15). Files without a cache (`markdownToHwpx` output, AI-generated or edited files) are typeset directly by the **pure-TS reflow engine** with `reflow: true` (v3.15). Equation objects are not rendered yet.

```typescript
import { renderHwpxToSvg } from "kordoc"

const r = await renderHwpxToSvg(readFileSync("approval.hwpx"), { highlights: ["예산"] })
writeFileSync("approval.svg", r.svg)
// r.width/r.height (pt), r.pageCount, r.stats { texts, images, tables }, r.warnings

const g = await renderHwpxToSvg(generatedHwpx, { reflow: true }) // cache-less files
```

From the CLI: `kordoc render approval.hwpx -o approval.svg` (`--reflow`, `--highlight 예산,집행`) — for continuous rendering use `kordoc render-worker` (stdin NDJSON).

### Page ranges

```typescript
const result = await parse(buffer, { pages: "1-3" })      // pages 1–3 only
const result = await parse(buffer, { pages: [1, 5, 10] })  // specific pages
```

### OCR (image-based PDFs)

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage)
  }
})
```

### PDF text-quality signals (v2.9+)

PDFs often have a text layer with broken ToUnicode/CMap or control characters mixed in. `parsePdf` returns per-page quality signals.

```typescript
const r = await parsePdf(buffer)
if (r.success && r.qualitySummary?.needsOcr) {
  // route to your OCR queue (kordoc ships no built-in OCR)
  await routeToOcr(buffer, r.qualitySummary.ocrCandidatePages)
}

for (const p of r.pageQuality ?? []) {
  if (p.needsOcr) console.log(`p${p.page} needs review: ${p.ocrReason}`)
}
```

Signal keys: `textChars`, `hangulRatio`, `controlCharRatio`, `replacementCharRatio`, `puaRatio` / `needsOcr` (page & document level) / `ocrReason` (`low_text` | `high_pua` | `high_control` | `high_replacement`).

## CLI

```bash
npx kordoc business-plan.hwpx                       # print to terminal
npx kordoc report.hwp -o report.md                  # save to file
npx kordoc *.pdf -d ./converted/                    # batch conversion
npx kordoc review.hwpx --format json                # JSON (blocks + metadata)
npx kordoc report.hwpx --pages 1-3                  # page range
npx kordoc fill form.hwpx -f '성명=홍길동,주소=서울' -o filled.hwpx   # fill a form
npx kordoc fill form.hwpx -j values.json -o filled.hwpx              # fill from JSON
npx kordoc fill form.hwpx --dry-run                                  # list fields only
npx kordoc generate report.md -o report.hwpx --preset 보고서          # markdown → official HWPX
npx kordoc patch original.hwpx edited.md -o patched.hwpx  # format-preserving roundtrip patch (.hwp auto-detected)
npx kordoc seal form.hwpx --image stamp.png --anchor "(인)" -o sealed.hwpx  # place a stamp/signature
npx kordoc validate output.hwpx                     # HWPX structure validation (ZIP, required parts, XML)
npx kordoc render approval.hwpx -o preview.svg      # layout-preserving SVG render (--reflow supported)
npx kordoc watch ./inbox -d ./converted             # folder watch mode
npx kordoc watch ./docs --webhook https://api/hook  # webhook notification
```

## MCP Server (Claude / Cursor / Windsurf)

**Automatic setup (recommended)**:

```bash
npx -y kordoc setup
```

Detects your AI client interactively and patches its config file — including `cmd /c npx` wrapping on Windows. See [30-Second Setup](#-30-second-setup-ai-agent-integration).

**Manual registration (macOS / Linux)**:

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

**Manual registration (Windows — when Claude Desktop can't find `.cmd`)**:

```json
{
  "mcpServers": {
    "kordoc": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "kordoc", "mcp"]
    }
  }
}
```

**11 tools:**

| Tool | Description |
|------|-------------|
| `parse_document` | HWP/HWPX/PDF/XLSX/DOCX → markdown (with metadata) |
| `detect_format` | Format detection via magic bytes |
| `parse_metadata` | Fast metadata-only extraction |
| `parse_pages` | Parse a specific page range |
| `parse_table` | Extract only the Nth table |
| `compare_documents` | Compare two documents (cross-format) |
| `parse_form` | Extract form fields as JSON |
| `fill_form` | Fill a form template (HWPX format-preserving, format/uniqueness guards) |
| `patch_document` | Apply edited markdown back into the original HWPX/HWP, format preserved (v3.3) |
| `generate_document` | Markdown (tables/equations/charts) → HWPX, official-document presets (v3.5) |
| `place_seal` | Place a stamp/signature image over an anchor phrase (v3.16) |

## API

### Core functions

| Function | Description |
|----------|-------------|
| `parse(buffer, options?)` | Auto format detection → Markdown + IRBlock[] |
| `parseHwpx(buffer, options?)` | HWPX only |
| `parseHwp(buffer, options?)` | HWP 5.x only |
| `parseHwp3(buffer, options?)` | HWP 3.x (1996–2002 legacy) only |
| `parsePdf(buffer, options?)` | PDF only |
| `parseXlsx(buffer, options?)` | XLSX only |
| `parseXls(buffer, options?)` | XLS (Excel 97–2003, BIFF8) only |
| `parseDocx(buffer, options?)` | DOCX only |
| `parseHwpml(buffer, options?)` | HWPML (XML-based HWP) only |
| `detectFormat(buffer)` | `"hwpx" \| "hwp" \| "hwp3" \| "hwpml" \| "pdf" \| "xlsx" \| "xls" \| "docx" \| "unknown"` |

### Advanced functions

| Function | Description |
|----------|-------------|
| `compare(bufferA, bufferB, options?)` | IR-level document comparison |
| `extractFormFields(blocks)` | Recognize form fields from IRBlock[] |
| `extractFormSchema(blocks)` | Field recognition + type/required/empty inference (v3.1) |
| `fillForm(buffer, values, options?)` | Fill a form template (markdown/hwpx/hwpx-preserve) |
| `fillFormFields(blocks, values)` | Replace field values on IRBlock[] |
| `fillHwpx(buffer, values)` | Direct HWPX XML manipulation (format-preserving) |
| `patchHwpx(original, editedMarkdown, options?)` | Edited markdown → in-place format-preserving HWPX patch (v3.0) |
| `patchHwp(original, editedMarkdown, options?)` | Edited markdown → format-preserving HWP 5.x binary patch (v3.0.1) |
| `openHwpxDocument(bytes, options?)` | `HwpxSession` incremental block-patch session for editors (v3.1) |
| `patchHwpxBlocks(bytes, edits, options?)` | One-shot block edits without a session (v3.1) |
| `markdownToHwpx(markdown, options?)` | Markdown → HWPX (themes, equations, charts, gongmun presets) |
| `markdownToPdf(markdown, options?)` | Markdown → PDF (print renderer) |
| `blocksToPdf(blocks, options?)` | IRBlock[] → PDF |
| `renderHtml(blocks, options?)` | IRBlock[] → print-ready HTML |
| `renderHwpxToSvg(buffer, options?)` | HWPX → layout-preserving SVG — multi-page, highlights, shapes; `reflow` for cache-less files (v3.10–15) |
| `placeSealHwpx(buffer, seals)` | Place stamp/signature images over anchor phrases (v3.16) |
| `validateHwpx(buffer)` | HWPX structure validation — ZIP, mimetype, required parts, XML well-formedness (v3.16) |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown string |

### Types

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode, OutlineItem,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult, FillResult, HwpxFillResult, FillOutputFormat, FillFormOutput,
  PatchOptions, PatchResult, PatchSkip,
  HwpxTheme, MarkdownToHwpxOptions,
  PrintPreset, PrintOptions, PageMargin,
  RenderSvgOptions, RenderSvgResult,
  OcrProvider, WatchOptions,
} from "kordoc"
```

## Supported Formats

| Format | Engine | Highlights |
|--------|--------|-----------|
| **HWPX** (Hancom 2020+) | ZIP + XML DOM | Manifest, nested tables, merged cells, corrupted-ZIP recovery |
| **HWP 5.x** (Hancom legacy) | OLE2 + CFB | Distribution-copy decryption, corrupted-CFB recovery, footnotes/hyperlinks, 21 control chars, image extraction |
| **HWP 3.x** (1996–2002) | Single binary | Johab → Unicode, 5,893 Hanja/symbol lookup, nested paragraph extraction |
| **HWPML 2.x** (XML-based HWP) | XML DOM | HeadingType-based headings, merged cells, DoS guards |
| **PDF** | pdfjs-dist | Line-based tables, XY-Cut reading order, heading detection, OCR hooks, text-quality signals |
| **XLSX** (Excel) | ZIP + XML DOM | Shared strings, merged cells, multiple sheets, formula display |
| **XLS** (Excel 97–2003) | OLE2 + BIFF8 | Workbook stream, SST shared strings, cell/sheet extraction |
| **DOCX** (Word) | ZIP + XML DOM | Style-based headings, numbering, footnotes, image extraction |

## Security

Production-grade hardening: ZIP-bomb guards, XXE/Billion-Laughs prevention, decompression-bomb guards, path-traversal blocking, MCP error sanitization, 500MB file-size cap. See [SECURITY.md](./SECURITY.md).

## About the Author

A local civil servant in Korea. Built this after seven years of wrestling HWP files at the Gwangjin-gu District Office in Seoul. Validated on thousands of real government documents across five public-sector projects.

## License

[MIT](./LICENSE)

This project includes the following open-source software:
- **rhwp** (MIT, edwardkim) — HWP5 distribution-copy decryption and lenient CFB parsing
- **OpenDataLoader PDF** (Apache 2.0, Hancom Inc.) — PDF table detection algorithm
- **cfb** (Apache 2.0, SheetJS) — HWP5 OLE2 container parsing
- **pdfjs-dist** (Apache 2.0, Mozilla) — PDF text extraction
- **JSZip** (MIT, Stuart Knightley et al.) — ZIP-based format parsing

See [NOTICE](./NOTICE) for details.
