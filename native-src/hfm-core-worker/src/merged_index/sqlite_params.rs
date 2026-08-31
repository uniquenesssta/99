use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::Value;

pub fn json_to_sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(if *flag { 1 } else { 0 }),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else if let Some(float) = number.as_f64() {
                SqlValue::Real(float)
            } else {
                SqlValue::Null
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

pub fn query_string_pairs(conn: &Connection, sql: &str, params: Vec<SqlValue>) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}
