// Read-only Restart Manager query. The caller runs this in a disposable process
// with a deadline, after the mutation worker has released its own file handles.
use serde_json::{json, Value};
use std::{io, os::windows::ffi::OsStrExt, path::Path, ptr};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileTime { low:u32, high:u32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct UniqueProcess { pid:u32, started:FileTime }
#[repr(C)]
#[derive(Clone, Copy)]
struct ProcessInfo {
    process:UniqueProcess,
    app_name:[u16;256],
    service_name:[u16;64],
    app_type:u32,
    status:u32,
    session:u32,
    restartable:i32,
}
#[link(name="rstrtmgr")]
extern "system" {
    fn RmStartSession(session:*mut u32,flags:u32,key:*mut u16)->u32;
    fn RmRegisterResources(session:u32,files:u32,names:*const *const u16,apps:u32,processes:*const UniqueProcess,services:u32,service_names:*const *const u16)->u32;
    fn RmGetList(session:u32,needed:*mut u32,count:*mut u32,processes:*mut ProcessInfo,reboot_reasons:*mut u32)->u32;
    fn RmEndSession(session:u32)->u32;
}
struct Session(u32);
impl Drop for Session {fn drop(&mut self){unsafe{RmEndSession(self.0);}}}
fn checked(code:u32)->io::Result<()> {if code==0{Ok(())}else{Err(io::Error::from_raw_os_error(code as i32))}}
fn text(units:&[u16])->String {
    String::from_utf16_lossy(&units[..units.iter().position(|c|*c==0).unwrap_or(units.len())])
}
fn query(target:&str)->io::Result<Value> {
    if target.contains('\0') || target.len()>32000 || !Path::new(target).is_absolute() {
        return Err(io::Error::other("invalid diagnostic path"));
    }
    let mut handle=0;let mut session_key=[0u16;33];
    unsafe{checked(RmStartSession(&mut handle,0,session_key.as_mut_ptr()))?;}
    let session=Session(handle);
    let path=std::ffi::OsStr::new(target).encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let names=[path.as_ptr()];
    unsafe{checked(RmRegisterResources(session.0,1,names.as_ptr(),0,ptr::null(),0,ptr::null()))?;}
    let mut entries:Vec<ProcessInfo>=Vec::new();
    // Processes can enter/exit between calls. Bound both allocation and retries.
    for _ in 0..4 {
        let mut needed=0;let mut count=entries.len() as u32;let mut reboot_reasons=0;
        let buffer=if entries.is_empty(){ptr::null_mut()}else{entries.as_mut_ptr()};
        let code=unsafe{RmGetList(session.0,&mut needed,&mut count,buffer,&mut reboot_reasons)};
        if code==234 {
            if needed==0 || needed>128 {return Err(io::Error::other("file usage list exceeded diagnostic limit"));}
            entries=vec![unsafe{std::mem::zeroed()};needed as usize];
            continue;
        }
        checked(code)?;
        if count as usize>entries.len(){return Err(io::Error::other("invalid file usage count"));}
        let processes=entries[..count as usize].iter().map(|entry|json!({
            "pid":entry.process.pid,
            "started":format!("{:08x}{:08x}",entry.process.started.high,entry.process.started.low),
            "name":text(&entry.app_name),
            "service":text(&entry.service_name),
        })).collect::<Vec<_>>();
        return Ok(json!({"ok":true,"target":target,"processes":processes,"rebootReasons":reboot_reasons}));
    }
    Err(io::Error::other("file usage list changed repeatedly"))
}
pub(super) fn run(target:&str)->io::Result<()> {
    let result=query(target).unwrap_or_else(|error|json!({"ok":false,"target":target,"message":error.to_string(),"code":error.raw_os_error()}));
    serde_json::to_writer(io::stdout().lock(),&result)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_manager_sdk_layout() {
        assert_eq!(std::mem::size_of::<UniqueProcess>(),12);
        assert_eq!(std::mem::size_of::<ProcessInfo>(),668);
        assert_eq!(std::mem::offset_of!(ProcessInfo,app_type),652);
        assert_eq!(text(&[0x534e,0x5eb7,0,0x0041]),"华康");
    }
}
