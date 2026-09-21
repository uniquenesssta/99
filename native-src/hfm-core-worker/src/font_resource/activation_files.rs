use std::fs;
use std::io::{Read, Write};
use std::collections::BTreeMap;
use super::activation_identity::{self, Identity};
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::types::FontResourceCommandConfig;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFilesPayload {
    #[serde(default)]
    copies: Vec<ActivationCopyJob>,
    #[serde(default)]
    inspects: Vec<String>,
    #[serde(default)]
    identities: BTreeMap<String, Identity>,
    #[serde(default)]
    registry_claims: Vec<ActivationRegistryClaim>,
    #[serde(default)]
    delete_registry_claims: bool,
    #[serde(default)]
    registry_expectations: BTreeMap<String, String>,
    #[serde(default)]
    require_missing: bool,
    #[serde(default)]
    restart_command: Option<String>,
    #[serde(default)]
    deletes: Vec<String>,
    #[serde(default)]
    allowed_delete_dir: String,
    #[serde(default)]
    allowed_name_prefix: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRegistryClaim {
    registry_name: String,
    install_path: String,
    session_id: String,
    identity: Option<Identity>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationCopyJob {
    id: String,
    source: String,
    dest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFileRow {
    id: String,
    source: String,
    dest: String,
    ok: bool,
    mode: String,
    message: String,
    identity: Option<Identity>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationDeleteRow {
    path: String,
    ok: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRegistryRow {
    registry_name: String,
    install_path: String,
    ok: bool,
    missing: bool,
    deleted: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFilesResult {
    ok: bool,
    copied: usize,
    reused: usize,
    deleted: usize,
    failed: usize,
    copy_results: Vec<ActivationFileRow>,
    inspect_results: Vec<ActivationInspectRow>,
    registry_results: Vec<ActivationRegistryRow>,
    delete_results: Vec<ActivationDeleteRow>,
    elapsed_ms: u128,
    worker_mode: &'static str,
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationInspectRow { path: String, identity: Option<Identity>, missing: bool, message: String }

pub fn run_font_activation_files(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: ActivationFilesPayload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if !payload.registry_expectations.is_empty() { return Err("legacy registry ownership contract rejected".into()); }
    if payload.require_missing && payload.registry_claims.is_empty() { return Err("missing cleanup target".into()); }
    if payload.require_missing && payload.delete_registry_claims { return Err("cannot delete while confirming missing cleanup target".into()); }
    let mut registry_results = Vec::with_capacity(payload.registry_claims.len());
    for claim in &payload.registry_claims {
        registry_results.push(verify_registry_claim(claim, &payload.allowed_delete_dir, &payload.allowed_name_prefix, payload.require_missing)?);
    }
    if payload.delete_registry_claims {
        registry_results.clear();
        for claim in &payload.registry_claims {
            registry_results.push(delete_registry_claim(claim, &payload.allowed_delete_dir, &payload.allowed_name_prefix)?);
        }
    }
    if let Some(command) = &payload.restart_command { super::windows::schedule_cleanup_restart(command)?; }
    let mut copied = 0usize;
    let mut reused = 0usize;
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut copy_results = Vec::new();
    let mut delete_results = Vec::new();

    for job in payload.copies {
        let row = if is_safe_delete_path(&job.dest, &payload.allowed_delete_dir, &payload.allowed_name_prefix) { copy_one(&job) } else { fail_copy(&job, "unsafe managed copy destination") };
        if row.ok && row.mode == "copied" {
            copied += 1;
        } else if row.ok && row.mode == "reused" {
            reused += 1;
        } else if !row.ok {
            failed += 1;
        }
        copy_results.push(row);
    }

    let inspect_results = payload.inspects.iter().map(|path| match if is_safe_delete_path(path, &payload.allowed_delete_dir, &payload.allowed_name_prefix) { activation_identity::inspect(Path::new(path)) } else { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "unsafe managed inspection path")) } {
        Ok(identity) => ActivationInspectRow { path:path.clone(), identity:Some(identity), missing:false, message:String::new() },
        Err(error) => ActivationInspectRow { path:path.clone(), identity:None, missing:error.kind()==std::io::ErrorKind::NotFound, message:error.to_string() },
    }).collect();
    for path in payload.deletes {
        let row = delete_one(&path, &payload.allowed_delete_dir, &payload.allowed_name_prefix, payload.identities.get(&path));
        if row.ok {
            deleted += 1;
        } else {
            failed += 1;
        }
        delete_results.push(row);
    }

    let result = ActivationFilesResult {
        ok: true,
        copied,
        reused,
        deleted,
        failed,
        copy_results,
        inspect_results,
        registry_results,
        delete_results,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-activation-files",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn validate_registry_claim_shape(claim: &ActivationRegistryClaim, allowed_dir: &str, prefix: &str) -> Result<(), String> {
    let session = claim.session_id.trim();
    let file_name = Path::new(&claim.install_path).file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let session_in_file = file_name.rsplit_once('.').map(|(stem, _)| stem.ends_with(&format!("_{}", session))).unwrap_or(false);
    if session.is_empty() || claim.registry_name.trim().is_empty()
        || !claim.registry_name.ends_with(&format!(" [{}]", session))
        || !session_in_file
        || !is_safe_delete_path(&claim.install_path, allowed_dir, prefix) {
        return Err("unsafe registry ownership request".into());
    }
    Ok(())
}

fn verify_registry_claim(claim: &ActivationRegistryClaim, allowed_dir: &str, prefix: &str, require_missing: bool) -> Result<ActivationRegistryRow, String> {
    validate_registry_claim_shape(claim, allowed_dir, prefix)?;
    if require_missing {
        if !super::windows::verify_registry_value(&claim.registry_name, &claim.install_path)? { return Err("registry value still exists".into()); }
        match fs::symlink_metadata(&claim.install_path) {
            Err(error) if error.kind()==std::io::ErrorKind::NotFound => {},
            Ok(_) => return Err("font file still exists".into()),
            Err(error) => return Err(error.to_string()),
        }
        return Ok(ActivationRegistryRow { registry_name:claim.registry_name.clone(), install_path:claim.install_path.clone(), ok:true, missing:true, deleted:false, message:"confirmed missing".into() });
    }
    let expected = claim.identity.as_ref().ok_or_else(|| "missing managed identity; manual review required".to_string())?;
    let actual = activation_identity::inspect(Path::new(&claim.install_path)).map_err(|error| error.to_string())?;
    if actual != *expected { return Err("managed font identity changed".into()); }
    if super::windows::verify_registry_value(&claim.registry_name, &claim.install_path)? { return Err("registry value missing; ownership cannot be confirmed".into()); }
    Ok(ActivationRegistryRow { registry_name:claim.registry_name.clone(), install_path:claim.install_path.clone(), ok:true, missing:false, deleted:false, message:"owned".into() })
}

fn delete_registry_claim(claim: &ActivationRegistryClaim, allowed_dir: &str, prefix: &str) -> Result<ActivationRegistryRow, String> {
    validate_registry_claim_shape(claim, allowed_dir, prefix)?;
    let expected = claim.identity.as_ref().ok_or_else(|| "missing managed identity; manual review required".to_string())?;
    let actual = activation_identity::inspect(Path::new(&claim.install_path)).map_err(|error| error.to_string())?;
    if actual != *expected { return Err("managed font identity changed".into()); }
    super::windows::delete_registry_value_if_owned(&claim.registry_name, &claim.install_path)?;
    Ok(ActivationRegistryRow { registry_name:claim.registry_name.clone(), install_path:claim.install_path.clone(), ok:true, missing:false, deleted:true, message:"deleted".into() })
}

fn copy_one(job: &ActivationCopyJob) -> ActivationFileRow {
    let source = Path::new(&job.source); let dest = Path::new(&job.dest);
    let result = (|| -> std::io::Result<(String, Identity)> {
        if same_path(source,dest) { return Err(std::io::Error::other("activation requires an independent managed copy")); }
        let source_identity = activation_identity::inspect(source)?;
        match activation_identity::inspect(dest) {
            Ok(identity) if identity.size == source_identity.size && identity.sha1 == source_identity.sha1 => return Ok(("reused".into(),identity)),
            Ok(_) => return Err(std::io::Error::other("destination has different contents")),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
        if let Some(parent)=dest.parent() { fs::create_dir_all(parent)?; }
        let temporary = dest.with_file_name(format!("{}.partial",dest.file_name().unwrap().to_string_lossy()));
        let mut output = fs::OpenOptions::new().write(true).read(true).create_new(true).open(&temporary)?;
        let publish = (|| -> std::io::Result<Identity> {
            let mut input=fs::File::open(source)?;
            let mut buffer=[0u8;65536];
            loop { let count=input.read(&mut buffer)?; if count==0 {break;} output.write_all(&buffer[..count])?; }
            output.sync_all()?;
            let copied = activation_identity::identify(&mut output)?;
            let after = activation_identity::inspect(source)?;
            if source_identity != after || copied.sha1 != source_identity.sha1 || copied.size != source_identity.size { return Err(std::io::Error::other("source changed or incomplete font copy")); }
            // Same-directory publication cannot overwrite a newly installed file.
            fs::hard_link(&temporary,dest)?;
            Ok(copied)
        })();
        drop(output);
        match publish {
            Ok(identity) => { let _ = activation_identity::remove_owned(&temporary, &identity); Ok(("copied".into(),identity)) },
            // The durable intent retains this exact partial path for manual identity review.
            Err(error) => Err(error),
        }
    })();
    match result {
        Ok((mode,identity)) => ActivationFileRow { id:job.id.clone(),source:job.source.clone(),dest:job.dest.clone(),ok:true,mode,message:"ok".into(),identity:Some(identity) },
        Err(error) => fail_copy(job,&error.to_string()),
    }
}

fn fail_copy(job: &ActivationCopyJob, message: &str) -> ActivationFileRow {
    ActivationFileRow { id: job.id.clone(), source: job.source.clone(), dest: job.dest.clone(), ok: false, mode: "failed".to_string(), message: message.to_string(), identity: None }
}

fn delete_one(path: &str, allowed_dir: &str, prefix: &str, identity: Option<&Identity>) -> ActivationDeleteRow {
    if !is_safe_delete_path(path, allowed_dir, prefix) {
        return ActivationDeleteRow { path: path.to_string(), ok: false, message: "unsafe temporary font path".to_string() };
    }
    let Some(identity) = identity else { return ActivationDeleteRow {path:path.into(),ok:false,message:"missing managed identity; manual review required".into()}; };
    match activation_identity::remove_owned(Path::new(path),identity) {
        Ok(_) => ActivationDeleteRow { path: path.to_string(), ok: true, message: "ok".to_string() },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ActivationDeleteRow { path: path.to_string(), ok: true, message: "already missing".to_string() },
        Err(error) => ActivationDeleteRow { path: path.to_string(), ok: false, message: error.to_string() },
    }
}

fn is_safe_delete_path(path: &str, allowed_dir: &str, prefix: &str) -> bool {
    if allowed_dir.trim().is_empty() || prefix.trim().is_empty() {
        return false;
    }
    let path_key = normalize_for_compare(path);
    let dir_key = normalize_for_compare(allowed_dir);
    let file_name = Path::new(path).file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let parent = Path::new(path).parent().map(|value| normalize_for_compare(&value.to_string_lossy())).unwrap_or_default();
    let canonical_parent = Path::new(path).parent().and_then(|value| value.canonicalize().ok());
    let canonical_allowed = Path::new(allowed_dir).canonicalize().ok();
    #[cfg(windows)]
    if !canonical_allowed.as_ref().is_some_and(|value| matches!(value.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))) { return false; }
    !path_key.is_empty() && parent == dir_key && file_name.starts_with(prefix)
        && canonical_parent.is_some() && canonical_parent == canonical_allowed
}

fn same_path(a: &Path, b: &Path) -> bool {
    normalize_for_compare(&a.to_string_lossy()) == normalize_for_compare(&b.to_string_lossy())
}

fn normalize_for_compare(value: &str) -> String {
    value.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("hfm-activation-{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn job(&self) -> ActivationCopyJob {
            ActivationCopyJob { id: "font".into(), source: self.0.join("source.ttf").to_string_lossy().into(), dest: self.0.join("HFM_ACTIVE_font.ttf").to_string_lossy().into() }
        }
    }
    impl Drop for Directory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn copy_is_complete_independent_and_does_not_overwrite() {
        let dir = Directory::new(); let job = dir.job();
        fs::write(&job.source, b"font content").unwrap();
        let row = copy_one(&job); assert!(row.ok, "{}", row.message);
        let source = activation_identity::inspect(Path::new(&job.source)).unwrap();
        let copied = row.identity.unwrap();
        assert_eq!(source.sha1, copied.sha1); assert_eq!(source.size, copied.size);
        assert_ne!(source.inode, copied.inode);
        assert_eq!(copy_one(&job).mode, "reused");
        fs::write(&job.source, b"new source").unwrap();
        assert!(!copy_one(&job).ok); assert_eq!(fs::read(&job.dest).unwrap(), b"font content");
        assert!(!Path::new(&format!("{}.partial", job.dest)).exists());
    }
    #[test]
    fn replaced_identical_file_and_neighbor_are_preserved() {
        let dir = Directory::new(); let job = dir.job();
        fs::write(&job.source, b"same bytes").unwrap();
        let original = copy_one(&job).identity.unwrap();
        fs::rename(&job.dest, format!("{}.old", job.dest)).unwrap();
        fs::write(&job.dest, b"same bytes").unwrap();
        let result = delete_one(&job.dest, &dir.0.to_string_lossy(), "HFM_ACTIVE_", Some(&original));
        assert!(!result.ok); assert_eq!(fs::read(&job.dest).unwrap(), b"same bytes");
        assert!(!delete_one(&job.source, &dir.0.to_string_lossy(), "HFM_ACTIVE_", Some(&original)).ok);
        let current = activation_identity::inspect(Path::new(&job.dest)).unwrap();
        assert!(delete_one(&job.dest, &dir.0.to_string_lossy(), "HFM_ACTIVE_", Some(&current)).ok);
        assert!(!Path::new(&job.dest).exists());
    }
    #[test]
    fn foreign_partial_and_same_source_destination_are_not_modified() {
        let dir = Directory::new(); let mut job = dir.job();
        fs::write(&job.source, b"source").unwrap();
        let partial = format!("{}.partial", job.dest);
        fs::write(&partial, b"foreign partial").unwrap();
        assert!(!copy_one(&job).ok); assert_eq!(fs::read(&partial).unwrap(), b"foreign partial");
        assert!(!Path::new(&job.dest).exists());
        job.dest = job.source.clone(); assert!(!copy_one(&job).ok);
        assert_eq!(fs::read(&job.source).unwrap(), b"source");
    }
    #[test]
    fn deletion_without_identity_is_never_accepted() {
        let dir = Directory::new(); let job = dir.job();
        fs::write(&job.dest, b"owned-looking only").unwrap();
        assert!(!delete_one(&job.dest, &dir.0.to_string_lossy(), "HFM_ACTIVE_", None).ok);
        assert!(Path::new(&job.dest).exists());
    }
}
