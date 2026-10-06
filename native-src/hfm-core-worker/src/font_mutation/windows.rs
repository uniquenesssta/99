use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{ffi::c_void, fs::{File, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::{AsRawHandle, FromRawHandle}}, path::{Path, PathBuf}, ptr};
use crate::windows_ffi::{Handle, FileInformation as Info, GetFileInformationByHandle, SetFileInformationByHandle, RegOpenKeyExW, RegDeleteValueW, RegCloseKey};
const FONT_KEY: &str = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
const HKCU: Handle = (-2147483647isize) as Handle;
const HKLM: Handle = (-2147483646isize) as Handle;
#[repr(C)] struct Security { length:u32, descriptor:Handle, inherit:i32 }
#[repr(C)] #[derive(Default)] struct IoStatus { status:usize, information:usize }
#[link(name="ntdll")] extern "system" {
    fn NtSetInformationFile(file:Handle, status:*mut IoStatus, data:*const c_void, size:u32, class:u32)->i32;
    fn RtlNtStatusToDosError(status:i32)->u32;
}
#[repr(C)] struct ShellInfo { size:u32, mask:u32, window:Handle, verb:*const u16, file:*const u16, parameters:*const u16, directory:*const u16, show:i32, instance:Handle, id_list:Handle, class:*const u16, class_key:Handle, hot_key:u32, icon:Handle, process:Handle }
#[link(name="kernel32")] extern "system" {
    fn GetFinalPathNameByHandleW(file:Handle, path:*mut u16, size:u32, flags:u32)->u32;
    fn GetWindowsDirectoryW(path:*mut u16, size:u32)->u32;
    fn CreateNamedPipeW(name:*const u16, access:u32, mode:u32, instances:u32, out_size:u32, in_size:u32, timeout:u32, security:*const Security)->Handle;
    fn ConnectNamedPipe(pipe:Handle, overlapped:Handle)->i32;
    fn GetNamedPipeClientProcessId(pipe:Handle, pid:*mut u32)->i32;
    fn GetNamedPipeServerProcessId(pipe:Handle, pid:*mut u32)->i32;
    fn GetProcessId(process:Handle)->u32;
    fn OpenProcess(access:u32, inherit:i32, pid:u32)->Handle;
    fn QueryFullProcessImageNameW(process:Handle, flags:u32, path:*mut u16, size:*mut u32)->i32;
    fn CloseHandle(handle:Handle)->i32;
    fn LocalFree(value:Handle)->Handle;
}
#[link(name="advapi32")] extern "system" {
    fn RegOpenKeyTransactedW(root:Handle, subkey:*const u16, options:u32, access:u32, out:*mut Handle, transaction:Handle, extended:Handle)->i32;
    fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32;
    fn RegQueryValueExW(key:Handle, name:*const u16, reserved:Handle, kind:*mut u32, data:*mut u8, bytes:*mut u32)->i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text:*const u16, revision:u32, out:*mut Handle, size:*mut u32)->i32;
}
#[link(name="KtmW32")] extern "system" {
    fn CreateTransaction(security:Handle, id:Handle, options:u32, isolation:u32, flags:u32, timeout:u32, description:*const u16)->Handle;
    fn CommitTransaction(transaction:Handle)->i32;
}
#[link(name="ole32")] extern "system" { fn CoInitializeEx(reserved:Handle,flags:u32)->i32; fn CoUninitialize(); }
#[link(name="gdi32")] extern "system" { fn RemoveFontResourceExW(path:*const u16,flags:u32,reserved:Handle)->i32; }
#[link(name="shell32")] extern "system" {
    fn ShellExecuteExW(info:*mut ShellInfo)->i32;
    fn SHGetFolderPathW(window:Handle, folder:i32, token:Handle, flags:u32, path:*mut u16)->i32;
}
#[link(name="sfc")] extern "system" { fn SfcIsFileProtected(rpc:Handle, path:*const u16)->i32; }
fn wide(s:&str)->Vec<u16>{std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()}
fn fail(s:&str)->io::Error{io::Error::other(s)}
fn last()->io::Error{io::Error::last_os_error()}
fn checked(ok:i32)->io::Result<()>{if ok==0{Err(last())}else{Ok(())}}
fn key(path:&str)->String { path.trim_start_matches("\\\\?\\").replace('/',"\\").to_lowercase() }
fn emit(out:&mut impl Write, value:&Value)->io::Result<()>{serde_json::to_writer(&mut *out,value)?;out.write_all(b"\n")?;out.flush()}
fn receive(input:&mut impl BufRead)->io::Result<Value>{
    let mut bytes=Vec::new();
    let n=(&mut *input).take(1024*1024+1).read_until(b'\n',&mut bytes)?;
    if n==0 || n>1024*1024 || bytes.last()!=Some(&b'\n'){return Err(fail("closed or oversized mutation protocol"));}
    Ok(serde_json::from_slice(&bytes)?)
}
fn gate(input:&mut impl BufRead,out:&mut impl Write,stage:&str)->io::Result<()> {
    let mut message=json!({"gate":stage});
    if !stage.starts_with("elevated-") {message["references"]=snapshot()?;}
    emit(out,&message)?;
    if receive(input)?.get("allow")!=Some(&Value::Bool(true)){return Err(fail("protection recheck refused mutation"));} Ok(())
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Identity { volume:u32, high:u32, low:u32, size_high:u32, size_low:u32, modified_high:u32, modified_low:u32 }
fn identity(file:&File)->io::Result<Identity>{let mut i=Info::default();unsafe{checked(GetFileInformationByHandle(file.as_raw_handle(),&mut i))?;}
    if i.attributes & (0x10|0x400)!=0 || i.links!=1 {return Err(fail("directory, reparse point or hard-linked target refused"));}
    Ok(Identity{volume:i.volume,high:i.index_high,low:i.index_low,size_high:i.size_high,size_low:i.size_low,modified_high:i.modified.high,modified_low:i.modified.low})
}
fn physical(file:&File)->io::Result<String>{let mut p=vec![0u16;32768];let n=unsafe{GetFinalPathNameByHandleW(file.as_raw_handle(),p.as_mut_ptr(),p.len() as u32,0)};if n==0{return Err(last())}if n as usize>=p.len(){return Err(fail("path too long"))}Ok(String::from_utf16_lossy(&p[..n as usize]))}
fn open_font(path:&str,delete:bool)->io::Result<File>{open_font_access(path,delete,false)}
fn open_font_access(path:&str,delete:bool,write_attributes:bool)->io::Result<File>{
    if path.contains('\0') || path.len()>32000 || !Path::new(path).is_absolute() || !matches!(Path::new(path).extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str(),"ttf"|"otf"|"ttc"|"otc") {return Err(fail("invalid font path"));}
    let f=OpenOptions::new().access_mode(0x80000000 | (if delete{0x10000}else{0}) | (if write_attributes{0x100}else{0})).share_mode(1).custom_flags(0x00200000).open(path)?;
    identity(&f)?;
    if key(&physical(&f)?)!=key(path){return Err(fail("font path resolves through an alias/reparse point; resolve before planning"));}
    let mut magic=[0;4];(&f).read_exact(&mut magic)?;
    if !matches!(&magic,b"\0\x01\0\0"|b"OTTO"|b"ttcf"|b"true"|b"typ1"){return Err(fail("not a supported font"));}
    if unsafe{SfcIsFileProtected(ptr::null_mut(),wide(path).as_ptr())}!=0{return Err(fail("WRP protected file; ownership and ACL are unchanged"));}
    Ok(f)
}
fn digest(file:&File)->io::Result<String>{
    use std::io::{Seek,SeekFrom};
    let mut file=file; file.seek(SeekFrom::Start(0))?;
    crate::windows_font_digest::sha256(file,u64::MAX).map(|(hash,_)|hash)
}
fn roots()->io::Result<(String,String)>{roots_for_token(ptr::null_mut())}
fn roots_for_token(token:Handle)->io::Result<(String,String)>{
    let mut b=[0u16;32768];let n=unsafe{GetWindowsDirectoryW(b.as_mut_ptr(),b.len() as u32)};if n==0||n as usize>=b.len(){return Err(last())}
    let windows=PathBuf::from(String::from_utf16_lossy(&b[..n as usize])).join("Fonts");
    let mut u=[0u16;260];if unsafe{SHGetFolderPathW(ptr::null_mut(),0x1c,token,0,u.as_mut_ptr())}<0{return Err(fail("original user fonts directory unavailable"))}
    let n=u.iter().position(|c|*c==0).unwrap_or(u.len());let user=PathBuf::from(String::from_utf16_lossy(&u[..n])).join("Microsoft\\Windows\\Fonts");
    Ok((windows.to_string_lossy().into(),user.to_string_lossy().into()))
}
fn direct_child(path:&str,root:&str)->bool {Path::new(path.trim_start_matches("\\\\?\\")).parent().is_some_and(|p|key(&p.to_string_lossy())==key(root))}
#[derive(Clone, Deserialize, Serialize)] #[serde(deny_unknown_fields)]
struct Record { scope:String, name:String, value:String }
#[derive(Clone, Deserialize, Serialize)] #[serde(deny_unknown_fields)]
struct Plan { path:String, sha256:String, delete_file:bool, records:Vec<Record>, identity:Option<Identity>,
    #[serde(default)] preflight_file:bool,
    #[serde(default)] allow_readonly_copy:bool,
}
struct Registry(Handle);impl Drop for Registry{fn drop(&mut self){unsafe{RegCloseKey(self.0);}}}
fn registry(record:&Record,write:bool,elevated:bool)->io::Result<Registry>{
    if record.name.is_empty()||record.name.contains('\0')||record.name.len()>16383||record.value.contains('\0'){return Err(fail("invalid registry record"))}
    let root=match record.scope.as_str(){"HKCU" if !elevated=>HKCU,"HKLM"=>HKLM,_=>return Err(fail("registry scope refused"))};
    let mut k=ptr::null_mut();let code=unsafe{RegOpenKeyExW(root,wide(FONT_KEY).as_ptr(),0,0x101|if write{2}else{0},&mut k)};
    if code!=0{return Err(io::Error::from_raw_os_error(code))}Ok(Registry(k))
}
fn delete_record(r:&Record)->io::Result<()> {
    let raw=unsafe{CreateTransaction(ptr::null_mut(),ptr::null_mut(),0,0,0,5000,ptr::null())};
    if raw as isize == -1{return Err(last())}let transaction=Process(raw);
    let root=if r.scope=="HKCU"{HKCU}else{HKLM};let mut raw_key=ptr::null_mut();
    let code=unsafe{RegOpenKeyTransactedW(root,wide(FONT_KEY).as_ptr(),0,0x103,&mut raw_key,transaction.0,ptr::null_mut())};
    if code!=0{return Err(io::Error::from_raw_os_error(code))}let k=Registry(raw_key);
    verify_record(&k,r)?;
    let code=unsafe{RegDeleteValueW(k.0,wide(&r.name).as_ptr())};if code!=0{return Err(io::Error::from_raw_os_error(code))}
    unsafe{checked(CommitTransaction(transaction.0))?;}Ok(())
}
fn verify_record(k:&Registry,r:&Record)->io::Result<()> {
    let mut bytes=65536u32;let mut data=vec![0u16;32768];let mut kind=0;
    let code=unsafe{RegQueryValueExW(k.0,wide(&r.name).as_ptr(),ptr::null_mut(),&mut kind,data.as_mut_ptr() as *mut u8,&mut bytes)};
    if code!=0{return Err(io::Error::from_raw_os_error(code))}
    let value=crate::font_registry::decode(&r.name,kind,&data,bytes)
        .map_err(|error|fail(&format!("registry verification: scope={}, name={:?}, type={kind}, bytes={bytes}: {error}",r.scope,r.name)))?;
    if value.as_deref()!=Some(r.value.as_str()){return Err(fail("registry target changed since planning"))}Ok(())
}
fn snapshot()->io::Result<Value> {
    let (windows,_)=roots()?;
    let rows=crate::font_registry::read()?.into_iter().map(|entry| {
        let value=entry.value;let bare=value.trim_matches('"');
        let path=if Path::new(bare).is_absolute(){PathBuf::from(bare)}else{PathBuf::from(&windows).join(bare)};
        json!({"source":entry.scope,"registryName":entry.name,"value":value,"path":path.to_string_lossy(),"fileName":path.file_name().map(|v|v.to_string_lossy())})
    }).collect::<Vec<_>>();
    Ok(Value::Array(rows))
}
fn validate(p:&Plan,elevated:bool,original_user:Option<&str>)->io::Result<()> {
    let (windows,current_user)=roots()?;
    let user=original_user.unwrap_or(&current_user);
    if p.records.len()>512||p.sha256.len()!=64||!p.sha256.bytes().all(|c|c.is_ascii_hexdigit()){return Err(fail("invalid plan"))}
    if (p.delete_file || p.preflight_file) && !direct_child(&p.path,&windows) && !direct_child(&p.path,user){return Err(fail("file deletion outside installed font directories refused"))}
    if p.allow_readonly_copy && (!(p.delete_file || p.preflight_file) || !direct_child(&p.path,user)) {
        return Err(fail("read-only normalization is limited to the current user's installed copy"));
    }
    // The elevated endpoint has no HKCU, UNC, arbitrary file or command capability.
    if elevated && ((!direct_child(&p.path,&windows)&&!direct_child(&p.path,user))||p.records.iter().any(|r|r.scope!="HKLM")){return Err(fail("elevated operation outside original-user/Windows font directories refused"))}
    for r in &p.records {
        let value=r.value.trim_matches('"');let target=if Path::new(value).is_absolute(){PathBuf::from(value)}else{PathBuf::from(&windows).join(value)};
        if key(&target.to_string_lossy())!=key(&p.path){return Err(fail("registry value does not name planned font"))}
    }
    Ok(())
}
fn retry_file_disposition(mut attempt:impl FnMut()->io::Result<()>,mut wait:impl FnMut(u64))->io::Result<()> {
    // A writable file with an already granted DELETE handle may still have
    // short-lived GDI/mapped-file references. Never replay registry changes or
    // request elevation here; the caller bounds any verified handle renewal.
    const DELAYS:[u64;4]=[50,100,200,400];
    for index in 0..=DELAYS.len() {
        match attempt() {
            Ok(())=>return Ok(()),
            Err(error) if matches!(error.raw_os_error(),Some(5)|Some(32)) && index<DELAYS.len()=>{
                eprintln!("font file disposition retry: attempt={}, code={:?}, delay_ms={}",index+1,error.raw_os_error(),DELAYS[index]);
                wait(DELAYS[index]);
            },
            Err(error)=>return Err(error),
        }
    }
    unreachable!()
}
#[cfg(test)]
fn mark_file_for_deletion(file:&File)->io::Result<()> {mark_file_for_deletion_status(file,&mut None)}
fn mark_file_for_deletion_status(file:&File,native_status:&mut Option<u32>)->io::Result<()> {
    *native_status=None;
    // Windows 10 RS1+: remove the directory entry on closing this handle,
    // rather than waiting for every delete-sharing reader to close. Keep image
    // section checks and read-only protection: never use IGNORE_READONLY (0x10).
    // Every DELETE handle keeps the no-write/no-replace sharing contract.
    // Native class 64 is the equivalent of Win32 FileDispositionInfoEx (21).
    // Preserve the NTSTATUS: both CANNOT_DELETE and ACCESS_DENIED map to error 5.
    const FILE_DISPOSITION_INFORMATION_EX:u32=64;
    const DELETE_POSIX_CHECK_IMAGE:u32=0x01|0x02|0x04;
    let flags=DELETE_POSIX_CHECK_IMAGE;
    let mut io_status=IoStatus::default();
    // OpenOptions creates a synchronous file handle; this request completes inline.
    let status=unsafe{NtSetInformationFile(file.as_raw_handle(),&mut io_status,&flags as *const _ as *const c_void,std::mem::size_of_val(&flags) as u32,FILE_DISPOSITION_INFORMATION_EX)};
    if status>=0{return Ok(())}
    *native_status=Some(status as u32);
    let error=io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(status)} as i32);
    // Only OS/filesystem feature absence permits legacy fallback. In particular,
    // access denied, sharing violations and mapped-image refusal stay errors.
    if !matches!(error.raw_os_error(),Some(1)|Some(50)|Some(87)) {
        eprintln!("font deletion API failed: method=FileDispositionInformationEx, ntstatus=0x{:08X}, flags=0x{flags:02X}, code={:?}, readonly={:?}",status as u32,error.raw_os_error(),file.metadata().map(|m|m.permissions().readonly()));
        return Err(error);
    }
    let delete=1u8;
    let result=unsafe{checked(SetFileInformationByHandle(file.as_raw_handle(),4,&delete as *const _ as *const c_void,std::mem::size_of_val(&delete) as u32))};
    eprintln!("font deletion API fallback: unsupported={:?}, method=FileDispositionInfo, result={:?}",error.raw_os_error(),result.as_ref().err().and_then(|e|e.raw_os_error()));
    result
}
fn release_font_resources(p:&Plan,elevated:bool,input:&mut impl BufRead,out:&mut impl Write)->io::Result<()> {
    let mut released=0;
    let result=(|| {
    for _ in 0..8 {
        gate(input,out,if elevated{"elevated-file"}else{"file"})?;
        if unsafe{RemoveFontResourceExW(wide(&p.path).as_ptr(),0,ptr::null_mut())}==0 {break;}
        released+=1;
    }
    Ok(())
    })();
    eprintln!("font resource release: removed={released}, limit=8");
    if released>0 {notify_font_change("resource-release",out);}
    result
}
// Diagnostic writes must stay on stderr: broker Track treats stdout writes as
// prepared and uses that fact to forbid replay through automatic elevation.
struct MutationTrace { operation:u64, started:std::time::Instant }
impl MutationTrace {
    fn new()->Self {
        static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
        Self{operation:NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed),started:std::time::Instant::now()}
    }
    fn event(&self,event:&str,generation:u32,detail:Value) {
        let unix_ms=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|v|v.as_millis()).ok();
        eprintln!("font mutation lifecycle: {}",json!({"pid":std::process::id(),"operation":self.operation,"unixMs":unix_ms,"elapsedMs":self.started.elapsed().as_millis(),"event":event,"handleGeneration":generation,"detail":detail}));
    }
}
#[derive(Default)]
struct FailureDetails { stage:&'static str, ntstatus:Option<u32>, uncertain:bool }
// The caller clears uncertainty only after the matching effect/done receipt
// has crossed the transport. A committed effect without ACK is never replayable.
fn until_receipted(details:&mut FailureDetails,action:impl FnOnce()->io::Result<()>)->io::Result<()> {
    details.uncertain=true;
    action()?;
    details.uncertain=false;
    Ok(())
}
fn notify_font_change(reason:&str,out:&mut impl Write) {
    let result=crate::font_resource::notify_font_change_now(false);
    eprintln!("font change notification: reason={reason}, ok={}, detail={:?}",result.is_ok(),result.as_ref().err());
    let _=emit(out,&json!({"notification":reason,"ok":result.is_ok()}));
}
fn notify_registry_change(changed:&mut bool,out:&mut impl Write) {
    if !std::mem::take(changed) {return;}
    // Consumers must hear about committed registry removals even when the
    // subsequent file cleanup fails. Never wait for file deletion to notify.
    notify_font_change("registry-change",out);
}
fn open_mutation_target(p:&Plan,elevated:bool,input:&mut impl BufRead,out:&mut impl Write)->io::Result<File> {
    // Request attribute access only when the explicit copy policy needs it.
    // The opened handle is still identity/hash checked before any attribute write.
    let write_attributes=p.allow_readonly_copy && std::fs::metadata(&p.path)?.permissions().readonly();
    match open_font_access(&p.path,p.delete_file,write_attributes) {
        // The separate file-cleanup plan has no registrations left. A loaded
        // session font can refuse DELETE sharing before the old release step.
        Err(error) if error.raw_os_error()==Some(32) && p.delete_file && p.records.is_empty()=>{
            let pin=open_font(&p.path,false)?;
            if pin.metadata()?.permissions().readonly() && !p.allow_readonly_copy{return Err(fail("font file is read-only"))}
            if p.identity.as_ref()!=Some(&identity(&pin)?) || digest(&pin)?!=p.sha256 {
                return Err(fail("font identity/content changed before resource release"));
            }
            // Once resources may change, never replay through automatic UAC.
            emit(out,&json!({"prepared":true}))?;
            release_font_resources(p,elevated,input,out)?;
            // The read pin prevents replacement during release. Reopening is
            // followed by the caller's original identity and digest checks.
            drop(pin);
            open_font_access(&p.path,true,write_attributes)
        },
        result=>result,
    }
}
fn reopen_verified_target(p:&Plan,previous:File,open:impl FnOnce()->io::Result<File>)->io::Result<File> {
    drop(previous);
    let file=open()?;
    if file.metadata()?.permissions().readonly(){return Err(fail("font became read-only during handle renewal"))}
    if p.identity.as_ref()!=Some(&identity(&file)?) || digest(&file)?!=p.sha256 {
        return Err(fail("font identity/content changed during handle renewal"));
    }
    Ok(file)
}
fn execute(p:&Plan,elevated:bool,original_user:Option<&str>,input:&mut impl BufRead,out:&mut impl Write,details:&mut FailureDetails)->io::Result<()> {
    let trace=MutationTrace::new();
    trace.event("execute-start",0,json!({"target":p.path,"deleteFile":p.delete_file,"records":p.records.len(),"elevated":elevated,"plannedIdentity":p.identity}));
    let mut stage="validate-plan";
    let mut registry_changed=false;
    let mut native_status=None;
    let result=(||->io::Result<()> {
    validate(p,elevated,original_user)?;
    // Check mutation permissions before registry/file effects. A sharing-only
    // cleanup may first release gated session resources; it marks prepared.
    stage="open-font";
    trace.event("target-open-start",1,json!({"deleteAccess":p.delete_file}));
    let file=open_mutation_target(p,elevated,input,out)?;
    trace.event("target-opened",1,json!({"deleteAccess":p.delete_file}));
    stage="identity-preflight";
    if p.identity.as_ref()!=Some(&identity(&file)?)||digest(&file)?!=p.sha256{return Err(fail("font identity/content changed"))}
    trace.event("target-identity-confirmed",1,json!({"identity":p.identity}));
    stage="readonly-preflight";
    let mut permissions=file.metadata()?.permissions();
    if (p.delete_file || p.preflight_file) && permissions.readonly() {
        if !p.allow_readonly_copy {
            return Err(fail("字体文件为只读；本步骤尚未删除注册记录。源文件和系统目录的只读属性不会自动更改。 (read-only)"));
        }
        // Explicit uninstall of a separate, verified per-user installation copy.
        // Do not use IGNORE_READONLY, path-based chmod, ACL changes or elevation
        // replay after an attribute change. Keep other attributes intact.
        emit(out,&json!({"prepared":true}))?;
        stage="readonly-normalization";
        gate(input,out,if elevated{"elevated-attributes"}else{"attributes"})?;
        permissions.set_readonly(false);
        file.set_permissions(permissions)?;
        if file.metadata()?.permissions().readonly(){return Err(fail("安装副本的只读属性未能解除；未删除本步骤的注册记录。"))}
        eprintln!("font installed copy: read-only attribute cleared on verified handle");
    }
    stage="registry-preflight";
    let mut keys=Vec::new();for r in &p.records{let k=registry(r,true,elevated)?;verify_record(&k,r)?;keys.push(k);}
    emit(out,&json!({"prepared":true}))?;
    for (r,k) in p.records.iter().zip(keys.iter()) {
        stage="registry-gate";
        gate(input,out,if elevated{"elevated-registry"}else{"registry"})?;verify_record(k,r)?;
        stage="registry-delete";
        until_receipted(details,|| {
            delete_record(r)?;
            registry_changed=true;
            trace.event("registry-committed",1,json!({"scope":r.scope,"name":r.name}));
            emit(out,&json!({"effect":"registry","scope":r.scope,"name":r.name}))
        })?;
    }
    if registry_changed {trace.event("registry-notification-start",1,json!({}));}
    let had_registry_change=registry_changed;
    notify_registry_change(&mut registry_changed,out);
    if had_registry_change {trace.event("registry-notification-finished",1,json!({}));}
    if p.delete_file {
        let mut held=Some(file);let mut renewal_pending=false;let mut renewed=false;let mut renewal_error=None;
        let mut generation=1u32;let mut attempt=0u32;
        let disposition=retry_file_disposition(|| {
        attempt+=1;
        trace.event("disposition-attempt-start",generation,json!({"attempt":attempt,"renewalPending":renewal_pending}));
        native_status=None;
        if renewal_pending {
            stage="file-handle-renewal";
            // The original DELETE handle is closed once only for CANNOT_DELETE.
            // The new handle must identify the same file, not just equal bytes.
            let previous=held.take().ok_or_else(||fail("missing deletion handle"))?;
            trace.event("target-renewal-start",generation,json!({"attempt":attempt}));
            let reopened=match reopen_verified_target(p,previous,|| {
                // reopen_verified_target has dropped the old target before this closure.
                trace.event("old-target-handle-closed",generation,json!({"attempt":attempt}));
                open_font(&p.path,true)
            }) {
                Ok(file)=>file,
                Err(error)=>{renewal_error=Some(error);return Err(fail("file handle renewal refused"));}
            };
            held=Some(reopened);renewal_pending=false;renewed=true;generation+=1;
            trace.event("renewed-target-identity-confirmed",generation,json!({"attempt":attempt,"identity":p.identity}));
        }
        let file=held.as_ref().ok_or_else(||fail("missing deletion handle"))?;
        stage="file-identity-recheck";
        if p.identity.as_ref()!=Some(&identity(&file)?){return Err(fail("font identity changed before delete"))}
        if file.metadata()?.permissions().readonly(){return Err(fail("font became read-only before delete"))}
        // Multiple loads can retain multiple resource references. Each removal
        // is separately gated; private or other-session resources are not forced.
        stage="font-resource-release";
        trace.event("resource-release-start",generation,json!({"attempt":attempt}));
        release_font_resources(p,elevated,input,out)?;
        trace.event("resource-release-finished",generation,json!({"attempt":attempt}));
        gate(input,out,if elevated{"elevated-file"}else{"file"})?;
        if p.identity.as_ref()!=Some(&identity(&file)?){return Err(fail("font identity changed before disposition"))}
        stage="file-disposition";
        let result=mark_file_for_deletion_status(file,&mut native_status);
        trace.event("disposition-returned",generation,json!({"attempt":attempt,"ok":result.is_ok(),"ntstatus":native_status,"code":result.as_ref().err().and_then(|e|e.raw_os_error())}));
        if !renewed && native_status==Some(0xC0000121) {
            renewal_pending=true;
            eprintln!("font deletion handle renewal scheduled: ntstatus=0xC0000121, same identity required, retry budget unchanged");
        }
        result
        },|ms| {
            trace.event("retry-wait-start",0,json!({"delayMs":ms,"targetHandleHeld":true}));
            std::thread::sleep(std::time::Duration::from_millis(ms));
            trace.event("retry-wait-finished",0,json!({"delayMs":ms,"targetHandleHeld":true}));
        });
        // Stop renewal errors immediately while retaining their original OS code.
        if let Some(error)=renewal_error{return Err(error)}
        disposition?;
        drop(held);
        trace.event("delete-target-handle-closed",generation,json!({"dispositionOk":true}));
        // A new object at the old path must never be removed during verification.
        stage="file-removal-verification";
        if Path::new(&p.path).try_exists()?{return Err(fail("file deletion not confirmed; do not retry without new identity"))}
        emit(out,&json!({"effect":"file"}))?;
    }
    Ok(())
    })();
    // All target handles scoped inside execute's closure have now been dropped,
    // including on an early error. This does not claim that external mappings closed.
    trace.event("execute-target-handles-released",0,json!({"stage":stage,"ok":result.is_ok(),"ntstatus":native_status,"code":result.as_ref().err().and_then(|e|e.raw_os_error())}));
    // A later record/gate may fail after an earlier record was committed.
    notify_registry_change(&mut registry_changed,out);
    details.stage=stage;details.ntstatus=native_status;
    // Keep the original OS error code and stdout protocol untouched. In
    // particular, logging must not mark a denied preflight as prepared and
    // suppress the broker's existing UAC decision.
    if let Err(error)=&result { eprintln!("font mutation failure: stage={stage}, elevated={elevated}, delete_file={}, records={}, code={:?}, detail={error}",p.delete_file,p.records.len(),error.raw_os_error()); }
    result
}

#[cfg(test)]
mod disposition_tests {
    use super::*;
    #[test]
    fn committed_or_dispatched_work_without_receipt_stays_uncertain() {
        let mut details=FailureDetails::default();let mut committed=0;
        let error=until_receipted(&mut details,|| {committed+=1;Err(io::Error::new(io::ErrorKind::BrokenPipe,"ACK lost"))}).unwrap_err();
        assert_eq!(committed,1);assert_eq!(error.kind(),io::ErrorKind::BrokenPipe);assert!(details.uncertain);
        let error=until_receipted(&mut details,|| {let mut child=io::Cursor::new(Vec::<u8>::new());receive(&mut child).map(|_|())}).unwrap_err();
        assert!(error.to_string().contains("closed"));assert!(details.uncertain);
        until_receipted(&mut details,|| Ok(())).unwrap();assert!(!details.uncertain);
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self {
            assert!(std::env::var_os("CI").is_none() && std::env::var_os("GITHUB_ACTIONS").is_none(), "real file mutation fixtures are local-only");
            let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path=std::env::temp_dir().join(format!("hfm-disposition-{}-{nonce}.ttf",std::process::id()));
            let mut file=OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
            // This is a file API fixture, not a substitute for the real-font
            // broker acceptance in check-local-user-state.cjs.
            file.write_all(b"\0\x01\0\0isolated file API fixture").unwrap();
            drop(file);
            // Match production planning: Windows temp paths can contain aliases
            // or short names, while open_font requires the resolved physical path.
            Self(std::fs::canonicalize(&path).unwrap())
        }
        fn path(&self)->&str {self.0.to_str().unwrap()}
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(metadata)=std::fs::metadata(&self.0) {
                let mut permissions=metadata.permissions();permissions.set_readonly(false);
                let _=std::fs::set_permissions(&self.0,permissions);
                let _=std::fs::remove_file(&self.0);
            }
        }
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_handle_delete_blocks_target_replacement() {
        let fixture=Fixture::new();
        let file=open_font(fixture.path(),true).unwrap();
        let error=OpenOptions::new().write(true).open(&fixture.0).unwrap_err();
        assert_eq!(error.raw_os_error(),Some(32));
        let error=std::fs::rename(&fixture.0,fixture.0.with_extension("replacement")).unwrap_err();
        assert_eq!(error.raw_os_error(),Some(32));
        mark_file_for_deletion(&file).unwrap();drop(file);
        assert!(!fixture.0.try_exists().unwrap());
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_readonly_file_is_not_force_deleted() {
        let fixture=Fixture::new();let mut permissions=std::fs::metadata(&fixture.0).unwrap().permissions();
        permissions.set_readonly(true);std::fs::set_permissions(&fixture.0,permissions).unwrap();
        let file=open_font(fixture.path(),true).unwrap();
        assert_eq!(mark_file_for_deletion(&file).unwrap_err().raw_os_error(),Some(5));drop(file);
        assert!(fixture.0.try_exists().unwrap());
        assert!(std::fs::metadata(&fixture.0).unwrap().permissions().readonly());
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_handle_without_delete_access_is_denied() {
        let fixture=Fixture::new();let file=open_font(fixture.path(),false).unwrap();
        assert_eq!(mark_file_for_deletion(&file).unwrap_err().raw_os_error(),Some(5));drop(file);
        assert!(fixture.0.try_exists().unwrap());
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_reader_without_delete_sharing_blocks_open() {
        let fixture=Fixture::new();let reader=OpenOptions::new().read(true).share_mode(1).open(&fixture.0).unwrap();
        assert_eq!(open_font(fixture.path(),true).unwrap_err().raw_os_error(),Some(32));
        assert!(fixture.0.try_exists().unwrap());drop(reader);
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_delete_sharing_reader_keeps_data_without_retaining_path() {
        let fixture=Fixture::new();let mut reader=OpenOptions::new().read(true).share_mode(1|4).open(&fixture.0).unwrap();
        let file=open_font(fixture.path(),true).unwrap();
        mark_file_for_deletion(&file).unwrap();drop(file);
        assert!(!fixture.0.try_exists().unwrap(),"reader retained deleted installation path");
        let mut bytes=Vec::new();reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(&bytes[..4],b"\0\x01\0\0");
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_external_reader_is_not_forced_after_resource_release() {
        let fixture=Fixture::new();let pin=open_font(fixture.path(),false).unwrap();
        let plan=Plan{path:fixture.path().into(),sha256:digest(&pin).unwrap(),identity:Some(identity(&pin).unwrap()),delete_file:true,records:Vec::new(),preflight_file:false,allow_readonly_copy:false};
        let mut denied=std::io::Cursor::new(b"{\"allow\":false}\n");let mut output=Vec::new();
        assert!(open_mutation_target(&plan,true,&mut denied,&mut output).unwrap_err().to_string().contains("protection recheck refused"));
        let mut allowed=std::io::Cursor::new(b"{\"allow\":true}\n");let mut output=Vec::new();
        assert_eq!(open_mutation_target(&plan,true,&mut allowed,&mut output).unwrap_err().raw_os_error(),Some(32));
        assert!(fixture.0.try_exists().unwrap());assert!(!String::from_utf8(output).unwrap().contains("\"effect\""));
        drop(pin);
        let mut input=std::io::Cursor::new(Vec::<u8>::new());
        assert!(open_mutation_target(&plan,false,&mut input,&mut Vec::new()).is_ok());
    }
    #[test]
    #[ignore = "local Windows mutation acceptance: npm run test:font-system-local"]
    fn real_handle_renewal_rejects_same_content_replacement() {
        let fixture=Fixture::new();let file=open_font(fixture.path(),true).unwrap();
        let plan=Plan{path:fixture.path().into(),sha256:digest(&file).unwrap(),identity:Some(identity(&file).unwrap()),delete_file:true,records:Vec::new(),preflight_file:false,allow_readonly_copy:false};
        let file=reopen_verified_target(&plan,file,||open_font(fixture.path(),true)).unwrap();
        let replacement=Fixture::new();
        let error=reopen_verified_target(&plan,file,||{
            std::fs::remove_file(&fixture.0)?;std::fs::rename(&replacement.0,&fixture.0)?;
            open_font(fixture.path(),true)
        }).unwrap_err();
        assert!(error.to_string().contains("identity/content changed"));assert!(fixture.0.try_exists().unwrap());
    }
    #[test]
    fn transient_failure_rechecks_before_success() {
        let mut checks=0;let mut waits=Vec::new();
        retry_file_disposition(||{checks+=1;if checks<3{Err(io::Error::from_raw_os_error(5))}else{Ok(())}},|ms|waits.push(ms)).unwrap();
        assert_eq!(checks,3);assert_eq!(waits,vec![50,100]);
    }
    #[test]
    fn persistent_denial_keeps_error_and_is_bounded() {
        let mut attempts=0;let mut waits=Vec::new();
        let error=retry_file_disposition(||{attempts+=1;Err(io::Error::from_raw_os_error(5))},|ms|waits.push(ms)).unwrap_err();
        assert_eq!(error.raw_os_error(),Some(5));assert_eq!(attempts,5);assert_eq!(waits,vec![50,100,200,400]);
    }
    #[test]
    fn protection_refusal_after_wait_stops_retry() {
        let mut checks=0;let mut mutations=0;
        let error=retry_file_disposition(||{checks+=1;if checks>1{return Err(fail("protection changed"))}mutations+=1;Err(io::Error::from_raw_os_error(32))},|_|{}).unwrap_err();
        assert_eq!(error.to_string(),"protection changed");assert_eq!(checks,2);assert_eq!(mutations,1);
    }
    #[test]
    fn unrelated_error_is_not_retried() {
        let error=retry_file_disposition(||Err(io::Error::from_raw_os_error(87)),|_|panic!("unexpected retry")).unwrap_err();
        assert_eq!(error.raw_os_error(),Some(87));
    }
}
struct Elevated { input:BufReader<File>, output:File, _process:Process }
struct Process(Handle);impl Drop for Process{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
fn image(pid:u32)->io::Result<String>{let h=unsafe{OpenProcess(0x1000,0,pid)};if h.is_null(){return Err(last())}let h=Process(h);let mut p=vec![0u16;32768];let mut size=p.len() as u32;unsafe{checked(QueryFullProcessImageNameW(h.0,0,p.as_mut_ptr(),&mut size))?;}Ok(String::from_utf16_lossy(&p[..size as usize]))}
fn pinned_image(path:&Path)->io::Result<File>{OpenOptions::new().read(true).share_mode(1).open(path)}
impl Elevated {
    fn start()->io::Result<Self>{
        if unsafe{CoInitializeEx(ptr::null_mut(),2)}<0{return Err(fail("COM initialization failed"))}
        struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}let _apartment=Apartment;
        let exe=std::env::current_exe()?;let _pin=pinned_image(&exe)?;
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|fail("clock"))?.as_nanos();
        let pipe=format!("\\\\.\\pipe\\hfm-font-mutation-{}-{nonce}",std::process::id());
        let mut descriptor=ptr::null_mut();unsafe{checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(wide("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)").as_ptr(),1,&mut descriptor,ptr::null_mut()))?;}
        let sa=Security{length:std::mem::size_of::<Security>() as u32,descriptor,inherit:0};
        let raw=unsafe{CreateNamedPipeW(wide(&pipe).as_ptr(),3|0x80000,8,1,65536,65536,0,&sa)};
        unsafe{LocalFree(descriptor);}
        if raw as isize == -1{return Err(last())}let output=unsafe{File::from_raw_handle(raw)};
        let verb=wide("runas");let executable=wide(&exe.to_string_lossy());let params=wide(&format!("--font-mutation-elevated {pipe} {}",std::process::id()));
        let mut info:ShellInfo=unsafe{std::mem::zeroed()};info.size=std::mem::size_of::<ShellInfo>() as u32;info.mask=0x40|0x100|0x400;info.verb=verb.as_ptr();info.file=executable.as_ptr();info.parameters=params.as_ptr();info.show=0;
        unsafe{checked(ShellExecuteExW(&mut info))?;}
        if info.process.is_null(){return Err(fail("missing elevated process handle"))}let process=Process(info.process);
        if unsafe{ConnectNamedPipe(raw,ptr::null_mut())}==0 && last().raw_os_error()!=Some(535){return Err(last())}
        let mut pid=0;unsafe{checked(GetNamedPipeClientProcessId(raw,&mut pid))?;}
        if pid!=unsafe{GetProcessId(process.0)}||key(&image(pid)?)!=key(&exe.to_string_lossy()){return Err(fail("elevated pipe peer mismatch"))}
        let input=BufReader::new(output.try_clone()?);Ok(Self{input,output,_process:process})
    }
    fn execute(&mut self,plan:&Plan,input:&mut impl BufRead,out:&mut impl Write)->io::Result<()> {
        emit(&mut self.output,&serde_json::to_value(plan)?)?;
        loop {let mut reply=receive(&mut self.input)?;
            if let Some(stage)=reply.get("gate").and_then(Value::as_str) {
                let original_stage=stage.trim_start_matches("elevated-").to_string();
                reply["gate"]=json!(original_stage);reply["references"]=snapshot()?;
            }
            emit(out,&reply)?;
            if reply.get("gate").is_some(){let allow=receive(input)?;emit(&mut self.output,&allow)?;}
            if reply.get("done").is_some(){return Ok(())}
        }
    }
}
fn elevated(args:&[String])->io::Result<()> {
    if args.len()!=4{return Err(fail("invalid elevated invocation"))}let pid:u32=args[3].parse().map_err(|_|fail("invalid broker pid"))?;
    if !args[2].starts_with(&format!("\\\\.\\pipe\\hfm-font-mutation-{pid}-")) {return Err(fail("invalid broker pipe"))}
    let exe=std::env::current_exe()?;let _pin=pinned_image(&exe)?;
    let mut output=OpenOptions::new().read(true).write(true).open(&args[2])?;
    let mut server=0;unsafe{checked(GetNamedPipeServerProcessId(output.as_raw_handle(),&mut server))?;}
    if server!=pid||key(&image(pid)?)!=key(&exe.to_string_lossy()){return Err(fail("broker process mismatch"))}
    let parent=unsafe{OpenProcess(0x1000,0,pid)};if parent.is_null(){return Err(last())}let parent=Process(parent);
    let mut token=ptr::null_mut();unsafe{checked(OpenProcessToken(parent.0,0x0e,&mut token))?;}let token=Process(token);
    let original_user=roots_for_token(token.0)?.1;
    std::env::set_var("HFM_PARENT_PID",pid.to_string());crate::isolated_lifetime::watch_parent().map_err(|e|fail(&e))?;
    let mut input=BufReader::new(output.try_clone()?);
    loop {let value=receive(&mut input)?;let plan:Plan=serde_json::from_value(value)?;
        let mut details=FailureDetails::default();
        let result=execute(&plan,true,Some(&original_user),&mut input,&mut output,&mut details);
        emit(&mut output,&json!({"done":true,"ok":result.is_ok(),"stage":details.stage,"ntstatus":details.ntstatus,"uncertain":details.uncertain,"code":result.as_ref().err().and_then(|e|e.raw_os_error()),"message":result.err().map(|e|e.to_string())}))?;
    }
}
pub fn run(args:&[String])->io::Result<()> {
    if args.get(1).is_some_and(|v|v=="--font-mutation-elevated"){return elevated(args)}
    let exe=std::env::current_exe()?;let _pin=pinned_image(&exe)?;
    let stdin=io::stdin();let stdout=io::stdout();let mut input=stdin.lock();let mut output=stdout.lock();let mut elevated:Option<Elevated>=None;let mut elevation_failure:Option<i32>=None;
    emit(&mut output,&json!({"protocol":"font-mutation-v1"}))?;
    loop {
        let value=receive(&mut input)?;
        if value.get("close")==Some(&Value::Bool(true)){return Ok(())}
        if value.get("snapshot")==Some(&Value::Bool(true)) {
            let result=snapshot();
            emit(&mut output,&match result {Ok(records)=>json!({"snapshot":true,"ok":true,"records":records}),Err(error)=>json!({"snapshot":true,"ok":false,"message":error.to_string()})})?;
            continue;
        }
        let mut plan:Plan=serde_json::from_value(value)?;
        let mut details=FailureDetails{stage:"plan-identity",ntstatus:None,uncertain:false};
        let result=(||->io::Result<()> {
            validate(&plan,false,None)?;
            // Capture identity without DELETE permission before any UAC wait.
            let file=open_font(&plan.path,false)?;
            if digest(&file)?!=plan.sha256{return Err(fail("font content changed before planning"))}
            plan.identity=Some(identity(&file)?);drop(file);
            // Normal permissions always get the first opportunity. Errors after
            // prepared/effects must never be replayed as an elevated operation.
            struct Track<'a,W>{out:&'a mut W,prepared:bool}
            impl<W:Write> Write for Track<'_,W>{fn write(&mut self,b:&[u8])->io::Result<usize>{self.prepared=true;self.out.write(b)}fn flush(&mut self)->io::Result<()>{self.out.flush()}}
            let mut tracked=Track{out:&mut output,prepared:false};
            let result=execute(&plan,false,None,&mut input,&mut tracked,&mut details);
            let denied=result.as_ref().err().and_then(|e|e.raw_os_error())==Some(5);
            if !denied||tracked.prepared{return result}
            validate(&plan,true,Some(&roots()?.1))?;
            gate(&mut input,&mut output,"before-uac")?;
            if let Some(code)=elevation_failure{return Err(io::Error::from_raw_os_error(code))}
            if elevated.is_none(){match Elevated::start(){Ok(child)=>elevated=Some(child),Err(error)=>{elevation_failure=Some(error.raw_os_error().unwrap_or(5));return Err(error)}}}
            // Parent revalidates protection again on each gate from the child.
            details.stage="elevated-transport";
            until_receipted(&mut details,|| elevated.as_mut().unwrap().execute(&plan,&mut input,&mut output))?;
            Ok(())
        })();
        // Elevated replies already contain a done receipt. Suppress the broker
        // duplicate using a separate completion marker at the transport layer.
        emit(&mut output,&json!({"brokerDone":true,"ok":result.is_ok(),"stage":details.stage,"ntstatus":details.ntstatus,"uncertain":details.uncertain,"code":result.as_ref().err().and_then(|e|e.raw_os_error()),"message":result.err().map(|e|e.to_string())}))?;
    }
}

pub(super) fn pin_recovery_file(path: &str, expected_physical: &str, expected_sha256: &str) -> io::Result<File> {
    let file = OpenOptions::new().read(true).share_mode(1).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
        return Err(fail("recovery target type/size changed; bindings retained"));
    }
    let actual_physical = physical(&file)?;
    if recovery_path_key(&actual_physical) != recovery_path_key(expected_physical) {
        return Err(fail(&format!("recovery target physical path changed: expected={expected_physical}, actual={actual_physical}; bindings retained")));
    }
    if digest(&file)? != expected_sha256 {
        return Err(fail("recovery target content changed; bindings retained"));
    }
    Ok(file)
}

fn recovery_path_key(path: &str) -> String {
    let lower = path.replace('/', "\\").to_lowercase();
    let native = if let Some(unc) = lower.strip_prefix(r"\\?\unc\") { format!(r"\\{unc}") } else { lower };
    key(&native)
}
