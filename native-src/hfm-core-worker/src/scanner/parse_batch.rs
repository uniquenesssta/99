use std::fs::{self, File, Metadata};
use std::io;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::font_parser::diagnostics::MetadataDiagnostic;
use crate::family::FontFamilyHint;
use crate::font_parser::{FontNameInfo, FontScriptInfo, FontStyleInfo};
use crate::font_resource::activation_identity::file_id;

use super::font_file::{scan_font_file_from_handle, FontFileScanOptions};
use super::metadata::{round_timestamp_ms, timestamp_ms};
use super::types::FontFileEntry;

#[derive(Clone, Debug)]
pub struct FontParseBatchCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchPayload {
    #[serde(default)]
    jobs: Vec<FontParseBatchJob>,
    #[serde(default)]
    full_hash: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchJob {
    job_id: String,
    root_path: String,
    file_path: String,
    cache_key: String,
    signature: String,
    #[serde(default)]
    file_size: f64,
    #[serde(default)]
    modified_at: f64,
    #[serde(default)]
    created_at: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchError {
    job_id: String,
    path: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchResult {
    job_id: String,
    root_path: String,
    file_path: String,
    cache_key: String,
    signature: String,
    file_size: f64,
    modified_at: f64,
    created_at: f64,
    signature_valid: bool,
    format_hint: String,
    quick_hash: String,
    content_hash: String,
    hash_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name_hint: Option<FontNameInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    metadata_diagnostics: Vec<MetadataDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    script_hint: Option<FontScriptInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_hint: Option<FontStyleInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    family_hint: Option<FontFamilyHint>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchOutput {
    ok: bool,
    results: Vec<FontParseBatchResult>,
    errors: Vec<FontParseBatchError>,
    count: usize,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

fn open_font_source(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep one read-only handle through signature, hashes and metadata.
        // FILE_SHARE_READ rejects existing writers and prevents subsequent
        // writable/delete handles until this source has actually been closed.
        fs::OpenOptions::new().read(true).share_mode(1).open(path)
    }
    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

fn validate_expected_metadata(job: &FontParseBatchJob, metadata: &Metadata) -> io::Result<()> {
    if !metadata.is_file() {
        return Err(io::Error::other("font parse source is not a regular file"));
    }
    if !job.file_size.is_finite() || !job.modified_at.is_finite()
        || job.file_size != metadata.len() as f64
        || round_timestamp_ms(job.modified_at) != timestamp_ms(metadata.modified()?) {
        return Err(io::Error::other("font changed before parsing: expected size or modified time mismatch"));
    }
    Ok(())
}

fn validate_unchanged_source(
    path: &Path,
    file: &File,
    before: &Metadata,
    identity: &(String, String),
) -> io::Result<()> {
    let after = file.metadata()?;
    // A parent junction/alias can be redirected even while the source file is
    // pinned. Reopen the submitted path and verify its current physical identity.
    let current = open_font_source(path)?;
    let current_metadata = current.metadata()?;
    let current_identity = file_id(&current)?;
    if !current_metadata.is_file()
        || before.len() != after.len()
        || before.modified()? != after.modified()?
        || before.len() != current_metadata.len()
        || before.modified()? != current_metadata.modified()?
        || *identity != current_identity {
        return Err(io::Error::other("font changed during parsing: source metadata or identity mismatch"));
    }
    Ok(())
}

fn parse_font_job(
    job: &FontParseBatchJob,
    options: &FontFileScanOptions,
    after_read: impl FnOnce(),
) -> io::Result<FontFileEntry> {
    let path = Path::new(&job.file_path);
    let mut file = open_font_source(path)?;
    let before = file.metadata()?;
    validate_expected_metadata(job, &before)?;
    let identity = file_id(&file)?;
    let entry = scan_font_file_from_handle(path, &mut file, &before, options)?;
    after_read();
    validate_unchanged_source(path, &file, &before, &identity)?;
    Ok(entry)
}

pub fn parse_font_batch(config: &FontParseBatchCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let payload_text = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: FontParseBatchPayload = serde_json::from_str(&payload_text).map_err(|error| error.to_string())?;
    let options = FontFileScanOptions {
        probe_names: true,
        probe_scripts: true,
        probe_style: true,
        probe_family: true,
        full_hash: payload.full_hash,
    };

    let mut results = Vec::with_capacity(payload.jobs.len());
    let mut errors = Vec::new();

    for job in payload.jobs {
        match parse_font_job(&job, &options, || {}) {
            Ok(entry) => {
                results.push(FontParseBatchResult {
                    job_id: job.job_id,
                    root_path: job.root_path,
                    file_path: job.file_path,
                    cache_key: job.cache_key,
                    signature: job.signature,
                    file_size: entry.size as f64,
                    modified_at: job.modified_at,
                    created_at: if job.created_at > 0.0 { job.created_at } else { entry.created_ms as f64 },
                    signature_valid: entry.signature_valid,
                    format_hint: entry.format,
                    quick_hash: entry.quick_hash.clone(),
                    content_hash: if entry.content_hash.is_empty() { entry.quick_hash.clone() } else { entry.content_hash },
                    hash_kind: entry.hash_kind,
                    name_hint: entry.name_hint,
                    metadata_diagnostics: entry.metadata_diagnostics,
                    script_hint: entry.script_hint,
                    style_hint: entry.style_hint,
                    family_hint: entry.family_hint,
                });
            }
            Err(error) => {
                errors.push(FontParseBatchError {
                    job_id: job.job_id,
                    path: job.file_path,
                    message: error.to_string(),
                });
            }
        }
    }

    let output = FontParseBatchOutput {
        ok: true,
        count: results.len(),
        results,
        errors,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-parse-batch",
    };
    serde_json::to_string(&output).map_err(|error| error.to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        cell::Cell,
        os::windows::fs::OpenOptionsExt,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    const FONT_HEADER: &[u8] = b"\0\x01\0\0\0\0\0\0\0\0\0\0";

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("hfm-parse-batch-{}-{nonce}-{sequence}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn font(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn job(path: &Path) -> FontParseBatchJob {
        let metadata = fs::metadata(path).unwrap();
        FontParseBatchJob {
            job_id: path.file_name().unwrap().to_string_lossy().into_owned(),
            root_path: path.parent().unwrap().to_string_lossy().into_owned(),
            file_path: path.to_string_lossy().into_owned(),
            cache_key: "cache-key".into(),
            signature: "persisted-signature".into(),
            file_size: metadata.len() as f64,
            modified_at: timestamp_ms(metadata.modified().unwrap()) as f64,
            created_at: 0.0,
        }
    }

    fn job_json(job: &FontParseBatchJob) -> Value {
        json!({"jobId": job.job_id, "rootPath": job.root_path, "filePath": job.file_path,
            "cacheKey": job.cache_key, "signature": job.signature, "fileSize": job.file_size,
            "modifiedAt": job.modified_at, "createdAt": job.created_at})
    }

    fn set_modified(path: &Path, time: SystemTime) {
        // Attribute-only writes are permitted despite FILE_SHARE_READ. This is
        // why the production batch also compares exact post-read timestamps.
        let file = fs::OpenOptions::new().access_mode(0x100).share_mode(7).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(time)).unwrap();
    }

    #[test]
    fn expected_size_and_rounded_mtime_are_checked_before_parse() {
        let fixture = Fixture::new();
        let path = fixture.font("source.ttf", FONT_HEADER);
        let expected = job(&path);
        let parsed = Cell::new(false);
        let options = FontFileScanOptions::default();
        let mut wrong_size = expected.clone();
        wrong_size.file_size += 1.0;
        let error = parse_font_job(&wrong_size, &options, || parsed.set(true)).unwrap_err();
        assert!(error.to_string().contains("before parsing"));
        let mut wrong_time = expected.clone();
        wrong_time.modified_at += 1.0;
        let error = parse_font_job(&wrong_time, &options, || parsed.set(true)).unwrap_err();
        assert!(error.to_string().contains("before parsing"));
        assert!(!parsed.get(), "stale source was parsed before rejecting its expected metadata");
        assert_eq!(fs::read(&path).unwrap(), FONT_HEADER);
    }

    #[test]
    fn fractional_native_listing_and_watcher_timestamps_share_one_signature() {
        let fixture = Fixture::new();
        let path = fixture.font("fractional.ttf", FONT_HEADER);
        let options = FontFileScanOptions::default();
        for (fraction_ns, rounded_offset) in [(400_000, 0), (499_800, 0), (499_900, 1),
            (500_000, 1), (500_100, 1), (700_000, 1), (999_000, 1)] {
            let base = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
            set_modified(&path, base + Duration::from_nanos(fraction_ns));
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!(metadata.modified().unwrap(), base + Duration::from_nanos(fraction_ns));
            let listed = super::super::font_file::scan_font_file(&path, &metadata, &options).unwrap();
            let nanos = metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            // Same order as Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6.
            let snapshot_ms = (nanos / 1_000_000) as f64 + (nanos % 1_000_000) as f64 / 1_000_000.0;
            let expected_ms = round_timestamp_ms(snapshot_ms);
            assert_eq!(expected_ms, 1_700_000_000_000 + rounded_offset);
            assert_eq!(listed.modified_ms, expected_ms);
            let mut expected = job(&path);
            expected.modified_at = listed.modified_ms as f64;
            assert!(parse_font_job(&expected, &options, || {}).is_ok(), "unchanged native listing rejected");
            expected.modified_at = snapshot_ms;
            assert_eq!(round_timestamp_ms(expected.modified_at), listed.modified_ms);
            assert!(parse_font_job(&expected, &options, || {}).is_ok(), "unchanged watcher snapshot rejected");
            if expected_ms == 1_700_000_000_001 {
                expected.modified_at = 1_700_000_000_000.0;
                assert!(parse_font_job(&expected, &options, || {}).is_err(), "stale truncated cache signature was reused");
            }
        }
    }

    #[test]
    fn pre_epoch_listing_and_batch_keep_signed_javascript_rounding() {
        let fixture = Fixture::new();
        let path = fixture.font("pre-epoch.ttf", FONT_HEADER);
        let options = FontFileScanOptions::default();
        for (before_ns, expected_ms) in [(400_000, 0), (500_000, 0), (700_000, -1), (999_000, -1), (1_500_000, -1)] {
            let time = UNIX_EPOCH - Duration::from_nanos(before_ns);
            set_modified(&path, time);
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!(metadata.modified().unwrap(), time);
            let listed = super::super::font_file::scan_font_file(&path, &metadata, &options).unwrap();
            assert_eq!(listed.modified_ms, expected_ms);
            let mut expected = job(&path);
            assert!(parse_font_job(&expected, &options, || {}).is_ok());
            let nanos = -(metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap_err().duration().as_nanos() as i128);
            expected.modified_at = (nanos / 1_000_000) as f64 + (nanos % 1_000_000) as f64 / 1_000_000.0;
            assert_eq!(round_timestamp_ms(expected.modified_at), listed.modified_ms);
            assert!(parse_font_job(&expected, &options, || {}).is_ok());
        }
    }

    #[test]
    fn pre_epoch_fractional_boundaries_match_signed_tree_snapshot_decoder() {
        let fixture = Fixture::new();
        let path = fixture.font("old-fractional.ttf", FONT_HEADER);
        let options = FontFileScanOptions::default();
        for (fraction_ns, rounded_offset) in [(499_800, 0), (499_900, 0), (500_000, 0),
            (500_100, 0), (500_200, -1), (700_000, -1), (999_000, -1)] {
            let time = UNIX_EPOCH - Duration::from_secs(1_700_000_000) - Duration::from_nanos(fraction_ns);
            set_modified(&path, time);
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!(metadata.modified().unwrap(), time);
            let nanos = -(metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap_err().duration().as_nanos() as i128);
            let snapshot_ms = (nanos / 1_000_000) as f64 + (nanos % 1_000_000) as f64 / 1_000_000.0;
            let listed = super::super::font_file::scan_font_file(&path, &metadata, &options).unwrap();
            assert_eq!(listed.modified_ms, -1_700_000_000_000 + rounded_offset);
            assert_eq!(round_timestamp_ms(snapshot_ms), listed.modified_ms);
            let mut expected = job(&path);
            expected.modified_at = snapshot_ms;
            assert!(parse_font_job(&expected, &options, || {}).is_ok());
        }
    }

    #[test]
    fn changed_before_parse_and_unreadable_sources_are_errors_not_bad_results() {
        let fixture = Fixture::new();
        let stale_path = fixture.font("changed.ttf", FONT_HEADER);
        let stale = job(&stale_path);
        fs::write(&stale_path, b"changed after listing and before batch admission").unwrap();
        let invalid_path = fixture.font("invalid.ttf", b"not a font");
        let invalid = job(&invalid_path);
        let missing_path = fixture.font("missing.ttf", FONT_HEADER);
        let missing = job(&missing_path);
        fs::remove_file(&missing_path).unwrap();
        let input = fixture.0.join("batch.json");
        fs::write(&input, json!({"jobs": [job_json(&stale), job_json(&invalid), job_json(&missing)]}).to_string()).unwrap();
        let output: Value = serde_json::from_str(&parse_font_batch(&FontParseBatchCommandConfig {
            input_path: input.to_string_lossy().into_owned(),
        }).unwrap()).unwrap();
        assert_eq!(output["ok"], true);
        assert_eq!(output["count"], 1);
        assert_eq!(output["results"].as_array().unwrap().len(), 1);
        assert_eq!(output["results"][0]["jobId"], invalid.job_id);
        assert_eq!(output["results"][0]["signatureValid"], false);
        assert!(!output["results"][0]["quickHash"].as_str().unwrap().is_empty());
        assert_eq!(output["errors"].as_array().unwrap().len(), 2);
        assert_eq!(output["errors"][0]["jobId"], stale.job_id);
        assert_eq!(output["errors"][1]["jobId"], missing.job_id);
        assert_eq!(fs::read(invalid_path).unwrap(), b"not a font");
    }

    #[test]
    fn source_pin_blocks_writers_and_rename_until_real_handle_release() {
        let fixture = Fixture::new();
        let path = fixture.font("pinned.ttf", FONT_HEADER);
        let moved = fixture.0.join("moved.ttf");
        let expected = job(&path);
        let options = FontFileScanOptions::default();
        let writer = fs::OpenOptions::new().write(true).share_mode(7).open(&path).unwrap();
        assert!(parse_font_job(&expected, &options, || {}).is_err(), "existing writer admitted");
        drop(writer);
        let entry = parse_font_job(&expected, &options, || {
            assert!(fs::OpenOptions::new().write(true).share_mode(7).open(&path).is_err());
            assert!(fs::rename(&path, &moved).is_err());
            assert!(File::open(&path).is_ok(), "read-only source pin blocked another reader");
        }).unwrap();
        assert!(entry.signature_valid);
        fs::rename(&path, &moved).unwrap();
        fs::rename(&moved, &path).unwrap();
        let writer = fs::OpenOptions::new().write(true).share_mode(7).open(&path).unwrap();
        drop(writer);
        assert_eq!(fs::read(&path).unwrap(), FONT_HEADER);
    }

    #[test]
    fn exact_post_read_metadata_rejects_change_within_the_same_rounded_millisecond() {
        let fixture = Fixture::new();
        let path = fixture.font("metadata-change.ttf", b"not a font");
        let base = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_modified(&path, base);
        let expected = job(&path);
        let error = parse_font_job(&expected, &FontFileScanOptions::default(), || {
            set_modified(&path, base + Duration::from_nanos(100_000));
        }).unwrap_err();
        assert!(error.to_string().contains("during parsing"));
        assert_eq!(job(&path).modified_at, expected.modified_at, "fixture crossed the rounded millisecond boundary");
        assert_eq!(fs::read(&path).unwrap(), b"not a font");
    }

    #[test]
    fn strict_handle_scan_does_not_turn_read_failure_into_invalid_signature() {
        let fixture = Fixture::new();
        let path = fixture.font("unreadable-handle.ttf", FONT_HEADER);
        let metadata = fs::metadata(&path).unwrap();
        let mut write_only = fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert!(scan_font_file_from_handle(&path, &mut write_only, &metadata, &FontFileScanOptions::default()).is_err());
        drop(write_only);
        assert_eq!(fs::read(&path).unwrap(), FONT_HEADER);
        let short = fixture.font("short.ttf", b"\0\x01");
        let entry = parse_font_job(&job(&short), &FontFileScanOptions::default(), || {}).unwrap();
        assert!(!entry.signature_valid, "readable short signature is definitively invalid");
    }

    #[test]
    fn stable_strict_scan_retains_quick_and_full_hash_modes() {
        let fixture = Fixture::new();
        let mut bytes = vec![0x5a; 150_000];
        bytes[..FONT_HEADER.len()].copy_from_slice(FONT_HEADER);
        let path = fixture.font("large.ttf", &bytes);
        let expected = job(&path);
        let quick = parse_font_job(&expected, &FontFileScanOptions::default(), || {}).unwrap();
        let full = parse_font_job(&expected, &FontFileScanOptions { full_hash: true, ..Default::default() }, || {}).unwrap();
        assert_eq!(quick.hash_kind, "quick-fnv1a64");
        assert_eq!(full.hash_kind, "full-fnv1a64");
        assert_eq!(quick.quick_hash, full.quick_hash);
        assert_eq!(quick.content_hash, quick.quick_hash);
        assert_ne!(full.content_hash, full.quick_hash);
        assert!(quick.signature_valid && full.signature_valid);
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    fn junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
            .arg(link).arg(target).output().unwrap();
        assert!(output.status.success(), "junction fixture failed: {output:?}");
    }

    #[test]
    fn redirected_junction_rejects_same_size_and_mtime_replacement() {
        let fixture = Fixture::new();
        let first = fixture.0.join("first");
        let second = fixture.0.join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("font.ttf"), FONT_HEADER).unwrap();
        fs::write(second.join("font.ttf"), FONT_HEADER).unwrap();
        let time = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_modified(&first.join("font.ttf"), time);
        set_modified(&second.join("font.ttf"), time);
        let link = fixture.0.join("fonts");
        junction(&link, &first);
        let path = link.join("font.ttf");
        let expected = job(&path);
        let error = parse_font_job(&expected, &FontFileScanOptions::default(), || {
            fs::remove_dir(&link).unwrap();
            junction(&link, &second);
        }).unwrap_err();
        assert!(error.to_string().contains("identity mismatch"));
        assert_eq!(job(&path).file_size, expected.file_size);
        assert_eq!(job(&path).modified_at, expected.modified_at);
        assert_eq!(fs::read(first.join("font.ttf")).unwrap(), FONT_HEADER);
        assert_eq!(fs::read(second.join("font.ttf")).unwrap(), FONT_HEADER);
        fs::remove_dir(&link).unwrap();
    }
}
