mod commands;
mod mapped_drives;
mod shared_file_io;
mod isolated_lifetime;
mod config;
mod core_scheduler;
mod core_daemon;
mod database_maintenance;
mod family;
mod font_probe;
mod font_resource;
mod font_parser;
mod folders;
mod hash;
mod install_status;
mod json;
mod local_tags;
mod merged_index;
mod mutation_protocol;
mod operation_trace;
mod protocol;
mod preview_cache;
mod preview_render;
mod root_index;
mod scanner;
mod shared_metadata;
mod system_fonts;
mod watcher;

fn main() {
    if let Err(error) = isolated_lifetime::watch_parent() { eprintln!("{}", error); std::process::exit(70); }
    let code = commands::run_from_env();
    if code != 0 {
        std::process::exit(code);
    }
}
