use crate::config::{parse_args, Command};
use crate::core_scheduler::read_core_scheduler_profile;
use crate::folders::list_physical_folder_tree;
use crate::install_status::{compare_install_status, read_install_status_index};
use crate::local_tags::{delete_local_tag_state_machine, read_local_tags_state_machine, set_local_tags_state_machine};
use crate::merged_index::{query_merged_index_ids, query_merged_index_metrics, query_merged_index_page, rebuild_merged_index, sync_merged_index};
use crate::preview_cache::{apply_preview_cache_rows, delete_preview_cache_rows, query_preview_cache_batch, query_preview_cache_status, read_preview_cache_status, run_preview_cache_maintenance, touch_preview_cache_rows};
use crate::root_index::apply_root_index_changes;
use crate::shared_metadata::{apply_shared_metadata, read_shared_metadata_known_tags, read_shared_metadata_overlay, read_shared_metadata_signature, remove_shared_metadata_tag};
use crate::system_fonts::read_system_installed_fonts;
use crate::watcher::{run_watcher_preflight, watcher_preflight_to_json};

use super::maintenance_commands::{run_daemon_database_backup, run_daemon_database_health_check, run_daemon_install_status_save};
use super::preview_commands::run_daemon_preview_render_image;
use super::resource_commands::{run_daemon_font_activation_files, run_daemon_font_registry_apply, run_daemon_font_registry_delete, run_daemon_font_resource_add, run_daemon_font_resource_notify, run_daemon_font_resource_remove};
use super::scan_commands::{run_daemon_font_parse_batch, run_daemon_list_font_files};
use super::types::command_from_args;

pub fn run_daemon_command(args: &[String]) -> Result<String, String> {
    let mut argv = Vec::with_capacity(args.len() + 1);
    argv.push("hfm-core-worker".to_string());
    argv.extend(args.iter().cloned());

    match parse_args(&argv) {
        Command::CoreSchedulerProfile(Ok(config)) => read_core_scheduler_profile(&config),
        Command::CoreSchedulerProfile(Err(message)) => Err(message),
        Command::ListFontFiles(Ok(config)) => run_daemon_list_font_files(&config),
        Command::ListFontFiles(Err(message)) => Err(message),
        Command::FontParseBatch(Ok(config)) => run_daemon_font_parse_batch(&config),
        Command::FontParseBatch(Err(message)) => Err(message),
        Command::MergedIndexQueryPage(Ok(config)) => query_merged_index_page(&config).map(|result| result.json),
        Command::MergedIndexQueryPage(Err(message)) => Err(message),
        Command::MergedIndexQueryMetrics(Ok(config)) => query_merged_index_metrics(&config).map(|result| result.json),
        Command::MergedIndexQueryMetrics(Err(message)) => Err(message),
        Command::MergedIndexQueryIds(Ok(config)) => query_merged_index_ids(&config).map(|result| result.json),
        Command::MergedIndexQueryIds(Err(message)) => Err(message),
        Command::MergedIndexRebuild(Ok(config)) => rebuild_merged_index(&config).map(|result| result.json),
        Command::MergedIndexRebuild(Err(message)) => Err(message),
        Command::MergedIndexSync(Ok(config)) => sync_merged_index(&config).map(|result| result.json),
        Command::MergedIndexSync(Err(message)) => Err(message),
        Command::InstallStatusRead(Ok(config)) => read_install_status_index(&config),
        Command::InstallStatusRead(Err(message)) => Err(message),
        Command::InstallStatusCompare(Ok(config)) => compare_install_status(&config),
        Command::InstallStatusCompare(Err(message)) => Err(message),
        Command::InstallStatusSave(Ok(config)) => run_daemon_install_status_save(&config),
        Command::InstallStatusSave(Err(message)) => Err(message),
        Command::PreviewCacheReadStatus(Ok(config)) => read_preview_cache_status(&config),
        Command::PreviewCacheReadStatus(Err(message)) => Err(message),
        Command::PreviewCacheQuery(Ok(config)) => query_preview_cache_status(&config),
        Command::PreviewCacheQuery(Err(message)) => Err(message),
        Command::PreviewCacheTouch(Ok(config)) => touch_preview_cache_rows(&config),
        Command::PreviewCacheTouch(Err(message)) => Err(message),
        Command::PreviewCacheBatch(Ok(config)) => query_preview_cache_batch(&config),
        Command::PreviewCacheBatch(Err(message)) => Err(message),
        Command::PreviewCacheApply(Ok(config)) => apply_preview_cache_rows(&config),
        Command::PreviewCacheApply(Err(message)) => Err(message),
        Command::PreviewCacheDelete(Ok(config)) => delete_preview_cache_rows(&config),
        Command::PreviewCacheDelete(Err(message)) => Err(message),
        Command::PreviewCacheMaintenance(Ok(config)) => run_preview_cache_maintenance(&config),
        Command::PreviewCacheMaintenance(Err(message)) => Err(message),
        Command::PreviewRenderImage(Ok(config)) => run_daemon_preview_render_image(&config),
        Command::PreviewRenderImage(Err(message)) => Err(message),
        Command::LocalTagsSet(Ok(config)) => set_local_tags_state_machine(&config),
        Command::LocalTagsSet(Err(message)) => Err(message),
        Command::LocalTagsRead(Ok(config)) => read_local_tags_state_machine(&config),
        Command::LocalTagsRead(Err(message)) => Err(message),
        Command::LocalTagsDeleteTag(Ok(config)) => delete_local_tag_state_machine(&config),
        Command::LocalTagsDeleteTag(Err(message)) => Err(message),
        Command::SharedMetadataApply(Ok(config)) => apply_shared_metadata(&config),
        Command::SharedMetadataApply(Err(message)) => Err(message),
        Command::SharedMetadataRemoveTag(Ok(config)) => remove_shared_metadata_tag(&config),
        Command::SharedMetadataRemoveTag(Err(message)) => Err(message),
        Command::SharedMetadataKnownTags(Ok(config)) => read_shared_metadata_known_tags(&config),
        Command::SharedMetadataKnownTags(Err(message)) => Err(message),
        Command::SharedMetadataOverlayRead(Ok(config)) => read_shared_metadata_overlay(&config),
        Command::SharedMetadataOverlayRead(Err(message)) => Err(message),
        Command::SharedMetadataSignature(Ok(config)) => read_shared_metadata_signature(&config),
        Command::SharedMetadataSignature(Err(message)) => Err(message),
        Command::WatcherBatchPreflight(Ok(config)) => {
            let started_at = std::time::Instant::now();
            run_watcher_preflight(&config).map(|result| watcher_preflight_to_json(&result, started_at.elapsed().as_millis()))
        }
        Command::WatcherBatchPreflight(Err(message)) => Err(message),
        Command::RootIndexApplyChanges(Ok(config)) => apply_root_index_changes(&config).map(|result| {
            format!(
                "{{\"ok\":true,\"applied\":true,\"count\":{},\"upserts\":{},\"deletes\":{},\"workerMode\":\"rust-root-index-apply-daemon\"}}",
                result.count,
                result.upserts,
                result.deletes
            )
        }),
        Command::RootIndexApplyChanges(Err(message)) => Err(message),
        Command::SystemInstalledFonts(Ok(config)) => read_system_installed_fonts(&config).map(|result| result.json),
        Command::SystemInstalledFonts(Err(message)) => Err(message),
        Command::DatabaseHealthCheck(Ok(config)) => run_daemon_database_health_check(&config),
        Command::DatabaseHealthCheck(Err(message)) => Err(message),
        Command::DatabaseBackup(Ok(config)) => run_daemon_database_backup(&config),
        Command::DatabaseBackup(Err(message)) => Err(message),
        Command::FontResourceAdd(Ok(config)) => run_daemon_font_resource_add(&config),
        Command::FontResourceAdd(Err(message)) => Err(message),
        Command::FontResourceRemove(Ok(config)) => run_daemon_font_resource_remove(&config),
        Command::FontResourceRemove(Err(message)) => Err(message),
        Command::FontResourceNotify(Ok(config)) => run_daemon_font_resource_notify(&config),
        Command::FontResourceNotify(Err(message)) => Err(message),
        Command::FontRegistryApply(Ok(config)) => run_daemon_font_registry_apply(&config),
        Command::FontRegistryApply(Err(message)) => Err(message),
        Command::FontRegistryDelete(Ok(config)) => run_daemon_font_registry_delete(&config),
        Command::FontRegistryDelete(Err(message)) => Err(message),
        Command::FontActivationFiles(Ok(config)) => run_daemon_font_activation_files(&config),
        Command::FontActivationFiles(Err(message)) => Err(message),
        Command::PhysicalFolderTree(Ok(config)) => list_physical_folder_tree(&config),
        Command::PhysicalFolderTree(Err(message)) => Err(message),
        _ => Err(format!(
            "unsupported daemon command: {}",
            command_from_args(args)
        )),
    }
}
