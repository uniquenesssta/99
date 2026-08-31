use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::config::{parse_args, usage, Command, ListFontFilesConfig};
use crate::core_scheduler::read_core_scheduler_profile;
use crate::database_maintenance::{run_database_backup, run_database_health_check};
use crate::font_resource::{add_font_resources, apply_font_registry, delete_font_registry, notify_font_change, remove_font_resources, run_font_activation_files};
use crate::json::escape_json;
use crate::install_status::{compare_install_status, read_install_status_index, save_install_status_index};
use crate::local_tags::{delete_local_tag_state_machine, read_local_tags_state_machine, set_local_tags_state_machine};
use crate::merged_index::{query_merged_index_ids, query_merged_index_metrics, query_merged_index_page, rebuild_merged_index, sync_merged_index};
use crate::protocol::{print_error, print_handshake};
use crate::preview_cache::{apply_preview_cache_rows, delete_preview_cache_rows, query_preview_cache_status, read_preview_cache_status, touch_preview_cache_rows, query_preview_cache_batch, run_preview_cache_maintenance};
use crate::preview_render::render_preview_image;
use crate::root_index::apply_root_index_changes;
use crate::shared_metadata::{apply_shared_metadata, read_shared_metadata_known_tags, read_shared_metadata_overlay, read_shared_metadata_signature, remove_shared_metadata_tag};
use crate::scanner::{list_font_files, result_to_json};
use crate::scanner::parse_batch::parse_font_batch;
use crate::system_fonts::read_system_installed_fonts;
use crate::watcher::{run_watcher_preflight, watcher_preflight_to_json};
use crate::folders::list_physical_folder_tree;

pub fn run_from_env() -> i32 {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|arg| arg == "--core-daemon") {
        return crate::core_daemon::run_core_daemon_stdio();
    }

    let code = match parse_args(&args) {
        Command::Handshake => {
            print_handshake();
            0
        }
        Command::CoreSchedulerProfile(Ok(config)) => print_core_scheduler_profile(config),
        Command::CoreSchedulerProfile(Err(message)) => {
            print_error(&message);
            2
        }
        Command::ListFontFiles(Ok(config)) => print_font_file_list(config),
        Command::FontParseBatch(Ok(config)) => print_font_parse_batch(config),
        Command::FontParseBatch(Err(message)) => {
            print_error(&message);
            2
        }
        Command::RootIndexApplyChanges(Ok(config)) => print_root_index_apply_changes(config),
        Command::InstallStatusRead(Ok(config)) => print_install_status_read(config),
        Command::InstallStatusRead(Err(message)) => {
            print_error(&message);
            2
        }
        Command::InstallStatusSave(Ok(config)) => print_install_status_save(config),
        Command::InstallStatusSave(Err(message)) => {
            print_error(&message);
            2
        }
        Command::InstallStatusCompare(Ok(config)) => print_install_status_compare(config),
        Command::InstallStatusCompare(Err(message)) => {
            print_error(&message);
            2
        }
        Command::LocalTagsSet(Ok(config)) => print_local_tags_set(config),
        Command::LocalTagsSet(Err(message)) => {
            print_error(&message);
            2
        }
        Command::LocalTagsRead(Ok(config)) => print_local_tags_read(config),
        Command::LocalTagsRead(Err(message)) => {
            print_error(&message);
            2
        }
        Command::LocalTagsDeleteTag(Ok(config)) => print_local_tags_delete_tag(config),
        Command::LocalTagsDeleteTag(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SharedMetadataApply(Ok(config)) => print_shared_metadata_apply(config),
        Command::SharedMetadataApply(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SharedMetadataRemoveTag(Ok(config)) => print_shared_metadata_remove_tag(config),
        Command::SharedMetadataRemoveTag(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SharedMetadataKnownTags(Ok(config)) => print_shared_metadata_known_tags(config),
        Command::SharedMetadataKnownTags(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SharedMetadataOverlayRead(Ok(config)) => print_shared_metadata_overlay_read(config),
        Command::SharedMetadataOverlayRead(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SharedMetadataSignature(Ok(config)) => print_shared_metadata_signature(config),
        Command::SharedMetadataSignature(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheReadStatus(Ok(config)) => print_preview_cache_read_status(config),
        Command::PreviewCacheReadStatus(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheApply(Ok(config)) => print_preview_cache_apply(config),
        Command::PreviewCacheApply(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheDelete(Ok(config)) => print_preview_cache_delete(config),
        Command::PreviewCacheDelete(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheQuery(Ok(config)) => print_preview_cache_query(config),
        Command::PreviewCacheQuery(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheTouch(Ok(config)) => print_preview_cache_touch(config),
        Command::PreviewCacheTouch(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheBatch(Ok(config)) => print_preview_cache_batch(config),
        Command::PreviewCacheBatch(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewCacheMaintenance(Ok(config)) => print_preview_cache_maintenance(config),
        Command::PreviewCacheMaintenance(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PreviewRenderImage(Ok(config)) => print_preview_render_result(render_preview_image(&config)),
        Command::PreviewRenderImage(Err(message)) => {
            print_error(&message);
            2
        }
        Command::DatabaseHealthCheck(Ok(config)) => print_database_maintenance_result(run_database_health_check(&config)),
        Command::DatabaseHealthCheck(Err(message)) => {
            print_error(&message);
            2
        }
        Command::DatabaseBackup(Ok(config)) => print_database_maintenance_result(run_database_backup(&config)),
        Command::DatabaseBackup(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontResourceAdd(Ok(config)) => print_font_resource_result(add_font_resources(&config)),
        Command::FontResourceAdd(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontResourceRemove(Ok(config)) => print_font_resource_result(remove_font_resources(&config)),
        Command::FontResourceRemove(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontResourceNotify(Ok(config)) => print_font_resource_result(notify_font_change(&config)),
        Command::FontResourceNotify(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontRegistryApply(Ok(config)) => print_font_resource_result(apply_font_registry(&config)),
        Command::FontRegistryApply(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontRegistryDelete(Ok(config)) => print_font_resource_result(delete_font_registry(&config)),
        Command::FontRegistryDelete(Err(message)) => {
            print_error(&message);
            2
        }
        Command::FontActivationFiles(Ok(config)) => print_font_resource_result(run_font_activation_files(&config)),
        Command::FontActivationFiles(Err(message)) => {
            print_error(&message);
            2
        }
        Command::RootIndexApplyChanges(Err(message)) => {
            print_error(&message);
            2
        }
        Command::MergedIndexQueryPage(Ok(config)) => print_merged_index_query_page(config),
        Command::MergedIndexQueryPage(Err(message)) => {
            print_error(&message);
            2
        }
        Command::MergedIndexQueryMetrics(Ok(config)) => print_merged_index_query_metrics(config),
        Command::MergedIndexQueryMetrics(Err(message)) => {
            print_error(&message);
            2
        }
        Command::MergedIndexQueryIds(Ok(config)) => print_merged_index_query_ids(config),
        Command::MergedIndexQueryIds(Err(message)) => {
            print_error(&message);
            2
        }
        Command::MergedIndexRebuild(Ok(config)) => print_merged_index_rebuild(config),
        Command::MergedIndexRebuild(Err(message)) => {
            print_error(&message);
            2
        }
        Command::MergedIndexSync(Ok(config)) => print_merged_index_sync(config),
        Command::MergedIndexSync(Err(message)) => {
            print_error(&message);
            2
        }
        Command::SystemInstalledFonts(Ok(config)) => print_system_installed_fonts(config),
        Command::SystemInstalledFonts(Err(message)) => {
            print_error(&message);
            2
        }
        Command::WatcherBatchPreflight(Ok(config)) => print_watcher_preflight(config),
        Command::WatcherBatchPreflight(Err(message)) => {
            print_error(&message);
            2
        }
        Command::PhysicalFolderTree(Ok(config)) => print_physical_folder_tree(config),
        Command::PhysicalFolderTree(Err(message)) => {
            print_error(&message);
            2
        }
        Command::ListFontFiles(Err(message)) => {
            print_error(&message);
            2
        }
        Command::Unknown => {
            usage();
            print_error("unknown command");
            2
        }
    };
    let _ = io::stdout().flush();
    code
}

fn print_core_scheduler_profile(config: crate::core_scheduler::CoreSchedulerProfileConfig) -> i32 {
    match read_core_scheduler_profile(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_font_parse_batch(config: crate::scanner::parse_batch::FontParseBatchCommandConfig) -> i32 {
    match parse_font_batch(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_install_status_read(config: crate::install_status::InstallStatusCommandConfig) -> i32 {
    match read_install_status_index(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_install_status_save(config: crate::install_status::InstallStatusCommandConfig) -> i32 {
    match save_install_status_index(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_install_status_compare(config: crate::install_status::InstallStatusCommandConfig) -> i32 {
    match compare_install_status(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_tag_mutation_error(command: &str, domain: &str, mutation_kind: &str, message: &str) -> i32 {
    let protocol = crate::mutation_protocol::tag_mutation_protocol_error(command, domain, mutation_kind, message);
    let protocol_json = serde_json::to_string(&protocol).unwrap_or_else(|_| "null".to_string());
    println!(
        "{{\"ok\":false,\"message\":\"{}\",\"mutationProtocol\":{}}}",
        escape_json(message),
        protocol_json
    );
    2
}

fn print_local_tags_set(config: crate::local_tags::LocalTagsCommandConfig) -> i32 {
    match set_local_tags_state_machine(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => print_tag_mutation_error("--local-tags-set", "localTags", "set", &message),
    }
}


fn print_local_tags_read(config: crate::local_tags::LocalTagsCommandConfig) -> i32 {
    match read_local_tags_state_machine(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_local_tags_delete_tag(config: crate::local_tags::LocalTagsCommandConfig) -> i32 {
    match delete_local_tag_state_machine(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => print_tag_mutation_error("--local-tags-delete-tag", "localTags", "deleteTag", &message),
    }
}

fn print_shared_metadata_apply(config: crate::shared_metadata::SharedMetadataCommandConfig) -> i32 {
    match apply_shared_metadata(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => print_tag_mutation_error("--shared-metadata-apply", "sharedMetadata", "apply", &message),
    }
}

fn print_shared_metadata_remove_tag(config: crate::shared_metadata::SharedMetadataCommandConfig) -> i32 {
    match remove_shared_metadata_tag(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => print_tag_mutation_error("--shared-metadata-remove-tag", "sharedMetadata", "removeTag", &message),
    }
}


fn print_shared_metadata_known_tags(config: crate::shared_metadata::SharedMetadataCommandConfig) -> i32 {
    match read_shared_metadata_known_tags(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_shared_metadata_overlay_read(config: crate::shared_metadata::SharedMetadataCommandConfig) -> i32 {
    match read_shared_metadata_overlay(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_shared_metadata_signature(config: crate::shared_metadata::SharedMetadataCommandConfig) -> i32 {
    match read_shared_metadata_signature(&config) {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_preview_cache_read_status(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    print_preview_cache_result(read_preview_cache_status(&config))
}

fn print_preview_cache_apply(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    print_preview_cache_result(apply_preview_cache_rows(&config))
}

fn print_preview_cache_delete(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    print_preview_cache_result(delete_preview_cache_rows(&config))
}

fn print_preview_cache_query(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    print_preview_cache_result(query_preview_cache_status(&config))
}

fn print_preview_cache_touch(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    print_preview_cache_result(touch_preview_cache_rows(&config))
}

fn print_preview_cache_result(result: Result<String, String>) -> i32 {
    match result {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}


fn print_preview_render_result(result: Result<String, String>) -> i32 {
    match result {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_preview_cache_batch(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    match query_preview_cache_batch(&config) {
        Ok(json) => { println!("{}", json); 0 }
        Err(message) => { println!("{{\"ok\":false,\"message\":\"{}\"}}", escape_json(&message)); 2 }
    }
}

fn print_preview_cache_maintenance(config: crate::preview_cache::PreviewCacheCommandConfig) -> i32 {
    match run_preview_cache_maintenance(&config) {
        Ok(json) => { println!("{}", json); 0 }
        Err(message) => { println!("{{\"ok\":false,\"message\":\"{}\"}}", escape_json(&message)); 2 }
    }
}

fn print_physical_folder_tree(config: crate::folders::PhysicalFolderTreeConfig) -> i32 {
    match list_physical_folder_tree(&config) {
        Ok(json) => { println!("{}", json); 0 }
        Err(message) => { println!("{{\"ok\":false,\"message\":\"{}\"}}", escape_json(&message)); 2 }
    }
}

fn print_database_maintenance_result(result: Result<String, String>) -> i32 {
    match result {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_font_resource_result(result: Result<String, String>) -> i32 {
    match result {
        Ok(json) => {
            println!("{}", json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_watcher_preflight(config: crate::watcher::WatcherPreflightConfig) -> i32 {
    let started_at = std::time::Instant::now();
    match run_watcher_preflight(&config) {
        Ok(result) => {
            println!("{}", watcher_preflight_to_json(&result, started_at.elapsed().as_millis()));
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_system_installed_fonts(config: crate::system_fonts::SystemInstalledFontsConfig) -> i32 {
    match read_system_installed_fonts(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_merged_index_query_page(config: crate::merged_index::MergedIndexPageQueryConfig) -> i32 {
    match query_merged_index_page(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}


fn print_merged_index_query_ids(config: crate::merged_index::MergedIndexIdsQueryConfig) -> i32 {
    match query_merged_index_ids(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_merged_index_query_metrics(config: crate::merged_index::MergedIndexMetricsQueryConfig) -> i32 {
    match query_merged_index_metrics(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_merged_index_rebuild(config: crate::merged_index::MergedIndexRebuildConfig) -> i32 {
    match rebuild_merged_index(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_merged_index_sync(config: crate::merged_index::MergedIndexSyncConfig) -> i32 {
    match sync_merged_index(&config) {
        Ok(result) => {
            println!("{}", result.json);
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_root_index_apply_changes(config: crate::root_index::RootIndexApplyConfig) -> i32 {
    match apply_root_index_changes(&config) {
        Ok(result) => {
            println!(
                "{{\"ok\":true,\"applied\":true,\"count\":{},\"upserts\":{},\"deletes\":{}}}",
                result.count,
                result.upserts,
                result.deletes
            );
            0
        }
        Err(message) => {
            println!(
                "{{\"ok\":false,\"message\":\"{}\"}}",
                escape_json(&message)
            );
            2
        }
    }
}

fn print_font_file_list(config: ListFontFilesConfig) -> i32 {
    let result = list_font_files(Path::new(&config.root), &config.extensions, config.max_entries, config.probe_names, config.probe_scripts, config.probe_style, config.probe_family, config.full_hash);
    let json = result_to_json(&config.root, &result);
    if let Some(output_path) = config.output {
        match fs::write(&output_path, json) {
            Ok(_) => {
                println!("{}", r#"{"ok":true,"written":true}"#);
                0
            }
            Err(error) => {
                eprintln!("{}", error);
                println!(
                    "{{\"ok\":false,\"message\":\"{}\"}}",
                    escape_json(&error.to_string())
                );
                2
            }
        }
    } else {
        println!("{}", json);
        0
    }
}
