use rusqlite::{params, Connection};
use super::catalog::clean_tag_names;
use super::types::{LocalTagsSetPayload, LocalRecoveryMove};
use super::state_machine::normalize_font_path;

pub fn validate_recovery_rows(conn: &Connection, payload: &LocalTagsSetPayload) -> Result<(), String> {
    for row in &payload.rows {
        if let Some(expected) = &row.expected_tag_names {
            let mut stmt = conn.prepare("SELECT DISTINCT tag_name FROM local_font_tags WHERE font_path = ?").map_err(|e| e.to_string())?;
            let tags = stmt.query_map([normalize_font_path(&row.font_path)], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            if clean_tag_names(&tags) != clean_tag_names(expected) {
                return Err("恢复期间本地标签已变化，原关联已保留，请重试。".to_string());
            }
        }
    }
    Ok(())
}

pub fn preserve_recovery_state(conn: &Connection, moves: &[LocalRecoveryMove]) -> Result<(), String> {
    let exists = |name: &str| -> Result<bool, String> {
        conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [name], |r| r.get::<_, i64>(0))
            .map(|n| n > 0).map_err(|e| e.to_string())
    };
    let favorites = exists("local_font_favorites")?;
    let protection = exists("local_font_protection")?;
    for item in moves {
        let from = normalize_font_path(&item.from);
        let to = normalize_font_path(&item.to);
        if from.is_empty() || to.is_empty() || from == to { continue; }
        if favorites {
            conn.execute("INSERT OR IGNORE INTO local_font_favorites(font_id,font_path,favorite)
                SELECT ?,?,favorite FROM local_font_favorites WHERE font_path=?
                AND NOT EXISTS (SELECT 1 FROM local_font_favorites WHERE font_path=?) ORDER BY rowid DESC LIMIT 1", params![format!("local-path:{to}"), &to, &from, &to]).map_err(|e| e.to_string())?;
        }
        if protection {
            conn.execute("INSERT INTO local_font_protection(font_path,protected)
                SELECT ?,protected FROM local_font_protection WHERE font_path=? AND protected=1
                ON CONFLICT(font_path) DO UPDATE SET protected=MAX(protected,excluded.protected)", params![&to, &from]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn pin_recovery_files(payload: &LocalTagsSetPayload) -> Result<Vec<std::fs::File>, String> {
    for source in &payload.recovery_missing_sources {
        match std::fs::metadata(&source.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            _ => return Err("原字体路径已恢复或暂不可访问，未修改关联。".into()),
        }
        if !std::fs::metadata(&source.root_path).map(|m| m.is_dir()).unwrap_or(false) {
            return Err("原字体根目录暂不可访问，未修改关联。".into());
        }
    }
    payload.recovery_files.iter().map(|item| crate::font_mutation::pin_recovery_file(&item.path, &item.physical_path, &item.sha256).map_err(|e| e.to_string())).collect()
}
