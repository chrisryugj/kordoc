# Benchmark details

Scoring rules, reproduction steps and per-option results behind the README [Validation](../README-EN.md#validation) section. Internal corpora are checked by `npm run bench:gate` and mandatory release gates. The external opendataloader-bench is measured separately.

## 4.24.11: OCR, rendering and generation · 2026-10-27

Compared document by document against 4.24.10 on the same corpora and scorers: OCR, degraded inputs and ODL OCR (rounds 115, 116, 118, 119), rendered text and image positions and page counts (112), and generation fidelity and round trip (113). PDF text, table and annex code is unchanged. The two exceptions are listed in the changelog.

| Metric | 4.24.10 | 4.24.11 |
| --- | --- | --- |
| OCR CER (fair · strict) | 0.03096 · 0.06255 | **0.03055 · 0.06215** |
| OCR character recall | 0.99100 | **0.99121** |
| Degraded-input OCR CER (clean · blur · JPEG · scan) | 0.0476 · 0.0631 · 0.0504 · 0.0730 | **0.0475 · 0.0630 · 0.0503 · 0.0730** |
| Rendered text position (same measurement) | 87,546/90,840 | **87,577/90,840** |
| Generation fidelity (mean of 5) | 0.80596 | **0.80681** |
| PDF text · tables · statute annexes · ODL · round trip · image position · page count | — | unchanged |

## 4.24.10: security, OCR and PDF · 2026-10-26

Compared document by document against 4.24.9 on the same corpora and scorers for OCR, degraded inputs, PDF text and tables, statute annexes and ODL (no regressions; HWPX, round-trip, generation and rendering code is unchanged). This release fixes the vulnerable demo lockfile and the Java SDK build-file name that blocked the government GitLab mirror, plus OCR leading bullets (▣, ❐, ‣), Roman numerals read as a vertical bar and date-final periods, and PDF vertical-writing 、。, gradient backgrounds taken as rules and CJK–Latin autospacing.

| Metric | 4.24.9 | 4.24.10 |
| --- | --- | --- |
| OCR CER (fair · strict) | 0.03128 · 0.06278 | **0.03096 · 0.06255** |
| OCR character recall | 0.99064 | **0.99100** |
| Degraded-input OCR CER (clean · skew +1 · noise · blur · JPEG · scan) | 0.0481 · 0.0557 · 0.0530 · 0.0635 · 0.0508 · 0.0734 | **0.0476 · 0.0553 · 0.0526 · 0.0631 · 0.0504 · 0.0730** |
| PDF text precision · word-boundary F1 | 0.99676 · 0.99064 | **0.99677 · 0.99066** |
| PDF table content NED | 0.98794 | **0.98795** |
| Statute annexes · ODL · HWPX · round-trip · generation · rendering | — | unchanged |

## 4.24.9: table borders, OCR and PDF tables · 2026-10-26

Same corpora and scorers as 4.24.8; every suite benchmark compared per document (no regressions). Fixes double rules on every row of tables built from a template or grown by patch (round-trip and generation benchmarks unchanged — borders are not scored, so regression tests pin them), leading ○ bullets the OCR recognizer dropped, and PDF tables split across pages swallowing the next page's first row.

| Metric | 4.24.8 | 4.24.9 |
| --- | --- | --- |
| OCR CER (fair · strict) | 0.03140 · 0.06290 | **0.03128 · 0.06278** |
| OCR character recall | 0.99052 | **0.99064** |
| Degraded-input OCR CER (clean · noise · blur · JPEG · scan) | 0.0483 · 0.0540 · 0.0638 · 0.0517 · 0.0738 | **0.0481 · 0.0530 · 0.0635 · 0.0508 · 0.0734** |
| PDF table structure · cell F1 · content NED | 0.98198 · 0.99187 · 0.98767 | **0.98241 · 0.99193 · 0.98794** |
| PDF text · statutory annexes · HWPX · ODL · round trip · generation · rendering | — | unchanged |

## 4.24.8: security, OCR and PDF · 2026-10-26

Same corpora and scorers as 4.24.7; every suite benchmark compared per document (rendering measured for text, images and page counts — unchanged). This release brings known dependency vulnerabilities to zero (zod 4 — the input schemas and validation of all 18 MCP tools are unchanged), fixes two OCR cases (leading ring bullets read as digits, 「 touching the next character) and PDF tables clipped only in their header cells. One regression: table content NED of the rice/pepper statistics document 0.92767 → 0.92732 (the header text now sits in the 7-column grid and is one cell off the reference's 9-column merged cells; the same document's reading order went 0.99784 → 1 and its two phantom tables are gone).

| Metric | 4.24.7 | 4.24.8 |
| --- | --- | --- |
| `npm audit` (clone + `npm ci` · fresh npm install) | 6 · 2 | **0 · 0** |
| OCR CER (fair · strict) | 0.03274 · 0.06419 | **0.03140 · 0.06290** |
| OCR character recall · precision · table structure (67 tables) | 0.99043 · 0.99400 · 25 | **0.99052 · 0.99404** · 25 |
| Degraded-input OCR CER (clean · 1° skew · noise · blur · 150dpi · scan) | 0.0509 · 0.0585 · 0.0566 · 0.0663 · 0.0553 · 0.0764 | **0.0483 · 0.0559 · 0.0540 · 0.0638 · 0.0528 · 0.0738** |
| PDF reading order | 0.99307 | **0.99309** |
| PDF tables · statutory annexes · HWPX · ODL 200 documents · rendering | — | unchanged |

## 4.24.7: template generation, HWPML and OCR · 2026-10-26

Same corpora and scorers as 4.24.6. This release fixes three OCR cases (background pattern read as characters at line ends, numeric columns merged into the header row, hyphens and dashes decided by stroke length), template generation and HWPML reading. Template detection was compared against the previous release on 3,105 corpus HWPX files: 4 changed, all of them a table-of-contents box previously taken as the summary box. The other benchmarks pass the release gate (`bench:gate`).

| Metric | 4.24.6 | 4.24.7 |
| --- | --- | --- |
| OCR CER (fair · strict) | 0.03321 · 0.06461 | **0.03274 · 0.06419** |
| OCR character recall · table structure (67 tables) | 0.99019 · 25 | **0.99043** · 25 |

## 4.24.6: rounds 81–90 on OCR, PDF, rendering and HWPX · 2026-10-25

Measured again on the 4.24.5 corpora and scorers (every suite benchmark compared per document; rendering measured by text runs, images and page counts). The rendered-text denominator grows from 90,762 to 90,906 because page numbers that now follow page-number restarts pair with the Hancom PDF page numbers. Round 89 (whitespace in indented HWPX XML) changes the HWPX parse used as the PDF-text reference: that document (issue2019 form) gains reference text from 6,960 to 9,219 characters, so its recall and word-boundary F1 rise and its reading order falls from 0.904 to 0.871 while the PDF output is unchanged.

| Metric | 4.24.5 | 4.24.6 |
| --- | --- | --- |
| PDF text recall · precision · order · word F1 (744 pairs) | 0.99880 · 0.99676 · 0.99302 · 0.99055 | **0.99881** · 0.99676 · **0.99307** · **0.99064** |
| PDF tables structure · cell F1 · content NED (2,331 tables) | 0.98198 · 0.99187 · 0.98767 | unchanged |
| Statute annex PDF tables · cell F1 · equations | 342/346 · 0.99778 · 11/11 | unchanged |
| HWPX cell match · content NED (2,424 documents) | 1 · 1 | unchanged |
| OCR CER (fair · strict) | 0.04085 · 0.07996 | **0.03321 · 0.06461** |
| OCR tables matched · structure · cell F1 (67 tables) | 52 · 24 · 0.5538 | 52 · **25** · **0.5663** |
| Degraded-input OCR CER (clean · skew+3 · blur · scan) | 0.0554 · 0.0685 · 0.0745 · 0.0831 | **0.0514 · 0.0638 · 0.0665 · 0.0766** |
| Degraded-input OCR table cell F1 (clean · scan) | 0.5774 · 0.4382 | **0.5892 · 0.4464** |
| Rendered text position · image position · page count | 87,509/90,762 · 4,019/4,107 · 1,154/1,159 | **87,620/90,906** · 4,019 · 1,154 |
| opendataloader-bench 200 docs (default · best · ocr) | 0.96370 · 0.97512 · 0.96524 | unchanged |

| Round | Fix | Change |
| --- | --- | --- |
| 81 | PDF: four-glyph vertical side tabs inside the outer 12% page band | PDF reading order +0.00005 (two false tables in the handbook) |
| 82 | OCR: join header-band top edges split into cells by white gaps; extend in-band dividers to the band top | OCR table exact 24 → 25 |
| 83 | OCR and PDF: unruled sub-rows of budget statements (expense codes and calculation lines) | OCR CER 0.04085 → 0.03416; all nine degraded variants improve |
| 86 | Rendering: page-number restarts (`hp:newNum`) | rendered text position +111 (12 documents) |
| 88 | OCR: horizontally overlapping OCR boxes are neither one line nor a superscript | OCR CER 0.03416 → 0.03321 |
| 89 | HWPX: whitespace between runs in indented XML is not text | reference-side change, see above |

Tried and not shipped: keeping OCR unit lines out of tables (a table whose two-row header had matched row numbers by chance lost cell F1), capping or walling off OCR baseline snapping (similar or better overall CER but many documents fell), and joining page-break paragraphs across a table at the top of the next page (target unchanged, another document fell).

## 4.24.5: rounds 71–79 on PDF, OCR and parsers · 2026-10-25

Re-measured with the same corpus as 4.24.4 (full suite, compared per document). Rendering and reflow code did not change, so rendered text 87,509/90,762, images 4,019/4,107, page counts 1,154/1,159 and reflow stay the same. **Scoring change** (round 71): the HWPX reference units also place a below-table caption after the table cells. Part of the PDF reading-order gain below (+0.0001, seven documents up, and the Ebola press note 1 → 0.990) comes from that reference change, not from PDF output.

| Metric | 4.24.4 | 4.24.5 |
| --- | --- | --- |
| PDF text recall · precision · order · word F1 (744 pairs) | 0.99879 · 0.99670 · 0.99247 · 0.99049 | 0.99880 · 0.99676 · **0.99302** · 0.99055 |
| PDF table structure · cell F1 · content NED (2,331 tables) | 0.98198 · 0.99222 · 0.98760 | 0.98198 · 0.99187 · 0.98767 |
| Annex PDF equations · phantom text | 7/11 · 0.00045 | **11/11** · 0.00031 |
| HWPX cell exact · content NED (2,424 documents) | 0.99998 · 0.99996 | **1 · 1** |
| OCR tables matched · exact · cell F1 (67 tables) | 51 · 21 · 0.5432 | **52 · 24 · 0.5538** |
| OCR CER (fair · strict) | 0.04085 · 0.08296 | 0.04085 · **0.07996** |
| Degraded OCR table cell F1 (clean) · CER (blur · jpeg50) | 0.5563 · 0.0751 · 0.0588 | **0.5774** · 0.0745 · 0.0581 |
| ODL 200 documents (default · best · ocr) | 0.96367 · 0.97512 · 0.96521 | 0.96370 · 0.97512 · 0.96524 |

The PDF table cell F1 and one fewer matched table come from a single document printed by rhwp through cairo (75544, not a Hancom PDF): a 3×3 false match carrying a garbage header row is gone. The one content-NED drop (a regulatory-impact nested table) comes from round 74's change to the HWPX reference parse.

| Round | Fix | Change |
| --- | --- | --- |
| 71 | HWPX·HWP: below-table captions after the table (with the scoring change) | HWPX score: 2 documents up |
| 72 | PDF: fraction bars drawn as lines, and body-font numerators under equation-font bars, become `$\frac{}{}$` | annex equations 7 → 11/11 |
| 73 | PDF·OCR: bridge a broken vertical rule only when every cell between the broken columns holds text | OCR table exact 21 → 22 |
| 74 | Captions stay with the table band left after unwrapping an invisible frame | HWPX cell exact and content NED 100% |
| 75 | PDF: monospace word-per-item lines are not borderless-table rows; footers carrying a rule-glyph strip are stripped; a ruled and an unruled table are not joined across pages | PDF reading order +0.00047 |
| 76 | PDF: overprinted digits (overflowing table-of-contents page numbers such as "175") keep stream order | exam precision 0.964 → 0.971 |
| 77 | OCR·PDF: sub-rows stacked without rules (three+ columns with the same three+ line count) split into rows | OCR table cell F1 +0.0024 |
| 78 | OCR: no `<u>` underline markup on OCR text (plain-text contract) | ODL +0.00003 |
| 79 | OCR: faint white dividers inside a coloured header band become cell boundaries | OCR table exact 22 → 24 |

Tried and left out: bottom-aligned baselines from font descent (no effect — Malgun Gothic was already within 1.5pt), merging spurious PDF row boundaries (one-row box tables are outside the scored set; handbook tables −1), applying the overprint grouping to 1pt neighbours (flips the HL₂ subscript), and two-block-thick band dividers (tables weld further on the skew+3 input, CER 0.080 → 0.107).

## 4.24.4: ten rounds on rendering and PDF · 2026-10-24

Re-measured with the same corpus and scorers as 4.24.3. Rounds 61–68 and 70 change rendering only; round 69 changes only PDF cell-edge detection. **Measurement change**: rendered text positions are now measured with our run start moved past a leading figure-width space (U+2005 — the PDF prints no glyph there). On the same code this measurement-side correction moves 87,360/90,696 to 87,434/90,762; the 4.24.3 figures below were re-measured on the new basis (87,215/90,692 on the old one). The only document whose rendered text positions went down is the 2025 administrative handbook (−3, saved by Hangul 2024 and printed by 2022, so its line breaks differ), and no document gained a new page-count mismatch. Round 69 was checked per document against the 4.24.3 suite for PDF text, tables and annexes: no document went down. Rules were derived only from pairs whose PDF was printed by the same Hangul version that saved the file (round 70's pair has no version in its PDF metadata, but all 24 of its text runs are within 1.5pt).

| Metric | 4.24.3 | 4.24.4 |
| --- | --- | --- |
| Rendered text runs within 1.5pt (Hancom PDF pairs, new basis) | 87,289/90,758 | 87,509/90,762 |
| Rendered images within 2pt · pair documents with matching page count | 4,017/4,107 · 1,154/1,159 | 4,019/4,107 · 1,154/1,159 |
| Reflow: all line starts match, multi-line paragraphs (12 folders) | 24,941/25,187 | same |
| PDF table structure match · cell F1 (708 pairs · 2,331 tables) | 0.98155 · 0.99179 | 0.98198 · 0.99222 |
| PDF text, annexes, ODL 200 documents, OCR | — | same |

| Round | Change | Change in counts |
| --- | --- | --- |
| 61 | Overfull non-justified lines in paragraphs with a minimum space width also shrink their spaces to fit (replaced by the round 68 rule) | text +104 |
| 62 | Rows at the page bottom of cell-split tables are checked with the row bottom plus the table's outer bottom margin | text +12 |
| 63 | When the last row is fitted to the table height, merged cells reaching the last row may shrink too if their content fits | text +2 |
| 64 | Cell heights grown by floating objects include the object's outer bottom margin | text +29 |
| 65 | Documents whose KoPub font entries list a substitute font are drawn with the substitute's widths when the saved line breaks of the leading sections clearly match it | text +10 |
| 66 | Justified lines that start with a control (field begin, object anchor) also stretch the spaces after it | text +16 |
| 67 | Overfull justified lines shrink spaces to at most 20% of their width and spread the rest evenly over the other glyphs | text +26 |
| 68 | The round 67 rule applies to every overfull line regardless of alignment and minimum space width | text +23 |
| 69 | PDF: a single solid rule that leaves more than 2pt of a cell edge uncovered at one end belongs to the neighbouring cell, not this edge | PDF table exact +0.00043 |
| 70 | Top-and-bottom objects anchored in a line carried to the top of the next page stay on the earlier page where that line would have continued (previous line end + line spacing) | images +2 |

Rounds 61–64 were measured on the old basis, round 65 onwards on the new one.

Tried and not adopted: stretching leading spaces of justified lines too (−977); drawing every KoPub document with the substitute font (+585, but that depends on the fonts of the PC that printed the PDF, which the saved file cannot tell); lowering the PDF cell-edge gap limit from 3 to 1.6pt (handbook table exact 95 → 80 — double and thick rules are inset 1.1–1.9pt at corners); skipping footer tables that hold only a page number when joining tables across pages (one table that should join does, but two separate tables are glued, −1); turning off the string-level even-spacing cleanup for PDF body lines (word F1 +0.0001, but six documents went down).

## 4.24.3: ten rounds on rendering and PDF · 2026-10-24

Re-measured with the same corpus and scorers as 4.24.2. Rounds 51–58 and 60 change rendering only; round 59 changes only PDF cross-page table joining. No round lowered rendered text positions in any document (full per-document comparison) and no document gained a new page-count mismatch. Round 59 was checked per document against the 4.24.2 suite for PDF text, tables, annexes and ODL (default, best, OCR): no document went down. Rules were derived only from pairs whose PDF was printed by the same Hangul version that saved the file. From round 51 inherited odd/even master pages are drawn, so more text and images are compared and the denominators grew.

| Metric | 4.24.2 | 4.24.3 |
| --- | --- | --- |
| Rendered text runs within 1.5pt (Hancom PDF pairs) | 86,954/90,550 | 87,215/90,692 |
| Rendered images within 2pt · pair documents with matching page count | 3,881/3,976 · 1,154/1,159 | 4,017/4,107 · 1,154/1,159 |
| Reflow: all line starts match, multi-line paragraphs (12 folders) | 24,941/25,187 | same |
| Annex PDF text recall | 0.99976 | 0.99982 |
| PDF text and tables, ODL 200 documents | — | same |

| Round | Change | Change in counts |
| --- | --- | --- |
| 51 | A section that defines only an odd or even master page inherits the other from the previous section | text +128 · images +131 |
| 52 | Tables split by whole rows (pageBreak TABLE) keep rows tied by merged cells on one page | text +60 |
| 53 | The continuation top of nested split tables accumulates from the outer levels | text +36 |
| 54 | Scale/rotation pairs in grouped objects' transforms apply the scale first, then the rotation | images +2 |
| 55 | "Anchor after the first line = that line + offset" applies only to paragraph-end anchors; mid-paragraph anchors in paragraphs saved narrow from the first line use the paragraph top | images +1 |
| 56 | Behind/in-front/square objects in cell paragraphs are measured from before the space-before | images +1 |
| 57 | Merged cells that Hangul saved split across pages: the next part's row starts the next page, cell frames and text are drawn per page | text +29 |
| 58 | Empty rows of staggered merged tables are set top-down from cells ending on that row (stored height − rows above) | text +8 |
| 59 | PDF: continuations of rows split at an open page boundary are no longer removed as repeated header rows | annex recall +0.00006 |
| 60 | Shadowed inline pictures sit at the line top when the line was laid out with the shadow included | images +1 |

Tried and not adopted: right-aligning rows whose widths sum to less than the table width (boundaries propagated back from the right edge — −786 overall, −589 within 10pt only); stretching the last row before a forced page break to the body bottom (Hancom's 89.3pt matches neither the natural 79.7pt nor the 101.6pt to the bottom); requiring two filled cells for a repeated header row (annex +1, but three PDF-table documents went down).

## 4.24.2: ten rounds on render layout · 2026-10-24

Re-measured with the same corpus and scorers as 4.24.1 (4.22.15–4.24.1 did not change rendering, so the baseline equals 4.22.14). All ten rounds change rendering only; parser output and the saved-layout reflow metrics are unchanged. No round lowered rendered text positions in any document (full per-document comparison) and no document gained a new page-count mismatch. Rules were derived only from pairs whose PDF was printed by the same Hangul version that saved the file.

| Metric | 4.24.1 | 4.24.2 |
| --- | --- | --- |
| Rendered text runs within 1.5pt (Hancom PDF pairs) | 86,508/90,518 | 86,954/90,550 |
| Rendered images within 2pt · pair documents with matching page count | 3,872/3,976 · 1,154/1,159 | 3,881/3,976 · 1,154/1,159 |
| Reflow: all line starts match, multi-line paragraphs (12 folders) | 24,941/25,187 | same |

| Round | Change | Text runs |
| --- | --- | --- |
| 41 | A top-and-bottom table anchored on the first line of a new page that started at the end of the previous page (anchor line = carried-over rows + outer margin) is drawn from the previous page | +43 |
| 42 | A cell-split table starting near the page bottom keeps its first row only if merged cells starting in that row also fit | +15 |
| 43 | Paragraph area top = previous paragraph end + previous paragraph's space after | +43 |
| 44 | Top-and-bottom objects anchored on the first line whose vertical offset is at least the line height sit below the line (line − space before + offset) | +33 (images +2) |
| 45 | The pushed-line check and the pushed-position inverse include the vertical offset (it was counted twice) | +241 (images +1) |
| 46 | Several top-and-bottom objects in one cell paragraph stack (horizontally overlapping ones only); cell height no longer counts the vertical offset twice | +12 |
| 47 | Body tables whose stored row heights exceed the table height (sz) shrink the last row to fit, when its content fits | +18 (images +5) |
| 48 | Trailing spaces before a forced line break are excluded from alignment and justification width | +38 |
| 49 | Centered page numbers sit at the center of the body area | +3 |
| 50 | Square-wrapped objects anchored after the first line sit at that line + vertical offset | 0 (images +1) |

Tried and not adopted: +50 bold width for TTF HY Myeongjo (휴먼명조) — some Hancom PDFs draw it at 1.047em, but reflow multi-line matches drop 24,941 → 24,825 and rendering −83 (depends on the author's fonts); page-size scale correction for 595×841 PDFs (1,075 of 1,172 pair PDFs are 595×841 but most are not scaled, −536 overall).

## 4.22.14: five rounds on cell height, line-end letter spacing, section first paragraphs and symbol widths · 2026-10-19

Re-measured against 4.22.13 with the same scorer and corpora (`node bench/suite.mjs cmp r42213 r42214`). Parser output (generation included) is the same per document in every bench. The only documents whose rendered spans dropped are three in round 38 (one span each that was already at the 1.5pt edge; compared over the full list of paired documents), and no document newly lost its page count. Reflow changed only in round 40: multi-line paragraphs +1 and line count −1 (one single-line paragraph now exceeds the line width by 3 and wraps).

| Metric | 4.22.13 | 4.22.14 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body · cell first lines · multi-line paragraphs (saved files, 12 folders) | 76,729/78,376 · 205,015/205,307 · 24,940/25,187 | 76,729 · 205,015 · 24,941/25,187 |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 86,051/90,433 | 86,508/90,518 |
| Rendered images within 2pt · page counts | 3,872/3,976 · 1,421/1,431 | 3,872/3,976 · 1,423/1,431 |

| Round | Fix | Rendered spans |
| --- | --- | --- |
| 36 | Cell height — a top-and-bottom object that would overlap the previous paragraph in the cell if placed above its line did not push the line, so it is measured from the line | +29 (pages +1) |
| 37 | Tables whose saved height (sz) equals an inner row boundary (Hancom saved only the first-page fragment) get no bottom-margin overflow slack | 0 (pages +1) |
| 38 | No letter spacing after the last character of a line — centered/right-aligned widths and justified stretching drop the last character's spacing | +298 |
| 39 | Line starts of a section's first paragraph that fall inside the section/column definition slots are read past those slots (front and back form tables no longer land side by side on page 2) | +91 (pairs +80) |
| 40 | Hancom supplementary private-use symbols U+F0000–F02FB and U+F035F–F03F4 are full width (bullet middle dot and others) | +39 (reflow multi-line +1, line count −1) |

## 4.22.13: five page-break and in-cell table rendering rounds · 2026-10-18

Re-measured against 4.22.12 with the same scorer and corpora (`node bench/suite.mjs cmp r42212 r42213`). All five rounds changed only rendering and reflow, so parser output (generation included) is the same per document in every bench, and the reflow saved-file metrics are unchanged. No document's rendered spans dropped in any round (compared over the full list of paired documents), and no document newly lost its page count.

| Metric | 4.22.12 | 4.22.13 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body · cell first lines · multi-line paragraphs (saved files, 12 folders) | 76,729/78,376 · 205,015/205,307 · 24,940/25,187 | unchanged |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 85,968/90,428 | 86,051/90,433 |
| Rendered images within 2pt · page counts | 3,869/3,976 · 1,413/1,431 | 3,872/3,976 · 1,421/1,431 |

| Round | Fix | Rendered spans |
| --- | --- | --- |
| 31 | Bottom page numbers in sections with a zero footer area sit in the middle of the bottom margin (baseline = page bottom − bottom margin/2 − 2.43pt) | +48 |
| 32 | Tables with cell lines that Hancom saved split across pages no longer stay on one page by overflowing into the bottom margin | +11 (pages +4) |
| 33 | A saved-split row whose first line does not fit in the room left starts on the next page | 0 (pages +2) |
| 34 | A top-and-bottom table in an empty cell paragraph is drawn above the line when the line was saved pushed down by that table (from the end of the previous paragraph in the cell) | +24 (images +3) |
| 35 | When a floating table anchored in an unsplit cell runs past the page, the cell and the table continue to the page where the table ends (cell height counts the floating table's rows) | 0 (pages +2) |

## 4.22.12: five text-box and rendering rounds · 2026-10-18

Re-measured against 4.22.11 with the same scorer and corpora (`node bench/suite.mjs cmp r42211 r42212`). All five rounds changed only rendering and reflow, so parser output (generation included) is the same per document in every bench, and the reflow saved-file metrics are unchanged. No document's rendered spans dropped in any round.

| Metric | 4.22.11 | 4.22.12 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body · cell first lines · multi-line paragraphs (saved files, 12 folders) | 76,729/78,376 · 205,015/205,307 · 24,940/25,187 | unchanged |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 85,837/90,418 | 85,968/90,428 |
| Rendered images within 2pt · page counts | 3,866/3,976 · 1,413/1,431 | 3,869/3,976 · 1,413/1,431 |
| Text lines escaping their text box (159 HWPX with text boxes) | 571 | 10 |

| Round | Fix | Rendered spans |
| --- | --- | --- |
| 26 | Sections whose top-level line cache is written in page-absolute coordinates drop their caches and are re-laid out (the body was shifted right by the left margin and clipped); text boxes without a text-area width are laid out at the shape width (their text vanished) | 0 (that form: pages 85 → 68, escaping lines 571 → 13) |
| 27 | Drawing joins old Hangul jamo onto the preceding letter, as reflow does | 0 (escaping lines 13 → 10) |
| 28 | A page-break paragraph saved below the middle of the body also starts a new page when its first line sits where its own top-and-bottom object pushed it | +47 |
| 29 | Unrotated text boxes use their current size (curSz) — for all 186 unrotated inline text boxes saved with sz different from curSz, the line height follows curSz | +70 (images +3) |
| 30 | Tables with no full-width row matching the table width use the longest-path boundaries without the on-path condition | +14 |

## 4.22.11: five rendering rounds · 2026-10-18

Re-measured against 4.22.10 with the same scorer and corpora (`node bench/suite.mjs cmp r42210 r42211`). All five rounds changed only rendering, so parser output and reflow are the same per document in every bench. No document's rendered spans dropped in any round.

| Metric | 4.22.10 | 4.22.11 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body · cell first lines · multi-line paragraphs (saved files, 12 folders) | 76,729/78,376 · 205,015/205,307 · 24,940/25,187 | unchanged |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 85,496/90,418 | 85,837/90,418 |
| Rendered images within 2pt · page counts | 3,866/3,976 · 1,413/1,431 | unchanged |

| Round | Fix | Rendered spans |
| --- | --- | --- |
| 21 | A table inside a cell split across pages restarts on the next page at the top of that cell's content (continued outer table top + cell top margin) | +107 |
| 22 | The last part of a row saved split extends to the bottom of top-and-bottom floats anchored to its lines (+ cell margins) | +11 |
| 23 | When a multi-row cell's content (+ cell margins) exceeds its stored height, rows are solved with the content height (still capped by the table's stored height) | +169 |
| 24 | The last part of a split centred or bottom-aligned cell aligns its text within the height left by the cell's stored share | +54 |
| 25 | A lone top-and-bottom float in an empty paragraph whose line was saved pushed down by it (line = previous paragraph end + float) is drawn above the line — since 4.21.31 an attachment picture (607pt) was pushed off the bottom of the page | 0 (no such document in the corpus) |

## 4.22.10: five table rendering rounds · 2026-10-18

Re-measured against 4.22.9 with the same scorer and corpora (`node bench/suite.mjs cmp r4229 r42210`). All five rounds changed only rendering, so parser output and reflow are the same per document in every bench. No document's rendered spans dropped in any round.

| Metric | 4.22.9 | 4.22.10 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body · cell first lines · multi-line paragraphs (saved files, 12 folders) | 76,729/78,376 · 205,015/205,307 · 24,940/25,187 | unchanged |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 84,468/90,405 | 85,496/90,418 |
| Rendered images within 2pt · page counts | 3,866/3,976 · 1,410/1,431 | 3,866/3,976 · 1,413/1,431 |

| Round | Fix | Rendered spans |
| --- | --- | --- |
| 16 | A cell Hancom split after its first line (vertpos 0) saves the second line at vertpos 0 too; a restart at the same position is a page break. The first part of a split row is no taller than the larger of the stored cell height and its content on that page | +84 (page counts +3) |
| 17 | When a merged cell is taller than the sum of its rows, the last row grows by the shortfall, cells ending higher first and never past the table's stored height (78 of 105 such tables then match their stored sz) | +180 |
| 18 | A flowing table whose first row does not fit at the page bottom moves to the next page as a whole | +26 |
| 19 | Tables whose rows store different cell-width sums use the longest path through the cells as column boundaries when it reaches the table width (nine column lines of a statistics table within 0.1pt of the same-version PDF; 46 tables in the corpus) | +615 |
| 20 | The next-page part of a vertically centred or bottom-aligned cell split over two pages is the stored cell height minus the first part (same rule as reflow) | +123 |

## 4.22.9: five layout and rendering rounds · 2026-10-18

Re-measured against 4.22.8 with the same scorer and corpora (`node bench/suite.mjs cmp r4228 r4229`). All five rounds changed only layout and rendering, so parser output is the same per document in every bench.

| Metric | 4.22.8 | 4.22.9 |
| --- | --- | --- |
| ODL default · `plain`+`htmlTables` · `ocr: true` · `ocr: false` (200 documents) | 0.96367 · 0.97512 · 0.96521 · 0.93903 | unchanged |
| Reflow body first-line positions (saved files, 12 folders) | 76,676/78,376 | 76,729/78,376 |
| Reflow table-cell first-line positions | 205,007/205,307 | 205,015/205,307 |
| Reflow body+objects · cells+objects | 16,332 · 6,188 | 16,336 · 6,188 |
| Multi-line paragraphs with all line starts matching · line counts | 24,939/25,187 · 306,680 | 24,940/25,187 · 306,681 |
| Rendered text spans within 1.5pt (Hancom PDF pairs) | 82,816/90,379 | 84,468/90,405 |
| Rendered images within 2pt · page counts | 3,858/3,976 · 1,410/1,431 | 3,866/3,976 · 1,410/1,431 |

Layout now measures the 359 non-ASCII half-width characters of Gulim and Dotum (•·−·◦ and more) at 0.5em (a youth policy press release: body +6, cells +4), and reserves the default cell width for bullets with `useInstWidth="0"` instead of the glyph's own width (Hancom draws a Dotum "−" bullet at 0.5em but reserves 1em). Rendering aligns only the first page part of a vertically centred or bottom-aligned cell that Hancom saved split across pages (three forms and a 40-page single-cell document saved and printed by the same version), breaks row-level tables with the table's bottom outer margin (a retiree employment review list +185, five drug-policy press releases +12 each), and counts inline objects in the position before a tab (a country list in a trademark international application form +99). The two documents whose rendered spans dropped (156782376 and pr-1674, 26 each) were saved with Hangul 2020 and printed with 2024 and 2022, so the difference reflects re-layout by another version; rules are fitted only on pairs printed by the same version that saved them.

## 4.22.8: five ODL and layout rounds · 2026-10-18

Re-measured against 4.22.7 with the same scorer and corpora (`node bench/suite.mjs cmp u3 r4228`). The only per-document drop is one document in score's PDF text coverage (below).

| Metric | 4.22.7 | 4.22.8 |
| --- | --- | --- |
| ODL default overall · reading order · headings (200 documents) | 0.96305 · 0.96340 · 0.94860 | 0.96367 · 0.96429 · 0.94866 |
| ODL `plain`+`htmlTables` · `ocr: true` · `ocr: false` | 0.97452 · 0.96459 · 0.93878 | 0.97512 · 0.96521 · 0.93903 |
| Reflow body first-line positions (saved line segments, 12 folders) | 76,631/78,375 | 76,676/78,376 |
| Reflow table-cell first-line positions | 205,005/205,305 | 205,007/205,307 |
| Reflow body+object · cell+object | 16,329 · 6,188 | 16,332 · 6,188 |
| Multiline paragraphs with all line starts matching · line counts | 24,938/25,187 · 306,678 | 24,939/25,187 · 306,680 |

ODL gains come from reading order: captions placed below a table on the page now follow the table (064, 110, 132), a false two-column gutter found from word fragments on a single-column page full of full-width lines is rejected (003), and an image-region OCR table whose rows are mostly one full-width cell is emitted as paragraphs (098, a gridded street map). Layout gains come from page-split shares of fixed-height (`noAdjust`) tables (+19 in issue1853), Wingdings advances for symbol-font private-use glyphs (+14, a footnote line in a food-safety press release) and the height of table-only paragraph-end lines (+12 in a city-agency press release). Score's PDF text coverage for a county plan dropped 0.99902 → 0.99901 (4 of 375,891 characters): page 413, once misread as two columns, is now read as one, and small raised amount notes stand as their own line before it. Measured but left out: an integer-rounding allowance for gaps after pdfjs space items (Korean PDF word F1 0.99049 → 0.98848, 98 documents down), and widening automatic OCR to small images and page-header logos (ODL default +0.00155 but 120 Korean PDFs took 221 s → 364 s; `ocr: true` reads that range).

## 4.22.7: five ODL and layout rounds · 2026-10-18

Re-measured against 4.22.6 with the same scorer and corpora (`node bench/suite.mjs cmp r4226 u3`; rounds 2, 4 and 5 only touched layout code, so parser output equals the round-3 build). No document dropped in any bench.

| Metric | 4.22.6 | 4.22.7 |
| --- | --- | --- |
| ODL default overall · reading order · headings (200 documents) | 0.96291 · 0.96316 · 0.94829 | 0.96305 · 0.96340 · 0.94860 |
| ODL `plain`+`htmlTables` · `ocr: true` · `ocr: false` | 0.97438 · 0.96445 · 0.93865 | 0.97452 · 0.96459 · 0.93878 |
| Reflow body first-line positions (saved line segments, 12 folders) | 76,525/78,375 | 76,631/78,375 |
| Reflow table-cell first-line positions | 204,958/205,304 | 205,005/205,305 |
| Reflow body+object · cell+object | 16,320 · 6,185 | 16,329 · 6,188 |
| Multiline paragraphs with all line starts matching · line counts | 24,938/25,187 · 306,677 | 24,938/25,187 · 306,678 |

ODL gains come from dropping needless Markdown escapes: intraword underscores (7 documents) and whitespace-flanked blank lines (1 document) cannot form emphasis in CommonMark, so rendering is unchanged. Unescaping a lone `*` or `~` in table cells raised ODL by 0.00014 but was left out: the scoring normalizer (and line-based consumers) turns `<br>` into a newline and strips the following `* ` as a list marker, dropping 7 PDF text and 12 other-format documents. Layout gains come from captions of tables split across pages (+77 in a policy research progress report), space compression in bulleted paragraphs of early Hangul 2024 builds below 3622 (+14 in a maritime press release), and splitting floating tables from before the paragraph's space-before (+15 body, +46 cells).

## 4.22.6: layout and PDF fixes · 2026-10-18

4.22.5 (6f49170) and this release (cd98760) were re-measured on the same corpora with the same scorer. Because the scoring criteria changed (CHANGELOG 4.22.6, "scoring change"), the current scorer was placed in a 4.22.5 checkout, `node bench/suite.mjs run b4225 --root=<4.22.5 checkout>` and `run r4226` were run, and `cmp b4225 r4226` compared every document.

| Metric | 4.22.5 | 4.22.6 |
| --- | --- | --- |
| HWPX character recall (5,740,269 reference characters) | 0.999973 | 1 |
| HWPX exact cell content | 0.999606 | 0.999983 |
| PDF character recall · word-boundary F1 | 0.99872 · 0.99037 | 0.99879 · 0.99049 |
| PDF exact table-cell content · content NED | 0.990677 · 0.987301 | 0.991321 · 0.987425 |
| Reflow body first-line positions (saved line segments, 12 folders) | 76,443/78,375 | 76,525/78,375 |
| Reflow table-cell first-line positions | 204,869/205,304 | 204,958/205,304 |
| Reflow multiline paragraphs with all line starts matching | 24,938/25,187 | 24,938/25,187 |
| Rendered page count = Hancom PDF | 1,154/1,159 | 1,154/1,159 |
| OCR CER (53 documents · 102 pages) | 0.04114 | 0.04085 |
| ODL default (200 documents) | 0.963 | 0.963 |

Per document: PDF tables (730 rows), annexes (544 rows), round trips, the 146 other-format files and the 200 ODL documents in all four modes have no drops. In score, 32 documents rose and 6 dropped, all in PDF coverage (at most 0.0047: the parser now merges numbers into the same circled digits as HWPX and HWP, while the coverage consensus counts the separate shapes and digits of the text layer; see the "남은 차이" (remaining differences) note in the CHANGELOG). Four PDF text documents dropped: reading order in rowbreak-problem-pages (a table row that now matches fully after a restored number entered the order population), word boundaries in the k-water RFP (inverted square numbers have no digits in the text layer), and precision in hwp3-sample11 and SO-SUEOP (about 0.0001). In reflow, one document dropped one table-cell paragraph (a 29-row table in the MFDS press release on joint inspections against illegal medicine distribution in traditional markets, whose earlier rows already diverge from Hancom). In OCR, character recall for eval-rda-2022 dropped from 0.9802 to 0.9753 because 14 restored symbols entered its text-layer reference; its edit distance fell from 54 to 41 (CER 0.0714 → 0.0532).

Reflow numbers come from `node --import tsx bench/layout/reflow-cmp.mts` over 12 folders in `bench/corpus/`: seoul, seoul2, seoul-old, review, korea-kr-pairs, korea-kr-pairs2, licbyl, licbyl2, rhwp, gate-fill, gate-fill3 and korea-kr. From this release the README reflow row uses this population (25,187 multiline paragraphs); the 25,581-paragraph population listed through 4.22.5 did not record its folders and could not be re-measured. The README HWPX, HWP pair and all-PDF rows also use the gate population (hwpx 2,424 · pdf 1,911 · hwp pairs 1,130, [corpus](corpus.md)); the 4.22.5 table listed HWPX 2,429 · HWP pairs 1,131 · PDF 2,070.

## 4.22.5: ten alternating layout/PDF rounds · 2026-10-17

Against 4.22.4, exact line starts increased from 25,326 to 25,332/25,581 paragraphs (99.0266%), PDF exact table-cell content from 0.990311 to 0.990677, character recall from 0.99865 to 0.99872, and reading order from 0.99242 to 0.99244. Exact table structure remains 2,288/2,331 and statute-annex structure 342/346; annex cell F1 improved from 0.99739 to 0.99778. Baseline and occupied-height restoration is separate from line-start scores. Ground truth, scorers, normalization and populations are unchanged. [Earlier five rounds](quality-alternating-5-2026-10-17.md) · [Additional five rounds, cross-effects and upstream review](quality-alternating-6-2026-10-17.md) (Korean).

## 4.22.4: ten alternating layout/PDF rounds · 2026-10-16

Against 4.22.3, exact line starts increased from 25,323 to 25,326/25,581 paragraphs, PDF exact table-cell content from 0.989994 to 0.990311, and character recall from 0.99858 to 0.99865. Exact PDF table structure remains 2,288/2,331 and statute-annex structure 342/346; annex cell F1 improved from 0.99697 to 0.99739. Image and baseline coordinate restoration is reported separately from line-start scores. Ground truth, scorers and populations are unchanged. [Earlier five rounds](quality-alternating-3-2026-10-16.md) · [Final five rounds, cross-checks and remaining errors](quality-alternating-4-2026-10-16.md) (Korean).

## 4.22.3: second set of five alternating layout/PDF rounds · 2026-10-16

Exact line breaks increased from 25,321 to 25,323/25,581 paragraphs; exact PDF table structure from 2,287 to 2,288/2,331 tables. Reserved height for an overflowing inline table is also restored from 100 to 4,477HU, with its actual 80HU line advance preserved. Ground truth, scorers and populations are unchanged. The fixed-source, per-document comparisons and unchanged ODL 200-document × four-mode scores are in the [detailed report](quality-alternating-2-2026-10-16.md) (Korean).

## 4.22.2: five alternating layout/PDF rounds · 2026-10-16

Starting after PR158, exact line breaks increased from 25,312 to 25,321/25,581 paragraphs (98.9484%→98.9836%), and exact PDF table structure from 2,285 to 2,287/2,331 tables (98.0266%→98.1124%). Ground truth, scorers and populations are unchanged.

The 48pt→0 position error after a partial edit is a separate reproduction result, not an addition to the full reflow score. PDF table improvements also increased PDF reading order from 0.99238 to 0.99239. See the [detailed report](quality-alternating-2026-10-16.md) (Korean) for cross-effects and regression checks by round.

## Earlier PDF improvements (PR158, included in 4.22.2) · 2026-10-16

Fixed merged role cells in contact tables and duplicate shaded grids in statistical tables. Ground truth, scorers and populations are unchanged. [Implementation evidence](quality-pdf-2026-10-16.md) (Korean) · [Machine-readable comparison](quality-pdf-2026-10-16.json)

| Metric | 4.22.1 | Development |
| --- | ---: | ---: |
| PDF exact cell text (2,331 tables) | 0.987963 | 0.988200 |
| PDF content NED similarity | 0.984361 | 0.984727 |
| PDF cell F1 | 0.991267 | 0.991406 |
| PDF reading order (744 pairs) | 0.99232 | 0.99238 |

Table structure match remains 0.980266; all metrics for the 101 nested tables remain 1; PDF statute annexes remain 342/346. No score decreased across 744 text, 730 table and 544 annex scoring rows. Tests: 3,958 passed, 9 skipped; type checking and build passed.

All document scores also remained identical across the external ODL's 200 documents in four modes. Measured with `node bench/suite.mjs run pdf-score-20261016-final --only=text,table,annex,odl,odlbest,odlocr,odlfast --jobs=2`.

## Release verification record: 4.22.0 · 2026-10-16

Verified by the automatic gates in `npm publish` for 4.22.0. See the [machine-readable results](release-4.22.0.json) and [same-corpus PDF/layout comparison](quality-layout-2026-10-15.md) (Korean). No document’s score decreased during this improvement series in PDF text, tables, statute annexes or the four external ODL modes. HWPX, HWP and all-PDF populations below have grown since the previous release.

| Target | Population | Result |
| --- | --- | --- |
| HWPX | 2,429 documents · 10,461 tables | Structure match 10,461/10,461 · 100%; exact cell text 99.9983%; content NED similarity 99.9956% |
| HWP 5.x ↔ HWPX | 1,131 pairs · 4,317 tables | Paired-document structure match 4,317/4,317 · 100% |
| PDF text | 744 pairs | Recall 99.86%, precision 99.67%, order 99.23%, word-boundary F1 99.02% |
| PDF tables | 708 pairs · 2,331 tables | Detection 99.83%, structure match 98.03%, cell F1 0.991267 |
| Nested PDF tables (text layer) | 29 documents · 101 tables | Detection, structure, cell F1, exact cell text and content NED all 100% |
| Statute annexes | 272 documents · 346 tables | HWP structure match 346/346; PDF 342/346 · 98.84% |
| All PDFs | 1,888 scored out of 2,070 documents | Text coverage 99.80% |
| OCR | 53 documents · 102 pages | CER 0.0412, character recall 99.02%, precision 99.33%, Hangul recall 99.40% |
| Other formats / roundtrip / fuzz | 146 documents (27 PPTX) / 75 roundtrips / 26,000 fuzz cases | Release gates passed |

Structure scores do not imply perfect visual fidelity or exact text in every cell. The 75 roundtrip cases and 8 generation fixtures are counted separately.

The nested-table 100% is limited to this text-layer sample; it does not cover PDFs without text layers, OCR or all page layout. All-PDF text coverage separately classifies 114 OCR-only documents and 68 documents with weak text layers. OCR compares 216dpi rendered inputs against the same PDFs’ text layers; it does not measure real scan noise or skew. Tests: 3,940 passed, 9 skipped; type checking, build and all automatic release gates passed.

## PDF → Markdown — opendataloader-bench

[opendataloader-bench](https://github.com/opendataloader-project/opendataloader-bench) scores 200 PDFs (papers, reports, slides, posters, scans) against human-made ground truth for **reading order (NID), table structure (TEDS) and heading hierarchy (MHS)** (1.0 = identical to the ground truth).

### Latest separate verification: 4.22.14 release candidate · 2026-10-19

| Setting | Overall | Reading order | Tables | Headings |
| --- | ---: | ---: | ---: | ---: |
| Default | 0.964 | 0.964 | 0.980 | 0.949 |
| Default + `plain: true, htmlTables: true` | 0.975 | 0.980 | 0.983 | 0.959 |
| `ocr: true` | 0.965 | 0.965 | 0.980 | 0.954 |
| `ocr: false` | 0.939 | 0.940 | 0.937 | 0.934 |

Each mode covers 200 documents with no missing predictions. Measured with `node bench/suite.mjs run r42214 --only=odl,odlbest,odlocr,odlfast`; every document is unchanged from 4.22.13 in all four modes (this release changed only rendering and reflow). [4.22.0 results](release-4.22.0.json) · [Earlier version comparisons](quality-campaign-session-2026-10-09.md)

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

Preserved from the earlier README. These are historical results, not current rankings or a same-hardware performance comparison. See the 4.22.0 release-candidate table above for the latest verified kordoc scores.

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
