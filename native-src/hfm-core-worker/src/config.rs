use crate::merged_index::{MergedIndexIdsQueryConfig, MergedIndexMetricsQueryConfig, MergedIndexPageQueryConfig, MergedIndexRebuildConfig, MergedIndexSyncConfig};
use crate::core_scheduler::CoreSchedulerProfileConfig;
use crate::root_index::RootIndexApplyConfig;
use crate::preview_cache::PreviewCacheCommandConfig;
use crate::preview_render::PreviewRenderCommandConfig;
use crate::install_status::InstallStatusCommandConfig;
use crate::local_tags::LocalTagsCommandConfig;
use crate::database_maintenance::DatabaseMaintenanceCommandConfig;
use crate::font_resource::FontResourceCommandConfig;
use crate::folders::PhysicalFolderTreeConfig;
use crate::shared_metadata::SharedMetadataCommandConfig;
use crate::system_fonts::SystemInstalledFontsConfig;
use crate::watcher::WatcherPreflightConfig;
use crate::scanner::parse_batch::FontParseBatchCommandConfig;

#[derive(Clone, Debug)]
pub struct ListFontFilesConfig {
    pub root: String,
    pub output: Option<String>,
    pub extensions: Vec<String>,
    pub max_entries: usize,
    pub probe_names: bool,
    pub probe_scripts: bool,
    pub probe_style: bool,
    pub probe_family: bool,
    pub full_hash: bool,
}

#[derive(Clone, Debug)]
pub enum Command {
    Handshake,
    CoreSchedulerProfile(Result<CoreSchedulerProfileConfig, String>),
    ListFontFiles(Result<ListFontFilesConfig, String>),
    FontParseBatch(Result<FontParseBatchCommandConfig, String>),
    RootIndexApplyChanges(Result<RootIndexApplyConfig, String>),
    InstallStatusRead(Result<InstallStatusCommandConfig, String>),
    InstallStatusSave(Result<InstallStatusCommandConfig, String>),
    InstallStatusCompare(Result<InstallStatusCommandConfig, String>),
    LocalTagsSet(Result<LocalTagsCommandConfig, String>),
    LocalTagsRead(Result<LocalTagsCommandConfig, String>),
    LocalTagsDeleteTag(Result<LocalTagsCommandConfig, String>),
    SharedMetadataApply(Result<SharedMetadataCommandConfig, String>),
    SharedMetadataRemoveTag(Result<SharedMetadataCommandConfig, String>),
    SharedMetadataKnownTags(Result<SharedMetadataCommandConfig, String>),
    SharedMetadataOverlayRead(Result<SharedMetadataCommandConfig, String>),
    SharedMetadataSignature(Result<SharedMetadataCommandConfig, String>),
    PreviewCacheReadStatus(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheApply(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheDelete(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheQuery(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheTouch(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheBatch(Result<PreviewCacheCommandConfig, String>),
    PreviewCacheMaintenance(Result<PreviewCacheCommandConfig, String>),
    PreviewRenderImage(Result<PreviewRenderCommandConfig, String>),
    DatabaseHealthCheck(Result<DatabaseMaintenanceCommandConfig, String>),
    DatabaseBackup(Result<DatabaseMaintenanceCommandConfig, String>),
    FontResourceAdd(Result<FontResourceCommandConfig, String>),
    FontResourceRemove(Result<FontResourceCommandConfig, String>),
    FontResourceNotify(Result<FontResourceCommandConfig, String>),
    FontRegistryApply(Result<FontResourceCommandConfig, String>),
    FontRegistryDelete(Result<FontResourceCommandConfig, String>),
    FontActivationFiles(Result<FontResourceCommandConfig, String>),
    MergedIndexQueryPage(Result<MergedIndexPageQueryConfig, String>),
    MergedIndexQueryMetrics(Result<MergedIndexMetricsQueryConfig, String>),
    MergedIndexQueryIds(Result<MergedIndexIdsQueryConfig, String>),
    MergedIndexRebuild(Result<MergedIndexRebuildConfig, String>),
    MergedIndexSync(Result<MergedIndexSyncConfig, String>),
    SystemInstalledFonts(Result<SystemInstalledFontsConfig, String>),
    WatcherBatchPreflight(Result<WatcherPreflightConfig, String>),
    PhysicalFolderTree(Result<PhysicalFolderTreeConfig, String>),
    Unknown,
}

pub fn default_font_extensions() -> Vec<String> {
    vec![
        "ttf".to_string(),
        "otf".to_string(),
        "ttc".to_string(),
        "otc".to_string(),
        "woff".to_string(),
        "woff2".to_string(),
    ]
}

pub fn parse_extension_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|entry| entry.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}



fn parse_input_only_command_args(args: &[String]) -> Result<String, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    input_path.ok_or_else(|| "missing --input".to_string())
}

fn parse_font_parse_batch_args(args: &[String]) -> Result<FontParseBatchCommandConfig, String> {
    Ok(FontParseBatchCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_install_status_command_args(args: &[String]) -> Result<InstallStatusCommandConfig, String> {
    Ok(InstallStatusCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_local_tags_command_args(args: &[String]) -> Result<LocalTagsCommandConfig, String> {
    Ok(LocalTagsCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_shared_metadata_command_args(args: &[String]) -> Result<SharedMetadataCommandConfig, String> {
    Ok(SharedMetadataCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_preview_cache_command_args(args: &[String]) -> Result<PreviewCacheCommandConfig, String> {
    Ok(PreviewCacheCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_preview_render_command_args(args: &[String]) -> Result<PreviewRenderCommandConfig, String> {
    Ok(PreviewRenderCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_database_maintenance_command_args(args: &[String]) -> Result<DatabaseMaintenanceCommandConfig, String> {
    Ok(DatabaseMaintenanceCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_font_resource_command_args(args: &[String]) -> Result<FontResourceCommandConfig, String> {
    Ok(FontResourceCommandConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_physical_folder_tree_args(args: &[String]) -> Result<PhysicalFolderTreeConfig, String> {
    Ok(PhysicalFolderTreeConfig {
        input_path: parse_input_only_command_args(args)?,
    })
}

fn parse_watcher_preflight_args(args: &[String]) -> Result<WatcherPreflightConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(WatcherPreflightConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}

fn parse_system_installed_fonts_args(args: &[String]) -> Result<SystemInstalledFontsConfig, String> {
    let mut windows_fonts_dir: Option<String> = None;
    let mut current_user_fonts_dir: Option<String> = None;
    let mut extensions = default_font_extensions();
    let mut include_name_candidates = false;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--windows-fonts-dir" if index + 1 < args.len() => {
                windows_fonts_dir = Some(args[index + 1].clone());
                index += 2;
            }
            "--current-user-fonts-dir" if index + 1 < args.len() => {
                current_user_fonts_dir = Some(args[index + 1].clone());
                index += 2;
            }
            "--extensions" if index + 1 < args.len() => {
                extensions = parse_extension_list(&args[index + 1]);
                index += 2;
            }
            "--include-name-candidates" => {
                include_name_candidates = true;
                index += 1;
            }
            "--no-name-candidates" => {
                include_name_candidates = false;
                index += 1;
            }
            _ => index += 1,
        }
    }

    Ok(SystemInstalledFontsConfig {
        windows_fonts_dir: windows_fonts_dir.ok_or_else(|| "missing --windows-fonts-dir".to_string())?,
        current_user_fonts_dir: current_user_fonts_dir.ok_or_else(|| "missing --current-user-fonts-dir".to_string())?,
        extensions,
        include_name_candidates,
    })
}

fn parse_root_index_apply_args(args: &[String]) -> Result<RootIndexApplyConfig, String> {
    let mut db_path: Option<String> = None;
    let mut root_path: Option<String> = None;
    let mut storage: String = "root".to_string();
    let mut input_path: Option<String> = None;
    let mut schema_version: i64 = 4;
    let mut cache_version: i64 = 2;
    let mut script_detection_version: i64 = 2;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--db" if index + 1 < args.len() => {
                db_path = Some(args[index + 1].clone());
                index += 2;
            }
            "--root" if index + 1 < args.len() => {
                root_path = Some(args[index + 1].clone());
                index += 2;
            }
            "--storage" if index + 1 < args.len() => {
                storage = args[index + 1].clone();
                index += 2;
            }
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            "--schema-version" if index + 1 < args.len() => {
                schema_version = args[index + 1].parse::<i64>().unwrap_or(schema_version);
                index += 2;
            }
            "--cache-version" if index + 1 < args.len() => {
                cache_version = args[index + 1].parse::<i64>().unwrap_or(cache_version);
                index += 2;
            }
            "--script-detection-version" if index + 1 < args.len() => {
                script_detection_version = args[index + 1].parse::<i64>().unwrap_or(script_detection_version);
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(RootIndexApplyConfig {
        db_path: db_path.ok_or_else(|| "missing --db".to_string())?,
        root_path: root_path.ok_or_else(|| "missing --root".to_string())?,
        storage,
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
        schema_version,
        cache_version,
        script_detection_version,
    })
}
fn parse_merged_index_page_query_args(args: &[String]) -> Result<MergedIndexPageQueryConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(MergedIndexPageQueryConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}


fn parse_merged_index_rebuild_args(args: &[String]) -> Result<MergedIndexRebuildConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(MergedIndexRebuildConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}

fn parse_merged_index_sync_args(args: &[String]) -> Result<MergedIndexSyncConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(MergedIndexSyncConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}


fn parse_merged_index_ids_query_args(args: &[String]) -> Result<MergedIndexIdsQueryConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(MergedIndexIdsQueryConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}

fn parse_merged_index_metrics_query_args(args: &[String]) -> Result<MergedIndexMetricsQueryConfig, String> {
    let mut input_path: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--input" if index + 1 < args.len() => {
                input_path = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }

    Ok(MergedIndexMetricsQueryConfig {
        input_path: input_path.ok_or_else(|| "missing --input".to_string())?,
    })
}

pub fn parse_args(args: &[String]) -> Command {
    if args.iter().any(|arg| arg == "--handshake" || arg == "--version") {
        return Command::Handshake;
    }

    if args.iter().any(|arg| arg == "--core-scheduler-profile") {
        return Command::CoreSchedulerProfile(Ok(CoreSchedulerProfileConfig));
    }

    if args.iter().any(|arg| arg == "--system-installed-fonts") {
        return Command::SystemInstalledFonts(parse_system_installed_fonts_args(args));
    }

    if args.iter().any(|arg| arg == "--watcher-batch-preflight") {
        return Command::WatcherBatchPreflight(parse_watcher_preflight_args(args));
    }

    if args.iter().any(|arg| arg == "--install-status-read") {
        return Command::InstallStatusRead(parse_install_status_command_args(args));
    }

    if args.iter().any(|arg| arg == "--install-status-save") {
        return Command::InstallStatusSave(parse_install_status_command_args(args));
    }

    if args.iter().any(|arg| arg == "--install-status-compare") {
        return Command::InstallStatusCompare(parse_install_status_command_args(args));
    }

    if args.iter().any(|arg| arg == "--local-tags-set") {
        return Command::LocalTagsSet(parse_local_tags_command_args(args));
    }

    if args.iter().any(|arg| arg == "--local-tags-read") {
        return Command::LocalTagsRead(parse_local_tags_command_args(args));
    }

    if args.iter().any(|arg| arg == "--local-tags-delete-tag") {
        return Command::LocalTagsDeleteTag(parse_local_tags_command_args(args));
    }

    if args.iter().any(|arg| arg == "--shared-metadata-apply") {
        return Command::SharedMetadataApply(parse_shared_metadata_command_args(args));
    }

    if args.iter().any(|arg| arg == "--shared-metadata-remove-tag") {
        return Command::SharedMetadataRemoveTag(parse_shared_metadata_command_args(args));
    }

    if args.iter().any(|arg| arg == "--shared-metadata-known-tags") {
        return Command::SharedMetadataKnownTags(parse_shared_metadata_command_args(args));
    }

    if args.iter().any(|arg| arg == "--shared-metadata-overlay-read") {
        return Command::SharedMetadataOverlayRead(parse_shared_metadata_command_args(args));
    }

    if args.iter().any(|arg| arg == "--shared-metadata-signature") {
        return Command::SharedMetadataSignature(parse_shared_metadata_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-read-status") {
        return Command::PreviewCacheReadStatus(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-apply") {
        return Command::PreviewCacheApply(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-delete") {
        return Command::PreviewCacheDelete(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-query") {
        return Command::PreviewCacheQuery(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-touch") {
        return Command::PreviewCacheTouch(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-batch") {
        return Command::PreviewCacheBatch(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-cache-maintenance") {
        return Command::PreviewCacheMaintenance(parse_preview_cache_command_args(args));
    }

    if args.iter().any(|arg| arg == "--preview-render-image") {
        return Command::PreviewRenderImage(parse_preview_render_command_args(args));
    }

    if args.iter().any(|arg| arg == "--database-health-check") {
        return Command::DatabaseHealthCheck(parse_database_maintenance_command_args(args));
    }

    if args.iter().any(|arg| arg == "--database-backup") {
        return Command::DatabaseBackup(parse_database_maintenance_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-resource-add") {
        return Command::FontResourceAdd(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-resource-remove") {
        return Command::FontResourceRemove(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-resource-notify") {
        return Command::FontResourceNotify(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-registry-apply") {
        return Command::FontRegistryApply(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-registry-delete") {
        return Command::FontRegistryDelete(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--font-activation-files") {
        return Command::FontActivationFiles(parse_font_resource_command_args(args));
    }

    if args.iter().any(|arg| arg == "--physical-folder-tree") {
        return Command::PhysicalFolderTree(parse_physical_folder_tree_args(args));
    }

    if args.iter().any(|arg| arg == "--root-index-apply-changes") {
        return Command::RootIndexApplyChanges(parse_root_index_apply_args(args));
    }

    if args.iter().any(|arg| arg == "--merged-index-query-page") {
        return Command::MergedIndexQueryPage(parse_merged_index_page_query_args(args));
    }

    if args.iter().any(|arg| arg == "--merged-index-query-metrics") {
        return Command::MergedIndexQueryMetrics(parse_merged_index_metrics_query_args(args));
    }

    if args.iter().any(|arg| arg == "--merged-index-query-ids") {
        return Command::MergedIndexQueryIds(parse_merged_index_ids_query_args(args));
    }

    if args.iter().any(|arg| arg == "--merged-index-rebuild") {
        return Command::MergedIndexRebuild(parse_merged_index_rebuild_args(args));
    }

    if args.iter().any(|arg| arg == "--merged-index-sync") {
        return Command::MergedIndexSync(parse_merged_index_sync_args(args));
    }

    if args.iter().any(|arg| arg == "--font-parse-batch") {
        return Command::FontParseBatch(parse_font_parse_batch_args(args));
    }

    if !args.iter().any(|arg| arg == "--list-font-files") {
        return Command::Unknown;
    }

    let mut root: Option<String> = None;
    let mut output: Option<String> = None;
    let mut extensions = default_font_extensions();
    let mut max_entries: usize = 200_000;
    let mut probe_names = false;
    let mut probe_scripts = false;
    let mut probe_style = false;
    let mut probe_family = false;
    let mut full_hash = false;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--root" if index + 1 < args.len() => {
                root = Some(args[index + 1].clone());
                index += 2;
            }
            "--output" if index + 1 < args.len() => {
                output = Some(args[index + 1].clone());
                index += 2;
            }
            "--extensions" if index + 1 < args.len() => {
                extensions = parse_extension_list(&args[index + 1]);
                index += 2;
            }
            "--max" if index + 1 < args.len() => {
                max_entries = args[index + 1]
                    .parse::<usize>()
                    .unwrap_or(max_entries)
                    .max(1);
                index += 2;
            }
            "--probe-names" => {
                probe_names = true;
                index += 1;
            }
            "--no-name-probe" => {
                probe_names = false;
                index += 1;
            }
            "--probe-scripts" => {
                probe_scripts = true;
                index += 1;
            }
            "--no-script-probe" => {
                probe_scripts = false;
                index += 1;
            }
            "--probe-style" => {
                probe_style = true;
                index += 1;
            }
            "--no-style-probe" => {
                probe_style = false;
                index += 1;
            }
            "--probe-family" => {
                probe_family = true;
                probe_names = true;
                probe_style = true;
                index += 1;
            }
            "--no-family-probe" => {
                probe_family = false;
                index += 1;
            }
            "--full-hash" => {
                full_hash = true;
                index += 1;
            }
            "--quick-hash" => {
                full_hash = false;
                index += 1;
            }
            _ => index += 1,
        }
    }

    let Some(root) = root else {
        return Command::ListFontFiles(Err("missing --root".to_string()));
    };

    Command::ListFontFiles(Ok(ListFontFilesConfig {
        root,
        output,
        extensions,
        max_entries,
        probe_names,
        probe_scripts,
        probe_style,
        probe_family,
        full_hash,
    }))
}

pub fn usage() {
    eprintln!("hfm-core-worker --handshake");
    eprintln!("hfm-core-worker --core-scheduler-profile");
    eprintln!("hfm-core-worker --core-daemon");
    eprintln!("hfm-core-worker --list-font-files --root <path> [--extensions ttf,otf,ttc,otc,woff,woff2] [--max <n>] [--probe-names] [--probe-scripts] [--probe-style] [--probe-family] [--full-hash] [--output <path>]");
    eprintln!("hfm-core-worker --font-parse-batch --input <json>");
    eprintln!("hfm-core-worker --system-installed-fonts --windows-fonts-dir <path> --current-user-fonts-dir <path> [--extensions ttf,otf,ttc,otc,woff,woff2] [--include-name-candidates]");
    eprintln!("hfm-core-worker --watcher-batch-preflight --input <json>");
    eprintln!("hfm-core-worker --install-status-read --input <json>");
    eprintln!("hfm-core-worker --install-status-save --input <json>");
    eprintln!("hfm-core-worker --install-status-compare --input <json>");
    eprintln!("hfm-core-worker --local-tags-set --input <json>");
    eprintln!("hfm-core-worker --local-tags-read --input <json>");
    eprintln!("hfm-core-worker --local-tags-delete-tag --input <json>");
    eprintln!("hfm-core-worker --shared-metadata-apply --input <json>");
    eprintln!("hfm-core-worker --shared-metadata-remove-tag --input <json>");
    eprintln!("hfm-core-worker --shared-metadata-known-tags --input <json>");
    eprintln!("hfm-core-worker --shared-metadata-overlay-read --input <json>");
    eprintln!("hfm-core-worker --shared-metadata-signature --input <json>");
    eprintln!("hfm-core-worker --preview-cache-read-status --input <json>");
    eprintln!("hfm-core-worker --preview-cache-apply --input <json>");
    eprintln!("hfm-core-worker --preview-cache-delete --input <json>");
    eprintln!("hfm-core-worker --preview-cache-query --input <json>");
    eprintln!("hfm-core-worker --preview-cache-touch --input <json>");
    eprintln!("hfm-core-worker --preview-cache-batch --input <json>");
    eprintln!("hfm-core-worker --preview-cache-maintenance --input <json>");
    eprintln!("hfm-core-worker --preview-render-image --input <json>");
    eprintln!("hfm-core-worker --database-health-check --input <json>");
    eprintln!("hfm-core-worker --database-backup --input <json>");
    eprintln!("hfm-core-worker --font-resource-add --input <json>");
    eprintln!("hfm-core-worker --font-resource-remove --input <json>");
    eprintln!("hfm-core-worker --font-resource-notify --input <json>");
    eprintln!("hfm-core-worker --font-registry-apply --input <json>");
    eprintln!("hfm-core-worker --font-registry-delete --input <json>");
    eprintln!("hfm-core-worker --font-activation-files --input <json>");
    eprintln!("hfm-core-worker --physical-folder-tree --input <json>");
    eprintln!("hfm-core-worker --root-index-apply-changes --db <path> --root <path> --storage <root|fallback> --input <json> [--schema-version <n>] [--cache-version <n>] [--script-detection-version <n>]");
    eprintln!("hfm-core-worker --merged-index-query-page --input <json>");
    eprintln!("hfm-core-worker --merged-index-query-metrics --input <json>");
    eprintln!("hfm-core-worker --merged-index-query-ids --input <json>");
    eprintln!("hfm-core-worker --merged-index-rebuild --input <json>");
    eprintln!("hfm-core-worker --merged-index-sync --input <json>");
}
