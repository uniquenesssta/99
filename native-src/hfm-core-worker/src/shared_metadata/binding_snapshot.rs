//! A source-only read effect: capture pinned DB/WAL bytes, replay committed WAL
//! pages in memory, and let SQLite query the private read-only image. Never open
//! a source SQLite connection (even READ_ONLY may create or update its SHM).
//! Format: https://sqlite.org/fileformat2.html#wal_file_format
//! Memory image: https://sqlite.org/c3ref/deserialize.html
use rusqlite::Connection;

// Bound both source capture and the final image before allocating. An oversized
// or unverifiable source is unavailable, never an authoritative empty snapshot.
const MAX_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;

#[cfg(windows)]
pub(super) fn open(path: &str) -> Result<Connection, String> {
    let (database, wal) = capture::read(path)?;
    open_image(materialize(database, wal.as_deref())?)
}

#[cfg(not(windows))]
pub(super) fn open(_path: &str) -> Result<Connection, String> {
    Err("binding snapshot file pin requires Windows".into())
}

fn be32(bytes: &[u8]) -> u32 { u32::from_be_bytes(bytes[..4].try_into().unwrap()) }
fn page_size(database: &[u8]) -> Result<usize, String> {
    if database.len() < 100 || &database[..16] != b"SQLite format 3\0"
        || !matches!((database[18], database[19]), (1, 1) | (2, 2)) {
        return Err("binding snapshot database header unsupported".into());
    }
    let value = u16::from_be_bytes([database[16], database[17]]) as usize;
    let size = if value == 1 { 65536 } else { value };
    if !(512..=65536).contains(&size) || !size.is_power_of_two() {
        return Err("binding snapshot page size invalid".into());
    }
    Ok(size)
}
fn checksum(bytes: &[u8], big_endian: bool, mut sum: [u32; 2]) -> [u32; 2] {
    for pair in bytes.chunks_exact(8) {
        let word = |bytes: &[u8]| if big_endian { be32(bytes) } else { u32::from_le_bytes(bytes[..4].try_into().unwrap()) };
        sum[0] = sum[0].wrapping_add(word(pair)).wrapping_add(sum[1]);
        sum[1] = sum[1].wrapping_add(word(&pair[4..])).wrapping_add(sum[0]);
    }
    sum
}
fn image_length(pages: u32, size: usize) -> Result<usize, String> {
    (pages as usize).checked_mul(size).filter(|length| *length > 0 && *length <= MAX_SNAPSHOT_BYTES)
        .ok_or_else(|| "binding snapshot committed image exceeds memory limit".into())
}

fn materialize(mut database: Vec<u8>, wal: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let size = page_size(&database)?;
    if database.len() > MAX_SNAPSHOT_BYTES || database.len() % size != 0
        || wal.is_some_and(|value| value.len() > MAX_SNAPSHOT_BYTES.saturating_sub(database.len())) {
        return Err("binding snapshot source size invalid or exceeds memory limit".into());
    }
    if let Some(wal) = wal.filter(|value| !value.is_empty()) {
        if wal.len() < 32 { return Err("binding snapshot WAL header truncated".into()); }
        let magic = be32(wal);
        if !matches!(magic, 0x377f0682 | 0x377f0683) || be32(&wal[4..]) != 3_007_000 || be32(&wal[8..]) as usize != size {
            return Err("binding snapshot WAL header unsupported".into());
        }
        let big_endian = magic == 0x377f0683;
        let mut sum = checksum(&wal[..24], big_endian, [0, 0]);
        if sum != [be32(&wal[24..]), be32(&wal[28..])] { return Err("binding snapshot WAL header checksum invalid".into()); }
        let frame_size = 24 + size;
        let mut committed_end = 32;
        let mut committed_pages = 0;
        let mut offset = 32;
        while offset < wal.len() {
            let remaining = &wal[offset..];
            // A reused WAL may retain frames from an older salt epoch. They are
            // not part of this snapshot and must not be replayed or checksummed.
            if remaining.len() >= 16 && remaining[8..16] != wal[16..24] {
                // Without a verified commit, reset residue is indistinguishable
                // from a damaged first frame. Retain prior counts rather than
                // certify the main image while possibly omitting WAL-only rows.
                if committed_pages == 0 { return Err("binding snapshot WAL salt mismatch before committed frame".into()); }
                break;
            }
            // Fail closed on torn/corrupt current-epoch data. A complete valid
            // uncommitted tail is ignored below, as required by the reader algorithm.
            if remaining.len() < frame_size { return Err("binding snapshot WAL frame truncated".into()); }
            let frame = &remaining[..frame_size];
            let page = be32(frame);
            if page == 0 || page == u32::MAX { return Err("binding snapshot WAL page number invalid".into()); }
            image_length(page, size)?;
            sum = checksum(&frame[..8], big_endian, sum);
            sum = checksum(&frame[24..], big_endian, sum);
            if sum != [be32(&frame[16..]), be32(&frame[20..])] { return Err("binding snapshot WAL frame checksum invalid".into()); }
            offset += frame_size;
            let pages = be32(&frame[4..]);
            if pages != 0 {
                image_length(pages, size)?;
                committed_end = offset;
                committed_pages = pages;
            }
        }
        if committed_pages != 0 {
            let length = image_length(committed_pages, size)?;
            let existing_pages = database.len() / size;
            let mut present = vec![false; committed_pages as usize];
            for item in present.iter_mut().take(existing_pages) { *item = true; }
            database.try_reserve(length.saturating_sub(database.len())).map_err(|_| "binding snapshot image allocation failed")?;
            database.resize(length, 0);
            for frame in wal[32..committed_end].chunks_exact(frame_size) {
                let page = be32(frame) as usize;
                // A later commit may shrink the DB. Earlier frames above that
                // final size are valid history, not pages in the resulting image.
                if page <= committed_pages as usize {
                    let start = (page - 1) * size;
                    database[start..start + size].copy_from_slice(&frame[24..]);
                    present[page - 1] = true;
                }
            }
            if present.contains(&false) { return Err("binding snapshot committed image has missing pages".into()); }
            if page_size(&database)? != size { return Err("binding snapshot committed page size changed".into()); }
        }
    }
    // SQLite deserialize cannot open a WAL-mode image. WAL has already been
    // applied above; changing only these private bytes never modifies the source.
    database[18] = 1;
    database[19] = 1;
    Ok(database)
}

fn open_image(database: Vec<u8>) -> Result<Connection, String> {
    use rusqlite::{serialize::OwnedData, DatabaseName};
    use std::ptr::NonNull;
    let mut conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
    // SQLite recommends padding untrusted serialized images by 20 bytes. The
    // allocation uses SQLite's allocator because OwnedData frees it with SQLite.
    let allocation = database.len().checked_add(20).ok_or("binding snapshot image too large")?;
    let pointer = NonNull::new(unsafe { rusqlite::ffi::sqlite3_malloc64(allocation as u64) }.cast::<u8>())
        .ok_or("binding snapshot SQLite allocation failed")?;
    let data = unsafe {
        std::ptr::copy_nonoverlapping(database.as_ptr(), pointer.as_ptr(), database.len());
        std::ptr::write_bytes(pointer.as_ptr().add(database.len()), 0, 20);
        OwnedData::from_raw_nonnull(pointer, database.len())
    };
    drop(database);
    conn.deserialize(DatabaseName::Main, data, true).map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA query_only=ON;").map_err(|error| error.to_string())?;
    let integrity: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if integrity != "ok" { return Err("binding snapshot image integrity check failed".into()); }
    Ok(conn)
}

#[cfg(windows)]
mod capture {
    use super::MAX_SNAPSHOT_BYTES;
    use std::{fs::{File, OpenOptions}, io::{Read, ErrorKind}, os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle}, path::Path};
    #[link(name = "kernel32")]
    extern "system" { fn GetFinalPathNameByHandleW(file: *mut std::ffi::c_void, path: *mut u16, size: u32, flags: u32) -> u32; }
    fn physical(file: &File) -> Result<String, String> {
        let mut buffer = vec![0u16; 32768];
        let size = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, 0) };
        if size == 0 || size as usize >= buffer.len() { return Err("binding snapshot physical identity unavailable".into()); }
        String::from_utf16(&buffer[..size as usize]).map_err(|_| "binding snapshot physical identity invalid".into())
    }
    fn regular(file: &File) -> Result<(), String> {
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
            return Err("binding snapshot requires an existing regular file".into());
        }
        Ok(())
    }
    fn optional(path: &str) -> Result<Option<File>, String> {
        match OpenOptions::new().read(true).share_mode(1).custom_flags(0x0020_0000).open(path) {
            Ok(file) => {
                regular(&file)?;
                if !physical(&file)?.eq_ignore_ascii_case(path) { return Err("binding snapshot sidecar identity changed".into()); }
                Ok(Some(file))
            },
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("binding snapshot sidecar pin unavailable: {error}")),
        }
    }
    fn bytes(file: &mut File, budget: usize) -> Result<Vec<u8>, String> {
        let length = usize::try_from(file.metadata().map_err(|error| error.to_string())?.len())
            .map_err(|_| "binding snapshot source exceeds memory limit")?;
        if length > budget { return Err("binding snapshot source exceeds memory limit".into()); }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| "binding snapshot source allocation failed")?;
        file.take(length as u64 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() != length { return Err("binding snapshot source changed during capture".into()); }
        Ok(bytes)
    }
    pub(super) struct PinnedSource {
        database: File,
        wal: Option<File>,
        _journal: Option<File>,
        _directory: File,
    }
    impl PinnedSource {
        pub(super) fn read(mut self) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
            let database = bytes(&mut self.database, MAX_SNAPSHOT_BYTES)?;
            let wal = self.wal.as_mut().map(|file| bytes(file, MAX_SNAPSHOT_BYTES - database.len())).transpose()?;
            Ok((database, wal))
        }
    }
    pub(super) fn read(path: &str) -> Result<(Vec<u8>, Option<Vec<u8>>), String> { pin(path)?.read() }
    pub(super) fn pin(path: &str) -> Result<PinnedSource, String> {
        // FILE_SHARE_READ denies both existing/new writable handles and delete
        // handles. In particular an already-open SQLite writer fails admission;
        // a new one cannot create/reset/checkpoint WAL while the DB pin is held.
        let database = OpenOptions::new().read(true).share_mode(1).custom_flags(0x0020_0000).open(path)
            .map_err(|error| format!("binding snapshot read-only pin unavailable: {error}"))?;
        regular(&database)?;
        let canonical = physical(&database)?;
        let parent = Path::new(&canonical).parent().ok_or("binding snapshot database parent missing")?;
        let directory = OpenOptions::new().access_mode(0x8000_0000).share_mode(1).custom_flags(0x0200_0000 | 0x0020_0000).open(parent)
            .map_err(|error| format!("binding snapshot parent pin unavailable: {error}"))?;
        let metadata = directory.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0
            || !physical(&directory)?.eq_ignore_ascii_case(&parent.to_string_lossy())
            || !physical(&database)?.eq_ignore_ascii_case(&canonical) {
            return Err("binding snapshot parent identity changed".into());
        }
        let wal = optional(&format!("{canonical}-wal"))?;
        let mut journal = optional(&format!("{canonical}-journal"))?;
        if let Some(journal) = journal.as_mut() {
            let mut header = [0u8; 8];
            let count = journal.read(&mut header).map_err(|error| error.to_string())?;
            if header[..count].iter().any(|byte| *byte != 0) { return Err("binding snapshot rollback recovery required".into()); }
        }
        // An ancestor may have moved while resolving the optional sidecars.
        // Recheck after the last pathname lookup so ENOENT cannot silently pair
        // the old main handle with a replacement directory's missing WAL.
        if !physical(&database)?.eq_ignore_ascii_case(&canonical)
            || !physical(&directory)?.eq_ignore_ascii_case(&parent.to_string_lossy()) {
            return Err("binding snapshot source identity changed during pin".into());
        }
        // Pins remain alive until BOTH files are captured. SQL never sees any
        // source path, so later mutation or worker cancellation cannot leak writes.
        Ok(PinnedSource { database, wal, _journal: journal, _directory: directory })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::SystemTime};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    const SCHEMA: &str = "CREATE TABLE font_metadata(font_id TEXT PRIMARY KEY,relative_path TEXT,path_key TEXT,tag_names_json TEXT,favorite INTEGER,delete_protected INTEGER,revision INTEGER,updated_at TEXT); INSERT INTO font_metadata VALUES('base','base.ttf','base.ttf','[\"Base\"]',0,0,1,'before');";
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("hfm-binding-memory-{}-{nonce}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn path(&self) -> PathBuf { self.0.join("metadata.sqlite") }
        fn seed(&self, size: usize) -> Connection {
            let conn = Connection::open(self.path()).unwrap();
            conn.execute_batch(&format!("PRAGMA page_size={size}; {SCHEMA} PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")).unwrap();
            conn
        }
        // Freeze a real SQLite main+WAL pair, including uncheckpointed commits.
        // Restoring bytes after connection close models a stopped/crashed writer;
        // no production source is ever changed or force-closed by this helper.
        fn freeze(&self, conn: Connection, keep_shm: bool) {
            let files: Vec<_> = ["", "-wal", "-shm"].into_iter().filter_map(|suffix| {
                let path = PathBuf::from(format!("{}{suffix}", self.path().display()));
                fs::read(&path).ok().map(|bytes| (suffix, path, bytes))
            }).collect();
            drop(conn);
            for (suffix, path, bytes) in files {
                if suffix != "-shm" || keep_shm { fs::write(path, bytes).unwrap(); }
            }
        }
        fn files(&self) -> BTreeMap<String, (Vec<u8>, SystemTime)> {
            fs::read_dir(&self.0).unwrap().map(|entry| {
                let path = entry.unwrap().path();
                (path.file_name().unwrap().to_string_lossy().into_owned(), (fs::read(&path).unwrap(), fs::metadata(&path).unwrap().modified().unwrap()))
            }).collect()
        }
        fn open(&self) -> Result<Connection, String> { super::open(self.path().to_str().unwrap()) }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn rows(conn: &Connection) -> Vec<(String, String, i64)> {
        conn.prepare("SELECT font_id,tag_names_json,revision FROM font_metadata ORDER BY font_id").unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect()
    }
    fn wal_path(path: &Path) -> PathBuf { PathBuf::from(format!("{}-wal", path.display())) }
    fn repair_checksums(wal: &mut [u8], big_endian: bool) {
        wal[..4].copy_from_slice(&(if big_endian { 0x377f0683u32 } else { 0x377f0682u32 }).to_be_bytes());
        let mut sum = checksum(&wal[..24], big_endian, [0, 0]);
        wal[24..28].copy_from_slice(&sum[0].to_be_bytes()); wal[28..32].copy_from_slice(&sum[1].to_be_bytes());
        let size = be32(&wal[8..]) as usize;
        for frame in wal[32..].chunks_exact_mut(24 + size) {
            sum = checksum(&frame[..8], big_endian, sum); sum = checksum(&frame[24..], big_endian, sum);
            frame[16..20].copy_from_slice(&sum[0].to_be_bytes()); frame[20..24].copy_from_slice(&sum[1].to_be_bytes());
        }
    }
    #[test]
    fn real_wal_commits_deletes_and_schema_match_sqlite_without_source_writes() {
        for size in [512, 4096, 65536] {
            for keep_shm in [false, true] {
                let fixture = Fixture::new(); let conn = fixture.seed(size);
                conn.execute_batch("INSERT INTO font_metadata VALUES('wal-only','wal.ttf','wal.ttf','[\"WAL\"]',1,1,2,'wal'); UPDATE font_metadata SET revision=3 WHERE font_id='wal-only'; DELETE FROM font_metadata WHERE font_id='base'; CREATE TABLE committed_schema(value TEXT); INSERT INTO committed_schema VALUES('visible');").unwrap();
                let expected = rows(&conn);
                // The latest row is absent in the source main file alone.
                let main = fs::read(fixture.path()).unwrap();
                assert_eq!(rows(&open_image(materialize(main, None).unwrap()).unwrap())[0].0, "base");
                fixture.freeze(conn, keep_shm);
                assert_eq!(fixture.0.join("metadata.sqlite-shm").exists(), keep_shm);
                let before = fixture.files();
                let snapshot = fixture.open().unwrap();
                assert_eq!(rows(&snapshot), expected);
                assert_eq!(snapshot.query_row("SELECT value FROM committed_schema", [], |row| row.get::<_, String>(0)).unwrap(), "visible");
                assert!(snapshot.execute_batch("DELETE FROM font_metadata").is_err(), "memory snapshot is writable");
                drop(snapshot);
                assert_eq!(fixture.files(), before, "snapshot changed source names, bytes or mtimes");
            }
        }
    }
    #[test]
    fn checkpointed_wal_header_with_absent_or_empty_wal_is_read_without_sidecars() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096);
        let expected = rows(&conn); drop(conn);
        assert_eq!(&fs::read(fixture.path()).unwrap()[18..20], &[2, 2]);
        assert!(!wal_path(&fixture.path()).exists());
        let before = fixture.files(); assert_eq!(rows(&fixture.open().unwrap()), expected); assert_eq!(fixture.files(), before);
        fs::write(wal_path(&fixture.path()), b"").unwrap();
        let before = fixture.files(); assert_eq!(rows(&fixture.open().unwrap()), expected); assert_eq!(fixture.files(), before);
        assert!(!fixture.0.join("metadata.sqlite-shm").exists());
    }
    #[test]
    fn valid_uncommitted_tail_is_ignored_and_snapshot_survives_later_source_change() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096);
        conn.execute_batch("UPDATE font_metadata SET tag_names_json='[\"Committed\"]',revision=2;").unwrap();
        let expected = rows(&conn); let committed_length = fs::metadata(wal_path(&fixture.path())).unwrap().len();
        conn.execute_batch("BEGIN; UPDATE font_metadata SET tag_names_json='[\"Uncommitted\"]',revision=3;").unwrap();
        conn.cache_flush().unwrap();
        assert!(fs::metadata(wal_path(&fixture.path())).unwrap().len() > committed_length, "test did not spill an uncommitted WAL frame");
        fixture.freeze(conn, false); let before = fixture.files(); let snapshot = fixture.open().unwrap();
        assert_eq!(rows(&snapshot), expected); assert_eq!(fixture.files(), before);
        // Captured image has no ongoing path dependency or source handle.
        fs::remove_file(wal_path(&fixture.path())).unwrap(); fs::write(fixture.path(), b"replacement").unwrap();
        assert_eq!(rows(&snapshot), expected);
    }
    #[test]
    fn wal_endian_and_old_salt_tail_follow_reader_algorithm() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096);
        conn.execute_batch("UPDATE font_metadata SET tag_names_json='[\"Latest\"]',revision=2").unwrap();
        let expected = rows(&conn); fixture.freeze(conn, false);
        let database = fs::read(fixture.path()).unwrap(); let original = fs::read(wal_path(&fixture.path())).unwrap();
        for big_endian in [false, true] {
            let mut wal = original.clone(); repair_checksums(&mut wal, big_endian);
            assert_eq!(rows(&open_image(materialize(database.clone(), Some(&wal)).unwrap()).unwrap()), expected);
            let frame_size = 24 + be32(&wal[8..]) as usize;
            let mut old_frame = wal[wal.len() - frame_size..].to_vec(); old_frame[8] ^= 1;
            wal.extend(old_frame);
            assert_eq!(rows(&open_image(materialize(database.clone(), Some(&wal)).unwrap()).unwrap()), expected);
        }
    }
    #[test]
    fn no_commit_wal_uses_base_and_vacuum_truncates_to_committed_size() {
        let fixture = Fixture::new(); let conn = fixture.seed(512);
        let expected = rows(&conn);
        conn.execute_batch("BEGIN; UPDATE font_metadata SET revision=50;").unwrap(); conn.cache_flush().unwrap();
        let uncommitted = fs::read(wal_path(&fixture.path())).unwrap();
        assert!(uncommitted.len() > 32);
        assert!(uncommitted[32..].chunks_exact(24 + 512).all(|frame| be32(&frame[4..]) == 0));
        fixture.freeze(conn, false);
        assert_eq!(rows(&fixture.open().unwrap()), expected);
        let fixture = Fixture::new(); let conn = fixture.seed(512);
        conn.execute_batch("CREATE TABLE large(value BLOB); INSERT INTO large WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<80) SELECT zeroblob(2048) FROM n; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        let base_size = fs::metadata(fixture.path()).unwrap().len();
        conn.execute_batch("DROP TABLE large; VACUUM; UPDATE font_metadata SET revision=9;").unwrap();
        let expected = rows(&conn); let pages: usize = conn.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        fixture.freeze(conn, false);
        let image = materialize(fs::read(fixture.path()).unwrap(), Some(&fs::read(wal_path(&fixture.path())).unwrap())).unwrap();
        assert_eq!(image.len(), pages * 512); assert!(image.len() < base_size as usize);
        assert_eq!(rows(&open_image(image).unwrap()), expected);
    }
    #[test]
    fn malformed_wal_and_oversized_or_missing_pages_are_unavailable() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096);
        conn.execute_batch("UPDATE font_metadata SET revision=2").unwrap(); fixture.freeze(conn, false);
        let database = fs::read(fixture.path()).unwrap(); let wal = fs::read(wal_path(&fixture.path())).unwrap();
        for at in [0, 4, 8, 24, 32 + 8, 32 + 12, 32 + 16, 32 + 24] {
            let mut bad = wal.clone(); bad[at] ^= 1;
            assert!(materialize(database.clone(), Some(&bad)).is_err(), "corruption at {at} was accepted");
        }
        for length in [1, 31, wal.len() - 1] {
            assert!(materialize(database.clone(), Some(&wal[..length])).is_err(), "truncated WAL accepted");
        }
        let frame_size = 24 + 4096; let last = wal.len() - frame_size;
        for count in [u32::MAX, MAX_SNAPSHOT_BYTES as u32 / 4096 + 1, 100] {
            let mut bad = wal.clone(); bad[last + 4..last + 8].copy_from_slice(&count.to_be_bytes()); repair_checksums(&mut bad, false);
            assert!(materialize(database.clone(), Some(&bad)).is_err(), "invalid committed size {count} was accepted");
        }
        let file = fs::OpenOptions::new().write(true).open(fixture.path()).unwrap(); file.set_len(MAX_SNAPSHOT_BYTES as u64 + 1).unwrap(); drop(file);
        assert!(fixture.open().unwrap_err().contains("memory limit"));
    }
    #[test]
    fn source_pins_reject_writers_replacement_and_hot_journal_without_writes() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096);
        conn.execute_batch("UPDATE font_metadata SET revision=2").unwrap();
        let before = fixture.files(); assert!(fixture.open().unwrap_err().contains("pin unavailable")); assert_eq!(fixture.files(), before);
        fixture.freeze(conn, false); let before = fixture.files();
        let pinned = capture::pin(fixture.path().to_str().unwrap()).unwrap();
        assert!(fs::OpenOptions::new().write(true).open(fixture.path()).is_err());
        assert!(fs::OpenOptions::new().write(true).open(wal_path(&fixture.path())).is_err());
        assert!(fs::rename(fixture.path(), fixture.0.join("replaced.sqlite")).is_err());
        assert!(fs::rename(wal_path(&fixture.path()), fixture.0.join("replaced.wal")).is_err());
        assert!(fs::rename(&fixture.0, fixture.0.with_extension("replaced")).is_err());
        let (database, wal) = pinned.read().unwrap();
        assert_eq!(rows(&open_image(materialize(database, wal.as_deref()).unwrap()).unwrap())[0].2, 2);
        // Denial came from the capture lifetime, not fixture ACLs.
        drop(fs::OpenOptions::new().write(true).open(fixture.path()).unwrap());
        drop(fs::OpenOptions::new().write(true).open(wal_path(&fixture.path())).unwrap());
        assert_eq!(fixture.files(), before);
        let journal = PathBuf::from(format!("{}-journal", fixture.path().display()));
        fs::write(&journal, [0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7]).unwrap(); let before = fixture.files();
        assert!(fixture.open().unwrap_err().contains("rollback recovery required")); assert_eq!(fixture.files(), before);
    }
    #[test]
    fn ancestor_move_cannot_detach_a_pinned_wal_from_its_main_database() {
        let outer = Fixture::new(); let ancestor = outer.0.join("ancestor");
        let source = ancestor.join("source"); fs::create_dir_all(&source).unwrap(); let fixture = Fixture(source);
        let conn = fixture.seed(4096); conn.execute_batch("UPDATE font_metadata SET revision=15").unwrap();
        fixture.freeze(conn, false); let before = fixture.files();
        let pinned = capture::pin(fixture.path().to_str().unwrap()).unwrap();
        let moved = outer.0.join("moved"); let renamed = fs::rename(&ancestor, &moved).is_ok();
        let (database, wal) = pinned.read().unwrap();
        // Filesystem may deny the ancestor rename. If it permits it, captured
        // handles must still supply the WAL-only commit, never main-file revision1.
        assert_eq!(rows(&open_image(materialize(database, wal.as_deref()).unwrap()).unwrap())[0].2, 15);
        if renamed { fs::rename(&moved, &ancestor).unwrap(); }
        assert_eq!(fixture.files(), before);
    }
    #[test]
    fn canonical_parent_pin_survives_lexical_junction_swap() {
        let fixture = Fixture::new(); let conn = fixture.seed(4096); fixture.freeze(conn, false);
        let outer = Fixture::new(); let junction = outer.0.join("alias");
        let status = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&fixture.0).status().unwrap(); assert!(status.success());
        let pinned = capture::pin(junction.join("metadata.sqlite").to_str().unwrap()).unwrap();
        fs::remove_dir(&junction).unwrap();
        let replacement = outer.0.join("replacement"); fs::create_dir(&replacement).unwrap();
        let status = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&replacement).status().unwrap(); assert!(status.success());
        let (database, wal) = pinned.read().unwrap();
        assert_eq!(rows(&open_image(materialize(database, wal.as_deref()).unwrap()).unwrap())[0].0, "base");
        assert_eq!(fs::read_dir(&replacement).unwrap().count(), 0);
        fs::remove_dir(junction).unwrap();
    }
}
