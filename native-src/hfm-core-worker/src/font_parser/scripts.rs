use std::collections::BTreeSet;
use std::fs::File;
use std::io;
use super::sfnt::{find_table_record, read_u16_be, read_u32_be};
use super::ttc::read_exact_at;
use super::types::FontScriptInfo;

const MAX_CMAP_TABLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CMAP_ENCODINGS: usize = 64;
const MAX_CMAP_SEGMENTS: usize = 8192;
const MAX_CMAP_GROUPS: usize = 65536;

#[derive(Clone, Copy)]
struct ScriptRange {
    script: &'static str,
    start: u32,
    end: u32,
}

const SCRIPT_RANGES: &[ScriptRange] = &[
    ScriptRange { script: "latin", start: 0x0020, end: 0x007e },
    ScriptRange { script: "latin", start: 0x00a0, end: 0x024f },
    ScriptRange { script: "greek", start: 0x0370, end: 0x03ff },
    ScriptRange { script: "cyrillic", start: 0x0400, end: 0x04ff },
    ScriptRange { script: "hebrew", start: 0x0590, end: 0x05ff },
    ScriptRange { script: "arabic", start: 0x0600, end: 0x06ff },
    ScriptRange { script: "devanagari", start: 0x0900, end: 0x097f },
    ScriptRange { script: "bengali", start: 0x0980, end: 0x09ff },
    ScriptRange { script: "gurmukhi", start: 0x0a00, end: 0x0a7f },
    ScriptRange { script: "gujarati", start: 0x0a80, end: 0x0aff },
    ScriptRange { script: "tamil", start: 0x0b80, end: 0x0bff },
    ScriptRange { script: "telugu", start: 0x0c00, end: 0x0c7f },
    ScriptRange { script: "thai", start: 0x0e00, end: 0x0e7f },
    ScriptRange { script: "lao", start: 0x0e80, end: 0x0eff },
    ScriptRange { script: "myanmar", start: 0x1000, end: 0x109f },
    ScriptRange { script: "ethiopic", start: 0x1200, end: 0x137f },
    ScriptRange { script: "khmer", start: 0x1780, end: 0x17ff },
    ScriptRange { script: "chinese", start: 0x3400, end: 0x4dbf },
    ScriptRange { script: "chinese", start: 0x4e00, end: 0x9fff },
    ScriptRange { script: "chinese", start: 0xf900, end: 0xfaff },
    ScriptRange { script: "japanese", start: 0x3040, end: 0x30ff },
    ScriptRange { script: "japanese", start: 0x31f0, end: 0x31ff },
    ScriptRange { script: "korean", start: 0x1100, end: 0x11ff },
    ScriptRange { script: "korean", start: 0x3130, end: 0x318f },
    ScriptRange { script: "korean", start: 0xac00, end: 0xd7af },
    ScriptRange { script: "symbol", start: 0x2190, end: 0x27bf },
    ScriptRange { script: "symbol", start: 0xe000, end: 0xf8ff },
    ScriptRange { script: "symbol", start: 0x1f000, end: 0x1faff },
    ScriptRange { script: "armenian", start: 0x0530, end: 0x058f },
    ScriptRange { script: "georgian", start: 0x10a0, end: 0x10ff },
];

#[derive(Default)]
struct ScriptAccumulator {
    latin: u64,
    greek: u64,
    cyrillic: u64,
    hebrew: u64,
    arabic: u64,
    devanagari: u64,
    bengali: u64,
    gurmukhi: u64,
    gujarati: u64,
    tamil: u64,
    telugu: u64,
    thai: u64,
    lao: u64,
    myanmar: u64,
    ethiopic: u64,
    khmer: u64,
    chinese: u64,
    japanese: u64,
    korean: u64,
    symbol: u64,
    armenian: u64,
    georgian: u64,
    range_count: usize,
}

impl ScriptAccumulator {
    fn add_range(&mut self, start: u32, end: u32) {
        if start > end {
            return;
        }
        self.range_count = self.range_count.saturating_add(1);
        for script_range in SCRIPT_RANGES {
            let overlap_start = start.max(script_range.start);
            let overlap_end = end.min(script_range.end);
            if overlap_start > overlap_end {
                continue;
            }
            let count = (u64::from(overlap_end).saturating_sub(u64::from(overlap_start)).saturating_add(1)).min(10_000);
            match script_range.script {
                "latin" => self.latin = self.latin.saturating_add(count),
                "greek" => self.greek = self.greek.saturating_add(count),
                "cyrillic" => self.cyrillic = self.cyrillic.saturating_add(count),
                "hebrew" => self.hebrew = self.hebrew.saturating_add(count),
                "arabic" => self.arabic = self.arabic.saturating_add(count),
                "devanagari" => self.devanagari = self.devanagari.saturating_add(count),
                "bengali" => self.bengali = self.bengali.saturating_add(count),
                "gurmukhi" => self.gurmukhi = self.gurmukhi.saturating_add(count),
                "gujarati" => self.gujarati = self.gujarati.saturating_add(count),
                "tamil" => self.tamil = self.tamil.saturating_add(count),
                "telugu" => self.telugu = self.telugu.saturating_add(count),
                "thai" => self.thai = self.thai.saturating_add(count),
                "lao" => self.lao = self.lao.saturating_add(count),
                "myanmar" => self.myanmar = self.myanmar.saturating_add(count),
                "ethiopic" => self.ethiopic = self.ethiopic.saturating_add(count),
                "khmer" => self.khmer = self.khmer.saturating_add(count),
                "chinese" => self.chinese = self.chinese.saturating_add(count),
                "japanese" => self.japanese = self.japanese.saturating_add(count),
                "korean" => self.korean = self.korean.saturating_add(count),
                "symbol" => self.symbol = self.symbol.saturating_add(count),
                "armenian" => self.armenian = self.armenian.saturating_add(count),
                "georgian" => self.georgian = self.georgian.saturating_add(count),
                _ => {}
            }
        }
    }

    fn scripts(&self) -> Vec<String> {
        let mut scripts = BTreeSet::new();
        self.push_if(&mut scripts, "latin", self.latin, 20);
        self.push_if(&mut scripts, "greek", self.greek, 8);
        self.push_if(&mut scripts, "cyrillic", self.cyrillic, 8);
        self.push_if(&mut scripts, "hebrew", self.hebrew, 5);
        self.push_if(&mut scripts, "arabic", self.arabic, 5);
        self.push_if(&mut scripts, "devanagari", self.devanagari, 5);
        self.push_if(&mut scripts, "bengali", self.bengali, 5);
        self.push_if(&mut scripts, "gurmukhi", self.gurmukhi, 5);
        self.push_if(&mut scripts, "gujarati", self.gujarati, 5);
        self.push_if(&mut scripts, "tamil", self.tamil, 5);
        self.push_if(&mut scripts, "telugu", self.telugu, 5);
        self.push_if(&mut scripts, "thai", self.thai, 5);
        self.push_if(&mut scripts, "lao", self.lao, 5);
        self.push_if(&mut scripts, "myanmar", self.myanmar, 5);
        self.push_if(&mut scripts, "ethiopic", self.ethiopic, 5);
        self.push_if(&mut scripts, "khmer", self.khmer, 5);
        self.push_if(&mut scripts, "chinese", self.chinese, 80);
        self.push_if(&mut scripts, "japanese", self.japanese, 12);
        self.push_if(&mut scripts, "korean", self.korean, 80);
        self.push_if(&mut scripts, "symbol", self.symbol, 12);
        self.push_if(&mut scripts, "armenian", self.armenian, 5);
        self.push_if(&mut scripts, "georgian", self.georgian, 5);
        if scripts.is_empty() && self.range_count > 0 {
            scripts.insert("other".to_string());
        }
        scripts.into_iter().collect()
    }

    fn push_if(&self, target: &mut BTreeSet<String>, script: &str, count: u64, threshold: u64) {
        if count >= threshold {
            target.insert(script.to_string());
        }
    }
}

fn parse_format_4(data: &[u8], subtable_offset: usize, acc: &mut ScriptAccumulator) -> bool {
    if subtable_offset + 16 > data.len() {
        return false;
    }
    let length = usize::from(read_u16_be(data, subtable_offset + 2).unwrap_or(0));
    let end = subtable_offset.saturating_add(length);
    if length < 16 || end > data.len() {
        return false;
    }
    let seg_count = usize::from(read_u16_be(data, subtable_offset + 6).unwrap_or(0) / 2).min(MAX_CMAP_SEGMENTS);
    if seg_count == 0 {
        return false;
    }
    let end_codes = subtable_offset + 14;
    let start_codes = end_codes + seg_count * 2 + 2;
    if start_codes + seg_count * 2 > end {
        return false;
    }
    for index in 0..seg_count {
        let range_end = u32::from(read_u16_be(data, end_codes + index * 2).unwrap_or(0));
        let range_start = u32::from(read_u16_be(data, start_codes + index * 2).unwrap_or(0));
        if range_start == 0xffff && range_end == 0xffff {
            continue;
        }
        acc.add_range(range_start, range_end);
    }
    true
}

fn parse_format_12(data: &[u8], subtable_offset: usize, acc: &mut ScriptAccumulator) -> bool {
    if subtable_offset + 16 > data.len() {
        return false;
    }
    let length = usize::try_from(read_u32_be(data, subtable_offset + 4).unwrap_or(0)).unwrap_or(0);
    let end = subtable_offset.saturating_add(length);
    if length < 16 || end > data.len() {
        return false;
    }
    let groups = usize::try_from(read_u32_be(data, subtable_offset + 12).unwrap_or(0)).unwrap_or(0).min(MAX_CMAP_GROUPS);
    let group_start = subtable_offset + 16;
    if group_start + groups * 12 > end {
        return false;
    }
    for index in 0..groups {
        let offset = group_start + index * 12;
        let start_char = read_u32_be(data, offset).unwrap_or(0);
        let end_char = read_u32_be(data, offset + 4).unwrap_or(0);
        acc.add_range(start_char, end_char);
    }
    true
}

fn parse_cmap(data: &[u8], source_index: usize) -> Option<FontScriptInfo> {
    if data.len() < 4 {
        return None;
    }
    let count = usize::from(read_u16_be(data, 2)?).min(MAX_CMAP_ENCODINGS);
    if 4 + count * 8 > data.len() {
        return None;
    }

    let mut offsets: Vec<usize> = Vec::new();
    for index in 0..count {
        let record_offset = 4 + index * 8;
        let subtable_offset = usize::try_from(read_u32_be(data, record_offset + 4)?).ok()?;
        if subtable_offset + 2 <= data.len() && !offsets.contains(&subtable_offset) {
            offsets.push(subtable_offset);
        }
    }

    let mut acc = ScriptAccumulator::default();
    let mut parsed_any = false;

    for subtable_offset in offsets.iter().copied() {
        let format = read_u16_be(data, subtable_offset).unwrap_or(0);
        if format == 12 && parse_format_12(data, subtable_offset, &mut acc) {
            parsed_any = true;
        }
    }
    for subtable_offset in offsets.iter().copied() {
        let format = read_u16_be(data, subtable_offset).unwrap_or(0);
        if format == 4 && parse_format_4(data, subtable_offset, &mut acc) {
            parsed_any = true;
        }
    }

    if !parsed_any {
        return None;
    }
    let scripts = acc.scripts();
    if scripts.is_empty() {
        return None;
    }
    Some(FontScriptInfo {
        scripts,
        range_count: acc.range_count,
        source_index,
    })
}

pub fn probe_font_scripts_from_directory(file: &mut File, table_directory: &[u8], source_index: usize) -> io::Result<Option<FontScriptInfo>> {
    let Some((cmap_offset, cmap_length)) = find_table_record(table_directory, b"cmap") else {
        return Ok(None);
    };

    if cmap_length == 0 || cmap_length > MAX_CMAP_TABLE_BYTES {
        return Ok(None);
    }

    let cmap_table = read_exact_at(file, cmap_offset, cmap_length)?;
    Ok(parse_cmap(&cmap_table, source_index))
}

