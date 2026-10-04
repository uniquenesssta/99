use std::{ffi::c_void, io, os::windows::ffi::OsStrExt, ptr};
use super::Entry;
type Handle = *mut c_void;
const FONT_KEY: &str = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
#[link(name="advapi32")] extern "system" {
    fn RegOpenKeyExW(root:Handle, subkey:*const u16, options:u32, access:u32, out:*mut Handle)->i32;
    fn RegEnumValueW(key:Handle,index:u32,name:*mut u16,name_len:*mut u32,reserved:Handle,kind:*mut u32,data:*mut u8,bytes:*mut u32)->i32;
    fn RegCloseKey(key:Handle)->i32;
}
struct Registry(Handle);
impl Drop for Registry {fn drop(&mut self){unsafe{RegCloseKey(self.0);}}}
fn fail(message:String)->io::Error {io::Error::other(message)}
pub(crate) fn read()->io::Result<Vec<Entry>> {
    let mut rows=Vec::new();
    let key:Vec<u16>=std::ffi::OsStr::new(FONT_KEY).encode_wide().chain(Some(0)).collect();
    for (scope,root) in [("HKCU",-2147483647isize),("HKLM",-2147483646isize)] {
        let mut raw=ptr::null_mut();let code=unsafe{RegOpenKeyExW(root as Handle,key.as_ptr(),0,0x101,&mut raw)};
        if code==2 && scope=="HKCU"{continue}
        if code!=0{return Err(fail(format!("registry snapshot open: scope={scope}, code={code}")))}
        let k=Registry(raw);
        for index in 0..100000u32 {
            let mut name=vec![0u16;16384];let mut name_len=name.len() as u32;
            let mut data=vec![0u16;32768];let mut bytes=(data.len()*2) as u32;let mut kind=0;
            let code=unsafe{RegEnumValueW(k.0,index,name.as_mut_ptr(),&mut name_len,ptr::null_mut(),&mut kind,data.as_mut_ptr() as *mut u8,&mut bytes)};
            if code==259{break}
            if code!=0{return Err(fail(format!("registry snapshot enum: scope={scope}, index={index}, code={code}, type={kind}, bytes={bytes}")))}
            let units=name.get(..name_len as usize).ok_or_else(||fail(format!("registry snapshot invalid name length: scope={scope}, index={index}")))?;
            let name=String::from_utf16(units).map_err(|_|fail(format!("registry snapshot invalid UTF-16 name: scope={scope}, index={index}")))?;
            let value=super::decode(&name,kind,&data,bytes)
                .map_err(|error|fail(format!("registry snapshot decode: scope={scope}, index={index}, name={name:?}, type={kind}, bytes={bytes}: {error}")))?;
            if index==99999{return Err(fail("font registry snapshot limit exceeded".into()))}
            if let Some(value)=value {rows.push(Entry{scope,name,value});}
        }
    }
    Ok(rows)
}
