mod backup;
mod health;
mod types;

use std::fs;

pub use types::DatabaseMaintenanceCommandConfig;

pub fn run_database_health_check(config: &DatabaseMaintenanceCommandConfig) -> Result<String, String> {
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let input: types::DatabaseHealthCheckPayload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    health::run_database_health_check(input)
}

pub fn run_database_backup(config: &DatabaseMaintenanceCommandConfig) -> Result<String, String> {
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let input: types::DatabaseBackupPayload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    backup::run_database_backup(input)
}
