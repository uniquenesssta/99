pub mod file_fingerprint;
pub mod fnv;
pub mod full_hash;

pub use file_fingerprint::quick_file_fingerprint_from_file;
pub use full_hash::full_file_fingerprint_from_file;
