use std::fs::File;
use super::diagnostics::{record, MetadataDiagnostic, MetadataDiagnosticKind as Kind};
use std::io;
use super::encoding::decode_name_string;
use super::sfnt::{find_table_record, read_u16_be};
use super::ttc::read_exact_at;
use super::types::FontNameInfo;

const MAX_NAME_TABLE_BYTES: usize = 512 * 1024;
const MAX_NAME_RECORDS: usize = 1024;

#[derive(Clone, Debug)]
struct Candidate {
    value: String,
    priority: i32,
}

fn update_candidate(slot: &mut Option<Candidate>, value: String, priority: i32) {
    if value.is_empty() {
        return;
    }
    match slot {
        Some(existing) if existing.priority > priority => {}
        Some(existing) if existing.priority == priority && existing.value.len() <= value.len() => {}
        _ => *slot = Some(Candidate { value, priority }),
    }
}

fn priority_for_record(platform_id: u16, language_id: u16, name_id: u16) -> i32 {
    let mut priority = 0;
    if platform_id == 3 {
        priority += 100;
    } else if platform_id == 0 {
        priority += 90;
    } else if platform_id == 1 {
        priority += 50;
    }

    match language_id {
        0x0409 => priority += 40,
        0x0804 | 0x0404 | 0x0c04 | 0x1004 | 0x1404 => priority += 35,
        0 => priority += 20,
        _ => priority += 5,
    }

    if name_id == 16 || name_id == 17 {
        priority += 10;
    }

    priority
}

fn parse_name_table(data: &[u8], source_index: usize) -> Option<FontNameInfo> {
    if data.len() < 6 {
        return None;
    }

    let count = usize::from(read_u16_be(data, 2)?);
    if count > MAX_NAME_RECORDS { return None; }
    let string_offset = usize::from(read_u16_be(data, 4)?);
    let records_end = 6usize.checked_add(count.checked_mul(12)?)?;
    if records_end > data.len() || string_offset > data.len() {
        return None;
    }

    let mut family_name: Option<Candidate> = None;
    let mut subfamily_name: Option<Candidate> = None;
    let mut full_name: Option<Candidate> = None;
    let mut postscript_name: Option<Candidate> = None;
    let mut preferred_family: Option<Candidate> = None;
    let mut preferred_subfamily: Option<Candidate> = None;
    let mut version: Option<Candidate> = None;
    let mut manufacturer: Option<Candidate> = None;
    let mut decoded_records = 0usize;

    for record_index in 0..count {
        let record_offset = 6 + record_index * 12;
        let platform_id = read_u16_be(data, record_offset)?;
        let encoding_id = read_u16_be(data, record_offset + 2)?;
        let language_id = read_u16_be(data, record_offset + 4)?;
        let name_id = read_u16_be(data, record_offset + 6)?;
        let length = usize::from(read_u16_be(data, record_offset + 8)?);
        let offset = usize::from(read_u16_be(data, record_offset + 10)?);
        let start = string_offset.checked_add(offset)?;
        let end = start.checked_add(length)?;
        if end > data.len() {
            continue;
        }

        let Some(value) = decode_name_string(platform_id, encoding_id, &data[start..end]) else {
            continue;
        };
        decoded_records += 1;
        let priority = priority_for_record(platform_id, language_id, name_id);

        match name_id {
            1 => update_candidate(&mut family_name, value, priority),
            2 => update_candidate(&mut subfamily_name, value, priority),
            4 => update_candidate(&mut full_name, value, priority),
            5 => update_candidate(&mut version, value, priority),
            6 => update_candidate(&mut postscript_name, value, priority),
            8 => update_candidate(&mut manufacturer, value, priority),
            16 => update_candidate(&mut preferred_family, value, priority),
            17 => update_candidate(&mut preferred_subfamily, value, priority),
            _ => {}
        }
    }

    let info = FontNameInfo {
        family_name: family_name.map(|item| item.value),
        subfamily_name: subfamily_name.map(|item| item.value),
        full_name: full_name.map(|item| item.value),
        postscript_name: postscript_name.map(|item| item.value),
        preferred_family: preferred_family.map(|item| item.value),
        preferred_subfamily: preferred_subfamily.map(|item| item.value),
        version: version.map(|item| item.value),
        manufacturer: manufacturer.map(|item| item.value),
        record_count: decoded_records,
        source_index,
    };

    if info.has_any_name() {
        Some(info)
    } else {
        None
    }
}

pub fn probe_font_names_from_directory(file: &mut File, table_directory: &[u8], source_index: usize, diagnostics: &mut Vec<MetadataDiagnostic>) -> io::Result<(Option<FontNameInfo>, bool)> {
    let Some((name_offset, name_length)) = find_table_record(table_directory, b"name") else {
        let directory_complete = table_directory.len() >= 12
            && super::sfnt::is_supported_sfnt_tag(table_directory, 0)
            && 12 + usize::from(read_u16_be(table_directory, 4).unwrap_or(0)) * 16 <= table_directory.len();
        record(diagnostics, "name", if directory_complete { Kind::MissingTable } else { Kind::InvalidStructure },
            Some(source_index), if directory_complete { "name-table-not-found" } else { "table-lookup-unavailable" });
        return Ok((None, false));
    };

    if name_length == 0 || name_length > MAX_NAME_TABLE_BYTES {
        record(diagnostics, "name", if name_length == 0 { Kind::EmptyMetadata } else { Kind::ResourceLimit }, Some(source_index), "name-table-length");
        return Ok((None, name_length > MAX_NAME_TABLE_BYTES));
    }

    let name_table = read_exact_at(file, name_offset, name_length)?;
    if name_table.len() >= 6 && usize::from(read_u16_be(&name_table, 2).unwrap_or(0)) > MAX_NAME_RECORDS {
        record(diagnostics, "name", Kind::ResourceLimit, Some(source_index), "name-record-limit");
        return Ok((None, true));
    }
    if name_table.len() < 6 || 6 + usize::from(read_u16_be(&name_table, 2).unwrap_or(0)) * 12 > name_table.len()
        || usize::from(read_u16_be(&name_table, 4).unwrap_or(0)) > name_table.len() {
        record(diagnostics, "name", Kind::InvalidStructure, Some(source_index), "name-header-bounds");
    }
    let result = parse_name_table(&name_table, source_index);
    if result.is_none() { record(diagnostics, "name", Kind::EmptyMetadata, Some(source_index), "no-decoded-name"); }
    Ok((result, false))
}

