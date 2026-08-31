use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use super::fnv::Fnv1a64;

const FULL_HASH_BUFFER_BYTES: usize = 256 * 1024;

pub fn full_file_fingerprint_from_file(file: &mut File, file_size: u64) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Fnv1a64::new();
    hash.update(&file_size.to_le_bytes());

    let mut buffer = vec![0_u8; FULL_HASH_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }

    Ok(hash.finish_hex())
}

