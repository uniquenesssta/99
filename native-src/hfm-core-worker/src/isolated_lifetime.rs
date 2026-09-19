// Only dedicated application children receive HFM_PARENT_PID. A daemon launched
// normally retains its existing lifecycle; no unrelated process is terminated.
pub fn watch_parent() -> Result<(), String> {
    let Ok(value) = std::env::var("HFM_PARENT_PID") else { return Ok(()); };
    let parent: u32 = value.parse().map_err(|_| "invalid parent pid")?;
    if parent == 0 || parent == std::process::id() { return Err("invalid parent identity".into()); }
    watch(parent)
}
#[cfg(windows)]
fn watch(parent: u32) -> Result<(), String> {
    type Handle = *mut std::ffi::c_void;
    #[link(name="kernel32")]
    extern "system" {
        fn OpenProcess(access:u32, inherit:i32, pid:u32) -> Handle;
        fn WaitForSingleObject(handle:Handle, timeout:u32) -> u32;
        fn GetCurrentProcess() -> Handle;
        fn TerminateProcess(handle:Handle, code:u32) -> i32;
    }
    let handle=unsafe { OpenProcess(0x00100000,0,parent) };
    if handle.is_null() { return Err("cannot acquire parent process lifetime".into()); }
    let handle=handle as usize;
    std::thread::Builder::new().name("shared-parent-lifetime".into()).spawn(move || {
        unsafe { WaitForSingleObject(handle as Handle,u32::MAX); TerminateProcess(GetCurrentProcess(),70); }
    }).map_err(|error| error.to_string())?;
    Ok(())
}
#[cfg(unix)]
fn watch(parent: u32) -> Result<(), String> {
    extern "C" { fn getppid() -> i32; fn kill(pid:i32, signal:i32) -> i32; }
    if unsafe { getppid() } as u32 != parent { return Err("parent already exited".into()); }
    std::thread::Builder::new().name("shared-parent-lifetime".into()).spawn(move || loop {
        if unsafe { getppid() } as u32 != parent { unsafe { kill(std::process::id() as i32,9); } break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }).map_err(|error| error.to_string())?;
    Ok(())
}
#[cfg(not(any(unix,windows)))]
fn watch(_parent:u32) -> Result<(), String> { Err("isolated lifetime is unavailable".into()) }

#[cfg(test)]
mod tests {
    use std::{fs, process::{Command, Stdio}, thread, time::{Duration, Instant}};

    // Re-enter this test binary as a parent and a blocked child. No application
    // font/registry operation is used; the real OS parent-lifetime owner runs.
    #[test]
    fn lifetime_fixture() {
        let Ok(mode)=std::env::var("HFM_LIFETIME_TEST_MODE") else {return};
        if mode=="parent" {
            let mut child=Command::new(std::env::current_exe().unwrap());
            child.args(["--exact","isolated_lifetime::tests::lifetime_fixture","--nocapture"])
                .env("HFM_LIFETIME_TEST_MODE","child").env("HFM_PARENT_PID",std::process::id().to_string())
                .stdout(Stdio::null()).stderr(Stdio::null());
            let mut child=child.spawn().unwrap();
            let _=child.wait();
        } else {
            super::watch_parent().unwrap();
            fs::write(std::env::var("HFM_LIFETIME_TEST_READY").unwrap(),std::process::id().to_string()).unwrap();
            loop {thread::park();}
        }
    }

    #[test]
    fn blocked_child_terminates_when_its_parent_dies() {
        let ready=std::env::temp_dir().join(format!("hfm-parent-proof-{}-{}.pid",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut parent=Command::new(std::env::current_exe().unwrap())
            .args(["--exact","isolated_lifetime::tests::lifetime_fixture","--nocapture"])
            .env("HFM_LIFETIME_TEST_MODE","parent").env("HFM_LIFETIME_TEST_READY",&ready)
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let deadline=Instant::now()+Duration::from_secs(10);
        let child=loop {
            if let Ok(value)=fs::read_to_string(&ready) {if let Ok(pid)=value.parse::<u32>() {break Some(pid)}}
            if Instant::now()>=deadline {break None}
            thread::sleep(Duration::from_millis(20));
        };
        parent.kill().unwrap();parent.wait().unwrap();
        let _=fs::remove_file(ready);
        let child=child.expect("child lifetime guardian did not become ready");
        let deadline=Instant::now()+Duration::from_secs(5);
        while running(child) && Instant::now()<deadline {thread::sleep(Duration::from_millis(20));}
        assert!(!running(child),"isolated child survived its parent");
    }
    #[cfg(windows)]
    fn running(pid:u32)->bool {
        type Handle=*mut std::ffi::c_void;
        #[link(name="kernel32")]
        extern "system" {fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;fn WaitForSingleObject(handle:Handle,timeout:u32)->u32;fn CloseHandle(handle:Handle)->i32;}
        unsafe {let handle=OpenProcess(0x00100000,0,pid);if handle.is_null(){return false}let live=WaitForSingleObject(handle,0)==258;CloseHandle(handle);live}
    }
    #[cfg(unix)]
    fn running(pid:u32)->bool {
        if let Ok(stat)=fs::read_to_string(format!("/proc/{pid}/stat")) {return stat.rsplit_once(") ").map(|(_,tail)|!tail.starts_with('Z')).unwrap_or(true)}
        extern "C" {fn kill(pid:i32,signal:i32)->i32;}
        unsafe {kill(pid as i32,0)==0}
    }
}
