//! kordoc-rust — Rust HWP/HWPX parser backend for kordoc
//!
//! This crate exposes two parser families:
//! - [`hwp`]   — HWP 5.0 (CFB/OLE container)
//! - [`hwpx`]  — HWPX (OOXML-style zip)
//!
//! Public API is byte-slice based so the crate works uniformly on
//! native targets and wasm32-unknown-unknown.
//!
//! See `CONTRIBUTING.md` for the kordoc upstream contribution plan.

pub mod hwp;
pub mod hwpx;

pub use hwp::HwpParser;
pub use hwpx::HwpxParser;

/// Crate version exposed for the kordoc JS layer.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// WASM glue (feature = "wasm")
// ---------------------------------------------------------------------------
#[cfg(feature = "wasm")]
mod wasm_api {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(start)]
    pub fn __init() {
        console_error_panic_hook::set_once();
    }

    /// Parse an HWP 5.0 document from raw bytes. Returns plain text.
    ///
    /// TODO(contrib): swap String → typed object via `serde-wasm-bindgen`
    /// once the JSON contract is frozen with kordoc (see CONTRIBUTING.md §Step 3).
    #[wasm_bindgen(js_name = parseHwp)]
    pub fn parse_hwp(bytes: &[u8]) -> Result<String, JsError> {
        let mut parser = super::HwpParser::from_bytes(bytes.to_vec())
            .map_err(|e| JsError::new(&format!("HWP open failed: {}", e)))?;
        parser
            .extract_text()
            .map_err(|e| JsError::new(&format!("HWP extract failed: {}", e)))
    }

    /// Parse an HWPX document from raw bytes. Returns plain text.
    #[wasm_bindgen(js_name = parseHwpx)]
    pub fn parse_hwpx(bytes: &[u8]) -> Result<String, JsError> {
        let mut parser = super::HwpxParser::from_bytes(bytes.to_vec())
            .map_err(|e| JsError::new(&format!("HWPX open failed: {}", e)))?;
        let doc = parser
            .parse()
            .map_err(|e| JsError::new(&format!("HWPX parse failed: {}", e)))?;
        Ok(doc.sections.join("\n\n"))
    }

    #[wasm_bindgen(js_name = version)]
    pub fn version() -> String {
        super::VERSION.to_string()
    }
}
