mod trash;
use std::{fs, io::{self, Read, Seek, SeekFrom}, path::Path, time::{SystemTime, UNIX_EPOCH}};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    path: String,
    availability_root: Option<String>,
    limit_bytes: Option<u64>,
    older_than_ms: Option<f64>,
    dest: Option<String>,
    transfer_path: Option<String>,
    #[serde(default)] recursive: bool,
    #[serde(default)] force: bool,
    #[serde(default)] exclusive: bool,
    #[serde(default)] append: bool,
    kind: Option<String>,
    schema_version: Option<i64>,
    cache_version: Option<i64>,
    script_detection_version: Option<i64>,
    #[serde(default)] repair_corrupt: bool,
    root_path: Option<String>,
    identity: Option<crate::font_resource::activation_identity::Identity>,
}
fn destination(request: &Request) -> io::Result<&str> { request.dest.as_deref().filter(|v|!v.is_empty()).ok_or_else(||io::Error::other("missing destination")) }
fn transfer(request: &Request) -> io::Result<&str> { request.transfer_path.as_deref().filter(|v|!v.is_empty()).ok_or_else(||io::Error::other("missing local transfer file")) }
fn unix_millis(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}
fn unix_nanos_text(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    }
}
fn metadata(value: &fs::Metadata) -> Value {
    let millis = |date: io::Result<SystemTime>| date.ok().map(unix_millis).unwrap_or(0.0);
    json!({"size":value.len(),"mtimeMs":millis(value.modified()),"birthtimeMs":millis(value.created()),"atimeMs":millis(value.accessed()),"isFile":value.is_file(),"isDirectory":value.is_dir(),"isSymbolicLink":value.file_type().is_symlink()})
}
fn execute(request: &Request) -> io::Result<Value> {
    if request.path.is_empty() || request.path.contains('\0') { return Err(io::Error::other("invalid shared path")); }
    let path = Path::new(&request.path);
    match request.operation.as_str() {
        "openFile" => {
            let mut file=fs::OpenOptions::new().read(true).write(true).create(!request.exclusive).create_new(request.exclusive).truncate(!request.append).open(path)?;
            file.sync_all()?;
            Ok(json!(crate::font_resource::activation_identity::identify(&mut file)?))
        },
        "removeOwnedFile" => {
            let expected=request.identity.as_ref().ok_or_else(||io::Error::other("missing owned file identity"))?;
            match crate::font_resource::activation_identity::remove_owned(path,expected) { Ok(_)=>{},Err(error) if error.kind()==io::ErrorKind::NotFound=>{},Err(error)=>return Err(error) }
            Ok(Value::Null)
        },
        "removeStaleLock" => {
            let cutoff=request.older_than_ms.ok_or_else(||io::Error::other("missing lock cutoff"))?;
            if !cutoff.is_finite() || fs::symlink_metadata(path)?.file_type().is_symlink() {return Err(io::Error::other("invalid stale lock target"));}
            let mut options=fs::OpenOptions::new();options.read(true);
            #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(0);}
            let mut file=options.open(path)?;
            let modified=unix_millis(file.metadata()?.modified()?);
            if modified>=cutoff {return Ok(json!(false));}
            let identity=crate::font_resource::activation_identity::identify(&mut file)?;drop(file);
            crate::font_resource::activation_identity::remove_owned(path,&identity)?;
            Ok(json!(true))
        },
        "writeOwnedFile" => {
            let expected=request.identity.as_ref().ok_or_else(||io::Error::other("missing shared lock identity"))?;
            let mut options=fs::OpenOptions::new(); options.read(true).write(true);
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
            let mut file=options.open(path)?;
            if crate::font_resource::activation_identity::identify(&mut file)? != *expected { return Err(io::Error::other("shared lock identity changed")); }
            if !request.append { file.set_len(0)?; file.seek(SeekFrom::Start(0))?; }
            io::copy(&mut fs::File::open(transfer(request)?)?,&mut file)?; file.sync_all()?;
            Ok(json!(crate::font_resource::activation_identity::identify(&mut file)?))
        },
        "stat" => Ok(metadata(&fs::metadata(path)?)),
        "lstat" => {
            let info=fs::symlink_metadata(path)?;let mut value=metadata(&info);
            if info.is_file() {
                let (device,inode)=crate::font_resource::activation_identity::file_id(&fs::File::open(path)?)?;
                value["dev"]=json!(device);value["ino"]=json!(inode);
            }
            Ok(value)
        },
        "link" => { fs::hard_link(path,destination(request)?)?; Ok(Value::Null) },
        "syncFile" => { fs::OpenOptions::new().write(true).open(path)?.sync_all()?; Ok(Value::Null) },
        "access" => { fs::metadata(path)?; Ok(Value::Null) },
        "realpath" => Ok(json!(fs::canonicalize(path)?.to_string_lossy())),
        "treeSnapshot" => {
            let mut rows = serde_json::Map::new();
            let mut pending = vec![path.to_path_buf()];
            while let Some(directory) = pending.pop() {
                for entry in fs::read_dir(directory)? {
                    let entry = entry?;
                    let kind = entry.file_type()?;
                    let full = entry.path();
                    // Cache writes must not generate another root refresh.
                    if entry.file_name() == ".hfm" || entry.file_name() == ".hfm-cache" { continue; }
                    if kind.is_dir() && !kind.is_symlink() { pending.push(full); }
                    else if kind.is_file() {
                        let info = entry.metadata()?;
                        let name = full.strip_prefix(path).map_err(io::Error::other)?.to_string_lossy().into_owned();
                        rows.insert(name, json!([info.len(), unix_nanos_text(info.modified()?)]));
                    }
                    if rows.len() + pending.len() > 200_000 { return Err(io::Error::other("directory snapshot limit exceeded")); }
                }
            }
            Ok(Value::Object(rows))
        },
        "repairRootDatabase" => {
            let missing = match fs::metadata(path) { Ok(_) => false, Err(error) if error.kind()==io::ErrorKind::NotFound => true, Err(error)=>return Err(error) };
            let check = || -> io::Result<Value> {
                let conn = Connection::open(path).map_err(io::Error::other)?;
                match request.kind.as_deref() {
                    Some("root-index") => crate::root_index::initialize_root_index_db(&conn,&crate::root_index::RootIndexApplyConfig {
                        db_path: request.path.clone(), root_path:request.root_path.clone().ok_or_else(||io::Error::other("missing root"))?,storage:"root".into(),input_path:String::new(),
                        schema_version:request.schema_version.ok_or_else(||io::Error::other("missing schema version"))?,cache_version:request.cache_version.ok_or_else(||io::Error::other("missing cache version"))?,script_detection_version:request.script_detection_version.ok_or_else(||io::Error::other("missing script version"))?,
                    }).map_err(io::Error::other)?,
                    Some("preview") => crate::preview_cache::initialize_preview_cache_db(&conn,request.schema_version.ok_or_else(||io::Error::other("missing schema version"))?).map_err(io::Error::other)?,
                    Some("events" | "hash" | "metrics") => { execute(&Request { operation:"initializeRootCache".into(),..request.clone() })?; },
                    _ => return Err(io::Error::other("unknown repair schema")),
                }
                let integrity:String=conn.query_row("PRAGMA quick_check",[],|row|row.get(0)).map_err(io::Error::other)?;
                if integrity != "ok" { return Err(io::Error::new(io::ErrorKind::InvalidData,format!("quick_check: {}",integrity))); }
                let count:i64=if request.kind.as_deref()==Some("root-index") { conn.query_row("SELECT COUNT(*) FROM entries WHERE COALESCE(is_deleted,0)=0 AND status<>'deleted'",[],|row|row.get(0)).map_err(io::Error::other)? } else {0};
                Ok(json!({"entries":count,"repaired":missing}))
            };
            match check() {
                Ok(value)=>Ok(value),
                Err(error)=> {
                    let corruption=error.kind()==io::ErrorKind::InvalidData || error.get_ref().and_then(|error|error.downcast_ref::<rusqlite::Error>()).is_some_and(|error| matches!(error, rusqlite::Error::SqliteFailure(code,_) if matches!(code.code, rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)));
                    if !request.repair_corrupt || !corruption { return Err(error); }
                    let quarantine=Path::new(destination(request)?).join(format!("repair-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_err(io::Error::other)?.as_nanos()));
                    fs::create_dir_all(&quarantine)?;
                    for suffix in ["","-wal","-shm","-journal"] {
                        let source=format!("{}{}",request.path,suffix);
                        let target=quarantine.join(Path::new(&source).file_name().ok_or_else(||io::Error::other("invalid quarantine path"))?);
                        match fs::rename(&source,target) { Ok(_)=>{},Err(error) if error.kind()==io::ErrorKind::NotFound=>{},Err(error)=>return Err(error) }
                    }
                    let mut value=check()?;value["repaired"]=json!(true);value["quarantinePath"]=json!(quarantine);Ok(value)
                }
            }
        },
        "initializeRootCache" => {
            let sql = match request.kind.as_deref() {
                Some("events") => "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type); CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);",
                Some("hash") => "CREATE TABLE IF NOT EXISTS file_hashes (relative_path TEXT PRIMARY KEY,quick_signature TEXT NOT NULL,content_hash TEXT,font_id TEXT,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_file_hashes_font_id ON file_hashes(font_id); CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(content_hash);",
                Some("metrics") => "CREATE TABLE IF NOT EXISTS metric_snapshots (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);",
                _ => return Err(io::Error::other("unknown root cache schema")),
            };
            let root = request.root_path.as_deref().ok_or_else(||io::Error::other("missing cache root"))?;
            let mut conn = Connection::open(path).map_err(io::Error::other)?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(io::Error::other)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(io::Error::other)?;
            tx.execute_batch(sql).map_err(io::Error::other)?;
            for (key,value) in [("schemaVersion","1"),("cacheArchitecture","v1-clean-shared-root"),("rootPath",root)] {
                tx.execute("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,value]).map_err(io::Error::other)?;
            }
            tx.commit().map_err(io::Error::other)?;
            Ok(Value::Null)
        },
        "readdir" => {
            let mut entries = Vec::new();
            for entry in fs::read_dir(path)? {
                let entry = entry?; let kind = entry.file_type()?;
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"isFile":kind.is_file(),"isDirectory":kind.is_dir(),"isSymbolicLink":kind.is_symlink()}));
            }
            Ok(json!(entries))
        },
        "readFile" => {
            if let Some(limit) = request.limit_bytes {
                if limit > 16*1024*1024 { return Err(io::Error::other("invalid read limit")); }
                let mut source=fs::File::open(path)?.take(limit);let mut output=fs::File::create(transfer(request)?)?;io::copy(&mut source,&mut output)?;
            } else { fs::copy(path, transfer(request)?)?; }
            Ok(Value::Null)
        },
        "writeFile" | "appendFile" => {
            let mut source = fs::File::open(transfer(request)?)?;
            let mut output = fs::OpenOptions::new().write(true).create(!request.exclusive).create_new(request.exclusive).append(request.operation=="appendFile").truncate(request.operation=="writeFile").open(path)?;
            io::copy(&mut source, &mut output)?; output.sync_all()?; Ok(Value::Null)
        },
        "mkdir" => { if request.recursive { fs::create_dir_all(path)?; } else { fs::create_dir(path)?; } Ok(Value::Null) },
        "copyFile" => {
            if request.exclusive {
                let mut source = fs::File::open(path)?;
                let mut dest = fs::OpenOptions::new().write(true).create_new(true).open(destination(request)?)?;
                io::copy(&mut source,&mut dest)?; dest.sync_all()?;
            } else { fs::copy(path,destination(request)?)?; }
            Ok(Value::Null)
        },
        "trash" => { trash::recycle(&request.path)?; Ok(Value::Null) },
        "rename" => { fs::rename(path,destination(request)?)?; Ok(Value::Null) },
        "unlink" | "rm" => {
            let result = match fs::symlink_metadata(path) {
                Ok(value) if value.is_dir() && !value.file_type().is_symlink() => if request.recursive { fs::remove_dir_all(path) } else { fs::remove_dir(path) },
                Ok(_) => fs::remove_file(path), Err(error) => Err(error),
            };
            match result { Err(error) if request.force && error.kind()==io::ErrorKind::NotFound => {}, result => result? }
            Ok(Value::Null)
        },
        "sqliteSnapshot" => {
            let target = transfer(request)?;
            if Path::new(target).exists() { return Err(io::Error::other("snapshot destination already exists")); }
            let conn = Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io::Error::other)?;
            conn.execute("VACUUM INTO ?",[target]).map_err(io::Error::other)?;
            Ok(Value::Null)
        },
        _ => Err(io::Error::other("unsupported shared filesystem operation")),
    }
}
pub fn run(input_path: &str) -> Result<String,String> {
    let request: Request = serde_json::from_str(&fs::read_to_string(input_path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let value = match execute(&request) {
        Ok(value) => json!({"ok":true,"operation":request.operation,"value":value}),
        Err(error) => {
            let root_unavailable = error.kind() == io::ErrorKind::NotFound && request.availability_root.as_deref().is_some_and(|root| fs::metadata(root).is_err());
            let kind = if root_unavailable { io::ErrorKind::Other } else { error.kind() };
            let cross_device = error.raw_os_error() == Some(if cfg!(windows) {17} else {18});
            let network_error = error.raw_os_error().is_some_and(|code| if cfg!(windows) { [53,64,67,121,1231,1232,1236,2250].contains(&code) } else { [101,104,107,110,113].contains(&code) });
            let code = if root_unavailable || network_error {"ENETUNREACH"} else if cross_device {"EXDEV"} else { match kind { io::ErrorKind::NotFound=>"ENOENT",io::ErrorKind::AlreadyExists=>"EEXIST",io::ErrorKind::PermissionDenied=>"EACCES",io::ErrorKind::NotADirectory=>"ENOTDIR",io::ErrorKind::IsADirectory=>"EISDIR",_=>"EIO" } };
            json!({"ok":false,"operation":request.operation,"code":code,"message":error.to_string()})
        },
    };
    serde_json::to_string(&value).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("hfm-shared-file-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn request(&self, operation: &str, name: &str, extra: Value) -> Request {
            let mut input = json!({"operation":operation,"path":self.0.join(name)});
            for (key,value) in extra.as_object().unwrap() { input[key] = value.clone(); }
            serde_json::from_value(input).unwrap()
        }
    }
    impl Drop for Directory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn owned_handle_rejects_replaced_lock_and_binary_round_trips() {
        let dir = Directory::new(); let transfer = dir.0.join("input"); fs::write(&transfer,[0,255,128,1]).unwrap();
        let identity = execute(&dir.request("openFile","lock",json!({"exclusive":true}))).unwrap();
        execute(&dir.request("writeOwnedFile","lock",json!({"identity":identity,"transferPath":transfer}))).unwrap();
        assert_eq!(fs::read(dir.0.join("lock")).unwrap(),[0,255,128,1]);
        assert!(execute(&dir.request("openFile","lock",json!({"exclusive":true}))).is_err());
        fs::rename(dir.0.join("lock"),dir.0.join("previous")).unwrap(); fs::write(dir.0.join("lock"),b"replacement").unwrap();
        assert!(execute(&dir.request("writeOwnedFile","lock",json!({"identity":identity,"transferPath":transfer}))).is_err());
        assert_eq!(fs::read(dir.0.join("lock")).unwrap(),b"replacement");
    }
    #[test]
    fn sqlite_snapshot_is_independent_and_schema_initialization_is_idempotent() {
        let dir = Directory::new();
        let request = dir.request("initializeRootCache","events.sqlite",json!({"kind":"events","rootPath":"root"}));
        execute(&request).unwrap(); execute(&request).unwrap();
        let conn = Connection::open(&request.path).unwrap();
        conn.execute("INSERT INTO events(event_type,payload_json,created_at) VALUES ('x','{}','now')",[]).unwrap();
        let target = dir.0.join("snapshot.sqlite");
        execute(&dir.request("sqliteSnapshot","events.sqlite",json!({"transferPath":target}))).unwrap();
        conn.execute("DELETE FROM events",[]).unwrap();
        let snapshot = Connection::open(&target).unwrap();
        assert_eq!(snapshot.query_row("SELECT COUNT(*) FROM events",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert!(execute(&dir.request("sqliteSnapshot","events.sqlite",json!({"transferPath":target}))).is_err());
    }
    #[test]
    fn snapshot_tracks_complete_tree_and_ignores_owned_cache() {
        let dir=Directory::new(); fs::create_dir(dir.0.join("nested")).unwrap(); fs::create_dir(dir.0.join(".hfm-cache")).unwrap();
        fs::write(dir.0.join("nested/font.ttf"),b"font").unwrap(); fs::write(dir.0.join(".hfm-cache/ignored"),b"cache").unwrap();
        let snapshot=execute(&dir.request("treeSnapshot","",json!({}))).unwrap(); assert_eq!(snapshot.as_object().unwrap().len(),1);
        fs::remove_file(dir.0.join("nested/font.ttf")).unwrap();
        assert_eq!(execute(&dir.request("treeSnapshot","",json!({}))).unwrap(),json!({}));
        assert!(execute(&dir.request("treeSnapshot","absent",json!({}))).is_err());
    }
}
