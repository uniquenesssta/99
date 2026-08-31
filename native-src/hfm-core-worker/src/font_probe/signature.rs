use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use super::types::FontProbeResult;

pub fn probe_font_signature_from_header(header: &[u8; 4]) -> FontProbeResult {
    match header {
        b"OTTO" => FontProbeResult { valid_signature: true, format: "otf".to_string() },
        b"ttcf" => FontProbeResult { valid_signature: true, format: "ttc".to_string() },
        b"true" => FontProbeResult { valid_signature: true, format: "ttf".to_string() },
        b"typ1" => FontProbeResult { valid_signature: true, format: "ttf".to_string() },
        _ => {
            let numeric = u32::from_be_bytes(*header);
            if numeric == 0x0001_0000 {
                FontProbeResult { valid_signature: true, format: "ttf".to_string() }
            } else {
                FontProbeResult::invalid()
            }
        }
    }
}

pub fn probe_font_signature_from_file(file: &mut File) -> FontProbeResult {
    if file.seek(SeekFrom::Start(0)).is_err() {
        return FontProbeResult::invalid();
    }
    let mut header = [0_u8; 4];
    if file.read_exact(&mut header).is_err() {
        return FontProbeResult::invalid();
    }
    probe_font_signature_from_header(&header)
}

