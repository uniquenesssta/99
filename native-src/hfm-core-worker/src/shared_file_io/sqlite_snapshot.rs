use std::{fs, io::{self, Write}, path::Path};
use rusqlite::{backup::{Backup, StepResult}, Connection, DatabaseName, OpenFlags, Transaction};
use crate::operation_trace::{OperationTrace, SnapshotPhase};
#[cfg(feature = "snapshot-busy-diagnostic")]
use super::snapshot_busy_diagnostic as diagnostic;

pub(super) const SQLITE_HEAP_LIMIT: i64 = 64 * 1024 * 1024;
const MEMORY_IMAGE_LIMIT: u64 = 16 * 1024 * 1024;

// Only the isolated single-command run() owner activates this process-global
// limit. It bounds SQLite heap, including page cache and serialization, not RSS.
pub(super) struct SnapshotBudgetOwner {
    limit: i64,
    previous: Option<(i64, i64)>,
}

impl SnapshotBudgetOwner {
    pub(super) fn new(limit: i64) -> Self { Self { limit, previous: None } }

    fn activate(&mut self) -> io::Result<bool> {
        if self.previous.is_some() { return Err(io::Error::other("snapshot budget already active")); }
        // The pinned bundled build uses the default heap-backed page cache.
        // Do not use this route when memory accounting is demonstrably absent.
        let disabled = unsafe {
            rusqlite::ffi::sqlite3_compileoption_used(b"DEFAULT_MEMSTATUS=0\0".as_ptr().cast()) != 0
        };
        let used = unsafe { rusqlite::ffi::sqlite3_memory_used() };
        let old_hard = unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(-1) };
        let old_soft = unsafe { rusqlite::ffi::sqlite3_soft_heap_limit64(-1) };
        if old_hard < 0 || old_soft < 0 {
            return Err(sqlite_error(rusqlite::ffi::SQLITE_NOMEM, "snapshot budget initialization failed"));
        }
        let effective = if old_hard > 0 { self.limit.min(old_hard) } else { self.limit };
        // Existing allocations cannot be reclaimed by lowering the limit. This
        // route choice precedes memory allocation; no failed copy is retried.
        if disabled || used <= 0 || effective <= used { return Ok(false); }
        let prior = unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(effective) };
        if prior < 0 {
            return Err(sqlite_error(rusqlite::ffi::SQLITE_NOMEM, "snapshot budget activation failed"));
        }
        self.previous = Some((prior, old_soft));
        if prior != old_hard {
            return Err(io::Error::other("snapshot budget owner is not isolated"));
        }
        if unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(-1) } != effective {
            return Err(io::Error::other("snapshot budget was not installed"));
        }
        // sqlite3_hard_heap_limit64 preserves an already tighter soft limit.
        Ok(true)
    }
}

impl Drop for SnapshotBudgetOwner {
    fn drop(&mut self) {
        if let Some((hard, soft)) = self.previous.take() {
            // run() outlives all source/target connections and serialized Data.
            // Restore hard first because setting it can also change soft.
            unsafe {
                rusqlite::ffi::sqlite3_hard_heap_limit64(hard);
                rusqlite::ffi::sqlite3_soft_heap_limit64(soft);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SnapshotRoute { Memory, Disk }
#[derive(Clone, Copy)]
struct SourceSize { page_size: u32, page_count: u64 }
enum SyntheticFailure { Busy, Locked, Integrity }

fn sqlite_error(code: i32, message: &'static str) -> io::Error {
    io::Error::other(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), Some(message.to_owned())))
}

fn phase(trace: Option<&OperationTrace>, value: SnapshotPhase) {
    if let Some(trace) = trace { trace.snapshot_phase(value); }
}

// The source is READ_ONLY. The transport owns this fresh target and its sidecars
// until the physical child has closed.
pub(super) fn reserve_target(target: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // SQLite may read/write the exclusively reserved empty file, but it may
        // not be deleted or replaced between reservation and connection close.
        options.share_mode(0x00000001 | 0x00000002);
    }
    options.open(target)
}

fn source_size(source: &Transaction<'_>) -> rusqlite::Result<SourceSize> {
    // page_count opens the read transaction before page_size is consulted.
    // Keep it through Backup so preselection cannot race growth or VACUUM.
    let page_count = source.query_row("PRAGMA main.page_count", [], |row| row.get::<_, i64>(0))?;
    let page_size = source.query_row("PRAGMA main.page_size", [], |row| row.get::<_, i64>(0))?;
    if page_count < 0 || !(512..=65536).contains(&page_size) || !(page_size as u32).is_power_of_two() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some("snapshot source size is invalid".to_owned()),
        ));
    }
    Ok(SourceSize { page_size: page_size as u32, page_count: page_count as u64 })
}

fn memory_bytes(size: SourceSize, image_limit: u64) -> Option<usize> {
    // Empty sources use Backup's original one-page disk initialization.
    if size.page_count == 0 { return None; }
    let bytes = size.page_count.checked_mul(u64::from(size.page_size))?;
    if bytes > image_limit { return None; }
    usize::try_from(bytes).ok()
}

fn backup_once(source: &Connection, destination: &mut Connection, trace: Option<&OperationTrace>,
               synthetic: &mut Option<SyntheticFailure>) -> io::Result<()> {
    phase(trace, SnapshotPhase::BackupStart);
    let step = (|| {
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::phase("before-new");
        let backup = Backup::new(source, destination)?;
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::phase("before-step");
        let step = backup.step(-1);
        #[cfg(feature = "snapshot-busy-diagnostic")]
        {
            diagnostic::phase("after-step");
            diagnostic::step(&step);
        }
        drop(backup);
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::phase("after-finish");
        step
    })();
    phase(trace, SnapshotPhase::BackupReturned);
    match step.map_err(io::Error::other)? {
        StepResult::Done => Ok(()),
        StepResult::Busy => {
            *synthetic = Some(SyntheticFailure::Busy);
            Err(sqlite_error(rusqlite::ffi::SQLITE_BUSY, "snapshot source is busy"))
        },
        StepResult::Locked => {
            *synthetic = Some(SyntheticFailure::Locked);
            Err(sqlite_error(rusqlite::ffi::SQLITE_LOCKED, "snapshot source is locked"))
        },
        _ => Err(io::Error::other("snapshot copy did not complete")),
    }
}

fn integrity(destination: &Connection, trace: Option<&OperationTrace>,
             synthetic: &mut Option<SyntheticFailure>) -> io::Result<()> {
    phase(trace, SnapshotPhase::IntegrityStart);
    let mut statement = destination.prepare("PRAGMA integrity_check").map_err(io::Error::other)?;
    let mut rows = statement.query([]).map_err(io::Error::other)?;
    let valid = match rows.next().map_err(io::Error::other)? {
        Some(row) => row.get::<_, String>(0).map_err(io::Error::other)? == "ok",
        None => false,
    };
    let unique = rows.next().map_err(io::Error::other)?.is_none();
    phase(trace, SnapshotPhase::IntegrityReturned);
    if !valid || !unique {
        *synthetic = Some(SyntheticFailure::Integrity);
        return Err(sqlite_error(rusqlite::ffi::SQLITE_CORRUPT, "snapshot integrity check failed"));
    }
    Ok(())
}

fn disk_copy(source: Transaction<'_>, target: &Path, trace: Option<&OperationTrace>,
             synthetic: &mut Option<SyntheticFailure>) -> io::Result<()> {
    let mut destination = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(io::Error::other)?;
    #[cfg(feature = "snapshot-busy-diagnostic")]
    diagnostic::install_destination(&destination).map_err(io::Error::other)?;
    phase(trace, SnapshotPhase::TargetOpened);
    let result = (|| {
        let copied = backup_once(&source, &mut destination, trace, synthetic);
        let released = source.commit().map_err(io::Error::other);
        copied?;
        released?;
        integrity(&destination, trace, synthetic)
    })();
    // Preserve the disk path's default journal and synchronous commit behavior.
    let closed = destination.close().map_err(|(_, error)| io::Error::other(error));
    phase(trace, SnapshotPhase::TargetCloseReturned);
    result?;
    closed
}

fn memory_copy(source: Transaction<'_>, size: SourceSize, expected_bytes: usize,
               target: &Path, reserved: &mut fs::File, trace: Option<&OperationTrace>,
               synthetic: &mut Option<SyntheticFailure>) -> io::Result<()> {
    let mut destination = Connection::open_in_memory().map_err(io::Error::other)?;
    #[cfg(feature = "snapshot-busy-diagnostic")]
    diagnostic::install_destination(&destination).map_err(io::Error::other)?;
    phase(trace, SnapshotPhase::TargetOpened);
    let result = (|| {
        destination.pragma_update(None, "page_size", i64::from(size.page_size)).map_err(io::Error::other)?;
        let page_size: u32 = destination.query_row("PRAGMA page_size", [], |row| row.get(0)).map_err(io::Error::other)?;
        let max_pages: u64 = destination.query_row(
            &format!("PRAGMA max_page_count={}", size.page_count), [], |row| row.get(0),
        ).map_err(io::Error::other)?;
        if page_size != size.page_size || max_pages != size.page_count {
            return Err(io::Error::other("snapshot memory page limits were not installed"));
        }
        let copied = backup_once(&source, &mut destination, trace, synthetic);
        let released = source.commit().map_err(io::Error::other);
        copied?;
        released?;
        // Serialization, sequential write_all, sync_all and memory close occur
        // between BackupReturned and IntegrityStart, inside the same deadline.
        let data = destination.serialize(DatabaseName::Main).map_err(io::Error::other)?;
        if data.len() != expected_bytes || data.len() < 100 || &data[..16] != b"SQLite format 3\0" {
            *synthetic = Some(SyntheticFailure::Integrity);
            return Err(sqlite_error(rusqlite::ffi::SQLITE_CORRUPT, "snapshot serialized size or header is invalid"));
        }
        let stored_page_size = u16::from_be_bytes([data[16], data[17]]);
        let stored_page_size = if stored_page_size == 1 { 65536 } else { u32::from(stored_page_size) };
        let stored_pages = u32::from_be_bytes([data[28], data[29], data[30], data[31]]);
        if stored_page_size != size.page_size || u64::from(stored_pages) != size.page_count
            || !matches!((data[18], data[19]), (1, 1) | (2, 2)) {
            *synthetic = Some(SyntheticFailure::Integrity);
            return Err(sqlite_error(rusqlite::ffi::SQLITE_CORRUPT, "snapshot serialized page metadata is invalid"));
        }
        // A completed WAL-source Backup includes committed WAL content but may
        // retain header versions 2/2. Normalize only the owned output header.
        let mut header = [0u8; 100];
        header.copy_from_slice(&data[..100]);
        header[18] = 1;
        header[19] = 1;
        reserved.write_all(&header)?;
        reserved.write_all(&data[100..])?;
        reserved.sync_all()?;
        Ok(())
    })();
    // Data was dropped by the closure. Release the memory database before the
    // actual persisted target's full integrity check; serialization is not proof.
    let closed = destination.close().map_err(|(_, error)| io::Error::other(error));
    if result.is_err() || closed.is_err() {
        phase(trace, SnapshotPhase::TargetCloseReturned);
        result?;
        return closed;
    }
    let check = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(io::Error::other)?;
    let checked = integrity(&check, trace, synthetic);
    let closed = check.close().map_err(|(_, error)| io::Error::other(error));
    phase(trace, SnapshotPhase::TargetCloseReturned);
    checked?;
    closed
}

pub(super) fn copy(source: &Connection, target: &Path, trace: Option<&OperationTrace>,
                   budget: Option<&mut SnapshotBudgetOwner>) -> io::Result<()> {
    copy_with_image_limit(source, target, trace, budget, MEMORY_IMAGE_LIMIT).map(|_| ())
}

// Parent-module contract tests can select a boundary with a small fixture.
// No request, environment variable or production CLI exposes this image limit.
pub(super) fn copy_with_image_limit(source: &Connection, target: &Path, trace: Option<&OperationTrace>,
                                  budget: Option<&mut SnapshotBudgetOwner>, image_limit: u64) -> io::Result<SnapshotRoute> {
    let mut synthetic = None;
    #[cfg(feature = "snapshot-busy-diagnostic")]
    diagnostic::begin();
    let copy_result = (|| {
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::install_source(source).map_err(io::Error::other)?;
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::phase("source-preflight-start");
        let source = source.unchecked_transaction().map_err(io::Error::other)?;
        let size = source_size(&source).map_err(io::Error::other)?;
        #[cfg(feature = "snapshot-busy-diagnostic")]
        diagnostic::phase("source-preflight-returned");
        let mut image_bytes = memory_bytes(size, image_limit);
        if image_bytes.is_some() {
            if let Some(budget) = budget {
                if !budget.activate()? { image_bytes = None; }
            }
        }
        phase(trace, SnapshotPhase::TargetOpenStart);
        let parent = target.parent().ok_or_else(|| io::Error::other("snapshot target parent is unavailable"))?;
        let _directory_pins = super::cleanup::pin_cache_directories(parent, parent)?;
        let mut reserved = reserve_target(target)?;
        let result = match image_bytes {
            Some(bytes) => memory_copy(source, size, bytes, target, &mut reserved, trace, &mut synthetic),
            None => disk_copy(source, target, trace, &mut synthetic),
        };
        result?;
        Ok(if image_bytes.is_some() { SnapshotRoute::Memory } else { SnapshotRoute::Disk })
    })();
    #[cfg(feature = "snapshot-busy-diagnostic")]
    {
        let outcome = synthetic.map(|failure| match failure {
            SyntheticFailure::Busy => diagnostic::SyntheticOutcome::Busy,
            SyntheticFailure::Locked => diagnostic::SyntheticOutcome::Locked,
            SyntheticFailure::Integrity => diagnostic::SyntheticOutcome::Integrity,
        });
        diagnostic::result(&copy_result, outcome);
    }
    copy_result
}
