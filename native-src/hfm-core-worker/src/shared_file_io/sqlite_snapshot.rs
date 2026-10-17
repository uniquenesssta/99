use std::{fs, io, path::Path};
use rusqlite::{backup::{Backup, StepResult}, Connection, OpenFlags};
use crate::operation_trace::{OperationTrace, SnapshotPhase};

fn sqlite_error(code: i32, message: &'static str) -> io::Error {
    io::Error::other(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), Some(message.to_owned())))
}

// The source is opened READ_ONLY by the command owner. The transport owns this
// fresh target and its sidecars until the physical child has closed. Copy pages
// once rather than rebuilding every table/index with VACUUM on a read path.
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

pub(super) fn copy(source: &Connection, target: &Path, trace: Option<&OperationTrace>) -> io::Result<()> {
    let phase = |value| { if let Some(trace) = trace { trace.snapshot_phase(value); } };
    phase(SnapshotPhase::TargetOpenStart);
    let parent = target.parent().ok_or_else(|| io::Error::other("snapshot target parent is unavailable"))?;
    // Reuse the cleanup owner's existing no-delete, non-reparse directory pin
    // during the write. Transport identity checks bound the directory lifetime.
    let _directory_pins = super::cleanup::pin_cache_directories(parent, parent)?;
    let reserved = reserve_target(target)?;
    let mut destination = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(io::Error::other)?;
    phase(SnapshotPhase::TargetOpened);
    let result = (|| {
        phase(SnapshotPhase::BackupStart);
        let step = (|| {
            let backup = Backup::new(source, &mut destination)?;
            backup.step(-1)
        })();
        phase(SnapshotPhase::BackupReturned);
        // Drop calls sqlite3_backup_finish, rolling back any incomplete copy.
        // Busy/Locked are not success, and this command never retries a step.
        match step.map_err(io::Error::other)? {
            StepResult::Done => {},
            StepResult::Busy => return Err(sqlite_error(rusqlite::ffi::SQLITE_BUSY, "snapshot source is busy")),
            StepResult::Locked => return Err(sqlite_error(rusqlite::ffi::SQLITE_LOCKED, "snapshot source is locked")),
            _ => return Err(io::Error::other("snapshot copy did not complete")),
        }
        // A page copy alone can preserve corrupt B-trees that VACUUM rejected.
        // Validate the complete target before publishing its path, under the
        // same external execution deadline and with the same corruption code.
        phase(SnapshotPhase::IntegrityStart);
        let mut statement = destination.prepare("PRAGMA integrity_check").map_err(io::Error::other)?;
        let mut rows = statement.query([]).map_err(io::Error::other)?;
        let valid = match rows.next().map_err(io::Error::other)? {
            Some(row) => row.get::<_, String>(0).map_err(io::Error::other)? == "ok",
            None => false,
        };
        let unique = rows.next().map_err(io::Error::other)?.is_none();
        phase(SnapshotPhase::IntegrityReturned);
        if !valid || !unique {
            return Err(sqlite_error(rusqlite::ffi::SQLITE_CORRUPT, "snapshot integrity check failed"));
        }
        Ok(())
    })();
    // Keep SQLite's default rollback journal and synchronous commit behavior.
    // Never return a live destination handle or a partially copied database.
    let closed = destination.close().map_err(|(_, error)| io::Error::other(error));
    drop(reserved);
    phase(SnapshotPhase::TargetCloseReturned);
    result?;
    closed
}
