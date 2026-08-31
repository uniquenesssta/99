use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::Connection;

use super::types::{
    DatabaseBackupItemResult,
    DatabaseBackupManifest,
    DatabaseBackupPayload,
    DatabaseBackupResult,
};

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn backup_one_database(item: &super::types::DatabaseMaintenanceFileItem, backup_dir: &Path, busy_timeout_ms: u64) -> DatabaseBackupItemResult {
    let source_path = item.file_path.clone();
    if fs::metadata(&source_path).is_err() {
        return DatabaseBackupItemResult {
            label: item.label.clone(),
            source_path,
            backup_path: None,
            ok: true,
            size_bytes: 0,
            message: "数据库文件不存在，已跳过。".to_string(),
        };
    }

    let backup_path = backup_dir.join(format!("{}.sqlite", item.label));
    let _ = fs::remove_file(&backup_path);

    let backup_path_string = backup_path.to_string_lossy().to_string();
    let backup_result = (|| -> Result<u64, String> {
        let conn = Connection::open(&source_path).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(busy_timeout_ms)).map_err(|error| error.to_string())?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        let sql = format!("VACUUM INTO {};", sqlite_string_literal(&backup_path_string));
        conn.execute_batch(&sql).map_err(|error| error.to_string())?;
        fs::metadata(&backup_path).map(|meta| meta.len()).map_err(|error| error.to_string())
    })();

    match backup_result {
        Ok(size_bytes) => DatabaseBackupItemResult {
            label: item.label.clone(),
            source_path,
            backup_path: Some(backup_path_string),
            ok: true,
            size_bytes,
            message: "已通过 Rust VACUUM INTO 备份。".to_string(),
        },
        Err(message) => {
            let _ = fs::remove_file(&backup_path);
            DatabaseBackupItemResult {
                label: item.label.clone(),
                source_path,
                backup_path: Some(backup_path_string),
                ok: false,
                size_bytes: 0,
                message,
            }
        }
    }
}

fn prune_old_backups(backups_root: &Path, retention_count: usize) -> Result<(), String> {
    fs::create_dir_all(backups_root).map_err(|error| error.to_string())?;
    let mut dirs: Vec<String> = fs::read_dir(backups_root)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.len() >= 11 && name.chars().nth(4) == Some('-') && name.chars().nth(7) == Some('-') && name.chars().nth(10) == Some('_'))
        .collect();
    dirs.sort();
    dirs.reverse();

    for name in dirs.into_iter().skip(retention_count) {
        let path = backups_root.join(name);
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}

pub fn run_database_backup(input: DatabaseBackupPayload) -> Result<String, String> {
    let started_at = Instant::now();
    let backups_root = PathBuf::from(&input.backups_root);
    let backup_dir = backups_root.join(&input.backup_dir_name);
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;

    let mut items = Vec::with_capacity(input.items.len());
    for item in &input.items {
        items.push(backup_one_database(item, &backup_dir, input.busy_timeout_ms));
    }

    let backup_dir_string = backup_dir.to_string_lossy().to_string();
    let ok = items.iter().all(|item| item.ok);
    let result = DatabaseBackupResult {
        ok,
        reason: input.reason.clone(),
        backup_dir: backup_dir_string.clone(),
        items,
        created_at: input.created_at.clone(),
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-database-backup",
    };

    let manifest = DatabaseBackupManifest {
        ok: result.ok,
        reason: &result.reason,
        backup_dir: &result.backup_dir,
        items: &result.items,
        created_at: &result.created_at,
        app: &input.app_name,
        schema_version: input.schema_version,
        data_root: &input.data_root,
        worker_mode: "rust-database-backup",
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(backup_dir.join("backup-manifest.json"), manifest_json).map_err(|error| error.to_string())?;
    let _ = prune_old_backups(&backups_root, input.retention_count);

    serde_json::to_string(&result).map_err(|error| error.to_string())
}
