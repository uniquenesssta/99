pub fn decode_name_string(platform_id: u16, _encoding_id: u16, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let decoded = if platform_id == 0 || platform_id == 3 {
        decode_utf16_be(bytes)
    } else if platform_id == 1 {
        decode_mac_roman_ascii(bytes)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };

    clean_name(decoded)
}

fn decode_utf16_be(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        units.push(u16::from_be_bytes([bytes[index], bytes[index + 1]]));
        index += 2;
    }
    String::from_utf16_lossy(&units)
}

fn decode_mac_roman_ascii(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len());
    for &byte in bytes {
        if byte == 0 {
            continue;
        }
        if byte < 0x80 {
            output.push(byte as char);
        } else {
            output.push('�');
        }
    }
    output
}

fn clean_name(value: String) -> Option<String> {
    let cleaned = value
        .replace('\u{0000}', "")
        .replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
