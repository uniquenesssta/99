// Local redirector identity lookup. Never opens the remote share or enumerates files.
#[cfg(windows)]
pub fn query() -> Result<String, String> {
    #[link(name = "mpr")]
    extern "system" { fn WNetGetConnectionW(local: *const u16, remote: *mut u16, length: *mut u32) -> u32; }
    let mut rows = Vec::new();
    for letter in b'A'..=b'Z' {
        let local = [letter as u16, b':' as u16, 0];
        let mut remote = vec![0u16; 32768];
        let mut length = remote.len() as u32;
        let status = unsafe { WNetGetConnectionW(local.as_ptr(), remote.as_mut_ptr(), &mut length) };
        match status {
            0 => {
                let end = remote.iter().position(|&c| c == 0).ok_or("unterminated mapping")?;
                let name = String::from_utf16(&remote[..end]).map_err(|_| "invalid mapping Unicode")?;
                if !name.starts_with("\\\\") { return Err("non-UNC mapping".into()); }
                rows.push(serde_json::json!({"drive": format!("{}:", letter as char), "remote": name}));
            }
            2250 | 1200 => {}, // NOT_CONNECTED / BAD_DEVICE: no redirection for this letter.
            // An unknown/disconnected identity is never silently treated as local.
            other => return Err(format!("mapped drive {}: query failed: {}", letter as char, other)),
        }
    }
    serde_json::to_string(&rows).map_err(|e| e.to_string())
}
#[cfg(not(windows))]
pub fn query() -> Result<String, String> { Ok("[]".into()) }
