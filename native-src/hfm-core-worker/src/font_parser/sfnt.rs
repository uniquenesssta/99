pub fn read_u16_be(data: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > data.len() {
        return None;
    }
    Some(u16::from_be_bytes([data[offset], data[offset + 1]]))
}

pub fn read_u32_be(data: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > data.len() {
        return None;
    }
    Some(u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

pub fn is_supported_sfnt_tag(data: &[u8], offset: usize) -> bool {
    if offset + 4 > data.len() {
        return false;
    }
    let tag = &data[offset..offset + 4];
    tag == b"OTTO"
        || tag == b"true"
        || tag == b"typ1"
        || tag == &[0x00, 0x01, 0x00, 0x00]
}

pub fn find_table_record(table_directory: &[u8], tag: &[u8; 4]) -> Option<(u64, usize)> {
    if table_directory.len() < 12 || !is_supported_sfnt_tag(table_directory, 0) {
        return None;
    }

    let num_tables = usize::from(read_u16_be(table_directory, 4)?);
    let needed = 12usize.checked_add(num_tables.checked_mul(16)?)?;
    if needed > table_directory.len() {
        return None;
    }

    for index in 0..num_tables {
        let offset = 12 + index * 16;
        if &table_directory[offset..offset + 4] != tag {
            continue;
        }
        let table_offset = u64::from(read_u32_be(table_directory, offset + 8)?);
        let table_length = usize::try_from(read_u32_be(table_directory, offset + 12)?).ok()?;
        return Some((table_offset, table_length));
    }

    None
}
