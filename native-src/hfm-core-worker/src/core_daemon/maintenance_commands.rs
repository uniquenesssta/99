use crate::database_maintenance::{
    run_database_backup,
    run_database_health_check,
    DatabaseMaintenanceCommandConfig,
};
use crate::install_status::{
    save_install_status_index,
    InstallStatusCommandConfig,
};

pub fn run_daemon_install_status_save(config: &InstallStatusCommandConfig) -> Result<String, String> {
    save_install_status_index(config)
}

pub fn run_daemon_database_health_check(config: &DatabaseMaintenanceCommandConfig) -> Result<String, String> {
    run_database_health_check(config)
}

pub fn run_daemon_database_backup(config: &DatabaseMaintenanceCommandConfig) -> Result<String, String> {
    run_database_backup(config)
}
