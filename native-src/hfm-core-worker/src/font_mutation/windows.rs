use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{ffi::c_void, fs::{File, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::{AsRawHandle, FromRawHandle}}, path::{Path, PathBuf}, ptr};
type Handle = *mut c_void;
const FONT_KEY: &str = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
const HKCU: Handle = (-2147483647isize) as Handle;
const HKLM: Handle = (-2147483646isize) as Handle;
#[repr(C)] #[derive(Default)] struct FileTime { low:u32, high:u32 }
#[repr(C)] #[derive(Default)] struct Info { attributes:u32, created:FileTime, accessed:FileTime, modified:FileTime, volume:u32, size_high:u32, size_low:u32, links:u32, index_high:u32, index_low:u32 }
#[repr(C)] struct Security { length:u32, descriptor:Handle, inherit:i32 }
#[repr(C)] struct ShellInfo { size:u32, mask:u32, window:Handle, verb:*const u16, file:*const u16, parameters:*const u16, directory:*const u16, show:i32, instance:Handle, id_list:Handle, class:*const u16, class_key:Handle, hot_key:u32, icon:Handle, process:Handle }
#[link(name="kernel32")] extern "system" {
    fn GetFileInformationByHandle(file:Handle, info:*mut Info)->i32;
    fn GetFinalPathNameByHandleW(file:Handle, path:*mut u16, size:u32, flags:u32)->u32;
    fn SetFileInformationByHandle(file:Handle, class:u32, data:*const c_void, size:u32)->i32;
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
    fn RegOpenKeyExW(root:Handle, subkey:*const u16, options:u32, access:u32, out:*mut Handle)->i32;
    fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32;
    fn RegEnumValueW(key:Handle,index:u32,name:*mut u16,name_len:*mut u32,reserved:Handle,kind:*mut u32,data:*mut u8,bytes:*mut u32)->i32;
    fn RegQueryValueExW(key:Handle, name:*const u16, reserved:Handle, kind:*mut u32, data:*mut u8, bytes:*mut u32)->i32;
    fn RegDeleteValueW(key:Handle, name:*const u16)->i32;
    fn RegCloseKey(key:Handle)->i32;
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
#[link(name="bcrypt")] extern "system" {
    fn BCryptOpenAlgorithmProvider(out:*mut Handle, name:*const u16, implementation:*const u16, flags:u32)->i32;
    fn BCryptCreateHash(algorithm:Handle, out:*mut Handle, object:*mut u8, size:u32, secret:*const u8, secret_size:u32, flags:u32)->i32;
    fn BCryptHashData(hash:Handle, data:*const u8, size:u32, flags:u32)->i32;
    fn BCryptFinishHash(hash:Handle, output:*mut u8, size:u32, flags:u32)->i32;
    fn BCryptDestroyHash(hash:Handle)->i32;
    fn BCryptCloseAlgorithmProvider(algorithm:Handle, flags:u32)->i32;
}
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
    if stage=="file" {message["references"]=snapshot()?;}
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
fn open_font(path:&str,delete:bool)->io::Result<File>{
    if path.contains('\0') || path.len()>32000 || !Path::new(path).is_absolute() || !matches!(Path::new(path).extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str(),"ttf"|"otf"|"ttc"|"otc") {return Err(fail("invalid font path"));}
    let f=OpenOptions::new().access_mode(0x80000000|if delete{0x10000}else{0}).share_mode(1).custom_flags(0x00200000).open(path)?;
    identity(&f)?;
    if key(&physical(&f)?)!=key(path){return Err(fail("font path resolves through an alias/reparse point; resolve before planning"));}
    let mut magic=[0;4];(&f).read_exact(&mut magic)?;
    if !matches!(&magic,b"\0\x01\0\0"|b"OTTO"|b"ttcf"|b"true"|b"typ1"){return Err(fail("not a supported font"));}
    if unsafe{SfcIsFileProtected(ptr::null_mut(),wide(path).as_ptr())}!=0{return Err(fail("WRP protected file; ownership and ACL are unchanged"));}
    Ok(f)
}
fn digest(file:&File)->io::Result<String>{
    use std::io::{Seek,SeekFrom};
    let mut f=file; f.seek(SeekFrom::Start(0))?;
    struct Hash(Handle,Handle);impl Drop for Hash{fn drop(&mut self){unsafe{if !self.1.is_null(){BCryptDestroyHash(self.1);}BCryptCloseAlgorithmProvider(self.0,0);}}}
    unsafe {
        let mut a=ptr::null_mut();if BCryptOpenAlgorithmProvider(&mut a,wide("SHA256").as_ptr(),ptr::null(),0)<0{return Err(fail("SHA256 provider unavailable"))}
        let mut h=Hash(a,ptr::null_mut());if BCryptCreateHash(a,&mut h.1,ptr::null_mut(),0,ptr::null(),0,0)<0{return Err(fail("SHA256 allocation failed"))}
        let mut buffer=[0u8;65536];loop{let n=f.read(&mut buffer)?;if n==0{break}if BCryptHashData(h.1,buffer.as_ptr(),n as u32,0)<0{return Err(fail("SHA256 read failed"))}}
        let mut hash=[0u8;32];if BCryptFinishHash(h.1,hash.as_mut_ptr(),32,0)<0{return Err(fail("SHA256 finish failed"))}Ok(hash.iter().map(|v|format!("{v:02x}")).collect())
    }
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
struct Plan { path:String, sha256:String, delete_file:bool, records:Vec<Record>, identity:Option<Identity> }
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
    if kind!=1||bytes%2!=0||bytes<2||bytes>65536{return Err(fail("unsupported or malformed registry value"))}
    data.truncate(bytes as usize/2);if data.pop()!=Some(0){return Err(fail("unterminated registry value"))}
    if String::from_utf16_lossy(&data)!=r.value{return Err(fail("registry target changed since planning"))}Ok(())
}
fn snapshot()->io::Result<Value> {
    let (windows,_)=roots()?;let mut rows=Vec::new();
    for (scope,root) in [("HKCU",HKCU),("HKLM",HKLM)] {
        let mut raw=ptr::null_mut();let code=unsafe{RegOpenKeyExW(root,wide(FONT_KEY).as_ptr(),0,0x101,&mut raw)};
        if code==2 && scope=="HKCU"{continue}if code!=0{return Err(io::Error::from_raw_os_error(code))}let k=Registry(raw);
        for index in 0..100000u32 {
            let mut name=vec![0u16;16384];let mut name_len=name.len() as u32;let mut data=vec![0u16;32768];let mut bytes=(data.len()*2) as u32;let mut kind=0;
            let code=unsafe{RegEnumValueW(k.0,index,name.as_mut_ptr(),&mut name_len,ptr::null_mut(),&mut kind,data.as_mut_ptr() as *mut u8,&mut bytes)};
            if code==259{break}if code!=0{return Err(io::Error::from_raw_os_error(code))}
            if kind!=1 || bytes<2 || bytes%2!=0{return Err(fail("font registry contains an unsupported value"))}
            data.truncate(bytes as usize/2);if data.pop()!=Some(0){return Err(fail("unterminated font registry value"))}
            let name=String::from_utf16(&name[..name_len as usize]).map_err(|_|fail("invalid registry name"))?;
            let value=String::from_utf16(&data).map_err(|_|fail("invalid registry path"))?;
            let bare=value.trim_matches('"');let path=if Path::new(bare).is_absolute(){PathBuf::from(bare)}else{PathBuf::from(&windows).join(bare)};
            rows.push(json!({"source":scope,"registryName":name,"value":value,"path":path.to_string_lossy(),"fileName":path.file_name().map(|v|v.to_string_lossy())}));
            if index==99999{return Err(fail("font registry snapshot limit exceeded"))}
        }
    }
    Ok(Value::Array(rows))
}
fn validate(p:&Plan,elevated:bool,original_user:Option<&str>)->io::Result<()> {
    let (windows,current_user)=roots()?;
    let user=original_user.unwrap_or(&current_user);
    if p.records.len()>512||p.sha256.len()!=64||!p.sha256.bytes().all(|c|c.is_ascii_hexdigit()){return Err(fail("invalid plan"))}
    if p.delete_file && !direct_child(&p.path,&windows) && !direct_child(&p.path,user){return Err(fail("file deletion outside installed font directories refused"))}
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
    // short-lived GDI/mapped-file references. Keep the same handle throughout;
    // never reopen by path, replay registry changes, or request elevation here.
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
fn execute(p:&Plan,elevated:bool,original_user:Option<&str>,input:&mut impl BufRead,out:&mut impl Write)->io::Result<()> {
    let mut stage="validate-plan";
    let result=(||->io::Result<()> {
    validate(p,elevated,original_user)?;
    // Acquire all permissions before the first effect. A denied preflight is the
    // only condition under which the broker may request elevation.
    stage="open-font";
    let file=open_font(&p.path,p.delete_file)?;
    // DELETE access can be granted on a read-only file, while setting its
    // disposition still fails. Reject before removing any registry records;
    // elevation cannot fix this attribute and must not silently clear it.
    stage="readonly-preflight";
    if p.delete_file && file.metadata()?.permissions().readonly() {
        return Err(fail("font file is read-only; no registry records were removed; clear the attribute explicitly before retrying"));
    }
    stage="identity-preflight";
    if p.identity.as_ref()!=Some(&identity(&file)?)||digest(&file)?!=p.sha256{return Err(fail("font identity/content changed"))}
    stage="registry-preflight";
    let mut keys=Vec::new();for r in &p.records{let k=registry(r,true,elevated)?;verify_record(&k,r)?;keys.push(k);}
    emit(out,&json!({"prepared":true}))?;
    for (r,k) in p.records.iter().zip(keys.iter()) {
        stage="registry-gate";
        gate(input,out,"registry")?;verify_record(k,r)?;
        stage="registry-delete";
        delete_record(r)?;
        emit(out,&json!({"effect":"registry","scope":r.scope,"name":r.name}))?;
    }
    if p.delete_file {
        retry_file_disposition(|| {
        stage="file-gate";
        gate(input,out,if elevated{"elevated-file"}else{"file"})?;
        stage="file-identity-recheck";
        if p.identity.as_ref()!=Some(&identity(&file)?){return Err(fail("font identity changed before delete"))}
        if file.metadata()?.permissions().readonly(){return Err(fail("font became read-only before delete"))}
        // Multiple loads can retain multiple resource references. Each removal
        // is separately gated; private or other-session resources are not forced.
        stage="font-resource-release";
        for index in 0..8 {
            if index>0 { gate(input,out,if elevated{"elevated-file"}else{"file"})?; }
            if unsafe{RemoveFontResourceExW(wide(&p.path).as_ptr(),0,ptr::null_mut())}==0 {break;}
        }
        gate(input,out,if elevated{"elevated-file"}else{"file"})?;
        if p.identity.as_ref()!=Some(&identity(&file)?){return Err(fail("font identity changed before disposition"))}
        stage="file-disposition";
        let delete=1u8;unsafe{checked(SetFileInformationByHandle(file.as_raw_handle(),4,&delete as *const _ as *const c_void,1))}
        },|ms|std::thread::sleep(std::time::Duration::from_millis(ms)))?;
        drop(file);
        // A new object at the old path must never be removed during verification.
        stage="file-removal-verification";
        if Path::new(&p.path).exists(){return Err(fail("file deletion not confirmed; do not retry without new identity"))}
        emit(out,&json!({"effect":"file"}))?;
    }
    Ok(())
    })();
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
            if reply.get("gate").and_then(Value::as_str)==Some("elevated-file") {reply["gate"]=json!("file");reply["references"]=snapshot()?;}
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
        let result=execute(&plan,true,Some(&original_user),&mut input,&mut output);
        emit(&mut output,&json!({"done":true,"ok":result.is_ok(),"code":result.as_ref().err().and_then(|e|e.raw_os_error()),"message":result.err().map(|e|e.to_string())}))?;
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
            let result=execute(&plan,false,None,&mut input,&mut tracked);
            let denied=result.as_ref().err().and_then(|e|e.raw_os_error())==Some(5);
            if !denied||tracked.prepared{return result}
            validate(&plan,true,Some(&roots()?.1))?;
            gate(&mut input,&mut output,"before-uac")?;
            if let Some(code)=elevation_failure{return Err(io::Error::from_raw_os_error(code))}
            if elevated.is_none(){match Elevated::start(){Ok(child)=>elevated=Some(child),Err(error)=>{elevation_failure=Some(error.raw_os_error().unwrap_or(5));return Err(error)}}}
            // Parent revalidates protection again on each gate from the child.
            elevated.as_mut().unwrap().execute(&plan,&mut input,&mut output)?;
            Ok(())
        })();
        // Elevated replies already contain a done receipt. Suppress the broker
        // duplicate using a separate completion marker at the transport layer.
        emit(&mut output,&json!({"brokerDone":true,"ok":result.is_ok(),"code":result.as_ref().err().and_then(|e|e.raw_os_error()),"message":result.err().map(|e|e.to_string())}))?;
    }
}
