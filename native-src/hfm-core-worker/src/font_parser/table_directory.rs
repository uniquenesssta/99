use std::fs::File;
use super::diagnostics::{record, MetadataDiagnostic, MetadataDiagnosticKind as Kind};
use std::io;

use super::sfnt::read_u16_be;
use super::ttc::read_exact_at;

pub const MAX_TABLE_DIRECTORY_BYTES: usize = 8192;

pub fn read_font_table_directory(file: &mut File, font_offset: u64, source_index: usize, diagnostics: &mut Vec<MetadataDiagnostic>) -> io::Result<Option<Vec<u8>>> {
    let directory_header = read_exact_at(file, font_offset, 12)?;
    if !super::sfnt::is_supported_sfnt_tag(&directory_header, 0) {
        record(diagnostics, "table-directory", Kind::UnsupportedFormat, Some(source_index), "sfnt-tag");
    }
    let num_tables = usize::from(read_u16_be(&directory_header, 4).unwrap_or(0));
    if num_tables == 0 {
        record(diagnostics, "table-directory", Kind::EmptyMetadata, Some(source_index), "no-tables");
        return Ok(None);
    }

    if 12usize + num_tables * 16 > MAX_TABLE_DIRECTORY_BYTES {
        record(diagnostics, "table-directory", Kind::ResourceLimit, Some(source_index), "directory-byte-limit");
    }
    let table_directory_len = (12usize + num_tables * 16).min(MAX_TABLE_DIRECTORY_BYTES);
    read_exact_at(file, font_offset, table_directory_len).map(Some)
}
