use cfb::CompoundFile;
use flate2::read::ZlibDecoder;
use miniz_oxide::inflate::DecompressError;
use std::io::{self, Cursor, Read};
#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;

/// HWP FileHeader flags (offset 36-39)
#[derive(Debug, Clone, Copy)]
pub struct HwpFlags {
    pub compressed: bool,
    pub encrypted: bool,
    pub distributed: bool,
    pub script_saved: bool,
    pub drm_protected: bool,
    pub xml_template: bool,
    pub history: bool,
    pub signature: bool,
    pub certificate_encrypted: bool,
    pub certificate_drm: bool,
    pub ccl: bool,
    pub mobile_optimized: bool,
    pub private_info_security: bool,
    pub track_changes: bool,
    pub kogl: bool,
    pub video_control: bool,
    pub order_field_control: bool,
}

impl Default for HwpFlags {
    fn default() -> Self {
        HwpFlags {
            compressed: true, // Default to true as most HWP files are compressed
            encrypted: false,
            distributed: false,
            script_saved: false,
            drm_protected: false,
            xml_template: false,
            history: false,
            signature: false,
            certificate_encrypted: false,
            certificate_drm: false,
            ccl: false,
            mobile_optimized: false,
            private_info_security: false,
            track_changes: false,
            kogl: false,
            video_control: false,
            order_field_control: false,
        }
    }
}

impl HwpFlags {
    pub fn from_bytes(data: &[u8]) -> Self {
        if data.len() < 4 {
            return Self::default();
        }
        
        let flags = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        
        HwpFlags {
            compressed: (flags & 0x01) != 0,
            encrypted: (flags & 0x02) != 0,
            distributed: (flags & 0x04) != 0,
            script_saved: (flags & 0x08) != 0,
            drm_protected: (flags & 0x10) != 0,
            xml_template: (flags & 0x20) != 0,
            history: (flags & 0x40) != 0,
            signature: (flags & 0x80) != 0,
            certificate_encrypted: (flags & 0x100) != 0,
            certificate_drm: (flags & 0x200) != 0,
            ccl: (flags & 0x400) != 0,
            mobile_optimized: (flags & 0x800) != 0,
            private_info_security: (flags & 0x1000) != 0,
            track_changes: (flags & 0x2000) != 0,
            kogl: (flags & 0x4000) != 0,
            video_control: (flags & 0x8000) != 0,
            order_field_control: (flags & 0x10000) != 0,
        }
    }
}

/// OLE 파일 구조를 분석하고 스트림을 추출합니다
///
/// Internally the HWP bytes are held in a `Cursor<Vec<u8>>` so the reader
/// works uniformly on native targets (including wasm32, where `std::fs` is
/// unavailable). The `open`/path-based constructor just slurps the file into
/// memory and delegates to [`OleReader::from_bytes`].
pub struct OleReader {
    compound_file: CompoundFile<Cursor<Vec<u8>>>,
    flags: HwpFlags,
}

impl OleReader {
    /// HWP 파일을 OLE 구조로 엽니다 (네이티브 전용).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        let bytes = std::fs::read(path)?;
        Self::from_bytes(bytes)
    }

    /// 메모리에 올라온 HWP 바이트로부터 OLE 구조를 읽습니다.
    ///
    /// This is the canonical entrypoint — both native `open()` and the
    /// wasm-bindgen glue funnel through here. Accepts any
    /// `impl Into<Vec<u8>>` so callers can pass `Vec<u8>`, `&[u8]`,
    /// `Box<[u8]>`, etc. without an extra allocation dance.
    pub fn from_bytes<B: Into<Vec<u8>>>(bytes: B) -> io::Result<Self> {
        let cursor = Cursor::new(bytes.into());
        let compound_file = CompoundFile::open(cursor)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let mut reader = OleReader {
            compound_file,
            flags: HwpFlags::default(),
        };

        // Try to read flags from FileHeader
        if let Ok(header) = reader.read_stream("FileHeader") {
            if header.len() >= 40 {
                reader.flags = HwpFlags::from_bytes(&header[36..40]);
            }
        }

        Ok(reader)
    }

    /// Get file flags
    pub fn flags(&self) -> &HwpFlags {
        &self.flags
    }

    /// 모든 스트림 이름 목록을 가져옵니다
    pub fn list_streams(&self) -> Vec<String> {
        self.compound_file
            .walk()
            .filter_map(|entry| {
                if entry.is_stream() {
                    Some(entry.path().to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    /// 특정 스트림의 내용을 읽습니다 (raw, uncompressed)
    pub fn read_stream(&mut self, stream_name: &str) -> io::Result<Vec<u8>> {
        let mut stream = self.compound_file.open_stream(stream_name)
            .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
        
        let mut buffer = Vec::new();
        stream.read_to_end(&mut buffer)?;
        Ok(buffer)
    }

    /// 압축된 스트림을 읽고 해제합니다
    pub fn read_compressed_stream(&mut self, stream_name: &str) -> io::Result<Vec<u8>> {
        let raw_data = self.read_stream(stream_name)?;
        
        if !self.flags.compressed {
            return Ok(raw_data);
        }
        
        // Decompress with zlib
        decompress_zlib(&raw_data)
    }

    /// FileHeader 스트림을 읽습니다 (HWP 메타데이터)
    pub fn read_file_header(&mut self) -> io::Result<Vec<u8>> {
        // FileHeader is never compressed
        self.read_stream("FileHeader")
    }

    /// DocInfo 스트림을 읽습니다 (문서 정보)
    pub fn read_doc_info(&mut self) -> io::Result<Vec<u8>> {
        self.read_compressed_stream("DocInfo")
    }

    /// BodyText 섹션을 읽습니다
    pub fn read_body_text(&mut self, section: usize) -> io::Result<Vec<u8>> {
        let stream_name = format!("BodyText/Section{}", section);
        self.read_compressed_stream(&stream_name)
    }

    /// BinData 스트림을 읽습니다 (이미지, OLE 객체 등)
    pub fn read_bin_data(&mut self, name: &str) -> io::Result<Vec<u8>> {
        let stream_name = format!("BinData/{}", name);
        let data = self.read_stream(&stream_name)?;
        
        // BinData may or may not be compressed
        // Try to decompress, fall back to raw data
        decompress_zlib(&data).or(Ok(data))
    }

    /// 모든 BinData 스트림 이름을 가져옵니다
    pub fn list_bin_data(&self) -> Vec<String> {
        self.compound_file
            .walk()
            .filter_map(|entry| {
                let path = entry.path().to_string_lossy().to_string();
                if entry.is_stream() && path.starts_with("/BinData/") {
                    Some(path.strip_prefix("/BinData/").unwrap_or(&path).to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Read the OLE2 SummaryInformation stream (`\u{0005}HwpSummaryInformation`).
    /// Returns raw bytes; parsing into propIds is the caller's job.
    pub fn read_summary_information(&mut self) -> io::Result<Vec<u8>> {
        // The leading byte is the binary 0x05 control char per OLE2 spec for
        // standard property streams.
        self.read_stream("\u{0005}HwpSummaryInformation")
    }

    /// Summary section count
    pub fn section_count(&self) -> usize {
        let mut count = 0;
        for entry in self.compound_file.walk() {
            let path = entry.path().to_string_lossy();
            if path.starts_with("/BodyText/Section") && entry.is_stream() {
                count += 1;
            }
        }
        count
    }
}

/// Decompress zlib-compressed data
/// HWP files use raw deflate (equivalent to Python's zlib.decompress(data, -15))
pub fn decompress_zlib(data: &[u8]) -> io::Result<Vec<u8>> {
    // First try zlib with header (standard zlib format)
    let mut decoder = ZlibDecoder::new(data);
    let mut decompressed = Vec::new();
    if decoder.read_to_end(&mut decompressed).is_ok() && !decompressed.is_empty() {
        return Ok(decompressed);
    }

    // Try raw deflate using miniz_oxide (equivalent to Python's wbits=-15)
    // This is what HWP files actually use
    if let Ok(result) = decompress_raw_deflate(data) {
        if !result.is_empty() {
            return Ok(result);
        }
    }

    // Fallback: try flate2's DeflateDecoder
    use flate2::read::DeflateDecoder;
    let mut decoder = DeflateDecoder::new(data);
    let mut decompressed = Vec::new();
    decoder.read_to_end(&mut decompressed)?;
    Ok(decompressed)
}

/// Decompress raw deflate data (no zlib header)
/// Equivalent to Python's zlib.decompress(data, -15)
///
/// HWP files use raw DEFLATE compression without zlib header.
/// Python handles this with zlib.decompress(data, wbits=-15)
fn decompress_raw_deflate(data: &[u8]) -> Result<Vec<u8>, DecompressError> {
    use miniz_oxide::inflate::core::{decompress, inflate_flags, DecompressorOxide};
    use miniz_oxide::inflate::TINFLStatus;

    // Estimate output size (compressed data typically expands 2-10x)
    let estimated_size = data.len().saturating_mul(10).max(4096);
    let mut output = vec![0u8; estimated_size];
    let mut decompressor = DecompressorOxide::new();

    let mut in_pos = 0;
    let mut out_pos = 0;

    loop {
        // Flags for raw deflate (no zlib header)
        let flags = inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF
            | if in_pos < data.len() { inflate_flags::TINFL_FLAG_HAS_MORE_INPUT } else { 0 };

        let (status, bytes_read, bytes_written) = decompress(
            &mut decompressor,
            &data[in_pos..],
            &mut output[out_pos..],
            out_pos,  // Output position for non-wrapping buffer
            flags,
        );

        in_pos += bytes_read;
        out_pos += bytes_written;

        match status {
            TINFLStatus::Done => {
                output.truncate(out_pos);
                return Ok(output);
            }
            TINFLStatus::HasMoreOutput => {
                // Expand output buffer
                let new_size = output.len().saturating_mul(2);
                output.resize(new_size, 0);
            }
            TINFLStatus::NeedsMoreInput => {
                // Return what we have if we got some output
                if out_pos > 0 {
                    output.truncate(out_pos);
                    return Ok(output);
                }
                // Try simpler approach
                return decompress_raw_deflate_simple(data);
            }
            _ => {
                // Error occurred, try simpler approach
                return decompress_raw_deflate_simple(data);
            }
        }
    }
}

/// Simpler raw deflate decompression using decompress_to_vec
fn decompress_raw_deflate_simple(data: &[u8]) -> Result<Vec<u8>, DecompressError> {
    // decompress_to_vec handles raw deflate without zlib wrapper
    miniz_oxide::inflate::decompress_to_vec(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ole_structure() {
        // 실제 HWP 파일이 있어야 테스트 가능
        // TODO: 샘플 HWP 파일 추가
    }

    #[test]
    fn test_hwp_flags_parsing() {
        // Test flags: compressed=true, encrypted=false
        let data = vec![0x01, 0x00, 0x00, 0x00];
        let flags = HwpFlags::from_bytes(&data);
        assert!(flags.compressed);
        assert!(!flags.encrypted);
        
        // Test flags: compressed=true, encrypted=true
        let data = vec![0x03, 0x00, 0x00, 0x00];
        let flags = HwpFlags::from_bytes(&data);
        assert!(flags.compressed);
        assert!(flags.encrypted);
    }
}
