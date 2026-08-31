pub mod encoding;
pub mod metadata;
pub mod name_table;
pub mod scripts;
pub mod sfnt;
pub mod style;
pub mod table_directory;
pub mod ttc;
pub mod types;

pub use metadata::{probe_font_metadata_from_file, FontMetadataProbeOptions};
pub use types::{FontNameInfo, FontScriptInfo, FontStyleInfo};
