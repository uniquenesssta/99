// A dedicated command owns this contract: no write until the base is proven
// local, then only one exclusive subtree. Handles pin that proof through GDI.
use std::{fs::{self, File, OpenOptions}, io, os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle}, path::{Path, PathBuf}};
use serde::Serialize;
use super::types::OwnedPreviewStageRequest;

#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(file: *mut std::ffi::c_void, path: *mut u16, size: u32, flags: u32) -> u32;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedPreviewStageProof {
    pub version: u32,
    pub token: String,
    pub base_path: String,
    pub directory_path: String,
    pub output_path: String,
}

pub struct PreparedOwnedPreviewStage {
    pub proof: OwnedPreviewStageProof,
    _base: File,
    _directory: File,
}

fn local_path(raw: &str, system_drive: &str, canonical: bool) -> Result<String, String> {
    let raw = if canonical { raw.strip_prefix(r"\\?\").unwrap_or(raw) } else { raw };
    let mut path = raw.replace('/', "\\");
    let bytes = path.as_bytes();
    if path.len() > 2048 || bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\'
        || !path[..2].eq_ignore_ascii_case(system_drive) || path[2..].contains(':') || path.contains('\0')
        || path.split('\\').skip(1).any(|part| part == "." || part == ".." || part.ends_with('.') || part.ends_with(' ')) {
        return Err("owned preview stage requires an unambiguous local SystemDrive path".into());
    }
    while path.len() > 3 && path.ends_with('\\') { path.pop(); }
    Ok(path)
}
fn key(path: &str) -> String { path.strip_prefix(r"\\?\").unwrap_or(path).replace('/', "\\").trim_end_matches('\\').to_lowercase() }
fn excluded(path: &str, roots: &[String]) -> bool {
    let path = key(path);
    roots.iter().any(|root| { let root = key(root); path == root || path.starts_with(&(root + "\\")) })
}
fn pin_directory(path: &Path) -> Result<(File, String), String> {
    // GENERIC_READ participates in Windows sharing checks; metadata-only
    // FILE_READ_ATTRIBUTES does not prevent stage rename (CI regression).
    // Only FILE_SHARE_READ: existing writers and later rename/reparse writes fail.
    let file = OpenOptions::new().access_mode(0x8000_0000).share_mode(1)
        .custom_flags(0x0200_0000 | 0x0020_0000).open(path).map_err(|e| format!("owned preview directory pin failed: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 { return Err("owned preview directory is a reparse point or not a directory".into()); }
    let mut buffer = vec![0u16; 32768];
    let size = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if size == 0 || size as usize >= buffer.len() { return Err(format!("owned preview directory identity unavailable: {}", io::Error::last_os_error())); }
    Ok((file, String::from_utf16_lossy(&buffer[..size as usize])))
}
fn token_valid(token: &str) -> bool {
    token.len() == 36 && token.bytes().enumerate().all(|(index, byte)| {
        if [8,13,18,23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    })
}
impl PreparedOwnedPreviewStage {
    pub fn prepare(input: &OwnedPreviewStageRequest, requested_output: &str) -> Result<Self, String> {
        let system = std::env::var("SystemDrive").map_err(|_| "SystemDrive is unavailable".to_string())?;
        if system.len() != 2 || !system.as_bytes()[0].is_ascii_alphabetic() || !system.ends_with(':')
            || !token_valid(&input.token) || input.excluded_roots.len() > 1024 {
            return Err("invalid owned preview stage identity".into());
        }
        let lexical = local_path(&input.base_path, &system, false)?;
        let leaf = format!(".hfm-preview-stage-{}", input.token);
        let expected = Path::new(&lexical).join(&leaf).join("preview.png");
        if key(requested_output) != key(&expected.to_string_lossy()) || excluded(&lexical, &input.excluded_roots) {
            return Err("owned preview requested output is outside its reservation".into());
        }
        // All operations above and canonicalize/pin below are reads. A redirected
        // UNC temp is refused before create_dir or the legacy renderer can write.
        let canonical = fs::canonicalize(&lexical).map_err(|e| format!("owned preview base unavailable: {e}"))?;
        let canonical = local_path(&canonical.to_string_lossy(), &system, true)?;
        let (base, physical) = pin_directory(Path::new(&canonical))?;
        let physical = local_path(&physical, &system, true)?;
        if key(&physical) != key(&canonical) || excluded(&physical, &input.excluded_roots) {
            return Err("owned preview base identity changed or overlaps a configured root".into());
        }
        let directory = PathBuf::from(&physical).join(&leaf);
        fs::create_dir(&directory).map_err(|e| format!("owned preview exclusive directory creation failed: {e}"))?;
        // If confirmation fails, retain the unconfirmed unique directory. Never
        // recursively remove a guessed or colliding path as a recovery action.
        let (directory_handle, directory_physical) = pin_directory(&directory)?;
        let directory_physical = local_path(&directory_physical, &system, true)?;
        if key(&directory_physical) != key(&directory.to_string_lossy()) { return Err("owned preview stage identity changed".into()); }
        let output = Path::new(&directory_physical).join("preview.png");
        Ok(Self { proof: OwnedPreviewStageProof { version: 1, token: input.token.clone(), base_path: physical,
            directory_path: directory_physical, output_path: output.to_string_lossy().into_owned() }, _base: base, _directory: directory_handle })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture { fn new() -> Self { let path = std::env::temp_dir().join(format!("hfm-owned-stage-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())); fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn request(base: &Path) -> (OwnedPreviewStageRequest, String) {
        let token = "00000000-0000-4000-8000-000000000001".to_string();
        let output = base.join(format!(".hfm-preview-stage-{token}")).join("preview.png").to_string_lossy().into_owned();
        (OwnedPreviewStageRequest { base_path: base.to_string_lossy().into_owned(), token, excluded_roots: vec![] }, output)
    }
    #[test]
    fn owned_preview_stage_pins_real_directories() {
        let fixture = Fixture::new(); let (request, output) = request(&fixture.0);
        let stage = PreparedOwnedPreviewStage::prepare(&request, &output).unwrap();
        assert!(fs::rename(&fixture.0, fixture.0.with_extension("renamed")).is_err());
        assert!(fs::rename(&stage.proof.directory_path, fixture.0.join("redirected")).is_err());
        assert!(OpenOptions::new().access_mode(0x4000_0000).share_mode(7).custom_flags(0x0200_0000 | 0x0020_0000).open(&stage.proof.directory_path).is_err(), "writable reparse handle admitted");
        fs::write(&stage.proof.output_path, b"owned").unwrap();
        drop(stage);
        // The exact same rename succeeds after release: denial must come from
        // the live pin, not unrelated ACL/fixture permissions.
        let directory = Path::new(&output).parent().unwrap();
        let renamed = fixture.0.join("redirected");
        fs::rename(directory, &renamed).unwrap();
        fs::rename(&renamed, directory).unwrap();
        assert!(PreparedOwnedPreviewStage::prepare(&request, &output).is_err(), "existing reservation reused");
        assert_eq!(fs::read(&output).unwrap(), b"owned");
    }
    #[test]
    fn owned_preview_stage_rejects_unsafe_targets_before_write() {
        let fixture = Fixture::new(); let (request, output) = request(&fixture.0);
        for token in ["..", "a/b", "a\\b", "x:stream", "\\\\server\\share"] {
            let mut bad = request.clone(); bad.token = token.into(); assert!(PreparedOwnedPreviewStage::prepare(&bad, &output).is_err());
        }
        for base in ["\\\\server\\share", "\\\\?\\C:\\Temp", "C:\\Temp\\..", "relative", "C:\\Temp:stream"] {
            let mut bad = request.clone(); bad.base_path = base.into(); assert!(PreparedOwnedPreviewStage::prepare(&bad, &output).is_err());
        }
        let mut excluded = request.clone(); excluded.excluded_roots.push(request.base_path.clone());
        assert!(PreparedOwnedPreviewStage::prepare(&excluded, &output).is_err());
        assert!(PreparedOwnedPreviewStage::prepare(&request, &fixture.0.join("other.png").to_string_lossy()).is_err());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
    #[test]
    fn owned_preview_stage_resolves_local_junction_without_following_later_swaps() {
        let fixture = Fixture::new(); let target = fixture.0.join("target"); fs::create_dir(&target).unwrap();
        let junction = fixture.0.join("junction");
        let status = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&target).status().unwrap();
        assert!(status.success(), "real directory junction fixture failed");
        let (request, output) = request(&junction);
        let stage = PreparedOwnedPreviewStage::prepare(&request, &output).unwrap();
        assert!(key(&stage.proof.base_path).ends_with("\\target"));
        assert!(fs::rename(&target, fixture.0.join("replacement")).is_err());
        // Swapping the lexical junction cannot redirect the canonical pinned stage.
        fs::remove_dir(&junction).unwrap();
        let other = fixture.0.join("other"); fs::create_dir(&other).unwrap();
        let status = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&junction).arg(&other).status().unwrap();
        assert!(status.success());
        fs::write(&stage.proof.output_path, b"canonical").unwrap();
        assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
        drop(stage);
        fs::remove_dir(&junction).unwrap();
    }
}
