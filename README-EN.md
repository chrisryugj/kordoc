# kordoc

**모두 파싱해버리겠다** — Parse them all.

[![npm version](https://img.shields.io/npm/v/kordoc.svg)](https://www.npmjs.com/package/kordoc)
[![license](https://img.shields.io/npm/l/kordoc.svg)](https://github.com/chrisryugj/kordoc/blob/main/LICENSE)

> *Korea's document hell is second to none. Built by a civil servant who survived seven years in it.*

HWP 3.x/5.x, HWPX, HWPML, PDF, XLS, XLSX, DOCX, images (PNG/JPG/WebP) — parse, compare, analyze, and generate every document format Korean government offices throw at you.

[한국어](./README.md)

[![kordoc — watch the demo](./docs/video-demo.jpg)](https://youtu.be/Q13GmgDcIw0)

<sub>▶ Click to play on YouTube. Narration is in Korean.</sub>

---

## ⚡ 30-Second Setup (AI Agent Integration)

**macOS / Linux / Windows.** All you need is Node.js 18+.

```bash
npx -y kordoc setup
```

An interactive wizard:
1. Pick your AI client (Claude Desktop / Cursor / Claude Code / Windsurf / VS Code / Gemini CLI / Zed / Antigravity / Codex — installed ones show `[detected]`)
2. Patches the config file automatically → restart the client

Windows gets automatic `cmd /c npx` wrapping. No manual JSON editing. After restart, 15 document tools (`parse_document`, `parse_table`, `fill_form`, `patch_document`, `generate_document`, `place_seal`, …) are live.

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

*   **📄 Any document to Markdown**: Convert `HWP3` (legacy), `HWP` (5.x), `HWPX`, `HWPML`, `PDF`, `XLS`, `XLSX`, `DOCX` — and `PNG`/`JPG`/`WebP` images (automatic OCR) — to `Markdown` instantly — the ideal shape for LLMs to read and reason about.
*   **📊 Faithful table reconstruction**: Borderless PDF tables and heavily merged HWP tables are analyzed structurally and restored as accurate markdown tables. Old-vs-new clause comparison tables in legislative amendment PDFs survive intact (v3.16.2).
*   **🔍 Automatic redline (diff)**: Compare two documents and see exactly what changed — including cross-format comparison (HWP vs HWPX).
*   **📝 Markdown back to HWPX**: Turn AI-written content back into report-form `HWPX`. No more copy-paste drudgery.
*   **🏛️ Government-standard document generation (v4.0)**: An official-document engine built by exhaustively decoding 16 real government templates plus 60 actually-approved drafts. Gaejosik reports (cover, TOC banner, Roman-numeral chapter headers, page numbers, approval box), draft documents (statutory head/foot blocks, automatic "끝."), public-notice and press-release presets, 8-level Korean item numbering, and a 13-rule notation linter (`kordoc lint`) — all verified down to the typeset output via Hancom COM rendering.
*   **🔄 Lossless format-preserving roundtrip (v3.0)**: Edit the converted markdown and hand it to `patchHwpx` (HWPX) / `patchHwp` (HWP 5.x binary) — only the changed paragraph/cell text is swapped in place, **without touching a single byte of the original formatting**. Row insertion/deletion inherits neighboring-row formatting (v3.7); filling originally-empty HWP 5.x cells works too (v3.8).
*   **🖼️ Layout-preserving render (v3.10–3.17)**: Reproduce the original layout as SVG from Hancom's saved typesetting cache; files without a cache (AI-generated HWPX, edited output) are typeset directly by a **pure-TS reflow engine**. Multi-page, multi-section, per-run fonts, landscape pages, tables, drawing shapes, search-term highlighting — HWPX previews on a server with no Hancom installed.
*   **📊 Chart generation (v3.16)**: A markdown ```chart fence (type/cat/series lines) becomes a native Hancom chart (OOXML chartSpace) — 20 types including bar/line/pie/donut/area/scatter/radar, with per-series colors.
*   **🔴 Stamp/signature placement (v3.16)**: Finds anchor phrases like "(인)" ("seal here") and places a stamp PNG as a floating object in front of text. Tables and pages never grow, so stamping doesn't shift the layout (`kordoc seal`).
*   **✏️ Form auto-fill**: Feed values into official form templates (applications, reports) and every blank is filled — preserving 100% of the original formatting (font, size, alignment).
*   **🤖 AI agent integration (MCP)**: Let `Claude Desktop`, `Cursor`, `Codex`, and friends call `kordoc` directly to read and produce documents.

---

## What's New in v4.12.0

Cleared **all remaining** HWP3 text loss left after v4.11.0. Comparing the nine HWP3 originals in rhwp `samples/` against their Hancom-converted twins by character multiset, the only characters still missing are image alt-texts — everything else is **0**.

- **🖼️ Text boxes inside drawing objects (#73)**: in HWP3, the extension block of the ch=11 (picture) control is a **drawing-object tree**, not an image, when `pic_type` is 3. Cover titles and flowchart labels live in text boxes there, and the block was skipped wholesale, so that text vanished (618 characters in sample16, 86 in sample19). kordoc now walks the frame header and shape tree (sibling/child bits) and reads each text box's paragraph list with the same parser as body text. Non-textbox shapes that carry the same block via "convert to text box" are recovered **only when the surplus length matches spec table 78 exactly**. The whole walk stays inside the extension-block slice, so a failure can't desync the body stream — it falls back to the previous skip-it-all behavior (recursion capped at 256 levels, 4,096 shapes).
- **🔣 Invisible markers leaked as a replacement character**: the new-number, page-number-position, and page-hide controls emitted `￼` (U+FFFC) into the body, which survived into the Markdown. Hangul renders nothing at those positions — they now follow the same contract as the table-of-contents marker.

## What's New in v4.11.0

Swept the latest rhwp devel (v0.8.3–0.8.4) and folded the findings into kordoc's HWP3 decoder. All four defects **drop characters without a warning** — the conversion "succeeds" and part of the body is simply missing.

- **🈳 Lost HWP3 symbols and hanja (missing coordinate rules)**: HWP3 stores characters as KS X 1001 coordinates — the symbol rows (0xA1–0xAC) with a stride of 96, the hanja rows (0xCA–0xFD) with a stride of 94. When the johab decoder was ported from rhwp, only the hardcoded table came along and **both rules were left behind**, so every code outside that table was dropped: `채권(債權)조서` became `채권()조서`, and symbols like `※ ○ 【】 ∴ ☞ ￦ ━` disappeared entirely. Both rules are ported, plus the two positions where Hancom's notation diverges from the standard mapping (`∼→～`, `⊙→◉`).
- **🔤 Wider measured table for private codes**: ported the Latin-1 Supplement pass-through (`ü·ö·ä·ß` were deleted, turning "für" into "fr") and the 28 measured codes from rhwp #5860, then added codes that rhwp's table lacks — six box-drawing pieces, the double rule, circled/parenthesized series (`⓪①②`, `ⓐ–ⓕ`, `㉠–㉢`), the `•` bullet. Each was aligned against the Hancom-converted twin of the same document, and **only codes whose occurrence count matches the converted file exactly** were added.
- **✒️ Lost araea syllables with a filler initial**: a syllable carrying only the araea vowel was treated as having an invalid initial and thrown away. It now survives as the single jamo, matching Hancom's own conversion.
- **🧱 Formatted runs skipped PUA cleanup (all formats)**: paragraphs with bold/underline go through the span path, which was the one place that skipped PUA substitution and stripping — so Hancom-only bullets and rule fragments landed in the Markdown as **raw PUA (tofu)**. This path is shared by HWP5, HWPX, and HWP3. Also synced the 22 entries missing from kordoc's copy of rhwp's verified Hancom PUA table (`┌┬┐└┘│`, `┈═━`, `⓪①②④–⑨`, `✺◇▸□`, `⊞⊟`).

Verified by comparing character multisets between nine HWP3 originals in rhwp `samples/` and their Hancom-converted twins. Characters present only in the converted file (i.e. lost by the HWP3 path) fell from 189→0 in `hwp3-sample11`, 1,139→618 in `hwp3-sample16`, and 172→11 in `hwp3-sample10`. The remaining 618 live in **text boxes inside drawing objects** (cover titles, flowchart labels), which kordoc still skips.

## What's New in v4.10.0

- **📡 Failure contract in every format (#69)**: the failure JSON (`success:false` + `code`) previously reached stdout only with `--format json`; it now covers **markdown and chunks** too, so headless pipelines branch on the cause code instead of keyword-matching Korean stderr messages. The code set, exit-code rule, and a stability guarantee are documented in the README. (reported by @sorbetsharkroundhand)
- **🖼️ `images/manifest.json` (#70)**: saving images now also emits a `[ { name, mimeType, bytes, source } ]` manifest with magic-byte-verified `mimeType`, removing extension guessing on the consumer side. Also replaces the DOCX fallback that mislabeled unknown image extensions as `image/png`. (reported by @sorbetsharkroundhand)
- **🩹 patchHwp soft-wrap shrink integrity (#71)**: replacing a soft-wrapped paragraph (2+ LINE_SEG segments) with a shorter single line left trailing segments whose `textpos` pointed beyond the new `nChars`, making **Hangul refuse to open the file with a "damaged/tampered" warning**. Out-of-range trailing segments are now trimmed with `lineSegCount` kept consistent (in-range segments are preserved so soft-wrap rendering survives). Rewritten compressed streams also restore Hancom's 8-byte tail (CRC32 + uncompressed size, verified on 7/7 corpus files). (reported by @heesun-woodi)

## What's New in v4.9.2

Opened a real report whose `<right>` source lines wrap past one line in Hangul, and fixed what showed up.

- **📌 Left-align fallback for multi-line source lines**: when a `<right>` paragraph (source citations, dates) exceeds the body width, right alignment leaves **each line's left edge ragged**, which reads as broken indentation (confirmed in Hangul — a three-line citation). The generator now pre-measures the typeset width: lines that fit stay right-placed (measured GT6/GT7/GT11 practice), overflowing ones are emitted left-aligned.
- **🔤 Caption style for source lines**: `<right>` lines starting with `출처:`/`자료:` used the body size and did not read as captions. A dedicated charPr renders them **3pt smaller than body** (floor 10pt) — HY Junggodic on the measured presets (gaejosik/report/plan), the body font elsewhere — following the practice of distinguishing table source notes from body text. Other `<right>` lines (e.g. dates) keep the body size.

## What's New in v4.9.1

Generated a real district review report, opened it in Hangul, and checked every visible oddity against a 555-document corpus. All three defects came from the same root cause — **one template file's stored values outranking actual practice**.

- **📐 Paragraph spacing between `○` items**: the default space-before was `□15pt/○10pt/-6pt`, taken from a single template file. The corpus says the opposite — **88%** of 582 `□` paragraphs and **88%** of 799 `○` paragraphs use **zero** space-before, and the old values do not even reach the top six (1.5pt ranks second). Combined with 160% line spacing, 10pt stretched the gap between items to 1.4 lines. Now set to the measured mode, keeping 1.5pt on `□` alone for section separation.
- **📑 Indentation of `가./나.` subheadings under `□`**: h3/h4 paragraphs had no left margin, so while `□` hung its marker to the left, subheadings started at the body edge and rendered **further left than their parent**, collapsing the hierarchy (confirmed in Hangul). They are now indented by the `□` marker width to align with the parent's title text.
- **📎 Attachment numbering no longer lost**: an indented `2. …` following `붙임  1. …` was parsed as a Markdown list and replaced with a bullet (`ㆍ`), **dropping the number**. Attachments are now a dedicated block that follows measured practice — one blank line before (95% of 343 samples), numbers `1. 2. 3.` preserved (zero bullet substitutions observed), and leading whitespace on later items kept so they align vertically with the first number (122 of 123 samples).
- **✍️ Gaejosik prose linter (`kordoc lint --munche`)**: 12 rules on a different axis than notation — declarative `~다` endings (measured 0%), deontic `~해야 한다`, `A-not-B` rhetoric with an abstract B (measured 0), question/exclamation marks in body text (measured 0), couplet slogans, items over 70 chars and conclusions over 60, and lead sentences not ending in `~하고자 함.`. Warnings attach automatically to `generate` for the report/plan/gaejosik presets (generation is never blocked); `kordoc lint` requires `--munche` to opt in. Not applied to drafts/notices/minutes/press releases, whose prose conventions differ. Rules and evidence: [`docs/gaejosik-munche.md`](docs/gaejosik-munche.md). Statistics come from [jkf87/hwpx-skill](https://github.com/jkf87/hwpx-skill) v1.17.0 (15 municipal reports, 2,288 lines).

## What's New in v4.9.0

- **🧹 AI-slop lint for official documents (`AI_*` rules)**: the gongmun style linter now flags stylistic traces that generative-AI drafts leave in official documents — dash usage (`AI_EM_DASH`: — – ―) and three or more bold spans on one line (`AI_BOLD_OVERUSE`). Both are advisory warnings shared by `kordoc lint` and the `generate` warning channel, kept separate from the 13 handbook-derived rules. Distilled from producing a real district review report as official HWPX. Writing guidance (dashes → commas/parentheses, one emphasis per point, loanwords → administrative terms) is reflected in `.claude/skills/gongmunseo/`.
- **📄 Renderer honors explicit page breaks (`pageBreak="1"`)**: the reflow renderer previously ignored `<hp:p pageBreak="1">` (how Hangul stores a manual page break) and kept flowing; it now starts a new page at that paragraph, so gaejosik chapter banners and post-processed documents render with the same page boundaries as Hangul.

## What's New in v4.8.0

- **📑 Per-page markdown in `--format json` (#68)**: JSON results now carry `pages: [{ pageNumber, markdown }]` by default, built from the real page boundaries introduced in v4.7.3 (`pageMode: "layout"`). Use it for RAG page citations or viewer page sync without re-parsing — the projection reuses the `pageNumber` already on each block, costing under 1% of parse time (24-page PDF: parse 399ms, pages 2.5ms). `--pages 3-5` narrows `pages` to those pages, and formats that do not number pages (DOCX, …) simply omit the field rather than claiming everything is page 1. The library exposes the same projection as `blocksToPages(blocks)`. (suggested by @sorbetsharkroundhand)

  A table spanning several pages is still one block anchored to its starting page, so the continuation pages carry an empty `markdown`. The entries are kept so array length still equals the page count; per-page table splitting is a separate feature.

## What's New in v4.7.3

- **📄 Real page boundaries for HWP/HWPX (#66)**: page boundaries are recovered from Hangul's layout cache (HWPX `linesegarray` / HWP5 `PARA_LINE_SEG`), so `pageCount` and each block's `pageNumber` are real page numbers rather than a section approximation, and `parse(buffer, { pages: "3-5" })` returns actual pages 3–5. Files without a layout cache keep the section approximation, distinguished by the new `metadata.pageMode: "layout" | "section"` (filtering under the approximation raises a `PAGE_BOUNDARY_APPROXIMATE` warning).

## What's New in v4.7.2

- **🔒 Air-gapped deployment**: `KORDOC_OFFLINE=1` blocks every outbound request (OCR model download, watch webhook) *before* it is sent, and `KORDOC_ROOT=<dir>` confines the MCP server's reads and writes to that directory subtree — both opt-in, so unset behaviour is unchanged. Build an offline install bundle with `node scripts/pack-offline.mjs [--with-ocr] [--with-models]`, and move OCR models across the air gap with `kordoc models --export/--import` (SHA-256 verified). See [docs/offline-deployment.md](docs/offline-deployment.md) for the procedure and security-review evidence.
- **🧹 Dependency hygiene**: `npm audit --omit=dev` reports 0 vulnerabilities (sharp ^0.35.0, adm-zip ^0.6.0 override, MCP SDK chain advisories cleared).

## What's New in v4.7.1

- **✏️ Underline preservation across formats**: the underlines v4.7.0 recovers from PDFs are now emitted from HWPX and HWP 5.x as `<u>…</u>` too. Detection keys on the underline *kind*, not its presence — Hancom writes `type="NONE"` even on non-underlined runs.
- **🔗 PDF link annotations**: `/Annots` Link entries (`/URI`) are correlated with text and emitted as `[text](url)`, with scheme allowlist sanitization.

## What's New in v4.7.0

- **✏️ PDF underline detection**: thin horizontal lines hugging the baseline are correlated with text and preserved as `<u>…</u>`. PDFs carry no underline font flag, so previous versions dropped them entirely. Five layers of false-positive defense against table rules and decorative badges. Measured: 32 of 48 corpus documents recover emphasis underlines.

## What's New in v4.6.1

- **📰 Two-column reading order fix (#64)**: PDFs typeset in two columns (exam papers, magazine layouts) came out with left/right columns interleaved row by row. A new geometry-only column detector (no prose assumptions like justification or long lines) restores the natural order — full left column, then full right column, with full-width elements (headers, page-number boxes) acting as band boundaries. Applies to the default mode, `--no-tables`, and the OCR path. Measured on the 2026 CSAT papers: with `--no-tables`, Physics I and Ethics both recover 20/20 questions with 0 order inversions (previously 13 questions / 3 inversions), Korean 44/45 with 0. Three row-structure guards (calibrated against the regression corpus) prevent false positives on ordinary documents — the PDF coverage gate stays at baseline. (reported with block dumps by @choa712)

## What's New in v4.6.0

- **🚫 PDF table-detection opt-out (#64)**: `--no-tables` (CLI) / `tables: false` (API·MCP). Visual bordered boxes (instruction/choice boxes on two-column exam papers) were picked up as line-based tables, pulling surrounding body text into cells and reversing reading order — with no way to turn detection off. The opt-out path skips line grids, cluster tables, multi-column alignment and Korean special tables, emitting natural reading-order paragraphs only. Default is unchanged (detection on). (reported by @choa712)
- **🖼️ JSON output for image-heavy documents (#65)**: HWP files with hundreds of images overflowed the runtime string limit during base64 serialization, so `--format json` ended in **non-JSON** output with no failure contract. Now `--image-refs` keeps only saved paths instead of bytes, oversized runs downgrade to reference mode automatically, and any post-parse failure still emits failure JSON with a cause code (`OUTPUT_TOO_LARGE`, …). (reported by @choa712)
- **🔤 Nested inline emphasis (#61)**: `**bold *italic* again**` produced literal asterisks, lost bold, and inverted styles — a common pattern in LLM-authored markdown, so the `generate_document` path was heavily exposed. (reported and fixed by @LeeYudok, PR #62)
- **📄 BOM-prefixed XML parts (#63)**: a UTF-8 BOM before the XML declaration in `[Content_Types].xml`/`.rels` (written by some OpenXML writers, and opened fine by Excel/LibreOffice) made xmldom reject the whole xlsx/docx with `PARSE_ERROR`. (reported by @soyesenna)

## What's New in v4.5.0

- **📄 Page options**: paper size (A4·A3·B4·B5·Letter·custom mm), **landscape orientation**, **multi-column** (1–8), and **header/footer text** — API `page`, CLI `--paper/--landscape/--columns/--header/--footer`, MCP `generate_document` parameters. Headers/footers use the same `<hp:header>`/`<hp:footer>` structure as real Hancom files.
- **🔗 Hyperlink generation**: `[text](url)` now emits a real 6-param `HYPERLINK` field (clickable in Hancom Office) instead of collapsing to plain text — and round-trips back to `[text](url)` on re-parse. Works inside table cells; dangerous schemes are sanitized.
- **📎 Footnote objects**: `[^1]` markers with `[^1]: body` definitions emit real `<hp:footNote>` objects that Hancom typesets at the bottom of the page.
- **🖼️ Real image embedding**: supply bytes via the `images` option, `data:` URIs, or CLI/MCP `--image-dir` to embed PNG/JPEG/GIF/BMP into BinData — pixel dimensions auto-converted (96dpi) and capped to body width. References without bytes keep the previous placeholder round-trip behavior.
- **🔍 OCR low-confidence observability**: lines silently dropped by the built-in OCR (confidence < 0.5) are now reported via an `OCR_LOW_CONF` warning.
- **📏 Scanned-table benchmark correction**: reference "tables" that carry no table structure (decorative vector grids from clipart, single-cell text boxes — fewer than 3 non-empty cells) are excluded from the scoring population, with the excluded count reported transparently. Corrected measurement: scanned-table match **71.4%**, cellF1 **0.595** (char recall/CER unchanged from v4.4.1).

## What's New in v4.2.6

- **📐 Left-aligned body for outline/report documents**: Body items (□/○/-) in outline (gaejosik) and report gongmun documents are now left-aligned instead of justified. When word-keeping meets justification, a line that breaks early (e.g. a 25-char line stretched to a 34-char column because the next word is long) got excessively wide inter-word gaps, making paragraphs look broken. This matches the left-aligned convention of the official Korean administrative style guide. Narrative-body justification for official drafts (official preset) is unchanged.

## What's New in v4.2.3

- **Inline table/text order preservation (#49·#50)**: when an inline (treatAsChar) table and text alternate within one paragraph or one cell (date-range form fields like `[date] from [date] to`), text was pulled ahead of the tables, reversing the reading order. Both top-level `blocks` and `IRCell.blocks` now follow document order, and the generator emits cells in the same order for symmetric roundtrips. Floating/page-anchored tables stay out of the text flow as before. (reported by @jumaniac)

## What's New in v4.2.2

- **~~Strikethrough~~ extraction (HWP5·HWPX)**: deletion marks in legislative amendment documents now survive as markdown `~~strikethrough~~`. Detection uses a strike-**shape** whitelist — Hancom stores the strikethrough bits as a default even on non-struck text (measured in upstream rhwp), so only real line kinds count and unknown values fail closed. HWPX supports partial-run strikes; HWP5 works at paragraph level.
- **ZIP decompression limit 100→256MB**: large real-world documents with a single 75MB section XML (found in rhwp's 10k-document survey) were being rejected as ZIP bombs — limit raised.

## What's New in v4.2.1

- **🖼️ Direct image input (PNG/JPG/WebP)**: convert screenshots and scanned images without wrapping them in a PDF — `kordoc form.png` / `parse(buffer)` / MCP `parse_document`. Images have no text layer, so the built-in OCR is applied automatically (no flag needed; decoding uses the optional dependency `sharp`).
- **📐 Raster ruling-line detection for scans**: the OCR path now finds horizontal/vertical table rules directly in the page pixels (binarization + run-length, no ML) and feeds them into the line-based table pipeline. Forms with tall merged label cells and multi-line prose cells (Korean government submission forms) are restored as proper tables with rowspan/colspan. The cluster detector remains as the fallback for borderless tables.

## What's New in v4.2.0

- **👓 Built-in text OCR (PP-OCRv5 korean)**: read scanned/image PDFs with **local inference, no API key** — `parse(buffer, { ocr: true })` / CLI `--ocr` / MCP `parse_document`'s `ocr` option. Models (~18MB) auto-download with SHA-256 verification on first use. Only pages flagged by the quality signals (scans, broken font mappings) are OCR'd — clean pages keep their parsed output — and OCR line boxes are fed through the table-detection pipeline, so **tables survive in scans**. Korean dictionary covers all 11,172 precomposed Hangul syllables; ≈1s per page on CPU.
- **🩹 HWP3 legacy parser conformance ×3**: stream-consumption defects for tab/field-code/bookmark control chars corrupted all following text, and roman numerals (Ⅰ–Ⅹ), circled digits (①–⑩), quotes, and bullet glyphs silently vanished — fixed by porting follow-up patches from the upstream (rhwp) source.
- **🐛 Formula-OCR page off-by-one**: `--pages` filtering was shifted by one page and formulas attached to the previous page's blocks (pdfium page indices are 0-based). Also fixed: XLSX/XLS `--keep-empty-cols` wiring gap.

## What's New in v4.1.0

- **👁️ `render_document` MCP tool (new)**: renders a generated/patched/filled HWPX exactly as typeset and **returns it as a PNG image in the response** — the AI can visually inspect its own output and fix it, closing the generate→render→verify loop inside MCP (typeset cache for Hancom-saved files, reflow engine for generated ones, search-term highlighting).
- **🕶️ `kordoc redact` + `redact_document` MCP (new)**: detects PII (resident registration no., phone, email, card, account; passport/driver license opt-in) and outputs a **format-preserving masked** HWPX/HWP (`850315-●●●●●●●`). Birthdate/Luhn validation reduces false positives; the report never contains the original PII. An assistive detector — human review before disclosure is required.
- **📦 `--format chunks` + `parse_chunks` MCP (new)**: structure-preserving chunk JSON for RAG — heading/outline hierarchy (□○- / 1.·가.·1)) becomes breadcrumb paths, tables become standalone chunks.
- **📋 Trailing empty column preservation (#47)**: blank input columns in form documents were deleted wholesale during parsing — the new `keepTrailingEmptyCols` parse option (CLI `--keep-empty-cols`) preserves anchored empty columns (phantom span-inflation columns are still trimmed), and **form paths (parse_form / fill) always preserve them**, so fillable fields no longer vanish from field listings. Reported by [@jumaniac](https://github.com/jumaniac).
- **📅 XLSX/XLS date conversion**: date cells no longer surface as serial numbers ("45306") but as ISO ("2024-01-15") — built-in and custom numFmt detection, date1904 handling.
- **🛡️ Production-wide review, ~80 fixes**: hostile-file hardening (equation regex ReDoS, HTML table span explosion, HWP3 decompression bomb, XLSX grid blowup), table-only PDFs misjudged as image-based, HWP5 control-char (hyphen/fixed-width space) mapping, DOCX tracked-change insertions lost, four form-fill label mismatch classes, HWP5 patch data remanence zeroed, MCP write-path validation, lined-table PDF performance (62,500 vertices 3.1s→0.2s), and more — see [CHANGELOG](CHANGELOG.md).

## What's New in v4.0.8

- **🖼️ PDF image extraction (new)**: previously only image *region coordinates* were computed and the bytes were silently lost — image XObjects are now decoded and re-encoded as PNG in pure JS (including waiting for pdfjs's async decoding; 731 images across 45 of 52 corpus PDFs). References are emitted at end-of-page positions, cross-page duplicates (logos/watermarks) are deduped, and cross-page table merging is unaffected.
- **🖼️ HWPX/HWP5 unreferenced-BinData sweep**: images the body walk can't reach — pictures inside headers/footers (press-release photo strips), cell-background images (borderFill imgBrush in approval documents) — are now recovered as image blocks at the end of the document. Corpus recovery: HWPX 686/686, HWP5 92/92 (100%).
- **🖼️ DOCX `w:object` images**: OLE object previews (`v:imagedata`) were missing from extraction — fixed (mc:Fallback copies remain excluded as duplicates).

## What's New in v4.0.7

- **🔗 DOCX hyperlink mass-loss fix**: paragraphs with multiple links kept only the last one; links are now emitted inline `[text](url)` in document order. **Field-code HYPERLINK** (`fldSimple`/`fldChar`, common in Word/Google Docs exports) and internal anchor links are handled (a measured document went from 176→21 links lost to zero).
- **🖼️ DOCX image body links**: images were extracted to files but never referenced as `![image](...)` in the markdown — now emitted inline at paragraph positions.
- **🔍 PDF mis-mapped mojibake detection**: ToUnicode mis-mappings producing valid-but-wrong Hangul passed silently — now detected via final-consonant (batchim) distribution, emitting per-page NEEDS_OCR warnings with reason `garbled_hangul`.

## What's New in v4.0.6

- **📊 PDF border-less band table fragmentation fix**: budget-ledger tables whose summary-row bands omit vertical rules lost department names — broken vertical segments are now bridged with a 4-way guard (637 sites measured in a real district budget).
- **📝 HWPX nested tables inside captions preserved (#46)**: table content inside a caption vanished wholesale (297 of 304 chars) — now flattened in document order. Report by [@jumaniac](https://github.com/jumaniac), advice by @hiSandog.

## What's New in v4.0.5

- **🖍️ Inline emphasis for any Hancom document**: bold/italic runs in HWPX files **not generated by kordoc** are now restored as markdown `**`/`*` markers (attribute-based detection, with automatic merging of runs split by Hancom's edit history). Structurally-bold cells (e.g. table header rows) are left unmarked.
- **🏛️ Gongmun-mode emphasis round-trip**: re-parsing an official-document HWPX preserves inline `**emphasis**` inside items, automatically distinguished from structural bold (e.g. fully-bold □ level-1 items in report numbering).
- **↔️ List-depth round-trip**: `1)` / `-` items parsed back from official documents no longer collapse to level 1 on regeneration ('1)'→'2.', '-'→□) — indentation is inverted into leading spaces, so draft/report/gaejosik double round-trips converge.

## What's New in v4.0.4

- **🖋️ Reflow object-flow model**: floating tables push text below them, page-anchored / behind-text objects don't participate in flow, inline tables advance by effective height + leading — self-consistency **59/59 (100%)** on the real-approval corpus. Mixed-cache documents (Hancom-saved files partially edited programmatically) also render at correct positions.
- **🎨 Format profile 0.3.0**: cell **font-name round-trip** (`fontName_hangul` — reproduce fonts without the source document), first-row fingerprint `anchor_row`, column widths preserved for tables whose first row is fully merged, and pre-validation of hand-edited border values (type/mm/color).
- **🧰 CLI/MCP option-surface unification**: gongmun option assembly and value sets share a single SSOT — no more drift between the two interfaces (6 missing MCP preset aliases restored). Byte-identical outputs verified across the refactor.
- **↔️ Round-trip hardening**: bold/italic/code markers inside table cells, paragraph-indent observation slot (`IRBlock.indent`), circled-number fallback parity beyond 15/51, nested-table height precision, adaptive footer rule width.

## What's New in v4.0.3

- **🛡️ Production hardening**: fixes confirmed by a two-pass adversarial review — explicit rejection of invalid numeric options (NaN / out-of-range), font-name XML escaping, cover/TOC extended to all presets (except press), body-font override no longer ignored when cover/TOC assets are on, heading hierarchy inversion at ≤13pt, and cell-object caption misattribution / false loss warnings.
- **📏 New defaults from field measurements**: 12pt body for draft documents and □→ㅇ→\* numbering for plans (previous behavior via `--pt 15` / `numbering: 'standard'`).

## What's New in v4.0.2

- **📏 Benchmarked against real approved documents**: 60 actually-approved government drafts (Seoul open-government archive) plus ministry templates were exhaustively decoded and compared against kordoc's output — 17 gaps catalogued, 9 fixed.
  - **Typesetting-area root fix**: generated documents lacked a column definition (`colPr`), so Hancom narrowed the text area by 10mm on each side and wide tables spilled into the right margin — now zero overflow across all presets (measured via COM rendering).
  - **Draft-document head/foot blocks** (`--doc-head`/`--doc-foot`, statutory form), **press-release preset** (`press`), **public-notice head** (`--notice-head`), **report-info line** (`--report-info`).
  - Column-width allocation rewritten (per-column floor = widest word — short columns no longer shatter vertically), 12pt table cells, draft margins matched to the dominant real-world value (20/15/20/15), level-2 bullet ㅇ/○ split by preset (`--bullet2`).
- Released after passing an eye-QA gate by a working civil servant.

## What's New in v4.0.1

- **✍️ Practitioner QA fixes**: bold text no longer swaps fonts to HY견고딕/Arial Black ("mystery font" bug), h2 section markers via `--h2-marker` (box □ / number / none), and the third-level dash ― corrected to the real-world hyphen `-`.
- **📝 13-rule official-notation linter**: `kordoc lint <file>` checks dates, times, amounts, attachment notation, etc.; generation also emits warnings inline.

## What's New in v4.0.0

- **🏛️ Government-standard gaejosik report, complete**: built from an exhaustive decode of 16 real government documents — cover page (gradient title box, accent bars), TOC banner, Roman-numeral chapter headers, page numbers ("- 1 -", cover/TOC excluded), approval box, automatic "끝." end mark, body title box. Tables get the measured government grammar automatically (shaded bold header with double rule, 0.4mm outer border hierarchy, content-proportional column widths, right-aligned placement). `--preset 개조식`.

## What's New in v3.18.0

- **🎨 Format profiles**: reproduce a table's **borders, shading, measured column widths, and cell fonts** — not just its merge topology — without shipping the source document. Extract style-only JSON from a reference hwpx with `hwpxToProfile(hwpx)`, then apply it to another document via `markdownToHwpx(md, { profile })` — share and reproduce an organization's formatting without leaking its content (issue #41, schema [`docs/format-profile-spec.md`](docs/format-profile-spec.md)). Schema & samples contributed by [@ai-localgov-officer](https://github.com/ai-localgov-officer) (PR #42).

## What's New in v3.17.0

- **🖼️ Render fidelity**: per-run fonts (gothic titles no longer fall back to the serif root font), full multi-section rendering (cover + body documents render every section), landscape page rotation (wide tables no longer clipped at the right edge), and page splitting for back-to-back full-page table paragraphs (trailing pages no longer pile onto one page).
- **✍️ Approval-box overlap fixed (reflow)**: In cache-less documents, the approval box's label table and stamp table were printed on top of each other — now placed side by side exactly like Hancom. Nested-table cell heights are measured correctly as well.

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
```

Optional dependencies for PDF parsing (pdfjs-dist), formula OCR, etc. are **installed by
default** (optionalDependencies). To slim the install, skip them with
`npm install kordoc --omit=optional` — PDF parsing, formula OCR, and print rendering
will then be unavailable.

## Quick Start

### Parse a document

```typescript
import { parse } from "kordoc"
import { readFileSync } from "fs"

const buffer = readFileSync("business-plan.hwpx")
const result = await parse(buffer)

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
const result = await fillForm(template, {
  성명: "홍길동",
  주민등록번호: "900101-1234567",
  주소: "서울특별시 광진구 능동로 120",
}, "hwpx-preserve")

writeFileSync("application_filled.hwpx", Buffer.from(result.output as ArrayBuffer))
// result.fill.filled → [{ label: "성명", value: "홍길동" }, ...]
// result.fill.unmatched → keys that failed to match
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
  gongmun: { preset: "보고서" },  // official | report | plan | notice | minutes | gaejosik | press
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

### OCR (scanned/image-based PDFs) — built-in engine (v4.2.0+)

```typescript
// Built-in OCR (PP-OCRv5 korean, ~18MB models auto-downloaded on first use)
const result = await parse(buffer, { ocr: true })     // only pages that need OCR
const result = await parse(buffer, { ocr: "force" })  // force-OCR every page
```

- **No API key or external service** — det (DBNet) + rec (CTC) ONNX inference on local CPU
  (official PaddlePaddle conversions, Apache-2.0).
- **Page-precise**: scanned pages and pages with broken ToUnicode mappings (the `needsOcr`
  signals) are OCR'd; clean pages keep their parsed output.
- **Tables survive**: OCR line boxes go through the same xy-cut + cluster table detection
  pipeline, so table structure is reconstructed even from scans.
- To use an external OCR instead, pass a provider function as before:

```typescript
const result = await parse(buffer, {
  ocr: async (pageImage, pageNumber, mimeType) => {
    return await myOcrService.recognize(pageImage) // Claude Vision, Tesseract, ...
  }
})
```

### PDF text-quality signals (v2.9+)

PDFs often have a text layer with broken ToUnicode/CMap or control characters mixed in. `parsePdf` returns per-page quality signals.

```typescript
const r = await parsePdf(buffer)
if (r.success && r.qualitySummary?.needsOcr) {
  // retry with the built-in OCR (v4.2.0+) — or route to your own OCR queue
  const retried = await parse(buffer, { ocr: true })
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
npx kordoc review.hwpx --format json                # JSON (blocks + pages + metadata)
npx kordoc report.hwpx --pages 1-3                  # page range
npx kordoc fill form.hwpx -f '성명=홍길동,주소=서울' -o filled.hwpx   # fill a form
npx kordoc fill form.hwpx -j values.json -o filled.hwpx              # fill from JSON
npx kordoc fill form.hwpx --dry-run                                  # list fields only
npx kordoc fill form.hwpx -j values.json --formats '{"날짜":"yy.mm.dd"}'  # per-field value formatting (label → format)
npx kordoc fill form.hwpx -j values.json --require-unique             # refuse if one key matches 2+ spots (repeated-label safety)
npx kordoc fill form.hwpx -j values.json --mask                       # don't echo filled values to stdout
npx kordoc generate report.md -o report.hwpx --preset 보고서          # markdown → official HWPX
npx kordoc lint report.md                                            # 13-rule official-notation linter — input is md/txt ('-' = stdin), exits 1 on errors
npx kordoc patch original.hwpx edited.md -o patched.hwpx  # format-preserving roundtrip patch (.hwp auto-detected)
npx kordoc seal form.hwpx --image stamp.png --anchor "(인)" -o sealed.hwpx  # place a stamp/signature
npx kordoc validate output.hwpx                     # HWPX structure validation (ZIP, required parts, XML)
npx kordoc redact complaint.hwpx -o redacted.hwpx   # PII detection + format-preserving masking (v4.1)
npx kordoc redact complaint.hwpx --mask-char '*' -o redacted.hwpx  # mask character (default ●)
npx kordoc profile agency-form.hwpx                 # extract table format profile (JSON) → reuse via generate --profile
npx kordoc render approval.hwpx -o preview.svg      # layout-preserving SVG render (documents without a layout cache are reflowed; --no-reflow disables)
npx kordoc render approval.hwpx --reflow-mode charAll -o preview.svg  # reflow line breaking: keep (word, default) | charAll (character)
npx kordoc models --status                          # model cache status (--export/--import for air-gapped sideloading)
npx kordoc check-ocr-models --status-only           # OCR model status as JSON (without the flag, missing models are downloaded)
npx kordoc check-formula-models --status-only       # formula OCR models (MFD + MFR + tokenizer, ~155MB) status only
npx kordoc watch ./inbox -d ./converted             # folder watch mode
npx kordoc watch ./docs --webhook https://api/hook  # webhook notification
```

> `check-ocr-models` and `check-formula-models` **download** what is missing or fails its SHA check,
> despite the name. Pass `--status-only` to inspect without downloading (formula models are ~155MB).
>
> `kordoc lint` inspects **text (markdown/txt)** — do not hand it an HWPX. To lint a generated document,
> lint the source markdown, or pipe: `kordoc report.hwpx | kordoc lint -`.

### Failure contract — machine-readable failure JSON (v4.10.0+, #69)

Conversion failures emit the same failure JSON to stdout **in every `--format` (markdown · json · chunks)** and exit 1, so callers branch on `code` instead of parsing human-oriented stderr messages.

```json
{ "success": false, "fileType": "hwpx", "error": "…", "code": "ENCRYPTED" }
```

This never collides with success output — `markdown` success is markdown text, `chunks` success is a JSON **array**, and a failure is always a `success:false` **object**. With `-o`/`-d`, no output file is produced for a failed input; with multiple inputs, each failed file emits one failure JSON. Codes: `ENCRYPTED`, `DRM_PROTECTED`, `UNSUPPORTED_FORMAT`, `CORRUPTED`, `IMAGE_BASED_PDF`, `ZIP_BOMB`, `DECOMPRESSION_BOMB`, `NO_SECTIONS`, `OUTPUT_TOO_LARGE`, `MISSING_DEPENDENCY`, `EMPTY_INPUT`, `PARSE_ERROR`. **Stability**: the exit-code rule (0 success / 1 failure) and the JSON fields are stable, and the `code` set only ever grows — existing values are never renamed or removed. The `error` string is for humans and is not part of the contract.

### Image bundles — `images/manifest.json` (v4.10.0+, #70)

When saving with `-o`/`-d`, extracted images land in `images/` together with a `manifest.json`, so consumers branch on formats without extension or magic-byte guessing.

```json
[ { "name": "image_001.png", "mimeType": "image/png", "bytes": 68, "source": "BinData/image1.png" } ]
```

`mimeType` prefers magic-byte detection (PNG/JPEG/GIF/BMP/WMF/EMF) over the declared, extension-derived type; undetectable formats (TIFF, SVG, …) keep the declared value. `source` is the original container entry (HWPX/DOCX ZIP path, HWP5 BinData storage name) and is absent for synthesized images (PDF re-encodes). Possible extensions: PDF always emits `png` (pure-JS re-encode); HWP5 emits sniffed `png/jpg/gif/bmp` (`bin` for WMF/EMF); HWPX emits extension-derived `png/jpg/gif/bmp/tif/wmf/emf/svg` (`bin` for unknown); DOCX keeps original extensions. Images are never re-encoded — trust the manifest, not the extension.

## MCP Server (Claude / Cursor / Windsurf / Codex)

**Automatic setup (recommended)**:

```bash
npx -y kordoc setup
```

Detects your AI client interactively and patches its config file — including `cmd /c npx` wrapping on Windows. See [30-Second Setup](#-30-second-setup-ai-agent-integration).

For Codex, the wizard registers the server through `codex mcp add` rather than editing its TOML config directly.

**Manual setup for Codex**:

```bash
codex mcp add kordoc -- npx -y kordoc mcp
```

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

**15 tools:**

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
| `extract_profile` | Extract a table format profile (JSON) from a reference HWPX — feed it to generate_document's profile_path |
| `generate_document` | Markdown (tables/equations/charts) → HWPX, official-document presets (v3.5) |
| `place_seal` | Place a stamp/signature image over an anchor phrase (v3.16) |
| `render_document` | Render HWPX exactly as typeset to a PNG image/SVG — lets the AI visually verify generated/edited documents (v4.1) |
| `redact_document` | Detect PII (resident registration no., phone, email, card, account) + format-preserving masking with a report (v4.1) |
| `parse_chunks` | Structure-preserving chunk JSON for RAG — heading/outline hierarchy breadcrumbs + standalone table chunks (v4.1) |

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
| `fillForm(input, values, outputFormat?)` | Fill a form template — outputFormat: `"markdown"` (default) / `"hwpx"` / `"hwpx-preserve"`, returns `{ output, format, fill }` |
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
| **PDF** | pdfjs-dist | Line-based tables, XY-Cut reading order, heading detection, built-in OCR engine, text-quality signals |
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
