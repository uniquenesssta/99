//! A dedicated, parent-owned process. Notifications are hints, never a file inventory.
use std::io::{self, Write};

fn receipt(kind: &str) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{{\"protocol\":1,\"type\":\"{kind}\"}}")?;
    out.flush()
}

fn change_receipt(paths: &std::collections::BTreeSet<String>) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &serde_json::json!({"protocol":1,"type":"change","paths":paths})).map_err(io::Error::other)?;
    writeln!(out)?;
    out.flush()
}

pub fn run(path: &str) -> i32 {
    if path.is_empty() || path.contains('\0') || !std::path::Path::new(path).is_absolute() {
        let _ = receipt("error");
        return 2;
    }
    match watch(path) {
        Ok(()) => 0,
        Err(_) => { let _ = receipt("error"); 2 },
    }
}

#[cfg(not(windows))]
fn watch(_path: &str) -> io::Result<()> { Err(io::Error::other("Windows notifications required")) }

/// Validate FILE_NOTIFY_INFORMATION before looking at names. A malformed record is overflow.
fn notification_paths(bytes: &[u8]) -> Result<(std::collections::BTreeSet<String>, bool), ()> {
    if bytes.is_empty() { return Err(()); }
    let mut offset = 0usize;
    let mut paths = std::collections::BTreeSet::new();
    let mut total_bytes = 0;
    let mut overflow = false;
    loop {
        let header = bytes.get(offset..offset.checked_add(12).ok_or(())?).ok_or(())?;
        let next = u32::from_le_bytes(header[0..4].try_into().map_err(|_| ())?) as usize;
        let action = u32::from_le_bytes(header[4..8].try_into().map_err(|_| ())?);
        let size = u32::from_le_bytes(header[8..12].try_into().map_err(|_| ())?) as usize;
        if !(1..=5).contains(&action) || size == 0 || size % 2 != 0 { return Err(()); }
        let end = offset.checked_add(12).and_then(|n| n.checked_add(size)).ok_or(())?;
        let name = bytes.get(offset + 12..end).ok_or(())?;
        let utf16: Vec<u16> = name.chunks_exact(2).map(|part| u16::from_le_bytes([part[0], part[1]])).collect();
        let name = String::from_utf16(&utf16).map_err(|_| ())?.replace('\\', "/");
        let parts: Vec<&str> = name.split('/').collect();
        if name.contains(['\0', ':']) || parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") { return Err(()); }
        // Font cache and hidden-directory writes must not create a notification feedback loop.
        let leaf = parts.last().copied().unwrap_or("");
        let font_leaf = [".ttf", ".otf", ".ttc", ".otc"].iter().any(|extension| leaf.to_ascii_lowercase().ends_with(extension));
        let ignored = parts[..parts.len() - 1].iter().any(|part| part.starts_with('.') || *part == "node_modules")
            || leaf == "node_modules" || leaf.starts_with("._") || (leaf.starts_with('.') && !font_leaf);
        if !ignored && !paths.contains(&name) {
            if paths.len() < 64 && name.len() <= 1024 && total_bytes + name.len() <= 7000 {
                total_bytes += name.len(); paths.insert(name);
            } else { overflow = true; }
        }
        if next == 0 { return Ok((paths, overflow)); }
        if next % 4 != 0 || next < 12 + size { return Err(()); }
        offset = offset.checked_add(next).ok_or(())?;
        if offset >= bytes.len() { return Err(()); }
    }
}

#[cfg(windows)]
fn watch(path: &str) -> io::Result<()> {
    use std::{ffi::c_void, fs::OpenOptions, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, ptr, time::{Duration, Instant}};
    type Handle = *mut c_void;
    #[repr(C)]
    struct Overlapped { internal: usize, internal_high: usize, offset: u32, offset_high: u32, event: Handle }
    type Completion = Option<unsafe extern "system" fn(u32, u32, *mut Overlapped)>;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateEventW(attributes: *const c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> Handle;
        fn ResetEvent(event: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
        fn ReadDirectoryChangesW(directory: Handle, buffer: *mut c_void, size: u32, subtree: i32, filter: u32, returned: *mut u32, overlapped: *mut Overlapped, completion: Completion) -> i32;
        fn GetOverlappedResult(file: Handle, overlapped: *mut Overlapped, transferred: *mut u32, wait: i32) -> i32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
    }
    // FILE_LIST_DIRECTORY; share read/write/delete; BACKUP_SEMANTICS + OVERLAPPED.
    // Opening a disconnected share can block here; the parent owns a 5-second kill deadline.
    let directory = OpenOptions::new().access_mode(1).share_mode(7).custom_flags(0x0200_0000 | 0x4000_0000).open(path)?;
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() { return Err(io::Error::last_os_error()); }
    struct Event(Handle);
    impl Drop for Event { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    let _event = Event(event);
    let mut overlapped = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event };
    // DWORD aligned and below SMB's 64KiB maximum. Never allocate per filename on the parent.
    let mut buffer = [0u32; 8192];
    let mut pending = false;
    let mut registered = false;
    let mut dirty = false;
    let mut overflow = false;
    let mut paths = std::collections::BTreeSet::new();
    let mut path_bytes = 0;
    let mut last_message = Instant::now();
    let mut last_change = Instant::now() - Duration::from_secs(1);
    let result = (|| -> io::Result<()> {
        loop {
            if !pending {
                unsafe { ResetEvent(event); }
                let ok = unsafe { ReadDirectoryChangesW(directory.as_raw_handle(), buffer.as_mut_ptr().cast(), std::mem::size_of_val(&buffer) as u32, 1,
                    0x0000_0001 | 0x0000_0002 | 0x0000_0008 | 0x0000_0010, ptr::null_mut(), &mut overlapped, None) };
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(997) { return Err(error); }
                }
                pending = true;
                if !registered { receipt("registered")?; registered = true; }
            }
            let elapsed = last_change.elapsed();
            if (dirty || overflow) && elapsed >= Duration::from_millis(250) {
                if overflow { receipt("overflow")?; }
                if !paths.is_empty() { change_receipt(&paths)?; }
                paths.clear(); path_bytes = 0;
                dirty = false; overflow = false;
                last_change = Instant::now(); last_message = Instant::now();
            }
            if last_message.elapsed() >= Duration::from_secs(5) { receipt("heartbeat")?; last_message = Instant::now(); }
            match unsafe { WaitForSingleObject(event, 100) } {
                258 => continue,
                0 => {},
                _ => return Err(io::Error::last_os_error()),
            }
            let mut transferred = 0u32;
            let ok = unsafe { GetOverlappedResult(directory.as_raw_handle(), &mut overlapped, &mut transferred, 0) };
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(996) { continue; }
                pending = false;
                if error.raw_os_error() == Some(1022) { overflow = true; continue; }
                return Err(error);
            }
            pending = false;
            if transferred == 0 || transferred as usize > std::mem::size_of_val(&buffer) { overflow = true; continue; }
            let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), transferred as usize) };
            match notification_paths(bytes) {
                Ok((found, incomplete)) => {
                    overflow |= incomplete;
                    for name in found {
                        if paths.contains(&name) { continue; }
                        if paths.len() < 64 && path_bytes + name.len() <= 7000 { path_bytes += name.len(); paths.insert(name); dirty = true; }
                        else { overflow = true; }
                    }
                },
                Err(()) => overflow = true,
            }
        }
    })();
    if pending {
        // Cancellation alone does not release OVERLAPPED storage. Wait until the OS is done.
        // If a provider stalls, the parent kill deadline/parent-lifetime guardian owns termination.
        unsafe { CancelIoEx(directory.as_raw_handle(), &mut overlapped); }
        let mut transferred = 0;
        unsafe { GetOverlappedResult(directory.as_raw_handle(), &mut overlapped, &mut transferred, 1); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::notification_paths;
    fn relevant_changes(bytes: &[u8]) -> Result<bool, ()> { notification_paths(bytes).map(|(paths, overflow)| !paths.is_empty() || overflow) }
    fn record(name: &str, action: u32) -> Vec<u8> {
        let name: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut bytes = Vec::new();
        bytes.extend(0u32.to_le_bytes()); bytes.extend(action.to_le_bytes()); bytes.extend((name.len() as u32).to_le_bytes()); bytes.extend(name); bytes
    }
    #[test]
    fn notification_names_are_bounded_hints() {
        assert_eq!(relevant_changes(&record("family\\font.ttf", 1)), Ok(true));
        assert_eq!(relevant_changes(&record("old-name", 4)), Ok(true));
        assert_eq!(relevant_changes(&record(".hfm\\index.sqlite", 3)), Ok(false));
        assert_eq!(relevant_changes(&record(".visible-font.ttf", 3)), Ok(true));
        assert_eq!(relevant_changes(&record(".hidden/font.ttf", 3)), Ok(false));
        assert_eq!(relevant_changes(&record("._font.ttf", 3)), Ok(false));
        assert_eq!(relevant_changes(&record("..\\escape.ttf", 1)), Err(()));
        assert_eq!(relevant_changes(&record("font.ttf", 9)), Err(()));
        assert_eq!(relevant_changes(&[]), Err(()));
        let mut malformed = record("font.ttf", 1); malformed[0..4].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(relevant_changes(&malformed), Err(()));
        let mut malformed = record("font.ttf", 1); malformed.pop();
        assert_eq!(relevant_changes(&malformed), Err(()));
        let (paths, overflow) = notification_paths(&record("family\\font.ttf", 3)).unwrap();
        assert!(!overflow); assert_eq!(paths.into_iter().collect::<Vec<_>>(), ["family/font.ttf"]);
        let (paths, overflow) = notification_paths(&record(&"a".repeat(1025), 3)).unwrap();
        assert!(overflow); assert!(paths.is_empty());
        let mut many = Vec::new();
        for index in 0..100 {
            let mut row = record(&format!("font-{index}.ttf"), 3);
            if index != 99 {
                while row.len() % 4 != 0 { row.push(0); }
                let length = row.len() as u32;
                row[0..4].copy_from_slice(&length.to_le_bytes());
            }
            many.extend(row);
        }
        let (paths, overflow) = notification_paths(&many).unwrap();
        assert!(overflow); assert_eq!(paths.len(), 64, "overflow must retain the bounded concrete path hints");
    }

    #[cfg(windows)]
    #[test]
    fn notification_process_fixture() {
        let Ok(path) = std::env::var("HFM_NOTIFICATION_TEST_ROOT") else { return; };
        crate::isolated_lifetime::watch_parent().unwrap();
        assert_eq!(super::run(&path), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_notification_child_observes_bursts_and_closes() {
        use std::{fs, io::{BufRead, BufReader}, process::{Child, Command, Stdio}, sync::mpsc, thread, time::{Duration, SystemTime, UNIX_EPOCH}};
        let directory = std::env::temp_dir().join(format!("hfm-notification-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        struct Owned { child: Child, directory: std::path::PathBuf }
        impl Drop for Owned {
            fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = fs::remove_dir_all(&self.directory); }
        }
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "watcher::notifications::tests::notification_process_fixture", "--nocapture"])
            .env("HFM_NOTIFICATION_TEST_ROOT", &directory).env("HFM_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut owned = Owned { child, directory };
        let stdout = owned.child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("\"type\":") && send.send(line).is_err() { break; }
            }
        });
        let ready = receive.recv_timeout(Duration::from_secs(10)).expect("native directory watcher did not register");
        assert!(ready.contains("\"type\":\"registered\""), "unexpected watcher startup receipt");
        fs::create_dir(owned.directory.join(".hfm")).unwrap();
        fs::write(owned.directory.join(".hfm/index.sqlite"), b"controlled cache").unwrap();
        assert!(receive.recv_timeout(Duration::from_millis(600)).is_err(), "internal cache write generated a root event");
        for index in 0..32 { fs::write(owned.directory.join(format!("controlled-{index}.ttf")), b"controlled fixture").unwrap(); }
        let changed = receive.recv_timeout(Duration::from_secs(5)).expect("native directory watcher did not deliver a burst");
        assert!(changed.contains("\"type\":\"change\""), "unexpected watcher change receipt");
        owned.child.kill().unwrap(); owned.child.wait().unwrap();
        reader.join().unwrap();
        assert!(owned.child.try_wait().unwrap().is_some(), "physical process close was not observed");
    }
}
