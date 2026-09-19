// Fixed recycle-bin operation in the existing killable native process.
// ABI: shobjidl_core.h IFileOperation, ole32 and shell32. No shell command text.
#[cfg(windows)]
mod platform {
    use std::{ffi::{c_void, OsStr}, io, os::windows::ffi::OsStrExt, ptr};
    #[repr(C)]
    struct Guid { a:u32, b:u16, c:u16, d:[u8;8] }
    const CLASS:Guid=Guid{a:0x3ad05575,b:0x8857,c:0x4850,d:[0x92,0x77,0x11,0xb8,0x5b,0xdb,0x8e,0x09]};
    const OPERATION:Guid=Guid{a:0x947aab5f,b:0x0a5c,c:0x4c13,d:[0xb4,0xd6,0x4b,0xf7,0x83,0x6f,0xc9,0xf8]};
    const ITEM:Guid=Guid{a:0x43826d1e,b:0xe718,c:0x42ee,d:[0xbc,0x55,0xa1,0xe2,0x61,0xc3,0x7b,0xfe]};
    #[repr(C)]
    struct OperationVtable {
        unknown:[usize;3], advise:usize, unadvise:usize,
        set_flags:unsafe extern "system" fn(*mut c_void,u32)->i32,
        preceding_items:[usize;12],
        delete_item:unsafe extern "system" fn(*mut c_void,*mut c_void,*mut c_void)->i32,
        delete_items:usize, new_item:usize,
        perform:unsafe extern "system" fn(*mut c_void)->i32,
        aborted:unsafe extern "system" fn(*mut c_void,*mut i32)->i32,
    }
    #[link(name="ole32")]
    extern "system" {
        fn CoInitializeEx(reserved:*mut c_void,flags:u32)->i32;
        fn CoUninitialize();
        fn CoCreateInstance(class:*const Guid,outer:*mut c_void,context:u32,iid:*const Guid,result:*mut *mut c_void)->i32;
    }
    #[link(name="shell32")]
    extern "system" { fn SHCreateItemFromParsingName(path:*const u16,context:*mut c_void,iid:*const Guid,result:*mut *mut c_void)->i32; }
    fn check(value:i32)->io::Result<()> { if value<0 {Err(io::Error::other(format!("recycle operation HRESULT=0x{:08x}",value as u32)))} else {Ok(())} }
    struct Apartment;
    impl Drop for Apartment {fn drop(&mut self){unsafe{CoUninitialize();}}}
    struct Com(*mut c_void);
    impl Drop for Com {fn drop(&mut self){unsafe{
        let table=*(self.0 as *const *const usize);
        let release:unsafe extern "system" fn(*mut c_void)->u32=std::mem::transmute(*table.add(2));
        release(self.0);
    }}}
    pub fn recycle(path:&str)->io::Result<()> {
        if path.is_empty() || path.contains('\0') || !std::path::Path::new(path).is_absolute() {return Err(io::Error::other("invalid recycle path"));}
        unsafe {
            check(CoInitializeEx(ptr::null_mut(),2))?;
            let _apartment=Apartment;
            let mut raw=ptr::null_mut();
            check(CoCreateInstance(&CLASS,ptr::null_mut(),1,&OPERATION,&mut raw))?;
            if raw.is_null(){return Err(io::Error::other("missing file-operation interface"));}
            let operation=Com(raw);
            let table=&**(operation.0 as *const *const OperationVtable);
            // Silent progress, no error UI, early failure, recycle-only intent,
            // and an explicit warning instead of accepting permanent deletion.
            check((table.set_flags)(operation.0,0x0004|0x0010|0x0400|0x4000|0x00080000|0x00100000))?;
            let wide:Vec<u16>=OsStr::new(path).encode_wide().chain(Some(0)).collect();
            raw=ptr::null_mut();
            check(SHCreateItemFromParsingName(wide.as_ptr(),ptr::null_mut(),&ITEM,&mut raw))?;
            if raw.is_null(){return Err(io::Error::other("missing shell item"));}
            let item=Com(raw);
            check((table.delete_item)(operation.0,item.0,ptr::null_mut()))?;
            check((table.perform)(operation.0))?;
            let mut aborted=0;
            check((table.aborted)(operation.0,&mut aborted))?;
            if aborted!=0 {return Err(io::Error::other("recycle operation aborted; result requires confirmation"));}
            Ok(())
        }
    }
}
#[cfg(windows)]
pub use platform::recycle;
#[cfg(not(windows))]
pub fn recycle(_path:&str)->std::io::Result<()> {Err(std::io::Error::other("isolated recycle requires Windows"))}
