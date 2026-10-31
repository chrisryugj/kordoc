# Usage guide

[README](../README-EN.md) · [한국어](usage.md) · [Benchmarks](benchmarks-en.md)

Full parsing options, CLI commands, MCP tools and API reference. See the README for a quick start and recent updates.

## ⚡ Install

All you need is Node.js 20+ (macOS / Linux / Windows).

### AI agent integration (MCP) — 30 seconds

```bash
npx -y kordoc setup
```

Pick your installed AI client (Claude Desktop · Cursor · Claude Code · Windsurf · VS Code · Gemini CLI · Zed · Antigravity · Codex) and the settings are written for you. Restart it and the [20 document tools](#-mcp-server) are on.

### Claude Code plugin

```
/plugin marketplace add chrisryugj/kordoc
/plugin install kordoc@kordoc
```

The skill turns on by itself for `.hwp`/`.hwpx` files and official-document requests (no separate install).

### Library · CLI

```bash
npm install kordoc        # CLI only? no install needed: npx kordoc <file>
```

PDF and OCR dependencies are installed by default (`--omit=optional` slims the install but drops PDF and OCR). Only PDF print rendering (`markdownToPdf`) needs `puppeteer-core` installed separately.

Embedding kordoc as a library in an app (Electron etc.): the only required packages `import "kordoc"` actually loads are `@xmldom/xmldom`, `jszip` and `markdown-it` (`cfb` is bundled). `@modelcontextprotocol/sdk` (plus the 92 packages, about 11MB, it pulls in such as express and hono), `commander` and `zod` serve only `kordoc mcp` and the CLI, so they can be left out of an app installer. Optional dependencies (`sharp`, `onnxruntime-node`, `@huggingface/tokenizers`, `@hyzyla/pdfium`, `pdfjs-dist`) can be dropped for the features you do not use (PNG render, OCR, PDF). The MCP SDK is not an optional dependency because, as in #99 below, npm drops optional dependencies together when one of them fails to install, which would remove the MCP server entirely.

<details>
<summary>Troubleshooting</summary>

- **`MODULE_NOT_FOUND` / `Cannot find module ...\dist\cli.js`** — a broken global install is lingering.
  ```powershell
  npm uninstall -g kordoc
  npx -y kordoc@latest setup
  ```
- **PowerShell `npx.ps1 … PSSecurityException`** — PowerShell's default policy. Run `npx -y kordoc setup` in cmd, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and reopen PowerShell.
- **PNG rendering / image OCR fail with `MISSING_DEPENDENCY` (sharp) on network-restricted linux/x64** (#99) — onnxruntime's CUDA download failed and took sharp with it.
  ```bash
  ONNXRUNTIME_NODE_INSTALL=skip npx -y kordoc@^4 <command> ...
  ```
- **Air-gapped networks** — see [Security](#-security).

</details>

---

## 🚀 Quick Start

### Parse a document

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const result = await parse(readFileSync("business-plan.hwpx"))   // a file path string works too

if (result.success) {
  result.markdown   // markdown
  result.blocks     // IRBlock[] structured data
  result.metadata   // { title, author, createdAt, pageMode, ... }
  result.pages      // [{ pageNumber, markdown }] per-page body
}
```

- `pages` appears only for formats whose blocks carry page numbers (HWP · HWPX · PDF; XLS(X): one sheet = one page; PPTX: one slide = one page). DOCX, which has no page numbering, omits the field.
- Page-boundary reliability is `metadata.pageMode` — `"layout"` (real pages from the typesetting cache) / `"section"` (section approximation).

**Parse options** (`parse(buffer, options)` · CLI flag)

| Option | CLI | Description |
| --- | --- | --- |
| `pages` | `-p, --pages` | `"1-3"` · `"1,3,5-7"` · `[1, 5, 10]` — real pages for PDF and Hancom-saved files, section approximation without a typesetting cache |
| `ocr` | `--ocr` · `--ocr-force` | default: scanned pages + text in large images (when the model is cached) · `true`: + small images and logos (~18MB model auto-download) · `"force"`: every page · `false`: off · function: external OCR · images embedded in HWP/HWPX are read only with `true`, `"force"` or a function (default: source text only; images in DOCX and other formats are not covered) |
| `ocrLines` | `--ocr-lines` · `--ocr-lines-all` | built-in OCR lines (box, confidence) as `result.ocrLines` (PDF, images). `"all"` also lists lines dropped for low confidence with `dropped: true` — see [OCR lines and models](#ocr-lines-and-models) |
| `ocrDet` · `ocrDetLongSide` | `--ocr-det` · `--ocr-det-long-side` | text detection model `"mobile"` (default), `"server"` (~88MB, downloaded on first use), `"medium"` (PP-OCRv6, ~62MB, downloaded on first use; for skewed, blurred or scanned input) or a local file `{path, sha256}`; detector input long side (32–4096, default 960) |
| `ocrRec` · `ocrRecDict` | `--ocr-rec` · `--ocr-rec-dict` (+ `--ocr-*-sha256`) | recognition model `"handwriting"` (Korean handwriting rec for handwritten forms, ~15MB, downloaded on first use) or a local file `{path, sha256}` (e.g. a fine-tuned rec); dictionary from a local file. Not loaded if the SHA-256 differs |
| `formulaOcr` | `--formula-ocr` | PDF formula OCR (MFD+MFR, ~155MB models) — detected formulas as `$…$` / `$$…$$` |
| `scriptTags` | `--script-tags` · `--no-script-tags` | superscripts/subscripts as `<sup>`/`<sub>` (so "10⁴ m²" does not flatten to "104 m2"). Default: on for HWPX · HWP · DOCX, off for PDF (`true` recommended for papers and math) |
| `images` | `--no-images` | `false` skips image bytes (placeholders remain; PDF skips PNG encoding) |
| `plain` | `--plain` | text-first Markdown without image placeholders, link URLs, underline or bold (headings, lists and table structure kept; `blocks` unchanged). `<sup>`/`<sub>` become `10^4`/`H_2O` |
| `htmlTables` | `--html-tables` | every table as HTML, one tag per indented line (first row `<th>`) |
| `tableFormat` | `--table-format gfm` | `"gfm"`: every table as a GFM pipe table, no HTML (vertically merged values repeat on every covered row; horizontally merged values stay in the first cell). Nested tables move out after their parent, linked by `<!-- <table id="t2" parent_id="t1" /> -->` markers (for RAG indexing; not combinable with `htmlTables`) |
| `password` | `--password` | open password (HWPX · HWP3 · HWP5; not Hancom DRM) |
| `tables` | `--no-tables` | `false` turns off PDF table detection (two-column exam sheets whose boxes read as tables and flip the order) |
| `removeHeaderFooter` | `--no-header-footer` | remove PDF running headers/footers (default on, 3+ pages) |
| `layoutTables` | `--keep-layout-tables` | invisible-border layout tables. Default `"visual"`: as they look (frames become text, only ruled parts stay tables, cell-built fractions become equations). `"keep"`: original table structure (use it for markdown you will `patch` back) |
| `keepTrailingEmptyCols` | `--keep-empty-cols` | keep empty trailing table columns (form input columns) — `patch` detects from the table shapes whether the edited Markdown came from this extraction |
| `keepEmptyParagraphs` | `--keep-empty-paragraphs` | keep empty paragraphs — source paragraph count = line count (HWPX) |
| `includeFieldPlaceholders` | `--include-field-placeholders` | also emit unfilled click-here field guide text (HWPX · HWP5) |
| `memos` | `--memos` | append document memos (Hangul "insert memo") as a final "메모" section — the memo list is always in the result's `memos` (memo text, anchored text, paragraph, author, time, block index; HWPX · HWP5) |
| `dedupeRunningHeaders` | `--dedupe-headers` | drop running headers repeated per page in HWP5 layout tables (opt-in: may also drop per-attachment renumbering) |
| `inlineImages` | `--inline-images` | inline images as base64 data URIs (BMP→PNG, HWP5) |
| `classifyTables` | — | classify tables as data / layout / uncertain into `IRTable.classification` |
| `onProgress` | — | progress callback `(current, total)` |

### Compare documents (redline)

```typescript
import { compare } from "kordoc"

const diff = await compare(oldBuffer, newBuffer)   // cross-format HWP ↔ HWPX works
// diff.stats → { added: 3, removed: 1, modified: 5, unchanged: 42 }
// diff.diffs → BlockDiff[] (tables include cell-level diffs)
```

### Extract and fill form fields

```typescript
import { parse, extractFormFields, fillForm } from "kordoc"
import { readFileSync, writeFileSync } from "fs"

const r = await parse(buffer)
if (r.success) {
  const form = extractFormFields(r.blocks)
  // form.fields → [{ label: "성명", value: "홍길동", row: 0, col: 0 }, ...], form.confidence → 0.85
}

// format-preserving mode — fonts, sizes, alignment intact (HWP 5.x is converted to HWPX with its format kept, then filled; output is HWPX)
const filled = await fillForm(readFileSync("application.hwpx"), {
  성명: "홍길동", 주민등록번호: "900101-1234567", 주소: "서울특별시 광진구 능동로 120",
}, "hwpx-preserve")
writeFileSync("application_filled.hwpx", Buffer.from(filled.output as ArrayBuffer))
// filled.fill.filled → filled fields, filled.fill.unmatched → keys that failed to match
```

- Array values fill the occurrences of the same label in order. Sub-label cells next to a row header (`상호 또는 법인명칭` or `성 명` beside `신청인` or `대표자`)
  are not treated as value cells, so the order does not depend on which other keys are given. Keys with no cell to write are reported in `unmatched`.
- Date placeholders under a column header (`년 월 - 년 월`) are overwritten with the value.
- Lines such as `업 체 명 :` inside a one-cell box (pledge forms) are filled like body text, and a trailing seal mark `(인)` or `(서명 또는 인)` is kept.
- Two-row headers (vertically merged `기 간` and `근 무 처`, plus `분야` and `내용` under `담당업무`) fill all four columns in the data rows below.
- `filled[].target` is the cell the value was written to — `{ table, row, col }`: the table ordinal in the `--keep-layout-tables --keep-empty-cols`
  extraction (document order, nested tables included, from 0) and the grid row and column in that table. Body text and click-here fields have none.

```bash
# See which cell each key and array index will go to before filling (writes nothing)
npx kordoc fill form.hwpx -j fields.json --dry-run
# → { "targets": [{ "key": "대표자", "index": 1, "value": "…", "target": { "table": 2, "row": 0, "col": 3 } }, …], "unmatched": [] }
#   an entry gets "overwrittenBy": "<key>" when a later key writes the same cell again
```

### Built-in standard draft templates + click-here fields

Standard draft-document forms (annexed to the 「Enforcement Rules of the Regulation on Administrative Efficiency and Collaboration」) ship with the package, so you can produce an official document by name alone. Form source: [rhwp](https://github.com/edwardkim/rhwp) (MIT).

| Name | Form | Use | Click-here fields |
|------|------|-----|-------------------|
| `gian` (general draft) | Annex Form No. 1 | outgoing / cooperation documents | 23 — agency name, recipient, via, title, body, attachments, sender, drafter, reviewer, approver, enforcement number, … |
| `gian-simple` (simple draft) | Annex Form No. 2 | internal approval reports/plans (approval table) | 13 — registration number, approval titles 1–4, title, summary, date, … |

```bash
npx kordoc fill --list-templates                                # built-in templates + fields
npx kordoc fill --template gian -j values.json -o draft.hwpx
npx kordoc fill templates:간이기안문 -f '제목=…' -o report.hwpx   # positional form works too
```

- Click-here fields are matched by name first, then remaining keys by label — works on any HWPX form with click-here fields.
- Multi-line values become in-paragraph line breaks; the original formatting is kept.
- API: `extractClickHereFields` → `fillHwpx(buf, values)`. The MCP `fill_form` tool takes the same templates via `template`.

### Generate HWPX (Markdown → HWPX)

```typescript
import { markdownToHwpx } from "kordoc"

const hwpx = await markdownToHwpx("# Title\n\nBody\n\n| Name | Rank |\n| --- | --- |\n| 홍길동 | 과장 |")

// display math → native HWPX equations (<hp:equation>) — LaTeX-like subset: \frac, \sqrt, scripts, Greek, integrals/limits, arrows, relations, matrices
await markdownToHwpx("Pythagoras\n\n$$a^2 + b^2 = c^2$$")

// inline math $…$ (body text and table cells) → in-line equation objects (treatAsChar). Off by default so plain $ (prices) stays text — opt-in; CLI --inline-math, MCP inline_math.
// Only paired $…$ counts: no space after the opening $ or before the closing $, no digit after the closing $, \$ / $$ / inline code excluded (Pandoc rule)
await markdownToHwpx("Body $x^2+1$ end", { inlineMath: true })

// official-document mode — 8-level item numbering + hanging indent + official margins / serif fonts
// preset: official | report | plan | notice | minutes | gaejosik | press | ministry (work report) | bangchim (Seoul policy plan)
await markdownToHwpx("1. 추진배경\n  - 세부 항목\n2. 추진계획", { gongmun: { preset: "보고서" } })

// government-standard gaejosik report — cover, TOC (banner), Roman-numeral chapter headers, body title box, page numbers ("- 1 -", not on cover/TOC)
await markdownToHwpx(md, {
  gongmun: {
    preset: "개조식",
    cover: { org: "Agency", date: "2026. 7. 11." },
    toc: true,                          // h2 list → Ⅰ Ⅱ Ⅲ TOC (on by default for gaejosik)
    approval: ["담당", "팀장", "과장"],   // approval box (optional)
    pageNumbers: true,                  // page numbers (on by default for gaejosik/report/plan)
    endMark: false,                     // "끝." at the end (on by default for drafts)
  },
})
```

- Tables follow government conventions automatically (shaded header, double bottom rule, content-proportional widths). Themes and a reference document's table format (`hwpxToProfile`) are accepted too.
- For the report, plan, gaejosik and bangchim presets, a blockquote right after the `#` title (`> …하고자 함`) becomes the summary box (gaejosik puts it under the title box on the first body page when the cover is on, the default; with `cover: false` the first `#` is a chapter header and the quote stays a ※ note). Keep it to one sentence (commas allowed) within three lines; longer or multi-sentence summaries produce a warning. For ministry, `> ▪ …` blockquotes become performance summary boxes wherever they appear.
- CLI: `kordoc generate report.md -o report.hwpx --preset 개조식 --org Agency --approval 담당,팀장,과장`

### Layout-preserving render

Draws documents exactly as laid out, from the typesetting cache Hancom stores in HWPX (no Hancom on the server). Files without a cache (generated files) are typeset by the built-in reflow engine. Equation objects are not rendered yet.

```typescript
import { renderHwpxToSvg, renderDocument, extractRenderedRegions } from "kordoc"

const r = await renderHwpxToSvg(readFileSync("approval.hwpx"), { highlights: ["예산"] })
// r.svg, r.width/r.height (pt), r.pageCount, r.stats { texts, images, tables }, r.warnings
const g = await renderHwpxToSvg(generatedHwpx, { reflow: true })   // cache-less files

// unified renderer — HWPX and HWP (5.x), per-page PNG + table crops
const { scene, assets } = await renderDocument("approval.hwp", { format: "png", pages: "1-2" })
const crops = await extractRenderedRegions("approval.hwp", { types: ["table"] })
```

CLI: `kordoc render approval.hwpx -o approval.svg` (`--highlight 예산`, `--no-reflow`). For preview apps, `kordoc render-worker` stays resident.

### Bulk conversion — persistent parse worker

```typescript
await parse(buffer, { images: false })                   // no image bytes
await parse(buffer, { plain: true, htmlTables: true })   // text-first + every table as HTML
```

`kordoc parse-worker` stays running and answers one line per stdin JSON line (no new node process per file).

```text
ready     {"ready":true,"version":"4.18.8","protocol":1}
request   {"id":1,"file":"doc.hwpx","images":false,"ocr":"off"}
response  {"id":1,"rss":183500800,"result":{ …same as --format json, failures as success:false… }}
quit      {"cmd":"quit"}  (or close stdin)
```

Requests accept `ocr` (`"off"` · `"auto"` · `"force"`), `formulaOcr` and `password`; use the response's `rss` (memory) to decide when to recycle the worker.
`--protocol 2` accepts `ParseOptions` (e.g. `tableFormat`) and file-based image transport; the Java and Python SDKs use it — see [parse-worker protocol](parse-worker-protocol.md) (Korean).

### OCR (scanned / image-based PDFs)

```typescript
await parse(buffer, { ocr: true })      // pages that need OCR + text in images (PP-OCRv5 korean, ~18MB model on first use)
await parse(buffer, { ocr: "force" })   // force every page
await parse(buffer, {                   // external OCR (Claude Vision, Tesseract, …)
  ocr: async (pageImage, pageNumber, mimeType) => myOcrService.recognize(pageImage),
})
```

- Runs on local CPU with no API key (PP-OCRv5 korean ONNX — all 11,172 precomposed Hangul syllables).
- Only pages without a text layer or with a broken one are OCR'd, and table structure is recovered from scans.
- Model management: `kordoc models --status` (`--export`/`--import` for air-gapped networks).
- Text in images embedded in HWP/HWPX bodies is read only with `ocr: true`, `"force"` or a function, and is inserted as paragraphs or tables right after that image block
  (`![image](image_001.png)`; inside the same table cell for an image in a cell). The default (no `ocr`) emits the source text only, so output does not change.
  Decorative images narrower or lower than 24px and WMF/EMF are skipped. Images in DOCX, XLSX and PPTX are not covered — read `result.images[]` with `parseImage` if needed.

#### OCR lines and models

```typescript
const r = await parse("scan.pdf", { ocr: true, ocrLines: true, ocrDet: "server", ocrDetLongSide: 1920 })
for (const page of r.success ? r.ocrLines ?? [] : []) {
  for (const line of page.lines) console.log(page.pageNumber, line.text, line.confidence, line.box)  // box: {x, y, w, h}
}
await parse(buffer, { ocrRec: { path: "/models/my-rec.onnx", sha256: "…" } })   // fine-tuned rec (same dictionary)
await parse("handwritten-form.pdf", { ocr: true, ocrRec: "handwriting" })        // handwriting recognition model
```

- `ocrLines` boxes are in OCR raster pixels (top-left origin). Each page carries `width`, `height`, `scale` (px/pt, 3 = 216dpi for PDF by default) and `deskewAngle`;
  convert to block `bbox` space (PDF pt, bottom-left origin) with `x / scale` and `pageHeight − (y + h) / scale`. For image input the raster is the image as shown (EXIF orientation applied; shrunk if over 24MP).
  Deskewed pages (`deskewAngle` ≠ 0) use the rotated raster — map back with θ = `deskewAngle` (degrees), (cx, cy) = ((`width`−1)/2, (`height`−1)/2):
  `x₀ = cx + (x−cx)·cosθ − (y−cy)·sinθ`, `y₀ = cy + (x−cx)·sinθ + (y−cy)·cosθ` (apply to the four box corners).
- Lines are the ones used to build blocks. Pages where only figure regions were read (the page has a text layer) are marked `regionsOnly: true` and list only lines inside those regions (before the figure-text merge). This path keeps the original PDF region coordinates without rotating the whole page, so `deskewAngle` is 0.
  A user OcrProvider and OCR of images embedded in HWP have no line geometry and are not covered. With the option off, results are unchanged.
- Local model files need an absolute path and a SHA-256; the engine reads the bytes, checks them and loads those bytes. A rec whose output classes are not dictionary + 2 is rejected.
  Built-in models (including `"server"` and `"handwriting"`) are cached under `~/.cache/kordoc/models/ppocr/` and never downloaded under `KORDOC_OFFLINE`. Automatic OCR (no `ocr` option) runs only when the selected model files are present.
- `ocrRec: "handwriting"` is a public model fine-tuned from PP-OCRv5 korean rec on handwriting and government-form data ([korean-handwriting-rec](https://github.com/VerifiedIdiot/korean-handwriting-rec), Apache-2.0).
  It uses the built-in Korean dictionary. It is meant for documents with a lot of handwriting such as handwritten applications and survey forms; it can misread narrow digits and slashes (e.g. the page mark `1/2`) that the default model reads correctly, so the default is unchanged.
  If the selected model cannot be downloaded or opened, kordoc does not fall back to the default model and reports a failure (an `OCR_FAILED` warning for PDFs).
- MCP `parse_document` accepts preset names only: `ocr_rec: "handwriting"`, `ocr_det: "mobile" | "server" | "medium"` and `ocr_det_long_side` (32 to 4096). Local model files are set through the CLI or the library.
- One engine session is cached per model selection (a resident worker using several selections keeps each in memory).

### PDF text-quality signals

`parsePdf` returns per-page quality signals — use them to send pages with a broken text layer to OCR.

```typescript
const r = await parsePdf(buffer)
if (r.success && r.qualitySummary?.needsOcr) await parse(buffer, { ocr: true })   // or route to your OCR queue
for (const p of r.pageQuality ?? []) if (p.needsOcr) console.log(`p${p.page} needs review: ${p.ocrReason}`)
```

Signals: `textChars` · `hangulRatio` · `controlCharRatio` · `replacementCharRatio` · `puaRatio`, `needsOcr`, `ocrReason` (`low_text` · `high_pua` · `high_control` · `high_replacement` · `garbled_hangul` · `vector_text`).

---

### Format-preserving editing

Extract Markdown with original table structure before patching.

```bash
npx kordoc original.hwpx --keep-layout-tables -o edited.md
# Edit edited.md, then:
npx kordoc patch original.hwpx edited.md -o patched.hwpx
```

To fill empty cells at the right end of a form row (`대표자 | (empty)`), extract with `--keep-empty-cols` as well — the default extraction trims that column.
Added table rows (`<tr>` or `|` rows) clone the format and merges of a neighbouring data row, and changed rows only rewrite the cells of the original row in the same place (several records in a form's single empty row).

HWPX patches also apply added and deleted paragraphs (`--no-structure` turns this off). HWP 5.x patches skip them in place and also write a rewrite (`<output>.rewrite.hwpx`): the original converted to HWPX with its format intact, with these edits applied. A new paragraph clones the nearest original paragraph with the same item marker (□·ㅇ·-·※·1.·가.) and replaces only its text, so indent, font and weight match the neighbouring lines; a line whose marker changed is re-dressed in that marker's paragraph format. Deleted paragraphs are removed whole (paragraphs holding section definitions, objects or page breaks are emptied instead). Reordering blocks is not supported.

Paragraphs whose text changed lose their line-break cache so Hancom re-lays them for the new text (HWPX and HWP 5.x; untouched paragraphs keep theirs).
To keep the original line positions in HWP 5.x, pass `--keep-lineseg` — the new text then breaks where the old lines did, which can start a line with a space or a period.

**Copying a template's format** — writing a new document in the look of a sample document uses the same path. Read the sample with `--keep-layout-tables`, keep the cover/approval tables, title, image lines, item markers, `**` emphasis and table notation, rewrite only the content, then run `patch sample.hwpx new.md -o new.hwpx`. `generate` re-lays the document in kordoc's own format, so the sample's logos, approval box and fonts do not carry over.

4.18.8 preserves actual CRLF/CR/LF inside a single cell paragraph when editing the same number of nonempty lines. Blank lines, added/deleted lines, literal `<br>` and complex mappings remain unsupported. The CLI exits with code 2 when any edit is skipped.

## 💻 CLI

[Parallel batch benchmarks and limits](parallel-batch.md)

`--jobs N` runs whole-file conversions in parallel using N reusable processes (default: 1). With `--jobs > 1`, multiple inputs require `-d` and distinct filename stems, including across extensions. Per-file failures do not stop other files, and any failure sets a nonzero exit status. Completion messages and failure JSON arrive in completion order. More workers use more memory; tiny files may be slower, and OCR already uses native CPU threads. This does not parallelize pages within one document or change the JavaScript/MCP APIs.

```bash
# convert
npx kordoc business-plan.hwpx                       # print to terminal
npx kordoc report.hwp -o report.md                  # save to file (images in images/report/)
npx kordoc *.pdf -d ./converted/                    # batch conversion
npx kordoc *.pdf --jobs 4 -d ./converted/           # parallel batch (4 reusable processes)
npx kordoc review.hwpx --format json                # JSON (blocks + pages + metadata)
npx kordoc review.pdf --format chunks               # RAG structure chunks (breadcrumbs + standalone tables)
npx kordoc report.hwpx --pages 1-3                  # page range
npx kordoc scan.pdf --ocr                           # built-in OCR (--ocr-force for every page)
npx kordoc locked.hwpx --password 'secret'          # password-protected HWPX/HWP3/HWP5
npx kordoc exam.pdf --no-tables                     # turn off PDF table detection
npx kordoc doc.pdf --format json --no-images        # no images (also --plain, --html-tables)

# fill forms
npx kordoc fill form.hwpx -f '성명=홍길동,주소=서울' -o filled.hwpx
npx kordoc fill form.hwpx -j values.json -o filled.hwpx
npx kordoc fill form.hwpx --dry-run                                 # list fields only (incl. click-here)
npx kordoc fill form.hwpx -j fields.json --dry-run                  # cell (table, row, col) per key and array index, writes nothing
npx kordoc fill form.hwpx -j values.json --formats '{"날짜":"yy.mm.dd"}' # per-field value format
npx kordoc fill form.hwpx -j values.json --require-unique           # refuse if one key matches 2+ spots
npx kordoc fill form.hwpx -j values.json --mask                     # don't echo filled values to stdout
npx kordoc fill --template gian -j values.json -o draft.hwpx        # built-in draft template (--list-templates)

# generate · edit · verify
npx kordoc generate report.md -o report.hwpx --preset 보고서         # Markdown → official HWPX
npx kordoc patch original.hwpx edited.md -o patched.hwpx            # format-preserving patch (.hwp auto)
npx kordoc patch original.hwpx edited.md --json --silent            # applied count, skipped edits, verification residual as JSON
npx kordoc to-hwpx document.hwp                                     # HWP → HWPX (5.x keeps formatting; -o needed when a same-name .hwpx exists)
npx kordoc compare old.hwp new.hwpx                                 # document diff (exit 1 when they differ, --json)
npx kordoc seal form.hwpx --image stamp.png --anchor "(인)" -o sealed.hwpx
npx kordoc memo report.hwpx --anchor "phrase" --text "memo text" -o reviewed.hwpx   # attach a memo to an anchor phrase (.hwp converts to HWPX keeping formatting)
npx kordoc validate output.hwpx                                     # HWPX structure validation (ZIP, required parts, XML)
npx kordoc lint report.md                                           # 27-rule notation linter (md/txt or documents, '-' = stdin, exit 1 on errors)
npx kordoc lint report.hwpx --numbers --styles                      # + body↔table number check, per-level style deviations (review lists)
npx kordoc lint report.md --gate --preset report                    # document gate: notation/style errors + AI-style (slop) and structure (why→what→how) findings → exit 1
npx kordoc generate report.md -o report.hwpx --preset report --gate # no file when the gate fails (docs/gongmun-logic.md)
npx kordoc profile agency-form.hwpx                                 # table format profile JSON → generate --profile
npx kordoc levels agency-sample.hwpx                                # per-marker-level font/size/bold → generate --levels
npx kordoc generate report.md -o report.hwpx --levels-from agency-sample.hwpx  # apply a sample's level styles
npx kordoc generate report.md -o report.hwpx --preset report --agency 국세청  # central-ministry house style (measured on 2,670 press releases, 52 agencies + 공통)
npx kordoc pack build report1.hwpx report2.hwpx report3.hwpx --name Gwangyang -o gwangyang.kpack  # agency pack from your own documents (docs/agency-pack-en.md)
npx kordoc pack info gwangyang.kpack --guide                        # pack summary and writing guide
npx kordoc generate new.md -o new.hwpx --pack gwangyang.kpack          # new document in the pack's style (--pack-kind press …)

# PII masking
npx kordoc redact complaint.hwpx -o redacted.hwpx                   # format-preserving masking + re-scan (exit 2 if anything remains)
npx kordoc redact complaint.hwpx --mask-char '*' -o redacted.hwpx   # mask character (default ●)
npx kordoc redact contract.hwp --rules rrn,phone,crn --json --dry-run  # pick rules + per-location report only (crn, IP are opt-in)
npx kordoc redact complaint.hwpx --rules rrn,phone,email,name,address -o redacted.hwpx  # names and addresses too (opt-in)
npx kordoc redact notice.pdf                                        # PDF/DOCX/etc.: masked .redacted.md only

# render
npx kordoc render approval.hwpx -o preview.svg                      # layout-preserving SVG (reflow when cache-less)
npx kordoc render approval.hwpx --format png --pages 2-4 -d ./pages # also PNG, JPEG, HTML, PDF
npx kordoc render approval.hwpx --reflow-mode charAll -o preview.svg # reflow line breaking: keep (word, default) | charAll (character)

# models · watch
npx kordoc models --status                          # OCR model status (--export/--import for air-gapped sideloading)
npx kordoc check-ocr-models --status-only           # status only as JSON (without the flag, missing models are downloaded)
npx kordoc check-formula-models --status-only       # formula OCR models (MFD+MFR+tokenizer, ~155MB) status only
npx kordoc watch ./inbox -d ./converted             # folder watch (keeps subfolders)
npx kordoc watch ./docs --webhook https://api/hook  # webhook notification
```

- A human must check PII-masking results before publication. Text inside images is outside automatic detection.
- `watch -d` keeps the subfolder structure.
- `check-ocr-models` and `check-formula-models` download missing models — pass `--status-only` to inspect only.
- `lint` parses documents (HWPX, HWP, PDF, …) and checks the body. Parsed text collapses repeated spaces and turns bold into `**`,
  so the 2-space "끝."/attachment rules and the bold-overuse rule only run on manuscripts (md/txt). `--numbers`/`--styles` are review lists and do not change the exit code.
- `generate` strips chat-paste artefacts (invisible characters, `【…†…】` citation tags, escaped `\*\*bold\*\*`) and reports them as a warning.
- HWPX `patch` also checks the result at the byte/structure level (untouched entries byte-identical, replaced XML strictly well-formed, tags preserved in text-only sections) and fails instead of writing a broken file. `--no-verify` skips it together with the re-parse check (HWP 5.x patches are not covered).

### Failure contract — machine-readable failure JSON

Conversion failures emit the JSON below to stdout in every `--format` and exit 1 — branch on `code`.

```json
{ "success": false, "fileType": "hwpx", "file": "report.hwpx", "error": "…", "code": "ENCRYPTED" }
```

- A failure is always a `success:false` object, so it never collides with success output (text or arrays). With multiple inputs each failure emits one line.
- Exit codes and fields are stable; `code` values are only ever added. The `error` string is for humans, not part of the contract.

| `code` | Meaning |
|---|---|
| `ENCRYPTED` | open password required (`--password`) or wrong |
| `DRM_PROTECTED` | Hancom document security (DRM) — cannot be opened |
| `UNSUPPORTED_FORMAT` | unsupported format |
| `CORRUPTED` | signature mismatch or unrecoverable damage |
| `IMAGE_BASED_PDF` | scanned PDF without a text layer (needs `--ocr`) |
| `ZIP_BOMB` / `DECOMPRESSION_BOMB` | decompression-bomb guard triggered |
| `NO_SECTIONS` | no body sections |
| `OUTPUT_TOO_LARGE` | output serialization exceeds the runtime string limit |
| `MISSING_DEPENDENCY` | optional dependency not installed (pdfjs-dist, …) |
| `EMPTY_INPUT` | empty input |
| `FILE_NOT_FOUND` | input path does not exist (ENOENT) |
| `PARSE_ERROR` | any other parse failure |

### Image bundles — `images/<document name>/manifest.json`

With `-o`/`-d`, images go to a per-document folder `images/<document name>/` with a `manifest.json` (converting several documents into one folder never overwrites images). `--format json --image-refs` keeps only paths instead of bytes.

```json
[ { "name": "image_001.png", "mimeType": "image/png", "bytes": 68, "source": "BinData/image1.png" } ]
```

- `mimeType` is detected from the file header (magic bytes); `source` is the path inside the original container.
- Images are stored as-is (only PDF images are re-encoded to PNG) — trust `mimeType` over the extension.

---

## 🤖 MCP Server

Automatic setup: [`npx -y kordoc setup`](#ai-agent-integration-mcp--30-seconds). Manual registration:

```bash
codex mcp add kordoc -- npx -y kordoc mcp          # Codex
```

```json
{ "mcpServers": { "kordoc": { "command": "npx", "args": ["-y", "kordoc", "mcp"] } } }
```

On Windows, if Claude Desktop can't find `.cmd`, use `"command": "cmd", "args": ["/c", "npx", "-y", "kordoc", "mcp"]`.

**22 tools**

| Tool | Description |
|------|-------------|
| `parse_document` | HWP/HWPX/PDF/XLSX/DOCX/PPTX → Markdown (with metadata) |
| `detect_format` | format detection via magic bytes |
| `parse_metadata` | fast metadata only |
| `parse_pages` | a page range only |
| `parse_table` | the Nth table only |
| `parse_chunks` | RAG structure chunks — heading/outline breadcrumbs + standalone table chunks |
| `compare_documents` | compare two documents (cross-format) |
| `parse_form` | form fields as JSON |
| `fill_form` | fill a form (HWPX format-preserving, format/uniqueness guards, built-in `template`, values from a JSON `fields_file` — values stay out of the conversation and the reply shows only their lengths) |
| `patch_document` | apply edited Markdown back into the original HWPX/HWP, format preserved |
| `convert_to_hwpx` | HWP → HWPX — HWP 5.x keeps its formatting (fonts, paragraph shapes, tables, pictures, shapes, equations, headers, footnotes, charts), HWP 3.x carries text and tables only. Needs `output_path` when a same-name .hwpx already exists |
| `extract_profile` | table format profile JSON from a reference HWPX — reuse via `generate_document`'s `profile_path` |
| `generate_document` | Markdown (tables/equations/charts) → HWPX, official-document presets (table total row goes right under the header by default — `total_row`), department template `template_path`, agency pack `pack_path` |
| `build_agency_pack` | a few agency documents (HWPX) → agency pack (.kpack): picks a representative template, strips original text, writes a writing guide ([agency packs](agency-pack-en.md)) |
| `agency_pack_info` | agency pack summary and writing guide — read it before writing a manuscript for the pack |
| `lint_document` | official-document review — notation always, plus opt-in style/slop/logic/number/budget checks (calculation basis, table totals, foreign currency, increase basis); each finding has line and column |
| `place_seal` | float a stamp/signature image over an anchor phrase |
| `add_memo` | attach a memo (Hangul "insert memo") to an anchor phrase — body text and formatting untouched. Read existing memos with `parse_document`'s `memos` |
| `render_document` | render HWPX/HWP as typeset to PNG/JPEG (inline) or SVG/HTML/PDF files — lets the AI visually check generated/edited output |
| `redact_document` | PII detection + format-preserving masking (HWPX/HWP incl. headers, footnotes, previews and document info, with a re-scan; other formats: masked Markdown) |
| `crop_regions` | crop rendered regions (tables/images/paragraphs/shapes) from page images at true scale + regions.json |
| `extract_tables` | table classification (data / org-chart-like / uncertain) + page·bbox + policy-based crops — org charts as images, data tables as structure |

---

## 📚 API

### Parsing

| Function | Description |
|----------|-------------|
| `parse(buffer, options?)` | auto format detection → Markdown + `IRBlock[]` (a file path string works too) |
| `parseHwpx` · `parseHwp` · `parseHwp3` · `parseHwpml` | HWPX · HWP 5.x · HWP 3.x (1996–2002) · HWPML only — all `(buffer, options?)` |
| `parsePdf` · `parseDocx` · `parsePptx` · `parseXlsx` · `parseXls` | PDF · DOCX · PPTX · XLSX · XLS (Excel 97–2003, BIFF8) only |
| `parseImage(buffer, options?)` | images (PNG/JPG/WebP) only — built-in OCR always on |
| `detectFormat(buffer)` | synchronous magic-byte detection — returns `hwpx` for ZIP and `hwp` for OLE2 for backward compatibility |
| `await detectZipFormat(buffer)` | ZIP entries → `hwpx` · `xlsx` · `docx` · `pptx` · `unknown` |
| `detectOle2Format(buffer)` | OLE2 streams → `hwp` · `xls` · `unknown` |

To tell ZIP formats apart, call `await detectZipFormat(buffer)` when `detectFormat()` returns `hwpx`.

### Compare · forms · editing

| Function | Description |
|----------|-------------|
| `compare(bufferA, bufferB, options?)` | IR-level document comparison |
| `extractFormFields(blocks)` / `extractFormSchema(blocks)` | form field recognition / + type, required, empty inference |
| `fillForm(input, values, outputFormat?)` | fill a form — `"markdown"` (default) · `"hwpx"` · `"hwpx-preserve"`, returns `{ output, format, fill }` |
| `fillFormFields(blocks, values)` | replace field values on IRBlock[] |
| `fillHwpx(buffer, values)` | direct HWPX XML manipulation (format-preserving) |
| `extractClickHereFields(buffer)` | inspect HWPX click-here (CLICK_HERE) fields — names and guide text |
| `resolveBuiltinTemplate(name)` / `readBuiltinTemplate(t)` | look up / load built-in draft templates (`gian` · `gian-simple`) |
| `patchHwpx(original, editedMarkdown, options?)` | edited Markdown → format-preserving HWPX patch |
| `patchHwp(original, editedMarkdown, options?)` | edited Markdown → format-preserving HWP 5.x binary patch |
| `openHwpxDocument(bytes, options?)` | `HwpxSession` incremental block-patch session for editors |
| `patchHwpxBlocks(bytes, edits, options?)` | one-shot block edits without a session |
| `placeSealHwpx(buffer, seals)` | float stamp/signature images over anchor phrases |
| `addMemoHwpx(buffer, memos)` | attach memos to anchor phrases — `{ anchor, text, author?, occurrence? }` |
| `validateHwpx(buffer)` | HWPX structure validation — ZIP, mimetype, required parts, XML well-formedness |

### Generate · render

| Function | Description |
|----------|-------------|
| `markdownToHwpx(markdown, options?)` | Markdown → HWPX (theme, format profile, page options, official-document presets) |
| `hwpxToProfile(buffer)` | reference HWPX → table format profile JSON (reuse via `markdownToHwpx(md, { profile })`) |
| `buildAgencyPack(name, samples, into?)` · `loadAgencyPack(buf)` · `packTemplate(pack, kind?)` | build / read an agency pack and get the template for a document kind — `markdownToHwpx(md, { template: packTemplate(pack) })` ([agency packs](agency-pack-en.md)) |
| `markdownToPdf(markdown, options?)` / `blocksToPdf(blocks, options?)` | Markdown / IRBlock[] → PDF (install `puppeteer-core` separately) |
| `renderHtml(blocks, options?)` | IRBlock[] → print-ready HTML (no puppeteer; raw HTML passes only allowed tags, plus CSP) |
| `renderHwpxToSvg(buffer, options?)` | HWPX → layout-preserving SVG — multi-page, highlights, shapes; `reflow` when cache-less |
| `renderDocument(input, { format, pages?, … })` | HWPX / HWP (5.x) → per-page svg/png/jpeg or document html/pdf assets + `RenderScene` (page-local pt bboxes, deterministic region ids) |
| `extractRenderedRegions(input, { types?, pages?, … })` | crop table/image/paragraph/shape regions from page images at true scale |
| `extractTables(input, { policy?, … })` | table classification (data / org-chart-like / uncertain) + render-region join + policy-based crops |

### Text · conversion helpers

| Function | Description |
|----------|-------------|
| `lintGongmunText(text, { document?, parsed? })` | 27 official-notation rules + 2 AI-slop rules (`document: true` adds document-level attachment / "끝." checks; `parsed: true` for text parsed from a document skips manuscript-only rules) |
| `redactMarkdown(text, options?)` / `redactText(...)` | PII detection + masking — text level (file level: CLI `redact`, MCP `redact_document`) |
| `blocksToChunks(blocks, options?)` | RAG structure chunks — heading/outline breadcrumbs + standalone table chunks |
| `blocksToMarkdown(blocks)` | IRBlock[] → Markdown |
| `blocksToPages(blocks)` | IRBlock[] → `[{ pageNumber, markdown }]` |

### Types

```typescript
import type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  DocumentMetadata, ParseOptions, ErrorCode, OutlineItem,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult, FormFieldType, FormFieldSchema, FormSchemaResult,
  FillResult, HwpxFillResult, FillOutputFormat, FillFormOutput,
  ClickHereField, BuiltinTemplate,
  PatchOptions, PatchResult, PatchSkip,
  HwpxTheme, MarkdownToHwpxOptions, PageOptions,
  PrintPreset, PrintOptions, PageMargin,
  RenderSvgOptions, RenderSvgResult,
  SealOp, SealPlacement, PlaceSealResult,
  ValidateResult, ValidateIssue,
  RedactRule, RedactOptions, RedactHit, RedactTextResult,
  DocChunk, ChunkOptions, GongmunLintFinding,
  OcrProvider, WatchOptions,
} from "kordoc"
```

---

## 📂 Supported Formats

| Format | Engine | Highlights |
|--------|--------|-----------|
| **HWPX** (Hancom 2020+) | ZIP + XML DOM | manifest, nested tables, merged cells, corrupted-ZIP recovery, real page boundaries from the typesetting cache, open passwords, form check boxes and radio buttons |
| **HWP 5.x** (Hancom legacy) | OLE2 + CFB | distribution-copy decryption, open passwords, corrupted-CFB recovery, footnotes/hyperlinks, 21 control chars, image extraction, real page boundaries |
| **HWP 3.x** (1996–2002) | single binary | Johab → Unicode, 5,893 Hanja/symbol lookup, nested paragraphs, arae-a (archaic Hangul), open passwords |
| **HWPML 2.x** (XML-based HWP) | XML DOM | HeadingType-based headings, merged cells, DoS guards |
| **PDF** | pdfjs-dist | ruled, clip-based and borderless tables, XY-Cut reading order, two-column pages, headings, footnotes/endnotes, math-font recovery, OCR, underline/links, image extraction, text-quality signals |
| **XLSX** (Excel) | ZIP + XML DOM | shared strings, merged cells, multiple sheets, formula display, date cells to ISO, large-sheet streaming |
| **XLS** (Excel 97–2003) | OLE2 + BIFF8 | Workbook stream, SST shared strings, cell/sheet extraction |
| **DOCX** (Word) | ZIP + XML DOM | style-based headings, numbering (real number labels), footnotes, hyperlinks, image extraction |
| **PPTX** (PowerPoint) | ZIP + XML DOM | presentation order (sldIdLst), one slide = one page, title placeholders as headings, two-level body bullet lists, merged tables, speaker notes (as quotes), image extraction, hidden slides skipped. Chart/SmartArt text: warning only |
| **Images** (PNG/JPG/WebP) | sharp + built-in OCR | screenshots and scans as direct input, tables recovered from raster rules |

---

## 🔒 Security

- Guards against ZIP and decompression bombs, XXE, path traversal and SSRF — details in [SECURITY.md](../SECURITY.md).
- **Air-gapped networks**: `KORDOC_OFFLINE=1` blocks all outbound traffic, and `KORDOC_ROOT=<dir>` confines MCP file access to that directory. Offline install bundles and moving models: [docs/offline-deployment.md](offline-deployment.md).

---

## License

[MIT](../LICENSE). This project includes the following open-source software:

- **rhwp** (MIT, edwardkim) — HWP5 distribution-copy decryption and lenient CFB parsing algorithms, the draft templates in `templates/`
- **claw-hwp** (MIT, DoHyun468) — OOXML chartSpace assembly, floating stamp placement metrics, secure-fill format engine, validate check set
- **OpenDataLoader PDF** (Apache 2.0, Hancom Inc.) — PDF table detection algorithm
- **hml-equation-parser** (Apache 2.0, Open Bapul) — HML equation parsing
- **PaddleOCR** (Apache 2.0, PaddlePaddle) — derived text OCR engine (PP-OCRv5 korean)
- **Pix2Text** (MIT, breezedeus) — formula OCR (MFD/MFR) algorithm port. Models are downloaded at runtime and not redistributed — the MFD weights are based on Ultralytics YOLOv8 (AGPL-3.0), so commercial or closed products relying on formula OCR should check those terms separately
- **cfb** (Apache 2.0, SheetJS) — HWP5 OLE2 container parsing
- **pdfjs-dist** (Apache 2.0, Mozilla) — PDF text extraction
- **JSZip** (MIT, Stuart Knightley et al.) — ZIP-based format parsing

Full notices are in [NOTICE](../NOTICE) and license texts in `THIRD_PARTY/` — both ship in the npm package.
