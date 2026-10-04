mod commands;
mod font_mutation;
#[cfg(windows)]
mod font_registry;
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
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|v| matches!(v.as_str(), "--font-mutation-broker" | "--font-mutation-elevated" | "--font-file-usage")) {
        if args[1] != "--font-mutation-elevated" {
            if let Err(error) = isolated_lifetime::watch_parent() { eprintln!("{error}"); std::process::exit(70); }
        }
        std::process::exit(font_mutation::run(&args));
    }
    if let Err(error) = isolated_lifetime::watch_parent() { eprintln!("{}", error); std::process::exit(70); }
    let code = commands::run_from_env();
    if code != 0 {
        std::process::exit(code);
    }
}
