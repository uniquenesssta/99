use super::*;

pub(super) fn remove_with_owned_locks(request: &Request, after_pin: impl FnOnce()) -> io::Result<Value> {
    let guards = request.guards.as_ref().filter(|guards| !guards.is_empty())
        .ok_or_else(|| io::Error::other("cache cleanup requires owned locks"))?;
    let targets = request.paths.as_ref().ok_or_else(|| io::Error::other("missing cleanup targets"))?;
    let root = Path::new(request.root_path.as_deref().ok_or_else(|| io::Error::other("missing cache cleanup root"))?);
    let mut directory_pins = pin_cache_directories(root, root)?;
    for guard in guards {
        let parent = Path::new(&guard.path).parent().ok_or_else(|| io::Error::other("invalid cleanup lock path"))?;
        directory_pins.extend(pin_cache_directories(parent, root)?);
    }
    let mut absent_parents = std::collections::HashSet::new();
    for target in targets {
        let parent = Path::new(target).parent().ok_or_else(|| io::Error::other("invalid cache cleanup path"))?;
        if !parent.starts_with(root) { return Err(io::Error::other("cache cleanup path escapes its root")); }
        match pin_cache_directories(parent, root) {
            Ok(pins) => directory_pins.extend(pins),
            // Never re-resolve this unpinned path after validation. A later
            // junction/directory arrival is outside this cleanup snapshot.
            Err(error) if error.kind() == io::ErrorKind::NotFound => { absent_parents.insert(target.clone()); },
            Err(error) => return Err(error),
        }
    }
    let mut pins = Vec::with_capacity(guards.len());
    // All leases stay pinned through the final deletion. A replacement of any
    // lease rejects the whole batch before the first cache file is touched.
    for guard in guards {
        if guard.path.is_empty() || fs::symlink_metadata(&guard.path)?.file_type().is_symlink() {
            return Err(io::Error::other("invalid cache cleanup lock"));
        }
        let mut options = fs::OpenOptions::new(); options.read(true);
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
        let mut pin = options.open(&guard.path)?;
        if crate::font_resource::activation_identity::identify(&mut pin)? != guard.identity {
            return Err(io::Error::other("cache cleanup lease identity changed"));
        }
        pins.push(pin);
    }
    for target in targets {
        if target.is_empty() || target.contains('\0') || guards.iter().any(|guard| guard.path.eq_ignore_ascii_case(target)) {
            return Err(io::Error::other("invalid cache cleanup target"));
        }
    }
    after_pin();
    let mut outcomes = Vec::with_capacity(targets.len());
    for target in targets {
        if absent_parents.contains(target) { outcomes.push(json!({"path":target,"status":"missing"})); continue; }
        match fs::remove_file(target) {
            Ok(()) => outcomes.push(json!({"path":target,"status":"removed"})),
            Err(error) if error.kind() == io::ErrorKind::NotFound => outcomes.push(json!({"path":target,"status":"missing"})),
            Err(error) => outcomes.push(json!({"path":target,"status":"failed","message":error.to_string()})),
        }
    }
    drop(pins);
    Ok(json!(outcomes))
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

pub(super) fn pin_cache_directories(directory: &Path, root: &Path) -> io::Result<Vec<fs::File>> {
    let relative = directory.strip_prefix(root).map_err(|_| io::Error::other("preview directory escapes cache root"))?;
    let mut current = root.to_path_buf();
    let mut paths = vec![current.clone()];
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) { return Err(io::Error::other("invalid preview directory")); }
        current.push(component); paths.push(current.clone());
    }
    let mut pins = Vec::new();
    for path in paths {
        let mut options = fs::OpenOptions::new(); options.read(true);
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(3).custom_flags(0x02000000 | 0x00200000); }
        let pin = options.open(&path)?;
        let metadata = pin.metadata()?;
        if !metadata.is_dir() || is_reparse(&metadata) { return Err(io::Error::other("linked preview cache directory retained")); }
        pins.push(pin);
    }
    Ok(pins)
}

fn validate_preview_schema(connection: &Connection, version: i64) -> io::Result<()> {
    let schema: String = connection.query_row("SELECT value FROM meta WHERE key='schemaVersion'", [], |row| row.get(0)).map_err(io::Error::other)?;
    if schema != version.to_string() { return Err(io::Error::other("preview cache schema is not supported for cleanup")); }
    connection.prepare("SELECT preview_key, output_path, status FROM preview_cache LIMIT 0").map_err(io::Error::other)?;
    Ok(())
}

fn pin_preview_database(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new(); options.read(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(3).custom_flags(0x00200000); }
    let pin = options.open(path)?;
    if !pin.metadata()?.is_file() || is_reparse(&pin.metadata()?) { return Err(io::Error::other("linked preview database retained")); }
    Ok(pin)
}

pub(super) fn preview_rows(request: &Request) -> io::Result<Value> {
    let _pin = pin_preview_database(Path::new(&request.path))?;
    let connection = Connection::open_with_flags(&request.path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io::Error::other)?;
    validate_preview_schema(&connection, request.schema_version.ok_or_else(|| io::Error::other("missing preview schema version"))?)?;
    let mut statement = connection.prepare("SELECT preview_key FROM preview_cache").map_err(io::Error::other)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(io::Error::other)?;
    let keys = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(io::Error::other)?;
    Ok(json!(keys))
}

pub(super) fn preview_entries(request: &Request) -> io::Result<Value> {
    let directory = Path::new(destination(request)?);
    let root = Path::new(request.root_path.as_deref().ok_or_else(|| io::Error::other("missing preview cache root"))?);
    let version = request.schema_version.ok_or_else(|| io::Error::other("missing preview schema version"))?;
    let keys = request.preview_keys.as_ref().filter(|keys| keys.len() <= 32)
        .ok_or_else(|| io::Error::other("invalid preview cleanup batch"))?;
    for key in keys {
        if key.len() != 40 || !key.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err(io::Error::other("invalid preview cleanup key"));
        }
    }
    // Pin configured cache directories without following junctions or symlinks.
    // Parent cache roots must exist; only the owned images directory is created.
    let _root_pin = pin_cache_directories(root, root)?;
    fs::create_dir_all(directory)?;
    let _directory_pins = pin_cache_directories(directory, root)?;
    let database_parent = Path::new(&request.path).parent().ok_or_else(|| io::Error::other("invalid preview database path"))?;
    let database_root = if database_parent.starts_with(root) { root } else { database_parent };
    let _database_directory_pins = match pin_cache_directories(database_parent, database_root) {
        Ok(pins) => pins,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    let database_parent_missing = _database_directory_pins.is_empty();
    let mut outcomes = Vec::new();
    for key in keys {
        let output = directory.join(format!("{key}.png"));
        let lock_path = directory.join(format!("{key}.png.publish.lock"));
        let mut rows_committed = false;
        let result = (|| -> io::Result<()> {
            let mut options = fs::OpenOptions::new(); options.read(true).write(true).create_new(true);
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
            let mut pin = options.open(&lock_path)?;
            let identity = crate::font_resource::activation_identity::identify(&mut pin)?;
            let operation = (|| -> io::Result<()> {
                // Existing publishers use this exact per-key lease. Keep its OS
                // object pinned across the database transaction and all unlinks.
                match if database_parent_missing { Err(io::Error::from(io::ErrorKind::NotFound)) } else { pin_preview_database(Path::new(&request.path)) } {
                    Ok(_database_pin) => {
                        let mut db = Connection::open_with_flags(&request.path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(io::Error::other)?;
                        db.busy_timeout(std::time::Duration::from_millis(1000)).map_err(io::Error::other)?;
                        let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(io::Error::other)?;
                        validate_preview_schema(&transaction, version)?;
                        transaction.execute("DELETE FROM preview_cache WHERE preview_key = ?", [key]).map_err(io::Error::other)?;
                        transaction.commit().map_err(io::Error::other)?;
                        rows_committed = true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                    Err(error) => return Err(error),
                }
                let prefix = format!("{key}.png.");
                let mut files = vec![output.clone()];
                for entry in fs::read_dir(directory)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name == format!("{key}.png.meta.json") || name.starts_with(&format!("{prefix}tmp.")) { files.push(entry.path()); }
                }
                for file in files {
                    match fs::remove_file(file) { Ok(()) => {}, Err(error) if error.kind() == io::ErrorKind::NotFound => {}, Err(error) => return Err(error) }
                }
                Ok(())
            })();
            drop(pin);
            let release = crate::font_resource::activation_identity::remove_owned(&lock_path, &identity);
            // The original failure stays authoritative even if release also fails.
            operation?;
            release?;
            Ok(())
        })();
        match result {
            Ok(()) => outcomes.push(json!({"key":key,"status":"removed","rowsCommitted":rows_committed})),
            Err(error) => outcomes.push(json!({"key":key,"status":"failed","rowsCommitted":rows_committed,"message":error.to_string()})),
        }
    }
    Ok(json!(outcomes))
}
