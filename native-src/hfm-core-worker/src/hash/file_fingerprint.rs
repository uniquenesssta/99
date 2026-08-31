use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use super::fnv::Fnv1a64;

const EDGE_SAMPLE_BYTES: usize = 64 * 1024;

pub fn quick_file_fingerprint_from_file(file: &mut File, file_size: u64) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Fnv1a64::new();
    hash.update(&file_size.to_le_bytes());

    let first_len = usize::try_from(file_size.min(EDGE_SAMPLE_BYTES as u64)).unwrap_or(0);
    if first_len > 0 {
        let mut first = vec![0_u8; first_len];
        file.read_exact(&mut first)?;
        hash.update(&first);
    }

    if file_size > EDGE_SAMPLE_BYTES as u64 {
        let tail_start = file_size.saturating_sub(EDGE_SAMPLE_BYTES as u64);
        file.seek(SeekFrom::Start(tail_start))?;
        let mut tail = vec![0_u8; EDGE_SAMPLE_BYTES];
        let read = file.read(&mut tail)?;
        hash.update(&tail[..read]);
    }

    Ok(hash.finish_hex())
}

