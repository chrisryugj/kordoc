//! HWPX parser implementation with table and character formatting support

use std::collections::HashMap;
use std::io::{self, Cursor, Read};
#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;
use zip::ZipArchive;

/// Character style properties
#[derive(Debug, Clone, Default)]
pub struct CharStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
}

/// Image information from HWPX file
#[derive(Debug, Clone)]
pub struct ImageInfo {
    pub id: String,           // image1, image2, ...
    pub path: String,         // BinData/image1.bmp
    pub media_type: String,   // image/bmp, image/png
    pub data: Vec<u8>,        // actual binary data
}

/// HWPX document parser.
///
/// Holds the zip archive over an in-memory cursor so the parser works on
/// both native and `wasm32-unknown-unknown` targets. Reading the full HWPX
/// into memory up-front is fine — HWPX files are OOXML-style zips and
/// typically measure in the single-digit MBs.
pub struct HwpxParser {
    archive: ZipArchive<Cursor<Vec<u8>>>,
    char_styles: HashMap<u32, CharStyle>,
}

/// Parsed HWPX document
#[derive(Debug, Clone)]
pub struct HwpxDocument {
    pub version: String,
    pub sections: Vec<String>,
    pub images: Vec<String>,
    pub image_info: Vec<ImageInfo>,
    pub preview_text: String,
    pub tables: Vec<Table>,
}

/// Table structure
#[derive(Debug, Clone)]
pub struct Table {
    pub rows: usize,
    pub cols: usize,
    pub cells: Vec<Vec<String>>,
    pub has_header: bool,
}

impl Table {
    /// Convert table to Markdown format.
    ///
    /// Same rendering rules as the HWP 5.x `build_gfm_table`:
    /// - 1-column wrapper tables → unwrap to plain paragraphs
    /// - Header separator always emitted after row 0 (GFM requires it)
    /// - Newlines inside cells become `<br>`
    /// - Pipes inside cells are escaped as `\|`
    /// - Header separator width matches actual column count
    pub fn to_markdown(&self) -> String {
        if self.cells.is_empty() || self.cols == 0 {
            return String::new();
        }

        // 1-column layout wrapper → unwrap to paragraphs
        if self.cols == 1 {
            return self.cells.iter()
                .filter_map(|row| row.first().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
        }

        let mut md = String::new();
        for (row_idx, row) in self.cells.iter().enumerate() {
            md.push('|');
            for cell in row {
                let escaped = cell.trim().replace('\n', "<br>").replace('|', "\\|");
                md.push(' ');
                md.push_str(&escaped);
                md.push_str(" |");
            }
            md.push('\n');

            // GFM header separator after the first row (always, not just when has_header)
            if row_idx == 0 {
                md.push('|');
                for _ in 0..self.cols {
                    md.push_str(" --- |");
                }
                md.push('\n');
            }
        }

        md
    }
}

impl HwpxParser {
    /// Open an HWPX file (native only).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::from_bytes(bytes)
    }

    /// 메모리 바이트로부터 HWPX 파서를 생성합니다. WASM/네이티브 공통 진입점.
    pub fn from_bytes<B: Into<Vec<u8>>>(bytes: B) -> io::Result<Self> {
        let cursor = Cursor::new(bytes.into());
        let archive = ZipArchive::new(cursor)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(Self {
            archive,
            char_styles: HashMap::new(),
        })
    }

    /// Parse the HWPX document
    pub fn parse(&mut self) -> io::Result<HwpxDocument> {
        let version = self.read_version()?;
        let preview_text = self.read_preview_text().unwrap_or_default();

        // Parse header.xml for character styles
        self.parse_header_styles()?;

        let (sections, tables) = self.extract_sections_with_tables()?;
        let images = self.list_images();
        
        // Parse manifest and extract image info
        let image_info = self.extract_images_with_data()?;

        Ok(HwpxDocument {
            version,
            sections,
            images,
            image_info,
            preview_text,
            tables,
        })
    }

    /// Parse header.xml to extract character style definitions
    fn parse_header_styles(&mut self) -> io::Result<()> {
        if let Ok(mut file) = self.archive.by_name("Contents/header.xml") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            self.char_styles = parse_char_properties(&content);
        }
        Ok(())
    }

    /// Read version info
    fn read_version(&mut self) -> io::Result<String> {
        if let Ok(mut file) = self.archive.by_name("version.xml") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            if let Some(start) = content.find("version=\"") {
                let start = start + 9;
                if let Some(end) = content[start..].find('"') {
                    return Ok(content[start..start + end].to_string());
                }
            }
        }
        Ok("unknown".to_string())
    }

    /// Read preview text (fast method)
    fn read_preview_text(&mut self) -> io::Result<String> {
        let mut file = self.archive.by_name("Preview/PrvText.txt")?;
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        Ok(content)
    }

    /// Extract text and tables from all sections
    fn extract_sections_with_tables(&mut self) -> io::Result<(Vec<String>, Vec<Table>)> {
        let mut sections = Vec::new();
        let mut all_tables = Vec::new();
        let mut section_idx = 0;

        loop {
            let section_name = format!("Contents/section{}.xml", section_idx);
            match self.archive.by_name(&section_name) {
                Ok(mut file) => {
                    let mut content = String::new();
                    file.read_to_string(&mut content)?;

                    let (text, tables) = parse_section_xml(&content, &self.char_styles);
                    sections.push(text);
                    all_tables.extend(tables);
                    section_idx += 1;
                }
                Err(_) => break,
            }
        }

        Ok((sections, all_tables))
    }

    /// List all images in BinData
    fn list_images(&self) -> Vec<String> {
        self.archive
            .file_names()
            .filter(|name| name.starts_with("BinData/"))
            .map(|s| s.to_string())
            .collect()
    }

    /// Get section count
    pub fn section_count(&self) -> usize {
        self.archive
            .file_names()
            .filter(|name| name.starts_with("Contents/section") && name.ends_with(".xml"))
            .count()
    }

    /// Check if compressed
    pub fn is_compressed(&self) -> bool {
        true
    }

    /// Check if encrypted
    pub fn is_encrypted(&self) -> bool {
        false
    }

    /// Parse manifest (content.hpf) and extract images with binary data
    fn extract_images_with_data(&mut self) -> io::Result<Vec<ImageInfo>> {
        let mut image_list = Vec::new();
        
        // First, parse the manifest to get image metadata
        if let Ok(mut file) = self.archive.by_name("Contents/content.hpf") {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            
            // Parse manifest for image items
            // Format: <opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp" .../>
            let mut pos = 0;
            while let Some(item_start) = content[pos..].find("<opf:item ") {
                let item_pos = pos + item_start;
                if let Some(item_end) = content[item_pos..].find("/>") {
                    let item_xml = &content[item_pos..item_pos + item_end + 2];
                    
                    // Check if this is an image
                    if let Some(href) = extract_attr(item_xml, "href") {
                        if href.starts_with("BinData/") {
                            let id = extract_attr(item_xml, "id").unwrap_or_default();
                            let media_type = extract_attr(item_xml, "media-type").unwrap_or_default();
                            
                            image_list.push((id, href, media_type));
                        }
                    }
                    pos = item_pos + item_end + 2;
                } else {
                    break;
                }
            }
        }
        
        // Now extract the actual image data
        let mut result = Vec::new();
        for (id, path, media_type) in image_list {
            if let Ok(mut file) = self.archive.by_name(&path) {
                let mut data = Vec::new();
                file.read_to_end(&mut data)?;
                result.push(ImageInfo {
                    id,
                    path,
                    media_type,
                    data,
                });
            }
        }
        
        Ok(result)
    }
}

/// Parse character properties from header.xml
fn parse_char_properties(header_xml: &str) -> HashMap<u32, CharStyle> {
    let mut styles = HashMap::new();

    // Find each charPr element
    let mut pos = 0;
    while let Some(start) = header_xml[pos..].find("<hh:charPr ") {
        let char_pr_start = pos + start;

        // Find the end of this charPr element
        if let Some(end) = header_xml[char_pr_start..].find("</hh:charPr>") {
            let char_pr_xml = &header_xml[char_pr_start..char_pr_start + end + 12];

            // Extract id
            if let Some(id) = extract_attr(char_pr_xml, "id") {
                if let Ok(id_num) = id.parse::<u32>() {
                    let mut style = CharStyle::default();

                    // Check for bold
                    style.bold = char_pr_xml.contains("<hh:bold") || char_pr_xml.contains("<hh:bold/>");

                    // Check for italic
                    style.italic = char_pr_xml.contains("<hh:italic") || char_pr_xml.contains("<hh:italic/>");

                    // Check for underline (type != NONE)
                    if let Some(underline_pos) = char_pr_xml.find("<hh:underline ") {
                        let underline_xml = &char_pr_xml[underline_pos..];
                        if let Some(type_val) = extract_attr(underline_xml, "type") {
                            style.underline = type_val != "NONE";
                        }
                    }

                    // Check for strikeout (shape != NONE)
                    if let Some(strike_pos) = char_pr_xml.find("<hh:strikeout ") {
                        let strike_xml = &char_pr_xml[strike_pos..];
                        if let Some(shape_val) = extract_attr(strike_xml, "shape") {
                            style.strikeout = shape_val != "NONE";
                        }
                    }

                    styles.insert(id_num, style);
                }
            }
            pos = char_pr_start + end + 12;
        } else {
            break;
        }
    }

    styles
}

/// Depth-aware finder for the MATCHING close tag when the same tag can nest.
///
/// Starts scanning at `from`, assumes we've already opened 1 level of `open`.
/// Returns the absolute index of the close tag that balances the opened depth,
/// or `None` if the XML is unbalanced.
///
/// Critical for HWPX: tables (`<hp:tbl>`) and cells (`<hp:tc>`) can nest, and
/// naïve `find("</hp:tbl>")` returns the FIRST close which is the inner one —
/// causing the outer table to truncate and lose all nested-cell content.
/// Reference: pyhwpx/kordoc use recursive tree walkers; we need the same
/// correctness without pulling in a DOM parser.
fn find_matching_close(xml: &str, from: usize, open: &str, close: &str) -> Option<usize> {
    let mut depth: usize = 1;
    let mut scan = from;
    while scan < xml.len() && depth > 0 {
        let o = xml[scan..].find(open).map(|i| scan + i);
        let c = xml[scan..].find(close).map(|i| scan + i);
        match (o, c) {
            (Some(oo), Some(cc)) if oo < cc => {
                depth += 1;
                scan = oo + open.len();
            }
            (_, Some(cc)) => {
                depth -= 1;
                if depth == 0 {
                    return Some(cc);
                }
                scan = cc + close.len();
            }
            _ => return None,
        }
    }
    None
}

/// Parse section XML and extract text with tables
fn parse_section_xml(xml: &str, char_styles: &HashMap<u32, CharStyle>) -> (String, Vec<Table>) {
    let mut result = String::new();
    let mut tables = Vec::new();
    let mut pos = 0;

    while pos < xml.len() {
        // Look for table start
        if let Some(tbl_start) = xml[pos..].find("<hp:tbl ") {
            let tbl_pos = pos + tbl_start;

            // Extract text before table
            let before_table = &xml[pos..tbl_pos];
            result.push_str(&extract_text_with_formatting(before_table, char_styles));

            // Find matching table close — must be depth-aware because HWPX
            // tables can nest. See find_matching_close() for rationale.
            let scan_from = tbl_pos + "<hp:tbl ".len();
            if let Some(tbl_end) = find_matching_close(xml, scan_from, "<hp:tbl ", "</hp:tbl>") {
                let table_xml = &xml[tbl_pos..tbl_end + 9];

                if let Some(table) = parse_table(table_xml) {
                    result.push_str("\n\n");
                    result.push_str(&table.to_markdown());
                    result.push('\n');
                    tables.push(table);
                }

                pos = tbl_end + 9;
            } else {
                pos = tbl_pos + 1;
            }
        } else {
            // No more tables, extract remaining text
            result.push_str(&extract_text_with_formatting(&xml[pos..], char_styles));
            break;
        }
    }

    // Clean up result
    let cleaned = clean_text(&result);
    (cleaned, tables)
}

/// Parse a single HWPX table from XML.
///
/// Walks `<hp:tc>` elements collecting cell text + position metadata from
/// `<hp:cellAddr colAddr rowAddr>` and `<hp:cellSpan colSpan rowSpan>` child
/// elements (HWPX spec). Cells are placed in a `rows × cols` grid using direct
/// addresses, with span shadow-fill — same algorithm as the HWP 5.x parser's
/// `build_gfm_table` (vendor/markdown-media/core/src/hwp/parser.rs).
///
/// Without addr-based placement, mdm's HWPX parser previously rendered merged
/// header tables with mis-aligned columns and dropped rows where the cell
/// count didn't match `rowCnt × colCnt`.
fn parse_table(xml: &str) -> Option<Table> {
    let rows: usize = extract_attr(xml, "rowCnt").and_then(|s| s.parse().ok()).unwrap_or(0);
    let cols: usize = extract_attr(xml, "colCnt").and_then(|s| s.parse().ok()).unwrap_or(0);
    if rows == 0 || cols == 0 {
        return None;
    }

    // Bound to avoid runaway allocation on malformed files
    let rows = rows.min(1024);
    let cols = cols.min(256);

    // Collect every <hp:tc> with its address + span + text
    #[derive(Clone)]
    struct CellMeta {
        col_addr: usize,
        row_addr: usize,
        col_span: usize,
        row_span: usize,
        text: String,
        has_addr: bool,
    }

    let mut collected: Vec<CellMeta> = Vec::new();
    let mut has_header = false;
    let mut sequential_idx: usize = 0; // for files without explicit addr
    let mut pos = 0;

    while let Some(tc_start) = xml[pos..].find("<hp:tc ") {
        let tc_pos = pos + tc_start;

        if extract_attr(&xml[tc_pos..], "header").as_deref() == Some("1") {
            has_header = true;
        }

        // Depth-aware close finder — cells can contain nested tables with
        // nested cells. Without depth tracking, the inner cell's `</hp:tc>`
        // would close the outer cell prematurely and we'd mis-count rows.
        let scan_from = tc_pos + "<hp:tc ".len();
        let Some(tc_end) = find_matching_close(xml, scan_from, "<hp:tc ", "</hp:tc>")
        else { break; };
        let cell_xml = &xml[tc_pos..tc_end];

        // <hp:cellAddr colAddr="..." rowAddr="..."/>
        let (col_addr, row_addr, has_addr) = match cell_xml.find("<hp:cellAddr ") {
            Some(addr_start) => {
                let addr_xml = &cell_xml[addr_start..];
                let ca = extract_attr(addr_xml, "colAddr").and_then(|s| s.parse().ok());
                let ra = extract_attr(addr_xml, "rowAddr").and_then(|s| s.parse().ok());
                match (ca, ra) {
                    (Some(c), Some(r)) => (c, r, true),
                    _ => (sequential_idx % cols, sequential_idx / cols, false),
                }
            }
            None => (sequential_idx % cols, sequential_idx / cols, false),
        };

        // <hp:cellSpan colSpan="..." rowSpan="..."/>
        let (col_span, row_span) = match cell_xml.find("<hp:cellSpan ") {
            Some(span_start) => {
                let span_xml = &cell_xml[span_start..];
                let cs = extract_attr(span_xml, "colSpan").and_then(|s| s.parse().ok()).unwrap_or(1usize);
                let rs = extract_attr(span_xml, "rowSpan").and_then(|s| s.parse().ok()).unwrap_or(1usize);
                (cs.max(1).min(cols), rs.max(1).min(rows))
            }
            None => (1, 1),
        };

        let text = extract_cell_text(cell_xml);
        collected.push(CellMeta {
            col_addr,
            row_addr,
            col_span,
            row_span,
            text,
            has_addr,
        });
        sequential_idx += 1;
        // tc_end is now ABSOLUTE (from find_matching_close) — advance past
        // `</hp:tc>` to skip the entire closed cell including any nested tables.
        pos = tc_end + "</hp:tc>".len();
    }

    if collected.is_empty() {
        return None;
    }

    // Build grid: None = unplaced, Some("") = shadow span fill, Some("text") = cell
    let mut grid: Vec<Vec<Option<String>>> = vec![vec![None; cols]; rows];

    let any_addr = collected.iter().any(|c| c.has_addr);

    if any_addr {
        for cell in &collected {
            if cell.row_addr >= rows || cell.col_addr >= cols {
                continue;
            }
            grid[cell.row_addr][cell.col_addr] = Some(cell.text.clone());
            for dr in 0..cell.row_span {
                for dc in 0..cell.col_span {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let rr = cell.row_addr + dr;
                    let cc = cell.col_addr + dc;
                    if rr < rows && cc < cols && grid[rr][cc].is_none() {
                        grid[rr][cc] = Some(String::new());
                    }
                }
            }
        }
    } else {
        // Sequential fill fallback (for files that omit cellAddr)
        let mut idx = 0usize;
        for r in 0..rows {
            for c in 0..cols {
                if grid[r][c].is_some() {
                    continue;
                }
                if idx >= collected.len() {
                    break;
                }
                let cell = &collected[idx];
                idx += 1;
                grid[r][c] = Some(cell.text.clone());
                for dr in 0..cell.row_span {
                    for dc in 0..cell.col_span {
                        if dr == 0 && dc == 0 {
                            continue;
                        }
                        let rr = r + dr;
                        let cc = c + dc;
                        if rr < rows && cc < cols && grid[rr][cc].is_none() {
                            grid[rr][cc] = Some(String::new());
                        }
                    }
                }
            }
        }
    }

    // Drop fully-empty rows (information-free shadow noise)
    let cells: Vec<Vec<String>> = grid
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|cell| cell.unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .filter(|row| row.iter().any(|c| !c.trim().is_empty()))
        .collect();

    if cells.is_empty() {
        return None;
    }

    Some(Table {
        rows: cells.len(),
        cols,
        cells,
        has_header,
    })
}

/// Extract cell text from cell XML.
///
/// Walks all `<hp:t>` runs (with or without attrs) AND any nested `<hp:drawText>`
/// (textbox) content. Multiple `<hp:p>` paragraphs inside a cell are joined
/// with `\n` (preserved as `<br>` by the table renderer). Text is decoded for
/// XML entities (`&amp;` → `&`, `&lt;` → `<`, etc).
fn extract_cell_text(xml: &str) -> String {
    // Collect text segments per <hp:p> paragraph
    let mut paragraphs: Vec<String> = Vec::new();
    let mut p_pos = 0;

    loop {
        // Find next <hp:p>... opening (allow with or without attrs)
        let opening = xml[p_pos..].find("<hp:p>").map(|i| (p_pos + i, 6))
            .or_else(|| xml[p_pos..].find("<hp:p ").map(|i| (p_pos + i, 6)));

        match opening {
            Some((p_start, _)) => {
                let after_open = match xml[p_start..].find('>') {
                    Some(i) => p_start + i + 1,
                    None => break,
                };
                let p_end = match xml[after_open..].find("</hp:p>") {
                    Some(i) => after_open + i,
                    None => break,
                };
                let p_xml = &xml[after_open..p_end];
                let p_text = extract_runs_text(p_xml);
                if !p_text.trim().is_empty() {
                    paragraphs.push(p_text);
                }
                p_pos = p_end + 7;
            }
            None => break,
        }
    }

    // Fallback: if no <hp:p> wrappers, just walk runs at the cell level
    if paragraphs.is_empty() {
        let direct = extract_runs_text(xml);
        if !direct.trim().is_empty() {
            paragraphs.push(direct);
        }
    }

    paragraphs.join("\n").trim().to_string()
}

/// Walk every `<hp:t>` run inside a fragment, decode XML entities, also pick up
/// `<hp:drawText>...</hp:drawText>` textbox bodies recursively, plus
/// `<hp:pic>` / `<hp:img>` references which become `[이미지: imageN]` markers.
fn extract_runs_text(xml: &str) -> String {
    let mut out = String::new();
    let mut pos = 0;

    while pos < xml.len() {
        // Pick the earliest opening tag — order matters for ties.
        let t1 = xml[pos..].find("<hp:t>");
        let t2 = xml[pos..].find("<hp:t ");
        let dt1 = xml[pos..].find("<hp:drawText>");
        let dt2 = xml[pos..].find("<hp:drawText ");
        let tab = xml[pos..].find("<hp:tab/>");
        let lb = xml[pos..].find("<hp:lineBreak/>");
        // Image references: hc:img carries binaryItemIDRef. It usually lives
        // inside an <hp:pic> wrapper but kordoc just emits one marker per
        // hc:img occurrence regardless of wrapper.
        let img1 = xml[pos..].find("<hc:img ");
        let img2 = xml[pos..].find("<hc:img>");

        let candidates = [
            t1.map(|i| (i, "t")),
            t2.map(|i| (i, "t")),
            dt1.map(|i| (i, "dt")),
            dt2.map(|i| (i, "dt")),
            tab.map(|i| (i, "tab")),
            lb.map(|i| (i, "lb")),
            img1.map(|i| (i, "img")),
            img2.map(|i| (i, "img")),
        ];
        let next = candidates
            .iter()
            .filter_map(|c| *c)
            .min_by_key(|(i, _)| *i);

        let Some((rel, kind)) = next else { break; };
        let abs = pos + rel;

        match kind {
            "t" => {
                let after_open = match xml[abs..].find('>') {
                    Some(i) => abs + i + 1,
                    None => break,
                };
                let close = match xml[after_open..].find("</hp:t>") {
                    Some(i) => after_open + i,
                    None => break,
                };
                let raw = &xml[after_open..close];
                out.push_str(&decode_xml_entities(raw));
                pos = close + 7;
            }
            "dt" => {
                let after_open = match xml[abs..].find('>') {
                    Some(i) => abs + i + 1,
                    None => break,
                };
                let close = match xml[after_open..].find("</hp:drawText>") {
                    Some(i) => after_open + i,
                    None => break,
                };
                let inner = &xml[after_open..close];
                let inner_text = extract_runs_text(inner);
                if !inner_text.trim().is_empty() {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str(inner_text.trim());
                }
                pos = close + 14;
            }
            "tab" => {
                out.push('\t');
                pos = abs + 9;
            }
            "lb" => {
                out.push('\n');
                pos = abs + 15;
            }
            "img" => {
                // <hc:img binaryItemIDRef="image1" .../>  →  [이미지: image1]
                let after_open = match xml[abs..].find('>') {
                    Some(i) => abs + i + 1,
                    None => break,
                };
                let tag_xml = &xml[abs..after_open];
                if let Some(id) = extract_attr(tag_xml, "binaryItemIDRef") {
                    if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                        out.push(' ');
                    }
                    out.push_str(&format!("[이미지: {}]", id));
                }
                pos = after_open;
            }
            _ => break,
        }
    }

    out
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Extract attribute value from XML tag
fn extract_attr(xml: &str, attr: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr);
    if let Some(start) = xml.find(&pattern) {
        let value_start = start + pattern.len();
        if let Some(end) = xml[value_start..].find('"') {
            return Some(xml[value_start..value_start + end].to_string());
        }
    }
    None
}

/// Extract text with formatting from section XML
fn extract_text_with_formatting(xml: &str, char_styles: &HashMap<u32, CharStyle>) -> String {
    let mut result = String::new();
    let mut pos = 0;

    // Process paragraph by paragraph
    while let Some(p_start) = xml[pos..].find("<hp:p") {
        let p_pos = pos + p_start;

        // Find the end of paragraph
        if let Some(p_end) = xml[p_pos..].find("</hp:p>") {
            let para_xml = &xml[p_pos..p_pos + p_end + 7];

            // Extract runs from this paragraph
            let para_text = extract_runs_with_formatting(para_xml, char_styles);
            if !para_text.is_empty() {
                result.push_str(&para_text);
                result.push('\n');
            }

            pos = p_pos + p_end + 7;
        } else {
            break;
        }
    }

    result
}

/// Extract runs with formatting applied
fn extract_runs_with_formatting(para_xml: &str, char_styles: &HashMap<u32, CharStyle>) -> String {
    let mut result = String::new();
    let mut pos = 0;

    while let Some(run_start) = para_xml[pos..].find("<hp:run ") {
        let run_pos = pos + run_start;

        // Get charPrIDRef attribute
        let run_tag_end = para_xml[run_pos..].find('>').unwrap_or(0);
        let run_tag = &para_xml[run_pos..run_pos + run_tag_end];
        let char_pr_id = extract_attr(run_tag, "charPrIDRef")
            .and_then(|s| s.parse::<u32>().ok());

        // Find run content and end
        if let Some(run_end) = para_xml[run_pos..].find("</hp:run>") {
            let run_content = &para_xml[run_pos..run_pos + run_end];

            // Extract text from <hp:t> tags within this run
            let mut text_content = String::new();
            let mut t_pos = 0;

            while let Some(t_start) = run_content[t_pos..].find("<hp:t>") {
                let t_start_pos = t_pos + t_start + 6;
                if let Some(t_end) = run_content[t_start_pos..].find("</hp:t>") {
                    let text = &run_content[t_start_pos..t_start_pos + t_end];
                    text_content.push_str(text);
                    t_pos = t_start_pos + t_end + 7;
                } else {
                    break;
                }
            }

            // Handle <hp:fwSpace/> (fixed-width space)
            if run_content.contains("<hp:fwSpace/>") && text_content.is_empty() {
                text_content.push(' ');
            }

            // Image references — scan run content for <hc:img binaryItemIDRef="...">
            // and emit `[이미지: imageN]` placeholders. kordoc emits one marker per
            // image occurrence so RAG/embedding pipelines can locate visual content.
            let mut img_scan = 0usize;
            while let Some(img_rel) = run_content[img_scan..].find("<hc:img ") {
                let img_abs = img_scan + img_rel;
                let after = match run_content[img_abs..].find('>') {
                    Some(i) => img_abs + i + 1,
                    None => break,
                };
                let tag = &run_content[img_abs..after];
                if let Some(id) = extract_attr(tag, "binaryItemIDRef") {
                    if !text_content.is_empty() && !text_content.ends_with(char::is_whitespace) {
                        text_content.push(' ');
                    }
                    text_content.push_str(&format!("[이미지: {}]", id));
                }
                img_scan = after;
            }

            // Apply formatting if we have text and a valid charPrIDRef
            if !text_content.is_empty() {
                let formatted = if let Some(id) = char_pr_id {
                    if let Some(style) = char_styles.get(&id) {
                        apply_markdown_formatting(&text_content, style)
                    } else {
                        text_content
                    }
                } else {
                    text_content
                };
                result.push_str(&formatted);
            }

            pos = run_pos + run_end + 9;
        } else {
            // Self-closing run or malformed
            pos = run_pos + 1;
        }
    }

    result
}

/// Apply Markdown formatting based on CharStyle
fn apply_markdown_formatting(text: &str, style: &CharStyle) -> String {
    let mut result = text.to_string();

    // Apply formatting in order: strikeout, bold, italic, underline
    if style.strikeout {
        result = format!("~~{}~~", result);
    }
    if style.bold && style.italic {
        result = format!("***{}***", result);
    } else if style.bold {
        result = format!("**{}**", result);
    } else if style.italic {
        result = format!("*{}*", result);
    }
    if style.underline {
        // Markdown doesn't have native underline, use HTML
        result = format!("<u>{}</u>", result);
    }

    result
}

/// Simple text extraction (for non-table content) - fallback without formatting
fn extract_text_simple(xml: &str) -> String {
    let mut result = String::new();
    let mut in_text_tag = false;
    let mut chars = xml.chars().peekable();
    let mut skip_table = false;

    while let Some(c) = chars.next() {
        if c == '<' {
            let mut tag = String::new();
            while let Some(&next) = chars.peek() {
                if next == '>' {
                    chars.next();
                    break;
                }
                tag.push(chars.next().unwrap());
            }

            // Skip table content (handled separately)
            if tag.starts_with("hp:tbl ") {
                skip_table = true;
            } else if tag == "/hp:tbl" {
                skip_table = false;
            } else if !skip_table {
                if tag == "hp:t" || tag.starts_with("hp:t ") {
                    in_text_tag = true;
                } else if tag == "/hp:t" {
                    in_text_tag = false;
                } else if tag == "/hp:p" {
                    result.push('\n');
                }
            }
        } else if in_text_tag && !skip_table {
            result.push(c);
        }
    }

    result
}

/// Remove XML tags of a given name from text
fn remove_xml_tags(text: &str, tag_name: &str) -> String {
    let mut result = text.to_string();
    let open_pattern = format!("<{} ", tag_name);
    let self_close = "/>";
    let close_pattern = format!("</{}>", tag_name);

    // Remove self-closing tags like <hp:tab ... />
    loop {
        if let Some(start) = result.find(&open_pattern) {
            if let Some(end) = result[start..].find(self_close) {
                result = format!("{} {}", &result[..start], &result[start + end + 2..]);
                continue;
            } else if let Some(end) = result[start..].find('>') {
                // Tag ends with > but may have closing tag later
                if let Some(close) = result[start + end..].find(&close_pattern) {
                    result = format!(
                        "{} {}",
                        &result[..start],
                        &result[start + end + 1 + close + close_pattern.len()..]
                    );
                    continue;
                }
            }
        }
        break;
    }

    result
}

/// Clean up extracted text
fn clean_text(text: &str) -> String {
    let mut cleaned = String::new();
    let mut prev_newline_count = 0;

    // Replace any remaining XML tags
    let text = text.replace("<hp:fwSpace/>", " ");
    // Remove tab tags (but preserve their presence as a space)
    let text = remove_xml_tags(&text, "hp:tab");

    for c in text.chars() {
        if c == '\n' {
            prev_newline_count += 1;
            if prev_newline_count <= 2 {
                cleaned.push(c);
            }
        } else if c.is_whitespace() {
            if !cleaned.ends_with(' ') && !cleaned.ends_with('\n') {
                cleaned.push(' ');
            }
            prev_newline_count = 0;
        } else {
            cleaned.push(c);
            prev_newline_count = 0;
        }
    }

    // Clean up redundant formatting markers
    let cleaned = cleaned.replace("******", "");
    let cleaned = cleaned.replace("****", "");
    let cleaned = cleaned.replace("** **", " ");
    let cleaned = cleaned.replace("**  **", " ");

    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_to_markdown() {
        let table = Table {
            rows: 2,
            cols: 3,
            cells: vec![
                vec!["헤더1".to_string(), "헤더2".to_string(), "헤더3".to_string()],
                vec!["데이터1".to_string(), "데이터2".to_string(), "데이터3".to_string()],
            ],
            has_header: true,
        };

        let md = table.to_markdown();
        assert!(md.contains("| 헤더1 |"));
        // GFM header separator: current impl emits spaced `| --- | --- | --- |`.
        assert!(md.contains("| --- | --- | --- |"));
        assert!(md.contains("| 데이터1 |"));
    }

    #[test]
    fn test_extract_cell_text() {
        let xml = r#"<hp:tc><hp:subList><hp:p><hp:run><hp:t>테스트</hp:t></hp:run></hp:p></hp:subList></hp:tc>"#;
        let text = extract_cell_text(xml);
        assert_eq!(text, "테스트");
    }

    #[test]
    fn test_extract_attr() {
        let xml = r#"<hp:tbl rowCnt="5" colCnt="3">"#;
        assert_eq!(extract_attr(xml, "rowCnt"), Some("5".to_string()));
        assert_eq!(extract_attr(xml, "colCnt"), Some("3".to_string()));
    }

    #[test]
    fn test_apply_markdown_formatting() {
        // Test bold
        let style = CharStyle {
            bold: true,
            italic: false,
            underline: false,
            strikeout: false,
        };
        assert_eq!(apply_markdown_formatting("테스트", &style), "**테스트**");

        // Test italic
        let style = CharStyle {
            bold: false,
            italic: true,
            underline: false,
            strikeout: false,
        };
        assert_eq!(apply_markdown_formatting("테스트", &style), "*테스트*");

        // Test bold+italic
        let style = CharStyle {
            bold: true,
            italic: true,
            underline: false,
            strikeout: false,
        };
        assert_eq!(apply_markdown_formatting("테스트", &style), "***테스트***");

        // Test underline
        let style = CharStyle {
            bold: false,
            italic: false,
            underline: true,
            strikeout: false,
        };
        assert_eq!(apply_markdown_formatting("테스트", &style), "<u>테스트</u>");

        // Test strikeout
        let style = CharStyle {
            bold: false,
            italic: false,
            underline: false,
            strikeout: true,
        };
        assert_eq!(apply_markdown_formatting("테스트", &style), "~~테스트~~");

        // Test combined: bold + underline + strikeout
        let style = CharStyle {
            bold: true,
            italic: false,
            underline: true,
            strikeout: true,
        };
        assert_eq!(
            apply_markdown_formatting("테스트", &style),
            "<u>**~~테스트~~**</u>"
        );
    }

    #[test]
    fn test_parse_char_properties() {
        let header_xml = r#"
            <hh:charPr id="0" height="1000">
                <hh:underline type="NONE"/>
                <hh:strikeout shape="NONE"/>
            </hh:charPr>
            <hh:charPr id="7" height="1100">
                <hh:bold/>
                <hh:underline type="NONE"/>
                <hh:strikeout shape="NONE"/>
            </hh:charPr>
            <hh:charPr id="28" height="2200">
                <hh:bold/>
                <hh:underline type="BOTTOM"/>
                <hh:strikeout shape="NONE"/>
            </hh:charPr>
            <hh:charPr id="99" height="1000">
                <hh:underline type="NONE"/>
                <hh:strikeout shape="3D"/>
            </hh:charPr>
        "#;

        let styles = parse_char_properties(header_xml);

        // id 0: no formatting
        let style0 = styles.get(&0).unwrap();
        assert!(!style0.bold);
        assert!(!style0.underline);
        assert!(!style0.strikeout);

        // id 7: bold only
        let style7 = styles.get(&7).unwrap();
        assert!(style7.bold);
        assert!(!style7.underline);
        assert!(!style7.strikeout);

        // id 28: bold + underline
        let style28 = styles.get(&28).unwrap();
        assert!(style28.bold);
        assert!(style28.underline);
        assert!(!style28.strikeout);

        // id 99: strikeout only
        let style99 = styles.get(&99).unwrap();
        assert!(!style99.bold);
        assert!(!style99.underline);
        assert!(style99.strikeout);
    }

    #[test]
    fn test_remove_xml_tags() {
        let text = "앞<hp:tab width=\"100\" type=\"1\"/>뒤";
        let result = remove_xml_tags(text, "hp:tab");
        assert!(result.contains("앞"));
        assert!(result.contains("뒤"));
        assert!(!result.contains("<hp:tab"));
    }
}
