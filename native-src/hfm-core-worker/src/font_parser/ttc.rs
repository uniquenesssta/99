use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use super::sfnt::read_u32_be;

const MAX_TTC_FONTS_TO_PROBE: usize = 8;

pub fn read_exact_at(file: &mut File, offset: u64, length: usize) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; length];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

pub fn font_offsets(file: &mut File) -> io::Result<Vec<u64>> {
    let header = read_exact_at(file, 0, 12)?;
    if &header[0..4] != b"ttcf" {
        return Ok(vec![0]);
    }

    let count = read_u32_be(&header, 8).unwrap_or(0) as usize;
    if count == 0 {
        return Ok(Vec::new());
    }

    let safe_count = count.min(MAX_TTC_FONTS_TO_PROBE);
    let offset_bytes = read_exact_at(file, 12, safe_count * 4)?;
    let mut offsets = Vec::with_capacity(safe_count);
    for index in 0..safe_count {
        if let Some(offset) = read_u32_be(&offset_bytes, index * 4) {
            offsets.push(u64::from(offset));
        }
    }
    Ok(offsets)
}
