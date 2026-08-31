use crate::font_resource::{
    add_font_resources,
    apply_font_registry,
    delete_font_registry,
    notify_font_change,
    remove_font_resources,
    run_font_activation_files,
    FontResourceCommandConfig,
};

pub fn run_daemon_font_resource_add(config: &FontResourceCommandConfig) -> Result<String, String> {
    add_font_resources(config)
}

pub fn run_daemon_font_resource_remove(config: &FontResourceCommandConfig) -> Result<String, String> {
    remove_font_resources(config)
}

pub fn run_daemon_font_resource_notify(config: &FontResourceCommandConfig) -> Result<String, String> {
    notify_font_change(config)
}

pub fn run_daemon_font_registry_apply(config: &FontResourceCommandConfig) -> Result<String, String> {
    apply_font_registry(config)
}

pub fn run_daemon_font_registry_delete(config: &FontResourceCommandConfig) -> Result<String, String> {
    delete_font_registry(config)
}

pub fn run_daemon_font_activation_files(config: &FontResourceCommandConfig) -> Result<String, String> {
    run_font_activation_files(config)
}
