use std::fs::File;
use std::io;
use super::sfnt::{find_table_record, read_u16_be, read_u32_be};
use super::ttc::read_exact_at;
use super::types::FontStyleInfo;

const MAX_OS2_TABLE_BYTES: usize = 512;
const MAX_HEAD_TABLE_BYTES: usize = 256;
const MAX_POST_TABLE_BYTES: usize = 256;
const MAX_MAXP_TABLE_BYTES: usize = 64;

#[derive(Clone, Debug, Default)]
struct StyleProbeParts {
    weight_class: Option<u16>,
    width_class: Option<u16>,
    fs_selection_italic: bool,
    fs_selection_bold: bool,
    head_mac_style_italic: bool,
    head_mac_style_bold: bool,
    post_italic: bool,
    monospaced: Option<bool>,
    units_per_em: Option<u16>,
    glyph_count: Option<u16>,
}

fn fixed_16_16_is_non_zero(value: u32) -> bool {
    value != 0
}

fn parse_os2_table(parts: &mut StyleProbeParts, data: &[u8]) {
    if data.len() < 8 {
        return;
    }
    let weight = read_u16_be(data, 4).unwrap_or(0);
    let width = read_u16_be(data, 6).unwrap_or(0);
    if (1..=1000).contains(&weight) {
        parts.weight_class = Some(weight);
    }
    if (1..=9).contains(&width) {
        parts.width_class = Some(width);
    }
    if data.len() >= 64 {
        let selection = read_u16_be(data, 62).unwrap_or(0);
        parts.fs_selection_italic = selection & 0x0001 != 0;
        parts.fs_selection_bold = selection & 0x0020 != 0;
    }
}

fn parse_head_table(parts: &mut StyleProbeParts, data: &[u8]) {
    if data.len() >= 20 {
        let units = read_u16_be(data, 18).unwrap_or(0);
        if (16..=16384).contains(&units) {
            parts.units_per_em = Some(units);
        }
    }
    if data.len() >= 46 {
        let mac_style = read_u16_be(data, 44).unwrap_or(0);
        parts.head_mac_style_bold = mac_style & 0x0001 != 0;
        parts.head_mac_style_italic = mac_style & 0x0002 != 0;
    }
}

fn parse_post_table(parts: &mut StyleProbeParts, data: &[u8]) {
    if data.len() >= 8 {
        let italic_angle = read_u32_be(data, 4).unwrap_or(0);
        parts.post_italic = fixed_16_16_is_non_zero(italic_angle);
    }
    if data.len() >= 16 {
        let is_fixed_pitch = read_u32_be(data, 12).unwrap_or(0);
        parts.monospaced = Some(is_fixed_pitch != 0);
    }
}

fn parse_maxp_table(parts: &mut StyleProbeParts, data: &[u8]) {
    if data.len() >= 6 {
        let glyph_count = read_u16_be(data, 4).unwrap_or(0);
        if glyph_count > 0 {
            parts.glyph_count = Some(glyph_count);
        }
    }
}

fn read_table_if_present(file: &mut File, table_directory: &[u8], tag: &[u8; 4], max_len: usize) -> io::Result<Option<Vec<u8>>> {
    let Some((table_offset, table_length)) = find_table_record(table_directory, tag) else {
        return Ok(None);
    };
    if table_length == 0 || table_length > max_len {
        return Ok(None);
    }
    read_exact_at(file, table_offset, table_length).map(Some)
}

pub fn probe_font_style_from_directory(file: &mut File, table_directory: &[u8], source_index: usize) -> io::Result<Option<FontStyleInfo>> {
    let mut parts = StyleProbeParts::default();

    if let Some(os2) = read_table_if_present(file, table_directory, b"OS/2", MAX_OS2_TABLE_BYTES)? {
        parse_os2_table(&mut parts, &os2);
    }
    if let Some(head) = read_table_if_present(file, table_directory, b"head", MAX_HEAD_TABLE_BYTES)? {
        parse_head_table(&mut parts, &head);
    }
    if let Some(post) = read_table_if_present(file, table_directory, b"post", MAX_POST_TABLE_BYTES)? {
        parse_post_table(&mut parts, &post);
    }
    if let Some(maxp) = read_table_if_present(file, table_directory, b"maxp", MAX_MAXP_TABLE_BYTES)? {
        parse_maxp_table(&mut parts, &maxp);
    }

    let bold = parts.fs_selection_bold
        || parts.head_mac_style_bold
        || parts.weight_class.map(|value| value >= 600).unwrap_or(false);
    let italic = parts.fs_selection_italic || parts.head_mac_style_italic || parts.post_italic;
    let info = FontStyleInfo {
        weight_class: parts.weight_class,
        width_class: parts.width_class,
        italic,
        bold,
        monospaced: parts.monospaced,
        units_per_em: parts.units_per_em,
        glyph_count: parts.glyph_count,
        source_index,
    };

    if info.has_any_style() {
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

