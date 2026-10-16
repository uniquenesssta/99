//! Bounded, encoding-aware cmap selection. Subtables are alternatives, never unions.
//! https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
use super::diagnostics::{record, MetadataDiagnostic, MetadataDiagnosticKind as Kind};

const MAX_ENCODINGS: usize = 64;
const MAX_SEGMENTS: usize = 8192;
const MAX_GROUPS: usize = 65536;
const MAX_VISITS: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParseDisposition {
    Complete, Missing, Empty, Unsupported, Malformed, ResourceLimit, IoError, NotRequested,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverageKind { Unicode, Symbol, Other }

#[derive(Debug)]
pub struct Coverage {
    pub ranges: Vec<(u32, u32)>,
    pub kind: CoverageKind,
}

type Failure = ParseDisposition;
fn word(d: &[u8], p: usize) -> Result<u16, Failure> { d.get(p..p.checked_add(2).ok_or(Failure::Malformed)?).map(|v| u16::from_be_bytes([v[0], v[1]])).ok_or(Failure::Malformed) }
fn long(d: &[u8], p: usize) -> Result<u32, Failure> { d.get(p..p.checked_add(4).ok_or(Failure::Malformed)?).map(|v| u32::from_be_bytes([v[0], v[1], v[2], v[3]])).ok_or(Failure::Malformed) }
fn size(n: u32) -> Result<usize, Failure> { usize::try_from(n).map_err(|_| Failure::Malformed) }
fn span(base: usize, count: usize, stride: usize) -> Result<usize, Failure> {
    base.checked_add(count.checked_mul(stride).ok_or(Failure::Malformed)?).ok_or(Failure::Malformed)
}
fn budget(left: &mut usize, count: usize) -> Result<(), Failure> {
    *left = left.checked_sub(count).ok_or(Failure::ResourceLimit)?;
    Ok(())
}
fn add(ranges: &mut Vec<(u32, u32)>, start: u32, end: u32) {
    if start > end { return; }
    if let Some(last) = ranges.last_mut() {
        if last.1.checked_add(1) == Some(start) { last.1 = end; return; }
    }
    ranges.push((start, end));
}
fn scalar_range(start: u32, end: u32) -> bool {
    start <= end && end <= 0x10ffff && !(start <= 0xdfff && end >= 0xd800)
}

fn parse_subtable(data: &[u8], format: u16, unicode: bool, left: &mut usize) -> Result<Vec<(u32, u32)>, Failure> {
    let length = match format {
        0 | 4 | 6 => usize::from(word(data, 2)?),
        10 | 12 | 13 => { if word(data, 2)? != 0 { return Err(Failure::Malformed); } size(long(data, 4)?)? },
        _ => return Err(Failure::Unsupported),
    };
    let d = data.get(..length).ok_or(Failure::Malformed)?;
    let mut ranges = Vec::new();
    match format {
        0 => {
            if length != 262 { return Err(Failure::Malformed); }
            budget(left, 256)?;
            for code in 0..256 { if d[6 + code] != 0 { add(&mut ranges, code as u32, code as u32); } }
        }
        6 | 10 => {
            let (base, start, count) = if format == 6 {
                (10, u32::from(word(d, 6)?), usize::from(word(d, 8)?))
            } else { (20, long(d, 12)?, size(long(d, 16)?)?) };
            if span(base, count, 2)? != length { return Err(Failure::Malformed); }
            if count > 0 {
                let end = start.checked_add(u32::try_from(count - 1).map_err(|_| Failure::Malformed)?).ok_or(Failure::Malformed)?;
                if (unicode && !scalar_range(start, end)) || (format == 6 && end > 0xffff) { return Err(Failure::Malformed); }
            }
            budget(left, count)?;
            for i in 0..count { if word(d, base + i * 2)? != 0 { add(&mut ranges, start + i as u32, start + i as u32); } }
        }
        4 => {
            let doubled = word(d, 6)?;
            if doubled == 0 || doubled % 2 != 0 { return Err(Failure::Malformed); }
            let count = usize::from(doubled / 2);
            if count > MAX_SEGMENTS { return Err(Failure::ResourceLimit); }
            let ends = 14;
            let starts = span(16, count, 2)?;
            let deltas = span(starts, count, 2)?;
            let offsets = span(deltas, count, 2)?;
            let glyphs = span(offsets, count, 2)?;
            if glyphs > length || length % 2 != 0 || word(d, 14 + count * 2)? != 0 { return Err(Failure::Malformed); }
            let mut previous = None;
            for i in 0..count {
                let start = u32::from(word(d, starts + i * 2)?);
                let end = u32::from(word(d, ends + i * 2)?);
                if start > end || previous.map_or(false, |p| start <= p) { return Err(Failure::Malformed); }
                previous = Some(end);
                let delta = word(d, deltas + i * 2)?;
                let offset = usize::from(word(d, offsets + i * 2)?);
                if offset % 2 != 0 { return Err(Failure::Malformed); }
                budget(left, (end - start + 1) as usize)?;
                for code in start..=end {
                    let glyph = if offset == 0 { (code as u16).wrapping_add(delta) } else {
                        let address = span(offsets + i * 2, 1, offset)?;
                        let address = span(address, (code - start) as usize, 2)?;
                        if address < glyphs { return Err(Failure::Malformed); }
                        let raw = word(d, address)?;
                        if raw == 0 { 0 } else { raw.wrapping_add(delta) }
                    };
                    if glyph != 0 && code != 0xffff {
                        if unicode && !scalar_range(code, code) { return Err(Failure::Malformed); }
                        add(&mut ranges, code, code);
                    }
                }
            }
            if previous != Some(0xffff) || word(d, starts + (count - 1) * 2)? != 0xffff { return Err(Failure::Malformed); }
        }
        12 | 13 => {
            let count = size(long(d, 12)?)?;
            if count > MAX_GROUPS { return Err(Failure::ResourceLimit); }
            if span(16, count, 12)? != length { return Err(Failure::Malformed); }
            budget(left, count)?;
            let mut previous = None;
            for i in 0..count {
                let p = 16 + i * 12;
                let start = long(d, p)?;
                let end = long(d, p + 4)?;
                let glyph = long(d, p + 8)?;
                if start > end || previous.map_or(false, |p| start <= p) || (unicode && !scalar_range(start, end)) { return Err(Failure::Malformed); }
                previous = Some(end);
                let last_glyph = if format == 12 { glyph.checked_add(end - start).ok_or(Failure::Malformed)? } else { glyph };
                if last_glyph > 0xffff { return Err(Failure::Malformed); }
                if format == 13 { if glyph != 0 { add(&mut ranges, start, end); } }
                else if glyph == 0 { if start < end { add(&mut ranges, start + 1, end); } }
                else { add(&mut ranges, start, end); }
            }
        }
        _ => return Err(Failure::Unsupported),
    }
    Ok(ranges)
}

fn encoding(platform: u16, encoding: u16, format: u16) -> Option<(u8, CoverageKind)> {
    match (platform, encoding, format) {
        (0, 4, 10 | 12) | (3, 10, 10 | 12) => Some((0, CoverageKind::Unicode)),
        (0, 0..=3, 0 | 4 | 6) | (3, 1, 0 | 4 | 6) => Some((1, CoverageKind::Unicode)),
        (0, 6, 13) => Some((2, CoverageKind::Other)),
        (3, 0, 0 | 4 | 6) => Some((3, CoverageKind::Symbol)),
        (1, 0..=32, 0 | 4 | 6) | (2, 0..=2, 0 | 4 | 6) |
        (3, 2..=6, 0 | 4 | 6) | (4, 0..=255, 0 | 4 | 6) => Some((4, CoverageKind::Other)),
        _ => None,
    }
}

pub fn parse(data: &[u8], source_index: usize, diagnostics: &mut Vec<MetadataDiagnostic>) -> Result<Coverage, ParseDisposition> {
    let result = select(data, source_index, diagnostics);
    if let Err(reason) = result.as_ref() { diagnose(*reason, source_index, diagnostics); }
    result
}
fn diagnose(reason: ParseDisposition, source_index: usize, diagnostics: &mut Vec<MetadataDiagnostic>) {
    let kind = match reason {
        Failure::ResourceLimit => Kind::ResourceLimit, Failure::Unsupported => Kind::UnsupportedFormat,
        Failure::Empty => Kind::EmptyMetadata, _ => Kind::InvalidStructure,
    };
    record(diagnostics, "cmap", kind, Some(source_index), "subtable-selection");
}
fn select(data: &[u8], source_index: usize, diagnostics: &mut Vec<MetadataDiagnostic>) -> Result<Coverage, Failure> {
    if word(data, 0)? != 0 { return Err(Failure::Malformed); }
    let count = usize::from(word(data, 2)?);
    let records_end = span(4, count, 8)?;
    if records_end > data.len() { return Err(Failure::Malformed); }
    if count > MAX_ENCODINGS { return Err(Failure::ResourceLimit); }
    let mut candidates = Vec::new();
    let mut failure = if count == 0 { Failure::Empty } else { Failure::Unsupported };
    for i in 0..count {
        let p = 4 + i * 8;
        let offset = size(long(data, p + 4)?)?;
        if offset < records_end || offset.checked_add(2).map_or(true, |end| end > data.len()) {
            failure = Failure::Malformed;
            diagnose(failure, source_index, diagnostics);
            continue;
        }
        let format = word(data, offset)?;
        if let Some((priority, kind)) = encoding(word(data, p)?, word(data, p + 2)?, format) {
            if !candidates.iter().any(|&(_, o, _, k)| o == offset && k == kind) { candidates.push((priority, offset, format, kind)); }
        }
    }
    candidates.sort_by_key(|&(priority, _, format, _)| (priority, match format { 12 | 4 => 0, _ => 1 }));
    let mut left = MAX_VISITS;
    for (_, offset, format, kind) in candidates {
        match parse_subtable(&data[offset..], format, kind == CoverageKind::Unicode || format == 13, &mut left) {
            Ok(ranges) => return Ok(Coverage { ranges, kind }),
            Err(reason) => {
                diagnose(reason, source_index, diagnostics);
                if reason == Failure::ResourceLimit { return Err(reason); }
                failure = reason;
            }
        }
    }
    Err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn w(d: &mut [u8], p: usize, value: u16) { d[p..p + 2].copy_from_slice(&value.to_be_bytes()); }
    fn l(d: &mut [u8], p: usize, value: u32) { d[p..p + 4].copy_from_slice(&value.to_be_bytes()); }
    fn table(records: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut d = vec![0; 4 + records.len() * 8];
        w(&mut d, 2, records.len() as u16);
        for (i, (platform, encoding, sub)) in records.iter().enumerate() {
            let offset = d.len() as u32;
            w(&mut d, 4 + i * 8, *platform); w(&mut d, 6 + i * 8, *encoding);
            l(&mut d, 8 + i * 8, offset); d.extend(sub);
        }
        d
    }
    fn grouped(format: u16, groups: &[(u32, u32, u32)]) -> Vec<u8> {
        let mut d = vec![0; 16 + groups.len() * 12];
        let len = d.len() as u32;
        w(&mut d, 0, format); l(&mut d, 4, len); l(&mut d, 12, groups.len() as u32);
        for (i, (start, end, glyph)) in groups.iter().enumerate() {
            l(&mut d, 16 + i * 12, *start); l(&mut d, 20 + i * 12, *end); l(&mut d, 24 + i * 12, *glyph);
        }
        d
    }
    fn trimmed(format: u16, start: u32, glyphs: &[u16]) -> Vec<u8> {
        let base = if format == 6 { 10 } else { 20 };
        let mut d = vec![0; base + glyphs.len() * 2]; let len = d.len();
        w(&mut d, 0, format);
        if format == 6 { w(&mut d, 2, len as u16); w(&mut d, 6, start as u16); w(&mut d, 8, glyphs.len() as u16); }
        else { l(&mut d, 4, len as u32); l(&mut d, 12, start); l(&mut d, 16, glyphs.len() as u32); }
        for (i, glyph) in glyphs.iter().enumerate() { w(&mut d, base + i * 2, *glyph); }
        d
    }
    fn format4(glyph_array: bool) -> Vec<u8> {
        let mut d = vec![0; if glyph_array { 36 } else { 32 }]; let len = d.len();
        w(&mut d, 0, 4); w(&mut d, 2, len as u16); w(&mut d, 6, 4);
        w(&mut d, 14, 0x42); w(&mut d, 16, 0xffff);
        w(&mut d, 20, 0x41); w(&mut d, 22, 0xffff); w(&mut d, 26, 1);
        if glyph_array { w(&mut d, 28, 4); w(&mut d, 32, 0); w(&mut d, 34, 7); }
        d
    }
    fn parsed(d: &[u8]) -> Result<Coverage, Failure> { parse(d, 0, &mut Vec::new()) }
    #[test]
    fn prefers_one_full_unicode_subtable_without_bmp_union() {
        let d = table(&[(3, 1, format4(false)), (3, 10, grouped(12, &[(0x400, 0x409, 1)]))]);
        assert_eq!(parsed(&d).unwrap().ranges, vec![(0x400, 0x409)]);
    }
    #[test]
    fn malformed_preferred_subtable_falls_back_without_partial_ranges() {
        let d = table(&[(3, 10, grouped(12, &[(0x400, 0x409, 1), (0x500, 0x4ff, 1)])), (3, 1, format4(false))]);
        assert_eq!(parsed(&d).unwrap().ranges, vec![(0x41, 0x42)]);
    }
    #[test]
    fn format4_glyph_array_zero_and_delta_zero_are_not_coverage() {
        assert_eq!(parsed(&table(&[(3, 1, format4(true))])).unwrap().ranges, vec![(0x42, 0x42)]);
        let mut d = format4(false); w(&mut d, 24, 0u16.wrapping_sub(0x41));
        assert_eq!(parsed(&table(&[(3, 1, d)])).unwrap().ranges, vec![(0x42, 0x42)]);
    }
    #[test]
    fn format4_rejects_missing_arrays_odd_count_and_out_of_bounds_glyphs() {
        for mutation in 0..3 {
            let mut d = format4(true);
            match mutation { 0 => { d.truncate(24); w(&mut d, 2, 24); }, 1 => w(&mut d, 6, 3), _ => w(&mut d, 28, 0xfffe) }
            assert_eq!(parsed(&table(&[(3, 1, d)])).unwrap_err(), Failure::Malformed);
        }
    }
    #[test]
    fn grouped_zero_excluded_and_overflow_rejected() {
        assert_eq!(parsed(&table(&[(3, 10, grouped(12, &[(0x41, 0x42, 0)]))])).unwrap().ranges, vec![(0x42, 0x42)]);
        for group in [(0x41, 0x42, u32::MAX), (0x41, 0x42, 0xffff), (0x110000, 0x110000, 1)] {
            assert_eq!(parsed(&table(&[(3, 10, grouped(12, &[group]))])).unwrap_err(), Failure::Malformed);
        }
    }
    #[test]
    fn supported_trimmed_and_byte_formats_exclude_zero() {
        for (format, encoding) in [(6, 3), (10, 4)] {
            let d = table(&[(0, encoding, trimmed(format, 0x41, &[0, 2, 3]))]);
            assert_eq!(parsed(&d).unwrap().ranges, vec![(0x42, 0x43)]);
        }
        let mut d = vec![0; 262]; w(&mut d, 2, 262); d[6 + 0x41] = 1;
        assert_eq!(parsed(&table(&[(0, 0, d)])).unwrap().ranges, vec![(0x41, 0x41)]);
    }
    #[test]
    fn trimmed_lengths_and_character_overflow_rejected() {
        let mut d = trimmed(10, u32::MAX, &[1, 2]);
        assert_eq!(parsed(&table(&[(0, 4, d.clone())])).unwrap_err(), Failure::Malformed);
        l(&mut d, 16, u32::MAX);
        assert_eq!(parsed(&table(&[(0, 4, d)])).unwrap_err(), Failure::Malformed);
        let mut d = trimmed(6, 0x41, &[1]); d.pop();
        assert_eq!(parsed(&table(&[(0, 3, d)])).unwrap_err(), Failure::Malformed);
    }
    #[test]
    fn symbol_and_legacy_are_not_unicode_and_format13_is_other() {
        assert_eq!(parsed(&table(&[(3, 0, format4(false))])).unwrap().kind, CoverageKind::Symbol);
        assert_eq!(parsed(&table(&[(3, 2, format4(false))])).unwrap().kind, CoverageKind::Other);
        assert_eq!(parsed(&table(&[(0, 6, grouped(13, &[(0x41, 0x7a, 1)]))])).unwrap().kind, CoverageKind::Other);
        assert_eq!(parsed(&table(&[(0, 6, grouped(13, &[(0x41, 0x7a, 0)]))])).unwrap().ranges.len(), 0);
        assert_eq!(parsed(&table(&[(3, 10, grouped(13, &[(0x41, 0x7a, 1)]))])).unwrap_err(), Failure::Unsupported);
    }
    #[test]
    fn variation_only_and_unsupported_formats_do_not_produce_coverage() {
        for (encoding, format) in [(5, 14), (3, 2), (4, 8)] {
            let mut d = vec![0; 16]; w(&mut d, 0, format);
            assert_eq!(parsed(&table(&[(0, encoding, d)])).unwrap_err(), Failure::Unsupported);
        }
    }
    #[test]
    fn duplicate_offsets_are_not_union_and_encoding_limit_is_not_clamped() {
        let mut d = table(&[(3, 1, format4(false)), (3, 1, format4(false))]);
        let first = long(&d, 8).unwrap(); l(&mut d, 16, first);
        assert_eq!(parsed(&d).unwrap().ranges, vec![(0x41, 0x42)]);
        let d = table(&vec![(3, 1, format4(false)); MAX_ENCODINGS + 1]);
        assert_eq!(parsed(&d).unwrap_err(), Failure::ResourceLimit);
    }
    #[test]
    fn declared_group_and_segment_limits_are_not_partial_successes() {
        let mut d = grouped(12, &[]); l(&mut d, 12, (MAX_GROUPS + 1) as u32);
        assert_eq!(parsed(&table(&[(3, 10, d)])).unwrap_err(), Failure::ResourceLimit);
        let mut d = format4(false); w(&mut d, 6, ((MAX_SEGMENTS + 1) * 2) as u16);
        assert_eq!(parsed(&table(&[(3, 1, d)])).unwrap_err(), Failure::ResourceLimit);
        assert_eq!(parse_subtable(&format4(false), 4, true, &mut 1).unwrap_err(), Failure::ResourceLimit);
    }
    #[test]
    fn header_offsets_and_truncation_are_bounded() {
        for d in [vec![], vec![0, 0, 0], vec![0, 0, 0, 1]] { assert_eq!(parsed(&d).unwrap_err(), Failure::Malformed); }
        let mut d = table(&[(3, 1, format4(false))]); l(&mut d, 8, u32::MAX);
        assert_eq!(parsed(&d).unwrap_err(), Failure::Malformed);
    }
    #[test]
    fn saturated_diagnostics_do_not_erase_authoritative_failure() {
        let mut diagnostics = Vec::new();
        for _ in 0..32 { diagnose(Failure::Unsupported, 0, &mut diagnostics); }
        assert_eq!(diagnostics.len(), 16);
        assert_eq!(parse(&[0], 0, &mut diagnostics).unwrap_err(), Failure::Malformed);
        assert_eq!(diagnostics.len(), 16);
    }
}
