pub mod ole;
pub mod parser;
pub mod record;

pub use parser::HwpParser;
pub use record::{HwpRecord, RecordParser, extract_para_text};
